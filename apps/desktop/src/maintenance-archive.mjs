import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { assertPrivatePath, ensurePrivateDirectory, securePrivateFile } from './private-state.mjs';

export const encryptedBackupFilename = 'desktop-backup.enc';
const magic = Buffer.from('DOVSPACE-BACKUP\0', 'ascii');
const derive = promisify(scrypt);
const kdf = Object.freeze({ name: 'scrypt', N: 131072, r: 8, p: 1 });
const maximumBytes = 32 * 1024 ** 3; // Below AES-GCM's per-message limit; disk use is bounded too.
const maximumEntries = 200_000;
const maximumMetadata = 16 * 1024;
const containerOverhead = magic.length + 4 + 16;
const maximumContainerBytes = maximumBytes + maximumMetadata + containerOverhead;
const invalid = () => new Error('Backup is malformed, damaged, or the password is incorrect. No existing instance was overwritten.');
const noFollow = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export function validateBackupPassword(password, creating = false) {
  if (typeof password !== 'string' || password.length < (creating ? 12 : 1) || password.length > 1024 || Buffer.byteLength(password) > 4096)
    throw new Error(creating ? 'Use a backup password of 12 to 1024 characters.' : 'Enter the backup password (at most 1024 characters).');
}
/** Container bounds include framing/tag overhead; they are not plaintext bounds. */
export function encryptedPayloadLength(containerSize, headerSize) {
  if (!Number.isSafeInteger(containerSize) || !Number.isSafeInteger(headerSize) || headerSize < 1 || headerSize > maximumMetadata) throw invalid();
  const length = containerSize - headerSize - containerOverhead;
  if (length < 1 || length > maximumBytes) throw invalid();
  return length;
}
/** Password possession authenticates bytes, not the author of executable SQL. */
export function requireTrustedBackupSource(acknowledged) {
  if (acknowledged !== true) throw Object.assign(new Error('Restore requires one-operation acknowledgement that the backup comes from a trusted source. Supplied database SQL executes with this local account’s privileges; encryption does not prove trusted authorship.'), { code: 'DESKTOP_RESTORE_TRUST_REQUIRED' });
}



export function assertBackupCompatibility(manifest, applicationVersion, platform = process.platform) {
  if (!manifest || manifest.format !== 'pm-agent-desktop-backup' || ![1, 2].includes(manifest.version) || manifest.postgresMajor !== 16)
    throw new Error('Unsupported desktop backup format or PostgreSQL major version.');
  if (manifest.platform !== platform)
    throw new Error('Restore requires the original operating system. Native paths and Provider state are not safely portable; no data was discarded or restored.');
  if (manifest.version === 2 && manifest.applicationVersion !== applicationVersion)
    throw new Error('Restore requires the same application version as the backup. Cross-version migration has not been validated; restore with the original version first.');
}

export async function withPrivateMaintenanceDirectory(operation) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dovspace-maintenance-'));
  try {
    await ensurePrivateDirectory(root, { newlyCreated: true });
    return await operation(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

function member(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || !value.split('/').every(part => part && part !== '.' && part !== '..'
    && !/[\\\x00-\x1f<>:"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw invalid();
  return value;
}
function record(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > maximumMetadata) throw invalid();
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}
async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) throw invalid();
}
async function regular(path, maximum = maximumBytes) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)) throw invalid();
  const file = await open(path, noFollow);
  const actual = await file.stat({ bigint: true });
  if (actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size || actual.nlink !== 1n) { await file.close(); throw invalid(); }
  return { file, before };
}
async function unchanged(file, before) {
  const after = await file.stat({ bigint: true });
  if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.nlink !== 1n) throw invalid();
}
async function* pack(root) {
  let entries = 0;
  const names = new Set();
  async function* walk(path, parent) {
    await directory(path);
    const before = await lstat(path, { bigint: true });
    for (const name of (await readdir(path)).sort()) {
      if (++entries > maximumEntries) throw invalid();
      const relative = member(parent ? `${parent}/${name}` : name);
      const folded = relative.normalize('NFD').toLowerCase();
      if (names.has(folded)) throw new Error('Backup contains case-colliding paths that cannot be restored safely.');
      names.add(folded);
      const location = join(path, name);
      const info = await lstat(location);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        yield record({ type: 'directory', path: relative });
        yield* walk(location, relative);
      } else {
        const { file, before: identity } = await regular(location);
        try {
          yield record({ type: 'file', path: relative, size: Number(identity.size) });
          let length = 0;
          for await (const chunk of file.createReadStream({ autoClose: false })) { length += chunk.length; yield chunk; }
          if (BigInt(length) !== identity.size) throw invalid();
          await unchanged(file, identity);
        } finally { await file.close(); }
      }
    }
    const after = await lstat(path, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw invalid();
  }
  yield record({ type: 'archive', version: 1 });
  yield* walk(root, '');
  yield record({ type: 'end' });
}
async function keyFor(password, salt) {
  const bytes = Buffer.from(password, 'utf8');
  try { return await derive(bytes, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 ** 2 }); }
  finally { bytes.fill(0); }
}
async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) { const result = await file.write(bytes, offset, bytes.length - offset); if (!result.bytesWritten) throw invalid(); offset += result.bytesWritten; }
}
async function readExactly(file, size, position) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) { const result = await file.read(bytes, offset, size - offset, position + offset); if (!result.bytesRead) throw invalid(); offset += result.bytesRead; }
  return bytes;
}

