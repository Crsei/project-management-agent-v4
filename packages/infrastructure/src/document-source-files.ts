import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, opendirSync, readSync, readdirSync, renameSync, unlinkSync, writeSync, type BigIntStats, type Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { documentSourceMutationReceiptSchema, type DocumentSourceContent, type DocumentSourceEntry, type DocumentSourceIssue, type DocumentSourceMutationReceipt } from '../../contracts/src/document-sources.ts';
import { parseDocumentSourceReceipt } from './document-sources.ts';
import { externalDocumentHistoryPreparedSchema, type ExternalDocumentHistoryPrepared } from './document-source-history.ts';
import { DomainError } from '../../domain/src/core.ts';
import { maxRepositoryFileBytes } from '../../pm-core/repository.ts';
import { assertCanonicalAbsolute, checkedFileOpen, fileStamp, GuardedDirectory, safePathComponent, safeRelativePath, sameFileIdentity, samePath } from '../../pm-core/platform.ts';
import { assertPrivatePath, makePrivatePath } from '../../pm-core/private-path.ts';
import { cacheWindowsPathAttributes } from '../../pm-core/windows-reparse.ts';

export type DocumentDirectoryIdentity = { device: string; inode: string };
type Link = GuardedDirectory;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const privateComponents: Record<string, true> = { '.pm': true, '.git': true, '.ssh': true, '.aws': true, '.config': true, '.codex': true, '.claude': true, '.agent-workspace': true, 'provider-homes': true };
const operationProofSchema = z.strictObject({ requestHash: z.string().regex(/^[a-f0-9]{64}$/), receipt: z.preprocess(parseDocumentSourceReceipt, documentSourceMutationReceiptSchema) });
const operationHistorySchema = z.strictObject({ requestHash: z.string().regex(/^[a-f0-9]{64}$/), capture: externalDocumentHistoryPreparedSchema });
const sameIdentity = sameFileIdentity;
const stamp = fileStamp;
const forbiddenPathCodes = ['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM'];
const forbidden = (): never => { throw new DomainError('document_source_path_forbidden', 'The requested path is not a safe ordinary Markdown file or directory', 403); };
const changed = (): never => { throw new DomainError('document_source_unavailable', 'The source directory changed or is unavailable; no fallback is used', 409, { reason: 'directory_identity_changed' }); };
const conflict = (): never => { throw new DomainError('document_source_file_revision_conflict', 'The Markdown file changed; reload before applying your changes', 409); };
const collision = (): never => { throw new DomainError('document_source_collision', 'A file or directory already exists at the destination; nothing was overwritten', 409); };
function writable(stat: BigIntStats): void { if ((stat.mode & 0o222n) === 0n) forbidden(); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function directory(stat: BigIntStats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o444n) === 0n || process.platform !== 'win32' && (stat.mode & 0o111n) === 0n) forbidden();
}
function ordinaryFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o444n) === 0n) forbidden();
}
function pinDirectory(location: string): Link {
  let link: Link;
  try { link = new GuardedDirectory(location); }
  catch (error) {
    if (forbiddenPathCodes.includes((error as NodeJS.ErrnoException).code ?? '')) forbidden();
    throw error;
  }
  try { directory(link.stat); return link; }
  catch (error) { link.close(); throw error; }
}
function assertLink(link: Link): void {
  try { link.assertCurrent(); directory(link.currentStat()); }
  catch { changed(); }
}
export function assertDocumentRelativePath(relative: string): void {
  if (relative.length > 4096 || !safeRelativePath(relative)
    || relative.split('/').some(documentPrivateComponent) || !/\.md$/i.test(relative)) forbidden();
}
export function documentPrivateComponent(component: string): boolean { return privateComponents[process.platform === 'linux' ? component : component.toLowerCase()] === true; }

/** Linux mutations remain descriptor-relative. Native desktop paths are guarded by
 * ancestor, open-file and root identity checks before and after every operation;
 * links, junction aliases and unsafe Win32 path aliases are never accepted. */
