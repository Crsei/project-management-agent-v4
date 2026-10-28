import test from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { createMarkdown, inspectMarkdown, parseMarkdown, patchMarkdown } from '../../pm-markdown/index.ts';
import { defaultConfiguration, diagnosticsOf, documentSchema, entityDefinitions, entityKinds, entitySchema, fieldRegistry, parseConfiguration, projectSchema, protocolInfo, ProtocolError, statusCategory, validateTransition, workflowFor, workItemSchema, type EntityKind, type FileRecord, type ProtocolConfiguration } from '../../pm-schema/index.ts';
import { referenceEntries, relationFields, resolveReference, validateRelations } from '../../pm-schema/relations.ts';

function raw(metadata: Record<string, unknown>, body = '# Protocol fixture\n'): string {
  return `---\n${stringify({ schema: 'pm/v1', id: 'TASK-1', entity: 'work_item', ...metadata })}---\n${body}`;
}
function record(id: string, metadata: Record<string, unknown> = {}, body?: string): FileRecord {
  const source = raw({ id, ...metadata }, body);
  return { id, path: `entities/${id}.md`, raw: source, revision: 'fixture', entity: parseMarkdown(source) };
}
function rejects(action: () => unknown, code: string, field?: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.ok(error.diagnostics.some((diagnostic) => diagnostic.code === code && (!field || diagnostic.field === field)), JSON.stringify(error.diagnostics));
    return true;
  });
}

const project = () => record('PRJ-1', { entity: 'project' });

test('per-entity schemas apply distinct defaults and retain unknown metadata', () => {
  const task = record('TASK-1').entity;
  const prj = project().entity;
  const doc = record('ADR-1', { entity: 'document', legacy: { untouched: true } }).entity;
  assert.equal(workItemSchema.safeParse(task).success, true);
  assert.equal(projectSchema.safeParse(prj).success, true);
  assert.equal(documentSchema.safeParse(doc).success, true);
  assert.equal(task.status, 'todo');
  assert.equal(task.kind, 'task');
  assert.equal(task.priority, 'medium');
  assert.equal(prj.status, 'planned');
  assert.equal(prj.priority, undefined);
  assert.equal(doc.status, undefined);
  assert.equal(doc.document_kind, 'note');
  assert.deepEqual(doc.legacy, { untouched: true });
  for (const entity of [task, prj, doc]) {
    assert.equal(entity.archived, false);
    assert.deepEqual(entity.blocked_by, []);
    assert.deepEqual(entity.labels, []);
    assert.deepEqual(entity.related_to, []);
  }
});

test('registry declares all sources, null semantics, and entity applicability as serializable data', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(protocolInfo)).fields, fieldRegistry);
  assert.equal(new Set(fieldRegistry.map(({ name }) => name)).size, fieldRegistry.length);
  for (const kind of entityKinds) {
    for (const definition of fieldRegistry) {
      if (definition.source !== 'yaml' || definition.entities.includes(kind)) continue;
      rejects(() => parseMarkdown(raw({ entity: kind, [definition.name]: [] })), 'FIELD_NOT_APPLICABLE', definition.name);
      rejects(() => patchMarkdown(raw({ entity: kind }), { [definition.name]: null }), 'FIELD_NOT_APPLICABLE', definition.name);
    }
  }
});

test('each entity rejects fields and workflows from other entity kinds', () => {
  rejects(() => parseMarkdown(raw({ entity: 'project', status: 'in_progress' })), 'SCHEMA_VALIDATION', 'status');
  rejects(() => parseMarkdown(raw({ status: 'active' })), 'SCHEMA_VALIDATION', 'status');
  rejects(() => parseMarkdown(raw({ entity: 'document', status: 'done' })), 'FIELD_NOT_APPLICABLE', 'status');
  rejects(() => parseMarkdown(raw({ entity: 'project', blocked_by: [] })), 'FIELD_NOT_APPLICABLE', 'blocked_by');
  rejects(() => parseMarkdown(raw({ entity: 'document', document_kind: 'task' })), 'SCHEMA_VALIDATION', 'document_kind');
  rejects(() => parseMarkdown(raw({ archived: 'true' })), 'SCHEMA_VALIDATION', 'archived');
});

test('calendar dates and project date ordering are enforced', () => {
  rejects(() => parseMarkdown(raw({ entity: 'project', start: '2026-02-30' })), 'SCHEMA_VALIDATION', 'start');
  rejects(() => parseMarkdown(raw({ entity: 'project', start: '2026-10-20', due: '2026-10-19' })), 'SCHEMA_VALIDATION', 'start');
  assert.equal(parseMarkdown(raw({ entity: 'project', start: '2028-02-29', due: '2028-02-29' })).start, '2028-02-29');
});

