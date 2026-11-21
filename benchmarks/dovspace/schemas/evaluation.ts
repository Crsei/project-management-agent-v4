import { z } from 'zod';
import { ArmSchema, BenchEventSchema, CheckResultSchema, FixtureEntitySchema, FixtureReceiptSchema, TargetSchema, TaskIdSchema, UsageSchema } from './types.ts';

export const EvidenceDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const EvidenceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
export const EvidencePathSchema = z.string().min(1).max(240).refine(value => {
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127) return false;
  return !value.includes('\\') && !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}, 'Canonical relative evidence path required');
export const DatasetIdentitySchema = z.object({ datasetId: EvidenceIdSchema, version: z.string().min(1), sha256: EvidenceDigestSchema }).strict();
export const EvidenceProducerSchema = z.enum(['host-runner', 'controlled-fixture', 'synthetic-calibration', 'imported-claim']);
export const EvaluatorVersionSchema = z.object({
  version: z.literal('1'), evaluatorId: z.literal('dovspace-independent-graders'), sha256: EvidenceDigestSchema,
  codeSha256: EvidenceDigestSchema, dependencySha256: EvidenceDigestSchema, calibrationDefinitionSha256: EvidenceDigestSchema,
  datasetDefinitionSha256: EvidenceDigestSchema,
  runtime: z.object({ node: z.string(), codeImage: z.string().min(1), codeImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable() }).strict(),
  applicableTasks: z.array(z.object({ taskId: TaskIdSchema, taskVersion: z.string() }).strict()).min(1),
  criteria: z.array(z.object({ taskId: TaskIdSchema, criterionId: z.string().min(1), required: z.boolean(), inputs: z.array(z.enum(['public-snapshots', 'entities-receipts', 'events', 'isolation', 'code-sandbox', 'full-authority'])).min(1) }).strict()).min(1),
  aggregation: z.literal('all-required-and-clean-execution'), calibrationSha256: EvidenceDigestSchema.nullable(),
}).strict();
export type EvaluatorVersion = z.infer<typeof EvaluatorVersionSchema>;
export const CalibrationEvidenceSchema = z.object({
  kind: z.literal('grader-calibration'), success: z.boolean(), evaluatorSha256: EvidenceDigestSchema, calibrationDefinitionSha256: EvidenceDigestSchema,
  infrastructureErrors: z.array(z.string()), codeExecution: z.object({ realSandboxCalls: z.number().int().nonnegative() }),
  cases: z.array(z.object({
    taskId: TaskIdSchema, name: z.string(), expectedPass: z.boolean(), actualPass: z.boolean(), passed: z.boolean(), exercised: z.boolean(),
    expectedFailedCheck: z.string().nullable(), intendedFailureObserved: z.boolean(), failedChecks: z.array(z.string()),
    expectedPassedChecks: z.array(z.string()), boundaryChecksObserved: z.boolean(), error: z.string().nullable(),
  })),
});
export const DatasetMemberAdmissionSchema = z.object({ evaluationMode: z.literal('canonical-task'), memberId: z.string().min(1), memberVersion: z.number().int().positive(), familyId: z.string().min(1), executionSpecSha256: EvidenceDigestSchema }).strict();
export const ExperimentAdmissionBindingSchema = z.object({ experimentId: z.string().min(1), experimentSha256: EvidenceDigestSchema, ledgerId: z.string().min(1), cellId: z.string().min(1), pairId: z.string().min(1), variant: z.enum(['baseline', 'candidate']), order: z.union([z.literal(0), z.literal(1)]), memberId: z.string().min(1), memberVersion: z.number().int().positive(), sequence: z.number().int().positive() }).strict();
export const EvaluationAdmissionSchema = z.object({
  version: z.literal('1'), admissionId: EvidenceIdSchema, attemptId: EvidenceIdSchema, runId: EvidenceIdSchema,
  taskId: TaskIdSchema, taskVersion: z.string(), fixtureVersion: z.string(), dataset: DatasetIdentitySchema,
  arm: ArmSchema,
  evaluatorSha256: EvidenceDigestSchema, producer: EvidenceProducerSchema, admittedAt: z.string().datetime(), parentAttemptId: EvidenceIdSchema.nullable(),
  versions: z.object({ productSha256: EvidenceDigestSchema.nullable(), harnessSha256: EvidenceDigestSchema, modelConfigSha256: EvidenceDigestSchema, toolPolicySha256: EvidenceDigestSchema }).strict(),
  datasetMember: DatasetMemberAdmissionSchema.optional(), experiment: ExperimentAdmissionBindingSchema.optional(),
  capture: z.object({ keyId: z.string().min(1), publicKeySha256: EvidenceDigestSchema }).strict().optional(),
}).strict();
export type EvaluationAdmission = z.infer<typeof EvaluationAdmissionSchema>;
const FailureSchema = z.object({ category: z.string(), message: z.string(), evidence: z.array(z.string()) }).strict();
export const EvaluationAttemptSchema = z.object({
  version: z.literal('1'), attemptId: EvidenceIdSchema, admissionId: EvidenceIdSchema, runId: EvidenceIdSchema,
  startedAt: z.string().datetime(), sealedAt: z.string().datetime(), status: z.enum(['succeeded', 'failed', 'interrupted', 'incomplete']), failure: FailureSchema.nullable(),
  executionFailure: FailureSchema.nullable().default(null),
  stageEvents: z.array(z.object({ type: z.string(), eventId: z.string() }).strict()), requirementRevisions: z.array(z.string()),
  inputAvailability: z.array(z.string()), usage: UsageSchema,
  actualVersions: z.object({ productSha256: EvidenceDigestSchema.nullable(), codeImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable() }).strict().default({ productSha256: null, codeImageDigest: null }),
}).strict();
export type EvaluationAttempt = z.infer<typeof EvaluationAttemptSchema>;
const SnapshotSchema = z.object({ fixtureId: z.string(), fixtureVersion: z.string(), capturedAt: z.string(), semanticHash: z.string(), entities: z.array(FixtureEntitySchema), receipts: z.array(FixtureReceiptSchema), publicFiles: z.record(EvidencePathSchema, z.string()) }).strict();
export const FrozenGradeInputSchema = z.object({
  version: z.literal('1'), taskId: TaskIdSchema, taskVersion: z.string(),
  allowedTargets: z.array(TargetSchema).default([]),
  fixture: z.object({ fixtureId: z.string(), fixtureVersion: z.string(), workspaceId: z.string(), targets: z.record(z.string(), TargetSchema), isolation: z.object({ verified: z.boolean(), proofDigest: z.string(), checks: z.array(CheckResultSchema) }).strict().nullable() }).strict(),
  before: SnapshotSchema, after: SnapshotSchema, events: z.array(BenchEventSchema),
  omittedInputs: z.array(z.literal('full-authority')).min(1),
}).strict();
export type FrozenGradeInput = z.infer<typeof FrozenGradeInputSchema>;
/** V2 splits compact UTF-8 JSON bytes, not events: even a single large event is lossless.
 * No compression, deduplication or model-supplied references are interpreted. */
