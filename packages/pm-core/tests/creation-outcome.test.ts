import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Workspace } from '../index.ts';
import { DurableState, requestHash } from '../state.ts';
import { FileRepository, revisionOf } from '../repository.ts';
import { createMarkdown } from '../../pm-markdown/index.ts';

test('original creation revision survives modification, deletion and workspace restart', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pm-creation-facts-'));
  let workspace = new Workspace(root);
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const input = { entity: 'work_item', title: 'Original request' };
  const original = await workspace.createEntity(input, 'original-key');
  assert.equal(workspace.originalCreationRevision('original-key'), original.revision);
  assert.equal(workspace.originalCreationRevision('missing-key'), undefined);
  const changed = await workspace.patch(original.id, { title: 'Later edit' }, original.revision);
  assert.equal(workspace.originalCreationRevision('original-key'), original.revision);
  const fact = Workspace.inspectCreation(root, 'original-key');
  assert.equal(fact.request?.id, original.id);
  assert.equal(fact.request?.revision, original.revision);
  assert.equal(fact.current?.revision, changed.revision);
  const archived = await workspace.archive(changed.id, changed.revision);
  await workspace.delete(archived.id, archived.revision);
  await workspace.close();
  workspace = new Workspace(root);
  await workspace.init();
  assert.equal(workspace.originalCreationRevision('original-key'), original.revision);
  const deleted = Workspace.inspectCreation(root, 'original-key');
  assert.equal(deleted.request?.revision, original.revision);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.current, undefined);
  await assert.rejects(workspace.createEntity(input, 'original-key'), /conflicts/);
  assert.equal(workspace.snapshot().files.length, 0);
});

test('inspection and explicit confirmation never publish absent or changed pending files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pm-creation-confirm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new FileRepository(root);
  repository.init();
  repository.mkdir('work-items');
  const input = { entity: 'work_item', title: 'Unconfirmed original' };
  const raw = createMarkdown({ ...input, id: 'TASK-001' });
  const state = new DurableState(repository);
  state.begin({ kind: 'create', id: 'TASK-001', path: 'work-items/TASK-001.md', raw,
    idempotency: { key: 'pending-key', hash: requestHash(input), id: 'TASK-001' } });
  const statePath = path.join(root, '.pm/state/state.json');
  const baseline = await readFile(statePath, 'utf8');
  assert.equal(Workspace.inspectCreation(root, 'pending-key').pending, true);
  Workspace.confirmCreation(root, 'pending-key');
  await assert.rejects(readFile(path.join(root, 'work-items/TASK-001.md')), { code: 'ENOENT' });
  assert.equal(await readFile(statePath, 'utf8'), baseline);
  await writeFile(path.join(root, 'work-items/TASK-001.md'), raw + '\nExternal change\n');
  Workspace.confirmCreation(root, 'pending-key');
  assert.equal(await readFile(statePath, 'utf8'), baseline);
  await writeFile(path.join(root, 'work-items/TASK-001.md'), raw);
  Workspace.confirmCreation(root, 'pending-key');
  const confirmed = Workspace.inspectCreation(root, 'pending-key');
  assert.equal(confirmed.pending, false);
  assert.equal(confirmed.request?.revision, revisionOf(raw));
  assert.equal(await readFile(path.join(root, 'work-items/TASK-001.md'), 'utf8'), raw);
});

test('historical idempotency records remain readable without inventing an original revision', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pm-creation-historical-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new FileRepository(root);
  repository.init();
  const historical = { key: 'historical-key', hash: revisionOf('historical request'), id: 'TASK-009' };
  repository.write('.pm/state/state.json', JSON.stringify({ version: 1, reservedIds: ['TASK-009'], observed: [], tombstones: ['TASK-009'], idempotency: [historical] }));
  const before = repository.read('.pm/state/state.json');
  const fact = Workspace.inspectCreation(root, 'historical-key');
  assert.deepEqual(fact.request, historical);
  assert.equal(fact.request?.revision, undefined);
  assert.equal(fact.deleted, true);
  assert.equal(repository.read('.pm/state/state.json'), before);
});

test('native policy guards see refreshed authoritative entities before any write', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pm-creation-guard-'));
  const workspace = new Workspace(root);
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const project = await workspace.createEntity({ entity: 'project', title: 'Initial project' });
  await writeFile(path.join(root, project.path), project.raw.replace('# Initial project', '# External authority'));
  await assert.rejects(workspace.createEntity({ entity: 'work_item', title: 'Refused task', project: project.id }, 'guard-key', async (_before, after) => {
    assert.equal(after.project, project.id);
    assert.equal(workspace.get(project.id).entity.title, 'External authority');
    throw new Error('Current policy refuses');
  }), /Current policy refuses/);
  assert.equal(workspace.snapshot().files.filter(file => file.entity.entity === 'work_item').length, 0);
  assert.equal(Workspace.inspectCreation(root, 'guard-key').request, undefined);
});
