import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { Workspace, WorkspaceError, revisionOf } from '../../pm-core/index.ts';
import { FileRepository } from '../../pm-core/repository.ts';
import { DurableState, requestHash } from '../../pm-core/state.ts';
import { Projection } from '../../pm-core/projection.ts';
import { MigrationManager, type MigrationPlan, type MigrationResult } from '../../pm-core/migrations.ts';
import { createMarkdown } from '../../pm-markdown/index.ts';
import { defaultConfiguration, entityDefinitions, entityKinds, parseConfiguration, statusCategory, type FileRecord, type ProtocolConfiguration } from '../../pm-schema/index.ts';
import { applyView } from '../../pm-schema/query.ts';

async function fixture(t: TestContext, files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'markdown-pm-advanced-core-'));
  for (const [name, raw] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), raw);
  }
  const fixture = { root, workspace: new Workspace(root) };
  t.after(async () => { await fixture.workspace.close(); await rm(root, { recursive: true, force: true }); });
  await fixture.workspace.init();
  return fixture;
}

function workflowConfig(): ProtocolConfiguration {
  return parseConfiguration({ schema: 'pm/config/v1', workflows: { work_item: {
    initial: 'queued',
    states: [
      { id: 'queued', label: 'Queued', category: 'unstarted' },
      { id: 'building', label: 'Building', category: 'started' },
      { id: 'shipped', label: 'Shipped', category: 'completed' },
    ],
    transitions: [{ from: 'queued', to: 'building' }, { from: 'building', to: 'shipped' }],
  } }, custom_fields: [
    { name: 'x-points', label: 'Points', type: 'number', entities: ['work_item'], min: 0, max: 100, default: 1 },
    { name: 'x-team', label: 'Team', type: 'select', entities: ['work_item'], options: ['red', 'blue'], default: 'red' },
    { name: 'x-ready', label: 'Ready', type: 'boolean', entities: ['work_item'], default: false },
  ] });
}

function errorCode(code: string): (error: unknown) => boolean {
  return error => error instanceof WorkspaceError && error.diagnostics.some(item => item.code === code);
}

function changed(workspace: Workspace, predicate: () => boolean): Promise<void> {
  const promise = Promise.withResolvers<void>();
  // The real OS watcher is under test; this deadline only bounds missing events, never sleeps for success.
  const timeout = setTimeout(() => { unsubscribe(); promise.reject(new Error('Configuration watcher did not emit the expected state')); }, 6000);
  const unsubscribe = workspace.onChange(() => {
    if (predicate()) { clearTimeout(timeout); unsubscribe(); promise.resolve(); }
  });
  return promise.promise;
}

test('Workspace config CAS supplies effective contextual workflow and typed defaults across restart', async t => {
  const current = await fixture(t);
  assert.equal(current.workspace.configuration().revision, 'absent');
  assert.deepEqual(current.workspace.snapshot().configurationErrors, []);
  const saved = await current.workspace.saveConfiguration(workflowConfig(), 'absent');
  const raw = await readFile(path.join(current.root, '.pm/config.yaml'), 'utf8');
  assert.equal(saved.revision, revisionOf(raw));
  assert.deepEqual(saved.diagnostics, []);
  const task = await current.workspace.create({ title: 'Configured task' });
  assert.equal(task.entity.status, 'queued');
  assert.equal(task.entity['x-points'], 1);
  assert.equal(task.entity['x-team'], 'red');
  assert.equal(task.entity['x-ready'], false);
  assert.deepEqual(current.workspace.items({ status: 'queued' }).map(file => file.id), [task.id]);
  assert.deepEqual((current.workspace.protocol().statuses as Record<string, string[]>).work_item, ['queued', 'building', 'shipped']);
  await assert.rejects(current.workspace.saveConfiguration(defaultConfiguration, 'absent'), errorCode('REVISION_CONFLICT'));
  const incompatible = structuredClone(saved.config);
  incompatible.custom_fields[0].min = 2;
  incompatible.custom_fields[0].default = 2;
  await assert.rejects(current.workspace.saveConfiguration(incompatible, saved.revision), error => {
    assert.ok(error instanceof WorkspaceError);
    assert.ok(error.diagnostics.some(item => item.path === task.path));
    return true;
  });
  assert.equal(await readFile(path.join(current.root, '.pm/config.yaml'), 'utf8'), raw);
  await current.workspace.close();
  await rm(path.join(current.root, '.pm/cache'), { recursive: true });
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.get(task.id).entity.status, 'queued');
  assert.equal(current.workspace.configuration().revision, saved.revision);
  assert.equal((await current.workspace.create({ title: 'Next configured task' })).id, 'TASK-002');
});

