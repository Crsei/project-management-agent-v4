import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { DomainError, type Capability } from '../../../../packages/domain/src/core.ts';
import { Workspace, WorkspaceError } from '../../../../packages/pm-core/index.ts';
import type { AgentChatToolResult } from '../../../../packages/agent-contracts/src/pm-tool-result.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import { nativeCommandId } from '../src/core-routes.ts';
import { CoreCommandJournal } from '../src/core-journal.ts';
import { createAgentChatTools, type AgentChatToolContext, type AgentChatTools } from '../src/agent-chat-tools.ts';

const workspaceId = '0196c319-8b1d-7000-8000-000000000001';
const actor = { id: '0196c319-8b1d-7000-8000-000000000010', email: 'fixture@example.invalid', name: 'Fixture' };
type Member = { user_id: string; workspace_id: string; capabilities: Capability[]; project_ids: string[] | null; version: number; revoked_at: null };

/** Only the SQL owned by workspace authorization, audit and service facts is simulated; the Markdown core is real. */
function fakeDatabase(member: () => Member): Pool {
  const query = async (text: string) => {
    if (/SELECT m\.\* FROM memberships/.test(text)) return { rows: [member()], rowCount: 1 };
    if (/UPDATE workspaces SET service_fact_head/.test(text)) return { rows: [{ sequence: '1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
}

function lifecycleResult(result: AgentChatToolResult): Extract<AgentChatToolResult, { kind: 'lifecycle' }> {
  assert.equal(result.kind, 'lifecycle');
  return result as Extract<AgentChatToolResult, { kind: 'lifecycle' }>;
}

const ALL_CAPABILITIES: Capability[] = ['domain.read', 'planning.edit', 'planning.lifecycle', 'workitem.complete', 'workitem.cancel_reopen'];

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-agent-lifecycle-'));
  const workspace = new Workspace(path.join(base, 'workspace'));
  await workspace.init();
  let capabilities: Capability[] = [...ALL_CAPABILITIES];
  let membershipProjects: string[] | null = null;
  const database = fakeDatabase(() => ({ user_id: actor.id, workspace_id: workspaceId, capabilities, project_ids: membershipProjects, version: 1, revoked_at: null }));
  const tools = createAgentChatTools({
    database: () => database,
    coreWorkspaces: { get: async () => { await workspace.rescan(); return workspace; }, rootFor: () => workspace.root } as never,
    executeCommand: async () => { throw new Error('The lifecycle tools never use command receipts'); },
    readCommandReceipt: async () => null,
    readComments: async () => { throw new Error('The lifecycle tools never read comments'); },
    localProjects: { enabled: false, defaultParent: null },
  });
  const project = await workspace.createEntity({ entity: 'project', title: 'Fixture' }, 'fixture');
  const other = await workspace.createEntity({ entity: 'project', title: 'Other' }, 'other');
  const task = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Lifecycle task' }, 'lifecycle-task');
  membershipProjects = [project.id];
  const context = (operationId = randomUUID(), scopeProjects: string[] = [project.id]): AgentChatToolContext => ({
    actor, workspaceId, threadId: 'thread-1', messageId: 'message-1', operationId, scope: { kind: 'projects', projectIds: [...scopeProjects] },
  });
  return { base, workspace, tools, project, other, task, context,
    allow: (caps: Capability[], projects: string[] | null = [project.id]) => { capabilities = caps; membershipProjects = projects; } };
}

test('archive, restore and delete use the native core and preserve the work item identity', async () => {
  const f = await fixture();
  try {
    const archived = lifecycleResult(await f.tools.execute('pm_archive_task', { id: f.task.id, revision: f.task.revision }, f.context()));
    assert.equal(archived.items.length, 1);
    assert.equal(archived.items[0]!.id, f.task.id);
    assert.equal(archived.items[0]!.entity, 'work_item');
    assert.deepEqual({ action: archived.receipt?.action, revision: archived.receipt?.revision, target: archived.receipt?.targetId },
      { action: 'ArchiveCoreEntity', revision: f.workspace.get(f.task.id).revision, target: f.task.id });
    assert.equal(f.workspace.get(f.task.id).entity.archived, true);

    const current = f.workspace.get(f.task.id);
    const restored = lifecycleResult(await f.tools.execute('pm_restore_task', { id: current.id, revision: current.revision }, f.context()));
    assert.equal(restored.receipt?.action, 'RestoreCoreEntity');
    assert.equal(f.workspace.get(f.task.id).entity.archived, false);

    const unarchived = f.workspace.get(f.task.id);
    await assert.rejects(f.tools.execute('pm_delete_task', { id: unarchived.id, revision: unarchived.revision }, f.context()),
      (error: unknown) => error instanceof DomainError && error.code === 'DELETE_REQUIRES_ARCHIVE');

    const archivable = f.workspace.get(f.task.id);
    await f.tools.execute('pm_archive_task', { id: archivable.id, revision: archivable.revision }, f.context());
    const deletable = f.workspace.get(f.task.id);
    const deleted = lifecycleResult(await f.tools.execute('pm_delete_task', { id: deletable.id, revision: deletable.revision }, f.context()));
    assert.deepEqual(deleted.items, []);
    assert.deepEqual(deleted.sources, []);
    assert.equal(deleted.receipt?.action, 'DeleteCoreEntity');
    assert.equal(deleted.receipt?.targetId, f.task.id);
    assert.equal(deleted.receipt?.revision, null);
    assert.throws(() => f.workspace.get(f.task.id), (error: unknown) => error instanceof WorkspaceError && error.status === 404);
  } finally { await f.workspace.close(); await rm(f.base, { recursive: true, force: true }); }
});

test('workflow transitions defer to the native transition table and the target lifecycle capability', async () => {
  const f = await fixture();
  try {
    const done = lifecycleResult(await f.tools.execute('pm_transition_task', { id: f.task.id, revision: f.task.revision, status: 'done' }, f.context()));
    assert.equal(done.items[0]!.status, 'done');
    assert.deepEqual({ action: done.receipt?.action, revision: done.receipt?.revision },
      { action: 'UpdateCoreProperties', revision: f.workspace.get(f.task.id).revision });

    const reopened = f.workspace.get(f.task.id);
    const todo = lifecycleResult(await f.tools.execute('pm_transition_task', { id: reopened.id, revision: reopened.revision, status: 'todo' }, f.context()));
    assert.equal(todo.items[0]!.status, 'todo');

    const canceled = f.workspace.get(f.task.id);
    const completed = lifecycleResult(await f.tools.execute('pm_transition_task', { id: canceled.id, revision: canceled.revision, status: 'canceled' }, f.context()));
    assert.equal(completed.items[0]!.status, 'canceled');

    // A configured state is required; the native core rejects an unknown target without touching the file.
    const current = f.workspace.get(f.task.id);
    await assert.rejects(f.tools.execute('pm_transition_task', { id: current.id, revision: current.revision, status: 'imaginary' }, f.context()),
      (error: unknown) => error instanceof WorkspaceError && error.status === 422);
    assert.equal(f.workspace.get(f.task.id).revision, current.revision);
  } finally { await f.workspace.close(); await rm(f.base, { recursive: true, force: true }); }
});

test('stale revisions, capability and cross-project denials never mutate the source', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.tools.execute('pm_archive_task', { id: f.task.id, revision: 'a'.repeat(64) }, f.context()),
      (error: unknown) => error instanceof WorkspaceError && error.status === 409);
    await assert.rejects(f.tools.execute('pm_transition_task', { id: f.task.id, revision: 'b'.repeat(64), status: 'done' }, f.context()),
      (error: unknown) => error instanceof WorkspaceError && error.status === 409);
    assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);

    f.allow(['domain.read', 'planning.edit', 'workitem.cancel_reopen']);
    await assert.rejects(f.tools.execute('pm_archive_task', { id: f.task.id, revision: f.task.revision }, f.context()),
      (error: unknown) => error instanceof DomainError && error.code === 'permission_denied');
    await assert.rejects(f.tools.execute('pm_transition_task', { id: f.task.id, revision: f.task.revision, status: 'done' }, f.context()),
      (error: unknown) => error instanceof DomainError && error.code === 'permission_denied');

    f.allow(['domain.read', 'planning.edit', 'planning.lifecycle', 'workitem.complete']);
    const done = f.workspace.get(f.task.id);
    await f.tools.execute('pm_transition_task', { id: done.id, revision: done.revision, status: 'done' }, f.context());
    const reopened = f.workspace.get(f.task.id);
    await assert.rejects(f.tools.execute('pm_transition_task', { id: reopened.id, revision: reopened.revision, status: 'todo' }, f.context()),
      (error: unknown) => error instanceof DomainError && error.code === 'permission_denied');
    assert.equal(f.workspace.get(f.task.id).entity.status, 'done');

    f.allow([...ALL_CAPABILITIES], null);
    const foreign = f.workspace.get(f.task.id);
    await assert.rejects(f.tools.execute('pm_restore_task', { id: foreign.id, revision: foreign.revision }, f.context(undefined, [f.other.id])),
      (error: unknown) => error instanceof DomainError && error.code === 'not_found_or_forbidden');
    assert.equal(f.workspace.get(f.task.id).revision, foreign.revision);
  } finally { await f.workspace.close(); await rm(f.base, { recursive: true, force: true }); }
});

