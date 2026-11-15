import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { Entity } from '../packages/domain/src/core.ts';
import type { FileRecord } from '../packages/pm-schema/index.ts';
import type { PmToolCallRecord, PmToolRequest } from '../packages/agent-contracts/src/pm-tools.ts';
import { CollaborationToolResultSchema } from '../packages/agent-contracts/src/pm-tool-collaboration.ts';
import { readonlyCorePort } from '../packages/pm-core/readonly.ts';
import { routeNotificationBatch } from '../packages/application/src/notification-routing.ts';
import { publishOutboxBatch } from '../packages/application/src/outbox.ts';
import { personalMentionToken } from '../packages/pm-markdown/mentions.ts';
import { watchCollaborationEvents } from '../packages/pm-cli/collaboration.ts';
import { CliRequestError, type CliRuntime, type PmRequestOptions, type PmScope } from '../packages/pm-cli/runtime.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';

function request(f: DashboardFixture, projectId: string | null, name: string, args: unknown): PmToolRequest {
  return { operationId: randomUUID(), name, arguments: args, target: { workspaceId: f.workspaceId, projectId }, threadId: 'collaboration-thread', messageId: randomUUID(), generationId: randomUUID() };
}
async function call(f: DashboardFixture, input: PmToolRequest, cookie = f.ownerCookie, reconcile = false) {
  const response = await f.request<PmToolCallRecord>(`/api/v1/workspaces/${f.workspaceId}/agent-tools/${reconcile ? 'result' : 'call'}`, { method: 'POST', cookie, body: input });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
function collaboration(record: PmToolCallRecord) {
  assert.equal(record.status, 'succeeded', JSON.stringify(record));
  return CollaborationToolResultSchema.parse(record.result);
}
async function setup(f: DashboardFixture) {
  const project = await f.command<Entity>('CreateProject', { name: 'Collaboration resources', goal: '', ownerId: f.owner.id, completionCriteria: [] });
  const task = await f.command<Entity>('CreateWorkItem', { title: 'Authoritative task', description: 'Original captured body', acceptanceCriteria: [] }, { extra: { projectId: project.id } });
  return { project, task };
}
async function file(f: DashboardFixture, id: string): Promise<FileRecord> {
  const response = await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${id}`);
  assert.equal(response.status, 200); return response.body;
}
async function patch(f: DashboardFixture, before: FileRecord, changes: Record<string, unknown>) {
  const response = await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/entities/${before.id}`, { method: 'PATCH', body: { revision: before.revision, changes } });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
async function drainNotifications(f: DashboardFixture) {
  const core = readonlyCorePort(id => join(f.coreRoot, id));
  for (let round = 0; round < 50; round++) if (!(await routeNotificationBatch(f.pool, core, `collaboration-${randomUUID()}`, { jobLimit: 20, candidateLimit: 100 })).jobs) return;
  throw new Error('Isolated notification routing did not settle');
}

describe('CLI collaboration families use original native services and current authority', { skip: !dashboardDatabaseUrl, timeout: 180000 }, () => {
  it('T8 edits, tombstones, restores, paginates immutable author history and recovers only the original receipt', async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const { project, task } = await setup(f), comment = await f.command<{ id: string; version: number }>('CreateTaskComment', { content: 'Original author body' }, { extra: { targetId: task.id, projectId: project.id } });
    const editInput = request(f, project.id, 'pm_edit_comment', { projectId: project.id, taskId: task.id, commentId: comment.id, version: 1, content: 'Corrected body' });
    const edited = collaboration(await call(f, editInput));
    assert.equal(edited.result.type, 'comment_mutation'); assert.equal(edited.receipt?.commandId, editInput.operationId); assert.equal(edited.receipt?.revision, '2');
    const stale = await call(f, request(f, project.id, 'pm_delete_comment', { projectId: project.id, taskId: task.id, commentId: comment.id, version: 1 }));
    assert.equal(stale.status, 'failed');
    const deleted = collaboration(await call(f, request(f, project.id, 'pm_delete_comment', { projectId: project.id, taskId: task.id, commentId: comment.id, version: 2 })));
    assert.equal(deleted.receipt?.revision, '3');
    const tombstones = await f.request<{ items: { authorId: string; content: string | null; deletedAt: string | null }[] }>(`/api/v1/workspaces/${f.workspaceId}/tasks/${task.id}/comments?projectId=${project.id}`);
    assert.equal(tombstones.body.items[0]!.authorId, f.owner.id); assert.equal(tombstones.body.items[0]!.content, null); assert.ok(tombstones.body.items[0]!.deletedAt);
    collaboration(await call(f, request(f, project.id, 'pm_restore_comment', { projectId: project.id, taskId: task.id, commentId: comment.id, version: 3 })));
    const first = collaboration(await call(f, request(f, project.id, 'pm_read_comment_history', { projectId: project.id, taskId: task.id, commentId: comment.id, after: null, limit: 2 })));
    assert.equal(first.result.type, 'comment_history'); if (first.result.type !== 'comment_history') return;
    assert.deepEqual(first.result.page.items.map(item => [item.version, item.action, item.content]), [[1, 'created', 'Original author body'], [2, 'edited', 'Corrected body']]);
    assert.equal(first.nextCursor, '2');
    const next = collaboration(await call(f, request(f, project.id, 'pm_read_comment_history', { projectId: project.id, taskId: task.id, commentId: comment.id, after: 2, limit: 2 })));
    assert.equal(next.result.type, 'comment_history'); if (next.result.type !== 'comment_history') return;
    assert.deepEqual(next.result.page.items.map(item => item.action), ['deleted', 'restored']);
    await f.pool.query("UPDATE pm_agent_tool_operations SET status='unknown',result=NULL,outcome_evidence=NULL WHERE operation_id=$1", [editInput.operationId]);
    const recovered = collaboration(await call(f, editInput, f.ownerCookie, true));
    assert.equal(recovered.receipt?.commandId, editInput.operationId); assert.equal(recovered.receipt?.revision, '2', 'never substitute the current restored version');
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM task_comment_revisions WHERE comment_id=$1', [comment.id])).rows[0].n, 4);
    const other = await f.member('Not the author');
    await f.command('SetWorkspaceMember', { userId: other.user.id, capabilities: ['domain.read', 'intent.propose'], projectIds: [project.id] });
    const forbidden = await call(f, request(f, project.id, 'pm_edit_comment', { projectId: project.id, taskId: task.id, commentId: comment.id, version: 4, content: 'Cannot impersonate author' }), other.cookie);
    assert.equal(forbidden.status, 'failed');
    const missing = await call(f, request(f, project.id, 'pm_read_comment_history', { projectId: project.id, taskId: task.id, commentId: randomUUID(), after: null, limit: 2 }));
    assert.equal(missing.result, null); assert.notEqual(missing.status, 'succeeded');
  });

  it('T9 preserves exact observation heads, independent personal state and source-unlink authorization without read acknowledgement', async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const { project, task } = await setup(f);
    let current = await patch(f, await file(f, task.id), { priority: 'high' });
    const historyInput = request(f, project.id, 'pm_read_change_history', { target: { kind: 'core', entityId: task.id }, includeRelated: true, cursor: null, head: null, limit: 100 });
    const seen = collaboration(await call(f, historyInput)); assert.equal(seen.result.type, 'history'); if (seen.result.type !== 'history') return;
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM change_history_cursors WHERE actor_id=$1', [f.owner.id])).rows[0].n, 0);
    const savedHead = seen.result.page.head;
    current = await patch(f, current, { priority: 'low' });
    const ackInput = request(f, project.id, 'pm_acknowledge_changes', { target: { kind: 'core', entityId: task.id }, through: savedHead, observationToken: seen.result.page.observationToken });
    const ack = collaboration(await call(f, ackInput)); assert.equal(ack.result.type, 'acknowledgement'); if (ack.result.type !== 'acknowledgement') return;
    assert.equal(ack.result.acknowledgement.reviewedThrough, savedHead); assert.equal(ack.result.acknowledgement.pendingCount, 1);
    const state = collaboration(await call(f, request(f, project.id, 'pm_read_review_state', { projectId: project.id, taskIds: [task.id], afterTaskId: null })));
    assert.equal(state.result.type, 'review_state'); if (state.result.type !== 'review_state') return;
    assert.equal(state.result.page.items[0]!.pendingCount, 1);
    const comparison = collaboration(await call(f, request(f, project.id, 'pm_compare_changes', { target: { kind: 'core', entityId: task.id }, fromMode: 'reviewed', fromChangeId: null, toChangeId: null, through: null, offset: 0, limit: 40 })));
    assert.equal(comparison.result.type, 'comparison'); if (comparison.result.type !== 'comparison') return;
    assert.equal(comparison.result.after?.revision, current.revision); assert.ok(comparison.result.after!.nextOffset); assert.ok(comparison.result.after!.raw.length <= 40);
    const another = await f.member('Independent reviewer');
    await f.command('SetWorkspaceMember', { userId: another.user.id, capabilities: ['domain.read'], projectIds: [project.id] });
    const independent = collaboration(await call(f, request(f, project.id, 'pm_read_review_state', { projectId: project.id, taskIds: [task.id], afterTaskId: null }), another.cookie));
    assert.equal(independent.result.type, 'review_state'); if (independent.result.type !== 'review_state') return;
    assert.ok(independent.result.page.items[0]!.pendingCount > 1);
    const document = await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/entities`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { entity: 'document', project: project.id, title: 'Linked source', body: 'Retained source secret', related_to: [task.id] } });
    assert.equal(document.status, 200);
    const linkedInput = request(f, project.id, 'pm_read_change_history', historyInput.arguments);
    const linked = collaboration(await call(f, linkedInput)); assert.equal(linked.result.type, 'history'); if (linked.result.type !== 'history') return;
    assert.ok(linked.result.page.items.some(item => item.relation === 'related_document'));
    const before = (await f.pool.query('SELECT target_key,reviewed_through::text FROM change_history_cursors WHERE actor_id=$1 ORDER BY target_key', [f.owner.id])).rows;
    await patch(f, document.body, { related_to: [] });
    const denied = await f.request(`/api/v1/workspaces/${f.workspaceId}/agent-tools/result`, { method: 'POST', body: linkedInput });
    assert.notEqual(denied.status, 200); assert.equal(JSON.stringify(denied.body).includes('Retained source secret'), false);
    const rejectedAck = await call(f, request(f, project.id, 'pm_acknowledge_changes', { target: { kind: 'core', entityId: task.id }, through: linked.result.page.head, observationToken: linked.result.page.observationToken }));
    assert.equal(rejectedAck.status, 'unknown', 'absence of a durable acknowledgement receipt must not fabricate rejection proof');
    assert.deepEqual((await f.pool.query('SELECT target_key,reviewed_through::text FROM change_history_cursors WHERE actor_id=$1 ORDER BY target_key', [f.owner.id])).rows, before);
    const observationsBefore = (await f.pool.query('SELECT count(*)::int AS n FROM change_history_observations')).rows[0].n;
    await call(f, historyInput, f.ownerCookie, true);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM change_history_observations')).rows[0].n, observationsBefore, 'stored result authorization does not mint observation tokens');
  });

  it('T9 project-delegated history excludes formerly broader actor-visible projects, including before snapshots and counts', async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const first = await setup(f), second = await setup(f);
    let moved = await file(f, second.task.id);
    const native = await f.request<{ items: { changeId: string }[] }>(`/api/v1/workspaces/${f.workspaceId}/change-history/query`, { method: 'POST', body: { target: { kind: 'core', entityId: moved.id } } });
    moved = await patch(f, moved, { project: first.project.id });
    moved = await patch(f, moved, { priority: 'high' });
    const scoped = collaboration(await call(f, request(f, first.project.id, 'pm_read_change_history', { target: { kind: 'core', entityId: moved.id }, includeRelated: true, cursor: null, head: null, limit: 100 })));
    assert.equal(scoped.result.type, 'history'); if (scoped.result.type !== 'history') return;
    assert.equal(scoped.result.page.items.length, 1); assert.equal(scoped.result.page.pendingCount, 1); assert.equal(scoped.result.page.items[0]!.afterRevision, moved.revision);
    const historical = await call(f, request(f, first.project.id, 'pm_read_change_detail', { changeId: native.body.items[0]!.changeId, offset: 0, limit: 12000 }));
    assert.notEqual(historical.status, 'succeeded'); assert.equal(historical.result, null);
  });

  it('T21 personal notification read/archive preserves CAS and recovers an actually lost original response without another write', async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const { project, task } = await setup(f), recipient = await f.member('Actual notification recipient');
    const membership = await f.command<{ version: number }>('SetWorkspaceMember', { userId: recipient.user.id, capabilities: ['domain.read'], projectIds: [project.id] });
    await f.command('CreateTaskComment', { content: personalMentionToken(recipient.user.id, 'Reader') }, { extra: { targetId: task.id, projectId: project.id } });
    await drainNotifications(f);
    const inboxInput = request(f, project.id, 'pm_read_notifications', { origin: 'routed', after: null, through: null });
    const inbox = collaboration(await call(f, inboxInput, recipient.cookie)); assert.equal(inbox.result.type, 'notifications'); if (inbox.result.type !== 'notifications') return;
    const item = inbox.result.page.items[0]!; assert.ok(item); assert.equal(item.state.readAt, null); assert.equal(item.state.archivedAt, null);
    const again = collaboration(await call(f, request(f, project.id, 'pm_read_notifications', { origin: 'routed', after: null, through: inbox.result.page.head }), recipient.cookie));
    assert.equal(again.result.type, 'notifications'); if (again.result.type !== 'notifications') return;
    assert.equal(again.result.page.items[0]!.state.readAt, null, 'opening a notification never acknowledges it');
    const original = request(f, project.id, 'pm_set_notification_read', { eventId: item.event.eventId, projectId: project.id, cursor: item.cursor, version: item.state.version, read: true });
    const lost = await fetch(`${f.origin}/api/v1/workspaces/${f.workspaceId}/agent-tools/call`, { method: 'POST', headers: { cookie: recipient.cookie, 'content-type': 'application/json' }, body: JSON.stringify(original), signal: t.signal });
    assert.equal(lost.status, 200); await lost.body?.cancel();
    await f.pool.query("UPDATE pm_agent_tool_operations SET status='unknown',result=NULL,outcome_evidence=NULL WHERE operation_id=$1", [original.operationId]);
    const recovered = collaboration(await call(f, original, recipient.cookie, true)); assert.equal(recovered.result.type, 'notification_state'); if (recovered.result.type !== 'notification_state') return;
    assert.equal(recovered.receipt?.commandId, original.operationId); assert.ok(recovered.result.state.readAt); assert.equal(recovered.result.state.archivedAt, null);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM command_receipts WHERE command_id=$1', [original.operationId])).rows[0].n, 1);
    const archived = collaboration(await call(f, request(f, project.id, 'pm_set_notification_archived', { eventId: item.event.eventId, projectId: project.id, cursor: item.cursor, version: recovered.result.state.version, archived: true }), recipient.cookie));
    assert.equal(archived.result.type, 'notification_state'); if (archived.result.type !== 'notification_state') return;
    assert.ok(archived.result.state.archivedAt); assert.equal(archived.result.state.readAt, recovered.result.state.readAt);
    const stale = await call(f, request(f, project.id, 'pm_set_notification_read', { eventId: item.event.eventId, projectId: project.id, cursor: item.cursor, version: item.state.version, read: false }), recipient.cookie);
    assert.equal(stale.status, 'failed');
    const auditDenied = await f.request(`/api/v1/workspaces/${f.workspaceId}/agent-tools/call`, { method: 'POST', cookie: recipient.cookie, body: request(f, project.id, 'pm_read_project_audit', { projectId: project.id, cursor: null, limit: 10, commandId: null, operationId: null }) });
    assert.equal(auditDenied.status, 403);
    const audit = collaboration(await call(f, request(f, project.id, 'pm_read_project_audit', { projectId: project.id, cursor: null, limit: 10, commandId: null, operationId: null })));
    assert.equal(audit.result.type, 'audit');
    await f.command('RevokeWorkspaceMember', { userId: recipient.user.id }, { extra: { expectedVersions: { [recipient.user.id]: membership.version } } });
    const removed = await f.request(`/api/v1/workspaces/${f.workspaceId}/agent-tools/result`, { method: 'POST', cookie: recipient.cookie, body: inboxInput });
    assert.equal(removed.status, 404); assert.equal(JSON.stringify(removed.body).includes(item.event.eventId), false);
  });

  it('T21 streams from actual HTTP cursors, resumes without replaying writes, rejects expired positions and rechecks live permissions', async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const { project, task } = await setup(f), recipient = await f.member('Live stream reader');
    const membership = await f.command<{ version: number }>('SetWorkspaceMember', { userId: recipient.user.id, capabilities: ['domain.read'], projectIds: [project.id] });
    await publishOutboxBatch(f.pool, 500);
    const baseline = await f.request<{ cursor: string }>(`/api/v1/workspaces/${f.workspaceId}/changes?after=0`);
    const printed: unknown[] = [], reads: string[] = [];
    let cookie = f.ownerCookie;
    const runtime: CliRuntime = {
      async authentication() { return { origin: f.origin, headers: { cookie } }; },
      async connection() { return { origin: f.origin, workspaceId: f.workspaceId, headers: { cookie } }; },
      async json<T>(_scope: PmScope, _endpoint: string, _options?: PmRequestOptions): Promise<T> { throw new Error('Watch must not send JSON/write requests'); },
      async response(_scope, endpoint, options) {
        assert.ok(!options?.method || options.method === 'GET'); reads.push(endpoint);
        const response = await fetch(`${f.origin}/api/v1/workspaces/${f.workspaceId}${endpoint}`, { headers: { cookie, ...options?.headers }, ...(options?.signal ? { signal: options.signal } : {}) });
        if (!response.ok) { const body = await response.json() as { error: { code: string } }; throw new CliRequestError(body.error.code, body.error.code, [], response.status); }
        return response;
      },
      print(value) { printed.push(value); },
    };
    await f.command('CreateTaskComment', { content: 'First new streamed fact' }, { extra: { targetId: task.id, projectId: project.id } }); await publishOutboxBatch(f.pool, 500);
    await watchCollaborationEvents(runtime, { after: baseline.body.cursor, projectId: project.id, durationMs: 5000, maxEvents: 1, reconnects: 0 });
    const summary = z.strictObject({ cursor: z.string(), events: z.number().int(), connections: z.number().int(), reason: z.enum(['limit', 'aborted', 'disconnected']), writeReplay: z.literal(false) });
    const first = summary.parse(printed.at(-1)); assert.equal(first.events, 1);
    await f.command('CreateTaskComment', { content: 'Created only while disconnected' }, { extra: { targetId: task.id, projectId: project.id } }); await publishOutboxBatch(f.pool, 500);
    const count = (await f.pool.query('SELECT count(*)::int AS n FROM task_comments WHERE task_id=$1', [task.id])).rows[0].n;
    await watchCollaborationEvents(runtime, { after: first.cursor, projectId: project.id, durationMs: 5000, maxEvents: 1, reconnects: 1 });
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM task_comments WHERE task_id=$1', [task.id])).rows[0].n, count);
    const head = summary.parse(printed.at(-1)).cursor;
    cookie = recipient.cookie;
    const { promise: ready, resolve: connected } = Promise.withResolvers<void>();
    const baseResponse = runtime.response;
    runtime.response = async (...args) => { const response = await baseResponse(...args); connected(); return response; };
    const running = watchCollaborationEvents(runtime, { after: head, projectId: project.id, durationMs: 5000, maxEvents: 10, reconnects: 2 });
    await ready;
    await f.command('RevokeWorkspaceMember', { userId: recipient.user.id }, { extra: { expectedVersions: { [recipient.user.id]: membership.version } } });
    await assert.rejects(running, /not_found_or_forbidden|permission_denied/);
    cookie = f.ownerCookie;
    await f.pool.query('DELETE FROM events WHERE workspace_id=$1 AND cursor<=$2::bigint', [f.workspaceId, head]);
    await assert.rejects(watchCollaborationEvents(runtime, { after: baseline.body.cursor, projectId: project.id, durationMs: 5000, maxEvents: 10, reconnects: 2 }), error => error instanceof CliRequestError && error.status === 410);
    assert.ok(reads.every(endpoint => endpoint.startsWith('/events?')));
  });
});
