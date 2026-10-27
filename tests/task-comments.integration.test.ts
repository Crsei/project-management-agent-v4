import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { TaskCommentHistoryPage, TaskCommentsPage } from '../packages/domain/src/task-comments.ts';
import type { FileRecord } from '../packages/pm-schema/index.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';

type CommentResult = { id: string; taskId: string; projectId: string; version: number; action: string };
function commentCommand(task: Entity, commandType: string, payload: Record<string, unknown>, previous?: CommentResult): Command {
  return { commandId: randomUUID(), commandType, targetId: task.id, projectId: task.projectId!, payload, ...(previous ? { expectedVersions: { [previous.id]: previous.version } } : {}) };
}
describe('task comments: current core scope, author CAS, immutable history and real command recovery', { skip: !dashboardDatabaseUrl, timeout: 180_000 }, () => {
  let fixture: DashboardFixture;
  before(async () => { fixture = await createDashboardFixture(); });
  after(async () => { await fixture?.close(); });
  const prefix = () => `/api/v1/workspaces/${fixture.workspaceId}`;
  async function setup() {
    const project = await fixture.command('CreateProject', { name: 'Comment history', goal: 'Real Markdown', ownerId: fixture.owner.id, completionCriteria: [] });
    const task = await fixture.command('CreateWorkItem', { title: 'Real comment target', description: 'Unchanged Markdown body', acceptanceCriteria: [] }, { extra: { projectId: project.id } });
    return { project, task };
  }
  async function list(task: Entity, cookie?: string, query = '') {
    const response = await fixture.request<TaskCommentsPage>(`${prefix()}/tasks/${task.id}/comments?projectId=${task.projectId}${query}`, cookie ? { cookie } : {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async function send(task: Entity, type: string, payload: Record<string, unknown>, previous?: CommentResult, cookie?: string) {
    const response = await fixture.send(commentCommand(task, type, payload, previous), cookie ? { cookie } : {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.result as CommentResult;
  }
  it('persists published Markdown across fresh reads, replays exactly once and leaves core source/state/revision unchanged', async () => {
    const { task } = await setup();
    const before = await fixture.request<FileRecord>(`${prefix()}/core/files/${task.id}`);
    const command = commentCommand(task, 'CreateTaskComment', { content: '**真实评论**\n\n<script>bad()</script>\n\n[x](javascript:alert(1))' });
    const first = await fixture.send(command);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual((await fixture.send(command)).body, first.body);
    assert.equal((await fixture.send({ ...command, payload: { content: 'different' } })).body.error?.code, 'idempotency_conflict');
    const receipt = await fixture.request(`${prefix()}/commands/${command.commandId}`);
    assert.equal(receipt.status, 200);
    assert.deepEqual(receipt.body, first.body);
    assert.equal(JSON.stringify(receipt.body).includes('<script>'), false);
    assert.equal((await list(task)).items[0]!.content, command.payload.content);
    assert.deepEqual(await list(task), await list(task));
    const current = await fixture.request<FileRecord>(`${prefix()}/core/files/${task.id}`);
    assert.equal(current.body.raw, before.body.raw);
    assert.equal(current.body.revision, before.body.revision);
    const facts = await fixture.pool.query<{ count: number; snapshots: number; events: number }>(`SELECT (SELECT count(*)::int FROM task_comments WHERE task_id=$1) AS count,
      (SELECT count(*)::int FROM task_comment_revisions WHERE command_id=$2) AS snapshots,(SELECT count(*)::int FROM outbox WHERE command_id=$2) AS events`, [task.id, command.commandId]);
    assert.deepEqual(facts.rows[0], { count: 1, snapshots: 1, events: 1 });
    const audit = await fixture.pool.query('SELECT changes FROM project_audit WHERE command_id=$1', [command.commandId]);
    assert.deepEqual(audit.rows.map(row => row.changes), [[]]);
  });
  it('serializes competing author edits and records no body/history/event for rejected stale or missing CAS', async () => {
    const { task } = await setup();
    const original = await send(task, 'CreateTaskComment', { content: 'Original' });
    const candidates = await Promise.all(['First edit', 'Second edit'].map(content => fixture.send(commentCommand(task, 'UpdateTaskComment', { commentId: original.id, content }, original))));
    assert.deepEqual(candidates.map(value => value.status).sort(), [200, 409]);
    assert.equal(candidates.find(value => value.status === 409)!.body.error?.code, 'version_conflict');
    const missing = await fixture.send(commentCommand(task, 'UpdateTaskComment', { commentId: original.id, content: 'No expected version' }));
    assert.equal(missing.body.error?.code, 'version_conflict');
    const row = (await list(task)).items[0]!;
    assert.equal(row.version, 2);
    assert.ok(['First edit', 'Second edit'].includes(row.content!));
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM task_comment_revisions WHERE comment_id=$1', [original.id])).rows[0].count, 2);
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM outbox WHERE aggregate_id=$1', [original.id])).rows[0].count, 2);
  });
  it('keeps a deleted tombstone, immutable version snapshots and a CAS author-only restoration', async () => {
    const { task } = await setup();
    const original = await send(task, 'CreateTaskComment', { content: 'Retained original' });
    const edited = await send(task, 'UpdateTaskComment', { commentId: original.id, content: 'Corrected content' }, original);
    const deleted = await send(task, 'DeleteTaskComment', { commentId: original.id }, edited);
    const tombstone = (await list(task)).items[0]!;
    assert.equal(tombstone.id, original.id); assert.equal(tombstone.content, null); assert.ok(tombstone.deletedAt);
    const history = await fixture.request<TaskCommentHistoryPage>(`${prefix()}/tasks/${task.id}/comments/${original.id}/history?projectId=${task.projectId}&limit=2`);
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.deepEqual(history.body.items.map(row => [row.action, row.content]), [['created', 'Retained original'], ['edited', 'Corrected content']]);
    assert.equal(history.body.nextCursor, 2);
    const next = await fixture.request<TaskCommentHistoryPage>(`${prefix()}/tasks/${task.id}/comments/${original.id}/history?projectId=${task.projectId}&after=2`);
    assert.deepEqual(next.body.items.map(row => [row.action, row.content]), [['deleted', 'Corrected content']]);
    assert.equal((await fixture.send(commentCommand(task, 'RestoreTaskComment', { commentId: original.id }, edited))).body.error?.code, 'version_conflict');
    const restored = await send(task, 'RestoreTaskComment', { commentId: original.id }, deleted);
    assert.equal(restored.version, 4);
    assert.equal((await list(task)).items[0]!.content, 'Corrected content');
    await assert.rejects(fixture.pool.query('DELETE FROM task_comments WHERE id=$1', [original.id]), /cannot be erased/);
    await assert.rejects(fixture.pool.query("UPDATE task_comment_revisions SET content='rewritten' WHERE comment_id=$1", [original.id]), /cannot be erased/);
  });
  it('rechecks current project and revoked capability on list, history, command and receipt without granting moderation', async () => {
    const { task, project } = await setup();
    const other = await setup();
    const author = await fixture.member('Comment author');
    const membership = await fixture.command<{ version: number }>('SetWorkspaceMember', { userId: author.user.id, capabilities: ['domain.read', 'intent.propose'], projectIds: [project.id] });
    const command = commentCommand(task, 'CreateTaskComment', { content: 'Author message' });
    const created = await fixture.send(command, { cookie: author.cookie });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const comment = created.body.result as CommentResult;
    assert.equal((await list(task, author.cookie)).items[0]!.authorId, author.user.id);
    const ownerEdit = await fixture.send(commentCommand(task, 'UpdateTaskComment', { commentId: comment.id, content: 'Admin cannot impersonate author' }, comment));
    assert.equal(ownerEdit.status, 403);
    const cross = await fixture.send(commentCommand(other.task, 'UpdateTaskComment', { commentId: comment.id, content: 'Cross-project body' }, comment));
    assert.equal(cross.status, 404);
    assert.equal((await fixture.request(`${prefix()}/tasks/${other.task.id}/comments?projectId=${other.project.id}`, { cookie: author.cookie })).status, 404);
    const wrongProject = await fixture.request(`${prefix()}/tasks/${task.id}/comments?projectId=${other.project.id}`);
    assert.equal(wrongProject.status, 404);
    const readOnly = await fixture.command<{ version: number }>('SetWorkspaceMember', { userId: author.user.id, capabilities: ['domain.read'], projectIds: [project.id] }, { extra: { expectedVersions: { [author.user.id]: membership.version } } });
    assert.equal((await fixture.send(commentCommand(task, 'DeleteTaskComment', { commentId: comment.id }, comment), { cookie: author.cookie })).status, 403);
    await fixture.command('RevokeWorkspaceMember', { userId: author.user.id }, { extra: { expectedVersions: { [author.user.id]: readOnly.version } } });
    for (const path of [`/tasks/${task.id}/comments?projectId=${project.id}`, `/tasks/${task.id}/comments/${comment.id}/history?projectId=${project.id}`, `/commands/${command.commandId}`]) assert.equal((await fixture.request(`${prefix()}${path}`, { cookie: author.cookie })).status, 404);
    assert.equal((await fixture.send(command, { cookie: author.cookie })).status, 404);
  });
  it('paginates complete tombstone-inclusive lists and rejects moving history into another project audience', async () => {
    const { task } = await setup();
    const other = await setup();
    for (let index = 0; index < 3; index += 1) await send(task, 'CreateTaskComment', { content: `Page ${index}` });
    const first = await list(task, undefined, '&limit=2');
    assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
    const last = await list(task, undefined, `&limit=2&after=${first.nextCursor}`);
    assert.equal(last.items.length, 1); assert.equal(last.nextCursor, null);
    assert.equal(new Set([...first.items, ...last.items].map(row => row.id)).size, 3);
    const file = await fixture.request<FileRecord>(`${prefix()}/core/files/${task.id}`);
    const moved = await fixture.request(`${prefix()}/core/entities/${task.id}`, { method: 'PATCH', body: { revision: file.body.revision, changes: { project: other.project.id } } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const read = await fixture.request<{ error: { code: string } }>(`${prefix()}/tasks/${task.id}/comments?projectId=${other.project.id}`);
    assert.equal(read.status, 409); assert.equal(read.body.error.code, 'task_comment_project_changed');
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM task_comments WHERE task_id=$1', [task.id])).rows[0].count, 3);
  });
});
