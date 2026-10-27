import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { createMarkdown, parseMarkdown, patchMarkdown } from '../../pm-markdown/index.ts';
import { entitySchema } from '../../pm-schema/index.ts';
import { validateRelations } from '../../pm-schema/relations.ts';

const source = `---
# A user-authored header must survive property edits.
schema: pm/v1
id: TASK-102
entity: work_item
kind: task
project: PRJ-001
status: todo # keep this inline explanation
priority: high
blocked_by: [TASK-101]
labels: [runtime, session] # preserve sequence comment
custom: &custom
  quoted: "00102"
  enabled: true
  note: |
    first line
    second line
custom_copy: *custom
# preserve this unknown field's comment
estimate: 8
---

# 实现 **Session** 管理

Keep  two spaces and trailing spaces.  

- [x] Define schema
- [ ] Implement API
  - [ ] Nested acceptance

[[ADR-001|Architecture]] and [[TASK-101#Protocol]] and [[ADR-001]].

\`[[INLINE-999]]\`

\`\`\`markdown
# Not the title
- [ ] Not a checklist item
[[CODE-999]]
\`\`\`

\`\`\`pm-view
entity: work_item
project: PRJ-001
layout: table
filter:
  priority: high
\`\`\`
`;

function yamlMetadata(raw: string): Record<string, unknown> {
  return parseDocument(raw.split(/^---[ \t]*\r?$/m)[1]).toJS() as Record<string, unknown>;
}

test('AST parsing derives one title, true checklist items, links and embedded views', () => {
  const entity = parseMarkdown(source);
  assert.equal(entity.title, '实现 Session 管理');
  assert.deepEqual(entity.links, ['ADR-001', 'TASK-101']);
  assert.deepEqual(entity.checklist.map(({ text, checked }) => ({ text, checked })), [
    { text: 'Define schema', checked: true },
    { text: 'Implement API', checked: false },
    { text: 'Nested acceptance', checked: false },
  ]);
  for (const item of entity.checklist) {
    assert.match(source.split('\n')[item.line - 1], /^\s*- \[[ x]\]/);
  }
  assert.deepEqual(entity.views, [{ entity: 'work_item', project: 'PRJ-001', layout: 'table', filter: { priority: 'high' } }]);
  assert.deepEqual(entity.blocked_by, ['TASK-101']);
  assert.deepEqual(entity.related_to, []);
});

test('property patches preserve exact body, unknown YAML values, aliases and comments', () => {
  const original = parseMarkdown(source);
  const nextRaw = patchMarkdown(source, { status: 'in_progress', assignee: 'agent:codex', labels: ['runtime', 'review'] });
  const next = parseMarkdown(nextRaw);
  assert.equal(next.status, 'in_progress');
  assert.equal(next.assignee, 'agent:codex');
  assert.deepEqual(next.labels, ['runtime', 'review']);
  assert.equal(next.body, original.body);
  assert.deepEqual(next.custom, original.custom);
  assert.deepEqual(next.custom_copy, original.custom_copy);
  assert.equal(next.estimate, 8);
  assert.ok(nextRaw.includes('# A user-authored header must survive property edits.'));
  assert.ok(nextRaw.includes('# keep this inline explanation'));
  assert.ok(nextRaw.includes('# preserve sequence comment'));
  assert.ok(nextRaw.includes("# preserve this unknown field's comment"));
  assert.ok(nextRaw.includes('&custom'));
  assert.ok(nextRaw.includes('*custom'));
  assert.ok(nextRaw.indexOf('status:') < nextRaw.indexOf('priority:'));
  assert.ok(nextRaw.indexOf('custom:') < nextRaw.indexOf('estimate:'));
});

test('replacing an anchored collection retains aliases used by extension fields', () => {
  const raw = source.replace('labels: [runtime, session]', 'labels: &tags [runtime, session]')
    .replace('estimate: 8', 'estimate: 8\nextension_tags: *tags');
  const result = patchMarkdown(raw, { labels: ['reviewed'] });
  assert.deepEqual(parseMarkdown(result).labels, ['reviewed']);
  assert.deepEqual(parseMarkdown(result).extension_tags, ['reviewed']);
  assert.ok(result.includes('&tags'));
  assert.ok(result.includes('*tags'));
  assert.equal(parseMarkdown(result).body, parseMarkdown(raw).body);
});

