import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectDesktopProductSource, readDesktopProductSource, validateDesktopEvaluation, verifyLiveRegistryMetadata } from './desktop-release-evaluation.mjs';
import { stagePrivateEvaluationMaterial } from './desktop-release-private-material.mjs';
import { collectSourceManifest } from '../benchmarks/dovspace/isolation/source.ts';
import { contentDigest } from '../apps/desktop/scripts/release-materials.mjs';
import { evaluationDigest } from '../benchmarks/dovspace/evaluation/review-schema.ts';

async function metadataFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'desktop-live-fences-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = { 'events/0000000001.json': '{"fixture":"metadata-only"}\n', 'fences/source-1.json': '{"withdrawn":true}\n',
    'online-fences/00000000-0000-4000-8000-000000000001.json': '{"restoreEpoch":1}\n' };
  const tree = [{ path: 'release-authority', type: 'tree', mode: '040000', sha: 'authority' }];
  const trees = { commit: { tree }, authority: { tree: [{ path: 'registry', type: 'tree', mode: '040000', sha: 'registry' }] }, registry: { tree: [] } };
  for (const directory of ['events', 'fences', 'online-fences']) {
    await mkdir(path.join(root, directory));
    trees.registry.tree.push({ path: directory, type: 'tree', mode: '040000', sha: directory });
    trees[directory] = { tree: [] };
    for (const [name, text] of Object.entries(records).filter(([name]) => name.startsWith(`${directory}/`))) {
      const bytes = Buffer.from(text);
      await writeFile(path.join(root, name), bytes);
      trees[directory].tree.push({ path: path.basename(name), type: 'blob', mode: '100644',
        sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') });
    }
  }
  const client = { async get(endpoint) {
    assert.ok(endpoint.startsWith('git/trees/'), 'metadata verification must use read-only tree calls only');
    const result = trees[endpoint.slice('git/trees/'.length)];
    assert.ok(result, `Unexpected fixture authority endpoint ${endpoint}`); return structuredClone(result);
  } };
  return { root, client, trees, records };
}

test('live source metadata compares actual event/fence/online-fence bytes, never private feedback content', async t => {
  const fixture = await metadataFixture(t);
  await mkdir(path.join(fixture.root, 'content'));
  await symlink('/nonexistent-private-content', path.join(fixture.root, 'content', 'not-readable'));
  await verifyLiveRegistryMetadata(fixture.client, fixture.root, 'release-authority/registry', 'commit');
  await writeFile(path.join(fixture.root, 'fences/source-1.json'), '{"withdrawn":false}\n');
  await assert.rejects(verifyLiveRegistryMetadata(fixture.client, fixture.root, 'release-authority/registry', 'commit'), /stale|differs/);
});

test('later online revocation, omitted event, extra local fence, symlink and truncated authority all block', async t => {
  const advanced = await metadataFixture(t);
  advanced.trees['online-fences'].tree.push({ path: 'later.json', type: 'blob', mode: '100644', sha: 'a'.repeat(40) });
  await assert.rejects(verifyLiveRegistryMetadata(advanced.client, advanced.root, 'release-authority/registry', 'commit'), /stale|differs/);
  const missing = await metadataFixture(t); await rm(path.join(missing.root, 'events/0000000001.json'));
  await assert.rejects(verifyLiveRegistryMetadata(missing.client, missing.root, 'release-authority/registry', 'commit'), /stale|differs/);
  const extra = await metadataFixture(t); await writeFile(path.join(extra.root, 'fences/extra.json'), '{}');
  await assert.rejects(verifyLiveRegistryMetadata(extra.client, extra.root, 'release-authority/registry', 'commit'), /stale|differs/);
  const linked = await metadataFixture(t); await rm(path.join(linked.root, 'fences/source-1.json'));
  await symlink(path.join(linked.root, 'events/0000000001.json'), path.join(linked.root, 'fences/source-1.json'));
  await assert.rejects(verifyLiveRegistryMetadata(linked.client, linked.root, 'release-authority/registry', 'commit'), /Unsafe/);
  const truncated = await metadataFixture(t); truncated.trees.events.truncated = true;
  await assert.rejects(verifyLiveRegistryMetadata(truncated.client, truncated.root, 'release-authority/registry', 'commit'), /Incomplete/);
});

test('missing policy/evaluation material is fatal before any remote call or release mutation', async () => {
  let calls = 0;
  const client = { async get() { calls++; throw new Error('No network is authorized by this local test'); } };
  await assert.rejects(validateDesktopEvaluation({ client, request: {}, manifest: {}, env: {} }), /requires exact evaluation material/);
  assert.equal(calls, 0);
});

async function materialDownloadFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'desktop-downloaded-material-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'download'), output = path.join(root, 'private');
  await mkdir(source, { mode: 0o755 });
  await mkdir(path.join(source, 'registry/events'), { recursive: true, mode: 0o755 });
  const hash = 'a'.repeat(64), baseline = { sourceSha: 'a'.repeat(40), sourceState: 'committed-clean', productSha256: hash, harnessSha256: hash, modelConfigSha256: hash, toolPolicySha256: hash, arm: 'raw' };
  const candidate = { ...baseline, sourceSha: 'b'.repeat(40), productSha256: 'b'.repeat(64) };
  const controls = { environmentSha256: hash, budgetSha256: hash, permissionsSha256: hash, fixtureSemanticSha256: hash, fixtureVersion: 'test', controlTransport: 'cli' };
  const experiment = { experimentId: 'private-staging-contract', preregisteredAt: '2026-01-03T00:00:00.000Z',
    dataset: { datasetId: 'test', version: '1', digest: hash }, baseline, candidate, treatment: 'productSha256',
    cells: ['baseline', 'candidate'].map((variant, order) => ({ cellId: variant, pairId: 'pair', cohort: 'critical', taskId: 'K02', taskVersion: '1', variant, arm: 'raw', order,
      requiredCriterionIds: ['safety.permission'], requiredRequirementRevisions: ['1'], controls })) };
  const policy = { schemaVersion: 1, policyId: 'test', version: '1', approvedAt: '2026-01-01T00:00:00.000Z', preregisteredAt: '2026-01-02T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z', experimentSha256: evaluationDigest(experiment), dataset: experiment.dataset, evaluatorSha256: hash, calibrationSha256: hash,
    maximumEvidenceAgeHours: 24, minimumPairs: 1, minimumTaskClusters: 1, absoluteSuccessRate: 1, noninferiorityMargin: 0.05,
    confidenceMethod: 'paired-task-cluster-hoeffding-one-sided-95', requiredCohorts: [{ cohort: 'critical', minimumPairs: 1, absoluteSuccessRate: 1 }],
    criticalCriterionIds: ['safety.permission'], requiredCostCoverage: 1, maximumCostPerAdmissionUsd: 1, maximumP95LatencyMs: 1000,
    exceptions: { allowedGateIds: [], maximumCount: 0, maximumLifetimeHours: 1 } };
  const material = { schemaVersion: 1, reviewRequest: { schemaVersion: 1, reviewId: 'test', reviewerId: 'test', createdAt: '2026-01-04T00:00:00.000Z',
    experiment, ledgerRoot: 'ledger', archives: [], rootCauses: [] },
    decisionRequest: { schemaVersion: 1, decisionId: 'test', reviewerId: 'test', createdAt: '2026-01-04T00:00:00.000Z', expiresAt: '2026-01-05T00:00:00.000Z',
      baseline, candidate, artifactSetSha256: hash, policy, exceptions: [] }, registryDirectory: 'registry', registrySourcePath: 'release-authority/registry' };
  const bytes = Buffer.from(JSON.stringify(material) + '\n');
  await writeFile(path.join(source, 'release-material.json'), bytes, { mode: 0o644 });
  await writeFile(path.join(source, 'registry/events/0000000001.json'), '{"syntheticTransportOnly":true}\n', { mode: 0o644 });
  return { root, source, output, materialSha256: createHash('sha256').update(bytes).digest('hex') };
}

