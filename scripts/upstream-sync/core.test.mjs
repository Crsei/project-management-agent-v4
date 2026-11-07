import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { analyzeChanges, assertAllowedPaths, assertIdentity, candidateTree, handoff, inspect, prepare, record, runIsolatedVerification, snapshotTree, validateHandoff, verify, workingTreeChanges } from './core.mjs';
import { cleanEnvironment, encode, file, git, identity, listTree, mergeBytes, publish, readBlob, relative, resolveCommit, sha256, sourceRepository } from './io.mjs';
import { parseArguments } from '../upstream-sync.mjs';
import { resourceClosure } from '../../vendor/cc-switch/scripts/closure.mjs';
import { patchBytes } from '../../vendor/cc-switch/scripts/provenance.mjs';
import { loadProfile as loadCcProfile } from './cc-switch.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'upstream-core-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '--template=', '--initial-branch=fixture']);
  const env = cleanEnvironment({ GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
  async function commit(message = 'fixture') {
    // Disposable fixture repos only: never commit a real repository in tests.
    await git(root, ['add', '--all']);
    await git(root, ['commit', '-m', message], { env });
    return resolveCommit(root, 'HEAD');
  }
  return { root, commit };
}
async function profileAt(source, commit, paths = ['pkg/main.ts']) {
  const tree = new Map((await listTree(source, commit)).map(entry => [entry.path, entry]));
  const inputs = [];
  for (const name of paths) {
    const bytes = await readBlob(source, commit, name), entry = tree.get(name);
    inputs.push({ path: name, commit, sha256: sha256(bytes), bytes: bytes.length, gitMode: entry.mode, blob: entry.blob });
  }
  return { id: 't3code', upstreamCommit: commit, inputs, selection: { trees: ['pkg'], files: [] }, metadataPaths: ['vendor/t3code/source-manifest.json'], outputs: inputs.map(input => ({ path: 'vendor/t3code/' + input.path, sourcePath: input.path, sourceCommit: input.commit, sha256: input.sha256, mode: input.gitMode === '100755' ? 0o755 : 0o644, kind: 'pristine' })), protectedPaths: ['vendor/other'], authoringTrees: ['vendor/t3code/integration-patches'] };
}

test('three-way merge preserves meaningful disjoint upstream and host changes', async () => {
  const base = Buffer.from('export const upstream = 1;\n\nexport const retained = true;\n\nexport const host = 1;\n');
  const local = Buffer.from(base.toString().replace('host = 1', 'host = 2'));
  const next = Buffer.from(base.toString().replace('upstream = 1', 'upstream = 2'));
  const merged = await mergeBytes(base, local, next);
  assert.equal(merged.conflict, false);
  assert.equal(merged.bytes.toString(), next.toString().replace('host = 1', 'host = 2'));
});

test('overlapping merge exposes all three sides instead of accepting ours or theirs', async () => {
  const merged = await mergeBytes(Buffer.from('const policy = "base";\n'), Buffer.from('const policy = "host-safety";\n'), Buffer.from('const policy = "new-api";\n'));
  assert.equal(merged.conflict, true);
  assert.equal(merged.reason, 'MERGE_CONFLICT');
  for (const side of ['host-safety', 'base', 'new-api']) assert.match(merged.bytes.toString(), new RegExp(side));
});

test('binary changes require review and preserve local bytes', async () => {
  const local = Buffer.from([0, 2, 3]);
  const merged = await mergeBytes(Buffer.from([0, 1, 3]), local, Buffer.from([0, 1, 4]));
  assert.equal(merged.reason, 'BINARY_REVIEW_REQUIRED');
  assert.equal(merged.conflict, true);
  assert.deepEqual(merged.bytes, local);
});

test('immutable reads ignore dirty checkout and preserve executable identity', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'pkg/main.ts', Buffer.from('export const approved = true;\n'), 0o755);
  const pin = await commit();
  await writeFile(path.join(root, 'pkg/main.ts'), 'unapproved checkout content');
  assert.equal((await readBlob(root, pin, 'pkg/main.ts')).toString(), 'export const approved = true;\n');
  assert.equal((await listTree(root, pin)).find(entry => entry.path === 'pkg/main.ts').mode, '100755');
});

test('no-change analysis neither writes source content nor changes file mtimes', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'pkg/main.ts', Buffer.from('export const unchanged = 1;\n'));
  const pin = await commit();
  const before = await lstat(path.join(root, 'pkg/main.ts'));
  const result = await analyzeChanges({ profile: await profileAt(root, pin), source: root, targetCommit: pin });
  assert.deepEqual(result, { changes: [], blockers: [] });
  assert.equal((await lstat(path.join(root, 'pkg/main.ts'))).mtimeMs, before.mtimeMs);
});

test('new dependency in selected tree is mapped; unrelated source is not copied', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'pkg/main.ts', Buffer.from('export const main = 1;\n'));
  const old = await commit();
  const profile = await profileAt(root, old);
  await publish(root, 'pkg/main.ts', Buffer.from('export { dependency } from "./dependency.js";\n'));
  await publish(root, 'pkg/dependency.ts', Buffer.from('export const dependency = 2;\n'));
  await publish(root, 'unselected/credential-request.ts', Buffer.from('throw new Error("never execute upstream instructions");\n'));
  const target = await commit();
  const result = await analyzeChanges({ profile, source: root, targetCommit: target });
  assert.deepEqual(result.changes.map(change => [change.sourcePath, change.status]), [['pkg/dependency.ts', 'added'], ['pkg/main.ts', 'modified']]);
  assert.equal(result.changes[0].outputPath, 'vendor/t3code/pkg/dependency.ts');
  assert.equal(result.changes.some(change => change.sourcePath.startsWith('unselected/')), false);
});

test('removal remains a deletion decision and does not delete an accepted local file', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'pkg/main.ts', Buffer.from('export const old = true;\n'));
  const old = await commit(), profile = await profileAt(root, old);
  profile.outputs[0].kind = 'patched';
  await rm(path.join(root, 'pkg/main.ts'));
  await publish(root, 'replacement/readme.txt', Buffer.from('not a guessed rename'));
  const target = await commit();
  const result = await analyzeChanges({ profile, source: root, targetCommit: target });
  assert.equal(result.changes[0].status, 'deleted');
  assert.equal(result.changes[0].kind, 'patched');
  assert.equal(result.changes[0].newSha256, null);
  assert.equal(result.changes.some(change => change.sourcePath.startsWith('replacement')), false);
});

