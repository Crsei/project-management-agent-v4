import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace, WorkspaceError, revisionOf } from '../../pm-core/index.ts';
import { FileRepository } from '../../pm-core/repository.ts';
import { DurableState, requestHash } from '../../pm-core/state.ts';
import { createMarkdown, patchMarkdown } from '../../pm-markdown/index.ts';
import type { Diagnostic } from '../../pm-schema/index.ts';

interface Fixture { root: string; workspace: Workspace }
async function fixture(t: TestContext, files: Record<string, string> = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'markdown-pm-lifecycle-'));
  for (const [name, raw] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), raw);
  }
  const result = { root, workspace: new Workspace(root) };
  t.after(async () => { await result.workspace.close(); await rm(root, { recursive: true, force: true }); });
  await result.workspace.init();
  return result;
}
async function restart(current: Fixture, removeCache = false): Promise<void> {
  await current.workspace.close();
  if (removeCache) await rm(path.join(current.root, '.pm/cache'), { recursive: true, force: true });
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
}
function hasCode(code: string, field?: string): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof WorkspaceError);
    assert.ok(error.diagnostics.some(item => item.code === code && (!field || item.field === field)), JSON.stringify(error.diagnostics));
    return true;
  };
}
function details(values: Diagnostic[]): unknown[] {
  return values.filter(item => item.severity === 'error').map(({ code, field, targetId }) => ({ code, field, targetId }));
}

const task = createMarkdown({ id: 'TASK-001', entity: 'work_item', title: 'Primary task' });
const project = createMarkdown({ id: 'PRJ-001', entity: 'project', title: 'Project one' });

test('Raw, property and external relation writes use the same diagnostics and repairable source revision', async t => {
  const { workspace, root } = await fixture(t, { 'task.md': task });
  const before = workspace.get('TASK-001');
  const invalid = patchMarkdown(task, { blocked_by: ['TASK-999'] });
  let apiDiagnostics: Diagnostic[] = [];
  await assert.rejects(workspace.patch(before.id, { blocked_by: ['TASK-999'] }, before.revision), error => {
    assert.ok(error instanceof WorkspaceError);
    apiDiagnostics = error.diagnostics;
    return hasCode('REFERENCE_NOT_FOUND', 'blocked_by')(error);
  });
  await assert.rejects(workspace.save(before.id, invalid, before.revision), error => {
    assert.ok(error instanceof WorkspaceError);
    assert.deepEqual(details(error.diagnostics), details(apiDiagnostics));
    return true;
  });
  assert.equal(await readFile(path.join(root, 'task.md'), 'utf8'), task);
  await writeFile(path.join(root, 'task.md'), invalid);
  await workspace.rescan();
  const stale = workspace.get(before.id);
  assert.equal(stale.stale, true);
  assert.deepEqual(details(stale.diagnostics!), details(apiDiagnostics));
  assert.equal(stale.raw, invalid);
  assert.equal(stale.revision, revisionOf(invalid));
  assert.deepEqual(stale.entity.blocked_by, []);
  await assert.rejects(workspace.save(before.id, task, before.revision), hasCode('REVISION_CONFLICT'));
  const repaired = await workspace.save(before.id, task, stale.revision);
  assert.equal(repaired.stale, undefined);
});

test('Unrelated invalid files do not freeze editing while invalid dependency targets remain rejected', async t => {
  const second = createMarkdown({ id: 'TASK-002', title: 'Dependency' });
  const { workspace, root } = await fixture(t, { 'task.md': task, 'dependency.md': second });
  await writeFile(path.join(root, 'dependency.md'), second.replace('status: todo', 'status: invalid'));
  await writeFile(path.join(root, 'broken.md'), '---\nschema: pm/v1\nid: TASK-900\nstatus: [\n---\n# Broken\n');
  await workspace.rescan();
  const updated = await workspace.patch('TASK-001', { status: 'done' }, workspace.get('TASK-001').revision);
  assert.equal(updated.entity.status, 'done');
  await assert.rejects(workspace.patch(updated.id, { blocked_by: ['TASK-002'] }, updated.revision), hasCode('REFERENCE_INVALID', 'blocked_by'));
  const created = await workspace.create({ title: 'Independent new work' });
  assert.equal(created.id, 'TASK-901');
});

