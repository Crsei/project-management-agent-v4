import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createAgentChatTools, type AgentChatToolsOptions } from '../apps/api/src/agent-chat-tools.ts';
import { CoreWorkspacePool, authorizeCoreScope, nativeCommandId } from '../apps/api/src/core-routes.ts';
import { executeCoreCommand, isCoreCommand, isCoreEntityKind, listCoreEntities, readCoreEntity } from '../apps/api/src/core-adapter.ts';
import { CoreCommandJournal } from '../apps/api/src/core-journal.ts';
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
        if (!isCoreCommand(command.commandType)) return runCommand(database, actor, workspaceId, command, taskCommentsCommands, await coreFor(actor), undefined, checkAuthorization);
        const hash = requestHash(command as unknown as Record<string, unknown>);
        const prior = await readExternalReceipt(database, actor, workspaceId, command.commandId, hash);
        if (prior) return prior;
        const scope = await authorizeCoreScope(database, actor, workspaceId, 'domain.read');
        const audit: ProjectAuditWrite[] = [], facts: CapturedServiceFact[] = [];
        const receipt = await executeCoreCommand({ workspace, scope, principal: actor, command, pool: database, ...(checkAuthorization ? { checkAuthorization } : {}), captureAudit: entries => { audit.push(...entries); }, captureFacts: entries => { facts.push(...entries); } }, command.commandId);
        await recordExternalReceipt(database, actor, workspaceId, command, receipt, [], audit, facts);
        return receipt;
      },
      readCommandReceipt(actor, workspaceId, command) { return readExternalReceipt(database, actor, workspaceId, command.commandId, requestHash(command as unknown as Record<string, unknown>)); },
      async readComments(actor, workspaceId, taskId, readOptions) {
        return readTaskComments({ sql: database, actor, workspaceId, membership: await getMembership(database, actor, workspaceId), now: new Date(), core: await coreFor(actor) }, taskId, readOptions);
      },
    };
    const tools = createAgentChatTools(options);
    function context(actor: Actor = owner, projects = [first.id], kind: 'workspace' | 'projects' = 'projects'): AgentChatToolContext {
      return { actor, workspaceId: ws.id, threadId: randomUUID(), messageId: randomUUID(), toolCallId: randomUUID(), operationId: randomUUID(), grantId: randomUUID(), scope: { kind, projectIds: projects } };
    }
    return { close, database, workspace, ws, owner, limited, first, second, task, peer, hidden, document, tools, options, context };
  } catch (error) { await close(); throw error; }
}

const taskInput = (projectId: string) => ({ projectId, title: 'Created through native tool', description: 'Real Markdown', assigneeId: null, priority: 'high', startDate: null, dueDate: null, labels: ['agent'] });
const taskEdit = (id: string, revision: string) => ({ id, revision, title: 'Ordinary title edit', description: null, assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null });
const denied = (error: unknown) => error instanceof DomainError && error.code === 'not_found_or_forbidden';

describe('Agent tools use native PM services and real PostgreSQL authority', { skip: !databaseUrl, timeout: 600000 }, () => {
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
    assert.notEqual(recovered?.sources[0]?.revision, original.revision);
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