test('Invalid external configuration stays visible, retains last-good display and blocks every ordinary write', async t => {
  const { root, workspace } = await fixture(t);
  const config = await workspace.saveConfiguration(workflowConfig(), 'absent');
  const task = await workspace.create({ title: 'Keep safe' });
  const invalid = 'schema: pm/config/v1\nworkflows: [\n';
  const observed = changed(workspace, () => workspace.configuration().diagnostics.length > 0);
  await writeFile(path.join(root, '.pm/config.yaml'), invalid);
  await observed;
  assert.equal(workspace.configuration().revision, revisionOf(invalid));
  assert.equal(workspace.configuration().config.workflows.work_item?.initial, 'queued');
  assert.ok(workspace.snapshot().configurationErrors.length);
  assert.ok(workspace.snapshot().errors.some(error => error.code === 'CONFIGURATION_INVALID'));
  for (const operation of [
    () => workspace.create({ title: 'Blocked' }),
    () => workspace.patch(task.id, { title: 'Blocked' }, task.revision),
    () => workspace.save(task.id, task.raw, task.revision),
    () => workspace.saveView('blocked', { name: 'Blocked', layout: 'table' }),
  ]) await assert.rejects(operation(), errorCode('CONFIGURATION_INVALID'));
  assert.equal(await readFile(path.join(root, task.path), 'utf8'), task.raw);
  await assert.rejects(workspace.saveConfiguration(config.config, config.revision), errorCode('REVISION_CONFLICT'));
  const repaired = await workspace.saveConfiguration(config.config, revisionOf(invalid));
  assert.deepEqual(repaired.diagnostics, []);
  assert.equal((await workspace.patch(task.id, { title: 'Repaired' }, task.revision)).entity.title, 'Repaired');
});

test('Contextual transitions cover structured, raw and external writes and retain last-good state', async t => {
  const current = await fixture(t);
  await current.workspace.saveConfiguration(workflowConfig(), 'absent');
  let task = await current.workspace.create({ title: 'Workflow' });
  await assert.rejects(current.workspace.patch(task.id, { status: 'shipped' }, task.revision));
  const forbidden = task.raw.replace('status: queued', 'status: shipped');
  await assert.rejects(current.workspace.save(task.id, forbidden, task.revision));
  assert.equal(await readFile(path.join(current.root, task.path), 'utf8'), task.raw);
  await writeFile(path.join(current.root, task.path), forbidden);
  await current.workspace.rescan();
  const stale = current.workspace.get(task.id);
  assert.equal(stale.entity.status, 'queued');
  assert.equal(stale.raw, forbidden);
  assert.equal(stale.stale, true);
  await current.workspace.rescan();
  assert.equal(current.workspace.get(task.id).stale, true);
  task = await current.workspace.save(task.id, forbidden.replace('status: shipped', 'status: building'), stale.revision);
  assert.equal(task.entity.status, 'building');
  assert.equal(task.stale, undefined);
  task = await current.workspace.patch(task.id, { status: 'shipped' }, task.revision);
  assert.equal(statusCategory(task.entity, current.workspace.configuration().config), 'completed');
  const edited = await current.workspace.patch(task.id, { title: 'Same status is legal' }, task.revision);
  assert.equal(edited.entity.status, 'shipped');
  await current.workspace.close();
  await writeFile(path.join(current.root, task.path), edited.raw.replace('status: shipped', 'status: queued'));
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.get(task.id).entity.status, 'shipped');
  assert.equal(current.workspace.get(task.id).stale, true);
});

test('Workspace allocates every model from the registry and preserves IDs without its cache', async t => {
  const current = await fixture(t);
  const records = new Map<string, FileRecord>();
  for (const kind of entityKinds) {
    const created = await current.workspace.createEntity({ entity: kind, title: `First ${kind}` });
    const definition = entityDefinitions[kind];
    assert.equal(created.id, `${definition.prefix}-001`);
    assert.equal(created.path, `${definition.directory}/${created.id}.md`);
    records.set(kind, created);
  }
  assert.equal(current.workspace.query({ layout: 'table' }).length, 9);
  assert.deepEqual(current.workspace.items().map(file => file.id), ['TASK-001']);
  assert.deepEqual(current.workspace.items({ entity: 'cycle' }).map(file => file.id), ['CYC-001']);
  await current.workspace.close();
  await rm(path.join(current.root, '.pm/cache'), { recursive: true });
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  for (const kind of entityKinds) {
    const record = records.get(kind)!;
    assert.equal(current.workspace.get(record.id).entity.entity, kind);
    assert.equal((await current.workspace.createEntity({ entity: kind, title: `Second ${kind}` })).id, `${entityDefinitions[kind].prefix}-002`);
  }
});

