import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import type { DocumentSourceContent, DocumentSourceEntry, DocumentSourceIssue } from '../../contracts/src/document-sources.ts';
import { DomainError } from '../../domain/src/core.ts';
import { maxRepositoryFileBytes } from '../../pm-core/repository.ts';

export type DocumentDirectoryIdentity = { device: string; inode: string };
type Link = { fd: number; location: string; stat: BigIntStats };
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const privateComponents: Record<string, true> = { '.pm': true, '.git': true, '.ssh': true, '.aws': true, '.config': true, '.codex': true, '.claude': true, '.agent-workspace': true, 'provider-homes': true };
const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const stamp = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const fdPath = (fd: number): string => `/proc/self/fd/${fd}`;
const forbidden = (): never => { throw new DomainError('document_source_path_forbidden', 'The requested path is not a safe ordinary Markdown file or directory', 403); };
const changed = (): never => { throw new DomainError('document_source_unavailable', 'The source directory changed or is unavailable; no fallback is used', 409, { reason: 'directory_identity_changed' }); };
function directory(stat: BigIntStats): void {
  if (!stat.isDirectory() || (stat.mode & 0o444n) === 0n || (stat.mode & 0o111n) === 0n) forbidden();
}
function ordinaryFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o444n) === 0n) forbidden();
}
function pinDirectory(location: string): Link {
  const fd = openSync(location, directoryFlags);
  try {
    const stat = fstatSync(fd, { bigint: true }); directory(stat);
    if (!sameIdentity(lstatSync(location, { bigint: true }), stat)) changed();
    return { fd, location, stat };
  } catch (error) { closeSync(fd); throw error; }
}
export function assertDocumentRelativePath(relative: string): void {
  if (!relative || relative.length > 4096 || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')
    || relative.split('/').some(part => !part || part === '.' || part === '..' || privateComponents[part] === true) || !/\.md$/i.test(relative)) forbidden();
}
export function documentPrivateComponent(component: string): boolean { return privateComponents[component] === true; }

/** Linux descriptor-relative traversal: NOFOLLOW applies to every untrusted component,
 * not just the leaf. Pinned parents prevent rename/symlink swaps from redirecting IO.
 * No source path is ever opened for writing; proc fd paths are internal, never input. */
export class DocumentSourceDirectory {
  private links: Link[] = [];
  readonly identity: DocumentDirectoryIdentity;
  readonly fd: number;
  readonly root: string;
  constructor(root: string, expected?: DocumentDirectoryIdentity) {
    this.root = root;
    if (!path.isAbsolute(root) || path.resolve(root) !== root || root.includes('\0')) forbidden();
    try {
      let location = '/';
      for (const component of ['', ...root.split('/').filter(Boolean)]) {
        if (component) location = `${fdPath(this.links[this.links.length - 1]!.fd)}/${component}`;
        this.links.push(pinDirectory(location));
      }
      const stat = this.links[this.links.length - 1]!.stat;
      this.fd = this.links[this.links.length - 1]!.fd;
      this.identity = { device: String(stat.dev), inode: String(stat.ino) };
      if (expected && (expected.device !== this.identity.device || expected.inode !== this.identity.inode)) changed();
      this.assertCurrent();
    } catch (error) { this.close(); throw error; }
  }
  assertCurrent(): void {
    for (const link of this.links) {
      const stat = lstatSync(link.location, { bigint: true });
      directory(stat);
      if (!sameIdentity(stat, link.stat) || !sameIdentity(fstatSync(link.fd, { bigint: true }), link.stat)) changed();
    }
  }
  close(): void { for (const link of this.links.reverse()) closeSync(link.fd); this.links = []; }