test('task start dates use one registered field with calendar and range validation on parse/create/patch', () => {
  assert.equal(fieldRegistry.find(field => field.name === 'x-pm-start')?.type, 'date');
  for (const date of ['2028-02-29', '2026-12-31']) {
    assert.equal(parseMarkdown(raw({ 'x-pm-start': date, due: date }))['x-pm-start'], date);
    assert.equal(parseMarkdown(createMarkdown({ id: 'TASK-2', title: 'Scheduled', 'x-pm-start': date, due: date }))['x-pm-start'], date);
    assert.equal(parseMarkdown(patchMarkdown(raw({ due: date }), { 'x-pm-start': date }))['x-pm-start'], date);
  }
  for (const date of ['2027-02-29', '2028-04-31', '2028-02-29T00:00:00Z', '', 2028, null]) {
    rejects(() => parseMarkdown(raw({ 'x-pm-start': date })), 'SCHEMA_VALIDATION', 'x-pm-start');
    if (date !== null) rejects(() => patchMarkdown(raw({}), { 'x-pm-start': date }), 'SCHEMA_VALIDATION', 'x-pm-start');
    rejects(() => createMarkdown({ id: 'TASK-2', title: 'Invalid date', 'x-pm-start': date }), 'SCHEMA_VALIDATION', 'x-pm-start');
  }
  rejects(() => parseMarkdown(raw({ 'x-pm-start': '2028-03-01', due: '2028-02-29' })), 'SCHEMA_VALIDATION', 'x-pm-start');
  rejects(() => createMarkdown({ id: 'TASK-2', title: 'Invalid range', 'x-pm-start': '2028-03-01', due: '2028-02-29' }), 'SCHEMA_VALIDATION', 'x-pm-start');
  rejects(() => patchMarkdown(raw({ 'x-pm-start': '2028-03-01' }), { due: '2028-02-29' }), 'SCHEMA_VALIDATION', 'x-pm-start');
  assert.equal(parseMarkdown(patchMarkdown(raw({ 'x-pm-start': '2028-03-01' }), { 'x-pm-start': null, due: '2028-02-29' }))['x-pm-start'], undefined);
  assert.equal(parseMarkdown(raw({ due: '2028-02-29' }))['x-pm-start'], undefined);
  rejects(() => parseMarkdown(raw({ start: '2028-02-29' })), 'FIELD_NOT_APPLICABLE', 'start');
  rejects(() => parseConfiguration({ schema: 'pm/config/v1', custom_fields: [{ name: 'x-pm-start', label: 'Cannot shadow schedule', type: 'text', entities: ['work_item'] }] }), 'CONFIGURATION_INVALID');
});

test('task location trims only incoming writes, clears explicitly and preserves unrelated Markdown and extension data', () => {
  const source = raw({ labels: ['retained'], parent: 'TASK-9', 'x-custom': { nested: ['value'] } }, '# Location\n\n[[DOC-1]]\n\n```pm-view\nentity: work_item\nlayout: table\n```\n');
  const patched = patchMarkdown(source, { 'x-pm-location': '  Room 12: East #desk  ' });
  const entity = parseMarkdown(patched);
  assert.equal(entity['x-pm-location'], 'Room 12: East #desk');
  assert.equal(entity.body, parseMarkdown(source).body);
  assert.deepEqual(entity.labels, ['retained']);
  assert.equal(entity.parent, 'TASK-9');
  assert.deepEqual(entity['x-custom'], { nested: ['value'] });
  for (const empty of ['', ' \n ', null]) assert.equal(parseMarkdown(patchMarkdown(patched, { 'x-pm-location': empty }))['x-pm-location'], undefined);
  assert.equal(parseMarkdown(createMarkdown({ id: 'TASK-2', title: 'Place', 'x-pm-location': '  Room 12  ' }))['x-pm-location'], 'Room 12');
  assert.equal(parseMarkdown(createMarkdown({ id: 'TASK-2', title: 'No place', 'x-pm-location': null }))['x-pm-location'], undefined);
  assert.equal(parseMarkdown(createMarkdown({ id: 'TASK-2', title: 'Maximum place', 'x-pm-location': 'a'.repeat(1000) }))['x-pm-location'], 'a'.repeat(1000));
  for (const value of [100, false, [], {}, 'a'.repeat(1001)]) {
    rejects(() => parseMarkdown(raw({ 'x-pm-location': value })), 'SCHEMA_VALIDATION', 'x-pm-location');
    rejects(() => patchMarkdown(source, { 'x-pm-location': value }), 'SCHEMA_VALIDATION', 'x-pm-location');
    rejects(() => createMarkdown({ id: 'TASK-2', title: 'Invalid place', 'x-pm-location': value }), 'SCHEMA_VALIDATION', 'x-pm-location');
  }
  for (const value of ['', ' untrimmed ', null]) rejects(() => parseMarkdown(raw({ 'x-pm-location': value })), 'SCHEMA_VALIDATION', 'x-pm-location');
  rejects(() => parseConfiguration({ schema: 'pm/config/v1', custom_fields: [{ name: 'x-pm-location', label: 'Cannot shadow location', type: 'number', entities: ['work_item'] }] }), 'CONFIGURATION_INVALID');
});

