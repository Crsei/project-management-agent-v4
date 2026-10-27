import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../packages/pm-markdown/index.ts';
import { defaultConfiguration, parseConfiguration, type FileRecord, type ProtocolConfiguration, type WorkspaceSnapshot } from '../packages/pm-schema/index.ts';
import { personalDate } from '../apps/web/src/features/pm/markdown/task-collection-model.ts';
import { workspaceHomeModel } from '../apps/web/src/features/pm/service/workspace-home-model.ts';

function file(id: string, kind: 'project' | 'work_item', fields: Record<string, string | boolean> = {}, configuration = defaultConfiguration): FileRecord {
  const values = { schema: 'pm/v1', id, entity: kind, ...(kind === 'work_item' ? { project: 'PRJ-1', status: 'todo' } : { status: 'active' }), ...fields };
  const raw = `---\n${Object.entries(values).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n# ${id}\n`;
  return { id, raw, path: `${kind}/${id}.md`, revision: `revision-${id}`, entity: parseMarkdown(raw, configuration) };
}
function snapshot(files: FileRecord[], configuration: ProtocolConfiguration = defaultConfiguration): WorkspaceSnapshot {
  return { files, configuration, configurationErrors: [], configurationRevision: 'revision-config', errors: [], unsupportedFiles: [], views: [] };
}

const customConfiguration = parseConfiguration({
  schema: 'pm/config/v1', custom_fields: [], workflows: {
    project: { initial: 'preparing', states: [{ id: 'preparing', label: 'Preparing', category: 'unstarted' }, { id: 'delivered', label: 'Delivered', category: 'completed' }, { id: 'withdrawn', label: 'Withdrawn', category: 'canceled' }], transitions: [] },
    work_item: { initial: 'queued', states: [{ id: 'queued', label: 'Queued', category: 'unstarted' }, { id: 'shipped', label: 'Shipped', category: 'completed' }, { id: 'dropped', label: 'Dropped', category: 'canceled' }], transitions: [] },
  },
});

test('Home aggregates only the authorized project scope and the current actor assignments', () => {
  const source = snapshot([
    file('PRJ-1', 'project'), file('PRJ-2', 'project'),
    file('TASK-1', 'work_item', { assignee: 'actor-a', due: '2026-10-22' }),
    file('TASK-2', 'work_item', { assignee: 'actor-b', due: '2026-10-21' }),
    file('TASK-3', 'work_item', { project: 'PRJ-2', assignee: 'actor-a', due: '2026-10-21' }),
    file('TASK-4', 'work_item', { project: 'PRJ-99', assignee: 'actor-a' }),
  ]);
  const before = JSON.stringify(source);
  const a = workspaceHomeModel(source, 'actor-a', ['PRJ-1'], '2026-10-22')!;
  const b = workspaceHomeModel(source, 'actor-b', ['PRJ-1'], '2026-10-22')!;
  assert.deepEqual(a.projects.map(value => value.id), ['PRJ-1']);
  assert.deepEqual(a.tasks.map(value => value.id), ['TASK-1', 'TASK-2']);
  assert.deepEqual(a.mine.todo?.map(value => value.id), ['TASK-1']);
  assert.deepEqual(a.mine.overdue, []);
  assert.deepEqual(b.mine.overdue?.map(value => value.id), ['TASK-2']);
  assert.deepEqual(workspaceHomeModel(source, 'actor-a', [], '2026-10-22')!.tasks, []);
  assert.deepEqual(workspaceHomeModel(snapshot([file('PRJ-1', 'project')]), 'actor-a', null, '2026-10-22')!.tasks, []);
  assert.equal(JSON.stringify(source), before);
});

test('Home uses custom native terminal categories, excludes archived work, and never completes a project from task percentage', () => {
  const source = snapshot([
    file('PRJ-1', 'project', { status: 'preparing' }, customConfiguration),
    file('PRJ-2', 'project', { status: 'delivered' }, customConfiguration),
    file('PRJ-3', 'project', { status: 'withdrawn' }, customConfiguration),
    file('PRJ-4', 'project', { status: 'preparing', archived: true }, customConfiguration),
    file('TASK-1', 'work_item', { status: 'shipped', assignee: 'actor-a', due: '2026-10-20' }, customConfiguration),
    file('TASK-2', 'work_item', { status: 'dropped', assignee: 'actor-a', due: '2026-10-20' }, customConfiguration),
    file('TASK-3', 'work_item', { status: 'queued', archived: true, assignee: 'actor-a', due: '2026-10-20' }, customConfiguration),
    file('TASK-4', 'work_item', { project: 'PRJ-4', status: 'queued', assignee: 'actor-a', due: '2026-10-20' }, customConfiguration),
  ], customConfiguration);
  const result = workspaceHomeModel(source, 'actor-a', null, '2026-10-22')!;
  assert.deepEqual(result.open, []);
  assert.deepEqual(result.overdue, []);
  assert.deepEqual(result.completed.map(value => value.id), ['TASK-1']);
  assert.deepEqual(result.mine.completed?.map(value => value.id), ['TASK-1']);
  assert.equal(result.activeProjects.length, 1);
  assert.equal(result.activeProjects[0]!.percent, 100);
  assert.equal(result.activeProjects[0]!.total, 1);
  assert.equal(result.activeProjects[0]!.file.entity.status, 'preparing');
  assert.equal(source.files[0]!.entity.status, 'preparing');
});