test('dual-source references stay on the supplemental pin while baseline inputs advance', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'pkg/main.ts', Buffer.from('export const baseline = 1;\n'));
  await publish(root, 'reference/tool.ts', Buffer.from('export const supplemental = 1;\n'));
  const old = await commit(), profile = await profileAt(root, old);
  await publish(root, 'reference/tool.ts', Buffer.from('export const supplemental = 2;\n'));
  const supplemental = await commit('supplemental');
  const referenceProfile = await profileAt(root, supplemental, ['reference/tool.ts']);
  profile.inputs.push(...referenceProfile.inputs);
  profile.outputs.push({ path: 'apps/host/derived.ts', kind: 'derived', mode: 0o644, inputs: [profile.inputs[0], referenceProfile.inputs[0]] });
  await publish(root, 'pkg/main.ts', Buffer.from('export const baseline = 2;\n'));
  await publish(root, 'reference/tool.ts', Buffer.from('export const supplemental = 999;\n'));
  const target = await commit('target');
  const result = await analyzeChanges({ profile, source: root, targetCommit: target });
  assert.equal(result.blockers.length, 0);
  assert.equal(result.changes.some(change => change.sourceCommit === supplemental), false);
  const derived = result.changes.find(change => change.outputPath === 'apps/host/derived.ts');
  assert.equal(derived.sourceCommit, old);
  assert.equal(derived.targetSourceCommit, target);
  assert.equal(derived.kind, 'derived');
});

test('missing object never falls back to checkout bytes', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'pkg/main.ts', Buffer.from('working checkout is not a missing commit'));
  await commit();
  await assert.rejects(readBlob(root, 'a'.repeat(40), 'pkg/main.ts'), /git failed/);
  await assert.rejects(readBlob(root, await resolveCommit(root, 'HEAD'), 'pkg/missing.ts'), /MISSING_OR_UNSAFE_OBJECT/);
});

test('ref injection and path traversal are refused before Git or filesystem writes', async t => {
  const { root } = await fixture(t);
  for (const ref of ['--upload-pack=evil', 'HEAD\n--exec=evil', 'HEAD bad']) await assert.rejects(resolveCommit(root, ref), /UNSAFE_REF/);
  for (const name of ['../escape', '/absolute', 'a/../../escape', 'a\\b', 'a\0b', 'a:b', '.git/config', 'x/.GIT/config', '.upstream-sync/state.json', 'a//b']) assert.throws(() => relative(name), /UNSAFE_PATH/);
  await assert.rejects(publish(root, '../escape', Buffer.from('no')), /UNSAFE_PATH/);
});

test('symlinks, hard links and special bits are rejected while ordinary permissions are preserved', async t => {
  const { root } = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'upstream-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, 'link'));
  await assert.rejects(publish(root, 'link/escape', Buffer.from('no')), /UNSAFE_PATH/);
  await publish(root, 'original', Buffer.from('original'));
  await link(path.join(root, 'original'), path.join(root, 'hardlink'));
  await assert.rejects(file(root, 'hardlink'), /UNSAFE_PATH/);
  await writeFile(path.join(root, 'restricted'), 'private', { mode: 0o600 });
  const before = await lstat(path.join(root, 'restricted'));
  assert.equal((await file(root, 'restricted')).mode, 0o644);
  const after = await lstat(path.join(root, 'restricted'));
  assert.equal(after.mode, before.mode);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  await chmod(path.join(root, 'restricted'), 0o2600);
  await assert.rejects(file(root, 'restricted'), /UNSAFE_PATH/);
  assert.equal(await lstat(path.join(outside, 'escape')).catch(error => error.code), 'ENOENT');
});

test('baseline source bytes, blob and mode must all match the pinned inventory', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'pkg/main.ts', Buffer.from('export const correct = true;\n'));
  const pin = await commit(), profile = await profileAt(root, pin);
  profile.inputs[0].sha256 = '0'.repeat(64);
  const result = await analyzeChanges({ profile, source: root, targetCommit: pin });
  assert.equal(result.blockers[0].code, 'SOURCE_BASELINE_DRIFT');
});

test('candidate fingerprint binds file content, mode and unknown side effects', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'approved.ts', Buffer.from('approved'));
  await publish(root, '.gitignore', Buffer.from('ignored-source.ts\nnode_modules/\n'));
  await commit();
  const first = await snapshotTree(root);
  await chmod(path.join(root, 'approved.ts'), 0o755);
  assert.notEqual(identity(await snapshotTree(root)), identity(first));
  await chmod(path.join(root, 'approved.ts'), 0o644);
  await publish(root, 'ignored-source.ts', Buffer.from('hidden implementation'));
  assert.notEqual(identity(await snapshotTree(root)), identity(first));
  const profile = { outputs: [{ path: 'approved.ts' }], metadataPaths: [], protectedPaths: [], authoringTrees: [] };
  assert.throws(() => assertAllowedPaths(['ignored-source.ts'], profile, { changes: [] }), /UNAPPROVED_CANDIDATE_PATH/);
});

test('tool, base, candidate and policy changes invalidate identity independently', () => {
  const baseline = { tools: [{ path: 'tool.mjs', sha256: 'a' }], baseCommit: 'b'.repeat(40), candidate: 'c', policyHash: 'p' };
  for (const [key, value] of [['tools', []], ['baseCommit', 'd'.repeat(40)], ['candidate', 'changed'], ['policyHash', 'changed']]) assert.throws(() => assertIdentity(baseline, { ...baseline, [key]: value }, 'plan'), /STALE_PLAN/);
  assert.doesNotThrow(() => assertIdentity({ b: 2, a: 1 }, { a: 1, b: 2 }));
});

test('allowlist rejects cross-fork, workflow and tooling edits even when supplied by a plan', () => {
  const profile = { outputs: [{ path: 'vendor/t3code/allowed.ts' }], metadataPaths: ['scripts/upstream-publish.mjs'], protectedPaths: ['vendor/other'], authoringTrees: [] };
  const plan = { changes: [{ outputPath: '.github/workflows/evil.yml' }, { outputPath: 'vendor/other/consumer.ts' }] };
  for (const name of ['.github/workflows/evil.yml', 'scripts/upstream-publish.mjs', 'vendor/other/consumer.ts', 'unlisted.ts']) assert.throws(() => assertAllowedPaths([name], profile, plan), /UNAPPROVED_CANDIDATE_PATH/);
  assert.doesNotThrow(() => assertAllowedPaths(['vendor/t3code/allowed.ts'], profile, plan));
});

test('private candidate tree includes new binary/executable files and deletions without changing the index', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'old.ts', Buffer.from('old'));
  const base = await commit();
  const indexBefore = (await git(root, ['write-tree'])).stdout.toString();
  await rm(path.join(root, 'old.ts'));
  const binary = Buffer.from([0, 1, 2, 255]);
  await publish(root, 'new tool.bin', binary, 0o755);
  const { treeHash, diff: diffBytes } = await candidateTree(root, base, ['new tool.bin', 'old.ts']);
  assert.match(treeHash, /^[a-f0-9]{40}$/);
  await assert.rejects(git(root, ['cat-file', '-e', treeHash]), /git failed/);
  assert.equal((await git(root, ['write-tree'])).stdout.toString(), indexBefore);
  const diff = diffBytes.toString();
  assert.match(diff, /GIT binary patch/);
  assert.match(diff, /deleted file mode/);
  assert.match(diff, /new file mode 100755/);
});

