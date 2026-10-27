import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { MigrationManager, type MigrationPlan } from '../../pm-core/migrations.ts';
import { FileRepository, maxRepositoryFileBytes, revisionOf } from '../../pm-core/repository.ts';
import { DurableState, requestHash } from '../../pm-core/state.ts';
import { createMarkdown, inspectFrontmatter, inspectMarkdown, parseMarkdown } from '../../pm-markdown/index.ts';
import { parseConfiguration, ProtocolError } from '../../pm-schema/index.ts';

const statePath = '.pm/state/state.json';
const configPath = '.pm/config.yaml';
const journalPath = '.pm/state/migrations/journal.json';
const legacyProject = '---\r\nschema: pm/v1\r\nid: PRJ-001\r\nentity: project\r\nstatus: in_progress # preserve workflow comment\r\nvendor: { untouched: true }\r\n---\r\n\r\n# Legacy project\r\n\r\nBody with **formatting**.\r\n';
const legacyDocument = '---\nschema: pm/v1\nid: ADR-001\nentity: document\nstatus: done\nproject: PRJ-001\n---\n\n# Architecture decision\n\nDecision body.\n';

class InterruptedRepository extends FileRepository {
  interrupt?: string;
  onWrite?: (relative: string) => void;
  override write(relative: string, raw: string, expectedRevision?: string): void {
    if (relative === this.interrupt) throw new Error('Simulated power loss');
    super.write(relative, raw, expectedRevision);
    this.onWrite?.(relative);
  }
}
async function fixture(t: TestContext, files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'markdown-pm-migrations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new InterruptedRepository(root);
  repository.init();
  for (const [name, raw] of Object.entries(files)) {
    const parent = path.posix.dirname(name);
    if (parent !== '.') repository.mkdir(parent);
    repository.write(name, raw);
  }
  const state = new DurableState(repository);
  const identities = Object.entries(files).filter(([name]) => name.endsWith('.md')).flatMap(([name, raw]) => {
    const id = inspectMarkdown(raw).id;
    return id ? [{ id, path: name, entity: String(inspectFrontmatter(raw).metadata.entity) }] : [];
  });
  state.observe(identities.map(identity => identity.id), identities);
  return { repository, manager: new MigrationManager(repository), root };
}
function hasCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ProtocolError, String(error));
    assert.ok(error.diagnostics.some(diagnostic => diagnostic.code === code), JSON.stringify(error.diagnostics));
    return true;
  };
}
function assertApplicable(plan: MigrationPlan): void {
  assert.deepEqual(plan.diagnostics.filter(diagnostic => diagnostic.severity === 'error'), []);
}

