import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from 'yaml';
import { parseMarkdown } from '../../pm-markdown/index.ts';
import { defaultConfiguration, parseConfiguration, ProtocolError, viewSchema, type Entity, type FileRecord, type ProtocolConfiguration, type SavedView, type ViewConfig } from '../../pm-schema/index.ts';
import { applyView, groupChange, queryExpressionSchema, sortRuleSchema, validateView, type QueryExpression } from '../../pm-schema/query.ts';

const configuration = parseConfiguration({ schema: 'pm/config/v1', workflows: {}, custom_fields: [
  { name: 'x-score', label: 'Score', type: 'number', entities: ['work_item'], min: 0, max: 100 },
  { name: 'x-flag', label: 'Flag', type: 'boolean', entities: ['work_item'] },
  { name: 'x-date', label: 'Review date', type: 'date', entities: ['work_item'] },
  { name: 'x-tags', label: 'Tags', type: 'multi_select', entities: ['work_item'], options: ['alpha', 'beta', 'gamma'] },
  { name: 'x-team', label: 'Team', type: 'select', entities: ['work_item'], options: ['red', 'blue'] },
  { name: 'x-ref', label: 'Reference', type: 'reference', entities: ['work_item'], target: 'work_item' },
] });
function record(id: string, metadata: Record<string, unknown> = {}, config: ProtocolConfiguration = configuration): FileRecord {
  const raw = `---\n${stringify({ schema: 'pm/v1', id, entity: 'work_item', ...metadata })}---\n# ${metadata.title ?? id}\n`;
  return { id, path: `entities/${id}.md`, raw, revision: 'fixture', entity: parseMarkdown(raw, config) };
}
function query(files: FileRecord[], where: QueryExpression, rest: Partial<ViewConfig> = {}): string[] {
  return applyView(files, { layout: 'table', entity: 'work_item', ...rest, where }, { configuration }).map((file) => file.id);
}
function rejects(action: () => unknown, field?: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.ok(error.diagnostics.length > 0);
    if (field) assert.ok(error.diagnostics.some((diagnostic) => diagnostic.field === field), JSON.stringify(error.diagnostics));
    return true;
  });
}

test('nested boolean expressions compose with compact scalar and array filters', () => {
  const files = [
    record('TASK-1', { priority: 'high', labels: ['visible'], 'x-score': 10, 'x-flag': false }),
    record('TASK-2', { priority: 'high', labels: ['visible'], 'x-score': 20, 'x-flag': true }),
    record('TASK-3', { priority: 'low', labels: ['visible'], 'x-score': 30 }),
    record('TASK-4', { priority: 'high', labels: ['hidden'], 'x-score': 30 }),
  ];
  const where: QueryExpression = { all: [
    { any: [{ field: 'x-score', op: 'gte', value: 20 }, { field: 'x-flag', op: 'eq', value: false }] },
    { not: { field: 'x-flag', op: 'eq', value: true } },
  ] };
  assert.deepEqual(query(files, where, { filter: { priority: 'high', labels: 'visible' } }), ['TASK-1']);
  assert.deepEqual(query(files, { all: [] }), ['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4']);
  assert.deepEqual(query(files, { any: [] }), []);
});