test('Candidate validation includes impacted children, target kinds, cycles and self references', async t => {
  const { workspace } = await fixture(t, {
    'project.md': project,
    'other.md': createMarkdown({ id: 'PRJ-002', entity: 'project', title: 'Other project' }),
    'parent.md': createMarkdown({ id: 'TASK-001', title: 'Parent', project: 'PRJ-001' }),
    'child.md': createMarkdown({ id: 'TASK-002', title: 'Child', project: 'PRJ-001', parent: 'TASK-001' }),
  });
  const parent = workspace.get('TASK-001');
  await assert.rejects(workspace.patch(parent.id, { project: 'PRJ-002' }, parent.revision), error => {
    assert.ok(error instanceof WorkspaceError);
    assert.ok(error.diagnostics.some(item => item.code === 'PARENT_PROJECT_MISMATCH' && item.entityId === 'TASK-002'));
    return true;
  });
  await assert.rejects(workspace.patch(parent.id, { parent: 'TASK-002' }, parent.revision), hasCode('RELATION_CYCLE', 'parent'));
  await assert.rejects(workspace.patch(parent.id, { blocked_by: ['PRJ-001'] }, parent.revision), hasCode('REFERENCE_TYPE', 'blocked_by'));
  await assert.rejects(workspace.patch(parent.id, { related_to: [parent.id] }, parent.revision), hasCode('SELF_REFERENCE', 'related_to'));
  await assert.rejects(workspace.create({ title: 'Invalid child', project: 'PRJ-002', parent: parent.id }), hasCode('PARENT_PROJECT_MISMATCH'));
  assert.equal(workspace.get(parent.id).revision, parent.revision);
});

test('Relationship-invalid targets propagate to their dependents on external edits', async t => {
  const { workspace, root } = await fixture(t, {
    'task.md': task,
    'dependent.md': createMarkdown({ id: 'TASK-002', title: 'Dependent', blocked_by: ['TASK-001'] }),
  });
  await writeFile(path.join(root, 'task.md'), patchMarkdown(task, { parent: 'TASK-999' }));
  await workspace.rescan();
  assert.ok(workspace.get('TASK-002').diagnostics?.some(item => item.code === 'REFERENCE_INVALID' && item.targetId === 'TASK-001'));
  await workspace.save('TASK-001', task, workspace.get('TASK-001').revision);
  assert.equal(workspace.get('TASK-002').stale, undefined);
});

test('First-seen invalid v1 source remains visible and can be repaired by revision-checked raw PUT', async t => {
  const invalid = task.replace('status: todo', 'status: impossible');
  const { workspace } = await fixture(t, { 'task.md': invalid });
  const source = workspace.source('TASK-001');
  assert.ok('readOnly' in source && source.readOnly);
  assert.equal(source.raw, invalid);
  assert.equal(workspace.snapshot().unsupportedFiles.length, 1);
  const repaired = await workspace.save('TASK-001', task, source.revision);
  assert.equal(repaired.stale, undefined);
  assert.equal(workspace.snapshot().unsupportedFiles.length, 0);
});

test('Future schemas retain exact raw bytes and reject every mutation even after a valid projection existed', async t => {
  const { workspace, root } = await fixture(t, { 'task.md': task });
  const future = task.replace('pm/v1', 'pm/v2');
  await writeFile(path.join(root, 'task.md'), future);
  await workspace.rescan();
  const source = workspace.source('TASK-001');
  assert.ok('readOnly' in source && source.readOnly);
  assert.equal(source.raw, future);
  assert.equal(workspace.snapshot().files.length, 0);
  assert.throws(() => workspace.get('TASK-001'), hasCode('UNSUPPORTED_SCHEMA_VERSION'));
  for (const operation of [
    () => workspace.save('TASK-001', task, source.revision),
    () => workspace.patch('TASK-001', { status: 'done' }, source.revision),
    () => workspace.archive('TASK-001', source.revision),
    () => workspace.restore('TASK-001', source.revision),
    () => workspace.delete('TASK-001', source.revision),
  ]) await assert.rejects(operation(), hasCode('UNSUPPORTED_SCHEMA_VERSION'));
  assert.equal(await readFile(path.join(root, 'task.md'), 'utf8'), future);
});

