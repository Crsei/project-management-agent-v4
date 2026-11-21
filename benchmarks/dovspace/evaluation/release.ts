import { z } from 'zod';
import { CaptureKeySchema, Digest, Identifier, Instant, DatasetReferenceSchema, EvaluationIdentitySchema, evaluationDigest } from './review-schema.ts';
import type { EvaluationReview } from './review.ts';
import type { TrustedReviewOptions } from './review-provenance.ts';

const ExceptionGate = z.enum(['quality.noninferiority', 'cost.bound', 'latency.bound']);
export const ThresholdPolicySchema = z.object({
  schemaVersion: z.literal(1), policyId: Identifier, version: Identifier, approvedAt: Instant, preregisteredAt: Instant, expiresAt: Instant,
  experimentSha256: Digest, dataset: DatasetReferenceSchema, evaluatorSha256: Digest, calibrationSha256: Digest,
  maximumEvidenceAgeHours: z.number().positive().max(24 * 90), minimumPairs: z.number().int().positive(), minimumTaskClusters: z.number().int().positive(),
  absoluteSuccessRate: z.number().min(0).max(1), noninferiorityMargin: z.number().min(0).max(0.2),
  confidenceMethod: z.literal('paired-task-cluster-hoeffding-one-sided-95'),
  requiredCohorts: z.array(z.object({ cohort: Identifier, minimumPairs: z.number().int().positive(), absoluteSuccessRate: z.number().min(0).max(1) }).strict()).min(1),
  criticalCriterionIds: z.array(Identifier).min(1), requiredCostCoverage: z.literal(1), maximumCostPerAdmissionUsd: z.number().nonnegative(),
  maximumP95LatencyMs: z.number().positive(),
  exceptions: z.object({ allowedGateIds: z.array(ExceptionGate), maximumCount: z.number().int().min(0).max(3), maximumLifetimeHours: z.number().positive().max(168) }).strict(),
}).strict().superRefine((policy, ctx) => {
  if (Date.parse(policy.approvedAt) > Date.parse(policy.preregisteredAt) || Date.parse(policy.preregisteredAt) >= Date.parse(policy.expiresAt)) ctx.addIssue({ code: 'custom', message: 'Policy approval must precede preregistration and expiry' });
  if (new Set(policy.requiredCohorts.map(cohort => cohort.cohort)).size !== policy.requiredCohorts.length || new Set(policy.criticalCriterionIds).size !== policy.criticalCriterionIds.length) ctx.addIssue({ code: 'custom', message: 'Policy cohort and critical criterion lists must be distinct' });
});
export type ThresholdPolicy = z.infer<typeof ThresholdPolicySchema>;
export const PolicyApprovalRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  preregistrations: z.array(z.object({ policySha256: Digest, experimentSha256: Digest, approvedAt: Instant, approvedBy: Identifier,
    captureKey: CaptureKeySchema, ledgerId: Identifier }).strict()),
  policies: z.array(z.object({ policySha256: Digest, experimentSha256: Digest, approvedAt: Instant, expiresAt: Instant,
    preregistrationCommit: z.string().regex(/^[a-f0-9]{40}$/), reviewerIds: z.array(Identifier).min(1), exceptionApproverIds: z.array(Identifier),
    captureKey: CaptureKeySchema, ledgerId: Identifier, ledgerClosureSha256: Digest,
    datasetRegistrySourcePath: z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/).refine(value => !value.split('/').some(part => part === '.' || part === '..')),
    evidence: z.array(z.object({ manifestSha256: Digest, gradeSha256: Digest }).strict()),
    decisionRequestSha256s: z.array(Digest), exceptionSha256s: z.array(Digest),
  }).strict()),
  revocations: z.array(z.object({ digest: Digest, revokedAt: Instant, reasonCode: Identifier }).strict()),
}).strict();
export type PolicyApprovalRegistry = z.infer<typeof PolicyApprovalRegistrySchema>;

