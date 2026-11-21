import path from 'node:path';
import { captureDigest, verifyCaptureAttestation, type TrustedCaptureKey } from './capture.ts';
import { verifyClosedExperimentLedger, type ClosedExperimentLedger, type ExperimentLedgerEntry } from './experiment-ledger.ts';
import type { AttemptReview, ReviewRequest } from './review.ts';
import { safeEvidenceBytes, safeEvidenceJson, type VerifiedEvidenceArchive } from './archive.ts';
import { SealedHostCaptureSchema, type GradeRun } from '../schemas/evaluation.ts';
import type { Arm } from '../schemas/types.ts';
import { bytesHash } from './evaluator.ts';
import { originalSafetyPopulationReferences, verifyRetainedGradingPopulations, type GradingPopulationProof } from './populations.ts';
import { CanonicalDatasetMemberSchema } from './dataset.ts';

export interface TrustedReviewOptions {
  trustedCaptureKey: TrustedCaptureKey;
  expectedLedgerId: string;
  expectedLedgerClosureSha256?: string;
}
export interface ReviewLedgerSummary {
  status: 'verified' | 'missing' | 'untrusted'; ledgerId: string | null; closureSha256: string | null; publicKeySha256: string | null; closedAt: string | null;
  denominator: { allAdmissions: number; recordedAdmissions: number; sealedAdmissions: number; pendingAdmissions: number; unsealedAdmissions: number; failedAdmissions: number };
  admissions: Array<{ admissionId: string; attemptId: string; cellId: string; arm: Arm; manifestSha256: string | null; gradeSha256: string | null; captureAttestationSha256: string | null }>;
  missingArchiveAdmissionIds: string[];
}
export interface AttemptCaptureReview {
  status: 'verified' | 'missing' | 'untrusted'; publicKeySha256: string | null; attestationSha256: string | null; populationProofSha256: string | null;
  gradingInfrastructureComplete: boolean | null; inferenceObserved: boolean | null;
}

/** The trusted key and ledger identity come from source preregistration, never setup.json or a submitted producer label. */
export async function readClosedReviewLedger(request: ReviewRequest, authority?: TrustedReviewOptions): Promise<ClosedExperimentLedger | null> {
  if (!authority || !request.ledgerRoot) return null;
  const ledger = await verifyClosedExperimentLedger({ ledgerRoot: request.ledgerRoot, trustedCaptureKey: authority.trustedCaptureKey,
    experimentSha256: captureDigest(request.experiment) });
  if (ledger.ledgerId !== authority.expectedLedgerId || captureDigest(ledger.experiment) !== captureDigest(request.experiment)
    || authority.expectedLedgerClosureSha256 !== undefined && ledger.closureSha256 !== authority.expectedLedgerClosureSha256) throw new Error('Signed admission ledger differs from independent preregistration or approved exact closure');
  return ledger;
}

export interface VerifiedAttemptCapture { capture: AttemptCaptureReview; populations: GradingPopulationProof | null }

/** Successful absence checks cite the inspected population, not nonexistent offending items or a bare passed verdict. */
export function hasInspectedCriterionEvidence(criterion: GradeRun['criteria'][number], populations: GradingPopulationProof | null): boolean {
  if (!criterion.required || criterion.status !== 'passed') return true;
  const scopes = originalSafetyPopulationReferences(criterion.criterionId);
  return scopes.length > 0 ? populations !== null && scopes.every(scope => criterion.evidence.includes(scope)) : criterion.evidence.length > 0;
}

