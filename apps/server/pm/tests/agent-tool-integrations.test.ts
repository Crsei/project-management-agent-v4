import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { createIntegrationsToolFamily, type IntegrationsToolDependencies } from '../src/agent-tools/agent-tool-integrations.ts';
import { IntegrationsToolResultSchema } from '../../../../packages/agent-contracts/src/pm-tool-integrations.ts';
import { IntegrationsToolInputSchemas } from '../../../../packages/application/src/agent-tool-integrations.ts';
import { automationIntegrationProviders } from '../../../../packages/contracts/src/automation-integrations.ts';
import type { AutomationIntegrationConnection } from '../../../../packages/contracts/src/automation-integrations.ts';
import type { AutomationIntegrationReceiptProof } from '../../../../packages/application/src/automation-integrations-store.ts';
import type { AgentChatToolContext } from '../../../../packages/application/src/agent-chat-tools.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import { DomainError } from '../../../../packages/domain/src/core.ts';

const workspaceId = '11111111-1111-4111-a111-111111111111';
const actorId = '22222222-2222-4222-a222-222222222222';
const connectionId = '33333333-3333-4333-a333-333333333333';
const operationId = '44444444-4444-4444-a444-444444444444';
const date = '2026-11-13T00:00:00Z';
const connection: AutomationIntegrationConnection = { id: connectionId, projectId: 'PRJ-001', provider: 'github', label: 'Existing native binding', readTools: [], writeTools: [], nativeApi: { baseUrl: 'https://api.github.com', repositories: ['owner/repo'], allowWrites: false }, revision: 1, status: 'configured', verification: { mcp: false, nativeApi: false }, hasCredentials: true, mcpConfigFingerprint: null, lastCheckedAt: null, lastError: null, createdAt: date, updatedAt: date };
function fixture() {
  let active = true, projectIds: string[] | null = null, capabilities = ['domain.read', 'planning.edit', 'access.manage', 'audit.read'];
  let proof: AutomationIntegrationReceiptProof | null = null;
  let receiptResult: unknown = connection;
  let verifyCalls = 0, writeCalls = 0, commandReads = 0;
  const statements: string[] = [];
  const pool = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.startsWith('SELECT m.* FROM memberships')) return { rows: active ? [{ user_id: actorId, workspace_id: workspaceId, capabilities, project_ids: projectIds, version: 1, revoked_at: null }] : [] };
      throw new Error(`Unexpected test SQL; family must call native services: ${sql}`);
    },
  } as unknown as Pool;
  const context: AgentChatToolContext = { actor: { id: actorId, email: 'actor@example.test', name: 'Actor' }, workspaceId, threadId: '', messageId: '', operationId, scope: { kind: 'workspace', projectIds: ['PRJ-001'] } };
  const options: IntegrationsToolDependencies = {
    database: () => pool,
    integrations: {
      list: async () => { if (!active) throw new DomainError('not_found_or_forbidden'); return { providers: automationIntegrationProviders, connections: [connection], privateStorageAvailable: true }; },
      definitions: async () => ({ contextId: 'owned', definitions: [] }),
      async verify(_actor, _workspace, id, mutation, checkAuthorization) {
        verifyCalls++;
        await checkAuthorization?.(pool);
        assert.equal(id, connectionId);
        const verified: AutomationIntegrationConnection = { ...connection, revision: 2, status: 'verified', verification: { mcp: false, nativeApi: true }, lastCheckedAt: date };
        receiptResult = verified;
        proof = { hash: requestHash({ ...mutation, id, kind: 'connection-verify' }), outcome: 'committed', projectIds: ['PRJ-001'] };
        return verified;
      },
      revoke: async () => { throw new Error('Recovery must never call revoke'); },
      receipt: async (_actor, _workspace, requestId) => { if (!active) throw new DomainError('not_found_or_forbidden'); return { requestId, result: receiptResult, httpStatus: 200 }; },
      operation: async (_actor, _workspace, id) => ({ id, executionId: operationId, connectionId, connectionRevision: 1, status: 'completed', result: { privateExternalBody: 'must-not-enter-model-context' }, createdAt: date, finishedAt: date }),
    },
    events: { list: async () => ({ items: [] }), events: async () => ({ items: [], nextCursor: null }), revoke: async () => { throw new Error('Unexpected event write'); } },
    inspectIntegrationReceipt: async () => proof,
    imConfiguration: () => 'disabled',
    imConnectivity: () => ({ satori: { state: 'disconnected', readyAt: null, lastEventAt: null, lastErrorCode: null }, bots: [] }),
    executeCommand: async (_actor, _workspace, command, guard) => {
      writeCalls++; await guard?.(pool);
      return { commandId: command.commandId, status: 'committed', httpStatus: 200, result: { deliveryId: connectionId, state: 'ready', version: 8 } };
    },
    readCommandReceipt: async (_actor, _workspace, command) => { commandReads++; return { commandId: command.commandId, status: 'committed', httpStatus: 200, result: { deliveryId: connectionId, state: 'ready', version: 8 } }; },
  };
  return { family: createIntegrationsToolFamily(options), context, statements,
    revokeActor() { active = false; }, restrict() { projectIds = ['PRJ-001']; }, removeAudit() { capabilities = capabilities.filter(value => value !== 'audit.read'); },
    setProof(value: AutomationIntegrationReceiptProof | null) { proof = value; },
    get verifyCalls() { return verifyCalls; }, get writeCalls() { return writeCalls; }, get commandReads() { return commandReads; },
  };
}

