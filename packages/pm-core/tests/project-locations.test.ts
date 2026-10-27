import assert from 'node:assert/strict';
import { access, chmod, cp, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { Workspace, WorkspaceError } from '../index.ts';
import { FileRepository, revisionOf } from '../repository.ts';
import { ProjectLocations, enumerateProjectMounts, previewProjectDirectory, readProjectLocation, rebindProjectLocations } from '../project-locations.ts';
import { DurableState, requestHash } from '../state.ts';
import { readCurrentCore } from '../readonly.ts';
import { createMarkdown } from '../../pm-markdown/index.ts';

async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-project-locations-'));
  const root = path.join(base, 'workspace');
  const first = path.join(base, 'first-code'), second = path.join(base, 'second-code');
  await mkdir(root); await mkdir(first); await mkdir(second);
  let workspace = new Workspace(root);
  await workspace.init();
  t.after(async () => { await workspace.close(); await rm(base, { recursive: true, force: true }); });
  return { base, root, first, second, get workspace() { return workspace; }, restart: async () => { await workspace.close(); workspace = new Workspace(root); await workspace.init(); return workspace; } };
}

test('two physical roots share aggregate IDs/configuration and expose virtual paths only', async t => {
  const f = await fixture(t);
  const readme = '# Existing source\nDo not import or modify.\n';
  await writeFile(path.join(f.first, 'README.md'), readme);
  const one = await f.workspace.initializeProject({ entity: 'project', title: 'One', body: 'Original description' }, 'one-key', { workspaceId: 'workspace-1', root: f.first });
  const two = await f.workspace.initializeProject({ entity: 'project', title: 'Two' }, 'two-key', { workspaceId: 'workspace-1', root: f.second });
  assert.equal(one.id, 'PRJ-001'); assert.equal(two.id, 'PRJ-002');
  assert.equal(one.path, 'project-roots/PRJ-001/projects/PRJ-001.md');
  assert.equal(await readFile(path.join(f.first, '.pm/core/projects/PRJ-001.md'), 'utf8'), one.raw);
  assert.equal(await readFile(path.join(f.first, 'README.md'), 'utf8'), readme);
  const task = await f.workspace.createEntity({ entity: 'work_item', project: one.id, title: 'Task one' }, 'task-one');
  const secondTask = await f.workspace.createEntity({ entity: 'work_item', project: two.id, title: 'Task two' }, 'task-two');
  const document = await f.workspace.createEntity({ entity: 'document', project: one.id, title: 'Design', body: `See [[${task.id}]].` }, 'document-key');
  assert.equal(task.id, 'TASK-001'); assert.equal(secondTask.id, 'TASK-002');
  assert.equal(document.path, `project-roots/${one.id}/docs/${document.id}.md`);
  assert.equal(await readFile(path.join(f.second, '.pm/core/work-items/TASK-002.md'), 'utf8'), secondTask.raw);
  assert.deepEqual(f.workspace.items().map(item => item.id).sort(), [task.id, secondTask.id].sort());
  const expectedIds = [one.id, two.id, task.id, secondTask.id, document.id].sort();
  assert.deepEqual(f.workspace.snapshot().files.map(file => file.id).sort(), expectedIds);
  assert.deepEqual(f.workspace.graph().nodes.map(node => node.id).sort(), expectedIds);
  assert.equal(JSON.stringify(f.workspace.snapshot()).includes(f.first), false);
  assert.equal(await access(path.join(f.first, '.pm/state')).then(() => true, () => false), false);
  assert.equal(await access(path.join(f.second, '.pm/config.yaml')).then(() => true, () => false), false);
  await f.restart();
  assert.equal(f.workspace.get(task.id).revision, task.revision);
  assert.equal(f.workspace.get(document.id).raw, document.raw);
  assert.equal(Workspace.inspectCreation(f.root, 'one-key').current?.path, one.path);
  assert.equal(enumerateProjectMounts(f.root).length, 2);
});

