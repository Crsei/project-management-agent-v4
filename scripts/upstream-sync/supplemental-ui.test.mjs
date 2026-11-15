import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArguments } from '../upstream-sync.mjs';
import { collectTools, runtimeIdentity } from './core.mjs';
import { encode, git, identity, sha256 } from './io.mjs';
import { prepareSupplemental, recordSupplemental, verifySupplemental } from './supplemental-ui.mjs';

// Control fixtures are deliberately synthetic and never source/publication
// acceptance. Tests exercise refusal before any authoring write or execution.
async function put(root, name, bytes) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), bytes);
}
async function commit(root, message) {
  await git(root, ['add', '--all']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
  return (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supplemental-ui-refusal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate'), hostRoot = path.join(root, 'host'), source = path.join(root, 'source'), control = path.join(root, 'control');
  for (const name of [candidate, hostRoot, source, control, path.join(control, 'originals')]) await mkdir(name, { recursive: true });
  for (const name of [hostRoot, source]) await git(name, ['init', '--initial-branch=main']);
  await put(hostRoot, 'base.txt', 'host base\n');
  const baseCommit = await commit(hostRoot, 'host fixture');
  const output = 'apps/web/src/context.ts', input = 'apps/web/src/context.ts';
  const original = Buffer.from('export const context = "before";\n'), after = Buffer.from('export const context = "after";\n'), license = Buffer.from('MIT fixture\n');
  await put(source, input, after);
  await put(source, 'LICENSE', license);
  const target = await commit(source, 'source fixture');
  const tool = 'scripts/upstream-sync.mjs', toolBytes = Buffer.from('// candidate tool is immutable task data, never executed\n');
  await put(candidate, output, after);
  await put(candidate, tool, toolBytes);
  const files = [
    { path: output, sha256: sha256(original), bytes: original.length, mode: 0o644 },
    { path: tool, sha256: sha256(toolBytes), bytes: toolBytes.length, mode: 0o644 },
  ];
  const baseline = { hostRoot, baseCommit, sourceCommit: target, candidate, kind: 'unapproved-authoring-snapshot-not-publication-evidence', snapshot: { version: 1, files } };
  const baselineBytes = encode(baseline), tools = await collectTools(), runtime = await runtimeIdentity();
  const reviews = {
    version: 1, baselineSha256: sha256(baselineBytes), sourceCommit: target, toolsSha256: identity(tools), runtimeSha256: identity(runtime), toolAssets: [],
    baseline: { authorities: [], crossForkAuthorities: [], outputs: [], hostInputs: [], crossForkHostInputs: [] },
    sources: [{ path: 'LICENSE', sha256: sha256(license), reason: 'Explicit fixture license review' }, { path: input, sha256: sha256(after), reason: 'Explicit fixture selected source' }],
    outputs: [{ path: output, sha256: sha256(after), mode: 0o644, kind: 'derived', reason: 'Explicit fixture output review', inputs: [{ path: input, commit: target, sha256: sha256(after) }] }], dependencies: [],
  };
  const reviewsBytes = encode(reviews);
  await put(control, 'baseline.json', baselineBytes);
  await put(control, 'reviews.json', reviewsBytes);
  const state = { version: 1, kind: 'reviewed-supplemental-ui-authoring-not-publication', status: 'prepared', candidate, hostRoot, baseCommit, source, target, baselineSha256: sha256(baselineBytes), reviewsSha256: sha256(reviewsBytes), originals: [], tools, runtime, bindings: [], preparedFingerprint: 'unused-refusal-precondition' };
  const approvedSourceHashes = Object.fromEntries(reviews.sources.map(entry => [entry.path, entry.sha256]));
  const approvedOutputHashes = { [output]: sha256(after) };
  const options = { candidate, control, approvedSourceHashes, approvedOutputHashes };
  const save = async () => { const bytes = encode(state); await put(control, 'state.json', bytes); options.controlSha256 = sha256(bytes); };
  await save();
  return { root, candidate, hostRoot, source, control, state, options, output, tool, after, reviews, save };
}

test('supplemental CLI requires exact hashes and rejects scope/full and relative controls', () => {
  assert.throws(() => parseArguments(['supplemental-verify', '--candidate', '/tmp/candidate', '--control', '/tmp/control']), /Missing --control-sha256/);
  assert.throws(() => parseArguments(['supplemental-verify', '--candidate', '/tmp/candidate', '--control', '/tmp/control', '--control-sha256', 'a'.repeat(64), '--scope', 'full']), /Invalid arguments/);
  assert.throws(() => parseArguments(['supplemental-verify', '--candidate', '/tmp/candidate', '--control', 'relative', '--control-sha256', 'a'.repeat(64)]), /must be absolute/);
  assert.deepEqual(parseArguments(['supplemental-tools']), { command: 'supplemental-tools', options: {} });
});

test('wrong control receipt is rejected before candidate or source authoring', async t => {
  const f = await fixture(t);
  await assert.rejects(recordSupplemental({ ...f.options, controlSha256: '0'.repeat(64) }), /STALE_REVIEW_OR_BASELINE/);
  assert.equal((await readFile(path.join(f.candidate, f.output))).toString(), f.after.toString());
});

test('source and output allowlists cannot omit, add or change any exact reviewed hash', async t => {
  const f = await fixture(t);
  await assert.rejects(recordSupplemental({ ...f.options, approvedSourceHashes: {} }), /STALE_SOURCE_ALLOWLIST/);
  await assert.rejects(recordSupplemental({ ...f.options, approvedSourceHashes: { ...f.options.approvedSourceHashes, 'unselected.ts': 'a'.repeat(64) } }), /STALE_SOURCE_ALLOWLIST/);
  await assert.rejects(recordSupplemental({ ...f.options, approvedOutputHashes: { [f.output]: 'b'.repeat(64) } }), /STALE_OUTPUT_ALLOWLIST/);
  await assert.rejects(recordSupplemental({ ...f.options, approvedOutputHashes: { ...f.options.approvedOutputHashes, 'apps/web/src/unselected.ts': 'c'.repeat(64) } }), /STALE_OUTPUT_ALLOWLIST/);
});

test('stale immutable source locator, reviewed source bytes and validating tool identities are refused', async t => {
  const f = await fixture(t);
  f.state.tools[0].sha256 = '0'.repeat(64);
  await f.save();
  await assert.rejects(recordSupplemental(f.options), /STALE_TRUSTED_TOOL/);
  f.state.tools = await collectTools();
  await f.save();
  const correctSourceHash = f.reviews.sources[1].sha256;
  f.reviews.sources[1].sha256 = 'f'.repeat(64);
  f.reviews.outputs[0].inputs[0].sha256 = 'f'.repeat(64);
  let bytes = encode(f.reviews);
  await put(f.control, 'reviews.json', bytes);
  f.state.reviewsSha256 = sha256(bytes);
  await f.save();
  await assert.rejects(recordSupplemental(f.options), /STALE_SOURCE_APPROVAL/);
  f.reviews.sources[1].sha256 = correctSourceHash;
  f.reviews.outputs[0].inputs[0].sha256 = correctSourceHash;
  bytes = encode(f.reviews);
  await put(f.control, 'reviews.json', bytes);
  f.state.reviewsSha256 = sha256(bytes);
  await f.save();
  await put(f.source, 'later.txt', 'later source HEAD\n');
  await commit(f.source, 'source changed');
  await assert.rejects(recordSupplemental(f.options), /STALE_SUPPLEMENTAL_SOURCE/);
});

test('candidate changes, protected candidate tool edits, symlinks and hardlinks are refused', async t => {
  const f = await fixture(t);
  await put(f.candidate, f.output, 'changed after exact review\n');
  await assert.rejects(recordSupplemental(f.options), /STALE_OUTPUT_APPROVAL/);
  await put(f.candidate, f.output, f.after);
  await put(f.candidate, f.tool, 'candidate cannot replace the validator\n');
  await assert.rejects(recordSupplemental(f.options), /UNAPPROVED_SNAPSHOT_CHANGE/);
  await put(f.candidate, f.tool, '// candidate tool is immutable task data, never executed\n');
  const outside = path.join(f.root, 'outside.ts');
  await writeFile(outside, f.after);
  await rm(path.join(f.candidate, f.output));
  await symlink(outside, path.join(f.candidate, f.output));
  await assert.rejects(recordSupplemental(f.options), /UNSAFE_TREE|UNSAFE_PATH/);
  await rm(path.join(f.candidate, f.output));
  await link(outside, path.join(f.candidate, f.output));
  await assert.rejects(recordSupplemental(f.options), /UNSAFE_PATH/);
  assert.equal((await readFile(outside)).toString(), f.after.toString(), 'No write follows either link');
});

test('cross-fork mismatches and mixed diagnostic state cannot be waived by output approvals', async t => {
  const f = await fixture(t);
  const name = 'vendor/openhands-extensions/output-inventory.json';
  const bytes = encode({ hostBuildInputs: [{ path: f.output, sha256: 'f'.repeat(64), bytes: f.after.length, mode: 0o644 }] });
  await put(f.candidate, name, bytes);
  f.state.bindings = [{ path: name, sha256: sha256(bytes), references: [{ path: f.output, sha256: 'f'.repeat(64), bytes: f.after.length, mode: 0o644 }] }];
  await f.save();
  await assert.rejects(recordSupplemental(f.options), /BLOCKED_CROSS_FORK/);
  await mkdir(path.join(f.candidate, '.upstream-sync'));
  await assert.rejects(recordSupplemental(f.options), /diagnostic\/maintenance state cannot be promoted/);
});

test('recorded generation cannot be verified after source/output/mode or metadata changes', async t => {
  const f = await fixture(t);
  f.state.status = 'recorded';
  f.state.recordedFiles = [];
  await f.save();
  await assert.rejects(verifySupplemental(f.options), /STALE_CANDIDATE/);
  await chmod(path.join(f.candidate, f.output), 0o755);
  await assert.rejects(verifySupplemental(f.options), /STALE_OUTPUT_APPROVAL/);
});

test('prepare refuses hash substitution and existing diagnostic state without changing the candidate', async t => {
  const f = await fixture(t);
  const options = { candidate: f.candidate, originalRoot: path.join(f.control, 'originals'), source: f.source, target: f.state.target, baseline: path.join(f.control, 'baseline.json'), baselineSha256: '0'.repeat(64), reviews: path.join(f.control, 'reviews.json'), reviewsSha256: f.state.reviewsSha256, control: path.join(f.root, 'new-control') };
  await assert.rejects(prepareSupplemental(options), /STALE_REVIEW_OR_BASELINE/);
  await mkdir(path.join(f.candidate, '.upstream-sync'));
  await assert.rejects(prepareSupplemental({ ...options, baselineSha256: f.state.baselineSha256 }), /diagnostic\/maintenance state cannot be promoted/);
});

test('an independently reviewed runtime anchor is required before profile parsing or authoring', async t => {
  const f = await fixture(t);
  f.reviews.runtimeSha256 = '0'.repeat(64);
  const bytes = encode(f.reviews);
  await put(f.control, 'reviews.json', bytes);
  f.state.reviewsSha256 = sha256(bytes);
  await f.save();
  await assert.rejects(recordSupplemental(f.options), /STALE_REVIEWED_RUNTIME/);
  assert.equal((await readFile(path.join(f.candidate, f.output))).toString(), f.after.toString());
});

test('a blanket tool fingerprint cannot approve an arbitrary maintenance asset or candidate validator', async t => {
  const f = await fixture(t);
  f.reviews.toolAssets = [{ path: 'scripts/upstream-sync.mjs', recordedRecipeSha256: '1'.repeat(64), recordedSha256: '2'.repeat(64), snapshotSha256: '3'.repeat(64), reviewedSha256: '4'.repeat(64), mode: 0o644, reason: 'Unapprovable validating-tool replacement fixture' }];
  const bytes = encode(f.reviews);
  await put(f.control, 'reviews.json', bytes);
  f.state.reviewsSha256 = sha256(bytes);
  await f.save();
  await assert.rejects(recordSupplemental(f.options), /Unapprovable maintenance asset/);
});