test('Formal and custom references appear in both context directions and guard deletion', async t => {
  const { workspace } = await fixture(t);
  await workspace.saveConfiguration(parseConfiguration({ schema: 'pm/config/v1', workflows: {}, custom_fields: [
    { name: 'x-spec', label: 'Specification', type: 'reference', target: 'document', entities: ['work_item'] },
  ] }), 'absent');
  const project = await workspace.createEntity({ entity: 'project', title: 'Project' });
  const goal = await workspace.createEntity({ entity: 'goal', title: 'Cross-project goal' });
  const document = await workspace.createEntity({ entity: 'document', title: 'Specification' });
  const references: Record<string, string> = {};
  for (const kind of ['cycle', 'milestone', 'module', 'requirement', 'release'] as const) {
    const target = await workspace.createEntity({ entity: kind, title: `Target ${kind}`, project: project.id, goals: [goal.id] });
    references[kind] = target.id;
  }
  const task = await workspace.create({ title: 'Connected task', project: project.id, ...references, goals: [goal.id], 'x-spec': document.id });
  const context = workspace.context(task.id).markdown;
  for (const id of [...Object.values(references), goal.id, document.id]) assert.ok(context.includes(`### ${id} (`), id);
  assert.match(workspace.context(document.id).markdown, /backlink:x-spec/);
  assert.match(workspace.context(references.cycle).markdown, /backlink:cycle/);
  assert.match(workspace.context(goal.id).markdown, /backlink:goals/);
  for (const id of [...Object.values(references), goal.id, document.id]) {
    const archived = await workspace.archive(id, workspace.get(id).revision);
    await assert.rejects(workspace.delete(id, archived.revision), errorCode('DELETE_REFERENCED'));
  }
  const otherProject = await workspace.createEntity({ entity: 'project', title: 'Other project' });
  const wrongCycle = await workspace.createEntity({ entity: 'cycle', title: 'Wrong project cycle', project: otherProject.id });
  await assert.rejects(workspace.patch(task.id, { cycle: wrongCycle.id }, task.revision), errorCode('REFERENCE_PROJECT_MISMATCH'));
  await assert.rejects(workspace.patch(task.id, { 'x-spec': project.id }, task.revision), errorCode('REFERENCE_TYPE'));
  const cleared = await workspace.patch(task.id, { 'x-spec': null }, task.revision);
  assert.equal(cleared.entity['x-spec'], undefined);
  const target = workspace.get(document.id);
  await workspace.delete(document.id, target.revision);
  assert.ok(!workspace.snapshot().files.some(file => file.id === document.id));
});

test('Workspace queries share typed DSL, archival and multi-sort semantics with the view evaluator', async t => {
  const { workspace } = await fixture(t);
  await workspace.saveConfiguration(workflowConfig(), 'absent');
  const first = await workspace.create({ title: 'One', 'x-points': 2, 'x-ready': true, due: '2026-11-02' });
  const second = await workspace.create({ title: 'Two', 'x-points': 10, 'x-ready': true, due: '2026-11-03' });
  const archived = await workspace.create({ title: 'Archived', 'x-points': 30, 'x-ready': true, archived: true, due: '2026-11-04' });
  await workspace.create({ title: 'Not ready', 'x-points': 50, 'x-ready': false });
  const view = { layout: 'table' as const, entity: 'work_item' as const,
    where: { all: [{ field: 'x-points', op: 'gte' as const, value: 2 }, { any: [{ field: 'x-ready', op: 'eq' as const, value: true }] }, { field: 'due', op: 'lt' as const, value: '2026-12-01' }] },
    order_by: [{ field: 'x-points', direction: 'desc' as const }, { field: 'title', direction: 'asc' as const }] };
  assert.deepEqual(workspace.query(view).map(file => file.id), [second.id, first.id]);
  assert.deepEqual(workspace.query(view, { archived: 'include' }).map(file => file.id), [archived.id, second.id, first.id]);
  assert.deepEqual(workspace.query(view), applyView(workspace.snapshot().files, view, { configuration: workspace.configuration().config }));
  assert.throws(() => workspace.query({ layout: 'table', where: { field: 'x-unknown', op: 'eq', value: 1 } }));
});

test('Saved view CAS persists order including hidden and archived IDs, never its system revision', async t => {
  const current = await fixture(t);
  const first = await current.workspace.create({ title: 'Visible', priority: 'high' });
  const hidden = await current.workspace.create({ title: 'Filtered out', priority: 'low' });
  const archived = await current.workspace.create({ title: 'Archived', priority: 'high', archived: true });
  let view = await current.workspace.saveView('ordered', { name: 'Order', layout: 'table', entity: 'work_item', filter: { priority: 'high' }, order: [archived.id, hidden.id, first.id] });
  assert.ok(view.revision);
  assert.deepEqual(current.workspace.query(view).map(file => file.id), [first.id]);
  assert.deepEqual(current.workspace.query(view, { archived: 'include' }).map(file => file.id), [archived.id, first.id]);
  const raw = await readFile(path.join(current.root, '.pm/views/ordered.yaml'), 'utf8');
  assert.equal(parse(raw).revision, undefined);
  await assert.rejects(current.workspace.saveView(view.id, { name: 'No revision', layout: 'table' }), errorCode('REVISION_CONFLICT'));
  await assert.rejects(current.workspace.saveView('new', { name: 'Wrong create revision', layout: 'table', revision: view.revision }), errorCode('REVISION_CONFLICT'));
  await assert.rejects(current.workspace.saveView(view.id, { ...view, order: [first.id, first.id] }));
  await assert.rejects(current.workspace.saveView(view.id, { ...view, order: ['TASK-999'] }), errorCode('VIEW_ORDER_INVALID'));
  const staleRevision = view.revision;
  view = await current.workspace.saveView(view.id, { ...view, order: [first.id, hidden.id, archived.id] });
  await assert.rejects(current.workspace.saveView(view.id, { ...view, revision: staleRevision }), errorCode('REVISION_CONFLICT'));
  await current.workspace.close();
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.deepEqual(current.workspace.snapshot().views, [view]);
});

