import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { registerAutomationStudioRoutes } from '../apps/server/pm/src/automation-studio-routes.ts';
import { createAutomationStudioService } from '../packages/application/src/automation-studio.ts';
import { runAutomationStudioBatch } from '../packages/application/src/automation-studio-worker.ts';
import { authorizeAutomationStudioService } from '../packages/application/src/automation-studio-auth.ts';
import { createAutomationTransferService, parseAutomationTransfer } from '../packages/application/src/automation-transfer.ts';
import type { ExecutionSelection } from '../packages/agent-contracts/src/execution.ts';
import type { StudioWorkspaceExecutionPort } from '../packages/contracts/src/automation-studio.ts';
import { studioConfigSchema, type StudioConfig, type StudioDefinition, type StudioPage, type StudioExecutionPort, type StudioExecutionRequest, type StudioExecutionResult } from '../packages/contracts/src/automation-studio.ts';
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
    const folders = new Map<string, { path: string; revision: number; device: number; inode: number }>();
    const registerFolder = async (id: string): Promise<ExecutionSelection> => {
      const directory = join(root, `source-${id}`); await mkdir(directory, { recursive: true });
      const info = await stat(directory), revision = (folders.get(id)?.revision ?? 0) + 1;
      folders.set(id, { path: directory, revision, device: info.dev, inode: info.ino });
      return { version: 2, agentWorkspaceId: id, agentWorkspaceRevision: revision };
    };
    const workspaceExecution: StudioWorkspaceExecutionPort = {
      async resolve(selection) {
        const folder = folders.get(selection.agentWorkspaceId ?? '');
        if (!folder) throw new DomainError('agent_workspace_unavailable', 'Folder is unavailable', 404);
        if (selection.agentWorkspaceRevision! > folder.revision) throw new DomainError('agent_workspace_revision_conflict', 'Future folder revision is unavailable', 409);
        let info;
        try { info = await stat(folder.path); } catch { throw new DomainError('agent_workspace_unavailable', 'Folder is missing', 409); }
        if (info.dev !== folder.device || info.ino !== folder.inode) throw new DomainError('agent_workspace_unavailable', 'Folder was replaced', 409);
        return { path: folder.path, environment: { version: 2, hostId: 'local', agentWorkspaceId: selection.agentWorkspaceId, agentWorkspaceName: selection.agentWorkspaceId, agentWorkspaceRevision: selection.agentWorkspaceRevision, sourcePath: folder.path, executionPath: folder.path, worktree: null, frozen: false } };
      },
    };
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
    const service = createAutomationStudioService({ database: () => pool, core, runtime, workspaceExecution, definitionResolver: {
      list: async () => ({ contextId: 'controlled-project', definitions: [{ contextId: 'controlled-project', serverId: 'github', name: 'Controlled MCP fixture', configFingerprint: 'a'.repeat(64), transport: 'streamable-http' }] }),
      resolve: async () => { throw new Error('Studio metadata must not request definition credentials'); },
    } });
    return { pool, owner, workspaceId, projectRoot, root, core, runtime, service, scope, registerFolder, workspaceExecution, stats: () => ({ dispatches, queries, cancels, lastRequest }), loseDispatch: () => { loseDispatch = true; }, create: () => service.create(owner, workspaceId, { requestId: randomUUID(), config }) };
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
  it('filters saved project shortcuts before cursor/limit while preserving legacy absent/false definitions', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    await writeFile(join(f.projectRoot, 'PRJ-002.md'), '---\nschema: pm/v1\nid: PRJ-002\nentity: project\nstatus: active\n---\n# Another authorized project\n');
    const rows = Array.from({ length: 55 }, (_, index) => ({ id: randomUUID(), project_id: 'PRJ-001', config: studioConfigSchema.parse({ ...config, name: `Shortcut ${index}`, quickAccess: true }), created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() }));
    const noise = Array.from({ length: 55 }, (_, index) => ({ id: randomUUID(), project_id: 'PRJ-002', config: studioConfigSchema.parse({ ...config, projectId: 'PRJ-002', name: `Other project ${index}`, quickAccess: true }), created_at: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString() }));
    const unpinned = [config, { ...config, quickAccess: false }].map((saved, index) => ({ id: randomUUID(), project_id: config.projectId, config: saved, created_at: new Date(Date.UTC(2026, 0, 3, 0, 0, index)).toISOString() }));
    await f.pool.query('INSERT INTO automation_studio_definitions(id,workspace_id,actor_id,project_id,config,created_at) SELECT d.id,$1,$2,d.project_id,d.config,d.created_at FROM jsonb_to_recordset($3::jsonb) AS d(id uuid,project_id text,config jsonb,created_at timestamptz)', [f.workspaceId, f.owner.id, JSON.stringify([...rows, ...noise, ...unpinned])]);
    const app = Fastify(); t.after(() => app.close());
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : error instanceof ZodError ? 400 : 500).send({ error: { code: error instanceof DomainError ? error.code : 'validation_failed' } }));
    registerAutomationStudioRoutes(app, { database: () => f.pool, actor: async () => f.owner, core: f.core, runtime: f.runtime, studio: f.service });
    const base = `/api/v1/workspaces/${f.workspaceId}/automations/definitions`;
    const response = await app.inject({ url: `${base}?projectId=PRJ-001&quickAccess=true` });
    assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
    const first = response.json<StudioPage<StudioDefinition>>();
    assert.equal(first.items.length, 50); assert.equal(first.nextCursor, first.items[49]!.id);
    assert.ok(first.items.every(item => item.config.projectId === 'PRJ-001' && item.config.quickAccess === true));
    const next = await app.inject({ url: `${base}?projectId=PRJ-001&quickAccess=true&cursor=${first.nextCursor}` });
    assert.equal(next.statusCode, 200);
    const second = next.json<StudioPage<StudioDefinition>>();
    assert.equal(second.items.length, 5); assert.equal(second.nextCursor, null);
    assert.deepEqual(new Set([...first.items, ...second.items].map(item => item.id)), new Set(rows.map(row => row.id)));
    const off = await app.inject({ url: `${base}?projectId=PRJ-001&quickAccess=false` });
    assert.equal(off.statusCode, 200); assert.deepEqual(new Set(off.json<StudioPage<StudioDefinition>>().items.map(item => item.id)), new Set(unpinned.map(row => row.id)));
    const all = await f.service.definitions(f.owner, f.workspaceId);
    assert.equal(all.items.length, 50); assert.ok(all.nextCursor);
    assert.deepEqual(all.items.slice(0, 2).map(item => item.config.quickAccess), [false, undefined]);
    for (const query of ['quickAccess=1', 'quickAccess=', 'quickAccess=true&quickAccess=false', 'projectId=TASK-001']) assert.equal((await app.inject({ url: `${base}?${query}` })).statusCode, 400);
  });
  it('authorizes before pagination and never returns another actor, revoked project or inaccessible cursor ID', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    await writeFile(join(f.projectRoot, 'PRJ-002.md'), '---\nschema: pm/v1\nid: PRJ-002\nentity: project\nstatus: active\n---\n# Restricted project\n');
    const other = await createUser(f.pool, { email: `${randomUUID()}@example.test`, name: 'Other creator', password: 'Isolated-Studio-Only-Password' });
    await f.pool.query('INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) VALUES($1,$2,$3,$4)', [f.workspaceId, other.id, ['domain.read', 'planning.edit'], ['PRJ-001']]);
    const visible = await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: { ...config, quickAccess: true } });
    const privateDefinition = await f.service.create(other, f.workspaceId, { requestId: randomUUID(), config: { ...config, quickAccess: true } });
    const hidden = Array.from({ length: 51 }, () => ({ id: randomUUID(), project_id: 'PRJ-002', config: { ...config, projectId: 'PRJ-002', quickAccess: true } }));
    hidden.push({ id: randomUUID(), project_id: 'PRJ-003', config: { ...config, projectId: 'PRJ-003', quickAccess: true } });
    await f.pool.query('INSERT INTO automation_studio_definitions(id,workspace_id,actor_id,project_id,config) SELECT d.id,$1,$2,d.project_id,d.config FROM jsonb_to_recordset($3::jsonb) AS d(id uuid,project_id text,config jsonb)', [f.workspaceId, f.owner.id, JSON.stringify(hidden)]);
    await f.pool.query('UPDATE memberships SET capabilities=$4,project_ids=$3,version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner.id, ['PRJ-001'], ['domain.read', 'planning.edit']]);
    assert.deepEqual(await f.service.definitions(f.owner, f.workspaceId), { items: [visible], nextCursor: null });
    assert.deepEqual(await f.service.definitions(f.owner, f.workspaceId, undefined, { quickAccess: true }), { items: [visible], nextCursor: null });
    assert.deepEqual((await f.service.definitions(other, f.workspaceId, undefined, { projectId: 'PRJ-001', quickAccess: true })).items, [privateDefinition]);
    for (const cursor of [hidden[0]!.id, privateDefinition.id]) assert.deepEqual(await f.service.definitions(f.owner, f.workspaceId, cursor, { quickAccess: true }), { items: [], nextCursor: null });
    for (const projectId of ['PRJ-002', 'PRJ-003']) await assert.rejects(f.service.definitions(f.owner, f.workspaceId, undefined, { projectId, quickAccess: true }), rejected('not_found_or_forbidden'));
    await f.pool.query('UPDATE memberships SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner.id]);
    await assert.rejects(f.service.definitions(f.owner, f.workspaceId, undefined, { projectId: 'PRJ-001', quickAccess: true }), rejected('not_found_or_forbidden'));
  });
  it('round trips shortcut switches through real draft import, retrieval and full-bundle export without activation', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const transfer = createAutomationTransferService({ database: () => f.pool, core: f.core, studio: f.service });
    for (const quickAccess of [undefined, false, true]) {
      const saved = quickAccess === undefined ? config : { ...config, quickAccess };
      const input = { requestId: randomUUID(), projectId: config.projectId, document: { version: 1, kind: 'pm-automation-bundle', spec: saved } };
      const imported = await transfer.import(f.owner, f.workspaceId, input);
      assert.equal(imported.status, 'completed'); assert.equal(imported.definition?.status, 'draft');
      assert.deepEqual(imported.definition?.config, saved);
      assert.deepEqual(await transfer.import(f.owner, f.workspaceId, input), imported);
      assert.deepEqual((await f.service.definition(f.owner, f.workspaceId, imported.definition!.id)).config, saved);
      const exported = await transfer.export(f.owner, f.workspaceId, imported.definition!.id, 'bundle');
      assert.deepEqual(parseAutomationTransfer({ projectId: config.projectId, document: exported.document }).config, saved);
    }
    assert.deepEqual((await f.service.executions(f.owner, f.workspaceId)).items, []); assert.equal(f.stats().dispatches, 0);
  });
  it('keeps draft rejection, paused manual runs, revision guards and immutable original receipts for pinned definitions', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close); f.loseDispatch();
    const draft = await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: { ...config, quickAccess: true } });
    const draftRequest = randomUUID();
    await assert.rejects(f.service.run(f.owner, f.workspaceId, draft.id, { requestId: draftRequest, expectedRevision: draft.revision }), rejected('automation_draft_requires_test'));
    assert.equal((await f.service.receipt(f.owner, f.workspaceId, draftRequest)).httpStatus, 409);
    const paused = await f.service.setStatus(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: draft.revision, status: 'paused' });
    const input = { requestId: randomUUID(), expectedRevision: paused.revision };
    const queued = await f.service.run(f.owner, f.workspaceId, paused.id, input);
    assert.equal(queued.status, 'queued'); assert.equal(queued.definitionRevision, paused.revision); assert.deepEqual(queued.configSnapshot, paused.config);
    const edited = await f.service.update(f.owner, f.workspaceId, paused.id, { requestId: randomUUID(), expectedRevision: paused.revision, config: { ...paused.config, quickAccess: false } });
    assert.equal(edited.config.quickAccess, false); assert.equal(edited.status, 'paused');
    const staleRequest = randomUUID();
    await assert.rejects(f.service.run(f.owner, f.workspaceId, paused.id, { requestId: staleRequest, expectedRevision: paused.revision }), rejected('version_conflict'));
    assert.equal((await f.service.receipt(f.owner, f.workspaceId, staleRequest)).httpStatus, 409);
    assert.deepEqual(await f.service.run(f.owner, f.workspaceId, paused.id, input), queued);
    assert.equal((await f.service.executions(f.owner, f.workspaceId, paused.id)).items.length, 1);
    await runAutomationStudioBatch(f.pool, f.core, f.runtime, 'shortcut-original');
    assert.equal((await f.service.execution(f.owner, f.workspaceId, queued.id)).status, 'outcome_unknown');
    assert.deepEqual(f.stats().lastRequest?.config, paused.config);
    assert.deepEqual((await f.service.receipt(f.owner, f.workspaceId, input.requestId)).result, queued);
    assert.equal((await f.service.query(f.owner, f.workspaceId, queued.id)).status, 'completed');
    assert.equal(f.stats().dispatches, 1); assert.equal(f.stats().queries, 1);
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
  it('records due legacy code selections as skipped while advancing schedules, reconciling healthy work and heartbeating', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const at = new Date(Date.now() + 600000), now = new Date(at.getTime() + 1000);
    const script: StudioConfig = { ...config, name: 'Pre-cutover script', trigger: { kind: 'once', at: at.toISOString(), timezone: 'UTC' }, action: { kind: 'script', entrypoint: 'main.py', setup: '', content: 'print("legacy")', bundleRef: null, files: [], repositories: [], plugins: [], timeoutSeconds: 60 } };
    const repository: StudioConfig = { ...config, name: 'Pre-cutover repository', trigger: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' }, action: { kind: 'template', templateId: 'github-pr-reviewer', arguments: { repositories: ['org/repository'], githubTokenSecret: 'GITHUB_TOKEN_REFERENCE' }, providerInstanceId: 'test-provider', model: 'test-model', options: {}, repositories: [], plugins: [], timeoutSeconds: 60 } };
    const legacy = [];
    for (const saved of [script, repository]) legacy.push(await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: saved }));
    const oldSelection = { version: 1, codeWorkspaceId: 'retired-code', codeWorkspaceRevision: 2, rootIds: ['source'], primaryRootId: 'source' };
    await f.pool.query("UPDATE automation_studio_definitions SET config=jsonb_set(config,'{action,executionSelection}',$2::jsonb) WHERE id=$1", [legacy[0]!.id, JSON.stringify(oldSelection)]);
    await f.pool.query("UPDATE automation_studio_definitions SET status='enabled',next_due_at=$2 WHERE id=ANY($1::uuid[])", [legacy.map(item => item.id), at]);
    const healthy = await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: { ...config, trigger: { kind: 'once', at: now.toISOString(), timezone: 'UTC' } } });
    await f.service.setStatus(f.owner, f.workspaceId, healthy.id, { requestId: randomUUID(), expectedRevision: 1, status: 'enabled' });
    const queuedDefinition = await f.create(), unknownDefinition = await f.create();
    const queuedInput = { requestId: randomUUID(), expectedRevision: 1 };
    const queued = await f.service.dispatchTest(f.owner, f.workspaceId, queuedDefinition.id, queuedInput);
    const unknown = await f.service.dispatchTest(f.owner, f.workspaceId, unknownDefinition.id, { requestId: randomUUID(), expectedRevision: 1 });
    await f.pool.query("UPDATE automation_studio_executions SET status='outcome_unknown',dispatched_at=clock_timestamp(),started_at=clock_timestamp(),budget_consumed=true,external_execution_id='original-unknown' WHERE id=$1", [unknown.id]);
    assert.deepEqual(await runAutomationStudioBatch(f.pool, f.core, f.runtime, 'legacy-isolation', { now }), { scheduled: 3, processed: 3 });
    for (const definition of legacy) {
      const executions = (await f.service.executions(f.owner, f.workspaceId, definition.id)).items;
      assert.equal(executions.length, 1);
      const skipped = executions[0]!;
      assert.equal(skipped.status, 'skipped'); assert.equal(skipped.error, 'agent_workspace_selection_required');
      assert.ok(skipped.finishedAt); assert.equal(skipped.startedAt, null); assert.equal(skipped.externalExecutionId, null);
      assert.deepEqual(skipped.configSnapshot, definition.config);
      assert.ok((await f.service.logs(f.owner, f.workspaceId, skipped.id)).items.some(event => event.kind === 'error' && event.message.includes('agent_workspace_selection_required') && event.message.includes('no external dispatch')));
      assert.deepEqual((await f.service.definition(f.owner, f.workspaceId, definition.id)).config, definition.config);
      const readable = await f.service.definition(f.owner, f.workspaceId, definition.id);
      assert.equal(readable.executionUnavailableReason, 'agent_workspace_selection_required');
      assert.equal(skipped.executionUnavailableReason, 'agent_workspace_selection_required');
      if (definition.id === legacy[0]!.id) {
        assert.deepEqual(readable.historicalExecutionSelection, oldSelection); assert.deepEqual(skipped.historicalExecutionSelection, oldSelection);
        assert.deepEqual((await f.pool.query('SELECT config FROM automation_studio_definitions WHERE id=$1', [definition.id])).rows[0].config.action.executionSelection, oldSelection);
      }
    }
    assert.equal((await f.service.definition(f.owner, f.workspaceId, legacy[0]!.id)).nextDueAt, null);
    assert.ok(Date.parse((await f.service.definition(f.owner, f.workspaceId, legacy[1]!.id)).nextDueAt!) > now.getTime());
    assert.equal((await f.service.execution(f.owner, f.workspaceId, queued.id)).status, 'completed');
    assert.equal((await f.service.execution(f.owner, f.workspaceId, unknown.id)).status, 'completed');
    assert.equal((await f.service.executions(f.owner, f.workspaceId, healthy.id)).items[0]!.status, 'completed');
    assert.deepEqual((await f.service.receipt(f.owner, f.workspaceId, queuedInput.requestId)).result, queued);
    assert.equal(f.stats().dispatches, 2); assert.equal(f.stats().queries, 1);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM automation_studio_heartbeats WHERE worker_id=$1', ['legacy-isolation'])).rows[0].count, 1);
    await runAutomationStudioBatch(f.pool, f.core, f.runtime, 'legacy-isolation', { now });
    for (const definition of legacy) assert.equal((await f.service.executions(f.owner, f.workspaceId, definition.id)).items.length, 1);
  });
  it('rejects unknown, future, missing and replaced Agent folders before enable, test or run without a PM registry', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    f.runtime.capabilities = async () => ({ actions: [{ id: 'script', available: true, reason: null }], providers: [], repositories: [], plugins: [] });
    const selected = await f.registerFolder('current');
    const missing = await f.registerFolder('missing'); await rename(join(f.root, 'source-missing'), join(f.root, 'source-missing-original'));
    const replaced = await f.registerFolder('replaced'); await rename(join(f.root, 'source-replaced'), join(f.root, 'source-replaced-original')); await mkdir(join(f.root, 'source-replaced'));
    const cases: [ExecutionSelection, string][] = [
      [{ ...selected, agentWorkspaceId: 'unknown' }, 'agent_workspace_unavailable'],
      [{ ...selected, agentWorkspaceRevision: 2 }, 'agent_workspace_revision_conflict'],
      [missing, 'agent_workspace_unavailable'], [replaced, 'agent_workspace_unavailable'],
    ];
    for (const [executionSelection, code] of cases) {
      const saved: StudioConfig = { ...config, name: code, action: { kind: 'script', entrypoint: 'main.py', setup: '', content: 'print("explicit")', bundleRef: null, files: [], repositories: [], plugins: [], timeoutSeconds: 60, executionSelection } };
      const validation = await f.service.validate(f.owner, f.workspaceId, saved);
      assert.equal(validation.valid, false); assert.ok(validation.issues.some(issue => issue.path === 'action.executionSelection' && issue.code === code));
      const draft = await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: saved });
      for (const operation of ['enable', 'test'] as const) {
        const input = { requestId: randomUUID(), expectedRevision: 1 };
        await assert.rejects(operation === 'enable' ? f.service.setStatus(f.owner, f.workspaceId, draft.id, { ...input, status: 'enabled' }) : f.service.dispatchTest(f.owner, f.workspaceId, draft.id, input), rejected('automation_configuration_unavailable'));
        assert.equal((await f.service.receipt(f.owner, f.workspaceId, input.requestId)).httpStatus, 409);
      }
      const paused = await f.service.setStatus(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: 1, status: 'paused' });
      await assert.rejects(f.service.run(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: paused.revision }), rejected('automation_configuration_unavailable'));
      assert.equal((await f.service.executions(f.owner, f.workspaceId, draft.id)).items.length, 0);
    }
    assert.equal(f.stats().dispatches, 0);
  });
  it('preserves receipt replay, PM project authority and CAS while rechecking Agent identity at Worker dispatch', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    let afterCapabilities: (() => Promise<void>) | null = null;
    f.runtime.capabilities = async () => {
      const other = await f.pool.connect();
      try { await other.query('BEGIN'); await other.query("SET LOCAL lock_timeout='500ms'"); await lockWorkspace(other, f.workspaceId); await other.query('COMMIT'); } finally { other.release(); }
      const change = afterCapabilities; afterCapabilities = null; await change?.();
      return { actions: [{ id: 'script', available: true, reason: null }], providers: [], repositories: [], plugins: [] };
    };
    const saved = (executionSelection: ExecutionSelection): StudioConfig => ({ ...config, action: { kind: 'script', entrypoint: 'main.py', setup: '', content: 'print("selected")', bundleRef: null, files: [], repositories: [], plugins: [], timeoutSeconds: 60, executionSelection } });
    const selection = await f.registerFolder('valid'), selectedConfig = saved(selection);
    const draft = await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: selectedConfig });
    const testInput = { requestId: randomUUID(), expectedRevision: 1 };
    const queued = await f.service.dispatchTest(f.owner, f.workspaceId, draft.id, testInput);
    const resolve = f.workspaceExecution.resolve;
    f.workspaceExecution.resolve = async () => { throw new Error('Agent unavailable'); };
    assert.deepEqual(await f.service.dispatchTest(f.owner, f.workspaceId, draft.id, testInput), queued);
    await assert.rejects(f.service.dispatchTest(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: 1 }), rejected('automation_configuration_unavailable'));
    f.workspaceExecution.resolve = resolve;
    await f.registerFolder('valid');
    assert.equal((await f.service.validate(f.owner, f.workspaceId, selectedConfig)).valid, true, 'Metadata changes do not replace folder identity');
    const originalMembership = (await f.pool.query<{ capabilities: string[] }>('SELECT capabilities FROM memberships WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner.id])).rows[0]!;
    await f.pool.query('UPDATE memberships SET project_ids=$3,capabilities=$4,version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner.id, [config.projectId], ['domain.read', 'planning.edit']]);
    assert.equal((await f.service.validate(f.owner, f.workspaceId, selectedConfig)).valid, true, 'PM access.manage is not Agent directory authority');
    await f.pool.query('UPDATE memberships SET project_ids=$3,version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner.id, ['PRJ-999']]);
    await assert.rejects(f.service.validate(f.owner, f.workspaceId, selectedConfig), rejected('not_found_or_forbidden'));
    await f.pool.query('UPDATE memberships SET project_ids=NULL,capabilities=$3,version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner.id, originalMembership.capabilities]);
    const raceDraft = await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: saved(await f.registerFolder('race')) });
    afterCapabilities = async () => { await rename(join(f.root, 'source-race'), join(f.root, 'source-race-original')); };
    const race = await f.service.dispatchTest(f.owner, f.workspaceId, raceDraft.id, { requestId: randomUUID(), expectedRevision: 1 });
    await runAutomationStudioBatch(f.pool, f.core, f.runtime, 'directory-race', { workspaceExecution: f.workspaceExecution });
    assert.equal((await f.service.execution(f.owner, f.workspaceId, race.id)).status, 'skipped');
    assert.equal((await f.service.execution(f.owner, f.workspaceId, queued.id)).status, 'completed');
    const casDraft = await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: saved(await f.registerFolder('cas')) });
    afterCapabilities = async () => { await f.service.update(f.owner, f.workspaceId, casDraft.id, { requestId: randomUUID(), expectedRevision: 1, config: { ...casDraft.config, name: 'Concurrent definition revision' } }); };
    const casInput = { requestId: randomUUID(), expectedRevision: 1 };
    await assert.rejects(f.service.dispatchTest(f.owner, f.workspaceId, casDraft.id, casInput), rejected('version_conflict'));
    assert.equal((await f.service.receipt(f.owner, f.workspaceId, casInput.requestId)).httpStatus, 409);
    assert.equal((await f.service.executions(f.owner, f.workspaceId, casDraft.id)).items.length, 0);
  });
  it('skips pre-cutover queued code intent without redispatching or abandoning an already unknown legacy outcome', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const legacy: StudioConfig = { ...config, action: { kind: 'script', entrypoint: 'main.py', setup: '', content: 'print("original")', bundleRef: null, files: [], repositories: [], plugins: [], timeoutSeconds: 60 } };
    const input = { requestId: randomUUID(), config: legacy };
    const definition = await f.service.create(f.owner, f.workspaceId, input);
    const queuedId = randomUUID(), unknownId = randomUUID();
    await f.pool.query("INSERT INTO automation_studio_executions(id,workspace_id,actor_id,definition_id,project_id,definition_revision,config_snapshot,request_id,trigger,status,dispatched_at,started_at,budget_consumed,external_execution_id) SELECT d.id,$1,$2,$3,$4,1,$5::jsonb,d.request_id,'test',d.status,CASE WHEN d.status='outcome_unknown' THEN clock_timestamp() ELSE NULL END,CASE WHEN d.status='outcome_unknown' THEN clock_timestamp() ELSE NULL END,d.status='outcome_unknown',CASE WHEN d.status='outcome_unknown' THEN 'original-legacy-outcome' ELSE NULL END FROM jsonb_to_recordset($6::jsonb) AS d(id uuid,request_id uuid,status text)", [f.workspaceId, f.owner.id, definition.id, config.projectId, JSON.stringify(legacy), JSON.stringify([{ id: queuedId, request_id: randomUUID(), status: 'queued' }, { id: unknownId, request_id: randomUUID(), status: 'outcome_unknown' }])]);
    assert.deepEqual(await runAutomationStudioBatch(f.pool, f.core, f.runtime, 'legacy-queue'), { scheduled: 0, processed: 2 });
    const skipped = await f.service.execution(f.owner, f.workspaceId, queuedId);
    assert.equal(skipped.status, 'skipped'); assert.equal(skipped.error, 'agent_workspace_selection_required');
    assert.equal(skipped.startedAt, null); assert.equal(skipped.externalExecutionId, null);
    assert.equal((await f.service.execution(f.owner, f.workspaceId, unknownId)).status, 'completed');
    assert.equal(f.stats().dispatches, 0); assert.equal(f.stats().queries, 1);
    assert.deepEqual((await f.service.receipt(f.owner, f.workspaceId, input.requestId)).result, definition);
    assert.deepEqual((await f.service.definition(f.owner, f.workspaceId, definition.id)).config, legacy);
    assert.ok((await f.service.logs(f.owner, f.workspaceId, queuedId)).items.some(event => event.kind === 'error' && event.message.includes('no external dispatch')));
    assert.equal((await f.pool.query('SELECT budget_consumed FROM automation_studio_executions WHERE id=$1', [queuedId])).rows[0].budget_consumed, false);
  });
  it('preserves Worker enabled-definition sync updates through read-only core authority without initializing PM storage', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    f.runtime.capabilities = async () => ({ actions: [{ id: 'script', available: true, reason: null }], providers: [], repositories: [], plugins: [] });
    const executionSelection = await f.registerFolder('worker-sync');
    const saved: StudioConfig = { ...config, action: { kind: 'script', entrypoint: 'main.py', setup: '', content: 'print("sync")', bundleRef: null, files: [], repositories: [], plugins: [], timeoutSeconds: 60, executionSelection } };
    const draft = await f.service.create(f.owner, f.workspaceId, { requestId: randomUUID(), config: saved });
    const enabled = await f.service.setStatus(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: 1, status: 'enabled' });
    const synced = await f.service.update(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: enabled.revision, config: { ...saved, name: 'Synchronized enabled definition' } });
    assert.equal(synced.status, 'enabled'); assert.equal(synced.revision, enabled.revision + 1);
    assert.deepEqual(synced.config.action, saved.action);
    const selection = await f.registerFolder('worker-sync');
    const staleInput = { requestId: randomUUID(), expectedRevision: synced.revision, config: { ...saved, name: 'Future folder revision', action: { ...saved.action, executionSelection: { ...selection, agentWorkspaceRevision: 3 } } } };
    await assert.rejects(f.service.update(f.owner, f.workspaceId, draft.id, staleInput), rejected('automation_configuration_unavailable'));
    assert.equal((await f.service.receipt(f.owner, f.workspaceId, staleInput.requestId)).httpStatus, 409);
    const refreshed = await f.service.update(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: synced.revision, config: { ...saved, action: { ...saved.action, executionSelection: selection } } });
    assert.equal(refreshed.status, 'enabled'); assert.equal(refreshed.revision, synced.revision + 1);
    assert.deepEqual((await f.service.definition(f.owner, f.workspaceId, draft.id)).config, refreshed.config);
    await assert.rejects(access(join(f.root, f.workspaceId, '.pm')), { code: 'ENOENT' });
    assert.equal((await f.service.executions(f.owner, f.workspaceId, draft.id)).items.length, 0);
    assert.equal(f.stats().dispatches, 0);
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
    assert.equal((await authorizeAutomationStudioService(f.pool, f.core, identity, { method: 'POST', url: '/api/v1/agent-contexts/authorize', body: { workspaceId: f.workspaceId, projectId: config.projectId } })).id, f.owner.id);
    await assert.rejects(authorizeAutomationStudioService(f.pool, f.core, identity, { method: 'POST', url: '/api/v1/agent-contexts/authorize', body: { workspaceId: f.workspaceId, projectId: null } }), rejected('automation_service_scope_forbidden'));
    assert.equal((await authorizeAutomationStudioService(f.pool, f.core, identity, { method: 'GET', url: '/api/v1/agent-tools', body: undefined })).id, f.owner.id);
    const toolUrl = `/api/v1/workspaces/${f.workspaceId}/agent-tools/call`;
    assert.equal((await authorizeAutomationStudioService(f.pool, f.core, identity, { method: 'POST', url: toolUrl, body: { target: { workspaceId: f.workspaceId, projectId: config.projectId } } })).id, f.owner.id);
    for (const body of [{ target: { workspaceId: f.workspaceId, projectId: null } }, { target: { workspaceId: randomUUID(), projectId: config.projectId } }, { scope: { kind: 'projects', projectIds: [config.projectId] } }])
      await assert.rejects(authorizeAutomationStudioService(f.pool, f.core, identity, { method: 'POST', url: toolUrl, body }), rejected('automation_service_scope_forbidden'));
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