test('normalize preview persists exact before/after without source changes; apply and restore survive restart', async t => {
  const { repository, manager } = await fixture(t, { 'project.md': legacyProject, 'docs/ADR-001.md': legacyDocument });
  const ledger = repository.read(statePath);
  const plan = manager.preview({ kind: 'normalize-v1' });
  assertApplicable(plan);
  assert.equal(plan.files.length, 2);
  assert.equal(repository.read('project.md'), legacyProject);
  assert.equal(repository.read('docs/ADR-001.md'), legacyDocument);
  assert.equal(repository.read(statePath), ledger);
  const project = plan.files.find(file => file.path === 'project.md')!;
  assert.equal(project.beforeRevision, revisionOf(legacyProject));
  assert.equal(project.afterRevision, revisionOf(project.after!));
  assert.equal(inspectFrontmatter(project.after!).body, inspectFrontmatter(legacyProject).body);
  assert.match(project.after!, /active # preserve workflow comment\r\n/);
  assert.match(project.after!, /vendor: \{ untouched: true \}/);
  assert.equal(parseMarkdown(plan.files.find(file => file.path.endsWith('ADR-001.md'))!.after!).document_kind, 'decision');
  assert.deepEqual(new MigrationManager(repository).list().map(item => item.status), ['preview']);
  const applied = new MigrationManager(repository).apply({ id: plan.id, revision: plan.revision });
  assert.equal(applied.status, 'applied');
  assert.equal(repository.read('project.md'), project.after);
  assert.equal(manager.pending(), false);
  assert.equal(repository.collect().files.length, 2, 'backups never enter source collection');
  assert.equal(new MigrationManager(repository).restore({ id: plan.id, revision: plan.revision }).status, 'restored');
  assert.equal(repository.read('project.md'), legacyProject);
  assert.equal(repository.read('docs/ADR-001.md'), legacyDocument);
  assert.equal(repository.read(statePath), ledger);
  assert.equal(manager.list()[0].status, 'restored');
});

test('normalization preserves explicit classification and classifies non-ADR legacy documents as notes', async t => {
  const note = legacyDocument.replace('ADR-001', 'DOC-001').replace('project: PRJ-001\n', '');
  const design = note.replace('DOC-001', 'DOC-002').replace('status: done', 'status: done\ndocument_kind: design');
  const { manager } = await fixture(t, { 'note.md': note, 'design.md': design });
  const plan = manager.preview({ kind: 'normalize-v1' });
  assertApplicable(plan);
  assert.equal(parseMarkdown(plan.files.find(file => file.path === 'note.md')!.after!).document_kind, 'note');
  assert.equal(parseMarkdown(plan.files.find(file => file.path === 'design.md')!.after!).document_kind, 'design');
});

test('transform migrates workflow and typed custom fields together, retaining YAML comments and Markdown bytes', async t => {
  const beforeConfig = parseConfiguration({ schema: 'pm/config/v1', custom_fields: [
    { name: 'x-points', label: 'Points', type: 'number', entities: ['work_item'] },
    { name: 'x-obsolete', label: 'Old field', type: 'text', entities: ['work_item'] },
  ] });
  const nextConfig = parseConfiguration({ schema: 'pm/config/v1', workflows: { work_item: {
    initial: 'queued', states: [{ id: 'queued', label: 'Queued', category: 'unstarted' }, { id: 'closed', label: 'Closed', category: 'completed' }], transitions: [],
  } }, custom_fields: [{ name: 'x-estimate', label: 'Estimate', type: 'number', entities: ['work_item'], min: 0 }] });
  const source = createMarkdown({ id: 'TASK-001', title: 'Task', 'x-points': 3, 'x-obsolete': 'remove', body: 'Keep `code` and [links](https://example.com).\n' }, beforeConfig)
    .replace('x-points: 3', 'x-points: 3 # estimate comment');
  const rawConfig = `# Original config comment\n${stringify(beforeConfig)}`;
  const { repository, manager } = await fixture(t, { 'task.md': source, [configPath]: rawConfig });
  const plan = manager.preview({ kind: 'transform', config: nextConfig, changes: [{ id: 'TASK-001', rename: { 'x-points': 'x-estimate' }, unset: ['x-obsolete'], set: { status: 'queued' } }] });
  assertApplicable(plan);
  manager.apply(plan);
  const after = repository.read('task.md');
  const entity = parseMarkdown(after, nextConfig);
  assert.equal(entity.status, 'queued');
  assert.equal(entity['x-estimate'], 3);
  assert.equal(entity['x-points'], undefined);
  assert.equal(entity['x-obsolete'], undefined);
  assert.match(after, /x-estimate: 3 # estimate comment/);
  assert.equal(inspectFrontmatter(after).body, inspectFrontmatter(source).body);
  assert.equal(manager.restore(plan).status, 'restored');
  assert.equal(repository.read('task.md'), source);
  assert.equal(repository.read(configPath), rawConfig);
});

test('restore removes newly introduced configuration but never rewinds IDs, idempotency or tombstones', async t => {
  const task = createMarkdown({ id: 'TASK-001', title: 'Existing' });
  const { repository, manager } = await fixture(t, { 'task.md': task });
  const config = parseConfiguration({ schema: 'pm/config/v1', custom_fields: [{ name: 'x-score', label: 'Score', type: 'number', entities: ['work_item'] }] });
  const plan = manager.preview({ kind: 'transform', config, changes: [{ id: 'TASK-001', set: { 'x-score': 5 } }] });
  assertApplicable(plan);
  assert.equal(plan.files.find(file => file.path === configPath)!.before, null);
  manager.apply(plan);
  const state = new DurableState(repository);
  const added = createMarkdown({ id: 'TASK-999', title: 'Later entity' });
  state.begin({ kind: 'create', id: 'TASK-999', path: 'later.md', raw: added, idempotency: { key: 'later-create', hash: revisionOf('request'), id: 'TASK-999' } });
  repository.write('later.md', added);
  state.finish();
  state.observe(['TASK-999'], [{ path: 'later.md', id: 'TASK-999', entity: 'work_item' }]);
  state.begin({ kind: 'delete', id: 'TASK-999', path: 'later.md', raw: added });
  repository.remove('later.md', revisionOf(added));
  state.finish();
  const advancedLedger = repository.read(statePath);
  manager.restore(plan);
  assert.equal(repository.read('task.md'), task);
  assert.throws(() => repository.read(configPath), { code: 'ENOENT' });
  assert.equal(repository.read(statePath), advancedLedger);
  const restoredState = new DurableState(repository);
  assert.ok(restoredState.ids.includes('TASK-999'));
  assert.equal(restoredState.deleted('TASK-999'), true);
  assert.equal(restoredState.request('later-create')?.id, 'TASK-999');
});

test('unknown protocol versions and forbidden field changes are persisted diagnostics, never writable plans', async t => {
  const future = createMarkdown({ id: 'TASK-001', title: 'Future' }).replace('pm/v1', 'pm/v2');
  const { repository, manager } = await fixture(t, { 'future.md': future });
  for (const kind of ['normalize-v1', 'transform'] as const) {
    const plan = manager.preview({ kind, ...(kind === 'transform' ? { changes: [{ id: 'TASK-001', set: { status: 'done' } }] } : {}) });
    assert.ok(plan.diagnostics.some(diagnostic => diagnostic.code === 'UNSUPPORTED_SCHEMA_VERSION'));
    assert.throws(() => manager.apply(plan), hasCode('UNSUPPORTED_SCHEMA_VERSION'));
    assert.equal(repository.read('future.md'), future);
  }
  repository.write('future.md', future.replace('pm/v2', 'pm/v1'), revisionOf(future));
  for (const field of ['id', 'schema', 'entity', 'body', 'revision', 'title', 'unregistered', 'x-unregistered']) {
    const plan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { [field]: 'changed' } }] });
    assert.ok(plan.diagnostics.some(diagnostic => diagnostic.severity === 'error'), field);
    assert.throws(() => manager.apply(plan), ProtocolError);
  }
});