test('Existing yml views use the observed path and exact-byte CAS', async t => {
  const raw = 'id: compact\nname: Compact\nlayout: table\nfilter:\n  status: todo\nsort: title\n';
  const { workspace, root } = await fixture(t, { '.pm/views/compact.yml': raw });
  const original = workspace.snapshot().views[0];
  assert.equal(original.revision, revisionOf(raw));
  const saved = await workspace.saveView(original.id, { ...original, name: 'Updated' });
  assert.equal(parse(await readFile(path.join(root, '.pm/views/compact.yml'), 'utf8')).name, 'Updated');
  assert.notEqual(saved.revision, original.revision);
  await assert.rejects(readFile(path.join(root, '.pm/views/compact.yaml'), 'utf8'), { code: 'ENOENT' });
});

test('Unsafe config paths fail closed instead of falling back to defaults', async t => {
  const { workspace, root } = await fixture(t);
  const task = await workspace.create({ title: 'Safe task' });
  const outside = await mkdtemp(path.join(os.tmpdir(), 'markdown-pm-config-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const filename = path.join(outside, 'config.yaml');
  const raw = stringify(defaultConfiguration);
  await writeFile(filename, raw);
  await symlink(filename, path.join(root, '.pm/config.yaml'));
  await workspace.rescan();
  assert.ok(workspace.configuration().diagnostics.length);
  await assert.rejects(workspace.patch(task.id, { title: 'Unsafe' }, task.revision), errorCode('CONFIGURATION_INVALID'));
  await assert.rejects(workspace.saveConfiguration(defaultConfiguration, workspace.configuration().revision));
  assert.equal(await readFile(filename, 'utf8'), raw);
});

test('Workspace migration applies and restores deliberately disallowed transitions without stale projections', async t => {
  const { workspace } = await fixture(t);
  await workspace.saveConfiguration(workflowConfig(), 'absent');
  const task = await workspace.create({ title: 'Migrated task' });
  await assert.rejects(workspace.patch(task.id, { status: 'shipped' }, task.revision));
  const plan = await workspace.migration('preview', { kind: 'transform', changes: [{ id: task.id, set: { status: 'shipped' } }] }) as MigrationPlan;
  const applied = await workspace.migration('apply', { id: plan.id, revision: plan.revision }) as MigrationResult;
  assert.equal(applied.status, 'applied');
  assert.equal(workspace.get(task.id).entity.status, 'shipped');
  assert.equal(workspace.get(task.id).stale, undefined);
  const restored = await workspace.migration('restore', { id: plan.id, revision: plan.revision }) as MigrationResult;
  assert.equal(restored.status, 'restored');
  assert.equal(workspace.get(task.id).raw, task.raw);
  assert.equal(workspace.get(task.id).entity.status, 'queued');
  assert.equal(workspace.get(task.id).stale, undefined);
});

test('Malformed migration journals block mutation before and after restart without hiding sources', async t => {
  const current = await fixture(t);
  const task = await current.workspace.create({ title: 'Protected' });
  const journal = path.join(current.root, '.pm/state/migrations/journal.json');
  await mkdir(path.dirname(journal), { recursive: true });
  await writeFile(journal, '{broken');
  for (const operation of [
    () => current.workspace.create({ title: 'Blocked' }),
    () => current.workspace.patch(task.id, { title: 'Blocked' }, task.revision),
    () => current.workspace.saveView('blocked', { name: 'Blocked', layout: 'table' }),
    () => current.workspace.saveConfiguration(defaultConfiguration, 'absent'),
    () => current.workspace.migration('preview', { kind: 'normalize-v1' }),
  ]) await assert.rejects(operation(), errorCode('MIGRATION_TAMPERED'));
  assert.ok(current.workspace.snapshot().errors.some(error => error.code === 'MIGRATION_TAMPERED'));
  assert.equal(current.workspace.get(task.id).raw, task.raw);
  await current.workspace.close();
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.get(task.id).raw, task.raw);
  await assert.rejects(current.workspace.create({ title: 'Still blocked' }), errorCode('MIGRATION_TAMPERED'));
});

test('Committed migration evidence survives a pre-cache crash without authorizing unrelated external transitions', async t => {
  const current = await fixture(t);
  await current.workspace.saveConfiguration(workflowConfig(), 'absent');
  const migrated = await current.workspace.create({ title: 'Migration target' });
  const external = await current.workspace.create({ title: 'Unrelated external source' });
  await current.workspace.close();
  const manager = new MigrationManager(new FileRepository(current.root));
  const plan = manager.preview({ kind: 'transform', changes: [{ id: migrated.id, set: { status: 'shipped' } }] });
  manager.apply({ id: plan.id, revision: plan.revision });
  assert.equal(manager.pending(), false);
  await writeFile(path.join(current.root, external.path), external.raw.replace('status: queued', 'status: shipped'));
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.get(migrated.id).entity.status, 'shipped');
  assert.equal(current.workspace.get(migrated.id).stale, undefined);
  assert.equal(current.workspace.get(external.id).entity.status, 'queued');
  assert.equal(current.workspace.get(external.id).stale, true);
});

