import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCoreProtectedMetadata, assertCoreTaskMutation, assertTaskCreationProject, requireTaskAssignee, type CoreTaskPolicyPorts } from '../src/core-task-creation.ts';
import { DomainError } from '../../domain/src/core.ts';
import { createMarkdown, parseMarkdown } from '../../pm-markdown/index.ts';
import { defaultConfiguration, type Entity, type FileRecord } from '../../pm-schema/index.ts';
import type { SqlExecutor } from '../src/ports.ts';

function project(properties: Record<string, unknown> = {}): FileRecord {
  const raw = createMarkdown({ id: 'PRJ-1', entity: 'project', title: 'Creation target', ...properties });
  return { id: 'PRJ-1', path: 'projects/PRJ-1.md', raw, revision: 'source-revision', entity: parseMarkdown(raw) };
}
function code(expected: string): (error: unknown) => boolean {
  return error => error instanceof DomainError && error.code === expected;
}

test('task creation requires current nonarchived nonterminal project evidence and honors configured categories', () => {
  assert.doesNotThrow(() => assertTaskCreationProject(project(), defaultConfiguration));
  assert.throws(() => assertTaskCreationProject(project({ archived: true }), defaultConfiguration), code('object_archived'));
  assert.throws(() => assertTaskCreationProject({ ...project(), stale: true }, defaultConfiguration), code('project_inputs_unavailable'));
  assert.throws(() => assertTaskCreationProject(project({ status: 'completed' }), defaultConfiguration), code('invalid_state'));
  assert.throws(() => assertTaskCreationProject(project({ status: 'canceled' }), defaultConfiguration), code('invalid_state'));
  const custom = structuredClone(defaultConfiguration);
  custom.workflows.project!.states.push({ id: 'reviewed_custom', label: 'Reviewed', category: 'completed' });
  const original = project();
  const terminal = { ...original, entity: { ...original.entity, status: 'reviewed_custom' } };
  assert.throws(() => assertTaskCreationProject(terminal, custom), code('invalid_state'));
  const unknown = { ...original, entity: { ...original.entity, status: 'unclassified' } };
  assert.throws(() => assertTaskCreationProject(unknown, custom), code('project_inputs_unavailable'));
});

test('unassigned creation needs no identity lookup, while malformed and nonmember identities fail closed', async () => {
  const calls: unknown[][] = [];
  const sql: SqlExecutor = { async query<T>(_statement: string, values?: unknown[]) { calls.push(values ?? []); return { rows: [] as T[], rowCount: 0 }; } };
  await requireTaskAssignee(sql, 'workspace', 'PRJ-1', null);
  assert.equal(calls.length, 0);
  await assert.rejects(requireTaskAssignee(sql, 'workspace', 'PRJ-1', 'somebody@example.test'), code('workspace_member_required'));
  assert.equal(calls.length, 0);
  const userId = '11111111-1111-4111-8111-111111111111';
  await assert.rejects(requireTaskAssignee(sql, 'workspace', 'PRJ-1', userId), code('workspace_member_required'));
  assert.deepEqual(calls, [['workspace', userId, 'PRJ-1']]);
});

function task(properties: Record<string, unknown> = {}): Entity {
  return parseMarkdown(createMarkdown({ id: 'TASK-1', entity: 'work_item', title: 'Policy subject', project: 'PRJ-1', ...properties }));
}

function policy(records: FileRecord[] = [project()]): { ports: CoreTaskPolicyPorts; required: string[]; assignments: unknown[][] } {
  const required: string[] = [];
  const assignments: unknown[][] = [];
  const ports: CoreTaskPolicyPorts = {
    configuration: structuredClone(defaultConfiguration),
    get(id) {
      const record = records.find(record => record.id === id);
      if (!record) throw new DomainError('not_found_or_forbidden', 'Not found', 404);
      return record;
    },
    requireCapability(capability) { required.push(capability); },
    allowsProject(projectId) { return projectId === 'PRJ-1'; },
    async requireAssignee(projectId, assigneeId) { assignments.push([projectId, assigneeId]); },
  };
  return { ports, required, assignments };
}

test('common task policy checks new assignments but preserves historical revoked identities on unrelated edits', async () => {
  const f = policy();
  const before = task({ assignee: 'historical-member' });
  f.ports.requireAssignee = async () => { throw new DomainError('workspace_member_required'); };
  await assertCoreTaskMutation(f.ports, { ...before, priority: 'urgent', labels: ['new'], 'x-pm-location': 'Room' }, before);
  await assert.rejects(assertCoreTaskMutation(f.ports, { ...before, assignee: 'new-member' }, before), code('workspace_member_required'));
  await assert.rejects(assertCoreTaskMutation(f.ports, before), code('workspace_member_required'));
  assert.ok(f.required.includes('domain.read'));
  assert.ok(f.required.includes('planning.edit'));
  const movedProject = project();
  movedProject.id = 'PRJ-2';
  movedProject.entity = { ...movedProject.entity, id: movedProject.id };
  const moved = policy([project(), movedProject]);
  moved.ports.allowsProject = () => true;
  await assertCoreTaskMutation(moved.ports, { ...before, project: movedProject.id }, before);
  assert.deepEqual(moved.assignments, [['PRJ-2', 'historical-member']]);
});