test('bare source repositories and rewritten refs resolve to immutable commits', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'pkg/main.ts', Buffer.from('first'));
  const first = await commit();
  await git(root, ['tag', 'moving']);
  await publish(root, 'pkg/main.ts', Buffer.from('second'));
  const second = await commit();
  await git(root, ['tag', '-f', 'moving', second]);
  assert.equal((await readBlob(root, first, 'pkg/main.ts')).toString(), 'first');
  assert.equal(await resolveCommit(root, 'moving'), second);
  assert.notEqual(first, second);
  const bare = path.join(root, 'bare.git');
  await mkdir(bare);
  await git(bare, ['init', '--bare', '--template=']);
  assert.equal(await sourceRepository(bare), bare);
});

test('unreviewed JSON is not a command interface and invalid plans cannot create candidates', async t => {
  const { root } = await fixture(t);
  assert.throws(() => parseArguments(['verify', '--candidate', root, '--command', 'touch /tmp/escaped']), /Invalid arguments/);
  assert.throws(() => parseArguments(['inspect', '--project', 't3code', '--source', 'relative', '--target', 'HEAD']), /must be absolute/);
  const destination = path.join(root, 'must-not-exist');
  await assert.rejects(prepare({ plan: { schemaVersion: 1, project: 'arbitrary-plugin', command: 'evil' }, destination }), /INVALID_PLAN/);
  assert.equal(await lstat(destination).catch(error => error.code), 'ENOENT');
});

test('publisher handoff rejects altered identity before using any supplied candidate path', async t => {
  const { root } = await fixture(t);
  const artifact = path.join(root, 'artifact');
  await mkdir(artifact);
  await publish(artifact, 'handoff.json', encode({ schemaVersion: 1, handoffId: 'f'.repeat(64), candidate: '/unreviewed/arbitrary', ready: true, verification: { scope: 'full', status: 'passed' } }));
  await assert.rejects(validateHandoff({ handoff: artifact }), /INVALID_HANDOFF_IDENTITY/);
});

test('credential and injection environment is never forwarded to trusted Git subprocesses', () => {
  const original = { GH_TOKEN: process.env.GH_TOKEN, NODE_OPTIONS: process.env.NODE_OPTIONS, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT };
  try {
    process.env.GH_TOKEN = 'synthetic-no-real-token';
    process.env.NODE_OPTIONS = '--require=/unreviewed/module';
    process.env.GIT_CONFIG_COUNT = '9';
    const clean = cleanEnvironment();
    for (const name of Object.keys(original)) assert.equal(clean[name], undefined);
    assert.equal(clean.GIT_CONFIG_GLOBAL, '/dev/null');
  } finally {
    for (const [name, value] of Object.entries(original)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('clean filters cannot execute while the core checks working bytes and staged identities', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, '.gitattributes', Buffer.from('*.txt filter=hostile\n'));
  await publish(root, 'source.txt', Buffer.from('accepted'));
  await commit();
  const sentinel = path.join(root, 'filter-executed');
  await git(root, ['config', 'filter.hostile.clean', `sh -c 'printf executed > "${sentinel}"; cat'`]);
  await git(root, ['config', 'filter.hostile.required', 'true']);
  assert.deepEqual(await workingTreeChanges(root), []);
  await writeFile(path.join(root, 'source.txt'), 'reviewed candidate');
  assert.deepEqual(await workingTreeChanges(root), ['source.txt']);
  const blob = (await git(root, ['hash-object', '-w', '--no-filters', '--stdin'], { input: 'reviewed candidate' })).stdout.toString().trim();
  await git(root, ['update-index', '--cacheinfo', `100644,${blob},source.txt`]);
  assert.deepEqual(await workingTreeChanges(root), ['source.txt']);
  assert.equal(await lstat(sentinel).catch(error => error.code), 'ENOENT');
});

test('Git replacement refs cannot alter immutable blob reads', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'pkg/main.ts', Buffer.from('pinned original'));
  const pin = await commit();
  const original = (await listTree(root, pin)).find(entry => entry.path === 'pkg/main.ts').blob;
  const impostor = (await git(root, ['hash-object', '-w', '--no-filters', '--stdin'], { input: 'replacement injection' })).stdout.toString().trim();
  await git(root, ['update-ref', `refs/replace/${original}`, impostor]);
  assert.equal((await readBlob(root, pin, 'pkg/main.ts')).toString(), 'pinned original');
});

test('full namespace hides host files and credentials and protects control receipts', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'source.ts', Buffer.from('reviewed source'));
  await commit();
  const control = path.join(root, '.upstream-sync');
  await mkdir(control);
  await writeFile(path.join(control, 'state.json'), 'trusted parent receipt', { mode: 0o644 });
  const outside = await mkdtemp(path.join(tmpdir(), 'upstream-host-only-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const hostOnly = path.join(outside, 'synthetic-secret');
  await writeFile(hostOnly, 'synthetic fixture only');
  const script = `
    const fs = require('node:fs');
    if (process.env.GH_TOKEN || process.env.NODE_OPTIONS || process.env.AWS_SECRET_ACCESS_KEY) process.exit(11);
    if (fs.existsSync(${JSON.stringify(hostOnly)})) process.exit(12);
    try { fs.writeFileSync('/workspace/.upstream-sync/state.json', 'forged pass'); process.exit(13); } catch (e) { if (!['EROFS','EACCES','EPERM'].includes(e.code)) throw e; }
    fs.writeFileSync('/workspace/.upstream-sync/verification-output/owned-result', 'isolated');
  `;
  let results;
  try { results = await runIsolatedVerification(root, [{ id: 'namespace-boundary', command: process.execPath, args: ['-e', script] }]); }
  catch (error) {
    if (/ISOLATION_PREREQUISITE/.test(error.message)) { t.skip(error.message); return; }
    throw error;
  }
  if (results[0].status !== 'passed' && /(?:Operation not permitted|No permissions to create|user namespace|Creating new namespace failed)/i.test(results[0].message ?? '')) {
    t.skip('Host kernel disables required unprivileged namespaces; no unsafe fallback executed');
    return;
  }
  assert.equal(results[0].status, 'passed', results[0].message);
  assert.equal(await readFile(path.join(control, 'state.json'), 'utf8'), 'trusted parent receipt');
  assert.equal(await readFile(path.join(control, 'verification-output/owned-result'), 'utf8'), 'isolated');
});

