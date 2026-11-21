import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateCaptureKey, loadCaptureSigner, signCapture, captureDigest } from './capture.ts';
import { createExperimentLedger, prepareExperimentAdmission, recordExperimentAdmission, recordExperimentSeal, closeExperimentLedger } from './experiment-ledger.ts';
import { ExperimentSchema } from './review-schema.ts';
import { ReviewRequestSchema } from './review.ts';
import { hasInspectedCriterionEvidence, readClosedReviewLedger, summarizeReviewLedger, unavailableLedgerAttempt, verifySignedAttemptCapture } from './review-provenance.ts';
import { ArtifactManifestSchema, EvaluationAdmissionSchema, EvaluationAttemptSchema, GradeRunSchema } from '../schemas/evaluation.ts';
import { freezeGradeInput, type VerifiedEvidenceArchive } from './archive.ts';
import { bytesHash } from './evaluator.ts';
import { referenceCase } from '../calibration/reference.ts';
import { captureGradingPopulations, originalSafetyPopulationReferences, verifyRetainedGradingPopulations } from './populations.ts';

const hash = 'a'.repeat(64);

/** Real signatures and immutable admission files, but synthetic protocol vectors only: never model-quality evidence or registered release approvals. */
async function ledgerFixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-signed-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = await generateCaptureKey({ keyId: 'protocol-test-key', keyDirectory: path.join(root, 'key') });
  const signer = await loadCaptureSigner({ keyId: key.keyId, privateKeyPath: key.privateKeyPath, expectedPublicKeySha256: key.publicKeySha256 });
  const trustedCaptureKey = { keyId: key.keyId, publicKeyPem: key.publicKeyPem, publicKeySha256: key.publicKeySha256 };
  const baseline = { sourceSha: 'a'.repeat(40), sourceState: 'committed-clean', productSha256: hash, harnessSha256: hash, modelConfigSha256: hash, toolPolicySha256: hash, arm: 'raw' };
  const candidate = { ...baseline, sourceSha: 'b'.repeat(40), productSha256: 'b'.repeat(64) };
  const controls = { environmentSha256: hash, budgetSha256: hash, permissionsSha256: hash, fixtureSemanticSha256: hash, fixtureVersion: 'test-fixture', controlTransport: 'cli' };
  const experiment = ExperimentSchema.parse({ experimentId: 'signed-protocol-vector', preregisteredAt: '2000-01-01T00:00:00.000Z', dataset: { datasetId: 'test-data', version: '1', digest: hash }, baseline, candidate, treatment: 'productSha256',
    cells: ['baseline', 'candidate'].map((variant, order) => ({ cellId: variant, pairId: 'pair', cohort: 'critical', taskId: 'K02', taskVersion: 'test-version', variant, arm: 'raw', order,
      requiredCriterionIds: ['safety.no-unsafe-completion'], requiredRequirementRevisions: ['test-version'], controls })) });
  const ledgerRoot = path.join(root, 'ledger'), descriptor = await createExperimentLedger({ ledgerRoot, experiment, trustedCaptureKey, signer });
  for (const [index, cellId] of ['baseline', 'baseline', 'candidate'].entries()) {
    const identity = experiment[cellId === 'baseline' ? 'baseline' : 'candidate'];
    const admission = EvaluationAdmissionSchema.parse({ version: '1', admissionId: `admission-${index}`, attemptId: `attempt-${index}`, runId: `run-${index}`, taskId: 'K02', taskVersion: 'test-version', fixtureVersion: 'test-fixture', arm: identity.arm,
      dataset: { datasetId: 'test-data', version: '1', sha256: hash }, evaluatorSha256: hash, producer: 'host-runner', admittedAt: new Date().toISOString(), parentAttemptId: null,
      versions: { productSha256: identity.productSha256, harnessSha256: hash, modelConfigSha256: hash, toolPolicySha256: hash },
      datasetMember: { evaluationMode: 'canonical-task', memberId: 'member', memberVersion: 1, familyId: 'dovspace-lite-public-fixture', executionSpecSha256: hash },
      capture: { keyId: key.keyId, publicKeySha256: key.publicKeySha256 } });
    const options = { ledgerRoot, signer, admission, cellId, member: { memberId: 'member', memberVersion: 1 }, archiveRoot: `archives/${index}` };
    const binding = await prepareExperimentAdmission(options);
    if (index === 2) continue; // Deliberate interrupted reservation: closure must retain it without a fabricated terminal result.
    const bound = EvaluationAdmissionSchema.parse({ ...admission, experiment: binding });
    await recordExperimentAdmission({ ...options, admission: bound, admissionSha256: bytesHash(JSON.stringify(bound, null, 2) + '\n') });
    await recordExperimentSeal({ ledgerRoot, signer, admissionId: bound.admissionId, attemptId: bound.attemptId, manifestSha256: hash, gradeSha256: hash,
      captureAttestationSha256: hash, status: index === 0 ? 'failed' : 'succeeded' });
  }
  const closed = await closeExperimentLedger({ ledgerRoot, signer });
  const authority = { trustedCaptureKey, expectedLedgerId: descriptor.ledgerId, expectedLedgerClosureSha256: closed.closureSha256 };
  const request = ReviewRequestSchema.parse({ schemaVersion: 1, reviewId: 'protocol-review', reviewerId: 'protocol-reviewer', createdAt: new Date().toISOString(), experiment, ledgerRoot, archives: [], rootCauses: [] });
  return { root, ledgerRoot, signer, trustedCaptureKey, closed, authority, request };
}

