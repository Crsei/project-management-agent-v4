import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import Fastify from 'fastify';
import { registerAgentToolRoutes } from '../apps/server/pm/src/agent-tool-routes.ts';
import { createAgentChatTools, type AgentChatToolsOptions } from '../apps/server/pm/src/agent-chat-tools.ts';
import { CoreWorkspacePool, authorizeCoreScope, nativeCommandId } from '../apps/server/pm/src/core-routes.ts';
import { executeCoreCommand, isCoreCommand, isCoreEntityKind, listCoreEntities, readCoreEntity } from '../apps/server/pm/src/core-adapter.ts';
import { CoreCommandJournal } from '../apps/server/pm/src/core-journal.ts';
import { readCoreSnapshot } from '../packages/pm-core/change-snapshots.ts';
import { accessCommands, getMembership } from '../packages/application/src/access.ts';
import { runCommand, requestHash } from '../packages/application/src/kernel.ts';
import { readExternalReceipt, recordExternalReceipt } from '../packages/application/src/core-bridge.ts';
import { readTaskComments, taskCommentsCommands } from '../packages/application/src/task-comments.ts';
import type { CoreAccess } from '../packages/application/src/ports.ts';
import type { ProjectAuditWrite } from '../packages/application/src/project-audit.ts';
import type { CapturedServiceFact } from '../packages/application/src/service-facts.ts';
import type { AgentChatToolContext } from '../packages/application/src/agent-chat-tools.ts';
import { DomainError, type Actor } from '../packages/domain/src/core.ts';
import { WorkspaceError } from '../packages/pm-core/index.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createMcpServiceBearer, type McpInvocationIdentity } from '../packages/infrastructure/src/mcp-service-auth.ts';
import { PM_TOOL_RECONCILE_PATH, createPmToolLinkageBearer, createPmToolReconcileBearer, pmToolRequestHash } from '../packages/infrastructure/src/pm-tool-service-auth.ts';
import { pmToolReconcileResultSchema, type PmToolLinkage } from '../packages/agent-contracts/src/pm-tools.ts';
import { readProjectAudit } from '../packages/application/src/project-audit.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
async function fixture() {
  assert.ok(databaseUrl, 'Real PostgreSQL is required');
  const namespace = `test_agent_tools_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(databaseUrl);
  let pool: Pool | undefined, root: string | undefined, cores: CoreWorkspacePool | undefined;
  let created = false;
  async function close() {
    await cores?.close(); await pool?.end();
    try { if (created) await bootstrap.query(`DROP SCHEMA ${namespace} CASCADE`); }
    finally { await bootstrap.end(); if (root) await rm(root, { recursive: true, force: true }); }
  }
  try {
    await bootstrap.query(`CREATE SCHEMA ${namespace}`); created = true;
    const scoped = new URL(databaseUrl); scoped.searchParams.set('options', `-c search_path=${namespace},public`);
    pool = createPool(scoped.toString()); await migrate(pool);
    const database = pool;
    const owner = await createUser(database, { email: `${randomUUID()}@example.test`, name: 'Native tool owner', password: 'isolated-tool-fixture-password' });
    const limited = await createUser(database, { email: `${randomUUID()}@example.test`, name: 'Project member', password: 'isolated-tool-member-password' });
    const ws = await createWorkspace(database, owner.id, 'Native tool boundary');
    root = await mkdtemp(join(tmpdir(), 'pm-agent-tools-'));
    cores = new CoreWorkspacePool(root, database);
    const coreWorkspaces = cores;
    const workspace = await cores.get(ws.id);
    const first = await workspace.createEntity({ entity: 'project', title: 'Authorized project' });
    const second = await workspace.createEntity({ entity: 'project', title: 'Other project' });
    const task = await workspace.createEntity({ entity: 'work_item', project: first.id, title: 'Task A', body: 'Original scope\n\n- [ ] Keep acceptance criteria' });
    const peer = await workspace.createEntity({ entity: 'work_item', project: first.id, title: 'Task B' });
    const hidden = await workspace.createEntity({ entity: 'work_item', project: second.id, title: 'Hidden task' });
    const document = await workspace.createEntity({ entity: 'document', project: first.id, title: 'Readable document', body: 'Current authorized document body' });
    const access = await runCommand(database, owner, ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', payload: { userId: limited.id, capabilities: ['domain.read', 'planning.edit', 'intent.propose'], projectIds: [first.id] } }, accessCommands);
    assert.equal(access.status, 'committed');
    async function coreFor(actor: Actor): Promise<CoreAccess> {
      const scope = await authorizeCoreScope(database, actor, ws.id, 'domain.read');
      return {
        handles: (_id, kind) => kind ? isCoreEntityKind(kind) : true,
        async get(id, kind) { const entity = readCoreEntity(workspace, scope, id); if (kind && entity.kind !== kind) throw new DomainError('not_found_or_forbidden', 'Wrong entity kind', 404); return entity; },
        async list(kind) { return (await listCoreEntities(workspace, scope, { kind })).items; },
        async records() { return workspace.snapshot().files.filter(record => scope.allows(record)); },
        async sprintHistory() { return workspace.sprintHistory(); },
        configuration() { return workspace.configuration().config; },
      };
    }
    const options: AgentChatToolsOptions = {
      database: () => database, coreWorkspaces, localProjects: { enabled: false, defaultParent: null },
      async executeCommand(actor, workspaceId, command, checkAuthorization) {
        assert.equal(workspaceId, ws.id);
        if (!isCoreCommand(command.commandType)) return runCommand(database, actor, workspaceId, command, taskCommentsCommands, await coreFor(actor), undefined, checkAuthorization, { kind: 'agent', requesterId: actor.id });
        const hash = requestHash(command as unknown as Record<string, unknown>);
        const prior = await readExternalReceipt(database, actor, workspaceId, command.commandId, hash);
        if (prior) return prior;
        const scope = await authorizeCoreScope(database, actor, workspaceId, 'domain.read');
        const audit: ProjectAuditWrite[] = [], facts: CapturedServiceFact[] = [];
        const receipt = await executeCoreCommand({ workspace, scope, principal: actor, command, pool: database, trustedSource: { kind: 'agent', requesterId: actor.id }, ...(checkAuthorization ? { checkAuthorization } : {}), captureAudit: entries => { audit.push(...entries); }, captureFacts: entries => { facts.push(...entries); } }, command.commandId);
        await recordExternalReceipt(database, actor, workspaceId, command, receipt, [], audit, facts, key => readCoreSnapshot(workspace.root, key));
        return receipt;
      },
      readCommandReceipt(actor, workspaceId, command) { return readExternalReceipt(database, actor, workspaceId, command.commandId, requestHash(command as unknown as Record<string, unknown>)); },
      async readComments(actor, workspaceId, taskId, readOptions) {
        return readTaskComments({ sql: database, actor, workspaceId, membership: await getMembership(database, actor, workspaceId), now: new Date(), core: await coreFor(actor) }, taskId, readOptions);
      },
    };
    const tools = createAgentChatTools(options);
    function context(actor: Actor = owner, projects = [first.id], kind: 'workspace' | 'projects' = 'projects'): AgentChatToolContext {
      return { actor, workspaceId: ws.id, threadId: randomUUID(), messageId: randomUUID(), operationId: randomUUID(), scope: { kind, projectIds: projects } };
    }
    return { close, database, coreWorkspaces, workspace, ws, owner, limited, first, second, task, peer, hidden, document, tools, options, context, coreFor };
  } catch (error) { await close(); throw error; }
}

const taskInput = (projectId: string) => ({ projectId, title: 'Created through native tool', description: 'Real Markdown', assigneeId: null, priority: 'high', startDate: null, dueDate: null, labels: ['agent'] });
const taskEdit = (id: string, revision: string) => ({ id, revision, title: 'Ordinary title edit', description: null, assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null });
const denied = (error: unknown) => error instanceof DomainError && error.code === 'not_found_or_forbidden';

describe('Agent tools use native PM services and real PostgreSQL authority', { skip: !databaseUrl, timeout: 600000 }, () => {
  it('forward migration discards only old PM chat structures and retains business evidence', async t => {
    const f = await fixture(); t.after(() => f.close());
    const command = await f.tools.execute('pm_create_task', taskInput(f.first.id), f.context());
    const comment = await f.tools.execute('pm_create_comment', { projectId: f.first.id, taskId: f.task.id, content: 'Retained receipt' }, f.context());
    const client = await f.database.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TABLE pm_agent_tool_operations');
      for (const file of ['0032_agent_chat.sql', '0033_agent_chat_tools.sql']) {
        await client.query(await readFile(new URL(`../packages/infrastructure/migrations/${file}`, import.meta.url), 'utf8'));
      }
      const thread = randomUUID(), message = randomUUID();
      await client.query('INSERT INTO agent_chat_threads(id,workspace_id,actor_id,title) VALUES($1,$2,$3,$4)', [thread, f.ws.id, f.owner.id, 'Retired']);
      await client.query("INSERT INTO agent_chat_messages(id,thread_id,role,content,status) VALUES($1,$2,'user','legacy','complete')", [message, thread]);
      const before = await client.query('SELECT command_id FROM project_audit WHERE workspace_id=$1 AND command_id=$2', [f.ws.id, command.receipt!.commandId]);
      assert.ok(before.rowCount);
      const receipts = await client.query('SELECT command_id FROM command_receipts WHERE workspace_id=$1 AND command_id=$2', [f.ws.id, comment.receipt!.commandId]);
      assert.equal(receipts.rowCount, 1);
      await client.query(await readFile(new URL('../packages/infrastructure/migrations/0038_unified_agent_tools.sql', import.meta.url), 'utf8'));
      const tables = await client.query<{ threads: string | null; messages: string | null; calls: string | null; operations: string | null }>("SELECT to_regclass(format('%I.agent_chat_threads',current_schema()))::text AS threads,to_regclass(format('%I.agent_chat_messages',current_schema()))::text AS messages,to_regclass(format('%I.agent_chat_tool_calls',current_schema()))::text AS calls,to_regclass(format('%I.pm_agent_tool_operations',current_schema()))::text AS operations");
      assert.equal(tables.rows[0]?.threads, null); assert.equal(tables.rows[0]?.messages, null); assert.equal(tables.rows[0]?.calls, null); assert.ok(tables.rows[0]?.operations);
      const after = await client.query('SELECT command_id FROM project_audit WHERE workspace_id=$1 AND command_id=$2', [f.ws.id, command.receipt!.commandId]);
      assert.equal(after.rowCount, before.rowCount);
      const retainedReceipts = await client.query('SELECT command_id FROM command_receipts WHERE workspace_id=$1 AND command_id=$2', [f.ws.id, comment.receipt!.commandId]);
      assert.equal(retainedReceipts.rowCount, 1);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('serves authenticated registry and reconciles the original operation without replay', async t => {
    const f = await fixture(); t.after(() => f.close());
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => error instanceof DomainError ? reply.code(error.status).send({ error: { code: error.code } }) : reply.code(500).send({ error: 'unexpected' }));
    registerAgentToolRoutes(app, { database: () => f.database, actor: async request => request.headers['x-test-actor'] === 'limited' ? f.limited : f.owner, coreWorkspaces: f.coreWorkspaces, tools: f.tools });
    t.after(() => app.close());
    const base = `/api/v1/workspaces/${f.ws.id}/agent-tools`;
    const listed = await app.inject({ method: 'GET', url: base });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().tools.length, 17);
    assert.ok(listed.json().tools.every((tool: { inputSchema: unknown }) => tool.inputSchema));
    const input = { operationId: randomUUID(), name: 'pm_create_task', arguments: taskInput(f.first.id), target: { workspaceId: f.ws.id, projectId: f.first.id }, threadId: 'chat-thread', messageId: 'chat-message', generationId: 'chat-generation' };
    const created = await app.inject({ method: 'POST', url: `${base}/call`, payload: input });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().status, 'succeeded');
    const repeated = await app.inject({ method: 'POST', url: `${base}/call`, payload: input });
    assert.deepEqual(repeated.json(), created.json());
    const reconciled = await app.inject({ method: 'POST', url: `${base}/result`, payload: input });
    assert.deepEqual(reconciled.json(), created.json());
    assert.equal(f.workspace.items({ entity: 'work_item', q: input.arguments.title }).length, 1);
    const conflict = await app.inject({ method: 'POST', url: `${base}/call`, payload: { ...input, arguments: { ...input.arguments, title: 'Different' } } });
    assert.equal(conflict.statusCode, 409);
    const forbidden = await app.inject({ method: 'POST', url: `${base}/call`, headers: { 'x-test-actor': 'limited' }, payload: { ...input, operationId: randomUUID(), target: { workspaceId: f.ws.id, projectId: f.second.id } } });
    assert.equal(forbidden.statusCode, 404);
    const missing = await app.inject({ method: 'POST', url: `${base}/result`, payload: { ...input, operationId: randomUUID() } });
    assert.equal(missing.statusCode, 404);
    await f.database.query("UPDATE pm_agent_tool_operations SET status='unknown',result=NULL,finished_at=NULL WHERE operation_id=$1", [input.operationId]);
    const recovered = await app.inject({ method: 'POST', url: `${base}/result`, payload: input });
    assert.equal(recovered.json().status, 'succeeded');
    assert.equal(recovered.json().result.receipt.operationId, input.operationId);
    assert.equal(f.workspace.items({ entity: 'work_item', q: input.arguments.title }).length, 1);
    const pending = { ...input, operationId: randomUUID(), arguments: { ...input.arguments, title: 'Unproven pending operation' } };
    const pendingHash = requestHash({ ...pending, workspaceId: f.ws.id, actorId: f.owner.id });
    await f.database.query("INSERT INTO pm_agent_tool_operations(operation_id,workspace_id,actor_id,request_hash,name,thread_id,message_id,generation_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running')", [pending.operationId, f.ws.id, f.owner.id, pendingHash, pending.name, pending.threadId, pending.messageId, pending.generationId]);
    const unknown = await app.inject({ method: 'POST', url: `${base}/result`, payload: pending });
    assert.equal(unknown.json().status, 'unknown');
    const noReplay = await app.inject({ method: 'POST', url: `${base}/call`, payload: pending });
    assert.equal(noReplay.json().status, 'unknown');
    await f.database.query("UPDATE pm_agent_tool_operations SET status='failed',outcome_evidence=NULL,error='{\"code\":\"legacy_http_403\",\"message\":\"Old uncertain denial\"}'::jsonb WHERE operation_id=$1", [pending.operationId]);
    const legacy = await app.inject({ method: 'POST', url: `${base}/result`, payload: pending });
    assert.equal(legacy.json().status, 'unknown', 'An old HTTP-derived failure is not authoritative without original evidence');
    assert.equal(legacy.json().certainty.evidence, 'unresolved');
    assert.equal(f.workspace.items({ entity: 'work_item', q: pending.arguments.title }).length, 0);
  });

  it('retains a commit before a delegated 403 and reconciles only its bound status after revocation', async t => {
    const f = await fixture(); t.after(() => f.close());
    const oldSecret = process.env.PM_AUTOMATION_SERVICE_SECRET, oldUrl = process.env.PM_MCP_AGENT_URL;
    process.env.PM_AUTOMATION_SERVICE_SECRET = 'isolated-pm-operation-reconciliation-secret'.repeat(3);
    process.env.PM_MCP_AGENT_URL = 'http://127.0.0.1:4123';
    t.after(() => {
      if (oldSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = oldSecret;
      if (oldUrl === undefined) delete process.env.PM_MCP_AGENT_URL; else process.env.PM_MCP_AGENT_URL = oldUrl;
    });
    let revoked = false, executions = 0;
    const target = { workspaceId: f.ws.id, projectId: f.first.id };
    const delegation: McpInvocationIdentity = { grantId: randomUUID(), actorId: f.limited.id, scope: target, access: 'full', threadIds: ['original-thread'], version: 1 };
    t.mock.method(globalThis, 'fetch', async () => revoked ? new Response(null, { status: 403 }) : Response.json(delegation));
    const linkage: PmToolLinkage = { traceId: randomUUID(), invocationId: randomUUID(), executionRoot: 'generation',
      inputMessageId: 'original-user-message', executionGrantId: randomUUID(), clientKind: 'chat', policy: 'full', enforcement: 'audit-only' };
    const secretText = `BUSINESS-BODY-${randomUUID()}`;
    const input = { operationId: randomUUID(), name: 'pm_create_task', arguments: { ...taskInput(f.first.id), description: secretText },
      target, threadId: 'original-thread', messageId: 'assistant-output', generationId: 'original-generation', linkage };
    const hash = pmToolRequestHash(input, f.limited.id);
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: { code: error instanceof DomainError ? error.code : 'unexpected' } }));
    registerAgentToolRoutes(app, { database: () => f.database, actor: async () => f.limited, coreWorkspaces: f.coreWorkspaces,
      tools: { ...f.tools, async execute(name, args, context) {
        executions++;
        const result = await f.tools.execute(name, args, context);
        await f.database.query('UPDATE memberships SET revoked_at=clock_timestamp(),version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.ws.id, f.limited.id]);
        revoked = true;
        return result;
      } } });
    t.after(() => app.close());
    const headers = { authorization: `Bearer ${createMcpServiceBearer(delegation)}`, 'x-pm-tool-linkage': createPmToolLinkageBearer(f.limited.id, hash, linkage) };
    const call = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${f.ws.id}/agent-tools/call`, headers, payload: input });
    assert.equal(call.statusCode, 403);
    const stored = (await f.database.query<{ status: string; result: { receipt: { commandId: string } }; linkage: PmToolLinkage }>('SELECT status,result,linkage FROM pm_agent_tool_operations WHERE operation_id=$1', [input.operationId])).rows[0]!;
    assert.equal(stored.status, 'succeeded'); assert.deepEqual(stored.linkage, linkage);
    const proof = { operationId: input.operationId, actorId: f.limited.id, target, requestHash: hash };
    const bearer = createPmToolReconcileBearer(proof);
    const internal = await app.inject({ method: 'POST', url: PM_TOOL_RECONCILE_PATH, headers: { authorization: `Bearer ${bearer}` }, payload: proof });
    assert.equal(internal.statusCode, 200);
    const status = pmToolReconcileResultSchema.parse(internal.json());
    assert.equal(status.status, 'succeeded'); assert.equal(status.evidence, 'operation');
    assert.deepEqual(status.commandIds, [stored.result.receipt.commandId]);
    assert.equal(internal.body.includes(secretText), false);
    for (const key of ['result', 'arguments', 'error', 'title', 'revision', 'cookie', 'token']) assert.equal(key in status, false);
    assert.equal((await app.inject({ method: 'POST', url: PM_TOOL_RECONCILE_PATH, headers: { authorization: `Bearer ${bearer}` }, payload: proof })).statusCode, 401, 'Consumed nonce survives in SQL');
    for (const authorization of ['Bearer ordinary-user-token', headers.authorization]) {
      assert.equal((await app.inject({ method: 'POST', url: PM_TOOL_RECONCILE_PATH, headers: { authorization }, payload: proof })).statusCode, 401);
    }
    for (const forged of [{ ...proof, actorId: f.owner.id }, { ...proof, target: { ...target, projectId: f.second.id } }, { ...proof, operationId: randomUUID() }]) {
      assert.equal((await app.inject({ method: 'POST', url: PM_TOOL_RECONCILE_PATH, headers: { authorization: `Bearer ${createPmToolReconcileBearer(forged)}` }, payload: forged })).statusCode, 404);
    }
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/workspaces/${f.ws.id}/agent-tools/result`, headers, payload: input })).statusCode, 403);
    // Fault injection: file/audit committed, but the original PM delivery record was not finished.
    await f.database.query("UPDATE pm_agent_tool_operations SET status='unknown',result=NULL,outcome_evidence=NULL,finished_at=NULL WHERE operation_id=$1", [input.operationId]);
    const journalProof = await app.inject({ method: 'POST', url: PM_TOOL_RECONCILE_PATH,
      headers: { authorization: `Bearer ${createPmToolReconcileBearer(proof)}` }, payload: proof });
    assert.equal(journalProof.json().status, 'succeeded'); assert.equal(journalProof.json().evidence, 'native_journal');
    assert.equal((await f.database.query('SELECT result FROM pm_agent_tool_operations WHERE operation_id=$1', [input.operationId])).rows[0]!.result, null);
    await f.database.query('UPDATE memberships SET revoked_at=NULL,version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.ws.id, f.limited.id]);
    revoked = false;
    const restored = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${f.ws.id}/agent-tools/result`,
      headers: { authorization: `Bearer ${createMcpServiceBearer(delegation)}` }, payload: input });
    assert.equal(restored.json().status, 'succeeded');
    assert.equal(restored.json().result.receipt.commandId, stored.result.receipt.commandId, 'Authorized hydration restores the original receipt without another write');
    assert.ok((await f.database.query('SELECT result FROM pm_agent_tool_operations WHERE operation_id=$1', [input.operationId])).rows[0]!.result);
    assert.equal(executions, 1);
    assert.equal(f.workspace.items({ entity: 'work_item', q: input.arguments.title }).length, 1);
    assert.equal((await f.database.query('SELECT id FROM project_audit WHERE workspace_id=$1 AND command_id=$2', [f.ws.id, status.commandIds[0]])).rowCount, 1);
  });

  it('keeps missing journals and interrupted audit persistence unresolved, then uses authorized original audit recovery once', async t => {
    const f = await fixture(); t.after(() => f.close());
    const oldSecret = process.env.PM_AUTOMATION_SERVICE_SECRET;
    process.env.PM_AUTOMATION_SERVICE_SECRET = 'isolated-pm-audit-reconciliation-secret'.repeat(3);
    t.after(() => { if (oldSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = oldSecret; });
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: 'safe-error' }));
    let executions = 0;
    registerAgentToolRoutes(app, { database: () => f.database, actor: async () => f.owner, coreWorkspaces: f.coreWorkspaces,
      tools: { ...f.tools, execute: async (...args) => { executions++; return f.tools.execute(...args); } } });
    t.after(() => app.close());
    const input = { operationId: randomUUID(), name: 'pm_create_task', arguments: taskInput(f.first.id),
      target: { workspaceId: f.ws.id, projectId: f.first.id }, threadId: 'thread', messageId: 'output', generationId: 'generation' };
    const proof = { operationId: input.operationId, actorId: f.owner.id, target: input.target, requestHash: pmToolRequestHash(input, f.owner.id) };
    const internal = () => app.inject({ method: 'POST', url: PM_TOOL_RECONCILE_PATH, headers: { authorization: `Bearer ${createPmToolReconcileBearer(proof)}` }, payload: proof });
    await f.database.query(`CREATE FUNCTION reject_agent_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.source='core_http' THEN RAISE EXCEPTION 'injected agent audit outage'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_agent_audit BEFORE INSERT ON project_audit FOR EACH ROW EXECUTE FUNCTION reject_agent_audit()`);
    const base = `/api/v1/workspaces/${f.ws.id}/agent-tools`;
    const first = await app.inject({ method: 'POST', url: `${base}/call`, payload: input });
    assert.equal(first.json().status, 'unknown');
    const created = f.workspace.items({ entity: 'work_item', q: input.arguments.title });
    assert.equal(created.length, 1);
    const revision = created[0]!.revision;
    assert.equal((await internal()).json().status, 'unknown', 'File completion with missing SQL audit is not a final proof');
    await f.database.query('DROP TRIGGER reject_agent_audit ON project_audit; DROP FUNCTION reject_agent_audit()');
    const journal = join(f.workspace.root, '.pm/state/pm-command-journal.ndjson'), held = `${journal}.held`;
    await rename(journal, held);
    try {
      assert.equal((await internal()).json().status, 'unknown', 'Journal absence never proves nonexecution');
      assert.equal((await app.inject({ method: 'POST', url: `${base}/call`, payload: input })).json().status, 'unknown');
    } finally { await rename(held, journal); }
    const recovered = await app.inject({ method: 'POST', url: `${base}/result`, payload: input });
    assert.equal(recovered.json().status, 'succeeded');
    const commandId = recovered.json().result.receipt.commandId;
    assert.equal((await internal()).json().status, 'succeeded');
    assert.equal((await app.inject({ method: 'POST', url: `${base}/result`, payload: input })).json().status, 'succeeded');
    assert.equal(executions, 1); assert.equal(f.workspace.get(created[0]!.id).revision, revision);
    assert.equal((await f.database.query('SELECT id FROM project_audit WHERE workspace_id=$1 AND command_id=$2', [f.ws.id, commandId])).rowCount, 1);
  });

  it('uses original SQL receipts but never absence or a native deletion tombstone as execution proof', async t => {
    const f = await fixture(); t.after(() => f.close());
    const context = f.context(), args = { projectId: f.first.id, taskId: f.task.id, content: 'Private comment body' };
    const identity = f.tools.recoveryIdentity('pm_create_comment', args, context)!;
    assert.deepEqual(await f.tools.inspectOutcome(identity, f.owner.id, f.ws.id), { status: 'unknown', evidence: 'unresolved' });
    await f.tools.execute('pm_create_comment', args, context);
    assert.deepEqual(await f.tools.inspectOutcome(identity, f.owner.id, f.ws.id), { status: 'succeeded', evidence: 'command_receipt' });
    assert.deepEqual(await f.tools.inspectOutcome({ ...identity, hash: 'f'.repeat(64) }, f.owner.id, f.ws.id), { status: 'unknown', evidence: 'unresolved' });
    assert.deepEqual(await f.tools.inspectOutcome(identity, f.limited.id, f.ws.id), { status: 'unknown', evidence: 'unresolved' });
    const creationContext = f.context(), creationArgs = { ...taskInput(f.first.id), title: 'Conservative deletion proof' };
    const creation = await f.tools.execute('pm_create_task', creationArgs, creationContext);
    const task = f.workspace.get(creation.receipt!.targetId!);
    await f.tools.execute('pm_archive_task', { id: task.id, revision: task.revision }, f.context());
    const archived = f.workspace.get(task.id), deletionContext = f.context(), deletionArgs = { id: task.id, revision: archived.revision };
    const deletion = f.tools.recoveryIdentity('pm_delete_task', deletionArgs, deletionContext)!;
    await f.tools.execute('pm_delete_task', deletionArgs, deletionContext);
    assert.deepEqual(await f.tools.inspectOutcome(deletion, f.owner.id, f.ws.id), { status: 'unknown', evidence: 'unresolved' });
    assert.equal(await f.tools.recover('pm_delete_task', deletionArgs, deletionContext), null);
    const originalCreation = await f.tools.recover('pm_create_task', creationArgs, creationContext);
    assert.deepEqual(originalCreation?.receipt, creation.receipt, 'A deleted current task does not erase the exact original creation receipt');
    assert.deepEqual(originalCreation?.items, []);
  });

  it('links trusted traces to exact existing audit rows with full audit-only policy and current audit authority', async t => {
    const f = await fixture(); t.after(() => f.close());
    const oldSecret = process.env.PM_AUTOMATION_SERVICE_SECRET;
    process.env.PM_AUTOMATION_SERVICE_SECRET = 'isolated-pm-audit-trace-secret'.repeat(3);
    t.after(() => { if (oldSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = oldSecret; });
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: 'safe-error' }));
    registerAgentToolRoutes(app, { database: () => f.database, actor: async request => request.headers['x-test-actor'] === 'limited' ? f.limited : f.owner,
      coreWorkspaces: f.coreWorkspaces, tools: f.tools });
    t.after(() => app.close());
    const target = { workspaceId: f.ws.id, projectId: f.first.id }, traceId = randomUUID(), privateBody = `DO-NOT-AUDIT-${randomUUID()}`;
    const input = { operationId: randomUUID(), name: 'pm_create_task', arguments: { ...taskInput(f.first.id), description: privateBody }, target,
      threadId: 'thread', messageId: 'output-message', generationId: 'generation',
      linkage: { traceId, invocationId: randomUUID(), inputMessageId: 'accepted-input-message', executionRoot: 'generation' as const,
        executionGrantId: randomUUID(), clientKind: 'chat' as const, policy: 'full' as const, enforcement: 'audit-only' as const } };
    const base = `/api/v1/workspaces/${f.ws.id}/agent-tools`;
    const headers = { 'x-pm-tool-linkage': createPmToolLinkageBearer(f.owner.id, pmToolRequestHash(input, f.owner.id), input.linkage) };
    const first = await app.inject({ method: 'POST', url: `${base}/call`, headers, payload: input });
    assert.equal(first.statusCode, 200); assert.equal(first.json().status, 'succeeded');
    assert.equal(first.json().linkage.traceId, traceId); assert.equal(first.json().linkage.policy, 'full');
    const commandId = first.json().result.receipt.commandId;
    assert.match(commandId, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.json().commandIds, [commandId]); assert.deepEqual(first.json().result.receipt.linkage, input.linkage);
    assert.deepEqual((await app.inject({ method: 'POST', url: `${base}/call`, headers, payload: input })).json(), first.json());
    for (const altered of [{ ...input, arguments: { ...input.arguments, title: 'Different request' } }, { ...input, target: { ...target, projectId: f.second.id } }]) {
      assert.equal((await app.inject({ method: 'POST', url: `${base}/call`, payload: altered })).statusCode, 409);
    }
    assert.equal((await app.inject({ method: 'POST', url: `${base}/call`, headers: { 'x-test-actor': 'limited' }, payload: input })).statusCode, 409);
    const next = { ...input, operationId: randomUUID(), arguments: { ...input.arguments, title: 'Second independently bound call' },
      linkage: { ...input.linkage, invocationId: randomUUID() } };
    const second = await app.inject({ method: 'POST', url: `${base}/call`, payload: next,
      headers: { 'x-pm-tool-linkage': createPmToolLinkageBearer(f.owner.id, pmToolRequestHash(next, f.owner.id), next.linkage) } });
    assert.equal(second.json().linkage.traceId, traceId);
    assert.notEqual(second.json().commandIds[0], commandId);
    const ctx = { sql: f.database, actor: f.owner, workspaceId: f.ws.id, membership: await getMembership(f.database, f.owner, f.ws.id), now: new Date(), core: await f.coreFor(f.owner) };
    const exact = await readProjectAudit(ctx, f.first.id, { commandId, operationId: input.operationId });
    assert.equal(exact.entries.length, 1); assert.equal(exact.entries[0]!.commandId, commandId);
    assert.deepEqual(exact.entries[0]!.correlation, { operationId: input.operationId, traceId, invocationId: input.linkage.invocationId,
      executionRoot: 'generation', executionGrantId: input.linkage.executionGrantId, clientKind: 'chat', policy: 'full', enforcement: 'audit-only' });
    assert.equal(JSON.stringify(exact).includes(privateBody), false);
    assert.equal(JSON.stringify(exact).includes('requestHash'), false);
    assert.equal(JSON.stringify(exact).includes('inputMessageId'), false);
    assert.equal((await readProjectAudit(ctx, f.first.id, { commandId, operationId: next.operationId })).entries.length, 0);
    assert.equal((await readProjectAudit(ctx, f.second.id, { commandId })).entries.length, 0);
    const page = await readProjectAudit(ctx, f.first.id, { limit: 1 });
    assert.ok(page.nextCursor);
    await assert.rejects(readProjectAudit(ctx, f.first.id, { cursor: page.nextCursor, commandId }), (error: unknown) => error instanceof DomainError && error.code === 'validation_failed');
    const limitedCtx = { ...ctx, actor: f.limited, membership: await getMembership(f.database, f.limited, f.ws.id), core: await f.coreFor(f.limited) };
    await assert.rejects(readProjectAudit(limitedCtx, f.first.id, { commandId }), (error: unknown) => error instanceof DomainError && error.status === 403);
    const forged = { ...input, operationId: randomUUID(), arguments: { ...input.arguments, title: 'Unsigned correlation does not grant provenance' } };
    const unsigned = await app.inject({ method: 'POST', url: `${base}/call`, payload: forged });
    assert.equal(unsigned.json().status, 'succeeded'); assert.equal(unsigned.json().linkage, undefined, 'An untrusted trace hint cannot become audit attribution');
    const external = { operationId: randomUUID(), name: 'pm_create_task', arguments: { ...taskInput(f.first.id), title: 'External full-access call' }, target, executionRoot: 'external' };
    const externalResult = await app.inject({ method: 'POST', url: `${base}/call`, payload: external });
    assert.equal(externalResult.json().status, 'succeeded');
    assert.equal(externalResult.json().threadId, ''); assert.equal(externalResult.json().messageId, ''); assert.equal(externalResult.json().generationId, '');
    assert.equal(externalResult.json().linkage.executionRoot, 'external'); assert.equal(externalResult.json().linkage.enforcement, 'audit-only');
    assert.equal((await app.inject({ method: 'POST', url: `${base}/result`, payload: external })).json().linkage.traceId, externalResult.json().linkage.traceId);
  });
  it('bounds and sources query/body pages, intersects explicit workspace grants and current membership', async t => {
    const f = await fixture(); t.after(() => f.close());
    const context = f.context(f.owner, [f.first.id], 'workspace');
    const query = await f.tools.execute('pm_query', { entity: null, projectId: null, query: null, after: null, limit: 2 }, context);
    assert.equal(query.items.length, 2); assert.equal(query.truncated, true); assert.ok(query.nextCursor);
    assert.ok(query.sources.every(source => source.projectId === f.first.id));
    await assert.rejects(f.tools.execute('pm_read', { id: f.hidden.id, bodyOffset: 0, bodyLimit: 30 }, context), denied);
    await assert.rejects(f.tools.execute('pm_read', { id: f.hidden.id, bodyOffset: 0, bodyLimit: 30 }, f.context(f.limited, [f.first.id, f.second.id])), denied);
    const read = await f.tools.execute('pm_read', { id: f.document.id, bodyOffset: 0, bodyLimit: 8 }, context);
    assert.equal(read.kind, 'document'); if (read.kind !== 'document') assert.fail();
    assert.equal(read.items[0]?.body?.length, 8); assert.equal(read.items[0]?.nextBodyOffset, 8); assert.equal(read.sources[0]?.revision, f.document.revision);
    await f.database.query('UPDATE memberships SET revoked_at=clock_timestamp(),version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.ws.id, f.limited.id]);
    await assert.rejects(f.tools.execute('pm_read', { id: f.task.id, bodyOffset: 0, bodyLimit: 30 }, f.context(f.limited)), denied);
  });

  it('creates once, retains original native operation keys, checks revisions and keeps body injection out of metadata', async t => {
    const f = await fixture(); t.after(() => f.close());
    const context = f.context(), input = taskInput(f.first.id);
    const created = await f.tools.execute('pm_create_task', input, context);
    const replay = await f.tools.execute('pm_create_task', input, context);
    if (created.kind !== 'task' || replay.kind !== 'task') assert.fail('Expected native task results');
    assert.equal(created.items[0]?.id, replay.items[0]?.id); assert.deepEqual(created.receipt, replay.receipt);
    assert.equal(f.workspace.items({ entity: 'work_item', q: input.title }).length, 1);
    await assert.rejects(f.tools.execute('pm_create_task', { ...input, title: 'Changed intent' }, context), (error: unknown) => error instanceof DomainError && error.code === 'command_id_conflict');
    const updated = await f.tools.execute('pm_update_task', { ...taskEdit(f.task.id, f.task.revision), description: 'Changed description' }, f.context());
    assert.equal(updated.kind, 'task');
    assert.ok(f.workspace.get(f.task.id).entity.checklist.some(item => item.text === 'Keep acceptance criteria'));
    await assert.rejects(f.tools.execute('pm_update_task', taskEdit(f.task.id, f.task.revision), f.context()), (error: unknown) => error instanceof WorkspaceError && error.status === 409);
    const before = f.workspace.get(f.document.id), body = '---\nstatus: done\narchived: true\n---\n# Content, not frontmatter';
    await f.tools.execute('pm_save_document', { id: before.id, revision: before.revision, body }, f.context());
    const after = f.workspace.get(before.id);
    assert.equal(after.entity.status, before.entity.status); assert.equal(after.entity.archived, before.entity.archived); assert.ok(after.entity.body.includes('status: done'));
    const audit = await f.database.query('SELECT command_id FROM project_audit WHERE workspace_id=$1 AND command_id=$2', [f.ws.id, created.receipt!.commandId]);
    assert.equal(audit.rows.length, 1);
  });

  it('creates real documents and saves project/task ordinary fields without changing workflow state', async t => {
    const f = await fixture(); t.after(() => f.close());
    const document = await f.tools.execute('pm_create_document', { projectId: f.first.id, title: 'Native created document', body: 'Saved initial content' }, f.context());
    if (document.kind !== 'document') assert.fail('Expected native document result');
    const created = f.workspace.get(document.items[0]!.id);
    assert.ok(created.entity.body.includes('Saved initial content'));
    assert.equal(created.revision, document.receipt?.revision);
    const body = `${created.entity.body.trim()}\n\nAppended without duplicating the document title.`;
    await f.tools.execute('pm_save_document', { id: created.id, revision: created.revision, body }, f.context());
    assert.equal(f.workspace.get(created.id).entity.body.trim(), body);
    await f.tools.execute('pm_update_project', { id: f.first.id, revision: f.first.revision, title: 'Updated project', goal: 'Ordinary goal', description: 'Updated native project body', startDate: '2026-10-01', dueDate: '2026-10-31' }, f.context());
    const project = f.workspace.get(f.first.id);
    assert.equal(project.entity.title, 'Updated project'); assert.equal(project.entity.goal, 'Ordinary goal');
    assert.equal(project.entity.status, f.first.entity.status);
    const edited = await f.tools.execute('pm_update_task', { ...taskEdit(f.task.id, f.task.revision), priority: 'urgent', labels: ['ordinary'], startDate: '2026-10-02', dueDate: '2026-10-30' }, f.context());
    if (edited.kind !== 'task') assert.fail('Expected native task result');
    assert.equal(edited.items[0]?.fields?.priority, 'urgent'); assert.deepEqual(edited.items[0]?.fields?.labels, ['ordinary']);
    assert.equal(f.workspace.get(f.task.id).entity.status, f.task.entity.status);
    await assert.rejects(f.tools.execute('pm_update_project', { id: project.id, revision: f.first.revision, title: 'Stale overwrite', goal: null, description: null, startDate: null, dueDate: null }, f.context()), (error: unknown) => error instanceof WorkspaceError && error.status === 409);
  });

  it('checks both relation endpoints and target CAS, hides out-of-scope relations and applies native cycle validation', async t => {
    const f = await fixture(); t.after(() => f.close());
    const link = { sourceId: f.task.id, targetId: f.hidden.id, relation: 'related_to', revision: f.task.revision, targetRevision: f.hidden.revision };
    await assert.rejects(f.tools.execute('pm_add_relation', link, f.context()), denied);
    assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
    await f.tools.execute('pm_add_relation', link, f.context(f.owner, [f.first.id, f.second.id]));
    const visible = await f.tools.execute('pm_read_relations', { id: f.task.id, after: null, limit: 20 }, f.context());
    assert.equal(visible.kind, 'relation'); assert.ok(!visible.items.some(item => 'targetId' in item && item.targetId === f.hidden.id));
    const current = f.workspace.get(f.task.id);
    await assert.rejects(f.tools.execute('pm_remove_relation', { ...link, revision: current.revision }, f.context()), denied);
    const target = await f.workspace.patch(f.hidden.id, { title: 'Concurrent related endpoint edit' }, f.hidden.revision);
    await assert.rejects(f.tools.execute('pm_remove_relation', { ...link, revision: current.revision }, f.context(f.owner, [f.first.id, f.second.id])), (error: unknown) => error instanceof DomainError && error.code === 'version_conflict');
    assert.equal(f.workspace.get(f.task.id).revision, current.revision);
    await f.tools.execute('pm_remove_relation', { ...link, revision: current.revision, targetRevision: target.revision }, f.context(f.owner, [f.first.id, f.second.id]));
    const first = f.workspace.get(f.task.id), peer = f.workspace.get(f.peer.id);
    await f.tools.execute('pm_add_relation', { sourceId: first.id, targetId: peer.id, relation: 'blocked_by', revision: first.revision, targetRevision: peer.revision }, f.context());
    await assert.rejects(f.tools.execute('pm_add_relation', { sourceId: peer.id, targetId: first.id, relation: 'blocked_by', revision: peer.revision, targetRevision: f.workspace.get(first.id).revision }, f.context()), (error: unknown) => error instanceof WorkspaceError && error.diagnostics.some(issue => issue.code === 'RELATION_CYCLE'));
  });

  it('checks cancellation and current grant at the actual native write boundary', async t => {
    const f = await fixture(); t.after(() => f.close());
    const cancelled = f.context(); cancelled.signal = AbortSignal.abort();
    await assert.rejects(f.tools.execute('pm_update_task', taskEdit(f.task.id, f.task.revision), cancelled), (error: unknown) => error instanceof DomainError && error.code === 'agent_tool_cancelled');
    const revoked = f.context(); revoked.checkAuthorization = async () => { throw new DomainError('agent_access_revoked', 'Explicit grant is revoked', 403); };
    await assert.rejects(f.tools.execute('pm_update_task', taskEdit(f.task.id, f.task.revision), revoked), (error: unknown) => error instanceof DomainError && error.code === 'agent_access_revoked');
    assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
    const queued = f.context(f.owner, [f.first.id], 'workspace');
    queued.checkAuthorization = async sql => {
      if (sql !== f.database) throw new DomainError('agent_access_revoked', 'Grant revoked while this command waited for its transaction lock', 403);
    };
    await assert.rejects(f.tools.execute('pm_create_project', { title: 'Must not be created', description: '', goal: null }, queued), (error: unknown) => error instanceof DomainError && error.code === 'agent_access_revoked');
    await assert.rejects(f.tools.execute('pm_create_comment', { projectId: f.first.id, taskId: f.task.id, content: 'Must not be posted' }, { ...queued, operationId: randomUUID() }), (error: unknown) => error instanceof DomainError && error.code === 'agent_access_revoked');
    assert.equal(f.workspace.items({ entity: 'project', q: 'Must not be created' }).length, 0);
    const comments = await f.tools.execute('pm_read_comments', { taskId: f.task.id, after: null, limit: 10 }, f.context());
    assert.deepEqual(comments.items, []);
  });

  it('recovers the original receipt after later changes but never promotes an unproven pending update', async t => {
    const f = await fixture(); t.after(() => f.close());
    const context = f.context(), input = { id: f.document.id, revision: f.document.revision, body: 'Committed original body' };
    const committed = await f.tools.execute('pm_save_document', input, context);
    const original = f.workspace.get(f.document.id);
    await f.workspace.patch(original.id, { title: 'Later human edit' }, original.revision);
    const recovered = await f.tools.recover('pm_save_document', input, context);
    assert.equal(recovered?.receipt?.commandId, committed.receipt?.commandId); assert.equal(recovered?.receipt?.revision, original.revision);
    assert.deepEqual(recovered?.items, []); assert.deepEqual(recovered?.sources, []);
    const stoppedRecovery = await f.tools.recover('pm_save_document', input, { ...context, signal: AbortSignal.abort() });
    assert.equal(stoppedRecovery?.receipt?.commandId, committed.receipt?.commandId, 'Cancellation prevents new dispatch but never erases a committed native receipt');
    const pendingContext = f.context(), current = f.workspace.get(f.task.id), args = taskEdit(current.id, current.revision);
    const action = 'UpdateCoreSource', nativeInput = { ...args }, commandId = nativeCommandId(f.ws.id, f.owner.id, action, current.id, pendingContext.operationId);
    new CoreCommandJournal(f.workspace.root).pendingHttp(commandId, requestHash({ action, targetId: current.id, input: nativeInput }), f.owner.id);
    assert.equal(await f.tools.recover('pm_update_task', args, pendingContext), null);
    await assert.rejects(f.tools.execute('pm_update_task', args, pendingContext), (error: unknown) => error instanceof DomainError && error.code === 'core_write_outcome_unknown');
    assert.equal(f.workspace.get(current.id).revision, current.revision);
  });

  it('creates actual projects only with explicit workspace authorization and preserves local storage policy', async t => {
    const f = await fixture(); t.after(() => f.close());
    const input = { title: 'Real tool-created project', description: 'Native policy', goal: null };
    await assert.rejects(f.tools.execute('pm_create_project', input, f.context()), (error: unknown) => error instanceof DomainError && error.code === 'agent_tool_workspace_scope_required');
    const result = await f.tools.execute('pm_create_project', input, f.context(f.owner, [f.first.id], 'workspace'));
    if (result.kind !== 'project') assert.fail('Expected native project result');
    assert.equal(result.kind, 'project'); assert.ok(result.items[0]); assert.equal(f.workspace.get(result.items[0]!.id).entity.title, input.title);
    const local = createAgentChatTools({ ...f.options, localProjects: { enabled: true, defaultParent: null } });
    assert.equal(local.registry.find(tool => tool.name === 'pm_create_project')?.available, false);
    assert.ok(!local.definitions.some(tool => tool.function.name === 'pm_create_project'));
    await assert.rejects(local.execute('pm_create_project', input, f.context(f.owner, [f.first.id], 'workspace')), (error: unknown) => error instanceof DomainError && error.code === 'local_project_directory_required');
    const query = await f.tools.execute('pm_query', { entity: 'project', projectId: null, query: null, after: null, limit: 20 }, f.context(f.owner, [f.first.id], 'workspace'));
    if (query.kind !== 'query') assert.fail('Expected typed project query result');
    assert.ok(!query.items.some(item => item.id === result.items[0]!.id), 'Creation does not silently expand a frozen project set');
  });

  it('creates and reads real comments through the native command service and recovers the original content/version', async t => {
    const f = await fixture(); t.after(() => f.close());
    const context = f.context(), args = { projectId: f.first.id, taskId: f.task.id, content: 'Actual delegated comment' };
    const result = await f.tools.execute('pm_create_comment', args, context), replay = await f.tools.execute('pm_create_comment', args, context);
    if (result.kind !== 'comment' || replay.kind !== 'comment') assert.fail('Expected native comment results');
    assert.equal(result.kind, 'comment'); assert.equal(result.items[0]?.id, replay.items[0]?.id);
    const read = await f.tools.execute('pm_read_comments', { taskId: f.task.id, after: null, limit: 10 }, f.context());
    assert.equal(read.kind, 'comment'); if (read.kind !== 'comment') assert.fail();
    assert.equal(read.items[0]?.content, args.content); assert.equal(read.items[0]?.version, 1);
    const recovered = await f.tools.recover('pm_create_comment', args, context); assert.equal(recovered?.receipt?.commandId, context.operationId);
    await assert.rejects(f.tools.recover('pm_create_comment', { ...args, content: 'Different content cannot borrow an old receipt' }, context), (error: unknown) => error instanceof DomainError && error.code === 'command_id_conflict');
    await assert.rejects(f.tools.execute('pm_create_comment', { ...args, projectId: f.second.id }, f.context(f.owner, [f.first.id, f.second.id])), denied);
  });
});
