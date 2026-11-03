import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, link, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalBlobStore, MAX_BLOB_BYTES } from '../src/blobs.ts';
import { SafeDirectory, exclusiveFileFlags } from '../src/portable-directory.ts';

async function setup(t: test.TestContext) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'pm-blobs-test-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'objects');
  const store = new LocalBlobStore(root);
  await store.init();
  return { temporary, root, store };
}

test('blob publication preserves exact bytes, digest, immutable identity and restart readability', async t => {
  const { root, store } = await setup(t);
  const bytes = Buffer.from([0, 255, 4, 13, 10, 128]);
  const original = await store.put(bytes);
  const repeat = await store.put(bytes);
  assert.notEqual(original.key, repeat.key);
  assert.equal(original.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(original.size, bytes.length);
  assert.deepEqual(await new LocalBlobStore(root).read(original.key), bytes);
  assert.deepEqual(await readFile(join(root, original.key)), bytes);
  await store.check();
  assert.equal((await readdir(root)).length, 2);
});

test('parallel blob writes publish complete independent objects with no pending files', async t => {
  const { root, store } = await setup(t);
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => store.put(Buffer.from(`content ${index}`))));
  assert.equal(new Set(results.map(item => item.key)).size, 20);
  for (const [index, result] of results.entries()) assert.equal((await store.read(result.key)).toString(), `content ${index}`);
  assert.equal((await readdir(root)).length, 20);
});

test('untrusted blob keys reject traversal, absolute paths, encoded paths and pending names', async t => {
  const { store } = await setup(t);
  for (const key of ['../secret', '/etc/passwd', '..%2fsecret', 'a/../b', '.pending-123', 'sha256-abc.blob', 'a\\b']) {
    await assert.rejects(store.read(key), { code: 'invalid_blob_key' });
  }
});

test('blob size is bounded and corrupt stored bytes never pass digest verification', async t => {
  const { root, store } = await setup(t);
  await assert.rejects(store.put(Buffer.alloc(MAX_BLOB_BYTES + 1)), { code: 'upload_too_large' });
  const original = await store.put(Buffer.from('trusted content'));
  await writeFile(join(root, original.key), 'changed content');
  await assert.rejects(store.read(original.key), { code: 'blob_integrity_error' });
  const empty = await store.put(Buffer.alloc(0));
  assert.equal((await store.read(empty.key)).length, 0);
});

test('blob adapter refuses root, ancestor and object symlinks', async t => {
  const { temporary, root, store } = await setup(t);
  const outside = join(temporary, 'outside');
  await mkdir(outside);
  const linked = join(temporary, 'linked');
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new LocalBlobStore(linked).init(), { code: 'blob_storage_unavailable' });
  await assert.rejects(new LocalBlobStore(join(linked, 'nested')).init(), { code: 'blob_storage_unavailable' });
  assert.deepEqual(await readdir(outside), []);
  const object = await store.put(Buffer.from('secret'));
  const external = join(outside, 'secret');
  await writeFile(external, 'secret');
  await unlink(join(root, object.key));
  await symlink(process.platform === 'win32' ? outside : external, join(root, object.key), process.platform === 'win32' ? 'junction' : 'file');
  await assert.rejects(store.read(object.key), { code: 'blob_read_failed' });
  assert.equal((await readFile(external)).toString(), 'secret');
});

test('blob import preserves immutable identity and refuses conflicts and hardlinks on native filesystems', async t => {
  const { temporary, root, store } = await setup(t);
  const bytes = Buffer.from('immutable import');
  const object = await store.put(bytes);
  assert.deepEqual(await store.importVerifiedObject(object.key, bytes), object);
  await assert.rejects(store.importVerifiedObject(object.key, Buffer.from('different content')), { code: 'blob_integrity_error' });
  assert.deepEqual(await store.read(object.key), bytes);
  const alias = join(temporary, 'hardlink');
  await link(join(root, object.key), alias);
  await assert.rejects(store.read(object.key), { code: 'blob_integrity_error' });
  await unlink(alias);
  await store.createMarker(Buffer.from('original marker'));
  await assert.rejects(store.createMarker(Buffer.from('replacement marker')), { code: 'blob_storage_binding_mismatch' });
  assert.equal((await new LocalBlobStore(root).readMarker())?.toString(), 'original marker');
});

test('an initialized blob store refuses a different directory substituted at the same root', async t => {
  const { root, store } = await setup(t);
  await store.put(Buffer.from('original'));
  await rename(root, `${root}-original`);
  await mkdir(root);
  await assert.rejects(store.put(Buffer.from('must not adopt replacement')), { code: 'blob_storage_unavailable' });
  assert.deepEqual(await readdir(root), []);
});

test('file fsync failure is fatal, including unsupported-operation errors on Windows', async t => {
  const { root, store } = await setup(t);
  const original = SafeDirectory.prototype.openFile;
  t.mock.method(SafeDirectory.prototype, 'openFile', async function (this: SafeDirectory, ...args: Parameters<typeof original>) {
    const file = await original.apply(this, args);
    t.mock.method(file, 'sync', async () => { throw Object.assign(new Error('File flush unsupported'), { code: 'ENOTSUP' }); });
    return file;
  });
  await assert.rejects(store.put(Buffer.from('not durable')), { code: 'blob_write_failed' });
  assert.deepEqual(await readdir(root), []);
});

test('portable directory guards reject a live root identity change while Linux keeps its pinned descriptor', async t => {
  const { root } = await setup(t);
  const directory = await SafeDirectory.open(root);
  try {
    await rename(root, `${root}-original`);
    await mkdir(root);
    if (process.platform === 'linux') {
      const file = await directory.openFile('pinned', exclusiveFileFlags);
      try { await file.writeFile('pinned original'); await file.sync(); } finally { await file.close(); }
      assert.equal((await readFile(join(`${root}-original`, 'pinned'))).toString(), 'pinned original');
      assert.deepEqual(await readdir(root), []);
    } else await assert.rejects(directory.assertIdentity(), { code: 'blob_checkpoint_unsafe' });
  } finally { await directory.close(); }
});

test('directory durability failures are not acknowledged as successful blob writes', async t => {
  const { store } = await setup(t);
  t.mock.method(SafeDirectory.prototype, 'sync', async () => { throw Object.assign(new Error('Directory flush failed'), { code: 'EIO' }); });
  await assert.rejects(store.put(Buffer.from('metadata flush fails')), { code: 'blob_write_failed' });
  await assert.rejects(store.check(), { code: 'blob_storage_unavailable' });
});
