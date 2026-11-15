import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentsFilesFamily, readUploadBytes, saveArtifactDownload } from '../documents-files.ts';
import type { CliRuntime } from '../runtime.ts';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('bounded upload reads real bytes and rejects links, special files and oversized input', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pm-cli-upload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from([0, 255, 13, 10, 42]);
  await writeFile(join(root, 'actual.bin'), bytes);
  assert.deepEqual(await readUploadBytes(join(root, 'actual.bin')), bytes);
  await symlink('actual.bin', join(root, 'alias.bin'));
  await assert.rejects(readUploadBytes(join(root, 'alias.bin')));
  await link(join(root, 'actual.bin'), join(root, 'hard.bin'));
  await assert.rejects(readUploadBytes(join(root, 'actual.bin')), /regular/);
  await mkdir(join(root, 'directory'));
  await assert.rejects(readUploadBytes(join(root, 'directory')), /regular/);
  await writeFile(join(root, 'large.bin'), Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(readUploadBytes(join(root, 'large.bin')), /8 MiB/);
  await writeFile(join(root, 'empty.bin'), Buffer.alloc(0));
  assert.equal((await readUploadBytes(join(root, 'empty.bin'))).length, 0);
});

test('artifact download writes and hashes real bytes exclusively without trusting server filenames', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pm-cli-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from([255, 0, 11, 42, 13]);
  const output = join(root, 'chosen.bin');
  const saved = await saveArtifactDownload(new Response(bytes, { headers: { 'content-disposition': 'attachment; filename="../wrong.bin"' } }), output, { size: bytes.length, sha256: digest(bytes) });
  assert.deepEqual(saved, { path: output, size: bytes.length, sha256: digest(bytes) });
  assert.deepEqual(await readFile(output), bytes);
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  await assert.rejects(saveArtifactDownload(new Response('overwrite'), output, { size: 9, sha256: digest(Buffer.from('overwrite')) }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(output), bytes);
  await symlink('chosen.bin', join(root, 'linked.bin'));
  await assert.rejects(saveArtifactDownload(new Response(bytes), join(root, 'linked.bin'), { size: bytes.length, sha256: digest(bytes) }));
  assert.deepEqual(await readFile(output), bytes);
  await symlink(root, join(root, 'linked-directory'));
  await assert.rejects(saveArtifactDownload(new Response(bytes), join(root, 'linked-directory', 'new.bin'), { size: bytes.length, sha256: digest(bytes) }), /ancestors/);
});

test('interrupted, oversized, truncated and corrupt downloads remove only their new partial output and release streams', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pm-cli-interrupted-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('complete bytes');
  for (const [name, response] of [
    ['short.bin', new Response(bytes.subarray(0, 3))],
    ['long.bin', new Response(Buffer.concat([bytes, Buffer.from('!')]))],
    ['corrupt.bin', new Response(Buffer.alloc(bytes.length, 42))],
    ['interrupted.bin', new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.subarray(0, 3)); }, pull(controller) { controller.error(new Error('interrupted transport')); } }))],
  ] as const) {
    await assert.rejects(saveArtifactDownload(response, join(root, name), { size: bytes.length, sha256: digest(bytes) }));
    await assert.rejects(lstat(join(root, name)), { code: 'ENOENT' });
    assert.equal(response.body?.locked, false);
  }
  let cancelled = false;
  const rejected = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
  await assert.rejects(saveArtifactDownload(rejected, join(root, 'invalid.bin'), { size: 8 * 1024 * 1024 + 1, sha256: digest(bytes) }));
  assert.equal(cancelled, true);
  assert.equal(rejected.body?.locked, false);
});

test('family ignores other prefixes and rejects unsupported inputs before authentication or request dispatch', async () => {
  const forbidden = () => { throw new Error('Unexpected service access'); };
  const runtime: CliRuntime = { authentication: forbidden, connection: forbidden, json: forbidden, response: forbidden, print: forbidden };
  assert.equal(await documentsFilesFamily.dispatch(['file', 'DOC-1'], runtime), false);
  await assert.rejects(documentsFilesFamily.dispatch(['upload', 'stage', '--project', 'PRJ-1', '--file', '/not-read', '--media-type', 'text/plain', '--request-id', 'not-a-uuid'], runtime));
  await assert.rejects(documentsFilesFamily.dispatch(['sources', 'list', '--endpoint', '/commands'], runtime), /unsupported/);
  await assert.rejects(documentsFilesFamily.dispatch(['artifact', 'download', 'not-a-uuid', '--output', 'not-created'], runtime));
});