test('Home open, completed and progress exclude canceled tasks without treating cancelation as completion', () => {
  const result = workspaceHomeModel(snapshot([
    file('PRJ-1', 'project'),
    file('TASK-1', 'work_item', { status: 'done' }),
    file('TASK-2', 'work_item', { status: 'canceled', due: '2026-10-20' }),
    file('TASK-3', 'work_item', { due: '2026-10-23' }),
  ]), 'actor-a', null, '2026-10-22')!;
  assert.equal(result.activeProjects[0]!.percent, 50);
  assert.equal(result.activeProjects[0]!.total, 2);
  assert.deepEqual(result.open.map(value => value.id), ['TASK-3']);
  assert.deepEqual(result.completed.map(value => value.id), ['TASK-1']);
  assert.deepEqual(result.overdue, []);
});

test('Home deadline buckets are disjoint, calendar-based and inclusive through day seven', () => {
  const result = workspaceHomeModel(snapshot([
    file('PRJ-1', 'project'),
    ...['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-07', '2027-01-08'].map((due, index) => file(`TASK-${index + 1}`, 'work_item', { due, assignee: 'actor-a' })),
    file('TASK-7', 'work_item', { assignee: 'actor-a' }),
    file('TASK-8', 'work_item', { due: '2026-12-31', status: 'done' }),
    file('TASK-9', 'work_item', { due: '2027-01-01', status: 'canceled' }),
  ]), 'actor-a', null, '2026-12-31')!;
  assert.deepEqual(result.overdue?.map(value => value.id), ['TASK-1']);
  assert.deepEqual(result.deadlines?.map(group => [group.id, group.files.map(value => value.id)]), [
    ['today', ['TASK-2']], ['tomorrow', ['TASK-3']], ['week', ['TASK-4', 'TASK-5']],
  ]);
  assert.deepEqual(result.mine.todo?.map(value => value.id), ['TASK-2', 'TASK-3', 'TASK-4', 'TASK-5', 'TASK-6', 'TASK-7']);
});

test('Home personal dates change at actor midnight, not browser or UTC midnight, including DST', () => {
  const source = snapshot([file('PRJ-1', 'project'), file('TASK-1', 'work_item', { due: '2026-03-08', assignee: 'actor-a' })]);
  const before = personalDate(new Date('2026-03-09T03:59:59Z'), 'America/New_York');
  const after = personalDate(new Date('2026-03-09T04:00:00Z'), 'America/New_York');
  assert.equal(workspaceHomeModel(source, 'actor-a', null, before)!.overdue!.length, 0);
  assert.equal(workspaceHomeModel(source, 'actor-a', null, after)!.overdue!.length, 1);
  const instant = new Date('2026-10-22T00:30:00Z');
  assert.equal(workspaceHomeModel(snapshot([file('PRJ-1', 'project'), file('TASK-1', 'work_item', { due: '2026-10-21' })]), 'actor-a', null, personalDate(instant, 'America/Los_Angeles'))!.overdue!.length, 0);
  assert.equal(workspaceHomeModel(snapshot([file('PRJ-1', 'project'), file('TASK-1', 'work_item', { due: '2026-10-21' })]), 'actor-a', null, personalDate(instant, 'Asia/Shanghai'))!.overdue!.length, 1);
});

test('Home missing time zone is unknown, not empty or an invented UTC date', () => {
  const result = workspaceHomeModel(snapshot([file('PRJ-1', 'project'), file('TASK-1', 'work_item', { due: '2026-10-20', assignee: 'actor-a' }), file('TASK-2', 'work_item', { status: 'done', assignee: 'actor-a' })]), 'actor-a', null, null)!;
  assert.equal(result.open.length, 1);
  assert.equal(result.completed.length, 1);
  assert.equal(result.overdue, null);
  assert.equal(result.deadlines, null);
  assert.equal(result.mine.todo, null);
  assert.equal(result.mine.overdue, null);
  assert.deepEqual(result.mine.completed?.map(value => value.id), ['TASK-2']);
});

test('Home invalid configuration blocks aggregation; unreadable and unknown-status sources are not silently counted', () => {
  const source = snapshot([file('PRJ-1', 'project'), file('TASK-1', 'work_item'), file('TASK-2', 'work_item'), file('TASK-3', 'work_item')]);
  source.files[1]!.stale = true;
  source.files[2]!.entity.status = 'unrecognized';
  source.files[3]!.diagnostics = [{ code: 'INVALID_SOURCE', severity: 'error', path: source.files[3]!.path, message: 'Source invalid' }];
  const result = workspaceHomeModel(source, 'actor-a', null, '2026-10-22')!;
  assert.equal(result.open.length, 0);
  assert.equal(result.excludedSources, 3);
  assert.equal(result.activeProjects[0]!.percent, null);
  source.configurationErrors.push({ code: 'CONFIGURATION_INVALID', severity: 'error', path: '.pm/config.yaml', message: 'Invalid workflow' });
  assert.equal(workspaceHomeModel(source, 'actor-a', null, '2026-10-22'), null);
});

test('Home a successful empty workspace has real zero totals and no invented project or tasks', () => {
  const result = workspaceHomeModel(snapshot([]), 'actor-a', null, '2026-10-22')!;
  assert.equal(result.activeProjects.length, 0);
  assert.equal(result.open.length, 0);
  assert.equal(result.completed.length, 0);
  assert.equal(result.overdue!.length, 0);
  assert.deepEqual(result.mine, { todo: [], overdue: [], completed: [] });
  assert.deepEqual(result.deadlines?.map(group => group.files), [[], [], []]);
});
