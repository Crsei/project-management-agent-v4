import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCiCommandRunner, createCiRecorder } from './check-ci-process.mjs';
import { CHECK_STAGES, CHECK_TASKS } from './check-task-graph.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = 'Usage: node scripts/check-turbo.mjs [--stage lint|build|host-build | --task ID (repeatable)] [--dry | --baseline] [--cache-name NAME]';
const privatePaths = ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'];
const validCacheName = name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name);
const own = (object, key) => Object.hasOwn(object, key);

export function parseTurboArguments(args) {
  let mode = 'turbo', cacheName = 'default', stage = 'lint';
  let selectedMode = false, selectedCache = false, selectedStage = false;
  const tasks = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if ((argument === '--baseline' || argument === '--dry') && !selectedMode) {
      mode = argument.slice(2);
      selectedMode = true;
    } else if (argument === '--stage' && !selectedStage && tasks.length === 0) {
      stage = args[++index];
      if (!own(CHECK_STAGES, stage ?? '')) throw new Error(usage);
      selectedStage = true;
    } else if (argument === '--task' && !selectedStage) {
      const id = args[++index];
      if (!own(CHECK_TASKS, id ?? '') || tasks.includes(id)) throw new Error(usage);
      tasks.push(id);
      stage = null;
    } else if (argument === '--cache-name' && !selectedCache) {
      cacheName = args[++index];
      if (!validCacheName(cacheName)) throw new Error(usage);
      selectedCache = true;
    } else throw new Error(usage);
  }
  if (mode === 'baseline' && selectedCache) throw new Error(usage);
  return { mode, cacheName, stage, tasks };
}

export function createCheckEnvironment(root, temporary, ambient = process.env) {
  return {
    PATH: [path.dirname(process.execPath), path.join(root, 'node_modules/.bin'), ambient.PATH ?? '/usr/local/bin:/usr/bin:/bin'].join(path.delimiter),
    HOME: path.join(temporary, 'home'), TMPDIR: path.join(temporary, 'tmp'),
    XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_DATA_HOME: path.join(temporary, 'data'), XDG_CACHE_HOME: path.join(temporary, 'cache'),
    CI: 'true', DOVSPACE_ISOLATED_CHECKS: '1', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
    NODE_OPTIONS: '--max-old-space-size=4096',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_ENABLE_AUTO_PIN: '0',
    npm_config_manage_package_manager_versions: 'false', npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null',
    // pnpm 11 otherwise runs an implicit install when its dependency state is stale.
    pnpm_config_verify_deps_before_run: 'error',
    TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
  };
}

async function privateDirectory(root, relative) {
  let directory = root, privatePath = false;
  for (const name of relative.split('/')) {
    directory = path.join(directory, name);
    privatePath ||= name === '.local' || name === '.turbo';
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Turbo artifact directories must not be symlinks');
    if (privatePath && (entry.uid !== process.getuid() || (entry.mode & 0o077))) throw new Error('Turbo artifact directories must be owned and private');
  }
  return directory;
}

async function isolatedEnvironment(root, source) {
  if (!source || source.CI !== 'true' || source.DOVSPACE_ISOLATED_CHECKS !== '1') throw new Error('Turbo dispatch requires a caller-owned isolated checks environment');
  const env = createCheckEnvironment(root, '/unused', source);
  for (const key of privatePaths) {
    const directory = source[key];
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory || directory === '/' || directory === root || directory.startsWith(`${root}${path.sep}`)) throw new Error('Turbo dispatch requires private absolute temporary directories outside the repository');
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(directory) !== directory || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid()) throw new Error('Turbo dispatch temporary directories must be owned, private and not symlinks');
    env[key] = directory;
  }
  if (new Set(privatePaths.map(key => env[key])).size !== privatePaths.length) throw new Error('Turbo dispatch temporary directories must be distinct');
  return env;
}