test('ambiguous or missing IDs, invalid configuration and invalid custom references cannot apply', async t => {
  const source = createMarkdown({ id: 'TASK-001', title: 'Task' });
  const { repository, manager } = await fixture(t, { 'one.md': source, 'duplicate.md': source });
  const duplicate = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'done' } }] });
  assert.ok(duplicate.diagnostics.some(diagnostic => diagnostic.code === 'DUPLICATE_ID'));
  repository.remove('duplicate.md', revisionOf(source));
  const missing = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-999', set: { status: 'done' } }] });
  assert.throws(() => manager.apply(missing), hasCode('NOT_FOUND'));
  const config = parseConfiguration({ schema: 'pm/config/v1', custom_fields: [{ name: 'x-link', label: 'Link', type: 'reference', target: 'work_item', entities: ['work_item'] }] });
  const reference = manager.preview({ kind: 'transform', config, changes: [{ id: 'TASK-001', set: { 'x-link': 'TASK-404' } }] });
  assert.throws(() => manager.apply(reference), hasCode('REFERENCE_NOT_FOUND'));
  const invalidConfig = { ...config, schema: 'pm/config/v2' };
  assert.throws(() => manager.preview({ kind: 'transform', config: invalidConfig as typeof config }), hasCode('MIGRATION_INVALID'));
  assert.equal(repository.read('one.md'), source);
});

test('input fingerprints reject changed source, reference targets, configuration, views, ledger and path sets', async t => {
  for (const changed of ['source', 'reference', 'configuration', 'view', 'ledger', 'new-file']) {
    await t.test(changed, async sub => {
      const task = createMarkdown({ id: 'TASK-001', title: 'Task', project: 'PRJ-001' });
      const project = createMarkdown({ id: 'PRJ-001', entity: 'project', title: 'Project' });
      const view = 'id: work\nname: Work\nentity: work_item\nlayout: table\n';
      const { repository, manager } = await fixture(sub, { 'task.md': task, 'project.md': project, '.pm/views/work.yaml': view });
      const plan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'done' } }] });
      assertApplicable(plan);
      if (changed === 'source') repository.write('task.md', task + '\nExternal bytes\n', revisionOf(task));
      if (changed === 'reference') repository.write('project.md', project + '\nExternal project\n', revisionOf(project));
      if (changed === 'configuration') repository.write(configPath, stringify(parseConfiguration({ schema: 'pm/config/v1' })));
      if (changed === 'view') repository.write('.pm/views/work.yaml', view + '# Changed\n', revisionOf(view));
      if (changed === 'ledger') new DurableState(repository).observe(['TASK-888'], []);
      if (changed === 'new-file') repository.write('extra.md', createMarkdown({ id: 'TASK-002', title: 'Extra' }));
      const current = repository.read('task.md');
      assert.throws(() => manager.apply(plan), hasCode('MIGRATION_CONFLICT'));
      assert.equal(repository.read('task.md'), current);
      assert.equal(manager.pending(), false);
    });
  }
});