test('null removes optional metadata, omitted properties stay unchanged, arrays explicitly clear', () => {
  const source = raw({ status: 'done', assignee: 'human', labels: ['a'], archived: true });
  const changed = parseMarkdown(patchMarkdown(source, { status: null, assignee: null, labels: [], archived: null }));
  assert.equal(changed.status, 'todo');
  assert.equal(changed.assignee, undefined);
  assert.equal(changed.archived, false);
  assert.deepEqual(changed.labels, []);
  assert.equal(parseMarkdown(patchMarkdown(source, { labels: [] })).status, 'done');
  for (const name of ['id', 'schema', 'entity']) rejects(() => patchMarkdown(source, { [name]: null }), 'IMMUTABLE_FIELD', name);
  rejects(() => patchMarkdown(source, { title: null }), 'SCHEMA_VALIDATION', 'title');
});

test('computed properties cannot be injected through YAML, patch, or create', () => {
  for (const name of ['body', 'links', 'checklist', 'views', 'revision', 'path', 'children', 'blocks', 'backlinks', 'progress']) {
    rejects(() => parseMarkdown(raw({ [name]: [] })), 'DERIVED_FIELD', name);
    rejects(() => patchMarkdown(raw({}), { [name]: null }), 'DERIVED_FIELD', name);
    if (name !== 'body') rejects(() => createMarkdown({ id: 'TASK-2', title: 'Create', [name]: [] }), 'DERIVED_FIELD', name);
  }
  assert.ok(parseMarkdown(createMarkdown({ id: 'TASK-2', title: 'Create', body: 'Real body' })).body.includes('Real body'));
});

test('existing extensions survive and new structured extensions require x- prefix', () => {
  const source = raw({ custom: { count: 1 }, 'x-flags': ['a'] }, '# Title\n\nUnmodified body  \n');
  const patched = patchMarkdown(source, { custom: { count: 2 }, 'x-new': { enabled: true } });
  assert.deepEqual(parseMarkdown(patched).custom, { count: 2 });
  assert.deepEqual(parseMarkdown(patched)['x-new'], { enabled: true });
  assert.equal(parseMarkdown(patched).body, parseMarkdown(source).body);
  assert.equal(parseMarkdown(patchMarkdown(source, { custom: null })).custom, undefined);
  rejects(() => patchMarkdown(source, { unknown: true }), 'UNKNOWN_FIELD', 'unknown');
  rejects(() => createMarkdown({ id: 'TASK-2', title: 'Create', unknown: true }), 'UNKNOWN_FIELD', 'unknown');
  assert.deepEqual(parseMarkdown(createMarkdown({ id: 'TASK-2', title: 'Create', 'x-new': { enabled: true } }))['x-new'], { enabled: true });
});

test('native workload estimates are bounded numbers, preserve unknown, and clear without turning into zero', () => {
  assert.equal(parseMarkdown(raw({}))['x-pm-estimate'], undefined);
  for (const estimate of [0, 0.25, 10, 1_000_000]) {
    assert.equal(parseMarkdown(raw({ 'x-pm-estimate': estimate }))['x-pm-estimate'], estimate);
    assert.equal(parseMarkdown(createMarkdown({ id: 'TASK-2', title: 'Estimated task', 'x-pm-estimate': estimate }))['x-pm-estimate'], estimate);
    assert.equal(parseMarkdown(patchMarkdown(raw({}), { 'x-pm-estimate': estimate }))['x-pm-estimate'], estimate);
  }
  const source = raw({ 'x-pm-estimate': 8 });
  assert.equal(parseMarkdown(patchMarkdown(source, { 'x-pm-estimate': null }))['x-pm-estimate'], undefined);
  for (const estimate of [-1, 1_000_001, NaN, Infinity, -Infinity, '8', '', false, null, {}, []]) {
    rejects(() => parseMarkdown(raw({ 'x-pm-estimate': estimate })), 'SCHEMA_VALIDATION', 'x-pm-estimate');
    if (estimate !== null) rejects(() => patchMarkdown(raw({}), { 'x-pm-estimate': estimate }), 'SCHEMA_VALIDATION', 'x-pm-estimate');
    rejects(() => createMarkdown({ id: 'TASK-2', title: 'Invalid estimate', 'x-pm-estimate': estimate }), 'SCHEMA_VALIDATION', 'x-pm-estimate');
  }
  rejects(() => patchMarkdown(raw({ entity: 'project', id: 'PRJ-1' }), { 'x-pm-estimate': 1 }), 'FIELD_NOT_APPLICABLE', 'x-pm-estimate');
  rejects(() => parseConfiguration({ schema: 'pm/config/v1', custom_fields: [{ name: 'x-pm-estimate', label: 'Cannot weaken the estimate contract', type: 'text', entities: ['work_item'] }] }), 'CONFIGURATION_INVALID');
});