export const EVIDENCE_ARCHIVE_BOUNDS = {
  fileBytes: 64 * 1024 * 1024, chunkBytes: 4 * 1024 * 1024, chunks: 128,
  expandedInputBytes: 512 * 1024 * 1024, archiveBytes: 640 * 1024 * 1024,
} as const;
const ArtifactFileSchema = z.object({ path: EvidencePathSchema, sha256: EvidenceDigestSchema, bytes: z.number().int().nonnegative().max(EVIDENCE_ARCHIVE_BOUNDS.fileBytes) }).strict();
export const FrozenGradeInputChunksSchema = z.object({
  version: z.literal('2'), kind: z.literal('frozen-grade-input-chunks'), encoding: z.literal('utf8-json'),
  bytes: z.number().int().positive().max(EVIDENCE_ARCHIVE_BOUNDS.expandedInputBytes), sha256: EvidenceDigestSchema,
  eventCount: z.number().int().nonnegative().safe(), chunkCount: z.number().int().positive().max(EVIDENCE_ARCHIVE_BOUNDS.chunks),
  chunks: z.array(ArtifactFileSchema).min(1).max(EVIDENCE_ARCHIVE_BOUNDS.chunks),
}).strict().superRefine((input, context) => {
  if (input.chunkCount !== input.chunks.length || input.chunkCount !== Math.ceil(input.bytes / EVIDENCE_ARCHIVE_BOUNDS.chunkBytes)) context.addIssue({ code: 'custom', message: 'Invalid input chunk count' });
  let total = 0;
  for (const [index, chunk] of input.chunks.entries()) {
    const expectedBytes = Math.min(EVIDENCE_ARCHIVE_BOUNDS.chunkBytes, input.bytes - total);
    if (chunk.path !== `inputs-${String(index).padStart(6, '0')}.bin` || chunk.bytes !== expectedBytes || expectedBytes <= 0) context.addIssue({ code: 'custom', path: ['chunks', index], message: 'Input chunk order, path or byte count differs' });
    total += chunk.bytes;
  }
  if (total !== input.bytes) context.addIssue({ code: 'custom', message: 'Input expanded byte count differs' });
});
export type FrozenGradeInputChunks = z.infer<typeof FrozenGradeInputChunksSchema>;
const manifestFields = {
  attemptId: EvidenceIdSchema, admissionId: EvidenceIdSchema, producer: EvidenceProducerSchema,
  createdAt: z.string().datetime(), access: z.literal('private-local-review'), retention: z.literal('operator-managed-no-public-export'),
  authenticity: z.literal('byte-identity-only-not-authorization'),
};
// Historical sealed bytes/signatures remain v1; they are read explicitly, never migrated.
export const ArtifactManifestSchema = z.discriminatedUnion('version', [
  z.object({ ...manifestFields, version: z.literal('1'), representation: z.literal('private-host-capture-v1'), files: z.array(ArtifactFileSchema).min(4).max(100) }).strict(),
  z.object({ ...manifestFields, version: z.literal('2'), representation: z.literal('private-host-capture-chunks-v2'), files: z.array(ArtifactFileSchema).min(4).max(160) }).strict(),
]);
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
export const CriterionGradeSchema = z.object({ criterionId: z.string().min(1), required: z.boolean(), status: z.enum(['passed', 'failed', 'not-evaluable', 'not-applicable']), reason: z.string().nullable(), evidence: z.array(z.string()), taskVersion: z.string(), requirementRevision: z.string() }).strict();
export const GradeRunSchema = z.object({
  version: z.literal('1'), gradeId: EvidenceIdSchema, attemptId: EvidenceIdSchema.nullable(), manifestSha256: EvidenceDigestSchema.nullable(),
  evaluatorSha256: EvidenceDigestSchema, calibrationSha256: EvidenceDigestSchema.nullable(), previousGradeId: EvidenceIdSchema.nullable(), createdAt: z.string().datetime(),
  kind: z.enum(['initial', 'regrade']), status: z.enum(['passed', 'failed', 'not-evaluable']), releaseEligible: z.boolean(),
  criteria: z.array(CriterionGradeSchema).min(1), executionFailure: FailureSchema.nullable(),
}).strict().superRefine((grade, context) => {
  if (new Set(grade.criteria.map(item => item.criterionId)).size !== grade.criteria.length) context.addIssue({ code: 'custom', path: ['criteria'], message: 'Duplicate criterion identity' });
  const identified = grade.attemptId !== null && grade.manifestSha256 !== null && grade.criteria.some(item => item.required);
  const evaluated = identified && grade.criteria.every(item => !item.required || item.status === 'passed' || item.status === 'failed');
  const successful = evaluated && grade.executionFailure === null && grade.criteria.every(item => !item.required || item.status === 'passed');
  if (grade.status === 'passed' && !successful || grade.releaseEligible && (grade.kind !== 'initial' || !evaluated || grade.status === 'not-evaluable' || grade.calibrationSha256 === null)) context.addIssue({ code: 'custom', path: ['status'], message: 'Partial, replay or uncalibrated evidence cannot establish original release-quality evidence' });
});
export type GradeRun = z.infer<typeof GradeRunSchema>;

export const SealedHostCaptureSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('dovspace-bench-sealed-capture-v1'), producer: z.literal('host-runner'),
  arm: ArmSchema,
  admissionId: EvidenceIdSchema, attemptId: EvidenceIdSchema, runId: EvidenceIdSchema, admissionSha256: EvidenceDigestSchema,
  manifestSha256: EvidenceDigestSchema, gradeId: EvidenceIdSchema, gradeSha256: EvidenceDigestSchema,
  evaluatorSha256: EvidenceDigestSchema, calibrationSha256: EvidenceDigestSchema.nullable(), experiment: ExperimentAdmissionBindingSchema,
  gradingInfrastructureComplete: z.boolean(),
  dataset: DatasetIdentitySchema, datasetMember: DatasetMemberAdmissionSchema,
  actualVersions: z.object({ productSha256: EvidenceDigestSchema.nullable(), codeImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable() }).strict(),
  populationProofSha256: EvidenceDigestSchema.nullable(),
  model: z.object({ providerRequests: z.number().int().nonnegative().nullable(), modelCalls: z.number().int().nonnegative().nullable(), effectiveModelSettingsHash: EvidenceDigestSchema.nullable(), inferenceObserved: z.boolean() }).strict(),
}).strict();
