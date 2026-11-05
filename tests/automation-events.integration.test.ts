import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createAutomationEventsService } from '../packages/application/src/automation-events.ts';
import { createAutomationIntegrationsService } from '../packages/application/src/automation-integrations.ts';
import { createAutomationIntegrationRuntimeService } from '../packages/application/src/automation-integrations-runtime.ts';
import type { StudioConfig } from '../packages/contracts/src/automation-studio.ts';
import type { AutomationEventReceipt } from '../packages/contracts/src/automation-integrations.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createAutomationPrivateStore, type AutomationMcpAdapter } from '../packages/infrastructure/src/automation-integrations.ts';
import type { AutomationServiceIdentity } from '../packages/infrastructure/src/automation-execution-client.ts';
import { readonlyCorePort } from '../packages/pm-core/readonly.ts';
import { acquireMailFixtureDatabase, createMailFixtureDatabase, type MailFixtureDatabase } from './mail-fixture-database.ts';
import { MailFixtureScope, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';
import { assertV4WorkerTestDatabase } from './worker-environment.ts';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const rejected = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
let database: MailFixtureDatabase;
async function fixture(signal: AbortSignal) {
  const scope = new MailFixtureScope(signal);
  return scope.initialize(async () => {
    const { pool } = await acquireMailFixtureDatabase(scope, database);
    const actor = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Events owner', password: 'Isolated-Events-Only-Password' });
    const other = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Other actor', password: 'Isolated-Events-Only-Password' });
    const workspaceId = (await createWorkspace(pool, actor.id, 'Isolated Events')).id;
    await pool.query('INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) VALUES($1,$2,$3,NULL)', [workspaceId, other.id, ['domain.read', 'planning.edit']]);
    const root = await scope.acquire(() => mkdtemp(join(tmpdir(), 'pm-events-')), value => rm(value, { recursive: true, force: true }));
    await mkdir(join(root, workspaceId, 'projects'), { recursive: true });
    await writeFile(join(root, workspaceId, 'projects', 'PRJ-001.md'), '---\nschema: pm/v1\nid: PRJ-001\nentity: project\nstatus: active\n---\n# Authorized events\n');
    const core = readonlyCorePort(id => join(root, id)); const privateStore = createAutomationPrivateStore(Buffer.alloc(32, 9).toString('base64'));
    const events = createAutomationEventsService({ database: () => pool, core, privateStore });
    const secret = 'explicit-private-webhook-secret-32bytes';
    const config: StudioConfig = { name: 'Authenticated event', description: '', projectId: 'PRJ-001', tags: [], templateId: null, action: { kind: 'prompt', providerInstanceId: 'controlled-provider', model: 'controlled-model', options: {}, prompt: 'Observe authenticated payload without task mutations', repositories: [], plugins: [], timeoutSeconds: 30 }, trigger: { kind: 'event', source: 'github', key: 'pull_request', filter: {} }, dailyLimit: 100, cooldownMinutes: 0 };
    async function definition(changed: StudioConfig = config) {
      const id = randomUUID(); await pool.query("INSERT INTO automation_studio_definitions(id,workspace_id,actor_id,project_id,config,status) VALUES($1,$2,$3,$4,$5::jsonb,'enabled')", [id, workspaceId, actor.id, changed.projectId, JSON.stringify(changed)]); return id;
    }
    async function endpoint(definitionId: string, mode: 'key' | 'standard_webhooks' = 'key') { return events.save(actor, workspaceId, randomUUID(), { requestId: randomUUID(), expectedRevision: 0, config: { definitionId, projectId: 'PRJ-001', source: 'github', key: 'pull_request', verification: mode, payloadPointer: '' }, secret: mode === 'standard_webhooks' ? 'whsec_' + Buffer.alloc(32, 8).toString('base64') : secret }); }
    return { pool, actor, other, workspaceId, root, core, privateStore, events, secret, config, definition, endpoint, close: scope.close };
  });
}
describe('PostgreSQL authenticated automation events and private connector operations', { skip: !source }, () => {
  before(async t => { assert.ok(source); assertV4WorkerTestDatabase(source); database = await createMailFixtureDatabase({ signal: t.signal }); }, { timeout: mailSchemaInitTimeout });
  after(async () => { await database?.close(); }, { timeout: 30000 });
  it('atomically authenticates one event into one authorized queue row across concurrency/restart and preserves immutable receipt', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close); const definitionId = await f.definition(); const endpoint = await f.endpoint(definitionId);
    const raw = Buffer.from('{ "pull_request": {"draft": false}, "action":"opened" }'); const externalId = randomUUID(); const headers = { 'x-automation-key': f.secret, 'x-webhook-id': externalId };
    const results = await Promise.allSettled([f.events.receive(endpoint.id, raw, headers), f.events.receive(endpoint.id, raw, headers)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.filter(result => result.status === 'rejected' && rejected('event_replay_rejected')(result.reason)).length, 1);
    const executions = await f.pool.query('SELECT * FROM automation_studio_executions WHERE definition_id=$1', [definitionId]); assert.equal(executions.rowCount, 1); assert.deepEqual(executions.rows[0].payload, JSON.parse(raw.toString()));
    assert.equal((await f.events.events(f.actor, f.workspaceId, endpoint.id)).items[0]?.executionId, executions.rows[0].id);
    const restarted = createAutomationEventsService({ database: () => f.pool, core: f.core, privateStore: f.privateStore });
    await assert.rejects(restarted.receive(endpoint.id, raw, { ...headers, 'x-webhook-id': randomUUID() }), rejected('event_replay_rejected'));
    const rotated = await f.endpoint(definitionId);
    const rotatedReceipt = await restarted.receive(rotated.id, raw, { ...headers, 'x-webhook-id': randomUUID() }) as AutomationEventReceipt;
    assert.equal(rotatedReceipt.executionId, executions.rows[0].id, 'Endpoint rotation does not defeat definition/source event dedupe');
    await assert.rejects(f.pool.query('DELETE FROM automation_event_inbox WHERE endpoint_id=$1', [endpoint.id]), error => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23514'));
    await assert.rejects(f.events.events(f.other, f.workspaceId, endpoint.id), rejected('not_found_or_forbidden'));
    assert.equal((await f.pool.query('SELECT count(*)::text AS count FROM automation_studio_executions WHERE definition_id=$1', [definitionId])).rows[0].count, '1');
  });
  it('filters durably, rejects revoked-owner dispatch, and permits distinct signed standard events with identical JSON bodies', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const config: StudioConfig = { ...f.config, trigger: { kind: 'event', source: 'github', key: 'pull_request', filter: { action: 'opened' } } };
    const definitionId = await f.definition(config); const endpoint = await f.endpoint(definitionId, 'standard_webhooks'); const raw = Buffer.from('{"action":"opened"}'); const timestamp = String(Math.floor(Date.now() / 1000));
    async function receive(body: Buffer) { const id = randomUUID(); const signature = createHmac('sha256', Buffer.alloc(32, 8)).update(`${id}.${timestamp}.`).update(body).digest('base64'); return f.events.receive(endpoint.id, body, { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': 'v1,' + signature }); }
    const first = await receive(raw) as AutomationEventReceipt; const second = await receive(raw) as AutomationEventReceipt; assert.equal(first.status, 'accepted'); assert.equal(second.status, 'accepted'); assert.notEqual(first.executionId, second.executionId);
    const filtered = await receive(Buffer.from('{"action":"closed"}')) as AutomationEventReceipt; assert.equal(filtered.status, 'filtered'); assert.equal(filtered.executionId, null);
    await f.pool.query('UPDATE memberships SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actor.id]);
    await assert.rejects(receive(Buffer.from('{"action":"opened","new":true}')), rejected('not_found_or_forbidden'));
    assert.equal((await f.pool.query('SELECT count(*)::text AS count FROM automation_studio_executions WHERE definition_id=$1', [definitionId])).rows[0].count, '2');
  });
  it('keeps private headers encrypted, freezes native API operations and never redispatches an unknown external result', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    let mcpCalls = 0; let nativeProbes = 0;
    const controlledAdapter: AutomationMcpAdapter = { list: async () => { mcpCalls++; throw new Error('API-only must never contact MCP'); }, call: async () => { throw new Error('API-only has no MCP calls'); } };
    const connections = createAutomationIntegrationsService({ database: () => f.pool, core: f.core, privateStore: f.privateStore, adapter: controlledAdapter, nativeAdapter: async () => { nativeProbes++; return { status: 200, body: { full_name: 'owner/approved' }, headers: {} }; } });
    const connectionId = randomUUID(); const saved = await connections.save(f.actor, f.workspaceId, connectionId, { requestId: randomUUID(), expectedRevision: 0, config: { projectId: 'PRJ-001', provider: 'github', label: 'Explicit API-only connection', readTools: [], writeTools: [], nativeApi: { baseUrl: 'https://api.github.com', repositories: ['owner/approved'], allowWrites: true } }, nativePrivateHeaders: { Authorization: 'Bearer controlled-private-not-real-provider' } });
    assert.equal(JSON.stringify(saved).includes('controlled-private'), false);
    const stored = (await f.pool.query('SELECT native_private_config FROM automation_integration_connections WHERE id=$1', [connectionId])).rows[0]; assert.equal(stored.native_private_config.includes('controlled-private'), false);
    const verified = await connections.verify(f.actor, f.workspaceId, connectionId, { requestId: randomUUID(), expectedRevision: saved.revision });
    assert.equal(verified.status, 'verified'); assert.deepEqual(verified.verification, { mcp: false, nativeApi: true }); assert.equal(mcpCalls, 0); assert.equal(nativeProbes, 1);
    const config: StudioConfig = { ...f.config, templateId: 'github-delivery-watchdog', action: { kind: 'template', templateId: 'github-delivery-watchdog', arguments: { repositories: ['owner/approved'] }, providerInstanceId: null, model: null, options: {}, repositories: [], plugins: [{ id: `integration:${connectionId}`, version: String(verified.revision) }], timeoutSeconds: 30 } };
    const definitionId = await f.definition(config); const endpoint = await f.endpoint(definitionId);
    const received = await f.events.receive(endpoint.id, Buffer.from('{"action":"opened","for":"native"}'), { 'x-automation-key': f.secret, 'x-webhook-id': randomUUID() }) as AutomationEventReceipt; assert.ok(received.executionId);
    await f.pool.query('UPDATE automation_studio_executions SET dispatched_at=clock_timestamp() WHERE id=$1', [received.executionId]);
    const row = (await f.pool.query('SELECT request_id FROM automation_studio_executions WHERE id=$1', [received.executionId])).rows[0]; const generationId = randomUUID();
    const identity: AutomationServiceIdentity = { actorId: f.actor.id, workspaceId: f.workspaceId, projectId: 'PRJ-001', executionId: received.executionId!, requestId: row.request_id, definitionId, definitionRevision: 1, audience: 'automation-integrations', generationId, issuedAt: Date.now(), expiresAt: Date.now() + 60000 };
    let attempts = 0;
    const broker = createAutomationIntegrationRuntimeService({ database: () => f.pool, core: f.core, privateStore: f.privateStore, adapter: controlledAdapter, nativeAdapter: async () => { attempts++; throw new Error('Controlled response lost after possible provider write'); } });
    await broker.handle(identity, { executionId: identity.executionId, generationId, method: 'grant/open' });
    assert.deepEqual(await broker.handle(identity, { executionId: identity.executionId, generationId, method: 'tools/list' }), { tools: [] }); assert.equal(mcpCalls, 0);
    const call = { executionId: identity.executionId, generationId, method: 'provider/request' as const, params: { provider: 'github', operationId: randomUUID(), method: 'POST', path: '/repos/owner/approved/issues/1/comments', body: { body: 'Explicit controlled test write' } } };
    await assert.rejects(broker.handle(identity, call), rejected('integration_outcome_unknown')); await assert.rejects(broker.handle(identity, call), rejected('integration_outcome_unknown')); assert.equal(attempts, 1);
    await broker.handle(identity, { executionId: identity.executionId, generationId, method: 'grant/close' });
    await assert.rejects(broker.handle(identity, call), rejected('integration_grant_revoked'));
    const revoked = await connections.revoke(f.actor, f.workspaceId, connectionId, { requestId: randomUUID(), expectedRevision: verified.revision }); assert.deepEqual(revoked.verification, { mcp: false, nativeApi: false });
    assert.equal((await connections.operation(f.actor, f.workspaceId, String(call.params.operationId))).status, 'outcome_unknown', 'Historical original outcome remains authorized and readable after connector revocation');
  });
  it('withholds a confirmed external result after revocation without losing the original completed receipt', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const connections = createAutomationIntegrationsService({ database: () => f.pool, core: f.core, privateStore: f.privateStore, nativeAdapter: async () => ({ status: 200, body: { full_name: 'owner/approved' }, headers: {} }) });
    const connectionId = randomUUID();
    const saved = await connections.save(f.actor, f.workspaceId, connectionId, { requestId: randomUUID(), expectedRevision: 0,
      config: { projectId: 'PRJ-001', provider: 'github', label: 'Revocation race', readTools: [], writeTools: [], nativeApi: { baseUrl: 'https://api.github.com', repositories: ['owner/approved'], allowWrites: true } },
      nativePrivateHeaders: { Authorization: 'Bearer controlled-not-a-real-credential' },
    });
    const verified = await connections.verify(f.actor, f.workspaceId, connectionId, { requestId: randomUUID(), expectedRevision: saved.revision });
    const definitionId = await f.definition({ ...f.config, templateId: 'github-delivery-watchdog', action: { kind: 'template', templateId: 'github-delivery-watchdog', arguments: { repositories: ['owner/approved'] }, providerInstanceId: null, model: null, options: {}, repositories: [], plugins: [{ id: `integration:${connectionId}`, version: String(verified.revision) }], timeoutSeconds: 30 } });
    const endpoint = await f.endpoint(definitionId);
    const received = await f.events.receive(endpoint.id, Buffer.from('{"action":"opened","for":"revocation"}'), { 'x-automation-key': f.secret, 'x-webhook-id': randomUUID() }) as AutomationEventReceipt;
    assert.ok(received.executionId);
    await f.pool.query('UPDATE automation_studio_executions SET dispatched_at=clock_timestamp() WHERE id=$1', [received.executionId]);
    const row = (await f.pool.query('SELECT request_id FROM automation_studio_executions WHERE id=$1', [received.executionId])).rows[0];
    const generationId = randomUUID();
    const identity: AutomationServiceIdentity = { actorId: f.actor.id, workspaceId: f.workspaceId, projectId: 'PRJ-001', executionId: received.executionId, requestId: row.request_id, definitionId, definitionRevision: 1, audience: 'automation-integrations', generationId, issuedAt: Date.now(), expiresAt: Date.now() + 60000 };
    const providerResult = { status: 201, body: { id: 77, body: 'created-but-withheld' }, headers: {} };
    const broker = createAutomationIntegrationRuntimeService({ database: () => f.pool, core: f.core, privateStore: f.privateStore, nativeAdapter: async () => {
      await connections.revoke(f.actor, f.workspaceId, connectionId, { requestId: randomUUID(), expectedRevision: verified.revision });
      return providerResult;
    } });
    await broker.handle(identity, { executionId: identity.executionId, generationId, method: 'grant/open' });
    const operationId = randomUUID();
    await assert.rejects(broker.handle(identity, { executionId: identity.executionId, generationId, method: 'provider/request', params: { provider: 'github', operationId, method: 'POST', path: '/repos/owner/approved/issues/1/comments', body: { body: 'controlled write' } } }),
      error => rejected('integration_outcome_unknown')(error) && !String(error).includes('created-but-withheld'));
    const receipt = await connections.operation(f.actor, f.workspaceId, operationId);
    assert.equal(receipt.status, 'completed');
    assert.deepEqual(receipt.result, providerResult);
  });
  it('confines PM acceptance analysis to its frozen PR even when the verified connection permits broader writes', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    for (const provider of ['github', 'gitlab'] as const) {
      const api = provider === 'github' ? 'https://api.github.com' : 'https://gitlab.com';
      const connections = createAutomationIntegrationsService({
        database: () => f.pool, core: f.core, privateStore: f.privateStore,
        nativeAdapter: async (_config, _headers, request) => ({
          status: 200, headers: {},
          body: provider === 'github' ? { full_name: request.path.endsWith('/other') ? 'owner/other' : 'owner/approved' }
            : { path_with_namespace: decodeURIComponent(request.path.split('/').at(-1)!) },
        }),
      });
      const connectionId = randomUUID();
      const saved = await connections.save(f.actor, f.workspaceId, connectionId, { requestId: randomUUID(), expectedRevision: 0,
        config: { projectId: 'PRJ-001', provider, label: 'Broad connection, narrow PM analysis', readTools: [], writeTools: [],
          nativeApi: { baseUrl: api, repositories: ['owner/approved', 'owner/other'], allowWrites: true } },
        nativePrivateHeaders: { Authorization: 'Bearer controlled-not-a-real-credential' },
      });
      const verified = await connections.verify(f.actor, f.workspaceId, connectionId, { requestId: randomUUID(), expectedRevision: saved.revision });
      const arguments_ = { taskIds: ['TASK-001'], repository: { provider, repository: 'owner/approved', ref: null, pullRequestNumber: 7 } };
      const definitionId = await f.definition({ ...f.config, templateId: 'pm-pr-acceptance-coverage', templateVersion: '1.0.0', templateInputs: arguments_,
        action: { kind: 'template', templateId: 'pm-pr-acceptance-coverage', arguments: arguments_, providerInstanceId: null, model: null, options: {}, repositories: [],
          plugins: [{ id: `integration:${connectionId}`, version: String(verified.revision) }], timeoutSeconds: 30 } });
      const endpoint = await f.endpoint(definitionId);
      const received = await f.events.receive(endpoint.id, Buffer.from(JSON.stringify({ action: 'opened', provider })), { 'x-automation-key': f.secret, 'x-webhook-id': randomUUID() }) as AutomationEventReceipt;
      assert.ok(received.executionId);
      await f.pool.query('UPDATE automation_studio_executions SET dispatched_at=clock_timestamp() WHERE id=$1', [received.executionId]);
      const row = (await f.pool.query('SELECT request_id FROM automation_studio_executions WHERE id=$1', [received.executionId])).rows[0];
      const generationId = randomUUID();
      const identity: AutomationServiceIdentity = { actorId: f.actor.id, workspaceId: f.workspaceId, projectId: 'PRJ-001', executionId: received.executionId,
        requestId: row.request_id, definitionId, definitionRevision: 1, audience: 'automation-integrations', generationId, issuedAt: Date.now(), expiresAt: Date.now() + 60000 };
      const calls: string[] = [];
      const broker = createAutomationIntegrationRuntimeService({ database: () => f.pool, core: f.core, privateStore: f.privateStore, nativeAdapter: async (_config, _headers, input) => {
        calls.push(input.path); return { status: 200, headers: {}, body: { number: 7, head: { sha: 'f'.repeat(40) } } };
      } });
      await broker.handle(identity, { executionId: identity.executionId, generationId, method: 'grant/open' });
      const prefix = provider === 'github' ? '/repos/owner/approved/pulls/7' : '/projects/owner%2Fapproved/merge_requests/7';
      const send = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => broker.handle(identity, { executionId: identity.executionId, generationId, method: 'provider/request',
        params: { provider, operationId: randomUUID(), method, path, ...(body === undefined ? {} : { body }) } });
      await send('GET', prefix);
      for (const denied of [prefix.replace(/7$/, '8'), prefix.replace('approved', 'other'), prefix + '?page=1&page=2', prefix + '?per_page=1000']) {
        await assert.rejects(send('GET', denied), rejected('integration_pm_analysis_forbidden'));
      }
      await assert.rejects(send('POST', prefix, { state: 'closed' }), rejected('integration_pm_analysis_forbidden'));
      await assert.rejects(send('GET', prefix, { injected: true }), rejected('integration_pm_analysis_forbidden'));
      await assert.rejects(broker.handle(identity, { executionId: identity.executionId, generationId, method: 'tools/list' }), rejected('integration_pm_analysis_forbidden'));
      assert.deepEqual(calls, [prefix], 'Denied PM analysis operations must not reach a provider despite broad verified connection authority');
    }
  });
});
