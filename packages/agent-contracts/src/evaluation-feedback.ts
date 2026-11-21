import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const probability = z.number().finite().min(0).max(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
export const evaluationReleaseIdentitySchema = z.strictObject({ artifactSha256: digest, sourceSha256: digest });
export const evaluationDriverSchema = z.enum(["codex", "claude", "grok", "fx", "cursor", "opencode", "antigravity", "pi", "omp", "muse", "acpRegistry", "other"]);
export const evaluationKindSchema = z.enum(["chat", "continuation", "compaction"]);
export const evaluationStatusSchema = z.enum(["pending", "completed", "failed", "cancelled", "interrupted", "observation-lost"]);
export const evaluationErrorClassSchema = z.enum(["none", "usage_limit", "authentication", "cancelled", "unsupported", "provider_error", "unknown"]);
export const evaluationPolicyInputSchema = z.strictObject({
  policyId: z.uuid(), expectedRevision: count, purpose: z.enum(["quality-regression", "release-observation"]),
  threadIds: z.array(z.string().min(1).max(256)).min(1).max(100),
  startsAt: timestamp, endsAt: timestamp, retentionDays: z.number().int().min(1).max(90),
  randomProbability: probability, failureProbability: probability, unknownProbability: probability,
  confirmedMetadataOnly: z.literal(true),
}).superRefine((value, ctx) => {
  if (Date.parse(value.endsAt) <= Date.parse(value.startsAt)) ctx.addIssue({ code: "custom", message: "Sampling requires a nonempty explicit observation interval." });
  if (new Set(value.threadIds).size !== value.threadIds.length) ctx.addIssue({ code: "custom", message: "Duplicate Session scope." });
});
export const evaluationPolicyActionSchema = z.strictObject({ policyId: z.uuid(), expectedRevision: count });
export const evaluationDeleteSchema = z.strictObject({ observationIds: z.array(z.uuid()).min(1).max(1000), reason: z.enum(["deleted", "revoked"]) });
const channel = z.strictObject({ candidate: z.boolean(), probability, selected: z.boolean() });
export const evaluationObservationSchema = z.strictObject({
  observationId: z.uuid(), clusterId: z.uuid(), policyId: z.uuid(), policyRevision: count.positive(),
  release: evaluationReleaseIdentitySchema, unit: z.literal("generation"), kind: evaluationKindSchema,
  driver: evaluationDriverSchema, configurationId: digest, samplingDesignSha256: digest, acceptedAt: timestamp, terminalAt: timestamp.nullable(),
  configurationIdentity: z.enum(["pending", "bound", "unavailable"]),
  expiresAt: timestamp,
  status: evaluationStatusSchema, errorClass: evaluationErrorClassSchema,
  random: channel, failure: channel, unknown: channel, inclusionProbability: probability,
  probabilityFinal: z.boolean(),
  usage: z.strictObject({ source: z.enum(["canonical-turn", "reported-turn", "unavailable"]), completeness: z.enum(["canonical", "partial", "unknown"]),
    inputTokens: count.nullable(), outputTokens: count.nullable(), costUsd: z.number().finite().nonnegative().nullable(), currency: z.literal("USD"), priceIdentity: z.null() }),
});
export const evaluationDenominatorSchema = z.strictObject({
  policyId: z.uuid(), policyRevision: count.positive(), release: evaluationReleaseIdentitySchema,
  kind: evaluationKindSchema, driver: evaluationDriverSchema, configurationId: digest, samplingDesignSha256: digest,
  eligible: count, pending: count, completed: count, failed: count, cancelled: count, interrupted: count, observationLost: count,
  randomCandidates: count, randomSelected: count, failureCandidates: count, failureSelected: count, unknownCandidates: count, unknownSelected: count,
  retained: count, removed: count, selectedRetained: count, labeled: z.literal(0),
});
/** Store/epoch fences invalidate every descendant; individual fences invalidate their observation descendants. No PM facts are deletion targets. */
export const evaluationFenceSchema = z.strictObject({ fenceId: z.uuid(), storeId: z.uuid(), restoreEpoch: count,
  scope: z.enum(["observations", "store-epoch"]), observationIds: z.array(z.uuid()),
  reason: z.enum(["retention", "deleted", "revoked", "restored"]), createdAt: timestamp });
export const evaluationMetadataExportSchema = z.strictObject({
  format: z.literal("agent-evaluation-metadata-v1"), schemaVersion: z.literal(1), exportId: z.uuid(),
  storeId: z.uuid(), restoreEpoch: count, exportedAt: timestamp, identityTrust: z.literal("operator-configured"), contentIncluded: z.literal(false),
  observations: z.array(evaluationObservationSchema), denominators: z.array(evaluationDenominatorSchema), fences: z.array(evaluationFenceSchema),
  coverage: z.strictObject({ status: z.enum(["complete", "incomplete"]), observerErrors: count, rejectedBeforeAcceptance: count, rejectedCoverage: z.literal("scoped-admission-rejections-only") }),
});
export const evaluationWindowInputSchema = z.strictObject({ windowId: z.uuid(), policyId: z.uuid(),
  baselineRelease: evaluationReleaseIdentitySchema, candidateRelease: evaluationReleaseIdentitySchema,
  baseline: z.strictObject({ startsAt: timestamp, endsAt: timestamp }), candidate: z.strictObject({ startsAt: timestamp, endsAt: timestamp }),
  kinds: z.array(evaluationKindSchema).min(1), drivers: z.array(evaluationDriverSchema).min(1), minimumEligiblePerCohort: count.positive(),
  maximumFailureRateIncrease: probability, maximumUnknownRateIncrease: probability, maximumTrafficShareChange: probability,
  expiresAt: timestamp, releaseDecisionSha256: digest,
}).superRefine((value, ctx) => {
  if ([value.baseline, value.candidate].some(interval => Date.parse(interval.startsAt) >= Date.parse(interval.endsAt))) ctx.addIssue({ code: "custom", message: "Observation windows must be nonempty." });
  if (Date.parse(value.baseline.endsAt) > Date.parse(value.candidate.startsAt)) ctx.addIssue({ code: "custom", message: "Baseline must precede candidate; overlapping windows are not comparable." });
  if (JSON.stringify(value.baselineRelease) === JSON.stringify(value.candidateRelease)) ctx.addIssue({ code: "custom", message: "Baseline and candidate releases must differ." });
  if (new Set(value.kinds).size !== value.kinds.length || new Set(value.drivers).size !== value.drivers.length) ctx.addIssue({ code: "custom", message: "Duplicate cohorts." });
});
export const evaluationDecisionInputSchema = z.strictObject({ decisionId: z.uuid(), windowId: z.uuid(),
  action: z.enum(["pause-sampling", "pause-dispatch-recommended", "rollback-recommended", "rollback-declined", "continue-observation"]),
  reason: z.enum(["recurrence", "behavior-drift", "traffic-drift", "collector-drift", "insufficient-evidence", "operator-review"]),
  evidenceSha256: digest, expiresAt: timestamp, confirmedNoDeployment: z.literal(true) });
export type EvaluationReleaseIdentity = z.infer<typeof evaluationReleaseIdentitySchema>;
export type EvaluationPolicyInput = z.infer<typeof evaluationPolicyInputSchema>;
export type EvaluationObservation = z.infer<typeof evaluationObservationSchema>;
export type EvaluationDenominator = z.infer<typeof evaluationDenominatorSchema>;
export type EvaluationFence = z.infer<typeof evaluationFenceSchema>;
export type EvaluationMetadataExport = z.infer<typeof evaluationMetadataExportSchema>;
export type EvaluationWindowInput = z.infer<typeof evaluationWindowInputSchema>;

const observationCohortCountsSchema = z.strictObject({ eligible: count, removed: count, pending: count, completed: count, cancelled: count, interrupted: count,
  observationLost: count, failures: count, unknown: count, randomSelected: count, clusters: count });
export const evaluationWindowSummarySchema = z.strictObject({
  format: z.literal("agent-release-observation-v1"), schemaVersion: z.literal(1), windowId: z.uuid(), storeId: z.uuid(), restoreEpoch: count,
  releaseDecisionSha256: digest, preregistrationSha256: digest,
  baselineRelease: evaluationReleaseIdentitySchema, candidateRelease: evaluationReleaseIdentitySchema,
  baselineWindow: z.strictObject({ startsAt: timestamp, endsAt: timestamp }), candidateWindow: z.strictObject({ startsAt: timestamp, endsAt: timestamp }),
  createdAt: timestamp, expiresAt: timestamp,
  lineage: z.strictObject({ observationIds: z.array(z.uuid()), earliestSourceExpiry: timestamp.nullable() }),
  thresholds: z.strictObject({ minimumEligiblePerCohort: count.positive(), maximumFailureRateIncrease: probability, maximumUnknownRateIncrease: probability, maximumTrafficShareChange: probability }),
  status: z.enum(["unknown", "drift-observed", "no-drift-observed"]), reasons: z.array(z.string()), driftReasons: z.array(z.enum(["behavior-drift", "traffic-composition-drift"])),
  cohorts: z.array(z.strictObject({
    kind: evaluationKindSchema, driver: evaluationDriverSchema, baseline: observationCohortCountsSchema, candidate: observationCohortCountsSchema,
    comparable: z.boolean(), reasons: z.array(z.string()), failureRateDifference: z.number().min(-1).max(1).nullable(), unknownRateDifference: z.number().min(-1).max(1).nullable(),
    recurrence: z.array(z.strictObject({ errorClass: evaluationErrorClassSchema, baselineOccurrences: count, candidateOccurrences: count, rootCauseConfirmed: z.literal(false) })),
    drift: z.enum(["unknown", "observed", "not-observed"]),
  })).min(1),
  traffic: z.strictObject({ baselineEligible: count, candidateEligible: count, outsideDeclaredCohorts: count, compositionChanged: z.boolean() }),
  interpretation: z.literal("Descriptive complete-denominator metadata only; no model-quality, causal root-cause, case-fixed, statistical significance or release-authorization claim. Session clustering is reported, not treated as independent tasks."),
  deploymentPerformed: z.literal(false),
});
export const evaluationWindowSummaryEnvelopeSchema = z.strictObject({ summary: evaluationWindowSummarySchema, summarySha256: digest });
export type EvaluationWindowSummary = z.infer<typeof evaluationWindowSummarySchema>;
