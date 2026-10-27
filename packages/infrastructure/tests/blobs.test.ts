import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalBlobStore, MAX_BLOB_BYTES } from '../src/blobs.ts';

async function setup(t: test.TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'pm-blobs-test-'));
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
  await symlink(outside, linked);
  await assert.rejects(new LocalBlobStore(linked).init(), { code: 'blob_storage_unavailable' });
  await assert.rejects(new LocalBlobStore(join(linked, 'nested')).init(), { code: 'blob_storage_unavailable' });
  assert.deepEqual(await readdir(outside), []);
  const object = await store.put(Buffer.from('secret'));
  const external = join(outside, 'secret');
  await writeFile(external, 'secret');
  await unlink(join(root, object.key));
  await symlink(external, join(root, object.key));
  await assert.rejects(store.read(object.key), { code: 'blob_read_failed' });
  await assert.rejects(store.read(object.key), { code: 'blob_read_failed' });
  assert.equal((await readFile(external)).toString(), 'secret');
});