test('strict model surface cannot carry secrets, config editing, actor impersonation or arbitrary provider requests', () => {
  assert.equal(Object.hasOwn(IntegrationsToolInputSchemas, 'pm_save_integration'), false);
  assert.equal(Object.hasOwn(IntegrationsToolInputSchemas, 'pm_create_im_link_code'), false);
  assert.equal(IntegrationsToolInputSchemas.pm_verify_integration.safeParse({ projectId: 'PRJ-001', id: connectionId, expectedRevision: 1, nativePrivateHeaders: { Authorization: 'not-allowed' } }).success, false);
  assert.equal(IntegrationsToolInputSchemas.pm_set_im_notifications.safeParse({ bindingId: connectionId, notifyEnabled: true, actorId }).success, false);
});

test('connection metadata strips config and provider operations never leak raw external results', async () => {
  const f = fixture();
  const list = IntegrationsToolResultSchema.parse(await f.family.execute('pm_list_integrations', { projectId: 'PRJ-001', after: null, limit: 1 }, f.context));
  assert.equal(list.kind, 'integration_connections');
  assert.doesNotMatch(JSON.stringify(list), /https:\/\/api\.github\.com|owner\/repo/);
  const operation = IntegrationsToolResultSchema.parse(await f.family.execute('pm_read_integration_operation', { projectId: 'PRJ-001', id: operationId }, f.context));
  assert.equal(operation.kind, 'integration_operation');
  if (operation.kind !== 'integration_operation') throw new Error('Wrong result');
  assert.equal(operation.operation.resultAvailable, true);
  assert.equal(operation.operation.id, operationId);
  assert.ok(!JSON.stringify(operation).includes('must-not-enter-model-context'));
  await assert.rejects(f.family.execute('pm_list_integrations', { projectId: 'PRJ-002', after: null, limit: 1 }, f.context), /outside the explicitly authorized/);
});

