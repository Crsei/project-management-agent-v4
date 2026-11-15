import { z } from 'zod';
import { BenchmarkConfigSchema, parseBenchmarkConfig } from '../benchmark.config.ts';
import { ArmSchema, SourceManifestSchema } from './types.ts';
import { getTaskDefinition, RUNNABLE_TASK_IDS } from '../tasks/index.ts';

export const STUDY_VARIANTS = ['baseline', 'candidate'] as const;
export type StudyVariant = typeof STUDY_VARIANTS[number];
export const StudyConfigurationSchema = BenchmarkConfigSchema.pick({ controlTransport: true, provider: true, providerApi: true, hostAuthBoundary: true, ompModel: true, model: true, modelOptions: true, budget: true, prices: true, providerEndpoint: true, providerBinary: true, agentImage: true, codeImage: true, postgresImage: true }).extend({ provider: z.enum(['codex', 'omp']), providerApi: z.enum(['openai-responses', 'openai-completions', 'openai-codex-responses']), providerBinary: BenchmarkConfigSchema.shape.providerBinary.unwrap() }).strict().superRefine((config, context) => {
  if (!config.model.trim() || config.budget.maxCostUsd === null || config.prices?.version === undefined || config.providerEndpoint === undefined) context.addIssue({ code: 'custom', message: 'Study preregistration requires an explicit fixed model, endpoint, versioned prices/output cap and positive cost budget; credentials are never part of this manifest.' });
  if (config.provider === 'omp' && !config.ompModel) context.addIssue({ code: 'custom', path: ['ompModel'], message: 'OMP study requires explicit native model limits/reasoning metadata.' });
  if (Object.values(config.modelOptions).some(value => typeof value !== 'string' && typeof value !== 'boolean')) context.addIssue({ code: 'custom', path: ['modelOptions'], message: 'Native model options must be explicit strings or booleans, exactly as runTask admits.' });
  try { parseBenchmarkConfig(config); } catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid native/API auth, model, endpoint or output reservation controls.' }); }
});
export const TreatmentSchema = z.object({ path: z.string().min(1), baseline: z.string().regex(/^[a-f0-9]{64}$/).nullable(), candidate: z.string().regex(/^[a-f0-9]{64}$/).nullable(), rationale: z.string().min(1) }).strict();
export const StudyManifestSchema = z.object({
  kind: z.literal('pm-tools-study-manifest'), version: z.literal(1), studyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/), preregisteredAt: z.iso.datetime(),
  harnessHash: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceKind: z.enum(['model-study', 'report-fixture']), stage: z.enum(['exploration', 'confirmation']), arm: ArmSchema,
  taskIds: z.array(z.string()).min(1), repetitions: z.number().int().min(1).max(100),
  maxTotalCostUsd: z.number().positive(),
  primaryMetric: z.enum(['inputTokens', 'costUsd', 'timeMs', 'pmResultBytes']),
  samplePlan: z.object({ rationale: z.string().min(1), stoppingRule: z.literal('fixed-complete-design'), independentConfirmation: z.boolean() }).strict(),
  controls: StudyConfigurationSchema,
  observationPolicy: z.object({ collectorVersion: z.literal('pm-tools-v1'), requestLogging: z.literal('private-redacted'), optionalObservers: z.literal('disabled'), skills: z.literal('disabled'), toolLoadMode: z.literal('essential') }).strict(),
  requiredTools: z.array(z.string().regex(/^pm_[a-z_]+$/)),
  safetyEvidence: z.object({ artifactSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().describe('Unverified artifact digest declaration only. No artifact contents or candidate binding are verified here; self-declared passed/cases/semanticCoverage fields are rejected and cannot establish targeted-safety clearance.').nullable(),
  variants: z.object({ baseline: z.object({ sourceRoot: z.string().min(1), sourceManifest: SourceManifestSchema }).strict(), candidate: z.object({ sourceRoot: z.string().min(1), sourceManifest: SourceManifestSchema }).strict() }).strict(),
  treatment: z.array(TreatmentSchema).min(1),
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.taskIds).size !== manifest.taskIds.length || manifest.taskIds.some(id => !RUNNABLE_TASK_IDS.some(runnable => runnable === id))) context.addIssue({ code: 'custom', path: ['taskIds'], message: 'Tasks must be distinct executable tasks; all nine original tasks remain available.' });
  if (new Set(manifest.requiredTools).size !== manifest.requiredTools.length) context.addIssue({ code: 'custom', path: ['requiredTools'], message: 'Required tool identities must be distinct.' });
  if (manifest.stage === 'confirmation' && (!manifest.samplePlan.independentConfirmation || manifest.taskIds.length !== RUNNABLE_TASK_IDS.length)) context.addIssue({ code: 'custom', path: ['samplePlan'], message: 'Confirmation requires an independent set covering all nine unchanged tasks.' });
  if (manifest.taskIds.every(id => RUNNABLE_TASK_IDS.some(runnable => runnable === id)) && manifest.controls.budget.maxCostUsd !== null) {
    const worstCaseCost = manifest.taskIds.reduce((sum, id) => sum + Math.min(getTaskDefinition(id).budget.maxCostUsd ?? manifest.controls.budget.maxCostUsd!, manifest.controls.budget.maxCostUsd!), 0) * manifest.repetitions * 2;
    if (worstCaseCost > manifest.maxTotalCostUsd + Number.EPSILON) context.addIssue({ code: 'custom', path: ['maxTotalCostUsd'], message: 'Total explicitly authorized budget must cover the complete fixed design at enforced per-run caps; lower per-run caps rather than silently truncate attempts.' });
  }
});
export type StudyManifest = z.infer<typeof StudyManifestSchema>;
export type StudyConfiguration = z.infer<typeof StudyConfigurationSchema>;
