import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Workspace } from '../index.ts';
import { FileRepository } from '../repository.ts';
import { DurableState } from '../state.ts';

async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-project-copy-'));
  const root = path.join(base, 'workspace'); await mkdir(root);
  let workspace = new Workspace(root); await workspace.init();
  t.after(async () => { await workspace.close(); await rm(base, { recursive: true, force: true }); });
  return { base, root, get workspace() { return workspace; }, async restart() { await workspace.close(); workspace = new Workspace(root); await workspace.init(); } };
}

test('duplicate remaps project/task links, parents and blockers; drops excluded references and resets work without copying provenance', async t => {
  const f = await fixture(t), w = f.workspace;
  const project = await w.createEntity({ entity: 'project', title: 'Source', body: 'Project prose', goal: 'Goal', 'x-pm-icon': 'layers', 'x-pm-created-by': 'source-actor' });
  const one = await w.create({ project: project.id, title: 'One', body: 'One prose\n\n- [x] completed criterion', status: 'done', 'x-pm-intent-ref': { intentId: 'not-cloned' } });
  const excluded = await w.create({ project: project.id, title: 'Archived task', archived: true });
  const doc = await w.createEntity({ entity: 'document', project: project.id, title: 'Excluded document' });
  const two = await w.create({ project: project.id, title: 'Two', parent: one.id, blocked_by: [one.id, excluded.id],
    body: `See [[${one.id}#section|parent]], [[${project.id}|project]], [[${excluded.id}|archived]] and [[${doc.id}|document]].\n\n![attachment](/api/v1/artifact-versions/old/content)\n\n\`[[${one.id}]]\`\n\n\`\`\`pm-view\nlayout: table\nproject: ${project.id}\n\`\`\`` });
  const originals = new Map(w.snapshot().files.map(record => [record.id, record.raw]));
  const configuration = w.configuration();
  configuration.config.workflows.work_item!.initial = 'in_progress';
  configuration.config.workflows.project!.initial = 'on_hold';
  await w.saveConfiguration(configuration.config, configuration.revision);
  const input = { name: 'Independent copy', includeTasks: true };
  const copied = await w.duplicateProject(project.id, project.revision, input, 'copy-1');
  assert.notEqual(copied.id, project.id); assert.equal(copied.copiedTaskCount, 2);
  const first = w.get(copied.taskIdMap[one.id]!), second = w.get(copied.taskIdMap[two.id]!);
  assert.equal(first.entity.project, copied.id); assert.equal(first.entity.status, 'in_progress');
  assert.equal(w.get(copied.id).entity.status, 'on_hold');
  assert.equal(first.entity.checklist[0]?.checked, false); assert.equal(first.entity['x-pm-intent-ref'], undefined);
  assert.equal(w.get(copied.id).entity['x-pm-created-by'], undefined); assert.equal(w.get(copied.id).entity['x-pm-icon'], 'layers');
  assert.equal(second.entity.parent, first.id); assert.deepEqual(second.entity.blocked_by, [first.id]);
  assert.deepEqual(second.entity.views, [], 'source-scoped embedded queries are inert in the copy');
  assert.deepEqual(second.entity.links.sort(), [first.id, copied.id].sort());
  assert.match(second.raw, new RegExp(`\`\\[\\[${one.id}\\]\\]\``), 'literal code is not an active source reference');
  assert.doesNotMatch(second.raw, /\/api\/v1\/artifact-versions/);
  for (const [id, raw] of originals) assert.equal(w.get(id).raw, raw);
  await f.restart();
  assert.deepEqual(await f.workspace.duplicateProject(project.id, project.revision, input, 'copy-1'), copied);
  assert.equal(f.workspace.get(second.id).entity.parent, first.id);
  await assert.rejects(f.workspace.duplicateProject(project.id, project.revision, { ...input, name: 'Changed' }, 'copy-1'));
  const empty = await f.workspace.duplicateProject(project.id, project.revision, { name: 'Content only', includeTasks: false }, 'copy-2');
  assert.equal(empty.copiedTaskCount, 0); assert.deepEqual(empty.taskIdMap, {});
});

