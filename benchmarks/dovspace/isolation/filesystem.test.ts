import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSocketDirectory, readRootedFile, writeRootedFile } from './filesystem.ts';

test('host materialization refuses leaf and ancestor links without truncating authority', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-rooted-'));
  try {
    await mkdir(path.join(root, 'public')); await mkdir(path.join(root, 'private'));
    const marker = path.join(root, 'private/ownership.json'); await writeFile(marker, 'owned-marker');
    await symlink(marker, path.join(root, 'public/decision.md'));
    await assert.rejects(writeRootedFile(path.join(root, 'public'), 'decision.md', 'corruption'));
    await assert.rejects(readRootedFile(path.join(root, 'public'), 'decision.md'));
    assert.equal(await readFile(marker, 'utf8'), 'owned-marker');
    await symlink(path.join(root, 'private'), path.join(root, 'public/docs'));
    await assert.rejects(writeRootedFile(path.join(root, 'public'), 'docs/ownership.json', 'corruption', { createParents: true }));
    assert.equal(await readFile(marker, 'utf8'), 'owned-marker');
    await link(marker, path.join(root, 'public/hardlink'));
    await assert.rejects(writeRootedFile(path.join(root, 'public'), 'hardlink', 'corruption'), /links/);
    assert.equal(await readFile(marker, 'utf8'), 'owned-marker');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('rooted files support explicit nested materialization and reject traversal, overwrite and oversized reads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-rooted-'));
  try {
    await writeRootedFile(root, 'knowledge/current.json', '{"fictional":true}', { createParents: true, exclusive: true });
    assert.equal(await readRootedFile(root, 'knowledge/current.json'), '{"fictional":true}');
    await assert.rejects(writeRootedFile(root, 'knowledge/current.json', 'overwrite', { exclusive: true }), { code: 'EEXIST' });
    await assert.rejects(writeRootedFile(root, '../escape', 'outside'), /traversal/);
    await assert.rejects(writeRootedFile(root, '/absolute', 'outside'), /relative/);
    await assert.rejects(readRootedFile(root, 'knowledge/current.json', 4), /oversized/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('private Unix sockets bind and connect beneath paths exceeding the AF_UNIX pathname limit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-long-socket-'));
  const directory = path.join(root, 'private-checkout-'.repeat(9));
  await mkdir(directory, { mode: 0o700 });
  const sockets = await openSocketDirectory(directory);
  const server = createServer((_incoming, outgoing) => outgoing.end('private-response'));
  try {
    assert.ok(Buffer.byteLength(path.join(directory, 'host.sock')) > 108);
    assert.ok(Buffer.byteLength(sockets.socketPath('host.sock')) < 108);
    const ready = Promise.withResolvers<void>();
    server.once('error', ready.reject);
    server.listen(sockets.socketPath('host.sock'), () => ready.resolve());
    await ready.promise;
    const response = Promise.withResolvers<string>();
    const client = request({ socketPath: sockets.socketPath('host.sock'), path: '/' }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.once('end', () => response.resolve(Buffer.concat(chunks).toString('utf8')));
    });
    client.once('error', response.reject); client.end();
    assert.equal(await response.promise, 'private-response');
    assert.throws(() => sockets.socketPath('../escape.sock'), /Invalid/);
  } finally {
    const ending = Promise.withResolvers<void>();
    server.close(() => ending.resolve()); server.closeAllConnections();
    await ending.promise;
    await sockets.close();
    await rm(root, { recursive: true, force: true });
  }
});