test('Durable creation recovery validates pending Markdown against workspace configuration', async t => {
  const current = await fixture(t);
  const config = workflowConfig();
  await current.workspace.saveConfiguration(config, 'absent');
  await current.workspace.close();
  const repository = new FileRepository(current.root);
  repository.init();
  const state = new DurableState(repository);
  const raw = createMarkdown({ id: 'TASK-017', entity: 'work_item', title: 'Recovered custom workflow' }, config);
  state.begin({ kind: 'create', id: 'TASK-017', path: 'work-items/TASK-017.md', raw });
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.get('TASK-017').entity.status, 'queued');
  assert.equal(await readFile(path.join(current.root, 'work-items/TASK-017.md'), 'utf8'), raw);
  assert.equal(new DurableState(repository).transaction, undefined);
  assert.equal((await current.workspace.create({ title: 'After recovery' })).id, 'TASK-018');
});

test('Removing or semantically breaking config never silently re-enables default workflow writes', async t => {
  const { workspace, root } = await fixture(t);
  const config = workflowConfig();
  await workspace.saveConfiguration(config, 'absent');
  const task = await workspace.create({ title: 'Nondefault state' });
  await writeFile(path.join(root, '.pm/config.yaml'), stringify(defaultConfiguration));
  await workspace.rescan();
  assert.equal(workspace.configuration().config.workflows.work_item?.initial, 'queued');
  assert.ok(workspace.configuration().diagnostics.some(item => item.path === task.path));
  await assert.rejects(workspace.create({ title: 'Must not become todo' }), errorCode('CONFIGURATION_INVALID'));
  await rm(path.join(root, '.pm/config.yaml'));
  await workspace.rescan();
  assert.equal(workspace.configuration().revision, 'absent');
  assert.ok(workspace.configuration().diagnostics.length);
  await assert.rejects(workspace.create({ title: 'Still not todo' }), errorCode('CONFIGURATION_INVALID'));
  await workspace.saveConfiguration(config, 'absent');
  assert.equal((await workspace.create({ title: 'Restored configuration' })).entity.status, 'queued');
});