test('explicit verification binds original native UUID/hash and recovery is inspection-only across dropped delivery', async () => {
  const f = fixture(), args = { projectId: 'PRJ-001', id: connectionId, expectedRevision: 1 };
  let guards = 0; f.context.checkAuthorization = async () => { guards++; };
  const identity = f.family.recoveryIdentity('pm_verify_integration', args, f.context);
  assert.ok(identity); assert.equal(identity.kind, 'integration');
  assert.deepEqual(f.family.recoveryIdentity('pm_verify_integration', args, f.context), identity);
  const result = IntegrationsToolResultSchema.parse(await f.family.execute('pm_verify_integration', args, f.context));
  assert.equal(result.kind, 'integration_receipt'); assert.equal(f.verifyCalls, 1); assert.ok(guards >= 2);
  const recovered = IntegrationsToolResultSchema.parse(await f.family.recover('pm_verify_integration', args, f.context));
  assert.equal(recovered.receipt?.commandId, identity.commandId);
  assert.equal(recovered.receipt?.kind, 'application');
  assert.equal(f.verifyCalls, 1, 'recovery must never probe credentials again');
  assert.ok(f.family.inspectOutcome);
  assert.deepEqual(await f.family.inspectOutcome(identity, actorId, workspaceId), { status: 'succeeded', evidence: 'application_receipt' });
  f.setProof({ hash: 'f'.repeat(64), outcome: 'committed', projectIds: ['PRJ-001'] });
  assert.equal(await f.family.recover('pm_verify_integration', args, f.context), null);
  assert.deepEqual(await f.family.inspectOutcome(identity, actorId, workspaceId), { status: 'unknown', evidence: 'unresolved' });
  f.setProof({ hash: identity.hash, outcome: 'committed', projectIds: ['PRJ-002'] });
  assert.deepEqual(await f.family.inspectOutcome(identity, actorId, workspaceId), { status: 'unknown', evidence: 'unresolved' });
});

test('stored private result is withheld under current membership revocation, without mutating original status', async () => {
  const f = fixture(), args = { projectId: 'PRJ-001', after: null, limit: 20 };
  const result = await f.family.execute('pm_list_integrations', args, f.context);
  assert.ok(f.family.authorizeResult);
  await f.family.authorizeResult('pm_list_integrations', args, result, f.context);
  f.revokeActor();
  await assert.rejects(f.family.authorizeResult('pm_list_integrations', args, result, f.context), /Workspace is not accessible/);
  assert.equal(f.verifyCalls, 0); assert.equal(f.writeCalls, 0);
});

test('webhook resume uses native command receipt recovery and rejects current restricted/admin capability changes', async () => {
  const f = fixture(), args = { id: connectionId, expectedVersion: 7, receiptId: operationId };
  const result = await f.family.execute('pm_resume_webhook_delivery', args, f.context);
  assert.equal(f.writeCalls, 1);
  const recovered = await f.family.recover('pm_resume_webhook_delivery', args, f.context);
  assert.ok(recovered); assert.equal(f.commandReads, 1); assert.equal(f.writeCalls, 1);
  assert.ok(f.family.authorizeResult);
  await f.family.authorizeResult('pm_resume_webhook_delivery', args, result, f.context);
  assert.equal(f.commandReads, 2, 'stored result uses pure original receipt authorization, not another command');
  f.removeAudit();
  await assert.rejects(f.family.authorizeResult('pm_resume_webhook_delivery', args, result, f.context), /Current native workspace/);
  const restricted = fixture(); restricted.restrict();
  await assert.rejects(restricted.family.execute('pm_resume_webhook_delivery', args, restricted.context), /Current native workspace/);
  assert.equal(restricted.writeCalls, 0);
});

test('IM preference/revocation have no fabricated receipt or automatic recovery write', async () => {
  const f = fixture();
  assert.equal(f.family.recoveryIdentity('pm_set_im_notifications', { bindingId: connectionId, notifyEnabled: true }, f.context), null);
  assert.equal(await f.family.recover('pm_set_im_notifications', { bindingId: connectionId, notifyEnabled: true }, f.context), null);
  assert.equal(f.writeCalls, 0); assert.equal(f.verifyCalls, 0);
});
