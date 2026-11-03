import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, linkSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ProjectLocations, assertProjectFile } from './project-locations.ts';
import { checkedFileOpen, directoryIdentity, fileStamp, pathContains, safeRelativePath, sameFileIdentity, samePath, syncDirectory } from './platform.ts';
import { assertNoWindowsReparsePath, cacheWindowsPathAttributes } from './windows-reparse.ts';

export const revisionOf = (raw: string): string => createHash('sha256').update(raw).digest('hex');
export const maxRepositoryFileBytes = 4 * 1024 * 1024;
export type DiskError = { path: string; message: string };
export type DiskFile = { path: string; raw: string };
export interface RepositoryCollection { files: DiskFile[]; views: DiskFile[]; errors: DiskError[] }

/** All paths are workspace-relative; links are rejected before opening or replacing files. */
export class FileRepository {
  readonly root: string;
  private readonly locations?: ProjectLocations;
  private readonly validateStorage: (() => void) | undefined;
  private rootIdentity: BigIntStats | undefined;

  constructor(root: string, mounted = true, validateStorage?: () => void) {
    this.root = path.resolve(root);
    this.validateStorage = validateStorage;
    if (mounted) this.locations = new ProjectLocations(this.root);
  }

  init(): void {
    if (this.rootIdentity) this.assertRoot();
    mkdirSync(this.root, { recursive: true });
    this.assertRoot();
    this.mkdir('.pm');
    this.mkdir('.pm/cache');
    this.mkdir('.pm/views');
    this.mkdir('.pm/state');
  }

  private assertRoot(): void {
    const stat = directoryIdentity(this.root);
    if (this.rootIdentity && !sameFileIdentity(this.rootIdentity, stat)) throw new Error('Workspace directory was replaced');
    this.rootIdentity ??= stat;
  }

  private projectPath(relative: string): { repository: FileRepository; relative: string } | undefined {
    const namespace = relative.split('/')[0]!;
    if (process.platform !== 'linux' && namespace.toLowerCase() === 'project-roots' && namespace !== 'project-roots') throw new Error('Unsafe virtual project path alias');
    if (relative !== 'project-roots' && !relative.startsWith('project-roots/')) return undefined;
    const [, projectId, ...parts] = relative.split('/');
    if (!projectId || !/^PRJ-\d+$/.test(projectId) || !parts.length || !safeRelativePath(parts.join('/')) || parts.some(part => part.toLowerCase() === '.pm')) throw new Error('Unsafe virtual project path');
    try {
      const mount = this.locations?.route(projectId);
      if (!mount) throw new Error('Unregistered project');
      return { repository: new FileRepository(mount.corePath, false, () => { this.locations!.route(projectId); }), relative: parts.join('/') };
    } catch (error) { throw this.projectError(error, relative); }
  }
  private projectError(error: unknown, relative: string): Error {
    if (error instanceof RepositoryConflict) return error;
    const failure = new Error(`Registered project file is unsafe or unavailable: ${relative}`) as NodeJS.ErrnoException;
    const code = (error as NodeJS.ErrnoException).code;
    if (code) failure.code = code;
    return failure;
  }