test('restore requires exact applied bytes and validates the current workspace against the original config', async t => {
  const source = createMarkdown({ id: 'TASK-001', title: 'Task' });
  const { repository, manager } = await fixture(t, { 'task.md': source });
  const config = parseConfiguration({ schema: 'pm/config/v1', workflows: { work_item: { initial: 'queued', states: [{ id: 'queued', label: 'Queued', category: 'unstarted' }], transitions: [] } } });
  const plan = manager.preview({ kind: 'transform', config, changes: [{ id: 'TASK-001', set: { status: 'queued' } }] });
  assertApplicable(plan);
  manager.apply(plan);
  const applied = repository.read('task.md');
  repository.write('task.md', applied + '\nExternal edit\n', revisionOf(applied));
  assert.throws(() => manager.restore(plan), hasCode('MIGRATION_CONFLICT'));
  repository.write('task.md', applied, revisionOf(applied + '\nExternal edit\n'));
  const later = createMarkdown({ id: 'TASK-002', title: 'Later', status: 'queued' }, config);
  repository.write('later.md', later);
  assert.throws(() => manager.restore(plan), ProtocolError, 'an unrelated entity now requires the new workflow');
  assert.equal(repository.read('task.md'), applied);
  assert.equal(manager.pending(), false);
});

test('restore rejects tombstoned entities even if external bytes recreate the exact applied source', async t => {
  const source = createMarkdown({ id: 'TASK-001', title: 'Task' });
  const { repository, manager } = await fixture(t, { 'task.md': source });
  const plan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'done' } }] });
  manager.apply(plan);
  const applied = repository.read('task.md');
  const state = new DurableState(repository);
  state.begin({ kind: 'delete', id: 'TASK-001', path: 'task.md', raw: applied });
  repository.remove('task.md', revisionOf(applied));
  state.finish();
  repository.write('task.md', applied);
  assert.throws(() => manager.restore(plan), hasCode('ID_TOMBSTONED'));
  assert.equal(repository.read('task.md'), applied);
  assert.equal(new DurableState(repository).deleted('TASK-001'), true);
});

test('partial apply and restore recover from durable journals only after exact-byte preflight', async t => {
  const first = createMarkdown({ id: 'TASK-001', title: 'First' });
  const second = createMarkdown({ id: 'TASK-002', title: 'Second' });
  const { repository, manager } = await fixture(t, { 'a.md': first, 'b.md': second });
  const plan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'done' } }, { id: 'TASK-002', set: { status: 'done' } }] });
  assertApplicable(plan);
  repository.interrupt = 'b.md';
  assert.throws(() => manager.apply(plan), hasCode('MIGRATION_PENDING'));
  assert.equal(parseMarkdown(repository.read('a.md')).status, 'done');
  assert.equal(repository.read('b.md'), second);
  assert.equal(manager.pending(), true);
  assert.throws(() => manager.assertWritable(), hasCode('MIGRATION_PENDING'));
  assert.equal(manager.list()[0].status, 'applying');
  const recovery = new MigrationManager(new FileRepository(repository.root));
  recovery.recover();
  assert.equal(recovery.pending(), false);
  assert.equal(parseMarkdown(repository.read('b.md')).status, 'done');
  assert.equal(recovery.list()[0].status, 'applied');
  assert.throws(() => manager.restore(plan), hasCode('MIGRATION_PENDING'));
  assert.equal(repository.read('a.md'), first);
  assert.equal(manager.list()[0].status, 'restoring');
  recovery.recover();
  assert.equal(repository.read('a.md'), first);
  assert.equal(repository.read('b.md'), second);
  assert.equal(recovery.pending(), false);
  assert.equal(recovery.list()[0].status, 'restored');
});