export class DocumentSourceDirectory {
  private links: Link[] = [];
  readonly identity: DocumentDirectoryIdentity;
  readonly handle: GuardedDirectory;
  readonly root: string;
  constructor(root: string, expected?: DocumentDirectoryIdentity) {
    this.root = root;
    try { assertCanonicalAbsolute(root); } catch { forbidden(); }
    try {
      let location = path.parse(root).root;
      for (const component of ['', ...root.slice(location.length).split(path.sep).filter(Boolean)]) {
        if (component) location = this.links[this.links.length - 1]!.path(component);
        this.links.push(pinDirectory(location));
      }
      this.handle = this.links[this.links.length - 1]!;
      const stat = this.handle.stat;
      this.identity = { device: String(stat.dev), inode: String(stat.ino) };
      if (expected && (expected.device !== this.identity.device || expected.inode !== this.identity.inode)) changed();
      this.assertCurrent();
    } catch (error) { this.close(); throw error; }
  }
  assertCurrent(): void {
    for (const link of this.links) assertLink(link);
  }
  close(): void { for (const link of this.links.reverse()) link.close(); this.links = []; }

  entries(): Dirent[] {
    this.assertCurrent();
    const entries = readdirSync(this.handle.path(), { withFileTypes: true });
    this.assertCurrent();
    return entries;
  }

