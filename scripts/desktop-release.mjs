import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { stringify as stringifyYAML } from 'yaml';
import { pathToFileURL } from 'node:url';
import { DESKTOP_UPDATE_REPOSITORY, updateInstallStampAssetName } from '../apps/desktop/src/update-policy.mjs';

const repository = `${DESKTOP_UPDATE_REPOSITORY.owner}/${DESKTOP_UPDATE_REPOSITORY.repo}`;
const root = path.resolve(import.meta.dirname, '..');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const safeName = name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);

export function assertReleaseRequest(request) {
  const { tag, sha, version, channel, distribution, targets, runId, attempt, ciRunId } = request;
  if (request.repository !== repository) throw new Error(`Desktop releases are restricted to ${repository}`);
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Expected one full lowercase source SHA');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.[1-9]\d*)?$/.test(version ?? '') || tag !== `v${version}`)
    throw new Error('Desktop tag must exactly match the application version (stable or preview.N)');
  if (!['preview', 'stable'].includes(channel) || (channel === 'preview') !== version.includes('-preview.'))
    throw new Error('Release channel must match the exact stable or preview application version');
  if (!['unsigned', 'signed'].includes(distribution)) throw new Error('Unknown desktop distribution');
  if (!same(targets, ['win32-x64']) && !same(targets, ['win32-x64', 'darwin-x64', 'darwin-arm64']))
    throw new Error('Release requires the exact Windows-only or complete native target set');
  if (distribution === 'unsigned' && (channel !== 'preview' || targets.length !== 1))
    throw new Error('Unsigned release is supported only for explicitly labeled Windows preview tests');
  for (const [label, value] of Object.entries({ runId, attempt, ciRunId })) {
    if (!/^[1-9]\d*$/.test(String(value ?? ''))) throw new Error(`${label} must identify an exact workflow run/attempt`);
  }
  return request;
}

export function assertSuccessfulChecks(run, request) {
  if (String(run?.id) !== String(request.ciRunId) || run.head_sha !== request.sha || run.event !== 'push'
    || run.status !== 'completed' || run.conclusion !== 'success' || run.head_repository?.full_name !== repository
    || run.path !== '.github/workflows/ci.yml')
    throw new Error('Selected CI run is not successful Repository checks for this exact source SHA');
}

export function assertDeliveryProvenance(manifest, report, request, target) {
  if (manifest.version !== request.version || manifest.target !== target || manifest.signing !== request.distribution
    || manifest.source?.commit !== request.sha || manifest.source?.dirty !== false)
    throw new Error(`Native delivery version, target, signing or clean source SHA mismatch: ${target}`);
  if (manifest.ci?.repository !== repository || manifest.ci.commit !== request.sha
    || String(manifest.ci.runId) !== String(request.runId) || String(manifest.ci.attempt) !== String(request.attempt))
    throw new Error(`Native delivery does not belong to this exact workflow run/attempt: ${target}`);
  if (!Array.isArray(manifest.releaseAuthorization?.openBlockers) || manifest.releaseAuthorization.openBlockers.length)
    throw new Error(`Recorded third-party release blockers remain open: ${target}`);
  if (report.checks?.finalArtifacts?.status !== 'passed' || report.checks?.application?.status !== 'passed'
    || report.checks?.installStamp?.status !== 'passed' || report.nativeSmoke?.status !== 'passed'
    || report.nativeSmoke.target !== target || report.nativeSmoke.scope !== 'final-distributable-payload'
    || !manifest.artifacts.some(file => same(file, report.nativeSmoke.artifact)))
    throw new Error(`Native delivery lacks exact final-payload verification and native smoke: ${target}`);
  if (request.distribution === 'signed' && report.checks?.signing?.status !== 'passed')
    throw new Error(`Native signed verification has not passed: ${target}`);
}

async function fileRecord(directory, name) {
  if (!safeName(name)) throw new Error('Unsafe public release asset name');
  const file = path.join(directory, name), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Release asset must be a regular unlinked file: ${name}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { name, bytes: info.size, sha256: hash.digest('hex') };
}

