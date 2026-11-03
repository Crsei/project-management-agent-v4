import { constants } from 'node:fs';
import type { BigIntStats, Dirent } from 'node:fs';
import { lstat, realpath, mkdir, open, readdir, link, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import { DomainError } from '../../domain/src/core.ts';
import { samePath, safeRelativePath } from '../../pm-core/platform.ts';
import { assertNoWindowsReparsePath, cacheWindowsPathAttributes } from '../../pm-core/windows-reparse.ts';

const linux = process.platform === 'linux';
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export const readOnlyFileFlags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
export const exclusiveFileFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);

type Identity = { path: string; stat: BigIntStats };
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function unsafe(): never { throw new DomainError('blob_checkpoint_unsafe', 'Storage path is linked, replaced, or outside its checked directory', 503); }

/** A manifest uses POSIX separators even when its consumer runs on Windows. */
export function assertStorageRelativePath(value: string): void {
  if (!safeRelativePath(value)) unsafe();
}
function assertName(name: string): void { assertStorageRelativePath(name); if (name.includes('/')) unsafe(); }

async function inspectDirectory(path: string): Promise<BigIntStats> {
  const stat = await lstat(path, { bigint: true });
  assertNoWindowsReparsePath(path, stat);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(path), path)) unsafe();
  return stat;
}

/**
 * Linux keeps descriptor-relative traversal and directory fsync. Node does not expose
 * openat/handle-relative reparse-safe traversal on macOS/Windows: those adapters check
 * every ancestor before/after I/O and are for private app-managed roots, NOT a sandbox
 * against a hostile process running as the same user. Such a sandbox needs native APIs.
 */
export class SafeDirectory {
  readonly root: string;
  private readonly handle: FileHandle | undefined;
  private readonly lineage: Identity[];

  private constructor(root: string, handle: FileHandle | undefined, lineage: Identity[]) {
    this.root = root;
    this.handle = handle;
    this.lineage = lineage;
  }

  static async open(root: string, create = false): Promise<SafeDirectory> {
    if (!['linux', 'darwin', 'win32'].includes(process.platform)) throw new DomainError('blob_platform_unsupported', 'Unsupported local storage platform', 503);
    root = resolve(root);
    const volume = parse(root).root;
    if (samePath(root, volume)) unsafe();
    const parts = root.slice(volume.length).split(sep).filter(Boolean);
    let current = new SafeDirectory(volume, linux ? await open(volume, directoryFlags) : undefined, []);
    try {
      if (!linux) current.lineage.push({ path: volume, stat: await inspectDirectory(volume) });
      for (const part of parts) {
        if (create) {
          try { await current.mkdir(part); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        }
        const next = await current.child(part);
        await current.close(); current = next;
      }
      return current;
    } catch (error) { await current.close(); throw error; }
  }

  path(name?: string): string {
    if (name !== undefined) assertName(name);
    const root = this.handle ? `/proc/self/fd/${this.handle.fd}` : this.root;
    return name === undefined ? root : join(root, name);
  }

  async assertIdentity(): Promise<void> {
    if (this.handle) return;
    for (const item of this.lineage) if (!sameIdentity(await inspectDirectory(item.path), item.stat)) unsafe();
  }

  async identity(): Promise<{ dev: bigint; ino: bigint }> {
    await this.assertIdentity();
    const stat = this.handle ? await this.handle.stat({ bigint: true }) : this.lineage[this.lineage.length - 1]!.stat;
    return { dev: stat.dev, ino: stat.ino };
  }

  async child(name: string): Promise<SafeDirectory> {
    assertName(name);
    await this.assertIdentity();
    if (this.handle) return new SafeDirectory(join(this.root, name), await open(this.path(name), directoryFlags), []);
    const path = this.path(name);
    const stat = await inspectDirectory(path);
    await this.assertIdentity();
    const child = new SafeDirectory(path, undefined, [...this.lineage, { path, stat }]);
    await child.assertIdentity();
    return child;
  }

  async duplicate(): Promise<SafeDirectory> {
    await this.assertIdentity();
    return new SafeDirectory(this.root, this.handle ? await open(`${this.path()}/.`, directoryFlags) : undefined, [...this.lineage]);
  }

  async openFile(name: string, flags = readOnlyFileFlags, mode = 0o600): Promise<FileHandle> {
    await this.assertIdentity();
    const path = this.path(name);
    let before: BigIntStats | undefined;
    if (!this.handle && !(flags & constants.O_EXCL)) {
      before = await lstat(path, { bigint: true });
      assertNoWindowsReparsePath(path, before);
      if (!before.isFile() || before.isSymbolicLink() || !samePath(await realpath(path), path)) unsafe();
    }
    const file = await open(path, flags, mode);
    try {
      if (!this.handle) {
        const stat = await file.stat({ bigint: true });
        const after = await lstat(path, { bigint: true });
        assertNoWindowsReparsePath(path, after);
        if (!stat.isFile() || ((flags & constants.O_EXCL) !== 0 && stat.nlink !== 1n) || after.isSymbolicLink() || !sameIdentity(stat, after) || (before && !sameIdentity(before, stat)) || !samePath(await realpath(path), path)) unsafe();
        await this.assertIdentity();
      }
      return file;
    } catch (error) { await file.close(); throw error; }
  }

  async assertFile(name: string, file: FileHandle): Promise<void> {
    await this.assertIdentity();
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) unsafe();
    if (!this.handle) {
      const current = await lstat(this.path(name), { bigint: true });
      assertNoWindowsReparsePath(this.path(name), current);
      if (current.isSymbolicLink() || !sameIdentity(stat, current) || !samePath(await realpath(this.path(name)), this.path(name))) unsafe();
    }
  }