test('failed namespace tests retain stdout diagnostics for missing dependencies', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'dependency.test.mjs', Buffer.from("import test from 'node:test';\ntest('loads its runtime dependency', async () => { await import('@upstream-maintenance/missing-for-smoke'); });\n"));
  await commit();
  await mkdir(path.join(root, '.upstream-sync'));
  const [result] = await runIsolatedVerification(root, [{ id: 'dependency-check', command: process.execPath, args: ['--test', 'dependency.test.mjs'] }]);
  assert.equal(result.status, 'failed');
  assert.match(result.stdoutExcerpt, /ERR_MODULE_NOT_FOUND/);
  assert.match(result.stdoutExcerpt, /@upstream-maintenance\/missing-for-smoke/);
  assert.equal(result.stderrExcerpt, '');
});

async function lifecycleFixture(t) {
  const upstream = await fixture(t), host = await fixture(t);
  const original = Buffer.from('export const upstream = 1;\n\nexport const keep = true;\n\nexport const host = 1;\n');
  await publish(upstream.root, 'LICENSE', Buffer.from('MIT fixture\n'));
  await publish(upstream.root, 'package.json', Buffer.from('{"name":"cc-fixture","version":"1.0.0"}\n'));
  await publish(upstream.root, 'src/main.ts', original);
  const old = await upstream.commit();
  const prefix = 'vendor/cc-switch/';
  await publish(host.root, '.gitignore', Buffer.from('node_modules/\n'));
  await publish(host.root, 'host/build.json', Buffer.from('{}\n'));
  await publish(host.root, 'package.json', Buffer.from('{"private":true,"type":"module"}\n'));
  const sourceTree = await listTree(upstream.root, old);
  const originals = new Map();
  for (const entry of sourceTree) originals.set(entry.path, await readBlob(upstream.root, old, entry.path));
  const sourceFiles = sourceTree.map(entry => ({ path: entry.path, mode: entry.mode, blob: entry.blob, sha256: sha256(originals.get(entry.path)), bytes: originals.get(entry.path).length }));
  const manifest = { schemaVersion: 1, upstream: 'https://github.com/farion1231/cc-switch', commit: old, version: '1.0.0', license: 'MIT', selection: ['LICENSE', 'package.json', 'src'], files: sourceFiles };
  const manifestBytes = encode(manifest);
  const policy = { version: 1, upstreamCommit: old, sourceManifestSha256: sha256(manifestBytes), productionRoots: [prefix + 'src/main.ts'], hostBuildInputs: ['host/build.json'], ownedTrees: ['vendor/cc-switch'], generatedTrees: [], sourceReferenceDocuments: [], dynamicResources: [] };
  const policyBytes = encode(policy), outputs = [], patches = [];
  async function enroll(name, bytes, source = null) {
    await publish(host.root, name, bytes);
    const output = { destination: name, sha256: sha256(bytes), bytes: bytes.length, mode: 0o644, provenance: source ? 'pristine-upstream' : 'local-fork-integration', reason: 'Synthetic exact replay fixture' };
    if (source) {
      output.source = source;
      output.upstreamSha256 = sha256(originals.get(source));
      if (!bytes.equals(originals.get(source))) {
        const recipePath = prefix + 'integration-patches/' + source + '.json';
        const recipe = patchBytes(originals.get(source), bytes, source);
        output.patch = { path: recipePath, sha256: sha256(recipe) };
        output.provenance = 'patched-upstream';
        patches.push(output.patch);
        await publish(host.root, recipePath, recipe);
      }
    } else {
      const recipePath = prefix + 'integration-patches/local/' + name + '.json';
      const recipe = encode({ version: 1, destination: name, sha256: output.sha256, mode: output.mode, encoding: 'base64', content: bytes.toString('base64') });
      output.asset = { path: recipePath, sha256: sha256(recipe) };
      patches.push(output.asset);
      await publish(host.root, recipePath, recipe);
    }
    outputs.push(output);
  }
  for (const [name, bytes] of originals) await enroll(prefix + name, name === 'src/main.ts' ? Buffer.from(bytes.toString().replace('host = 1', 'host = 2')) : bytes, name);
  await enroll(prefix + 'source-manifest.json', manifestBytes);
  await enroll(prefix + 'fork-policy.json', policyBytes);
  await enroll(prefix + 'host-only.json', Buffer.from('{"local":"preserve"}\n'));
  await mkdir(path.join(host.root, 'node_modules'));
  const require = createRequire(import.meta.url);
  await symlink(path.dirname(require.resolve('typescript/package.json')), path.join(host.root, 'node_modules/typescript'), 'dir');
  const closure = await resourceClosure(host.root, policy, outputs, sourceTree.map(entry => entry.path).sort());
  const tree = encode({ version: 1, upstreamCommit: old, paths: sourceTree.map(entry => entry.path).sort() });
  const inventory = { version: 1, upstreamCommit: old, sourceManifestSha256: sha256(manifestBytes), policySha256: sha256(policyBytes), closureSha256: sha256(closure), upstreamTreeSha256: sha256(tree), hostBuildInputs: [{ path: 'host/build.json', sha256: sha256('{}\n'), bytes: 3 }], files: outputs.sort((a, b) => a.destination.localeCompare(b.destination)), patches: patches.sort((a, b) => a.path.localeCompare(b.path)), summary: {} };
  await publish(host.root, prefix + 'resource-closure.json', closure);
  await publish(host.root, prefix + 'upstream-tree.json', tree);
  await publish(host.root, prefix + 'output-inventory.json', encode(inventory));
  const base = await host.commit();
  const owned = await mkdtemp(path.join(tmpdir(), 'upstream-candidate-owned-'));
  t.after(() => rm(owned, { recursive: true, force: true }));
  return { host, upstream, old, base, original, prefix, owned, candidate: path.join(owned, 'candidate') };
}