/** Only the authenticated encrypted container is published; no password enters a child process. */
export async function encryptBackupDirectory(source, destination, password) {
  validateBackupPassword(password, true);
  const salt = randomBytes(32), nonce = randomBytes(12);
  const header = Buffer.from(JSON.stringify({ format: 'dovspace-encrypted-backup', version: 1, cipher: 'aes-256-gcm', kdf, salt: salt.toString('hex'), nonce: nonce.toString('hex') }));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  const aad = Buffer.concat([magic, length, header]);
  const key = await keyFor(password, salt);
  let output;
  let created = false;
  try {
    output = await open(destination, 'wx', 0o600); created = true;
    await securePrivateFile(destination, { newlyCreated: true });
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 }); cipher.setAAD(aad);
    await writeAll(output, aad);
    let bytes = 0;
    for await (const chunk of pack(source)) {
      bytes += chunk.length;
      if (bytes > maximumBytes) throw new Error('Desktop backup exceeds the supported 32 GiB encrypted-container limit.');
      await writeAll(output, cipher.update(chunk));
    }
    await writeAll(output, cipher.final()); await writeAll(output, cipher.getAuthTag());
    await output.sync();
  } catch (error) {
    await output?.close(); output = undefined;
    if (created) await rm(destination, { force: true });
    throw error;
  } finally { key.fill(0); await output?.close(); }
}

async function unpack(archive, destination) {
  const input = await open(archive, noFollow);
  const size = (await input.stat()).size;
  let position = 0, count = 0;
  const names = new Set(), directories = new Set(['']);
  async function next() {
    const length = (await readExactly(input, 4, position)).readUInt32BE(); position += 4;
    if (!length || length > maximumMetadata) throw invalid();
    const value = JSON.parse((await readExactly(input, length, position)).toString('utf8')); position += length;
    return value;
  }
  try {
    const start = await next();
    if (JSON.stringify(start) !== JSON.stringify({ type: 'archive', version: 1 })) throw invalid();
    for (;;) {
      const entry = await next();
      if (entry.type === 'end' && Object.keys(entry).length === 1) { if (position !== size) throw invalid(); break; }
      if (++count > maximumEntries || !['file', 'directory'].includes(entry.type)) throw invalid();
      const path = member(entry.path), folded = path.normalize('NFD').toLowerCase();
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (names.has(folded) || !directories.has(parent)) throw invalid();
      names.add(folded);
      const target = join(destination, ...path.split('/'));
      if (entry.type === 'directory') {
        if (Object.keys(entry).length !== 2) throw invalid();
        await mkdir(target, { mode: 0o700 }); directories.add(path);
        await ensurePrivateDirectory(target, { newlyCreated: true });
      } else {
        if (Object.keys(entry).length !== 3 || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > size - position) throw invalid();
        const output = await open(target, 'wx', 0o600);
        try {
          await securePrivateFile(target, { newlyCreated: true });
          let remaining = entry.size;
          while (remaining) { const length = Math.min(remaining, 64 * 1024); await writeAll(output, await readExactly(input, length, position)); remaining -= length; position += length; }
          await output.sync();
        } finally { await output.close(); }
      }
    }
  } finally { await input.close(); }
}

/** Authentication completes in private staging before extraction, let alone instance initialization. */
export async function decryptBackupDirectory(source, destination, password) {
  validateBackupPassword(password);
  await assertPrivatePath(dirname(destination), true);
  const { file, before } = await regular(source, maximumContainerBytes);
  let key;
  let created = false;
  try {
    const prefix = await readExactly(file, magic.length + 4, 0);
    if (!prefix.subarray(0, magic.length).equals(magic)) throw invalid();
    const headerSize = prefix.readUInt32BE(magic.length);
    const length = encryptedPayloadLength(Number(before.size), headerSize);
    const rawHeader = await readExactly(file, headerSize, prefix.length);
    const header = JSON.parse(rawHeader.toString('utf8'));
    // Never execute attacker-selected work factors or accept unauthenticated algorithm downgrades.
    if (Object.keys(header).length !== 6 || header.format !== 'dovspace-encrypted-backup' || header.version !== 1 || header.cipher !== 'aes-256-gcm'
      || JSON.stringify(header.kdf) !== JSON.stringify(kdf) || !/^[a-f0-9]{64}$/.test(header.salt) || !/^[a-f0-9]{24}$/.test(header.nonce)) throw invalid();
    const offset = prefix.length + headerSize;
    key = await keyFor(password, Buffer.from(header.salt, 'hex'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.nonce, 'hex'), { authTagLength: 16 });
    decipher.setAAD(Buffer.concat([prefix, rawHeader]));
    decipher.setAuthTag(await readExactly(file, 16, offset + length));
    await withPrivateMaintenanceDirectory(async root => {
      const packed = join(root, 'authenticated-payload');
      const output = await open(packed, 'wx', 0o600);
      try {
        await securePrivateFile(packed, { newlyCreated: true });
        for await (const chunk of file.createReadStream({ start: offset, end: offset + length - 1, autoClose: false }))
          await writeAll(output, decipher.update(chunk));
        await writeAll(output, decipher.final());
        await output.sync();
      } finally { await output.close(); }
      await unchanged(file, before);
      await mkdir(destination, { mode: 0o700 }); created = true;
      await ensurePrivateDirectory(destination, { newlyCreated: true });
      await unpack(packed, destination);
    });
  } catch {
    if (created) await rm(destination, { recursive: true, force: true });
    throw invalid();
  } finally { key?.fill(0); await file.close(); }
}