async function installedTurbo(root, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Turbo checks require an exactly pinned Turbo devDependency');
  const require = createRequire(path.join(root, 'package.json'));
  let turboManifest;
  try { turboManifest = require.resolve('turbo/package.json'); }
  catch { throw new Error('Pinned Turbo is not installed; run the approved frozen-lockfile installation first'); }
  const withinModules = filename => filename.startsWith(`${path.join(root, 'node_modules')}${path.sep}`);
  if (!withinModules(await realpath(turboManifest))) throw new Error('Installed Turbo must resolve inside repository node_modules');
  if (JSON.parse(await readFile(turboManifest, 'utf8')).version !== version) throw new Error('Installed Turbo does not match the exact devDependency pin');
  const architecture = process.arch === 'x64' ? '64' : process.arch;
  if (!['64', 'arm64'].includes(architecture)) throw new Error('Linux Turbo checks support x64 and arm64 only');
  // Never invoke the JavaScript launcher: it can download a missing optional binary.
  const turboRequire = createRequire(turboManifest);
  const nativePackage = `@turbo/linux-${architecture}`;
  let binary, nativeManifest;
  try {
    binary = turboRequire.resolve(`${nativePackage}/bin/turbo`);
    nativeManifest = turboRequire.resolve(`${nativePackage}/package.json`);
  } catch { throw new Error('Pinned Turbo platform binary is missing; no automatic download was attempted'); }
  if (!withinModules(await realpath(binary)) || !withinModules(await realpath(nativeManifest))) throw new Error('Turbo platform files must resolve inside repository node_modules');
  if (JSON.parse(await readFile(nativeManifest, 'utf8')).version !== version) throw new Error('Installed Turbo platform binary does not match the pin');
  if (!(await lstat(binary)).isFile()) throw new Error('Installed Turbo platform binary must be a regular executable file');
  await access(binary, constants.X_OK);
  return binary;
}

async function entry(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

async function regularMetadata(filename, maximum = 1024 * 1024) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum || !(stat.mode & 0o444)) throw new Error('Unproven metadata file');
    return await file.readFile();
  } finally { await file.close(); }
}

