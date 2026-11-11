import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertDeliveryProvenance, assertReleaseRequest, assertRemoteAssets, assertSuccessfulChecks,
  createGitHubClient, finalizeExisting, lookupRelease, mergeMacFeeds, publicAssetName,
  publishCandidate, verifyCandidate,
} from './desktop-release.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const clone = value => structuredClone(value);
const request = (overrides = {}) => ({ repository: 'Crsei/project-management-agent-v4', tag: 'v0.1.1-preview.1',
  sha: 'a'.repeat(40), version: '0.1.1-preview.1', channel: 'preview', distribution: 'unsigned',
  targets: ['win32-x64'], runId: '42', attempt: '1', ciRunId: '40', ...overrides });
const ciRun = value => ({ id: Number(value.ciRunId), head_sha: value.sha, event: 'push', status: 'completed',
  conclusion: 'success', head_repository: { full_name: value.repository }, path: '.github/workflows/ci.yml' });

async function candidate(t, identity = request()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'desktop-release-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installer = `PM-Agent-v4-${identity.version}-win-x64-${identity.distribution}.exe`;
  const contents = new Map([
    [installer, Buffer.from(`native installer ${identity.version}`)],
    [identity.channel === 'preview' ? 'preview.yml' : 'latest.yml', Buffer.from(`version: ${identity.version}\npath: ${installer}\n`)],
    ['desktop-install-stamp-win32-x64.json', Buffer.from(json({ version: identity.version }))],
    [`win32-x64-${identity.distribution}-desktop-source.tar.gz`, Buffer.from('corresponding source fixture')],
    [`win32-x64-${identity.distribution}-desktop-legal.tar.gz`, Buffer.from('legal fixture')],
  ]);
  const assets = [];
  for (const [name, bytes] of contents) {
    await writeFile(path.join(directory, name), bytes);
    assets.push({ name, bytes: bytes.length, sha256: sha256(bytes), target: 'win32-x64', original: name });
  }
  assets.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const manifest = { schemaVersion: 1, kind: 'desktop-github-release', ...identity, sources: [], assets };
  const index = Buffer.from(json(manifest));
  await writeFile(path.join(directory, 'desktop-release.json'), index);
  contents.set('desktop-release.json', index);
  const sums = [...assets, { name: 'desktop-release.json', sha256: sha256(index) }]
    .sort((a, b) => a.name.localeCompare(b.name, 'en')).map(file => `${file.sha256}  ${file.name}\n`).join('');
  await writeFile(path.join(directory, 'SHA256SUMS'), sums);
  contents.set('SHA256SUMS', Buffer.from(sums));
  return { directory, contents, identity };
}

function remote(fixture) {
  const state = { release: null, assets: [], calls: [], writes: [], failUpload: false, movedTag: false, ciFailure: false };
  const client = {
    async get(endpoint) {
      state.calls.push(endpoint);
      if (endpoint.startsWith('git/ref/tags/')) return { object: { type: 'commit', sha: state.movedTag ? 'b'.repeat(40) : fixture.identity.sha } };
      if (endpoint === '') return { default_branch: 'main' };
      if (endpoint.startsWith('compare/')) return { status: 'behind' };
      if (endpoint.startsWith('actions/runs/')) return { ...ciRun({ ...fixture.identity, ciRunId: endpoint.split('/').at(-1) }), ...(state.ciFailure ? { conclusion: 'failure' } : {}) };
      if (endpoint.startsWith('releases?')) return state.release ? [clone(state.release)] : [];
      if (endpoint.startsWith('releases/1/assets?')) return clone(state.assets);
      if (endpoint === 'releases/1') return clone(state.release);
      throw new Error(`Unexpected fixture API call ${endpoint}`);
    },
    async post(endpoint, body) {
      assert.equal(endpoint, 'releases');
      state.writes.push({ method: 'POST', endpoint, body: clone(body) });
      state.release = { id: 1, html_url: `https://github.com/${fixture.identity.repository}/releases/tag/${fixture.identity.tag}`, ...clone(body) };
      return clone(state.release);
    },
    async patch(endpoint, body) {
      assert.equal(endpoint, 'releases/1');
      assert.equal(state.assets.length, fixture.contents.size, 'visibility may change only after all assets are uploaded');
      state.writes.push({ method: 'PATCH', endpoint, body: clone(body) });
      Object.assign(state.release, body);
      return clone(state.release);
    },
    async upload(release, asset, directory) {
      assert.equal(release.draft, true);
      if (state.failUpload && state.assets.length === 2) throw new Error('Interrupted asset upload');
      assert.ok(!state.assets.some(item => item.name === asset.name), 'no replacement of uploaded assets');
      const bytes = await readFile(path.join(directory, asset.name));
      state.writes.push({ method: 'UPLOAD', name: asset.name });
      state.assets.push({ id: state.assets.length + 10, name: asset.name, size: bytes.length,
        digest: `sha256:${sha256(bytes)}`, state: 'uploaded' });
    },
    async digest(asset) { return sha256(fixture.contents.get(asset.name)); },
    async readAsset(asset) { return fixture.contents.get(asset.name); },
  };
  return { client, state };
}

