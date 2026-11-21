import { captureDigest } from './capture.ts';
import { z } from 'zod';
import { ArmSchema } from '../schemas/types.ts';

export const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
export const Instant = z.iso.datetime();
export function evaluationDigest(value: unknown): string {
  return captureDigest(value);
}
export { CaptureKeySchema } from './capture.ts';
export const EvaluationIdentitySchema = z.object({
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  sourceState: z.enum(['committed-clean', 'dirty-uncommitted']), baseSourceSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  productSha256: Digest, harnessSha256: Digest, modelConfigSha256: Digest, toolPolicySha256: Digest, arm: ArmSchema,
}).strict().superRefine((value, ctx) => {
  if (value.sourceState === 'committed-clean' && (value.sourceSha === null || value.baseSourceSha !== undefined)) ctx.addIssue({ code: 'custom', message: 'Committed clean identity requires its actual source commit, without a dirty-base substitute' });
  if (value.sourceState === 'dirty-uncommitted' && value.sourceSha !== null) ctx.addIssue({ code: 'custom', message: 'Uncommitted snapshot must not claim an executed Git commit; keep actual HEAD as baseSourceSha provenance only' });
});
export type EvaluationIdentity = z.infer<typeof EvaluationIdentitySchema>;
export const DatasetReferenceSchema = z.object({ datasetId: Identifier, version: Identifier, digest: Digest }).strict();
export const ExperimentControlsSchema = z.object({ environmentSha256: Digest, budgetSha256: Digest, permissionsSha256: Digest,
  fixtureSemanticSha256: Digest, fixtureVersion: Identifier, controlTransport: z.enum(['http', 'cli']) }).strict();
export const ExperimentSchema = z.object({
  experimentId: Identifier, preregisteredAt: Instant, dataset: DatasetReferenceSchema,
  candidate: EvaluationIdentitySchema, baseline: EvaluationIdentitySchema,
  treatment: z.enum(['productSha256', 'modelConfigSha256', 'toolPolicySha256', 'arm']),
  cells: z.array(z.object({ cellId: Identifier, pairId: Identifier, cohort: Identifier, taskId: Identifier,
    taskVersion: Identifier, variant: z.enum(['baseline', 'candidate']), arm: ArmSchema, order: z.union([z.literal(0), z.literal(1)]),
    requiredCriterionIds: z.array(Identifier).min(1), requiredRequirementRevisions: z.array(Identifier).min(1), controls: ExperimentControlsSchema,
  }).strict()).min(2),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.cells.map(cell => cell.cellId)).size !== value.cells.length) ctx.addIssue({ code: 'custom', message: 'Duplicate experiment cell' });
  for (const key of ['productSha256', 'harnessSha256', 'modelConfigSha256', 'toolPolicySha256', 'arm'] as const) {
    if (key !== value.treatment && value.candidate[key] !== value.baseline[key]) ctx.addIssue({ code: 'custom', message: `Unregistered second treatment: ${key}` });
  }
  if (value.candidate[value.treatment] === value.baseline[value.treatment]) ctx.addIssue({ code: 'custom', message: 'Treatment identities must differ' });
  if (value.treatment === 'arm' && (value.candidate.sourceSha !== value.baseline.sourceSha || value.candidate.sourceState !== value.baseline.sourceState
    || value.candidate.baseSourceSha !== value.baseline.baseSourceSha)) ctx.addIssue({ code: 'custom', message: 'Arm-only comparison requires the same exact source identity, not a code fork' });
  for (const [index, cell] of value.cells.entries()) if (cell.arm !== value[cell.variant].arm) ctx.addIssue({ code: 'custom', path: ['cells', index, 'arm'], message: 'Actual cell arm differs from its preregistered variant identity' });
  for (const pairId of new Set(value.cells.map(cell => cell.pairId))) {
    const pair = value.cells.filter(cell => cell.pairId === pairId), first = pair[0];
    if (pair.length !== 2 || new Set(pair.map(cell => cell.variant)).size !== 2 || new Set(pair.map(cell => cell.order)).size !== 2
      || pair.some(cell => cell.taskId !== first?.taskId || cell.taskVersion !== first.taskVersion || cell.cohort !== first.cohort
        || evaluationDigest(cell.requiredCriterionIds) !== evaluationDigest(first.requiredCriterionIds)
        || evaluationDigest(cell.controls) !== evaluationDigest(first.controls)
        || evaluationDigest(cell.requiredRequirementRevisions) !== evaluationDigest(first.requiredRequirementRevisions))) {
      ctx.addIssue({ code: 'custom', message: `Incomplete or inconsistent preregistered pair: ${pairId}` });
    }
  }
});
export type EvaluationExperiment = z.infer<typeof ExperimentSchema>;