test('recovery reports only proven outcomes and never replays a pending or changed write', async () => {
  const f = await fixture();
  try {
    f.allow([...ALL_CAPABILITIES], null);
    const journal = new CoreCommandJournal(f.workspace.root);
    const pendingOperation = randomUUID();
    const pendingInput = { revision: f.task.revision };
    const pendingCommandId = nativeCommandId(workspaceId, actor.id, 'ArchiveCoreEntity', f.task.id, pendingOperation);
    journal.pendingHttp(pendingCommandId, requestHash({ action: 'ArchiveCoreEntity', targetId: f.task.id, input: pendingInput }), actor.id);

    const pendingContext = f.context(pendingOperation);
    assert.equal(await f.tools.recover('pm_archive_task', { id: f.task.id, revision: f.task.revision }, pendingContext), null);
    assert.equal(f.workspace.get(f.task.id).entity.archived, false);
    await assert.rejects(f.tools.execute('pm_archive_task', { id: f.task.id, revision: f.task.revision }, f.context(pendingOperation)),
      (error: unknown) => error instanceof DomainError && error.code === 'core_write_outcome_unknown');
    assert.equal(f.workspace.get(f.task.id).entity.archived, false);

    const archiveOperation = randomUUID();
    const archived = lifecycleResult(await f.tools.execute('pm_archive_task', { id: f.task.id, revision: f.task.revision }, f.context(archiveOperation)));
    assert.equal(archived.items[0]!.id, f.task.id);
    const archivedRevision = f.workspace.get(f.task.id).revision;
    const recovered = lifecycleResult((await f.tools.recover('pm_archive_task', { id: f.task.id, revision: f.task.revision }, f.context(archiveOperation)))!);
    assert.equal(recovered.items[0]!.id, f.task.id);
    assert.equal(recovered.items[0]!.revision, archivedRevision);
    assert.equal(f.workspace.get(f.task.id).revision, archivedRevision);
    assert.equal(f.workspace.get(f.task.id).entity.archived, true);

    // A later change means the original receipt can no longer prove the current contents.
    const current = f.workspace.get(f.task.id);
    await f.workspace.patch(current.id, { status: 'in_progress' }, current.revision);
    const changed = lifecycleResult((await f.tools.recover('pm_archive_task', { id: f.task.id, revision: f.task.revision }, f.context(archiveOperation)))!);
    assert.deepEqual(changed.items, []);
    assert.equal(changed.receipt?.revision, archivedRevision);

    // Permanent deletion leaves an unreadable tombstone; recovery must not invent a surviving task.
    const deleteOperation = randomUUID();
    const beforeDelete = f.workspace.get(f.task.id);
    const deleteArgs = { id: beforeDelete.id, revision: beforeDelete.revision };
    await f.tools.execute('pm_delete_task', deleteArgs, f.context(deleteOperation));
    assert.equal(await f.tools.recover('pm_delete_task', deleteArgs, f.context(deleteOperation)), null);
  } finally { await f.workspace.close(); await rm(f.base, { recursive: true, force: true }); }
});

test('the registry advertises the four lifecycle tools as writes with their native capabilities', async () => {
  const f = await fixture();
  try {
    const byName = new Map(f.tools.registry.map(tool => [tool.name, tool]));
    for (const name of ['pm_archive_task', 'pm_restore_task', 'pm_delete_task', 'pm_transition_task'] as const) {
      const tool = byName.get(name);
      assert.ok(tool, name);
      assert.equal(tool.write, true);
      assert.ok(tool.description.length > 0);
      assert.equal(tool.available, true);
      assert.ok(f.tools.availableToolNames.includes(name));
      assert.ok(f.tools.definitions.some(definition => definition.function.name === name));
    }
    assert.deepEqual(byName.get('pm_archive_task')!.capabilities, ['domain.read', 'planning.lifecycle']);
    assert.deepEqual(byName.get('pm_restore_task')!.capabilities, ['domain.read', 'planning.lifecycle']);
    assert.deepEqual(byName.get('pm_delete_task')!.capabilities, ['domain.read', 'planning.lifecycle']);
    assert.deepEqual(byName.get('pm_transition_task')!.capabilities, ['domain.read', 'planning.edit']);
  } finally { await f.workspace.close(); await rm(f.base, { recursive: true, force: true }); }
});