test('recovery detects an external conflict before changing any remaining file and can resume after explicit repair', async t => {
  const first = createMarkdown({ id: 'TASK-001', title: 'First' });
  const second = createMarkdown({ id: 'TASK-002', title: 'Second' });
  const { repository, manager } = await fixture(t, { 'a.md': first, 'b.md': second });
  const plan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'done' } }, { id: 'TASK-002', set: { status: 'done' } }] });
  repository.interrupt = 'b.md';
  assert.throws(() => manager.apply(plan), hasCode('MIGRATION_PENDING'));
  repository.interrupt = undefined;
  const firstApplied = repository.read('a.md');
  repository.write('b.md', second + '\nExternal edit\n', revisionOf(second));
  assert.throws(() => new MigrationManager(repository).recover(), hasCode('MIGRATION_CONFLICT'));
  assert.equal(repository.read('a.md'), firstApplied);
  assert.equal(repository.read('b.md'), second + '\nExternal edit\n');
  assert.equal(manager.pending(), true);
  repository.write('b.md', second, revisionOf(second + '\nExternal edit\n'));
  new MigrationManager(repository).recover();
  assert.equal(manager.pending(), false);
  assert.equal(parseMarkdown(repository.read('b.md')).status, 'done');
});

test('a file reverted during the final write cannot publish a silently incomplete migration', async t => {
  const first = createMarkdown({ id: 'TASK-001', title: 'First' });
  const second = createMarkdown({ id: 'TASK-002', title: 'Second' });
  const { repository, manager } = await fixture(t, { 'a.md': first, 'b.md': second });
  const plan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'done' } }, { id: 'TASK-002', set: { status: 'done' } }] });
  repository.onWrite = relative => {
    if (relative !== 'b.md') return;
    repository.onWrite = undefined;
    repository.write('a.md', first, revisionOf(repository.read('a.md')));
  };
  assert.throws(() => manager.apply(plan), hasCode('MIGRATION_CONFLICT'));
  assert.equal(manager.pending(), true);
  assert.equal(manager.list()[0].status, 'applying');
  new MigrationManager(repository).recover();
  assert.equal(parseMarkdown(repository.read('a.md')).status, 'done');
});

test('backup tampering, unsafe manifest paths and journal traversal are rejected without source writes', async t => {
  for (const attack of ['backup', 'manifest', 'traversal', 'journal']) {
    await t.test(attack, async sub => {
      const source = createMarkdown({ id: 'TASK-001', title: 'Task' });
      const { repository, manager } = await fixture(sub, { 'task.md': source });
      const plan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'done' } }] });
      const manifestPath = `.pm/state/migrations/${plan.id}/manifest.json`;
      const manifestRaw = repository.read(manifestPath);
      const manifest = JSON.parse(manifestRaw);
      let revision = plan.revision;
      if (attack === 'backup') {
        const backupPath = `.pm/state/migrations/${plan.id}/blobs/${manifest.files[0].before.revision}-0.txt`;
        repository.write(backupPath, 'tampered', revisionOf(repository.read(backupPath)));
      } else if (attack === 'manifest') {
        manifest.files[0].afterRevision = '0'.repeat(64);
        repository.write(manifestPath, JSON.stringify(manifest), revisionOf(manifestRaw));
      } else if (attack === 'traversal') {
        manifest.files[0].path = '../outside.md';
        const { revision: _revision, ...payload } = manifest;
        revision = manifest.revision = requestHash(payload);
        repository.write(manifestPath, JSON.stringify(manifest), revisionOf(manifestRaw));
      } else {
        repository.interrupt = 'task.md';
        assert.throws(() => manager.apply(plan), hasCode('MIGRATION_PENDING'));
        const rawJournal = repository.read(journalPath);
        const journal = JSON.parse(rawJournal);
        journal.inputs[0].path = '../outside.md';
        repository.write(journalPath, JSON.stringify(journal), revisionOf(rawJournal));
        assert.throws(() => manager.recover(), hasCode('MIGRATION_TAMPERED'));
        assert.throws(() => manager.assertWritable(), hasCode('MIGRATION_TAMPERED'));
        assert.equal(repository.read('task.md'), source);
        return;
      }
      assert.throws(() => manager.apply({ id: plan.id, revision }), hasCode('MIGRATION_TAMPERED'));
      assert.equal(repository.read('task.md'), source);
    });
  }
});