test('unsupported schema inspection preserves identity without current-version interpretation', () => {
  const source = raw({ schema: 'pm/v2', id: 'NEXT-1', entity: 'new_kind', status: { future: true }, links: 'future representation' }, 'No v1 heading required.\n');
  assert.deepEqual(inspectMarkdown(source), { id: 'NEXT-1', schema: 'pm/v2' });
  rejects(() => parseMarkdown(source), 'UNSUPPORTED_SCHEMA_VERSION', 'schema');
  rejects(() => patchMarkdown(source, { schema: 'pm/v1' }), 'UNSUPPORTED_SCHEMA_VERSION', 'schema');
  rejects(() => patchMarkdown(source, {}), 'UNSUPPORTED_SCHEMA_VERSION', 'schema');
  assert.deepEqual(inspectMarkdown('---\nid: NEXT-2\nschema: pm/v3\nbroken: [\n---\n'), { id: 'NEXT-2', schema: 'pm/v3' });
  assert.deepEqual(inspectMarkdown('---\r\nschema: pm/v3\r\nid: NEXT-3\r\nbroken: [\r\n---\r\n'), { id: 'NEXT-3', schema: 'pm/v3' });
  assert.deepEqual(inspectMarkdown('not frontmatter'), {});
});

test('diagnostics normalize expected and unexpected failures without losing field details', () => {
  rejects(() => parseMarkdown('# Missing frontmatter'), 'YAML_SYNTAX');
  rejects(() => parseMarkdown(raw({}, 'No H1')), 'TITLE_MISSING', 'title');
  const diagnostic = { code: 'REFERENCE_TYPE', severity: 'error' as const, path: '', field: 'parent', targetId: 'PRJ-1', message: 'Wrong kind' };
  assert.deepEqual(diagnosticsOf(new ProtocolError([diagnostic]), { path: 'task.md', entityId: 'TASK-1' }), [{ ...diagnostic, path: 'task.md', entityId: 'TASK-1' }]);
  assert.equal(diagnosticsOf(new Error('Failure'))[0].code, 'VALIDATION_ERROR');
});

test('relationships accept valid typed references including archived and cross-project blocking', () => {
  const files = [project(), record('PRJ-2', { entity: 'project', archived: true }),
    record('TASK-1', { project: 'PRJ-1' }), record('TASK-2', { project: 'PRJ-1', parent: 'TASK-1', blocked_by: ['TASK-3'] }),
    record('TASK-3', { project: 'PRJ-2', archived: true }), record('ADR-1', { entity: 'document', project: 'PRJ-1', related_to: ['TASK-2', 'PRJ-2'] })];
  assert.deepEqual(validateRelations(files), []);
  const before = JSON.stringify(files);
  validateRelations(files);
  assert.equal(JSON.stringify(files), before);
});

test('missing, invalid, and incorrectly typed references have stable source and target diagnostics', () => {
  const files = [project(), record('ADR-1', { entity: 'document' }),
    record('TASK-1', { project: 'ADR-1', parent: 'PRJ-1', blocked_by: ['TASK-404'] })];
  const result = validateRelations(files);
  for (const [code, field, targetId] of [['REFERENCE_TYPE', 'project', 'ADR-1'], ['REFERENCE_TYPE', 'parent', 'PRJ-1'], ['REFERENCE_NOT_FOUND', 'blocked_by', 'TASK-404']]) {
    assert.ok(result.some((diagnostic) => diagnostic.code === code && diagnostic.field === field && diagnostic.targetId === targetId && diagnostic.path === 'entities/TASK-1.md' && diagnostic.entityId === 'TASK-1'));
  }
  const stale = record('TASK-2');
  stale.stale = true;
  assert.ok(validateRelations([stale, record('TASK-3', { blocked_by: ['TASK-2'] })]).some(({ code, targetId }) => code === 'REFERENCE_INVALID' && targetId === 'TASK-2'));
  const invalidChain = validateRelations([record('TASK-1', { blocked_by: ['TASK-404'] }), record('TASK-2', { parent: 'TASK-1' }), record('TASK-3', { related_to: ['TASK-2'] })]);
  assert.ok(invalidChain.some(({ code, entityId }) => code === 'REFERENCE_INVALID' && entityId === 'TASK-3'));
});

test('self references, parent project mismatches, and cycles reject every offending edge', () => {
  for (const field of ['parent', 'blocked_by', 'related_to']) {
    const value = field === 'parent' ? 'TASK-1' : ['TASK-1'];
    assert.ok(validateRelations([record('TASK-1', { [field]: value })]).some((diagnostic) => diagnostic.code === 'SELF_REFERENCE' && diagnostic.field === field && diagnostic.targetId === 'TASK-1'));
  }
  const mismatch = validateRelations([project(), record('TASK-1', { project: 'PRJ-1' }), record('TASK-2', { parent: 'TASK-1' })]);
  assert.ok(mismatch.some(({ code, entityId, field }) => code === 'PARENT_PROJECT_MISMATCH' && entityId === 'TASK-2' && field === 'parent'));
  for (const field of ['parent', 'blocked_by']) {
    const files = ['TASK-1', 'TASK-2', 'TASK-3'].map((id, index, ids) => record(id, { [field]: field === 'parent' ? ids[(index + 1) % 3] : [ids[(index + 1) % 3]] }));
    assert.equal(validateRelations(files).filter(({ code }) => code === 'RELATION_CYCLE').length, 3);
    assert.deepEqual(validateRelations([...files].reverse()), validateRelations(files));
  }
});

