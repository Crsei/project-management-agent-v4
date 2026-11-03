import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyTree, snapshotTree } from './maintenance-files.ts';

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'desktop-backup-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  return { root, source, target: join(root, 'restored') };
}

test('restore preserves nested binary files and empty directories', async t => {
  const { source, target } = await fixture(t);
  await mkdir(join(source, 'nested'));
  await mkdir(join(source, 'empty'));
  const bytes = Buffer.from([0, 255, 1, 128, 10]);
  await writeFile(join(source, 'nested', 'attachment.bin'), bytes);
  const manifest = await snapshotTree(source);
  await copyTree(source, target, manifest);
  assert.deepEqual(await readFile(join(target, 'nested', 'attachment.bin')), bytes);
  assert.deepEqual(await snapshotTree(target), manifest);
});

test('changed backup bytes are rejected before creating the restore target', async t => {
  const { source, target } = await fixture(t);
  await writeFile(join(source, 'note.md'), 'original');
  const manifest = await snapshotTree(source);
  await writeFile(join(source, 'note.md'), 'modified');
  await assert.rejects(copyTree(source, target, manifest), /manifest differs/);
  await assert.rejects(readFile(join(target, 'note.md')), { code: 'ENOENT' });
});

test('backup refuses linked content instead of reading external files', async t => {
  const { root, source } = await fixture(t);
  await writeFile(join(root, 'outside'), 'private');
  // Hard links are available to unprivileged Windows accounts and must be refused.
  await link(join(root, 'outside'), join(source, 'hardlink'));
  await assert.rejects(snapshotTree(source), /Unsafe maintenance file/);
  await rm(join(source, 'hardlink'));
  if (process.platform !== 'win32') {
    await symlink(join(root, 'outside'), join(source, 'symlink'));
    await assert.rejects(snapshotTree(source), /refuses filesystem links/);
  }
});

test('restore rejects traversal manifests and never overwrites an existing destination', async t => {
  const { source, target } = await fixture(t);
  await writeFile(join(source, 'note.md'), 'source');
  const manifest = await snapshotTree(source);
  await assert.rejects(copyTree(source, target, { ...manifest, directories: ['../escape'] }));
  await mkdir(target);
  await writeFile(join(target, 'note.md'), 'existing');
  await assert.rejects(copyTree(source, target, manifest), { code: 'EEXIST' });
  assert.equal(await readFile(join(target, 'note.md'), 'utf8'), 'existing');
});
