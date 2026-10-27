import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectWebhookFact, sha256, signWebhookRequest, signWebhookReceipt, verifyWebhookReceipt, type WebhookFact, type WebhookRequestIdentity } from '../packages/domain/src/webhooks.ts';
import { normalizeWebhookUrl, readWebhookConfig } from '../packages/infrastructure/src/webhook-config.ts';
import { isGlobalWebhookAddress, verifyWebhookRequest } from '../packages/infrastructure/src/webhook-transport.ts';
import { createWebhookEndpointSchema } from '../packages/contracts/src/webhook-schemas.ts';

function fact(): WebhookFact { return { fact_id: randomUUID(), workspace_id: randomUUID(), fact_sequence: '1', schema_version: 1, source_kind: 'core_observation', project_id: 'PRJ-001', entity_kind: 'work_item', entity_id: 'TASK-001', before_revision: null, after_revision: 'revision-1', change_kinds: ['created','metadata_changed'], occurred_at: null, observed_at: new Date(), safety_class: 'project_fact' }; }
test('outbound facts are explicit three-kind projections with no source field values', () => {
  const input = { ...fact(), title: 'never-export', source_key: 'internal-command', actorRef: 'secret-actor', body: 'private-body' };
  const result = projectWebhookFact(input, randomUUID()); assert.ok(result);
  const body = JSON.parse(result.body.toString());
  assert.deepEqual(Object.keys(body).sort(), ['schemaVersion','eventId','deliveryId','eventType','workspaceId','projectId','entity','changeKinds','sourceKind','occurredAt','observedAt'].sort());
  assert.ok(!result.body.toString().includes('never-export')); assert.ok(!result.body.toString().includes('internal-command')); assert.equal(result.sha256, sha256(result.body));
  for (const patch of [{ source_kind: 'legacy_activity' },{ safety_class: 'restricted_internal' },{ entity_kind: 'comment' },{ schema_version: 2 },{ change_kinds: ['deleted'] },{ project_id: null },{ occurred_at: new Date() },{ observed_at: null }]) assert.equal(projectWebhookFact({ ...input, ...patch }, randomUUID()), null);
  for (const [kind, event] of [['project','pm.project.changed.v1'],['work_item','pm.task.changed.v1'],['milestone','pm.milestone.changed.v1']]) {
    const value = projectWebhookFact({ ...fact(), entity_kind: kind!, entity_id: kind === 'project' ? 'PRJ-001' : kind === 'milestone' ? 'MS-001' : 'TASK-001' }, randomUUID()); assert.equal(value?.eventType, event);
  }
});
test('HMAC binds exact method, path, bytes, identity, key and timestamp; receipts require a closed fence', () => {
  const key = randomBytes(32); const payload = projectWebhookFact(fact(), randomUUID())!;
  const body = JSON.parse(payload.body.toString());
  const request: WebhookRequestIdentity = { method: 'POST', path: '/deliver', endpointId: randomUUID(), deliveryId: body.deliveryId, eventId: body.eventId, attemptId: randomUUID(), attemptNo: 1, timestamp: Math.floor(Date.now()/1000), keyId: 'key-one', bodySha256: payload.sha256 };
  const signature = signWebhookRequest(key, request); assert.ok(verifyWebhookRequest(key, request, payload.body, signature));
  for (const patch of [{ method: 'GET' as const },{ path: '/other' },{ endpointId: randomUUID() },{ attemptId: randomUUID() },{ keyId: 'other' },{ timestamp: request.timestamp - 301 }]) assert.equal(verifyWebhookRequest(key, { ...request, ...patch }, payload.body, signature), false);
  assert.equal(verifyWebhookRequest(key, request, Buffer.concat([payload.body, Buffer.from(' ')]), signature), false);
  const receipt = { schemaVersion: 1, receiverReceiptId: randomUUID(), endpointId: request.endpointId, deliveryId: request.deliveryId, eventId: request.eventId, attemptId: request.attemptId, payloadSha256: payload.sha256, status: 'not_accepted', recordedAt: new Date().toISOString() };
  let bytes = Buffer.from(JSON.stringify(receipt)); assert.equal(verifyWebhookReceipt(key, request, 200, bytes, signWebhookReceipt(key, request, 200, bytes), payload.sha256), null);
  bytes = Buffer.from(JSON.stringify({ ...receipt, closedThroughAttemptNo: 1 })); assert.equal(verifyWebhookReceipt(key, request, 200, bytes, signWebhookReceipt(key, request, 200, bytes), payload.sha256)?.status, 'not_accepted');
  assert.equal(verifyWebhookReceipt(key, request, 500, bytes, signWebhookReceipt(key, request, 200, bytes), payload.sha256), null);
  assert.equal(verifyWebhookReceipt(key, request, 200, bytes, signWebhookReceipt(key, request, 200, bytes), '0'.repeat(64)), null);
});
test('public address and exact URL policy rejects metadata, reserved, mapped and normalization bypasses', () => {
  for (const address of ['0.0.0.0','10.0.0.1','100.64.1.1','127.0.0.1','169.254.169.254','172.31.0.1','192.168.0.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','240.0.0.1','::','::1','fc00::1','fe80::1','ff02::1','::ffff:8.8.8.8','2001:db8::1','2002:0808:0808::1','3fff::1']) assert.equal(isGlobalWebhookAddress(address), false, address);
  for (const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(isGlobalWebhookAddress(address), true, address);
  for (const url of ['http://public.example.com/x','https://127.0.0.1/x','https://2130706433/x','https://user:pass@public.example.com/x','https://public.example.com:444/x','https://public.example.com/x?q=1','https://public.example.com/x#f','https://public.example.com/a/../x','https://public.example.com/%2e%2e/x','https://host.local/x','https://localhost/x','https://public.example.com\\@127.0.0.1/x']) assert.throws(() => normalizeWebhookUrl(url), url);
  assert.equal(normalizeWebhookUrl('https://receiver.pm-webhook.com/path').hostname, 'receiver.pm-webhook.com');
  assert.equal(createWebhookEndpointSchema.safeParse({ targetKey: 'approved', projectIds: ['PRJ-001'], eventTypes: ['pm.task.changed.v1'], url: 'https://attacker.com/' }).success, false);
});
test('manifest distinguishes absent, invalid and approved metadata without opening secret files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pm-webhook-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(readWebhookConfig({}).status, 'disabled'); assert.equal(readWebhookConfig({ WEBHOOK_TARGETS_FILE: '' }).status, 'configuration_error');
  const file = join(root, 'manifest.json'); const target = { targetKey: 'approved', workspaceId: randomUUID(), projectIds: ['PRJ-001'], eventTypes: ['pm.task.changed.v1'], deliveryUrl: 'https://receiver.pm-webhook.com/deliver', receiptBaseUrl: 'https://receiver.pm-webhook.com/receipts', reconcileBaseUrl: 'https://receiver.pm-webhook.com/reconcile', protocol: 'pm-receipt-v1', policyVersion: 1, keyring: [{ keyId: 'one', secretFile: join(root, 'does-not-exist-{endpointId}'), activeFrom: '2020-01-01T00:00:00.000Z', activeUntil: null, receiverReady: true }] };
  await writeFile(file, JSON.stringify({ schemaVersion: 1, targets: [target] }), { mode: 0o600 }); const config = readWebhookConfig({ WEBHOOK_TARGETS_FILE: file }); assert.equal(config.status, 'configured'); assert.ok(config.digest);
  const rotatedTarget = { ...target, keyring: [...target.keyring, { ...target.keyring[0]!, keyId: 'two', secretFile: join(root, 'new-key-{endpointId}') }] };
  await writeFile(file, JSON.stringify({ schemaVersion: 1, targets: [rotatedTarget] })); const rotated = readWebhookConfig({ WEBHOOK_TARGETS_FILE: file });
  assert.equal(rotated.status, 'configured'); assert.equal(rotated.targets[0]!.targetDigest, config.targets[0]!.targetDigest); assert.notEqual(rotated.digest, config.digest);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, targets: [{ ...target, allowPrivateNetwork: true }] })); assert.equal(readWebhookConfig({ WEBHOOK_TARGETS_FILE: file }).status, 'configuration_error');
});
