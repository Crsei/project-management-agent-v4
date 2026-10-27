import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../packages/pm-markdown/index.ts';
import { defaultConfiguration, parseConfiguration, type FileRecord } from '../packages/pm-schema/index.ts';
import { applyView, groupChange } from '../packages/pm-schema/query.ts';
import { calendarDay, collectTasks, personalDate, safeWorkspaceReturn, taskScope } from '../apps/web/src/features/pm/markdown/task-collection-model.ts';
import { decodeCreationDrafts, newCreationDraft, resumableCreationDraft } from '../apps/web/src/features/pm/markdown/creation-model.ts';

function task(id: string, due: string | null, status = 'todo', extra = ''): FileRecord {
  const raw = `---\nschema: pm/v1\nid: ${id}\nentity: work_item\nproject: PRJ-1\nstatus: ${status}\npriority: medium\n${due ? `due: ${due}\n` : ''}${extra}---\n# ${id}\n`;
  return { id, path: `work_items/${id}.md`, raw, revision: `revision-${id}`, entity: parseMarkdown(raw) };
}

function assignedTask(id: string, due: string | null, status = 'todo', actorId = 'actor-self'): FileRecord {
  return task(id, due, status, `assignee: ${actorId}\n`);
}

test('personal calendar dates respect opposite timezone boundaries and leap/month/year changes', () => {
  const instant = new Date('2024-02-29T00:30:00Z');
  assert.equal(personalDate(instant, 'America/Los_Angeles'), '2024-02-28');
  assert.equal(personalDate(instant, 'Asia/Shanghai'), '2024-02-29');
  assert.equal(personalDate(new Date('2026-12-31T12:30:00Z'), 'Pacific/Kiritimati'), '2027-01-01');
  assert.equal(calendarDay('2024-02-28', 1), '2024-02-29');
  assert.equal(calendarDay('2024-02-28', 7), '2024-03-06');
  assert.equal(calendarDay('2026-12-31', 1), '2027-01-01');
  assert.equal(calendarDay('2026-03-08', 1), '2026-03-09');
  assert.equal(personalDate(new Date('2026-03-09T03:59:59Z'), 'America/New_York'), '2026-03-08');
  assert.equal(personalDate(new Date('2026-03-09T04:00:00Z'), 'America/New_York'), '2026-03-09');
});

test('mine groups only the current assignee into overdue, today, all future or undated, and completed', () => {
  const files = [
    assignedTask('TASK-1', '2024-02-28'), assignedTask('TASK-2', '2024-02-29'),
    assignedTask('TASK-3', '2024-03-01'), assignedTask('TASK-4', null),
    assignedTask('TASK-5', '2024-02-29', 'done'), assignedTask('TASK-6', '2024-02-28', 'canceled'),
    assignedTask('TASK-7', '2030-01-01'), assignedTask('TASK-8', null, 'done'),
    assignedTask('TASK-9', '2024-02-29', 'todo', 'actor-other'), task('TASK-10', '2024-02-29'),
    task('TASK-11', '2024-02-29', 'todo', 'x-pm-created-by: actor-self\n'),
  ];
  const result = collectTasks(files, 'mine', '2024-02-29', new Set(['TASK-9', 'TASK-10']), defaultConfiguration, 'actor-self');
  assert.deepEqual(result.files.map(file => file.id), ['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4', 'TASK-5', 'TASK-7', 'TASK-8']);
  assert.deepEqual(result.groups.map(group => [group.id, group.files.map(file => file.id)]), [
    ['overdue', ['TASK-1']], ['today', ['TASK-2']], ['upcoming', ['TASK-3', 'TASK-4', 'TASK-7']], ['completed', ['TASK-5', 'TASK-8']],
  ]);
  assert.equal(result.groups[1]?.due, '2024-02-29');
  assert.equal(result.canceled.length, 0);
  assert.deepEqual(collectTasks(files, 'mine', '2024-02-29', null, defaultConfiguration, 'actor-other').files.map(file => file.id), ['TASK-9']);
  assert.deepEqual(collectTasks(files, 'mine', '2024-02-29', null, defaultConfiguration, 'actor-absent').files, []);
  assert.equal(collectTasks([], 'mine', '2024-02-29', null, defaultConfiguration, 'actor-self').groups[1]?.due, '2024-02-29');
});

