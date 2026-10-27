import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace, WorkspaceError } from '../../pm-core/index.ts';

const TASK = `---
schema: pm/v1
id: TASK-102
entity: work_item
kind: task
project: PRJ-001
parent: TASK-100
status: todo # important status comment
priority: high
blocked_by: [TASK-101]
custom: { retained: yes }
---

# Session management

Keep this **body** byte-for-byte.
- [x] Define schema
- [ ] Implement API

See [[ADR-001]].
`;

const DEFAULT_FILES = {
  'work-items/TASK-102.md': TASK,
  'projects/PRJ-001.md': '---\nschema: pm/v1\nid: PRJ-001\nentity: project\n---\n# Project\n',
  'work-items/TASK-100.md': '---\nschema: pm/v1\nid: TASK-100\nentity: work_item\nproject: PRJ-001\n---\n# Parent\n',
  'work-items/TASK-101.md': '---\nschema: pm/v1\nid: TASK-101\nentity: work_item\nproject: PRJ-001\n---\n# Blocker\n',
  'docs/ADR-001.md': '---\nschema: pm/v1\nid: ADR-001\nentity: document\n---\n# Architecture\n',
};

interface Fixture { root: string; workspace: Workspace }
async function fixture(t: TestContext, files: Record<string, string> = DEFAULT_FILES): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'markdown-pm-core-'));
  for (const [name, raw] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), raw);
  }
  const result = { root, workspace: new Workspace(root) };
  t.after(async () => { await result.workspace.close(); await rm(root, { recursive: true, force: true }); });
  await result.workspace.init();
  return result;
}

function untilChanged(workspace: Workspace, predicate: () => boolean): Promise<void> {
  const changed = Promise.withResolvers<void>();
  // Integration deadline only: completion awaits the real filesystem watcher event, never a guessed sleep.
  const timeout = setTimeout(() => { unsubscribe(); changed.reject(new Error('Watcher did not project the external edit')); }, 6000);
  const unsubscribe = workspace.onChange(() => {
    if (predicate()) { clearTimeout(timeout); unsubscribe(); changed.resolve(); }
  });
  return changed.promise;
}

function isStatus(status: number): (error: unknown) => boolean {
  return error => error instanceof WorkspaceError && error.status === status;
}

test('SQLite projects files, relationships, filtered queries and Agent context', async t => {
  const project = '---\nschema: pm/v1\nid: PRJ-001\nentity: project\n---\n# Agent Workspace\n';
  const parent = TASK.replaceAll('TASK-102', 'TASK-100').replace('parent: TASK-100\n', '').replace('# Session management', '# Session epic');
  const blocker = TASK.replaceAll('TASK-102', 'TASK-101').replace('blocked_by: [TASK-101]', 'blocked_by: []').replace('# Session management', '# Runtime foundation');
  const document = '---\nschema: pm/v1\nid: ADR-001\nentity: document\nproject: PRJ-001\n---\n# Session architecture\n\nLinks [[TASK-102]].\n';
  const { workspace, root } = await fixture(t, {
    'work-items/session.md': TASK, 'projects/project.md': project, 'work-items/epic.md': parent,
    'work-items/runtime.md': blocker, 'docs/architecture.md': document,
  });
  assert.equal(workspace.snapshot().files.length, 5);
  assert.deepEqual(workspace.snapshot().errors, []);
  assert.equal(workspace.items({ project: 'PRJ-001', status: 'todo', q: 'session', priority: 'high' }).length, 2);
  assert.equal(workspace.items({ q: '%_' }).length, 0);
  assert.equal(workspace.get('TASK-102').path, 'work-items/session.md');
  const context = workspace.context('TASK-102').markdown;
  for (const text of ['Agent Workspace', 'Runtime foundation', 'Session epic', 'Session architecture', 'backlink:link', 'Revision:']) assert.ok(context.includes(text), text);
  assert.ok((await stat(path.join(root, '.pm/cache/index.sqlite'))).isFile());
});