test('real CLI core lifecycle merges, records exact recipes and hands off diagnostic provenance only', async t => {
  const f = await lifecycleFixture(t);
  const noop = await inspect({ root: f.host.root, source: f.upstream.root, project: 'cc-switch', target: f.old });
  assert.equal(noop.status, 'no-change');
  assert.deepEqual(noop.blockers, []);
  assert.equal((await prepare({ plan: noop, destination: f.candidate })).status, 'no-change');
  assert.equal(await lstat(f.candidate).catch(error => error.code), 'ENOENT');
  await publish(f.upstream.root, 'src/main.ts', Buffer.from(f.original.toString().replace('upstream = 1', 'upstream = 3')));
  await publish(f.upstream.root, 'src/dependency.ts', Buffer.from('export const dependency = 5;\n'));
  const target = await f.upstream.commit();
  const plan = await inspect({ root: f.host.root, source: f.upstream.root, project: 'cc-switch', target });
  assert.equal(plan.status, 'changes');
  const prepared = await prepare({ plan, destination: f.candidate });
  assert.deepEqual(prepared.conflicts, []);
  assert.equal((await prepare({ plan, destination: f.candidate })).resumed, true);
  const sourcePath = f.prefix + 'src/main.ts';
  const merged = (await file(f.candidate, sourcePath)).bytes;
  assert.match(merged.toString(), /upstream = 3/);
  assert.match(merged.toString(), /host = 2/);
  assert.equal((await file(f.host.root, sourcePath)).bytes.toString().includes('upstream = 1'), true);
  const recorded = await record({ candidate: f.candidate });
  assert.equal(recorded.status, 'recorded', JSON.stringify(recorded.blockers));
  assert.deepEqual(recorded.blockers, []);
  assert.equal((await record({ candidate: f.candidate })).resumed, true);
  const evidence = await verify({ candidate: f.candidate, scope: 'provenance' });
  assert.equal(evidence.scope, 'provenance');
  assert.equal(evidence.status, 'passed', JSON.stringify(evidence.checks));
  const artifact = path.join(f.owned, 'handoff');
  const delivered = await handoff({ candidate: f.candidate, output: artifact });
  assert.equal(delivered.ready, false);
  await assert.rejects(validateHandoff({ handoff: artifact }), /FULL_VERIFICATION_REQUIRED/);
  const contents = JSON.parse(await readFile(path.join(artifact, 'handoff.json'), 'utf8'));
  assert.ok(contents.files.some(entry => entry.path.endsWith('src/dependency.ts') && entry.status === 'added'));
  assert.match(await readFile(path.join(artifact, 'changes.patch'), 'utf8'), /src\/dependency\.ts/);
  assert.equal((await file(f.candidate, f.prefix + 'host-only.json')).bytes.toString(), '{"local":"preserve"}\n');
  await publish(f.candidate, sourcePath, Buffer.from(merged.toString().replace('host = 2', 'host = 7')));
  await assert.rejects(handoff({ candidate: f.candidate, output: path.join(f.owned, 'stale') }), /STALE_CANDIDATE/);
  await assert.rejects(record({ candidate: f.candidate }), /REAUTHOR_REQUIRES_EXACT_OUTPUT_APPROVAL/);
  const currentHash = sha256((await file(f.candidate, sourcePath)).bytes);
  const reauthored = await record({ candidate: f.candidate, approvedOutputHashes: { [sourcePath]: currentHash } });
  assert.equal(reauthored.status, 'recorded', JSON.stringify(reauthored.blockers));
  assert.equal((await verify({ candidate: f.candidate, scope: 'provenance' })).status, 'passed');
  assert.notEqual(reauthored.candidateFingerprint, recorded.candidateFingerprint);
});

test('real plans reject baseline drift, altered private tools and unknown candidate side effects', async t => {
  const f = await lifecycleFixture(t);
  await publish(f.upstream.root, 'src/main.ts', Buffer.from(f.original.toString().replace('upstream = 1', 'upstream = 3')));
  const target = await f.upstream.commit();
  const plan = await inspect({ root: f.host.root, source: f.upstream.root, project: 'cc-switch', target });
  await publish(f.host.root, 'host/build.json', Buffer.from('{"unreviewed":true}\n'));
  await assert.rejects(prepare({ plan, destination: f.candidate }), /STALE_PLAN/);
  const driftReport = await inspect({ root: f.host.root, source: f.upstream.root, project: 'cc-switch', target });
  assert.ok(driftReport.blockers.some(item => item.code === 'BASELINE_DRIFT' && item.path === 'host/build.json'));
  await publish(f.host.root, 'host/build.json', Buffer.from('{}\n'));
  await prepare({ plan, destination: f.candidate });
  await publish(f.candidate, 'unexpected.js', Buffer.from('throw new Error("never executed")'));
  await assert.rejects(record({ candidate: f.candidate }), /UNAPPROVED_CANDIDATE_PATH/);
  await rm(path.join(f.candidate, 'unexpected.js'));
  const tool = plan.tools.find(entry => entry.path === 'scripts/upstream-sync/core.mjs');
  const snapshot = path.join(f.candidate, '.upstream-sync/tools', tool.path);
  const original = await readFile(snapshot);
  await writeFile(snapshot, 'unreviewed tools');
  await assert.rejects(record({ candidate: f.candidate }), /STALE_SNAPSHOT_TOOLS/);
  await writeFile(snapshot, original);
  await publish(f.host.root, 'unrelated.txt', Buffer.from('new approved host commit'));
  await f.host.commit();
  await assert.rejects(record({ candidate: f.candidate }), /STALE_PLAN/);
});

test('selected symlink objects are blocked before materialization', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'pkg/main.ts', Buffer.from('export const approved = true;\n'));
  const old = await commit(), profile = await profileAt(root, old);
  await symlink('/unreachable/synthetic-outside', path.join(root, 'pkg/link.ts'));
  const target = await commit();
  const result = await analyzeChanges({ profile, source: root, targetCommit: target });
  assert.ok(result.blockers.some(item => item.code === 'UNSAFE_SOURCE_MODE' && item.path === 'pkg/link.ts'));
  assert.equal(result.changes.some(item => item.sourcePath === 'pkg/link.ts'), false);
});

test('complete selected trees cannot conceal missing baseline inventory members', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'pkg/main.ts', Buffer.from('export const approved = true;\n'));
  await publish(root, 'pkg/unenrolled.ts', Buffer.from('export const dependency = true;\n'));
  const old = await commit();
  const result = await analyzeChanges({ profile: await profileAt(root, old), source: root, targetCommit: old });
  assert.ok(result.blockers.some(item => item.code === 'UNENROLLED_BASELINE_SOURCE' && item.path === 'pkg/unenrolled.ts'));
});

test('promisor sources cannot silently fetch missing objects during read-only inspection', async t => {
  const { root, commit } = await fixture(t);
  await publish(root, 'pkg/main.ts', Buffer.from('cached source'));
  await commit();
  await git(root, ['config', 'remote.origin.promisor', 'true']);
  await assert.rejects(sourceRepository(root), /OFFLINE_OBJECTS_REQUIRED/);
});