test('External renames preserve identity; same-path identity edits remain diagnosed after restart and cache deletion', async t => {
  const current = await fixture(t, { 'task.md': task });
  await rename(path.join(current.root, 'task.md'), path.join(current.root, 'renamed.md'));
  await current.workspace.rescan();
  assert.equal(current.workspace.get('TASK-001').path, 'renamed.md');
  const mutated = task.replace('id: TASK-001', 'id: TASK-010');
  await writeFile(path.join(current.root, 'renamed.md'), mutated);
  await current.workspace.rescan();
  assert.ok(current.workspace.get('TASK-001').diagnostics?.some(item => item.code === 'IMMUTABLE_FIELD'));
  await restart(current, true);
  const source = current.workspace.source('TASK-001');
  assert.ok(source.diagnostics?.some(item => item.code === 'IMMUTABLE_FIELD'));
  await assert.rejects(current.workspace.save('TASK-001', mutated, source.revision), hasCode('IMMUTABLE_FIELD'));
  await current.workspace.save('TASK-001', task, source.revision);
  const next = await current.workspace.create({ title: 'Allocated after observed identity edit' });
  assert.equal(next.id, 'TASK-011');
});

test('Archive filters exclude by default, include and only are explicit, restore keeps workflow and relations', async t => {
  const { workspace } = await fixture(t, { 'task.md': task });
  const related = await workspace.create({ title: 'Related item', status: 'in_progress', related_to: ['TASK-001'] });
  const archived = await workspace.archive(related.id, related.revision);
  assert.equal(archived.entity.status, 'in_progress');
  assert.equal(workspace.items().length, 1);
  assert.equal(workspace.items({ archived: 'include' }).length, 2);
  assert.deepEqual(workspace.items({ archived: 'only' }).map(file => file.id), [related.id]);
  assert.equal(workspace.get(related.id).entity.archived, true);
  assert.equal(workspace.snapshot().files.length, 2);
  assert.match(workspace.context('TASK-001').markdown, new RegExp(`${related.id} \\(related_to\\)`));
  assert.deepEqual(workspace.get('TASK-001').entity.related_to, []);
  const restored = await workspace.restore(related.id, archived.revision);
  assert.equal(restored.entity.status, 'in_progress');
  assert.deepEqual(restored.entity.related_to, ['TASK-001']);
  assert.equal(workspace.items().length, 2);
});

test('Projects and documents use generic creation and work-item convenience rejects entity overrides', async t => {
  const { workspace } = await fixture(t);
  await assert.rejects(workspace.create({ entity: 'project', title: 'Wrong endpoint' }));
  const createdProject = await workspace.createEntity({ entity: 'project', title: 'Project', owner: 'Ada', status: 'active' });
  const document = await workspace.createEntity({ entity: 'document', title: 'Design', project: createdProject.id, document_kind: 'design' });
  assert.equal(createdProject.id, 'PRJ-001');
  assert.equal(document.id, 'DOC-001');
  assert.equal(document.entity.status, undefined);
  await assert.rejects(workspace.createEntity({ entity: 'document', title: 'Invalid', priority: 'urgent' }), hasCode('FIELD_NOT_APPLICABLE'));
});

test('Deletion requires archive and protects project, parent, blocker, related and resolved wiki inbound references', async t => {
  const cases = ['project', 'parent', 'blocked_by', 'related_to', 'title-link', 'basename-link'] as const;
  for (const field of cases) await t.test(field, async sub => {
    const target = field === 'project' ? project : task;
    const targetId = field === 'project' ? 'PRJ-001' : 'TASK-001';
    const reference = field === 'title-link' ? { body: 'See [[Primary task]].' }
      : field === 'basename-link' ? { body: 'See [[target]].' }
      : field === 'blocked_by' || field === 'related_to' ? { [field]: [targetId] } : { [field]: targetId };
    const { workspace } = await fixture(sub, { 'target.md': target, 'referrer.md': createMarkdown({ id: 'TASK-002', title: 'Referrer', ...reference }) });
    await assert.rejects(workspace.delete(targetId, workspace.get(targetId).revision), hasCode('DELETE_REQUIRES_ARCHIVE'));
    const archived = await workspace.archive(targetId, workspace.get(targetId).revision);
    await assert.rejects(workspace.delete(targetId, archived.revision), error => {
      assert.ok(error instanceof WorkspaceError);
      assert.ok(error.diagnostics.some(item => item.code === 'DELETE_REFERENCED' && item.targetId === targetId && item.entityId === 'TASK-002' && item.field === (field.endsWith('-link') ? 'links' : field)));
      return true;
    });
  });
});