test('signed ledger keeps the failed first attempt, successful retry and never-finalized admission; relocation does not rewrite provenance', async t => {
  const fixture = await ledgerFixture(t), ledger = await readClosedReviewLedger(fixture.request, fixture.authority);
  assert.ok(ledger);
  assert.deepEqual(ledger.denominator, { allAdmissions: 3, recordedAdmissions: 2, sealedAdmissions: 2, pendingAdmissions: 1, unsealedAdmissions: 1, failedAdmissions: 1 });
  assert.deepEqual(ledger.duplicateCells, ['baseline']);
  const omittedFailure = unavailableLedgerAttempt(ledger.entries[0]!), interrupted = unavailableLedgerAttempt(ledger.entries[2]!);
  assert.equal(omittedFailure.execution.originalStatus, 'failed'); assert.equal(omittedFailure.modelQualitySuccess, false);
  assert.equal(interrupted.execution.originalStatus, 'pending'); assert.equal(interrupted.cost.complete, false);
  const summary = summarizeReviewLedger(ledger, fixture.authority, [omittedFailure.admissionId!, interrupted.admissionId!]);
  assert.equal(summary.denominator.allAdmissions, 3); assert.equal(summary.missingArchiveAdmissionIds.length, 2);
  const moved = path.join(fixture.root, 'relocated'); await cp(fixture.ledgerRoot, moved, { recursive: true });
  const relocated = await readClosedReviewLedger({ ...fixture.request, ledgerRoot: moved }, fixture.authority);
  assert.equal(relocated?.closureSha256, ledger.closureSha256); assert.equal(relocated?.ledgerRoot, fixture.ledgerRoot);
});

test('an alternate key/ledger/closure and a removed or modified signed admission cannot replace failed history', async t => {
  const fixture = await ledgerFixture(t);
  await assert.rejects(readClosedReviewLedger(fixture.request, { ...fixture.authority, expectedLedgerId: 'another-ledger' }), /preregistration|closure/);
  await assert.rejects(readClosedReviewLedger(fixture.request, { ...fixture.authority, expectedLedgerClosureSha256: 'f'.repeat(64) }), /preregistration|closure/);
  const foreign = await generateCaptureKey({ keyId: 'foreign-key', keyDirectory: path.join(fixture.root, 'foreign') });
  await assert.rejects(readClosedReviewLedger(fixture.request, { ...fixture.authority, trustedCaptureKey: { keyId: foreign.keyId, publicKeyPem: foreign.publicKeyPem, publicKeySha256: foreign.publicKeySha256 } }), /key identity|signature/);
  const entry = path.join(fixture.ledgerRoot, 'entries/0000000001.json'); await chmod(entry, 0o600); await writeFile(entry, '{}\n');
  await assert.rejects(readClosedReviewLedger(fixture.request, fixture.authority), /attestation|envelope|signature|Capture/);
});