  async entries(): Promise<Dirent[]> {
    await this.assertIdentity();
    const entries = await readdir(this.path(), { withFileTypes: true });
    await this.assertIdentity();
    for (const entry of entries) assertName(entry.name);
    if (process.platform === 'win32') cacheWindowsPathAttributes(entries.map(entry => this.path(entry.name)));
    return entries;
  }

  async mkdir(name: string): Promise<void> {
    await this.assertIdentity();
    await mkdir(this.path(name), { mode: 0o700 });
    await this.assertIdentity();
    await this.sync();
  }

  async publish(temporary: string, name: string, file: FileHandle): Promise<void> {
    await this.assertFile(temporary, file);
    // link() is create-exclusive on all supported platforms, unlike rename().
    await link(this.path(temporary), this.path(name));
    const published = await lstat(this.path(name), { bigint: true });
    const source = await file.stat({ bigint: true });
    if (!published.isFile() || published.isSymbolicLink() || !sameIdentity(source, published) || source.nlink !== 2n) unsafe();
    await this.assertIdentity();
    await this.unlink(temporary);
    await this.assertFile(name, file);
    await this.sync();
  }

  async unlink(name: string): Promise<void> {
    await this.assertIdentity();
    await unlink(this.path(name));
    await this.assertIdentity();
  }

  async sync(): Promise<void> {
    await this.assertIdentity();
    if (this.handle) { await this.handle.sync(); return; }
    // Node/Windows cannot open a directory for FlushFileBuffers. This is an explicit
    // metadata-durability limitation, not a swallowed file fsync failure. Every file
    // must still be flushed through FileHandle.sync() before publication/acknowledgment.
    if (process.platform === 'win32') return;
    const directory = await open(this.root, directoryFlags);
    try {
      if (!sameIdentity(await directory.stat({ bigint: true }), this.lineage[this.lineage.length - 1]!.stat)) unsafe();
      await directory.sync();
      await this.assertIdentity();
    } finally { await directory.close(); }
  }

  async close(): Promise<void> { await this.handle?.close(); }
}
