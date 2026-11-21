import { z } from 'zod';
import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { digest, erasePrivateContent, exclusiveJson, Id, identifier, mutateRegistry, privateJson, readEvents, resolveDatasetArchiveRoot, type RegistryEvent } from './dataset-files.ts';
import { safeEvidenceBytes, verifyEvidenceArchive, type VerifiedEvidenceArchive } from './archive.ts';
import { evaluationFenceSchema, evaluationMetadataExportSchema, type EvaluationFence } from '../../../packages/agent-contracts/src/evaluation-feedback.ts';
import { TraceRedactor } from '../runners/telemetry.ts';
import { readGradeRun } from './regrade.ts';
import { CheckResultSchema, SafetyGateSchema, type CheckResult } from '../schemas/types.ts';
import type { GradeRun } from '../schemas/evaluation.ts';
import { bytesHash } from './evaluator.ts';

export const RegistryIdSchema = z.string().regex(Id).refine(value => value !== '.' && value !== '..');
export const CriterionIdSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(value => value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const DateSchema = z.iso.datetime();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const WithdrawalSchema = z.object({ sourceId: RegistryIdSchema, reason: z.enum(['withdrawn', 'permission-revoked', 'retention-expired']), actorId: RegistryIdSchema }).strict();
const WithdrawalRecordSchema = WithdrawalSchema.extend({ schemaVersion: z.literal(1), withdrawnAt: DateSchema }).strict();
const ExportRecordSchema = z.object({ exportId: RegistryIdSchema, lineageSourceIds: z.array(RegistryIdSchema), digest: HashSchema }).strict();
export const SourceSchema = z.object({ sourceId: RegistryIdSchema, sourceVersion: RegistryIdSchema, kind: z.enum(['synthetic', 'manual-feedback', 'online-metadata']), provenanceId: RegistryIdSchema, retentionUntil: DateSchema, importedClaim: z.boolean(), observation: z.object({ storeId: RegistryIdSchema, restoreEpoch: z.number().int().nonnegative(), observationId: RegistryIdSchema, releaseId: RegistryIdSchema.nullable() }).strict().nullable() }).strict().superRefine((source, context) => {
  if (source.kind === 'online-metadata' && (!source.importedClaim || !source.observation) || source.kind !== 'online-metadata' && source.observation) context.addIssue({ code: 'custom', message: 'Online metadata requires exact scoped identity and remains an imported claim' });
});
export type FeedbackSource = z.infer<typeof SourceSchema>;
export const SourceEnrollmentSchema = z.object({ enrollmentId: RegistryIdSchema, source: SourceSchema, maintainerId: RegistryIdSchema, labelerId: RegistryIdSchema, reviewerId: RegistryIdSchema, licenseId: RegistryIdSchema, licenseAuthorized: z.literal(true), sanitized: z.literal(true), independentExpectedCriterion: z.literal(true) }).strict().superRefine((enrollment, context) => {
  if (enrollment.source.kind !== 'synthetic' || enrollment.source.importedClaim || enrollment.source.observation || new Set([enrollment.maintainerId, enrollment.labelerId, enrollment.reviewerId]).size !== 3) context.addIssue({ code: 'custom', message: 'Canonical source enrollment requires original synthetic provenance and independent maintenance, labeling and review' });
});
export const IntakeSchema = z.object({ caseId: RegistryIdSchema, familyId: RegistryIdSchema, signatureCode: RegistryIdSchema, source: SourceSchema, occurrenceId: RegistryIdSchema, expectedCode: RegistryIdSchema, actualCode: RegistryIdSchema, severity: z.enum(['low', 'medium', 'high', 'critical']), reportedRoot: z.enum(['unknown', 'product', 'harness', 'model', 'task', 'permission', 'infrastructure']), releaseId: RegistryIdSchema.nullable() }).strict();
export const TriageSchema = z.object({ caseId: RegistryIdSchema, status: z.enum(['reported', 'reproduced', 'disproved', 'insufficient', 'accepted']), reviewerId: RegistryIdSchema, rootCategory: z.enum(['unknown', 'product', 'harness', 'model', 'task', 'permission', 'infrastructure']), rootCertainty: z.enum(['unknown', 'inferred', 'confirmed']), reasonCode: RegistryIdSchema, reproductionId: RegistryIdSchema.nullable() }).strict();
export const ContentPermissionSchema = z.object({ permissionId: RegistryIdSchema, sourceId: RegistryIdSchema, sourceVersion: RegistryIdSchema, grantedBy: RegistryIdSchema, purpose: z.literal('local-evaluation'), audience: z.literal('local-reviewers'), allowDataset: z.boolean(), allowExport: z.boolean(), allowTraining: z.literal(false), allowPublic: z.literal(false), expiresAt: DateSchema }).strict();
export const PreviewSchema = z.object({ previewId: RegistryIdSchema, sourceId: RegistryIdSchema, permissionId: RegistryIdSchema, transformVersion: RegistryIdSchema, text: z.string().min(1).max(16384) }).strict();
export const PreviewReviewSchema = z.object({ previewId: RegistryIdSchema, reviewerId: RegistryIdSchema, disposition: z.enum(['approved', 'rejected']), secretsChecked: z.literal(true), piiChecked: z.literal(true), reasonCode: RegistryIdSchema }).strict();
export const ReproductionSchema = z.object({ reproductionId: RegistryIdSchema, caseId: RegistryIdSchema, archiveRoot: z.string().min(1), manifestDigest: HashSchema, attemptId: RegistryIdSchema, initialGradePath: z.string().min(1), initialGradeSha256: HashSchema, reproducerId: RegistryIdSchema, synthetic: z.literal(true), independentlyExecuted: z.literal(true), provenanceId: RegistryIdSchema, licenseId: RegistryIdSchema, affectedVersion: RegistryIdSchema, preconditionCode: RegistryIdSchema, failureCriterionIds: z.array(CriterionIdSchema).min(1), noExternalReplay: z.literal(true) }).strict();
export type Reproduction = z.infer<typeof ReproductionSchema> & { taskId: string; taskVersion: string; lineageSourceIds: string[] };
export type FeedbackOccurrence = { occurrenceId: string; caseId: string; sourceId: string; sourceVersion: string; releaseId: string | null; importedClaim: boolean; expectedCode: string; actualCode: string; severity: z.infer<typeof IntakeSchema>['severity']; reportedRoot: z.infer<typeof IntakeSchema>['reportedRoot'] };
export type FeedbackCase = Omit<z.infer<typeof IntakeSchema>, 'source' | 'occurrenceId' | 'releaseId'> & { occurrences: FeedbackOccurrence[]; triage: z.infer<typeof TriageSchema> | null };
export type PreviewMetadata = Omit<z.infer<typeof PreviewSchema>, 'text'> & { review: z.infer<typeof PreviewReviewSchema> | null };
export type FeedbackState = { sources: Map<string, FeedbackSource>; enrollments: Map<string, z.infer<typeof SourceEnrollmentSchema>>; cases: Map<string, FeedbackCase>; permissions: Map<string, z.infer<typeof ContentPermissionSchema>>; previews: Map<string, PreviewMetadata>; reproductions: Map<string, Reproduction>; withdrawnSourceIds: Set<string>; exportIds: Set<string>; events: RegistryEvent[] };

/** Only host-created events enter this projection; imported records use intake and never restore labels. */
export function feedbackState(events: RegistryEvent[]): FeedbackState {
  const state: FeedbackState = { sources: new Map(), enrollments: new Map(), cases: new Map(), permissions: new Map(), previews: new Map(), reproductions: new Map(), withdrawnSourceIds: new Set(), exportIds: new Set(), events };
  for (const event of events) {
    if (event.kind === 'intake') {
      const input = IntakeSchema.parse(event.data);
      const source = state.sources.get(input.source.sourceId);
      if (source && digest(source) !== digest(input.source)) throw new Error('Source identity/version cannot be reassigned');
      state.sources.set(input.source.sourceId, input.source);
      let feedback = state.cases.get(input.caseId);
      if (!feedback) {
        const { source: _source, occurrenceId: _occurrence, releaseId: _release, ...details } = input;
        feedback = { ...details, occurrences: [], triage: null };
        state.cases.set(input.caseId, feedback);
      }
      feedback.occurrences.push({ occurrenceId: input.occurrenceId, caseId: input.caseId, sourceId: input.source.sourceId, sourceVersion: input.source.sourceVersion, releaseId: input.releaseId, importedClaim: input.source.importedClaim, expectedCode: input.expectedCode, actualCode: input.actualCode, severity: input.severity, reportedRoot: input.reportedRoot });
    } else if (event.kind === 'source-enrollment') {
      const enrollment = SourceEnrollmentSchema.parse(event.data);
      const source = state.sources.get(enrollment.source.sourceId), prior = state.enrollments.get(enrollment.enrollmentId);
      if (source && digest(source) !== digest(enrollment.source) || prior && digest(prior) !== digest(enrollment)) throw new Error('Canonical source enrollment identity is immutable');
      state.sources.set(enrollment.source.sourceId, enrollment.source);
      state.enrollments.set(enrollment.enrollmentId, enrollment);
    } else if (event.kind === 'triage') {
      const triage = TriageSchema.parse(event.data);
      const feedback = state.cases.get(triage.caseId);
      if (!feedback) throw new Error('Triage references an absent case');
      feedback.triage = triage;
    } else if (event.kind === 'permission') {
      const permission = ContentPermissionSchema.parse(event.data);
      state.permissions.set(permission.permissionId, permission);
    } else if (event.kind === 'preview') {
      const preview = PreviewSchema.omit({ text: true }).parse(event.data);
      state.previews.set(preview.previewId, { ...preview, review: null });
    } else if (event.kind === 'preview-review') {
      const review = PreviewReviewSchema.parse(event.data), preview = state.previews.get(review.previewId);
      if (!preview) throw new Error('Review references an absent preview');
      preview.review = review;
    } else if (event.kind === 'reproduction') {
      const reproduction = ReproductionSchema.extend({ taskId: RegistryIdSchema, taskVersion: RegistryIdSchema, lineageSourceIds: z.array(RegistryIdSchema).min(1) }).parse(event.data);
      state.reproductions.set(reproduction.reproductionId, reproduction);
    } else if (event.kind === 'withdrawal') {
      state.withdrawnSourceIds.add(WithdrawalRecordSchema.parse(event.data).sourceId);
    } else if (event.kind === 'export') {
      state.exportIds.add(ExportRecordSchema.parse(event.data).exportId);
    } else if (event.kind === 'online-fence') {
      evaluationFenceSchema.parse(event.data);
    } else if (event.kind === 'online-import') {
      z.object({ exportId: RegistryIdSchema, digest: HashSchema, lineageSourceIds: z.array(RegistryIdSchema) }).strict().parse(event.data);
    } else if (!['dataset', 'exposure'].includes(event.kind)) throw new Error('Unknown feedback registry event');
  }
  return state;
}
export class SourceInvalidatedError extends Error {
  readonly sourceId: string;
  constructor(sourceId: string, message: string) { super(message); this.name = 'SourceInvalidatedError'; this.sourceId = sourceId; }
}
export async function assertLineageActive(registryRoot: string, sourceIds: readonly string[]): Promise<void> {
  const state = feedbackState(await readEvents(registryRoot));
  for (const sourceId of new Set(sourceIds)) {
    identifier(sourceId);
    const fence = await lstat(path.join(registryRoot, 'fences', `${sourceId}.json`)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (fence || state.withdrawnSourceIds.has(sourceId)) throw new SourceInvalidatedError(sourceId, 'Source lineage is withdrawn; descendants are invalid');
    const source = state.sources.get(sourceId);
    if (!source || Date.parse(source.retentionUntil) <= Date.now()) throw new SourceInvalidatedError(sourceId, 'Source lineage is absent or expired');
    await assertOnlineSourceUnfenced(registryRoot, source);
  }
}
export async function assertSourceRegistrationAllowed(registryRoot: string, source: FeedbackSource, state: FeedbackState): Promise<void> {
  const fenced = await lstat(path.join(registryRoot, 'fences', `${source.sourceId}.json`)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (fenced || state.withdrawnSourceIds.has(source.sourceId) || Date.parse(source.retentionUntil) <= Date.now()) throw new Error('Intake/enrollment cannot resurrect withdrawn or expired sources');
  await assertOnlineSourceUnfenced(registryRoot, source);
  const existing = state.sources.get(source.sourceId);
  if (existing && digest(existing) !== digest(source)) throw new Error('Source identity/version cannot be reassigned');
}
export async function intakeFeedback(registryRoot: string, raw: unknown): Promise<FeedbackCase> {
  const input = IntakeSchema.parse(raw);
  return mutateRegistry(registryRoot, async (events, append) => {
    const state = feedbackState(events);
    await assertSourceRegistrationAllowed(registryRoot, input.source, state);
    const priorOccurrence = [...state.cases.values()].flatMap(item => item.occurrences).find(item => item.occurrenceId === input.occurrenceId || item.sourceId === input.source.sourceId && item.sourceVersion === input.source.sourceVersion);
    const duplicate = [...state.cases.values()].find(item => item.signatureCode === input.signatureCode && item.familyId === input.familyId);
    const target = duplicate?.caseId ?? input.caseId;
    const normalized = { ...input, caseId: target };
    if (priorOccurrence) {
      if (priorOccurrence.caseId !== target || priorOccurrence.sourceId !== input.source.sourceId || priorOccurrence.sourceVersion !== input.source.sourceVersion || priorOccurrence.releaseId !== input.releaseId || priorOccurrence.expectedCode !== input.expectedCode || priorOccurrence.actualCode !== input.actualCode || priorOccurrence.severity !== input.severity || priorOccurrence.reportedRoot !== input.reportedRoot) throw new Error('Occurrence identity conflicts with its original intake');
      return state.cases.get(priorOccurrence.caseId)!;
    }
    const existingCase = state.cases.get(target);
    if (existingCase && (existingCase.familyId !== input.familyId || existingCase.signatureCode !== input.signatureCode)) throw new Error('Case identity/family cannot be reassigned');
    await append('intake', normalized);
    return feedbackState(events).cases.get(target)!;
  });
}
export async function triageFeedback(registryRoot: string, raw: unknown): Promise<FeedbackCase> {
  const input = TriageSchema.parse(raw);
  return mutateRegistry(registryRoot, async (events, append) => {
    const state = feedbackState(events), feedback = state.cases.get(input.caseId);
    if (!feedback) throw new Error('Unknown feedback case');
    await assertLineageActive(registryRoot, feedback.occurrences.map(item => item.sourceId));
    const reproduction = input.reproductionId ? state.reproductions.get(input.reproductionId) : undefined;
    if (['reproduced', 'accepted'].includes(input.status) || input.rootCertainty === 'confirmed') {
      if (!reproduction || reproduction.caseId !== input.caseId || reproduction.reproducerId === input.reviewerId) throw new Error('Reproduced/confirmed triage requires an independently reviewed reproduction');
      await verifyReproductionEvidence(registryRoot, reproduction);
    }
    if (input.rootCategory === 'unknown' && input.rootCertainty !== 'unknown') throw new Error('Unknown root cannot be confirmed or inferred');
    await append('triage', input);
    return feedbackState(events).cases.get(input.caseId)!;
  });
}
export async function grantContentPermission(registryRoot: string, raw: unknown): Promise<unknown> {
  const input = ContentPermissionSchema.parse(raw);
  return mutateRegistry(registryRoot, async (events, append) => {
    const state = feedbackState(events);
    await assertLineageActive(registryRoot, [input.sourceId]);
    const source = state.sources.get(input.sourceId);
    if (!source || state.permissions.has(input.permissionId) || source.sourceVersion !== input.sourceVersion || Date.parse(input.expiresAt) <= Date.now() || Date.parse(input.expiresAt) > Date.parse(source.retentionUntil)) throw new Error('Permission is duplicate, expired, beyond source retention or bound to another source version');
    await append('permission', input);
    return input;
  });
}
function checkPreviewPermission(state: FeedbackState, preview: Pick<PreviewMetadata, 'sourceId' | 'permissionId'>): void {
  const permission = state.permissions.get(preview.permissionId), source = state.sources.get(preview.sourceId);
  if (!permission || !source || permission.sourceId !== preview.sourceId || permission.sourceVersion !== source.sourceVersion || Date.parse(permission.expiresAt) <= Date.now()) throw new Error('Explicit current content permission is required');
}
export async function createContentPreview(registryRoot: string, raw: unknown): Promise<PreviewMetadata> {
  const input = PreviewSchema.parse(raw);
  // Conservative quarantine is not a claim of comprehensive PII anonymization; human review remains mandatory.
  const sanitized = new TraceRedactor().text(input.text).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]').replace(/https?:\/\/\S+/gi, '[redacted-url]').replace(/\b(?:Bearer\s+\S+|(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{8,})\b/gi, '[redacted-secret]').replace(/(?:[A-Za-z]:\\|\/)[^\s<>"']+/g, '[redacted-path]').replace(/\p{Cc}/gu, character => {
    const code = character.charCodeAt(0);
    return code === 127 || code < 32 && code !== 9 && code !== 10 && code !== 13 ? '' : character;
  });
  return mutateRegistry(registryRoot, async (events, append) => {
    const state = feedbackState(events);
    await assertLineageActive(registryRoot, [input.sourceId]);
    checkPreviewPermission(state, input);
    if (state.previews.has(input.previewId)) throw new Error('Preview identity is immutable');
    const { text: _text, ...metadata } = input;
    await exclusiveJson(path.join(registryRoot, 'content', input.sourceId, `${input.previewId}.json`), { text: sanitized });
    await append('preview', metadata);
    return { ...metadata, review: null };
  });
}
export async function reviewContentPreview(registryRoot: string, raw: unknown): Promise<PreviewMetadata> {
  const input = PreviewReviewSchema.parse(raw);
  return mutateRegistry(registryRoot, async (events, append) => {
    const state = feedbackState(events), preview = state.previews.get(input.previewId);
    if (!preview || preview.review) throw new Error('Preview review requires an unreviewed immutable preview');
    await assertLineageActive(registryRoot, [preview.sourceId]);
    checkPreviewPermission(state, preview);
    if (state.permissions.get(preview.permissionId)?.grantedBy === input.reviewerId) throw new Error('Content reviewer must be independent of permission grant');
    await append('preview-review', input);
    return { ...preview, review: input };
  });
}
export async function readContentPreview(registryRoot: string, previewId: string): Promise<unknown> {
  identifier(previewId);
  const state = feedbackState(await readEvents(registryRoot)), preview = state.previews.get(previewId);
  if (!preview) throw new Error('Unknown content preview');
  await assertLineageActive(registryRoot, [preview.sourceId]);
  checkPreviewPermission(state, preview);
  return { ...preview, content: await privateJson(path.join(registryRoot, 'content', preview.sourceId, `${previewId}.json`)) };
}
const ExecutedInitialAssertionsSchema = z.object({ checks: z.record(z.string(), z.array(CheckResultSchema)), safetyGate: SafetyGateSchema });
type ReproductionEvidenceReference = Pick<Reproduction, 'archiveRoot' | 'manifestDigest' | 'attemptId' | 'initialGradePath' | 'initialGradeSha256' | 'failureCriterionIds'>;
/** A failed assertion must exist in both the sealed executed grader result and its exact initial GradeRun. */
export async function verifyReproductionEvidence(registryRoot: string, reproduction: ReproductionEvidenceReference): Promise<{ archive: VerifiedEvidenceArchive; grade: GradeRun; assertions: CheckResult[] }> {
  const archive = await verifyEvidenceArchive(resolveDatasetArchiveRoot(registryRoot, reproduction.archiveRoot), reproduction.manifestDigest);
  if (archive.legacy || !archive.admission || !archive.attempt || !archive.inputs || archive.admission.producer === 'imported-claim' || archive.admission.attemptId !== reproduction.attemptId) throw new Error('Reproduction requires sealed independently executed frozen inputs, not imported claims/legacy');
  const sealedGrade = archive.manifest?.files.find(file => file.path === 'initial-grader-result.json');
  if (!sealedGrade) throw new Error('Reproduction requires a sealed executed initial grader result');
  const grade = await readGradeRun(archive, resolveDatasetArchiveRoot(registryRoot, reproduction.initialGradePath), reproduction.initialGradeSha256);
  if (grade.kind !== 'initial' || grade.status !== 'failed') throw new Error('Reproduction requires an actually failed initial GradeRun');
  const executedBytes = await safeEvidenceBytes(path.join(archive.root, sealedGrade.path));
  if (executedBytes.length !== sealedGrade.bytes || bytesHash(executedBytes) !== sealedGrade.sha256) throw new Error('Sealed executed initial grader result changed during verification');
  let executedValue: unknown;
  try { executedValue = JSON.parse(executedBytes.toString('utf8')) as unknown; } catch { throw new Error('Malformed sealed executed initial grader result'); }
  const executed = ExecutedInitialAssertionsSchema.parse(executedValue);
  const assertions = [...Object.values(executed.checks).flat(), ...executed.safetyGate.checks];
  if (new Set(reproduction.failureCriterionIds).size !== reproduction.failureCriterionIds.length) throw new Error('Reproduction failure criterion identities must be unique');
  for (const criterionId of reproduction.failureCriterionIds) {
    const matchingGrades = grade.criteria.filter(criterion => criterion.criterionId === criterionId);
    const matchingAssertions = assertions.filter(assertion => assertion.id === criterionId);
    const criterion = matchingGrades[0], assertion = matchingAssertions[0];
    if (matchingGrades.length !== 1 || !criterion || criterion.status !== 'failed' || criterion.taskVersion !== archive.admission.taskVersion || !archive.attempt.requirementRevisions.includes(criterion.requirementRevision) || matchingAssertions.length !== 1 || !assertion || assertion.passed) throw new Error('Reproduction failure criterion was not an applicable executed failing assertion');
  }
  return { archive, grade, assertions };
}
export async function registerReproduction(registryRoot: string, raw: unknown): Promise<Reproduction> {
  const input = ReproductionSchema.parse(raw);
  return mutateRegistry(registryRoot, async (events, append) => {
    const state = feedbackState(events), feedback = state.cases.get(input.caseId);
    if (!feedback || state.reproductions.has(input.reproductionId)) throw new Error('Reproduction requires an existing case and a new identity');
    const lineageSourceIds = [...new Set(feedback.occurrences.map(item => item.sourceId))].sort();
    await assertLineageActive(registryRoot, lineageSourceIds);
    const { archive } = await verifyReproductionEvidence(registryRoot, input);
    if (!archive.admission) throw new Error('Reproduction has no immutable admission');
    const result = { ...input, archiveRoot: path.isAbsolute(input.archiveRoot) ? archive.root : input.archiveRoot, initialGradePath: path.isAbsolute(input.initialGradePath) ? path.resolve(input.initialGradePath) : input.initialGradePath, taskId: archive.admission.taskId, taskVersion: archive.admission.taskVersion, lineageSourceIds };
    await append('reproduction', result);
    return result;
  });
}
export async function withdrawFeedbackSource(registryRoot: string, raw: unknown): Promise<unknown> {
  const input = WithdrawalSchema.parse(raw);
  return mutateRegistry(registryRoot, async (events, append) => {
    const state = feedbackState(events), source = state.sources.get(input.sourceId);
    if (input.reason === 'retention-expired' && source && Date.parse(source.retentionUntil) > Date.now()) throw new Error('Source retention has not expired');
    const file = path.join(registryRoot, 'fences', `${input.sourceId}.json`);
    const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    const receipt = existing ? await privateJson(file) : { schemaVersion: 1, ...input, withdrawnAt: new Date().toISOString() };
    if (!existing) await exclusiveJson(file, receipt); // Fence first: interrupted deletion still blocks every descendant.
    if (!state.withdrawnSourceIds.has(input.sourceId)) await append('withdrawal', receipt);
    await erasePrivateContent(registryRoot, input.sourceId);
    return { receipt, invalidatedCases: [...state.cases.values()].filter(item => item.occurrences.some(occurrence => occurrence.sourceId === input.sourceId)).map(item => item.caseId), pmFactsChanged: false };
  });
}
export async function expireFeedbackSources(registryRoot: string, actorId: string): Promise<unknown[]> {
  identifier(actorId);
  const state = feedbackState(await readEvents(registryRoot)), result: unknown[] = [];
  for (const source of state.sources.values()) if (Date.parse(source.retentionUntil) <= Date.now()) result.push(await withdrawFeedbackSource(registryRoot, { sourceId: source.sourceId, reason: 'retention-expired', actorId }));
  for (const permission of state.permissions.values()) if (Date.parse(permission.expiresAt) <= Date.now()) {
    await mutateRegistry(registryRoot, async () => erasePrivateContent(registryRoot, permission.sourceId));
    result.push({ permissionId: permission.permissionId, expiredContentErased: true, pmFactsChanged: false });
  }
  return result;
}
/** Restores/intakes only claims and permanent fences. Independent labels, previews and permissions never import. */
export async function exportFeedbackMetadata(registryRoot: string, exportId: string): Promise<unknown> {
  identifier(exportId);
  await expireFeedbackSources(registryRoot, 'metadata-export');
  return mutateRegistry(registryRoot, async (events, append) => {
    const state = feedbackState(events);
    if (state.exportIds.has(exportId)) throw new Error('Export identity is immutable');
    const fencesDirectory = path.join(registryRoot, 'fences');
    const names = await readdir(fencesDirectory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const tombstones = [];
    for (const name of names) { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$/.test(name)) throw new Error('Unsafe withdrawal fence filename'); tombstones.push(await privateJson(path.join(fencesDirectory, name))); }
    const activeSources: string[] = [];
    for (const source of state.sources.values()) {
      try { await assertLineageActive(registryRoot, [source.sourceId]); activeSources.push(source.sourceId); }
      catch (error) { if (!(error instanceof SourceInvalidatedError)) throw error; }
    }
    const cases = [...state.cases.values()].flatMap(feedback => feedback.occurrences.filter(occurrence => activeSources.includes(occurrence.sourceId)).map(occurrence => ({ caseId: feedback.caseId, familyId: feedback.familyId, signatureCode: feedback.signatureCode, source: { ...state.sources.get(occurrence.sourceId)!, importedClaim: true }, occurrenceId: occurrence.occurrenceId, expectedCode: occurrence.expectedCode, actualCode: occurrence.actualCode, severity: occurrence.severity, reportedRoot: occurrence.reportedRoot, releaseId: occurrence.releaseId })));
    const onlineFences = await readOnlineFences(registryRoot);
    const bundle = { schemaVersion: 1, kind: 'feedback-metadata', exportId, exportedAt: new Date().toISOString(), cases, tombstones, onlineFences, groundTruth: false, contentIncluded: false };
    await append('export', { exportId, lineageSourceIds: activeSources, digest: digest(bundle) });
    return bundle;
  });
}
export const FeedbackImportSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('feedback-metadata'), exportId: RegistryIdSchema, exportedAt: DateSchema, cases: z.array(IntakeSchema), tombstones: z.array(WithdrawalRecordSchema), onlineFences: z.array(evaluationFenceSchema), groundTruth: z.literal(false), contentIncluded: z.literal(false) }).strict();
export async function importFeedbackMetadata(registryRoot: string, raw: unknown): Promise<unknown> {
  const bundle = FeedbackImportSchema.parse(raw);
  // Tombstones apply before any intake, including ones whose source is not locally known yet.
  for (const tombstone of bundle.tombstones) await withdrawFeedbackSource(registryRoot, { sourceId: tombstone.sourceId, reason: tombstone.reason === 'retention-expired' ? 'withdrawn' : tombstone.reason, actorId: tombstone.actorId });
  for (const fence of bundle.onlineFences) await applyOnlineFence(registryRoot, fence);
  const imported = [];
  for (const entry of bundle.cases) {
    const state = feedbackState(await readEvents(registryRoot));
    const known = state.sources.get(entry.source.sourceId);
    imported.push(await intakeFeedback(registryRoot, { ...entry, source: known ?? { ...entry.source, importedClaim: true } }));
  }
  return { importedCases: [...new Set(imported.map(item => item.caseId))], importedOccurrences: bundle.cases.length, groundTruth: false, contentIncluded: false };
}

