import { z } from 'zod';

export const ArmSchema = z.enum(['raw', 'knowledge', 'dovspace']);
export type Arm = z.infer<typeof ArmSchema>;
export const TaskIdSchema = z.enum(['K01', 'K02', 'K03', 'K04', 'D01', 'D02', 'D03', 'D04', 'L01', 'L02', 'L03', 'L04']);
export type TaskId = z.infer<typeof TaskIdSchema>;
export const TASK_IDS = TaskIdSchema.options;
export const BudgetSchema = z.object({ maxDurationMinutes: z.number().positive(), maxModelCalls: z.number().int().positive(), maxToolCalls: z.number().int().positive(), maxCostUsd: z.number().positive().nullable().default(null) });
export type Budget = z.infer<typeof BudgetSchema>;
export const TargetSchema = z.object({ key: z.string(), workspaceId: z.string(), projectId: z.string().nullable(), entityId: z.string(), revision: z.string(), kind: z.string() });
export type FixtureTarget = z.infer<typeof TargetSchema>;
export const FixtureManifestSchema = z.object({ fixtureVersion: z.string(), workspaceId: z.string(), targets: z.record(z.string(), TargetSchema) });
export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;
export const TaskDefinitionSchema = z.object({
  id: TaskIdSchema, title: z.string().min(1), taskVersion: z.string(), fixtureVersion: z.string(), category: z.enum(['knowledge', 'delivery', 'long-horizon']), instruction: z.string().min(1), budget: BudgetSchema,
  targetKeys: z.array(z.string()), inputs: z.array(z.string()), acceptanceCriteria: z.array(z.string()), smoke: z.boolean(),
  allowedTools: z.array(z.string()), allowedTargets: z.array(z.string()), phases: z.array(z.object({ id: z.string(), instruction: z.string(), requiredEvidence: z.array(z.string()) })).min(1),
  interventions: z.array(z.object({ afterPhase: z.string(), action: z.string(), trigger: z.string(), payload: z.record(z.string(), z.unknown()).optional() })), hiddenGrader: z.string(),
}).superRefine((task, context) => {
  const phaseIds = new Set(task.phases.map(phase => phase.id));
  if (phaseIds.size !== task.phases.length) context.addIssue({ code: 'custom', path: ['phases'], message: 'Phase identities must be unique' });
  for (const [index, intervention] of task.interventions.entries()) if (!phaseIds.has(intervention.afterPhase)) context.addIssue({ code: 'custom', path: ['interventions', index, 'afterPhase'], message: 'Intervention must reference an existing phase' });
});
export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;
export type ResolvedTaskDefinition = Omit<TaskDefinition, 'allowedTargets'> & { allowedTargets: FixtureTarget[] };
export const BenchEventSchema = z.object({
  id: z.string(), timestamp: z.string(), runId: z.string(), type: z.string(), source: z.enum(['runner', 'transport', 'provider', 'agent', 'grader', 'isolation']),
  taskId: z.string().optional(), scenarioId: z.string().optional(), threadId: z.string().optional(), generationId: z.string().optional(), commandId: z.string().optional(), receiptId: z.string().optional(), targetId: z.string().optional(), provider: z.string().optional(), model: z.string().optional(),
  sessionId: z.string().optional(), phaseId: z.string().optional(), operationId: z.string().optional(), toolName: z.string().optional(), data: z.record(z.string(), z.unknown()).default({}),
});
export type BenchEvent = z.infer<typeof BenchEventSchema>;
export const UsageSchema = z.object({ inputTokens: z.number().nonnegative().nullable(), outputTokens: z.number().nonnegative().nullable(), cacheReadTokens: z.number().nonnegative().nullable(), cacheWriteTokens: z.number().nonnegative().nullable(), costUsd: z.number().nonnegative().nullable(), modelCalls: z.number().int().nonnegative().nullable(), toolCalls: z.number().int().nonnegative().nullable() });
export type Usage = z.infer<typeof UsageSchema>;
export const CheckResultSchema = z.object({ id: z.string(), passed: z.boolean(), required: z.boolean().default(true), score: z.number().min(0).max(1), evidence: z.array(z.string()), reason: z.string().optional() });
export type CheckResult = z.infer<typeof CheckResultSchema>;
export const SafetyGateSchema = z.object({ passed: z.boolean(), checks: z.array(CheckResultSchema), violations: z.array(z.string()) });
export type SafetyGate = z.infer<typeof SafetyGateSchema>;
export const PhaseResultSchema = z.object({ id: z.string(), passed: z.boolean(), checks: z.array(CheckResultSchema), evidence: z.array(z.string()) });
export type PhaseResult = z.infer<typeof PhaseResultSchema>;
export const MutationSchema = z.object({ domain: z.string(), identity: z.string(), kind: z.enum(['added', 'removed', 'changed']), before: z.unknown().optional(), after: z.unknown().optional() });
export type Mutation = z.infer<typeof MutationSchema>;
export const ReproducibilitySchema = z.object({ fixtureId: z.string(), fixtureSemanticHash: z.string(), modelConfigHash: z.string(), budgetHash: z.string(), permissionsHash: z.string(), environmentHash: z.string().default('unavailable'), effectiveModelSettingsHash: z.string().nullable().default(null) });
export type Reproducibility = z.infer<typeof ReproducibilitySchema>;
export const RunResultSchema = z.object({
  runId: z.string(), taskId: z.string(), taskVersion: z.string(), fixtureVersion: z.string(), arm: ArmSchema, agent: z.string(), model: z.string(), success: z.boolean(), safetyGate: SafetyGateSchema,
  checkpointScore: z.number().min(0).max(1), phaseResults: z.array(PhaseResultSchema), usage: UsageSchema, timeMs: z.number().nonnegative(), unexpectedMutations: z.array(MutationSchema),
  artifacts: z.record(z.string(), z.string()), reproducibility: ReproducibilitySchema,
  humanInterventions: z.object({ count: z.number().int().nonnegative().nullable(), definition: z.string(), reason: z.string().nullable() }).default({ count: null, definition: 'Runner-recorded operator actions excluding scheduled benchmark interventions', reason: 'Not observed' }),
  rework: z.object({ count: z.number().int().nonnegative().nullable(), denominator: z.number().int().nonnegative().nullable().default(null), proportion: z.number().min(0).max(1).nullable().default(null), definition: z.string(), reason: z.string().nullable() }).default({ count: null, denominator: null, proportion: null, definition: 'Repeated failed PM mutation attempts with identical normalized input and unchanged authority revision, excluding receipt reads and intentional response loss; not all semantic/code rework', reason: 'Not observed' }),
  failure: z.object({ category: z.enum(['infrastructure', 'provider', 'budget', 'knowledge', 'state', 'code', 'process', 'safety', 'interrupted', 'grader', 'tool', 'permission', 'model', 'task']), message: z.string(), evidence: z.array(z.string()) }).nullable(),
}).superRefine((result, context) => {
  if (result.success && (!result.safetyGate.passed || result.unexpectedMutations.length > 0 || result.phaseResults.length === 0 || result.phaseResults.some(phase => !phase.passed || phase.checks.some(check => check.required && !check.passed)))) context.addIssue({ code: 'custom', path: ['success'], message: 'Verified success requires every independent required phase/check and a clean safety gate' });
});
export type RunResult = z.infer<typeof RunResultSchema>;