/** Only independently registered source metadata may select a capture key and the one admitted ledger. */
export function trustedReviewAuthority(approvals: PolicyApprovalRegistry, experimentSha256: string, policySha256?: string): TrustedReviewOptions | undefined {
  const registrations = approvals.preregistrations.filter(entry => entry.experimentSha256 === experimentSha256 && (policySha256 === undefined || entry.policySha256 === policySha256));
  const registration = registrations[0];
  if (!registration) return undefined;
  if (registrations.some(entry => entry.ledgerId !== registration.ledgerId || evaluationDigest(entry.captureKey) !== evaluationDigest(registration.captureKey))) throw new Error('Conflicting independently preregistered capture authorities for one experiment');
  if (approvals.revocations.some(entry => entry.digest === registration.captureKey.publicKeySha256)) return undefined;
  const policy = policySha256 === undefined ? undefined : approvals.policies.find(entry => entry.policySha256 === policySha256 && entry.experimentSha256 === experimentSha256);
  if (policy && (policy.ledgerId !== registration.ledgerId || evaluationDigest(policy.captureKey) !== evaluationDigest(registration.captureKey))) throw new Error('Post-result approval cannot substitute the independently preregistered capture key or ledger');
  return { trustedCaptureKey: registration.captureKey, expectedLedgerId: registration.ledgerId,
    ...(policy ? { expectedLedgerClosureSha256: policy.ledgerClosureSha256 } : {}) };
}
export const ReleaseExceptionSchema = z.object({
  exceptionId: Identifier, gateId: ExceptionGate, candidate: EvaluationIdentitySchema, policySha256: Digest,
  approvedBy: Identifier, approvedAt: Instant, expiresAt: Instant, scope: z.string().min(1).max(500),
  evidence: z.array(Digest).min(1), risk: z.string().min(1).max(1000), observationPlan: z.string().min(1).max(1000), rollbackConditions: z.string().min(1).max(1000),
}).strict();
export const ReleaseDecisionRequestSchema = z.object({
  schemaVersion: z.literal(1), decisionId: Identifier, reviewerId: Identifier, createdAt: Instant, expiresAt: Instant,
  candidate: EvaluationIdentitySchema, baseline: EvaluationIdentitySchema, artifactSetSha256: Digest,
  policy: ThresholdPolicySchema, exceptions: z.array(ReleaseExceptionSchema),
}).strict();
export type ReleaseDecisionRequest = z.infer<typeof ReleaseDecisionRequestSchema>;
export type ReleaseGate = { gateId: string; status: 'passed' | 'failed' | 'unknown' | 'exception-approved'; reasons: string[]; evidence: unknown };
export const ReleaseEvaluationDecisionSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('release-evaluation-decision'), decisionId: Identifier, reviewerId: Identifier,
  createdAt: Instant, expiresAt: Instant, candidate: EvaluationIdentitySchema, baseline: EvaluationIdentitySchema, artifactSetSha256: Digest,
  policyId: Identifier, policyVersion: Identifier, policySha256: Digest, experimentId: Identifier, experimentSha256: Digest,
  evaluatorSha256: Digest, calibrationSha256: Digest, reviewSha256: Digest, dataset: DatasetReferenceSchema,
  ledgerId: Identifier.nullable(), ledgerClosureSha256: Digest.nullable(), capturePublicKeySha256: Digest.nullable(),
  status: z.enum(['passed', 'exception-approved', 'blocked']),
  gates: z.array(z.object({ gateId: Identifier, status: z.enum(['passed', 'failed', 'unknown', 'exception-approved']),
    reasons: z.array(z.string()), evidence: z.unknown() }).strict()).min(1),
  exceptions: z.array(ReleaseExceptionSchema), authority: z.literal('evaluation-only-no-publication-authority'),
}).strict().superRefine((decision, ctx) => {
  if (new Set(decision.gates.map(gate => gate.gateId)).size !== decision.gates.length) ctx.addIssue({ code: 'custom', message: 'Duplicate release gate identity' });
  if (decision.status !== 'blocked' && (!decision.ledgerId || !decision.ledgerClosureSha256 || !decision.capturePublicKeySha256)) ctx.addIssue({ code: 'custom', message: 'A green decision requires independently authenticated complete admission provenance' });
  if (decision.status !== 'blocked' && (decision.candidate.sourceState !== 'committed-clean' || decision.baseline.sourceState !== 'committed-clean'
    || decision.candidate.sourceSha === null || decision.baseline.sourceSha === null)) ctx.addIssue({ code: 'custom', message: 'Uncommitted offline snapshot evidence cannot authorize a release decision' });
  if (decision.status !== 'blocked' && decision.gates.some(gate => gate.status === 'unknown' || gate.status === 'failed')
    || decision.status === 'passed' && decision.gates.some(gate => gate.status !== 'passed')
    || decision.status === 'exception-approved' && (!decision.exceptions.length || !decision.gates.some(gate => gate.status === 'exception-approved'))) {
    ctx.addIssue({ code: 'custom', message: 'Unknown/failing/excepted evidence cannot be serialized as an unconditional green decision' });
  }
});
export type ReleaseEvaluationDecision = z.infer<typeof ReleaseEvaluationDecisionSchema>;