const publish = (fixture, client, extra = {}) => publishCandidate({ client, request: fixture.identity,
  directory: fixture.directory, action: 'publish', authorization: async () => {}, ...extra });

test('desktop release identity binds repository, exact tag/version/SHA/channel and provenance', () => {
  assert.equal(assertReleaseRequest(request()).tag, 'v0.1.1-preview.1');
  assertReleaseRequest(request({ version: '0.1.1', tag: 'v0.1.1', channel: 'stable', distribution: 'signed' }));
  for (const overrides of [
    { repository: 'other/repository' }, { tag: 'v0.1.1-preview.2' }, { sha: 'main' }, { sha: 'A'.repeat(40) },
    { version: '0.1.1-beta.1', tag: 'v0.1.1-beta.1' }, { channel: 'stable' }, { attempt: '0' }, { ciRunId: '' },
    { targets: ['darwin-arm64'] }, { targets: ['win32-x64', 'darwin-x64', 'darwin-arm64'] },
    { version: '0.1.1', tag: 'v0.1.1', channel: 'stable' },
  ]) assert.throws(() => assertReleaseRequest(request(overrides)));
});

test('exact CI gate rejects failed, foreign, PR and mismatched source runs', () => {
  const identity = request(), successful = ciRun(identity);
  assertSuccessfulChecks(successful, identity);
  for (const mutation of [{ head_sha: 'b'.repeat(40) }, { conclusion: 'failure' }, { status: 'in_progress' },
    { event: 'pull_request' }, { head_repository: { full_name: 'other/repo' } }, { id: 41 }, { path: '.github/workflows/desktop.yml' }])
    assert.throws(() => assertSuccessfulChecks({ ...successful, ...mutation }, identity), /not successful/);
});

test('native delivery must retain exact clean source, run attempt, hard license and final-payload smoke', () => {
  const identity = request(), artifact = { path: 'setup.exe', bytes: 3, sha256: 'c'.repeat(64) };
  const manifest = { version: identity.version, target: 'win32-x64', signing: 'unsigned', source: { commit: identity.sha, dirty: false },
    ci: { repository: identity.repository, commit: identity.sha, runId: '42', attempt: '1' }, releaseAuthorization: { openBlockers: [] }, artifacts: [artifact] };
  const report = { checks: { finalArtifacts: { status: 'passed' }, application: { status: 'passed' }, installStamp: { status: 'passed' } },
    nativeSmoke: { status: 'passed', target: 'win32-x64', scope: 'final-distributable-payload', artifact } };
  assertDeliveryProvenance(manifest, report, identity, 'win32-x64');
  for (const mutate of [value => { value.version = '0.1.0'; }, value => { value.source.dirty = true; },
    value => { value.ci.attempt = '2'; }, value => { value.ci.repository = 'other/repo'; },
    value => { value.releaseAuthorization.openBlockers = ['FONT-LICENSE']; }]) {
    const changed = clone(manifest); mutate(changed);
    assert.throws(() => assertDeliveryProvenance(changed, report, identity, 'win32-x64'));
  }
  const changed = clone(report); changed.nativeSmoke.scope = 'supplied-installed-tree';
  assert.throws(() => assertDeliveryProvenance(manifest, changed, identity, 'win32-x64'), /native smoke/);
});

test('public asset naming preserves installers/feed/stamp and qualifies colliding target materials', () => {
  const common = { target: 'win32-x64', distribution: 'unsigned', artifacts: ['setup.exe'], updateAssets: ['preview.yml', 'desktop-install-stamp-win32-x64.json'] };
  assert.equal(publicAssetName({ ...common, name: 'setup.exe' }), 'setup.exe');
  assert.equal(publicAssetName({ ...common, name: 'preview.yml' }), 'preview.yml');
  assert.equal(publicAssetName({ ...common, name: 'desktop-package.json' }), 'win32-x64-unsigned-desktop-package.json');
  assert.throws(() => publicAssetName({ ...common, name: '../secret' }), /Unsafe/);
});

