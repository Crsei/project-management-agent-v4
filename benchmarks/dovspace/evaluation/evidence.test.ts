import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { benchmarkConfig, parseBenchmarkConfig } from '../benchmark.config.ts';
import { referenceCase } from '../calibration/reference.ts';
import { calibrationMutations, CALIBRATION_EXPECTED_FAILURES, calibrationExpectedPasses } from '../calibration/cases.ts';
import { gradeTask } from '../graders/index.ts';
import { getTaskDefinition, RUNNABLE_TASK_IDS } from '../tasks/index.ts';
import { GradeRunSchema } from '../schemas/evaluation.ts';
import { prepareReportDirectory } from '../reports/files.ts';
import { admitEvidence, archiveCalibrationEvidence, freezeGradeInput, safeEvidenceJson, sealEvidence, verifyEvidenceArchive } from './archive.ts';
import { bytesHash, criterionCatalog, currentEvaluatorVersion } from './evaluator.ts';
import { readGradeRun, regradeEvidenceArchive } from './regrade.ts';
import { loadEvaluatorCalibration } from './calibration.ts';
import { captureGradingPopulations, verifyRetainedGradingPopulations, originalSafetyPopulationReferences } from './populations.ts';
import { runEvidenceCommand } from './commands-evidence.ts';