export function publicAssetName({ name, target, distribution, artifacts, updateAssets }) {
  if (!safeName(name)) throw new Error('Unsafe delivery asset name');
  return artifacts.includes(name) || updateAssets.includes(name) ? name : `${target}-${distribution}-${name}`;
}

export async function stageCandidate({ request, deliveries, output }) {
  assertReleaseRequest(request);
  const { verifyDeliveryFiles } = await import('../apps/desktop/scripts/verify-delivery.mjs');
  const { configuredArtifactNames, parseUpdateMetadata } = await import('../apps/desktop/scripts/delivery-assets.mjs');
  const entries = await readdir(deliveries, { withFileTypes: true });
  const expectedDirectories = request.targets.map(target => `desktop-${request.distribution}-${target}`).sort();
  if (!same(entries.map(entry => entry.name).sort(), expectedDirectories)
    || entries.some(entry => !entry.isDirectory() || entry.isSymbolicLink()))
    throw new Error('Downloaded artifact directories do not match the exact requested native target set');
  await mkdir(output, { recursive: false });
  const assets = [], sources = [], names = new Set();
  for (const target of request.targets) {
    const directory = path.join(deliveries, `desktop-${request.distribution}-${target}`);
    const { manifest, names: deliveryNames } = await verifyDeliveryFiles(directory);
    const report = JSON.parse(await readFile(path.join(directory, 'desktop-verification.json'), 'utf8'));
    assertDeliveryProvenance(manifest, report, request, target);
    if (sources.length && sources[0].sha256 !== manifest.source.sha256) throw new Error('Native targets were not built from identical public source bytes');
    sources.push({ target, ...manifest.source });
    const [platform, arch] = target.split('-');
    const updateAssets = [updateInstallStampAssetName({ platform, arch }), configuredArtifactNames(manifest).update.feedName].filter(Boolean);
    for (const original of deliveryNames) {
      const name = publicAssetName({ name: original, target, distribution: request.distribution,
        artifacts: manifest.artifacts.map(file => file.path), updateAssets });
      if (names.has(name)) throw new Error(`Duplicate public asset across native targets: ${name}`);
      names.add(name);
      await copyFile(path.join(directory, original), path.join(output, name));
      assets.push({ ...await fileRecord(output, name), target, original });
    }
  }
  if (request.targets.includes('darwin-x64')) {
    const channel = request.channel === 'preview' ? 'preview' : 'latest';
    const fragments = await Promise.all(['x64', 'arm64'].map(async arch =>
      parseUpdateMetadata(await readFile(path.join(output, `${channel}-mac-${arch}.yml`), 'utf8'))));
    const merged = mergeMacFeeds(fragments, request.version);
    const metadata = stringifyYAML(merged);
    parseUpdateMetadata(metadata);
    const name = `${channel}-mac.yml`;
    await writeFile(path.join(output, name), metadata, { flag: 'wx' });
    assets.push({ ...await fileRecord(output, name), target: 'darwin-universal-feed', original: null });
  }
  assets.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const manifest = { schemaVersion: 1, kind: 'desktop-github-release', ...request, sources, assets };
  await writeFile(path.join(output, 'desktop-release.json'), json(manifest), { flag: 'wx' });
  await writeFile(path.join(output, 'SHA256SUMS'), [...assets, await fileRecord(output, 'desktop-release.json')]
    .sort((a, b) => a.name.localeCompare(b.name, 'en')).map(file => `${file.sha256}  ${file.name}\n`).join(''), { flag: 'wx' });
  return verifyCandidate(output, request);
}

export function mergeMacFeeds(fragments, version) {
  if (!Array.isArray(fragments) || fragments.length !== 2) throw new Error('Both native macOS feed fragments are required');
  const files = [];
  for (const [index, feed] of fragments.entries()) {
    const arch = index === 0 ? 'x64' : 'arm64';
    if (feed.version !== version || !Array.isArray(feed.files) || feed.files.length !== 1
      || !safeName(feed.path) || !feed.path.endsWith(`-mac-${arch}-signed.zip`)
      || feed.files[0].url !== feed.path || feed.files[0].sha512 !== feed.sha512
      || !/^[A-Za-z0-9+/]{86}==$/.test(feed.sha512 ?? '') || !Number.isSafeInteger(feed.files[0].size) || feed.files[0].size <= 0)
      throw new Error('Native macOS feed fragment version, architecture, ZIP identity or hash mismatch');
    files.push(feed.files[0]);
  }
  return { ...fragments[0], files, path: files[0].url, sha512: files[0].sha512 };
}