test('wiki links resolve exact IDs or unique title/basename without becoming dependencies', () => {
  const target = record('ADR-1', { entity: 'document' }, '# Architecture\n');
  target.path = 'docs/design-note.md';
  const source = record('TASK-1', {}, '# Task\n\n[[ADR-1]] [[Architecture]] [[design-note]] [[Missing]]\n');
  const files = [source, target];
  for (const name of ['ADR-1', 'Architecture', 'design-note']) assert.equal(resolveReference(name, files), target);
  const diagnostics = validateRelations(files);
  assert.deepEqual(diagnostics.map(({ code, severity, field, targetId }) => ({ code, severity, field, targetId })), [{ code: 'UNRESOLVED_LINK', severity: 'warning', field: 'links', targetId: 'Missing' }]);
  const duplicateTitle = record('ADR-2', { entity: 'document' }, '# Architecture\n');
  assert.equal(resolveReference('Architecture', [...files, duplicateTitle]), undefined);
  assert.equal(resolveReference('ADR-1', [...files, duplicateTitle]), target);
  assert.equal(resolveReference('design-note', [...files, { ...duplicateTitle, path: 'else/design-note.md' }]), undefined);
});

test('duplicate IDs are diagnosed at each source and cannot resolve as valid references', () => {
  const duplicate = { ...record('TASK-1'), path: 'other/TASK-1.md' };
  const files = [record('TASK-1'), duplicate, record('TASK-2', { parent: 'TASK-1' })];
  assert.equal(validateRelations(files).filter(({ code }) => code === 'DUPLICATE_ID').length, 2);
  assert.ok(validateRelations(files).some(({ code, targetId }) => code === 'REFERENCE_INVALID' && targetId === 'TASK-1'));
  assert.equal(resolveReference('TASK-1', files), undefined);
});

test('every model creates and patches through the shared schema with scoped field applicability', () => {
  for (const kind of entityKinds) {
    const source = createMarkdown({ id: `${entityDefinitions[kind].prefix}-1`, entity: kind, title: `${kind} title`, body: 'Description stays Markdown.\n' });
    const entity = parseMarkdown(source);
    assert.equal(entity.entity, kind);
    assert.equal(entitySchema.safeParse(entity).success, true);
    assert.equal(entity.status, workflowFor(kind)?.initial);
    assert.equal(parseMarkdown(patchMarkdown(source, { title: 'New title', labels: ['model'] })).title, 'New title');
    if (kind !== 'document') {
      assert.equal(parseMarkdown(patchMarkdown(source, { status: workflowFor(kind)!.states.at(-1)!.id })).status, 'canceled');
    }
  }
  assert.equal(parseMarkdown(createMarkdown({ id: 'GOAL-1', entity: 'goal', title: 'Goal', target: 12.5, unit: 'percent' })).target, 12.5);
  assert.equal(parseMarkdown(createMarkdown({ id: 'REL-1', entity: 'release', title: 'Release', version: '1.2.3' })).version, '1.2.3');
  assert.equal(parseMarkdown(createMarkdown({ id: 'REQ-1', entity: 'requirement', title: 'Requirement' })).priority, 'medium');
  rejects(() => createMarkdown({ id: 'MS-1', entity: 'milestone', title: 'Milestone', start: '2026-01-01' }), 'FIELD_NOT_APPLICABLE', 'start');
  rejects(() => createMarkdown({ id: 'GOAL-1', entity: 'goal', title: 'Goal', target: '12' }), 'SCHEMA_VALIDATION', 'target');
  rejects(() => createMarkdown({ id: 'MOD-1', entity: 'module', title: 'Module', start: '2026-03-02', due: '2026-03-01' }), 'SCHEMA_VALIDATION', 'start');
  rejects(() => createMarkdown({ id: 'GOAL-1', entity: 'goal', title: 'Goal', schema: 'pm/v2' }), 'UNSUPPORTED_SCHEMA_VERSION', 'schema');
});

function configured(): ProtocolConfiguration {
  return parseConfiguration({
    schema: 'pm/config/v1',
    workflows: { work_item: {
      initial: 'queued',
      states: [{ id: 'queued', label: 'Queued', category: 'backlog' }, { id: 'shipping', label: 'Shipping', category: 'started' }, { id: 'shipped', label: 'Shipped', category: 'completed' }],
      transitions: [{ from: 'queued', to: 'shipping' }, { from: 'shipping', to: 'shipped' }],
    } },
    custom_fields: [
      { name: 'x-points', label: 'Points', type: 'number', entities: ['work_item'], min: 0, max: 20, required: true, default: 3 },
      { name: 'x-note', label: 'Note', type: 'text', entities: ['work_item'], min: 1, max: 10 },
      { name: 'x-flag', label: 'Flag', type: 'boolean', entities: ['work_item'], default: false },
      { name: 'x-date', label: 'Date', type: 'date', entities: ['work_item'] },
      { name: 'x-size', label: 'Size', type: 'select', entities: ['work_item'], options: ['s', 'm'] },
      { name: 'x-teams', label: 'Teams', type: 'multi_select', entities: ['work_item'], options: ['a', 'b'], min: 1, max: 2 },
      { name: 'x-spec', label: 'Specification', type: 'reference', entities: ['work_item'], target: 'document' },
    ],
  });
}

