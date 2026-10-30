import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChangeNotification, ProjectAuditEntry, TaskComment } from '@contracts';
import type { FileRecord } from '@pm-schema';
import { activityProjects, readActivityAudits, readActivityCommentTargets, workspaceActivityEntries } from './workspace-activity-model.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const commentId = '33333333-3333-4333-8333-333333333333';
function file(id: string, kind: 'project' | 'work_item' | 'document', project?: string): FileRecord {
  return { id, path: `${id}.md`, raw: '', revision: 'current', entity: {
    schema: 'pm/v1', id, entity: kind, title: `Title ${id}`, ...(project ? { project } : {}),
    status: 'done', assignee: actorId, body: '', blocked_by: [], related_to: [], labels: [], links: [], checklist: [], views: [],
  } };
}
function audit(overrides: Partial<ProjectAuditEntry> = {}): ProjectAuditEntry {
  return { id: '10', projectId: 'PRJ-001', source: 'core_http', commandId: 'request', action: 'UpdateCoreProperties', actorId,
    occurredAt: '2026-10-29T10:00:00.000Z', targetId: 'TASK-001', targetKind: 'work_item', beforeVersion: 'before', afterVersion: 'after',
    changes: [{ field: 'status', before: 'todo', after: 'in_progress' }], private: false, ...overrides };
}
function event(overrides: Partial<ChangeNotification> = {}): ChangeNotification {
  return { eventId: 'change', workspaceId, projectId: 'PRJ-001', aggregateId: 'TASK-001', aggregateKind: 'work_item',
    aggregateVersion: 2, eventType: 'WorkItemMetadataUpdated', occurredAt: '2026-10-29T10:01:00.000Z', ...overrides };
}
function input(overrides: Partial<Parameters<typeof workspaceActivityEntries>[0]> = {}): Parameters<typeof workspaceActivityEntries>[0] {
  return { workspaceId, projectIds: null, files: [file('PRJ-001', 'project'), file('TASK-001', 'work_item', 'PRJ-001')],
    audits: [], auditedProjectIds: [], events: [], commentTargets: [], people: [{ id: actorId, name: 'Authorized name' }], canReadAudit: true, linksAvailable: true, ...overrides };
}
function comment(id = commentId): TaskComment {
  return { id, workspaceId, projectId: 'PRJ-001', taskId: 'TASK-001', authorId: actorId, version: 1,
    content: 'This body must not enter the activity snapshot', deletedAt: null, createdAt: '2026-10-29T10:00:00.000Z', updatedAt: '2026-10-29T10:00:00.000Z' };
}