export async function verifyCandidate(directory, request) {
  assertReleaseRequest(request);
  const manifest = JSON.parse(await readFile(path.join(directory, 'desktop-release.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'desktop-github-release'
    || Object.keys(request).some(key => !same(manifest[key], request[key])) || !Array.isArray(manifest.assets) || !manifest.assets.length)
    throw new Error('Staged desktop release identity differs from requested tag/SHA/version/run');
  const assets = [], names = new Set();
  for (const expected of manifest.assets) {
    if (names.has(expected.name)) throw new Error('Duplicate staged release asset');
    names.add(expected.name);
    const actual = await fileRecord(directory, expected.name);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`Staged asset changed: ${expected.name}`);
    assets.push(actual);
  }
  assets.push(await fileRecord(directory, 'desktop-release.json'));
  const sums = assets.slice().sort((a, b) => a.name.localeCompare(b.name, 'en')).map(file => `${file.sha256}  ${file.name}\n`).join('');
  if (await readFile(path.join(directory, 'SHA256SUMS'), 'utf8') !== sums) throw new Error('Staged release checksums do not match the complete assets');
  assets.push(await fileRecord(directory, 'SHA256SUMS'));
  if (!same((await readdir(directory)).sort(), assets.map(file => file.name).sort())) throw new Error('Staged release has extra or missing assets');
  return { manifest, assets };
}

export function createGitHubClient(token, fetcher = fetch) {
  if (!token) throw new Error('Workflow GITHUB_TOKEN is required');
  async function request(endpoint, { method = 'GET', body, binary = false, bytes } = {}) {
    const url = new URL(endpoint, 'https://api.github.com');
    if (!['api.github.com', 'uploads.github.com'].includes(url.hostname) || url.protocol !== 'https:'
      || (url.pathname !== `/repos/${repository}` && !url.pathname.startsWith(`/repos/${repository}/`))) throw new Error('Unexpected GitHub API destination');
    const headers = { Authorization: `Bearer ${token}`, Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dovspace-desktop-release' };
    if (body !== undefined) headers['Content-Type'] = binary ? 'application/octet-stream' : 'application/json';
    if (bytes !== undefined) headers['Content-Length'] = String(bytes);
    let response = await fetcher(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(120_000),
      ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body), ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }) });
    if (binary && method === 'GET' && response.status === 302) {
      const destination = new URL(response.headers.get('location'));
      if (destination.protocol !== 'https:' || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(destination.hostname))
        throw new Error('Unexpected GitHub release asset download destination');
      response = await fetcher(destination, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    }
    if (!response.ok) throw new Error(`GitHub API ${method} ${url.pathname} failed (${response.status}); inspect the exact tag before retrying`);
    if (binary && method === 'GET') return response;
    return response.status === 204 ? null : response.json();
  }
  return {
    get: endpoint => request(`/repos/${repository}${endpoint ? `/${endpoint}` : ''}`),
    post: (endpoint, body) => request(`/repos/${repository}/${endpoint}`, { method: 'POST', body }),
    patch: (endpoint, body) => request(`/repos/${repository}/${endpoint}`, { method: 'PATCH', body }),
    upload: async (release, asset, directory) => {
      const url = `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`;
      const stream = createReadStream(path.join(directory, asset.name));
      try {
        return await request(url, { method: 'POST', body: Readable.toWeb(stream), binary: true, bytes: asset.bytes });
      } finally { stream.destroy(); }
    },
    digest: async asset => {
      const response = await request(`/repos/${repository}/releases/assets/${asset.id}`, { binary: true });
      const hash = createHash('sha256');
      for await (const chunk of response.body) hash.update(chunk);
      return hash.digest('hex');
    },
    readAsset: async asset => {
      if (asset.size > 1024 * 1024) throw new Error('Release index exceeds the bounded metadata size');
      const response = await request(`/repos/${repository}/releases/assets/${asset.id}`, { binary: true });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 1024 * 1024) throw new Error('Release index exceeds the bounded metadata size');
        chunks.push(chunk);
      }
      if (bytes !== asset.size) throw new Error('Downloaded release index size differs from GitHub asset');
      return Buffer.concat(chunks);
    },
  };
}