test('Actions-style 0755/0644 downloads become independent 0700/0600 regular files before registry validation', async t => {
  const fixture = await materialDownloadFixture(t), sourceFile = path.join(fixture.source, 'registry/events/0000000001.json');
  await chmod(sourceFile, 0o666);
  const staged = await stagePrivateEvaluationMaterial(fixture);
  for (const directory of ['', 'registry', 'registry/events']) assert.equal((await lstat(path.join(fixture.output, directory))).mode & 0o077, 0);
  const copied = path.join(fixture.output, 'registry/events/0000000001.json'), info = await lstat(copied), original = await lstat(sourceFile);
  assert.equal(info.mode & 0o077, 0); assert.equal(info.nlink, 1); assert.notEqual(info.ino, original.ino);
  assert.equal(original.mode & 0o777, 0o666, 'the download is not chmodded/adopted in place');
  assert.equal(await readFile(copied, 'utf8'), await readFile(sourceFile, 'utf8'));
  assert.equal(staged.inferencePerformed, false);
});

test('private restaging rejects links, content exports, replacement trees and tampered material rather than repairing them', async t => {
  const linked = await materialDownloadFixture(t);
  await symlink(path.join(linked.root, 'outside'), path.join(linked.source, 'registry/events/linked.json'));
  await assert.rejects(stagePrivateEvaluationMaterial(linked), /unsafe|non-regular/);
  const hardlinked = await materialDownloadFixture(t);
  await link(path.join(hardlinked.source, 'release-material.json'), path.join(hardlinked.source, 'linked.json'));
  await assert.rejects(stagePrivateEvaluationMaterial(hardlinked), /regular-file/);
  const content = await materialDownloadFixture(t); await mkdir(path.join(content.source, 'registry/content'));
  await assert.rejects(stagePrivateEvaluationMaterial(content), /content must never/);
  const reused = await materialDownloadFixture(t); await mkdir(reused.output, { mode: 0o700 });
  await assert.rejects(stagePrivateEvaluationMaterial(reused), /already exists/);
  const changed = await materialDownloadFixture(t);
  await writeFile(path.join(changed.source, 'release-material.json'), '{}');
  await assert.rejects(stagePrivateEvaluationMaterial(changed), /bytes differ/);
  const nested = await materialDownloadFixture(t);
  await assert.rejects(stagePrivateEvaluationMaterial({ ...nested, output: path.join(nested.source, 'nested') }), /independent/);
});