test('Structured updates preserve Markdown and survive restart with a deleted cache', async t => {
  const current = await fixture(t);
  const before = current.workspace.get('TASK-102');
  const updated = await current.workspace.patch(before.id, { status: 'done', priority: 'urgent', blocked_by: [] }, before.revision);
  assert.equal(updated.entity.status, 'done');
  assert.deepEqual(updated.entity.blocked_by, []);
  assert.match(updated.raw, /# important status comment/);
  assert.match(updated.raw, /custom: \{ retained: yes \}/);
  assert.equal(updated.raw.slice(updated.raw.indexOf('\n# Session')), TASK.slice(TASK.indexOf('\n# Session')));
  assert.notEqual(updated.revision, before.revision);
  assert.equal(await readFile(path.join(current.root, updated.path), 'utf8'), updated.raw);
  await current.workspace.close();
  await rm(path.join(current.root, '.pm/cache'), { recursive: true });
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.get(before.id).revision, updated.revision);
  assert.equal(current.workspace.get(before.id).entity.status, 'done');
});

test('Concurrent commands use revisions and preserve the winning writer', async t => {
  const { workspace, root } = await fixture(t);
  const original = workspace.get('TASK-102');
  const results = await Promise.allSettled([
    workspace.patch(original.id, { status: 'done' }, original.revision),
    workspace.patch(original.id, { priority: 'urgent' }, original.revision),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected' && isStatus(409)(rejected.reason));
  const current = workspace.get(original.id);
  assert.equal(current.entity.status, 'done');
  assert.equal(current.entity.priority, 'high');
  assert.equal(await readFile(path.join(root, original.path), 'utf8'), current.raw);
});

test('Actual disk content wins even before the watcher has run', async t => {
  const { workspace, root } = await fixture(t);
  const original = workspace.get('TASK-102');
  const external = TASK.replace('status: todo', 'status: in_progress').replace('Keep this', 'External writer keeps this');
  await writeFile(path.join(root, original.path), external);
  await assert.rejects(workspace.save(original.id, TASK.replace('priority: high', 'priority: low'), original.revision), error => {
    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.status, 409);
    assert.equal(error.current?.raw, external);
    return true;
  });
  assert.equal(await readFile(path.join(root, original.path), 'utf8'), external);
});

test('External edits emit events; malformed input retains explicitly stale last-good data', async t => {
  const { workspace, root } = await fixture(t);
  const filename = path.join(root, 'work-items/TASK-102.md');
  let observed = untilChanged(workspace, () => workspace.get('TASK-102').entity.status === 'done');
  await writeFile(filename, TASK.replace('status: todo', 'status: done'));
  await observed;
  const good = workspace.get('TASK-102');
  observed = untilChanged(workspace, () => workspace.get('TASK-102').stale === true);
  const invalid = TASK.replace('status: todo', 'status: impossible');
  await writeFile(filename, invalid);
  await observed;
  const stale = workspace.get('TASK-102');
  assert.equal(stale.raw, invalid);
  assert.notEqual(stale.revision, good.revision);
  assert.equal(stale.entity.status, good.entity.status);
  assert.ok(stale.error);
  assert.equal(workspace.snapshot().errors[0].path, good.path);
  await assert.rejects(workspace.patch(good.id, { status: 'in_progress' }, good.revision), isStatus(409));
  assert.equal(await readFile(filename, 'utf8'), invalid);
  observed = untilChanged(workspace, () => !workspace.get('TASK-102').stale);
  await writeFile(filename, TASK);
  await observed;
  assert.equal(workspace.get('TASK-102').entity.status, 'todo');
});

test('Duplicate IDs never select an arbitrary writer, including stale-ID collisions', async t => {
  const { workspace, root } = await fixture(t);
  const original = workspace.get('TASK-102');
  await writeFile(path.join(root, 'work-items/duplicate.md'), TASK.replace('# Session management', '# Duplicate'));
  await workspace.rescan();
  assert.equal(workspace.get(original.id).stale, true);
  assert.ok(workspace.get(original.id).diagnostics?.some(error => error.code === 'DUPLICATE_ID'));
  assert.equal(workspace.snapshot().errors.filter(error => error.code === 'DUPLICATE_ID').length, 2);
  await writeFile(path.join(root, original.path), '---\ninvalid: [\n---\n# Broken\n');
  await workspace.rescan();
  assert.equal(workspace.get(original.id).raw, '---\ninvalid: [\n---\n# Broken\n');
  await assert.rejects(workspace.patch(original.id, { status: 'done' }, original.revision), isStatus(409));
  await rm(path.join(root, 'work-items/duplicate.md'));
  await writeFile(path.join(root, original.path), TASK);
  await workspace.rescan();
  assert.equal(workspace.get(original.id).stale, undefined);
});

test('Startup reports malformed files and rejects both copies of new duplicate IDs', async t => {
  const independent = '---\nschema: pm/v1\nid: TASK-102\nentity: work_item\n---\n# Independent\n';
  const { workspace } = await fixture(t, {
    'one.md': independent, 'two.md': independent,
    'broken.md': '---\nschema: pm/v1\nid: TASK-999\nstatus: [\n---\n# Broken\n',
  });
  assert.equal(workspace.snapshot().files.length, 0);
  assert.equal(workspace.snapshot().errors.length, 3);
  assert.throws(() => workspace.get('TASK-102'), isStatus(409));
  const created = await workspace.create({ title: 'Fresh task' });
  assert.equal(created.id, 'TASK-1000');
});

test('Stable IDs survive file renames and new tasks are durable real Markdown', async t => {
  const { workspace, root } = await fixture(t);
  await rename(path.join(root, 'work-items/TASK-102.md'), path.join(root, 'work-items/renamed.md'));
  await workspace.rescan();
  assert.equal(workspace.get('TASK-102').path, 'work-items/renamed.md');
  const created = await workspace.create({ title: 'A new task', project: 'PRJ-001', parent: 'TASK-102', blocked_by: ['TASK-102'], body: 'Detailed acceptance context.' });
  assert.equal(created.id, 'TASK-103');
  assert.equal(created.entity.parent, 'TASK-102');
  assert.deepEqual(created.entity.blocked_by, ['TASK-102']);
  assert.equal(await readFile(path.join(root, created.path), 'utf8'), created.raw);
  assert.ok(workspace.context(created.id).markdown.includes('Session management'));
});

test('Invalid and identity-changing saves cannot damage disk content', async t => {
  const { workspace, root } = await fixture(t);
  const original = workspace.get('TASK-102');
  await assert.rejects(workspace.save(original.id, TASK.replace('status: todo', 'status: invalid'), original.revision), isStatus(422));
  await assert.rejects(workspace.save(original.id, TASK.replace('id: TASK-102', 'id: TASK-999'), original.revision), isStatus(422));
  await assert.rejects(workspace.patch(original.id, { id: 'TASK-999' }, original.revision), isStatus(422));
  assert.equal(await readFile(path.join(root, original.path), 'utf8'), TASK);
});

test('Saved views persist, validate and remain workspace-confined', async t => {
  const current = await fixture(t);
  const view = await current.workspace.saveView('priority-table', { name: 'High priority', layout: 'table', project: 'PRJ-001', filter: { priority: 'high' }, sort: 'title' });
  assert.equal(current.workspace.snapshot().views[0].id, view.id);
  assert.match(await readFile(path.join(current.root, '.pm/views/priority-table.yaml'), 'utf8'), /layout: table/);
  await assert.rejects(current.workspace.saveView('../outside', { name: 'Unsafe', layout: 'table' }), isStatus(400));
  await assert.rejects(current.workspace.saveView('invalid', { name: 'Invalid', layout: 'calendar' }), isStatus(422));
  await current.workspace.close();
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.deepEqual(current.workspace.snapshot().views, [view]);
});

test('Symlink files and directories cannot expose or overwrite outside content', async t => {
  const { workspace, root } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'markdown-pm-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const raw = TASK.replace('id: TASK-102', 'id: TASK-900');
  await writeFile(path.join(outside, 'secret.md'), raw);
  await symlink(path.join(outside, 'secret.md'), path.join(root, 'linked.md'));
  await symlink(outside, path.join(root, 'external'));
  await workspace.rescan();
  assert.equal(workspace.snapshot().errors.filter(error => /Symbolic links/.test(error.message)).length, 2);
  assert.throws(() => workspace.get('TASK-900'), isStatus(404));
  const original = workspace.get('TASK-102');
  await rm(path.join(root, original.path));
  await symlink(path.join(outside, 'secret.md'), path.join(root, original.path));
  await assert.rejects(workspace.save(original.id, TASK.replace('status: todo', 'status: done'), original.revision), isStatus(409));
  assert.equal(await readFile(path.join(outside, 'secret.md'), 'utf8'), raw);
});

