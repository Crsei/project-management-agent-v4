import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../packages/pm-markdown/index.ts';
import { defaultConfiguration, parseConfiguration, ProtocolError, validateTransition, type FileRecord } from '../packages/pm-schema/index.ts';
import { patchTaskDraftRaw, toggleTaskChecklistRaw } from '../apps/web/src/features/pm/markdown/task-detail-model.ts';

const raw = '\uFEFF---\r\nschema: pm/v1\r\nid: TASK-1\r\nentity: work_item\r\nproject: PRJ-1\r\nstatus: todo\r\npriority: low # keep priority note\r\nx-local-note: &note { nested: "keep this" } # keep extension\r\nx-local-copy: *note\r\n---\r\n> # Not the title\r\n\r\n# Saved title\r\n\r\nKeep [[PRJ-1|Project]] and **Markdown**.\r\n\r\n> [!NOTE]\r\n> Keep this callout.\r\n\r\n- [ ] Real checklist\r\n> - [X] Quoted checklist\r\n\r\n```md\r\n- [ ] Code, not a checklist\r\n```\r\n';
function file(source = raw): FileRecord {
  return { id: 'TASK-1', path: 'tasks/TASK-1.md', raw: source, revision: 'original-revision', entity: parseMarkdown(source) };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof ProtocolError && error.diagnostics.some(issue => issue.code === code);
}

test('source and field edits share the supplied latest raw without replacing unknown metadata or Markdown bytes', () => {
  const original = file();
  const source = raw.replace('Saved title', 'Source title').replace('Keep [[PRJ-1|Project]]', 'Latest source [[PRJ-1|Project]]');
  const body = parseMarkdown(source).body;
  const patched = patchTaskDraftRaw(original, source, { priority: 'urgent', 'x-pm-estimate': 0 }, defaultConfiguration);
  const entity = parseMarkdown(patched);
  assert.equal(entity.title, 'Source title');
  assert.equal(entity.priority, 'urgent');
  assert.equal(entity['x-pm-estimate'], 0);
  assert.equal(entity.body, body);
  assert.ok(patched.includes('x-local-note: &note { nested: "keep this" } # keep extension\r\n'));
  assert.ok(patched.includes('x-local-copy: *note\r\n'));
  assert.ok(patched.includes('# keep priority note\r\n'));
  assert.ok(patched.startsWith('\uFEFF---\r\n'));
  const renamed = patchTaskDraftRaw(original, patched, { title: 'Field title' }, defaultConfiguration);
  assert.equal(parseMarkdown(renamed).title, 'Field title');
  assert.ok(renamed.includes('> # Not the title\r\n'));
  assert.equal(original.raw, raw);
  assert.equal(original.revision, 'original-revision');
});

test('multiple staged workflow selections are validated against the saved original, not the intermediate draft', () => {
  const configuration = parseConfiguration({ schema: 'pm/config/v1', workflows: { work_item: {
    initial: 'todo', states: [{ id: 'todo', label: 'Todo', category: 'unstarted' }, { id: 'doing', label: 'Doing', category: 'started' }, { id: 'review', label: 'Review', category: 'started' }],
    transitions: [{ from: 'todo', to: 'doing' }, { from: 'todo', to: 'review' }],
  } } });
  const original = file();
  const first = patchTaskDraftRaw(original, raw, { status: 'doing' }, configuration);
  const final = patchTaskDraftRaw(original, first, { status: 'review' }, configuration);
  assert.deepEqual(validateTransition(original.entity, parseMarkdown(final, configuration), configuration), []);
  assert.equal(validateTransition(parseMarkdown(first, configuration), parseMarkdown(final, configuration), configuration)[0]?.code, 'TRANSITION_NOT_ALLOWED');
  const reset = patchTaskDraftRaw(original, final, { status: 'todo' }, configuration);
  assert.deepEqual(validateTransition(original.entity, parseMarkdown(reset, configuration), configuration), []);
});

