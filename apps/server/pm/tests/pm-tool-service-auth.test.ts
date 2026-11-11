import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pmToolCallProjectionSchema, pmToolRequestSchema } from '../../../../packages/agent-contracts/src/pm-tools.ts';
import { mcpMac } from '../../../../packages/infrastructure/src/mcp-service-auth.ts';
import { PM_TOOL_RECONCILE_PATH, createPmToolLinkageBearer, createPmToolReconcileBearer, pmToolRequestHash, verifyPmToolLinkageBearer, verifyPmToolReconcileBearer } from '../../../../packages/infrastructure/src/pm-tool-service-auth.ts';

const actorId = '0196c319-8b1d-7000-8000-000000000010';
const target = { workspaceId: '0196c319-8b1d-7000-8000-000000000001', projectId: 'PRJ-001' };
const request = () => ({ operationId: randomUUID(), name: 'pm_create_task', arguments: { title: 'Private original title' }, target,
  threadId: 'thread', messageId: 'assistant-output', generationId: 'generation' });
const linkage = () => ({ traceId: randomUUID(), invocationId: randomUUID(), executionRoot: 'generation' as const,
  inputMessageId: 'accepted-user-input', executionGrantId: randomUUID(), clientKind: 'chat' as const, policy: 'full' as const, enforcement: 'audit-only' as const });

test('status signatures bind original identity, purpose, audience, method, path and expiry without a user grant', t => {
  const secret = process.env.PM_AUTOMATION_SERVICE_SECRET;
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'isolated-operation-service-proof-secret'.repeat(3);
  t.after(() => { if (secret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = secret; });
  const input = request(), proof = { operationId: input.operationId, actorId, target, requestHash: pmToolRequestHash(input, actorId) };
  const bearer = createPmToolReconcileBearer(proof);
  assert.ok(verifyPmToolReconcileBearer(bearer, 'POST', PM_TOOL_RECONCILE_PATH, proof));
  for (const changed of [{ ...proof, operationId: randomUUID() }, { ...proof, actorId: randomUUID() }, { ...proof, target: { ...target, projectId: 'PRJ-002' } }, { ...proof, requestHash: 'f'.repeat(64) }])
    assert.equal(verifyPmToolReconcileBearer(bearer, 'POST', PM_TOOL_RECONCILE_PATH, changed), null);
  assert.equal(verifyPmToolReconcileBearer(bearer, 'GET', PM_TOOL_RECONCILE_PATH, proof), null);
  assert.equal(verifyPmToolReconcileBearer(bearer, 'POST', `${PM_TOOL_RECONCILE_PATH}?other=1`, proof), null);
  assert.equal(verifyPmToolReconcileBearer('ordinary-user-cookie', 'POST', PM_TOOL_RECONCILE_PATH, proof), null);
  const [domain, payload] = bearer.split('.');
  assert.ok(domain && payload);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  for (const changed of [{ ...claims, audience: 'other-service' }, { ...claims, purpose: 'execute-command' }, { ...claims, issuedAt: claims.issuedAt - 120_000, expiresAt: claims.expiresAt - 120_000 }]) {
    const body = Buffer.from(JSON.stringify(changed)).toString('base64url');
    assert.equal(verifyPmToolReconcileBearer(`${domain}.${body}.${mcpMac(domain, body)}`, 'POST', PM_TOOL_RECONCILE_PATH, proof), null);
  }
});

test('execution linkage is actor/request-bound full audit-only evidence, not a new permission', t => {
  const secret = process.env.PM_AUTOMATION_SERVICE_SECRET;
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'isolated-operation-service-proof-secret'.repeat(3);
  t.after(() => { if (secret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = secret; });
  const input = request(), evidence = linkage(), hash = pmToolRequestHash({ ...input, linkage: evidence }, actorId);
  const bearer = createPmToolLinkageBearer(actorId, hash, evidence);
  assert.equal(verifyPmToolLinkageBearer(bearer, actorId, hash, evidence), true);
  assert.equal(verifyPmToolLinkageBearer(bearer, randomUUID(), hash, evidence), false);
  assert.equal(verifyPmToolLinkageBearer(bearer, actorId, 'a'.repeat(64), evidence), false);
  assert.equal(verifyPmToolLinkageBearer(bearer, actorId, hash, { ...evidence, traceId: randomUUID() }), false);
  assert.equal(evidence.policy, 'full'); assert.equal(evidence.enforcement, 'audit-only');
  const reordered = { ...input, arguments: { description: 'body', title: 'title' } };
  assert.equal(pmToolRequestHash(reordered, actorId), pmToolRequestHash({ ...reordered, arguments: { title: 'title', description: 'body' } }, actorId));
  assert.notEqual(pmToolRequestHash(input, actorId), pmToolRequestHash({ ...input, arguments: { title: 'Changed' } }, actorId));
});

test('external execution has no fake Chat IDs and hidden projections cannot carry a full result', () => {
  const original = request();
  const external = pmToolRequestSchema.parse({ operationId: original.operationId, name: original.name, arguments: original.arguments, target, executionRoot: 'external' });
  assert.equal(external.threadId, ''); assert.equal(external.messageId, ''); assert.equal(external.generationId, '');
  assert.equal(pmToolRequestSchema.safeParse({ ...external, threadId: 'pretend-chat' }).success, false);
  assert.equal(pmToolRequestSchema.safeParse({ ...external, executionRoot: undefined }).success, false);
  const placeholder = { operationId: original.operationId, threadId: 'thread', messageId: 'message', generationId: 'generation', visibility: 'redacted' };
  assert.equal(pmToolCallProjectionSchema.safeParse(placeholder).success, true);
  assert.equal(pmToolCallProjectionSchema.safeParse({ ...placeholder, status: 'succeeded', name: original.name, target, actorId, workspaceId: target.workspaceId,
    result: null, error: null, createdAt: new Date().toISOString(), finishedAt: null }).success, false);
});