  scan(canRead: (relative: string) => boolean = () => true): { entries: Omit<DocumentSourceEntry, 'fileKey'>[]; issues: DocumentSourceIssue[]; fingerprint: string } {
    const entries: Omit<DocumentSourceEntry, 'fileKey'>[] = [], issues: DocumentSourceIssue[] = [];
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
    const walk = (parent: Link, relative: string, depth: number): void => {
      if (depth > maxDepth) { issue(relative, 'depth_limit'); return; }
      const before = parent.currentStat();
      directory(before);
      hash.update(JSON.stringify([relative, stamp(before)]));
      const names: string[] = [];
      try {
        const stream = opendirSync(parent.path());
        try {
          let entry;
          while ((entry = stream.readSync()) !== null) {
            if (visited >= maxNodes) { issue(relative, 'scan_limit'); break; }
            names.push(entry.name); visited++;
          }
        } finally { stream.closeSync(); }
        names.sort();
        if (process.platform === 'win32') cacheWindowsPathAttributes(names.filter(name => safePathComponent(name)).map(name => parent.path(name)));
      } catch {
        if (!relative) throw new DomainError('document_source_unavailable', 'The source root cannot be enumerated', 409, { reason: 'directory_unreadable' });
        issue(relative, 'directory_unreadable'); return;
      }
      for (const name of names) {
        const child = relative ? `${relative}/${name}` : name;
        if (!safePathComponent(name) || child.length > 4096) { issue(relative, 'unsafe_path'); continue; }
        if (!visible(child)) continue;
        if (documentPrivateComponent(name)) { issue(child, 'private_path'); continue; }
        const location = parent.path(name);
        try {
          const stat = lstatSync(location, { bigint: true });
          hash.update(JSON.stringify([child, stamp(stat)]));
          if (stat.isSymbolicLink()) { issue(child, 'symlink_forbidden'); continue; }
          if (stat.isDirectory()) {
            directory(stat);
            const nested = pinDirectory(location);
            try {
              if (!sameIdentity(nested.stat, stat)) changed();
              walk(nested, child, depth + 1);
              if (!sameIdentity(lstatSync(location, { bigint: true }), stat)) changed();
            } finally { nested.close(); }
          } else if (!stat.isFile()) issue(child, 'special_file_forbidden');
          else if (stat.nlink !== 1n) issue(child, 'hardlink_forbidden');
          else if (/\.md$/i.test(name)) {
            ordinaryFile(stat);
            const leaf = checkedFileOpen(location, fileFlags);
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
      if (stamp(parent.currentStat()) !== stamp(before)) changed();
    };
    this.assertCurrent();
    if (visible('')) walk(this.handle, '', 0);
    this.assertCurrent();
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    hash.update(JSON.stringify(issues));
    return { entries, issues, fingerprint: hash.digest('hex') };
  }

  content(relative: string, sourceRevision: number, canWrite = false): DocumentSourceContent {
    assertDocumentRelativePath(relative);
    const nested: Link[] = [];
    let leaf: number | undefined;
    try {
      this.assertCurrent();
      let parent = this.handle;
      const parts = relative.split('/'), filename = parts.pop()!;
      for (const component of parts) {
        const link = pinDirectory(parent.path(component));
        nested.push(link); parent = link;
      }
      const location = parent.path(filename);
      const before = lstatSync(location, { bigint: true }); ordinaryFile(before);
      leaf = checkedFileOpen(location, fileFlags);
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
      for (const link of nested) assertLink(link);
      this.assertCurrent();
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new DomainError('document_source_encoding_invalid', 'Markdown content is not valid UTF-8', 422); }
      const revision = createHash('sha256').update(stamp(stat)).update('\0').update(bytes).digest('hex');
      return { path: relative, content, size: bytes.length, modifiedAt: new Date(Number(stat.mtimeMs)).toISOString(), sourceRevision, revision, canWrite };
    } finally {
      if (leaf !== undefined) closeSync(leaf);
      for (const link of nested.reverse()) link.close();
    }
  }

  /** Authorize retained bytes without treating an absent file as a filesystem read. */
  assertHistoryPath(relative: string): void {
    assertDocumentRelativePath(relative);
    const nested: Link[] = [];
    const current = (): void => { this.assertCurrent(); for (const link of nested) assertLink(link); };
    let leaf: number | undefined;
    try {
      current();
      let parent = this.handle;
      const parts = relative.split('/');
      for (let index = 0; index < parts.length; index++) {
        const location = parent.path(parts[index]!);
        let stat: BigIntStats;
        try { stat = lstatSync(location, { bigint: true }); }
        catch (error) { if (!missing(error)) throw error; current(); return; }
        if (index < parts.length - 1) {
          directory(stat);
          const link = pinDirectory(location); nested.push(link);
          if (!sameIdentity(link.stat, stat)) changed();
          parent = link;
        } else {
          ordinaryFile(stat);
          leaf = checkedFileOpen(location, fileFlags);
          const opened = fstatSync(leaf, { bigint: true }); ordinaryFile(opened);
          if (stamp(opened) !== stamp(stat) || stamp(lstatSync(location, { bigint: true })) !== stamp(stat)) changed();
        }
      }
      current();
    } finally {
      if (leaf !== undefined) closeSync(leaf);
      for (const link of nested.reverse()) link.close();
    }
  }

  private parent<T>(relative: string, create: boolean, action: (location: string, parent: Link, current: () => void) => T): T {
    assertDocumentRelativePath(relative);
    const nested: Link[] = [];
    const current = (): void => {
      this.assertCurrent();
      for (const link of nested) assertLink(link);
    };
    try {
      this.assertCurrent();
      let parent = this.handle;
      const parts = relative.split('/'), name = parts.pop()!;
      for (const component of parts) {
        const location = parent.path(component);
        if (create) {
          try { lstatSync(location); }
          catch (error) {
            if (!missing(error)) throw error;
            writable(parent.currentStat());
            current();
            // Never recursive: every existing/new parent is independently pinned.
            try { mkdirSync(location, { mode: 0o755 }); parent.sync(); }
            catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
          }
        }
        const link = pinDirectory(location);
        nested.push(link); parent = link;
      }
      current(); writable(parent.currentStat());
      const result = action(parent.path(name), parent, current);
      current(); return result;
    } finally { for (const link of nested.reverse()) link.close(); }
  }

  /** Read-only preflight; missing relative parents are allowed, never the root. */
  assertVacant(relative: string): void {
    assertDocumentRelativePath(relative); this.assertCurrent();
    const nested: Link[] = [];
    try {
      let parent = this.handle;
      const parts = relative.split('/'), name = parts.pop()!;
      for (const component of parts) {
        const location = parent.path(component);
        let stat: BigIntStats;
        try { stat = lstatSync(location, { bigint: true }); }
        catch (error) { if (!missing(error)) throw error; writable(parent.currentStat()); for (const link of nested) assertLink(link); this.assertCurrent(); return; }
        directory(stat);
        const link = pinDirectory(location); nested.push(link); parent = link;
      }
      writable(parent.currentStat());
      try {
        const stat = lstatSync(parent.path(name), { bigint: true });
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1n)) forbidden();
      }
      catch (error) { if (!missing(error)) throw error; this.assertCurrent(); return; }
      collision();
    } finally { for (const link of nested.reverse()) link.close(); }
  }

