import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../benchmark.config.ts';
import { digest } from '../fixtures/snapshot.ts';

export type SourceManifest = { version: '1'; files: { path: string; sha256: string }[]; sourceHash: string };
export type SourceStage = { root: string; manifest: SourceManifest };
export type StagedProductSource = { root: string; manifest: SourceManifest; dependencies: string[]; dependencyManifest: { path: string; sha256: string }[] };
const roots = ['apps/server', 'packages', 'vendor'];
const rootFiles = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json', 'apps/desktop/src/private-state.mjs'];
const excluded: Record<string, true> = { node_modules: true, dist: true, 'dist-electron': true, '.git': true, '.local': true, '.runtime': true, outputs: true, benchmarks: true, '.cache': true };
function included(name: string): boolean { return !excluded[name] && !name.startsWith('.') && !/(?:\.sqlite(?:-[a-z]+)?|\.db|\.pem|\.key)$/.test(name); }
const approved = new Map<string, string>();

/** Only explicit product/server inputs. Source hardlinks from pnpm injection are copied, never mounted into the product stage. */
export async function collectSourceManifest(root: string): Promise<SourceManifest> {
  if (!path.isAbsolute(root) || await realpath(root) !== root) throw new Error('Source root must be canonical and absolute');
  const files: SourceManifest['files'] = [];
  async function visit(relative: string): Promise<void> {
    const absolute = path.join(root, relative), stat = await lstat(absolute);
    if (await realpath(absolute) !== absolute) throw new Error(`Product source path follows a symlink: ${relative}`);
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error(`Unsupported product source entry: ${relative}`);
    if (stat.isDirectory()) {
      for (const item of await readdir(absolute)) if (included(item)) await visit(path.join(relative, item));
    } else files.push({ path: relative.split(path.sep).join('/'), sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') });
  }
  for (const relative of [...roots, ...rootFiles]) await visit(relative);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { version: '1', files, sourceHash: digest(files) };
}

/** Project a separately verified distribution inventory onto the exact benchmark server closure representation. */
export function projectProductSourceInventory(inventory: readonly { path: string; sha256: string }[]): SourceManifest {
  const seen = new Set<string>(), files: SourceManifest['files'] = [];
  for (const entry of inventory) {
    if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.startsWith('/')
      || entry.path.split('/').some(part => !part || part === '.' || part === '..')
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || seen.has(entry.path)) throw new Error('Product source projection requires a canonical complete inventory');
    seen.add(entry.path);
    if (rootFiles.includes(entry.path) || roots.some(root => entry.path.startsWith(`${root}/`))
      && entry.path.split('/').every(included)) files.push({ path: entry.path, sha256: entry.sha256 });
  }
  if (rootFiles.some(name => !files.some(file => file.path === name)) || roots.some(root => !files.some(file => file.path.startsWith(`${root}/`)))) throw new Error('Distribution inventory is missing the benchmark server/package/vendor closure');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { version: '1', files, sourceHash: digest(files) };
}

/** Called by the study verifier only AFTER it proves the predeclared treatment delta. */
export async function approveSourceStage(root: string, manifest: SourceManifest): Promise<SourceStage> {
  const observed = await collectSourceManifest(root);
  if (manifest.version !== '1' || digest(manifest.files) !== manifest.sourceHash || digest(observed) !== digest(manifest)) throw new Error('Approved source manifest does not match actual product files');
  approved.set(root, manifest.sourceHash);
  return { root, manifest };
}

export async function stageProductSource(destination: string, selection?: SourceStage): Promise<StagedProductSource> {
  const root = selection?.root ?? repositoryRoot;
  if (selection && approved.get(root) !== selection.manifest.sourceHash) throw new Error('Source stage has not passed the treatment verifier in this process');
  const manifest = await collectSourceManifest(root);
  if (selection && digest(manifest) !== digest(selection.manifest)) throw new Error('Approved source changed before staging');
  await mkdir(destination, { mode: 0o700 });
  for (const relative of roots) await mkdir(path.join(destination, relative), { recursive: true, mode: 0o700 });
  for (const entry of manifest.files) {
    const output = path.join(destination, entry.path);
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await copyFile(path.join(root, entry.path), output);
    await chmod(output, 0o400);
    const copied = await lstat(output);
    if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1) throw new Error(`Product stage did not create an independent ordinary file: ${entry.path}`);
  }
  const staged = await collectSourceManifest(destination), sourceAfterCopy = await collectSourceManifest(root);
  if (digest(staged) !== digest(manifest) || digest(sourceAfterCopy) !== digest(manifest)) throw new Error('Source changed during immutable staging');
  const dependencies: string[] = [], dependencyManifest: { path: string; sha256: string }[] = [];
  async function discover(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.name === 'node_modules' && item.isDirectory()) { dependencies.push(absolute); continue; }
      if (item.isDirectory() && included(item.name)) await discover(absolute);
    }
  }
  for (const relative of roots) await discover(path.join(repositoryRoot, relative));
  dependencies.push(path.join(repositoryRoot, 'node_modules'));
  // Hash real dependency bytes once (pnpm links are followed only within this explicit dependency tree).
  const seen = new Set<string>();
  async function hashDependencies(directory: string, relative: string): Promise<void> {
    const actual = await realpath(directory);
    const local = path.relative(repositoryRoot, actual);
    if (local.startsWith('..') || path.isAbsolute(local)) throw new Error('Dependency link escapes the explicit repository dependency boundary');
    if (!local.split(path.sep).includes('node_modules')) {
      dependencyManifest.push({ path: relative, sha256: digest({ productLink: local.split(path.sep).join('/') }) });
      return;
    }
    if (seen.has(actual)) return;
    seen.add(actual);
    const stat = await lstat(actual);
    if (stat.isDirectory()) for (const name of await readdir(actual)) await hashDependencies(path.join(actual, name), path.posix.join(relative, name));
    else if (stat.isFile()) dependencyManifest.push({ path: relative, sha256: createHash('sha256').update(await readFile(actual)).digest('hex') });
    else throw new Error('Unsupported dependency input');
  }
  for (const directory of dependencies) {
    const relative = path.relative(repositoryRoot, directory);
    await mkdir(path.dirname(path.join(destination, relative)), { recursive: true, mode: 0o700 });
    const target = path.join(destination, relative);
    await mkdir(target, { recursive: true, mode: 0o700 });
    async function linkEntries(input: string, output: string): Promise<void> {
      for (const name of await readdir(input)) {
        const from = path.join(input, name), to = path.join(output, name), actual = await realpath(from);
        if (name.startsWith('@') && (await lstat(from)).isDirectory()) { await mkdir(to, { mode: 0o700 }); await linkEntries(from, to); continue; }
        const productRelative = path.relative(repositoryRoot, actual);
        const productLink = !productRelative.startsWith('..') && !path.isAbsolute(productRelative) && !productRelative.split(path.sep).includes('node_modules');
        await symlink(productLink ? path.join(destination, productRelative) : actual, to);
      }
    }
    await linkEntries(directory, target);
    await hashDependencies(directory, relative.split(path.sep).join('/'));
  }
  dependencyManifest.sort((a, b) => a.path.localeCompare(b.path));
  return { root: destination, manifest, dependencies, dependencyManifest };
}