test('staging never launders an originally forbidden workflow transition into a legal save', () => {
  const configuration = parseConfiguration({ schema: 'pm/config/v1', workflows: { work_item: {
    initial: 'todo', states: [{ id: 'todo', label: 'Todo', category: 'unstarted' }, { id: 'doing', label: 'Doing', category: 'started' }, { id: 'done', label: 'Done', category: 'completed' }],
    transitions: [{ from: 'todo', to: 'doing' }, { from: 'doing', to: 'done' }],
  } } });
  const original = file();
  const first = patchTaskDraftRaw(original, raw, { status: 'doing' }, configuration);
  const final = patchTaskDraftRaw(original, first, { status: 'done' }, configuration);
  assert.equal(validateTransition(original.entity, parseMarkdown(final, configuration), configuration)[0]?.code, 'TRANSITION_NOT_ALLOWED');
  assert.equal(configuration.workflows.work_item!.transitions.length, 2, 'the authoritative configuration was not relaxed');
});

test('invalid source, empty titles and identity changes cannot be patched from saved fallback values', () => {
  const original = file();
  assert.throws(() => patchTaskDraftRaw(original, '', { priority: 'high' }, defaultConfiguration), hasCode('YAML_SYNTAX'));
  assert.throws(() => patchTaskDraftRaw(original, raw.replace('TASK-1', 'TASK-2'), { priority: 'high' }, defaultConfiguration), hasCode('IMMUTABLE_FIELD'));
  assert.throws(() => patchTaskDraftRaw(original, raw.replace('pm/v1', 'pm/v2'), { priority: 'high' }, defaultConfiguration), hasCode('UNSUPPORTED_SCHEMA_VERSION'));
  assert.throws(() => patchTaskDraftRaw(original, raw, { title: '' }, defaultConfiguration), hasCode('SCHEMA_VALIDATION'));
  assert.throws(() => patchTaskDraftRaw(original, raw, { 'x-pm-estimate': Number.NaN }, defaultConfiguration), hasCode('SCHEMA_VALIDATION'));
  assert.throws(() => patchTaskDraftRaw(original, raw, { id: 'TASK-2' }, defaultConfiguration), hasCode('IMMUTABLE_FIELD'));
  assert.throws(() => patchTaskDraftRaw({ ...original, entity: { ...original.entity, archived: true } }, raw, { title: 'No write' }, defaultConfiguration), /Archived/);
  assert.equal(original.raw, raw);
});

test('checklist edits use latest AST lines, preserve all other bytes and never toggle fenced code', () => {
  const original = file();
  const latest = raw.replace('- [ ] Real checklist', 'An inserted source line.\r\n\r\n- [ ] Real checklist');
  const checklist = parseMarkdown(latest).checklist;
  const toggled = toggleTaskChecklistRaw(original, latest, checklist[0]!.line, defaultConfiguration);
  assert.equal(toggled, latest.replace('- [ ] Real checklist', '- [x] Real checklist'));
  assert.equal(toggleTaskChecklistRaw(original, toggled, checklist[1]!.line, defaultConfiguration), toggled.replace('> - [X] Quoted checklist', '> - [ ] Quoted checklist'));
  const expectedLine = latest.split('\n')[checklist[0]!.line - 1]!;
  assert.equal(toggleTaskChecklistRaw(original, toggled, checklist[0]!.line, defaultConfiguration, expectedLine), latest, 'a second click uses the latest checked state');
  assert.throws(() => toggleTaskChecklistRaw(original, latest.replace('Real checklist', 'A concurrent different item'), checklist[0]!.line, defaultConfiguration, expectedLine), /line moved/);
  const codeLine = latest.split('\n').findIndex(line => line.includes('Code, not a checklist')) + 1;
  assert.throws(() => toggleTaskChecklistRaw(original, latest, codeLine, defaultConfiguration), /line moved/);
  assert.throws(() => toggleTaskChecklistRaw(original, latest, original.entity.checklist[0]!.line, defaultConfiguration), /line moved/);
});