async function pnpmExecutable(root, env) {
  for (const directory of env.PATH.split(path.delimiter)) {
    const candidate = path.resolve(root, directory || '.', 'pnpm');
    try {
      const executable = await realpath(candidate);
      if (!(await lstat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      return executable;
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
  }
  throw new Error('Pinned pnpm executable is missing; no installation was attempted');
}

async function runNativeTurbo(runner, label, binary, args, env, pnpm, leafUmask) {
  const temporary = await mkdtemp(path.join(env.TMPDIR, 'check-turbo-pnpm-'));
  try {
    // Native restoration applies its process umask to archived modes. Only
    // Turbo gets an unmasked restore; every pnpm leaf gets the caller's mask,
    // so a MISS emits exactly the same permissions as the direct baseline.
    const quotedPnpm = "'" + pnpm.replaceAll("'", "'\\''") + "'";
    await writeFile(path.join(temporary, 'pnpm'), `#!/bin/sh\numask ${leafUmask.toString(8)}\nexec ${quotedPnpm} "$@"\n`, { mode: 0o700, flag: 'wx' });
    await runner.run(label, '/bin/sh', ['-c', 'umask 000; exec "$@"', 'check-turbo-native', binary, ...args],
      { ...env, PATH: `${temporary}${path.delimiter}${env.PATH}` });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function safeDirectoryChain(directory) {
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await entry(current);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('Unproven directory chain');
  }
}

async function gitCacheMetadata(root) {
  const disabled = (reason, unsafe = false) => ({ enabled: false, reason, unsafe });
  try {
    const marker = path.join(root, '.git'), stat = await entry(marker);
    if (!stat) return disabled('git-layout-unproven');
    if (stat.isSymbolicLink()) return disabled('git-layout-unproven', true);
    let common = marker, indexDirectory = marker;
    if (stat.isFile()) {
      const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec((await regularMetadata(marker, 4096)).toString('utf8'))?.[1];
      if (!pointer || !path.isAbsolute(pointer) || path.resolve(pointer) !== pointer) return disabled('git-layout-unproven', true);
      const admin = path.dirname(pointer);
      common = path.dirname(admin);
      // Only the bounded sibling-repository layout is proven here. Never read
      // an arbitrary path merely because an untrusted .git file names it.
      if (path.basename(admin) !== 'worktrees' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(path.basename(pointer)) ||
          path.basename(common) !== '.git' || path.dirname(path.dirname(common)) !== path.dirname(root) ||
          path.dirname(common) === root) return disabled('git-layout-unproven', true);
      await safeDirectoryChain(pointer);
      indexDirectory = pointer;
      const backlink = (await regularMetadata(path.join(pointer, 'gitdir'), 4096)).toString('utf8').trimEnd();
      const commondir = (await regularMetadata(path.join(pointer, 'commondir'), 4096)).toString('utf8').trimEnd();
      if (backlink !== marker || commondir !== '../..') return disabled('git-layout-unproven', true);
    } else if (!stat.isDirectory() || await entry(path.join(marker, 'commondir'))) return disabled('git-layout-unproven', true);
    await safeDirectoryChain(common);
    for (const filename of new Set([
      path.join(common, 'config'), path.join(common, 'HEAD'), path.join(common, 'packed-refs'),
      path.join(indexDirectory, 'config.worktree'), path.join(indexDirectory, 'HEAD'), path.join(indexDirectory, 'index'),
    ])) {
      const metadata = await entry(filename);
      if (metadata && (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)) return disabled('git-layout-unproven', true);
    }
    for (const relative of ['objects', 'objects/info', 'refs']) {
      const metadata = await entry(path.join(common, relative));
      if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) return disabled('git-layout-unproven', true);
    }
    if (await entry(path.join(common, 'objects/info/alternates'))) return disabled('git-layout-unproven', true);
    const info = await entry(path.join(common, 'info'));
    if (info && (!info.isDirectory() || info.isSymbolicLink())) return disabled('git-excludes-unproven', true);
    const excludePath = path.join(common, 'info/exclude'), exclude = await entry(excludePath);
    if (exclude && (!exclude.isFile() || exclude.isSymbolicLink() || !(exclude.mode & 0o444))) return disabled('git-excludes-unproven', true);
    const hash = createHash('sha256').update(exclude ? `exclude-file\0${exclude.mode}\0` : 'exclude-absent\0');
    if (exclude) hash.update(await regularMetadata(excludePath));
    return { enabled: true, hash, index: path.join(indexDirectory, 'index') };
  } catch { return disabled('git-layout-unproven', true); }
}

const generatedRoots = () => [...new Set(Object.values(CHECK_TASKS).flatMap(task => task.outputRoots ?? []))];
const inside = (parent, filename) => filename === parent || filename.startsWith(`${parent}${path.sep}`);
const inputPath = (base, input, root) => input.startsWith('$TURBO_ROOT$/')
  ? { base: root, relative: input.slice('$TURBO_ROOT$/'.length) }
  : { base, relative: input };

async function cacheIdentity(root, tasks, packages, config, git) {
  const disabled = reason => ({ enabled: false, reason, fingerprint: 'uncached' });
  const cached = tasks.filter(id => CHECK_TASKS[id].cache);
  if (!cached.length) return disabled('noncache-task-selection');
  if (!git.enabled) return disabled(git.reason);
  try {
    const hash = git.hash;
    const globals = (config.globalDependencies ?? []).filter(pattern => typeof pattern === 'string' && !pattern.startsWith('!'));
    const outputs = generatedRoots().map(relative => path.join(root, relative));
    const inspected = new Set(), ancestors = new Set(), ignores = new Map(), metadata = new Map(), traversals = new Map();
    // Explicit public input globs are content-hashed by pinned native Turbo,
    // including Git-ignored files. Keep this shared identity metadata-only so
    // one leaf's content change does not invalidate unrelated selected leaves.
    const inspect = async filename => {
      if (inspected.has(filename)) return entry(filename);
      inspected.add(filename);
      const stat = await entry(filename);
      metadata.set(path.relative(root, filename), stat?.mode ?? 'absent');
      if (!stat) return null;
      if (stat.isSymbolicLink()) throw new Error('symlinked-task-inputs');
      // pnpm file: dependencies legitimately hardlink public source into this
      // worktree's node_modules. Reads do not follow an alias path, and native
      // content hashing observes writes through either name. Writable artifact
      // trees and Git/control metadata retain their stricter hardlink guards.
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('unsupported-task-inputs');
      if (!(stat.mode & 0o444) || (stat.isDirectory() && !(stat.mode & 0o111))) throw new Error('unreadable-task-inputs');
      await access(filename, constants.R_OK | (stat.isDirectory() ? constants.X_OK : 0));
      return stat;
    };
    const parents = async directory => {
      let current = root;
      for (const segment of ['', ...path.relative(root, directory).split('/').filter(Boolean)]) {
        current = path.join(current, segment);
        if (ancestors.has(current)) continue;
        ancestors.add(current);
        const stat = await inspect(current);
        if (!stat) return;
        if (current !== root && await entry(path.join(current, '.git'))) throw new Error('nested-git-boundary');
        for (const item of await readdir(current, { withFileTypes: true })) {
          const filename = path.join(current, item.name), relative = path.relative(root, filename);
          if (globals.some(pattern => path.matchesGlob(relative, pattern)) && !item.isDirectory()) await inspect(filename);
        }
        const rules = {};
        for (const name of ['.gitignore', '.eslintignore']) {
          const ignore = path.join(current, name);
          if (await entry(ignore)) {
            await inspect(ignore);
            rules[name] = (await regularMetadata(ignore)).toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
          }
        }
        ignores.set(current, rules);
      }
    };
    const gitIgnoredDirectory = directory => {
      const name = path.basename(directory);
      let proven = false;
      for (const [ancestor, rules] of ignores) {
        if (!inside(ancestor, directory)) continue;
        if (Object.values(rules).flat().some(rule => rule.startsWith('!') && !['!.env.example', '!.env.agent.example'].includes(rule))) return false;
        if ((rules['.gitignore'] ?? []).some(rule => rule.endsWith('/') && !rule.slice(0, -1).includes('/') && path.matchesGlob(name, rule.slice(0, -1)))) proven = true;
      }
      return proven;
    };
    const codeFile = name => /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/.test(name);
    for (const id of cached) {
      const task = CHECK_TASKS[id].task;
      const base = task.startsWith('//#') ? root : packages.get(task.split('#')[0]);
      const inputs = config.tasks?.[task]?.inputs;
      if (!base || !Array.isArray(inputs) || inputs.some(input => typeof input !== 'string')) return disabled('task-inputs-unproven');
      const excluded = inputs.filter(input => input.startsWith('!')).map(input => inputPath(base, input.slice(1), root));
      const oxlint = ['lint:agent', 'lint:ci', 'lint:upstream'].includes(id);
      const scope = JSON.stringify([oxlint, excluded.map(({ base, relative }) => [base, relative])]);
      if (!traversals.has(scope)) traversals.set(scope, new Map());
      const visited = traversals.get(scope);
      const visit = async (filename, recursive) => {
        const previous = visited.get(filename);
        if (previous === true || previous === recursive) return;
        visited.set(filename, recursive);
        const name = path.basename(filename);
        if (name === '.git') throw new Error('nested-git-boundary');
        // Owned generated output is not source identity, whether absent,
        // restored or freshly built. Output path safety is checked separately.
        if (outputs.some(output => inside(output, filename))) return;
        const stat = await entry(filename);
        if (!stat) { await inspect(filename); return; }
        if (stat.isSymbolicLink()) throw new Error('symlinked-task-inputs');
        if (name.startsWith('.env') && codeFile(name)) throw new Error('private-task-inputs');
        if (excluded.some(({ base: excludedBase, relative: pattern }) => {
          const relative = path.relative(excludedBase, filename);
          return path.matchesGlob(relative, pattern) || (stat.isDirectory() && path.matchesGlob(`${relative}/__check_input__`, pattern));
        })) {
          // This one documented historical directory is not public input.
          // Do not descend into its ignore files or other private history.
          if (stat.isDirectory() && filename === path.join(root, 'docs/implementation')) return;
          if (name === 'node_modules' && (!oxlint || gitIgnoredDirectory(filename))) return;
          if (stat.isDirectory() && !['.local', '.tmp'].includes(name) && gitIgnoredDirectory(filename)) return;
          if (codeFile(name) || stat.isDirectory()) throw new Error('private-task-inputs');
          return;
        }
        await inspect(filename);
        if (stat.isDirectory() && recursive) {
          await parents(filename);
          for (const item of await readdir(filename, { withFileTypes: true })) await visit(path.join(filename, item.name), true);
        }
      };
      for (const input of inputs.filter(input => !input.startsWith('!'))) {
        const { base: inputBase, relative: pattern } = inputPath(base, input, root);
        const recursive = pattern.endsWith('/**');
        const relative = recursive ? pattern.slice(0, -3) : pattern;
        const parent = path.dirname(relative), name = path.basename(relative);
        if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..') || /[$*?{[!]/.test(parent) || (recursive && /[$*?{[!]/.test(name))) return disabled('task-inputs-unproven');
        const filename = path.join(inputBase, relative);
        await parents(recursive ? filename : path.dirname(filename));
        if (!recursive && /[*?{[!]/.test(name)) {
          const directory = path.dirname(filename);
          if (await entry(directory)) for (const item of await readdir(directory, { withFileTypes: true })) {
            if (path.matchesGlob(item.name, name) || (item.name.startsWith('.env') && codeFile(item.name))) await visit(path.join(directory, item.name), false);
          }
        } else await visit(filename, recursive);
      }
    }
    for (const [filename, mode] of [...metadata].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) hash.update(`${filename}\0${mode}\0`);
    return { enabled: true, reason: 'proven-git-task-inputs', fingerprint: hash.digest('hex') };
  } catch (error) {
    const reasons = ['symlinked-task-inputs', 'nested-git-boundary', 'private-task-inputs', 'unreadable-task-inputs', 'unsupported-task-inputs'];
    return disabled(reasons.includes(error.message) ? error.message : 'task-metadata-unproven');
  }
}

async function safeArtifactTree(directory) {
  const stat = await entry(directory);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Turbo artifact directories must not be symlinks or non-directories');
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name), child = await lstat(filename);
    if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile()) || child.nlink > 1 && child.isFile()) throw new Error('Turbo artifact entries must be ordinary unlinked files or directories, not symlinks');
    if (child.isDirectory()) await safeArtifactTree(filename);
  }
}

async function rejectTrackedOutputs(root, outputs, git, runner, env) {
  if (!outputs.length) return;
  if (git.unsafe) throw new Error('Turbo cannot prove generated output ownership with unsafe Git metadata');
  if (!git.index || !await entry(git.index)) return;
  // Give Git only an authenticated index copy, not the checkout's config,
  // includes, hooks, objects or alternate/shared index locations. This keeps
  // native index parsing without turning metadata proof into private reads.
  const index = await regularMetadata(git.index, 64 * 1024 * 1024);
  const temporary = await mkdtemp(path.join(env.TMPDIR, 'check-turbo-index-'));
  try {
    for (const name of ['objects', 'refs']) await mkdir(path.join(temporary, name), { mode: 0o700 });
    await writeFile(path.join(temporary, 'HEAD'), 'ref: refs/heads/check-turbo\n', { mode: 0o600 });
    await writeFile(path.join(temporary, 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\n', { mode: 0o600 });
    await writeFile(path.join(temporary, 'index'), index, { mode: 0o600 });
    const tracked = await runner.run('Proving generated outputs contain no tracked source (isolated Git index)', '/usr/bin/git',
      ['--no-optional-locks', `--git-dir=${temporary}`, `--work-tree=${root}`, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'ls-files', '--cached', '--full-name', '-z'],
      env, { capture: true });
    for (const relative of tracked.split('\0')) {
      if (relative && outputs.some(output => inside(output, path.join(root, relative)))) throw new Error('Turbo generated output roots must not contain tracked source');
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function ownedOutputs(root, tasks, packages, config) {
  const roots = new Set();
  const owners = [];
  for (const [id, task] of Object.entries(CHECK_TASKS)) for (const relative of task.outputRoots ?? []) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split('/').some(part => !part || ['.', '..', '.git', '.local', '.turbo', 'node_modules'].includes(part)) || path.normalize(relative) !== relative) throw new Error('Turbo output ownership must stay inside public generated directories');
    const directory = path.join(root, relative);
    if (owners.some(owner => inside(owner.directory, directory) || inside(directory, owner.directory))) throw new Error('Turbo generated output roots must have one unambiguous task owner');
    owners.push({ id, directory });
  }
  for (const id of tasks) {
    const task = CHECK_TASKS[id], base = task.task.startsWith('//#') ? root : packages.get(task.task.split('#')[0]);
    const declared = task.outputRoots ?? [];
    const configured = config.tasks?.[task.task]?.outputs ?? [];
    if (!Array.isArray(declared) || !Array.isArray(configured)) throw new Error('Turbo output ownership is not proven');
    const actual = configured.map(output => {
      if (typeof output !== 'string' || !output.endsWith('/**') || output.startsWith('!')) throw new Error('Turbo outputs must be wholly owned directory roots');
      const { base: outputBase, relative } = inputPath(base, output.slice(0, -3), root);
      return path.relative(root, path.resolve(outputBase, relative));
    }).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...declared].sort())) throw new Error('Turbo outputs do not match canonical task ownership');
    for (const relative of declared) {
      if (typeof relative !== 'string') throw new Error('Turbo output ownership is not proven');
      const directory = path.join(root, relative);
      let ancestor = root;
      for (const part of relative.split('/')) {
        ancestor = path.join(ancestor, part);
        const stat = await entry(ancestor);
        if (!stat) break;
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Turbo output ancestors must not be symlinks or non-directories');
      }
      await safeArtifactTree(directory);
      roots.add(directory);
    }
  }
  return [...roots];
}

function selectedTasks(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || !own(CHECK_TASKS, id)) || new Set(ids).size !== ids.length) throw new Error('Turbo tasks must be a nonempty, distinct registry allowlist selection');
  const selected = new Set(ids);
  // The build stage is the existing serial prerequisite chain, not package ^build.
  const lastBuild = Math.max(-1, ...ids.map(id => CHECK_STAGES.build.indexOf(id)));
  for (const id of CHECK_STAGES.build.slice(0, lastBuild + 1)) selected.add(id);
  return Object.values(CHECK_STAGES).flat().filter(id => selected.has(id));
}

