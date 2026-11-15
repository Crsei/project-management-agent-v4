import assert from 'node:assert/strict';
import nativeFs, { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { sha256 } from './io.mjs';
import { exists, file, publish, walk } from './supplemental-fs.mjs';
import { snapshotRetiredResolver } from './supplemental-retirements.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supplemental-descriptor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate'), outside = path.join(root, 'outside');
  await fs.mkdir(candidate); await fs.mkdir(outside);
  return { root, candidate, outside };
}

test('a leaf swapped to an external symlink after lstat is never opened for content', async t => {
  const f = await fixture(t), leaf = path.join(f.candidate, 'leaf.txt'), secret = path.join(f.outside, 'private.txt');
  await fs.writeFile(leaf, 'approved input\n'); await fs.writeFile(secret, 'external private fixture bytes\n');
  const open = fs.open;
  let swapped = false, noFollow = false;
  t.mock.method(fs, 'open', async (target, flags, ...rest) => {
    if (!swapped && String(target).endsWith('/leaf.txt')) {
      swapped = true; noFollow = Boolean(flags & constants.O_NOFOLLOW);
      await fs.rename(leaf, path.join(f.candidate, 'preserved.txt'));
      await fs.symlink(secret, leaf);
    }
    return open(target, flags, ...rest);
  });
  await assert.rejects(file(f.candidate, 'leaf.txt'), error => ['ELOOP', 'EMLINK'].includes(error.code));
  assert.equal(swapped, true);
  assert.equal(noFollow, true, 'The raced symlink is refused by the actual open, before any content read');
});

test('a parent swapped before temporary creation cannot redirect the writer outside its held directory', async t => {
  const f = await fixture(t), parent = path.join(f.candidate, 'nested'), held = path.join(f.candidate, 'held-original');
  await fs.mkdir(parent);
  const before = Buffer.from('approved preimage\n');
  await fs.writeFile(path.join(parent, 'item.json'), before);
  await fs.writeFile(path.join(f.outside, 'item.json'), 'external bytes must remain\n');
  const open = fs.open;
  let swapped = false;
  t.mock.method(fs, 'open', async (target, flags, ...rest) => {
    if (!swapped && String(target).includes('/.supplemental-')) {
      swapped = true;
      await fs.rename(parent, held);
      await fs.symlink(f.outside, parent);
    }
    return open(target, flags, ...rest);
  });
  await publish(f.candidate, 'nested/item.json', Buffer.from('transaction postimage\n'), 0o644, { expected: { sha256: sha256(before), bytes: before.length, mode: 0o644 } });
  assert.equal(swapped, true);
  assert.equal(await fs.readFile(path.join(f.outside, 'item.json'), 'utf8'), 'external bytes must remain\n');
  assert.deepEqual(await fs.readdir(f.outside), ['item.json'], 'No temporary file is created through the replaced pathname');
  assert.equal(await fs.readFile(path.join(held, 'item.json'), 'utf8'), 'transaction postimage\n');
  await assert.rejects(file(f.candidate, 'nested/item.json'), error => ['ENOTDIR', 'ELOOP'].includes(error.code));
});

test('ordinary supplemental reads retain the nlink=1 contract', async t => {
  const f = await fixture(t), original = path.join(f.outside, 'original.txt');
  await fs.writeFile(original, 'read-only fixture\n');
  await fs.link(original, path.join(f.candidate, 'linked.txt'));
  await assert.rejects(file(f.candidate, 'linked.txt'), /UNSAFE_PATH/);
});

test('retirement resolution uses captured config bytes and cannot re-open a raced external config symlink', async t => {
  const f = await fixture(t), ts = createRequire(import.meta.url)('typescript');
  await fs.mkdir(path.join(f.candidate, 'src'));
  await fs.writeFile(path.join(f.candidate, 'src/current.ts'), 'export {};\n');
  const config = path.join(f.candidate, 'tsconfig.json'), outside = path.join(f.outside, 'private-config.json');
  await fs.writeFile(config, JSON.stringify({ compilerOptions: { paths: { 'retired-alias': ['./src/deleted.ts'] }, moduleResolution: 'Bundler', module: 'ESNext' }, include: ['src/**/*.ts'] }));
  await fs.writeFile(outside, 'PRIVATE_CONFIG_FIXTURE_MUST_NOT_BE_READ');
  const resolve = await snapshotRetiredResolver(f.candidate, [{ destination: 'src/deleted.ts' }], ts);
  await fs.rename(config, path.join(f.candidate, 'preserved-config.json'));
  await fs.symlink(outside, config);
  const readFileSync = nativeFs.readFileSync;
  let reopened = false;
  t.mock.method(nativeFs, 'readFileSync', (name, ...options) => {
    if (String(name) === config || String(name) === outside) reopened = true;
    return readFileSync(name, ...options);
  });
  assert.equal(resolve('src/current.ts', 'retired-alias'), 'src/deleted.ts');
  assert.equal(reopened, false);
});