  scan(canRead: (relative: string) => boolean = () => true): { entries: DocumentSourceEntry[]; issues: DocumentSourceIssue[]; fingerprint: string } {
    const entries: DocumentSourceEntry[] = [], issues: DocumentSourceIssue[] = [];
    const hash = createHash('sha256');
    let visited = 0;
    const maxNodes = 100_000, maxIssues = 1000, maxDepth = 128;
    function issue(relative: string, code: string): void {
      if (issues.length < maxIssues) issues.push({ path: relative, code });
      else if (issues.at(-1)?.code !== 'issue_limit') issues.push({ path: '', code: 'issue_limit' });
    }
    let scopeExcluded = false;
    const visible = (relative: string): boolean => {
      if (canRead(relative)) return true;
      if (!scopeExcluded) { issue('', 'scope_excluded'); scopeExcluded = true; }
      return false;
    };
    const walk = (fd: number, relative: string, depth: number): void => {
      if (depth > maxDepth) { issue(relative, 'depth_limit'); return; }
      const before = fstatSync(fd, { bigint: true });
      directory(before);
      hash.update(JSON.stringify([relative, stamp(before)]));
      const names: string[] = [];
      try {
        const stream = opendirSync(fdPath(fd));
        try {
          let entry;
          while ((entry = stream.readSync()) !== null) {
            if (visited >= maxNodes) { issue(relative, 'scan_limit'); break; }
            names.push(entry.name); visited++;
          }
        } finally { stream.closeSync(); }
        names.sort();
      } catch {
        if (!relative) throw new DomainError('document_source_unavailable', 'The source root cannot be enumerated', 409, { reason: 'directory_unreadable' });
        issue(relative, 'directory_unreadable'); return;
      }
      for (const name of names) {
        const child = relative ? `${relative}/${name}` : name;
        if (name.includes('\\') || name.includes('\0') || child.length > 4096) { issue(relative, 'unsafe_path'); continue; }
        if (!visible(child)) continue;
        if (documentPrivateComponent(name)) { issue(child, 'private_path'); continue; }
        const location = `${fdPath(fd)}/${name}`;
        try {
          const stat = lstatSync(location, { bigint: true });
          hash.update(JSON.stringify([child, stamp(stat)]));
          if (stat.isSymbolicLink()) { issue(child, 'symlink_forbidden'); continue; }
          if (stat.isDirectory()) {
            directory(stat);
            const nested = pinDirectory(location);
            try {
              if (!sameIdentity(nested.stat, stat)) changed();
              walk(nested.fd, child, depth + 1);
              if (!sameIdentity(lstatSync(location, { bigint: true }), stat)) changed();
            } finally { closeSync(nested.fd); }
          } else if (!stat.isFile()) issue(child, 'special_file_forbidden');
          else if (stat.nlink !== 1n) issue(child, 'hardlink_forbidden');
          else if (/\.md$/i.test(name)) {
            ordinaryFile(stat);
            const leaf = openSync(location, fileFlags);
            try {
              const actual = fstatSync(leaf, { bigint: true }); ordinaryFile(actual);
              if (stamp(actual) !== stamp(stat) || stamp(lstatSync(location, { bigint: true })) !== stamp(stat)) changed();
              entries.push({ path: child, name, size: Number(stat.size), modifiedAt: new Date(Number(stat.mtimeMs)).toISOString() });
            } finally { closeSync(leaf); }
          }
        } catch (error) {
          if (error instanceof DomainError && error.code === 'document_source_unavailable') throw error;
          issue(child, error instanceof DomainError ? 'path_forbidden' : 'entry_unreadable');
        }
      }
      if (stamp(fstatSync(fd, { bigint: true })) !== stamp(before)) changed();
    };
    this.assertCurrent();
    if (visible('')) walk(this.fd, '', 0);
    this.assertCurrent();
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    hash.update(JSON.stringify(issues));
    return { entries, issues, fingerprint: hash.digest('hex') };
  }

  content(relative: string, sourceRevision: number): DocumentSourceContent {
    assertDocumentRelativePath(relative);
    const nested: Link[] = [];
    let leaf: number | undefined;
    try {
      this.assertCurrent();
      let parent = this.fd;
      const parts = relative.split('/'), filename = parts.pop()!;
      for (const component of parts) {
        const location = `${fdPath(parent)}/${component}`;
        const link = pinDirectory(location);
        nested.push(link); parent = link.fd;
      }
      const location = `${fdPath(parent)}/${filename}`;
      const before = lstatSync(location, { bigint: true }); ordinaryFile(before);
      leaf = openSync(location, fileFlags);
      const stat = fstatSync(leaf, { bigint: true }); ordinaryFile(stat);
      if (stamp(stat) !== stamp(before)) changed();
      if (stat.size > BigInt(maxRepositoryFileBytes)) throw new DomainError('document_source_file_too_large', 'Markdown content exceeds the 4 MiB read limit', 413, { maxBytes: maxRepositoryFileBytes });
      // A bounded positional read never follows file growth or silently truncates it.
      const bytes = Buffer.alloc(Number(stat.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(leaf, bytes, offset, bytes.length - offset, offset);
        if (!count) changed();
        offset += count;
      }
      if (readSync(leaf, Buffer.alloc(1), 0, 1, bytes.length) || stamp(fstatSync(leaf, { bigint: true })) !== stamp(stat)
        || stamp(lstatSync(location, { bigint: true })) !== stamp(stat)) changed();
      for (const link of nested) {
        const current = lstatSync(link.location, { bigint: true }); directory(current);
        if (!sameIdentity(current, link.stat) || !sameIdentity(fstatSync(link.fd, { bigint: true }), link.stat)) changed();
      }
      this.assertCurrent();
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new DomainError('document_source_encoding_invalid', 'Markdown content is not valid UTF-8', 422); }
      return { path: relative, content, size: bytes.length, modifiedAt: new Date(Number(stat.mtimeMs)).toISOString(), sourceRevision };
    } finally {
      if (leaf !== undefined) closeSync(leaf);
      for (const link of nested.reverse()) closeSync(link.fd);
    }
  }
}

/** Translate filesystem errors without returning host paths or OS error messages. */
export function documentSourceFileError(error: unknown, readingFile = false): never {
  if (error instanceof DomainError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (readingFile && code === 'ENOENT') throw new DomainError('document_source_file_not_found', 'The Markdown file no longer exists', 404);
  if (['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code ?? '')) forbidden();
  throw new DomainError('document_source_unavailable', 'The source directory is missing or unreadable; no fallback is used', 409, { reason: 'directory_unavailable' });
}
