import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createAutomationStudioService } from '../packages/application/src/automation-studio.ts';
import { runAutomationStudioBatch } from '../packages/application/src/automation-studio-worker.ts';
import { authorizeAutomationStudioService } from '../packages/application/src/automation-studio-auth.ts';
import type { StudioConfig, StudioExecutionPort, StudioExecutionRequest, StudioExecutionResult } from '../packages/contracts/src/automation-studio.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { lockWorkspace } from '../packages/infrastructure/src/database.ts';
import { readonlyCorePort } from '../packages/pm-core/readonly.ts';
import { acquireMailFixtureDatabase, createMailFixtureDatabase, type MailFixtureDatabase } from './mail-fixture-database.ts';
import { MailFixtureScope, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';
import { assertV4WorkerTestDatabase } from './worker-environment.ts';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const config: StudioConfig = { name: 'Frozen execution', description: '', projectId: 'PRJ-001', tags: ['regression'], templateId: null, trigger: { kind: 'manual' }, action: { kind: 'prompt', providerInstanceId: 'test-provider', model: 'test-model', options: {}, prompt: 'Read the current project', repositories: [], plugins: [], timeoutSeconds: 60 }, dailyLimit: 10, cooldownMinutes: 0 };
const rejected = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
let database: MailFixtureDatabase;
async function fixture(signal: AbortSignal) {
  const scope = new MailFixtureScope(signal);
  return scope.initialize(async () => {
    const { pool } = await acquireMailFixtureDatabase(scope, database);
    const owner = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Studio owner', password: 'Isolated-Studio-Only-Password' });
    const workspaceId = (await createWorkspace(pool, owner.id, 'Execution regression')).id;
    const root = await scope.acquire(() => mkdtemp(join(tmpdir(), 'pm-studio-')), value => rm(value, { recursive: true, force: true }));
    const projectRoot = join(root, workspaceId, 'projects'); await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, 'PRJ-001.md'), '---\nschema: pm/v1\nid: PRJ-001\nentity: project\nstatus: active\n---\n# Studio project\n');
    const core = readonlyCorePort(id => join(root, id));
    let dispatches = 0, queries = 0, cancels = 0, lastRequest: StudioExecutionRequest | null = null;
    let loseDispatch = false;
    const completed: StudioExecutionResult = { status: 'completed', externalExecutionId: 'external-original', threadId: 'native-thread', summary: 'Controlled runtime result', error: null, logs: [{ id: 'log-1', at: new Date().toISOString(), message: 'Controlled transport log', stream: 'system' }] };
    const runtime: StudioExecutionPort = {
      capabilities: async () => ({ actions: [{ id: 'prompt', available: true, reason: null }, { id: 'script', available: false, reason: 'test fixture does not run scripts' }], providers: [{ id: 'test-provider', name: 'Controlled test port', models: ['test-model'] }], repositories: [], plugins: [], features: [{ id: 'provider:test-provider:promptConnectors', available: true, reason: null }, { id: 'provider:test-provider:templateWorkspace', available: true, reason: null }] }),
      async dispatch(request) {
        dispatches++; lastRequest = request;
        // A new connection must be able to acquire the workspace lock while the transport is awaited.
        const other = await pool.connect();
        try { await other.query('BEGIN'); await other.query("SET LOCAL lock_timeout='500ms'"); await lockWorkspace(other, workspaceId); await other.query('COMMIT'); } finally { other.release(); }
        if (loseDispatch) throw new Error('Response lost after external acceptance');
        return completed;
      },
      async query() { queries++; return completed; },
      async cancel() { cancels++; return { ...completed, status: 'cancelled' }; },
    };
    const service = createAutomationStudioService({ database: () => pool, core, runtime, definitionResolver: {
      list: async () => ({ contextId: 'controlled-project', definitions: [{ contextId: 'controlled-project', serverId: 'github', name: 'Controlled MCP fixture', configFingerprint: 'a'.repeat(64), transport: 'streamable-http' }] }),
      resolve: async () => { throw new Error('Studio metadata must not request definition credentials'); },
    } });
    return { pool, owner, workspaceId, core, runtime, service, scope, stats: () => ({ dispatches, queries, cancels, lastRequest }), loseDispatch: () => { loseDispatch = true; }, create: () => service.create(owner, workspaceId, { requestId: randomUUID(), config }) };
  });
}
describe('PostgreSQL Studio definitions, immutable results and unknown-safe dispatch', { skip: !source }, () => {
  before(async t => { assert.ok(source); assertV4WorkerTestDatabase(source); database = await createMailFixtureDatabase({ signal: t.signal }); }, { timeout: mailSchemaInitTimeout });
  after(async () => { await database?.close(); }, { timeout: 30000 });
  it('persists drafts, CAS conflicts and original receipts; validation never queues or calls dispatch', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const requestId = randomUUID(); const input = { requestId, config };
    const [a,b] = await Promise.all([f.service.create(f.owner, f.workspaceId, input), f.service.create(f.owner, f.workspaceId, input)]);
    assert.deepEqual(a,b); assert.equal(a.status, 'draft');
    const validation = await f.service.validate(f.owner, f.workspaceId, config); assert.equal(validation.valid, true);
    assert.equal((await f.service.executions(f.owner, f.workspaceId)).items.length, 0); assert.equal(f.stats().dispatches, 0);
    const changed = await f.service.update(f.owner, f.workspaceId, a.id, { requestId: randomUUID(), expectedRevision: 1, config: { ...config, name: 'Edited' } });
    assert.equal(changed.revision, 2);
    const failedKey = randomUUID(); await assert.rejects(f.service.update(f.owner, f.workspaceId, a.id, { requestId: failedKey, expectedRevision: 1, config }), rejected('version_conflict'));
    assert.equal((await f.service.receipt(f.owner, f.workspaceId, failedKey)).httpStatus, 409);
    assert.deepEqual((await f.service.receipt(f.owner, f.workspaceId, requestId)).result, a);
    await assert.rejects(f.service.create(f.owner, f.workspaceId, { requestId, config: { ...config, name: 'Other' } }), rejected('idempotency_conflict'));
  });
  it('explicit test freezes a revision and real transport is outside SQL; finished results and logs survive delete', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close); const definition = await f.create();
    const execution = await f.service.dispatchTest(f.owner, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: 1 }); assert.equal(execution.status, 'queued');
    await Promise.all([runAutomationStudioBatch(f.pool, f.core, f.runtime, 'worker-a'), runAutomationStudioBatch(f.pool, f.core, f.runtime, 'worker-b')]);
    const result = await f.service.execution(f.owner, f.workspaceId, execution.id); assert.equal(result.status, 'completed'); assert.equal(result.threadId, 'native-thread'); assert.equal(f.stats().dispatches, 1);
    assert.deepEqual(f.stats().lastRequest?.config, config);
    await f.service.remove(f.owner, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: 1 });
    assert.deepEqual(await f.service.execution(f.owner, f.workspaceId, execution.id), result);
    assert.ok((await f.service.logs(f.owner, f.workspaceId, execution.id)).items.some(event => event.message === 'Controlled transport log'));
    await assert.rejects(f.pool.query('UPDATE automation_studio_executions SET summary=summary WHERE id=$1', [execution.id]));
    await assert.rejects(f.pool.query('DELETE FROM automation_studio_execution_events WHERE execution_id=$1', [execution.id]));
  });
  it('a lost dispatch response is queried by its original identity, never redispatched', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close); f.loseDispatch(); const definition = await f.create();
    const execution = await f.service.dispatchTest(f.owner, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: 1 });
    await runAutomationStudioBatch(f.pool, f.core, f.runtime, 'worker-original');
    assert.equal((await f.service.execution(f.owner, f.workspaceId, execution.id)).status, 'outcome_unknown');
    const reconciled = await f.service.query(f.owner, f.workspaceId, execution.id); assert.equal(reconciled.status, 'completed');
    assert.equal(f.stats().dispatches, 1); assert.equal(f.stats().queries, 1);
  });
  it('revocation prevents new dispatch; native service grant never authenticates a global PM endpoint', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close); const definition = await f.create();
    const execution = await f.service.dispatchTest(f.owner, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: 1 });
    await f.pool.query('UPDATE memberships SET capabilities=$3 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner.id, ['domain.read']]);
    await runAutomationStudioBatch(f.pool, f.core, f.runtime, 'worker-revoked'); assert.equal(f.stats().dispatches, 0);
    assert.equal((await f.service.execution(f.owner, f.workspaceId, execution.id)).status, 'skipped');
    const identity = { actorId: f.owner.id, workspaceId: f.workspaceId, projectId: config.projectId, executionId: execution.id, requestId: execution.requestId, definitionId: definition.id, definitionRevision: 1 };
    await assert.rejects(authorizeAutomationStudioService(f.pool, f.core, identity, { method: 'GET', url: `/api/v1/workspaces/${f.workspaceId}/entities`, body: undefined }), rejected('automation_service_scope_forbidden'));
  });
  it('full-date once is claimed by two Workers once, then remains exhausted across future years', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const at = new Date(Date.now() + 600000);
    const once = await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: { ...config, trigger: { kind: 'once', at: at.toISOString(), timezone: 'UTC' } } });
    const enabled = await f.service.setStatus(f.owner, f.workspaceId, once.id, { requestId: randomUUID(), expectedRevision: 1, status: 'enabled' });
    assert.equal(enabled.nextDueAt, at.toISOString());
    const due = new Date(at.getTime() + 1000);
    await Promise.all([runAutomationStudioBatch(f.pool, f.core, f.runtime, 'once-a', { now: due }), runAutomationStudioBatch(f.pool, f.core, f.runtime, 'once-b', { now: due })]);
    assert.equal(f.stats().dispatches, 1);
    assert.equal((await f.service.definition(f.owner, f.workspaceId, once.id)).nextDueAt, null);
    await runAutomationStudioBatch(f.pool, f.core, f.runtime, 'next-year', { now: new Date(at.getTime() + 366 * 86400000) });
    assert.equal((await f.service.executions(f.owner, f.workspaceId, once.id)).items.length, 1);
  });
  it('daily budget and cooldown count committed attempts, including explicit test execution', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const definition = await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: { ...config, dailyLimit: 1, cooldownMinutes: 60 } });
    await f.service.dispatchTest(f.owner, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: 1 });
    await f.service.dispatchTest(f.owner, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: 1 });
    await runAutomationStudioBatch(f.pool, f.core, f.runtime, 'budget');
    const history = (await f.service.executions(f.owner, f.workspaceId, definition.id)).items;
    assert.equal(f.stats().dispatches, 1);
    assert.equal(history.filter(item => item.status === 'completed').length, 1);
    assert.equal(history.filter(item => item.status === 'skipped' && item.error === 'daily_limit').length, 1);
  });
  it('queued cancellation commits its event before freezing the result and never dispatches', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close); const definition = await f.create();
    const queued = await f.service.dispatchTest(f.owner, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: 1 });
    const requestId = randomUUID();
    const cancelled = await f.service.cancel(f.owner, f.workspaceId, queued.id, { requestId });
    assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.finishedAt);
    assert.deepEqual((await f.service.receipt(f.owner, f.workspaceId, requestId)).result, cancelled);
    assert.ok((await f.service.logs(f.owner, f.workspaceId, queued.id)).items.some(event => event.kind === 'cancel'));
    await runAutomationStudioBatch(f.pool, f.core, f.runtime, 'cancelled');
    assert.equal(f.stats().dispatches, 0);
  });
  it('pause does not cancel a started run and current native grants remain confined to its one project', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close); const definition = await f.create();
    const enabled = await f.service.setStatus(f.owner, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: 1, status: 'enabled' });
    f.runtime.dispatch = async () => ({ status: 'running', externalExecutionId: 'original-running', threadId: 'native-thread', error: null, summary: 'Controlled running generation', logs: [] });
    const queued = await f.service.run(f.owner, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: enabled.revision });
    await runAutomationStudioBatch(f.pool, f.core, f.runtime, 'running');
    const paused = await f.service.setStatus(f.owner, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: enabled.revision, status: 'paused' });
    assert.equal(paused.status, 'paused');
    assert.equal((await f.service.execution(f.owner, f.workspaceId, queued.id)).status, 'running');
    const identity = { actorId: f.owner.id, workspaceId: f.workspaceId, projectId: config.projectId, executionId: queued.id, requestId: queued.requestId, definitionId: definition.id, definitionRevision: enabled.revision };
    assert.equal((await authorizeAutomationStudioService(f.pool, f.core, identity, { method: 'POST', url: '/api/v1/agent-contexts/resolve', body: { workspaceId: f.workspaceId, projectId: config.projectId } })).id, f.owner.id);
    await assert.rejects(authorizeAutomationStudioService(f.pool, f.core, identity, { method: 'POST', url: '/api/v1/agent-contexts/resolve', body: { workspaceId: f.workspaceId, projectId: null } }), rejected('automation_service_scope_forbidden'));
    assert.equal((await f.service.query(f.owner, f.workspaceId, queued.id)).status, 'completed');
  });
  it('validates and enables deterministic native maintenance with explicit None and no configured model', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    f.runtime.capabilities = async () => ({ actions: [{ id: 'template', available: true, reason: null }], providers: [], repositories: [], plugins: [] });
    for (const templateId of ['github-delivery-watchdog', 'github-stale-ci-pr-closer'] as const) {
      const arguments_: Record<string, unknown> = { repositories: ['org/repository'], githubTokenSecret: 'GITHUB_TOKEN_REFERENCE' };
      if (templateId === 'github-delivery-watchdog') arguments_.branchPrefix = 'openhands/issue';
      const native: StudioConfig = { ...config, action: { kind: 'template', templateId, arguments: arguments_, providerInstanceId: null, model: null, options: {}, repositories: [], plugins: [], timeoutSeconds: 60 } };
      const validation = await f.service.validate(f.owner, f.workspaceId, native);
      assert.equal(validation.valid, true);
      const draft = await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: native });
      const enabled = await f.service.setStatus(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: 1, status: 'enabled' });
      assert.equal(enabled.status, 'enabled');
      assert.deepEqual(enabled.config.action, native.action);
    }
  });
  it('filters API-only plugin capabilities by action and Worker rejects unsuitable frozen prompt refs before dispatch', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const connectionId = randomUUID(), plugin = { id: `integration:${connectionId}`, version: '1' };
    const connection = { projectId: config.projectId, provider: 'github', label: 'Controlled native API fixture', readTools: [], writeTools: [], nativeApi: { baseUrl: 'https://api.github.com', repositories: ['org/repository'], allowWrites: false } };
    await f.pool.query("INSERT INTO automation_integration_connections(id,workspace_id,actor_id,project_id,config,native_private_config,has_credentials,status,verification) VALUES($1,$2,$3,$4,$5::jsonb,'controlled-no-credentials',false,'verified',$6::jsonb)", [connectionId, f.workspaceId, f.owner.id, config.projectId, JSON.stringify(connection), JSON.stringify({ mcp: false, nativeApi: true })]);
    assert.ok((await f.service.capabilities(f.owner, f.workspaceId, config.projectId)).plugins.some(item => item.id === plugin.id));
    assert.ok((await f.service.capabilities(f.owner, f.workspaceId, config.projectId, 'template')).plugins.some(item => item.id === plugin.id));
    for (const kind of ['prompt', 'script'] as const) assert.equal((await f.service.capabilities(f.owner, f.workspaceId, config.projectId, kind)).plugins.some(item => item.id === plugin.id), false);
    const prompt: StudioConfig = { ...config, action: { ...config.action, plugins: [plugin] } };
    assert.ok((await f.service.validate(f.owner, f.workspaceId, prompt)).issues.some(issue => issue.code === 'plugin_unavailable'));
    const draft = await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: prompt });
    const queued = await f.service.dispatchTest(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: 1 });
    await runAutomationStudioBatch(f.pool, f.core, f.runtime, 'mechanism-check');
    assert.equal(f.stats().dispatches, 0);
    const skipped = await f.service.execution(f.owner, f.workspaceId, queued.id);
    assert.equal(skipped.status, 'skipped'); assert.equal(skipped.error, 'integration_mechanism_unavailable_for_action');
    await f.pool.query('UPDATE automation_integration_connections SET verification=$2::jsonb WHERE id=$1', [connectionId, JSON.stringify({ mcp: false, nativeApi: false })]);
    assert.equal((await f.service.capabilities(f.owner, f.workspaceId, config.projectId, 'template')).plugins.some(item => item.id === plugin.id), false, 'Generic verified status does not replace durable native-API evidence');
  });
  it('gates the selected Provider protocol before activation, affected Test queue and Worker dispatch without network under SQL locks', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const connectionId = randomUUID(), plugin = { id: `integration:${connectionId}`, version: '1' };
    const connection = { projectId: config.projectId, provider: 'github', label: 'Controlled MCP fixture', mcpDefinition: { contextId: 'controlled-project', serverId: 'github' }, readTools: ['read_repository'], writeTools: [] };
    await f.pool.query("INSERT INTO automation_integration_connections(id,workspace_id,actor_id,project_id,config,native_private_config,has_credentials,status,verification,mcp_config_fingerprint) VALUES($1,$2,$3,$4,$5::jsonb,'',false,'verified',$6::jsonb,$7)", [connectionId, f.workspaceId, f.owner.id, config.projectId, JSON.stringify(connection), JSON.stringify({ mcp: true, nativeApi: false }), 'a'.repeat(64)]);
    const originalCapabilities = f.runtime.capabilities;
    let support: boolean | null = true;
    f.runtime.capabilities = async scope => {
      const other = await f.pool.connect();
      try { await other.query('BEGIN'); await other.query("SET LOCAL lock_timeout='500ms'"); await lockWorkspace(other, f.workspaceId); await other.query('COMMIT'); } finally { other.release(); }
      const current = await originalCapabilities(scope);
      return { ...current, features: support === null ? [] : [{ id: 'provider:test-provider:promptConnectors', available: support, reason: support ? null : 'Controlled adapter cannot carry two scoped MCP servers' }] };
    };
    const prompt: StudioConfig = { ...config, action: { ...config.action, plugins: [plugin] } };
    const draft = await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: prompt });
    assert.equal((await f.service.validate(f.owner, f.workspaceId, prompt)).valid, true);
    const queued = await f.service.dispatchTest(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: 1 });
    support = false;
    const testKey = randomUUID();
    await assert.rejects(f.service.dispatchTest(f.owner, f.workspaceId, draft.id, { requestId: testKey, expectedRevision: 1 }), rejected('automation_configuration_unavailable'));
    assert.equal((await f.service.receipt(f.owner, f.workspaceId, testKey)).httpStatus, 409);
    await assert.rejects(f.service.setStatus(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: 1, status: 'enabled' }), rejected('automation_configuration_unavailable'));
    assert.equal((await f.service.executions(f.owner, f.workspaceId, draft.id)).items.length, 1);
    await runAutomationStudioBatch(f.pool, f.core, f.runtime, 'provider-protocol');
    assert.equal(f.stats().dispatches, 0);
    const skipped = await f.service.execution(f.owner, f.workspaceId, queued.id);
    assert.equal(skipped.status, 'skipped'); assert.equal(skipped.error, 'provider_tool_protocol_unavailable');
    support = null;
    assert.ok((await f.service.validate(f.owner, f.workspaceId, prompt)).issues.some(issue => issue.code === 'provider_tool_protocol_unavailable'), 'Missing required feature never implies generic support');
  });
});