test('all ordinary edits, raw saves, archive and deletion use the registered core', async t => {
  const f = await fixture(t);
  const project = await f.workspace.initializeProject({ entity: 'project', title: 'Edits' }, 'edit-project', { workspaceId: 'workspace-1', root: f.first });
  let task = await f.workspace.create({ project: project.id, title: 'Dates', 'x-pm-start': '2026-10-24', due: '2026-10-25' });
  task = await f.workspace.patch(task.id, { due: '2026-10-27' }, task.revision);
  const physical = path.join(f.first, '.pm/core/work-items', `${task.id}.md`);
  assert.equal(await readFile(physical, 'utf8'), task.raw);
  task = await f.workspace.save(task.id, task.raw.replace('# Dates', '# Raw title'), task.revision);
  assert.equal(f.workspace.get(task.id).entity.title, 'Raw title');
  await assert.rejects(f.workspace.save(task.id, task.raw.replace(`project: ${project.id}`, 'project: PRJ-999'), task.revision));
  task = await f.workspace.archive(task.id, task.revision);
  await f.workspace.delete(task.id, task.revision);
  await assert.rejects(readFile(physical), { code: 'ENOENT' });
  assert.equal(Workspace.inspectCreation(f.root, 'edit-project').current?.revision, project.revision);
});

test('missing registered roots never recreate directories, including after restart and readonly scans', async t => {
  const f = await fixture(t);
  const project = await f.workspace.initializeProject({ entity: 'project', title: 'Missing' }, 'missing-key', { workspaceId: 'workspace-1', root: f.first });
  const parked = path.join(f.base, 'unmounted'); await rename(f.first, parked);
  await assert.rejects(f.workspace.create({ project: project.id, title: 'Must not exist' }));
  assert.throws(() => readCurrentCore(f.root));
  assert.throws(() => readProjectLocation(f.root, project.id));
  await f.restart();
  await assert.rejects(f.workspace.initializeProject({ entity: 'project', title: 'Missing' }, 'missing-key', { workspaceId: 'workspace-1', root: f.first }));
  await assert.rejects(access(f.first), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(parked, '.pm/core/projects', `${project.id}.md`), 'utf8'), project.raw);
});

test('preflight refuses overlaps, foreign metadata, sensitive roots and filesystem links', async t => {
  const f = await fixture(t);
  const project = await f.workspace.initializeProject({ entity: 'project', title: 'Safe' }, 'safe-key', { workspaceId: 'workspace-1', root: f.first });
  await mkdir(path.join(f.first, 'nested'));
  assert.throws(() => previewProjectDirectory(f.root, { workspaceId: 'workspace-1', root: path.join(f.first, 'nested') }));
  assert.throws(() => previewProjectDirectory(f.root, { workspaceId: 'workspace-1', root: f.base }));
  assert.throws(() => previewProjectDirectory(f.root, { workspaceId: 'workspace-2', root: f.second }));
  assert.throws(() => previewProjectDirectory(f.root, { workspaceId: 'workspace-1', root: '/etc' }));
  await mkdir(path.join(f.second, '.pm')); await writeFile(path.join(f.second, '.pm/project.json'), '{}');
  assert.throws(() => previewProjectDirectory(f.root, { workspaceId: 'workspace-1', root: f.second }));
  const linked = path.join(f.base, 'linked'); await symlink(f.first, linked, 'dir');
  assert.throws(() => previewProjectDirectory(f.root, { workspaceId: 'workspace-1', root: linked }));
  assert.deepEqual(enumerateProjectMounts(f.root).map(mount => mount.projectId), [project.id]);
  assert.equal(await readFile(path.join(f.first, '.pm/core/projects', `${project.id}.md`), 'utf8'), project.raw);
  const task = await f.workspace.create({ project: project.id, title: 'No hard links' });
  await link(path.join(f.first, '.pm/core/work-items', `${task.id}.md`), path.join(f.base, 'hard-linked.md'));
  await f.workspace.rescan();
  await assert.rejects(f.workspace.patch(task.id, { title: 'Refused' }, task.revision));
  assert.throws(() => readCurrentCore(f.root));
  assert.throws(() => new FileRepository(f.root).read(`/etc/passwd`));
  assert.throws(() => new FileRepository(f.root).read(`project-roots/${project.id}/../project.json`));
});

