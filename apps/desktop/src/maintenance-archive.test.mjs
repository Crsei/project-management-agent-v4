import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertBackupCompatibility, decryptBackupDirectory, encryptedPayloadLength, encryptBackupDirectory, validateBackupPassword, withPrivateMaintenanceDirectory } from './maintenance-archive.mjs';
import { backupDesktop, restoreDesktop } from './maintenance.mjs';
import { ensurePrivateDirectory } from './private-state.mjs';

const password = 'a strong independent backup password';
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-encrypted-backup-test-')));
  await ensurePrivateDirectory(root, { newlyCreated: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(source, { mode: 0o700 });
  await mkdir(join(source, 'empty'), { mode: 0o700 });
  await mkdir(join(source, 'nested'), { mode: 0o700 });
  await writeFile(join(source, 'nested', 'private.json'), 'synthetic-private-credential-and-conversation', { mode: 0o600 });
  await writeFile(join(source, 'nested', 'binary'), Buffer.from([0, 255, 128, 4]), { mode: 0o600 });
  return { root, source, archive: join(root, 'encrypted'), target: join(root, 'restored') };
}
const absent = path => assert.rejects(lstat(path), { code: 'ENOENT' });

test('container size boundary includes authenticated framing without reducing the 32 GiB payload ceiling', () => {
  const maximumPayload = 32 * 1024 ** 3;
  const overhead = Buffer.byteLength('DOVSPACE-BACKUP\0') + 4 + 16;
  for (const header of [1, 300, 16 * 1024]) {
    assert.equal(encryptedPayloadLength(maximumPayload + header + overhead, header), maximumPayload);
    assert.equal(encryptedPayloadLength(1 + header + overhead, header), 1);
    assert.throws(() => encryptedPayloadLength(maximumPayload + header + overhead + 1, header));
    assert.throws(() => encryptedPayloadLength(header + overhead, header));
  }
  for (const header of [0, -1, 16 * 1024 + 1, NaN]) assert.throws(() => encryptedPayloadLength(1000, header));
});

// Independently construct a correctly authenticated but malicious payload. This tests
// parser confinement, not only the much earlier authentication-failure branch.
function authenticatedPayload(records) {
  const salt = randomBytes(32), nonce = randomBytes(12), magic = Buffer.from('DOVSPACE-BACKUP\0');
  const kdf = { name: 'scrypt', N: 131072, r: 8, p: 1 };
  const header = Buffer.from(JSON.stringify({ format: 'dovspace-encrypted-backup', version: 1, cipher: 'aes-256-gcm', kdf, salt: salt.toString('hex'), nonce: nonce.toString('hex') }));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  const aad = Buffer.concat([magic, length, header]);
  const payload = Buffer.concat(records.map(value => { const body = Buffer.from(JSON.stringify(value)); const size = Buffer.alloc(4); size.writeUInt32BE(body.length); return Buffer.concat([size, body]); }));
  const key = scryptSync(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 ** 2 });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
    return Buffer.concat([aad, cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  } finally { key.fill(0); }
}

test('encrypted container roundtrip retains binary bytes and empty directories without plaintext or password', async t => {
  const f = await fixture(t);
  await encryptBackupDirectory(f.source, f.archive, password);
  const bytes = await readFile(f.archive);
  assert.equal(bytes.includes(Buffer.from(password)), false);
  assert.equal(bytes.includes(Buffer.from('synthetic-private-credential-and-conversation')), false);
  await decryptBackupDirectory(f.archive, f.target, password);
  assert.equal(await readFile(join(f.target, 'nested/private.json'), 'utf8'), 'synthetic-private-credential-and-conversation');
  assert.deepEqual(await readFile(join(f.target, 'nested/binary')), Buffer.from([0, 255, 128, 4]));
  assert.deepEqual(await readdir(join(f.target, 'empty')), []);
  if (process.platform !== 'win32') assert.equal((await lstat(f.archive)).mode & 0o077, 0);
  const other = join(f.root, 'another'); await encryptBackupDirectory(f.source, other, password);
  assert.notDeepEqual(await readFile(other), bytes, 'fresh salt and nonce must randomize identical snapshots');
});

test('wrong password, altered header/ciphertext/tag, truncation and excessive KDF are rejected before extraction', async t => {
  const f = await fixture(t); await encryptBackupDirectory(f.source, f.archive, password);
  const original = await readFile(f.archive);
  await assert.rejects(decryptBackupDirectory(f.archive, f.target, 'wrong password'));
  await absent(f.target);
  const headerLength = original.readUInt32BE(16);
  for (const position of [0, 25, 20 + headerLength + 5, original.length - 1]) {
    const tampered = Buffer.from(original); tampered[position] ^= 1;
    await writeFile(f.archive, tampered);
    await assert.rejects(decryptBackupDirectory(f.archive, f.target, password));
    await absent(f.target);
  }
  for (const bytes of [original.subarray(0, 12), original.subarray(0, original.length - 10), Buffer.from(original.toString('latin1').replace('131072', '999999'), 'latin1')]) {
    await writeFile(f.archive, bytes);
    await assert.rejects(decryptBackupDirectory(f.archive, f.target, password)); await absent(f.target);
  }
});

test('authenticated traversal, duplicate, case-collision and trailing records cannot create an initialized target', async t => {
  const f = await fixture(t);
  for (const entries of [
    [{ type: 'file', path: '../escape', size: 0 }],
    [{ type: 'file', path: 'CONIN$', size: 0 }],
    [{ type: 'file', path: 'COM¹.txt', size: 0 }],
    [{ type: 'directory', path: 'a' }, { type: 'directory', path: 'a' }],
    [{ type: 'directory', path: 'A' }, { type: 'directory', path: 'a' }],
    [{ type: 'directory', path: 'é' }, { type: 'directory', path: 'e\u0301' }],
    [{ type: 'file', path: 'missing/child', size: 0 }],
    [{ type: 'end' }, { type: 'directory', path: 'ignored' }],
  ]) {
    await writeFile(f.archive, authenticatedPayload([{ type: 'archive', version: 1 }, ...entries, { type: 'end' }]));
    await assert.rejects(decryptBackupDirectory(f.archive, f.target, password));
    await absent(f.target); await absent(join(f.root, 'escape'));
  }
});

test('encryption and decryption refuse overwrite and reject hardlinks without deleting existing data', async t => {
  const f = await fixture(t); await encryptBackupDirectory(f.source, f.archive, password);
  const original = await readFile(f.archive);
  await assert.rejects(encryptBackupDirectory(f.source, f.archive, password), { code: 'EEXIST' });
  assert.deepEqual(await readFile(f.archive), original);
  await mkdir(f.target); await writeFile(join(f.target, 'keep'), 'existing');
  await assert.rejects(decryptBackupDirectory(f.archive, f.target, password));
  assert.equal(await readFile(join(f.target, 'keep'), 'utf8'), 'existing');
  await link(join(f.source, 'nested/private.json'), join(f.source, 'hardlink'));
  const rejected = join(f.root, 'rejected');
  await assert.rejects(encryptBackupDirectory(f.source, rejected, password)); await absent(rejected);
});

test('private plaintext staging is removed on success and failure', async () => {
  let root;
  await withPrivateMaintenanceDirectory(async path => { root = path; await writeFile(join(path, 'plaintext'), 'private', { mode: 0o600 }); });
  await absent(root);
  await assert.rejects(withPrivateMaintenanceDirectory(async path => { root = path; throw new Error('synthetic failure'); }));
  await absent(root);
});

test('format, database, OS and application-version compatibility fail closed rather than discard data', () => {
  const manifest = { format: 'pm-agent-desktop-backup', version: 2, postgresMajor: 16, platform: process.platform, applicationVersion: '0.1.0' };
  assert.doesNotThrow(() => assertBackupCompatibility(manifest, '0.1.0'));
  assert.throws(() => assertBackupCompatibility({ ...manifest, version: 3 }, '0.1.0'));
  assert.throws(() => assertBackupCompatibility({ ...manifest, postgresMajor: 17 }, '0.1.0'));
  assert.throws(() => assertBackupCompatibility(manifest, '0.2.0'));
  assert.throws(() => assertBackupCompatibility({ ...manifest, applicationVersion: undefined }, '0.1.0'));
  assert.throws(() => assertBackupCompatibility(manifest, '0.1.0', process.platform === 'win32' ? 'darwin' : 'win32'));
  for (const value of ['', 'short', 'x'.repeat(1025), null]) assert.throws(() => validateBackupPassword(value, true));
});

test('actual restore entry rejects wrong password and legacy default without initializing even an empty target', async t => {
  const f = await fixture(t);
  const backup = join(f.root, 'backup'); await mkdir(backup);
  await encryptBackupDirectory(f.source, join(backup, 'desktop-backup.enc'), password);
  await mkdir(f.target);
  const options = { serverRoot: f.root, runtimeRoot: f.root, source: backup, dataDir: f.target, password: 'incorrect', trustedSourceAcknowledged: true };
  for (const trustedSourceAcknowledged of [undefined, false, 'true', 1]) {
    await assert.rejects(restoreDesktop({ ...options, password, trustedSourceAcknowledged }), { code: 'DESKTOP_RESTORE_TRUST_REQUIRED' });
    assert.deepEqual(await readdir(f.target), []);
  }
  const absentTarget = join(f.root, 'unacknowledged-target');
  await assert.rejects(restoreDesktop({ ...options, dataDir: absentTarget, password, trustedSourceAcknowledged: false }), { code: 'DESKTOP_RESTORE_TRUST_REQUIRED' });
  await absent(absentTarget);
  await assert.rejects(restoreDesktop(options));
  assert.deepEqual(await readdir(f.target), []);
  await assert.rejects(restoreDesktop({ ...options, source: f.source }));
  assert.deepEqual(await readdir(f.target), []);
  await assert.rejects(backupDesktop({ ...options, dataDir: f.source, destination: join(f.root, 'new-backup'), password: '' }));
  await absent(join(f.root, 'new-backup'));
});