export async function verifyRemoteIdentity(client, request) {
  assertReleaseRequest(request);
  const ref = await client.get(`git/ref/tags/${encodeURIComponent(request.tag)}`);
  let object = ref.object;
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) object = (await client.get(`git/tags/${object.sha}`)).object;
  if (object?.type !== 'commit' || object.sha !== request.sha) throw new Error('Release tag no longer points to the expected source SHA');
  const repositoryInfo = await client.get('');
  const comparison = await client.get(`compare/${encodeURIComponent(repositoryInfo.default_branch)}...${request.sha}`);
  if (!['identical', 'behind'].includes(comparison.status)) throw new Error('Release commit is not in default-branch history');
  assertSuccessfulChecks(await client.get(`actions/runs/${request.ciRunId}`), request);
}

async function listRelease(client, tag) {
  // The tags endpoint omits drafts on some API paths. Authenticated pagination
  // includes them; never treat an API failure as evidence that no release exists.
  let found;
  for (let page = 1; ; page++) {
    const releases = await client.get(`releases?per_page=100&page=${page}`);
    for (const release of releases.filter(item => item.tag_name === tag)) {
      if (found) throw new Error('More than one GitHub Release owns this tag');
      found = release;
    }
    if (releases.length < 100) return found;
  }
}

async function releaseAssets(client, release) {
  const assets = [];
  for (let page = 1; ; page++) {
    const batch = await client.get(`releases/${release.id}/assets?per_page=100&page=${page}`);
    assets.push(...batch);
    if (batch.length < 100) return assets;
  }
}

export async function assertRemoteAssets(client, actual, expected, { complete = true } = {}) {
  const names = new Set();
  for (const asset of actual) {
    const wanted = expected.find(file => file.name === asset.name);
    if (!wanted || names.has(asset.name) || asset.state !== 'uploaded' || asset.size !== wanted.bytes)
      throw new Error(`Unexpected, duplicate, incomplete or mismatched remote asset: ${asset.name}`);
    names.add(asset.name);
    // GitHub's content digest covers the exact uploaded bytes. Older API assets
    // without a digest are streamed and hashed rather than trusted by size alone.
    const digest = asset.digest ?? `sha256:${await client.digest(asset)}`;
    if (digest !== `sha256:${wanted.sha256}`) throw new Error(`Remote asset hash mismatch: ${asset.name}`);
  }
  if (complete && names.size !== expected.length) throw new Error('GitHub Release is missing required native installers, metadata or source/legal assets');
}

function releaseBody(request, assets) {
  return [`# ${request.tag}`, '',
    request.distribution === 'unsigned' ? '**Unsigned Windows preview for testing only — not a trusted signed production release.**' : 'Signed native desktop release.', '',
    `- Source: \`${request.sha}\``, `- Repository checks: https://github.com/${repository}/actions/runs/${request.ciRunId}`,
    `- Native build: https://github.com/${repository}/actions/runs/${request.runId}/attempts/${request.attempt}`,
    `- Channel: ${request.channel}; exact version: ${request.version}`,
    '- Recorded third-party release gate: clear. This records repository metadata, not legal authorization.', '',
    'Installers, updater feeds, candidate compatibility stamps and target-qualified complete source/legal/security materials are listed in desktop-release.json. Target-qualified materials retain their original names in that index.', '',
    `<!-- desktop-release:${request.sha}:${assets.find(file => file.name === 'desktop-release.json').sha256} -->`, ''].join('\n');
}