async function sharedForkFixture(t) {
  const f = await lifecycleFixture(t);
  const shared = 'apps/server/agent/src/extensions/provider.ts';
  const sharedBytes = Buffer.from('export const revision = 1;\n');
  await publish(f.host.root, shared, sharedBytes);
  // The shared host output is enrolled only as a CC output, not a closure or
  // hostBuildInput. Its local asset remains a valid exact replay recipe.
  const inventoryPath = f.prefix + 'output-inventory.json';
  const inventory = JSON.parse((await file(f.host.root, inventoryPath)).bytes);
  const assetPath = f.prefix + 'integration-patches/local/shared-provider.json';
  const assetBytes = encode({ version: 1, destination: shared, sha256: sha256(sharedBytes), mode: 0o644, encoding: 'base64', content: sharedBytes.toString('base64') });
  const asset = { path: assetPath, sha256: sha256(assetBytes) };
  inventory.files.push({ destination: shared, sha256: sha256(sharedBytes), bytes: sharedBytes.length, mode: 0o644, provenance: 'local-fork-integration', asset });
  inventory.patches.push(asset);
  await publish(f.host.root, assetPath, assetBytes);
  await publish(f.host.root, inventoryPath, encode(inventory));

  // A real independent supplemental Git pin makes source input paths distinct
  // from PM output paths; source-relative inputs must not become host bindings.
  const supplementalPath = 'reference/provider.ts';
  const supplementalBytes = Buffer.from('export const upstreamProvider = true;\n');
  await publish(f.upstream.root, supplementalPath, supplementalBytes);
  const supplemental = await f.upstream.commit('independent T3 supplemental fixture pin');
  const t3 = 'vendor/t3code/';
  const originals = [];
  const copiedOutputs = [];
  for (const entry of await listTree(f.upstream.root, f.old)) {
    const bytes = await readBlob(f.upstream.root, f.old, entry.path);
    const destination = t3 + entry.path;
    originals.push({ source_path: entry.path, destination_path: destination, action: 'copy-verbatim', category: 'fixture', owner: 'fixture', role: 'runtime-or-build-input', sha256: sha256(bytes), bytes: bytes.length, git_blob_sha1: entry.blob, git_mode: entry.mode });
    copiedOutputs.push({ destination, source: entry.path, upstreamSha256: sha256(bytes), sha256: sha256(bytes), bytes: bytes.length, mode: 0o644, provenance: 'pristine-upstream' });
    await publish(f.host.root, destination, bytes);
  }
  const omp = t3 + 'packages/provider-omp/src/server.ts';
  const ompBytes = Buffer.from('export const unrelatedOmp = true;\n');
  await publish(f.host.root, omp, ompBytes);
  copiedOutputs.push({ destination: omp, asset: omp, sha256: sha256(ompBytes), bytes: ompBytes.length, mode: 0o644, provenance: 'local-addition' });
  const supplementTree = new Map((await listTree(f.upstream.root, supplemental)).map(entry => [entry.path, entry]));
  const sourceIdentity = async (commit, name) => {
    const bytes = await readBlob(f.upstream.root, commit, name);
    const entry = (await listTree(f.upstream.root, commit)).find(value => value.path === name);
    return { commit, path: name, sha256: sha256(bytes), bytes: bytes.length, gitBlobSha1: entry.blob, gitMode: entry.mode };
  };
  const license = await readBlob(f.upstream.root, f.old, 'LICENSE');
  const manifest = { manifest_version: 1, upstream: { commit: f.old }, packages: [], files: originals, imports: [], summary: {}, implementation_inventory: { family_ledgers: [] }, consumer_slices: [], adapter_boundaries: [], runtime_resources: { static_source_resource_edges: [] } };
  const manifestBytes = encode(manifest);
  const adaptations = {
    policy: { sourceManifest: 'Immutable fixture originals', replay: 'Exact line splices' },
    version: 1, baselineCommit: f.old, baselineInventory: t3 + 'sync-inventory.json', sourceInventory: t3 + 'mcp-skills-source.json',
    sources: [f.old, supplemental].map(commit => ({ commit, role: 'fixture', license: { spdx: 'MIT', path: 'LICENSE', sha256: sha256(license), distributedPath: t3 + 'LICENSE' } })),
    outputs: [{ destination: shared, provenance: 'adapted-upstream', reason: 'Reviewed shared provider fixture', license: 'MIT; vendor/t3code/LICENSE', inputs: [await sourceIdentity(supplemental, supplementalPath), await sourceIdentity(f.old, 'src/main.ts')], sha256: sha256(sharedBytes), bytes: sharedBytes.length, mode: 0o644, recipe: { kind: 'exact-line-splices', primaryInput: 0, splices: [{ start: 0, before: [supplementalBytes.toString()], after: [sharedBytes.toString()] }] } }],
  };
  const supplementalFiles = [];
  for (const name of ['LICENSE', supplementalPath]) {
    const bytes = await readBlob(f.upstream.root, supplemental, name);
    const entry = supplementTree.get(name);
    supplementalFiles.push({ path: name, sha256: sha256(bytes), bytes: bytes.length, blob: entry.blob, mode: entry.mode });
  }
  await publish(f.host.root, t3 + 'source-manifest.json', manifestBytes);
  await publish(f.host.root, t3 + 'sync-inventory.json', encode({ version: 1, upstreamCommit: f.old, sourceManifestSha256: sha256(manifestBytes), files: copiedOutputs, extractions: [], runtimeResources: { hostBuildInputs: [] } }));
  await publish(f.host.root, t3 + 'mcp-skills-adaptations.json', encode(adaptations));
  await publish(f.host.root, t3 + 'mcp-skills-source.json', encode({ version: 1, upstream: { commit: supplemental, existingVendorCommit: f.old }, files: supplementalFiles }));
  await publish(f.host.root, t3 + 'sync-imports.json', encode({ version: 1, upstreamCommit: f.old, adaptationCommits: [f.old, supplemental], packages: [], edges: [] }));
  await publish(f.host.root, t3 + 'omp-source.json', encode({ classification: 'Local fixture, never upstream' }));
  await publish(f.host.root, t3 + 'integration-patches.json', encode({ reason: 'Reviewed fixture' }));
  await f.host.commit('approved dual-fork shared-output baseline');
  await publish(f.upstream.root, 'src/main.ts', Buffer.from(f.original.toString().replace('upstream = 1', 'upstream = 3')));
  const target = await f.upstream.commit('shared output upstream impact');
  return { ...f, shared, sharedBytes, omp, ompBytes, target, ccInventoryPath: inventoryPath, t3SupplementalPath: t3 + 'mcp-skills-adaptations.json' };
}

test('cross-fork output-only CC inventory blocks T3 shared-host impact without host or closure enrollment', async t => {
  const f = await sharedForkFixture(t);
  const inventory = JSON.parse((await file(f.host.root, f.ccInventoryPath)).bytes);
  const closure = JSON.parse((await file(f.host.root, f.prefix + 'resource-closure.json')).bytes);
  assert.ok(inventory.files.some(entry => entry.destination === f.shared));
  assert.equal(inventory.hostBuildInputs.some(entry => entry.path === f.shared), false);
  assert.equal(closure.inputs.some(entry => entry.path === f.shared), false);
  const report = await inspect({ root: f.host.root, source: f.upstream.root, project: 't3code', target: f.target });
  assert.ok(report.changes.some(change => change.outputPath === f.shared), 'The shared derived output must be genuinely affected');
  assert.ok(report.blockers.some(entry => entry.code === 'BLOCKED_CROSS_FORK' && entry.path === f.shared && entry.inventory === f.ccInventoryPath), 'CC files[].destination must protect the shared output even without path-form enrollment');
});

