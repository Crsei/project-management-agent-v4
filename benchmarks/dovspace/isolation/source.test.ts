import test from 'node:test';
import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { approveSourceStage, collectSourceManifest, stageProductSource } from './source.ts';

test('only explicitly verified source manifests can stage a treatment; mutations and source symlinks fail closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-source-stage-'));
  try {
    for (const directory of ['apps/server/pm/src', 'apps/desktop/src', 'packages/application/src', 'vendor/provider/src']) await mkdir(path.join(root, directory), { recursive: true });
    for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json', 'apps/desktop/src/private-state.mjs']) await writeFile(path.join(root, name), name);
    const code = path.join(root, 'packages/application/src/tool.ts'); await writeFile(code, 'export const version = 1;\n');
    await writeFile(path.join(root, 'packages/application/.env'), 'must never be staged');
    await mkdir(path.join(root, 'packages/application/dist')); await writeFile(path.join(root, 'packages/application/dist/old.js'), 'stale build excluded');
    const manifest = await collectSourceManifest(root);
    assert.ok(manifest.files.some(entry => entry.path === 'packages/application/src/tool.ts'));
    assert.ok(manifest.files.every(entry => !entry.path.includes('.env') && !entry.path.includes('/dist/')));
    await assert.rejects(stageProductSource(path.join(root, 'unapproved'), { root, manifest }), /has not passed/);
    const approved = await approveSourceStage(root, manifest);
    await writeFile(code, 'export const version = 2;\n');
    await assert.rejects(stageProductSource(path.join(root, 'changed'), approved), /changed before staging/);
    await assert.rejects(approveSourceStage(root, manifest), /does not match/);
    await symlink('/etc/passwd', path.join(root, 'vendor/provider/src/escape.ts'));
    await assert.rejects(collectSourceManifest(root), /symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pnpm-style hardlinked public product input becomes an independent read-only stage with unchanged approved bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-hardlinked-product-'));
  try {
    for (const directory of ['apps/server/pm/src', 'apps/desktop/src', 'packages/application/src', 'vendor/provider/src']) await mkdir(path.join(root, directory), { recursive: true });
    for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json', 'apps/desktop/src/private-state.mjs']) await writeFile(path.join(root, name), name);
    const relative = 'vendor/provider/src/public.d.ts', source = path.join(root, relative), injectedLink = path.join(root, 'pnpm-injection-link.d.ts');
    const original = 'export declare const publicValue: 1;\n';
    await writeFile(source, original);
    await link(source, injectedLink);
    assert.equal((await lstat(source)).nlink, 2);
    const manifest = await collectSourceManifest(root), approved = await approveSourceStage(root, manifest);
    const staged = await stageProductSource(path.join(root, 'independent-stage'), approved);
    const output = path.join(staged.root, relative), before = await lstat(source), after = await lstat(output);
    assert.deepEqual(staged.manifest, manifest);
    assert.equal(await readFile(output, 'utf8'), original);
    assert.equal(after.nlink, 1);
    assert.ok(before.dev !== after.dev || before.ino !== after.ino, 'Copy must break the injected source inode relationship');
    assert.equal(after.mode & 0o777, 0o400);
    assert.equal((await lstat(staged.root)).mode & 0o777, 0o700);
    await writeFile(injectedLink, 'export declare const publicValue: 2;\n');
    assert.equal(await readFile(output, 'utf8'), original, 'Later source-link writes cannot mutate the immutable product stage');
    assert.deepEqual(await collectSourceManifest(staged.root), manifest);
  } finally { await rm(root, { recursive: true, force: true }); }
});