export function createTurboDispatcher(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['root', 'runner', 'env', 'cacheName'].includes(key))) throw new Error('Unknown Turbo dispatcher options');
  let { root = repositoryRoot, runner, env, cacheName = 'default' } = options;
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Turbo dispatch requires an absolute repository root');
  root = path.resolve(root);
  if (!runner || typeof runner.run !== 'function') throw new Error('Turbo dispatch requires a caller-owned command runner');
  if (!validCacheName(cacheName)) throw new Error('Turbo dispatch requires a safe local cache name');
  const prepare = async () => {
    if (process.platform !== 'linux') throw new Error('Turbo checks require the existing Linux CI process supervisor');
    if (await realpath(root) !== root) throw new Error('Turbo repository root must not be a symlink');
    const childEnv = await isolatedEnvironment(root, env);
    const nodePin = (await regularMetadata(path.join(root, '.node-version'))).toString('utf8').trim();
    const manifest = JSON.parse((await regularMetadata(path.join(root, 'package.json'))).toString('utf8'));
    const pnpmPin = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha\d+\..+)?$/.exec(manifest.packageManager)?.[1];
    const turboPin = manifest.devDependencies?.turbo;
    const leafUmask = process.umask();
    if (!/^\d+\.\d+\.\d+$/.test(nodePin) || !pnpmPin || process.versions.node !== nodePin) throw new Error('Turbo checks require the repository-pinned Node and pnpm toolchain');
    if (!/^\d+\.\d+\.\d+$/.test(turboPin ?? '')) throw new Error('Turbo checks require an exactly pinned Turbo devDependency');
    const pnpm = await pnpmExecutable(root, childEnv);
    const pnpmVersion = await runner.run('Pinned pnpm version (no installation)', pnpm, ['--version'], childEnv, { capture: true });
    if (pnpmVersion !== pnpmPin) throw new Error('Installed pnpm does not match the repository pin; no installation was attempted');
    // Freshness must fail before Turbo can replay a cached success, not just
    // inside a leaf on MISS. The fixed pnpm error policy forbids implicit repair.
    await runner.run('Pinned pnpm dependency freshness (no installation)', pnpm, ['exec', process.execPath, '--version'], childEnv);
    childEnv.DOVSPACE_CHECK_TOOLCHAIN = `${process.platform}-${process.arch}:node-${nodePin}:pnpm-${pnpmPin}:turbo-${turboPin}:umask-${leafUmask.toString(8).padStart(3, '0')}`;
    return { env: childEnv, turboPin, pnpm, leafUmask };
  };
  const execute = async (ids, mode) => {
    const tasks = selectedTasks(ids);
    const prepared = await prepare();
    const packageNames = new Set(tasks.map(id => CHECK_TASKS[id].task.split('#')[0]).filter(name => name !== '//'));
    const packages = new Map();
    if (packageNames.size) {
      // Use the pinned package manager's workspace map, not a second registry.
      const output = await runner.run('Resolving selected workspace task directories', prepared.pnpm, ['list', '--recursive', '--depth=-1', '--json'], prepared.env, { capture: true });
      const workspaces = JSON.parse(output);
      if (!Array.isArray(workspaces)) throw new Error('Cannot resolve Turbo task workspace directories');
      for (const name of packageNames) {
        const matches = workspaces.filter(workspace => workspace?.name === name);
        const directory = matches.length === 1 ? matches[0].path : undefined;
        if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Selected Turbo task must resolve to exactly one workspace');
        const relative = path.relative(root, directory);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || await realpath(directory) !== directory) throw new Error('Turbo task workspace must be inside the repository and not a symlink');
        packages.set(name, directory);
      }
    }
    const config = JSON.parse((await regularMetadata(path.join(root, 'turbo.json'))).toString('utf8'));
    const outputs = await ownedOutputs(root, tasks, packages, config);
    const git = await gitCacheMetadata(root);
    if (mode === 'dry' && git.unsafe) throw new Error(`Turbo dry cannot inspect unsafe Git metadata: ${git.reason}`);
    await rejectTrackedOutputs(root, outputs, git, runner, prepared.env);
    const cache = mode === 'baseline' ? { enabled: false, fingerprint: 'uncached' } : await cacheIdentity(root, tasks, packages, config, git);
    const dispatchEnv = { ...prepared.env, DOVSPACE_CHECK_TOOLCHAIN: `${prepared.env.DOVSPACE_CHECK_TOOLCHAIN}:ignore-${cache.fingerprint}` };
    if (mode === 'baseline' || git.unsafe) {
      for (const directory of outputs) await rm(directory, { recursive: true, force: true });
      for (const id of tasks) {
        const task = CHECK_TASKS[id];
        const fallback = git.unsafe ? ` (cache disabled: ${git.reason}; unsafe SCM bypassed)` : '';
        await runner.run(`Uncached ${id}: ${task.label}${fallback}`, prepared.pnpm, [...task.args], dispatchEnv);
      }
      return;
    }
    const binary = await installedTurbo(root, prepared.turboPin);
    const version = await runner.run('Pinned native Turbo version (no launcher or download)', binary, ['--version'], prepared.env, { capture: true });
    if (version !== prepared.turboPin) throw new Error('Native Turbo executable does not match the repository pin');
    const cacheDirectory = await privateDirectory(root, `.local/check-turbo/${cacheName}`);
    await safeArtifactTree(cacheDirectory);
    await privateDirectory(root, '.turbo/runs');
    await safeArtifactTree(path.join(root, '.turbo'));
    for (const directory of packages.values()) {
      const logs = await privateDirectory(root, `${path.relative(root, directory)}/.turbo`);
      await safeArtifactTree(logs);
    }
    // Validate every root first, then remove only declared generated trees.
    // This gives both a cache restoration and a native MISS a clean inventory;
    // tsc emit alone otherwise leaves stale modules from deleted source files.
    if (mode !== 'dry') for (const directory of outputs) await rm(directory, { recursive: true, force: true });
    const args = ['run', ...tasks.map(id => CHECK_TASKS[id].task), `--cache=local:${cache.enabled ? 'rw' : ''}`, `--cache-dir=${cacheDirectory}`, '--env-mode=strict', '--framework-inference=false', '--concurrency=1', mode === 'dry' ? '--dry=json' : '--summarize'];
    const cacheScope = cache.enabled ? 'local cache hits are not execution' : `cache disabled: ${cache.reason}${mode === 'dry' ? '' : '; real execution'}`;
    const label = mode === 'dry' ? `Dry task selection ${tasks.join(', ')} (no task execution; ${cacheScope})` : `Turbo task selection ${tasks.join(', ')} (${cacheScope})`;
    if (mode === 'dry') await runner.run(label, binary, args, dispatchEnv);
    else await runNativeTurbo(runner, label, binary, args, dispatchEnv, prepared.pnpm, prepared.leafUmask);
  };
  const stageTasks = stage => {
    if (typeof stage !== 'string' || !own(CHECK_STAGES, stage)) throw new Error('Unknown Turbo check stage');
    return CHECK_STAGES[stage];
  };
  const runTasks = async (ids, options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'baseline') || (own(options, 'baseline') && typeof options.baseline !== 'boolean')) throw new Error('Turbo dispatch accepts only a boolean baseline option');
    return execute(ids, options.baseline ? 'baseline' : 'turbo');
  };
  return {
    runTasks,
    runStage: async (stage, options) => runTasks(stageTasks(stage), options),
    dryTasks: async ids => execute(ids, 'dry'),
    dryStage: async stage => execute(stageTasks(stage), 'dry'),
  };
}