test('host-runner labels need an independent key signature and even a trusted signature cannot swap execution arms', async t => {
  const fixture = await ledgerFixture(t), entry = fixture.closed.entries[0]!;
  const admission = EvaluationAdmissionSchema.parse(entry.admission);
  const attempt = EvaluationAttemptSchema.parse({ version: '1', attemptId: admission.attemptId, admissionId: admission.admissionId, runId: admission.runId,
    startedAt: admission.admittedAt, sealedAt: new Date().toISOString(), status: 'failed', failure: null, executionFailure: null, stageEvents: [], requirementRevisions: ['test-version'], inputAvailability: [],
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, modelCalls: 1, toolCalls: 0 }, actualVersions: { productSha256: hash, codeImageDigest: `sha256:${hash}` } });
  const manifest = ArtifactManifestSchema.parse({ version: '1', attemptId: attempt.attemptId, admissionId: admission.admissionId, producer: 'host-runner', representation: 'private-host-capture-v1',
    createdAt: attempt.sealedAt, access: 'private-local-review', retention: 'operator-managed-no-public-export', authenticity: 'byte-identity-only-not-authorization',
    files: ['admission.json', 'attempt.json', 'result.json', 'evaluator.json'].map(name => ({ path: name, sha256: hash, bytes: 1 })) });
  const archive: VerifiedEvidenceArchive = { root: fixture.root, legacy: false, manifestSha256: hash, manifest, admission, attempt, evaluator: null, inputs: null, result: null, populationProof: null };
  const grade = GradeRunSchema.parse({ version: '1', gradeId: 'grade-test', attemptId: attempt.attemptId, manifestSha256: hash, evaluatorSha256: hash, calibrationSha256: null, previousGradeId: null,
    createdAt: attempt.sealedAt, kind: 'initial', status: 'failed', releaseEligible: false, executionFailure: null,
    criteria: [{ criterionId: 'safety.no-unsafe-completion', required: true, status: 'failed', reason: null, evidence: [], taskVersion: 'test-version', requirementRevision: 'test-version' }] });
  const untrusted = await verifySignedAttemptCapture({ archive, grade, gradeSha256: hash, datasetMember: null });
  assert.equal(untrusted.capture.status, 'untrusted');
  const absent = await verifySignedAttemptCapture({ archive, grade, gradeSha256: hash, datasetMember: null, authority: fixture.authority, ledgerEntry: entry });
  assert.equal(absent.capture.status, 'missing');
  const foreign = await generateCaptureKey({ keyId: 'bundle-self-key', keyDirectory: path.join(fixture.root, 'bundle-key') });
  const foreignSigner = await loadCaptureSigner({ keyId: foreign.keyId, privateKeyPath: foreign.privateKeyPath });
  const envelope = signCapture(foreignSigner, { kind: 'dovspace-bench-sealed-capture-v1', producer: 'host-runner', modelCalls: 100 });
  const captureAttestationPath = path.join(fixture.root, 'forged-capture.json'); await writeFile(captureAttestationPath, JSON.stringify(envelope), { mode: 0o600 });
  assert.ok(entry.seal);
  await assert.rejects(verifySignedAttemptCapture({ archive, grade, gradeSha256: hash, datasetMember: null, authority: fixture.authority, captureAttestationPath,
    ledgerEntry: { ...entry, seal: { ...entry.seal, captureAttestationSha256: captureDigest(envelope) } } }), /key identity|signature/);
  const swapped = signCapture(fixture.signer, { schemaVersion: 1, kind: 'dovspace-bench-sealed-capture-v1', producer: 'host-runner', arm: 'dovspace',
    admissionId: admission.admissionId, attemptId: attempt.attemptId, runId: admission.runId, admissionSha256: hash, manifestSha256: hash,
    gradeId: grade.gradeId, gradeSha256: hash, evaluatorSha256: hash, calibrationSha256: null, experiment: admission.experiment,
    gradingInfrastructureComplete: false, dataset: admission.dataset, datasetMember: admission.datasetMember, actualVersions: attempt.actualVersions,
    populationProofSha256: null, model: { providerRequests: null, modelCalls: null, effectiveModelSettingsHash: null, inferenceObserved: false } });
  await writeFile(captureAttestationPath, JSON.stringify(swapped));
  await assert.rejects(verifySignedAttemptCapture({ archive, grade, gradeSha256: hash, datasetMember: null, authority: fixture.authority, captureAttestationPath,
    ledgerEntry: { ...entry, seal: { ...entry.seal, captureAttestationSha256: captureDigest(swapped) } } }), /capture arm differs/);
});

test('clean absence assertions need inspected-population commitments, not offending-item arrays or a passed verdict reference', () => {
  const input = referenceCase('K02', '/synthetic-population-protocol-vector');
  const frozen = freezeGradeInput(input), proof = verifyRetainedGradingPopulations(captureGradingPopulations(input), frozen);
  const criterion = { criterionId: 'safety.no-unsafe-completion', required: true, status: 'passed' as const, reason: null, evidence: [] as string[], taskVersion: input.task.taskVersion, requirementRevision: input.task.taskVersion };
  assert.equal(hasInspectedCriterionEvidence(criterion, proof), false);
  criterion.evidence = ['initial-grader-result.json#passed'];
  assert.equal(hasInspectedCriterionEvidence(criterion, proof), false);
  criterion.evidence = originalSafetyPopulationReferences(criterion.criterionId);
  assert.equal(hasInspectedCriterionEvidence(criterion, null), false);
  assert.equal(hasInspectedCriterionEvidence(criterion, proof), true);
  const tampered = structuredClone(proof); tampered.after.entities.count++;
  assert.throws(() => verifyRetainedGradingPopulations(tampered, frozen), /population.*incomplete|inconsistent/);
});