test('numbers, dates, booleans and registered arrays retain native types', () => {
  const files = [
    record('TASK-1', { 'x-score': 2, 'x-date': '2028-02-29', 'x-flag': false, 'x-tags': ['alpha', 'beta'] }),
    record('TASK-2', { 'x-score': 10, 'x-date': '2028-03-01', 'x-flag': true, 'x-tags': ['beta', 'alpha'] }),
    record('TASK-3', { 'x-score': 20, 'x-date': '2028-03-10', 'x-tags': [] }),
  ];
  assert.deepEqual(query(files, { field: 'x-score', op: 'gt', value: 2 }), ['TASK-2', 'TASK-3']);
  assert.deepEqual(query(files, { field: 'x-score', op: 'lte', value: 10 }), ['TASK-1', 'TASK-2']);
  assert.deepEqual(query(files, { field: 'x-date', op: 'lt', value: '2028-03-01' }), ['TASK-1']);
  assert.deepEqual(query(files, { field: 'x-flag', op: 'eq', value: false }), ['TASK-1']);
  assert.deepEqual(query(files, { field: 'x-tags', op: 'contains', value: 'alpha' }), ['TASK-1', 'TASK-2']);
  assert.deepEqual(query(files, { field: 'x-tags', op: 'eq', value: ['alpha', 'beta'] }), ['TASK-1']);
  assert.deepEqual(query(files, { field: 'x-tags', op: 'ne', value: [] }), ['TASK-1', 'TASK-2']);
  assert.deepEqual(query(files, { field: 'x-score', op: 'in', value: [2, 20] }), ['TASK-1', 'TASK-3']);
  assert.deepEqual(query(files, { field: 'x-score', op: 'not_in', value: [2, 20] }), ['TASK-2']);
  assert.deepEqual(query(files, { field: 'x-score', op: 'in', value: [] }), []);
  assert.deepEqual(query(files, { field: 'x-score', op: 'not_in', value: [] }), ['TASK-1', 'TASK-2', 'TASK-3']);
  assert.deepEqual(applyView(files, { layout: 'table', filter: { 'x-flag': false, 'x-score': 2 } }, { configuration }).map((file) => file.id), ['TASK-1']);
});

test('missing values are distinct from false, zero and empty arrays', () => {
  const files = [record('TASK-1'), record('TASK-2', { 'x-flag': false, 'x-score': 0, 'x-tags': [] }), record('TASK-3', { 'x-flag': true, 'x-score': 4 })];
  assert.deepEqual(query(files, { field: 'x-flag', op: 'exists' }), ['TASK-2', 'TASK-3']);
  assert.deepEqual(query(files, { field: 'x-flag', op: 'exists', value: false }), ['TASK-1']);
  assert.deepEqual(query(files, { field: 'x-flag', op: 'eq', value: null }), ['TASK-1']);
  assert.deepEqual(query(files, { field: 'x-flag', op: 'ne', value: null }), ['TASK-2', 'TASK-3']);
  assert.deepEqual(query(files, { field: 'x-flag', op: 'ne', value: true }), ['TASK-2']);
  assert.deepEqual(query(files, { field: 'x-score', op: 'not_in', value: [4] }), ['TASK-2']);
  assert.deepEqual(query(files, { field: 'x-tags', op: 'exists' }), ['TASK-2']);
  assert.deepEqual(query(files, { not: { field: 'x-score', op: 'gt', value: 0 } }), ['TASK-1', 'TASK-2']);
});

test('semantic validation rejects coercions, illegal operators and invalid calendar dates', () => {
  const invalid: QueryExpression[] = [
    { field: 'x-score', op: 'eq', value: '10' }, { field: 'x-flag', op: 'eq', value: 'false' },
    { field: 'x-score', op: 'in', value: [10, '20'] }, { field: 'x-flag', op: 'gt', value: true },
    { field: 'x-score', op: 'contains', value: 1 }, { field: 'x-tags', op: 'eq', value: 'alpha' },
    { field: 'x-tags', op: 'in', value: ['alpha'] }, { field: 'x-date', op: 'eq', value: '2026-02-29' },
    { field: 'due', op: 'gte', value: 'tomorrow' }, { field: 'priority', op: 'eq', value: 'critical' },
    { field: 'project', op: 'eq', value: 'not-an-id' }, { field: 'id', op: 'eq', value: null },
    { field: 'x-team', op: 'eq', value: 'green' }, { field: 'x-tags', op: 'contains', value: 'delta' },
  ];
  for (const where of invalid) rejects(() => validateView({ layout: 'table', entity: 'work_item', where }, configuration));
});