test('Invalid config prevents pending lifecycle recovery from publishing source bytes', async t => {
  const current = await fixture(t);
  const config = workflowConfig();
  await current.workspace.saveConfiguration(config, 'absent');
  await current.workspace.close();
  const repository = new FileRepository(current.root);
  const state = new DurableState(repository);
  const raw = createMarkdown({ id: 'TASK-021', entity: 'work_item', title: 'Pending contextual task' }, config);
  state.begin({ kind: 'create', id: 'TASK-021', path: 'work-items/TASK-021.md', raw });
  await writeFile(path.join(current.root, '.pm/config.yaml'), 'schema: pm/config/v1\nworkflows: [\n');
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.ok(current.workspace.configuration().diagnostics.length);
  assert.equal(new DurableState(repository).transaction?.id, 'TASK-021');
  await assert.rejects(readFile(path.join(current.root, 'work-items/TASK-021.md'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(current.workspace.create({ title: 'Cannot bypass recovery' }), errorCode('RECOVERY_CONFLICT'));
  await current.workspace.close();
  await writeFile(path.join(current.root, '.pm/config.yaml'), stringify(config));
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.get('TASK-021').raw, raw);
  assert.equal(new DurableState(repository).transaction, undefined);
});

test('Explicit saved and embedded view orders protect archived entities from deletion', async t => {
  const { workspace } = await fixture(t);
  const task = await workspace.create({ title: 'Ordered target', archived: true });
  const document = await workspace.createEntity({ entity: 'document', title: 'Ordered report',
    body: `\`\`\`pm-view\nlayout: table\nentity: work_item\norder: [${task.id}]\n\`\`\`\n` });
  const view = await workspace.saveView('ordered-reference', {
    name: 'Ordered reference', layout: 'table', entity: 'work_item', order: [task.id],
  });
  await assert.rejects(workspace.delete(task.id, task.revision), error => {
    assert.ok(error instanceof WorkspaceError);
    assert.ok(error.diagnostics.some(item => item.code === 'DELETE_REFERENCED' && item.path === '.pm/views/ordered-reference.yaml' && item.field === 'order'));
    assert.ok(error.diagnostics.some(item => item.code === 'DELETE_REFERENCED' && item.path === document.path && item.field === 'views.0.order'));
    return true;
  });
  assert.equal(workspace.snapshot().views[0].id, view.id);
  assert.deepEqual(workspace.snapshot().errors, []);
  await workspace.saveView(view.id, { ...view, order: [] });
  await workspace.save(document.id, document.raw.replace(`order: [${task.id}]`, 'order: []'), document.revision);
  await workspace.delete(task.id, task.revision);
  assert.equal(workspace.snapshot().views[0].id, view.id);
  assert.deepEqual((await workspace.saveConfiguration(defaultConfiguration, 'absent')).diagnostics, []);
});

test('Cold config loading keeps malformed sources individually repairable under configured workflows', async t => {
  const config = workflowConfig();
  const valid = createMarkdown({ id: 'TASK-001', entity: 'work_item', title: 'Configured intact task' }, config);
  const broken = '---\nschema: pm/v1\nid: TASK-002\nentity: work_item\nstatus: [\n---\n# Repair me\n';
  const brokenView = 'name: Broken view\nlayout: calendar\n';
  const { workspace } = await fixture(t, {
    '.pm/config.yaml': stringify(config),
    'work-items/TASK-001.md': valid,
    'work-items/TASK-002.md': broken,
    '.pm/views/broken.yaml': brokenView,
  });
  assert.deepEqual(workspace.configuration().diagnostics, []);
  assert.equal(workspace.get('TASK-001').entity.status, 'queued');
  assert.equal(workspace.get('TASK-001').stale, undefined);
  assert.ok(workspace.snapshot().errors.some(item => item.path === 'work-items/TASK-002.md'));
  assert.ok(workspace.snapshot().errors.some(item => item.path === '.pm/views/broken.yaml'));
  const repaired = createMarkdown({ id: 'TASK-002', entity: 'work_item', title: 'Repaired configured task' }, config);
  assert.equal((await workspace.save('TASK-002', repaired, revisionOf(broken))).entity.status, 'queued');
  await workspace.saveView('broken', { name: 'Repaired view', layout: 'table', revision: revisionOf(brokenView) });
  const first = workspace.get('TASK-001');
  assert.equal((await workspace.patch(first.id, { status: 'building' }, first.revision)).entity.status, 'building');
  assert.deepEqual(workspace.snapshot().errors, []);
});

test('Acknowledged migration transitions never authorize later replay after an allowed reverse', async t => {
  const current = await fixture(t);
  const config = workflowConfig();
  config.workflows.work_item!.transitions = [{ from: 'shipped', to: 'queued' }];
  await current.workspace.saveConfiguration(config, 'absent');
  const task = await current.workspace.create({ title: 'One-time migration' });
  const plan = await current.workspace.migration('preview', { kind: 'transform', changes: [{ id: task.id, set: { status: 'shipped' } }] }) as MigrationPlan;
  await current.workspace.migration('apply', { id: plan.id, revision: plan.revision });
  const migrated = current.workspace.get(task.id);
  const manager = new MigrationManager(new FileRepository(current.root));
  assert.deepEqual(manager.completedTransitions(), []);
  await current.workspace.patch(task.id, { status: 'queued' }, migrated.revision);
  await current.workspace.close();
  await writeFile(path.join(current.root, task.path), migrated.raw);
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.get(task.id).entity.status, 'queued');
  assert.equal(current.workspace.get(task.id).stale, true);
});

test('Projection-before-ack crash retires evidence after a valid offline reverse transition', async t => {
  const current = await fixture(t);
  const config = workflowConfig();
  config.workflows.work_item!.transitions = [{ from: 'shipped', to: 'queued' }];
  await current.workspace.saveConfiguration(config, 'absent');
  const task = await current.workspace.create({ title: 'Crash boundary' });
  const plan = await current.workspace.migration('preview', { kind: 'transform', changes: [{ id: task.id, set: { status: 'shipped' } }] }) as MigrationPlan;
  const acknowledgment = t.mock.method(MigrationManager.prototype, 'acknowledgeTransitions', () => { throw new Error('Interrupted after projection publication'); });
  await current.workspace.migration('apply', { id: plan.id, revision: plan.revision });
  const migrated = current.workspace.get(task.id);
  assert.equal(migrated.entity.status, 'shipped');
  acknowledgment.mock.restore();
  await current.workspace.close();
  await writeFile(path.join(current.root, task.path), task.raw);
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.get(task.id).entity.status, 'queued');
  assert.equal(current.workspace.get(task.id).stale, undefined);
  assert.deepEqual(new MigrationManager(new FileRepository(current.root)).completedTransitions(), []);
  await current.workspace.close();
  await writeFile(path.join(current.root, task.path), migrated.raw);
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.get(task.id).entity.status, 'queued');
  assert.equal(current.workspace.get(task.id).stale, true);
});

