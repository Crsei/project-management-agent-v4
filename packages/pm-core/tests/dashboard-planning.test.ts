import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { analyzeCriticalPath } from '../../domain/src/dashboard-planning.ts';
import { setProjectDependenciesSchema, updateMilestoneSchema, updateTaskDurationSchema } from '../../application/src/dashboard-planning.ts';
import { parseMarkdown, patchMarkdown } from '../../pm-markdown/index.ts';
import { validateRelations, referenceEntries } from '../../pm-schema/relations.ts';
import { applyView, groupChange } from '../../pm-schema/query.ts';
import { ProtocolError, type FileRecord } from '../../pm-schema/index.ts';
import { Workspace, WorkspaceError } from '../index.ts';

function record(id: string, fields: Record<string, unknown> = {}): FileRecord {
  const raw = `---\n${stringify({ schema: 'pm/v1', id, entity: id.startsWith('PRJ') ? 'project' : 'work_item', ...fields })}---\n# ${id}\n\nPreserved source.\n`;
  return { id, path: `${id}.md`, raw, revision: 'test-source', entity: parseMarkdown(raw) };
}
function task(id: string, duration: number | undefined, dependencies: string[] = [], project = 'PRJ-1') {
  return record(id, { project, ...(duration === undefined ? {} : { estimated_duration_days: duration }), blocked_by: dependencies });
}
async function workspace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-planning-core-'));
  const current = new Workspace(root);
  t.after(async () => { await current.close(); await rm(root, { recursive: true, force: true }); });
  await current.init();
  return { root, current };
}
function hasCode(code: string) {
  return (error: unknown) => error instanceof WorkspaceError && error.diagnostics.some(item => item.code === code);
}

test('critical path performs forward/backward passes and keeps both equal diamond branches', () => {
  const files = [record('PRJ-1'), task('TASK-1', 2), task('TASK-2', 3, ['TASK-1']), task('TASK-3', 3, ['TASK-1']), task('TASK-4', 2, ['TASK-2', 'TASK-3']), task('TASK-5', 1, ['TASK-1']), task('TASK-6', 1, ['TASK-5'])];
  const result = analyzeCriticalPath('PRJ-1', files);
  assert.equal(result.status, 'available');
  if (result.status !== 'available') return;
  assert.equal(result.durationDays, 7);
  assert.deepEqual(result.criticalPaths, [['TASK-1', 'TASK-2', 'TASK-4'], ['TASK-1', 'TASK-3', 'TASK-4']]);
  assert.deepEqual(result.tasks.find(item => item.id === 'TASK-5'), { id: 'TASK-5', title: 'TASK-5', projectId: 'PRJ-1', estimatedDurationDays: 1, earlyStart: 2, earlyFinish: 3, lateStart: 5, lateFinish: 6, totalFloat: 3, freeFloat: 0, critical: false });
  assert.equal(result.tasks.find(item => item.id === 'TASK-6')!.freeFloat, 3);
  assert.deepEqual(result.tasks.filter(item => item.critical).map(item => item.id).sort(), ['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4']);
});

test('critical path includes real cross-project task prerequisites without adding project dependencies', () => {
  const result = analyzeCriticalPath('PRJ-1', [record('PRJ-1'), record('PRJ-2'), task('TASK-1', 2, ['TASK-2']), task('TASK-2', 3, [], 'PRJ-2')]);
  assert.equal(result.status, 'available');
  if (result.status !== 'available') return;
  assert.equal(result.durationDays, 5);
  assert.deepEqual(result.criticalPaths, [['TASK-2', 'TASK-1']]);
});

test('missing estimates, hidden/deleted predecessors, invalid source and cycles are unavailable', () => {
  const missing = analyzeCriticalPath('PRJ-1', [record('PRJ-1'), task('TASK-1', undefined)]);
  assert.equal(missing.status, 'unavailable');
  if (missing.status === 'unavailable') assert.equal(missing.reasons[0]!.code, 'missing_duration');
  for (const id of ['TASK-999', 'TASK-404']) {
    const result = analyzeCriticalPath('PRJ-1', [record('PRJ-1'), task('TASK-1', 1, [id])]);
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.equal(result.reasons[0]!.code, 'dependency_unavailable');
    assert.ok(!JSON.stringify(result).includes(id), 'unavailable dependencies must not leak hidden identities');
  }
  const stale = task('TASK-1', 1); stale.stale = true;
  assert.equal(analyzeCriticalPath('PRJ-1', [record('PRJ-1'), stale]).status, 'unavailable');
  const cyclic = analyzeCriticalPath('PRJ-1', [record('PRJ-1'), task('TASK-1', 1, ['TASK-2']), task('TASK-2', 1, ['TASK-1'])]);
  assert.equal(cyclic.status, 'unavailable');
  if (cyclic.status === 'unavailable') assert.equal(cyclic.reasons[0]!.code, 'dependency_cycle');
});

