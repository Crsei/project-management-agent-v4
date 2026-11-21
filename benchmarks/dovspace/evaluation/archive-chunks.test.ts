import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, cp, link, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { benchmarkConfig } from '../benchmark.config.ts';
import { referenceCase } from '../calibration/reference.ts';
import { gradeTask } from '../graders/index.ts';
import { prepareReportDirectory } from '../reports/files.ts';
import { ArtifactManifestSchema, EVIDENCE_ARCHIVE_BOUNDS, FrozenGradeInputChunksSchema, type ArtifactManifest } from '../schemas/evaluation.ts';
import { getTaskDefinition } from '../tasks/index.ts';
import { admitEvidence, archiveCalibrationEvidence, freezeGradeInput, safeEvidenceBytes, safeEvidenceJson, sealEvidence, verifyEvidenceArchive } from './archive.ts';
import { generateCaptureKey, loadCaptureSigner, signCapture, verifyCaptureAttestation } from './capture.ts';
import { runEvidenceCommand } from './commands-evidence.ts';
import { bytesHash, currentEvaluatorVersion } from './evaluator.ts';
import { verifyRetainedGradingPopulations } from './populations.ts';
import { readGradeRun } from './regrade.ts';

const image = `sha256:${'a'.repeat(64)}`;
const MiB = 1024 * 1024;
async function fixture(t: TestContext, paddingBytes: number, manifestEntries = 0) {
  const root = path.join(benchmarkConfig.outputsRoot, `archive-chunks-test-${randomUUID()}`);
  await prepareReportDirectory(root, true);
  t.after(async () => {
    for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await chmod(path.join(root, entry.name), 0o700);
    await rm(root, { recursive: true, force: true });
  });
  const input = referenceCase('K03', '/no-model-no-pm-chunk-regression');
  input.events.push({ id: 'environment-full-population', timestamp: new Date().toISOString(), runId: 'synthetic-chunk-vector', source: 'isolation', type: 'environment_manifest', data: {
    sourceFiles: Array.from({ length: manifestEntries }, (_, index) => ({ path: `packages/source/${index}/retained-source-file.ts`, sha256: 'b'.repeat(64) })), sourceFileCount: manifestEntries,
  } });
  input.events.push({ id: 'one-large-event', timestamp: new Date().toISOString(), runId: 'synthetic-chunk-vector', source: 'provider', type: 'provider_evidence', operationId: 'invocation-a', data: { retained: 'x'.repeat(paddingBytes), unicode: '界😀', modelJson: { $ref: '../../must-not-be-read', kind: 'frozen-grade-input-chunks', chunks: [{ path: '/etc/passwd' }] } } });
  // Identical response bytes must never merge separate invocation identities.
  for (const operationId of ['invocation-b', 'invocation-c']) input.events.push({ id: operationId, timestamp: new Date().toISOString(), runId: 'synthetic-chunk-vector', source: 'provider', type: 'provider_evidence', operationId, data: { response: 'identical response bytes' } });
  const evaluator = await currentEvaluatorVersion(image), grade = await gradeTask(input), archiveRoot = path.join(root, 'archive');
  const sealed = await archiveCalibrationEvidence(input, grade, null, archiveRoot, evaluator);
  return { root, input, evaluator, grade, archiveRoot, sealed };
}

async function rewriteJson(root: string, name: string, value: unknown, manifest: ArtifactManifest): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value) + '\n'), filename = path.join(root, name);
  await chmod(filename, 0o600); await writeFile(filename, bytes);
  const entry = manifest.files.find(file => file.path === name)!; entry.bytes = bytes.length; entry.sha256 = bytesHash(bytes);
}

