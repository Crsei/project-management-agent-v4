// Native usage semantics adapted from t3code provider-core/server/usage.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { UsageProviderKind, UsageSource, UsageSpeed, UsageTokenTotals, UsageSettings } from "@agent-workspace/contracts/usage";
import type { StoredProviderInstance } from "../providers/instances.ts";

export interface UsageRecord {
  provider: UsageProviderKind;
  timestampMs: number;
  model: string;
  rateModel?: string;
  sessionId: string;
  totals: UsageTokenTotals;
  reportedCostUsd: number | null;
  speed: UsageSpeed;
  unresolvedServiceTierTurnId?: string;
  dedupeKey: string | null;
  instanceId?: string;
  nativeTurnId?: string;
}
export interface UsageScan {
  source: UsageSource;
  records: UsageRecord[];
}
export interface UsageReadContext {
  instances: StoredProviderInstance[];
  sinceMs: number;
  untilMs: number;
  awaitRefresh: boolean;
  settings: UsageSettings;
  signal?: AbortSignal;
}
export const EMPTY_TOTALS: UsageTokenTotals = { uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 };
export function totalTokens(totals: UsageTokenTotals): number {
  return totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens + totals.outputTokens;
}
export function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)) : 0;
}
export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