test('unknown, derived and inapplicable fields never silently pass', () => {
  for (const field of ['unknown', 'x-unregistered', 'progress', 'revision', 'views', '__proto__']) {
    rejects(() => validateView({ layout: 'table', where: { field, op: 'exists' } }, configuration), field);
    rejects(() => validateView({ layout: 'table', sort: field }, configuration), field);
    rejects(() => validateView({ layout: 'table', columns: [field] }, configuration), field);
  }
  rejects(() => validateView({ layout: 'table', entity: 'document', filter: { priority: 'high' } }, configuration), 'priority');
  rejects(() => validateView({ layout: 'table', entity: 'project', filter: { 'x-score': 3 } }, configuration), 'x-score');
  rejects(() => validateView({ layout: 'table', sort: 'labels' }, configuration), 'labels');
  rejects(() => validateView({ layout: 'table', order_by: [{ field: 'title', direction: 'asc' }, { field: 'title', direction: 'desc' }] }, configuration));
  rejects(() => validateView({ layout: 'table', columns: ['title', 'title'] }, configuration));
});

test('bounded structural schemas reject deep, wide, cyclic and non-JSON inputs without recursive descent', () => {
  const leaf: QueryExpression = { field: 'title', op: 'eq', value: 'A' };
  let depth16: QueryExpression = leaf;
  for (let index = 1; index < 16; index++) depth16 = { not: depth16 };
  assert.equal(queryExpressionSchema.safeParse(depth16).success, true);
  assert.equal(queryExpressionSchema.safeParse({ not: depth16 }).success, false);
  assert.equal(queryExpressionSchema.safeParse({ all: Array.from({ length: 255 }, () => leaf) }).success, true);
  assert.equal(queryExpressionSchema.safeParse({ all: Array.from({ length: 256 }, () => leaf) }).success, false);
  const cyclic: { not?: unknown } = {}; cyclic.not = cyclic;
  for (const value of [cyclic, { field: 'title', op: 'regex', value: '.*' }, { ...leaf, ignored: true },
    { all: [], any: [] }, { field: 'title', op: 'eq' }, { field: 'title', op: 'eq', value: undefined },
    { field: 'title', op: 'eq', value: { object: true } }, { field: 'x-score', op: 'eq', value: Number.NaN },
    { field: 'x-score', op: 'eq', value: Infinity }, { field: 'title', op: 'in', value: Array(257).fill('a') },
    { field: 'title', op: 'exists', value: 'false' }]) assert.equal(queryExpressionSchema.safeParse(value).success, false);
  assert.equal(sortRuleSchema.safeParse({ field: 'title', direction: 'asc', ignored: true }).success, false);
  rejects(() => validateView({ layout: 'table', wher: leaf } as unknown as ViewConfig, configuration));
  rejects(() => validateView({ layout: 'table', where: cyclic } as unknown as ViewConfig, configuration));
});

test('multisort is numeric, stable by ID, and keeps missing values last in both directions', () => {
  const files = [record('TASK-4'), record('TASK-3', { 'x-score': 10, 'x-flag': true }),
    record('TASK-2', { 'x-score': 2, 'x-flag': true }), record('TASK-1', { 'x-score': 10, 'x-flag': false }),
    record('TASK-0', { 'x-score': 10, 'x-flag': true })];
  const view: ViewConfig = { layout: 'table', order_by: [{ field: 'x-score', direction: 'desc' }, { field: 'x-flag', direction: 'asc' }] };
  const original = files.map((file) => file.id);
  assert.deepEqual(applyView(files, view, { configuration }).map((file) => file.id), ['TASK-1', 'TASK-0', 'TASK-3', 'TASK-2', 'TASK-4']);
  assert.deepEqual(applyView([...files].reverse(), view, { configuration }).map((file) => file.id), ['TASK-1', 'TASK-0', 'TASK-3', 'TASK-2', 'TASK-4']);
  assert.deepEqual(applyView(files, { layout: 'table', sort: 'x-score' }, { configuration }).map((file) => file.id), ['TASK-2', 'TASK-0', 'TASK-1', 'TASK-3', 'TASK-4']);
  assert.deepEqual(files.map((file) => file.id), original);
});

