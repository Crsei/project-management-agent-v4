import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, readdirSync, readSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { FileRepository, revisionOf } from './repository.ts';
import { inspectFrontmatter } from '../pm-markdown/index.ts';
import { assertCanonicalAbsolute, checkedFileOpen, directoryIdentity, fileStamp, pathContains, safeRelativePath, syncDirectory, systemStoragePath } from './platform.ts';
import { cacheWindowsPathAttributes } from './windows-reparse.ts';

export interface ProjectDirectory { workspaceId: string; root: string; mode?: 'existing' | 'new' }
export interface ProjectRootIdentity { device: string; inode: string }
export interface ProjectDirectoryCheck { root: string; mode: 'existing' | 'new'; identity?: ProjectRootIdentity; parentIdentity?: ProjectRootIdentity }
export interface ProjectMount {
  projectId: string; workspaceId: string; storageId: string; root: string;
  corePath: string; attachmentsPath: string; virtualPrefix: string;
}
export interface ProjectLocation extends ProjectMount {
  status: 'initializing' | 'ready' | 'moving';
  initialization: { key: string; hash: string; step: 'reserved' | 'directory' | 'marker' | 'content' | 'ready' };
}
type RootIdentity = ProjectRootIdentity;
interface Target { root: string; mode: 'existing' | 'new'; identity?: RootIdentity; parentIdentity?: RootIdentity; attempted?: boolean }
interface TransferFile { source: string; destination: string; revision: string; attachment?: boolean }
interface Transfer {
  key: string; hash: string; phase: 'copying' | 'cutover'; source?: { root: string; identity: RootIdentity };
  target: Target; files: TransferFile[];
}
interface Entry {
  projectId: string; workspaceId: string; storageId: string; root: string; mode: 'existing' | 'new';
  identity?: RootIdentity; parentIdentity?: RootIdentity; rootAttempted?: boolean; initialization: ProjectLocation['initialization']; transfer?: Transfer;
  completedTransfers?: { key: string; hash: string }[];
}
interface Registry { version: 1; entries: Entry[] }
interface Marker { version: 1; workspaceId: string; projectId: string; storageId: string; core: '.pm/core'; attachments: '.pm/attachments' }
export const projectLocationsPath = '.pm/state/project-locations.json';
const projectIdPattern = /^PRJ-\d+$/;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameIdentity = (a: RootIdentity | undefined, b: RootIdentity): boolean => a?.device === b.device && a.inode === b.inode;
const overlaps = (a: string, b: string): boolean => pathContains(a, b) || pathContains(b, a);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safeRelative = safeRelativePath;
function identity(root: string): RootIdentity {
  const stat = directoryIdentity(root);
  return { device: String(stat.dev), inode: String(stat.ino) };
}
function assertAllowedRoot(root: string): void {
  assertCanonicalAbsolute(root);
  if (systemStoragePath(root)) throw new Error('System directories cannot store projects');
}
function validateRoot(root: string, allowMissing = false): string {
  assertAllowedRoot(root);
  let current = path.parse(root).root;
  const parts = root.slice(current.length).split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    try { identity(current); }
    catch (error) { if (allowMissing && i === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return root; throw error; }
    if (i < parts.length - 1) {
      try { new FileRepository(current, false).resolve('.pm/project.json'); throw new Error('Project directories cannot be nested inside another marked project'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return root;
}
const markerFor = (entry: Entry): Marker => ({ version: 1, workspaceId: entry.workspaceId, projectId: entry.projectId, storageId: entry.storageId, core: '.pm/core', attachments: '.pm/attachments' });
const markerRaw = (entry: Entry): string => JSON.stringify(markerFor(entry), null, 2) + '\n';
function mount(entry: Entry): ProjectMount {
  return { projectId: entry.projectId, workspaceId: entry.workspaceId, storageId: entry.storageId, root: entry.root,
    corePath: path.join(entry.root, '.pm/core'), attachmentsPath: path.join(entry.root, '.pm/attachments'), virtualPrefix: `project-roots/${entry.projectId}` };
}
function validateMarker(entry: Entry): void {
  validateRoot(entry.root);
  if (!sameIdentity(entry.identity, identity(entry.root))) throw new Error('Registered project directory was replaced');
  const repository = new FileRepository(entry.root, false);
  const value: unknown = JSON.parse(repository.read('.pm/project.json'));
  if (!object(value) || Object.keys(value).length !== 6 || JSON.stringify(value) !== JSON.stringify(markerFor(entry))) throw new Error('Project directory marker conflicts with registered identity');
  repository.resolve('.pm/core');
  repository.resolve('.pm/attachments');
}

/** The workspace remains the only identity/configuration/state authority. This is a physical mount table, not another Workspace. */
export class ProjectLocations {
  private repository: FileRepository;
  constructor(workspaceRoot: string) { this.repository = new FileRepository(workspaceRoot, false); }
  private load(): { value: Registry; revision?: string } {
    let raw: string;
    try { raw = this.repository.read(projectLocationsPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: { version: 1, entries: [] } }; throw error; }
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.version !== 1 || !Array.isArray(value.entries)) throw new Error('Invalid project location registry');
    const projects = new Set<string>(), stores = new Set<string>(), keys = new Set<string>();
    const roots: string[] = [];
    const validIdentity = (item: unknown): item is RootIdentity => object(item) && typeof item.device === 'string' && /^\d+$/.test(item.device) && typeof item.inode === 'string' && /^\d+$/.test(item.inode);
    for (const item of value.entries) {
      if (!object(item) || typeof item.projectId !== 'string' || !projectIdPattern.test(item.projectId) || typeof item.workspaceId !== 'string' || !item.workspaceId
        || typeof item.storageId !== 'string' || !/^[a-f0-9-]{36}$/.test(item.storageId) || typeof item.root !== 'string' || !path.isAbsolute(item.root) || path.resolve(item.root) !== item.root
        || !['existing', 'new'].includes(String(item.mode)) || item.identity !== undefined && !validIdentity(item.identity) || item.parentIdentity !== undefined && !validIdentity(item.parentIdentity)
        || !object(item.initialization) || typeof item.initialization.key !== 'string' || !item.initialization.key || typeof item.initialization.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.initialization.hash)
        || !['reserved', 'directory', 'marker', 'content', 'ready'].includes(String(item.initialization.step)) || item.initialization.step === 'ready' && !item.identity)
        throw new Error('Invalid project location entry');
      assertAllowedRoot(item.root);
      if (projects.has(item.projectId) || stores.has(item.storageId) || keys.has(item.initialization.key) || roots.some(root => overlaps(root, item.root as string))) throw new Error('Overlapping or duplicate project location entries');
      if (overlaps(this.repository.root, item.root)) throw new Error('Project directory overlaps workspace storage');
      if (item.rootAttempted !== undefined && typeof item.rootAttempted !== 'boolean' || item.completedTransfers !== undefined && (!Array.isArray(item.completedTransfers) || item.completedTransfers.some(operation => !object(operation) || typeof operation.key !== 'string' || !operation.key || typeof operation.hash !== 'string' || !/^[a-f0-9]{64}$/.test(operation.hash)))) throw new Error('Invalid project operation history');
      projects.add(item.projectId); stores.add(item.storageId); keys.add(item.initialization.key); roots.push(item.root);
      if (item.transfer !== undefined) {
        const move = item.transfer;
        if (!object(move) || typeof move.key !== 'string' || !move.key || typeof move.hash !== 'string' || !/^[a-f0-9]{64}$/.test(move.hash)
          || !['copying', 'cutover'].includes(String(move.phase)) || !object(move.target) || typeof move.target.root !== 'string' || !path.isAbsolute(move.target.root)
          || path.resolve(move.target.root) !== move.target.root || !['new', 'existing'].includes(String(move.target.mode)) || move.target.identity !== undefined && !validIdentity(move.target.identity) || move.target.parentIdentity !== undefined && !validIdentity(move.target.parentIdentity)
          || !Array.isArray(move.files) || move.files.some(file => !object(file) || typeof file.source !== 'string' || !safeRelative(file.source) || typeof file.destination !== 'string' || !safeRelative(file.destination) || typeof file.revision !== 'string' || !/^[a-f0-9]{64}$/.test(file.revision) || file.attachment !== undefined && typeof file.attachment !== 'boolean')
          || move.source !== undefined && (!object(move.source) || typeof move.source.root !== 'string' || !path.isAbsolute(move.source.root) || !validIdentity(move.source.identity))) throw new Error('Invalid project transfer journal');
        assertAllowedRoot(move.target.root);
        if (object(move.source) && typeof move.source.root === 'string') assertAllowedRoot(move.source.root);
        for (const file of move.files as TransferFile[]) {
          if (file.attachment ? !move.source || !file.source.startsWith('.pm/attachments/') || file.destination !== file.source : !/\.md$/i.test(file.destination) || file.destination.startsWith('.pm/') || file.destination.startsWith('project-roots/') || file.source !== (move.source ? `project-roots/${item.projectId}/${file.destination}` : file.destination)) throw new Error('Unsafe project transfer file');
        }
        if (new Set((move.files as TransferFile[]).map(file => file.source)).size !== move.files.length || new Set((move.files as TransferFile[]).map(file => file.destination)).size !== move.files.length) throw new Error('Duplicate project transfer manifest file');
      }
    }
    if (new Set(value.entries.map(item => (item as Entry).workspaceId)).size > 1) throw new Error('Foreign workspace project location');
    const entries = value.entries as Entry[];
    for (const entry of entries) if (entry.transfer?.phase === 'copying') {
      const target = entry.transfer.target.root;
      if (overlaps(this.repository.root, target) || entries.some(other => other === entry && !entry.transfer!.source ? false : overlaps(other.root, target))) throw new Error('Overlapping transfer target');
    }
    return { value: { version: 1, entries }, revision: revisionOf(raw) };
  }
  private update(change: (entries: Entry[]) => void): void {
    const { value, revision } = this.load();
    change(value.entries);
    this.repository.write(projectLocationsPath, JSON.stringify(value, null, 2) + '\n', revision);
  }
  list(): ProjectLocation[] {
    return this.load().value.entries.map(entry => ({ ...mount(entry), status: entry.transfer ? 'moving' : entry.initialization.step === 'ready' ? 'ready' : 'initializing', initialization: { ...entry.initialization } }));
  }
  entry(projectId: string): ProjectLocation | undefined { return this.list().find(entry => entry.projectId === projectId); }
  get(projectId: string): ProjectMount | null {
    const entry = this.load().value.entries.find(item => item.projectId === projectId);
    if (!entry) return null;
    if (entry.initialization.step !== 'ready' || entry.transfer) throw new Error('Project storage initialization or transfer requires recovery');
    validateMarker(entry);
    return mount(entry);
  }
  mounts(): ProjectMount[] { return this.load().value.entries.map(entry => this.get(entry.projectId)!); }
  assertSettled(): void { if (this.load().value.entries.some(entry => entry.transfer || entry.initialization.step !== 'ready')) throw new Error('Project storage operation requires recovery'); }
  /** Available only to repository routing; incomplete initialization may read its exact registered root, never create it. */
  route(projectId: string): ProjectMount {
    const entry = this.load().value.entries.find(item => item.projectId === projectId);
    if (!entry || !entry.identity || !['marker', 'content', 'ready'].includes(entry.initialization.step)) throw new Error('Project storage is not available');
    validateMarker(entry);
    return mount(entry);
  }
  retiredPaths(): Set<string> {
    return new Set(this.load().value.entries.flatMap(entry => entry.transfer?.phase === 'cutover' && !entry.transfer.source ? entry.transfer.files.map(file => file.source) : []));
  }
  preview(directory: ProjectDirectory, projectId?: string): ProjectDirectoryCheck {
    if (!directory.workspaceId || directory.workspaceId.length > 256) throw new Error('Workspace identity is required');
    const mode = directory.mode ?? 'existing';
    if (mode !== 'existing' && mode !== 'new') throw new Error('Invalid project directory mode');
    const root = validateRoot(directory.root, mode === 'new');
    if (mode === 'new') {
      try { lstatSync(root); throw new Error('New project directory already exists'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const entries = this.load().value.entries;
    if (entries.some(entry => entry.workspaceId !== directory.workspaceId)) throw new Error('Foreign workspace directory registration');
    if (overlaps(root, this.repository.root) || entries.some(entry => entry.projectId !== projectId && (overlaps(root, entry.root) || entry.transfer && overlaps(root, entry.transfer.target.root)))) throw new Error('Project directories must not overlap registered storage');
    if (projectId && entries.some(entry => entry.projectId === projectId && overlaps(root, entry.root))) throw new Error('Project destination overlaps current directory');
    try { new FileRepository(root, false).resolve('.pm'); throw new Error('Directory already contains application metadata'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { root, mode, ...(mode === 'existing' ? { identity: identity(root) } : { parentIdentity: identity(path.dirname(root)) }) };
  }
  reserve(projectId: string, key: string, requestHash: string, directory: ProjectDirectory, expected?: ProjectDirectoryCheck): ProjectLocation {
    if (!projectIdPattern.test(projectId) || !key.trim() || key.length > 512 || !/^[a-f0-9]{64}$/.test(requestHash)) throw new Error('Invalid project initialization reservation');
    const existing = this.load().value.entries.find(item => item.projectId === projectId || item.initialization.key === key);
    if (existing) {
      if (existing.projectId !== projectId || existing.initialization.key !== key || existing.initialization.hash !== requestHash || existing.root !== directory.root || existing.workspaceId !== directory.workspaceId || existing.mode !== (directory.mode ?? 'existing')) throw new Error('Project initialization conflicts with its original request');
      return this.entry(projectId)!;
    }
    const checked = this.preview(directory);
    if (expected && (expected.root !== checked.root || expected.mode !== checked.mode || !(checked.mode === 'existing' ? sameIdentity(expected.identity, checked.identity!) : sameIdentity(expected.parentIdentity, checked.parentIdentity!)))) throw new Error('Project directory changed after preflight');
    this.update(entries => { entries.push({ projectId, workspaceId: directory.workspaceId, storageId: randomUUID(), ...checked, initialization: { key, hash: requestHash, step: 'reserved' } }); });
    return this.entry(projectId)!;
  }
  prepare(projectId: string): void {
    let entry = this.load().value.entries.find(item => item.projectId === projectId);
    if (!entry) throw new Error('Project directory was not reserved');
    if (entry.initialization.step === 'ready') { validateMarker(entry); return; }
    if (entry.initialization.step === 'reserved') {
      if (entry.mode === 'existing') {
        validateRoot(entry.root);
        if (!sameIdentity(entry.identity, identity(entry.root))) throw new Error('Reserved project directory was replaced');
      } else if (!entry.rootAttempted) {
        validateRoot(entry.root, true);
        if (!sameIdentity(entry.parentIdentity, identity(path.dirname(entry.root)))) throw new Error('Reserved project parent directory was replaced');
        this.update(entries => { entries.find(item => item.projectId === projectId)!.rootAttempted = true; });
        mkdirSync(entry.root, { mode: 0o700 }); syncDirectory(path.dirname(entry.root));
      } else {
        // A missing attempted root is an unknown result, never permission to recreate an empty project.
        validateRoot(entry.root);
        if (new FileRepository(entry.root, false).read('.pm/project.json') !== markerRaw(entry)) throw new Error('Attempted project directory requires identity recovery');
      }
      const found = identity(entry.root);
      this.update(entries => { const current = entries.find(item => item.projectId === projectId)!; current.identity = found; current.initialization.step = 'directory'; });
      entry = this.load().value.entries.find(item => item.projectId === projectId)!;
    }
    validateRoot(entry.root);
    if (!sameIdentity(entry.identity, identity(entry.root))) throw new Error('Reserved project directory was replaced');
    const repository = new FileRepository(entry.root, false);
    if (entry.initialization.step === 'directory') {
      repository.mkdir('.pm');
      try { if (repository.read('.pm/project.json') !== markerRaw(entry)) throw new Error('Conflicting project marker'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; repository.write('.pm/project.json', markerRaw(entry)); }
      repository.mkdir('.pm/core'); repository.mkdir('.pm/core/projects'); repository.mkdir('.pm/core/work-items'); repository.mkdir('.pm/core/docs'); repository.mkdir('.pm/attachments');
      this.update(entries => { entries.find(item => item.projectId === projectId)!.initialization.step = 'marker'; });
    }
    validateMarker(this.load().value.entries.find(item => item.projectId === projectId)!);
  }
  contentWritten(projectId: string): void { this.update(entries => { const entry = entries.find(item => item.projectId === projectId)!; validateMarker(entry); entry.initialization.step = 'content'; }); }
  finish(projectId: string): ProjectMount {
    this.update(entries => { const entry = entries.find(item => item.projectId === projectId)!; validateMarker(entry); if (!['content', 'ready'].includes(entry.initialization.step)) throw new Error('Project content is incomplete'); entry.initialization.step = 'ready'; });
    return this.get(projectId)!;
  }
  watchPaths(): string[] { return this.load().value.entries.flatMap(entry => [path.join(entry.root, '.pm/core'), path.join(entry.root, '.pm/project.json')]); }

  /** The operator already moved the complete directory. Only an absent original and matching marker authorize rebinding. */
  rebindMoved(projectId: string, key: string, directory: ProjectDirectory, validate: (files: { path: string; raw: string }[]) => void): ProjectMount {
    const entry = this.load().value.entries.find(item => item.projectId === projectId);
    if (!entry || entry.transfer || entry.initialization.step !== 'ready') throw new Error('Project is not settled for rebinding');
    const operationHash = hash({ projectId, directory: { workspaceId: directory.workspaceId, root: directory.root, mode: 'existing' }, rebind: true });
    const completed = entry.completedTransfers?.find(operation => operation.key === key);
    if (completed) { if (completed.hash !== operationHash) throw new Error('Rebind key conflicts with its original request'); return this.get(projectId)!; }
    try { lstatSync(entry.root); throw new Error('Original project directory still exists; rebinding would create duplicate authority'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (directory.workspaceId !== entry.workspaceId || (directory.mode ?? 'existing') !== 'existing') throw new Error('Moved project identity conflicts with registration');
    const root = validateRoot(directory.root);
    const entries = this.load().value.entries;
    if (overlaps(root, this.repository.root) || entries.some(other => other.projectId !== projectId && overlaps(root, other.root))) throw new Error('Moved directory overlaps registered storage');
    const rebound = { ...entry, root, identity: identity(root) };
    validateMarker(rebound);
    const collected = new FileRepository(path.join(root, '.pm/core'), false).collect();
    if (collected.errors.length || !collected.files.some(file => inspectFrontmatter(file.raw).metadata.id === projectId)) throw new Error('Moved project authority is incomplete');
    for (const file of collected.files) assertProjectFile(projectId, file.raw);
    validate(collected.files.map(file => ({ ...file, path: `project-roots/${projectId}/${file.path}` })));
    const final = new FileRepository(path.join(root, '.pm/core'), false).collect();
    if (final.errors.length || final.files.length !== collected.files.length || final.files.some(file => !collected.files.some(before => before.path === file.path && before.raw === file.raw))) throw new Error('Moved project changed during verification');
    this.update(current => {
      validateMarker(rebound);
      try { lstatSync(entry.root); throw new Error('Original project directory reappeared before rebind commit'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const location = current.find(item => item.projectId === projectId)!;
      location.root = root; location.identity = rebound.identity;
      location.completedTransfers = [...(location.completedTransfers ?? []), { key, hash: operationHash }];
    });
    return this.get(projectId)!;
  }

  /** Stopped/serialized transfer: journal before copying, verify before cutover, then remove only the exact old authority bytes. */
  transfer(projectId: string, key: string, directory: ProjectDirectory, sources: { path: string; raw: string }[], relocate: boolean): ProjectMount {
    const operationHash = hash({ projectId, directory: { workspaceId: directory.workspaceId, root: directory.root, mode: directory.mode ?? 'existing' }, relocate });
    let entry = this.load().value.entries.find(item => item.projectId === projectId);
    if (entry?.transfer) {
      if (entry.transfer.key !== key || entry.transfer.hash !== operationHash) throw new Error('A different project transfer requires recovery');
    } else {
      const completed = entry?.completedTransfers?.find(operation => operation.key === key);
      if (completed) { if (completed.hash !== operationHash) throw new Error('Transfer key conflicts with its original request'); return this.get(projectId)!; }
      if (relocate !== !!entry) throw new Error(relocate ? 'Project is not registered for relocation' : 'Project already uses registered storage');
      const target = this.preview(directory, projectId);
      if (entry) validateMarker(entry);
      for (const source of sources) {
        if (!safeRelative(source.path) || source.path.startsWith('.pm/') || !/\.md$/i.test(source.path) || source.path.startsWith('project-roots/') && !source.path.startsWith(`project-roots/${projectId}/`)) throw new Error('Unsafe project transfer source');
        assertProjectFile(projectId, source.raw);
      }
      if (new Set(sources.map(source => source.path)).size !== sources.length) throw new Error('Duplicate project transfer source');
      const files: TransferFile[] = sources.map(source => ({ source: source.path, destination: source.path.startsWith(`project-roots/${projectId}/`) ? source.path.slice(`project-roots/${projectId}/`.length) : source.path, revision: revisionOf(source.raw) }));
      if (!files.length) throw new Error('Project has no readable authority to transfer');
      if (entry) {
        const attachmentRepository = new FileRepository(entry.root, false);
        const walk = (relative: string): void => {
          const directory = attachmentRepository.resolve(relative);
          const entries = readdirSync(directory, { withFileTypes: true });
          if (process.platform === 'win32') cacheWindowsPathAttributes(entries.map(item => path.join(directory, item.name)));
          for (const item of entries) {
            if (item.name.startsWith('.pm-write-')) continue;
            const file = `${relative}/${item.name}`;
            if (item.isDirectory()) walk(file);
            else if (item.isFile()) files.push({ source: file, destination: file, revision: binaryRevision(attachmentRepository.resolve(file)), attachment: true });
            else throw new Error('Unsafe project attachment');
          }
        };
        walk('.pm/attachments');
      }
      const transfer: Transfer = { key, hash: operationHash, phase: 'copying', ...(entry ? { source: { root: entry.root, identity: entry.identity! } } : {}), target: { ...target, ...(target.mode === 'existing' ? { identity: identity(target.root) } : { parentIdentity: identity(path.dirname(target.root)) }) }, files };
      this.update(entries => {
        if (entry) entries.find(item => item.projectId === projectId)!.transfer = transfer;
        else entries.push({ projectId, workspaceId: directory.workspaceId, storageId: randomUUID(), root: target.root, mode: target.mode, initialization: { key, hash: operationHash, step: 'reserved' }, transfer });
      });
    }
    entry = this.load().value.entries.find(item => item.projectId === projectId)!;
    let move = entry.transfer!;
    if (move.phase === 'copying') {
      if (!move.target.identity) {
        if (!move.target.attempted) {
          validateRoot(move.target.root, move.target.mode === 'new');
          if (!sameIdentity(move.target.parentIdentity, identity(path.dirname(move.target.root)))) throw new Error('Transfer parent directory was replaced');
          this.update(entries => { entries.find(item => item.projectId === projectId)!.transfer!.target.attempted = true; });
          if (move.target.mode === 'new') { mkdirSync(move.target.root, { mode: 0o700 }); syncDirectory(path.dirname(move.target.root)); }
        } else {
          validateRoot(move.target.root);
          if (new FileRepository(move.target.root, false).read('.pm/project.json') !== markerRaw(entry)) throw new Error('Attempted transfer destination requires identity recovery');
        }
        const found = identity(move.target.root);
        this.update(entries => { entries.find(item => item.projectId === projectId)!.transfer!.target.identity = found; });
        entry = this.load().value.entries.find(item => item.projectId === projectId)!; move = entry.transfer!;
      }
      const targetEntry: Entry = { ...entry, root: move.target.root, identity: move.target.identity!, mode: move.target.mode };
      validateRoot(targetEntry.root);
      if (!sameIdentity(targetEntry.identity, identity(targetEntry.root))) throw new Error('Transfer destination was replaced');
      const targetRepository = new FileRepository(targetEntry.root, false);
      targetRepository.mkdir('.pm');
      try { if (targetRepository.read('.pm/project.json') !== markerRaw(entry)) throw new Error('Conflicting transfer destination marker'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; targetRepository.write('.pm/project.json', markerRaw(entry)); }
      targetRepository.mkdir('.pm/core/projects'); targetRepository.mkdir('.pm/core/work-items'); targetRepository.mkdir('.pm/core/docs'); targetRepository.mkdir('.pm/attachments');
      const sourceRepository = move.source ? new FileRepository(move.source.root, false) : this.repository;
      if (move.source) { if (!sameIdentity(move.source.identity, identity(move.source.root))) throw new Error('Transfer source was replaced'); validateMarker({ ...entry, root: move.source.root, identity: move.source.identity }); }
      for (const file of move.files) {
        const sourcePath = file.attachment ? file.source : move.source ? `.pm/core/${file.source.slice(`project-roots/${projectId}/`.length)}` : file.source;
        const destination = file.attachment ? file.destination : `.pm/core/${file.destination}`;
        if (binaryRevision(sourceRepository.resolve(sourcePath)) !== file.revision) throw new Error('Transfer source changed; intervention required');
        targetRepository.mkdir(path.posix.dirname(destination));
        try { if (binaryRevision(targetRepository.resolve(destination)) !== file.revision) throw new Error('Transfer destination conflicts with original bytes'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          copyVerifiedFile(sourceRepository.resolve(sourcePath), targetRepository.resolve(destination, true), file.revision);
          syncDirectory(path.dirname(targetRepository.resolve(destination)));
        }
        if (binaryRevision(targetRepository.resolve(destination)) !== file.revision) throw new Error('Transfer copy verification failed');
      }
      // Check the entire tree again, including newly added files, before choosing the single authority.
      verifyTransferContents(projectId, move, sourceRepository, targetRepository, true);
      validateMarker(targetEntry);
      if (move.source) validateMarker({ ...entry, root: move.source.root, identity: move.source.identity });
      this.update(entries => { const current = entries.find(item => item.projectId === projectId)!; current.root = move.target.root; current.mode = move.target.mode; current.identity = move.target.identity!; current.initialization.step = 'ready'; current.transfer!.phase = 'cutover'; });
      entry = this.load().value.entries.find(item => item.projectId === projectId)!; move = entry.transfer!;
    }
    validateMarker(entry);
    const sourceRepository = move.source ? new FileRepository(move.source.root, false) : this.repository;
    if (move.source && !sameIdentity(move.source.identity, identity(move.source.root))) throw new Error('Transfer source was replaced before cleanup');
    if (move.source) {
      try { validateMarker({ ...entry, root: move.source.root, identity: move.source.identity }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        for (const file of move.files) {
          const sourcePath = file.attachment ? file.source : `.pm/core/${file.destination}`;
          try { sourceRepository.resolve(sourcePath); throw new Error('Old marker is missing while old authority remains'); }
          catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; }
        }
      }
    }
    verifyTransferContents(projectId, move, sourceRepository, new FileRepository(entry.root, false), false);
    const targetRepository = new FileRepository(entry.root, false);
    for (const file of move.files) {
      const destination = file.attachment ? file.destination : `.pm/core/${file.destination}`;
      if (binaryRevision(targetRepository.resolve(destination)) !== file.revision) throw new Error('Cutover destination changed before cleanup');
      const sourcePath = file.attachment ? file.source : move.source ? `.pm/core/${file.source.slice(`project-roots/${projectId}/`.length)}` : file.source;
      try {
        const filename = sourceRepository.resolve(sourcePath);
        if (binaryRevision(filename) !== file.revision) throw new Error('Old authority changed before cleanup');
        validateMarker(entry);
        if (move.source) validateMarker({ ...entry, root: move.source.root, identity: move.source.identity });
        unlinkSync(filename); syncDirectory(path.dirname(filename));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (move.source) {
      try { const marker = '.pm/project.json'; if (sourceRepository.read(marker) !== markerRaw(entry)) throw new Error('Old project marker changed'); sourceRepository.remove(marker, revisionOf(markerRaw(entry))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.update(entries => { const current = entries.find(item => item.projectId === projectId)!; current.completedTransfers = [...(current.completedTransfers ?? []), { key, hash: operationHash }]; delete current.transfer; });
    return this.get(projectId)!;
  }
}

function verifyTransferContents(projectId: string, transfer: Transfer, source: FileRepository, target: FileRepository, completeSource: boolean): void {
  const expectedCore = new Map(transfer.files.filter(file => !file.attachment).map(file => [file.destination, file.revision]));
  const expectedAttachments = new Map(transfer.files.filter(file => file.attachment).map(file => [file.destination, file.revision]));
  const inspectCore = (repository: FileRepository, legacy: boolean, complete: boolean): void => {
    const collection = repository.collect();
    if (collection.errors.length) throw new Error('Project transfer tree is unreadable');
    const files = legacy ? collection.files.filter(file => {
      const { metadata } = inspectFrontmatter(file.raw);
      return metadata.entity === 'project' ? metadata.id === projectId : metadata.project === projectId;
    }) : collection.files;
    if (complete && files.length !== expectedCore.size) throw new Error('Project transfer file set changed');
    for (const file of files) {
      assertProjectFile(projectId, file.raw);
      if (expectedCore.get(file.path) !== revisionOf(file.raw)) throw new Error('Project transfer authority changed or gained an unreviewed file');
    }
  };
  const inspectAttachments = (repository: FileRepository, complete: boolean): void => {
    let count = 0;
    const walk = (relative: string): void => {
      const directory = repository.resolve(relative);
      const entries = readdirSync(directory, { withFileTypes: true });
      if (process.platform === 'win32') cacheWindowsPathAttributes(entries.map(entry => path.join(directory, entry.name)));
      for (const entry of entries) {
        if (entry.name.startsWith('.pm-write-')) continue;
        const file = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) {
          count++;
          if (expectedAttachments.get(file) !== binaryRevision(repository.resolve(file))) throw new Error('Project attachment set changed during transfer');
        } else throw new Error('Unsafe attachment in transfer tree');
      }
    };
    walk('.pm/attachments');
    if (complete && count !== expectedAttachments.size) throw new Error('Project attachment set is incomplete');
  };
  inspectCore(transfer.source ? new FileRepository(path.join(source.root, '.pm/core'), false) : source, !transfer.source, completeSource);
  if (transfer.source) inspectAttachments(source, completeSource);
  inspectCore(new FileRepository(path.join(target.root, '.pm/core'), false), false, true);
  inspectAttachments(target, true);
}

function binaryRevision(filename: string): string {
  const fd = checkedFileOpen(filename, constants.O_RDONLY);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe transfer source');
    const before = fileStamp(fstatSync(fd, { bigint: true }));
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    // Read through the already validated descriptor rather than following a second path lookup.
    let position = 0, bytes = 0;
    do { bytes = readSync(fd, buffer, 0, buffer.length, position); if (bytes) { digest.update(buffer.subarray(0, bytes)); position += bytes; } } while (bytes);
    if (fileStamp(fstatSync(fd, { bigint: true })) !== before || fileStamp(lstatSync(filename, { bigint: true })) !== before) throw new Error('Transfer source changed while reading');
    return digest.digest('hex');
  } finally { closeSync(fd); }
}

function copyVerifiedFile(source: string, destination: string, revision: string): void {
  const input = checkedFileOpen(source, constants.O_RDONLY);
  const temporary = path.join(path.dirname(destination), `.pm-write-${randomUUID()}`);
  let output: number | undefined;
  try {
    const stat = fstatSync(input);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe transfer source');
    const before = fileStamp(fstatSync(input, { bigint: true }));
    output = checkedFileOpen(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytes = readSync(input, buffer, 0, buffer.length, null);
      if (!bytes) break;
      digest.update(buffer.subarray(0, bytes));
      let offset = 0;
      while (offset < bytes) offset += writeSync(output, buffer, offset, bytes - offset);
    }
    fsyncSync(output);
    if (digest.digest('hex') !== revision || fileStamp(fstatSync(input, { bigint: true })) !== before || fileStamp(lstatSync(source, { bigint: true })) !== before) throw new Error('Transfer source changed while copying');
    linkSync(temporary, destination);
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** Administrative/maintenance interfaces. Returned absolute paths must never be returned through ordinary FileRecord APIs. */
export const readProjectLocation = (workspaceRoot: string, projectId: string): ProjectMount | null => new ProjectLocations(workspaceRoot).get(projectId);
export const enumerateProjectMounts = (workspaceRoot: string): ProjectMount[] => new ProjectLocations(workspaceRoot).mounts();
export function previewProjectDirectory(workspaceRoot: string, directory: ProjectDirectory): { root: string; mode: 'existing' | 'new' } { return new ProjectLocations(workspaceRoot).preview(directory); }
export function assertProjectFile(projectId: string, raw: string): void {
  const { metadata } = inspectFrontmatter(raw);
  if (metadata.entity === 'project' ? metadata.id !== projectId : metadata.project !== projectId) throw new Error('File does not belong to its registered project');
}
/** Rebind a fully restored, stopped workspace. Reads only restored destinations, never the old machine's roots. */
export function rebindProjectLocations(workspaceRoot: string, bindings: Record<string, string>): void {
  const repository = new FileRepository(workspaceRoot, false), raw = repository.read(projectLocationsPath);
  const registry = new ProjectLocations(workspaceRoot);
  const locations = registry.list();
  if (locations.some(entry => entry.status !== 'ready') || Object.keys(bindings).length !== locations.length || locations.some(entry => !Object.hasOwn(bindings, entry.projectId))) throw new Error('Restore requires one destination for every settled project mount');
  const value = JSON.parse(raw) as Registry;
  const roots: string[] = [];
  for (const entry of value.entries) {
    const root = validateRoot(bindings[entry.projectId]!);
    if (overlaps(root, repository.root) || roots.some(other => overlaps(root, other))) throw new Error('Restored roots must not overlap');
    roots.push(root);
    const rebound = { ...entry, root, identity: identity(root) };
    validateMarker(rebound);
    entry.root = root; entry.identity = rebound.identity;
  }
  repository.write(projectLocationsPath, JSON.stringify(value, null, 2) + '\n', revisionOf(raw));
}