test('directory probes accept contained normalized root/trailing forms without relaxing ledger file paths', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.candidate, 'nested'));
  assert.equal(await exists(f.candidate, './'), true);
  assert.equal(await exists(f.candidate, 'nested/'), true);
  assert.equal(await exists(f.candidate, 'nested/../'), true);
  assert.equal(await exists(f.candidate, 'missing/'), false);
  await assert.rejects(exists(f.candidate, '../outside/'), /UNSAFE_PATH/);
  await assert.rejects(exists(f.candidate, '/absolute/'), /UNSAFE_PATH/);
  await assert.rejects(file(f.candidate, 'nested/'), /UNSAFE_PATH/);
  await assert.rejects(publish(f.candidate, 'nested/', Buffer.from('forbidden')), /UNSAFE_PATH/);
});

test('third bytes arriving after the last check are authenticated after displacement and restored, never overwritten', async t => {
  const f = await fixture(t), leaf = path.join(f.candidate, 'item.json'), before = Buffer.from('approved preimage\n');
  await fs.writeFile(leaf, before);
  const rename = fs.rename;
  let raced = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!raced && String(from).endsWith('/item.json') && String(to).endsWith('/original')) {
      raced = true;
      await fs.writeFile(leaf, 'concurrent user bytes\n');
    }
    return rename(from, to);
  });
  await assert.rejects(publish(f.candidate, 'item.json', Buffer.from('reviewed postimage\n'), 0o644, { expected: { sha256: sha256(before), bytes: before.length, mode: 0o644 } }), /unexpected displaced bytes.*restored exclusively/);
  assert.equal(raced, true);
  assert.equal(await fs.readFile(leaf, 'utf8'), 'concurrent user bytes\n');
  assert.deepEqual(await fs.readdir(f.candidate), ['item.json']);
});

test('a destination created after displacement wins no-replace publication while the original inode is retained', async t => {
  const f = await fixture(t), leaf = path.join(f.candidate, 'item.json'), before = Buffer.from('approved preimage\n');
  await fs.writeFile(leaf, before);
  const rename = fs.rename;
  let raced = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    const result = await rename(from, to);
    if (!raced && String(from).endsWith('/item.json') && String(to).endsWith('/original')) {
      raced = true;
      await fs.writeFile(leaf, 'new concurrent destination\n');
    }
    return result;
  });
  await assert.rejects(publish(f.candidate, 'item.json', Buffer.from('reviewed postimage\n'), 0o644, { expected: { sha256: sha256(before), bytes: before.length, mode: 0o644 } }), /preexisting inode preserved at .*supplemental-preserved-.*current destination not overwritten/);
  assert.equal(await fs.readFile(leaf, 'utf8'), 'new concurrent destination\n');
  const directory = (await fs.readdir(f.candidate)).find(name => name.startsWith('.supplemental-preserved-'));
  assert.ok(directory);
  assert.equal(await fs.readFile(path.join(f.candidate, directory, 'original'), 'utf8'), before.toString());
});

test('root and prefixed traversal use held descriptors without allowing candidate directory symlinks', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.candidate, 'nested'));
  await fs.writeFile(path.join(f.candidate, 'root.txt'), 'root fixture\n');
  await fs.writeFile(path.join(f.candidate, 'nested/child.txt'), 'child fixture\n');
  assert.deepEqual(await walk(f.candidate), ['nested/child.txt', 'root.txt']);
  assert.deepEqual(await walk(f.candidate, 'nested'), ['nested/child.txt']);
  await fs.rename(path.join(f.candidate, 'nested'), path.join(f.candidate, 'preserved'));
  await fs.symlink(f.outside, path.join(f.candidate, 'nested'));
  await assert.rejects(walk(f.candidate), /UNSAFE_PATH/);
  assert.deepEqual(await fs.readdir(f.outside), []);
});
