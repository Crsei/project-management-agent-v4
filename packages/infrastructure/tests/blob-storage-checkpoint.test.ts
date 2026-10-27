import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, cp, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCoreCheckpoint, verifyCoreCheckpoint } from '../src/blob-storage-checkpoint.ts';
import { Workspace } from '../../pm-core/index.ts';

test('checkpoint preserves config/views/state and excludes only reconstructible cache', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pm-core-checkpoint-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, randomUUID());
  await mkdir(join(workspace, '.pm', 'state'), { recursive: true }); await mkdir(join(workspace, '.pm', 'cache')); await mkdir(join(workspace, '.pm', 'views'));
  await writeFile(join(workspace, '.pm', 'config.yaml'), 'schemaVersion: 1\n');
  await writeFile(join(workspace, '.pm', 'state', 'ledger.json'), '{"nextId":4}');
  await writeFile(join(workspace, '.pm', 'views', 'saved.yaml'), 'name: private view\n');
  await writeFile(join(workspace, '.pm', 'cache', 'index.sqlite'), 'rebuildable');
  await writeFile(join(workspace, 'TASK-001.md'), '# Original authoritative Markdown\n');
  const entries = await captureCoreCheckpoint(root);
  assert.equal(entries.length, 4); assert.ok(entries.some(entry => entry.path.includes('/.pm/state/'))); assert.ok(entries.some(entry => entry.path.includes('/.pm/views/')));
  assert.ok(entries.every(entry => !entry.path.includes('/.pm/cache/')));
  assert.match(await verifyCoreCheckpoint(root, [...entries].reverse()), /^[a-f0-9]{64}$/);
  await writeFile(join(workspace, '.pm', 'cache', 'index.sqlite'), 'different cache is allowed'); await verifyCoreCheckpoint(root, entries);
  await writeFile(join(workspace, 'TASK-001.md'), '# Modified\n');
  await assert.rejects(verifyCoreCheckpoint(root, entries), { code: 'blob_checkpoint_mismatch' });
  await assert.rejects(verifyCoreCheckpoint(root, [{ path: '../escape', sha256: 'a'.repeat(64), size: 0 }]), { code: 'blob_checkpoint_unsafe' });
});
test('checkpoint restores a default-config workspace without inventing a configuration file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pm-core-checkpoint-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source'), targetRoot = join(root, 'target'), id = randomUUID();
  const source = new Workspace(join(sourceRoot, id));
  await source.init();
  const configuration = source.configuration();
  await source.close();
  const entries = await captureCoreCheckpoint(sourceRoot);
  await cp(sourceRoot, targetRoot, { recursive: true });
  await verifyCoreCheckpoint(targetRoot, entries);
  await assert.rejects(lstat(join(sourceRoot, id, '.pm', 'config.yaml')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(targetRoot, id, '.pm', 'config.yaml')), { code: 'ENOENT' });
  await writeFile(join(targetRoot, id, '.pm', 'config.yaml'), 'schemaVersion: 1\n');
  await assert.rejects(verifyCoreCheckpoint(targetRoot, entries), { code: 'blob_checkpoint_mismatch' });
  await rm(join(targetRoot, id, '.pm', 'config.yaml'));
  const restored = new Workspace(join(targetRoot, id));
  try { await restored.init(); assert.deepEqual(restored.configuration(), configuration); }
  finally { await restored.close(); }
});
test('checkpoint never recreates missing durable state or follows symlinks to make recovery pass', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pm-core-checkpoint-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, randomUUID()); await mkdir(join(workspace, '.pm'), { recursive: true }); await writeFile(join(workspace, '.pm', 'config.yaml'), 'schemaVersion: 1\n');
  await assert.rejects(captureCoreCheckpoint(root));
  await mkdir(join(workspace, '.pm', 'state')); await symlink('/etc/passwd', join(workspace, 'not-markdown'));
  await assert.rejects(captureCoreCheckpoint(root), { code: 'blob_checkpoint_unsafe' });
});