test('configured workflows apply initial states and categories, with explicit directed transitions', () => {
  const configuration = configured();
  assert.equal(workflowFor('project', configuration)!.initial, 'planned');
  assert.equal(workflowFor('document', configuration), undefined);
  const source = createMarkdown({ id: 'TASK-1', title: 'Custom workflow' }, configuration);
  const first = parseMarkdown(source, configuration);
  assert.equal(first.status, 'queued');
  assert.equal(statusCategory(first, configuration), 'backlog');
  rejects(() => parseMarkdown(source), 'SCHEMA_VALIDATION', 'status');
  rejects(() => patchMarkdown(source, { status: 'shipped' }, configuration), 'TRANSITION_NOT_ALLOWED', 'status');
  rejects(() => patchMarkdown(source, { status: 'done' }, configuration), 'SCHEMA_VALIDATION', 'status');
  const started = patchMarkdown(source, { status: 'shipping' }, configuration);
  assert.equal(statusCategory(parseMarkdown(started, configuration), configuration), 'started');
  rejects(() => patchMarkdown(started, { status: null }, configuration), 'TRANSITION_NOT_ALLOWED', 'status');
  const finished = parseMarkdown(patchMarkdown(started, { status: 'shipped' }, configuration), configuration);
  assert.equal(statusCategory(finished, configuration), 'completed');
  assert.equal(validateTransition(first, finished, configuration)[0].code, 'TRANSITION_NOT_ALLOWED');
  const locked = parseConfiguration({ ...configuration, workflows: { work_item: { ...configuration.workflows.work_item!, transitions: [] } } });
  assert.equal(parseMarkdown(patchMarkdown(source, { title: 'Still editable', status: 'queued' }, locked), locked).title, 'Still editable');
  rejects(() => patchMarkdown(source, { status: 'shipping' }, locked), 'TRANSITION_NOT_ALLOWED', 'status');
  for (const kind of entityKinds.filter((kind) => kind !== 'document')) {
    const definition = workflowFor(kind)!;
    assert.equal(definition.transitions.length, definition.states.length * (definition.states.length - 1));
  }
});

test('workflow category defaults round-trip without replacing transitions or leaking into custom definitions', () => {
  assert.deepEqual(workflowFor('work_item')!.default_targets, { started: 'in_progress' });
  const configuration = configured();
  const definition = configuration.workflows.work_item!;
  assert.equal(definition.default_targets, undefined, 'An explicit workflow must not inherit built-in target IDs');
  definition.states.push({ id: 'checking', label: 'Checking', category: 'started' });
  definition.transitions.push({ from: 'queued', to: 'checking' });
  definition.default_targets = { started: 'shipping' };
  const parsed = parseConfiguration(configuration);
  assert.deepEqual(parsed.workflows.work_item, definition);
  const source = createMarkdown({ id: 'TASK-1', title: 'Explicit review lane' }, parsed);
  const checking = parseMarkdown(patchMarkdown(source, { status: 'checking' }, parsed), parsed);
  assert.equal(checking.status, 'checking', 'Category defaults must not restrict explicitly selected native states');
  const locked = parseConfiguration({ ...parsed, workflows: { work_item: { ...definition, transitions: [] } } });
  rejects(() => patchMarkdown(source, { status: 'shipping' }, locked), 'TRANSITION_NOT_ALLOWED', 'status');
});

test('typed extensions validate without coercion, default on reads and preserve exact source/body', () => {
  const configuration = configured();
  const source = raw({ status: 'queued', 'x-unknown': { retained: true } }, '# Typed\n\nBody with spaces  \n');
  const entity = parseMarkdown(source, configuration);
  assert.equal(entity['x-points'], 3);
  assert.equal(entity['x-flag'], false);
  assert.equal(patchMarkdown(source, {}, configuration), source);
  const patched = patchMarkdown(source, { 'x-points': 8, 'x-teams': ['a'], 'x-date': '2028-02-29', 'x-size': 's', 'x-spec': 'DOC-1' }, configuration);
  assert.equal(parseMarkdown(patched, configuration).body, entity.body);
  assert.deepEqual(parseMarkdown(patched, configuration)['x-unknown'], { retained: true });
  for (const [field, value] of [
    ['x-points', '4'], ['x-points', 21], ['x-flag', 'false'], ['x-note', ''], ['x-size', 'large'],
    ['x-date', '2026-02-29'], ['x-teams', ['a', 'a']], ['x-teams', []], ['x-spec', 'not-an-id'],
  ] as [string, unknown][]) {
    rejects(() => patchMarkdown(source, { [field]: value }, configuration), 'SCHEMA_VALIDATION', field);
  }
  rejects(() => createMarkdown({ id: 'PRJ-1', entity: 'project', title: 'Project', 'x-points': 4 }, configuration), 'FIELD_NOT_APPLICABLE', 'x-points');
  const required = parseConfiguration({ schema: 'pm/config/v1', custom_fields: [{ name: 'x-required', label: 'Required', type: 'text', required: true, entities: ['work_item'] }] });
  rejects(() => parseMarkdown(raw({}), required), 'SCHEMA_VALIDATION', 'x-required');
  const requiredSource = createMarkdown({ id: 'TASK-1', title: 'Required', 'x-required': 'present' }, required);
  rejects(() => patchMarkdown(requiredSource, { 'x-required': null }, required), 'SCHEMA_VALIDATION', 'x-required');
  assert.equal(parseMarkdown(patchMarkdown(source, { 'x-points': null }, configuration), configuration)['x-points'], 3);
});