// Real on-disk archive IO, grader, population verification, Ed25519 and detached grading;
// these synthetic inputs are not model-quality, calibration or release evidence.
test('large full-population input and a single >64MiB event round-trip, seal, copy and regrade losslessly', async t => {
  const value = await fixture(t, 65 * MiB, 103133), archive = await verifyEvidenceArchive(value.archiveRoot, value.sealed.manifestSha256);
  assert.equal(archive.manifest!.version, '2');
  const descriptor = FrozenGradeInputChunksSchema.parse(await safeEvidenceJson(path.join(value.archiveRoot, 'inputs.json')));
  assert.ok(descriptor.bytes > 64 * MiB); assert.ok(descriptor.chunkCount > 16);
  assert.ok(archive.manifest!.files.every(file => file.bytes <= EVIDENCE_ARCHIVE_BOUNDS.fileBytes));
  assert.ok(descriptor.chunks.every(file => file.bytes <= EVIDENCE_ARCHIVE_BOUNDS.chunkBytes));
  assert.deepEqual(archive.inputs, freezeGradeInput(value.input));
  assert.equal((archive.inputs!.events.find(event => event.id === 'environment-full-population')!.data.sourceFiles as unknown[]).length, 103133);
  assert.deepEqual(archive.inputs!.events.filter(event => ['invocation-b', 'invocation-c'].includes(event.operationId ?? '')).map(event => event.operationId), ['invocation-b', 'invocation-c']);
  assert.deepEqual(verifyRetainedGradingPopulations(archive.populationProof, archive.inputs!), archive.populationProof);
  assert.equal(archive.populationProof!.events.count, value.input.events.length);
  assert.equal(archive.result!.success, value.grade.success);
  const initial = await readGradeRun(archive, value.sealed.initialGradePath, value.sealed.initialGradeSha256);
  const keyRoot = await mkdtemp(path.join(tmpdir(), 'archive-chunks-signature-'));
  t.after(() => rm(keyRoot, { recursive: true, force: true }));
  const key = await generateCaptureKey({ keyId: 'synthetic-archive-signature', keyDirectory: path.join(keyRoot, 'key') });
  const signer = await loadCaptureSigner({ keyId: key.keyId, privateKeyPath: key.privateKeyPath });
  const payload = { kind: 'no-model-archive-bytes-v1', manifestSha256: value.sealed.manifestSha256, initialGradeSha256: value.sealed.initialGradeSha256 };
  const signature = signCapture(signer, payload);
  assert.deepEqual(verifyCaptureAttestation(signature, signer, payload), payload);
  assert.throws(() => verifyCaptureAttestation(signature, signer, { ...payload, manifestSha256: '0'.repeat(64) }), /does not match/);
  const descriptorPath = path.join(value.root, 'archive-reference.json');
  await writeFile(descriptorPath, JSON.stringify({ archiveRoot: value.archiveRoot, manifestSha256: value.sealed.manifestSha256 }), { mode: 0o600 });
  const copyRoot = path.join(value.root, 'copy');
  assert.equal((await runEvidenceCommand('archive', { input: descriptorPath, 'output-root': copyRoot }))!.exitCode, 0);
  const copied = await verifyEvidenceArchive(copyRoot, value.sealed.manifestSha256);
  assert.deepEqual(copied.inputs, archive.inputs);
  assert.equal(bytesHash(await safeEvidenceBytes(path.join(copyRoot, 'manifest.json'))), payload.manifestSha256);
  const command = await runEvidenceCommand('regrade', { input: descriptorPath, 'output-root': path.join(value.root, 'detached-grade'), 'code-image': image, 'previous-grade': value.sealed.initialGradePath, 'previous-grade-sha256': value.sealed.initialGradeSha256 });
  assert.equal(command!.exitCode, 2); // Withheld authority is intentionally not independently replayable.
  const result = command!.result as { gradePath: string; gradeSha256: string; inferencePerformed: boolean; pmReplayPerformed: boolean };
  const regraded = await readGradeRun(archive, result.gradePath, result.gradeSha256);
  assert.equal(regraded.previousGradeId, initial.gradeId); assert.equal(regraded.executionFailure, null);
  assert.equal(regraded.releaseEligible, false); assert.equal(result.inferencePerformed, false); assert.equal(result.pmReplayPerformed, false);
  assert.equal(regraded.criteria.find(criterion => criterion.criterionId === 'safety.no-unrelated-mutations')!.status, 'not-evaluable');
  assert.equal(bytesHash(await safeEvidenceBytes(path.join(value.archiveRoot, 'manifest.json'))), payload.manifestSha256);
  const oversized = path.join(value.root, 'oversized-raw-file'); await writeFile(oversized, ''); await truncate(oversized, 64 * MiB + 1);
  await assert.rejects(safeEvidenceBytes(oversized), /bounded single-link/);
});

