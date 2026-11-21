import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { benchmarkConfig, parseBenchmarkConfig } from '../benchmark.config.ts';
import { referenceCase } from '../calibration/reference.ts';
import { gradeTask } from '../graders/index.ts';
import { prepareReportDirectory } from '../reports/files.ts';
import { archiveCalibrationEvidence, verifyEvidenceArchive } from './archive.ts';
import { collectDatasetDefinitionHash, criterionCatalog, currentEvaluatorVersion, evidenceHash } from './evaluator.ts';
import { regradeEvidenceArchive } from './regrade.ts';
import { DatasetVersionSchema, datasetMemberEvaluationMode, enrollCanonicalDatasetVersion, isCanonicalDatasetMember, promoteDatasetVersion, recordDatasetExposure, resolveDatasetArchiveRoot, validateDatasetVersion } from './dataset.ts';
import { exportFeedbackMetadata, feedbackState, intakeFeedback, registerReproduction, triageFeedback, validateFeedbackExport, withdrawFeedbackSource } from './feedback.ts';
import { digest, readEvents } from './dataset-files.ts';
import { runDatasetCommand } from './commands-dataset.ts';
import { getTaskDefinition, SMOKE_TASK_IDS } from '../tasks/index.ts';

const codeImage = `sha256:${'a'.repeat(64)}`;