test('external project membership changes never enter the aggregate or readonly view', async t => {
  const f = await fixture(t);
  const one = await f.workspace.initializeProject({ entity: 'project', title: 'One' }, 'owner-one', { workspaceId: 'workspace-1', root: f.first });
  const two = await f.workspace.initializeProject({ entity: 'project', title: 'Two' }, 'owner-two', { workspaceId: 'workspace-1', root: f.second });
  const foreign = createMarkdown({ id: 'TASK-700', entity: 'work_item', project: two.id, title: 'Wrong mount' });
  await writeFile(path.join(f.first, '.pm/core/work-items/TASK-700.md'), foreign);
  await f.workspace.rescan();
  assert.equal(f.workspace.items().some(item => item.id === 'TASK-700'), false);
  assert.ok(f.workspace.snapshot().errors.some(issue => issue.path === `project-roots/${one.id}/work-items/TASK-700.md`));
  assert.throws(() => readCurrentCore(f.root), /unavailable/);
});

test('an interrupted original initialization resumes the reserved ID/key without writable success', async t => {
  const f = await fixture(t); await f.workspace.close();
  const repository = new FileRepository(f.root), state = new DurableState(repository), locations = new ProjectLocations(f.root);
  const input = { entity: 'project', title: 'Interrupted', body: 'Keep exact original bytes' };
  const directory = { workspaceId: 'workspace-1', root: f.first, mode: 'existing' as const };
  const raw = createMarkdown({ ...input, id: 'PRJ-001' });
  state.begin({ kind: 'create', id: 'PRJ-001', path: 'project-roots/PRJ-001/projects/PRJ-001.md', raw, idempotency: { key: 'original-key', hash: requestHash(input), id: 'PRJ-001' } });
  locations.reserve('PRJ-001', 'original-key', requestHash({ input, directory }), directory);
  locations.prepare('PRJ-001');
  const before = await readFile(path.join(f.root, '.pm/state/state.json'), 'utf8');
  assert.throws(() => readCurrentCore(f.root), /recovery/);
  assert.equal(await readFile(path.join(f.root, '.pm/state/state.json'), 'utf8'), before);
  await f.restart();
  await assert.rejects(f.workspace.create({ title: 'Other writer' }), (error: unknown) => error instanceof WorkspaceError && error.status === 409);
  await assert.rejects(access(path.join(f.first, '.pm/core/projects/PRJ-001.md')), { code: 'ENOENT' });
  const result = await f.workspace.initializeProject(input, 'original-key', directory);
  assert.equal(result.id, 'PRJ-001'); assert.equal(result.raw, raw);
  assert.equal((await f.workspace.initializeProject(input, 'original-key', directory)).id, result.id);
  await assert.rejects(f.workspace.initializeProject(input, 'original-key', { ...directory, root: f.second }), /conflicts/);
  assert.deepEqual(f.workspace.snapshot().files.map(file => file.id), [result.id]);
  const next = await f.workspace.initializeProject({ entity: 'project', title: 'Next' }, 'next-key', { workspaceId: 'workspace-1', root: f.second });
  assert.equal(next.id, 'PRJ-002');
});

test('legacy authority remains real until migration, then relocation preserves revisions and binary attachments', async t => {
  const f = await fixture(t);
  const project = await f.workspace.createEntity({ entity: 'project', title: 'Legacy', body: 'Historical project body' }, 'legacy-original');
  const task = await f.workspace.create({ project: project.id, title: 'Legacy task' }, 'legacy-task');
  const doc = await f.workspace.createEntity({ entity: 'document', project: project.id, title: 'Historical link', body: `[[${task.id}]]` });
  assert.equal(project.path, `projects/${project.id}.md`);
  assert.equal(f.workspace.projectLocations().length, 0);
  await writeFile(path.join(f.first, 'source.ts'), 'export const untouched = true;\n');
  const migrated = await f.workspace.migrateProject(project.id, 'migrate-key', { workspaceId: 'workspace-1', root: f.first });
  assert.equal(f.workspace.get(project.id).revision, project.revision);
  assert.equal(f.workspace.get(task.id).raw, task.raw);
  assert.equal(f.workspace.get(doc.id).revision, doc.revision);
  await assert.rejects(access(path.join(f.root, project.path)), { code: 'ENOENT' });
  assert.equal((await f.workspace.migrateProject(project.id, 'migrate-key', { workspaceId: 'workspace-1', root: f.first })).storageId, migrated.storageId);
  const bytes = Buffer.from([0, 255, 24, 0, 128]);
  await mkdir(path.join(migrated.attachmentsPath, 'objects')); await writeFile(path.join(migrated.attachmentsPath, 'objects/file.bin'), bytes);
  await writeFile(path.join(migrated.attachmentsPath, '.pm-store.json'), '{"stable":"identity"}\n');
  const relocated = await f.workspace.relocateProject(project.id, 'relocate-key', { workspaceId: 'workspace-1', root: f.second });
  assert.equal(relocated.storageId, migrated.storageId);
  assert.deepEqual(await readFile(path.join(relocated.attachmentsPath, 'objects/file.bin')), bytes);
  assert.equal(await readFile(path.join(relocated.attachmentsPath, '.pm-store.json'), 'utf8'), '{"stable":"identity"}\n');
  assert.equal(await readFile(path.join(f.first, 'source.ts'), 'utf8'), 'export const untouched = true;\n');
  await assert.rejects(access(path.join(f.first, '.pm/project.json')), { code: 'ENOENT' });
  assert.equal(Workspace.inspectCreation(f.root, 'legacy-original').current?.revision, project.revision);
  await f.restart();
  assert.equal(f.workspace.get(task.id).revision, task.revision);
  assert.equal(readCurrentCore(f.root).files.length, 3);
});

