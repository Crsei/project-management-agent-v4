import { z } from 'zod';
import { safeEvidenceBytes, safeEvidenceJson, verifyEvidenceArchive } from './archive.ts';
import { readGradeRun } from './regrade.ts';
import { validateDatasetVersion, assertLineageActive, isCanonicalDatasetMember } from './dataset.ts';
import { EvaluatorVersionSchema } from '../schemas/evaluation.ts';
import type { Arm } from '../schemas/types.ts';
import { assertEvaluatorIdentity, bytesHash, evidenceHash } from './evaluator.ts';
import { calibrationMutations, CALIBRATION_EXPECTED_FAILURES } from '../calibration/cases.ts';
import { hasInspectedCriterionEvidence, readClosedReviewLedger, summarizeReviewLedger, unavailableLedgerAttempt, verifySignedAttemptCapture, type AttemptCaptureReview, type ReviewLedgerSummary, type TrustedReviewOptions } from './review-provenance.ts';

import { DatasetReferenceSchema, Digest, ExperimentSchema, Identifier, Instant, evaluationDigest, type EvaluationExperiment, type EvaluationIdentity } from './review-schema.ts';
export { CaptureKeySchema, DatasetReferenceSchema, Digest, EvaluationIdentitySchema, ExperimentControlsSchema, ExperimentSchema, Identifier, Instant, evaluationDigest } from './review-schema.ts';
export type { EvaluationExperiment, EvaluationIdentity } from './review-schema.ts';
export const ReviewRequestSchema = z.object({
  schemaVersion: z.literal(1), reviewId: Identifier, reviewerId: Identifier, createdAt: Instant,
  experiment: ExperimentSchema, ledgerRoot: z.string().min(1).optional(),
  archives: z.array(z.object({ archiveRoot: z.string().min(1), manifestSha256: Digest, gradeId: Identifier,
    gradePath: z.string().min(1), gradeSha256: Digest, cellId: Identifier,
    evaluatorPath: z.string().min(1).optional(), calibrationPath: z.string().min(1).optional(), captureAttestationPath: z.string().min(1).optional() }).strict()),
  rootCauses: z.array(z.object({ attemptId: Identifier, category: Identifier, certainty: z.enum(['confirmed', 'inferred', 'unknown']),
    evidence: z.array(z.string()).min(1), reviewerId: Identifier }).strict()).default([]),
}).strict();
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;
export type CriterionReview = { criterionId: string; required: boolean; status: string; reason: string | null;
  evidence: string[]; taskVersion: string | null; requirementRevision: string | null; applicability: 'applicable' | 'unknown' | 'not-applicable' };
export type AttemptReview = {
  admissionId: string | null; attemptId: string; runId: string; cellId: string | null; arm: Arm | null; producer: string;
  manifestSha256: string | null; gradeSha256: string | null; gradeId: string | null;
  versions: Record<string, unknown>; admittedAt: string | null; sealedAt: string | null;
  execution: { status: string; failure: unknown; originalStatus?: string; originalScoredFailure?: unknown }; functional: CriterionReview[]; safety: CriterionReview[];
  stageEvents: unknown[]; requirementRevisions: string[]; missingEvidence: string[];
  rootCause: { category: string; certainty: 'confirmed' | 'inferred' | 'unknown'; evidence: string[]; reviewerId: string | null };
  releaseEligible: boolean; modelQualitySuccess: boolean;
  capture: AttemptCaptureReview;
  cost: { usd: number | null; complete: boolean; basis: string | null }; timeMs: number | null;
  fixtureId: string | null; environmentHash: string | null; fixtureSemanticHash: string | null; effectiveModelSettingsHash: string | null;
};
export type EvaluationReview = {
  schemaVersion: 1; kind: 'evaluation-review'; reviewId: string; reviewerId: string; createdAt: string;
  experiment: EvaluationExperiment; experimentSha256: string; dataset: z.infer<typeof DatasetReferenceSchema>;
  lineageSourceIds: string[]; attempts: AttemptReview[]; ledger: ReviewLedgerSummary;
  denominator: { basis: 'signed-closed-ledger' | 'submitted-claims-only'; allAdmissions: number; modelQualitySuccesses: number; evaluable: number; missingOrIneligible: number; successRate: number | null };
  coverage: { missingCells: string[]; duplicateCells: string[]; unexpectedCells: string[]; completePairs: number; requiredPairs: number };
  comparable: boolean; comparabilityIssues: string[];
};