test('creation does not silently coerce explicit invalid null values into defaults', () => {
  for (const key of ['entity', 'kind', 'status', 'priority']) {
    assert.throws(() => createMarkdown({ id: 'TASK-302', title: 'Invalid null', [key]: null }), /Invalid PM metadata/);
  }
});

test('repeated board/property updates never erode the Markdown suffix', () => {
  let result = source;
  for (const status of ['in_progress', 'done', 'todo', 'canceled', 'done']) {
    result = patchMarkdown(result, { status });
    assert.equal(parseMarkdown(result).body, parseMarkdown(source).body);
    assert.equal(parseMarkdown(result).status, status);
  }
  assert.deepEqual(parseMarkdown(result).custom, parseMarkdown(source).custom);
  assert.ok(result.includes('# keep this inline explanation'));
});

test('CRLF and a missing final newline survive property edits', () => {
  const raw = source.trimEnd().replace(/\n/g, '\r\n');
  const result = patchMarkdown(raw, { priority: 'urgent' });
  assert.equal(parseMarkdown(result).body, parseMarkdown(raw).body);
  assert.ok(result.startsWith('---\r\n'));
  assert.equal(/(?<!\r)\n/.test(result), false);
  assert.equal(result.endsWith('\n'), false);
});

test('empty patches are byte-identical and title-only changes do not normalize YAML', () => {
  assert.equal(patchMarkdown(source, {}), source);
  const title = 'New [literal] *title* <safe> # 2';
  const result = patchMarkdown(source, { title });
  assert.equal(parseMarkdown(result).title, title);
  const prefixLength = source.length - parseMarkdown(source).body.length;
  assert.equal(result.slice(0, prefixLength), source.slice(0, prefixLength));
  assert.equal(parseMarkdown(result).body.slice(parseMarkdown(result).body.indexOf('\n\nKeep')),
    parseMarkdown(source).body.slice(parseMarkdown(source).body.indexOf('\n\nKeep')));
  assert.equal(yamlMetadata(result).title, undefined);
});

test('first real H1 wins over YAML title, code examples and quoted H1', () => {
  const raw = '---\nschema: pm/v1\nid: ADR-001\nentity: document\ntitle: stale YAML title\n---\n\n> # Quoted heading\n\n```md\n# Example heading\n```\n\nActual title\n============\n\n# Later H1\n';
  assert.equal(parseMarkdown(raw).title, 'Actual title');
  const patched = patchMarkdown(raw, { title: 'Replacement' });
  assert.equal(parseMarkdown(patched).title, 'Replacement');
  assert.ok(patched.includes('> # Quoted heading'));
  assert.ok(patched.includes('# Later H1'));
  assert.equal(yamlMetadata(patched).title, 'stale YAML title');
});

test('null deletes optional fields; work item defaults are projections, not forced YAML', () => {
  const result = patchMarkdown(source, { priority: null, project: null, blocked_by: null, estimate: null });
  const entity = parseMarkdown(result);
  assert.equal(entity.priority, 'medium');
  assert.equal(entity.project, undefined);
  assert.deepEqual(entity.blocked_by, []);
  assert.equal(entity.estimate, undefined);
  const metadata = yamlMetadata(result);
  for (const key of ['priority', 'project', 'blocked_by', 'estimate']) assert.equal(Object.hasOwn(metadata, key), false);
});

test('identity and computed fields cannot be changed through property commands', () => {
  for (const [key, value] of Object.entries({ id: 'TASK-103', schema: 'pm/v2', entity: 'document', body: '# New', links: [], checklist: [], views: [] })) {
    assert.throws(() => patchMarkdown(source, { [key]: value }), /Cannot change|derived/);
  }
  assert.throws(() => patchMarkdown(source, { id: 'TASK-102' }), /identity/);
  assert.throws(() => patchMarkdown(source, { title: null }), /title/);
  assert.throws(() => patchMarkdown(source, { title: 'line one\nline two' }), /single line/);
  assert.throws(() => patchMarkdown(source, { assignee: undefined }), /undefined/);
});