  resolve(relative: string, allowMissing = false): string {
    this.validateStorage?.();
    if (!safeRelativePath(relative)) throw new Error('Unsafe workspace path');
    const project = this.projectPath(relative);
    if (project) {
      try { return project.repository.resolve(project.relative, allowMissing); }
      catch (error) { throw this.projectError(error, relative); }
    }
    const target = path.resolve(this.root, relative);
    if (!pathContains(this.root, target) || target === this.root) throw new Error('Path escapes workspace');
    this.assertRoot();
    let current = this.root;
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]!);
      try {
        const stat = lstatSync(current, { bigint: true });
        if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${relative}`);
        if (process.platform !== 'linux' && !samePath(realpathSync(current), current)) throw new Error(`Reparse aliases are not allowed: ${relative}`);
        if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Only regular files and directories are allowed: ${relative}`);
        assertNoWindowsReparsePath(current, stat);
        if (stat.isFile() && stat.nlink > 1n) throw new Error(`Hard-linked files are not allowed: ${relative}`);
        if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Not a directory: ${relative}`);
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return target;
        throw error;
      }
    }
    return target;
  }

  mkdir(relative: string): void {
    const project = this.projectPath(relative);
    if (project) {
      try { project.repository.mkdir(project.relative); return; }
      catch (error) { throw this.projectError(error, relative); }
    }
    const target = this.resolve(relative, true);
    const firstCreated = mkdirSync(target, { recursive: true });
    this.resolve(relative);
    if (firstCreated !== undefined) {
      // Persist every new directory entry before a journal may reference its files.
      const parent = path.dirname(firstCreated);
      let directory = target;
      for (;;) {
        syncDirectory(directory);
        if (directory === parent) break;
        directory = path.dirname(directory);
      }
    }
  }

  read(relative: string): string {
    const project = this.projectPath(relative);
    if (project) {
      try { return project.repository.read(project.relative); }
      catch (error) { throw this.projectError(error, relative); }
    }
    const filename = this.resolve(relative);
    const fd = checkedFileOpen(filename, constants.O_RDONLY);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink > 1) throw new Error(`Only regular, unlinked workspace files are allowed: ${relative}`);
      // Durable state embeds a recovery journal and may exceed the Markdown content limit.
      if (!['.pm/state/state.json', '.pm/state/project-locations.json', '.pm/state/service-observations.json', '.pm/state/pm-command-journal.ndjson'].includes(relative) && stat.size > maxRepositoryFileBytes) throw new Error(`File exceeds the 4 MiB limit: ${relative}`);
      const before = fileStamp(fstatSync(fd, { bigint: true }));
      const raw = readFileSync(fd, 'utf8');
      if (fileStamp(fstatSync(fd, { bigint: true })) !== before || fileStamp(lstatSync(filename, { bigint: true })) !== before) throw new RepositoryConflict('File changed while reading');
      this.resolve(relative);
      return raw;
    } finally {
      closeSync(fd);
    }
  }

  collect(): RepositoryCollection {
    const files: DiskFile[] = [];
    const views: DiskFile[] = [];
    const errors: DiskError[] = [];
    const walk = (directory: string): void => {
      let entries;
      try {
        if (!directory) this.assertRoot();
        const absolute = directory ? this.resolve(directory) : this.root;
        entries = readdirSync(absolute, { withFileTypes: true });
        if (process.platform === 'win32') cacheWindowsPathAttributes(entries.map(entry => path.join(absolute, entry.name)));
      } catch (error) {
        errors.push({ path: directory || '.', message: (error as Error).message });
        return;
      }
      const retired = this.locations?.retiredPaths() ?? new Set<string>();
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if ((process.platform === 'linux' ? relative : relative.toLowerCase()) === 'project-roots') { errors.push({ path: relative, message: 'Physical files cannot occupy the virtual project mount namespace' }); continue; }
        if (entry.name.startsWith('.pm-write-') || relative === '.pm/cache' || relative === '.pm/state' || retired.has(relative)) continue;
        if (entry.isSymbolicLink()) {
          errors.push({ path: relative, message: 'Symbolic links are not allowed in the workspace' });
        } else if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') || relative === '.pm' || relative === '.pm/views') walk(relative);
        } else if (entry.isFile() && (/\.md$/i.test(entry.name) && !relative.startsWith('.pm/') || relative.startsWith('.pm/views/') && /\.ya?ml$/i.test(entry.name))) {
          try {
            const file = { path: relative, raw: this.read(relative) };
            (relative.startsWith('.pm/views/') ? views : files).push(file);
          } catch (error) {
            errors.push({ path: relative, message: (error as Error).message });
          }
        }
      }
    };
    walk('');
    for (const location of this.locations?.list() ?? []) {
      const prefix = location.virtualPrefix;
      try {
        const mounted = this.locations!.route(location.projectId);
        const core = new FileRepository(mounted.corePath, false).collect();
        for (const file of core.files) {
          try { assertProjectFile(location.projectId, file.raw); files.push({ path: `${prefix}/${file.path}`, raw: file.raw }); }
          catch { errors.push({ path: `${prefix}/${file.path}`, message: 'File does not belong to its registered project' }); }
        }
        for (const error of core.errors) errors.push({ path: `${prefix}/${error.path}`, message: 'Registered project source is unsafe or unavailable' });
      } catch { errors.push({ path: prefix, message: 'Registered project storage is unavailable or requires recovery' }); }
    }
    return { files, views, errors };
  }

  /** A synchronous final revision check immediately precedes atomic replacement. */
  write(relative: string, raw: string, expectedRevision?: string): void {
    const projectId = /^project-roots\/(PRJ-\d+)\//.exec(relative)?.[1];
    if (projectId) assertProjectFile(projectId, raw);
    const project = this.projectPath(relative);
    if (project) {
      try { project.repository.write(project.relative, raw, expectedRevision); return; }
      catch (error) { throw this.projectError(error, relative); }
    }
    const filename = this.resolve(relative, true);
    const directory = path.posix.dirname(relative);
    if (directory !== '.') this.resolve(directory);
    const temporary = path.join(path.dirname(filename), `.pm-write-${randomUUID()}`);
    let fd: number | undefined;
    try {
      fd = checkedFileOpen(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeFileSync(fd, raw, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.resolve(relative, true);
      if (expectedRevision !== undefined) {
        let actual: string;
        try { actual = revisionOf(this.read(relative)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RepositoryConflict('File disappeared or is no longer safe to write');
          throw error;
        }
        if (actual !== expectedRevision) throw new RepositoryConflict('File changed on disk');
        renameSync(temporary, filename);
      } else {
        // A hard-link publish is exclusive: a simultaneous external creator cannot be overwritten.
        try { linkSync(temporary, filename); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RepositoryConflict('File already exists');
          throw error;
        }
        unlinkSync(temporary);
      }
      syncDirectory(path.dirname(filename));
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  /** A deletion is revision-checked and directory-synced just like a replacement. */
  remove(relative: string, expectedRevision: string): void {
    const project = this.projectPath(relative);
    if (project) {
      try { project.repository.remove(project.relative, expectedRevision); return; }
      catch (error) { throw this.projectError(error, relative); }
    }
    const filename = this.resolve(relative);
    if (revisionOf(this.read(relative)) !== expectedRevision) throw new RepositoryConflict('File changed on disk');
    unlinkSync(filename);
    syncDirectory(path.dirname(filename));
  }
}

export class RepositoryConflict extends Error {}