test('cross-fork supplemental-only T3 output blocks an explicitly approved CC shared-host edit', async t => {
  const f = await sharedForkFixture(t);
  const t3Inventory = JSON.parse((await file(f.host.root, 'vendor/t3code/sync-inventory.json')).bytes);
  assert.equal(t3Inventory.files.some(entry => entry.destination === f.shared), false);
  const plan = await inspect({ root: f.host.root, source: f.upstream.root, project: 'cc-switch', target: f.target });
  assert.deepEqual(plan.blockers, [], 'Unchanged shared output is a valid baseline; upstream-relative supplemental inputs are not PM paths');
  await prepare({ plan, destination: f.candidate });
  const edited = Buffer.from('export const revision = 2;\n');
  await publish(f.candidate, f.shared, edited);
  const result = await record({ candidate: f.candidate, approvedOutputHashes: { [f.shared]: sha256(edited) } });
  assert.equal(result.status, 'blocked', 'Explicit CC approval cannot override another fork supplemental output fingerprint');
  assert.ok(result.blockers.some(entry => entry.code === 'BLOCKED_CROSS_FORK' && entry.path === f.shared && entry.inventory === f.t3SupplementalPath));
  assert.equal(JSON.parse((await file(f.candidate, f.prefix + 'source-manifest.json')).bytes).commit, f.old, 'The new pin must not be written before the cross-fork check');
});

test('CC cross-fork bindings omit accepted retired T3 paths without weakening active owners or proof checks', async t => {
  const f = await sharedForkFixture(t);
  const ledger = JSON.parse((await file(f.host.root, f.t3SupplementalPath)).bytes);
  const destination = 'apps/web/src/retired-owner.ts';
  const bytes = Buffer.from('export const obsolete = true;\n');
  const retired = { destination, provenance: 'local-integration', inputs: [], reason: 'Historical host integration', license: 'Existing repository terms', sha256: sha256(bytes), bytes: bytes.length, mode: 0o644, recipe: { kind: 'local-bytes', base64: bytes.toString('base64') }, retirement: { sha256: sha256(bytes), reason: 'Reviewed removal with no consumers' } };
  ledger.outputs.push(retired);
  await publish(f.host.root, f.t3SupplementalPath, encode(ledger));
  await f.host.commit('accepted absent retirement fixture');
  const report = await inspect({ root: f.host.root, source: f.upstream.root, project: 'cc-switch', target: f.target });
  assert.deepEqual(report.blockers, []);
  const binding = report.externalBindings.find(entry => entry.path === f.t3SupplementalPath);
  assert.ok(binding.references.some(entry => entry.path === f.shared), 'Active external owner remains fingerprinted');
  assert.ok(!binding.references.some(entry => entry.path === destination), 'Historical hash is not an active external binding');
  await prepare({ plan: report, destination: f.candidate });
  const result = await record({ candidate: f.candidate });
  assert.equal(result.status, 'recorded', JSON.stringify(result.blockers));
  retired.retirement.sha256 = '0'.repeat(64);
  await publish(f.host.root, f.t3SupplementalPath, encode(ledger));
  await assert.rejects(inspect({ root: f.host.root, source: f.upstream.root, project: 'cc-switch', target: f.target }), /Malformed adaptation retirement/);
  retired.retirement.sha256 = retired.sha256;
  await publish(f.host.root, f.t3SupplementalPath, encode(ledger));
  await publish(f.host.root, destination, bytes);
  await assert.rejects(inspect({ root: f.host.root, source: f.upstream.root, project: 'cc-switch', target: f.target }), /Retired target exists/);
});


test('first record rejects coherent old-generation inventory and patch forgery hiding an unchanged host safety patch', async t => {
  const f = await lifecycleFixture(t);
  // The upstream update deliberately does not touch the patched main output.
  await publish(f.upstream.root, 'src/dependency.ts', Buffer.from('export const dependency = 5;\n'));
  const target = await f.upstream.commit();
  const plan = await inspect({ root: f.host.root, source: f.upstream.root, project: 'cc-switch', target });
  const outputPath = f.prefix + 'src/main.ts';
  assert.equal(plan.changes.some(change => change.outputPath === outputPath), false);
  await prepare({ plan, destination: f.candidate });
  assert.match((await file(f.candidate, outputPath)).bytes.toString(), /host = 2/);
  const inventoryPath = f.prefix + 'output-inventory.json';
  const inventory = JSON.parse((await file(f.candidate, inventoryPath)).bytes);
  const entry = inventory.files.find(value => value.destination === outputPath);
  // Remove the accepted host behavior and rewrite both exact recipe and its
  // inventory fingerprint coherently. The immutable upstream original is intact.
  const forgedBytes = f.original;
  const forgedRecipe = patchBytes(f.original, forgedBytes, 'src/main.ts');
  await publish(f.candidate, outputPath, forgedBytes);
  await publish(f.candidate, entry.patch.path, forgedRecipe);
  entry.sha256 = sha256(forgedBytes);
  entry.bytes = forgedBytes.length;
  entry.patch.sha256 = sha256(forgedRecipe);
  inventory.patches.find(value => value.path === entry.patch.path).sha256 = entry.patch.sha256;
  await publish(f.candidate, inventoryPath, encode(inventory));
  const forgedProfile = await loadCcProfile(f.candidate);
  assert.equal(forgedProfile.outputs.find(value => value.path === outputPath).sha256, sha256(forgedBytes), 'Forgery is internally coherent, not a malformed-ledger test');
  await assert.rejects(record({ candidate: f.candidate }), /(?:BASELINE|METADATA|PREIMAGE)/, 'First record must authenticate old-generation metadata against prepare, not candidate-authored identities');
  assert.equal(JSON.parse((await file(f.candidate, f.prefix + 'source-manifest.json')).bytes).commit, f.old);
  assert.equal(JSON.parse((await file(f.candidate, inventoryPath)).bytes).upstreamCommit, f.old);
});

test('named dotenv templates are fingerprinted while actual dotenv credential names are refused before reading', async t => {
  const { root, commit } = await fixture(t);
  for (const name of ['.env.example', '.env.agent.example', '.env.agent.sample', '.env.agent.template']) await publish(root, name, Buffer.from('SYNTHETIC_TEMPLATE=\n'));
  await commit();
  const snapshot = await snapshotTree(root);
  assert.ok(snapshot.some(entry => entry.path === '.env.agent.example'));
  for (const name of ['.env', '.env.production', '.env.example.production']) {
    await writeFile(path.join(root, name), 'synthetic fixture, never a real credential', { mode: 0o600 });
    await assert.rejects(snapshotTree(root), /CREDENTIAL_FILE_NOT_ALLOWED/, 'Credential filename rejection must precede content or permission reads');
    await rm(path.join(root, name));
  }
});