test('migration backup symlinks cannot read or overwrite outside the safe repository', async t => {
  const source = createMarkdown({ id: 'TASK-001', title: 'Task' });
  const { repository, manager, root } = await fixture(t, { 'task.md': source });
  const plan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'done' } }] });
  const manifest = JSON.parse(repository.read(`.pm/state/migrations/${plan.id}/manifest.json`));
  const backupPath = `.pm/state/migrations/${plan.id}/blobs/${manifest.files[0].before.revision}-0.txt`;
  repository.remove(backupPath, revisionOf(repository.read(backupPath)));
  await symlink(path.join(root, 'task.md'), path.join(root, backupPath));
  assert.throws(() => manager.apply(plan), hasCode('MIGRATION_TAMPERED'));
  assert.equal(repository.read('task.md'), source);
});

test('explicit confirmation revision is required and an applied/restored plan cannot be reused', async t => {
  const source = createMarkdown({ id: 'TASK-001', title: 'Task' });
  const { manager } = await fixture(t, { 'task.md': source });
  const plan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'done' } }] });
  assert.throws(() => manager.apply({ id: plan.id, revision: '0'.repeat(64) }), hasCode('MIGRATION_CONFLICT'));
  assert.throws(() => manager.apply({ id: '../escape', revision: plan.revision }), hasCode('MIGRATION_INVALID'));
  manager.apply(plan);
  assert.throws(() => manager.apply(plan), hasCode('MIGRATION_INVALID'));
  manager.restore(plan);
  assert.throws(() => manager.restore(plan), hasCode('MIGRATION_INVALID'));
  assert.throws(() => manager.apply(plan), hasCode('MIGRATION_INVALID'));
});

test('normalize-v1 leaves an explicitly configured in_progress project state unchanged', async t => {
  const config = parseConfiguration({ schema: 'pm/config/v1', workflows: { project: {
    initial: 'in_progress', states: [{ id: 'in_progress', label: 'In progress', category: 'started' }], transitions: [],
  } } });
  const { repository, manager } = await fixture(t, { 'project.md': legacyProject, [configPath]: stringify(config) });
  const plan = manager.preview({ kind: 'normalize-v1' });
  assertApplicable(plan);
  assert.deepEqual(plan.files, []);
  manager.apply(plan);
  assert.equal(repository.read('project.md'), legacyProject);
});

test('chunked backups preserve Unicode boundaries and recovery exposes only verified completion evidence', async t => {
  const source = createMarkdown({ id: 'TASK-001', title: 'Large source', body: `${'a'.repeat(262000)}\u{1D11E}${'z'.repeat(262144)}\n` });
  const { repository, manager } = await fixture(t, { 'task.md': source });
  const plan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'done' } }] });
  const manifest = JSON.parse(repository.read(`.pm/state/migrations/${plan.id}/manifest.json`));
  assert.ok(manifest.files[0].before.parts > 1);
  repository.interrupt = 'task.md';
  assert.throws(() => manager.apply(plan), hasCode('MIGRATION_PENDING'));
  assert.deepEqual(manager.completedTransitions(), []);
  repository.interrupt = undefined;
  manager.recover();
  const appliedRevision = revisionOf(repository.read('task.md'));
  assert.deepEqual(manager.completedTransitions(), [{ path: 'task.md', fromRevision: revisionOf(source), toRevision: appliedRevision }]);
  manager.restore(plan);
  assert.equal(repository.read('task.md'), source);
  assert.deepEqual(manager.completedTransitions(), [{ path: 'task.md', fromRevision: appliedRevision, toRevision: revisionOf(source) }]);
  manager.recover();
  assert.equal(manager.pending(), false);
});

test('committed revision-pair evidence survives journal removal and detects status tampering', async t => {
  const source = createMarkdown({ id: 'TASK-001', title: 'Task' });
  const { repository, manager } = await fixture(t, { 'task.md': source });
  const plan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'done' } }] });
  assert.deepEqual(manager.completedTransitions(), []);
  manager.apply(plan);
  const appliedRevision = revisionOf(repository.read('task.md'));
  assert.deepEqual(new MigrationManager(repository).completedTransitions(), [{
    path: 'task.md', fromRevision: revisionOf(source), toRevision: appliedRevision,
  }]);
  manager.restore(plan);
  assert.deepEqual(new MigrationManager(repository).completedTransitions(), [{
    path: 'task.md', fromRevision: appliedRevision, toRevision: revisionOf(source),
  }]);
  const statusPath = `.pm/state/migrations/${plan.id}/status.json`;
  const raw = repository.read(statusPath);
  const status = JSON.parse(raw);
  status.status = 'applied';
  repository.write(statusPath, JSON.stringify(status), revisionOf(raw));
  assert.throws(() => manager.completedTransitions(), hasCode('MIGRATION_TAMPERED'));
  assert.equal(repository.read('task.md'), source);
});