test('mine fails closed for missing actor or unknown and malformed personal dates', () => {
  const files = [assignedTask('TASK-1', '2024-02-29'), assignedTask('TASK-2', null, 'done'), task('TASK-3', null)];
  for (const actor of [null, '', ' ']) {
    assert.deepEqual(collectTasks(files, 'mine', '2024-02-29', null, defaultConfiguration, actor).files, []);
  }
  assert.deepEqual(collectTasks(files, 'mine', '2024-02-29', null, defaultConfiguration).files, []);
  for (const date of [null, '', 'invalid', '2024-02-30', '2023-02-29', '2024-2-29', '2024-02-29T00:00:00Z']) {
    const result = collectTasks(files, 'mine', date, null, defaultConfiguration, 'actor-self');
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.groups.map(group => [group.id, group.files.length]), [['overdue', 0], ['today', 0], ['upcoming', 0], ['completed', 0]]);
  }
});

test('mine uses the actor timezone through DST and year boundaries', () => {
  const instant = new Date('2026-03-09T03:59:59Z');
  const files = [assignedTask('TASK-1', '2026-03-08'), assignedTask('TASK-2', '2026-03-09')];
  const local = collectTasks(files, 'mine', personalDate(instant, 'America/New_York'), null, defaultConfiguration, 'actor-self');
  assert.deepEqual(local.groups.map(group => group.files.map(file => file.id)), [[], ['TASK-1'], ['TASK-2'], []]);
  const next = collectTasks(files, 'mine', personalDate(new Date('2026-03-09T04:00:00Z'), 'America/New_York'), null, defaultConfiguration, 'actor-self');
  assert.deepEqual(next.groups.map(group => group.files.map(file => file.id)), [['TASK-1'], ['TASK-2'], [], []]);
  const year = collectTasks([assignedTask('TASK-3', '2026-12-31'), assignedTask('TASK-4', '2027-01-01'), assignedTask('TASK-5', '2028-01-01')], 'mine', '2027-01-01', null, defaultConfiguration, 'actor-self');
  assert.deepEqual(year.groups.map(group => group.files.map(file => file.id)), [['TASK-3'], ['TASK-4'], ['TASK-5'], []]);
});

test('important intersects visible files with this actor watches; priority never means watched', () => {
  const visible = [task('TASK-1', null), task('TASK-2', null), task('TASK-3', null, 'done'), task('TASK-4', null, 'canceled')];
  visible[1]!.entity.priority = 'urgent';
  const result = collectTasks(visible, 'important', '2026-10-21', new Set(['TASK-1', 'TASK-3', 'TASK-4', 'TASK-99']), defaultConfiguration);
  assert.deepEqual(result.files.map(file => file.id), ['TASK-1', 'TASK-3', 'TASK-4']);
  assert.deepEqual(result.open.map(file => file.id), ['TASK-1']);
  assert.deepEqual(result.completed.map(file => file.id), ['TASK-3']);
  assert.deepEqual(result.canceled.map(file => file.id), ['TASK-4']);
  assert.deepEqual(result.groups.map(group => [group.id, group.files.map(file => file.id)]), [['todo', ['TASK-1']], ['done', ['TASK-3']], ['canceled', ['TASK-4']]]);
  assert.deepEqual(collectTasks(visible, 'important', null, new Set(['TASK-2']), defaultConfiguration).files.map(file => file.id), ['TASK-2']);
  assert.equal(collectTasks(visible, 'important', null, null, defaultConfiguration).files.length, 0);
});

