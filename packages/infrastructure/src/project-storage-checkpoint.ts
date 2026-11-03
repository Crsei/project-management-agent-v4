import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import { enumerateProjectMounts, rebindProjectLocations } from '../../pm-core/project-locations.ts';
import { pathContains, samePath } from '../../pm-core/platform.ts';
import { captureCoreCheckpoint, coreCheckpointSchema } from './blob-storage-checkpoint.ts';
import { SafeDirectory, assertStorageRelativePath, exclusiveFileFlags } from './portable-directory.ts';

const treeSchema = z.strictObject({ files: coreCheckpointSchema, directories: z.array(z.string()) });
export const localProjectCheckpointSchema = z.strictObject({ formatVersion: z.literal(1), core: coreCheckpointSchema, coreDirectories: z.array(z.string()), projects: z.array(z.strictObject({ workspaceId: z.uuid(), projectId: z.string().min(1), storageId: z.uuid(), files: coreCheckpointSchema, directories: z.array(z.string()) })) });
export type LocalProjectCheckpoint = z.infer<typeof localProjectCheckpointSchema>;
export function localProjectCheckpointSha256(manifest: LocalProjectCheckpoint): string { return createHash('sha256').update(JSON.stringify(localProjectCheckpointSchema.parse(manifest))).digest('hex'); }
/** Maintenance roots must be canonical, non-sensitive and pairwise independent before any writes. */
export function assertIndependentStorageRoots(paths: string[]): void {
  for (let index = 0; index < paths.length; index++) {
    const root = paths[index]!, volume = parse(root).root;
    const sensitive = process.platform === 'win32'
      ? ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'].map(name => join(volume, name))
      : process.platform === 'darwin'
        ? ['/System', '/Library', '/Applications', '/private/etc', '/private/var/db', '/private/var/root', '/usr', '/bin', '/sbin', '/dev']
        : ['/etc', '/proc', '/sys', '/dev', '/boot', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/run', '/root'];
    if (samePath(root, volume) || resolve(root) !== root || root.includes('\0') || sensitive.some(parent => pathContains(parent, root))) throw new DomainError('blob_checkpoint_unsafe');
    for (let other = 0; other < index; other++) {
      if (pathContains(root, paths[other]!) || pathContains(paths[other]!, root)) throw new DomainError('blob_restore_overlapping_roots');
    }
  }
}
function checkedTree(input: z.infer<typeof treeSchema>): z.infer<typeof treeSchema> {
  const tree = treeSchema.parse(input), seen = new Set<string>();
  const key = (path: string) => process.platform === 'linux' ? path : path.normalize('NFD').toLowerCase();
  const directories = new Set(tree.directories.map(key));
  for (const path of [...tree.directories, ...tree.files.map(file => file.path)]) {
    assertStorageRelativePath(path);
    if (seen.has(key(path))) throw new DomainError('blob_checkpoint_unsafe', 'Checkpoint paths collide');
    seen.add(key(path));
    const parents = path.split('/'); parents.pop();
    while (parents.length) {
      if (!directories.has(key(parents.join('/')))) throw new DomainError('blob_checkpoint_unsafe', 'Checkpoint parent directory is missing');
      parents.pop();
    }
  }
  return { files: tree.files.sort((a, b) => a.path.localeCompare(b.path, 'en')), directories: tree.directories.sort((a, b) => a.localeCompare(b, 'en')) };
}
async function createDirectory(root: string, resume = false): Promise<SafeDirectory> {
  const parent = await SafeDirectory.open(dirname(resolve(root)));
  try {
    try { await parent.mkdir(basename(root)); }
    catch (error) { if (!resume || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return await parent.child(basename(root));
  } finally { await parent.close(); }
}
async function snapshotTree(root: string): Promise<z.infer<typeof treeSchema>> {
  const files: z.infer<typeof coreCheckpointSchema> = [], directories: string[] = [];
  async function walk(directory: SafeDirectory, relative: string): Promise<void> {
    for (const entry of await directory.entries()) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new DomainError('blob_checkpoint_unsafe');
      if (entry.isDirectory()) {
        if (path === '.pm/cache' || path.endsWith('/.pm/cache')) continue;
        const child = await directory.child(entry.name);
        try { directories.push(path); await walk(child, path); } finally { await child.close(); }
      } else {
        const file = await directory.openFile(entry.name);
        try {
          const stat = await file.stat({ bigint: true });
          if (!stat.isFile() || stat.nlink !== 1n) throw new DomainError('blob_checkpoint_unsafe');
          const hash = createHash('sha256'); let size = 0;
          for await (const chunk of file.createReadStream({ autoClose: false })) {
            hash.update(chunk); size += chunk.length;
            if (BigInt(size) > stat.size) throw new DomainError('blob_checkpoint_changed');
          }
          const after = await file.stat({ bigint: true });
          if (BigInt(size) !== stat.size || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) throw new DomainError('blob_checkpoint_changed');
          await directory.assertFile(entry.name, file);
          files.push({ path, size, sha256: hash.digest('hex') });
        } finally { await file.close(); }
      }
    }
    await directory.assertIdentity();
  }
  const directory = await SafeDirectory.open(root);
  try { await walk(directory, ''); } finally { await directory.close(); }
  return checkedTree({ files, directories });
}
async function copyTree(source: string, target: string, tree: z.infer<typeof treeSchema>, resume = false, acceptReboundRegistry?: (path: string) => Promise<boolean>): Promise<void> {
  const checked = checkedTree(tree);
  const destination = await createDirectory(target, resume);
  try {
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
    const root = await SafeDirectory.open(source);
    async function parent(root: SafeDirectory, path: string): Promise<{ directory: SafeDirectory; name: string }> {
      assertStorageRelativePath(path);
      const parts = path.split('/'), name = parts.pop()!;
      let directory = await root.duplicate();
      try {
        for (const part of parts) { const next = await directory.child(part); await directory.close(); directory = next; }
        return { directory, name };
      } catch (error) { await directory.close(); throw error; }
    }
    try {
      const existingDirectories = new Set(existing.directories);
      for (const path of checked.directories) {
        if (existingDirectories.has(path)) continue;
        const item = await parent(destination, path);
        try { await item.directory.mkdir(item.name); } finally { await item.directory.close(); }
      }
      for (const entry of checked.files) {
        if (existingFiles.has(entry.path)) continue;
        const from = await parent(root, entry.path), to = await parent(destination, entry.path);
        let input: FileHandle | undefined, output: FileHandle | undefined;
        try {
          input = await from.directory.openFile(from.name);
          const stat = await input.stat({ bigint: true });
          if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(entry.size)) throw new DomainError('blob_checkpoint_changed');
          output = await to.directory.openFile(to.name, exclusiveFileFlags);
          const hash = createHash('sha256'); let size = 0;
          for await (const chunk of input.createReadStream({ autoClose: false })) {
            hash.update(chunk); size += chunk.length;
            if (size > entry.size) throw new DomainError('blob_checkpoint_changed');
            await output.writeFile(chunk);
          }
          const after = await input.stat({ bigint: true });
          if (size !== entry.size || hash.digest('hex') !== entry.sha256 || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) throw new DomainError('blob_checkpoint_changed');
          await from.directory.assertFile(from.name, input);
          await output.sync();
          await to.directory.assertFile(to.name, output);
          await to.directory.sync();
        } finally { await input?.close(); await output?.close(); await from.directory.close(); await to.directory.close(); }
      }
      await destination.sync();
      await root.assertIdentity();
    } finally { await root.close(); }
    const finalTree = { files: [...expectedFiles.values()], directories: checked.directories };
    if (!isDeepStrictEqual(await snapshotTree(target), finalTree)) throw new DomainError('blob_checkpoint_mismatch');
    await destination.assertIdentity();
  } finally { await destination.close(); }
}
export async function captureLocalProjectCheckpoint(coreRoot: string): Promise<LocalProjectCheckpoint> {
  const core = await captureCoreCheckpoint(coreRoot), tree = await snapshotTree(coreRoot);
  if (!isDeepStrictEqual(core, tree.files)) throw new DomainError('blob_checkpoint_changed');
  const projects: LocalProjectCheckpoint['projects'] = [];
  const directory = await SafeDirectory.open(coreRoot);
  try {
    for (const entry of await directory.entries()) {
      if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) throw new DomainError('blob_checkpoint_unknown_workspace');
      for (const mount of enumerateProjectMounts(join(coreRoot, entry.name))) {
        const projectTree = await snapshotTree(join(mount.root, '.pm'));
        projects.push({ workspaceId: mount.workspaceId, projectId: mount.projectId, storageId: mount.storageId, ...projectTree });
      }
    }
    await directory.assertIdentity();
  } finally { await directory.close(); }
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
  const directory = await createDirectory(options.directory);
  try {
    await copyTree(options.coreRoot, join(options.directory, 'core'), { files: manifest.core, directories: manifest.coreDirectories });
    await directory.mkdir('projects');
    for (const project of manifest.projects) {
      const mount = enumerateProjectMounts(join(options.coreRoot, project.workspaceId)).find(item => item.projectId === project.projectId);
      if (!mount || mount.storageId !== project.storageId) throw new DomainError('blob_checkpoint_changed');
      await copyTree(join(mount.root, '.pm'), join(options.directory, 'projects', project.storageId), { files: project.files, directories: project.directories });
    }
    if (!isDeepStrictEqual(await captureLocalProjectCheckpoint(options.coreRoot), manifest)) throw new DomainError('blob_checkpoint_changed');
    const file = await directory.openFile('manifest.json', exclusiveFileFlags);
    try { await file.writeFile(JSON.stringify(manifest)); await file.sync(); await directory.assertFile('manifest.json', file); } finally { await file.close(); }
    await directory.sync();
  } finally { await directory.close(); }
  return { manifest, manifestSha256: localProjectCheckpointSha256(manifest) };
}
async function readRegistry(path: string): Promise<unknown> {
  const directory = await SafeDirectory.open(dirname(path));
  let file: FileHandle | undefined;
  try {
    file = await directory.openFile(basename(path));
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new DomainError('blob_checkpoint_unsafe');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const result = await file.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw new DomainError('blob_checkpoint_changed'); offset += result.bytesRead; }
    if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead) throw new DomainError('blob_checkpoint_changed');
    await directory.assertFile(basename(path), file);
    return JSON.parse(bytes.toString('utf8'));
  } finally { await file?.close(); await directory.close(); }
}
/** Copies to new roots and rebinds from copied identities only; source paths are never opened. */
export async function restoreLocalProjectCheckpoint(options: { directory: string; manifest: LocalProjectCheckpoint; expectedManifestSha256: string; targetCoreRoot: string; targetProjectsRoot: string; stopped: boolean }): Promise<{ coreRoot: string; projects: { workspaceId: string; projectId: string; storageId: string; root: string }[] }> {
  if (!options.stopped) throw new DomainError('blob_maintenance_requires_stop');
  assertIndependentStorageRoots([resolve(options.directory), options.targetCoreRoot, options.targetProjectsRoot]);
  const manifest = localProjectCheckpointSchema.parse(options.manifest);
  if (localProjectCheckpointSha256(manifest) !== options.expectedManifestSha256) throw new DomainError('blob_backup_set_mismatch');
  // Validate every path/collision before creating any restore target.
  checkedTree({ files: manifest.core, directories: manifest.coreDirectories });
  const storageIds = new Set<string>(), projectIds = new Set<string>();
  for (const project of manifest.projects) {
    checkedTree({ files: project.files, directories: project.directories });
    const identity = `${project.workspaceId}/${project.projectId}`;
    const storageId = project.storageId.toLowerCase();
    if (storageIds.has(storageId) || projectIds.has(identity)) throw new DomainError('blob_checkpoint_unsafe');
    storageIds.add(storageId); projectIds.add(identity);
  }
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
  const parent = await createDirectory(options.targetProjectsRoot, true);
  const projects = [];
  try {
    const allowed = new Set(manifest.projects.map(project => project.storageId));
    if ((await parent.entries()).some(entry => !allowed.has(entry.name))) throw new DomainError('blob_checkpoint_mismatch', 'Project restore parent contains unknown entries');
    for (const project of manifest.projects) {
      const root = join(options.targetProjectsRoot, project.storageId);
      const projectDirectory = await createDirectory(root, true);
      try {
        if ((await projectDirectory.entries()).some(entry => entry.name !== '.pm')) throw new DomainError('blob_checkpoint_mismatch', 'Project restore root contains unknown entries');
        await copyTree(join(options.directory, 'projects', project.storageId), join(root, '.pm'), { files: project.files, directories: project.directories }, true);
        await projectDirectory.assertIdentity();
      } finally { await projectDirectory.close(); }
      projects.push({ workspaceId: project.workspaceId, projectId: project.projectId, storageId: project.storageId, root });
    }
    await parent.assertIdentity();
  } finally { await parent.close(); }
  for (const workspaceId of new Set(projects.map(project => project.workspaceId))) {
    const bindings: Record<string, string> = {};
    for (const project of projects) if (project.workspaceId === workspaceId) bindings[project.projectId] = project.root;
    rebindProjectLocations(join(options.targetCoreRoot, workspaceId), bindings);
  }
  return { coreRoot: options.targetCoreRoot, projects };
}
