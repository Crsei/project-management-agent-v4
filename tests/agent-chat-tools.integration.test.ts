import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import Fastify from 'fastify';
import { z } from 'zod';
import { registerTaskBriefRoutes } from '../apps/server/pm/src/routes/task-brief-routes.ts';
import { registerAgentToolRoutes } from '../apps/server/pm/src/routes/agent-tool-routes.ts';
import { createAgentChatTools, type AgentChatToolsOptions } from '../apps/server/pm/src/agent-tools/agent-chat-tools.ts';
import { createAdministrationToolFamily } from '../apps/server/pm/src/agent-tools/agent-tool-administration.ts';
import { CoreWorkspacePool, authorizeCoreScope, nativeCommandId } from '../apps/server/pm/src/routes/core-routes.ts';
import { executeCoreCommand, isCoreCommand, isCoreEntityKind, listCoreEntities, readCoreEntity } from '../apps/server/pm/src/core-adapter.ts';
import { CoreCommandJournal } from '../apps/server/pm/src/core-journal.ts';
import { readCoreSnapshot } from '../packages/pm-core/change-snapshots.ts';
import { accessCommands, getMembership } from '../packages/application/src/access.ts';
import { runCommand, requestHash } from '../packages/application/src/kernel.ts';
import { readExternalReceipt, recordExternalReceipt } from '../packages/application/src/core-bridge.ts';
import { readTaskComments, taskCommentsCommands } from '../packages/application/src/task-comments.ts';
import type { CoreAccess, SqlExecutor } from '../packages/application/src/ports.ts';
import type { ProjectAuditWrite } from '../packages/application/src/project-audit.ts';
import type { CapturedServiceFact } from '../packages/application/src/service-facts.ts';
import type { AgentChatToolContext } from '../packages/application/src/agent-chat-tools.ts';
import { DomainError, type Actor } from '../packages/domain/src/core.ts';
import { WorkspaceError } from '../packages/pm-core/index.ts';
import { FileRepository, RepositoryConflict } from '../packages/pm-core/repository.ts';
import { parseConfiguration, type ProtocolConfiguration } from '../packages/pm-schema/index.ts';
import { agentChatToolResultSchema } from '../packages/agent-contracts/src/pm-tool-result.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createMcpServiceBearer, type McpInvocationIdentity } from '../packages/infrastructure/src/mcp-service-auth.ts';
import { PM_TOOL_RECONCILE_PATH, createPmToolLinkageBearer, createPmToolReconcileBearer, pmToolRequestHash } from '../packages/infrastructure/src/pm-tool-service-auth.ts';
import { pmToolReconcileResultSchema, type PmToolLinkage } from '../packages/agent-contracts/src/pm-tools.ts';
import { readProjectAudit } from '../packages/application/src/project-audit.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
async function fixture(configuration?: ProtocolConfiguration) {
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
    if (configuration) await workspace.saveConfiguration(configuration, workspace.configuration().revision);
    const first = await workspace.createEntity({ entity: 'project', title: 'Authorized project' });
    const second = await workspace.createEntity({ entity: 'project', title: 'Other project' });
    const task = await workspace.createEntity({ entity: 'work_item', project: first.id, title: 'Task A', body: 'Original scope\n\n- [ ] Keep acceptance criteria' });
    const peer = await workspace.createEntity({ entity: 'work_item', project: first.id, title: 'Task B' });
    const hidden = await workspace.createEntity({ entity: 'work_item', project: second.id, title: 'Hidden task' });
    const document = await workspace.createEntity({ entity: 'document', project: first.id, title: 'Readable document', body: 'Current authorized document body' });
    const access = await runCommand(database, owner, ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', payload: { userId: limited.id, capabilities: ['domain.read', 'planning.edit', 'intent.propose'], projectIds: [first.id] } }, accessCommands);
    assert.equal(access.status, 'committed');
    async function coreFor(actor: Actor, sql: SqlExecutor = database): Promise<CoreAccess> {
      const scope = await authorizeCoreScope(sql, actor, ws.id, 'domain.read');
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

  it('does not turn a transient core-port outage into a permanent command rejection', async t => {
    const f = await fixture(); t.after(() => f.close());
    const command = { commandId: randomUUID(), commandType: 'CreateTaskComment', projectId: f.first.id, targetId: f.task.id, payload: { content: 'Recorded after storage recovery' } };
    await assert.rejects(runCommand(f.database, f.owner, f.ws.id, command, taskCommentsCommands, async () => {
      throw new DomainError('workspace_initialization_pending', 'Workspace temporarily unavailable', 503);
    }), (error: unknown) => error instanceof DomainError && error.status === 503);
    const unavailable = await f.database.query('SELECT command_id FROM command_receipts WHERE workspace_id=$1 AND command_id=$2', [f.ws.id, command.commandId]);
    assert.equal(unavailable.rowCount, 0, 'Storage unavailability must not permanently reject the command identity');
    const receipt = await runCommand(f.database, f.owner, f.ws.id, command, taskCommentsCommands, sql => f.coreFor(f.owner, sql));
    assert.equal(receipt.status, 'committed');
    const comments = await f.tools.execute('pm_read_comments', { taskId: f.task.id, after: null, limit: 10 }, f.context());
    assert.equal(comments.kind, 'comment');
    assert.deepEqual(comments.items.map(item => 'content' in item ? item.content : null), ['Recorded after storage recovery']);
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

  it('uses original SQL receipts and completed native journals, never absence or a deletion tombstone alone as execution proof', async t => {
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
    assert.deepEqual(await f.tools.inspectOutcome(deletion, f.owner.id, f.ws.id), { status: 'succeeded', evidence: 'native_journal' });
    const recoveredDeletion = await f.tools.recover('pm_delete_task', deletionArgs, deletionContext);
    if (recoveredDeletion?.kind !== 'lifecycle') assert.fail('Expected the original durable deletion receipt');
    assert.deepEqual(recoveredDeletion.items, []); assert.equal(recoveredDeletion.receipt?.targetId, task.id);
    const unrelatedDeletion = f.tools.recoveryIdentity('pm_delete_task', deletionArgs, f.context())!;
    assert.deepEqual(await f.tools.inspectOutcome(unrelatedDeletion, f.owner.id, f.ws.id), { status: 'unknown', evidence: 'unresolved' });
    const originalCreation = await f.tools.recover('pm_create_task', creationArgs, creationContext);
    assert.deepEqual(originalCreation?.receipt, creation.receipt, 'A deleted current task does not erase the exact original creation receipt');
    if (originalCreation?.kind !== 'task') assert.fail('Expected the original native task creation receipt');
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
    if (query.kind !== 'query') assert.fail('Expected a native entity query page');
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
    if (comments.kind !== 'comment') assert.fail('Expected a native comment page');
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
    if (recovered?.kind !== 'document') assert.fail('Expected the original document write receipt');
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
  it('serves the same read-only brief over HTTP and registered tools, rejects old revisions and hides unauthorized relationships', async t => {
    const f = await fixture(); t.after(() => f.close());
    const current = await f.workspace.patch(f.task.id, { blocked_by: [f.hidden.id] }, f.task.revision);
    const app = Fastify(); t.after(() => app.close());
    app.setErrorHandler((error, _request, reply) => error instanceof DomainError
      ? reply.code(error.status).send({ error: { code: error.code, message: error.message } })
      : error instanceof z.ZodError ? reply.code(400).send({ error: { code: 'validation_failed' } }) : reply.code(500).send({ error: 'unexpected' }));
    const options = { database: () => f.database, actor: async (request: { headers: Record<string, unknown> }) => request.headers['x-test-actor'] === 'limited' ? f.limited : f.owner, coreWorkspaces: f.coreWorkspaces };
    registerTaskBriefRoutes(app, options);
    const base = `/api/v1/workspaces/${f.ws.id}/projects/${f.first.id}/tasks/${f.task.id}`;
    for (const stage of ['analysis', 'development', 'review', 'recovery'] as const) {
      const response = await app.inject({ method: 'GET', url: `${base}/brief?revision=${current.revision}&stage=${stage}`, headers: { 'x-test-actor': 'limited' } });
      assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'private, no-store');
      const result = await f.tools.execute('pm_task_brief', { projectId: f.first.id, taskId: f.task.id, revision: current.revision, stage, bodyOffset: null, bodyLimit: null }, f.context(f.limited));
      if (result.kind !== 'task_brief') assert.fail('Expected the registered task brief result');
      const { generatedAt: _httpAt, ...http } = response.json(), { generatedAt: _toolAt, ...tool } = result.brief;
      assert.deepEqual(http, tool);
      assert.ok(result.brief.relations.every(edge => edge.source.entityId !== f.hidden.id && edge.target.entityId !== f.hidden.id));
      assert.ok(!JSON.stringify(result.brief).includes(f.hidden.id));
      assert.ok(!JSON.stringify(result.brief).includes(f.hidden.entity.title));
      assert.equal(result.receipt, undefined);
    }
    const stale = await app.inject({ method: 'GET', url: `${base}/brief?revision=${f.task.revision}&stage=analysis` });
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().error.code, 'task_brief_revision_conflict');
    const missing = await app.inject({ method: 'GET', url: `${base}/brief?stage=analysis` }); assert.equal(missing.statusCode, 400);
    const hidden = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${f.ws.id}/projects/${f.second.id}/tasks/${f.hidden.id}/brief?revision=${f.hidden.revision}&stage=analysis`, headers: { 'x-test-actor': 'limited' } });
    assert.equal(hidden.statusCode, 404); assert.ok(!hidden.body.includes(f.hidden.entity.title));
    assert.equal(f.workspace.get(f.task.id).revision, current.revision);
    const writes = await f.database.query<{ count: string }>('SELECT count(*)::text AS count FROM pm_agent_tool_operations WHERE workspace_id=$1', [f.ws.id]);
    assert.equal(writes.rows[0]?.count, '0', 'HTTP and direct read services do not create executions or business tool operations');
  });

  it('retrieves current original knowledge, enforces explicit cross-project scope, invalidates pages and refuses cached old tool results', async t => {
    const f = await fixture(); t.after(() => f.close());
    const own = await f.workspace.createEntity({ entity: 'requirement', project: f.first.id, title: 'lexical authority', body: 'lexical current requirement\n' + 'retained context\n'.repeat(300) + 'SUPERSEDED: read the replacement.' });
    await f.workspace.createEntity({ entity: 'document', project: f.first.id, title: 'lexical peer', body: 'lexical second source' });
    await f.workspace.createEntity({ entity: 'document', project: f.second.id, title: 'lexical hidden', body: 'lexical outside current default scope' });
    const app = Fastify(); t.after(() => app.close());
    app.setErrorHandler((error, _request, reply) => error instanceof DomainError ? reply.code(error.status).send({ error: { code: error.code } }) : reply.code(500).send({ error: 'unexpected' }));
    const options = { database: () => f.database, actor: async (request: { headers: Record<string, unknown> }) => request.headers['x-test-actor'] === 'limited' ? f.limited : f.owner, coreWorkspaces: f.coreWorkspaces };
    registerTaskBriefRoutes(app, options); registerAgentToolRoutes(app, { ...options, tools: f.tools });
    const base = `/api/v1/workspaces/${f.ws.id}/projects/${f.first.id}/tasks/${f.task.id}/knowledge?revision=${f.task.revision}&query=lexical`;
    const first = await app.inject({ method: 'GET', url: `${base}&limit=1`, headers: { 'x-test-actor': 'limited' } });
    assert.equal(first.statusCode, 200); assert.deepEqual(first.json().projectIds, [f.first.id]); assert.ok(first.json().nextCursor);
    const chosen = first.json().items[0]; assert.equal(chosen.validity, 'needs_review'); assert.equal(chosen.applicability, 'needs_review');
    const both = await app.inject({ method: 'GET', url: `${base}&projectIds=${f.first.id},${f.second.id}` });
    assert.equal(both.statusCode, 200); assert.equal(both.json().items.length, 3);
    const deniedCrossProject = await app.inject({ method: 'GET', url: `${base}&projectIds=${f.first.id},${f.second.id}`, headers: { 'x-test-actor': 'limited' } });
    assert.equal(deniedCrossProject.statusCode, 404);
    const continuation = await f.tools.execute('pm_read', { id: own.id, bodyOffset: 2000, bodyLimit: 12000 }, f.context(f.limited));
    assert.equal(continuation.kind, 'requirement');
    if (continuation.kind !== 'requirement') assert.fail();
    assert.equal(continuation.items[0]?.entity, 'requirement'); assert.equal(continuation.items[0]?.revision, own.revision);
    assert.ok(continuation.items[0]?.body?.includes('SUPERSEDED'));
    const call = { operationId: randomUUID(), name: 'pm_search_knowledge', arguments: { projectId: f.first.id, taskId: f.task.id, revision: f.task.revision, query: 'lexical', projectIds: null, limit: 20, cursor: null }, target: { workspaceId: f.ws.id, projectId: f.first.id }, threadId: 'brief-thread', messageId: 'brief-message', generationId: 'brief-generation' };
    const toolBase = `/api/v1/workspaces/${f.ws.id}/agent-tools`;
    const original = await app.inject({ method: 'POST', url: `${toolBase}/call`, payload: call, headers: { 'x-test-actor': 'limited' } });
    assert.equal(original.statusCode, 200); assert.equal(original.json().result.kind, 'knowledge');
    assert.ok(original.json().result.knowledge.items.some((item: { validitySignals: { text: string }[] }) => item.validitySignals.some(signal => signal.text.includes('SUPERSEDED'))));
    await f.workspace.patch(own.id, { title: 'lexical changed source' }, own.revision);
    const oldPage = await app.inject({ method: 'GET', url: `${base}&limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`, headers: { 'x-test-actor': 'limited' } });
    assert.equal(oldPage.statusCode, 409); assert.equal(oldPage.json().error.code, 'task_knowledge_cursor_stale');
    const oldResult = await app.inject({ method: 'POST', url: `${toolBase}/result`, payload: call, headers: { 'x-test-actor': 'limited' } });
    assert.equal(oldResult.statusCode, 409); assert.equal(oldResult.json().error.code, 'agent_tool_read_stale'); assert.ok(!oldResult.body.includes(own.entity.body));
    const refreshed = await app.inject({ method: 'GET', url: base, headers: { 'x-test-actor': 'limited' } });
    assert.equal(refreshed.json().items.find((item: { source: { entityId: string } }) => item.source.entityId === own.id)?.source.revision, f.workspace.get(own.id).revision);
    await f.database.query('UPDATE memberships SET revoked_at=clock_timestamp(),version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.ws.id, f.limited.id]);
    const revoked = await app.inject({ method: 'GET', url: base, headers: { 'x-test-actor': 'limited' } });
    assert.equal(revoked.statusCode, 404); assert.ok(!revoked.body.includes('SUPERSEDED'));
    const revokedTool = await app.inject({ method: 'POST', url: `${toolBase}/result`, payload: call, headers: { 'x-test-actor': 'limited' } });
    assert.equal(revokedTool.statusCode, 404); assert.ok(!revokedTool.body.includes('SUPERSEDED'));
  });

  it('settles authoritative brief and knowledge rejections without losing their original operation identity', async t => {
    const f = await fixture(); t.after(() => f.close());
    const current = await f.workspace.patch(f.task.id, { title: 'Changed authoritative task' }, f.task.revision);
    const app = Fastify(); t.after(() => app.close());
    app.setErrorHandler((error, _request, reply) => error instanceof DomainError ? reply.code(error.status).send({ error: { code: error.code } }) : reply.code(500).send({ error: 'unexpected' }));
    registerAgentToolRoutes(app, { database: () => f.database, actor: async () => f.limited, coreWorkspaces: f.coreWorkspaces, tools: f.tools });
    const base = `/api/v1/workspaces/${f.ws.id}/agent-tools`;
    const knowledge = { projectId: f.first.id, taskId: f.task.id, revision: current.revision, query: 'literal', projectIds: null, limit: 20, cursor: null };
    const cases = [
      { name: 'pm_task_brief', arguments: { projectId: f.first.id, taskId: f.task.id, revision: f.task.revision, stage: 'development', bodyOffset: null, bodyLimit: null }, code: 'task_brief_revision_conflict' },
      { name: 'pm_search_knowledge', arguments: { ...knowledge, projectIds: [f.first.id, f.second.id] }, code: 'not_found_or_forbidden' },
      { name: 'pm_search_knowledge', arguments: { ...knowledge, cursor: 'invalid-cursor' }, code: 'task_knowledge_cursor_stale' },
      { name: 'pm_search_knowledge', arguments: { ...knowledge, query: '!!!' }, code: 'task_knowledge_query_invalid' },
    ];
    for (const item of cases) {
      const call = { operationId: randomUUID(), name: item.name, arguments: item.arguments, target: { workspaceId: f.ws.id, projectId: f.first.id }, threadId: 'rejected-read-thread', messageId: 'rejected-read-message', generationId: 'rejected-read-generation' };
      for (const action of ['call', 'result', 'call']) {
        const response = await app.inject({ method: 'POST', url: `${base}/${action}`, payload: call });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().operationId, call.operationId);
        assert.equal(response.json().status, 'failed');
        assert.equal(response.json().error.code, item.code);
        assert.equal(response.json().result, null);
        assert.ok(!response.body.includes(f.hidden.entity.title));
      }
      const rows = await f.database.query<{ status: string; outcome_evidence: string }>('SELECT status,outcome_evidence FROM pm_agent_tool_operations WHERE operation_id=$1', [call.operationId]);
      assert.deepEqual(rows.rows, [{ status: 'failed', outcome_evidence: 'pm_result' }]);
    }
    assert.equal(f.workspace.get(current.id).revision, current.revision);
  });

  it('keeps source-read failures embedded in a last-good snapshot unknown rather than terminally rejected', async t => {
    const f = await fixture(); t.after(() => f.close());
    const originalRead = FileRepository.prototype.read;
    const fault = t.mock.method(FileRepository.prototype, 'read', function (this: FileRepository, relative: string) {
      if (this.root === f.workspace.root && relative === f.task.path) throw new RepositoryConflict('File changed while reading');
      return originalRead.call(this, relative);
    });
    await f.workspace.rescan();
    const stale = f.workspace.snapshot().files.find(record => record.id === f.task.id);
    assert.equal(stale?.stale, true);
    assert.ok(stale?.diagnostics?.some(issue => issue.code === 'FILE_UNREADABLE'));
    const app = Fastify(); t.after(() => app.close());
    registerAgentToolRoutes(app, { database: () => f.database, actor: async () => f.limited, coreWorkspaces: f.coreWorkspaces, tools: f.tools });
    const base = `/api/v1/workspaces/${f.ws.id}/agent-tools`;
    const inputs = [
      { name: 'pm_task_brief', arguments: { projectId: f.first.id, taskId: f.task.id, revision: f.task.revision, stage: 'development', bodyOffset: null, bodyLimit: null } },
      { name: 'pm_search_knowledge', arguments: { projectId: f.first.id, taskId: f.task.id, revision: f.task.revision, query: 'literal', projectIds: null, limit: 20, cursor: null } },
    ];
    for (const input of inputs) {
      const call = { ...input, operationId: randomUUID(), target: { workspaceId: f.ws.id, projectId: f.first.id }, threadId: 'unreadable-thread', messageId: 'unreadable-message', generationId: 'unreadable-generation' };
      for (const action of ['call', 'result']) {
        const response = await app.inject({ method: 'POST', url: `${base}/${action}`, payload: call });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().operationId, call.operationId);
        assert.equal(response.json().status, 'unknown');
        assert.equal(response.json().error.code, 'agent_tool_outcome_unknown');
        assert.equal(response.json().result, null);
        assert.ok(!response.body.includes(f.task.entity.body));
      }
      const rows = await f.database.query<{ status: string; outcome_evidence: string | null }>('SELECT status,outcome_evidence FROM pm_agent_tool_operations WHERE operation_id=$1', [call.operationId]);
      assert.deepEqual(rows.rows, [{ status: 'unknown', outcome_evidence: null }]);
    }
    fault.mock.restore();
    await f.workspace.rescan();
    assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
    const recovered = await app.inject({ method: 'POST', url: `${base}/call`, payload: { ...inputs[0], operationId: randomUUID(), target: { workspaceId: f.ws.id, projectId: f.first.id }, threadId: 'recovered-thread', messageId: 'recovered-message', generationId: 'recovered-generation' } });
    assert.equal(recovered.json().status, 'succeeded');
    assert.equal(recovered.json().result.brief.task.revision, f.task.revision);
  });

  it('does not terminally reject a source omitted by an unreadable scan before any last-good record exists', async t => {
    const f = await fixture(); t.after(() => f.close());
    const unseenId = 'TASK-999999', unseenPath = f.task.path.replace(f.task.id, unseenId);
    assert.notEqual(unseenPath, f.task.path);
    const originalRead = FileRepository.prototype.read;
    const fault = t.mock.method(FileRepository.prototype, 'read', function (this: FileRepository, relative: string) {
      if (this.root === f.workspace.root && relative === unseenPath) throw new RepositoryConflict('File changed while reading');
      return originalRead.call(this, relative);
    });
    await writeFile(join(f.workspace.root, unseenPath), f.task.raw.replaceAll(f.task.id, unseenId));
    await f.workspace.rescan();
    const snapshot = f.workspace.snapshot();
    assert.equal(snapshot.files.some(record => record.id === unseenId), false);
    assert.ok(snapshot.errors.some(issue => issue.code === 'FILE_UNREADABLE' && issue.path === unseenPath));
    const app = Fastify(); t.after(() => app.close());
    registerAgentToolRoutes(app, { database: () => f.database, actor: async () => f.limited, coreWorkspaces: f.coreWorkspaces, tools: f.tools });
    const base = `/api/v1/workspaces/${f.ws.id}/agent-tools`;
    const call = { operationId: randomUUID(), name: 'pm_task_brief', arguments: { projectId: f.first.id, taskId: unseenId, revision: f.task.revision, stage: 'development', bodyOffset: null, bodyLimit: null },
      target: { workspaceId: f.ws.id, projectId: f.first.id }, threadId: 'unseen-thread', messageId: 'unseen-message', generationId: 'unseen-generation' };
    for (const action of ['call', 'result']) {
      const response = await app.inject({ method: 'POST', url: `${base}/${action}`, payload: call });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().operationId, call.operationId);
      assert.equal(response.json().status, 'unknown');
      assert.equal(response.json().error.code, 'agent_tool_outcome_unknown');
    }
    const rows = await f.database.query<{ status: string; outcome_evidence: string | null }>('SELECT status,outcome_evidence FROM pm_agent_tool_operations WHERE operation_id=$1', [call.operationId]);
    assert.deepEqual(rows.rows, [{ status: 'unknown', outcome_evidence: null }]);
    fault.mock.restore();
    await f.workspace.rescan();
    const current = f.workspace.get(unseenId);
    const recovered = await app.inject({ method: 'POST', url: `${base}/call`, payload: { ...call, operationId: randomUUID(), arguments: { ...call.arguments, revision: current.revision } } });
    assert.equal(recovered.json().status, 'succeeded');
    assert.equal(recovered.json().result.brief.task.taskId, unseenId);
  });
  it('discovers the custom workflow through the authorized project API without business writes or write grants', async t => {
    const configuration = parseConfiguration({ schema: 'pm/config/v1', workflows: { work_item: {
      initial: 'intake',
      states: [{ id: 'intake', label: '材料待齐', category: 'unstarted' }, { id: 'assembly', label: '组装中', category: 'started' }, { id: 'released', label: '已投放', category: 'completed' }],
      transitions: [{ from: 'intake', to: 'assembly' }, { from: 'assembly', to: 'released' }],
    } }, custom_fields: [{ name: 'x-unrelated', label: 'Unrelated private configuration', type: 'text', entities: ['project'], default: 'EXCLUDE-FROM-WORKFLOW' }] });
    const f = await fixture(configuration); t.after(() => f.close());
    const member = await getMembership(f.database, f.limited, f.ws.id);
    const updated = await runCommand(f.database, f.owner, f.ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember',
      expectedVersions: { [f.limited.id]: member.version }, payload: { userId: f.limited.id, capabilities: ['domain.read'], projectIds: [f.first.id] } }, accessCommands);
    assert.equal(updated.status, 'committed');
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: { code: error instanceof DomainError ? error.code : 'unexpected' } }));
    registerAgentToolRoutes(app, { database: () => f.database, actor: async request => {
      if (request.headers['x-test-actor'] === 'limited') return f.limited;
      if (request.headers['x-test-actor'] === 'owner') return f.owner;
      throw new DomainError('authentication_required', 'Sign in is required', 401);
    }, coreWorkspaces: f.coreWorkspaces, tools: f.tools });
    t.after(() => app.close());
    const base = `/api/v1/workspaces/${f.ws.id}/agent-tools`;
    const call = { operationId: randomUUID(), name: 'pm_read_workflow', arguments: { projectId: f.first.id },
      target: { workspaceId: f.ws.id, projectId: f.first.id }, threadId: 'workflow-thread', messageId: 'workflow-message', generationId: 'workflow-generation' };
    const headers = { 'x-test-actor': 'limited' };
    const counts = 'SELECT (SELECT count(*)::int FROM command_receipts) AS receipts,(SELECT count(*)::int FROM project_audit) AS audit,(SELECT count(*)::int FROM outbox) AS events';
    const before = { counts: (await f.database.query(counts)).rows, files: f.workspace.snapshot().files.map(file => [file.id, file.raw, file.revision]),
      config: f.workspace.configuration(), state: await readFile(join(f.workspace.root, '.pm/state/state.json'), 'utf8') };
    const catalog = await app.inject({ method: 'GET', url: base, headers });
    assert.equal(catalog.statusCode, 200);
    const advertised = catalog.json().tools.find((tool: { name: string }) => tool.name === call.name);
    assert.ok(advertised); assert.equal(advertised.write, false); assert.deepEqual(advertised.capabilities, ['domain.read']);
    const response = await app.inject({ method: 'POST', url: `${base}/call`, headers, payload: call });
    assert.equal(response.statusCode, 200); assert.equal(response.json().status, 'succeeded');
    const result = agentChatToolResultSchema.parse(response.json().result);
    if (result.kind !== 'workflow') assert.fail('Expected a native workflow result');
    assert.equal(result.workflow.initial, f.task.entity.status);
    assert.deepEqual(result.workflow.states, configuration.workflows.work_item!.states);
    assert.deepEqual(result.workflow.transitions, configuration.workflows.work_item!.transitions);
    assert.equal(result.workflow.defaultTargets, null);
    assert.equal(result.workflow.projectId, f.first.id); assert.equal(result.workflow.workspaceId, f.ws.id);
    assert.equal(result.workflow.configuration.revision, before.config.revision);
    assert.equal(result.workflow.configuration.source, 'workspace');
    assert.equal(result.receipt, undefined); assert.equal(result.truncated, false);
    assert.ok(result.sources.some(source => source.kind === 'workflow' && source.projectId === f.first.id && source.revision === result.workflow.configuration.workflowRevision));
    assert.doesNotMatch(response.body, /EXCLUDE-FROM-WORKFLOW|x-unrelated|custom_fields/);
    const reconciled = await app.inject({ method: 'POST', url: `${base}/result`, headers, payload: call });
    assert.deepEqual(reconciled.json(), response.json());
    assert.deepEqual({ counts: (await f.database.query(counts)).rows, files: f.workspace.snapshot().files.map(file => [file.id, file.raw, file.revision]),
      config: f.workspace.configuration(), state: await readFile(join(f.workspace.root, '.pm/state/state.json'), 'utf8') }, before);
    const operations = await f.database.query('SELECT status,recovery_identity FROM pm_agent_tool_operations WHERE operation_id=$1', [call.operationId]);
    assert.deepEqual(operations.rows, [{ status: 'succeeded', recovery_identity: null }], 'Only the existing tool-operation record is written');
    const transitionCall = { ...call, operationId: randomUUID(), name: 'pm_transition_task',
      arguments: { id: f.task.id, revision: f.task.revision, status: 'assembly' } };
    let transitionDispatches = 0;
    const execute = f.tools.execute;
    f.tools.execute = (...args) => { if (args[0] === 'pm_transition_task') transitionDispatches++; return execute(...args); };
    const transition = await app.inject({ method: 'POST', url: `${base}/call`, headers, payload: transitionCall });
    assert.equal(transition.statusCode, 200); assert.equal(transition.json().status, 'failed');
    assert.equal(transition.json().result, null); assert.equal(transition.json().error.code, 'permission_denied');
    assert.equal(transition.json().certainty.evidence, 'pm_result');
    for (const endpoint of ['result', 'call']) {
      const deniedAgain = await app.inject({ method: 'POST', url: `${base}/${endpoint}`, headers, payload: transitionCall });
      assert.equal(deniedAgain.statusCode, 200); assert.deepEqual(deniedAgain.json(), transition.json());
    }
    assert.equal(transitionDispatches, 1, 'The original native permission denial is retained without redispatch');
    const pendingTransition = { ...transitionCall, operationId: randomUUID() };
    const pendingIdentity = f.tools.recoveryIdentity(pendingTransition.name, pendingTransition.arguments, { ...f.context(f.limited), operationId: pendingTransition.operationId });
    if (pendingIdentity?.kind !== 'core') assert.fail('Expected the original native lifecycle identity');
    new CoreCommandJournal(f.workspace.root).pendingHttp(pendingIdentity.commandId, pendingIdentity.hash, f.limited.id);
    const pendingDenial = await app.inject({ method: 'POST', url: `${base}/call`, headers, payload: pendingTransition });
    assert.equal(pendingDenial.statusCode, 200); assert.equal(pendingDenial.json().status, 'unknown');
    assert.equal(pendingDenial.json().certainty.evidence, 'unresolved', 'Current permission denial cannot settle an already-pending native original');
    for (const endpoint of ['result', 'call']) {
      const pendingAgain = await app.inject({ method: 'POST', url: `${base}/${endpoint}`, headers, payload: pendingTransition });
      assert.equal(pendingAgain.json().status, 'unknown'); assert.equal(pendingAgain.json().certainty.evidence, 'unresolved');
    }
    assert.equal(transitionDispatches, 2, 'The pending original is reconciled without redispatch');
    assert.deepEqual({ counts: (await f.database.query(counts)).rows, files: f.workspace.snapshot().files.map(file => [file.id, file.raw, file.revision]),
      config: f.workspace.configuration(), state: await readFile(join(f.workspace.root, '.pm/state/state.json'), 'utf8') }, before);
    const anonymous = await app.inject({ method: 'POST', url: `${base}/call`, payload: { ...call, operationId: randomUUID() } });
    assert.equal(anonymous.statusCode, 401);
    const outsideMembership = await app.inject({ method: 'POST', url: `${base}/call`, headers, payload: { ...call, operationId: randomUUID(),
      arguments: { projectId: f.second.id }, target: { ...call.target, projectId: f.second.id } } });
    assert.equal(outsideMembership.statusCode, 404);
    const wrongProject = await app.inject({ method: 'POST', url: `${base}/call`, headers: { 'x-test-actor': 'owner' },
      payload: { ...call, operationId: randomUUID(), arguments: { projectId: f.second.id } } });
    assert.equal(wrongProject.json().status, 'failed'); assert.equal(wrongProject.json().result, null);
    assert.equal(wrongProject.json().error.code, 'not_found_or_forbidden');
    const wrongWorkspace = await app.inject({ method: 'POST', url: `${base}/call`, headers,
      payload: { ...call, operationId: randomUUID(), target: { ...call.target, workspaceId: randomUUID() } } });
    assert.equal(wrongWorkspace.statusCode, 400); assert.equal(wrongWorkspace.json().error.code, 'agent_tool_target_mismatch');
    await f.database.query('UPDATE memberships SET capabilities=ARRAY[]::text[],version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.ws.id, f.limited.id]);
    const noRead = await app.inject({ method: 'POST', url: `${base}/result`, headers, payload: call });
    assert.equal(noRead.statusCode, 403); assert.ok(!noRead.body.includes('材料待齐'));
    await f.database.query('UPDATE memberships SET revoked_at=clock_timestamp(),version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.ws.id, f.limited.id]);
    const revoked = await app.inject({ method: 'POST', url: `${base}/result`, headers, payload: call });
    assert.equal(revoked.statusCode, 404); assert.ok(!revoked.body.includes('材料待齐'));
  });

  it('requires a new workflow read after configuration changes instead of replaying a historical plan as current', async t => {
    const f = await fixture(); t.after(() => f.close());
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: { code: error instanceof DomainError ? error.code : 'unexpected' } }));
    registerAgentToolRoutes(app, { database: () => f.database, actor: async () => f.limited, coreWorkspaces: f.coreWorkspaces, tools: f.tools });
    t.after(() => app.close());
    const base = `/api/v1/workspaces/${f.ws.id}/agent-tools`;
    const call = { operationId: randomUUID(), name: 'pm_read_workflow', arguments: { projectId: f.first.id },
      target: { workspaceId: f.ws.id, projectId: f.first.id }, threadId: 'workflow-thread', messageId: 'workflow-message', generationId: 'workflow-generation' };
    const response = await app.inject({ method: 'POST', url: `${base}/call`, payload: call });
    assert.equal(response.statusCode, 200); assert.equal(response.json().status, 'succeeded');
    const old = response.json().result.workflow;
    const configuration = f.workspace.configuration();
    configuration.config.workflows.work_item!.states[0]!.label = 'New configured intake label';
    await f.workspace.saveConfiguration(configuration.config, configuration.revision);
    for (const action of ['result', 'call']) {
      const stale = await app.inject({ method: 'POST', url: `${base}/${action}`, payload: call });
      assert.equal(stale.statusCode, 409); assert.equal(stale.json().error.code, 'agent_tool_read_stale');
    }
    const fresh = await app.inject({ method: 'POST', url: `${base}/call`, payload: { ...call, operationId: randomUUID() } });
    assert.equal(fresh.json().status, 'succeeded');
    assert.equal(fresh.json().result.workflow.states[0].label, 'New configured intake label');
    assert.notEqual(fresh.json().result.workflow.configuration.workflowRevision, old.configuration.workflowRevision);
    assert.notEqual(fresh.json().result.workflow.configuration.revision, old.configuration.revision);
    assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
    const retained = await f.database.query<{ result: unknown }>('SELECT result FROM pm_agent_tool_operations WHERE operation_id=$1', [call.operationId]);
    assert.deepEqual(retained.rows[0]!.result, response.json().result, 'Original read history is immutable');
  });
  it('terminalizes only authoritative missing reads and durable archive-guard rejection, never redispatching originals', async t => {
    const f = await fixture(); t.after(() => f.close());
    const app = Fastify(); t.after(() => app.close());
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: 'denied' }));
    let dispatches = 0;
    const execute = f.tools.execute;
    f.tools.execute = (...args) => { dispatches++; return execute(...args); };
    registerAgentToolRoutes(app, { database: () => f.database, actor: async () => f.owner, coreWorkspaces: f.coreWorkspaces, tools: f.tools });
    const base = `/api/v1/workspaces/${f.ws.id}/agent-tools`;
    const call = (name: string, argumentsValue: unknown) => ({ operationId: randomUUID(), name, arguments: argumentsValue, target: { workspaceId: f.ws.id, projectId: f.first.id }, threadId: 'foundation', messageId: 'original', generationId: 'generation' });
    const missing = call('pm_read', { id: 'TASK-999999', bodyOffset: 0, bodyLimit: 100 });
    const absent = await app.inject({ method: 'POST', url: `${base}/call`, payload: missing });
    assert.equal(absent.json().status, 'failed'); assert.equal(absent.json().certainty.evidence, 'pm_result');
    const before = await readFile(join(f.workspace.root, f.task.path), 'utf8');
    const deletion = call('pm_delete_task', { id: f.task.id, revision: f.task.revision });
    const deniedDelete = await app.inject({ method: 'POST', url: `${base}/call`, payload: deletion });
    assert.equal(deniedDelete.json().status, 'failed'); assert.equal(deniedDelete.json().certainty.evidence, 'internal_proof');
    assert.equal(await readFile(join(f.workspace.root, f.task.path), 'utf8'), before);
    assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
    const dispatched = dispatches;
    for (const original of [missing, deletion]) for (const endpoint of ['result', 'call']) {
      const repeated = await app.inject({ method: 'POST', url: `${base}/${endpoint}`, payload: original });
      assert.equal(repeated.json().status, 'failed');
    }
    assert.equal(dispatches, dispatched, 'Repeated original requests only read their durable result');
    await f.database.query("UPDATE pm_agent_tool_operations SET status='unknown',result=NULL,error=NULL,outcome_evidence=NULL,finished_at=NULL WHERE operation_id=$1", [deletion.operationId]);
    const recoveredRejection = await app.inject({ method: 'POST', url: `${base}/result`, payload: deletion });
    assert.equal(recoveredRejection.json().status, 'failed'); assert.equal(dispatches, dispatched);
    const readable = call('pm_read', { id: f.document.id, bodyOffset: 0, bodyLimit: 1000 });
    assert.equal((await app.inject({ method: 'POST', url: `${base}/call`, payload: readable })).json().status, 'succeeded');
    const visibleDispatches = dispatches;
    await f.workspace.patch(f.document.id, { project: f.second.id }, f.document.revision);
    const hiddenHistory = await app.inject({ method: 'POST', url: `${base}/result`, payload: readable });
    assert.equal(hiddenHistory.statusCode, 404); assert.ok(!hiddenHistory.body.includes(f.document.entity.body));
    assert.equal(dispatches, visibleDispatches, 'Current result authorization does not redispatch the original read or any write');
    assert.equal((await f.database.query<{ status: string }>('SELECT status FROM pm_agent_tool_operations WHERE operation_id=$1', [readable.operationId])).rows[0]?.status, 'succeeded');
    const removed = await f.workspace.archive(f.peer.id, f.peer.revision);
    await f.workspace.delete(removed.id, removed.revision);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/call`, payload: call('pm_read', { id: removed.id, bodyOffset: 0, bodyLimit: 100 }) })).json().status, 'failed');
    await writeFile(join(f.workspace.root, 'work-items', 'unsafe-source.md'), '---\nschema: pm/v1\nid: TASK-999998\nentity: work_item\nproject: broken\n---\n# Unsafe source\n');
    const unproven = await app.inject({ method: 'POST', url: `${base}/call`, payload: call('pm_read', { id: 'TASK-999997', bodyOffset: 0, bodyLimit: 100 }) });
    assert.equal(unproven.json().status, 'unknown', 'An invalid authoritative scan cannot prove nonexistence');
    const uncertainCall = call('pm_transition_task', { id: f.task.id, revision: f.task.revision, status: f.peer.entity.status });
    f.tools.execute = async () => { dispatches++; throw new DomainError('permission_denied', 'A denial without native dispatch-boundary evidence', 403); };
    const uncertain = await app.inject({ method: 'POST', url: `${base}/call`, payload: uncertainCall });
    assert.equal(uncertain.statusCode, 200); assert.equal(uncertain.json().status, 'unknown');
    assert.equal(uncertain.json().certainty.evidence, 'unresolved', 'An ordinary 403 is not an authoritative pre-dispatch rejection');
    const uncertainDispatches = dispatches;
    for (const endpoint of ['result', 'call']) {
      const repeated = await app.inject({ method: 'POST', url: `${base}/${endpoint}`, payload: uncertainCall });
      assert.equal(repeated.json().status, 'unknown'); assert.equal(repeated.json().certainty.evidence, 'unresolved');
    }
    assert.equal(dispatches, uncertainDispatches, 'An unproven original is reconciled, never redispatched');
    assert.equal(f.workspace.get(f.task.id).raw, before);
  });

  it('covers all nine native kinds with typed fields, body/source CAS and their own legal lifecycle', async t => {
    const f = await fixture(); t.after(() => f.close());
    const configuration = f.workspace.configuration();
    await assert.rejects(f.tools.execute('pm_update_entity', { id: f.task.id, revision: f.task.revision, fields: [{ field: 'related_to', value: [f.hidden.id] }] }, f.context()), denied);
    assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
    configuration.config.custom_fields.push({ name: 'x-tool-flag', label: 'Typed flag', type: 'boolean', entities: ['project', 'work_item', 'document', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goal'] });
    await f.workspace.saveConfiguration(configuration.config, configuration.revision);
    const context = () => f.context(f.owner, [f.first.id, f.second.id], 'workspace');
    for (const kind of ['work_item', 'document', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goal'] as const) {
      const created = agentChatToolResultSchema.parse(await f.tools.execute('pm_create_entity', { entity: kind, projectId: f.first.id, title: `Typed ${kind}`, body: 'Original body', fields: [{ field: 'x-tool-flag', value: true }] }, context()));
      assert.equal(created.kind, kind === 'work_item' ? 'task' : kind);
      const record = f.workspace.get(created.receipt!.targetId!);
      assert.equal(record.entity['x-tool-flag'], true);
      const queried = await f.tools.execute('pm_query', { entity: kind, projectId: f.first.id, query: `Typed ${kind}`, after: null, limit: 1 }, context());
      if (queried.kind !== 'query') assert.fail('Expected an all-kind native query');
      assert.equal(queried.items[0]?.id, record.id);
      await f.tools.execute('pm_update_entity', { id: record.id, revision: record.revision, fields: [{ field: 'x-tool-flag', value: false }, { field: 'labels', value: [] }] }, context());
      let current = f.workspace.get(record.id);
      await f.tools.execute('pm_update_entity', { id: current.id, revision: current.revision, fields: [{ field: 'x-tool-flag', value: null }] }, context());
      current = f.workspace.get(record.id); assert.equal(current.entity['x-tool-flag'], undefined);
      await f.tools.execute('pm_update_entity', { id: current.id, revision: current.revision, fields: [{ field: 'x-tool-flag', value: false }] }, context());
      current = f.workspace.get(record.id);
      assert.equal(current.entity['x-tool-flag'], false); assert.deepEqual(current.entity.labels, []);
      await assert.rejects(f.tools.execute('pm_save_entity_source', { id: current.id, revision: current.revision, raw: current.raw.replace(`id: ${current.id}`, 'id: TASK-999999') }, context()), (error: unknown) => error instanceof WorkspaceError);
      assert.equal(f.workspace.get(record.id).revision, current.revision);
      await f.tools.execute('pm_save_entity_body', { id: current.id, revision: current.revision, body: 'Changed body without metadata changes' }, context());
      const withBody = f.workspace.get(current.id);
      assert.equal(withBody.entity.status, current.entity.status); assert.equal(withBody.entity.project, current.entity.project);
      assert.equal(withBody.entity['x-tool-flag'], false); assert.match(withBody.entity.body, /Changed body/);
      await assert.rejects(f.tools.execute('pm_save_entity_body', { id: current.id, revision: current.revision, body: 'Stale overwrite' }, context()), (error: unknown) => error instanceof WorkspaceError && error.status === 409);
      await f.tools.execute('pm_save_entity_source', { id: withBody.id, revision: withBody.revision, raw: `${withBody.raw}\nSource-preserving append.\n` }, context());
      current = f.workspace.get(record.id);
      const unchanged = current.revision;
      await assert.rejects(f.tools.execute('pm_update_entity', { id: current.id, revision: current.revision, fields: [{ field: 'status', value: 'done' }] }, context()), (error: unknown) => error instanceof DomainError && error.code === 'agent_tool_protected_action');
      assert.equal(f.workspace.get(record.id).revision, unchanged);
      if (kind !== 'document') {
        const workflow = f.workspace.configuration().config.workflows[kind]!;
        const target = workflow.transitions.find(edge => edge.from === current.entity.status)!.to;
        await f.tools.execute('pm_transition_entity', { id: current.id, revision: current.revision, status: target }, context());
        current = f.workspace.get(record.id); assert.equal(current.entity.status, target);
      }
      await f.tools.execute('pm_archive_entity', { id: current.id, revision: current.revision }, context());
      current = f.workspace.get(record.id); assert.equal(current.entity.archived, true);
      await f.tools.execute('pm_restore_entity', { id: current.id, revision: current.revision }, context());
      current = f.workspace.get(record.id); assert.equal(current.entity.archived, false);
      await f.tools.execute('pm_archive_entity', { id: current.id, revision: current.revision }, context());
      current = f.workspace.get(record.id);
      const deletionContext = context(), deletionInput = { id: current.id, revision: current.revision };
      await f.tools.execute('pm_delete_entity', deletionInput, deletionContext);
      const recovered = await f.tools.recover('pm_delete_entity', deletionInput, deletionContext);
      assert.equal(recovered?.kind, 'lifecycle'); assert.deepEqual(recovered?.items, []); assert.equal(recovered?.receipt?.targetId, current.id);
    }
    const createdProject = await f.tools.execute('pm_create_project', { title: 'Ninth kind', description: 'Project body', goal: null }, context());
    const projectId = createdProject.receipt!.targetId!;
    const projectContext = () => f.context(f.owner, [projectId], 'workspace');
    let project = f.workspace.get(projectId);
    await f.tools.execute('pm_update_entity', { id: project.id, revision: project.revision, fields: [{ field: 'x-tool-flag', value: true }] }, projectContext());
    project = f.workspace.get(projectId);
    await f.tools.execute('pm_save_entity_body', { id: project.id, revision: project.revision, body: 'Ninth kind body' }, projectContext());
    project = f.workspace.get(projectId);
    assert.equal(project.entity['x-tool-flag'], true);
    await f.tools.execute('pm_archive_entity', { id: project.id, revision: project.revision }, projectContext());
    project = f.workspace.get(projectId);
    await f.tools.execute('pm_restore_entity', { id: project.id, revision: project.revision }, projectContext());
    project = f.workspace.get(projectId);
    await f.tools.execute('pm_archive_entity', { id: project.id, revision: project.revision }, projectContext());
    project = f.workspace.get(projectId);
    await f.tools.execute('pm_delete_entity', { id: project.id, revision: project.revision }, projectContext());
  });

  it('discovers saved revisions safely and applies/restores a nonempty native migration without preview business writes', async t => {
    const f = await fixture(); t.after(() => f.close());
    const admin = () => f.context(f.owner, [f.first.id, f.second.id], 'workspace');
    const viewInput = { id: 'foundation-view', name: 'Native saved view', view: { project: f.first.id, entity: 'work_item', layout: 'table' }, revision: null };
    const saved = await f.tools.execute('pm_save_view', viewInput, admin());
    assert.equal(saved.kind, 'views'); if (saved.kind !== 'views') assert.fail();
    const read = await f.tools.execute('pm_read_view', { id: viewInput.id }, f.context(f.limited));
    assert.equal(read.kind, 'views'); if (read.kind !== 'views') assert.fail();
    assert.equal(read.items[0]?.revision, saved.items[0]?.revision);
    await assert.rejects(f.tools.execute('pm_save_view', viewInput, admin()), (error: unknown) => error instanceof WorkspaceError && error.status === 409);
    await f.tools.execute('pm_save_view', { ...viewInput, name: 'Updated with rediscovered revision', revision: read.items[0]!.revision }, admin());
    await f.tools.execute('pm_save_view', { ...viewInput, id: 'hidden-view', view: { ...viewInput.view, project: f.second.id } }, admin());
    const limitedViews = await f.tools.execute('pm_list_views', { after: null, limit: 20 }, f.context(f.limited));
    assert.ok(!JSON.stringify(limitedViews).includes('hidden-view'));
    const viewQuery = { view: { project: f.first.id, entity: 'work_item', layout: 'table', order: [f.peer.id, f.task.id] }, archived: 'exclude', after: null, limit: 1 };
    const page = await f.tools.execute('pm_query_view', viewQuery, f.context(f.limited));
    if (page.kind !== 'query') assert.fail();
    assert.equal(page.items[0]?.id, f.peer.id); assert.ok(page.nextCursor);
    const next = await f.tools.execute('pm_query_view', { ...viewQuery, after: page.nextCursor }, f.context(f.limited));
    if (next.kind !== 'query') assert.fail();
    assert.equal(next.items[0]?.id, f.task.id); assert.equal(next.nextCursor, null);
    await f.workspace.patch(f.task.id, { title: 'Revision changed between view pages' }, f.task.revision);
    await assert.rejects(f.tools.execute('pm_query_view', { ...viewQuery, after: page.nextCursor }, f.context(f.limited)), (error: unknown) => error instanceof DomainError && error.code === 'agent_tool_view_cursor_stale');
    await assert.rejects(f.tools.execute('pm_save_configuration', { config: f.workspace.configuration().config, revision: f.workspace.configuration().revision }, f.context(f.limited)), (error: unknown) => error instanceof DomainError && error.status === 403);
    const config = await f.tools.execute('pm_read_configuration', {}, admin());
    assert.equal(config.kind, 'configuration'); if (config.kind !== 'configuration') assert.fail();
    assert.equal(config.revision, 'absent');
    const migrationConfiguration = parseConfiguration({ ...config.configuration, custom_fields: [...config.configuration.custom_fields,
      { name: 'x-migration-phase', label: 'Migration phase', type: 'text', entities: ['work_item'] }] });
    await f.tools.execute('pm_save_configuration', { config: migrationConfiguration, revision: config.revision }, admin());
    await assert.rejects(f.tools.execute('pm_save_configuration', { config: migrationConfiguration, revision: config.revision }, admin()), (error: unknown) => error instanceof WorkspaceError && error.status === 409);
    const before = await f.workspace.createEntity({ entity: 'work_item', project: f.first.id, title: 'Migratable native Markdown',
      'x-migration-phase': 'before', body: 'Keep this original migration body.\n' });
    const counts = 'SELECT (SELECT count(*)::int FROM command_receipts) AS receipts,(SELECT count(*)::int FROM project_audit) AS audit,(SELECT count(*)::int FROM outbox) AS events';
    const businessBefore = { counts: (await f.database.query(counts)).rows, files: f.workspace.snapshot().files.map(file => [file.id, file.raw, file.revision]),
      config: f.workspace.configuration(), state: await readFile(join(f.workspace.root, '.pm/state/state.json'), 'utf8') };
    const preview = await f.tools.execute('pm_preview_migration', { kind: 'transform', config: null, changes: [{ id: before.id, set: [{ field: 'x-migration-phase', value: 'migrated' }], rename: [], unset: [] }] }, admin());
    assert.equal(preview.kind, 'migration'); if (preview.kind !== 'migration') assert.fail();
    assert.deepEqual(preview.migration.diagnostics.filter(issue => issue.severity === 'error'), []);
    assert.ok(preview.migration.totalFiles > 0); assert.ok(preview.items.some(file => file.path === before.path && file.beforeRevision !== file.afterRevision));
    assert.deepEqual({ counts: (await f.database.query(counts)).rows, files: f.workspace.snapshot().files.map(file => [file.id, file.raw, file.revision]),
      config: f.workspace.configuration(), state: await readFile(join(f.workspace.root, '.pm/state/state.json'), 'utf8') }, businessBefore);
    const original = { id: preview.migration.id, revision: preview.migration.revision, after: null, limit: 1 };
    const applied = await f.tools.execute('pm_apply_migration', original, admin());
    assert.equal(applied.kind, 'migration'); if (applied.kind !== 'migration') assert.fail();
    assert.equal(applied.migration.status, 'applied'); assert.ok(applied.migration.totalFiles > 0);
    assert.equal(f.workspace.get(before.id).entity['x-migration-phase'], 'migrated');
    assert.equal(f.workspace.get(before.id).entity.body, before.entity.body);
    const reread = await f.tools.execute('pm_read_migration', { id: original.id, after: null, limit: 1 }, admin());
    assert.equal(reread.kind, 'migration'); if (reread.kind !== 'migration') assert.fail();
    assert.equal(reread.migration.status, 'applied'); assert.equal(reread.migration.revision, original.revision);
    const restored = await f.tools.execute('pm_restore_migration', original, admin());
    assert.equal(restored.kind, 'migration'); if (restored.kind !== 'migration') assert.fail();
    assert.equal(restored.migration.status, 'restored'); assert.ok(restored.migration.totalFiles > 0);
    assert.equal(f.workspace.get(before.id).raw, before.raw);
  });
  it('uses exact native state-category capability without inventing a generic planning-edit grant', async t => {
    const f = await fixture(); t.after(() => f.close());
    const member = await getMembership(f.database, f.limited, f.ws.id);
    const granted = await runCommand(f.database, f.owner, f.ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', expectedVersions: { [f.limited.id]: member.version }, payload: { userId: f.limited.id, capabilities: ['domain.read', 'workitem.complete'], projectIds: [f.first.id] } }, accessCommands);
    assert.equal(granted.status, 'committed');
    await f.tools.execute('pm_transition_entity', { id: f.task.id, revision: f.task.revision, status: 'done' }, f.context(f.limited));
    const completed = f.workspace.get(f.task.id);
    assert.equal(completed.entity.status, 'done');
    await assert.rejects(f.tools.execute('pm_update_entity', { id: completed.id, revision: completed.revision, fields: [{ field: 'title', value: 'Forbidden ordinary edit' }] }, f.context(f.limited)), (error: unknown) => error instanceof DomainError && error.status === 403);
    assert.equal(f.workspace.get(f.task.id).revision, completed.revision);
  });
  it('permits the native directory-read capability without granting core read and rechecks directory history after revocation', async t => {
    const f = await fixture(); t.after(() => f.close());
    let membership = await getMembership(f.database, f.limited, f.ws.id);
    const grant = await runCommand(f.database, f.owner, f.ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', expectedVersions: { [f.limited.id]: membership.version }, payload: { userId: f.limited.id, capabilities: ['directory.read'], projectIds: [f.first.id] } }, accessCommands);
    assert.equal(grant.status, 'committed');
    const administration = createAdministrationToolFamily({
      ...f.options,
      async checkMount() { throw new Error('Member directory must not inspect storage mounts'); },
      async applicationRead(principal, workspaceId, reader) {
        const current = await getMembership(f.database, principal, workspaceId);
        return reader({ sql: f.database, actor: principal, workspaceId, membership: current, now: new Date(), core: {
          async get(id, kind) { return (await f.coreFor(principal)).get(id, kind); },
          async list(kind) { return (await f.coreFor(principal)).list(kind); },
          async records() { return (await f.coreFor(principal)).records(); },
          async sprintHistory() { return (await f.coreFor(principal)).sprintHistory(); },
          configuration() { throw new Error('Directory-only actor must not read core configuration'); },
        } });
      },
    });
    const tools = createAgentChatTools({ ...f.options, families: [administration] });
    const app = Fastify(); t.after(() => app.close());
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: 'denied' }));
    registerAgentToolRoutes(app, { database: () => f.database, actor: async () => f.limited, coreWorkspaces: f.coreWorkspaces, tools });
    const base = `/api/v1/workspaces/${f.ws.id}/agent-tools`;
    const catalog = await app.inject({ method: 'GET', url: base });
    assert.equal(catalog.statusCode, 200);
    assert.ok(catalog.json().tools.some((tool: { name: string }) => tool.name === 'pm_read_members'));
    assert.ok(!catalog.json().tools.some((tool: { name: string }) => tool.name === 'pm_read'));
    const original = { operationId: randomUUID(), name: 'pm_read_members', arguments: { workspaceId: f.ws.id, after: null, limit: 20 }, target: { workspaceId: f.ws.id, projectId: f.first.id }, threadId: 'directory', messageId: 'read', generationId: 'generation' };
    const read = await app.inject({ method: 'POST', url: `${base}/call`, payload: original });
    assert.equal(read.statusCode, 200); assert.equal(read.json().status, 'succeeded'); assert.equal(read.json().result.kind, 'administration_members');
    assert.deepEqual(read.json().result.items.map((item: { userId: string }) => item.userId), [f.limited.id]);
    const coreRead = await app.inject({ method: 'POST', url: `${base}/call`, payload: { ...original, operationId: randomUUID(), name: 'pm_read', arguments: { id: f.task.id, bodyOffset: 0, bodyLimit: 1000 } } });
    assert.equal(coreRead.statusCode, 403); assert.ok(!coreRead.body.includes(f.task.entity.body));
    membership = await getMembership(f.database, f.limited, f.ws.id);
    const revoke = await runCommand(f.database, f.owner, f.ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', expectedVersions: { [f.limited.id]: membership.version }, payload: { userId: f.limited.id, capabilities: [], projectIds: [f.first.id] } }, accessCommands);
    assert.equal(revoke.status, 'committed');
    const history = await app.inject({ method: 'POST', url: `${base}/result`, payload: original });
    assert.equal(history.statusCode, 403);
    assert.equal((await f.database.query<{ status: string }>('SELECT status FROM pm_agent_tool_operations WHERE operation_id=$1', [original.operationId])).rows[0]?.status, 'succeeded');
  });
  it('reauthorizes saved core comment bodies against the current task and pinned project without replay', async t => {
    const f = await fixture(); t.after(() => f.close());
    const text = 'Another author retained this private comment in project A';
    await f.tools.execute('pm_create_comment', { projectId: f.first.id, taskId: f.task.id, content: text }, f.context());
    const app = Fastify(); t.after(() => app.close());
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: { code: error instanceof DomainError ? error.code : 'unexpected' } }));
    let dispatches = 0;
    const execute = f.tools.execute;
    f.tools.execute = (...args) => { dispatches++; return execute(...args); };
    registerAgentToolRoutes(app, { database: () => f.database, actor: async request => request.headers['x-test-actor'] === 'limited' ? f.limited : f.owner, coreWorkspaces: f.coreWorkspaces, tools: f.tools });
    const base = `/api/v1/workspaces/${f.ws.id}/agent-tools`;
    const call = (projectId: string | null) => ({ operationId: randomUUID(), name: 'pm_read_comments', arguments: { taskId: f.task.id, after: null, limit: 10 }, target: { workspaceId: f.ws.id, projectId }, threadId: 'comment-authority', messageId: 'original-read', generationId: 'generation' });
    const limited = call(f.first.id), unrestricted = call(null);
    const limitedHeaders = { 'x-test-actor': 'limited' };
    const firstRead = await app.inject({ method: 'POST', url: `${base}/call`, headers: limitedHeaders, payload: limited });
    const workspaceRead = await app.inject({ method: 'POST', url: `${base}/call`, payload: unrestricted });
    assert.equal(firstRead.statusCode, 200); assert.equal(firstRead.json().status, 'succeeded');
    assert.equal(firstRead.json().result.items[0].content, text);
    assert.equal(workspaceRead.statusCode, 200); assert.equal(workspaceRead.json().result.items[0].content, text);
    const originalDispatches = dispatches;
    await f.workspace.patch(f.task.id, { project: f.second.id }, f.task.revision);
    await assert.rejects(f.options.readComments(f.owner, f.ws.id, f.task.id, { projectId: f.first.id, limit: 1 }), denied);
    for (const original of [limited, unrestricted]) {
      const headers = original.operationId === limited.operationId ? limitedHeaders : {};
      for (const endpoint of ['result', 'call']) {
        const hidden = await app.inject({ method: 'POST', url: `${base}/${endpoint}`, headers, payload: original });
        assert.equal(hidden.statusCode, 404); assert.ok(!hidden.body.includes(text));
      }
      const retained = (await f.database.query<{ status: string; result: unknown }>('SELECT status,result FROM pm_agent_tool_operations WHERE operation_id=$1', [original.operationId])).rows[0]!;
      assert.equal(retained.status, 'succeeded');
      assert.deepEqual(retained.result, original.operationId === limited.operationId ? firstRead.json().result : workspaceRead.json().result);
    }
    assert.equal(dispatches, originalDispatches, 'Comment delivery uses only current readonly binding checks, never replay');
  });

  it('withholds retained workspace configuration diagnostics after scope narrowing while preserving the original success', async t => {
    const f = await fixture(); t.after(() => f.close());
    let member = await getMembership(f.database, f.limited, f.ws.id);
    const unrestricted = await runCommand(f.database, f.owner, f.ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', expectedVersions: { [f.limited.id]: member.version }, payload: { userId: f.limited.id, capabilities: ['domain.read'], projectIds: null } }, accessCommands);
    assert.equal(unrestricted.status, 'committed');
    const invalid = f.workspace.configuration().config;
    invalid.workflows.work_item = { initial: 'private-workflow', states: [{ id: 'private-workflow', label: 'Private workflow diagnostic', category: 'unstarted' }], transitions: [] };
    const configPath = join(f.workspace.root, '.pm/config.yaml'), raw = JSON.stringify(invalid);
    await writeFile(configPath, raw);
    const app = Fastify(); t.after(() => app.close());
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: { code: error instanceof DomainError ? error.code : 'unexpected' } }));
    let dispatches = 0;
    const execute = f.tools.execute;
    f.tools.execute = (...args) => { dispatches++; return execute(...args); };
    registerAgentToolRoutes(app, { database: () => f.database, actor: async () => f.limited, coreWorkspaces: f.coreWorkspaces, tools: f.tools });
    const base = `/api/v1/workspaces/${f.ws.id}/agent-tools`;
    const original = { operationId: randomUUID(), name: 'pm_read_configuration', arguments: {}, target: { workspaceId: f.ws.id, projectId: f.first.id }, threadId: 'configuration-authority', messageId: 'original-read', generationId: 'generation' };
    const response = await app.inject({ method: 'POST', url: `${base}/call`, payload: original });
    assert.equal(response.statusCode, 200); assert.equal(response.json().status, 'succeeded');
    const result = agentChatToolResultSchema.parse(response.json().result);
    if (result.kind !== 'configuration') assert.fail('Expected the original native configuration result');
    assert.ok(result.diagnostics.length > 0);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.path === f.hidden.path), 'Unrestricted diagnostics include the otherwise hidden project source');
    member = await getMembership(f.database, f.limited, f.ws.id);
    const narrowed = await runCommand(f.database, f.owner, f.ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', expectedVersions: { [f.limited.id]: member.version }, payload: { userId: f.limited.id, capabilities: ['domain.read'], projectIds: [f.first.id] } }, accessCommands);
    assert.equal(narrowed.status, 'committed');
    const originalDispatches = dispatches;
    for (const endpoint of ['result', 'call']) {
      const hidden = await app.inject({ method: 'POST', url: `${base}/${endpoint}`, payload: original });
      assert.equal(hidden.statusCode, 404); assert.ok(!hidden.body.includes(f.hidden.path));
    }
    assert.equal(dispatches, originalDispatches);
    const retained = (await f.database.query<{ status: string; result: unknown }>('SELECT status,result FROM pm_agent_tool_operations WHERE operation_id=$1', [original.operationId])).rows[0]!;
    assert.equal(retained.status, 'succeeded'); assert.deepEqual(retained.result, response.json().result);
    const fresh = await app.inject({ method: 'POST', url: `${base}/call`, payload: { ...original, operationId: randomUUID() } });
    assert.equal(fresh.statusCode, 200); assert.equal(fresh.json().status, 'succeeded'); assert.deepEqual(fresh.json().result.diagnostics, []);
    assert.equal(await readFile(configPath, 'utf8'), raw, 'Read visibility checks never repair or rewrite configuration');
  });
});
