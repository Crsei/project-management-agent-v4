import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareReportDirectory, readReportJson, writeReportFile } from './files.ts';

test('report publication refuses ancestor symlinks and existing experiment directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dovspace-report-boundary-'));
  try {
    const real = join(root, 'real');
    await mkdir(real);
    await symlink(real, join(root, 'redirect'));
    await assert.rejects(prepareReportDirectory(join(root, 'redirect', 'child')), /symlink|redirected/);
    assert.deepEqual(await readdir(real), []);
    await prepareReportDirectory(join(real, 'experiment'), true);
    await assert.rejects(prepareReportDirectory(join(real, 'experiment'), true), /already exists/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('report writes refuse symlink and hard-link destinations without modifying their targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dovspace-report-write-'));
  try {
    const target = join(root, 'protected.json');
    await writeFile(target, 'unchanged');
    const symbolic = join(root, 'symbolic.json');
    await symlink(target, symbolic);
    await assert.rejects(writeReportFile(symbolic, 'incorrect'), /single-link/);
    assert.equal(await readFile(target, 'utf8'), 'unchanged');
    await rm(symbolic);
    const hard = join(root, 'hard.json');
    await link(target, hard);
    await assert.rejects(writeReportFile(hard, 'incorrect'), /single-link/);
    assert.equal(await readFile(target, 'utf8'), 'unchanged');
    await writeReportFile(join(root, 'report.md'), 'first');
    await writeReportFile(join(root, 'report.md'), 'second');
    assert.equal(await readFile(join(root, 'report.md'), 'utf8'), 'second');
    assert.equal((await readdir(root)).some((name) => name.startsWith('.report-')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('report input refuses file links and withholds malformed JSON content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dovspace-report-read-'));
  try {
    const input = join(root, 'result.json');
    await writeFile(input, '{"model":"not-an-executed-model"}');
    assert.deepEqual(await readReportJson(input), { model: 'not-an-executed-model' });
    await symlink(input, join(root, 'linked.json'));
    await assert.rejects(readReportJson(join(root, 'linked.json')));
    await writeFile(input, '{"private":"do-not-print-this"');
    await assert.rejects(readReportJson(input), (error: unknown) => error instanceof Error && /input withheld/.test(error.message) && !error.message.includes('do-not-print-this'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