test('macOS canonical feed contains both ZIP architectures with coherent x64 legacy metadata', () => {
  const fragments = ['x64', 'arm64'].map((arch, index) => {
    const name = `PM-Agent-v4-0.1.1-preview.1-mac-${arch}-signed.zip`;
    const hash = createHash('sha512').update(arch).digest('base64');
    return { version: '0.1.1-preview.1', files: [{ url: name, sha512: hash, size: 100 + index }],
      path: name, sha512: hash, releaseDate: `2026-11-12T00:00:0${index}.000Z` };
  });
  const merged = mergeMacFeeds(fragments, '0.1.1-preview.1');
  assert.deepEqual(merged.files, fragments.flatMap(value => value.files));
  assert.equal(merged.path, fragments[0].path);
  assert.equal(merged.sha512, fragments[0].sha512);
  assert.equal(merged.releaseDate, fragments[0].releaseDate);
  assert.throws(() => mergeMacFeeds(fragments.slice(0, 1), '0.1.1-preview.1'), /Both/);
  assert.throws(() => mergeMacFeeds(fragments.toReversed(), '0.1.1-preview.1'), /architecture/);
  assert.throws(() => mergeMacFeeds(fragments, '0.1.1-preview.2'), /version/);
});

test('staged exact file/byte/hash/checksum set rejects mutation and extra assets', async t => {
  const fixture = await candidate(t);
  assert.equal((await verifyCandidate(fixture.directory, fixture.identity)).assets.length, fixture.contents.size);
  await appendFile(path.join(fixture.directory, 'preview.yml'), 'tamper');
  await assert.rejects(verifyCandidate(fixture.directory, fixture.identity), /Staged asset changed/);
  const second = await candidate(t);
  await writeFile(path.join(second.directory, 'unexpected.txt'), 'extra');
  await assert.rejects(verifyCandidate(second.directory, second.identity), /extra or missing/);
});

test('explicit draft uploads complete assets without exposing a visible update', async t => {
  const fixture = await candidate(t), { client, state } = remote(fixture);
  const result = await publish(fixture, client, { action: 'draft' });
  assert.equal(result.state, 'draft'); assert.equal(result.visible, false);
  assert.equal(state.release.draft, true);
  assert.equal(state.assets.length, fixture.contents.size);
  assert.equal(state.writes.filter(write => write.method === 'PATCH').length, 0);
  assert.equal((await lookupRelease(client, fixture.identity)).visible, false);
});

test('explicit publish changes visibility only after exact complete uploads and two hard gates', async t => {
  const fixture = await candidate(t), { client, state } = remote(fixture);
  let gates = 0;
  const result = await publish(fixture, client, { authorization: async () => { gates++; } });
  assert.equal(result.state, 'published'); assert.equal(result.visible, true); assert.equal(gates, 2);
  assert.equal(state.release.prerelease, true);
  assert.equal(state.release.make_latest, 'false');
  assert.equal(state.writes.at(-1).method, 'PATCH');
  const writes = state.writes.length;
  assert.equal((await publish(fixture, client)).state, 'already-published');
  assert.equal(state.writes.length, writes, 'published release must never be overwritten');
});

test('a later dispatch promotes the exact complete draft without rebuilding or replacing assets', async t => {
  const fixture = await candidate(t), { client, state } = remote(fixture);
  await publish(fixture, client, { action: 'draft' });
  const writes = state.writes.length, originalBody = state.release.body;
  const result = await finalizeExisting({ client, request: request({ runId: '52', attempt: '2', ciRunId: '50' }),
    action: 'publish', authorization: async () => {} });
  assert.equal(result.state, 'published');
  assert.equal(state.writes.length, writes + 1);
  assert.equal(state.writes.at(-1).method, 'PATCH');
  assert.equal(state.release.body, originalBody, 'original native build provenance remains immutable');
  const after = state.writes.length;
  const rerun = await finalizeExisting({ client, request: request({ runId: '53', attempt: '1' }), action: 'publish', authorization: async () => {} });
  assert.equal(rerun.state, 'already-published'); assert.equal(state.writes.length, after);
});

test('OPEN authorization blockers or moved tags reject before release mutation', async t => {
  const fixture = await candidate(t), { client, state } = remote(fixture);
  await assert.rejects(publish(fixture, client, { authorization: async () => { throw new Error('four OPEN release blockers'); } }), /four OPEN/);
  assert.equal(state.writes.length, 0);
  state.movedTag = true;
  await assert.rejects(publish(fixture, client), /tag no longer/);
  assert.equal(state.writes.length, 0);
});