test('shared search/project/filter set remains identical across layouts and scope projection never mutates a view', () => {
  const files = [assignedTask('TASK-1', '2026-10-21'), task('TASK-2', '2026-10-21', 'todo', 'archived: true\nassignee: actor-self\n'), assignedTask('TASK-3', '2026-10-22', 'todo', 'actor-other'), assignedTask('TASK-4', '2026-10-21')];
  files[3]!.entity.project = 'PRJ-2';
  const view = { entity: 'work_item' as const, project: 'PRJ-1', layout: 'kanban' as const, group_by: 'priority', filter: { priority: 'medium' } };
  const serialized = JSON.stringify(view);
  const matching = applyView(files, view, { search: 'TASK', archived: 'exclude', configuration: defaultConfiguration });
  assert.deepEqual(collectTasks(matching, 'mine', '2026-10-21', new Set(['TASK-1']), defaultConfiguration, 'actor-self').files.map(file => file.id), ['TASK-1']);
  const withArchived = applyView(files, view, { search: 'TASK', archived: 'include', configuration: defaultConfiguration });
  assert.deepEqual(collectTasks(withArchived, 'mine', '2026-10-21', null, defaultConfiguration, 'actor-self').files.map(file => file.id), ['TASK-1', 'TASK-2']);
  assert.deepEqual(collectTasks(matching, 'all', '2026-10-21', new Set(), defaultConfiguration).files.map(file => file.id), ['TASK-1', 'TASK-3']);
  collectTasks(matching, 'important', '2026-10-21', new Set(['TASK-1']), defaultConfiguration);
  assert.equal(JSON.stringify(view), serialized);
  assert.equal(serialized.includes('TASK-1'), false);
  assert.deepEqual(groupChange(files[0]!.entity, 'priority', 'urgent', defaultConfiguration), { priority: 'urgent' });
  assert.equal(files[0]!.entity.status, 'todo');
});

test('mine preserves native due ordering and explicit saved sort within its groups', () => {
  const files = [assignedTask('TASK-1', null), assignedTask('TASK-2', '2027-01-01'), assignedTask('TASK-3', '2026-10-22')];
  for (const [sort, expected] of [['due', ['TASK-3', 'TASK-2', 'TASK-1']], ['id', ['TASK-1', 'TASK-2', 'TASK-3']]] as const) {
    const matching = applyView(files, { entity: 'work_item', layout: 'table', sort }, { configuration: defaultConfiguration });
    const result = collectTasks(matching, 'mine', '2026-10-21', null, defaultConfiguration, 'actor-self');
    assert.deepEqual(result.groups.find(group => group.id === 'upcoming')?.files.map(file => file.id), expected);
  }
  assert.deepEqual(files.map(file => file.id), ['TASK-1', 'TASK-2', 'TASK-3']);
});

test('completed and canceled follow configured workflow categories, not hard-coded status IDs', () => {
  const configuration = parseConfiguration({ schema: 'pm/config/v1', workflows: { work_item: { initial: 'queued', states: [{ id: 'queued', label: 'Queued', category: 'unstarted' }, { id: 'shipped', label: 'Shipped', category: 'completed' }, { id: 'withdrawn', label: 'Withdrawn', category: 'canceled' }], transitions: [] } }, custom_fields: [] });
  const files = [assignedTask('TASK-1', '2026-10-21'), assignedTask('TASK-2', '2026-10-21'), assignedTask('TASK-3', '2026-10-21')].map((file, index) => ({ ...file, entity: { ...file.entity, status: ['queued', 'shipped', 'withdrawn'][index]! } }));
  const result = collectTasks(files, 'all', '2026-10-21', new Set(), configuration);
  assert.deepEqual([result.open.length, result.completed.length, result.canceled.length], [1, 1, 1]);
  assert.deepEqual(result.groups.map(group => [group.id, group.label, group.category, group.files.map(file => file.id)]), [
    ['queued', 'Queued', 'unstarted', ['TASK-1']],
    ['shipped', 'Shipped', 'completed', ['TASK-2']],
    ['withdrawn', 'Withdrawn', 'canceled', ['TASK-3']],
  ]);
  const mine = collectTasks(files, 'mine', '2026-10-21', new Set(), configuration, 'actor-self');
  assert.deepEqual(mine.groups.map(group => [group.id, group.files.map(file => file.id)]), [['overdue', []], ['today', ['TASK-1']], ['upcoming', []], ['completed', ['TASK-2']]]);
  assert.deepEqual(mine.files.map(file => file.id), ['TASK-1', 'TASK-2']);
  const unknown = { ...files[0]!, entity: { ...files[0]!.entity, status: 'unconfigured' } };
  assert.deepEqual(collectTasks([unknown], 'mine', '2026-10-21', null, configuration, 'actor-self').open, [unknown]);
  assert.equal(collectTasks([unknown], 'all', null, null, configuration).groups[0]?.id, 'status:unconfigured');
});

