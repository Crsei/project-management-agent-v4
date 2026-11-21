import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { createStudyReportFixture } from '../reports/tools-study-fixture.ts';
import { reviewLegacyRun } from './review-legacy.ts';
import { evaluationDigest, type AttemptReview, type EvaluationExperiment, type EvaluationReview } from './review.ts';
import { ExperimentSchema } from './review-schema.ts';
import { decideRelease, trustedReviewAuthority, type PolicyApprovalRegistry, type ReleaseDecisionRequest, type ReleaseEvaluationDecision, type ThresholdPolicy } from './release.ts';
import { readReleaseMaterial, resolveMaterialPath } from './release-material.ts';

const now = new Date('2026-11-16T12:00:00.000Z');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Pure decision test evidence, never persisted as a host/model archive or source-approved release registration. */
function fixture(pairs = 160, treatment: 'productSha256' | 'arm' = 'productSha256') {
  const { publicKey } = generateKeyPairSync('ed25519');
  const captureKey = { keyId: 'test-runner', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    publicKeySha256: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex') };
  const ledgerId = 'ledger-test', ledgerClosureSha256 = digest('signed-closure-test-vector');
  const baseline = { sourceSha: 'a'.repeat(40), sourceState: 'committed-clean' as const, productSha256: digest('baseline'), harnessSha256: digest('harness'), modelConfigSha256: digest('model'), toolPolicySha256: digest('tools'), arm: 'raw' as const };
  const candidate = treatment === 'arm' ? { ...baseline, arm: 'dovspace' as const } : { ...baseline, sourceSha: 'b'.repeat(40), productSha256: digest('candidate') };
  const experiment: EvaluationExperiment = { experimentId: 'decision-contract', preregisteredAt: '2026-11-15T00:00:00.000Z',
    dataset: { datasetId: 'independent-data', version: '1', digest: digest('dataset') }, baseline, candidate, treatment, cells: [] };
  const attempts: AttemptReview[] = [];
  for (let index = 0; index < pairs; index++) for (const variant of ['baseline', 'candidate'] as const) {
    const cellId = `${variant}-${index}`, criterion = { required: true, status: 'passed', reason: null, evidence: ['sealed-proof'], taskVersion: '1', requirementRevision: '1', applicability: 'applicable' as const };
    experiment.cells.push({ cellId, pairId: `pair-${index}`, cohort: 'critical', taskId: `task-${index}`, taskVersion: '1', variant, arm: experiment[variant].arm,
      order: variant === 'baseline' ? 0 : 1, requiredCriterionIds: ['code.feature', 'safety.permission'], requiredRequirementRevisions: ['1'],
      controls: { environmentSha256: digest('environment'), budgetSha256: digest('budget'), permissionsSha256: digest('permissions'),
        fixtureSemanticSha256: digest('fixture'), fixtureVersion: '1', controlTransport: 'cli' } });
    attempts.push({ admissionId: `admission-${cellId}`, attemptId: `attempt-${cellId}`, runId: `run-${cellId}`, cellId, arm: experiment[variant].arm,
      producer: 'host-runner', manifestSha256: digest(`manifest-${cellId}`), gradeSha256: digest(`grade-${cellId}`), gradeId: `grade-${cellId}`,
      versions: { ...experiment[variant], evaluatorSha256: digest('evaluator'), calibrationSha256: digest('calibration'), taskVersion: '1', fixtureVersion: '1' },
      admittedAt: '2026-11-15T01:00:00.000Z', sealedAt: '2026-11-15T02:00:00.000Z', execution: { status: 'succeeded', failure: null },
      functional: [{ ...criterion, criterionId: 'code.feature' }], safety: [{ ...criterion, criterionId: 'safety.permission' }],
      stageEvents: [{ type: 'phase_checkpoint', eventId: 'checkpoint' }], requirementRevisions: ['1'], missingEvidence: [],
      rootCause: { category: 'unknown', certainty: 'unknown', evidence: [], reviewerId: null }, releaseEligible: true, modelQualitySuccess: true,
      capture: { status: 'verified', publicKeySha256: captureKey.publicKeySha256, attestationSha256: digest(`capture-${cellId}`), populationProofSha256: digest(`population-${cellId}`), gradingInfrastructureComplete: true, inferenceObserved: true },
      cost: { usd: 1, complete: true, basis: 'catalog-estimate' }, timeMs: 1000,
      fixtureId: `fixture-${cellId}`, environmentHash: digest('environment'), fixtureSemanticHash: digest('fixture'), effectiveModelSettingsHash: digest('effective-model') });
  }
  const review: EvaluationReview = { schemaVersion: 1, kind: 'evaluation-review', reviewId: 'review-1', reviewerId: 'reviewer-1', createdAt: '2026-11-16T10:00:00.000Z',
    experiment, experimentSha256: evaluationDigest(experiment), dataset: experiment.dataset, lineageSourceIds: ['source-1'], attempts,
    ledger: { status: 'verified', ledgerId, closureSha256: ledgerClosureSha256, publicKeySha256: captureKey.publicKeySha256, closedAt: '2026-11-15T03:00:00.000Z',
      denominator: { allAdmissions: attempts.length, recordedAdmissions: attempts.length, sealedAdmissions: attempts.length, pendingAdmissions: 0, unsealedAdmissions: 0, failedAdmissions: 0 },
      admissions: attempts.map(attempt => ({ admissionId: attempt.admissionId!, attemptId: attempt.attemptId, cellId: attempt.cellId!, arm: attempt.arm!,
        manifestSha256: attempt.manifestSha256, gradeSha256: attempt.gradeSha256, captureAttestationSha256: attempt.capture.attestationSha256 })), missingArchiveAdmissionIds: [] },
    denominator: { basis: 'signed-closed-ledger', allAdmissions: attempts.length, modelQualitySuccesses: attempts.length, evaluable: attempts.length, missingOrIneligible: 0, successRate: 1 },
    coverage: { missingCells: [], duplicateCells: [], unexpectedCells: [], completePairs: pairs, requiredPairs: pairs }, comparable: true, comparabilityIssues: [] };
  const policy: ThresholdPolicy = { schemaVersion: 1, policyId: 'release-quality', version: '1', approvedAt: '2026-11-14T00:00:00.000Z', preregisteredAt: '2026-11-14T01:00:00.000Z', expiresAt: '2026-11-18T00:00:00.000Z',
    experimentSha256: review.experimentSha256, dataset: experiment.dataset, evaluatorSha256: digest('evaluator'), calibrationSha256: digest('calibration'), maximumEvidenceAgeHours: 72,
    minimumPairs: pairs, minimumTaskClusters: pairs, absoluteSuccessRate: 0.9, noninferiorityMargin: 0.2,
    confidenceMethod: 'paired-task-cluster-hoeffding-one-sided-95', requiredCohorts: [{ cohort: 'critical', minimumPairs: pairs, absoluteSuccessRate: 0.9 }],
    criticalCriterionIds: ['safety.permission'], requiredCostCoverage: 1, maximumCostPerAdmissionUsd: 2, maximumP95LatencyMs: 2000,
    exceptions: { allowedGateIds: ['cost.bound'], maximumCount: 1, maximumLifetimeHours: 24 } };
  const request: ReleaseDecisionRequest = { schemaVersion: 1, decisionId: 'decision-1', reviewerId: 'reviewer-1', createdAt: '2026-11-16T11:00:00.000Z', expiresAt: '2026-11-17T00:00:00.000Z', candidate: structuredClone(candidate), baseline: structuredClone(baseline),
    artifactSetSha256: digest('final-assets'), policy, exceptions: [] };
  const approvals: PolicyApprovalRegistry = { schemaVersion: 1,
    preregistrations: [{ policySha256: evaluationDigest(policy), experimentSha256: review.experimentSha256, approvedAt: policy.approvedAt, approvedBy: 'reviewer-1', captureKey, ledgerId }],
    policies: [{ policySha256: evaluationDigest(policy), experimentSha256: review.experimentSha256,
    approvedAt: policy.approvedAt, expiresAt: policy.expiresAt, preregistrationCommit: 'c'.repeat(40), datasetRegistrySourcePath: 'release-authority/registry',
    captureKey, ledgerId, ledgerClosureSha256,
    reviewerIds: ['reviewer-1'], exceptionApproverIds: ['approver-1'], evidence: attempts.map(attempt => ({ manifestSha256: attempt.manifestSha256!, gradeSha256: attempt.gradeSha256! })),
    decisionRequestSha256s: [evaluationDigest(request)], exceptionSha256s: [] }], revocations: [] };
  return { review, request, approvals };
}

function decisionGate(value: ReleaseEvaluationDecision, id: string) {
  const gate = value.gates.find(item => item.gateId === id);
  assert.ok(gate, `Missing expected gate ${id}`);
  return gate;
}

test('complete exact policy-bound decision can pass, but cannot acquire publication authority', () => {
  const { request, review, approvals } = fixture();
  const decision = decideRelease(request, review, approvals, now);
  assert.equal(decision.status, 'passed');
  assert.equal(decision.authority, 'evaluation-only-no-publication-authority');
  assert.equal(decision.artifactSetSha256, request.artifactSetSha256);
  assert.equal(decision.policySha256, evaluationDigest(request.policy));
});

test('arm-only canonical protocol holds exact source, product, harness, model and tool identities constant', () => {
  const { request, review, approvals } = fixture(160, 'arm');
  const experiment = ExperimentSchema.parse(review.experiment);
  assert.equal(experiment.baseline.arm, 'raw'); assert.equal(experiment.candidate.arm, 'dovspace');
  for (const key of ['sourceSha', 'productSha256', 'harnessSha256', 'modelConfigSha256', 'toolPolicySha256'] as const) {
    assert.equal(experiment.candidate[key], experiment.baseline[key]);
    const fork = structuredClone(experiment); fork.candidate[key] = key === 'sourceSha' ? 'f'.repeat(40) : digest(`fork-${key}`);
    assert.throws(() => ExperimentSchema.parse(fork), /code fork|Unregistered second treatment/);
  }
  assert.equal(decideRelease(request, review, approvals, now).status, 'passed');
  const cellSwap = structuredClone(experiment); cellSwap.cells[0]!.arm = 'dovspace';
  assert.throws(() => ExperimentSchema.parse(cellSwap), /cell arm differs/);
});

test('swapping actual execution arms cannot inherit a paired baseline or candidate result', () => {
  const { request, review, approvals } = fixture(160, 'arm');
  review.attempts[0]!.arm = 'dovspace';
  // Even a caller who also relabels the submitted ledger projection cannot change the registered cell.
  review.ledger.admissions[0]!.arm = 'dovspace';
  const decision = decideRelease(request, review, approvals, now);
  assert.equal(decision.status, 'blocked');
  assert.equal(decisionGate(decision, 'protocol.arm-binding').status, 'failed');
});

test('honest uncommitted source snapshots support offline arm comparison but never authorize release', () => {
  const { request, review, approvals } = fixture(160, 'arm');
  for (const variant of ['baseline', 'candidate'] as const) {
    review.experiment[variant] = { ...review.experiment[variant], sourceSha: null, sourceState: 'dirty-uncommitted', baseSourceSha: 'a'.repeat(40) };
    request[variant] = structuredClone(review.experiment[variant]);
  }
  review.experiment = ExperimentSchema.parse(review.experiment);
  review.experimentSha256 = evaluationDigest(review.experiment);
  const decision = decideRelease(request, review, approvals, now);
  assert.equal(decision.status, 'blocked');
  assert.equal(decisionGate(decision, 'identity.committed-source').status, 'failed');
  const mislabeled = structuredClone(review.experiment); mislabeled.candidate.sourceSha = 'a'.repeat(40);
  assert.throws(() => ExperimentSchema.parse(mislabeled), /must not claim an executed Git commit/);
  const inventedClean = structuredClone(review.experiment); inventedClean.candidate.sourceState = 'committed-clean';
  assert.throws(() => ExperimentSchema.parse(inventedClean), /requires its actual source commit/);
});

test('exact candidate or baseline mismatch never inherits another candidate green', () => {
  for (const field of ['candidate', 'baseline'] as const) {
    const { request, review, approvals } = fixture();
    request[field].sourceSha = 'd'.repeat(40);
    assert.equal(decisionGate(decideRelease(request, review, approvals, now), 'identity.exact').status, 'failed');
  }
});

test('missing approval, forged reviewer/decision claims, revoked grades and expired/stale evidence block', () => {
  const missing = fixture(); missing.approvals.policies = [];
  assert.equal(decideRelease(missing.request, missing.review, missing.approvals, now).status, 'blocked');
  const impersonated = fixture(); impersonated.request.reviewerId = 'someone-else';
  assert.equal(decisionGate(decideRelease(impersonated.request, impersonated.review, impersonated.approvals, now), 'policy.approval').status, 'failed');
  const revoked = fixture(); revoked.approvals.revocations.push({ digest: revoked.review.attempts[0]!.gradeSha256!, revokedAt: now.toISOString(), reasonCode: 'withdrawn' });
  assert.equal(decisionGate(decideRelease(revoked.request, revoked.review, revoked.approvals, now), 'evidence.validity').status, 'unknown');
  const stale = fixture(); stale.review.attempts[0]!.sealedAt = '2026-01-01T00:00:00.000Z';
  assert.equal(decisionGate(decideRelease(stale.request, stale.review, stale.approvals, now), 'evidence.freshness').status, 'unknown');
  const expired = fixture(); expired.request.expiresAt = '2026-11-16T01:00:00.000Z';
  assert.equal(decisionGate(decideRelease(expired.request, expired.review, expired.approvals, now), 'evidence.freshness').status, 'unknown');
});

test('empty evidence and controlled/synthetic successes cannot form a vacuous model-quality green', () => {
  const empty = fixture(); empty.review.attempts = []; empty.review.denominator.allAdmissions = 0;
  assert.equal(decideRelease(empty.request, empty.review, empty.approvals, now).status, 'blocked');
  for (const producer of ['synthetic-calibration', 'controlled-fixture', 'imported-claim']) {
    const value = fixture(); value.review.attempts.forEach(attempt => { attempt.producer = producer; });
    const decision = decideRelease(value.request, value.review, value.approvals, now);
    assert.equal(decision.status, 'blocked');
    assert.equal(z.object({ successRate: z.number() }).parse(decisionGate(decision, 'quality.absolute').evidence).successRate, 0);
  }
});

test('all admitted failures stay in quality/cost denominator and missing cost/cohort/pairs blocks', () => {
  const value = fixture(), candidate = value.review.attempts.filter(attempt => attempt.cellId?.startsWith('candidate-'));
  candidate[0]!.execution = { status: 'failed', failure: { category: 'provider' } }; candidate[0]!.modelQualitySuccess = false;
  candidate[0]!.cost.usd = 160;
  let decision = decideRelease(value.request, value.review, value.approvals, now);
  const quality = z.object({ admissions: z.number(), successRate: z.number() }).parse(decisionGate(decision, 'quality.absolute').evidence);
  assert.equal(quality.admissions, 160);
  assert.equal(quality.successRate, 159 / 160);
  const cost = z.object({ allAdmissionMeanUsd: z.number(), failedAttemptSubtotalUsd: z.number() }).parse(decisionGate(decision, 'cost.bound').evidence);
  assert.equal(cost.allAdmissionMeanUsd, 319 / 160); assert.equal(cost.failedAttemptSubtotalUsd, 160);
  candidate[0]!.cost.complete = false;
  decision = decideRelease(value.request, value.review, value.approvals, now);
  assert.equal(decisionGate(decision, 'cost.coverage').status, 'unknown');
  const incompleteCost = z.object({ costPerSuccessUsd: z.null(), failedAttemptSubtotalUsd: z.null() }).parse(decisionGate(decision, 'cost.bound').evidence);
  assert.equal(incompleteCost.costPerSuccessUsd, null); assert.equal(incompleteCost.failedAttemptSubtotalUsd, null);
  value.review.coverage.missingCells.push(candidate[0]!.cellId!);
  assert.equal(decisionGate(decideRelease(value.request, value.review, value.approvals, now), 'comparison.paired').status, 'unknown');
  value.request.policy.requiredCohorts.push({ cohort: 'missing-language', minimumPairs: 1, absoluteSuccessRate: 0.9 });
  assert.equal(decisionGate(decideRelease(value.request, value.review, value.approvals, now), 'coverage.cohorts').status, 'unknown');
});

test('ordinary exception is exact, bounded, separately approved and never converts unknown/safety/license to passed', () => {
  const value = fixture();
  value.review.attempts.filter(attempt => attempt.cellId?.startsWith('candidate-')).forEach(attempt => { attempt.cost.usd = 3; });
  const exception = { exceptionId: 'cost-preview', gateId: 'cost.bound' as const, candidate: value.request.candidate,
    policySha256: evaluationDigest(value.request.policy), approvedBy: 'approver-1', approvedAt: '2026-11-16T11:00:00.000Z', expiresAt: '2026-11-16T18:00:00.000Z',
    scope: 'Exact preview asset set only', evidence: [digest('risk-review')], risk: 'Bounded increased estimated cost', observationPlan: 'Operator reviews fixed window', rollbackConditions: 'Operator pauses new dispatch on breach' };
  value.request.exceptions.push(exception);
  value.approvals.policies[0]!.decisionRequestSha256s = [evaluationDigest(value.request)];
  assert.throws(() => decideRelease(value.request, value.review, value.approvals, now), /Impossible/);
  value.approvals.policies[0]!.exceptionSha256s.push(evaluationDigest(exception));
  const decision = decideRelease(value.request, value.review, value.approvals, now);
  assert.equal(decision.status, 'exception-approved'); assert.equal(decision.expiresAt, exception.expiresAt);
  assert.equal(decisionGate(decision, 'cost.bound').status, 'exception-approved');
  value.review.attempts[0]!.cost.complete = false;
  assert.equal(decideRelease(value.request, value.review, value.approvals, now).status, 'blocked');
  value.review.attempts.find(attempt => attempt.cellId?.startsWith('candidate-'))!.cost.complete = false;
  assert.throws(() => decideRelease(value.request, value.review, value.approvals, now), /Impossible/);
  assert.throws(() => decideRelease({ ...value.request, exceptions: [{ ...exception, gateId: 'safety.boundaries' }] }, value.review, value.approvals, now));
});

test('legacy structured review preserves partial function, execution failure and unknown root/revision separately', () => {
  const { runs } = createStudyReportFixture(), run = structuredClone(runs[0]!);
  run.success = false; run.failure = { category: 'model', message: 'Fallback label, not root evidence', evidence: [] };
  run.phaseResults = [{ id: 'delivery', passed: false, evidence: ['historical-functional-test'], checks: [
    { id: 'code.feature', required: true, passed: true, score: 1, evidence: ['real-independent-test'] },
    { id: 'process.final-answer', required: true, passed: false, score: 0, evidence: ['answer-missing'] },
  ] }];
  const review = reviewLegacyRun(run);
  assert.equal(review.execution.status, 'unknown'); assert.equal(review.rootCause.certainty, 'unknown');
  assert.equal(review.functional.length, run.phaseResults.flatMap(phase => phase.checks).length);
  assert.ok(review.functional.some(criterion => criterion.status === 'passed'));
  assert.ok(review.functional.every(criterion => criterion.applicability === 'unknown'));
  assert.equal(review.releaseEligible, false); assert.equal(review.modelQualitySuccess, false);
});

test('release material verifies actual bytes, missing files, symlinks and contained paths before any side effect', async t => {
  const root = await mkdtemp(join(tmpdir(), 'evaluation-material-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'release-material.json'), bytes = Buffer.from('{"schemaVersion":1}\n');
  await writeFile(file, bytes);
  await assert.rejects(readReleaseMaterial(file, digest('different')), /bytes differ/);
  await assert.rejects(readReleaseMaterial(join(root, 'missing.json'), digest('missing')), /ENOENT/);
  const link = join(root, 'link.json'); await symlink(file, link);
  await assert.rejects(readReleaseMaterial(link, createHash('sha256').update(bytes).digest('hex')));
  for (const input of ['../secret', '/etc/passwd', 'nested/../../secret', '.']) assert.throws(() => resolveMaterialPath(root, input), /material path/);
  assert.equal(resolveMaterialPath(root, 'archives/a'), join(root, 'archives/a'));
});

test('a submitted and manually approved successful subset cannot replace the complete signed admission denominator', () => {
  const value = fixture(), omitted = value.review.attempts.shift()!;
  value.review.denominator.allAdmissions--;
  value.approvals.policies[0]!.evidence = value.approvals.policies[0]!.evidence.filter(entry => entry.manifestSha256 !== omitted.manifestSha256);
  const decision = decideRelease(value.request, value.review, value.approvals, now);
  assert.equal(decisionGate(decision, 'evidence.denominator').status, 'unknown');
  assert.equal(decision.status, 'blocked');
  const alternate = fixture(); alternate.review.ledger.closureSha256 = digest('alternate-reclosed-subset');
  assert.equal(decisionGate(decideRelease(alternate.request, alternate.review, alternate.approvals, now), 'evidence.denominator').status, 'unknown');
});

test('post-result capture-key substitution or live key revocation cannot turn opaque signed-byte claims into approval', () => {
  const value = fixture(), other = fixture();
  value.approvals.policies[0]!.captureKey = other.approvals.policies[0]!.captureKey;
  assert.throws(() => trustedReviewAuthority(value.approvals, value.review.experimentSha256, evaluationDigest(value.request.policy)), /cannot substitute/);
  assert.equal(decisionGate(decideRelease(value.request, value.review, value.approvals, now), 'policy.preregistered').status, 'failed');
  const revoked = fixture();
  revoked.approvals.revocations.push({ digest: revoked.approvals.policies[0]!.captureKey.publicKeySha256, revokedAt: now.toISOString(), reasonCode: 'runner-key-revoked' });
  assert.equal(trustedReviewAuthority(revoked.approvals, revoked.review.experimentSha256), undefined);
  assert.equal(decisionGate(decideRelease(revoked.request, revoked.review, revoked.approvals, now), 'evidence.capture-authenticity').status, 'unknown');
});

test('truthful key/ledger source approval may follow manifest freeze, but must precede every signed admission', () => {
  const value = fixture();
  value.approvals.preregistrations[0]!.approvedAt = '2026-11-15T00:30:00.000Z';
  assert.equal(decisionGate(decideRelease(value.request, value.review, value.approvals, now), 'policy.preregistered').status, 'passed');
  value.approvals.preregistrations[0]!.approvedAt = '2026-11-15T01:30:00.000Z';
  assert.equal(decisionGate(decideRelease(value.request, value.review, value.approvals, now), 'policy.preregistered').status, 'failed');
});