test('Repairing an initially stale source retires pending migration evidence without a later exemption', async t => {
  const current = await fixture(t);
  await current.workspace.saveConfiguration(workflowConfig(), 'absent');
  const task = await current.workspace.create({ title: 'Repair then reject replay' });
  await current.workspace.close();
  const manager = new MigrationManager(new FileRepository(current.root));
  const plan = manager.preview({ kind: 'transform', changes: [{ id: task.id, set: { status: 'shipped' } }] });
  manager.apply({ id: plan.id, revision: plan.revision });
  const migratedRaw = await readFile(path.join(current.root, task.path), 'utf8');
  const invalid = task.raw.replace('status: queued', 'status: [');
  await writeFile(path.join(current.root, task.path), invalid);
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.get(task.id).stale, true);
  assert.equal(current.workspace.get(task.id).entity.status, 'queued');
  assert.equal(manager.completedTransitions().length, 1);
  const repaired = await current.workspace.save(task.id, task.raw, revisionOf(invalid));
  assert.equal(repaired.stale, undefined);
  assert.equal(repaired.entity.status, 'queued');
  assert.deepEqual(manager.completedTransitions(), []);
  await current.workspace.close();
  await writeFile(path.join(current.root, task.path), migratedRaw);
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.get(task.id).entity.status, 'queued');
  assert.equal(current.workspace.get(task.id).stale, true);
});

test('Deferred retirement survives publication-to-ack failure with or without the disposable cache', async t => {
  for (const removeCache of [false, true]) await t.test(removeCache ? 'cache removed' : 'cache retained', async sub => {
    const current = await fixture(sub);
    await current.workspace.saveConfiguration(workflowConfig(), 'absent');
    const task = await current.workspace.create({ title: 'Durable repair retirement' }, 'retirement-identity');
    const before = JSON.parse(await readFile(path.join(current.root, '.pm/state/state.json'), 'utf8'));
    await current.workspace.close();
    const repository = new FileRepository(current.root);
    const manager = new MigrationManager(repository);
    const plan = manager.preview({ kind: 'transform', changes: [{ id: task.id, set: { status: 'shipped' } }] });
    manager.apply({ id: plan.id, revision: plan.revision });
    const migratedRaw = await readFile(path.join(current.root, task.path), 'utf8');
    const invalid = task.raw.replace('status: queued', 'status: [');
    await writeFile(path.join(current.root, task.path), invalid);
    current.workspace = new Workspace(current.root);
    await current.workspace.init();
    assert.equal(current.workspace.get(task.id).stale, true);
    const acknowledgment = sub.mock.method(MigrationManager.prototype, 'acknowledgeTransitions', () => { throw new Error('Crash after repaired projection publication'); });
    await current.workspace.save(task.id, task.raw, revisionOf(invalid));
    const journal = new DurableState(repository).migrationProjection;
    assert.ok(journal);
    assert.equal(new DurableState(repository).migrationBaselines().next().value?.raw, task.raw);
    assert.equal(current.workspace.get(task.id).entity.status, 'queued');
    acknowledgment.mock.restore();
    await current.workspace.close();
    if (removeCache) await rm(path.join(current.root, '.pm/cache'), { recursive: true });
    await writeFile(path.join(current.root, task.path), migratedRaw);
    current.workspace = new Workspace(current.root);
    await current.workspace.init();
    assert.equal(current.workspace.get(task.id).entity.status, 'queued');
    assert.equal(current.workspace.get(task.id).stale, true);
    assert.equal(await readFile(path.join(current.root, task.path), 'utf8'), migratedRaw);
    assert.equal(new DurableState(repository).migrationProjection, undefined);
    assert.deepEqual(manager.completedTransitions(), []);
    const after = JSON.parse(await readFile(path.join(current.root, '.pm/state/state.json'), 'utf8'));
    for (const field of ['reservedIds', 'observed', 'idempotency', 'tombstones']) assert.deepEqual(after[field], before[field], field);
  });
});

test('Retirement journal recovers a migration target if publication never reached the cache', async t => {
  const current = await fixture(t);
  await current.workspace.saveConfiguration(workflowConfig(), 'absent');
  const task = await current.workspace.create({ title: 'Before projection publication' });
  const plan = await current.workspace.migration('preview', { kind: 'transform', changes: [{ id: task.id, set: { status: 'shipped' } }] }) as MigrationPlan;
  const publication = t.mock.method(Projection.prototype, 'replace', () => { throw new Error('Crash before cache publication'); });
  await assert.rejects(current.workspace.migration('apply', { id: plan.id, revision: plan.revision }));
  const repository = new FileRepository(current.root);
  const journal = new DurableState(repository).migrationProjection;
  assert.ok(journal);
  assert.match(new DurableState(repository).migrationBaselines().next().value?.raw ?? '', /status: shipped/);
  publication.mock.restore();
  await current.workspace.close();
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.get(task.id).entity.status, 'shipped');
  assert.equal(current.workspace.get(task.id).stale, undefined);
  assert.equal(new DurableState(repository).migrationProjection, undefined);
});