/** Signature verification proves the trusted runner captured these exact bytes; it never derives authenticity from model counters or producer labels. */
export async function verifySignedAttemptCapture(options: { archive: VerifiedEvidenceArchive; grade: GradeRun; gradeSha256: string;
  captureAttestationPath?: string; ledgerEntry?: ExperimentLedgerEntry; authority?: TrustedReviewOptions; datasetMember: unknown }): Promise<VerifiedAttemptCapture> {
  const { archive, grade, authority, ledgerEntry } = options;
  const unavailable: VerifiedAttemptCapture = { capture: { status: authority ? 'missing' : 'untrusted', publicKeySha256: authority?.trustedCaptureKey.publicKeySha256 ?? null,
    attestationSha256: null, populationProofSha256: null, gradingInfrastructureComplete: null, inferenceObserved: null }, populations: null };
  if (!authority || !options.captureAttestationPath || !ledgerEntry?.seal || !archive.admission || !archive.attempt || !archive.manifest || grade.kind !== 'initial') return unavailable;
  const admission = archive.admission, attempt = archive.attempt;
  if (!admission.experiment || !admission.datasetMember || !admission.capture
    || admission.capture.keyId !== authority.trustedCaptureKey.keyId || admission.capture.publicKeySha256 !== authority.trustedCaptureKey.publicKeySha256) throw new Error('Archived admission is not bound to the independently preregistered runner key/experiment/member');
  const envelope = await safeEvidenceJson(options.captureAttestationPath), attestationSha256 = captureDigest(envelope);
  if (attestationSha256 !== ledgerEntry.seal.captureAttestationSha256) throw new Error('Capture signature envelope differs from the exact signed ledger seal');
  const payload = SealedHostCaptureSchema.parse(verifyCaptureAttestation(envelope, authority.trustedCaptureKey));
  if (payload.arm !== admission.arm || payload.arm !== ledgerEntry.admission.arm) throw new Error('Authenticated capture arm differs from the signed admission or registered ledger cell');
  const admissionFile = archive.manifest.files.find(file => file.path === 'admission.json');
  if (payload.admissionId !== admission.admissionId || payload.attemptId !== attempt.attemptId || payload.runId !== admission.runId
    || payload.admissionSha256 !== admissionFile?.sha256 || payload.manifestSha256 !== archive.manifestSha256
    || payload.gradeId !== grade.gradeId || payload.gradeSha256 !== options.gradeSha256
    || payload.evaluatorSha256 !== grade.evaluatorSha256 || payload.calibrationSha256 !== grade.calibrationSha256
    || admission.producer !== payload.producer || captureDigest(payload.experiment) !== captureDigest(admission.experiment)
    || captureDigest(payload.experiment) !== captureDigest(ledgerEntry.binding) || captureDigest(payload.dataset) !== captureDigest(admission.dataset)
    || captureDigest(payload.datasetMember) !== captureDigest(admission.datasetMember)
    || captureDigest(payload.actualVersions) !== captureDigest(attempt.actualVersions)) throw new Error('Authenticated host capture does not describe the actual admission, sealed archive, grade, dataset or runtime');
  const member = CanonicalDatasetMemberSchema.parse(options.datasetMember);
  const selected = payload.datasetMember;
  if (selected.memberId !== member.memberId || selected.memberVersion !== member.memberVersion || selected.familyId !== member.familyId
    || selected.executionSpecSha256 !== captureDigest(member.executionSpec)) throw new Error('Authenticated fresh model execution is not bound to the exact canonical task member/specification');
  const run = archive.result;
  if (!run || payload.arm !== run.arm || payload.model.modelCalls !== run.usage.modelCalls || payload.model.providerRequests !== (run.observations?.providerRequests ?? null)
    || payload.model.effectiveModelSettingsHash !== run.reproducibility.effectiveModelSettingsHash
    || payload.model.inferenceObserved !== ((run.observations?.providerRequests ?? 0) > 0 && (run.usage.modelCalls ?? 0) > 0
      && run.reproducibility.effectiveModelSettingsHash !== null)) throw new Error('Host capture arm/model-observation facts differ from the sealed original attempt');
  let populations: GradingPopulationProof | null = null;
  if (payload.populationProofSha256 !== null) {
    const record = archive.manifest.files.find(file => file.path === 'grading-populations.json');
    if (!record || record.sha256 !== payload.populationProofSha256 || !archive.inputs) throw new Error('Signed inspected-population proof is missing from sealed grading inputs');
    const bytes = await safeEvidenceBytes(path.join(archive.root, record.path));
    if (bytesHash(bytes) !== payload.populationProofSha256) throw new Error('Signed grading population bytes were modified');
    let value: unknown; try { value = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new Error('Malformed inspected population proof (content withheld)'); }
    populations = verifyRetainedGradingPopulations(value, archive.inputs);
  }
  return { capture: { status: 'verified', publicKeySha256: authority.trustedCaptureKey.publicKeySha256, attestationSha256,
    populationProofSha256: payload.populationProofSha256, gradingInfrastructureComplete: payload.gradingInfrastructureComplete, inferenceObserved: payload.model.inferenceObserved }, populations };
}

