import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const identity = value => sha256(canonical(value));
export const inside = (root, target) => target === root || target.startsWith(root + path.sep);
export function containsControl(value, maximum = 31) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= maximum || code === 127) return true;
  }
  return false;
}
export function relative(value) {
  if (typeof value !== 'string' || !value || containsControl(value) || /[\\:]/.test(value) || path.posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.toLowerCase() === '.upstream-sync')) throw new Error(`UNSAFE_PATH: ${JSON.stringify(value)}`);
  return value;
}
export async function directory(value, { absent = false } = {}) {
  if (typeof value !== 'string' || !value || containsControl(value)) throw new Error('UNSAFE_DIRECTORY');
  const absolute = path.resolve(value);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current).catch(error => { if (error.code === 'ENOENT' && absent) return null; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`UNSAFE_DIRECTORY: ${current}`);
  }
  return absolute;
}
export async function safePath(root, name) {
  relative(name);
  await directory(root);
  let current = path.resolve(root);
  for (const [index, part] of name.split('/').entries()) {
    current = path.join(current, part);
    const stat = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink() || stat && (index < name.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.mode & 0o7000)) throw new Error(`UNSAFE_PATH: ${name}`);
  }
  return current;
}
export async function file(root, name, { optional = false } = {}) {
  const target = await safePath(root, name);
  const stat = await lstat(target).catch(error => { if (error.code === 'ENOENT' && optional) return null; throw error; });
  if (!stat) return null;
  const mode = stat.mode & 0o111 ? 0o755 : 0o644;
  return { bytes: await readFile(target), mode };
}
export async function publish(root, name, bytes, mode = 0o644, { exclusive = false } = {}) {
  if (![0o644, 0o755].includes(mode)) throw new Error(`UNSAFE_MODE: ${name}`);
  const target = await safePath(root, name);
  await mkdir(path.dirname(target), { recursive: true });
  // Never truncate an existing inode: hard links and symlinks have already been refused.
  const temporary = `${target}.upstream-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode });
    await chmod(temporary, mode);
    await safePath(root, name);
    if (exclusive) {
      await writeFile(target, bytes, { flag: 'wx', mode });
      await chmod(target, mode);
    } else await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}
export async function walk(root, prefix = '', { omit = [] } = {}) {
  const output = [];
  await directory(root);
  async function visit(name) {
    const full = path.join(root, name);
    const stat = await lstat(full);
    if (stat.isSymbolicLink() || stat.mode & 0o7000) throw new Error(`UNSAFE_TREE: ${name}`);
    if (stat.isDirectory()) {
      for (const child of (await readdir(full)).sort()) {
        const next = name ? `${name}/${child}` : child;
        if (!omit.some(entry => next === entry || next.startsWith(entry + '/'))) await visit(next);
      }
    } else { relative(name); await safePath(root, name); output.push(name); }
  }
  if (prefix) relative(prefix);
  await visit(prefix);
  return output;
}
export function cleanEnvironment(extra = {}) {
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', ...extra };
}
export async function run(command, args, { cwd, env = cleanEnvironment(), input, accepted = [0], maxBytes = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    let bytes = 0, overflow = false;
    for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]]) stream.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) { overflow = true; child.kill('SIGKILL'); } else chunks.push(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const result = { code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
      if (overflow || !accepted.includes(code) || signal) reject(Object.assign(new Error(`${command} failed (${signal ?? code})${overflow ? ': output limit' : ': ' + result.stderr.toString('utf8').slice(0, 4096)}`), { result }));
      else resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export const git = (root, args, options = {}) => run('git', ['--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.quotePath=false', '-c', 'submodule.recurse=false', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', '-C', root, ...args], options);
async function requireOfflineObjects(root) {
  const config = await git(root, ['config', '--local', '--get-regexp', '^(extensions\\..*|remote\\..*\\.promisor)$'], { accepted: [0, 1] });
  for (const line of config.stdout.toString('utf8').split('\n')) {
    const match = /^(\S+)(?:\s+(.*))?$/.exec(line);
    if (match && (match[1].toLowerCase() === 'extensions.partialclone' || match[1].toLowerCase().endsWith('.promisor') && (match[2] === undefined || /^(?:true|1|yes|on)$/i.test(match[2])))) throw new Error('OFFLINE_OBJECTS_REQUIRED: partial/promisor repositories may fetch implicitly; materialize a separate complete read-only cache first');
  }
}
export async function repository(root) {
  root = await directory(root);
  await requireOfflineObjects(root);
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.toString().trim();
  if (await realpath(top) !== await realpath(root)) throw new Error('Repository must be its exact worktree root');
  return root;
}
export async function sourceRepository(root) {
  root = await directory(root);
  await requireOfflineObjects(root);
  const bare = (await git(root, ['rev-parse', '--is-bare-repository'])).stdout.toString().trim();
  if (bare === 'true') {
    const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).stdout.toString().trim();
    if (await realpath(gitDir) !== await realpath(root)) throw new Error('Source must be its exact Git root');
    return root;
  }
  return repository(root);
}
const treeCache = new Map();
const blobCache = new Map();
export async function readObjects(root, blobs) {
  const missing = [...new Set(blobs)].filter(blob => !blobCache.has(`${root}:${blob}`));
  if (missing.length) {
    if (missing.some(blob => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blob))) throw new Error('Invalid Git blob identity');
    const bytes = (await git(root, ['cat-file', '--batch'], { input: missing.join('\n') + '\n' })).stdout;
    let offset = 0;
    for (const blob of missing) {
      const end = bytes.indexOf(10, offset);
      const header = bytes.subarray(offset, end).toString('ascii').split(' ');
      if (end < 0 || header[0] !== blob || header[1] !== 'blob' || !/^\d+$/.test(header[2])) throw new Error(`MISSING_OR_UNSAFE_OBJECT: ${blob}`);
      const length = Number(header[2]);
      offset = end + 1;
      if (!Number.isSafeInteger(length) || offset + length >= bytes.length || bytes[offset + length] !== 10) throw new Error('Malformed Git object batch');
      const content = bytes.subarray(offset, offset + length);
      const actual = createHash(blob.length === 40 ? 'sha1' : 'sha256').update(`blob ${length}\0`).update(content).digest('hex');
      if (actual !== blob) throw new Error(`CORRUPT_GIT_OBJECT: ${blob}`);
      blobCache.set(`${root}:${blob}`, content);
      offset += length + 1;
    }
    if (offset !== bytes.length) throw new Error('Unexpected Git object batch suffix');
  }
  return new Map(blobs.map(blob => [blob, blobCache.get(`${root}:${blob}`)]));
}
export async function resolveCommit(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || containsControl(ref, 32)) throw new Error('UNSAFE_REF');
  const commit = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).stdout.toString().trim();
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(commit)) throw new Error('Invalid full Git commit');
  return commit;
}
export async function listTree(root, commit) {
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(commit)) throw new Error('Immutable commit required');
  const key = `${root}:${commit}`;
  if (treeCache.has(key)) return treeCache.get(key);
  const raw = (await git(root, ['ls-tree', '-r', '-z', '--full-tree', commit])).stdout;
  const result = raw.toString('utf8');
  if (!Buffer.from(result).equals(raw)) throw new Error('UNSAFE_GIT_PATH_ENCODING');
  const entries = result.split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error('Malformed Git tree');
    return { path: relative(match[4]), mode: match[1], type: match[2], blob: match[3] };
  });
  treeCache.set(key, entries);
  return entries;
}
export async function readBlob(root, commit, name) {
  relative(name);
  const entry = (await listTree(root, commit)).find(entry => entry.path === name);
  if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`MISSING_OR_UNSAFE_OBJECT: ${commit}:${name}`);
  return (await readObjects(root, [entry.blob])).get(entry.blob);
}
export async function mergeBytes(oldBytes, localBytes, newBytes) {
  if (localBytes.equals(oldBytes)) return { bytes: newBytes, conflict: false };
  if (newBytes.equals(oldBytes) || localBytes.equals(newBytes)) return { bytes: localBytes, conflict: false };
  if ([oldBytes, localBytes, newBytes].some(bytes => bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))) return { bytes: localBytes, conflict: true, reason: 'BINARY_REVIEW_REQUIRED' };
  const temporary = await mkdtemp(path.join(tmpdir(), 'upstream-merge-'));
  try {
    const paths = ['local', 'base', 'upstream'].map(name => path.join(temporary, name));
    await Promise.all(paths.map((name, index) => writeFile(name, [localBytes, oldBytes, newBytes][index], { flag: 'wx', mode: 0o600 })));
    const result = await git(temporary, ['merge-file', '-p', '--diff3', '-L', 'accepted-local', '-L', 'old-upstream', '-L', 'new-upstream', '--', ...paths], { accepted: Array.from({ length: 128 }, (_, index) => index) });
    return { bytes: result.stdout, conflict: result.code !== 0, reason: result.code ? 'MERGE_CONFLICT' : undefined };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