test('common policy rejects closed, archived, stale and out-of-scope project evidence for source and property changes alike', async () => {
  const before = task();
  for (const [record, error] of [
    [project({ status: 'completed' }), 'invalid_state'],
    [project({ archived: true }), 'object_archived'],
    [{ ...project(), stale: true }, 'project_inputs_unavailable'],
  ] as const) {
    const f = policy([record]);
    await assert.rejects(assertCoreTaskMutation(f.ports, before), code(error));
    await assert.rejects(assertCoreTaskMutation(f.ports, { ...before, title: 'Changed' }, before), code(error));
  }
  const f = policy();
  f.ports.allowsProject = () => false;
  await assert.rejects(assertCoreTaskMutation(f.ports, before), code('not_found_or_forbidden'));
  await assert.rejects(assertCoreTaskMutation(f.ports, { ...before, project: 'PRJ-2' }, before), code('not_found_or_forbidden'));
});

test('configured task completion and cancellation capabilities do not gain a hidden planning.edit requirement', async () => {
  const before = task({ assignee: 'historical-member' });
  for (const [status, capability] of [['done', 'workitem.complete'], ['canceled', 'workitem.cancel_reopen']] as const) {
    const f = policy();
    await assertCoreTaskMutation(f.ports, { ...before, status }, before);
    assert.deepEqual(f.required, ['domain.read', capability]);
    assert.deepEqual(f.assignments, []);
  }
  const f = policy();
  await assertCoreTaskMutation(f.ports, { ...before, archived: true, 'x-pm-archived-at': '2026-10-21T00:00:00Z', checklist: [{ text: 'same body', checked: false, line: 9 }] }, before);
  assert.deepEqual(f.required, ['domain.read', 'planning.lifecycle']);
  const custom = policy();
  custom.ports.configuration.workflows.work_item!.states.push({ id: 'custom_final', label: 'Finished', category: 'completed' });
  await assertCoreTaskMutation(custom.ports, { ...before, status: 'custom_final' });
  assert.ok(custom.required.includes('workitem.complete'));
});

test('new parent and custom references use actual project scope without prohibiting authorized cross-project blockers', async () => {
  const parent = { ...project(), id: 'TASK-9', entity: task({ id: 'TASK-9' }) };
  const f = policy([project(), parent]);
  await assertCoreTaskMutation(f.ports, task({ kind: 'subtask', parent: parent.id }));
  parent.entity = { ...parent.entity, project: 'PRJ-2' };
  await assert.rejects(assertCoreTaskMutation(f.ports, task({ kind: 'subtask', parent: parent.id })), code('not_found_or_forbidden'));
  f.ports.allowsProject = () => true;
  await assert.rejects(assertCoreTaskMutation(f.ports, task({ kind: 'subtask', parent: parent.id })), code('project_mismatch'));
  await assertCoreTaskMutation(f.ports, task({ blocked_by: [parent.id] }));
  f.ports.configuration.custom_fields.push({ name: 'x-related-task', label: 'Related task', type: 'reference', target: 'work_item', entities: ['work_item'] });
  f.ports.allowsProject = projectId => projectId === 'PRJ-1';
  await assert.rejects(assertCoreTaskMutation(f.ports, task({ 'x-related-task': parent.id })), code('not_found_or_forbidden'));
});

test('native protected server facts cannot be created, changed or removed but unrelated custom metadata is retained', () => {
  const before = task({ 'x-pm-created-by': 'actor', 'x-pm-command-id': 'original', 'x-pm-intent-ref': { intentId: 'intent', acceptedRevision: 1 } });
  assert.doesNotThrow(() => assertCoreProtectedMetadata({ ...before, 'x-custom': 'allowed' }, before));
  assert.doesNotThrow(() => assertCoreProtectedMetadata({ ...before, 'x-pm-intent-ref': { acceptedRevision: 1, intentId: 'intent' } }, before));
  for (const field of ['x-pm-created-by', 'x-pm-created-at', 'x-pm-updated-at', 'x-pm-command-id', 'x-pm-intent-ref', 'x-pm-archived-at']) {
    assert.throws(() => assertCoreProtectedMetadata(task({ [field]: 'forged' })), code('protected_metadata'));
    assert.throws(() => assertCoreProtectedMetadata({ ...before, [field]: 'changed' }, before), code('protected_metadata'));
  }
  assert.throws(() => assertCoreProtectedMetadata(task(), before), code('protected_metadata'));
  assert.doesNotThrow(() => assertCoreProtectedMetadata(task({ 'x-pm-start': '2028-02-29', 'x-pm-location': 'Room', 'x-pm-estimate': 0 })));
});

test('non-task creation does not inherit task-only membership or project closure policy', async () => {
  const f = policy([project({ status: 'completed' })]);
  const entity = parseMarkdown(createMarkdown({ id: 'DOC-1', entity: 'document', title: 'Generic document', 'x-untouched': { value: 1 } }));
  await assertCoreTaskMutation(f.ports, entity);
  assert.deepEqual(f.required, []);
  assert.deepEqual(f.assignments, []);
});