test('ordinary status growth cannot migrate a near-limit source beyond its UTF-8 read bound', async t => {
  for (const character of ['a', 'é']) {
    await t.test(character === 'a' ? 'ASCII' : 'multibyte', async sub => {
      const prefix = createMarkdown({ id: 'TASK-001', title: 'Near limit' });
      const remaining = maxRepositoryFileBytes - Buffer.byteLength(prefix);
      const width = Buffer.byteLength(character);
      const source = prefix + character.repeat(Math.floor(remaining / width)) + 'a'.repeat(remaining % width);
      assert.equal(Buffer.byteLength(source), maxRepositoryFileBytes);
      const { repository, manager } = await fixture(sub, { 'task.md': source });
      const plan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'in_progress' } }] });
      assert.ok(Buffer.byteLength(plan.files[0].after!) > maxRepositoryFileBytes);
      assert.ok(plan.diagnostics.some(diagnostic => diagnostic.code === 'MIGRATION_LIMIT' && diagnostic.path === 'task.md'));
      assert.throws(() => manager.apply(plan), hasCode('MIGRATION_LIMIT'));
      assert.equal(manager.pending(), false);
      assert.equal(repository.read('task.md'), source);

      // Simulate an unbounded plan/journal persisted by an older process, not a newly applicable preview.
      const manifestPath = `.pm/state/migrations/${plan.id}/manifest.json`;
      const rawManifest = repository.read(manifestPath);
      const manifest = JSON.parse(rawManifest);
      manifest.diagnostics = [];
      const { revision: _revision, ...payload } = manifest;
      manifest.revision = requestHash(payload);
      repository.write(manifestPath, JSON.stringify(manifest), revisionOf(rawManifest));
      repository.write(journalPath, JSON.stringify({ version: 1, id: plan.id, revision: manifest.revision, direction: 'apply', inputs: manifest.inputs }));
      assert.throws(() => new MigrationManager(repository).recover(), hasCode('MIGRATION_LIMIT'));
      assert.equal(repository.read('task.md'), source);
      assert.equal(manager.pending(), true);
    });
  }
});

test('configuration YAML expansion is size-checked before an applicable preview or recovery write', async t => {
  const source = createMarkdown({ id: 'TASK-001', title: 'Task' });
  const { repository, manager } = await fixture(t, { 'task.md': source });
  const config = parseConfiguration({ schema: 'pm/config/v1', workflows: { work_item: {
    initial: 'todo', states: [{ id: 'todo', label: 'x\n'.repeat(650000), category: 'unstarted' }], transitions: [],
  } } });
  assert.ok(Buffer.byteLength(stringify(config)) > maxRepositoryFileBytes);
  const plan = manager.preview({ kind: 'transform', config });
  assert.ok(plan.diagnostics.some(diagnostic => diagnostic.code === 'MIGRATION_LIMIT' && diagnostic.path === configPath));
  assert.throws(() => manager.apply(plan), hasCode('MIGRATION_LIMIT'));
  assert.equal(manager.pending(), false);
  assert.throws(() => repository.read(configPath), { code: 'ENOENT' });
  assert.equal(repository.read('task.md'), source);
  const manifestPath = `.pm/state/migrations/${plan.id}/manifest.json`;
  const rawManifest = repository.read(manifestPath);
  const manifest = JSON.parse(rawManifest);
  manifest.diagnostics = [];
  const { revision: _revision, ...payload } = manifest;
  manifest.revision = requestHash(payload);
  repository.write(manifestPath, JSON.stringify(manifest), revisionOf(rawManifest));
  repository.write(journalPath, JSON.stringify({ version: 1, id: plan.id, revision: manifest.revision, direction: 'apply', inputs: manifest.inputs }));
  assert.throws(() => new MigrationManager(repository).recover(), hasCode('MIGRATION_LIMIT'));
  assert.throws(() => repository.read(configPath), { code: 'ENOENT' });
  assert.equal(repository.read('task.md'), source);
});