test('missing, corrupt, reordered, duplicated, linked and abusive input chunk references fail closed even with rehashed metadata', async t => {
  const value = await fixture(t, 2 * EVIDENCE_ARCHIVE_BOUNDS.chunkBytes);
  const mutations = ['missing', 'tamper', 'truncated', 'reordered', 'duplicate', 'reordered-bytes', 'duplicated-bytes', 'orphan', 'descriptor-missing', 'descriptor-downgrade', 'parent-ref', 'absolute-ref', 'metadata-ref', 'symlink', 'hardlink', 'expanded-overflow', 'zero-chunk', 'chunk-overflow', 'chunk-count', 'event-count', 'whole-digest', 'aggregate-overflow', 'manifest-duplicate', 'manifest-reorder', 'oversized-file'] as const;
  for (const mutation of mutations) {
    const root = path.join(value.root, mutation); await cp(value.archiveRoot, root, { recursive: true }); await chmod(root, 0o700);
    const manifest = ArtifactManifestSchema.parse(await safeEvidenceJson(path.join(root, 'manifest.json')));
    const descriptor = FrozenGradeInputChunksSchema.parse(await safeEvidenceJson(path.join(root, 'inputs.json')));
    const first = descriptor.chunks[0]!, second = descriptor.chunks[1]!;
    if (mutation === 'missing') await rm(path.join(root, first.path));
    if (mutation === 'tamper' || mutation === 'truncated') {
      const content = await readFile(path.join(root, first.path)); content[0] = content[0]! ^ 1;
      await chmod(path.join(root, first.path), 0o600); await writeFile(path.join(root, first.path), mutation === 'tamper' ? content : content.subarray(0, content.length - 1));
    }
    if (mutation === 'reordered') descriptor.chunks.reverse();
    if (mutation === 'duplicate') descriptor.chunks[1] = { ...first };
    if (mutation === 'reordered-bytes' || mutation === 'duplicated-bytes') {
      const a = await readFile(path.join(root, first.path)), b = await readFile(path.join(root, second.path));
      for (const [entry, content] of [[first, mutation === 'reordered-bytes' ? b : a], [second, a]] as const) {
        await chmod(path.join(root, entry.path), 0o600); await writeFile(path.join(root, entry.path), content);
        entry.sha256 = bytesHash(content); manifest.files.find(file => file.path === entry.path)!.sha256 = entry.sha256;
      }
    }
    if (mutation === 'orphan') {
      const extra = { path: 'inputs-000127.bin', bytes: 2, sha256: bytesHash('{}') };
      await writeFile(path.join(root, extra.path), '{}', { mode: 0o400 }); manifest.files.push(extra); manifest.files.sort((a, b) => a.path.localeCompare(b.path));
    }
    if (mutation === 'parent-ref') first.path = '../outside';
    if (mutation === 'absolute-ref') first.path = '/etc/passwd';
    if (mutation === 'metadata-ref') first.path = 'admission.json';
    if (mutation === 'symlink' || mutation === 'hardlink') {
      const outside = path.join(value.root, `${mutation}-outside`); await writeFile(outside, await readFile(path.join(root, first.path)));
      await rm(path.join(root, first.path));
      if (mutation === 'symlink') await symlink(outside, path.join(root, first.path)); else await link(outside, path.join(root, first.path));
    }
    if (mutation === 'expanded-overflow') descriptor.bytes = EVIDENCE_ARCHIVE_BOUNDS.expandedInputBytes + 1;
    if (mutation === 'zero-chunk') first.bytes = 0;
    if (mutation === 'chunk-overflow') first.bytes = EVIDENCE_ARCHIVE_BOUNDS.chunkBytes + 1;
    if (mutation === 'chunk-count') descriptor.chunkCount++;
    if (mutation === 'event-count') descriptor.eventCount++;
    if (mutation === 'whole-digest') descriptor.sha256 = '0'.repeat(64);
    if (mutation === 'oversized-file') { await chmod(path.join(root, first.path), 0o600); await truncate(path.join(root, first.path), 64 * MiB + 1); }
    if (mutation === 'descriptor-missing') { await rm(path.join(root, 'inputs.json')); manifest.files = manifest.files.filter(file => file.path !== 'inputs.json'); }
    else await rewriteJson(root, 'inputs.json', mutation === 'descriptor-downgrade' ? freezeGradeInput(value.input) : descriptor, manifest);
    if (mutation === 'aggregate-overflow') {
      await writeFile(path.join(root, 'calibration.json'), '{}');
      manifest.files.push({ path: 'calibration.json', bytes: 2, sha256: bytesHash('{}') });
      manifest.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      for (const file of manifest.files) file.bytes = EVIDENCE_ARCHIVE_BOUNDS.fileBytes;
    }
    if (mutation === 'manifest-duplicate') manifest.files.push({ ...manifest.files[0]! });
    if (mutation === 'manifest-reorder') manifest.files.reverse();
    await chmod(path.join(root, 'manifest.json'), 0o600); await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest) + '\n');
    if (mutation === 'aggregate-overflow') await assert.rejects(verifyEvidenceArchive(root), /bounded evidence size/, mutation);
    else await assert.rejects(verifyEvidenceArchive(root), mutation);
  }
});