async function readOnlineFences(registryRoot: string): Promise<EvaluationFence[]> {
  const directory = path.join(registryRoot, 'online-fences');
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  const result = (await readEvents(registryRoot)).filter(event => event.kind === 'online-fence').map(event => evaluationFenceSchema.parse(event.data));
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) throw new Error('Unsafe online withdrawal fence filename');
    const fence = evaluationFenceSchema.parse(await privateJson(path.join(directory, name)));
    const existing = result.find(item => item.fenceId === fence.fenceId);
    if (existing && digest(existing) !== digest(fence)) throw new Error('Online fence content disagrees with immutable registry lineage');
    if (!existing) result.push(fence);
  }
  return result;
}
async function assertOnlineSourceUnfenced(registryRoot: string, source: FeedbackSource): Promise<void> {
  if (!source.observation) return;
  for (const fence of await readOnlineFences(registryRoot)) {
    if (fence.storeId === source.observation.storeId && fence.restoreEpoch === source.observation.restoreEpoch && (fence.scope === 'store-epoch' || fence.observationIds.includes(source.observation.observationId))) throw new SourceInvalidatedError(source.sourceId, 'Online source restore/deletion fence invalidates this observation lineage');
  }
}
export async function applyOnlineFence(registryRoot: string, raw: unknown): Promise<void> {
  const fence = evaluationFenceSchema.parse(raw);
  await mutateRegistry(registryRoot, async (events, append) => {
    const file = path.join(registryRoot, 'online-fences', `${fence.fenceId}.json`);
    const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing && digest(await privateJson(file)) !== digest(fence)) throw new Error('Online fence identity is immutable');
    if (!existing) {
      await exclusiveJson(file, fence);
      await append('online-fence', fence);
    }
    for (const source of feedbackState(events).sources.values()) {
      if (source.observation?.storeId === fence.storeId && source.observation.restoreEpoch === fence.restoreEpoch && (fence.scope === 'store-epoch' || fence.observationIds.includes(source.observation.observationId))) await erasePrivateContent(registryRoot, source.sourceId);
    }
  });
}
export const OnlineFeedbackImportSchema = z.object({ metadata: evaluationMetadataExportSchema, observationIds: z.array(z.uuid()).min(1), retentionUntil: DateSchema, provenanceId: RegistryIdSchema, expectedCode: RegistryIdSchema, actualCode: RegistryIdSchema, severity: z.enum(['low', 'medium', 'high', 'critical']) }).strict();
export async function importOnlineFeedback(registryRoot: string, raw: unknown): Promise<unknown> {
  const input = OnlineFeedbackImportSchema.parse(raw), envelope = input.metadata;
  for (const fence of envelope.fences) await applyOnlineFence(registryRoot, fence);
  if (new Set(input.observationIds).size !== input.observationIds.length) throw new Error('Online import selection must be unique');
  const selected = input.observationIds.map(observationId => {
    const observation = envelope.observations.find(item => item.observationId === observationId);
    if (!observation) throw new Error('Selected observation is absent from the explicit metadata export');
    return observation;
  });
  const imported: FeedbackCase[] = [], sourceIds: string[] = [];
  for (const observation of selected) {
    if (Date.parse(input.retentionUntil) > Date.parse(observation.expiresAt)) throw new Error('Offline retention cannot extend the original approved observation expiry');
    const sourceId = `online-${digest({ storeId: envelope.storeId, restoreEpoch: envelope.restoreEpoch, observationId: observation.observationId })}`;
    sourceIds.push(sourceId);
    const familyId = `family-${digest({ storeId: envelope.storeId, restoreEpoch: envelope.restoreEpoch, clusterId: observation.clusterId })}`;
    const releaseId = `release-${digest(observation.release)}`;
    const source: FeedbackSource = { sourceId, sourceVersion: 'metadata-v1', kind: 'online-metadata', provenanceId: input.provenanceId, retentionUntil: input.retentionUntil, importedClaim: true, observation: { storeId: envelope.storeId, restoreEpoch: envelope.restoreEpoch, observationId: observation.observationId, releaseId } };
    imported.push(await intakeFeedback(registryRoot, { caseId: `case-${digest({ sourceId, actualCode: input.actualCode })}`, familyId, signatureCode: input.actualCode, source, occurrenceId: `occurrence-${digest({ sourceId })}`, expectedCode: input.expectedCode, actualCode: input.actualCode, severity: input.severity, reportedRoot: 'unknown', releaseId }));
  }
  await mutateRegistry(registryRoot, async (_events, append) => append('online-import', { exportId: envelope.exportId, digest: digest(envelope), lineageSourceIds: sourceIds }));
  return { importedCases: [...new Set(imported.map(item => item.caseId))], importedOccurrences: imported.length, metadataExportId: envelope.exportId, metadataDigest: digest(envelope), denominatorCoverage: envelope.coverage, groundTruth: false, contentIncluded: false };
}
export async function validateFeedbackExport(registryRoot: string, raw: unknown): Promise<unknown> {
  const input = FeedbackImportSchema.parse(raw), events = await readEvents(registryRoot);
  const record = events.filter(event => event.kind === 'export').map(event => ExportRecordSchema.parse(event.data)).find(entry => entry.exportId === input.exportId);
  if (!record || record.digest !== digest(input)) throw new Error('Export does not match a host-created immutable export record');
  await assertLineageActive(registryRoot, record.lineageSourceIds);
  return { exportId: input.exportId, digest: record.digest, status: 'active', contentIncluded: false, groundTruth: false };
}