test('compact sort remains a secondary key alongside explicit multisort', () => {
  const files = [record('TASK-1', { title: 'Zulu', priority: 'low', status: 'todo' }),
    record('TASK-2', { title: 'Alpha', priority: 'urgent', status: 'done' }), record('TASK-3', { title: 'Beta', priority: 'urgent', status: 'todo' })];
  assert.deepEqual(applyView(files, { layout: 'table', sort: 'priority' }).map((file) => file.id), ['TASK-2', 'TASK-3', 'TASK-1']);
  assert.deepEqual(applyView(files, { layout: 'table', order_by: [{ field: 'status', direction: 'asc' }], sort: 'title' }).map((file) => file.id), ['TASK-3', 'TASK-1', 'TASK-2']);
});

test('filtered manual order retains hidden and archived IDs without changing saved data', () => {
  const files = [record('TASK-1', { title: 'Alpha', priority: 'high' }), record('TASK-2', { title: 'Beta', priority: 'low' }),
    record('TASK-3', { title: 'Gamma', priority: 'high', archived: true }), record('TASK-4', { title: 'Delta', priority: 'high' }), record('TASK-5', { title: 'Epsilon', priority: 'high' })];
  const view: SavedView = { id: 'ordered', name: 'Ordered', revision: 'sha', layout: 'table', filter: { priority: 'high' },
    order: ['TASK-3', 'TASK-2', 'TASK-4'], sort: 'title' };
  const before = structuredClone(view);
  assert.deepEqual(applyView(files, view).map((file) => file.id), ['TASK-4', 'TASK-1', 'TASK-5']);
  assert.deepEqual(applyView(files, view, { archived: 'include' }).map((file) => file.id), ['TASK-3', 'TASK-4', 'TASK-1', 'TASK-5']);
  assert.deepEqual(applyView(files, view, { archived: 'only' }).map((file) => file.id), ['TASK-3']);
  assert.deepEqual(applyView(files, { ...view, filter: {} }, { archived: 'include' }).map((file) => file.id), ['TASK-3', 'TASK-2', 'TASK-4', 'TASK-1', 'TASK-5']);
  assert.deepEqual(view, before);
  rejects(() => validateView({ layout: 'table', order: ['TASK-1', 'TASK-1'] }));
  rejects(() => validateView({ layout: 'table', order: ['bad-id'] }));
});

test('all-kind queries, project scope, text search and applicability share one evaluator', () => {
  const files = [record('PRJ-1', { entity: 'project', title: 'Project' }),
    record('TASK-1', { project: 'PRJ-1', title: 'Important work', labels: ['searchable'], priority: 'high' }),
    record('TASK-2', { project: 'PRJ-2', title: 'Other work' }), record('DOC-1', { entity: 'document', project: 'PRJ-1' })];
  assert.deepEqual(applyView(files, { layout: 'table' }).map((file) => file.id), ['DOC-1', 'PRJ-1', 'TASK-1', 'TASK-2']);
  assert.deepEqual(applyView(files, { layout: 'table', project: 'PRJ-1' }).map((file) => file.id), ['DOC-1', 'PRJ-1', 'TASK-1']);
  assert.deepEqual(applyView(files, { layout: 'table', filter: { priority: 'high' } }).map((file) => file.id), ['TASK-1']);
  assert.deepEqual(applyView(files, { layout: 'table' }, { search: 'SEARCHABLE' }).map((file) => file.id), ['TASK-1']);
  const documentWithLegacyMetadata = { ...files[3], entity: { ...files[3].entity, 'x-score': 50 } };
  assert.deepEqual(applyView([documentWithLegacyMetadata], { layout: 'table', where: { field: 'x-score', op: 'eq', value: 50 } }, { configuration }), []);
});