test('desktop inventory verifies the exact benchmark server closure projection, not incomparable whole-distribution digests', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'desktop-source-projection-')); t.after(() => rm(root, { recursive: true, force: true }));
  const entries = {
    'package.json': '{}', 'pnpm-workspace.yaml': 'packages: []', 'pnpm-lock.yaml': 'lockfileVersion: 9', 'tsconfig.base.json': '{}',
    'apps/desktop/src/private-state.mjs': 'export const privateState = true;', 'apps/desktop/package.json': '{}',
    'apps/server/agent/src/example.ts': 'export const server = 1;', 'packages/example/src/index.ts': 'export const shared = 1;',
    'vendor/example/index.ts': 'export const vendor = 1;', 'apps/web/src/example.tsx': 'export const web = 1;', 'README.md': 'Public test fixture',
  };
  const files = [];
  for (const [name, text] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true, mode: 0o700 }); await writeFile(path.join(root, name), text);
    files.push({ path: name, bytes: Buffer.byteLength(text), mode: 0o644, sha256: createHash('sha256').update(text).digest('hex') });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const source = { schemaVersion: 1, commit: 'a'.repeat(40), dirty: false, files, sha256: contentDigest(files) };
  const expected = { target: 'win32-x64', commit: source.commit, dirty: false, sha256: source.sha256, inventory: 'desktop-source.json' };
  const actual = await collectSourceManifest(root), projected = projectDesktopProductSource(source, expected);
  assert.equal(projected.sourceHash, actual.sourceHash);
  assert.notEqual(projected.sourceHash, source.sha256);
  assert.ok(projected.files.every(file => !file.path.startsWith('apps/web/') && file.path !== 'README.md'));
  const bytes = Buffer.from(JSON.stringify(source) + '\n'), name = 'win32-x64-unsigned-desktop-source.json';
  await writeFile(path.join(root, name), bytes);
  const asset = { target: 'win32-x64', original: 'desktop-source.json', name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const request = { sha: source.commit, targets: ['win32-x64'] }, manifest = { sources: [expected], assets: [asset] };
  assert.equal(await readDesktopProductSource({ request, manifest, directory: root }), actual.sourceHash);
  assert.equal(await readDesktopProductSource({ client: { readAsset: async () => bytes }, request, manifest, remoteAssets: [{ name, size: bytes.length }] }), actual.sourceHash);
  await writeFile(path.join(root, name), Buffer.concat([bytes, Buffer.from(' ')]));
  await assert.rejects(readDesktopProductSource({ request, manifest, directory: root }), /inventory bytes differ/);
  assert.throws(() => projectDesktopProductSource({ ...source, dirty: true }, expected), /source identity/);
  const changed = structuredClone(source), server = changed.files.find(file => file.path === 'apps/server/agent/src/example.ts');
  server.sha256 = 'f'.repeat(64); changed.sha256 = contentDigest(changed.files);
  assert.notEqual(projectDesktopProductSource(changed, { ...expected, sha256: changed.sha256 }).sourceHash, actual.sourceHash);
});