test('Unknown or unreadable sources block deletion conservatively, but ordinary unresolved wiki warnings do not', async t => {
  const { workspace, root } = await fixture(t, { 'task.md': task });
  const archived = await workspace.archive('TASK-001', workspace.get('TASK-001').revision);
  await writeFile(path.join(root, 'future.md'), createMarkdown({ id: 'DOC-001', entity: 'document', title: 'Future' }).replace('pm/v1', 'pm/v2'));
  await workspace.rescan();
  await assert.rejects(workspace.delete(archived.id, archived.revision), hasCode('DELETE_UNVERIFIABLE'));
  await rm(path.join(root, 'future.md'));
  await writeFile(path.join(root, 'note.md'), createMarkdown({ id: 'DOC-002', entity: 'document', title: 'Note', body: 'See [[Not present]].' }));
  await workspace.rescan();
  assert.ok(workspace.snapshot().errors.some(item => item.code === 'UNRESOLVED_LINK' && item.severity === 'warning'));
  assert.deepEqual(await workspace.delete(archived.id, archived.revision), { id: archived.id, deleted: true });
});

test('IDs, idempotency records and tombstones survive restart and deleting the disposable cache', async t => {
  const current = await fixture(t);
  const input = { title: 'Idempotent task', 'x-meta': { b: 2, a: 1 }, labels: ['one', 'two'] };
  const created = await current.workspace.create(input, 'create-once');
  const reordered = { labels: ['one', 'two'], 'x-meta': { a: 1, b: 2 }, title: 'Idempotent task' };
  assert.equal((await current.workspace.create(reordered, 'create-once')).id, created.id);
  await restart(current, true);
  assert.equal((await current.workspace.create(reordered, 'create-once')).id, created.id);
  await assert.rejects(current.workspace.create({ ...input, title: 'Changed intent' }, 'create-once'), hasCode('IDEMPOTENCY_CONFLICT'));
  const archived = await current.workspace.archive(created.id, created.revision);
  await current.workspace.delete(created.id, archived.revision);
  await restart(current, true);
  await assert.rejects(current.workspace.create(input, 'create-once'), hasCode('IDEMPOTENCY_CONFLICT'));
  const next = await current.workspace.create({ title: 'Next task' });
  assert.equal(next.id, 'TASK-002');
  await writeFile(path.join(current.root, 'resurrected.md'), created.raw);
  await current.workspace.rescan();
  assert.ok(current.workspace.snapshot().unsupportedFiles.some(file => file.id === created.id && file.diagnostics.some(item => item.code === 'TOMBSTONED_ID')));
  await assert.rejects(current.workspace.save(created.id, created.raw, revisionOf(created.raw)), hasCode('TOMBSTONED_ID'));
});

test('External deletions reserve observed IDs forever while same-ID restoration remains allowed', async t => {
  const current = await fixture(t, { 'task.md': task });
  await rm(path.join(current.root, 'task.md'));
  await current.workspace.rescan();
  await restart(current, true);
  const created = await current.workspace.create({ title: 'After external deletion' });
  assert.equal(created.id, 'TASK-002');
  await writeFile(path.join(current.root, 'restored.md'), task);
  await current.workspace.rescan();
  assert.equal(current.workspace.get('TASK-001').path, 'restored.md');
  const once = await current.workspace.create({ title: 'Externally removed retry' }, 'external-once');
  await rm(path.join(current.root, once.path));
  await current.workspace.rescan();
  await restart(current, true);
  await assert.rejects(current.workspace.create({ title: 'Externally removed retry' }, 'external-once'), hasCode('IDEMPOTENCY_CONFLICT'));
});

test('Deletion ignores an entity own wiki links without changing other Markdown', async t => {
  const selfLink = createMarkdown({ id: 'TASK-001', title: 'Self note', body: 'See [[TASK-001]].' });
  const { workspace } = await fixture(t, { 'task.md': selfLink });
  const archived = await workspace.archive('TASK-001', workspace.get('TASK-001').revision);
  assert.deepEqual(await workspace.delete(archived.id, archived.revision), { id: archived.id, deleted: true });
});