/** No caller-supplied passed flags: gates are recomputed from complete archived review and source-approved policy pins. */
export function decideRelease(input: unknown, review: EvaluationReview, approvedInput: unknown, now = new Date()): ReleaseEvaluationDecision {
  const request = ReleaseDecisionRequestSchema.parse(input), approvals = PolicyApprovalRegistrySchema.parse(approvedInput), policy = request.policy;
  const policySha256 = evaluationDigest(policy), gates: ReleaseGate[] = [], time = now.getTime();
  if (!Number.isFinite(time)) throw new Error('Invalid release decision clock');
  const approval = approvals.policies.find(entry => entry.policySha256 === policySha256 && entry.experimentSha256 === review.experimentSha256);
  const add = (gateId: string, passed: boolean, reasons: string[], evidence: unknown, unknown = false) => {
    gates.push({ gateId, status: passed ? 'passed' : unknown ? 'unknown' : 'failed', reasons: passed ? [] : reasons, evidence });
  };
  const revoked = new Set(approvals.revocations.map(entry => entry.digest));
  const exactEvidence = review.attempts.map(attempt => ({ manifestSha256: attempt.manifestSha256, gradeSha256: attempt.gradeSha256 }))
    .sort((a, b) => String(a.manifestSha256).localeCompare(String(b.manifestSha256), 'en'));
  const approvedEvidence = approval?.evidence.slice().sort((a, b) => a.manifestSha256.localeCompare(b.manifestSha256, 'en'));
  add('policy.approval', !!approval && approval.reviewerIds.includes(request.reviewerId)
    && approval.decisionRequestSha256s.includes(evaluationDigest(request)) && !revoked.has(evaluationDigest(request)) && !revoked.has(policySha256)
    && Date.parse(approval.expiresAt) > time && Date.parse(approval.approvedAt) <= Date.parse(review.experiment.preregisteredAt),
  ['Missing, revoked, expired or unauthorized source-controlled policy/reviewer registration'], { policySha256, approval: approval ?? null }, !approval);
  add('identity.exact', evaluationDigest(request.candidate) === evaluationDigest(review.experiment.candidate)
    && evaluationDigest(request.baseline) === evaluationDigest(review.experiment.baseline)
    && policy.experimentSha256 === review.experimentSha256 && evaluationDigest(policy.dataset) === evaluationDigest(review.dataset),
  ['Exact candidate/baseline/experiment/dataset identity mismatch'], { candidate: request.candidate, baseline: request.baseline });
  add('identity.committed-source', review.experiment.candidate.sourceState === 'committed-clean' && review.experiment.baseline.sourceState === 'committed-clean'
    && review.experiment.candidate.sourceSha !== null && review.experiment.baseline.sourceSha !== null,
  ['Offline dirty snapshots can support an honest signed benchmark comparison, but cannot authorize desktop draft/publication or a committed release candidate'],
  { candidate: review.experiment.candidate, baseline: review.experiment.baseline });
  const registeredCells = new Map(review.experiment.cells.map(cell => [cell.cellId, cell]));
  add('protocol.arm-binding', review.attempts.length > 0 && review.attempts.every(attempt => {
    const cell = attempt.cellId === null ? undefined : registeredCells.get(attempt.cellId);
    return !!cell && attempt.arm === cell.arm && attempt.arm === review.experiment[cell.variant].arm;
  }), ['Actual signed execution arm must match its exact registered cell and baseline/candidate identity; arm labels cannot be swapped'],
  review.attempts.map(attempt => ({ attemptId: attempt.attemptId, cellId: attempt.cellId, arm: attempt.arm })));
  const ledger = review.ledger;
  add('evidence.denominator', !!approval && ledger.status === 'verified' && review.denominator.basis === 'signed-closed-ledger'
    && ledger.ledgerId === approval.ledgerId && ledger.closureSha256 === approval.ledgerClosureSha256
    && ledger.missingArchiveAdmissionIds.length === 0 && ledger.denominator.pendingAdmissions === 0 && ledger.denominator.unsealedAdmissions === 0
    && ledger.denominator.allAdmissions === review.attempts.length && review.denominator.allAdmissions === ledger.denominator.allAdmissions
    && ledger.admissions.every(entry => review.attempts.filter(attempt => attempt.admissionId === entry.admissionId && attempt.attemptId === entry.attemptId
      && attempt.cellId === entry.cellId && attempt.arm === entry.arm && attempt.manifestSha256 === entry.manifestSha256 && attempt.gradeSha256 === entry.gradeSha256
      && attempt.capture.attestationSha256 === entry.captureAttestationSha256).length === 1)
    && evaluationDigest(exactEvidence) === evaluationDigest(approvedEvidence) && review.attempts.length >= 2
    && new Set(review.attempts.map(attempt => attempt.admissionId)).size === review.attempts.length,
  ['Every independently signed admission, including pending/unsealed failures and retries, must appear; an approved submitted hash list is not a denominator'],
  { ledger, submittedArchives: review.attempts.length }, true);
  add('evidence.capture-authenticity', !!approval && ledger.status === 'verified'
    && ledger.publicKeySha256 === approval.captureKey.publicKeySha256 && !revoked.has(approval.captureKey.publicKeySha256)
    && !!ledger.closureSha256 && !revoked.has(ledger.closureSha256) && review.attempts.length > 0
    && review.attempts.every(attempt => attempt.capture.status === 'verified' && attempt.capture.publicKeySha256 === approval.captureKey.publicKeySha256
      && !!attempt.capture.attestationSha256 && !!attempt.capture.populationProofSha256),
  ['Host provenance requires the independently preregistered public-key signature and inspected whole-population proof; producer/counter claims and hashes alone are insufficient'],
  { keySha256: ledger.publicKeySha256, ledgerId: ledger.ledgerId, closureSha256: ledger.closureSha256 }, true);
  add('evidence.validity', review.attempts.length > 0 && review.attempts.every(attempt => attempt.releaseEligible && attempt.producer === 'host-runner'
    && !!attempt.manifestSha256 && !!attempt.gradeSha256 && !revoked.has(attempt.manifestSha256) && !revoked.has(attempt.gradeSha256)
    && attempt.versions.evaluatorSha256 === policy.evaluatorSha256 && attempt.versions.calibrationSha256 === policy.calibrationSha256
    && attempt.capture.gradingInfrastructureComplete === true && attempt.capture.inferenceObserved === true
    && attempt.missingEvidence.length === 0), ['Required evidence is missing, synthetic/controlled/imported, uncalibrated, inapplicable or revoked'],
  review.attempts.map(attempt => ({ attemptId: attempt.attemptId, missing: attempt.missingEvidence })), true);
  const preregTime = Date.parse(review.experiment.preregisteredAt);
  const preregistered = approvals.preregistrations.find(entry => entry.policySha256 === policySha256 && entry.experimentSha256 === review.experimentSha256);
  add('policy.preregistered', !!preregistered && !!approval && approval.reviewerIds.includes(preregistered.approvedBy)
    && preregistered.ledgerId === approval.ledgerId && evaluationDigest(preregistered.captureKey) === evaluationDigest(approval.captureKey)
    && Date.parse(policy.approvedAt) <= Date.parse(policy.preregisteredAt)
    && Date.parse(policy.preregisteredAt) <= preregTime && review.attempts.every(attempt => !!attempt.admittedAt
      && Date.parse(attempt.admittedAt) >= preregTime && Date.parse(attempt.admittedAt) >= Date.parse(preregistered.approvedAt)),
  ['Threshold policy and complete experiment must be approved before any candidate/baseline admission'], { approvedAt: policy.approvedAt, preregisteredAt: policy.preregisteredAt, experimentPreregisteredAt: review.experiment.preregisteredAt });
  add('evidence.freshness', Date.parse(policy.expiresAt) > time && Date.parse(request.expiresAt) > time
    && Date.parse(request.createdAt) <= time && Date.parse(request.createdAt) <= Date.parse(request.expiresAt)
    && Date.parse(request.expiresAt) <= Date.parse(policy.expiresAt) && Date.parse(review.createdAt) <= time
    && !!ledger.closedAt && Date.parse(ledger.closedAt) <= time && Date.parse(ledger.closedAt) <= Date.parse(review.createdAt)
    && review.attempts.every(attempt => !!attempt.sealedAt && Date.parse(attempt.sealedAt) <= time
      && time - Date.parse(attempt.sealedAt) <= policy.maximumEvidenceAgeHours * 3_600_000),
  ['Required policy/decision/review/attempt evidence is expired, stale, missing or future-dated'], { now: now.toISOString(), expiresAt: request.expiresAt }, true);
  add('comparison.paired', review.comparable && review.coverage.missingCells.length === 0 && review.coverage.duplicateCells.length === 0
    && review.coverage.unexpectedCells.length === 0 && review.coverage.completePairs === review.coverage.requiredPairs
    && review.coverage.completePairs >= policy.minimumPairs, ['Required paired identities, stages, independent fixtures, complete cells or minimum pairs are missing'], { coverage: review.coverage, issues: review.comparabilityIssues }, true);
  const variantAttempts = (variant: 'baseline' | 'candidate') => review.attempts.filter(attempt => review.experiment.cells.some(cell => cell.variant === variant && cell.cellId === attempt.cellId));
  const candidate = variantAttempts('candidate'), baseline = variantAttempts('baseline');
  const qualitySuccess = (attempt: EvaluationReview['attempts'][number]) => attempt.modelQualitySuccess && attempt.releaseEligible
    && attempt.producer === 'host-runner' && attempt.execution.status === 'succeeded' && !attempt.execution.failure
    && attempt.capture.status === 'verified' && attempt.capture.gradingInfrastructureComplete === true && attempt.capture.inferenceObserved === true
    && attempt.functional.some(criterion => criterion.required) && attempt.safety.some(criterion => criterion.required)
    && [...attempt.functional, ...attempt.safety].every(criterion => !criterion.required || criterion.status === 'passed' && criterion.applicability === 'applicable');
  const successRate = candidate.length ? candidate.filter(qualitySuccess).length / candidate.length : null;
  add('quality.absolute', successRate !== null && successRate >= policy.absoluteSuccessRate, ['Candidate all-admission success rate is below the preregistered absolute floor'], { successRate, minimum: policy.absoluteSuccessRate, admissions: candidate.length }, successRate === null);
  const cohortResults = policy.requiredCohorts.map(cohort => {
    const cells = review.experiment.cells.filter(cell => cell.cohort === cohort.cohort && cell.variant === 'candidate');
    const attempts = candidate.filter(attempt => cells.some(cell => cell.cellId === attempt.cellId));
    return { ...cohort, pairs: cells.length, admissions: attempts.length, successRate: attempts.length ? attempts.filter(qualitySuccess).length / attempts.length : null,
      complete: cells.length >= cohort.minimumPairs && cells.every(cell => attempts.filter(attempt => attempt.cellId === cell.cellId).length === 1) };
  });
  add('coverage.cohorts', cohortResults.every(cohort => cohort.complete && cohort.successRate !== null && cohort.successRate >= cohort.absoluteSuccessRate),
    ['Required cohort coverage, complete paired sample or absolute quality floor is missing'], cohortResults, true);
  const byTask = new Map<string, number[]>();
  for (const pairId of new Set(review.experiment.cells.map(cell => cell.pairId))) {
    const cells = review.experiment.cells.filter(cell => cell.pairId === pairId), before = cells.find(cell => cell.variant === 'baseline'), after = cells.find(cell => cell.variant === 'candidate');
    const b = baseline.filter(attempt => attempt.cellId === before?.cellId), c = candidate.filter(attempt => attempt.cellId === after?.cellId);
    if (!before || !after || b.length !== 1 || c.length !== 1) continue;
    const values = byTask.get(before.taskId) ?? []; values.push(Number(qualitySuccess(c[0]!)) - Number(qualitySuccess(b[0]!))); byTask.set(before.taskId, values);
  }
  const clusters = [...byTask.values()].map(values => values.reduce((sum, value) => sum + value, 0) / values.length);
  const mean = clusters.length ? clusters.reduce((sum, value) => sum + value, 0) / clusters.length : null;
  // Paired outcome differences lie in [-1,1]. Repeats are clustered by task, never treated as independent tasks.
  const lower95 = mean === null ? null : mean - Math.sqrt(2 * Math.log(20) / clusters.length);
  add('quality.noninferiority', lower95 !== null && clusters.length >= policy.minimumTaskClusters && lower95 >= -policy.noninferiorityMargin,
    ['Preregistered one-sided 95% task-cluster noninferiority bound is not established'], { method: policy.confidenceMethod, taskClusters: clusters.length, meanDelta: mean, lower95, margin: policy.noninferiorityMargin }, lower95 === null || clusters.length < policy.minimumTaskClusters);
  const safety = review.attempts.flatMap(attempt => attempt.safety.map(criterion => ({ attemptId: attempt.attemptId, ...criterion })));
  const critical = review.attempts.flatMap(attempt => policy.criticalCriterionIds.map(id => ({ attemptId: attempt.attemptId, id,
    check: [...attempt.safety, ...attempt.functional].find(criterion => criterion.criterionId === id && criterion.required) ?? null })));
  add('safety.boundaries', review.attempts.length > 0 && safety.length > 0 && safety.every(check => check.status === 'passed' && check.applicability === 'applicable')
    && critical.every(item => item.check?.status === 'passed' && item.check.applicability === 'applicable'),
  ['Every safety and critical permission/revision/replay/secrets/license criterion must independently pass; never waivable'], { safety, critical }, true);
  const knownCosts = review.attempts.filter(attempt => attempt.cost.complete && attempt.cost.usd !== null && attempt.cost.basis !== null);
  add('cost.coverage', review.attempts.length > 0 && knownCosts.length === review.attempts.length && new Set(knownCosts.map(attempt => attempt.cost.basis)).size === 1,
    ['Complete same-basis cost evidence for every admission including failures is required; missing usage is not zero or released reservation'], { knownAdmissions: knownCosts.length, allAdmissions: review.attempts.length, requiredFraction: policy.requiredCostCoverage, bases: [...new Set(knownCosts.map(attempt => attempt.cost.basis))] }, true);
  const candidateCosts = candidate.filter(attempt => attempt.cost.complete && attempt.cost.usd !== null && attempt.cost.basis !== null);
  const candidateCost = candidateCosts.reduce((sum, attempt) => sum + attempt.cost.usd!, 0), candidateSuccesses = candidate.filter(qualitySuccess).length;
  const costBases = new Set(candidateCosts.map(attempt => attempt.cost.basis));
  const meanCost = candidate.length > 0 && candidateCosts.length === candidate.length && costBases.size === 1 ? candidateCost / candidate.length : null;
  const failedCosts = candidateCosts.filter(attempt => !qualitySuccess(attempt)), failedKnownSubtotal = failedCosts.reduce((sum, attempt) => sum + attempt.cost.usd!, 0);
  add('cost.bound', meanCost !== null && meanCost <= policy.maximumCostPerAdmissionUsd,
    ['Candidate all-admission average cost exceeds the preregistered bound'], { allAdmissionMeanUsd: meanCost, maximum: policy.maximumCostPerAdmissionUsd,
      costPerSuccessUsd: meanCost !== null && candidateSuccesses > 0 ? candidateCost / candidateSuccesses : null,
      failedAttemptSubtotalUsd: costBases.size === 1 && failedCosts.length === candidate.length - candidateSuccesses || candidate.length === candidateSuccesses ? failedKnownSubtotal : null,
      failedCostCoverage: { knownAdmissions: failedCosts.length, allFailedAdmissions: candidate.length - candidateSuccesses },
      knownFailedAttemptSubtotalUsd: costBases.size === 1 && failedCosts.length > 0 || candidate.length === candidateSuccesses ? failedKnownSubtotal : null }, meanCost === null);
  const times = candidate.map(attempt => attempt.timeMs).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const p95 = candidate.length > 0 && times.length === candidate.length ? times[Math.ceil(times.length * 0.95) - 1]! : null;
  add('latency.coverage', candidate.length > 0 && times.length === candidate.length, ['Latency must cover all candidate admissions, including failures'], { knownAdmissions: times.length, allAdmissions: candidate.length }, true);
  add('latency.bound', p95 !== null && p95 <= policy.maximumP95LatencyMs, ['Candidate latency exceeds the preregistered workload-specific p95 bound'], { p95Ms: p95, maximum: policy.maximumP95LatencyMs }, p95 === null);
  if (request.exceptions.length > policy.exceptions.maximumCount || new Set(request.exceptions.map(exception => exception.gateId)).size !== request.exceptions.length) throw new Error('Exception count exceeds preregistered scope or duplicates a gate');
  for (const exception of request.exceptions) {
    const gate = gates.find(item => item.gateId === exception.gateId);
    if (!gate || gate.status !== 'failed' || !policy.exceptions.allowedGateIds.includes(exception.gateId)
      || !approval?.exceptionApproverIds.includes(exception.approvedBy) || !approval.exceptionSha256s.includes(evaluationDigest(exception))
      || revoked.has(evaluationDigest(exception)) || exception.policySha256 !== policySha256
      || evaluationDigest(exception.candidate) !== evaluationDigest(request.candidate) || Date.parse(exception.approvedAt) > time
      || Date.parse(exception.expiresAt) <= time || Date.parse(exception.expiresAt) > Date.parse(request.expiresAt)
      || Date.parse(exception.expiresAt) - Date.parse(exception.approvedAt) > policy.exceptions.maximumLifetimeHours * 3_600_000
      || Date.parse(exception.expiresAt) <= Date.parse(exception.approvedAt) || exception.evidence.some(digest => revoked.has(digest))) {
      throw new Error('Impossible, unapproved, unknown/missing-evidence or out-of-scope exception; source/safety/license cannot be waived');
    }
    gate.status = 'exception-approved'; gate.reasons.push(`Bounded human exception: ${exception.exceptionId}`);
  }
  const blocked = gates.some(gate => gate.status === 'failed' || gate.status === 'unknown');
  return ReleaseEvaluationDecisionSchema.parse({ schemaVersion: 1, kind: 'release-evaluation-decision', decisionId: request.decisionId, reviewerId: request.reviewerId,
    createdAt: request.createdAt, expiresAt: new Date(Math.min(Date.parse(request.expiresAt), ...request.exceptions.map(exception => Date.parse(exception.expiresAt)))).toISOString(), candidate: request.candidate, baseline: request.baseline,
    artifactSetSha256: request.artifactSetSha256, policyId: policy.policyId, policyVersion: policy.version, policySha256,
    experimentId: review.experiment.experimentId, experimentSha256: review.experimentSha256,
    evaluatorSha256: policy.evaluatorSha256, calibrationSha256: policy.calibrationSha256,
    ledgerId: ledger.ledgerId, ledgerClosureSha256: ledger.closureSha256, capturePublicKeySha256: ledger.publicKeySha256,
    reviewSha256: evaluationDigest(review), dataset: review.dataset, status: blocked ? 'blocked' : request.exceptions.length ? 'exception-approved' : 'passed',
    gates, exceptions: request.exceptions, authority: 'evaluation-only-no-publication-authority' });
}