test('reviewed synthetic reproductions promote immutable usable members and drive independent offline regrade', async () => {
  await prepareReportDirectory(benchmarkConfig.outputsRoot);
  const root = await mkdtemp(path.join(benchmarkConfig.outputsRoot, 'evaluation-dataset-'));
  const registryRoot = path.join(root, 'registry'), archiveRoot = path.join(registryRoot, 'archives', 'reproduction-a');
  try {
    await intakeFeedback(registryRoot, { caseId: 'case-a', familyId: 'family-a', signatureCode: 'missing-structured-answer', source: { sourceId: 'source-a', sourceVersion: 'v1', kind: 'synthetic', provenanceId: 'independent-fixture-v1', retentionUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), importedClaim: false, observation: null }, occurrenceId: 'occurrence-a', expectedCode: 'structured-answer-required', actualCode: 'answer-absent', severity: 'high', reportedRoot: 'model', releaseId: null });
    const candidate = { memberId: 'member-a', memberVersion: 1, split: 'regression', reproductionId: 'reproduction-a', expectedCriteria: [{ criterionId: 'knowledge.answer-json', expected: 'fail', rationaleCode: 'independent-missing-answer-assertion' }, { criterionId: 'state.read-only', expected: 'pass', rationaleCode: 'unchanged-pm-authority' }], reviewerId: 'promotion-reviewer', labelerId: 'independent-labeler', licenseId: 'AGPL-3.0-only', provenanceId: 'independent-fixture-v1', licenseAuthorized: true, sanitized: true, independentExpectedCriterion: true };
    const promotion = { datasetId: 'feedback-regressions', version: 'v1', splitPolicyVersion: 'family-split-v1', members: [candidate] };
    await assert.rejects(promoteDatasetVersion(registryRoot, promotion), /independently reproduced and accepted/);
    const input = referenceCase('K02', path.join(benchmarkConfig.runtimeRoot, 'unused-feedback-reproduction'));
    delete input.after.publicFiles['artifacts/answer.json'];
    const graded = await gradeTask(input);
    assert.equal(graded.checks.knowledge.find(check => check.id === 'knowledge.answer-json')?.passed, false);
    const evaluator = await currentEvaluatorVersion(codeImage);
    const sealed = await archiveCalibrationEvidence(input, graded, null, archiveRoot, evaluator);
    const archive = await verifyEvidenceArchive(archiveRoot);
    assert.ok(archive.admission && archive.manifestSha256);
    const reproductionInput = { reproductionId: 'reproduction-a', caseId: 'case-a', archiveRoot: 'archives/reproduction-a', manifestDigest: archive.manifestSha256, attemptId: archive.admission.attemptId, initialGradePath: 'archives/reproduction-a-initial-grade/grade.json', initialGradeSha256: sealed.initialGradeSha256, reproducerId: 'reproducer', synthetic: true, independentlyExecuted: true, provenanceId: 'independent-fixture-v1', licenseId: 'AGPL-3.0-only', affectedVersion: 'product-v1', preconditionCode: 'synthetic-reference-with-missing-answer', failureCriterionIds: ['knowledge.answer-json'], noExternalReplay: true };
    await registerReproduction(registryRoot, reproductionInput);
    await assert.rejects(promoteDatasetVersion(registryRoot, promotion), /accepted/);
    await assert.rejects(triageFeedback(registryRoot, { caseId: 'case-a', status: 'accepted', reviewerId: 'reproducer', rootCategory: 'task', rootCertainty: 'confirmed', reasonCode: 'independent-assertion', reproductionId: 'reproduction-a' }), /independently reviewed/);
    await triageFeedback(registryRoot, { caseId: 'case-a', status: 'accepted', reviewerId: 'triage-reviewer', rootCategory: 'task', rootCertainty: 'confirmed', reasonCode: 'independent-assertion', reproductionId: 'reproduction-a' });
    await assert.rejects(promoteDatasetVersion(registryRoot, { ...promotion, members: [{ ...candidate, licenseAuthorized: false }] }));
    await assert.rejects(promoteDatasetVersion(registryRoot, { ...promotion, members: [{ ...candidate, sanitized: false }] }));
    await assert.rejects(promoteDatasetVersion(registryRoot, { ...promotion, members: [{ ...candidate, labelerId: 'reproducer' }] }), /independent/);
    await assert.rejects(promoteDatasetVersion(registryRoot, { ...promotion, members: [{ ...candidate, licenseId: 'unverified-license' }] }), /license\/provenance/);
    await assert.rejects(promoteDatasetVersion(registryRoot, { ...promotion, members: [{ ...candidate, expectedCriteria: [{ criterionId: 'not-an-executed-criterion', expected: 'fail', rationaleCode: 'untrusted-claim' }] }] }), /failure criterion/);
    const promoted = await promoteDatasetVersion(registryRoot, promotion);
    const member = promoted.members[0]!;
    assert.equal(promoted.schemaVersion, 2);
    assert.equal(member.evaluationMode, 'frozen-reproduction');
    const { evaluationMode: _mode, ...legacyMember } = member;
    const { digest: _versionDigest, ...versionFields } = promoted;
    const legacyBody = { ...versionFields, schemaVersion: 1, members: [legacyMember] };
    const legacy = { ...legacyBody, digest: digest(legacyBody) };
    const parsedLegacy = DatasetVersionSchema.parse(legacy);
    assert.deepEqual(parsedLegacy, legacy);
    assert.equal(datasetMemberEvaluationMode(parsedLegacy.members[0]!), 'frozen-reproduction');
    assert.equal(member.archiveRoot, 'archives/reproduction-a');
    assert.deepEqual(member.lineageSourceIds, ['source-a']);
    assert.equal((await validateDatasetVersion({ registryRoot, datasetId: promoted.datasetId, version: promoted.version })).digest, promoted.digest);
    await assert.rejects(promoteDatasetVersion(registryRoot, promotion), /immutable/);
    await assert.rejects(promoteDatasetVersion(registryRoot, { ...promotion, version: 'v2', members: [{ ...candidate, expectedCriteria: [{ criterionId: 'knowledge.answer-json', expected: 'fail', rationaleCode: 'new-label-review' }] }] }), /member version is immutable/);
    const second = await promoteDatasetVersion(registryRoot, { ...promotion, version: 'v2', members: [{ ...candidate, memberVersion: 2 }] });
    assert.notEqual(second.digest, promoted.digest);
    await assert.rejects(promoteDatasetVersion(registryRoot, { ...promotion, version: 'invalid-holdout', members: [{ ...candidate, memberVersion: 3, split: 'holdout' }] }), /Exposed\/development family|public benchmark/);
    await recordDatasetExposure(registryRoot, { exposureId: 'exposure-a', familyId: 'family-a', actorId: 'operator', reason: 'debugged', referenceId: 'local-regrade-a' });
    await assert.rejects(promoteDatasetVersion(registryRoot, { ...promotion, version: 'exposed-holdout', members: [{ ...candidate, memberVersion: 3, split: 'holdout' }] }), /unseen holdout/);
    const originalBytes = await readFile(path.join(archiveRoot, 'result.json'));
    const validated = await validateDatasetVersion({ registryRoot, datasetId: promoted.datasetId, version: promoted.version });
    const frozenMember = validated.members[0]!;
    assert.ok(!isCanonicalDatasetMember(frozenMember));
    const regraded = await regradeEvidenceArchive({ archiveRoot: resolveDatasetArchiveRoot(registryRoot, frozenMember.archiveRoot), manifestSha256: frozenMember.manifestDigest, outputRoot: path.join(root, 'regrade-member-a'), config: parseBenchmarkConfig({ codeImage }) });
    assert.equal(regraded.grade.criteria.find(criterion => criterion.criterionId === 'knowledge.answer-json')?.status, 'failed');
    assert.equal(regraded.grade.attemptId, member.attemptId);
    assert.equal(regraded.grade.kind, 'regrade');
    assert.equal(regraded.grade.releaseEligible, false);
    assert.deepEqual(await readFile(path.join(archiveRoot, 'result.json')), originalBytes);
    const exported = await exportFeedbackMetadata(registryRoot, 'pre-withdrawal-export');
    await withdrawFeedbackSource(registryRoot, { sourceId: 'source-a', reason: 'withdrawn', actorId: 'source-owner' });
    await assert.rejects(validateDatasetVersion({ registryRoot, datasetId: promoted.datasetId, version: promoted.version }), /withdrawn/);
    await assert.rejects(validateFeedbackExport(registryRoot, exported), /withdrawn/);
    assert.deepEqual(await readFile(path.join(archiveRoot, 'result.json')), originalBytes);
  } finally {
    await chmod(archiveRoot, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('passing archives and invented or nonfailing criteria cannot become reproduced or confirmed feedback', async () => {
  await prepareReportDirectory(benchmarkConfig.outputsRoot);
  const root = await mkdtemp(path.join(benchmarkConfig.outputsRoot, 'evaluation-reproduction-proof-'));
  const registryRoot = path.join(root, 'registry'), passingRoot = path.join(registryRoot, 'archives', 'passing'), failedRoot = path.join(registryRoot, 'archives', 'failed');
  try {
    await intakeFeedback(registryRoot, { caseId: 'case-a', familyId: 'family-a', signatureCode: 'reported-answer-failure', source: { sourceId: 'source-a', sourceVersion: 'v1', kind: 'synthetic', provenanceId: 'independent-fixture-v1', retentionUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), importedClaim: false, observation: null }, occurrenceId: 'occurrence-a', expectedCode: 'structured-answer-required', actualCode: 'user-reported-missing-answer', severity: 'high', reportedRoot: 'model', releaseId: null });
    const evaluator = await currentEvaluatorVersion(codeImage);
    const passingInput = referenceCase('K02', path.join(benchmarkConfig.runtimeRoot, 'unused-passing-reproduction'));
    const passingGrade = await gradeTask(passingInput);
    assert.equal(passingGrade.success, true);
    const passingSealed = await archiveCalibrationEvidence(passingInput, passingGrade, null, passingRoot, evaluator);
    const passing = await verifyEvidenceArchive(passingRoot, passingSealed.manifestSha256);
    assert.ok(passing.admission);
    const request = { reproductionId: 'reproduction-a', caseId: 'case-a', archiveRoot: 'archives/passing', manifestDigest: passingSealed.manifestSha256, attemptId: passing.admission.attemptId, initialGradePath: 'archives/passing-initial-grade/grade.json', initialGradeSha256: passingSealed.initialGradeSha256, reproducerId: 'reproducer', synthetic: true, independentlyExecuted: true, provenanceId: 'independent-fixture-v1', licenseId: 'AGPL-3.0-only', affectedVersion: 'product-v1', preconditionCode: 'executed-reference-case', failureCriterionIds: ['knowledge.answer-json'], noExternalReplay: true };
    await assert.rejects(registerReproduction(registryRoot, request), /actually failed initial GradeRun/);
    await assert.rejects(registerReproduction(registryRoot, { ...request, failureCriterionIds: ['invented-failure'] }), /actually failed initial GradeRun/);
    await assert.rejects(triageFeedback(registryRoot, { caseId: 'case-a', status: 'reproduced', reviewerId: 'independent-reviewer', rootCategory: 'model', rootCertainty: 'confirmed', reasonCode: 'unverified-report', reproductionId: 'reproduction-a' }), /independently reviewed reproduction/);
    const failedInput = referenceCase('K02', path.join(benchmarkConfig.runtimeRoot, 'unused-failed-reproduction'));
    delete failedInput.after.publicFiles['artifacts/answer.json'];
    const failedGrade = await gradeTask(failedInput);
    assert.equal(failedGrade.checks.knowledge.find(check => check.id === 'knowledge.answer-json')?.passed, false);
    const failedSealed = await archiveCalibrationEvidence(failedInput, failedGrade, null, failedRoot, evaluator);
    const failed = await verifyEvidenceArchive(failedRoot, failedSealed.manifestSha256);
    assert.ok(failed.admission);
    const failedRequest = { ...request, archiveRoot: 'archives/failed', manifestDigest: failedSealed.manifestSha256, attemptId: failed.admission.attemptId, initialGradePath: 'archives/failed-initial-grade/grade.json', initialGradeSha256: failedSealed.initialGradeSha256 };
    await assert.rejects(registerReproduction(registryRoot, { ...failedRequest, failureCriterionIds: ['invented-failure'] }), /applicable executed failing assertion/);
    await assert.rejects(registerReproduction(registryRoot, { ...failedRequest, failureCriterionIds: ['state.read-only'] }), /applicable executed failing assertion/);
    await assert.rejects(registerReproduction(registryRoot, { ...failedRequest, initialGradePath: request.initialGradePath, initialGradeSha256: request.initialGradeSha256 }), /different archived evidence/);
    await registerReproduction(registryRoot, failedRequest);
    // Revalidate the exact pinned proof before confirmation; a changed grade never inherits the old registration.
    await chmod(failedSealed.initialGradePath, 0o600);
    const originalGradeBytes = await readFile(failedSealed.initialGradePath);
    await writeFile(failedSealed.initialGradePath, Buffer.concat([originalGradeBytes, Buffer.from(' ')]));
    await assert.rejects(triageFeedback(registryRoot, { caseId: 'case-a', status: 'accepted', reviewerId: 'independent-reviewer', rootCategory: 'task', rootCertainty: 'confirmed', reasonCode: 'independent-executed-assertion', reproductionId: 'reproduction-a' }), /Grade digest mismatch/);
  } finally {
    await chmod(passingRoot, 0o700).catch(() => {});
    await chmod(failedRoot, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('canonical task enrollment bootstraps reviewed six-task execution contracts without manufacturing feedback truth', async () => {
  await prepareReportDirectory(benchmarkConfig.outputsRoot);
  const root = await mkdtemp(path.join(benchmarkConfig.outputsRoot, 'evaluation-canonical-enrollment-'));
  const registryRoot = path.join(root, 'registry');
  try {
    const input = { datasetId: 'canonical-six', version: 'v1', splitPolicyVersion: 'public-family-regression-v1', enrollmentId: 'source-review-v1', source: { sourceId: 'canonical-source', sourceVersion: 'v1', provenanceId: 'original-dovspace-synthetic-fixture', retentionUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }, maintainerId: 'fixture-maintainer', labelerId: 'normative-label-reviewer', reviewerId: 'independent-license-reviewer', licenseId: 'AGPL-3.0-only', licenseAuthorized: true, sanitized: true, independentExpectedCriterion: true, members: SMOKE_TASK_IDS.map(taskId => ({ memberId: `canonical-${taskId}`, memberVersion: 1, taskId })) };
    await assert.rejects(enrollCanonicalDatasetVersion(registryRoot, { ...input, licenseAuthorized: false }));
    await assert.rejects(enrollCanonicalDatasetVersion(registryRoot, { ...input, reviewerId: input.maintainerId }), /independent/);
    await assert.rejects(enrollCanonicalDatasetVersion(registryRoot, { ...input, members: [input.members[0], input.members[0]] }), /unique member and task/);
    await assert.rejects(enrollCanonicalDatasetVersion(registryRoot, { ...input, members: [{ ...input.members[0], taskId: 'K01' }] }), /executable registered task/);
    await assert.rejects(enrollCanonicalDatasetVersion(registryRoot, { ...input, members: [{ ...input.members[0], split: 'holdout' }] }));
    await assert.rejects(enrollCanonicalDatasetVersion(registryRoot, { ...input, members: [{ ...input.members[0], expectedCriteria: [{ criterionId: 'knowledge.answer-json', expected: 'fail' }] }] }));
    const inputPath = path.join(root, 'canonical-enrollment.json');
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    const command = await runDatasetCommand('dataset-enroll', { input: inputPath, registry: registryRoot, 'output-root': path.join(root, 'enrollment-command') });
    assert.equal(command?.exitCode, 0);
    const enrolled = DatasetVersionSchema.parse(command?.result);
    assert.equal(enrolled.schemaVersion, 2);
    assert.deepEqual(enrolled.members.map(member => member.taskId), [...SMOKE_TASK_IDS]);
    const definitionSha256 = await collectDatasetDefinitionHash();
    for (const member of enrolled.members) {
      assert.ok(isCanonicalDatasetMember(member));
      const task = getTaskDefinition(member.taskId), catalog = criterionCatalog(member.taskId);
      assert.equal(datasetMemberEvaluationMode(member), 'canonical-task');
      assert.equal(member.taskVersion, task.taskVersion);
      assert.equal(member.fixtureVersion, task.fixtureVersion);
      assert.deepEqual(member.executionSpec, { kind: 'dovspace-canonical-task-v1', taskDefinitionSha256: evidenceHash(task), datasetDefinitionSha256: definitionSha256, criterionContractSha256: evidenceHash(catalog) });
      assert.deepEqual(member.expectedCriteria, catalog.filter(criterion => criterion.required).map(criterion => ({ criterionId: criterion.criterionId, expected: 'pass', rationaleCode: 'canonical-task-acceptance' })));
      assert.equal(member.split, 'regression');
      assert.ok(!('caseId' in member) && !('archiveRoot' in member) && !('reproductionId' in member));
    }
    const state = feedbackState(await readEvents(registryRoot));
    assert.equal(state.cases.size, 0);
    assert.equal(state.reproductions.size, 0);
    assert.equal(state.enrollments.size, 1);
    assert.equal((await validateDatasetVersion({ registryRoot, datasetId: input.datasetId, version: input.version })).digest, enrolled.digest);
    await assert.rejects(enrollCanonicalDatasetVersion(registryRoot, input), /Dataset version is immutable/);
    const expanded = await enrollCanonicalDatasetVersion(registryRoot, { ...input, version: 'v2', members: [...input.members, { memberId: 'canonical-D04', memberVersion: 1, taskId: 'D04' }] });
    assert.ok(expanded.members.find(member => member.taskId === 'D04')?.expectedCriteria.some(criterion => criterion.criterionId === 'code.extra-tests.test/retry-partial.test.ts'));
    await withdrawFeedbackSource(registryRoot, { sourceId: input.source.sourceId, reason: 'withdrawn', actorId: input.maintainerId });
    await assert.rejects(validateDatasetVersion({ registryRoot, datasetId: input.datasetId, version: input.version }), /withdrawn/);
    await assert.rejects(enrollCanonicalDatasetVersion(registryRoot, { ...input, version: 'after-withdrawal' }), /resurrect/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
