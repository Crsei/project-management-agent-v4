import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { assertNoWindowsReparsePath } from './windows-reparse.ts';

/** Protection boundaries are conservative on case-insensitive desktop filesystems. */
function comparison(value: string, platform: NodeJS.Platform): string {
  const normalized = (platform === 'win32' ? path.win32 : path.posix).resolve(value);
  return platform === 'win32' ? normalized.toLowerCase() : platform === 'darwin' ? normalized.normalize('NFD').toLowerCase() : normalized;
}
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return comparison(a, platform) === comparison(b, platform);
}
export function pathContains(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const base = comparison(root, platform), child = comparison(target, platform);
  const separator = platform === 'win32' ? '\\' : '/';
  return child === base || child.startsWith(base.endsWith(separator) ? base : base + separator);
}
export function safePathComponent(value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) return false;
  // Win32 aliases include alternate streams, device basenames (even with extensions),
  // and suffixes removed by the filesystem API. Never let them alias guarded names.
  return platform !== 'win32' || !/[<>:"|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value)
    && !/^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value);
}
export function safeRelativePath(value: string, platform: NodeJS.Platform = process.platform): boolean {
  return !!value && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !/^[a-z]:/i.test(value)
    && value.split('/').every(component => safePathComponent(component, platform));
}
export function sameFileIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}
export const fileStamp = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export function assertCanonicalAbsolute(value: string): void {
  if (!path.isAbsolute(value) || value.includes('\0') || path.resolve(value) !== value
    || process.platform === 'win32' && (!/^[a-z]:\\/i.test(value) || value.slice(path.parse(value).root.length).split(path.sep).filter(Boolean).some(component => !safePathComponent(component))))
    throw new Error('Storage requires a canonical local absolute path');
}

export function systemStoragePath(root: string): boolean {
  const sensitive = process.platform === 'win32'
    ? [process.env.SystemRoot ?? 'C:\\Windows', process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', process.env.ProgramData ?? 'C:\\ProgramData']
    : ['/etc', '/proc', '/sys', '/dev', '/boot', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/run', '/root', ...(process.platform === 'darwin' ? ['/System', '/Library', '/Applications', '/private/etc', '/private/var/root'] : [])];
  return samePath(root, path.parse(root).root) || sensitive.some(item => pathContains(item, root));
}
function ordinaryDirectory(location: string): BigIntStats {
  const stat = lstatSync(location, { bigint: true });
  assertNoWindowsReparsePath(location, stat);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(location), location)) throw Object.assign(new Error('Storage directory is a link, reparse alias, or non-directory'), { code: 'EPERM' });
  return stat;
}
/** Validate every ancestor, including drive roots; never accept a junction as a root. */
export function directoryIdentity(location: string): BigIntStats {
  assertCanonicalAbsolute(location);
  let current = path.parse(location).root;
  let stat = ordinaryDirectory(current);
  for (const component of location.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    stat = ordinaryDirectory(current);
  }
  return stat;
}

/** Linux keeps descriptor-relative traversal. Other native targets compare both
 * pathname and open-file identity before/after I/O; Windows cannot open a directory
 * with Node's fs API. No unsupported fsync error is caught or treated as success. */
export class GuardedDirectory {
  readonly fd: number | undefined;
  readonly stat: BigIntStats;
  readonly location: string;
  private closed = false;
  constructor(location: string) {
    this.location = location;
    const descriptorRelative = process.platform === 'linux' && /^\/proc\/self\/fd\/\d+(?:\/[^/]+)?$/.test(location);
    const before = descriptorRelative ? lstatSync(location, { bigint: true }) : directoryIdentity(location);
    if (!before.isDirectory() || before.isSymbolicLink()) throw Object.assign(new Error('Unsafe storage directory'), { code: 'EPERM' });
    if (process.platform !== 'win32') {
      const fd = openSync(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd, { bigint: true });
        if (!sameFileIdentity(before, stat) || !sameFileIdentity(lstatSync(location, { bigint: true }), stat)) throw new Error('Storage directory changed while opening');
        this.fd = fd;
      } catch (error) { closeSync(fd); throw error; }
    }
    this.stat = before;
  }
  assertCurrent(): void {
    if (this.closed) throw new Error('Storage directory is closed');
    const current = lstatSync(this.location, { bigint: true });
    assertNoWindowsReparsePath(this.location, current);
    if (current.isSymbolicLink() || !current.isDirectory() || !sameFileIdentity(current, this.stat)
      || this.fd !== undefined && !sameFileIdentity(fstatSync(this.fd, { bigint: true }), this.stat)
      || process.platform !== 'linux' && !samePath(realpathSync(this.location), this.location)) throw new Error('Storage directory identity changed');
  }
  currentStat(): BigIntStats { this.assertCurrent(); return this.fd === undefined ? lstatSync(this.location, { bigint: true }) : fstatSync(this.fd, { bigint: true }); }
  path(component?: string): string {
    this.assertCurrent();
    const root = process.platform === 'linux' ? `/proc/self/fd/${this.fd!}` : this.location;
    if (component === undefined) return root;
    if (!safePathComponent(component)) throw new Error('Unsafe storage path component');
    return path.join(root, component);
  }
  sync(): void {
    this.assertCurrent();
    // Node exposes no Windows directory FlushFileBuffers handle. File contents are
    // still fsynced by callers; metadata power-loss durability is not promised there.
    if (this.fd !== undefined) fsyncSync(this.fd);
    this.assertCurrent();
  }
  close(): void { if (!this.closed && this.fd !== undefined) closeSync(this.fd); this.closed = true; }
}
export function syncDirectory(directory: string): void {
  const handle = new GuardedDirectory(directory);
  try { handle.sync(); } finally { handle.close(); }
}
/** NOFOLLOW where supported, plus pre/post lstat and open-handle identity on every
 * target (including Win32, whose O_NOFOLLOW constant does not protect an open). */
export function checkedFileOpen(filename: string, flags: number, mode?: number): number {
  if (!safePathComponent(path.basename(filename))) throw new Error('Unsafe storage filename');
  const exclusive = (flags & constants.O_EXCL) !== 0 && (flags & constants.O_CREAT) !== 0;
  let before: BigIntStats | undefined;
  if (!exclusive) {
    try { before = lstatSync(filename, { bigint: true }); }
    catch (error) { if ((flags & constants.O_CREAT) === 0 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)) throw new Error('Unsafe storage file');
  if (before) assertNoWindowsReparsePath(filename, before);
  const fd = openSync(filename, flags | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    const actual = fstatSync(fd, { bigint: true }), current = lstatSync(filename, { bigint: true });
    assertNoWindowsReparsePath(filename, current);
    if (!actual.isFile() || actual.nlink !== 1n || current.isSymbolicLink() || !sameFileIdentity(actual, current)
      || before && !sameFileIdentity(before, actual)
      || process.platform !== 'linux' && !samePath(realpathSync(filename), filename)) throw new Error('Storage file identity changed while opening');
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