test('scope parsing is independent from layout and return URLs cannot escape the workspace', () => {
  assert.equal(taskScope('mine'), 'mine');
  assert.equal(taskScope('today'), 'all');
  assert.equal(taskScope('upcoming'), 'all');
  assert.equal(taskScope(null), 'all');
  assert.equal(taskScope('calendar'), 'all');
  const root = '/pm/current';
  assert.equal(safeWorkspaceReturn('/pm/current/issues?scope=mine&view=calendar', root), '/pm/current/issues?scope=mine&view=calendar');
  assert.equal(safeWorkspaceReturn('/pm/current/projects/PRJ-1?view=detail2#tasks', root), '/pm/current/projects/PRJ-1?view=detail2#tasks');
  for (const input of ['https://evil.invalid/pm/current/issues', '//evil.invalid/pm/current/issues', '/pm/other/issues', '/pm/current/../other/issues', '/pm/current/%2e%2e/other/issues', '/pm/current/\\evil.invalid', '/pm/current/issues/new', '/pm/current/issues/new/', '/pm/current/entities/TASK-1', 'javascript:alert(1)']) assert.equal(safeWorkspaceReturn(input, root), '/pm/current/issues');
});

test('project return preserves its overview tab while rejecting sibling projects and detail loops', () => {
  const root = '/pm/current/projects/PRJ-1';
  assert.equal(safeWorkspaceReturn(`${root}?view=detail2&tab=files`, root), `${root}?view=detail2&tab=files`);
  assert.equal(safeWorkspaceReturn(`${root}#overview`, root), `${root}#overview`);
  assert.equal(safeWorkspaceReturn(`${root}/issues?view=calendar`, root), `${root}/issues?view=calendar`);
  for (const input of ['/pm/current/projects/PRJ-10', '/pm/current/projects/PRJ-2/issues', `${root}/../PRJ-2/issues`, `${root}/%2e%2e/PRJ-2/issues`, `${root}/issues/new`, `${root}/entities/TASK-1`]) {
    assert.equal(safeWorkspaceReturn(input, root), `${root}/issues`);
  }
});

test('mine creation defaults reach native values while recovered assignee and date edits win', () => {
  const draft = newCreationDraft('mine-draft', defaultConfiguration, { entity: 'work_item', project: 'PRJ-1', assignee: 'actor-self', due: '2026-10-21' });
  assert.equal(draft.values.assignee, 'actor-self');
  assert.equal(draft.values.due, '2026-10-21');
  assert.equal(draft.values.status, defaultConfiguration.workflows.work_item?.initial);
  draft.values.assignee = 'actor-other';
  draft.values.due = '2027-01-01';
  const recovered = decodeCreationDrafts(JSON.stringify({ [draft.draftId]: draft }));
  const resumed = resumableCreationDraft(recovered, 'work_item', 'PRJ-1');
  assert.equal(resumed?.draftId, 'mine-draft');
  assert.equal(resumed?.values.assignee, 'actor-other');
  assert.equal(resumed?.values.due, '2027-01-01');
  assert.equal(newCreationDraft('mine-no-project', defaultConfiguration, { assignee: 'actor-self' }).values.project, undefined);
});

test('default workflow exposes a review lane that remains open work', () => {
  const workflow = defaultConfiguration.workflows.work_item!;
  assert.equal(workflow.states.find(state => state.id === 'review')?.category, 'started');
  assert.deepEqual(groupChange(task('TASK-901', null).entity, 'status', 'review', defaultConfiguration), { status: 'review' });
  const result = collectTasks([task('TASK-901', null, 'review')], 'all', null, null, defaultConfiguration);
  assert.deepEqual(result.groups.map(group => group.id), ['review']);
  assert.equal(result.open.length, 1);
  assert.equal(result.completed.length, 0);
  assert.equal(result.canceled.length, 0);
});