test('configuration rejects inconsistent workflows, declarations, constraints and defaults', () => {
  const valid = configured();
  const state = valid.workflows.work_item!;
  for (const workflow of [
    { ...state, initial: 'missing' },
    { ...state, states: [...state.states, state.states[0]] },
    { ...state, transitions: [{ from: 'queued', to: 'missing' }] },
    { ...state, transitions: [state.transitions[0], state.transitions[0]] },
    { ...state, default_targets: { started: 'missing' } },
    { ...state, default_targets: { started: 'queued' } },
    { ...state, default_targets: { unknown: 'shipping' } },
    { ...state, default_targets: { started: '' } },
    { ...state, default_targets: null },
  ]) rejects(() => parseConfiguration({ ...valid, workflows: { work_item: workflow } }), 'CONFIGURATION_INVALID');
  rejects(() => parseConfiguration({ ...valid, schema: 'pm/config/v2' }), 'CONFIGURATION_INVALID');
  rejects(() => parseConfiguration({ ...valid, workflows: { document: state } }), 'CONFIGURATION_INVALID');
  rejects(() => parseConfiguration({ ...valid, workflows: { sprint: state } }), 'CONFIGURATION_INVALID');
  rejects(() => parseConfiguration({ ...valid, custom_fields: [valid.custom_fields[0], valid.custom_fields[0]] }), 'CONFIGURATION_INVALID');
  const base = { name: 'x-value', label: 'Value', type: 'number', entities: ['work_item'] };
  for (const changes of [
    { name: 'status' }, { type: 'number', default: '3' }, { min: 4, max: 2 },
    { type: 'boolean', min: 0 }, { type: 'text', min: -1 }, { type: 'text', max: 1.5 },
    { type: 'select' }, { type: 'select', options: ['a', 'a'] }, { type: 'select', options: ['a'], default: 'b' },
    { type: 'multi_select', options: ['a'], min: 2 }, { type: 'date', default: '2026-02-30' },
    { type: 'reference' }, { type: 'reference', target: 'sprint' }, { target: 'document' },
    { options: ['a'] }, { entities: ['work_item', 'work_item'] }, { entities: [] }, { default: null },
  ]) rejects(() => parseConfiguration({ schema: 'pm/config/v1', custom_fields: [{ ...base, ...changes }] }), 'CONFIGURATION_INVALID');
  const effective = parseConfiguration({ schema: 'pm/config/v1' });
  effective.workflows.work_item!.states[0].label = 'Changed copy';
  assert.notEqual(defaultConfiguration.workflows.work_item!.states[0].label, 'Changed copy');
});