/** Host-only authority. Never include these objects or paths in an Agent prompt. */
export const FixtureEntitySchema = z.object({ key: z.string(), id: z.string(), projectId: z.string().nullable(), kind: z.string(), revision: z.string(), path: z.string(), entity: z.record(z.string(), z.unknown()), raw: z.string() });
export type FixtureEntity = z.infer<typeof FixtureEntitySchema>;
export const FixtureReceiptSchema = z.object({ operationId: z.string(), kind: z.enum(['command', 'creation', 'native']), targetId: z.string().nullable(), revision: z.string().nullable(), status: z.string(), result: z.unknown() });
export type FixtureReceipt = z.infer<typeof FixtureReceiptSchema>;
export const FixtureSnapshotSchema = z.object({ fixtureId: z.string(), fixtureVersion: z.string(), capturedAt: z.string(), semanticHash: z.string(), entities: z.array(FixtureEntitySchema), receipts: z.array(FixtureReceiptSchema), tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))), files: z.record(z.string(), z.string()), publicFiles: z.record(z.string(), z.string()), transportEvents: z.array(BenchEventSchema).optional() });
export type FixtureSnapshot = z.infer<typeof FixtureSnapshotSchema>;
export const FixtureDiffSchema = z.object({ beforeHash: z.string(), afterHash: z.string(), mutations: z.array(MutationSchema), unexpectedMutations: z.array(MutationSchema) });
export type FixtureDiff = z.infer<typeof FixtureDiffSchema>;
export type EffectiveIsolationPolicy = { networkMode: string; readOnlyRoot: boolean; user: string; capDrop: string[]; securityOpt: string[]; pidMode: string; privileged: boolean; maskedPaths: string[]; readOnlyPaths: string[]; appArmorProfile: string; nativeBoundary: string };
export type IsolationEvidence = { backend: 'docker'; verified: boolean; containerId: string; networkId: string; checks: CheckResult[]; proofDigest: string; imageIds?: Record<string, string>; effectivePolicy?: EffectiveIsolationPolicy };
export type FixtureRuntime = {
  activeSessionId?: string;
  activeGenerationId?: string;
  effectiveModelSettingsHash?: string;
  environmentHash: string;
  environmentEvidence: { sourceHash: string; sourceFileCount: number; lockfileHash: string; imageIds: Record<string, string>; nodeVersion: string; isolationPolicy: EffectiveIsolationPolicy };
  agentBaseUrl: string; agentAccessToken: string; pmCookie: string; workingDirectory: string; environment: Record<string, string>; containerId: string; isolationVerified: boolean; auditEvents: BenchEvent[];
  providerConfig: { instanceId: string; driver: string; config: Record<string, string>; environment: { name: string; value: string; sensitive: boolean }[] };
};
export type FixtureHandle = {
  fixtureId: string; fixtureVersion: string; root: string; publicRoot: string; authorityRoot: string; agentDataRoot: string;
  imageIds?: Record<string, string>;
  workspaceId: string; actorId: string; targets: Record<string, FixtureTarget>; pm: { baseUrl: string; token: string }; runtime: FixtureRuntime | null; isolation: IsolationEvidence | null;
};
export type PrepareAdapterInput = { runId: string; fixtureId: string; arm: Arm; fixture: FixtureHandle; model: string; provider: string; modelOptions?: Record<string, unknown>; allowedTools: string[]; allowedTargets: FixtureTarget[]; budget: Budget };
export interface BenchAgentAdapter {
  prepare(input: PrepareAdapterInput): Promise<void>;
  start(input: { instruction: string; taskId: string }): Promise<{ sessionId: string }>;
  observe(sessionId: string): AsyncIterable<BenchEvent>;
  interrupt(sessionId: string, reason: string): Promise<void>;
  resume(input: { priorSessionId: string; instruction: string }): Promise<{ sessionId: string }>;
  stop(sessionId: string): Promise<void>;
}