test('explicit local-authoring creates a same-pin candidate and records only exact-approved CC output edits', async t => {
  const f = await lifecycleFixture(t);
  const plan = await inspect({ root: f.host.root, source: f.upstream.root, project: 'cc-switch', target: f.old });
  assert.equal(plan.status, 'no-change');
  const defaultResult = await prepare({ plan, destination: f.candidate });
  assert.equal(defaultResult.status, 'no-change');
  assert.equal(await lstat(f.candidate).catch(error => error.code), 'ENOENT');
  const prepared = await prepare({ plan, destination: f.candidate, purpose: 'local-authoring' });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.purpose, 'local-authoring');
  assert.equal((await prepare({ plan, destination: f.candidate, purpose: 'local-authoring' })).resumed, true);
  await assert.rejects(prepare({ plan, destination: f.candidate, purpose: 'upstream-update' }), /STALE_RESUMED_PURPOSE/);
  assert.equal((await record({ candidate: f.candidate })).status, 'no-change');
  const outputPath = f.prefix + 'src/main.ts';
  const baseline = (await file(f.candidate, outputPath)).bytes;
  const edited = Buffer.from(baseline.toString().replace('host = 2', 'host = 7'));
  await publish(f.candidate, outputPath, edited);
  await assert.rejects(record({ candidate: f.candidate }), /LOCAL_AUTHORING_REQUIRES_EXACT_OUTPUT_APPROVAL/);
  await assert.rejects(record({ candidate: f.candidate, approvedOutputHashes: { [outputPath]: sha256(baseline) } }), /STALE_OUTPUT_APPROVAL/);
  const result = await record({ candidate: f.candidate, approvedOutputHashes: { [outputPath]: sha256(edited) } });
  assert.equal(result.status, 'recorded', JSON.stringify(result.blockers));
  assert.deepEqual(result.blockers, []);
  assert.equal(JSON.parse((await file(f.candidate, f.prefix + 'source-manifest.json')).bytes).commit, f.old);
  assert.deepEqual((await file(f.host.root, outputPath)).bytes, baseline, 'The approved host worktree must not be recaptured');
  const evidence = await verify({ candidate: f.candidate, scope: 'provenance' });
  assert.equal(evidence.status, 'passed', JSON.stringify(evidence.checks));
  assert.equal(evidence.purpose, 'local-authoring');
  const output = path.join(f.owned, 'local-handoff');
  await handoff({ candidate: f.candidate, output });
  const artifact = JSON.parse((await file(output, 'handoff.json')).bytes);
  assert.equal(artifact.purpose, 'local-authoring');
  assert.equal(artifact.oldCommit, f.old);
  assert.equal(artifact.targetCommit, f.old);
});

test('local-authoring refuses changed or merely advanced upstream pins and refuses source expansion', async t => {
  const f = await lifecycleFixture(t);
  const current = await inspect({ root: f.host.root, source: f.upstream.root, project: 'cc-switch', target: f.old });
  await assert.rejects(prepare({ plan: current, destination: f.candidate, purpose: 'auto-recapture' }), /INVALID_CANDIDATE_PURPOSE/);
  await publish(f.upstream.root, 'unselected/readme.txt', Buffer.from('unrelated upstream change'));
  const unrelated = await f.upstream.commit();
  const unrelatedPlan = await inspect({ root: f.host.root, source: f.upstream.root, project: 'cc-switch', target: unrelated });
  assert.equal(unrelatedPlan.changes.length, 0);
  await assert.rejects(prepare({ plan: unrelatedPlan, destination: f.candidate, purpose: 'local-authoring' }), /LOCAL_AUTHORING_REQUIRES_SAME_PIN/);
  await publish(f.upstream.root, 'src/main.ts', Buffer.from(f.original.toString().replace('upstream = 1', 'upstream = 3')));
  const changed = await f.upstream.commit();
  const changedPlan = await inspect({ root: f.host.root, source: f.upstream.root, project: 'cc-switch', target: changed });
  assert.ok(changedPlan.changes.length);
  await assert.rejects(prepare({ plan: changedPlan, destination: f.candidate, purpose: 'local-authoring' }), /LOCAL_AUTHORING_REQUIRES_SAME_PIN/);
  assert.equal(await lstat(f.candidate).catch(error => error.code), 'ENOENT');
  await prepare({ plan: current, destination: f.candidate, purpose: 'local-authoring' });
  await assert.rejects(record({ candidate: f.candidate, approvedSourcePaths: ['LICENSE'] }), /LOCAL_AUTHORING_SCOPE_EXPANSION/);
  const policyPath = f.prefix + 'fork-policy.json';
  const frozen = (await file(f.candidate, policyPath)).bytes;
  await assert.rejects(record({ candidate: f.candidate, approvedOutputHashes: { [policyPath]: sha256(frozen) } }), /UNAPPROVABLE_GENERATION_METADATA/);
  const manifestPath = f.prefix + 'source-manifest.json';
  const manifest = JSON.parse((await file(f.candidate, manifestPath)).bytes);
  manifest.version = 'unreviewed production recapture';
  await publish(f.candidate, manifestPath, encode(manifest));
  await assert.rejects(record({ candidate: f.candidate }), /UNREVIEWED_GENERATION_METADATA/);
});

test('initial T3 local-authoring preserves OMP and replays exact same-pin adapter generation', async t => {
  const f = await sharedForkFixture(t);
  const plan = await inspect({ root: f.host.root, source: f.upstream.root, project: 't3code', target: f.old });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.status, 'no-change');
  await prepare({ plan, destination: f.candidate, purpose: 'local-authoring' });
  const unrelated = Buffer.from('export const unrelatedOmp = false;\n');
  await publish(f.candidate, f.omp, unrelated);
  await assert.rejects(record({ candidate: f.candidate, approvedOutputHashes: { [f.omp]: sha256(unrelated) } }), /UNAPPROVED_REVIEW_PATH/);
  await publish(f.candidate, f.omp, f.ompBytes);
  const outputPath = 'vendor/t3code/src/main.ts';
  const baseline = (await file(f.candidate, outputPath)).bytes;
  const edited = Buffer.from(baseline.toString().replace('host = 1', 'host = 8'));
  await publish(f.candidate, outputPath, edited);
  await assert.rejects(record({ candidate: f.candidate }), /LOCAL_AUTHORING_REQUIRES_EXACT_OUTPUT_APPROVAL/);
  const result = await record({ candidate: f.candidate, approvedOutputHashes: { [outputPath]: sha256(edited) } });
  assert.equal(result.status, 'recorded', JSON.stringify(result.blockers));
  assert.deepEqual(result.blockers, []);
  const manifest = JSON.parse((await file(f.candidate, 'vendor/t3code/source-manifest.json')).bytes);
  assert.equal(manifest.upstream.commit, f.old);
  assert.equal(manifest.generation.previousCommit, f.old);
  assert.equal(manifest.generation.purpose, 'local-authoring');
  assert.deepEqual((await file(f.candidate, f.omp)).bytes, f.ompBytes);
  assert.deepEqual((await file(f.host.root, outputPath)).bytes, baseline);
  const evidence = await verify({ candidate: f.candidate, scope: 'provenance' });
  assert.equal(evidence.status, 'passed', JSON.stringify(evidence.checks));
});