test('invalid edits fail rather than returning invalid Markdown', () => {
  for (const changes of [
    { status: 'blocked' }, { priority: 'critical' }, { blocked_by: 'TASK-101' },
    { blocked_by: ['not-an-id'] }, { project: 'wrong' }, { due: '2026-02-30' },
    { due: 'tomorrow' }, { labels: [1] }, { assignee: '' },
  ]) assert.throws(() => patchMarkdown(source, changes), /Invalid PM metadata/);
  assert.equal(parseMarkdown(patchMarkdown(source, { due: '2028-02-29' })).due, '2028-02-29');
});

test('invalid frontmatter, duplicate keys, malformed metadata and missing titles are rejected', () => {
  assert.throws(() => parseMarkdown('# No YAML'), /Missing YAML/);
  assert.throws(() => parseMarkdown('---\nid: TASK-1\n# No delimiter'), /Unclosed YAML/);
  assert.throws(() => parseMarkdown('---\n- not-a-map\n---\n# Title\n'), /mapping/);
  assert.throws(() => parseMarkdown(source.replace('status: todo', 'status: done\nstatus: todo')), /Invalid YAML/);
  assert.throws(() => parseMarkdown(source.replace('id: TASK-102', 'id: invalid')), /id/);
  assert.throws(() => parseMarkdown(source.replace('schema: pm/v1', 'schema: pm/v2')), /schema/);
  assert.throws(() => parseMarkdown(source.replace('# 实现 **Session** 管理', 'No heading')), /Missing title/);
  assert.throws(() => parseMarkdown(source.replace('blocked_by: [TASK-101]', 'blocked_by: null')), /blocked_by/);
});

test('create defaults work items while preserving provided metadata and body', () => {
  const body = '## Goal\n\nBuild the API.\n\n- [ ] Ship\n\n[[ADR-001]]\n';
  const raw = createMarkdown({ id: 'TASK-301', title: 'A [safe] title', body, project: 'PRJ-001', 'x-custom': { count: 2 } });
  const entity = parseMarkdown(raw);
  assert.equal(entity.schema, 'pm/v1');
  assert.equal(entity.entity, 'work_item');
  assert.equal(entity.kind, 'task');
  assert.equal(entity.status, 'todo');
  assert.equal(entity.priority, 'medium');
  assert.equal(entity.title, 'A [safe] title');
  assert.ok(entity.body.endsWith(body));
  assert.deepEqual(entity['x-custom'], { count: 2 });
  assert.equal(yamlMetadata(raw).title, undefined);
  assert.throws(() => createMarkdown({ id: 'bad', title: 'Title' }), /id/);
  assert.throws(() => createMarkdown({ id: 'TASK-301', title: 'Title', schema: 'other' }), /schema/);
  assert.throws(() => createMarkdown({ id: 'TASK-301', title: 'Title', body: 1 }), /body/);
});

test('project and document entities do not acquire task workflow defaults', () => {
  for (const [entity, id] of [['project', 'PRJ-002'], ['document', 'ADR-002']]) {
    const parsed = parseMarkdown(createMarkdown({ id, title: 'Non-task', entity }));
    assert.equal(parsed.status, entity === 'project' ? 'planned' : undefined);
    assert.equal(parsed.priority, undefined);
    assert.equal(parsed.kind, undefined);
    assert.equal(entitySchema.safeParse(parsed).success, true);
  }
});

test('sample workspace satisfies shared relationship validity rules', async () => {
  const root = fileURLToPath(new URL('./fixtures/workspace/', import.meta.url));
  const files = [];
  for (const directory of ['projects', 'work-items', 'docs']) {
    for (const filename of await readdir(join(root, directory))) {
      if (!filename.endsWith('.md')) continue;
      const raw = await readFile(join(root, directory, filename), 'utf8');
      const entity = parseMarkdown(raw);
      files.push({ id: entity.id, path: `${directory}/${filename}`, raw, revision: 'fixture', entity });
    }
  }
  assert.deepEqual(validateRelations(files), []);
});