test('immutable sealed v1 archives retain explicit historical decoding and byte-identical copy semantics', async t => {
  const value = await fixture(t, 0), root = path.join(value.root, 'historical-v1-vector'); await prepareReportDirectory(root, true);
  const original = ArtifactManifestSchema.parse(await safeEvidenceJson(path.join(value.archiveRoot, 'manifest.json')));
  const files: ArtifactManifest['files'] = [];
  for (const file of original.files.filter(file => file.path !== 'inputs.json' && !file.path.endsWith('.bin'))) {
    await writeFile(path.join(root, file.path), await safeEvidenceBytes(path.join(value.archiveRoot, file.path)), { flag: 'wx', mode: 0o400 }); files.push(file);
  }
  const inputBytes = Buffer.from(JSON.stringify(freezeGradeInput(value.input), null, 2) + '\n');
  await writeFile(path.join(root, 'inputs.json'), inputBytes, { flag: 'wx', mode: 0o400 }); files.push({ path: 'inputs.json', bytes: inputBytes.length, sha256: bytesHash(inputBytes) });
  const manifest = ArtifactManifestSchema.parse({ ...original, version: '1', representation: 'private-host-capture-v1', files });
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), manifestSha256 = bytesHash(manifestBytes);
  await writeFile(path.join(root, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o400 }); await chmod(root, 0o500);
  const archived = await verifyEvidenceArchive(root, manifestSha256); assert.deepEqual(archived.inputs, freezeGradeInput(value.input)); assert.equal(archived.manifest!.version, '1');
  const input = path.join(value.root, 'historical-reference.json'); await writeFile(input, JSON.stringify({ archiveRoot: root, manifestSha256 }));
  const copy = path.join(value.root, 'historical-copy'); await runEvidenceCommand('archive', { input, 'output-root': copy });
  assert.deepEqual(await safeEvidenceBytes(path.join(copy, 'manifest.json')), manifestBytes); assert.deepEqual(await safeEvidenceBytes(path.join(copy, 'inputs.json')), inputBytes);
  assert.equal((await verifyEvidenceArchive(copy, manifestSha256)).manifest!.version, '1');
});

test('archive publication failure does not turn an independently successful model/task result into a grading failure', async t => {
  const value = await fixture(t, 0), root = path.join(value.root, 'publication-failure');
  const context = await admitEvidence({ root, runId: 'separate-archive-failure', task: getTaskDefinition('K03'), arm: 'raw', producer: 'synthetic-calibration', modelConfigSha256: '1'.repeat(64), toolPolicySha256: '2'.repeat(64), harnessSha256: '3'.repeat(64), productSha256: null, codeImage: image, evaluator: value.evaluator });
  const previous = await verifyEvidenceArchive(value.archiveRoot), result = { ...previous.result!, runId: context.admission.runId };
  assert.equal(value.grade.success, true); assert.equal(result.success, true);
  await writeFile(path.join(root, 'unexpected.json'), '{}');
  await assert.rejects(sealEvidence({ ...context, result, inputs: freezeGradeInput(value.input), events: value.input.events, grade: value.grade }), /Unexpected file/);
  const retained = await safeEvidenceJson(path.join(root, 'result.json')) as { success: boolean; failure: unknown };
  assert.equal(retained.success, true); assert.equal(retained.failure, null);
  await assert.rejects(verifyEvidenceArchive(root), /not sealed/);
  assert.equal((await readdir(value.root)).includes('publication-failure-initial-grade'), false);
});