test('explicit moved-folder rebinding refuses active duplicates and preserves the original store identity', async t => {
  const f = await fixture(t);
  const project = await f.workspace.initializeProject({ entity: 'project', title: 'Moved code' }, 'moved-project', { workspaceId: 'workspace-1', root: f.first });
  const original = f.workspace.projectLocation(project.id)!;
  const moved = path.join(f.base, 'manually-moved');
  await cp(f.first, moved, { recursive: true });
  await assert.rejects(f.workspace.rebindProject(project.id, 'rebind-duplicate', { workspaceId: 'workspace-1', root: moved }), /verification/);
  await rm(moved, { recursive: true }); await rename(f.first, moved);
  await assert.rejects(f.workspace.relocateProject(project.id, 'must-not-infer-rebind', { workspaceId: 'workspace-1', root: moved }));
  const rebound = await f.workspace.rebindProject(project.id, 'rebind-original', { workspaceId: 'workspace-1', root: moved });
  assert.equal(rebound.storageId, original.storageId);
  assert.equal(f.workspace.get(project.id).revision, project.revision);
  assert.equal((await f.workspace.rebindProject(project.id, 'rebind-original', { workspaceId: 'workspace-1', root: moved })).root, moved);
  await assert.rejects(access(f.first), { code: 'ENOENT' });
});

test('stopped restore rebinding reads only copied destinations and leaves readonly state byte-identical', async t => {
  const f = await fixture(t);
  const project = await f.workspace.initializeProject({ entity: 'project', title: 'Restore' }, 'restore-project', { workspaceId: 'workspace-1', root: f.first });
  await f.workspace.close();
  const restoredWorkspace = path.join(f.base, 'restored-workspace'), restoredProject = path.join(f.base, 'restored-project');
  await cp(f.root, restoredWorkspace, { recursive: true }); await cp(f.first, restoredProject, { recursive: true });
  await rename(f.root, path.join(f.base, 'offline-workspace')); await rename(f.first, path.join(f.base, 'offline-project'));
  rebindProjectLocations(restoredWorkspace, { [project.id]: restoredProject });
  const statePath = path.join(restoredWorkspace, '.pm/state/state.json');
  const mapPath = path.join(restoredWorkspace, '.pm/state/project-locations.json');
  const beforeState = await readFile(statePath, 'utf8'), beforeMap = await readFile(mapPath, 'utf8');
  assert.equal(readCurrentCore(restoredWorkspace).files[0]?.revision, project.revision);
  assert.equal(await readFile(statePath, 'utf8'), beforeState); assert.equal(await readFile(mapPath, 'utf8'), beforeMap);
  assert.equal(beforeMap.includes(f.first), false);
});