export async function runCheckTurbo({ root = repositoryRoot, args = process.argv.slice(2), ambientEnv = process.env } = {}) {
  const { mode, cacheName, stage, tasks } = parseTurboArguments(args);
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Turbo dispatch requires an absolute repository root');
  root = path.resolve(root);
  if (await realpath(root) !== root) throw new Error('Turbo repository root must not be a symlink');
  const mask = process.umask(0o077);
  let temporary, recorder, runner, interrupted, failure;
  const stop = signal => {
    if (interrupted) return;
    interrupted = signal;
    runner?.stop(signal);
  };
  const sigint = () => stop('SIGINT'), sigterm = () => stop('SIGTERM');
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  try {
    recorder = createCiRecorder(root);
    runner = createCiCommandRunner({ cwd: root, recorder, interrupted: () => interrupted });
    recorder.record('run', 'Repository Turbo checks', 'scope', { mode, stage, tasks });
    await recorder.measure('run', 'Repository Turbo checks', async () => {
      let operationFailure;
      try {
        // Never inherit TMPDIR or remove anything except this invocation's directory.
        temporary = await mkdtemp('/var/tmp/dovspace-check-turbo-');
        const env = createCheckEnvironment(root, temporary, ambientEnv);
        for (const name of privatePaths) await mkdir(env[name], { mode: 0o700 });
        const dispatcher = createTurboDispatcher({ root, runner, env, cacheName });
        if (mode === 'dry') await (stage ? dispatcher.dryStage(stage) : dispatcher.dryTasks(tasks));
        else await (stage ? dispatcher.runStage(stage, { baseline: mode === 'baseline' }) : dispatcher.runTasks(tasks, { baseline: mode === 'baseline' }));
      } catch (error) { operationFailure = error; }
      finally {
        try {
          if (temporary) await recorder.measure('stage', 'Turbo owned temporary cleanup', () => rm(temporary, { recursive: true, force: true }));
        } catch (error) { operationFailure = operationFailure ? new AggregateError([operationFailure, error], 'Turbo execution and owned cleanup failed') : error; }
      }
      if (operationFailure) throw operationFailure;
      if (interrupted) throw new Error(`Turbo checks interrupted by ${interrupted}`);
    }, () => interrupted);
  } catch (error) { failure = error; }
  finally {
    process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
    process.umask(mask);
    try { recorder?.close(); }
    catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  if (interrupted) throw new Error(`Turbo checks interrupted by ${interrupted}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await runCheckTurbo(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Turbo checks failed');
    process.exitCode = 1;
  }
}
