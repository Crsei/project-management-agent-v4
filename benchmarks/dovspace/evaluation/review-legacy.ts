import type { RunResult } from '../schemas/types.ts';
import type { AttemptReview, CriterionReview } from './review.ts';

/** Legacy observations retain partial functional proof; failure labels never become a confirmed root cause. */
export function reviewLegacyRun(run: RunResult): AttemptReview {
  const criterion = (check: RunResult['safetyGate']['checks'][number]): CriterionReview => ({ criterionId: check.id,
    required: check.required, status: check.passed ? 'passed' : 'failed', reason: check.reason ?? null, evidence: [...check.evidence],
    taskVersion: run.taskVersion, requirementRevision: null, applicability: 'unknown' });
  const executionFailure = run.failure && ['infrastructure', 'provider', 'budget', 'tool', 'permission', 'interrupted'].includes(run.failure.category) ? run.failure : null;
  return {
    admissionId: null, attemptId: run.runId, runId: run.runId, cellId: null, arm: run.arm, producer: 'legacy-unverified', manifestSha256: null,
    gradeSha256: null, gradeId: null, versions: { taskVersion: run.taskVersion, fixtureVersion: run.fixtureVersion, model: run.model,
      modelConfigSha256: run.reproducibility.modelConfigHash, harnessSha256: null, productSha256: null, evaluatorSha256: null, calibrationSha256: null },
    admittedAt: run.study?.admittedAt ?? null, sealedAt: null,
    execution: { status: executionFailure?.category === 'interrupted' ? 'interrupted' : executionFailure ? 'failed' : 'unknown',
      failure: executionFailure, originalStatus: run.success ? 'passed' : 'failed', originalScoredFailure: run.failure },
    functional: run.phaseResults.flatMap(phase => phase.checks.map(criterion)), safety: run.safetyGate.checks.map(criterion),
    stageEvents: run.phaseResults.map(phase => ({ phaseId: phase.id, evidence: phase.evidence, reachedStageUnknown: true })), requirementRevisions: [],
    missingEvidence: ['Legacy evidence has no immutable admission/archive/grade identity.', 'Historical stage and requirement revision applicability are unknown.',
      'Product, evaluator and calibration versions are unavailable; no release-quality conclusion is authorized.'],
    rootCause: { category: run.failure?.category ?? 'unknown', certainty: 'unknown', evidence: run.failure?.evidence ?? [], reviewerId: null },
    releaseEligible: false, modelQualitySuccess: false,
    capture: { status: 'untrusted', publicKeySha256: null, attestationSha256: null, populationProofSha256: null, gradingInfrastructureComplete: null, inferenceObserved: null },
    cost: { usd: run.usage.costUsd, complete: run.observations?.usageCoverage.costUsd?.complete === true && run.usage.costUsd !== null,
      basis: run.usage.costBasis ?? null }, timeMs: run.timeMs,
    fixtureId: run.reproducibility.fixtureId, environmentHash: run.reproducibility.environmentHash,
    fixtureSemanticHash: run.reproducibility.fixtureSemanticHash, effectiveModelSettingsHash: run.reproducibility.effectiveModelSettingsHash,
  };
}