test('new formal references are typed, project scoped, and discoverable for every source kind', () => {
  const files = [
    project(), record('PRJ-2', { entity: 'project' }),
    ...(['cycle', 'milestone', 'module', 'requirement', 'release'] as EntityKind[]).map((entity) => record(`${entityDefinitions[entity].prefix}-1`, { entity, project: 'PRJ-1', goals: ['GOAL-1'] })),
    record('GOAL-1', { entity: 'goal', project: 'PRJ-2' }),
    record('TASK-1', { project: 'PRJ-1', cycle: 'CYC-1', milestone: 'MS-1', module: 'MOD-1', requirement: 'REQ-1', release: 'REL-1', goals: ['GOAL-1'] }),
  ];
  const requirement = files.find(({ id }) => id === 'REQ-1')!;
  requirement.entity = parseMarkdown(raw({ id: 'REQ-1', entity: 'requirement', project: 'PRJ-1', module: 'MOD-1', milestone: 'MS-1', release: 'REL-1', goals: ['GOAL-1'] }));
  assert.deepEqual(validateRelations(files), []);
  const task = files.find(({ id }) => id === 'TASK-1')!;
  assert.deepEqual(referenceEntries(task.entity).map(({ field }) => field).sort(), ['cycle', 'goals', 'milestone', 'module', 'project', 'release', 'requirement']);
  for (const name of ['cycle', 'milestone', 'module', 'requirement', 'release']) {
    assert.ok(relationFields().some((definition) => definition.name === name && definition.scoped));
    const wrongKind = { ...task, entity: { ...task.entity, [name]: 'GOAL-1' } };
    assert.ok(validateRelations([...files.filter(({ id }) => id !== task.id), wrongKind]).some(({ code, field }) => code === 'REFERENCE_TYPE' && field === name));
    const foreign = { ...task, entity: { ...task.entity, project: 'PRJ-2' } };
    assert.ok(validateRelations([...files.filter(({ id }) => id !== task.id), foreign]).some(({ code, field }) => code === 'REFERENCE_PROJECT_MISMATCH' && field === name));
  }
  const goalText = record('PRJ-3', { entity: 'project', goal: 'Free text', goals: ['GOAL-1'] });
  assert.equal(goalText.entity.goal, 'Free text');
  assert.deepEqual(referenceEntries(goalText.entity).map(({ targetId }) => targetId), ['GOAL-1']);
  assert.deepEqual(validateRelations([record('CYC-2', { entity: 'cycle' }), record('TASK-2', { cycle: 'CYC-2' })]), []);
  assert.ok(validateRelations([project(), record('CYC-2', { entity: 'cycle' }), record('TASK-2', { project: 'PRJ-1', cycle: 'CYC-2' })]).some(({ code }) => code === 'REFERENCE_PROJECT_MISMATCH'));
});

test('module and goal parent cycles reject every edge while goal hierarchies may cross projects', () => {
  for (const entity of ['module', 'goal'] as const) {
    const prefix = entityDefinitions[entity].prefix;
    const files = [1, 2, 3].map((n) => record(`${prefix}-${n}`, { entity, parent: `${prefix}-${n % 3 + 1}` }));
    assert.equal(validateRelations(files).filter(({ code }) => code === 'RELATION_CYCLE').length, 3);
    assert.ok(validateRelations([record(`${prefix}-1`, { entity, parent: `${prefix}-1` })]).some(({ code }) => code === 'SELF_REFERENCE'));
  }
  const files = [project(), record('PRJ-2', { entity: 'project' }), record('GOAL-1', { entity: 'goal', project: 'PRJ-1' }), record('GOAL-2', { entity: 'goal', project: 'PRJ-2', parent: 'GOAL-1' })];
  assert.deepEqual(validateRelations(files), []);
  assert.ok(validateRelations([record('MOD-1', { entity: 'module', parent: 'TASK-1' }), record('TASK-1')]).some(({ code }) => code === 'REFERENCE_TYPE'));
});

test('registered reference defaults participate in integrity, applicability and incoming discovery', () => {
  const configuration = parseConfiguration({ schema: 'pm/config/v1', custom_fields: [
    { name: 'x-spec', label: 'Specification', type: 'reference', entities: ['work_item'], target: 'document', default: 'DOC-1', required: true },
  ] });
  const source = raw({});
  const task: FileRecord = { id: 'TASK-1', path: 'task.md', raw: source, revision: 'fixture', entity: parseMarkdown(source, configuration) };
  assert.deepEqual(referenceEntries(task.entity, configuration).map(({ field, targetId }) => ({ field, targetId })), [{ field: 'x-spec', targetId: 'DOC-1' }]);
  assert.ok(validateRelations([task], configuration).some(({ code, field }) => code === 'REFERENCE_NOT_FOUND' && field === 'x-spec'));
  assert.ok(validateRelations([task, record('DOC-1', { entity: 'goal' })], configuration).some(({ code, field }) => code === 'REFERENCE_TYPE' && field === 'x-spec'));
  assert.deepEqual(validateRelations([task, record('DOC-1', { entity: 'document' })], configuration), []);
  const target = record('DOC-1', { entity: 'document' });
  target.stale = true;
  assert.ok(validateRelations([task, target], configuration).some(({ code, field }) => code === 'REFERENCE_INVALID' && field === 'x-spec'));
});

test('embedded views validate configured fields and bounded DSL without dropping unknown clauses', () => {
  const configuration = configured();
  const source = raw({ status: 'queued' }, '# Query\n\n```pm-view\nentity: work_item\nlayout: table\nwhere:\n  field: x-points\n  op: gte\n  value: 2\norder_by:\n  - field: x-points\n    direction: desc\ncolumns: [title, x-points]\n```\n');
  assert.equal(parseMarkdown(source, configuration).views[0].where && parseMarkdown(source, configuration).views[0].order_by?.[0].field, 'x-points');
  assert.throws(() => parseMarkdown(source.replace('field: x-points', 'field: x-missing'), configuration), ProtocolError);
  rejects(() => parseMarkdown(source.replace('op: gte', 'op: execute'), configuration), 'SCHEMA_VALIDATION', 'views');
  rejects(() => parseMarkdown(source.replace('layout: table', 'layout: table\nignored_typo: true'), configuration), 'SCHEMA_VALIDATION', 'views');
});
