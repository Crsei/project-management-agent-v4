import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createIntegrationsToolFamily } from '../apps/server/pm/src/agent-tool-integrations.ts';
import { createAutomationIntegrationsService } from '../packages/application/src/automation-integrations.ts';
import { createAutomationEventsService } from '../packages/application/src/automation-events.ts';
import { inspectAutomationIntegrationReceipt } from '../packages/application/src/automation-integrations-store.ts';
import { IntegrationsToolResultSchema } from '../packages/agent-contracts/src/pm-tool-integrations.ts';
import type { AgentChatToolContext } from '../packages/application/src/agent-chat-tools.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createAutomationPrivateStore } from '../packages/infrastructure/src/automation-integrations.ts';
import { readonlyCorePort } from '../packages/pm-core/readonly.ts';
import { acquireMailFixtureDatabase, createMailFixtureDatabase, type MailFixtureDatabase } from './mail-fixture-database.ts';
import { MailFixtureScope, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';
import { assertV4WorkerTestDatabase } from './worker-environment.ts';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
let database: MailFixtureDatabase;
describe('T29 native original integration proof and current result authorization', { skip: !source }, () => {
  before(async t => { assert.ok(source); assertV4WorkerTestDatabase(source); database = await createMailFixtureDatabase({ signal: t.signal }); }, { timeout: mailSchemaInitTimeout });
  after(async () => { await database?.close(); }, { timeout: 30000 });
  it('recovers only the committed original request, guards mutations inside the native lock and redacts after current revocation', { timeout: 60000 }, async t => {
    const scope = new MailFixtureScope(t.signal);
    const f = await scope.initialize(async () => {
      const { pool } = await acquireMailFixtureDatabase(scope, database);
      const actor = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'CLI integrations owner', password: 'Isolated-Integration-Password-Only' });
      const workspaceId = (await createWorkspace(pool, actor.id, 'Original integrations')).id;
      const root = await scope.acquire(() => mkdtemp(join(tmpdir(), 'cli-integration-original-')), value => rm(value, { recursive: true, force: true }));
      await mkdir(join(root, workspaceId, 'projects'), { recursive: true });
      await writeFile(join(root, workspaceId, 'projects', 'PRJ-001.md'), '---\nschema: pm/v1\nid: PRJ-001\nentity: project\nstatus: active\n---\n# Original integration scope\n');
      const core = readonlyCorePort(id => join(root, id));
      const privateStore = createAutomationPrivateStore(Buffer.alloc(32, 17).toString('base64'));
      return { pool, actor, workspaceId, core, privateStore };
    });
    t.after(scope.close);
    let probes = 0;
    const nativePrivateHeaders = { authorization: 'Bearer controlled-not-a-real-provider-credential' };
    const integrations = createAutomationIntegrationsService({
      database: () => f.pool, core: f.core, privateStore: f.privateStore,
      nativeAdapter: async (_config, headers, request) => {
        probes++;
        assert.deepEqual(headers, nativePrivateHeaders);
        assert.equal(request.provider, 'github'); assert.equal(request.method, 'GET'); assert.equal(request.path, '/repos/owner/approved');
        return { status: 200, body: { full_name: 'owner/approved' }, headers: {} };
      },
    });
    const events = createAutomationEventsService({ database: () => f.pool, core: f.core, privateStore: f.privateStore });
    const connectionId = randomUUID();
    const saved = await integrations.save(f.actor, f.workspaceId, connectionId, { requestId: randomUUID(), expectedRevision: 0, config: { projectId: 'PRJ-001', provider: 'github', label: 'Controlled transport; not a real provider acceptance', readTools: [], writeTools: [], nativeApi: { baseUrl: 'https://api.github.com', repositories: ['owner/approved'], allowWrites: false } }, nativePrivateHeaders });
    assert.equal(saved.status, 'configured'); assert.equal(probes, 0, 'saving never probes or executes');
    const family = createIntegrationsToolFamily({ database: () => f.pool, integrations, events, inspectIntegrationReceipt: (actorId, workspaceId, requestId) => inspectAutomationIntegrationReceipt(f.pool, actorId, workspaceId, requestId), imConfiguration: () => 'disabled', imConnectivity: () => ({ satori: { state: 'disconnected', readyAt: null, lastEventAt: null, lastErrorCode: null }, bots: [] }), executeCommand: async () => { throw new Error('No command dispatch expected'); }, readCommandReceipt: async () => null });
    const context: AgentChatToolContext = { actor: f.actor, workspaceId: f.workspaceId, operationId: randomUUID(), threadId: '', messageId: '', scope: { kind: 'workspace', projectIds: ['PRJ-001'] } };
    const input = { projectId: 'PRJ-001', id: connectionId, expectedRevision: saved.revision };
    const identity = family.recoveryIdentity('pm_verify_integration', input, context); assert.ok(identity);
    const result = IntegrationsToolResultSchema.parse(await family.execute('pm_verify_integration', input, context));
    assert.equal(probes, 1); assert.ok(result.kind === 'integration_receipt');
    // A committed verification receipt alone does not prove that authentication and the probe succeeded.
    assert.equal(result.outcome, 'succeeded'); assert.ok(result.connection);
    assert.equal(result.connection.status, 'verified'); assert.deepEqual(result.connection.verification, { mcp: false, nativeApi: true }); assert.equal(result.connection.lastError, null);
    const proof = await inspectAutomationIntegrationReceipt(f.pool, f.actor.id, f.workspaceId, identity.commandId);
    assert.equal(proof?.hash, identity.hash); assert.equal(proof?.outcome, 'committed'); assert.deepEqual(proof?.projectIds, ['PRJ-001']);
    const recovered = IntegrationsToolResultSchema.parse(await family.recover('pm_verify_integration', input, context));
    assert.equal(recovered.receipt?.commandId, identity.commandId); assert.equal(probes, 1, 'recovery never repeats the provider probe');
    assert.deepEqual(recovered, result, 'recovery returns the immutable original result');
    assert.equal(await family.recover('pm_verify_integration', { ...input, expectedRevision: saved.revision + 1 }, context), null, 'different original hash is never adopted');
    const rejectedRequest = randomUUID();
    await assert.rejects(integrations.revoke(f.actor, f.workspaceId, connectionId, { requestId: rejectedRequest, expectedRevision: result.connection.revision }, async sql => {
      await sql.query('SELECT 1');
      throw new DomainError('permission_denied', 'Current delegation was revoked', 403);
    }), { code: 'permission_denied', status: 403 });
    assert.equal(await inspectAutomationIntegrationReceipt(f.pool, f.actor.id, f.workspaceId, rejectedRequest), null, 'precommit authorization failure has no fabricated native outcome');
    assert.equal((await integrations.list(f.actor, f.workspaceId, 'PRJ-001')).connections[0]?.status, 'verified');
    assert.ok(family.authorizeResult);
    await family.authorizeResult('pm_verify_integration', input, result, context);
    await f.pool.query('UPDATE memberships SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actor.id]);
    await assert.rejects(family.authorizeResult('pm_verify_integration', input, result, context), { code: 'not_found_or_forbidden', status: 404 });
    const originalFact = await inspectAutomationIntegrationReceipt(f.pool, f.actor.id, f.workspaceId, identity.commandId);
    assert.equal(originalFact?.outcome, 'committed', 'current visibility is independent of original execution fact');
    assert.equal(probes, 1);
  });
});
