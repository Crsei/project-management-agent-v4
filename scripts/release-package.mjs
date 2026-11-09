import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = 'project-management-agent-v4';
const releaseTagPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/;
const shaPattern = /^[0-9a-f]{40}$/;
const usage = `Usage:
  node scripts/release-package.mjs prepare --tag vX.Y.Z --sha <40-hex commit> --output <empty directory>
  node scripts/release-package.mjs verify --directory <directory>
Prepares reproducible source and build-evidence archives with SHA256SUMS and
release-manifest.json, or verifies an already prepared directory. Packaging
requires a clean tracked checkout at the exact commit; it is not a signing,
distribution-authorization, installer, or production-deployment step.`;

export function parseReleaseTag(tag) {
  if (typeof tag !== 'string' || !releaseTagPattern.test(tag)) {
    throw new Error('Release tags must be v-prefixed semantic versions such as v1.2.3 or v1.2.3-rc.1');
  }
  return tag.slice(1);
}

export function assertReleaseIdentity({ tag, version, commit }) {
  if (version !== parseReleaseTag(tag)) {
    throw new Error(`Tag ${tag} does not match version ${version}`);
  }
  if (!shaPattern.test(commit)) throw new Error('Release commit must be one full lowercase 40-hex commit id');
  return { tag, version, commit };
}

export function formatChecksums(artifacts) {
  return `${[...artifacts]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map(artifact => `${artifact.sha256}  ${artifact.name}`)
    .join('\n')}\n`;
}

