import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMarkdown, parseMarkdown } from '../../pm-markdown/index.ts';
import { defaultConfiguration, parseConfiguration, type FileRecord, type ProtocolConfiguration } from '../../pm-schema/index.ts';
import { buildEntityGraph, graphQuerySchema, type GraphQuery } from '../../pm-schema/graph.ts';
import { createReferenceResolver, normalizeWikilink, resolveReference, validateRelations } from '../../pm-schema/relations.ts';
import { Workspace, WorkspaceError } from '../index.ts';

function record(id: string, metadata: Record<string, unknown> = {}, body = '', configuration: ProtocolConfiguration = defaultConfiguration): FileRecord {
  const raw = createMarkdown({ id, title: id, entity: 'document', ...metadata, body }, configuration);
  return { id, path: `entities/${id}.md`, raw, revision: 'fixture', entity: parseMarkdown(raw, configuration) };
}

const configuration = parseConfiguration({ schema: 'pm/config/v1', workflows: {}, custom_fields: [
  { name: 'x-spec', label: 'Specification', type: 'reference', entities: ['work_item'], target: 'document' },
] });

test('graph exposes exact formal/custom field direction, normalized deduplicated links and isolated nodes without source', () => {
  const spec = record('DOC-1', { title: 'Architecture' }); spec.path = 'docs/design-note.md';
  const task = record('TASK-1', { entity: 'work_item', project: 'PRJ-1', blocked_by: ['TASK-2'], 'x-spec': 'DOC-1' },
    '[[DOC-1]] [[DOC-1#Heading|label]] [[Architecture|Alias]] [[design-note]]\n\n`[[Ignored]]`\n', configuration);
  const files = [task, record('PRJ-1', { entity: 'project' }), record('TASK-2', { entity: 'work_item' }), spec, record('DOC-9')];
  const before = structuredClone(files);
  const graph = buildEntityGraph(files, configuration);
  assert.deepEqual(graph.nodes.map(node => node.id), ['DOC-1', 'DOC-9', 'PRJ-1', 'TASK-1', 'TASK-2']);
  assert.deepEqual(graph.links.map(({ source, target, kind }) => ({ source, target, kind })).sort((a, b) => a.kind.localeCompare(b.kind)), [
    { source: 'TASK-1', target: 'TASK-2', kind: 'blocked_by' },
    { source: 'TASK-1', target: 'DOC-1', kind: 'link' },
    { source: 'TASK-1', target: 'PRJ-1', kind: 'project' },
    { source: 'TASK-1', target: 'DOC-1', kind: 'x-spec' },
  ]);
  assert.deepEqual(graph.availableRelations, ['blocked_by', 'link', 'project', 'x-spec']);
  assert.deepEqual(graph.unresolved, []);
  assert.deepEqual(files, before);
  assert.deepEqual(buildEntityGraph([...files].reverse(), configuration), graph);
});

test('indexed reference resolution preserves stable-ID priority, name ambiguity and formal-ID-only meaning', () => {
  const first = record('DOC-1', { title: 'Shared' }); first.path = 'docs/same.md';
  const second = record('DOC-2', { title: 'Shared' }); second.path = 'elsewhere/same.md';
  const misleading = record('DOC-3', { title: 'DOC-1' });
  const source = record('DOC-4', { related_to: ['DOC-999'] }, '[[Shared]] [[same]] [[DOC-1#Section|Alias]] [[Missing]]');
  const files = [first, second, misleading, source];
  const resolver = createReferenceResolver(files);
  assert.equal(resolver.resolve('DOC-1').file, first);
  assert.equal(resolveReference('DOC-1#Section|Alias', files), first);
  assert.equal(normalizeWikilink(' DOC-1#Section|Alias '), 'DOC-1');
  assert.deepEqual(resolver.resolve('Shared'), { reason: 'ambiguous' });
  assert.deepEqual(resolver.resolve('same'), { reason: 'ambiguous' });
  assert.deepEqual(resolver.resolveId('Shared'), { reason: 'missing' });
  const graph = buildEntityGraph(files, defaultConfiguration);
  assert.deepEqual(graph.links.map(link => [link.source, link.target, link.kind]), [['DOC-4', 'DOC-1', 'link']]);
  assert.deepEqual(graph.unresolved, [
    { source: 'DOC-4', target: 'DOC-999', reason: 'missing' },
    { source: 'DOC-4', target: 'Missing', reason: 'missing' },
    { source: 'DOC-4', target: 'Shared', reason: 'ambiguous' },
    { source: 'DOC-4', target: 'same', reason: 'ambiguous' },
  ]);
  assert.deepEqual(buildEntityGraph(files, defaultConfiguration, {}, { includeUnresolved: false }).unresolved, []);
  assert.deepEqual(buildEntityGraph(files, defaultConfiguration, { relations: [] }).unresolved, []);
  assert.deepEqual(buildEntityGraph(files, defaultConfiguration, { relations: ['related_to'] }).unresolved,
    [{ source: 'DOC-4', target: 'DOC-999', reason: 'missing' }]);
  const duplicate = { ...first, path: 'duplicate.md' };
  assert.deepEqual(createReferenceResolver([...files, duplicate]).resolve('DOC-1'), { reason: 'ambiguous' });
  assert.equal(buildEntityGraph([...files, duplicate], defaultConfiguration).nodes.some(node => node.id === 'DOC-1'), false);
});

