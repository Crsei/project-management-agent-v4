// Usage presentation adapted from t3code usageBreakdown.ts and usageLimits.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { UsageBucket, UsageSummaryInput } from "@agent-workspace/contracts/usage";

export type Period = 1 | 7 | 30 | 90;

function dayAt(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (name: string) => parts.find(part => part.type === name)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function summaryInput(period: Period, timeZone: string, instanceId: string, now = new Date()): UsageSummaryInput {
  const untilDay = dayAt(now, timeZone);
  // Calendar-day windows are inclusive. 24h instead uses exact instants across DST.
  const date = new Date(`${untilDay}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (period - 1));
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return { sinceDay: period === 1 ? dayAt(since, timeZone) : date.toISOString().slice(0, 10), untilDay, timeZone,
    resolution: period === 1 ? "hour" : "day", ...(period === 1 ? { sinceTime: since.toISOString(), untilTime: now.toISOString() } : {}),
    ...(instanceId ? { instanceIds: [instanceId] } : {}) };
}

export function tokenTotal(bucket: UsageBucket): number {
  const t = bucket.totals;
  return t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens + t.outputTokens;
}

export interface UsageTotals {
  tokens: number; input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number;
  cost: number; savings: number; unpriced: number; records: number;
  costInput: number; costRead: number; costWrite: number; costOutput: number; costOther: number;
  fast: number; ultrafast: number; premium: number;
}

export function aggregate(buckets: readonly UsageBucket[]): UsageTotals {
  const result = { tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0, savings: 0, unpriced: 0, records: 0,
    costInput: 0, costRead: 0, costWrite: 0, costOutput: 0, costOther: 0, fast: 0, ultrafast: 0, premium: 0 };
  for (const b of buckets) {
    result.tokens += tokenTotal(b); result.input += b.totals.uncachedInputTokens; result.cacheRead += b.totals.cachedInputTokens;
    result.cacheWrite += b.totals.cacheCreationTokens; result.output += b.totals.outputTokens; result.reasoning += b.totals.reasoningTokens;
    result.cost += b.costUsd; result.savings += b.cacheSavingsUsd; result.unpriced += b.unpricedRecords; result.records += b.records;
    if (b.categoryCostUsd) {
      result.costInput += b.categoryCostUsd.input; result.costRead += b.categoryCostUsd.cacheRead; result.costWrite += b.categoryCostUsd.cacheWrite; result.costOutput += b.categoryCostUsd.output;
      const split = b.categoryCostUsd.input + b.categoryCostUsd.cacheRead + b.categoryCostUsd.cacheWrite + b.categoryCostUsd.output;
      const remainder = b.costUsd - split;
      // Four category additions can differ from the pricing sum by a few ULPs.
      // Do not turn arithmetic roundoff into a real "Other" charge; tiny actual costs remain visible.
      if (remainder > Number.EPSILON * Math.max(b.costUsd, split) * 8) result.costOther += remainder;
    } else result.costOther += b.costUsd;
    result.fast += b.fastCostUsd ?? 0; result.ultrafast += b.ultrafastCostUsd ?? 0; result.premium += b.speedPremiumUsd ?? 0;
  }
  return result;
}