test('copy freezes IDs and bytes before a partial disk failure, survives restart, and resumes only its original manifest', async t => {
  const f = await fixture(t), w = f.workspace;
  const project = await w.createEntity({ entity: 'project', title: 'Durable source' });
  await w.create({ project: project.id, title: 'Task' });
  const destination = path.join(f.base, 'destination'); await mkdir(destination);
  await writeFile(path.join(destination, 'user-code.ts'), 'export const retained = true;\n');
  const originalWrite = FileRepository.prototype.write;
  const injected = t.mock.method(FileRepository.prototype, 'write', function(this: FileRepository, relative: string, raw: string, revision?: string) {
    if (relative === 'work-items/TASK-002.md') throw new Error('deterministic destination failure');
    return originalWrite.call(this, relative, raw, revision);
  });
  const input = { name: 'Durable copy', includeTasks: true }, directory = { workspaceId: 'workspace', root: destination };
  await assert.rejects(w.duplicateProject(project.id, project.revision, input, 'durable-copy', directory));
  injected.mock.restore();
  const pending = new DurableState(new FileRepository(f.root), true).transaction;
  assert.equal(pending?.kind, 'duplicate'); if (pending?.kind !== 'duplicate') throw new Error('Missing durable manifest');
  const expected = pending.idempotency.copy.taskIdMap;
  await f.restart();
  assert.equal(new DurableState(new FileRepository(f.root), true).transaction?.kind, 'duplicate', 'restart does not silently resume writes');
  const beforeRecovery = await readdir(path.join(destination, '.pm/core/work-items'));
  assert.deepEqual(beforeRecovery, []);
  const copied = await f.workspace.duplicateProject(project.id, project.revision, input, 'durable-copy', directory);
  assert.equal(copied.id, pending.id); assert.deepEqual(copied.taskIdMap, expected);
  assert.equal(await readFile(path.join(destination, 'user-code.ts'), 'utf8'), 'export const retained = true;\n');
  assert.deepEqual(await readdir(path.join(destination, '.pm/attachments')), []);
  assert.equal(new DurableState(new FileRepository(f.root), true).transaction, undefined);
  await f.restart();
  assert.deepEqual(await f.workspace.duplicateProject(project.id, project.revision, input, 'durable-copy', directory), copied);
});

test('validation and source conflicts touch no directory; edited destinations are never overwritten during recovery', async t => {
  const f = await fixture(t), w = f.workspace;
  const project = await w.createEntity({ entity: 'project', title: 'Original' });
  const changed = await w.patch(project.id, { title: 'Changed source' }, project.revision);
  const destination = path.join(f.base, 'not-created');
  await assert.rejects(w.duplicateProject(project.id, project.revision, { name: 'No copy', includeTasks: false }, 'stale', { workspaceId: 'workspace', root: destination, mode: 'new' }));
  await assert.rejects(readFile(path.join(destination, '.pm/project.json')), { code: 'ENOENT' });
  assert.equal(new DurableState(new FileRepository(f.root), true).transaction, undefined);
  const originalWrite = FileRepository.prototype.write;
  const injected = t.mock.method(FileRepository.prototype, 'write', function(this: FileRepository, relative: string, raw: string, revision?: string) {
    if (relative === 'projects/PRJ-002.md') throw new Error('deterministic project failure');
    return originalWrite.call(this, relative, raw, revision);
  });
  const input = { name: 'Frozen', includeTasks: false };
  await assert.rejects(w.duplicateProject(changed.id, changed.revision, input, 'edited-destination'));
  injected.mock.restore();
  const pending = new DurableState(new FileRepository(f.root), true).transaction;
  assert.equal(pending?.kind, 'duplicate'); if (pending?.kind !== 'duplicate') throw new Error('Missing copy manifest');
  const edited = pending.raw + '\nUser content after interruption.\n';
  await writeFile(path.join(f.root, pending.path), edited);
  await f.restart();
  await assert.rejects(f.workspace.duplicateProject(changed.id, changed.revision, input, 'edited-destination'));
  assert.equal(await readFile(path.join(f.root, pending.path), 'utf8'), edited);
  assert.equal(new DurableState(new FileRepository(f.root), true).transaction?.id, pending.id);
});