test('Malformed durable state fails closed instead of resetting ID or idempotency history', async t => {
  const current = await fixture(t, { 'task.md': task });
  await current.workspace.close();
  const statePath = path.join(current.root, '.pm/state/state.json');
  await writeFile(statePath, '{ broken state');
  current.workspace = new Workspace(current.root);
  await assert.rejects(current.workspace.init(), hasCode('PERSISTENT_STATE_INVALID'));
  assert.equal(await readFile(statePath, 'utf8'), '{ broken state');
  assert.equal(await readFile(path.join(current.root, 'task.md'), 'utf8'), task);
});

test('Creation journal recovers before and after content publication with durable idempotency', async t => {
  for (const published of [false, true]) await t.test(published ? 'published' : 'not published', async sub => {
    const current = await fixture(sub);
    await current.workspace.close();
    const repository = new FileRepository(current.root);
    const state = new DurableState(repository);
    const input = { entity: 'work_item', title: 'Recovered creation' };
    const raw = createMarkdown({ ...input, id: 'TASK-001' });
    state.begin({ kind: 'create', id: 'TASK-001', path: 'work-items/TASK-001.md', raw, idempotency: { key: 'recovery-key', hash: requestHash(input), id: 'TASK-001' } });
    if (published) { repository.mkdir('work-items'); repository.write('work-items/TASK-001.md', raw); }
    await restart(current, true);
    assert.equal(current.workspace.get('TASK-001').raw, raw);
    assert.equal((await current.workspace.create({ title: 'Recovered creation' }, 'recovery-key')).id, 'TASK-001');
    assert.equal(new DurableState(repository).transaction, undefined);
  });
});

test('Deletion journal recovers before and after unlink and retains tombstones', async t => {
  for (const removed of [false, true]) await t.test(removed ? 'unlinked' : 'not unlinked', async sub => {
    const current = await fixture(sub, { 'task.md': task });
    const archived = await current.workspace.archive('TASK-001', current.workspace.get('TASK-001').revision);
    await current.workspace.close();
    const repository = new FileRepository(current.root);
    const state = new DurableState(repository);
    state.begin({ kind: 'delete', id: archived.id, path: archived.path, raw: archived.raw });
    if (removed) repository.remove(archived.path, archived.revision);
    await restart(current, true);
    assert.throws(() => current.workspace.get(archived.id), error => error instanceof WorkspaceError && error.status === 404);
    assert.equal(new DurableState(repository).deleted(archived.id), true);
    assert.equal((await current.workspace.create({ title: 'After recovered deletion' })).id, 'TASK-002');
  });
});

test('Crash recovery never overwrites or deletes conflicting external content', async t => {
  for (const kind of ['create', 'delete'] as const) await t.test(kind, async sub => {
    const current = await fixture(sub, kind === 'delete' ? { 'task.md': task } : {});
    await current.workspace.close();
    const repository = new FileRepository(current.root);
    const state = new DurableState(repository);
    state.begin({ kind, id: 'TASK-001', path: 'task.md', raw: task });
    const external = task.replace('Primary task', 'External writer retained');
    await writeFile(path.join(current.root, 'task.md'), external);
    current.workspace = new Workspace(current.root);
    await assert.rejects(current.workspace.init(), hasCode('RECOVERY_CONFLICT'));
    assert.equal(await readFile(path.join(current.root, 'task.md'), 'utf8'), external);
    assert.equal(new DurableState(repository).transaction?.kind, kind);
  });
});

test('Hardlinked content and hardlinked durable state cannot be read or mutated as safe workspace files', async t => {
  const current = await fixture(t, { 'task.md': task });
  await link(path.join(current.root, 'task.md'), path.join(current.root, 'other.md'));
  await current.workspace.rescan();
  assert.ok(current.workspace.snapshot().errors.some(item => item.code === 'FILE_UNREADABLE'));
  await assert.rejects(current.workspace.save('TASK-001', task, revisionOf(task)), hasCode('FILE_UNREADABLE'));
  assert.equal(await readFile(path.join(current.root, 'other.md'), 'utf8'), task);
  await current.workspace.close();
  await link(path.join(current.root, '.pm/state/state.json'), path.join(current.root, 'ledger-copy.json'));
  current.workspace = new Workspace(current.root);
  await assert.rejects(current.workspace.init(), hasCode('PERSISTENT_STATE_INVALID'));
});