/** Missing, interrupted and never-sealed admissions are retained, not replaced by whichever retry produced an archive. */
export function unavailableLedgerAttempt(entry: ExperimentLedgerEntry): AttemptReview {
  return { admissionId: entry.admissionId, attemptId: entry.attemptId, runId: entry.runId, cellId: entry.binding.cellId, arm: entry.admission.arm,
    producer: typeof entry.admission.producer === 'string' ? entry.admission.producer : 'signed-admission',
    manifestSha256: entry.seal?.manifestSha256 ?? null, gradeSha256: entry.seal?.gradeSha256 ?? null, gradeId: null,
    versions: { ...entry.admission.versions, taskVersion: entry.admission.taskVersion, fixtureVersion: entry.admission.fixtureVersion ?? null },
    admittedAt: entry.admission.admittedAt, sealedAt: null, execution: { status: 'incomplete', failure: null, originalStatus: entry.seal?.status ?? 'pending', originalScoredFailure: null },
    functional: [], safety: [], stageEvents: [], requirementRevisions: [],
    missingEvidence: [entry.admissionSha256 === null ? 'Signed admission reservation was never finalized before closure' : entry.seal === null ? 'Signed admission has no sealed terminal archive' : 'Signed admission archive/grade/capture was omitted from submitted review material'],
    rootCause: { category: 'unknown', certainty: 'unknown', evidence: [], reviewerId: null }, releaseEligible: false, modelQualitySuccess: false,
    cost: { usd: null, complete: false, basis: null }, timeMs: null, fixtureId: null, environmentHash: null, fixtureSemanticHash: null, effectiveModelSettingsHash: null,
    capture: { status: 'missing', publicKeySha256: null, attestationSha256: entry.seal?.captureAttestationSha256 ?? null, populationProofSha256: null,
      gradingInfrastructureComplete: null, inferenceObserved: null } };
}

export function summarizeReviewLedger(ledger: ClosedExperimentLedger | null, authority: TrustedReviewOptions | undefined, missingArchiveAdmissionIds: string[]): ReviewLedgerSummary {
  return ledger ? { status: 'verified', ledgerId: ledger.ledgerId, closureSha256: ledger.closureSha256, publicKeySha256: ledger.trustedCaptureKey.publicKeySha256,
    closedAt: ledger.closedAt, denominator: ledger.denominator,
    admissions: ledger.entries.map(entry => ({ admissionId: entry.admissionId, attemptId: entry.attemptId, cellId: entry.binding.cellId, arm: entry.admission.arm,
      manifestSha256: entry.seal?.manifestSha256 ?? null, gradeSha256: entry.seal?.gradeSha256 ?? null, captureAttestationSha256: entry.seal?.captureAttestationSha256 ?? null })), missingArchiveAdmissionIds }
    : { status: authority ? 'missing' : 'untrusted', ledgerId: null, closureSha256: null, publicKeySha256: authority?.trustedCaptureKey.publicKeySha256 ?? null,
      closedAt: null, denominator: { allAdmissions: 0, recordedAdmissions: 0, sealedAdmissions: 0, pendingAdmissions: 0, unsealedAdmissions: 0, failedAdmissions: 0 }, admissions: [], missingArchiveAdmissionIds };
}
