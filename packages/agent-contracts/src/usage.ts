// Adapted from t3code usage.ts/providerUsageLimits.ts/settings.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const amount = z.number().finite().nonnegative();
const id = z.string().trim().min(1).max(512);
export const USAGE_CONTRACT_VERSION = 6 as const;
export const usageProviderKindSchema = z.enum(["codex", "claude", "grok", "fx", "cursor", "opencode", "antigravity", "pi", "omp", "muse", "acpRegistry"]);
export type UsageProviderKind = z.infer<typeof usageProviderKindSchema>;
export type UsageSpeed = "standard" | "fast" | "ultrafast";
/** Input categories are disjoint. Reasoning is a subset of output, not extra tokens. */
export const usageTokenTotalsSchema = z.object({ uncachedInputTokens: count, cachedInputTokens: count, cacheCreationTokens: count, outputTokens: count, reasoningTokens: count });
export type UsageTokenTotals = z.infer<typeof usageTokenTotalsSchema>;
export const usageCategoryCostSchema = z.object({ input: amount, cacheRead: amount, cacheWrite: amount, output: amount });
export type UsageCategoryCost = z.infer<typeof usageCategoryCostSchema>;
export const usageCostSourceSchema = z.enum(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = z.infer<typeof usageCostSourceSchema>;
export const usageBucketSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), hourStart: z.string().optional(), provider: usageProviderKindSchema,
  model: id, sourcePath: z.string().optional(), totals: usageTokenTotalsSchema, costUsd: amount, cacheSavingsUsd: amount,
  categoryCostUsd: usageCategoryCostSchema.optional(), fastCostUsd: amount.optional(), ultrafastCostUsd: amount.optional(), speedPremiumUsd: amount.optional(),
  costSource: usageCostSourceSchema, records: count, unpricedRecords: count, sessions: count,
  providerReportedRecords: count.optional(),
});
export type UsageBucket = z.infer<typeof usageBucketSchema>;
export const usageSourceFingerprintSchema = z.object({ hostId: z.string(), provider: usageProviderKindSchema, resolvedHomePath: z.string(), volumeId: z.string() });
export type UsageSourceFingerprint = z.infer<typeof usageSourceFingerprintSchema>;
export const usageSourceSchema = z.object({
  fingerprint: usageSourceFingerprintSchema, status: z.enum(["ok", "missing", "partial", "failed"]),
  scannedFiles: count, skippedFiles: count, malformedRecords: count, distinctSessions: count,
  message: z.string().nullable(), action: z.literal("enableCursorKeychain").optional(), refreshing: z.literal(true).optional(),
  instanceIds: z.array(id).optional(), label: z.string().optional(),
});
export type UsageSource = z.infer<typeof usageSourceSchema>;
export const usagePricingSchema = z.object({ status: z.enum(["fresh", "cached", "unavailable"]), source: z.string(), fetchedAt: z.string().nullable(), knownModels: count });
export type UsagePricing = z.infer<typeof usagePricingSchema>;
export const usageSummaryInputSchema = z.object({
  sinceDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), untilDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timeZone: z.string().min(1).max(128),
  resolution: z.enum(["day", "hour"]).optional(), sinceTime: z.string().optional(), untilTime: z.string().optional(),
  awaitRefresh: z.boolean().optional(), instanceIds: z.array(id).max(100).optional(),
}).strict();
export type UsageSummaryInput = z.infer<typeof usageSummaryInputSchema>;
export const usageSummarySchema = z.object({
  contractVersion: z.number(), readAt: z.string(), timeZone: z.string(), sinceDay: z.string(), untilDay: z.string(),
  buckets: z.array(usageBucketSchema), sources: z.array(usageSourceSchema), pricing: usagePricingSchema, scanDurationMs: count,
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
export const usageModelPriceOverrideSchema = z.object({
  inputCostPerMillionTokens: amount, outputCostPerMillionTokens: amount,
  cacheReadCostPerMillionTokens: amount.optional(), cacheWriteCostPerMillionTokens: amount.optional(),
}).strict();
export type UsageModelPriceOverride = z.infer<typeof usageModelPriceOverrideSchema>;
export const usageSettingsSchema = z.object({
  revision: count, usagePriceOverrides: z.record(id, usageModelPriceOverrideSchema), usageModelAliases: z.record(id, id),
  cursorKeychainUsageEnabled: z.boolean(),
}).strict();
export type UsageSettings = z.infer<typeof usageSettingsSchema>;
export const usageSettingsUpdateSchema = z.object({
  revision: count, usagePriceOverrides: z.record(id, usageModelPriceOverrideSchema.nullable()).optional(),
  usageModelAliases: z.record(id, id.nullable()).optional(), cursorKeychainUsageEnabled: z.boolean().optional(),
}).strict();
export type UsageSettingsUpdate = z.infer<typeof usageSettingsUpdateSchema>;
export const serverProviderUsageWindowSchema = z.object({
  id, kind: z.enum(["session", "weekly", "monthly", "other"]), label: z.string(), usedPercent: z.number().finite().min(0).max(100),
  resetsAt: z.string().optional(), windowDurationMins: count.optional(),
});
export type ServerProviderUsageWindow = z.infer<typeof serverProviderUsageWindowSchema>;
export const serverProviderResetCreditsSchema = z.object({ availableCount: count, nextExpiresAt: z.string().optional(), nextCreditId: id.optional() });
export type ServerProviderResetCredits = z.infer<typeof serverProviderResetCreditsSchema>;
export const serverProviderUsageLimitsSchema = z.object({
  checkedAt: z.string(), lastProbeAt: z.string().optional(), windows: z.array(serverProviderUsageWindowSchema), credentialFingerprint: z.string().optional(),
  account: z.object({ id: z.string().optional(), email: z.string().optional(), plan: z.string().optional(), workspaceId: z.string().optional() }).optional(),
  resetCredits: serverProviderResetCreditsSchema.optional(), externalUsage: z.object({ label: z.string(), url: z.string() }).optional(),
  unavailable: z.object({ reason: z.enum(["unsupported", "probeFailed"]), message: z.string().optional() }).optional(),
});
export type ServerProviderUsageLimits = z.infer<typeof serverProviderUsageLimitsSchema>;
export type ProviderUsageLimitsUpdate = { windows: ServerProviderUsageWindow[] };
export const providerConsumeResetCreditInputSchema = z.union([
  z.object({ instanceId: id }).strict(), z.object({ sourceId: id, accountId: id, creditId: id }).strict(),
]);
export type ProviderConsumeResetCreditInput = z.infer<typeof providerConsumeResetCreditInputSchema>;
export const providerConsumeResetCreditResultSchema = z.object({ outcome: z.enum(["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]), warning: z.string().optional() });
export type ProviderConsumeResetCreditResult = z.infer<typeof providerConsumeResetCreditResultSchema>;
export const usageLimitSourceAccountSchema = z.object({ id, driver: usageProviderKindSchema, email: z.string().optional(), plan: z.string().optional(), workspaceId: z.string().optional(), usageLimits: serverProviderUsageLimitsSchema });
export type UsageLimitSourceAccount = z.infer<typeof usageLimitSourceAccountSchema>;
export const usageLimitSourceSnapshotSchema = z.object({ id, kind: z.literal("cliproxy"), label: z.string(), checkedAt: z.string(), accounts: z.array(usageLimitSourceAccountSchema), error: z.string().optional() });
export type UsageLimitSourceSnapshot = z.infer<typeof usageLimitSourceSnapshotSchema>;
export const usageLimitsReportSchema = z.object({
  createdAt: z.string(), accounts: z.array(z.object({
    id, driver: usageProviderKindSchema, label: z.string(), plan: z.string().optional(), email: z.string().optional(),
    sourceLabel: z.string().optional(), instanceId: id.optional(), instanceIds: z.array(id).optional(), resetCreditInput: providerConsumeResetCreditInputSchema.optional(),
    displayName: z.string().optional(), accentColor: z.string().optional(), limits: serverProviderUsageLimitsSchema,
  })), notices: z.array(z.string()),
});
export type UsageLimitsReport = z.infer<typeof usageLimitsReportSchema>;
/** managementKey is write-only on HTTP; omitted preserves the configured secret. */
export const usageLimitSourceInputSchema = z.object({
  kind: z.literal("cliproxy"), label: z.string().trim().min(1).max(200), url: z.string().url().max(2048),
  enabled: z.boolean(), managementKey: z.string().max(16000).optional(), clearManagementKey: z.boolean().optional(), revision: count.optional(),
}).strict();
export type UsageLimitSourceInput = z.infer<typeof usageLimitSourceInputSchema>;
export const usageLimitSourceViewSchema = z.object({ id, kind: z.literal("cliproxy"), label: z.string(), url: z.string(), enabled: z.boolean(), revision: count, managementKeyConfigured: z.boolean() });
export type UsageLimitSourceView = z.infer<typeof usageLimitSourceViewSchema>;
export const contextWindowUsageSchema = z.object({
  usedTokens: count, maxTokens: count.positive().optional(), autoCompactThreshold: count.positive().optional(),
  updatedAt: z.string(), model: z.string().optional(), promptCacheTtlMs: count.optional(),
});
export type ContextWindowUsage = z.infer<typeof contextWindowUsageSchema>;
/** Actual per-turn provider counters with incomplete categorization. Input retains
 * native semantics: do not sum categories or price these without a canonical turn. */
export const reportedTurnUsageSchema = z.object({
  inputTokens: count, outputTokens: count, cachedInputTokens: count.optional(),
  cacheCreationTokens: count.optional(), reasoningTokens: count.optional(),
});
export type ReportedTurnUsage = z.infer<typeof reportedTurnUsageSchema>;
export const nativeUsageUpdateSchema = z.object({
  turn: z.object({ totals: usageTokenTotalsSchema, model: z.string().optional(), costUsd: amount.optional(), speed: z.enum(["standard", "fast", "ultrafast"]).optional() }).optional(),
  reportedTurn: reportedTurnUsageSchema.optional(),
  context: contextWindowUsageSchema.optional(), limits: z.object({ windows: z.array(serverProviderUsageWindowSchema) }).optional(),
});
export type NativeUsageUpdate = z.infer<typeof nativeUsageUpdateSchema>;
export const threadUsageSnapshotSchema = z.object({
  threadId: id, generationId: id.optional(), providerInstanceId: id.optional(), model: z.string().optional(), updatedAt: z.string().optional(),
  totals: usageTokenTotalsSchema.optional(), costUsd: amount.optional(), context: contextWindowUsageSchema.optional(),
  reportedTurn: reportedTurnUsageSchema.optional(),
});
export type ThreadUsageSnapshot = z.infer<typeof threadUsageSnapshotSchema>;