test('Corrupt retirement journals fail closed on checksum, source, path, identity and configuration', async t => {
  for (const corruption of ['checksum', 'revision', 'path', 'identity', 'configuration', 'missing-blob', 'corrupt-blob', 'chunk-count'] as const) await t.test(corruption, async sub => {
    const current = await fixture(sub);
    const task = await current.workspace.create({ title: 'Never replay a corrupt baseline' });
    await current.workspace.close();
    const repository = new FileRepository(current.root);
    const state = new DurableState(repository);
    state.stageMigrationProjection([{ path: task.path, fromRevision: task.revision, toRevision: revisionOf(task.raw + '\n') }], [task], defaultConfiguration, 'absent');
    const filename = path.join(current.root, '.pm/state/state.json');
    const value = JSON.parse(await readFile(filename, 'utf8'));
    const journal = value.migrationProjection;
    if (corruption === 'checksum') journal.checksum = '0'.repeat(64);
    else {
      if (corruption === 'revision') journal.sources[0].revision = '0'.repeat(64);
      if (corruption === 'path') journal.sources[0].path = '../outside.md';
      if (corruption === 'identity') {
        const raw = task.raw.replace(task.id, 'TASK-999');
        const revision = revisionOf(raw);
        repository.write(`.pm/state/projection-blobs/${revision}-0.txt`, raw);
        journal.sources[0].revision = revision;
        journal.sources[0].content = { revision, bytes: Buffer.byteLength(raw), parts: 1 };
      }
      if (corruption === 'configuration') {
        const raw = JSON.stringify({ ...defaultConfiguration, schema: 'pm/config/v2' });
        const revision = revisionOf(raw);
        repository.write(`.pm/state/projection-blobs/${revision}-0.txt`, raw);
        journal.configurations[revision] = { revision, bytes: Buffer.byteLength(raw), parts: 1 };
        journal.sources[0].configuration = revision;
      }
      if (corruption === 'missing-blob') await rm(path.join(current.root, `.pm/state/projection-blobs/${journal.sources[0].content.revision}-0.txt`));
      if (corruption === 'corrupt-blob') await writeFile(path.join(current.root, `.pm/state/projection-blobs/${journal.sources[0].content.revision}-0.txt`), 'corrupted');
      if (corruption === 'chunk-count') journal.sources[0].content.parts += 1;
      const { checksum: _checksum, ...payload } = journal;
      journal.checksum = requestHash(payload);
    }
    await writeFile(filename, JSON.stringify(value, null, 2) + '\n');
    current.workspace = new Workspace(current.root);
    await assert.rejects(current.workspace.init(), errorCode('PERSISTENT_STATE_INVALID'));
    assert.equal(await readFile(path.join(current.root, task.path), 'utf8'), task.raw);
  });
});

test('Retirement shares large contexts and chunks source payloads without aggregate journal serialization', async t => {
  const current = await fixture(t);
  const config = workflowConfig();
  config.custom_fields[0].label = 'Context'.repeat(50_000);
  await current.workspace.saveConfiguration(config, 'absent');
  const tasks: FileRecord[] = [];
  const body = 'Source text '.repeat(30_000);
  for (let index = 0; index < 8; index++) tasks.push(await current.workspace.create({ title: `Chunked task ${index}`, body }));
  const plan = await current.workspace.migration('preview', {
    kind: 'transform', changes: tasks.map(task => ({ id: task.id, set: { status: 'shipped' } })),
  }) as MigrationPlan;
  const acknowledgment = t.mock.method(MigrationManager.prototype, 'acknowledgeTransitions', () => { throw new Error('Keep the chunked retirement journal for recovery'); });
  await current.workspace.migration('apply', { id: plan.id, revision: plan.revision });
  acknowledgment.mock.restore();
  const stateRaw = await readFile(path.join(current.root, '.pm/state/state.json'), 'utf8');
  const journal = JSON.parse(stateRaw).migrationProjection;
  assert.ok(journal);
  assert.ok(Buffer.byteLength(stateRaw) < 64 * 1024, 'Durable metadata must not contain repeated configuration or source payloads');
  assert.equal(Object.keys(journal.configurations).length, 1);
  assert.equal(new Set(journal.sources.map((source: { configuration: string }) => source.configuration)).size, 1);
  assert.ok(journal.configurations[journal.configuration].parts >= 2);
  assert.ok(journal.sources.every((source: { raw?: unknown; content: { parts: number } }) => source.raw === undefined && source.content.parts >= 2));
  for (const blob of [journal.configurations[journal.configuration], ...journal.sources.map((source: { content: unknown }) => source.content)]) {
    for (let part = 0; part < blob.parts; part++) {
      const chunk = await readFile(path.join(current.root, `.pm/state/projection-blobs/${blob.revision}-${part}.txt`));
      assert.ok(chunk.byteLength <= 1024 * 1024);
    }
  }
  await current.workspace.close();
  await rm(path.join(current.root, '.pm/cache'), { recursive: true });
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  for (const task of tasks) {
    const recovered = current.workspace.get(task.id);
    assert.equal(recovered.entity.status, 'shipped');
    assert.equal(recovered.stale, undefined);
    assert.equal(recovered.raw, task.raw.replace('status: queued', 'status: shipped'));
  }
  assert.equal(current.workspace.configuration().config.custom_fields[0].label, config.custom_fields[0].label);
  assert.equal(new DurableState(new FileRepository(current.root)).migrationProjection, undefined);
});