test('failed upload retains a nonvisible draft and exact retry only uploads missing assets', async t => {
  const fixture = await candidate(t), { client, state } = remote(fixture);
  state.failUpload = true;
  await assert.rejects(publish(fixture, client), /Interrupted asset upload/);
  assert.equal(state.release.draft, true); assert.equal(state.assets.length, 2);
  assert.equal(state.writes.some(write => write.method === 'PATCH'), false);
  state.failUpload = false;
  assert.equal((await publish(fixture, client)).state, 'published');
  assert.equal(state.writes.filter(write => write.method === 'UPLOAD').length, fixture.contents.size);
});

test('gate or tag failure immediately before visibility keeps the fully staged release draft', async t => {
  for (const mode of ['license', 'tag']) {
    const fixture = await candidate(t), { client, state } = remote(fixture);
    let gates = 0;
    await assert.rejects(publish(fixture, client, { authorization: async () => {
      if (++gates === 2) {
        if (mode === 'license') throw new Error('release gate reopened');
        state.movedTag = true;
      }
    } }), mode === 'license' ? /gate reopened/ : /tag no longer/);
    assert.equal(state.release.draft, true); assert.equal(state.assets.length, fixture.contents.size);
    assert.equal(state.writes.some(write => write.method === 'PATCH'), false);
  }
});

test('mismatched existing draft and published assets fail closed without replacement', async t => {
  const fixture = await candidate(t), { client, state } = remote(fixture);
  await publish(fixture, client, { action: 'draft' });
  state.assets[0].digest = `sha256:${'b'.repeat(64)}`;
  const writes = state.writes.length;
  await assert.rejects(publish(fixture, client), /hash mismatch/);
  assert.equal(state.writes.length, writes); assert.equal(state.release.draft, true);
  state.release.draft = false;
  await assert.rejects(lookupRelease(client, request({ sha: 'b'.repeat(40) })), /source\/channel identity/);
  assert.equal(state.writes.length, writes);
});

test('remote verifier rejects missing, extra, duplicate, uploading and corrupt assets', async () => {
  const expected = [{ name: 'preview.yml', bytes: 5, sha256: 'a'.repeat(64) }];
  const asset = { id: 1, name: 'preview.yml', state: 'uploaded', size: 5, digest: `sha256:${'a'.repeat(64)}` };
  await assertRemoteAssets({}, [asset], expected);
  await assert.rejects(assertRemoteAssets({}, [], expected), /missing/);
  for (const actual of [[asset, asset], [{ ...asset, name: 'unknown' }], [{ ...asset, state: 'starter' }],
    [{ ...asset, size: 4 }], [{ ...asset, digest: `sha256:${'b'.repeat(64)}` }]])
    await assert.rejects(assertRemoteAssets({}, actual, expected));
  await assertRemoteAssets({ digest: async () => 'a'.repeat(64) }, [{ ...asset, digest: null }], expected);
});

test('GitHub asset redirects never forward workflow credentials off the fixed API host', async () => {
  const calls = [];
  const client = createGitHubClient('synthetic-workflow-token', async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/native/fixture' } });
    return new Response('index');
  });
  assert.equal((await client.readAsset({ id: 2, size: 5 })).toString(), 'index');
  assert.match(calls[0].url, /^https:\/\/api.github.com\/repos\/Crsei\/project-management-agent-v4\//);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-workflow-token');
  assert.equal(calls[1].options.headers, undefined);
  const untrusted = createGitHubClient('synthetic-workflow-token', async () => new Response(null,
    { status: 302, headers: { location: 'https://example.invalid/secret' } }));
  await assert.rejects(untrusted.readAsset({ id: 2, size: 5 }), /Unexpected GitHub release asset/);
});

test('signed stable publication is non-prerelease and becomes the stable latest release', async t => {
  const fixture = await candidate(t, request({ version: '0.1.1', tag: 'v0.1.1', channel: 'stable', distribution: 'signed' }));
  const { client, state } = remote(fixture);
  assert.equal((await publish(fixture, client)).state, 'published');
  assert.equal(state.release.prerelease, false);
  assert.equal(state.release.make_latest, 'true');
});

test('second updater build has a new immutable version tag and cannot replace its baseline release', async t => {
  const baseline = await candidate(t), { client, state } = remote(baseline);
  await publish(baseline, client);
  const writes = state.writes.length;
  const candidateIdentity = request({ version: '0.1.1-preview.2', tag: 'v0.1.1-preview.2', runId: '52' });
  assertReleaseRequest(candidateIdentity);
  await assert.rejects(verifyCandidate(baseline.directory, candidateIdentity), /identity differs/);
  assert.equal((await lookupRelease(client, candidateIdentity)), null);
  assert.equal(state.writes.length, writes);
});