test('local graph traverses undirected selected kinds for one to three hops and returns induced directed edges through cycles', () => {
  const files = [record('DOC-1', { related_to: ['DOC-2'] }), record('DOC-2', { related_to: ['DOC-1', 'DOC-3'] }),
    record('DOC-3', {}, '[[DOC-4]]'), record('DOC-4'), record('DOC-9')];
  assert.deepEqual(validateRelations(files), [], 'knowledge links and related_to cycles are not formal dependency cycles');
  const dependencies = [record('TASK-1', { entity: 'work_item', blocked_by: ['TASK-2'] }), record('TASK-2', { entity: 'work_item', blocked_by: ['TASK-1'] })];
  assert.ok(validateRelations(dependencies).some(issue => issue.code === 'RELATION_CYCLE'), 'graph support must not weaken formal dependency business validation');
  const graph = (query: GraphQuery) => buildEntityGraph(files, defaultConfiguration, query);
  assert.deepEqual(graph({ centerId: 'DOC-1' }).nodes.map(node => node.id), ['DOC-1', 'DOC-2']);
  assert.deepEqual(graph({ centerId: 'DOC-1', depth: 2 }).nodes.map(node => node.id), ['DOC-1', 'DOC-2', 'DOC-3']);
  assert.deepEqual(graph({ centerId: 'DOC-1', depth: 3 }).nodes.map(node => node.id), ['DOC-1', 'DOC-2', 'DOC-3', 'DOC-4']);
  assert.deepEqual(graph({ centerId: 'DOC-4', depth: 1 }).nodes.map(node => node.id), ['DOC-3', 'DOC-4'], 'incoming links are traversable');
  assert.equal(graph({ centerId: 'DOC-1' }).links.length, 2, 'both directed related_to edges survive the induced graph');
  const selected = graph({ centerId: 'DOC-1', depth: 3, relations: ['related_to'] });
  assert.deepEqual(selected.nodes.map(node => node.id), ['DOC-1', 'DOC-2', 'DOC-3']);
  assert.deepEqual(selected.availableRelations, ['link', 'related_to']);
  assert.deepEqual(graph({ relations: [] }).nodes.map(node => node.id), ['DOC-1', 'DOC-2', 'DOC-3', 'DOC-4', 'DOC-9']);
  assert.deepEqual(graph({ relations: [] }).links, []);
  assert.deepEqual(graph({ centerId: 'DOC-1', relations: [] }).nodes.map(node => node.id), ['DOC-1']);
});

test('global view/search/archive filtering does not bridge excluded nodes or misdiagnose valid targets', () => {
  const files = [record('DOC-1', { title: 'Alpha', labels: ['keep'], related_to: ['DOC-2', 'DOC-4'] }),
    record('DOC-2', { title: 'Beta', labels: ['drop'], related_to: ['DOC-3'] }), record('DOC-3', { title: 'Gamma', labels: ['keep'] }),
    record('DOC-4', { title: 'Archive', labels: ['keep'], archived: true })];
  assert.deepEqual(buildEntityGraph(files, defaultConfiguration, { search: 'KEEP' }).nodes.map(node => node.id), ['DOC-1', 'DOC-3']);
  const local = buildEntityGraph(files, defaultConfiguration, { centerId: 'DOC-1', depth: 3, view: { layout: 'graph', filter: { labels: 'keep' } } });
  assert.deepEqual(local.nodes.map(node => node.id), ['DOC-1']);
  assert.deepEqual(buildEntityGraph(files, defaultConfiguration, { centerId: 'DOC-1', search: 'Beta' }), { nodes: [], links: [], unresolved: [], availableRelations: [] });
  assert.deepEqual(buildEntityGraph(files, defaultConfiguration, { centerId: 'DOC-4' }).nodes, []);
  assert.equal(buildEntityGraph(files, defaultConfiguration, { archived: 'only' }).nodes[0]!.archived, true);
});