  assertWritable(relative: string, expectedRevision: string, sourceRevision: number): DocumentSourceContent {
    const content = this.content(relative, sourceRevision, true);
    if (content.revision !== expectedRevision) conflict();
    this.parent(relative, false, () => undefined);
    return content;
  }

  write(relative: string, content: string, sourceRevision: number, expectedRevision?: string): DocumentSourceContent {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > maxRepositoryFileBytes) throw new DomainError('document_source_file_too_large', 'Markdown content exceeds the 4 MiB limit', 413, { maxBytes: maxRepositoryFileBytes });
    return this.parent(relative, expectedRevision === undefined, (location, parent, current) => {
      const temporary = parent.path(`.pm-document-${randomUUID()}.tmp`);
      let output: number | undefined;
      try {
        if (expectedRevision === undefined) this.assertVacant(relative);
        else this.assertWritable(relative, expectedRevision, sourceRevision);
        output = checkedFileOpen(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(output, bytes, offset, bytes.length - offset);
        fsyncSync(output); closeSync(output); output = undefined;
        current();
        if (expectedRevision !== undefined) {
          this.assertWritable(relative, expectedRevision, sourceRevision); current();
          renameSync(temporary, location);
        } else {
          // Exclusive publish also rejects a destination created after preflight.
          try { linkSync(temporary, location); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') collision(); throw error; }
          unlinkSync(temporary);
        }
        parent.sync(); current();
        return this.content(relative, sourceRevision, true);
      } finally {
        if (output !== undefined) closeSync(output);
        try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
      }
    });
  }

  remove(relative: string, expectedRevision: string, sourceRevision: number): void {
    this.parent(relative, false, (location, parent, current) => {
      this.assertWritable(relative, expectedRevision, sourceRevision); current();
      unlinkSync(location); parent.sync(); current();
    });
  }

  move(relative: string, expectedRevision: string, sourceRevision: number, target: DocumentSourceDirectory, targetPath: string, targetSourceRevision: number): DocumentSourceContent {
    if (samePath(path.join(this.root, relative), path.join(target.root, targetPath)))
      throw new DomainError('document_source_same_path', 'Source and destination are the same Markdown file', 409);
    const original = this.assertWritable(relative, expectedRevision, sourceRevision);
    target.assertVacant(targetPath);
    // Copy/publish before unlink works across devices and never overwrites. A
    // failure after publication is uncertain, not a fictitious filesystem rollback.
    const result = target.write(targetPath, original.content, targetSourceRevision);
    this.remove(relative, expectedRevision, sourceRevision);
    target.assertCurrent(); this.assertCurrent();
    return result;
  }
}

/** Private fsynced completion evidence survives a failed SQL receipt commit. It
 * proves an original attempt, never authorizes replay of a filesystem mutation. */
export class DocumentSourceOperationJournal {
  private readonly root: DocumentSourceDirectory;
  private readonly links: Link[] = [];
  private readonly handle: Link;
  constructor(dataRoot: string, workspaceId: string, actorId: string) {
    this.root = new DocumentSourceDirectory(path.resolve(dataRoot));
    try {
      let parent = this.root.handle;
      for (const component of ['document-source-operations', workspaceId, actorId]) {
        if (!/^[a-z0-9-]+$/.test(component)) forbidden();
        const location = parent.path(component);
        this.assertCurrent();
        try { mkdirSync(location, { mode: 0o700 }); makePrivatePath(location); parent.sync(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const link = pinDirectory(location);
        try { assertPrivatePath(location); } catch (error) { link.close(); throw error; }
        this.links.push(link); parent = link;
      }
      this.handle = parent; this.assertCurrent();
    } catch (error) { this.close(); throw error; }
  }
  private assertCurrent(): void {
    this.root.assertCurrent();
    for (const link of this.links) assertLink(link);
  }
  private readEvidence(operationId: string, suffix: string): unknown | undefined {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) forbidden();
    this.assertCurrent();
    const location = this.handle.path(`${operationId}${suffix}.json`);
    let fd: number;
    try { fd = checkedFileOpen(location, fileFlags); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    try {
      const stat = fstatSync(fd, { bigint: true }); ordinaryFile(stat);
      if (stat.size > 32n * 1024n * 1024n) forbidden();
      assertPrivatePath(location);
      const bytes = Buffer.alloc(Number(stat.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) changed();
        offset += count;
      }
      if (stamp(fstatSync(fd, { bigint: true })) !== stamp(stat) || stamp(lstatSync(location, { bigint: true })) !== stamp(stat)) changed();
      const proof: unknown = JSON.parse(bytes.toString('utf8'));
      this.assertCurrent(); return proof;
    } finally { closeSync(fd); }
  }
  read(operationId: string, requestHash: string): DocumentSourceMutationReceipt | undefined {
    const evidence = this.readEvidence(operationId, '');
    if (evidence === undefined) return undefined;
    const proof = operationProofSchema.parse(evidence);
    if (proof.requestHash !== requestHash) throw new DomainError('document_source_operation_id_conflict', 'The original operation identity conflicts with its durable evidence', 409);
    if (proof.receipt.operationId !== operationId || proof.receipt.status !== 'succeeded') changed();
    return proof.receipt;
  }
  readHistory(operationId: string, requestHash: string): ExternalDocumentHistoryPrepared | undefined {
    const evidence = this.readEvidence(operationId, '.history');
    if (evidence === undefined) return undefined;
    const proof = operationHistorySchema.parse(evidence);
    if (proof.requestHash !== requestHash || proof.capture.operationId !== operationId) throw new DomainError('document_source_operation_id_conflict', 'The original history identity conflicts with its durable evidence', 409);
    return proof.capture;
  }
  /** Prepared bytes are not a change: publication also requires original success proof. */
  prepareHistory(operationId: string, requestHash: string, capture: ExternalDocumentHistoryPrepared): void {
    this.recordEvidence(operationId, '.history', { requestHash, capture: externalDocumentHistoryPreparedSchema.parse(capture) });
  }
  record(operationId: string, requestHash: string, receipt: DocumentSourceMutationReceipt): void {
    this.recordEvidence(operationId, '', { requestHash, receipt });
  }
  private recordEvidence(operationId: string, suffix: string, evidence: unknown): void {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) forbidden();
    this.assertCurrent();
    const temporary = this.handle.path(`.${randomUUID()}.tmp`);
    const location = this.handle.path(`${operationId}${suffix}.json`);
    let fd: number | undefined;
    try {
      fd = checkedFileOpen(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      makePrivatePath(temporary);
      const bytes = Buffer.from(JSON.stringify(evidence));
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd); closeSync(fd); fd = undefined; this.assertCurrent();
      linkSync(temporary, location); unlinkSync(temporary); this.handle.sync(); this.assertCurrent();
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
    }
  }
  close(): void {
    for (const link of this.links.reverse()) link.close();
    this.links.length = 0; this.root.close();
  }
}

/** Translate filesystem errors without returning host paths or OS error messages. */
export function documentSourceFileError(error: unknown, readingFile = false): never {
  if (error instanceof DomainError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (readingFile && code === 'ENOENT') throw new DomainError('document_source_file_not_found', 'The Markdown file no longer exists', 404);
  if (forbiddenPathCodes.includes(code ?? '')) forbidden();
  throw new DomainError('document_source_unavailable', 'The source directory is missing or unreadable; no fallback is used', 409, { reason: 'directory_unavailable' });
}