test('group writes preserve native scalar values and optional clearing without mutation', () => {
  const entity = record('TASK-1', { assignee: 'Ada', 'x-team': 'red', 'x-score': 2 }).entity;
  const before = structuredClone(entity);
  for (const [field, value] of [['assignee', null], ['x-team', 'blue'], ['x-team', null], ['x-score', 20], ['x-flag', false],
    ['x-date', '2028-02-29'], ['x-ref', 'TASK-2'], ['priority', 'urgent'], ['title', 'New title']] as const) {
    assert.deepEqual(groupChange(entity, field, value, configuration), { [field]: value });
  }
  assert.deepEqual(entity, before);
});

test('invalid grouping fails before a patch can be applied', () => {
  const entity = record('TASK-1').entity;
  const before = structuredClone(entity);
  for (const field of ['id', 'schema', 'entity', 'body', 'progress', 'labels', 'blocked_by', 'x-tags', 'x-unknown']) {
    rejects(() => groupChange(entity, field, 'anything', configuration), field);
    rejects(() => validateView({ layout: 'kanban', group_by: field }, configuration), field);
  }
  for (const [field, value] of [['x-score', '2'], ['x-score', 101], ['x-flag', 'false'], ['x-team', 'green'], ['x-date', '2026-02-29'],
    ['x-ref', 'bad-id'], ['status', null], ['priority', null], ['archived', null], ['title', null], ['title', 'Two\nlines'], ['assignee', '']] as const) {
    rejects(() => groupChange(entity, field, value, configuration), field);
  }
  const project = record('PRJ-1', { entity: 'project', start: '2026-10-10', due: '2026-10-20' }).entity;
  rejects(() => groupChange(project, 'due', '2026-10-01', configuration), 'due');
  rejects(() => groupChange(project, 'x-score', 5, configuration), 'x-score');
  rejects(() => groupChange({ ...entity, schema: 'pm/v2' } as unknown as Entity, 'assignee', 'Ada', configuration));
  assert.deepEqual(entity, before);
});

test('grouped status writes honor configured transitions and required custom fields', () => {
  const candidate = structuredClone(defaultConfiguration);
  candidate.workflows.work_item!.transitions = [];
  candidate.custom_fields = [{ name: 'x-required', label: 'Required', type: 'text', entities: ['work_item'], required: true, min: 3, max: 10 }];
  const locked = parseConfiguration(candidate);
  const entity = record('TASK-1', { 'x-required': 'present' }, locked).entity;
  assert.deepEqual(groupChange(entity, 'status', entity.status, locked), { status: entity.status });
  rejects(() => groupChange(entity, 'status', 'done', locked));
  rejects(() => groupChange(entity, 'x-required', null, locked), 'x-required');
  rejects(() => groupChange(entity, 'x-required', 'ab', locked), 'x-required');
  rejects(() => groupChange(entity, 'x-required', 'too long for field', locked), 'x-required');
});

test('configured workflow ordering and date ordering are shared with the browser evaluator', () => {
  const configured = structuredClone(configuration);
  configured.workflows.work_item = {
    initial: 'queued',
    states: [{ id: 'queued', label: 'Queued', category: 'unstarted' }, { id: 'running', label: 'Running', category: 'started' },
      { id: 'shipped', label: 'Shipped', category: 'completed' }],
    transitions: [{ from: 'queued', to: 'running' }, { from: 'running', to: 'shipped' }],
  };
  const workflowConfig = parseConfiguration(configured);
  const files = [record('TASK-1', { status: 'shipped', 'x-date': '2028-03-01' }, workflowConfig),
    record('TASK-2', { status: 'queued', 'x-date': '2028-02-29' }, workflowConfig),
    record('TASK-3', { status: 'running' }, workflowConfig)];
  assert.deepEqual(applyView(files, { layout: 'table', sort: 'status' }, { configuration: workflowConfig }).map((file) => file.id),
    ['TASK-2', 'TASK-3', 'TASK-1']);
  assert.deepEqual(applyView(files, { layout: 'table', filter: { status: 'running' } }, { configuration: workflowConfig }).map((file) => file.id), ['TASK-3']);
  assert.deepEqual(applyView(files, { layout: 'table', order_by: [{ field: 'x-date', direction: 'desc' }] }, { configuration: workflowConfig }).map((file) => file.id),
    ['TASK-1', 'TASK-2', 'TASK-3']);
  assert.deepEqual(groupChange(files[1].entity, 'status', 'running', workflowConfig), { status: 'running' });
  rejects(() => groupChange(files[1].entity, 'status', 'shipped', workflowConfig), 'status');
  rejects(() => validateView({ layout: 'table', entity: 'work_item', filter: { status: 'todo' } }, workflowConfig), 'status');
});

