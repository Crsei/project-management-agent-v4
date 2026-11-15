import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { containsControl, relative, sha256 } from './io.mjs';

const absent = error => { if (error.code === 'ENOENT') return null; throw error; };
const privatePath = name => name.split('/').some(part => ['.local', 'node_modules', '.ssh', '.aws', '.gnupg', '.netrc', 'credentials.toml', 'id_rsa', 'id_ed25519'].includes(part.toLowerCase()) || part === '.env' || part.startsWith('.env.') && !/\.(?:example|sample|template)$/.test(part));
const same = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const canonicalMode = info => info.mode & 0o111n ? 0o755 : 0o644;
function name(value) {
  relative(value);
  if (privatePath(value)) throw new Error(`CREDENTIAL_FILE_NOT_ALLOWED: ${value}`);
  return value;
}
function regular(info, value) {
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.mode & 0o7000n) throw new Error(`UNSAFE_PATH: ${value}`);
}
async function parents(root, value = '', { create = false } = {}) {
  if (process.platform !== 'linux' || constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) throw new Error('SUPPLEMENTAL_PLATFORM_PREREQUISITE: Linux no-follow descriptors required');
  const absolute = path.resolve(root);
  const parts = [...absolute.split('/').filter(Boolean), ...value.split('/').filter(Boolean)];
  const handles = [await fs.open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)];
  try {
    for (const part of parts) {
      const target = `/proc/self/fd/${handles.at(-1).fd}/${part}`;
      if (create) await fs.mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      handles.push(await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    }
    return { target: `/proc/self/fd/${handles.at(-1).fd}`, close: async () => { for (const handle of handles.reverse()) await handle.close(); } };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close();
    throw error;
  }
}
async function readAt(parent, leaf, { optional = false } = {}) {
  const target = `${parent}/${leaf}`;
  const before = await fs.lstat(target, { bigint: true }).catch(absent);
  if (!before && optional) return null;
  regular(before, leaf);
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    regular(opened, leaf);
    if (!same(before, opened)) throw new Error(`STALE_SUPPLEMENTAL_INPUT: ${leaf}`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await fs.lstat(target, { bigint: true });
    if (!same(opened, after) || !same(opened, current) || BigInt(bytes.length) !== opened.size) throw new Error(`STALE_SUPPLEMENTAL_INPUT: ${leaf}`);
    return { bytes, mode: canonicalMode(opened) };
  } finally { await handle.close(); }
}
export async function file(root, value, options = {}) {
  name(value);
  const directory = await parents(root, path.posix.dirname(value) === '.' ? '' : path.posix.dirname(value)).catch(error => { if (options.optional && error.code === 'ENOENT') return null; throw error; });
  if (!directory) return null;
  try { return await readAt(directory.target, path.posix.basename(value), options); }
  finally { await directory.close(); }
}
export async function exists(root, value) {
  // Existence probes follow the existing resolver's normalized file-or-directory
  // semantics. This does not relax the strict file/publish ledger path contract.
  if (typeof value !== 'string' || !value || containsControl(value) || /[\\:]/.test(value) || path.posix.isAbsolute(value) || privatePath(value) || value.split('/').some(part => ['.git', '.upstream-sync'].includes(part.toLowerCase()))) throw new Error(`UNSAFE_PATH: ${JSON.stringify(value)}`);
  const normalized = path.posix.normalize(value);
  value = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  if (value === '.') {
    const rootDirectory = await parents(root);
    await rootDirectory.close();
    return true;
  }
  name(value);
  const directory = await parents(root, path.posix.dirname(value) === '.' ? '' : path.posix.dirname(value)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!directory) return false;
  try {
    const target = `${directory.target}/${path.posix.basename(value)}`;
    const info = await fs.lstat(target, { bigint: true }).catch(absent);
    if (!info) return false;
    if (info.isDirectory() && !info.isSymbolicLink()) return true;
    regular(info, value);
    return true;
  } finally { await directory.close(); }
}
export async function publish(root, value, bytes, mode = 0o644, { exclusive = false, expected } = {}) {
  name(value);
  if (![0o644, 0o755, 0o600].includes(mode)) throw new Error(`UNSAFE_MODE: ${value}`);
  const directory = await parents(root, path.posix.dirname(value) === '.' ? '' : path.posix.dirname(value), { create: true });
  const leaf = path.posix.basename(value), target = `${directory.target}/${leaf}`;
  const temporary = `${directory.target}/.supplemental-${randomBytes(16).toString('hex')}`;
  try {
    const current = await readAt(directory.target, leaf, { optional: true });
    if (expected && (!current || sha256(current.bytes) !== expected.sha256 || current.bytes.length !== expected.bytes || current.mode !== expected.mode)) throw new Error(`CONCURRENT_SUPPLEMENTAL_WRITE: ${value}`);
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
    const last = await readAt(directory.target, leaf, { optional: true });
    if (Boolean(current) !== Boolean(last) || current && (!current.bytes.equals(last.bytes) || current.mode !== last.mode)) throw new Error(`CONCURRENT_SUPPLEMENTAL_WRITE: ${value}`);
    if (exclusive || !current) {
      // Atomic no-replace publication closes the absent-leaf race.
      await fs.link(temporary, target);
      await fs.unlink(temporary);
    } else {
      // Do not rename over a pathname checked earlier: another writer can put
      // third bytes there between the check and rename. Move the actual leaf
      // aside first, authenticate that inode, then publish with no replacement.
      const backupName = `.supplemental-preserved-${randomBytes(16).toString('hex')}`;
      const backupDirectory = `${directory.target}/${backupName}`;
      await fs.mkdir(backupDirectory, { mode: 0o700 });
      const backup = await fs.open(backupDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const backupRoot = `/proc/self/fd/${backup.fd}`, original = `${backupRoot}/original`;
      let moved = false, installed = false;
      try {
        await fs.rename(target, original);
        moved = true;
        const displaced = await readAt(backupRoot, 'original');
        if (!current.bytes.equals(displaced.bytes) || current.mode !== displaced.mode) throw new Error(`CONCURRENT_SUPPLEMENTAL_WRITE: ${value}; unexpected displaced bytes`);
        await fs.link(temporary, target);
        installed = true;
        await fs.unlink(temporary);
        const retained = await readAt(backupRoot, 'original');
        if (!current.bytes.equals(retained.bytes) || current.mode !== retained.mode) throw new Error(`CONCURRENT_SUPPLEMENTAL_WRITE: ${value}; displaced inode changed during publication`);
        await fs.unlink(original);
        moved = false;
      } catch (error) {
        let failure = error;
        let restored = false;
        if (moved && !installed) {
          try {
            // Exclusive link restores even an unexpected inode without
            // overwriting a concurrently created destination.
            await fs.link(original, target);
            await fs.unlink(original);
            moved = false;
            restored = true;
          } catch (restoreError) {
            if (restoreError.code !== 'EEXIST') failure = new Error(`${error.message}; exclusive restoration refused: ${restoreError.message}`, { cause: error });
          }
        }
        const location = `${await fs.readlink(directory.target)}/${backupName}/original`;
        throw new Error(`${failure.message}; ${moved ? `preexisting inode preserved at ${location}; current destination not overwritten` : restored ? 'unexpected preexisting inode restored exclusively; reviewed bytes not published' : 'destination not overwritten'}`, { cause: failure });
      } finally {
        try {
          if (!moved) await fs.rmdir(backupDirectory);
        } finally { await backup.close(); }
      }
    }
  } finally {
    try { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    finally { await directory.close(); }
  }
}
export async function walk(root, prefix = '', { omit = [] } = {}) {
  if (prefix) name(prefix);
  const result = [], directory = await parents(root);
  async function visit(parent, value) {
    // The held /proc fd is intentionally a descriptor reference, not an input
    // symlink. Resolve its final "." while keeping O_NOFOLLOW on real children.
    const target = value ? `${parent}/${path.posix.basename(value)}` : `${parent}/.`;
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const anchored = `/proc/self/fd/${handle.fd}`;
      for (const child of (await fs.readdir(anchored)).sort()) {
        const next = value ? `${value}/${child}` : child;
        if (next.split('/').some(part => ['node_modules', '.local'].includes(part.toLowerCase())) || omit.some(entry => next === entry || next.startsWith(`${entry}/`))) continue;
        name(next);
        const info = await fs.lstat(`${anchored}/${child}`, { bigint: true });
        if (info.isDirectory() && !info.isSymbolicLink()) await visit(anchored, next);
        else { regular(info, next); result.push(next); }
      }
    } finally { await handle.close(); }
  }
  try {
    if (prefix) {
      const parent = await parents(root, path.posix.dirname(prefix) === '.' ? '' : path.posix.dirname(prefix));
      try { await visit(parent.target, prefix); } finally { await parent.close(); }
    } else await visit(directory.target, '');
    return result;
  } finally { await directory.close(); }
}

export async function makeDirectory(root, { exclusive = false } = {}) {
  const absolute = path.resolve(root);
  const parent = await parents(path.dirname(absolute));
  try {
    await fs.mkdir(`${parent.target}/${path.basename(absolute)}`, { mode: 0o700 }).catch(error => {
      if (exclusive || error.code !== 'EEXIST') throw error;
    });
    const opened = await fs.open(`${parent.target}/${path.basename(absolute)}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await opened.close();
    return absolute;
  } finally { await parent.close(); }
}

export async function lock(root) {
  const parent = await parents(root), target = `${parent.target}/record.lock`;
  let handle;
  try {
    await fs.mkdir(target, { mode: 0o700 });
    handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    await parent.close();
    if (error.code === 'EEXIST') throw new Error('SUPPLEMENTAL_RECORD_LOCKED: inspect the external control owner before retrying; stale locks are never removed automatically');
    throw error;
  }
  const identity = await handle.stat({ bigint: true });
  return async () => {
    try {
      const current = await fs.lstat(target, { bigint: true });
      if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isDirectory() || current.isSymbolicLink()) throw new Error('SUPPLEMENTAL_LOCK_IDENTITY_CHANGED');
      await fs.rmdir(target);
    } finally { await handle.close(); await parent.close(); }
  };
}