const image = `sha256:${'a'.repeat(64)}`;
const config = parseBenchmarkConfig({ ...benchmarkConfig, codeImage: image });
async function fixture(t: TestContext) {
  const root = path.join(benchmarkConfig.outputsRoot, `evidence-test-${randomUUID()}`);
  await prepareReportDirectory(root, true);
  const archives: string[] = [];
  t.after(async () => { for (const archive of archives) await chmod(archive, 0o700).catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const input = referenceCase('K02', path.join(config.runtimeRoot, 'never-executed-agent'));
  input.fixture.pm.token = 'DO_NOT_EXPORT_FIXTURE_TOKEN';
  input.before.tables.accounts = [{ password: 'DO_NOT_EXPORT_ACCOUNT_TABLE' }];
  input.after.tables.accounts = structuredClone(input.before.tables.accounts);
  const evaluator = await currentEvaluatorVersion(image), grade = await gradeTask(input);
  const archiveRoot = path.join(root, 'archive'); archives.push(archiveRoot);
  const sealed = await archiveCalibrationEvidence(input, grade, null, archiveRoot, evaluator);
  const archive = await verifyEvidenceArchive(archiveRoot, sealed.manifestSha256);
  return { root, input, evaluator, grade, archiveRoot, archive, sealed, archives };
}

test('immutable admission, archive bytes and original results survive independent regrades', async t => {
  const value = await fixture(t);
  const original = await readFile(path.join(value.archiveRoot, 'result.json'));
  const initial = await readGradeRun(value.archive, value.sealed.initialGradePath, value.sealed.initialGradeSha256);
  assert.deepEqual(value.archive.attempt!.requirementRevisions, [getTaskDefinition('K02').taskVersion]);
  assert.ok(initial.criteria.every(item => item.requirementRevision === getTaskDefinition('K02').taskVersion));
  const first = await regradeEvidenceArchive({ archiveRoot: value.archiveRoot, manifestSha256: value.sealed.manifestSha256, outputRoot: path.join(value.root, 'grade-1'), config, previousGradePath: value.sealed.initialGradePath, previousGradeSha256: value.sealed.initialGradeSha256 });
  const second = await regradeEvidenceArchive({ archiveRoot: value.archiveRoot, outputRoot: path.join(value.root, 'grade-2'), config, previousGradePath: first.gradePath, previousGradeSha256: first.gradeSha256 });
  assert.notEqual(first.grade.gradeId, initial.gradeId);
  assert.notEqual(second.grade.gradeId, first.grade.gradeId);
  assert.equal(second.grade.previousGradeId, first.grade.gradeId);
  assert.equal(first.grade.attemptId, value.archive.attempt!.attemptId);
  assert.equal(second.grade.manifestSha256, value.sealed.manifestSha256);
  assert.deepEqual(await readFile(path.join(value.archiveRoot, 'result.json')), original);
  assert.equal(first.grade.criteria.find(item => item.criterionId === 'knowledge.current.retentionDays')?.status, 'passed');
  assert.equal(first.grade.criteria.find(item => item.criterionId === 'safety.no-unrelated-mutations')?.status, 'not-evaluable');
  assert.equal(first.grade.status, 'not-evaluable'); assert.equal(first.grade.releaseEligible, false);
  const metadata = await safeEvidenceJson(path.join(value.root, 'grade-1', 'grade-manifest.json')) as Record<string, unknown>;
  assert.equal(metadata.inferencePerformed, false); assert.equal(metadata.pmReplayPerformed, false); assert.equal(metadata.operation, 'regrade-not-rerun');
  await assert.rejects(() => regradeEvidenceArchive({ archiveRoot: value.archiveRoot, outputRoot: path.join(value.root, 'grade-1'), config }), /already exists/);
  await assert.rejects(() => archiveCalibrationEvidence(value.input, value.grade, null, value.archiveRoot, value.evaluator), /already exists/);
});

test('frozen inputs omit credentials, authority tables and live fixture capabilities', async t => {
  const value = await fixture(t);
  const serialized = JSON.stringify(value.archive.inputs);
  assert.doesNotMatch(serialized, /DO_NOT_EXPORT_FIXTURE_TOKEN|DO_NOT_EXPORT_ACCOUNT_TABLE/);
  assert.equal('tables' in value.archive.inputs!.before, false);
  assert.equal('pm' in value.archive.inputs!.fixture, false);
  assert.equal('root' in value.archive.inputs!.fixture, false);
  const unsafe = structuredClone(value.input); unsafe.after.publicFiles['../escape.ts'] = Buffer.from('bad').toString('base64');
  assert.throws(() => freezeGradeInput(unsafe), /Canonical relative/);
});

test('original authority failures retain verdicts and commitments without exporting credential row values', async t => {
  const value = await fixture(t), input = structuredClone(value.input);
  input.after.tables.accounts = [{ password: 'DO_NOT_EXPORT_CHANGED_CREDENTIAL_ROW' }];
  const grade = await gradeTask(input), archiveRoot = path.join(value.root, 'credential-mutation'); value.archives.push(archiveRoot);
  assert.equal(grade.safetyGate.passed, false);
  const sealed = await archiveCalibrationEvidence(input, grade, null, archiveRoot, value.evaluator);
  const archive = await verifyEvidenceArchive(archiveRoot), initial = await readGradeRun(archive, sealed.initialGradePath, sealed.initialGradeSha256);
  assert.equal(initial.criteria.find(item => item.criterionId === 'safety.no-unrelated-mutations')?.status, 'failed');
  for (const directory of [archiveRoot, `${archiveRoot}-initial-grade`]) for (const name of await readdir(directory)) {
    assert.doesNotMatch(await readFile(path.join(directory, name), 'utf8'), /DO_NOT_EXPORT_ACCOUNT_TABLE|DO_NOT_EXPORT_CHANGED_CREDENTIAL_ROW|DO_NOT_EXPORT_FIXTURE_TOKEN/);
  }
});

test('artifact corruption and caller-selected manifest hashes never verify', async t => {
  const value = await fixture(t);
  await assert.rejects(() => verifyEvidenceArchive(value.archiveRoot, '0'.repeat(64)), /digest mismatch/);
  const filename = path.join(value.archiveRoot, 'inputs.json'); await chmod(filename, 0o600); await writeFile(filename, '{}\n');
  await assert.rejects(() => verifyEvidenceArchive(value.archiveRoot, value.sealed.manifestSha256), /corruption/);
});

test('manifest traversal, identity substitution and links are denied even after rehashing', async t => {
  for (const mutation of ['traversal', 'identity', 'unmanifested', 'symlink', 'hardlink'] as const) {
    const value = await fixture(t); await chmod(value.archiveRoot, 0o700);
    const manifestPath = path.join(value.archiveRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: { path: string; sha256: string; bytes: number }[] };
    if (mutation === 'traversal') manifest.files[0]!.path = '../outside.json';
    else if (mutation === 'identity') {
      const attemptPath = path.join(value.archiveRoot, 'attempt.json'), attempt = JSON.parse(await readFile(attemptPath, 'utf8')) as Record<string, unknown>;
      attempt.attemptId = 'substituted-attempt'; const bytes = JSON.stringify(attempt) + '\n';
      await chmod(attemptPath, 0o600); await writeFile(attemptPath, bytes);
      const entry = manifest.files.find(item => item.path === 'attempt.json')!; entry.sha256 = bytesHash(bytes); entry.bytes = Buffer.byteLength(bytes);
    } else if (mutation === 'symlink' || mutation === 'hardlink') {
      const filename = path.join(value.archiveRoot, 'inputs.json'), outside = path.join(value.root, 'outside.json');
      await writeFile(outside, await readFile(filename), { mode: 0o600 }); await rm(filename);
      if (mutation === 'symlink') await symlink(outside, filename); else await link(outside, filename);
    } else await writeFile(path.join(value.archiveRoot, 'unmanifested.json'), '{}', { mode: 0o600 });
    await chmod(manifestPath, 0o600); await writeFile(manifestPath, JSON.stringify(manifest) + '\n');
    await assert.rejects(() => verifyEvidenceArchive(value.archiveRoot));
  }
});

test('missing capture and legacy archives produce explicit per-criterion not-evaluable grades', async t => {
  const value = await fixture(t), missingRoot = path.join(value.root, 'missing'); value.archives.push(missingRoot);
  const evidence = await admitEvidence({ root: missingRoot, runId: 'admitted-failure', task: getTaskDefinition('K02'), arm: 'raw', producer: 'host-runner', modelConfigSha256: '1'.repeat(64), toolPolicySha256: '2'.repeat(64), harnessSha256: '3'.repeat(64), productSha256: null, codeImage: image, evaluator: value.evaluator });
  await assert.rejects(() => verifyEvidenceArchive(missingRoot), /not sealed/);
  const failure = { category: 'infrastructure' as const, message: 'Fixture never provisioned', evidence: [] };
  await sealEvidence({ ...evidence, result: { ...value.archive.result!, runId: 'admitted-failure', success: false, failure }, events: [] });
  const missing = await regradeEvidenceArchive({ archiveRoot: missingRoot, outputRoot: path.join(value.root, 'missing-grade'), config });
  assert.equal(missing.grade.executionFailure?.category, 'infrastructure');
  assert.ok(missing.grade.criteria.length > 10 && missing.grade.criteria.every(item => item.status === 'not-evaluable'));
  const legacyRoot = path.join(value.root, 'legacy'); await mkdir(legacyRoot, { mode: 0o700 });
  await writeFile(path.join(legacyRoot, 'result.json'), JSON.stringify(value.archive.result), { mode: 0o600 });
  const legacy = await regradeEvidenceArchive({ archiveRoot: legacyRoot, outputRoot: path.join(value.root, 'legacy-grade'), config });
  assert.equal(legacy.archive.legacy, true); assert.equal(legacy.grade.attemptId, null);
  assert.ok(legacy.grade.criteria.every(item => item.status === 'not-evaluable')); assert.equal(legacy.grade.releaseEligible, false);
});

test('changed evaluator runtime cannot reuse old calibration; tampered grades cannot bind', async t => {
  const value = await fixture(t), filename = path.join(value.root, 'calibration.json');
  await writeFile(filename, JSON.stringify({ kind: 'grader-calibration', success: true, evaluatorSha256: value.evaluator.sha256, calibrationDefinitionSha256: value.evaluator.calibrationDefinitionSha256, infrastructureErrors: [], codeExecution: { realSandboxCalls: 1 }, cases: [] }), { mode: 0o600 });
  await assert.rejects(() => loadEvaluatorCalibration(`sha256:${'b'.repeat(64)}`, filename), /changed evaluator/);
  await assert.rejects(() => loadEvaluatorCalibration(image, filename), /every independent/);
  await assert.rejects(() => readGradeRun(value.archive, value.sealed.initialGradePath, '0'.repeat(64)), /Grade digest/);
  const initial = await readGradeRun(value.archive, value.sealed.initialGradePath, value.sealed.initialGradeSha256);
  assert.equal(GradeRunSchema.safeParse({ ...initial, status: 'passed', releaseEligible: true, calibrationSha256: null }).success, false);
  assert.equal(GradeRunSchema.safeParse({ ...initial, status: 'passed', criteria: [{ ...initial.criteria[0]!, status: 'not-evaluable' }] }).success, false);
  const changed = await regradeEvidenceArchive({ archiveRoot: value.archiveRoot, outputRoot: path.join(value.root, 'changed-evaluator-grade'), config: parseBenchmarkConfig({ ...config, codeImage: `sha256:${'b'.repeat(64)}` }) });
  assert.notEqual(changed.grade.evaluatorSha256, value.evaluator.sha256);
  assert.equal(changed.grade.attemptId, value.archive.attempt!.attemptId);
  assert.equal(changed.grade.calibrationSha256, null); assert.equal(changed.grade.releaseEligible, false);
});

test('original absence assertions bind complete inspected populations without retaining credential tables', async t => {
  const value = await fixture(t), frozen = freezeGradeInput(value.input), proof = captureGradingPopulations(value.input);
  assert.deepEqual(verifyRetainedGradingPopulations(proof, frozen), proof);
  assert.equal(proof.before.authorityTables.retained, false);
  assert.equal(proof.before.authorityRows, 1);
  const initial = await readGradeRun(value.archive, value.sealed.initialGradePath, value.sealed.initialGradeSha256);
  for (const criterionId of ['safety.no-unsafe-completion', 'safety.no-forbidden-actions', 'safety.receipt-target-scope']) {
    const criterion = initial.criteria.find(item => item.criterionId === criterionId)!;
    assert.equal(criterion.status, 'passed');
    for (const reference of originalSafetyPopulationReferences(criterionId)) assert.ok(criterion.evidence.includes(reference));
  }
  const corrupted = structuredClone(proof); corrupted.trustedEvents.count += 1;
  assert.throws(() => verifyRetainedGradingPopulations(corrupted, frozen), /population/);
  const wrongScope = structuredClone(frozen); wrongScope.allowedTargets.push({ ...Object.values(wrongScope.fixture.targets)[0]!, entityId: 'substituted-target' });
  assert.throws(() => verifyRetainedGradingPopulations(proof, wrongScope), /population/);
  const leaked = structuredClone(proof); leaked.before.authorityTables.retained = true;
  assert.throws(() => verifyRetainedGradingPopulations(leaked, frozen), /Withheld authority/);
});

test('archive copy preserves immutable identities and command flags cannot activate inference', async t => {
  const value = await fixture(t), input = path.join(value.root, 'archive-reference.json'), copy = path.join(value.root, 'copy'); value.archives.push(copy);
  await writeFile(input, JSON.stringify({ archiveRoot: value.archiveRoot, manifestSha256: value.sealed.manifestSha256 }), { mode: 0o600 });
  const copied = await runEvidenceCommand('archive', { input, 'output-root': copy }); assert.equal(copied?.exitCode, 0);
  const archive = await verifyEvidenceArchive(copy, value.sealed.manifestSha256); assert.equal(archive.attempt!.attemptId, value.archive.attempt!.attemptId);
  await assert.rejects(() => runEvidenceCommand('regrade', { input, 'output-root': path.join(value.root, 'forbidden'), model: 'any-model' }), /Unsupported/);
});

test('current controlled fixture command archives actual targeted evidence then verifies and regrades without inference', async t => {
  const value = await fixture(t), archiveRoot = path.join(value.root, 'failed-fixture'); value.archives.push(archiveRoot);
  const selection = path.join(value.root, 'fixture-selection.json');
  await writeFile(selection, JSON.stringify({ taskId: 'K02', mutation: 'stale-current-with-correct-keywords' }), { mode: 0o600 });
  const created = await runEvidenceCommand('archive-fixture', { input: selection, 'output-root': archiveRoot, 'code-image': image });
  assert.equal(created?.exitCode, 0);
  const archive = await verifyEvidenceArchive(archiveRoot);
  assert.equal(archive.admission!.producer, 'synthetic-calibration');
  assert.equal(archive.result!.success, false);
  assert.equal(archive.attempt!.executionFailure, null);
  const descriptor = path.join(value.root, 'failed-descriptor.json');
  await writeFile(descriptor, JSON.stringify({ archiveRoot, manifestSha256: archive.manifestSha256 }), { mode: 0o600 });
  const verified = await runEvidenceCommand('verify', { input: descriptor, 'output-root': path.join(value.root, 'verified-fixture') });
  assert.equal(verified?.exitCode, 0);
  const regraded = await runEvidenceCommand('regrade', { input: descriptor, 'output-root': path.join(value.root, 'regraded-fixture'), 'code-image': image });
  assert.equal(regraded?.exitCode, 2);
  const result = regraded!.result;
  assert.ok(result && typeof result === 'object' && 'grade' in result);
  const grade = GradeRunSchema.parse(result.grade);
  assert.equal(grade.criteria.find(item => item.criterionId === 'knowledge.current.retentionDays')?.status, 'failed');
  assert.equal(grade.executionFailure, null); assert.equal(grade.releaseEligible, false);
});

test('undelivered L03 revision is not misreported as ignoring an issued requirement', async t => {
  const value = await fixture(t), input = referenceCase('L03', '/unmaterialized-revision-evidence');
  input.events = input.events.filter(item => !(item.source === 'runner' && item.type === 'intervention_applied' && item.data.action === 'change-requirement'));
  const archiveRoot = path.join(value.root, 'before-revision'); value.archives.push(archiveRoot);
  const sealed = await archiveCalibrationEvidence(input, undefined, 'Stopped before revised requirement delivery', archiveRoot, value.evaluator);
  const archive = await verifyEvidenceArchive(archiveRoot);
  const grade = await readGradeRun(archive, sealed.initialGradePath, sealed.initialGradeSha256);
  const assertion = grade.criteria.find(item => item.criterionId === 'code.feature.server-below-backoff')!;
  assert.equal(assertion.requirementRevision, 'retry-v2'); assert.equal(assertion.status, 'not-applicable');
  assert.equal(archive.attempt!.requirementRevisions.includes('retry-v2'), false);
  assert.deepEqual(archive.attempt!.requirementRevisions, [getTaskDefinition('L03').taskVersion, 'retry-v1']);
  assert.notEqual(grade.status, 'passed');
});

test('every calibration negative names a real specific criterion and preserved boundary', () => {
  for (const taskId of RUNNABLE_TASK_IDS) {
    const catalog = criterionCatalog(taskId);
    for (const mutation of calibrationMutations(taskId)) {
      const expected = CALIBRATION_EXPECTED_FAILURES[taskId]?.[mutation.name];
      assert.ok(expected && catalog.some(item => item.criterionId === expected), `${taskId}/${mutation.name}: ${expected}`);
      assert.ok(calibrationExpectedPasses(mutation.name).length > 0);
    }
  }
});
for (const taskId of ['K02', 'K03', 'D01', 'L02'] as const) test(`${taskId} negatives fail their intended criterion rather than aggregate success only`, async () => {
  for (const mutation of calibrationMutations(taskId)) {
    const input = referenceCase(taskId, '/not-materialized-targeted-calibration'); mutation.mutate(input);
    const grade = await gradeTask(input), checks = [...Object.values(grade.checks).flat(), ...grade.safetyGate.checks];
    const expected = CALIBRATION_EXPECTED_FAILURES[taskId]![mutation.name]!;
    assert.ok(checks.some(item => item.id === expected && !item.passed), `${taskId}/${mutation.name} must fail ${expected}`);
    for (const id of calibrationExpectedPasses(mutation.name)) assert.ok(checks.some(item => item.id === id && item.passed), `${taskId}/${mutation.name} preserves ${id}`);
  }
});
