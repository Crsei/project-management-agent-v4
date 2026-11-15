import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { encode, sha256 } from './io.mjs';
import { lock } from './supplemental-fs.mjs';
import { applyTransaction } from './supplemental-transaction.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supplemental-transaction-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate'), control = path.join(root, 'control');
  await fs.mkdir(candidate); await fs.mkdir(control);
  const preparedState = { status: 'prepared', exactApproval: 'immutable fixture data' }, nextState = { ...preparedState, status: 'recorded' };
  await fs.writeFile(path.join(control, 'state.json'), encode(preparedState));
  const preimages = new Map(), plannedFiles = [];
  for (const name of ['a.json', 'b.json']) {
    const before = Buffer.from(`before ${name}\n`), content = Buffer.from(`after ${name}\n`);
    await fs.writeFile(path.join(candidate, name), before);
    preimages.set(name, { bytes: before, mode: 0o644 });
    plannedFiles.push({ path: name, content, sha256: sha256(content), bytes: content.length, mode: 0o644 });
  }
  const validate = async () => {};
  return { root, candidate, control, preparedState, nextState, preimages, plannedFiles, validate, inputReceipt: sha256(encode(preparedState)) };
}

test('partial publication retains exact pre/post journal and resumes only its own bytes with the original receipt', async t => {
  const f = await fixture(t), rename = fs.rename;
  const failure = t.mock.method(fs, 'rename', async (from, to) => {
    if (String(from).endsWith('/b.json') && String(to).endsWith('/original')) throw Object.assign(new Error('injected second publication failure'), { code: 'EIO' });
    return rename(from, to);
  });
  await assert.rejects(applyTransaction(f), /SUPPLEMENTAL_TRANSACTION_PENDING:.*writtenThisAttempt=\["a.json"\]/);
  assert.equal(await fs.readFile(path.join(f.candidate, 'a.json'), 'utf8'), 'after a.json\n');
  assert.equal(await fs.readFile(path.join(f.candidate, 'b.json'), 'utf8'), 'before b.json\n');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.control, 'state.json'))), f.preparedState);
  const journal = JSON.parse(await fs.readFile(path.join(f.control, 'transaction/manifest.json')));
  assert.equal(journal.inputReceipt, f.inputReceipt);
  assert.equal(journal.files.length, 2);
  failure.mock.restore();
  const resumed = await applyTransaction(f);
  assert.equal(resumed.controlSha256, sha256(encode(f.nextState)));
  assert.deepEqual(resumed.writtenPaths, ['b.json']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.control, 'state.json'))), f.nextState);
  assert.deepEqual((await applyTransaction(f)).writtenPaths, [], 'Lost-response retry with the original receipt does not blindly overwrite outputs');
});

test('concurrent third bytes or staged tampering are never overwritten by recovery', async t => {
  const f = await fixture(t);
  f.validate = async phase => { if (phase === 'after') throw new Error('injected stale reviewed runtime'); };
  await assert.rejects(applyTransaction(f), /SUPPLEMENTAL_TRANSACTION_PENDING/);
  await fs.writeFile(path.join(f.candidate, 'b.json'), 'concurrent user bytes\n');
  f.validate = async () => {};
  await assert.rejects(applyTransaction(f), /CONCURRENT_SUPPLEMENTAL_WRITE: b.json/);
  assert.equal(await fs.readFile(path.join(f.candidate, 'b.json'), 'utf8'), 'concurrent user bytes\n');
  await fs.writeFile(path.join(f.control, 'transaction/post-0'), 'tampered stage\n');
  await assert.rejects(applyTransaction(f), /STALE_SUPPLEMENTAL_STAGE/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.control, 'state.json'))), f.preparedState);
});

test('external lock rejects simultaneous writers and never auto-clears another owner', async t => {
  const f = await fixture(t), release = await lock(f.control);
  await assert.rejects(lock(f.control), /SUPPLEMENTAL_RECORD_LOCKED/);
  await release();
  const next = await lock(f.control);
  await next();
});

test('interruption after leaf displacement requires fresh reconstruction and preserves backup plus temp inodes', async t => {
  const f = await fixture(t), backup = path.join(f.candidate, '.supplemental-preserved-interrupted');
  await fs.mkdir(backup);
  await fs.rename(path.join(f.candidate, 'a.json'), path.join(backup, 'original'));
  const temporary = path.join(f.candidate, '.supplemental-interrupted');
  await fs.writeFile(temporary, f.plannedFiles[0].content);
  const originalInode = (await fs.lstat(path.join(backup, 'original'))).ino, temporaryInode = (await fs.lstat(temporary)).ino;
  await assert.rejects(applyTransaction(f), error => error.code === 'SUPPLEMENTAL_RECONSTRUCTION_REQUIRED' && error.details.recovery === 'fresh-candidate-and-control-required');
  await assert.rejects(fs.lstat(path.join(f.candidate, 'a.json')), { code: 'ENOENT' });
  assert.equal((await fs.lstat(path.join(backup, 'original'))).ino, originalInode);
  assert.equal((await fs.lstat(temporary)).ino, temporaryInode);
  assert.equal(await fs.readFile(path.join(backup, 'original'), 'utf8'), 'before a.json\n');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.control, 'state.json'))), f.preparedState);
});

test('interruption after no-replace link refuses nlink residue without unlinking either name', async t => {
  const f = await fixture(t), backup = path.join(f.candidate, '.supplemental-preserved-interrupted');
  await fs.mkdir(backup);
  await fs.rename(path.join(f.candidate, 'a.json'), path.join(backup, 'original'));
  const temporary = path.join(f.candidate, '.supplemental-interrupted');
  await fs.writeFile(temporary, f.plannedFiles[0].content);
  await fs.link(temporary, path.join(f.candidate, 'a.json'));
  const inode = (await fs.lstat(temporary)).ino;
  await assert.rejects(applyTransaction(f), error => error.code === 'SUPPLEMENTAL_RECONSTRUCTION_REQUIRED');
  assert.equal((await fs.lstat(temporary)).ino, inode);
  assert.equal((await fs.lstat(path.join(f.candidate, 'a.json'))).ino, inode);
  assert.equal((await fs.lstat(temporary)).nlink, 2);
  assert.equal(await fs.readFile(path.join(backup, 'original'), 'utf8'), 'before a.json\n');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.control, 'state.json'))), f.preparedState);
});

test('an extra preserved backup disqualifies otherwise recognizable pre/post metadata from same-receipt retry', async t => {
  const f = await fixture(t), backup = path.join(f.candidate, '.supplemental-preserved-interrupted');
  await fs.mkdir(backup);
  await fs.rename(path.join(f.candidate, 'a.json'), path.join(backup, 'original'));
  await fs.writeFile(path.join(f.candidate, 'a.json'), f.plannedFiles[0].content);
  f.validate = async () => {
    const extra = (await fs.readdir(f.candidate)).find(name => !['a.json', 'b.json'].includes(name));
    if (extra) throw new Error(`UNAPPROVED_SNAPSHOT_CHANGE: ${extra}`);
  };
  await assert.rejects(applyTransaction(f), error => error.code === 'SUPPLEMENTAL_RECONSTRUCTION_REQUIRED');
  assert.equal(await fs.readFile(path.join(f.candidate, 'a.json'), 'utf8'), 'after a.json\n');
  assert.equal(await fs.readFile(path.join(backup, 'original'), 'utf8'), 'before a.json\n');
  assert.equal(await fs.readFile(path.join(f.candidate, 'b.json'), 'utf8'), 'before b.json\n');
});