export async function lookupRelease(client, request) {
  const release = await listRelease(client, request.tag);
  if (!release) return null;
  const actual = await releaseAssets(client, release);
  const indexAsset = actual.find(asset => asset.name === 'desktop-release.json');
  if (!indexAsset || release.target_commitish !== request.sha || release.prerelease !== (request.channel === 'preview'))
    throw new Error('Existing release has no matching desktop source/channel identity; refusing replacement');
  const index = await client.readAsset(indexAsset);
  const manifest = JSON.parse(index.toString('utf8'));
  assertReleaseRequest(manifest);
  for (const key of ['repository', 'tag', 'sha', 'version', 'channel', 'distribution', 'targets']) {
    if (!same(manifest[key], request[key])) throw new Error('Existing desktop release identity differs from requested release');
  }
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'desktop-github-release' || !Array.isArray(manifest.assets) || !manifest.assets.length)
    throw new Error('Existing release is not an indexed complete desktop delivery');
  const assets = [...manifest.assets, { name: 'desktop-release.json', bytes: index.length, sha256: createHash('sha256').update(index).digest('hex') }];
  const sums = assets.slice().sort((a, b) => a.name.localeCompare(b.name, 'en')).map(file => `${file.sha256}  ${file.name}\n`).join('');
  assets.push({ name: 'SHA256SUMS', bytes: Buffer.byteLength(sums), sha256: createHash('sha256').update(sums).digest('hex') });
  if (release.body !== releaseBody(manifest, assets)) throw new Error('Existing release provenance marker differs from its exact asset index');
  await verifyRemoteIdentity(client, manifest);
  await assertRemoteAssets(client, actual, assets);
  return { state: release.draft ? 'draft' : 'already-published', visible: !release.draft, url: release.html_url, tag: request.tag };
}

export async function finalizeExisting({ client, request, action, authorization }) {
  await authorization();
  await verifyRemoteIdentity(client, request);
  const existing = await lookupRelease(client, request);
  if (!existing) return null;
  if (existing.visible) {
    if (action !== 'publish') throw new Error('Existing release is already published, not a draft');
    return existing;
  }
  if (action === 'draft') return existing;
  if (action !== 'publish') throw new Error('Explicit publication action required');
  await authorization();
  await verifyRemoteIdentity(client, request);
  await lookupRelease(client, request);
  const release = await listRelease(client, request.tag);
  if (!release?.draft || release.tag_name !== request.tag || release.target_commitish !== request.sha
    || release.prerelease !== (request.channel === 'preview')) throw new Error('Draft state changed before explicit publication');
  await client.patch(`releases/${release.id}`, { draft: false, make_latest: request.channel === 'stable' ? 'true' : 'false' });
  const published = await lookupRelease(client, request);
  if (!published?.visible) throw new Error('Release visibility was not confirmed; inspect the exact tag before retrying');
  return { ...published, state: 'published' };
}

export async function publishCandidate({ client, request, directory, action, authorization }) {
  if (!['draft', 'publish'].includes(action)) throw new Error('Explicit draft or publish action required');
  // This callback executes the real --release gate in the CLI. It is deliberately
  // before any draft mutation and again immediately before visibility changes.
  await authorization();
  await verifyRemoteIdentity(client, request);
  const { assets } = await verifyCandidate(directory, request);
  const body = releaseBody(request, assets);
  let release = await listRelease(client, request.tag);
  if (release) {
    if (release.target_commitish !== request.sha || release.prerelease !== (request.channel === 'preview') || release.body !== body)
      throw new Error('Existing release tag/source/channel/asset identity differs; refusing replacement');
    const uploaded = await releaseAssets(client, release);
    await assertRemoteAssets(client, uploaded, assets, { complete: !release.draft });
    if (!release.draft) {
      if (action !== 'publish') throw new Error('Existing release is already published, not a draft');
      return { state: 'already-published', visible: true, url: release.html_url, tag: request.tag };
    }
  } else {
    release = await client.post('releases', { tag_name: request.tag, target_commitish: request.sha, name: request.tag,
      body, draft: true, prerelease: request.channel === 'preview', make_latest: 'false' });
  }
  if (!release.draft) throw new Error('GitHub did not create a draft; refusing asset mutation');
  for (const asset of assets) {
    // Re-read release state before every write; no --clobber or deletion path.
    const current = await client.get(`releases/${release.id}`);
    if (!current.draft || current.body !== body || current.target_commitish !== request.sha || current.tag_name !== request.tag
      || current.prerelease !== (request.channel === 'preview')) throw new Error('Release state changed while staging; refusing mutation');
    const uploaded = await releaseAssets(client, current);
    await assertRemoteAssets(client, uploaded, assets, { complete: false });
    if (!uploaded.some(file => file.name === asset.name)) await client.upload(current, asset, directory);
  }
  await authorization();
  await verifyRemoteIdentity(client, request);
  const current = await client.get(`releases/${release.id}`);
  if (!current.draft || current.body !== body || current.target_commitish !== request.sha || current.tag_name !== request.tag
    || current.prerelease !== (request.channel === 'preview')) throw new Error('Draft changed before publication');
  await assertRemoteAssets(client, await releaseAssets(client, current), assets);
  if (action === 'draft') return { state: 'draft', visible: false, url: release.html_url, tag: request.tag };
  const published = await client.patch(`releases/${release.id}`, { draft: false, make_latest: request.channel === 'stable' ? 'true' : 'false' });
  if (published.draft || published.tag_name !== request.tag || published.prerelease !== (request.channel === 'preview'))
    throw new Error('Publication outcome is not the requested visible release; inspect the exact tag before retrying');
  await assertRemoteAssets(client, await releaseAssets(client, published), assets);
  return { state: 'published', visible: true, url: published.html_url, tag: request.tag };
}