test('watcher observes registered core changes without importing arbitrary code Markdown', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const project = await f.workspace.initializeProject({ entity: 'project', title: 'Watch' }, 'watch-project', { workspaceId: 'workspace-1', root: f.first });
  const task = await f.workspace.create({ project: project.id, title: 'Before external edit' });
  const changed = new Promise<void>(resolve => {
    const off = f.workspace.onChange(event => { if (event.reason === 'external' && f.workspace.get(task.id).entity.title === 'External edit') { off(); resolve(); } });
  });
  await writeFile(path.join(f.first, '.pm/core/work-items', `${task.id}.md`), task.raw.replace('# Before external edit', '# External edit'));
  await changed;
  await writeFile(path.join(f.first, 'NOT-AN-ENTITY.md'), createMarkdown({ id: 'TASK-900', title: 'Code tree is not imported' }));
  await f.workspace.rescan();
  assert.equal(f.workspace.items().some(file => file.id === 'TASK-900'), false);
  const stored = await readdir(path.join(f.first, '.pm'));
  assert.deepEqual(stored.sort(), ['attachments', 'core', 'project.json']);
  assert.equal(f.workspace.get(task.id).revision, revisionOf(await readFile(path.join(f.first, '.pm/core/work-items', `${task.id}.md`), 'utf8')));
});

test('new-folder mode creates only the reserved root and refuses inode replacement', async t => {
  const f = await fixture(t), root = path.join(f.base, 'new-code');
  const input = { entity: 'project', title: 'New folder' };
  const directory = { workspaceId: 'workspace-1', root, mode: 'new' as const };
  const project = await f.workspace.initializeProject(input, 'new-directory-key', directory);
  const parked = path.join(f.base, 'original-code');
  await rename(root, parked); await cp(parked, root, { recursive: true });
  assert.throws(() => readProjectLocation(f.root, project.id), /replaced/);
  await assert.rejects(f.workspace.create({ project: project.id, title: 'Do not adopt replacement' }));
  await rm(root, { recursive: true }); await f.restart();
  await assert.rejects(f.workspace.initializeProject(input, 'new-directory-key', directory));
  await assert.rejects(access(root), { code: 'ENOENT' });
});

test('a durable partial migration stays fenced on restart and resumes only its original transfer key', async t => {
  const f = await fixture(t);
  const project = await f.workspace.createEntity({ entity: 'project', title: 'Migration recovery' });
  const task = await f.workspace.create({ project: project.id, title: 'Keep task revision' });
  await f.workspace.close();
  const directory = { workspaceId: 'workspace-1', root: f.first, mode: 'existing' as const };
  const operationHash = createHash('sha256').update(JSON.stringify({ projectId: project.id, directory, relocate: false })).digest('hex');
  const diskIdentity = await stat(f.first, { bigint: true });
  const storageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const marker = { version: 1, workspaceId: 'workspace-1', projectId: project.id, storageId, core: '.pm/core', attachments: '.pm/attachments' };
  await mkdir(path.join(f.first, '.pm/core/projects'), { recursive: true });
  await mkdir(path.join(f.first, '.pm/core/work-items')); await mkdir(path.join(f.first, '.pm/core/docs')); await mkdir(path.join(f.first, '.pm/attachments'));
  await writeFile(path.join(f.first, '.pm/project.json'), JSON.stringify(marker, null, 2) + '\n');
  await writeFile(path.join(f.first, '.pm/core', project.path), project.raw);
  const journal = { version: 1, entries: [{ projectId: project.id, workspaceId: 'workspace-1', storageId, root: f.first, mode: 'existing',
    initialization: { key: 'original-transfer', hash: operationHash, step: 'reserved' },
    transfer: { key: 'original-transfer', hash: operationHash, phase: 'copying', target: { root: f.first, mode: 'existing', identity: { device: String(diskIdentity.dev), inode: String(diskIdentity.ino) } },
      files: [project, task].map(file => ({ source: file.path, destination: file.path, revision: file.revision })) } }] };
  await writeFile(path.join(f.root, '.pm/state/project-locations.json'), JSON.stringify(journal));
  await f.restart();
  assert.throws(() => readCurrentCore(f.root), /recovery/);
  assert.equal(await readFile(path.join(f.root, task.path), 'utf8'), task.raw);
  await assert.rejects(f.workspace.migrateProject(project.id, 'replacement-key', directory), /recovery/);
  await assert.rejects(f.workspace.create({ project: project.id, title: 'Fenced' }));
  const result = await f.workspace.migrateProject(project.id, 'original-transfer', directory);
  assert.equal(result.storageId, storageId);
  assert.equal(f.workspace.get(task.id).revision, task.revision);
  assert.equal(f.workspace.get(project.id).revision, project.revision);
  await assert.rejects(access(path.join(f.root, task.path)), { code: 'ENOENT' });
  assert.equal(readCurrentCore(f.root).files.length, 2);
});

