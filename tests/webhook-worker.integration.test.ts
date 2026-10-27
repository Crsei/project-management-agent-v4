import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { deliverWebhookBatch } from '../packages/application/src/webhook-delivery.ts';
import type { WebhookDeliveryDetail } from '../packages/domain/src/webhooks.ts';
import { createWebhookFixture, webhookDatabaseUrl, type WebhookFixture } from './webhook-fixture.ts';

async function until(f: WebhookFixture, state: string): Promise<{ id: string; version: number }> {
  for (let i=0;i<400;i++) { const row=(await f.pool.query<{ id: string; version: number }>('SELECT id,version FROM webhook_deliveries WHERE state=$1 ORDER BY created_at LIMIT 1',[state])).rows[0]; if(row) return row; await delay(10); }
  throw new Error(`Isolated webhook did not reach ${state}`);
}
function worker(f: WebhookFixture, hold?: 'preparing' | 'sending', proxyOrigin?: string): ChildProcess {
  const databaseUrl = f.pool.options.connectionString;
  if (!databaseUrl) throw new Error('Isolated fixture database identity unavailable');
  return spawn(process.execPath, [fileURLToPath(new URL('./webhook-worker-fixture.ts', import.meta.url))], { stdio: ['ignore','ignore','pipe'], env: { ...process.env, PM_WEBHOOK_TEST_DATABASE_URL: databaseUrl, PM_WEBHOOK_TEST_CERT: join(f.root,'tls-cert.pem'), PM_WEBHOOK_TEST_PORT: String(f.receiver.port), PM_WEBHOOK_TEST_WORKER_ID: `isolated-${randomUUID()}`, WEBHOOK_TARGETS_FILE: join(f.root,'targets.json'), ...(hold ? { PM_WEBHOOK_TEST_HOLD: hold } : {}), ...(proxyOrigin ? { HTTP_PROXY: proxyOrigin, HTTPS_PROXY: proxyOrigin, ALL_PROXY: proxyOrigin, NO_PROXY: '' } : {}) } });
}
async function stop(child: ChildProcess, kill = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = Promise.withResolvers<void>(); child.once('exit', () => closed.resolve()); child.kill(kill ? 'SIGKILL' : 'SIGTERM'); await closed.promise;
}
async function setup(f: WebhookFixture): Promise<void> {
  const e = await f.command<{ endpointId: string; version: number }>('CreateWebhookEndpoint',{targetKey:'isolated_receiver',projectIds:[f.projectId],eventTypes:['pm.task.changed.v1']}); await f.enable(e.endpointId,e.version); await f.task();
}
test('two actual Worker processes ignore environment proxies and retain one durable receiver effect', { skip: !webhookDatabaseUrl }, async t => {
  let proxyRequests=0;const proxy=createServer((_request,response)=>{proxyRequests++;response.writeHead(502).end()});proxy.on('connect',(_request,socket)=>{proxyRequests++;socket.destroy()});
  const listening=Promise.withResolvers<void>();proxy.listen(0,'127.0.0.1',listening.resolve);await listening.promise;
  t.after(async()=>{const closed=Promise.withResolvers<void>();proxy.close(()=>closed.resolve());proxy.closeAllConnections();await closed.promise});
  const address=proxy.address();assert.ok(address&&typeof address!=='string');const proxyOrigin=`http://127.0.0.1:${address.port}`;
  const f=await createWebhookFixture(); await setup(f);
  const one=worker(f,undefined,proxyOrigin), two=worker(f,undefined,proxyOrigin); t.after(async()=>{await stop(one);await stop(two);await f.close()});
  await until(f,'accepted'); await stop(one); await stop(two);
  assert.equal((await f.pool.query<{ count: string }>('SELECT count(*)::text FROM webhook_deliveries')).rows[0]!.count,'1');
  assert.equal((await f.pool.query<{ effect_count: number }>('SELECT effect_count FROM receiver_inbox')).rows[0]!.effect_count,1);
  assert.equal(f.receiver.requests.filter(r=>r.path==='/deliver').length,1);
  assert.equal(proxyRequests,0);
});
test('killed preparing Worker cannot late-dispatch; killed sending Worker requires receiver reconciliation', { skip: !webhookDatabaseUrl }, async () => {
  for (const phase of ['preparing','sending'] as const) {
    const f=await createWebhookFixture(); await setup(f); const child=worker(f,phase);
    try {
      const d=await until(f,phase); await stop(child,true);
      await f.pool.query("UPDATE webhook_deliveries SET lease_expires_at=now()-interval '1 second',version=version+1 WHERE id=$1",[d.id]);
      await deliverWebhookBatch(f.pool); // Lease recovery only: never touch a production target.
      assert.equal(f.receiver.requests.length,0);
      const state=(await f.pool.query<{state:string}>('SELECT state FROM webhook_deliveries WHERE id=$1',[d.id])).rows[0]!.state;
      assert.equal(state,phase==='preparing'?'ready':'unknown');
      if(phase==='preparing'){await f.batch();assert.equal((await f.pool.query<{state:string}>('SELECT state FROM webhook_deliveries WHERE id=$1',[d.id])).rows[0]!.state,'accepted')}
      else {await f.batch();assert.equal(f.receiver.requests.length,0)}
    } finally {await stop(child,true);await f.close()}
  }
});
test('receiver acceptance with failed PM receipt commit remains sending then unknown and reconciles without another POST', { skip: !webhookDatabaseUrl }, async t => {
  const f=await createWebhookFixture(); t.after(()=>f.close()); await setup(f);
  await f.pool.query("CREATE FUNCTION fail_webhook_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated receipt commit failure'; END $$; CREATE TRIGGER fail_webhook_receipt BEFORE INSERT ON webhook_delivery_receipts FOR EACH ROW EXECUTE FUNCTION fail_webhook_receipt()");
  await assert.rejects(f.batch(),/isolated receipt commit failure/); const d=await until(f,'sending');
  await f.pool.query('DROP TRIGGER fail_webhook_receipt ON webhook_delivery_receipts; DROP FUNCTION fail_webhook_receipt()');
  await f.pool.query("UPDATE webhook_deliveries SET lease_expires_at=now()-interval '1 second',version=version+1 WHERE id=$1",[d.id]); await deliverWebhookBatch(f.pool);
  const unknown=await until(f,'unknown'); await f.command('ReconcileWebhookDelivery',{},unknown); await f.batch();
  const detail=await f.request<WebhookDeliveryDetail>(`/api/v1/workspaces/${f.workspaceId}/webhook-deliveries/${d.id}`); assert.equal(detail.body.state,'accepted');
  assert.equal(f.receiver.requests.filter(r=>r.path==='/deliver').length,1); assert.equal((await f.pool.query<{effect_count:number}>('SELECT effect_count FROM receiver_inbox')).rows[0]!.effect_count,1);
});
