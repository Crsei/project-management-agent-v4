import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import { enumerateProjectMounts, rebindProjectLocations } from '../../pm-core/project-locations.ts';
import { captureCoreCheckpoint, coreCheckpointSchema } from './blob-storage-checkpoint.ts';

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const treeSchema = z.strictObject({ files: coreCheckpointSchema, directories: z.array(z.string()) });
export const localProjectCheckpointSchema = z.strictObject({ formatVersion: z.literal(1), core: coreCheckpointSchema, coreDirectories: z.array(z.string()), projects: z.array(z.strictObject({ workspaceId: z.uuid(), projectId: z.string().min(1), storageId: z.uuid(), files: coreCheckpointSchema, directories: z.array(z.string()) })) });
export type LocalProjectCheckpoint = z.infer<typeof localProjectCheckpointSchema>;
export function localProjectCheckpointSha256(manifest: LocalProjectCheckpoint): string { return createHash('sha256').update(JSON.stringify(localProjectCheckpointSchema.parse(manifest))).digest('hex'); }
/** Maintenance roots must be canonical, non-sensitive and pairwise independent before any writes. */
export function assertIndependentStorageRoots(paths: string[]): void {
  const sensitive = ['/etc', '/proc', '/sys', '/dev', '/boot', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/run', '/root'];
  for (let index = 0; index < paths.length; index++) {
    const root = paths[index]!;
    if (root === sep || resolve(root) !== root || root.includes('\0') || sensitive.some(parent => root === parent || root.startsWith(parent + sep))) throw new DomainError('blob_checkpoint_unsafe');
    for (let other = 0; other < index; other++) {
      const previous = paths[other]!;
      if (root === previous || root.startsWith(previous + sep) || previous.startsWith(root + sep)) throw new DomainError('blob_restore_overlapping_roots');
    }
  }
}
async function pinnedDirectory(root: string): Promise<FileHandle> {
  root = resolve(root);
  if (root === sep) throw new DomainError('blob_checkpoint_unsafe');
  let directory = await open(sep, directoryFlags);
  try {
    for (const part of root.split(sep).filter(Boolean)) {
      const next = await open(`/proc/self/fd/${directory.fd}/${part}`, directoryFlags);
      await directory.close(); directory = next;
    }
    return directory;
  } catch (error) { await directory.close(); throw error; }
}
function safeRelative(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new DomainError('blob_checkpoint_unsafe');
}
async function snapshotTree(root: string): Promise<z.infer<typeof treeSchema>> {
  const files: z.infer<typeof coreCheckpointSchema> = [];
  const directories: string[] = [];
  async function walk(directory: FileHandle, relative: string): Promise<void> {
    for (const entry of await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (path === '.pm/cache' || path.endsWith('/.pm/cache')) continue;
      if (entry.isDirectory()) {
        const child = await open(`/proc/self/fd/${directory.fd}/${entry.name}`, directoryFlags);
        try { directories.push(path); await walk(child, path); } finally { await child.close(); }
      } else {
        const file = await open(`/proc/self/fd/${directory.fd}/${entry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1) throw new DomainError('blob_checkpoint_unsafe');
          const hash = createHash('sha256'); let size = 0;
          for await (const chunk of file.createReadStream({ autoClose: false })) { hash.update(chunk); size += chunk.length; }
          if (size !== stat.size) throw new DomainError('blob_checkpoint_changed');
          files.push({ path, size, sha256: hash.digest('hex') });
        } finally { await file.close(); }
      }
    }
  }
  const directory = await pinnedDirectory(root);
  try { await walk(directory, ''); } finally { await directory.close(); }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')), directories: directories.sort((a, b) => a.localeCompare(b, 'en')) };
}
async function copyTree(source: string, target: string, tree: z.infer<typeof treeSchema>, resume = false, acceptReboundRegistry?: (path: string) => Promise<boolean>): Promise<void> {
  const checked = treeSchema.parse(tree);
  if (await realpath(dirname(resolve(target))) !== dirname(resolve(target))) throw new DomainError('blob_checkpoint_unsafe');
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) { if (!resume || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const existing = resume ? await snapshotTree(target) : { files: [], directories: [] };
  const expectedFiles = new Map(checked.files.map(entry => [entry.path, entry]));
  const existingFiles = new Set<string>();
  for (const entry of existing.files) {
    const expected = expectedFiles.get(entry.path);
    if (!expected) throw new DomainError('blob_checkpoint_mismatch', 'Restore target contains an unknown file');
    if (entry.sha256 !== expected.sha256 || entry.size !== expected.size) {
      if (!acceptReboundRegistry || !await acceptReboundRegistry(entry.path)) throw new DomainError('blob_checkpoint_mismatch', 'Restore target conflicts with the original checkpoint');
      expectedFiles.set(entry.path, entry);
    }
    existingFiles.add(entry.path);
  }
  const expectedDirectories = new Set(checked.directories);
  if (existing.directories.some(path => !expectedDirectories.has(path))) throw new DomainError('blob_checkpoint_mismatch', 'Restore target contains an unknown directory');
  const root = await pinnedDirectory(source);
  const destination = await pinnedDirectory(target);
  async function parent(root: FileHandle, path: string): Promise<{ directory: FileHandle; name: string }> {
    safeRelative(path);
    const parts = path.split('/'); const name = parts.pop()!;
    // Dereference only our pinned descriptor; O_NOFOLLOW still guards the final
    // directory component and every subsequently opened child.
    let directory = await open(`/proc/self/fd/${root.fd}/.`, directoryFlags);
    try {
      for (const part of parts) { const next = await open(`/proc/self/fd/${directory.fd}/${part}`, directoryFlags); await directory.close(); directory = next; }
      return { directory, name };
    } catch (error) { await directory.close(); throw error; }
  }
  try {
    const existingDirectories = new Set(existing.directories);
    for (const path of checked.directories) {
      if (existingDirectories.has(path)) continue;
      const item = await parent(destination, path);
      try { await mkdir(`/proc/self/fd/${item.directory.fd}/${item.name}`, { mode: 0o700 }); await item.directory.sync(); } finally { await item.directory.close(); }
    }
    for (const entry of checked.files) {
      if (existingFiles.has(entry.path)) continue;
      const from = await parent(root, entry.path); const to = await parent(destination, entry.path);
      let input: FileHandle | undefined; let output: FileHandle | undefined;
      try {
        input = await open(`/proc/self/fd/${from.directory.fd}/${from.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await input.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.size) throw new DomainError('blob_checkpoint_changed');
        output = await open(`/proc/self/fd/${to.directory.fd}/${to.name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const hash = createHash('sha256'); let size = 0;
        for await (const chunk of input.createReadStream({ autoClose: false })) { hash.update(chunk); size += chunk.length; await output.writeFile(chunk); }
        if (size !== entry.size || hash.digest('hex') !== entry.sha256) throw new DomainError('blob_checkpoint_changed');
        await output.sync(); await to.directory.sync();
      } finally { await input?.close(); await output?.close(); await from.directory.close(); await to.directory.close(); }
    }
    await destination.sync();
  } finally { await root.close(); await destination.close(); }
  const finalTree = { files: [...expectedFiles.values()], directories: checked.directories };
  if (!isDeepStrictEqual(await snapshotTree(target), finalTree)) throw new DomainError('blob_checkpoint_mismatch');
}
export async function captureLocalProjectCheckpoint(coreRoot: string): Promise<LocalProjectCheckpoint> {
  const core = await captureCoreCheckpoint(coreRoot);
  const tree = await snapshotTree(coreRoot);
  const projects: LocalProjectCheckpoint['projects'] = [];
  for (const entry of await readdir(coreRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) throw new DomainError('blob_checkpoint_unknown_workspace');
    for (const mount of enumerateProjectMounts(join(coreRoot, entry.name))) {
      const projectTree = await snapshotTree(join(mount.root, '.pm'));
      projects.push({ workspaceId: mount.workspaceId, projectId: mount.projectId, storageId: mount.storageId, ...projectTree });
    }
  }
  projects.sort((a, b) => `${a.workspaceId}/${a.projectId}`.localeCompare(`${b.workspaceId}/${b.projectId}`, 'en'));
  return localProjectCheckpointSchema.parse({ formatVersion: 1, core, coreDirectories: tree.directories, projects });
}
/** Stopped export copies .pm only: unrelated source repository files are never imported. */
export async function exportLocalProjectCheckpoint(options: { coreRoot: string; directory: string; stopped: boolean }): Promise<{ manifest: LocalProjectCheckpoint; manifestSha256: string }> {
  if (!options.stopped) throw new DomainError('blob_maintenance_requires_stop');
  const manifest = await captureLocalProjectCheckpoint(options.coreRoot);
  const roots = [resolve(options.coreRoot), resolve(options.directory)];
  for (const workspaceId of new Set(manifest.projects.map(project => project.workspaceId))) {
    for (const mount of enumerateProjectMounts(join(options.coreRoot, workspaceId))) roots.push(mount.root);
  }
  assertIndependentStorageRoots(roots);
  await mkdir(options.directory, { mode: 0o700 });
  await copyTree(options.coreRoot, join(options.directory, 'core'), { files: manifest.core, directories: manifest.coreDirectories });
  await mkdir(join(options.directory, 'projects'), { mode: 0o700 });
  for (const project of manifest.projects) {
    const mount = enumerateProjectMounts(join(options.coreRoot, project.workspaceId)).find(item => item.projectId === project.projectId);
    if (!mount || mount.storageId !== project.storageId) throw new DomainError('blob_checkpoint_changed');
    await copyTree(join(mount.root, '.pm'), join(options.directory, 'projects', project.storageId), { files: project.files, directories: project.directories });
  }
  if (!isDeepStrictEqual(await captureLocalProjectCheckpoint(options.coreRoot), manifest)) throw new DomainError('blob_checkpoint_changed');
  const file = await open(join(options.directory, 'manifest.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(manifest)); await file.sync(); } finally { await file.close(); }
  return { manifest, manifestSha256: localProjectCheckpointSha256(manifest) };
}
async function readRegistry(path: string): Promise<unknown> {
  const directory = await pinnedDirectory(dirname(path));
  let file: FileHandle | undefined;
  try {
    file = await open(`/proc/self/fd/${directory.fd}/${basename(path)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new DomainError('blob_checkpoint_unsafe');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const result = await file.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw new DomainError('blob_checkpoint_changed'); offset += result.bytesRead; }
    if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead) throw new DomainError('blob_checkpoint_changed');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await file?.close(); await directory.close(); }
}
/** Copies to new roots and rebinds from copied identities only; source paths are never opened. */
export async function restoreLocalProjectCheckpoint(options: { directory: string; manifest: LocalProjectCheckpoint; expectedManifestSha256: string; targetCoreRoot: string; targetProjectsRoot: string; stopped: boolean }): Promise<{ coreRoot: string; projects: { workspaceId: string; projectId: string; storageId: string; root: string }[] }> {
  if (!options.stopped) throw new DomainError('blob_maintenance_requires_stop');
  assertIndependentStorageRoots([resolve(options.directory), options.targetCoreRoot, options.targetProjectsRoot]);
  const manifest = localProjectCheckpointSchema.parse(options.manifest);
  if (localProjectCheckpointSha256(manifest) !== options.expectedManifestSha256) throw new DomainError('blob_backup_set_mismatch');
  const registrySchema = z.object({ entries: z.array(z.object({ projectId: z.string(), workspaceId: z.string(), storageId: z.string(), root: z.string(), identity: z.unknown() }).passthrough()) }).passthrough();
  await copyTree(join(options.directory, 'core'), options.targetCoreRoot, { files: manifest.core, directories: manifest.coreDirectories }, true, async path => {
    if (!/^[a-f0-9-]{36}\/\.pm\/state\/project-locations\.json$/.test(path)) return false;
    const original = registrySchema.parse(await readRegistry(join(options.directory, 'core', path)));
    const current = registrySchema.parse(await readRegistry(join(options.targetCoreRoot, path)));
    for (const entry of current.entries) {
      const project = manifest.projects.find(project => project.workspaceId === entry.workspaceId && project.projectId === entry.projectId && project.storageId === entry.storageId);
      if (!project || entry.root !== join(options.targetProjectsRoot, project.storageId)) return false;
    }
    const stableOriginal = { ...original, entries: original.entries.map(({ root: _root, identity: _identity, ...entry }) => entry) };
    const stableCurrent = { ...current, entries: current.entries.map(({ root: _root, identity: _identity, ...entry }) => entry) };
    return isDeepStrictEqual(stableOriginal, stableCurrent);
  });
  if (await realpath(dirname(resolve(options.targetProjectsRoot))) !== dirname(resolve(options.targetProjectsRoot))) throw new DomainError('blob_checkpoint_unsafe');
  try { await mkdir(options.targetProjectsRoot, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const parent = await pinnedDirectory(options.targetProjectsRoot);
  try {
    const allowed = new Set(manifest.projects.map(project => project.storageId));
    if ((await readdir(`/proc/self/fd/${parent.fd}`)).some(name => !allowed.has(name))) throw new DomainError('blob_checkpoint_mismatch', 'Project restore parent contains unknown entries');
  } finally { await parent.close(); }
  const projects = [];
  for (const project of manifest.projects) {
    const root = join(options.targetProjectsRoot, project.storageId);
    try { await mkdir(root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await copyTree(join(options.directory, 'projects', project.storageId), join(root, '.pm'), { files: project.files, directories: project.directories }, true);
    projects.push({ workspaceId: project.workspaceId, projectId: project.projectId, storageId: project.storageId, root });
  }
  for (const workspaceId of new Set(projects.map(project => project.workspaceId))) {
    const bindings: Record<string, string> = {};
    for (const project of projects) if (project.workspaceId === workspaceId) bindings[project.projectId] = project.root;
    rebindProjectLocations(join(options.targetCoreRoot, workspaceId), bindings);
  }
  return { coreRoot: options.targetCoreRoot, projects };
}