test('projection acknowledgment consumes only exact completed pairs and restore produces fresh evidence', async t => {
  const first = createMarkdown({ id: 'TASK-001', title: 'First' });
  const second = createMarkdown({ id: 'TASK-002', title: 'Second' });
  const { repository, manager } = await fixture(t, { 'a.md': first, 'b.md': second });
  const plan = manager.preview({ kind: 'transform', changes: [
    { id: 'TASK-001', set: { status: 'done' } }, { id: 'TASK-002', set: { status: 'done' } },
  ] });
  manager.apply(plan);
  const transitions = manager.completedTransitions();
  assert.equal(transitions.length, 2);
  manager.acknowledgeTransitions([{ ...transitions[0], fromRevision: '0'.repeat(64) }]);
  assert.deepEqual(manager.completedTransitions(), transitions);
  manager.acknowledgeTransitions([transitions[0]]);
  assert.deepEqual(new MigrationManager(repository).completedTransitions(), [transitions[1]]);
  manager.acknowledgeTransitions(transitions);
  assert.deepEqual(new MigrationManager(repository).completedTransitions(), []);
  manager.restore(plan);
  const reversed = manager.completedTransitions();
  assert.deepEqual(reversed, transitions.map(transition => ({
    path: transition.path, fromRevision: transition.toRevision, toRevision: transition.fromRevision,
  })));
  manager.acknowledgeTransitions(transitions);
  assert.deepEqual(manager.completedTransitions(), reversed, 'old forward proofs cannot consume reverse operation evidence');
  manager.acknowledgeTransitions(reversed);
  assert.deepEqual(new MigrationManager(repository).completedTransitions(), []);
});

test('a crash before durable acknowledgment retains exact completion evidence for startup reconciliation', async t => {
  const source = createMarkdown({ id: 'TASK-001', title: 'Task' });
  const { repository, manager } = await fixture(t, { 'task.md': source });
  const plan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'done' } }] });
  manager.apply(plan);
  const transitions = manager.completedTransitions();
  repository.interrupt = `.pm/state/migrations/${plan.id}/status.json`;
  assert.throws(() => manager.acknowledgeTransitions(transitions), /Simulated power loss/);
  assert.deepEqual(new MigrationManager(repository).completedTransitions(), transitions);
  repository.interrupt = undefined;
  new MigrationManager(repository).acknowledgeTransitions(transitions);
  assert.deepEqual(new MigrationManager(repository).completedTransitions(), []);
  assert.equal(parseMarkdown(repository.read('task.md')).status, 'done');
});

test('pending projection retirement blocks further migrations but allows durable evidence acknowledgment', async t => {
  const source = createMarkdown({ id: 'TASK-001', title: 'Task' });
  const { repository, manager } = await fixture(t, { 'task.md': source });
  const appliedPlan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'done' } }] });
  manager.apply(appliedPlan);
  const applied = repository.read('task.md');
  const transitions = manager.completedTransitions();
  const configuration = parseConfiguration({ schema: 'pm/config/v1' });
  const state = new DurableState(repository);
  state.stageMigrationProjection(transitions, [{
    id: 'TASK-001', path: 'task.md', raw: applied, revision: revisionOf(applied), entity: parseMarkdown(applied, configuration),
  }], configuration, 'absent');
  const pendingLedger = repository.read(statePath);
  const blockedPlan = manager.preview({ kind: 'transform', changes: [{ id: 'TASK-001', set: { status: 'todo' } }] });
  assert.ok(blockedPlan.diagnostics.some(diagnostic => diagnostic.code === 'MIGRATION_PENDING'));
  assert.throws(() => manager.apply(blockedPlan), hasCode('MIGRATION_PENDING'));
  assert.throws(() => manager.restore(appliedPlan), hasCode('MIGRATION_PENDING'));
  assert.equal(repository.read('task.md'), applied);
  manager.acknowledgeTransitions(transitions);
  assert.deepEqual(new MigrationManager(repository).completedTransitions(), []);
  assert.equal(repository.read(statePath), pendingLedger, 'acknowledgment never rewinds the durable ledger');
  state.finishMigrationProjection();
  manager.restore(appliedPlan);
  assert.equal(repository.read('task.md'), source);
});