function requireAuthorization() {
  const result = spawnSync(process.execPath, ['scripts/check-third-party-notices.mjs', '--release'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Recorded third-party --release authorization gate failed; no release is published');
}

async function requestFromEnvironment(env) {
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const desktopVersion = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8')).version;
  if (desktopVersion !== version) throw new Error('Root and desktop application versions differ');
  const request = { repository: env.GITHUB_REPOSITORY, tag: env.DESKTOP_RELEASE_TAG, sha: env.DESKTOP_RELEASE_SHA,
    version, channel: env.DESKTOP_RELEASE_CHANNEL, distribution: env.DESKTOP_DISTRIBUTION,
    targets: env.DESKTOP_WINDOWS_ONLY === 'true' ? ['win32-x64'] : ['win32-x64', 'darwin-x64', 'darwin-arm64'],
    runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, ciRunId: env.DESKTOP_CI_RUN_ID };
  assertReleaseRequest(request);
  const checked = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (checked.status !== 0 || checked.stdout.trim() !== request.sha || env.GITHUB_SHA !== request.sha)
    throw new Error('Dispatch ref, checked-out source and expected release SHA must be identical');
  return request;
}

async function main(command) {
  if (!['preflight', 'release'].includes(command)) throw new Error('Usage: node scripts/desktop-release.mjs preflight|release (explicit desktop workflow environment required)');
  const request = await requestFromEnvironment(process.env);
  const client = createGitHubClient(process.env.GH_TOKEN);
  if (command === 'preflight') {
    await verifyRemoteIdentity(client, request);
    const existing = await lookupRelease(client, request);
    if (existing?.visible && process.env.DESKTOP_RELEASE_ACTION !== 'publish') throw new Error('Requested draft is already a published immutable release');
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT,
      `already_published=${Boolean(existing?.visible)}\nstaged_draft=${existing?.state === 'draft'}\n`, { flag: 'a' });
    if (existing) {
      console.log(json(existing));
      if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,
        `### Existing desktop release\n\n${existing.url}\n\n**${existing.state}** — exact assets verified; preflight does not modify releases or make drafts visible.\n`, { flag: 'a' });
    }
    return;
  }
  let result = await finalizeExisting({ client, request, action: process.env.DESKTOP_RELEASE_ACTION, authorization: requireAuthorization });
  if (!result) {
    await stageCandidate({ request, deliveries: process.env.DESKTOP_RELEASE_DELIVERIES, output: process.env.DESKTOP_RELEASE_STAGE });
    result = await publishCandidate({ client, request, directory: process.env.DESKTOP_RELEASE_STAGE,
      action: process.env.DESKTOP_RELEASE_ACTION, authorization: requireAuthorization });
  }
  console.log(json(result));
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,
    `### Desktop release outcome\n\n- Tag: ${result.tag}\n- State: **${result.state}**\n- Visible to updater: **${result.visible}**\n- ${result.url}\n`, { flag: 'a' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