export async function verifyDirectory(directory) {
  const resolved = path.resolve(directory);
  const manifest = JSON.parse(await readFile(path.join(resolved, 'release-manifest.json'), 'utf8'));
  if (manifest?.schemaVersion !== 1 || manifest.project !== project) throw new Error('Unsupported release manifest');
  assertReleaseIdentity({ tag: manifest.tag, version: manifest.version, commit: manifest.commit });
  if (typeof manifest.commitTime !== 'string' || Number.isNaN(Date.parse(manifest.commitTime))) {
    throw new Error('Release manifest commitTime must be an ISO timestamp');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error('Release manifest must list at least one artifact');
  }
  const names = new Set();
  for (const artifact of manifest.artifacts) {
    if (typeof artifact?.name !== 'string' || !artifact.name
      || artifact.name === '.' || artifact.name === '..' || artifact.name.includes('/') || artifact.name.includes('\\')
      || !/^[A-Za-z0-9._-]+$/.test(artifact.name)) {
      throw new Error(`Unsafe artifact name: ${JSON.stringify(artifact?.name)}`);
    }
    if (names.has(artifact.name)) throw new Error(`Duplicate artifact name: ${artifact.name}`);
    names.add(artifact.name);
    if (typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      throw new Error(`Invalid artifact digest: ${artifact.name}`);
    }
    const file = path.join(resolved, artifact.name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Artifact must be a regular file: ${artifact.name}`);
    if (info.size !== artifact.bytes) throw new Error(`Artifact size does not match its manifest: ${artifact.name}`);
    const digest = createHash('sha256').update(await readFile(file)).digest('hex');
    if (digest !== artifact.sha256) throw new Error(`Artifact digest does not match its manifest: ${artifact.name}`);
  }
  const expectedChecksums = formatChecksums(manifest.artifacts);
  const actualChecksums = await readFile(path.join(resolved, 'SHA256SUMS'), 'utf8');
  if (actualChecksums !== expectedChecksums) throw new Error('SHA256SUMS does not match release-manifest.json');
  const entries = new Set(await readdir(resolved));
  for (const name of entries) {
    if (name !== 'SHA256SUMS' && name !== 'release-manifest.json' && !names.has(name)) {
      throw new Error(`Unexpected file in release directory: ${name}`);
    }
  }
  for (const name of names) entries.delete(name);
  if (entries.size !== 2) throw new Error('Release directory is missing required metadata');
  return manifest;
}

function run(command, args, { capture = false, cwd = root } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture && result.stderr ? `: ${result.stderr.trim()}` : '';
    throw new Error(`${command} exited ${result.status ?? result.signal}${detail}`);
  }
  return capture ? result.stdout.trim() : '';
}

function git(args, cwd = root) {
  return run('git', ['-c', 'core.hooksPath=/dev/null', ...args], { capture: true, cwd });
}

function assertCleanCheckout(commit, cwd) {
  const head = git(['rev-parse', 'HEAD'], cwd);
  if (head !== commit) throw new Error(`Checkout HEAD ${head} is not the requested release commit ${commit}`);
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], cwd);
  if (dirty) throw new Error('Packaging requires a clean tracked checkout; commit or revert tracked changes first');
}

async function collectArtifact(directory, name) {
  const file = path.join(directory, name);
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`Expected a regular artifact file: ${name}`);
  return {
    name,
    sha256: createHash('sha256').update(await readFile(file)).digest('hex'),
    bytes: info.size,
  };
}

export async function prepareRelease({ tag, commit, output, cwd = root }) {
  const repository = path.resolve(cwd);
  const version = parseReleaseTag(tag);
  const packageVersion = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;
  assertReleaseIdentity({ tag, version: packageVersion, commit });
  if (typeof output !== 'string' || !output || !path.isAbsolute(output)) {
    throw new Error('--output must be an absolute directory outside the checkout');
  }
  if (path.resolve(output).startsWith(`${repository}${path.sep}`) || path.resolve(output) === repository) {
    throw new Error('--output must be outside the checkout');
  }
  assertCleanCheckout(commit, repository);
  const localTag = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { cwd: repository, encoding: 'utf8' });
  if (localTag.status === 0 && localTag.stdout.trim() !== commit) {
    throw new Error(`Local tag ${tag} points at ${localTag.stdout.trim()}, not ${commit}`);
  }
  await mkdir(output, { recursive: true });
  const outputEntry = await lstat(output);
  const canonicalOutput = await realpath(output);
  if (!outputEntry.isDirectory() || outputEntry.isSymbolicLink()
    || canonicalOutput === repository || canonicalOutput.startsWith(`${repository}${path.sep}`)) {
    throw new Error('--output must be a real directory outside the checkout');
  }
  if ((await readdir(canonicalOutput)).length) throw new Error('Release output directory must be empty');
  const commitTime = new Date(Number(git(['show', '-s', '--format=%ct', commit], repository)) * 1000).toISOString();
  const sourceName = `${project}-${version}-source.tar.gz`;
  const buildName = `${project}-${version}-build-evidence.tar.gz`;
  run('git', ['archive', '--format=tar.gz', `--prefix=${project}-${version}/`, '--output', path.join(output, sourceName), commit], { cwd: repository });
  // Explicit build outputs only: never desktop release directories, logs,
  // node_modules, private .env files, or unrelated artifacts under dist/.
  const required = [
    'dist/apps', 'dist/packages', 'apps/web/dist', 'apps/server/agent/dist', 'deploy',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'LICENSE', 'LICENSE.t3code', 'THIRD_PARTY_NOTICES.md', 'apps/server/agent/package.json',
    // Runtime legal materials copied by deploy/Dockerfile; keep them in the
    // same evidence bundle as the binaries they cover.
    'vendor/t3code/LICENSE', 'vendor/cc-switch/LICENSE', 'vendor/cc-switch/LICENSING.md',
    'vendor/openhands-extensions/LICENSE', 'vendor/openhands-extensions/LICENSING.md',
    'vendor/openhands-extensions/extensions/LICENSE',
    'vendor/openhands-automations/LICENSE.agent-canvas', 'vendor/openhands-automations/LICENSE.extensions',
  ];
  const optional = ['dist/scripts', 'dist/vendor'];
  const inputs = [...required];
  for (const name of required) await lstat(path.join(repository, name)).catch(() => {
    throw new Error(`Missing build output before packaging: ${name}`);
  });
  for (const name of optional) {
    if (await lstat(path.join(repository, name)).then(() => true, () => false)) inputs.push(name);
  }
  run('tar', [
    '--sort=name', `--mtime=@${Math.floor(Date.parse(commitTime) / 1000)}`,
    '--owner=0', '--group=0', '--numeric-owner', '--format=gnu',
    `--transform=s,^,${project}-${version}/,`,
    // gzip -n keeps the archive header timestamp-free so the evidence hash
    // depends only on the committed sources and their fixed member mtimes.
    '--use-compress-program=gzip -n', '-cf', path.join(output, buildName), ...inputs,
  ], { cwd: repository });
  const artifacts = [await collectArtifact(output, sourceName), await collectArtifact(output, buildName)]
    .sort((left, right) => (left.name < right.name ? -1 : 1));
  const manifest = {
    schemaVersion: 1,
    project,
    version,
    tag,
    commit,
    commitTime,
    artifacts,
  };
  await writeFile(path.join(output, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(output, 'SHA256SUMS'), formatChecksums(artifacts));
  await verifyDirectory(output);
  return manifest;
}

function parseOptions(args) {
  let command;
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help') return { help: true };
    if (argument === 'prepare' || argument === 'verify') {
      if (command) throw new Error(usage);
      command = argument;
    } else if (argument === '--tag' && command === 'prepare' && options.tag === undefined) options.tag = args[++index];
    else if (argument === '--sha' && command === 'prepare' && options.commit === undefined) options.commit = args[++index];
    else if (argument === '--output' && command === 'prepare' && options.output === undefined) options.output = args[++index];
    else if (argument === '--directory' && command === 'verify' && options.directory === undefined) options.directory = args[++index];
    else throw new Error(usage);
  }
  if (command === 'prepare') {
    if (typeof options.tag !== 'string' || typeof options.commit !== 'string' || typeof options.output !== 'string') throw new Error(usage);
  } else if (command === 'verify') {
    if (typeof options.directory !== 'string') throw new Error(usage);
  } else {
    throw new Error(usage);
  }
  return { command, ...options };
}

async function main(args) {
  let options;
  try {
    options = parseOptions(args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(usage);
    return;
  }
  try {
    if (options.command === 'prepare') {
      const manifest = await prepareRelease(options);
      console.log(`Prepared ${manifest.tag} from ${manifest.commit}`);
      for (const artifact of manifest.artifacts) console.log(`${artifact.sha256}  ${artifact.name} (${artifact.bytes} bytes)`);
    } else {
      const manifest = await verifyDirectory(options.directory);
      console.log(`Verified ${manifest.tag} from ${manifest.commit}: ${manifest.artifacts.length} artifacts`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