test('preflight identity survives guard awaits and a crash before mount registration', async t => {
  const f = await fixture(t), parked = path.join(f.base, 'preflight-original');
  const input = { entity: 'project', title: 'Original directory only' };
  const directory = { workspaceId: 'workspace-1', root: f.first };
  await writeFile(path.join(f.first, 'README.md'), '# Original code\n');
  await assert.rejects(f.workspace.initializeProject(input, 'preflight-key', directory, async () => {
    await rename(f.first, parked); await mkdir(f.first);
  }), /recovery/);
  assert.equal(f.workspace.projectLocations().length, 0);
  await assert.rejects(access(path.join(f.first, '.pm')), { code: 'ENOENT' });
  await f.restart();
  await assert.rejects(f.workspace.initializeProject(input, 'preflight-key', directory), /recovery/);
  await assert.rejects(f.workspace.initializeProject(input, 'preflight-key', { ...directory, root: f.second }), /original durable reservation/);
  await rm(f.first, { recursive: true }); await rename(parked, f.first);
  const result = await f.workspace.initializeProject(input, 'preflight-key', directory);
  assert.equal(result.id, 'PRJ-001');
  assert.equal(await readFile(path.join(f.first, 'README.md'), 'utf8'), '# Original code\n');
  assert.equal(Workspace.inspectCreation(f.root, 'preflight-key').request?.id, result.id);
});

test('a real unwritable selected directory stays pending without modifying existing files', async t => {
  const f = await fixture(t);
  const original = Buffer.from('User-owned source remains exact\r\n');
  await writeFile(path.join(f.first, 'README.md'), original);
  const input = { entity: 'project', title: 'Permission recovery' };
  const directory = { workspaceId: 'workspace-1', root: f.first, mode: 'existing' as const };
  await chmod(f.first, 0o500);
  try {
    await assert.rejects(f.workspace.initializeProject(input, 'permission-key', directory), /requires recovery/);
    await assert.rejects(access(path.join(f.first, '.pm/project.json')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path.join(f.first, 'README.md')), original);
    assert.throws(() => readCurrentCore(f.root), /recovery/);
  } finally { await chmod(f.first, 0o700); }
  await f.restart();
  const recovered = await f.workspace.initializeProject(input, 'permission-key', directory);
  assert.equal(recovered.id, 'PRJ-001');
  assert.deepEqual(await readFile(path.join(f.first, 'README.md')), original);
  assert.equal((await f.workspace.initializeProject(input, 'permission-key', directory)).revision, recovered.revision);
});

test('ENOSPC after the identity marker preserves the reservation and resumes without duplicate identity', async t => {
  const f = await fixture(t);
  const input = { entity: 'project', title: 'Capacity recovery' };
  const directory = { workspaceId: 'workspace-1', root: f.first, mode: 'existing' as const };
  const mkdir = FileRepository.prototype.mkdir;
  const fault = t.mock.method(FileRepository.prototype, 'mkdir', function (this: FileRepository, relative: string) {
    if (this.root === f.first && relative === '.pm/core') throw Object.assign(new Error('Selected disk capacity exhausted'), { code: 'ENOSPC' });
    return mkdir.call(this, relative);
  });
  await assert.rejects(f.workspace.initializeProject(input, 'capacity-key', directory), /requires recovery/);
  const marker = await readFile(path.join(f.first, '.pm/project.json'));
  await assert.rejects(access(path.join(f.first, '.pm/core/projects/PRJ-001.md')), { code: 'ENOENT' });
  await f.restart();
  assert.throws(() => readCurrentCore(f.root), /recovery/);
  await assert.rejects(f.workspace.create({ title: 'Forbidden replacement' }), (error: unknown) => error instanceof WorkspaceError && error.status === 409);
  fault.mock.restore();
  const recovered = await f.workspace.initializeProject(input, 'capacity-key', directory);
  assert.equal(recovered.id, 'PRJ-001');
  assert.deepEqual(await readFile(path.join(f.first, '.pm/project.json')), marker);
  const next = await f.workspace.initializeProject({ entity: 'project', title: 'Next identity' }, 'after-capacity-key', { workspaceId: 'workspace-1', root: f.second });
  assert.equal(next.id, 'PRJ-002');
});