test('formal numeric and reference fields on new entity kinds use the same semantics', () => {
  const files = [record('GOAL-1', { entity: 'goal', target: 2 }), record('GOAL-2', { entity: 'goal', target: 10 }),
    record('TASK-1', { cycle: 'CYC-1', goals: ['GOAL-1'] })];
  assert.deepEqual(applyView(files, { layout: 'table', entity: 'goal', where: { field: 'target', op: 'gte', value: 3 } }).map((file) => file.id), ['GOAL-2']);
  assert.deepEqual(applyView(files, { layout: 'table', filter: { cycle: 'CYC-1', goals: 'GOAL-1' } }).map((file) => file.id), ['TASK-1']);
  assert.deepEqual(groupChange(files[0].entity, 'target', 20), { target: 20 });
  assert.deepEqual(groupChange(files[2].entity, 'cycle', null), { cycle: null });
  rejects(() => groupChange(files[2].entity, 'goals', ['GOAL-2']), 'goals');
});

test('numeric predicate thresholds are independent of custom-field assignment bounds', () => {
  const files = [record('TASK-1', { 'x-score': 0 }), record('TASK-2', { 'x-score': 100 })];
  assert.deepEqual(query(files, { all: [{ field: 'x-score', op: 'gt', value: -1 }, { field: 'x-score', op: 'lt', value: 101 }] }), ['TASK-1', 'TASK-2']);
  assert.deepEqual(query(files, { field: 'x-score', op: 'eq', value: 101 }), []);
  assert.deepEqual(query(files, { field: 'x-score', op: 'in', value: [-1, 100, 101] }), ['TASK-2']);
  assert.deepEqual(applyView(files, { layout: 'table', filter: { 'x-score': -1 } }, { configuration }), []);
  rejects(() => groupChange(files[0].entity, 'x-score', -1, configuration), 'x-score');
  rejects(() => groupChange(files[0].entity, 'x-score', 101, configuration), 'x-score');
});

test('original JSON and YAML compact-filter keys cannot disappear and broaden a query', () => {
  const files = [record('TASK-1')];
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const yaml = `layout: table\nfilter:\n  ${key}: forbidden\n`;
    const inputs: ViewConfig[] = [JSON.parse(`{"layout":"table","filter":{"${key}":"forbidden"}}`), parse(yaml)];
    for (const input of inputs) {
      assert.equal(Object.prototype.hasOwnProperty.call(input.filter, key), true);
      assert.equal(viewSchema.safeParse(input).success, false);
      rejects(() => validateView(input, configuration));
      rejects(() => applyView(files, input, { configuration }));
      const saved: SavedView = { ...input, id: 'unsafe-view', name: 'Unsafe', revision: 'current' };
      rejects(() => validateView(saved, configuration));
      rejects(() => applyView(files, saved, { configuration }));
    }
    const embedded = `${files[0].raw}\n\`\`\`pm-view\n${yaml}\`\`\`\n`;
    rejects(() => parseMarkdown(embedded, configuration));
  }
});
