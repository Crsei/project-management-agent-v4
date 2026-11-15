import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { directory, git, identity, relative, sha256 } from './io.mjs';

const privateTree = name => name.split('/').some(part => ['.local', 'node_modules'].includes(part.toLowerCase()));
const secretPath = name => privateTree(name) || name.split('/').some(part => part === '.env' || part.startsWith('.env.') && !/\.(?:example|sample|template)$/.test(part) || ['.ssh', '.aws', '.gnupg', '.netrc', 'credentials.toml', 'id_rsa', 'id_ed25519'].includes(part));
const sameFile = (left, right) => ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
const missing = error => { if (error.code === 'ENOENT') return null; throw error; };

// This read-only entry point deliberately permits linked regular files only as
// snapshot inputs. Candidate writes and every ordinary provenance read continue
// to use io.file/io.publish, which reject links. Never open a source for writing.
export async function snapshotFile(root, name, { optional = false } = {}) {
  relative(name);
  if (secretPath(name)) throw new Error(`CREDENTIAL_FILE_NOT_ALLOWED: ${name}; no credential bytes were read`);
  if (process.platform !== 'linux' || constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) throw new Error('SNAPSHOT_PLATFORM_PREREQUISITE: Linux no-follow directory descriptors required');
  await directory(root);
  const directories = [await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)];
  let handle;
  try {
    // Walk through held directory descriptors, not a symlink-raceable pathname.
    const parts = name.split('/');
    for (const part of parts.slice(0, -1)) {
      const parent = `/proc/self/fd/${directories.at(-1).fd}/${part}`;
      const info = await lstat(parent, { bigint: true }).catch(missing);
      if (!info && optional) return null;
      if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error(`UNSAFE_SNAPSHOT_INPUT: ${name}`);
      directories.push(await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    }
    const target = `/proc/self/fd/${directories.at(-1).fd}/${parts.at(-1)}`;
    const before = await lstat(target, { bigint: true }).catch(missing);
    if (!before && optional) return null;
    if (!before || before.isSymbolicLink() || !before.isFile() || Boolean(before.mode & 0o7000n)) throw new Error(`UNSAFE_SNAPSHOT_INPUT: ${name}`);
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error(`STALE_SNAPSHOT_INPUT: ${name}`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(target, { bigint: true });
    if (!sameFile(opened, after) || !sameFile(opened, current) || BigInt(bytes.length) !== opened.size) throw new Error(`STALE_SNAPSHOT_INPUT: ${name}`);
    return { bytes, mode: opened.mode & 0o111n ? 0o755 : 0o644 };
  } finally {
    await handle?.close();
    for (const parent of directories.reverse()) await parent.close();
  }
}

function pathsFrom(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('UNSAFE_SNAPSHOT_PATH_ENCODING');
  return text.split('\0').filter(Boolean).map(relative);
}

export async function captureWorktree(root, requiredPaths = []) {
  // Git ignores are mutable task data, not a private-data boundary. Explicit
  // dependencies may not smuggle private paths back into the captured set.
  for (const name of requiredPaths) {
    relative(name);
    if (secretPath(name)) throw new Error(`CREDENTIAL_FILE_NOT_ALLOWED: ${name}; no credential bytes were read`);
  }
  const index = (await git(root, ['ls-files', '--stage', '-z'])).stdout;
  const visible = pathsFrom((await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout);
  const names = [...new Set([...visible, ...requiredPaths])].filter(name => !privateTree(name) && name !== '.upstream-sync' && !name.startsWith('.upstream-sync/')).sort();
  const files = [];
  for (const name of names) {
    const input = await snapshotFile(root, name, { optional: true });
    files.push(input ? { path: name, sha256: sha256(input.bytes), bytes: input.bytes.length, mode: input.mode } : { path: name, deleted: true });
  }
  const afterIndex = (await git(root, ['ls-files', '--stage', '-z'])).stdout;
  const afterVisible = pathsFrom((await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout);
  if (!index.equals(afterIndex) || identity(visible.sort()) !== identity(afterVisible.sort())) throw new Error('STALE_WORKTREE_SNAPSHOT: index or path set changed during capture');
  return { version: 1, files, indexBase64: index.toString('base64'), ignoredFiles: 'Git-ignored paths are omitted; .local and node_modules trees are independently excluded even if ignore rules are removed or overridden. Explicit private required paths are refused before content reads.' };
}