export { reviewLegacyRun } from './review-legacy.ts';

/** Reporting reads sealed inputs and immutable grades only. It never regrades or executes an agent. */
export async function createEvaluationReview(input: unknown, registryRoot: string, authority?: TrustedReviewOptions): Promise<EvaluationReview> {
  const request = ReviewRequestSchema.parse(input), experiment = request.experiment;
  const dataset = await validateDatasetVersion({ registryRoot, datasetId: experiment.dataset.datasetId, version: experiment.dataset.version });
  if (dataset.digest !== experiment.dataset.digest) throw new Error('Exact dataset digest mismatch');
  await assertLineageActive(registryRoot, dataset.lineageSourceIds);
  const attempts: AttemptReview[] = [], issues: string[] = [], admissions = new Set<string>();
  const ledger = await readClosedReviewLedger(request, authority);
  if (!ledger) issues.push('Missing independently preregistered signing authority or complete signed admission ledger');
  for (const reference of request.archives) {
    const archive = await verifyEvidenceArchive(reference.archiveRoot, reference.manifestSha256);
    if (archive.legacy || !archive.admission || !archive.attempt || !archive.manifest || !archive.manifestSha256) throw new Error('Versioned review requires a sealed current archive; use legacy report for historical evidence');
    const { admission, attempt } = archive;
    if (admissions.has(admission.admissionId)) throw new Error('Duplicate admission would corrupt the all-attempt denominator');
    admissions.add(admission.admissionId);
    const grade = await readGradeRun(archive, reference.gradePath, reference.gradeSha256);
    if (grade.gradeId !== reference.gradeId || grade.manifestSha256 !== archive.manifestSha256 || grade.attemptId !== attempt.attemptId) throw new Error('Immutable grade identity or archive/attempt binding mismatch');
    const cell = experiment.cells.find(item => item.cellId === reference.cellId), missing: string[] = [];
    const ledgerEntry = ledger?.entries.find(entry => entry.admissionId === admission.admissionId);
    const member = ledgerEntry ? dataset.members.find(item => item.memberId === ledgerEntry.binding.memberId && item.memberVersion === ledgerEntry.binding.memberVersion) : undefined;
    if (!ledgerEntry) missing.push('Archive is not authenticated by the independently preregistered complete admission ledger');
    else {
      const admittedFile = archive.manifest.files.find(file => file.path === 'admission.json');
      if (ledgerEntry.attemptId !== attempt.attemptId || ledgerEntry.runId !== admission.runId || ledgerEntry.binding.cellId !== reference.cellId
        || ledgerEntry.admissionSha256 !== admittedFile?.sha256 || evaluationDigest(ledgerEntry.admission) !== evaluationDigest(admission)
        || !member || member.taskId !== admission.taskId || member.taskVersion !== admission.taskVersion) throw new Error('Signed admission/cell/dataset-member identity differs from the actual archive');
      if (!ledgerEntry.seal || ledgerEntry.seal.manifestSha256 !== archive.manifestSha256 || ledgerEntry.seal.gradeSha256 !== reference.gradeSha256
        || ledgerEntry.seal.status !== attempt.status) missing.push('Archive/grade/status does not match the signed terminal ledger seal');
    }
    if (member && !isCanonicalDatasetMember(member)) missing.push('Frozen reproduction labels are replay-only, not normative fresh model-quality task acceptance');
    const verifiedCapture = await verifySignedAttemptCapture({ archive, grade, gradeSha256: reference.gradeSha256,
      ...(reference.captureAttestationPath ? { captureAttestationPath: reference.captureAttestationPath } : {}),
      ...(ledgerEntry ? { ledgerEntry } : {}), ...(authority ? { authority } : {}), datasetMember: member ?? null });
    const capture = verifiedCapture.capture;
    if (capture.status !== 'verified') missing.push('Original host capture has no independently preregistered public-key signature');
    if (capture.gradingInfrastructureComplete !== true) missing.push('Original independent grading infrastructure did not establish complete inspected outcomes');
    if (capture.inferenceObserved !== true) missing.push('The authenticated admission did not establish observed model inference');
    if (!verifiedCapture.populations) missing.push('Authenticated whole inspected-population commitments are missing');
    const evaluator = reference.evaluatorPath ? EvaluatorVersionSchema.parse(await safeEvidenceJson(reference.evaluatorPath)) : archive.evaluator;
    if (evaluator) assertEvaluatorIdentity(evaluator);
    if (!evaluator || evaluator.sha256 !== grade.evaluatorSha256
      || !evaluator.applicableTasks.some(task => task.taskId === admission.taskId && task.taskVersion === admission.taskVersion)) missing.push('Grade evaluator descriptor is missing, mismatched or inapplicable');
    if (!evaluator?.runtime.codeImageDigest) missing.push('Evaluator code sandbox image has no immutable digest');
    if (evaluator) for (const declared of evaluator.criteria.filter(item => item.taskId === admission.taskId && item.required)) {
      if (!grade.criteria.some(item => item.criterionId === declared.criterionId && item.required)) missing.push(`Evaluator required obligation omitted: ${declared.criterionId}`);
    }
    if (!reference.calibrationPath || !evaluator || !grade.calibrationSha256) missing.push('Recoverable exact evaluator calibration material is missing');
    else {
      const bytes = await safeEvidenceBytes(reference.calibrationPath);
      if (bytesHash(bytes) !== grade.calibrationSha256 || evaluator.calibrationSha256 !== grade.calibrationSha256) throw new Error('Calibration material digest differs from grade/evaluator identity');
      let calibrationInput: unknown;
      try { calibrationInput = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new Error('Malformed calibration JSON (input withheld)'); }
      const calibration = z.object({ kind: z.literal('grader-calibration'), success: z.literal(true), evaluatorSha256: Digest,
        calibrationDefinitionSha256: Digest, infrastructureErrors: z.array(z.unknown()).length(0),
        codeExecution: z.object({ realSandboxCalls: z.number().int().positive() }).passthrough(),
        cases: z.array(z.object({ taskId: z.string().min(1), name: z.string().min(1), expectedFailedCheck: z.string().nullable(),
          passed: z.literal(true), exercised: z.literal(true), intendedFailureObserved: z.literal(true) }).passthrough()).min(1),
      }).passthrough().parse(calibrationInput);
      const { sha256, ...uncalibrated } = evaluator;
      if (sha256 !== grade.evaluatorSha256 || calibration.evaluatorSha256 !== evidenceHash({ ...uncalibrated, calibrationSha256: null })
        || calibration.calibrationDefinitionSha256 !== evaluator.calibrationDefinitionSha256) throw new Error('Calibration code/dependency/definition applicability differs from evaluator');
      const expectedCases = evaluator.applicableTasks.flatMap(task => ['correct-reference', ...calibrationMutations(task.taskId).map(item => item.name)].map(name => ({ taskId: task.taskId, name })));
      if (calibration.cases.length !== expectedCases.length || new Set(calibration.cases.map(item => `${item.taskId}/${item.name}`)).size !== expectedCases.length
        || expectedCases.some(expected => !calibration.cases.some(actual => actual.taskId === expected.taskId && actual.name === expected.name
          && actual.expectedFailedCheck === (expected.name === 'correct-reference' ? null : CALIBRATION_EXPECTED_FAILURES[expected.taskId]?.[expected.name])))) throw new Error('Calibration omits independent positive/targeted-negative cases or uses inapplicable criterion labels');
    }
    if (!cell) issues.push(`Unexpected cell: ${reference.cellId}`);
    if (cell && (admission.taskId !== cell.taskId || admission.taskVersion !== cell.taskVersion)) missing.push('Task or task-version differs from preregistered cell');
    if (evaluationDigest(admission.dataset) !== evaluationDigest({ datasetId: experiment.dataset.datasetId, version: experiment.dataset.version, sha256: experiment.dataset.digest })) missing.push('Admission dataset identity differs');
    const identity = cell ? experiment[cell.variant] : null;
    if (identity && Object.entries(admission.versions).some(([key, value]) => !(key === 'productSha256' && value === null)
      && value !== identity[key as keyof EvaluationIdentity])) missing.push('Declared product/harness/model/tool versions differ from exact experiment variant');
    if (!identity || !attempt.actualVersions.productSha256 || attempt.actualVersions.productSha256 !== identity.productSha256) missing.push('Actual frozen product bytes are missing or differ from the candidate/baseline identity');
    if (Date.parse(admission.admittedAt) < Date.parse(experiment.preregisteredAt)) missing.push('Admission predates preregistration');
    if (!attempt.stageEvents.length) missing.push('No host-captured execution-stage evidence');
    if (Date.parse(grade.createdAt) < Date.parse(attempt.sealedAt) || Date.parse(grade.createdAt) > Date.parse(request.createdAt)) missing.push('Grade creation time is outside the sealed-at/review interval');
    const criterion = (entry: typeof grade.criteria[number]): CriterionReview => {
      const applicable = entry.taskVersion === admission.taskVersion && (entry.requirementRevision === null || attempt.requirementRevisions.includes(entry.requirementRevision));
      if (entry.required && (!applicable || entry.status === 'not-evaluable' || entry.status === 'not-applicable')) missing.push(`Required criterion unavailable or inapplicable: ${entry.criterionId}`);
      if (!hasInspectedCriterionEvidence(entry, verifiedCapture.populations)) missing.push(`Required criterion lacks artifact or authenticated inspected-population proof: ${entry.criterionId}`);
      return { ...entry, reason: entry.reason ?? null, applicability: entry.status === 'not-applicable' ? 'not-applicable' : applicable ? 'applicable' : 'unknown' };
    };
    const criteria = grade.criteria.map(criterion);
    if (cell) {
      for (const id of cell.requiredCriterionIds) if (!criteria.some(item => item.criterionId === id && item.required && item.applicability === 'applicable' && ['passed', 'failed'].includes(item.status))) missing.push(`Missing required criterion: ${id}`);
      for (const revision of cell.requiredRequirementRevisions) if (!attempt.requirementRevisions.includes(revision)) missing.push(`Requirement revision was not delivered: ${revision}`);
    }
    if (!criteria.some(item => item.required && !item.criterionId.startsWith('safety.'))) missing.push('No required functional criteria');
    if (!criteria.some(item => item.required && item.criterionId.startsWith('safety.'))) missing.push('No required safety criteria');
    if (admission.producer !== 'host-runner') missing.push('Controlled/synthetic/imported producer is not model-quality evidence');
    // Eligibility authenticates admissible original evidence; a complete functional failure may still be eligible negative evidence.
    if (grade.status === 'not-evaluable' || !grade.releaseEligible) missing.push('Grade is partial, replay-only or lacks eligible original host evidence');
    if (!grade.calibrationSha256) missing.push('Missing calibration identity');
    const rootCause = request.rootCauses.find(item => item.attemptId === attempt.attemptId);
    const run = archive.result;
    if (!run || run.arm !== cell?.arm || run.arm !== identity?.arm || admission.arm !== run.arm) missing.push('Actual sealed execution arm differs from the signed admission or preregistered cell/variant');
    if (!run || (run.usage.modelCalls ?? 0) <= 0 || (run.observations?.providerRequests ?? 0) <= 0
      || !run.reproducibility.effectiveModelSettingsHash) missing.push('Actual host-observed model requests and effective model configuration are missing');
    const environment = run?.study?.environmentEvidence;
    const commonEnvironment = environment ? Object.fromEntries(Object.entries(environment).filter(([key]) => !['sourceHash', 'sourceFiles', 'sourceFileCount'].includes(key))) : null;
    const environmentHash = commonEnvironment ? evaluationDigest(commonEnvironment) : run?.reproducibility.environmentHash ?? null;
    const controls = cell?.controls;
    if (!run || !controls || environmentHash !== controls.environmentSha256 || run.reproducibility.budgetHash !== controls.budgetSha256
      || run.reproducibility.permissionsHash !== controls.permissionsSha256 || run.reproducibility.fixtureSemanticHash !== controls.fixtureSemanticSha256
      || run.fixtureVersion !== controls.fixtureVersion || run.reproducibility.controlTransport !== controls.controlTransport) missing.push('Actual environment/budget/permissions/fixture/transport differ from preregistered common controls');
    const costCoverage = run?.observations?.usageCoverage.costUsd;
    const eligible = missing.length === 0;
    attempts.push({
      admissionId: admission.admissionId, attemptId: attempt.attemptId, runId: admission.runId, cellId: reference.cellId, arm: run?.arm ?? admission.arm ?? null,
      producer: admission.producer, manifestSha256: archive.manifestSha256, gradeSha256: reference.gradeSha256, gradeId: grade.gradeId,
      versions: { ...admission.versions, taskVersion: admission.taskVersion, fixtureVersion: admission.fixtureVersion,
        evaluatorSha256: grade.evaluatorSha256, calibrationSha256: grade.calibrationSha256, dataset: admission.dataset,
        evaluatorCodeSha256: evaluator?.codeSha256 ?? null, evaluatorDependencySha256: evaluator?.dependencySha256 ?? null,
        calibrationDefinitionSha256: evaluator?.calibrationDefinitionSha256 ?? null, evaluatorRuntime: evaluator?.runtime ?? null,
        actualProductSha256: attempt.actualVersions.productSha256, actualCodeImageDigest: attempt.actualVersions.codeImageDigest,
        resultCanonicalSha256: evaluationDigest(archive.result) },
      admittedAt: admission.admittedAt, sealedAt: attempt.sealedAt, execution: {
        status: attempt.executionFailure || ['interrupted', 'incomplete'].includes(attempt.status) ? attempt.status : 'succeeded',
        failure: attempt.executionFailure, originalStatus: attempt.status, originalScoredFailure: attempt.failure },
      functional: criteria.filter(item => !item.criterionId.startsWith('safety.')), safety: criteria.filter(item => item.criterionId.startsWith('safety.')),
      stageEvents: attempt.stageEvents, requirementRevisions: attempt.requirementRevisions, missingEvidence: missing,
      rootCause: rootCause ?? { category: 'unknown', certainty: 'unknown', evidence: [], reviewerId: null }, releaseEligible: eligible,
      capture,
      modelQualitySuccess: eligible && !['incomplete', 'interrupted'].includes(attempt.status) && !attempt.executionFailure && grade.status === 'passed'
        && criteria.some(item => item.required) && criteria.every(item => !item.required || item.status === 'passed' && item.applicability === 'applicable'),
      cost: { usd: run?.usage.costUsd ?? null, complete: !!run && costCoverage?.complete === true && run.usage.costUsd !== null
        && costCoverage.knownSubtotal === run.usage.costUsd && costCoverage.totalRequests !== null && costCoverage.knownRequests === costCoverage.totalRequests,
        basis: run?.usage.costBasis ?? null }, timeMs: run?.timeMs ?? null,
      fixtureId: run?.reproducibility.fixtureId ?? null, environmentHash,
      fixtureSemanticHash: run?.reproducibility.fixtureSemanticHash ?? null, effectiveModelSettingsHash: run?.reproducibility.effectiveModelSettingsHash ?? null,
    });
  }
  const missingArchiveAdmissionIds: string[] = [];
  if (ledger) for (const entry of ledger.entries) if (!admissions.has(entry.admissionId)) {
    missingArchiveAdmissionIds.push(entry.admissionId);
    attempts.push(unavailableLedgerAttempt(entry));
  }
  const ledgerSummary = summarizeReviewLedger(ledger, authority, missingArchiveAdmissionIds);
  const count = (id: string) => attempts.filter(attempt => attempt.cellId === id).length;
  const coverage = { missingCells: experiment.cells.filter(cell => !count(cell.cellId)).map(cell => cell.cellId),
    duplicateCells: experiment.cells.filter(cell => count(cell.cellId) > 1).map(cell => cell.cellId),
    unexpectedCells: attempts.filter(attempt => !experiment.cells.some(cell => cell.cellId === attempt.cellId)).map(attempt => attempt.cellId!),
    completePairs: 0, requiredPairs: new Set(experiment.cells.map(cell => cell.pairId)).size };
  if (coverage.missingCells.length || coverage.duplicateCells.length || coverage.unexpectedCells.length) issues.push('Missing/duplicate/unregistered cells: all admitted attempts retained, comparison blocked');
  for (const pairId of new Set(experiment.cells.map(cell => cell.pairId))) {
    const cells = experiment.cells.filter(cell => cell.pairId === pairId), pair = cells.map(cell => attempts.filter(attempt => attempt.cellId === cell.cellId));
    if (pair.some(group => group.length !== 1)) continue;
    const [a, b] = pair.map(group => group[0]!);
    let valid = true;
    for (const key of ['environmentHash', 'fixtureSemanticHash', 'effectiveModelSettingsHash'] as const) {
      // A model configuration treatment changes effective model settings by design.
      if (key === 'effectiveModelSettingsHash' && experiment.treatment === 'modelConfigSha256') continue;
      if (!a?.[key] || a[key] === 'unavailable' || a[key] !== b?.[key]) { issues.push(`${pairId}: missing/mismatched ${key}`); valid = false; }
    }
    for (const key of ['evaluatorSha256', 'calibrationSha256', 'taskVersion', 'fixtureVersion']) if (!a?.versions[key] || a.versions[key] !== b?.versions[key]) { issues.push(`${pairId}: missing/mismatched ${key}`); valid = false; }
    if (!a?.fixtureId || a.fixtureId === b?.fixtureId) { issues.push(`${pairId}: independent fixtures missing/reused`); valid = false; }
    const first = cells.findIndex(cell => cell.order === 0), second = cells.findIndex(cell => cell.order === 1);
    if (Date.parse(pair[first]?.[0]?.admittedAt ?? '') > Date.parse(pair[second]?.[0]?.admittedAt ?? '')) { issues.push(`${pairId}: admission order contradicts preregistration`); valid = false; }
    if (valid) coverage.completePairs++;
  }
  for (const attempt of attempts) for (const missing of attempt.missingEvidence) issues.push(`${attempt.attemptId}: ${missing}`);
  if (!attempts.length) issues.push('Empty evidence cannot be green');
  const successes = attempts.filter(attempt => attempt.modelQualitySuccess).length, evaluable = attempts.filter(attempt => attempt.releaseEligible).length;
  const allAdmissions = ledger?.denominator.allAdmissions ?? attempts.length;
  return { schemaVersion: 1, kind: 'evaluation-review', reviewId: request.reviewId, reviewerId: request.reviewerId, createdAt: request.createdAt,
    experiment, experimentSha256: evaluationDigest(experiment), dataset: experiment.dataset, lineageSourceIds: dataset.lineageSourceIds, attempts, ledger: ledgerSummary,
    denominator: { basis: ledger ? 'signed-closed-ledger' : 'submitted-claims-only', allAdmissions, modelQualitySuccesses: successes, evaluable, missingOrIneligible: allAdmissions - evaluable,
      successRate: allAdmissions ? successes / allAdmissions : null }, coverage, comparable: issues.length === 0, comparabilityIssues: [...new Set(issues)] };
}