test('authorization trims after full-workspace resolution and never exposes hidden diagnostics or relation statistics', () => {
  const source = record('DOC-1', { related_to: ['DOC-3'] }, '[[Shared]] [[DOC-3]] [[Missing]]');
  const visible = record('DOC-2', { title: 'Shared' });
  const hidden = record('DOC-3', { title: 'Shared' }, '[[Hidden diagnostic]]');
  const files = [source, visible, hidden];
  const visibleIds = new Set(['DOC-1', 'DOC-2']);
  const scoped = buildEntityGraph(files, defaultConfiguration, {}, { visibleIds, includeUnresolved: true });
  assert.deepEqual(scoped.nodes.map(node => node.id), ['DOC-1', 'DOC-2']);
  assert.deepEqual(scoped.links, [], 'the hidden same-name candidate must still prevent false visible resolution');
  assert.deepEqual(scoped.unresolved, []);
  assert.deepEqual(scoped.availableRelations, []);
  assert.equal(JSON.stringify(scoped).includes('DOC-3'), false);
  assert.equal(JSON.stringify(scoped).includes('Missing'), false);
  assert.deepEqual(buildEntityGraph(files, defaultConfiguration, { centerId: 'DOC-1', depth: 3 }, { visibleIds }).nodes.map(node => node.id), ['DOC-1']);
  assert.deepEqual(buildEntityGraph(files, defaultConfiguration, { centerId: 'DOC-3' }, { visibleIds }).nodes, []);
});

test('query schema rejects loose shapes and coercion while allowing empty relation selection and full depth range', () => {
  const invalid: unknown[] = [null, [], { unknown: true }, { search: 1 }, { search: 'x'.repeat(501) }, { archived: 'all' },
    { centerId: '' }, { centerId: 'not-an-id' }, { centerId: 1 }, { depth: 0 }, { depth: 4 }, { depth: 1.5 }, { depth: '2' },
    { relations: 'link' }, { relations: [1] }, { relations: [''] }, { relations: [' '] }, { relations: Array(257).fill('link') },
    { view: null }, { view: [] }, { view: { layout: 'graph', unexpected: true } },
    { view: { layout: 'graph', where: { field: 'title', op: 'regex', value: '.*' } } },
  ];
  for (const input of invalid) assert.equal(graphQuerySchema.safeParse(input).success, false, JSON.stringify(input));
  for (const depth of [1, 2, 3]) assert.equal(graphQuerySchema.safeParse({ centerId: 'DOC-1', depth, relations: [] }).success, true);
  assert.throws(() => buildEntityGraph([], defaultConfiguration, { view: { layout: 'graph', filter: { unknown: 'value' } } }), /Unknown query field/);
});

test('workspace graph is a read-only saved projection, retains stale markers, and rejects inaccessible centers identically', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pm-graph-'));
  const workspace = new Workspace(root);
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  const first = record('DOC-1', {}, '[[DOC-2]]'); const second = record('DOC-2');
  await writeFile(path.join(root, 'docs', 'one.md'), first.raw);
  await writeFile(path.join(root, 'docs', 'two.md'), second.raw);
  await workspace.init();
  const before = workspace.snapshot();
  const visible = (file: FileRecord) => file.id === 'DOC-1';
  for (const centerId of ['DOC-2', 'DOC-999']) assert.throws(() => workspace.graph({ centerId }, visible), (error: unknown) => {
    assert.ok(error instanceof WorkspaceError); assert.equal(error.status, 404); assert.equal(error.message, 'Entity is not accessible');
    assert.equal(JSON.stringify(error.diagnostics).includes(centerId), false); return true;
  });
  assert.deepEqual(workspace.graph({ centerId: 'DOC-1', search: 'excluded' }, visible).nodes, []);
  assert.deepEqual(workspace.snapshot(), before);
  assert.equal(await readFile(path.join(root, 'docs', 'one.md'), 'utf8'), first.raw);
  await writeFile(path.join(root, 'docs', 'two.md'), second.raw.replace('schema: pm/v1', 'schema: [broken'));
  await workspace.rescan();
  assert.equal(workspace.graph().nodes.find(node => node.id === 'DOC-2')!.stale, true);
});
