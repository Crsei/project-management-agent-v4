import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect as connectTls } from 'node:tls';
import { test } from 'node:test';
import { sha256, type WebhookDeliveryDetail, type WebhookOverview } from '../packages/domain/src/webhooks.ts';
import { deliverWebhookBatch } from '../packages/application/src/webhook-delivery.ts';
import { createWebhookTransport, WebhookNetworkError } from '../packages/infrastructure/src/webhook-transport.ts';
import { createWebhookFixture, webhookDatabaseUrl, type WebhookFixture } from './webhook-fixture.ts';

type EndpointResult = { endpointId: string; version: number; state: string };
async function endpoint(f: WebhookFixture) { return f.command<EndpointResult>('CreateWebhookEndpoint', { targetKey: 'isolated_receiver', projectIds: [f.projectId], eventTypes: ['pm.task.changed.v1'] }); }
async function current(f: WebhookFixture): Promise<WebhookDeliveryDetail> {
  const row = (await f.pool.query<{ id: string }>('SELECT id FROM webhook_deliveries ORDER BY created_at DESC LIMIT 1')).rows[0]; assert.ok(row);
  const response = await f.request<WebhookDeliveryDetail>(`/api/v1/workspaces/${f.workspaceId}/webhook-deliveries/${row.id}`); assert.equal(response.status, 200); return response.body;
}
test('real TLS, shared persisted core fact, exact body, signed receipt, dedup and safe management DTO', { skip: !webhookDatabaseUrl }, async t => {
  const f = await createWebhookFixture(); t.after(() => f.close());
  const e = await endpoint(f); assert.equal(e.state, 'paused'); await f.enable(e.endpointId, e.version);
  const task = await f.task(); await f.batch(); await f.batch();
  const d = await current(f); assert.equal(d.state, 'accepted'); assert.equal(d.attempts.length, 1); assert.equal(d.receipts.length, 1);
  const inbox = (await f.pool.query<{ effect_count: number }>('SELECT effect_count FROM receiver_inbox')).rows[0]!; assert.equal(inbox.effect_count, 1);
  const row = (await f.pool.query<{ payload_bytes: Buffer; payload_sha256: string; fact_id: string; source_kind: string }>('SELECT d.payload_bytes,d.payload_sha256,d.fact_id,f.source_kind FROM webhook_deliveries d JOIN service_fact_events f ON f.fact_id=d.fact_id')).rows[0]!;
  assert.equal(sha256(row.payload_bytes), row.payload_sha256); assert.deepEqual(f.receiver.bodies[0], row.payload_bytes);
  const body = JSON.parse(row.payload_bytes.toString()); assert.equal(body.entity.id, task.id); assert.equal(body.eventId, row.fact_id); assert.equal(body.deliveryId, d.deliveryId); assert.equal(body.sourceKind, row.source_kind);
  for (const marker of ['private-title-marker','private-body-marker','private-goal-marker',f.actor.email,f.actor.id]) assert.ok(!row.payload_bytes.toString().includes(marker), marker);
  const overview = await f.request<WebhookOverview>(`/api/v1/workspaces/${f.workspaceId}/webhooks`); assert.equal(overview.status, 200);
  const publicBytes = JSON.stringify({ overview: overview.body, detail: d }); for (const forbidden of ['secretFile','deliveryUrl','payload_bytes','payloadBytes','x-pm-signature','private-title-marker']) assert.ok(!publicBytes.includes(forbidden));
  assert.equal(f.receiver.requests.filter(r => r.path === '/deliver').length, 1);
  const repeated = await f.receiver.transport.send(await f.receiver.transport.prepare(f.config.targets[0]!, 'dispatch', d.deliveryId), f.receiver.requests[0]!, row.payload_bytes, await readFile(f.config.targets[0]!.keyring[0]!.secretFile.replace('{endpointId}', f.receiver.requests[0]!.endpointId)), row.payload_sha256);
  assert.equal(repeated.receipt?.status, 'accepted'); assert.equal((await f.pool.query<{ effect_count: number }>('SELECT effect_count FROM receiver_inbox')).rows[0]!.effect_count, 1);
  const tampered = Buffer.from(JSON.stringify({ ...body, entity: { ...body.entity, afterRevision: 'different-revision' } }));
  const changed = await f.receiver.transport.send(await f.receiver.transport.prepare(f.config.targets[0]!, 'dispatch', d.deliveryId), { ...f.receiver.requests[0]!, attemptId: randomUUID(), bodySha256: sha256(tampered) }, tampered, await readFile(f.config.targets[0]!.keyring[0]!.secretFile.replace('{endpointId}', f.receiver.requests[0]!.endpointId)), sha256(tampered));
  assert.equal(changed.httpStatus, 409); assert.equal(changed.receipt, null); assert.equal((await f.pool.query<{ effect_count: number }>('SELECT effect_count FROM receiver_inbox')).rows[0]!.effect_count, 1);
  await assert.rejects(f.pool.query('UPDATE webhook_deliveries SET payload_bytes=$2,version=version+1 WHERE id=$1', [d.deliveryId, Buffer.from('{}')]), /Immutable webhook/);
});
test('receiver commit then response loss stays unknown without automatic POST; authenticated GET recovers same identity', { skip: !webhookDatabaseUrl }, async t => {
  const f = await createWebhookFixture(); t.after(() => f.close()); const e = await endpoint(f); await f.enable(e.endpointId, e.version);
  f.receiver.mode = 'lose_response'; await f.task(); await f.batch(); let d = await current(f); assert.equal(d.state, 'unknown'); const identity = d.deliveryId;
  await f.batch(); await f.batch(); assert.equal(f.receiver.requests.filter(r => r.path === '/deliver').length, 1);
  await f.command('ReconcileWebhookDelivery', {}, { id: d.deliveryId, version: d.version }); f.receiver.mode = 'accept'; await f.batch();
  d = await current(f); assert.equal(d.state, 'accepted'); assert.equal(d.deliveryId, identity); assert.ok(f.receiver.requests.some(r => r.method === 'GET')); assert.equal(f.receiver.requests.filter(r => r.path === '/deliver').length, 1);
  assert.equal((await f.pool.query<{ effect_count: number }>('SELECT effect_count FROM receiver_inbox')).rows[0]!.effect_count, 1);
});
test('negative reconciliation closes late attempts; only explicit CAS resume reuses the immutable body and delivery ID', { skip: !webhookDatabaseUrl }, async t => {
  const f = await createWebhookFixture(); t.after(() => f.close()); const e = await endpoint(f); await f.enable(e.endpointId, e.version);
  f.receiver.mode = 'do_not_accept'; await f.task(); await f.batch(); let d = await current(f); assert.equal(d.state, 'unknown');
  const rejected = await f.request<{ error?: { code: string }; status?: string }>(`/api/v1/workspaces/${f.workspaceId}/commands`, { method: 'POST', body: { commandId: randomUUID(), commandType: 'ResumeWebhookDelivery', targetId: d.deliveryId, expectedVersions: { [d.deliveryId]: d.version }, payload: { receiptId: randomUUID() } } }); assert.equal(rejected.status, 409);
  const original = (await f.pool.query<{ payload_bytes: Buffer; payload_sha256: string }>('SELECT payload_bytes,payload_sha256 FROM webhook_deliveries WHERE id=$1', [d.deliveryId])).rows[0]!;
  await f.command('ReconcileWebhookDelivery', {}, { id: d.deliveryId, version: d.version }); await f.batch(); await f.batch(); d = await current(f); assert.equal(d.state, 'unknown'); assert.ok(d.resumeReceiptId);
  const key = await readFile(f.config.targets[0]!.keyring[0]!.secretFile.replace('{endpointId}', f.receiver.requests[0]!.endpointId));
  f.receiver.mode = 'accept'; const late = await f.receiver.transport.send(await f.receiver.transport.prepare(f.config.targets[0]!, 'dispatch', d.deliveryId), f.receiver.requests[0]!, original.payload_bytes, key, original.payload_sha256); assert.equal(late.receipt?.status, 'not_accepted'); assert.equal((await f.pool.query<{ effect_count: number }>('SELECT effect_count FROM receiver_inbox')).rows[0]!.effect_count, 0);
  const oldId = d.deliveryId; const oldAttempt = d.attemptNo; await f.command('ResumeWebhookDelivery', { receiptId: d.resumeReceiptId }, { id: d.deliveryId, version: d.version }); await f.batch(); d = await current(f); assert.equal(d.state, 'accepted'); assert.equal(d.deliveryId, oldId); assert.ok(d.attemptNo > oldAttempt);
  const saved = (await f.pool.query<{ payload_bytes: Buffer }>('SELECT payload_bytes FROM webhook_deliveries WHERE id=$1', [d.deliveryId])).rows[0]!; assert.deepEqual(saved.payload_bytes, original.payload_bytes); assert.equal((await f.pool.query<{ effect_count: number }>('SELECT effect_count FROM receiver_inbox')).rows[0]!.effect_count, 1);
});
test('revocation committed during DNS preparation prevents every receiver request and blocks unsent delivery', { skip: !webhookDatabaseUrl }, async t => {
  const f = await createWebhookFixture(); t.after(() => f.close()); const e = await endpoint(f); await f.enable(e.endpointId, e.version); await f.task();
  await deliverWebhookBatch(f.pool, f.config, { transport: { async prepare(...args) { const prepared = await f.receiver.transport.prepare(...args); await f.pool.query("UPDATE memberships SET capabilities=array_remove(capabilities,'audit.read'),version=version+1 WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.actor.id]); return prepared; }, send: f.receiver.transport.send } });
  assert.equal(f.receiver.requests.length, 0); assert.equal((await f.pool.query<{ state: string }>('SELECT state FROM webhook_deliveries')).rows[0]!.state, 'blocked');
  const query = await f.request(`/api/v1/workspaces/${f.workspaceId}/webhooks`); assert.equal(query.status, 403);
});
test('double consumers create one dispatch lease and one durable receiver effect', { skip: !webhookDatabaseUrl }, async t => {
  const f = await createWebhookFixture(); t.after(() => f.close()); const e = await endpoint(f); await f.enable(e.endpointId, e.version); await f.task();
  await Promise.all([f.batch(),f.batch()]); assert.equal((await f.pool.query<{ count: string }>('SELECT count(*)::text FROM webhook_deliveries')).rows[0]!.count, '1'); assert.equal(f.receiver.requests.filter(r => r.path === '/deliver').length, 1);
  // Never reset or reuse historical accepted delivery rows.
  const d = await current(f); assert.equal(d.state, 'accepted');
  const summary = await deliverWebhookBatch(f.pool, f.config); assert.equal(summary.attempted, 0);
});
test('untrusted 2xx, redirects and response limits never imply acceptance or trigger blind retries', { skip: !webhookDatabaseUrl }, async t => {
  for (const mode of ['unsigned','redirect','oversize'] as const) {
    const f = await createWebhookFixture(); t.after(() => f.close()); const e = await endpoint(f); await f.enable(e.endpointId, e.version); f.receiver.mode = mode; await f.task(); await f.batch(); const d = await current(f); assert.equal(d.state, 'unknown'); await f.batch(); assert.equal(f.receiver.requests.filter(r => r.path === '/deliver').length, 1);
  }
});
test('SSRF preparation denial remains pre-dispatch and cannot forge accepted state', { skip: !webhookDatabaseUrl }, async t => {
  const f = await createWebhookFixture(); t.after(() => f.close()); const e = await endpoint(f); await f.enable(e.endpointId, e.version); await f.task();
  await deliverWebhookBatch(f.pool, f.config, { transport: { prepare: async () => { throw new WebhookNetworkError('webhook_dns_denied'); }, send: f.receiver.transport.send } });
  assert.equal(f.receiver.requests.length, 0); const d = await current(f); assert.equal(d.state, 'blocked'); assert.equal(d.attemptNo, 0);
  await assert.rejects(f.pool.query("UPDATE webhook_deliveries SET state='accepted',accepted_at=now(),version=version+1 WHERE id=$1", [d.deliveryId]), /requires authenticated receipt/);
});
test('actual TLS certificate mismatch proves no HTTP was sent and exhausts only bounded same-ID safe retries', { skip: !webhookDatabaseUrl }, async t => {
  const f=await createWebhookFixture();t.after(()=>f.close());const e=await endpoint(f);await f.enable(e.endpointId,e.version);await f.task();
  const ca=await readFile(join(f.root,'tls-cert.pem'));
  const transport=createWebhookTransport({resolve:async()=>[{address:'127.0.0.1',family:4}],connect:(_url,pinned)=>connectTls({host:pinned.address,port:f.receiver.port,servername:'not-the-approved-host.pm-webhook.com',ca,rejectUnauthorized:true})});
  let deliveryId:string|undefined;
  for(let i=0;i<3;i++){
    await deliverWebhookBatch(f.pool,f.config,{transport});const d=await current(f);
    if(deliveryId)assert.equal(d.deliveryId,deliveryId);else deliveryId=d.deliveryId;
    assert.equal(d.state,i===2?'failed_safe':'retry_wait');
    if(i<2)await f.pool.query('UPDATE webhook_deliveries SET next_attempt_at=now(),version=version+1 WHERE id=$1',[d.deliveryId]);
  }
  assert.equal(f.receiver.requests.length,0);assert.equal((await f.pool.query<{count:string}>('SELECT count(*)::text FROM receiver_inbox')).rows[0]!.count,'0');
});