test('ordinary readers retain metadata, never actors or inferred status/diffs', () => {
  const entries = workspaceActivityEntries(input({ canReadAudit: false, audits: [audit()], auditedProjectIds: ['PRJ-001'], events: [event(), event()] }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.source, 'changes');
  assert.equal(entries[0]!.actorId, null);
  assert.equal(entries[0]!.actorName, null);
  assert.equal(entries[0]!.changes, undefined);
  assert.equal(entries[0]!.category, 'other');
  assert.equal(entries[0]!.href, `/pm/${workspaceId}/projects/PRJ-001/entities/TASK-001`);
});

test('explicit lifecycle metadata is a status fact without invented actors or transition values', () => {
  const entries = workspaceActivityEntries(input({ canReadAudit: false, events: [
    event({ eventId: 'started', eventType: 'WorkItemStarted' }),
    event({ eventId: 'completed', eventType: 'WorkItemCompleted' }),
    event({ eventId: 'generic', eventType: 'WorkItemMetadataUpdated' }),
    event({ eventId: 'created', eventType: 'WorkItemCreated' }),
    event({ eventId: 'wrong-kind', eventType: 'WorkItemStarted', aggregateKind: 'project' }),
    event({ eventId: 'project', eventType: 'ProjectActivated', aggregateKind: 'project', aggregateId: 'PRJ-001' }),
  ] }));
  assert.equal(entries.filter(entry => entry.category === 'status').length, 3);
  for (const entry of entries) { assert.equal(entry.actorId, null); assert.equal(entry.changes, undefined); }
  assert.equal(entries.find(entry => entry.id === 'changes:generic')!.category, 'other');
  assert.equal(entries.find(entry => entry.id === 'changes:created')!.category, 'other');
  assert.equal(entries.find(entry => entry.id === 'changes:wrong-kind')!.category, 'projects');
});

test('only persisted non-null unequal status differences count as transitions', () => {
  const entries = workspaceActivityEntries(input({ auditedProjectIds: ['PRJ-001'], audits: [
    audit(),
    audit({ id: '9', commandId: 'create', action: 'CreateWorkItem', beforeVersion: null, changes: [{ field: 'status', before: null, after: 'todo' }] }),
    audit({ id: '8', commandId: 'metadata', changes: [{ field: 'priority', before: 'low', after: 'high' }] }),
    audit({ id: '7', commandId: 'noop', changes: [{ field: 'status', before: 'todo', after: 'todo' }] }),
    audit({ id: '6', commandId: 'project', targetKind: 'project', targetId: 'PRJ-001', beforeVersion: null, changes: [{ field: 'status', before: null, after: 'planned' }] }),
  ] }));
  assert.equal(entries.filter(entry => entry.category === 'status').length, 1);
  assert.equal(entries.find(entry => entry.id === 'audit:10')!.actorName, 'Authorized name');
  assert.equal(entries.find(entry => entry.id === 'audit:9')!.category, 'other');
  assert.equal(entries.find(entry => entry.id === 'audit:8')!.category, 'other');
  assert.deepEqual(entries.find(entry => entry.id === 'audit:7')!.changes, []);
  assert.equal(entries.find(entry => entry.id === 'audit:6')!.category, 'projects');
});

test('project source partition avoids timestamp heuristics and duplicate audit/stream writes', () => {
  const entries = workspaceActivityEntries(input({ audits: [audit()], auditedProjectIds: ['PRJ-001'], events: [event(), event({ eventId: 'other-project', projectId: 'PRJ-002' })] }));
  assert.deepEqual(entries.map(entry => entry.source).sort(), ['audit', 'changes']);
  assert.equal(entries.some(entry => entry.id === 'changes:change'), false);
  assert.equal(entries.find(entry => entry.source === 'changes')!.actorId, null);
});

test('a cross-project write is shown once with its current authorized target context', () => {
  const files = [file('PRJ-001', 'project'), file('PRJ-002', 'project'), file('TASK-001', 'work_item', 'PRJ-002')];
  const entries = workspaceActivityEntries(input({ files, auditedProjectIds: ['PRJ-001', 'PRJ-002'], audits: [audit(), audit({ id: '11', projectId: 'PRJ-002' })] }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.projectId, 'PRJ-002');
  assert.equal(entries[0]!.href, `/pm/${workspaceId}/projects/PRJ-002/entities/TASK-001`);
});

test('scope filters reject foreign workspace/project facts and never expose hidden target names', () => {
  const files = [file('PRJ-001', 'project'), file('PRJ-002', 'project'), file('TASK-002', 'work_item', 'PRJ-002')];
  const entries = workspaceActivityEntries(input({ files, projectIds: ['PRJ-001'], auditedProjectIds: ['PRJ-002'],
    audits: [audit({ projectId: 'PRJ-002', targetId: 'TASK-002' })], events: [event({ workspaceId: 'foreign' }), event({ projectId: 'PRJ-002' }), event()] }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.targetTitle, 'TASK-001');
  assert.equal(entries[0]!.href, null);
});

test('comment links resolve the true current task, not the comment UUID or a convenient project task', () => {
  const activity = audit({ action: 'CreateTaskComment', targetId: commentId, targetKind: 'task_comment', changes: [] });
  const entries = workspaceActivityEntries(input({ audits: [activity], auditedProjectIds: ['PRJ-001'],
    commentTargets: [{ commentId, taskId: 'TASK-001', projectId: 'PRJ-001', deleted: false }] }));
  assert.equal(entries[0]!.category, 'comments');
  assert.equal(entries[0]!.targetId, 'TASK-001');
  assert.equal(entries[0]!.targetTitle, 'Title TASK-001');
  assert.equal(entries[0]!.href, `/pm/${workspaceId}/projects/PRJ-001/entities/TASK-001#comment-${commentId}`);
  assert.equal(workspaceActivityEntries(input({ audits: [activity], auditedProjectIds: ['PRJ-001'] }))[0]!.href, null);
  assert.equal(workspaceActivityEntries(input({ audits: [activity], auditedProjectIds: ['PRJ-001'], commentTargets: [{ commentId, taskId: 'TASK-001', projectId: 'PRJ-001', deleted: true }] }))[0]!.href, null);
});

test('missing, stale and unresolved targets stay nonclickable; private watch is not a task link', () => {
  for (const files of [[], [file('TASK-001', 'work_item', 'PRJ-001')], [file('PRJ-001', 'project'), { ...file('TASK-001', 'work_item', 'PRJ-001'), stale: true }]]) {
    assert.equal(workspaceActivityEntries(input({ files, audits: [audit()], auditedProjectIds: ['PRJ-001'] }))[0]!.href, null);
  }
  const entries = workspaceActivityEntries(input({ audits: [audit({ targetId: commentId, targetKind: 'task_watch', action: 'WatchTask', private: true, changes: [] })], auditedProjectIds: ['PRJ-001'] }));
  assert.equal(entries[0]!.category, 'other');
  assert.equal(entries[0]!.href, null);
  const unavailable = workspaceActivityEntries(input({ audits: [audit()], auditedProjectIds: ['PRJ-001'], linksAvailable: false }))[0]!;
  assert.equal(unavailable.href, null);
  assert.equal(unavailable.projectId, null);
  assert.equal(unavailable.projectTitle, null);
});

test('archived authorized projects remain in the complete project discovery scope', () => {
  const archived = file('PRJ-002', 'project');
  archived.entity.archived = true;
  assert.deepEqual(activityProjects([archived, file('PRJ-001', 'project'), file('TASK-001', 'work_item', 'PRJ-001')], null), ['PRJ-001', 'PRJ-002']);
  assert.deepEqual(activityProjects([archived, file('PRJ-001', 'project')], ['PRJ-002']), ['PRJ-002']);
});

test('audit pagination reads every page/project and rejects cycles, scope mismatch and nondecreasing IDs', async () => {
  const calls: string[] = [];
  const entries = await readActivityAudits(['PRJ-001', 'PRJ-002'], async (projectId, cursor) => {
    calls.push(`${projectId}:${cursor ?? 'first'}`);
    return { projectId, entries: [audit({ id: cursor ? '8' : projectId === 'PRJ-001' ? '10' : '7', projectId })], nextCursor: projectId === 'PRJ-001' && !cursor ? 'older' : null };
  }, new AbortController().signal);
  assert.deepEqual(calls, ['PRJ-001:first', 'PRJ-001:older', 'PRJ-002:first']);
  assert.deepEqual(entries.map(entry => entry.id), ['10', '8', '7']);
  await assert.rejects(readActivityAudits(['PRJ-001'], async () => ({ projectId: 'PRJ-002', entries: [], nextCursor: null }), new AbortController().signal), /invalid_response/);
  await assert.rejects(readActivityAudits(['PRJ-001'], async () => ({ projectId: 'PRJ-001', entries: [audit()], nextCursor: 'cycle' }), new AbortController().signal), /invalid_response/);
  await assert.rejects(readActivityAudits(['PRJ-001'], async () => ({ projectId: 'PRJ-001', entries: [], nextCursor: 'empty-loop' }), new AbortController().signal), /invalid_response/);
});

test('comment target lookup paginates, strips body/author, stops after resolution, and honors moved-history limitations', async () => {
  const files = [file('TASK-001', 'work_item', 'PRJ-001'), file('TASK-002', 'work_item', 'PRJ-001')];
  const calls: string[] = [];
  const earlier = '00000000-0000-4000-8000-000000000001';
  const result = await readActivityCommentTargets({ workspaceId, projectIds: ['PRJ-001'] }, files, [{ projectId: 'PRJ-001', commentId }], async (taskId, projectId, after) => {
    calls.push(`${taskId}:${after ?? 'first'}`);
    return { taskId, projectId, items: [comment(after ? commentId : earlier)], nextCursor: after ? null : earlier };
  }, new AbortController().signal);
  assert.deepEqual(calls, ['TASK-001:first', `TASK-001:${earlier}`]);
  assert.deepEqual(result, [{ commentId, taskId: 'TASK-001', projectId: 'PRJ-001', deleted: false }]);
  assert.deepEqual(await readActivityCommentTargets({ workspaceId, projectIds: ['PRJ-001'] }, files, [{ projectId: 'PRJ-001', commentId }], async () => null, new AbortController().signal), []);
  await assert.rejects(readActivityCommentTargets({ workspaceId, projectIds: ['PRJ-001'] }, files, [{ projectId: 'PRJ-001', commentId }], async () => ({ taskId: 'TASK-001', projectId: 'PRJ-001', items: [comment()], nextCursor: earlier }), new AbortController().signal), /invalid_response/);
});

test('aborted activity snapshots do not issue any further page requests', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(readActivityAudits(['PRJ-001'], async () => { calls += 1; return { projectId: 'PRJ-001', entries: [], nextCursor: null }; }, controller.signal));
  assert.equal(calls, 0);
});

test('comment lookup stops at the frozen requested-ID bound rather than following a live tail', async () => {
  const later = '99999999-9999-4999-8999-999999999999';
  let calls = 0;
  const result = await readActivityCommentTargets({ workspaceId, projectIds: null }, [file('TASK-001', 'work_item', 'PRJ-001')],
    [{ projectId: 'PRJ-001', commentId }], async () => {
      calls += 1;
      assert.equal(calls, 1);
      return { taskId: 'TASK-001', projectId: 'PRJ-001', items: [comment(later)], nextCursor: later };
    }, new AbortController().signal);
  assert.equal(calls, 1);
  assert.deepEqual(result, []);
});