test('duration is strict nonnegative finite calendar days in source, patches, queries and commands', () => {
  const source = task('TASK-1', 0.5);
  assert.equal(source.entity.estimated_duration_days, 0.5);
  assert.equal(groupChange(source.entity, 'estimated_duration_days', 0).estimated_duration_days, 0);
  assert.equal(applyView([source, task('TASK-2', 2)], { entity: 'work_item', layout: 'table', where: { field: 'estimated_duration_days', op: 'gt', value: 1 } }).length, 1);
  for (const value of [-1, Infinity, NaN, '2']) {
    assert.throws(() => patchMarkdown(source.raw, { estimated_duration_days: value }), ProtocolError);
    assert.throws(() => groupChange(source.entity, 'estimated_duration_days', value), ProtocolError);
    assert.equal(updateTaskDurationSchema.safeParse({ estimatedDurationDays: value }).success, false);
  }
  assert.equal(parseMarkdown(patchMarkdown(source.raw, { estimated_duration_days: null })).estimated_duration_days, undefined);
  assert.equal(updateTaskDurationSchema.safeParse({ estimatedDurationDays: null }).success, true);
  assert.throws(() => record('PRJ-1', { estimated_duration_days: 2 }), ProtocolError);
});

test('formal project references reject duplicates, self, type mismatch, missing targets and cycles', () => {
  assert.throws(() => record('PRJ-1', { depends_on: ['PRJ-2', 'PRJ-2'] }), ProtocolError);
  assert.equal(setProjectDependenciesSchema.safeParse({ dependsOn: ['PRJ-2', 'PRJ-2'] }).success, false);
  for (const [dependencies, others, code] of [
    [['PRJ-1'], [], 'SELF_REFERENCE'], [['TASK-1'], [task('TASK-1', 1)], 'REFERENCE_TYPE'],
    [['PRJ-404'], [], 'REFERENCE_NOT_FOUND'], [['PRJ-2'], [record('PRJ-2', { depends_on: ['PRJ-1'] })], 'RELATION_CYCLE'],
  ] as const) {
    const diagnostics = validateRelations([record('PRJ-1', { depends_on: dependencies }), ...others]);
    assert.ok(diagnostics.some(item => item.field === 'depends_on' && item.code === code), JSON.stringify(diagnostics));
  }
  const first = record('PRJ-1', { depends_on: ['PRJ-2'] });
  assert.ok(referenceEntries(first.entity).some(item => item.field === 'depends_on' && item.targetId === 'PRJ-2'));
  assert.deepEqual(validateRelations([first, record('PRJ-2'), task('TASK-1', 1, ['TASK-2']), task('TASK-2', 1, [], 'PRJ-2')]), []);
});

test('raw/API-equivalent writes share graph validation and project deletion protection', async t => {
  const { root, current } = await workspace(t);
  const first = await current.createEntity({ entity: 'project', title: 'First' });
  let second = await current.createEntity({ entity: 'project', title: 'Second' });
  const dependent = await current.patch(first.id, { depends_on: [second.id] }, first.revision);
  await assert.rejects(current.patch(second.id, { depends_on: [first.id] }, second.revision), hasCode('RELATION_CYCLE'));
  await assert.rejects(current.save(second.id, patchMarkdown(second.raw, { depends_on: [first.id] }), second.revision), hasCode('RELATION_CYCLE'));
  second = await current.archive(second.id, second.revision);
  await assert.rejects(current.delete(second.id, second.revision), hasCode('DELETE_REFERENCED'));
  await writeFile(join(root, dependent.path), patchMarkdown(dependent.raw, { depends_on: [dependent.id] }));
  await current.rescan();
  assert.ok(current.snapshot().errors.some(item => item.field === 'depends_on' && item.code === 'SELF_REFERENCE'));
  assert.equal(analyzeCriticalPath(first.id, current.snapshot().files).status, 'unavailable');
});

test('external invalid duration retains an explicitly unavailable source instead of a fresh valid estimate', async t => {
  const { root, current } = await workspace(t);
  const project = await current.createEntity({ entity: 'project', title: 'Project' });
  const item = await current.createEntity({ entity: 'work_item', project: project.id, title: 'Task', estimated_duration_days: 2 });
  await writeFile(join(root, item.path), item.raw.replace('estimated_duration_days: 2', 'estimated_duration_days: -3'));
  await current.rescan();
  const result = analyzeCriticalPath(project.id, current.snapshot().files);
  assert.equal(result.status, 'unavailable');
  if (result.status === 'unavailable') assert.ok(result.reasons.some(reason => reason.code === 'invalid_source'));
});

test('external deletion of a referenced task cannot turn the remaining graph into successful analysis', async t => {
  const { root, current } = await workspace(t);
  const project = await current.createEntity({ entity: 'project', title: 'Project' });
  const prerequisite = await current.createEntity({ entity: 'work_item', project: project.id, title: 'Prerequisite', estimated_duration_days: 2 });
  await current.createEntity({ entity: 'work_item', project: project.id, title: 'Dependent', estimated_duration_days: 3, blocked_by: [prerequisite.id] });
  await rm(join(root, prerequisite.path));
  await current.rescan();
  const result = analyzeCriticalPath(project.id, current.snapshot().files);
  assert.equal(result.status, 'unavailable');
  assert.ok(current.snapshot().errors.some(item => item.code === 'REFERENCE_NOT_FOUND' || item.code === 'REFERENCE_INVALID'));
});

test('public milestone update contract rejects unknown/empty fields and impossible dates', () => {
  for (const payload of [{}, { targetDate: '2026-02-30' }, { targetDate: '' }, { due: '2026-10-20' }, { targetDate: null, body: 'replace' }, { name: '' }, { criteria: [3] }])
    assert.equal(updateMilestoneSchema.safeParse(payload).success, false, JSON.stringify(payload));
  assert.deepEqual(updateMilestoneSchema.parse({ targetDate: null }), { targetDate: null });
  assert.deepEqual(updateMilestoneSchema.parse({ targetDate: '2028-02-29' }), { targetDate: '2028-02-29' });
});
