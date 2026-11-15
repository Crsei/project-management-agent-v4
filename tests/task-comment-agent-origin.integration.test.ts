import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, describe, it } from 'node:test';
import type { Entity } from '../packages/domain/src/core.ts';
import type { FileRecord } from '../packages/pm-schema/index.ts';
import type { TaskCommentsPage, TaskCommentHistoryPage } from '../packages/domain/src/task-comments.ts';
import type { PmToolRequest, PmToolCallRecord } from '../packages/agent-contracts/src/pm-tools.ts';
import { createPmToolLinkageBearer, pmToolRequestHash } from '../packages/infrastructure/src/pm-tool-service-auth.ts';
import { createDashboardFixture, type DashboardFixture } from './dashboard-fixture.ts';

// This suite requires the explicit isolated test DB, never the production DATABASE_URL fallback.
describe('Agent discussion provenance uses native PM comments and original receipts', { skip: !process.env.TEST_DATABASE_URL, timeout: 240_000 }, () => {
  let fixture: DashboardFixture;
  const oldSecret = process.env.PM_AUTOMATION_SERVICE_SECRET;
  before(async () => {
    process.env.PM_AUTOMATION_SERVICE_SECRET = 'isolated-comment-origin-service-proof-secret'.repeat(3);
    fixture = await createDashboardFixture();
  });
  after(async () => {
    await fixture?.close();
    if (oldSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET;
    else process.env.PM_AUTOMATION_SERVICE_SECRET = oldSecret;
  });
  async function setup() {
    const project = await fixture.command('CreateProject', { name: 'Trusted discussion', goal: 'Native PM only', ownerId: fixture.owner.id, completionCriteria: [] });
    const task = await fixture.command('CreateWorkItem', { title: 'Discussion target', description: '## Acceptance\n\n- [ ] Preserve task state and source', acceptanceCriteria: [] }, { extra: { projectId: project.id } });
    const file = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${task.id}`);
    assert.equal(file.status, 200);
    return { task, project, file: file.body };
  }
  function operation(task: Entity, revision: string, content = 'Concise verified stage; private transcript is not copied.'): PmToolRequest {
    const operationId = randomUUID();
    return { operationId, name: 'pm_create_comment', target: { workspaceId: fixture.workspaceId, projectId: task.projectId! },
      arguments: { projectId: task.projectId, taskId: task.id, content }, threadId: randomUUID(), messageId: randomUUID(), generationId: randomUUID(),
      linkage: { traceId: randomUUID(), invocationId: operationId, executionRoot: 'generation', clientKind: 'chat', policy: 'full', enforcement: 'audit-only',
        collaboration: { runId: 'run-readable-id', agentId: 'reviewer-readable-id', agentVersion: 3, delegationId: 'delegation-readable-id',
          target: { workspaceId: fixture.workspaceId, projectId: task.projectId!, taskId: task.id, taskRevision: revision } } } };
  }
  async function call(input: PmToolRequest, options: { signed?: boolean; actorId?: string; cookie?: string; reconcile?: boolean } = {}) {
    const actorId = options.actorId ?? fixture.owner.id;
    return fixture.request<PmToolCallRecord>(`/api/v1/workspaces/${fixture.workspaceId}/agent-tools/${options.reconcile ? 'result' : 'call'}`, {
      method: 'POST', body: input, ...(options.cookie ? { cookie: options.cookie } : {}),
      headers: options.signed ? { 'x-pm-tool-linkage': createPmToolLinkageBearer(actorId, pmToolRequestHash(input, actorId), input.linkage!) } : {},
    });
  }
  async function discussion(task: Entity, options: { query?: string; cookie?: string } = {}) {
    return fixture.request<TaskCommentsPage>(`/api/v1/workspaces/${fixture.workspaceId}/tasks/${task.id}/comments?projectId=${task.projectId}${options.query ?? ''}`, options.cookie ? { cookie: options.cookie } : {});
  }

  it('ignores browser/model-origin claims, preserves the real human author, and never accepts sourceAgentId in native payloads', async () => {
    const { task, file } = await setup();
    const unsigned = operation(task, file.revision, 'Unsigned correlation hint');
    assert.equal((await call(unsigned)).body.status, 'succeeded');
    const rows = await discussion(task);
    assert.equal(rows.body.items[0]!.authorId, fixture.owner.id);
    assert.equal(rows.body.items[0]!.origin, null);
    const forged = await fixture.send({ commandId: randomUUID(), commandType: 'CreateTaskComment', projectId: task.projectId!, targetId: task.id,
      payload: { content: 'Cannot impersonate', sourceAgentId: 'reviewer-readable-id', origin: unsigned.linkage!.collaboration } });
    assert.equal(forged.status, 400);
    assert.equal((await discussion(task)).body.items.length, 1);
  });

  it('does not trust a service proof after its Agent identity or original operation body is modified', async () => {
    const { task, file } = await setup(), input = operation(task, file.revision);
    const proof = createPmToolLinkageBearer(fixture.owner.id, pmToolRequestHash(input, fixture.owner.id), input.linkage!);
    const tampered: PmToolRequest = { ...input, linkage: { ...input.linkage!, collaboration: { ...input.linkage!.collaboration!, agentId: 'spoofed-agent' } } };
    const response = await fixture.request<PmToolCallRecord>(`/api/v1/workspaces/${fixture.workspaceId}/agent-tools/call`, {
      method: 'POST', body: tampered, headers: { 'x-pm-tool-linkage': proof },
    });
    assert.equal(response.body.status, 'succeeded');
    const comment = (await discussion(task)).body.items[0]!;
    assert.equal(comment.authorId, fixture.owner.id); assert.equal(comment.origin, null);
  });

  it('binds structured origin to signed original operation, shares the same Issue page and recovers lost responses without duplicate posts', async () => {
    const { task, file } = await setup(), input = operation(task, file.revision);
    const created = await call(input, { signed: true });
    assert.equal(created.status, 200, JSON.stringify(created.body)); assert.equal(created.body.status, 'succeeded');
    assert.equal(created.body.result?.kind, 'comment');
    const page = await discussion(task), comment = page.body.items[0]!;
    assert.equal(page.status, 200); assert.equal(page.body.items.length, 1);
    assert.equal(comment.authorId, fixture.owner.id);
    assert.deepEqual(comment.origin, { ...input.linkage!.collaboration, operationId: input.operationId, threadId: input.threadId, generationId: input.generationId });
    assert.equal(created.body.result?.receipt?.commandId, input.operationId);
    assert.deepEqual(created.body.result?.kind === 'comment' ? created.body.result.items[0]!.origin : null, comment.origin);
    await fixture.pool.query("UPDATE pm_agent_tool_operations SET status='unknown',result=NULL,finished_at=NULL WHERE operation_id=$1", [input.operationId]);
    const recovered = await call(input, { signed: true, reconcile: true });
    assert.equal(recovered.body.status, 'succeeded'); assert.equal(recovered.body.result?.receipt?.commandId, input.operationId);
    assert.deepEqual(recovered.body.result?.kind === 'comment' ? recovered.body.result.items[0]!.origin : null, comment.origin);
    assert.equal((await call(input, { signed: true })).body.status, 'succeeded');
    assert.equal((await discussion(task)).body.items.length, 1);
    const changed = await call({ ...input, arguments: { projectId: task.projectId, taskId: task.id, content: 'Changed same key' } }, { signed: true });
    assert.equal(changed.status, 409);
    const current = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${task.id}`);
    assert.equal(current.body.revision, file.revision); assert.equal(current.body.raw, file.raw);
  });

  it('retains the creation origin and records a different trusted producer for an Agent-authored edit', async () => {
    const { task, file } = await setup(), created = operation(task, file.revision);
    assert.equal((await call(created, { signed: true })).body.status, 'succeeded');
    const original = (await discussion(task)).body.items[0]!;
    const edited = operation(task, file.revision);
    edited.name = 'pm_edit_comment';
    edited.arguments = { projectId: task.projectId, taskId: task.id, commentId: original.id, version: original.version, content: 'Concise corrected result' };
    edited.linkage!.collaboration!.runId = 'second-actual-run';
    const result = await call(edited, { signed: true });
    assert.equal(result.body.status, 'succeeded', JSON.stringify(result.body));
    const current = (await discussion(task)).body.items[0]!;
    assert.equal(current.version, 2); assert.equal(current.content, 'Concise corrected result');
    assert.deepEqual(current.origin, original.origin);
    const history = await fixture.request<TaskCommentHistoryPage>(`/api/v1/workspaces/${fixture.workspaceId}/tasks/${task.id}/comments/${current.id}/history?projectId=${task.projectId}`);
    assert.equal(history.body.items[1]!.origin?.runId, 'second-actual-run');
    assert.equal(history.body.items[1]!.origin?.operationId, edited.operationId);
    const historyRead = operation(task, file.revision);
    historyRead.name = 'pm_read_comment_history';
    historyRead.arguments = { projectId: task.projectId, taskId: task.id, commentId: original.id, after: null, limit: 10 };
    const projected = await call(historyRead, { signed: true });
    assert.equal(projected.body.status, 'succeeded', 'The independent Agent wire contract must accept structured revision origins');
  });

  it('keeps original Agent origin immutable while author CAS and human edit history retain separate producer facts', async () => {
    const { task, file } = await setup(), input = operation(task, file.revision);
    await call(input, { signed: true });
    const original = (await discussion(task)).body.items[0]!;
    const candidates = await Promise.all(['Author edit A', 'Author edit B'].map(content => fixture.send({ commandId: randomUUID(), commandType: 'UpdateTaskComment', projectId: task.projectId!, targetId: task.id,
      expectedVersions: { [original.id]: original.version }, payload: { commentId: original.id, content } })));
    assert.deepEqual(candidates.map(candidate => candidate.status).sort(), [200, 409]);
    const current = (await discussion(task)).body.items[0]!;
    assert.deepEqual(current.origin, original.origin); assert.equal(current.authorId, fixture.owner.id);
    const history = await fixture.request<TaskCommentHistoryPage>(`/api/v1/workspaces/${fixture.workspaceId}/tasks/${task.id}/comments/${current.id}/history?projectId=${task.projectId}`);
    assert.deepEqual(history.body.items[0]!.origin, original.origin); assert.equal(history.body.items[1]!.origin, null);
    await assert.rejects(fixture.pool.query('UPDATE task_comments SET agent_origin=NULL,version=version+1 WHERE id=$1', [original.id]), /immutable/);
    await assert.rejects(fixture.pool.query('UPDATE task_comment_revisions SET agent_origin=NULL WHERE comment_id=$1', [original.id]), /cannot be erased/);
  });

  it('rechecks author rights and revocation on discussion, history and original operation delivery', async () => {
    const { task, project, file } = await setup(), author = await fixture.member('Run initiator');
    const membership = await fixture.command<{ version: number }>('SetWorkspaceMember', { userId: author.user.id, capabilities: ['domain.read', 'intent.propose'], projectIds: [project.id] });
    const input = operation(task, file.revision);
    assert.equal((await call(input, { signed: true, actorId: author.user.id, cookie: author.cookie })).body.status, 'succeeded');
    const original = (await discussion(task)).body.items[0]!;
    assert.equal(original.authorId, author.user.id);
    const ownerEdit = await fixture.send({ commandId: randomUUID(), commandType: 'UpdateTaskComment', projectId: project.id, targetId: task.id, expectedVersions: { [original.id]: 1 }, payload: { commentId: original.id, content: 'Owner is not the author' } });
    assert.equal(ownerEdit.status, 403);
    await fixture.command('RevokeWorkspaceMember', { userId: author.user.id }, { extra: { expectedVersions: { [author.user.id]: membership.version } } });
    assert.equal((await discussion(task, { cookie: author.cookie })).status, 404);
    assert.equal((await call(input, { signed: true, actorId: author.user.id, cookie: author.cookie, reconcile: true })).status, 404);
    const history = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/tasks/${task.id}/comments/${original.id}/history?projectId=${project.id}`, { cookie: author.cookie });
    assert.equal(history.status, 404);
    assert.equal((await discussion(task)).body.items.length, 1);
  });

  it('rejects changed brief/cross-target signed origins before a comment is committed and keeps current pagination authoritative', async () => {
    const { task, file } = await setup(), wrongVersion = operation(task, '0'.repeat(64));
    const stale = await call(wrongVersion, { signed: true });
    assert.equal(stale.body.status, 'failed');
    const wrongTarget = operation(task, file.revision); wrongTarget.linkage!.collaboration!.target.taskId = 'TASK-999999';
    assert.equal((await call(wrongTarget, { signed: true })).body.status, 'failed');
    assert.equal((await discussion(task)).body.items.length, 0);
    for (let index = 0; index < 3; index++) await call(operation(task, file.revision, `Public stage ${index}`), { signed: true });
    const first = await discussion(task, { query: '&limit=2' });
    assert.equal(first.body.items.length, 2); assert.ok(first.body.nextCursor);
    const last = await discussion(task, { query: `&limit=2&after=${first.body.nextCursor}` });
    assert.equal(last.body.items.length, 1); assert.equal(last.body.nextCursor, null);
    assert.equal(new Set([...first.body.items, ...last.body.items].map(comment => comment.id)).size, 3);
    assert.equal((await call({ ...operation(task, file.revision), operationId: randomUUID() }, { signed: true, reconcile: true })).status, 404);
    assert.equal((await discussion(task)).body.items.length, 3, 'A missing original receipt must never create a replacement comment');
  });
});
