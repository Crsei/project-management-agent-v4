// Adapted from t3code usageAggregation.ts and UsageService.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { UsageBucket, UsageCategoryCost, UsageSettings, UsageSource, UsageSummaryInput, UsageTokenTotals } from "@agent-workspace/contracts/usage";
import { cacheSavingsUsd, priceUsage, type RateTable } from "./pricing.ts";
import { EMPTY_TOTALS, type UsageScan } from "./types.ts";

export interface AggregationPricing {
  table: RateTable;
  overrides?: RateTable;
  aliases?: UsageSettings["usageModelAliases"];
}

const HOUR_MS = 60 * 60 * 1000;
const QUARTER_HOUR_MS = 15 * 60 * 1000;

function dayFormatter(timeZone: string): (timestampMs: number) => string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  const days = new Map<number, string | null>();
  return (timestampMs) => {
    const slot = Math.floor(timestampMs / QUARTER_HOUR_MS);
    let day = days.get(slot);
    if (day === undefined) {
      const first = formatter.format(new Date(slot * QUARTER_HOUR_MS));
      const last = formatter.format(new Date((slot + 1) * QUARTER_HOUR_MS - 1));
      day = first === last ? first : null;
      days.set(slot, day);
    }
    return day ?? formatter.format(new Date(timestampMs));
  };
}

function resolveAlias(model: string, aliases: AggregationPricing["aliases"]): string {
  if (!aliases || !Object.hasOwn(aliases, model)) return model;
  const seen = new Set<string>();
  let target = model;
  while (Object.hasOwn(aliases, target)) {
    if (seen.has(target)) return model;
    seen.add(target);
    target = aliases[target]!;
  }
  return target;
}

interface MutableBucket {
  day: string;
  hourStart?: string;
  provider: UsageBucket["provider"];
  model: string;
  sourcePath: string;
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  categoryCostUsd: UsageCategoryCost | null;
  fastCostUsd: number;
  ultrafastCostUsd: number;
  speedPremiumUsd: number;
  records: number;
  unpricedRecords: number;
  providerReportedRecords: number;
  sessions: Set<string>;
}

function roundUsd(value: number): number { return Math.round(value * 1e6) / 1e6; }

/** Aggregate the already-authorized scans; native/ledger precedence is resolved by the caller. */
export function aggregateUsage(scans: UsageScan[], input: UsageSummaryInput, pricing: AggregationPricing): { buckets: UsageBucket[]; sources: UsageSource[] } {
  const toDay = dayFormatter(input.timeZone);
  const hourly = input.resolution === "hour";
  const sinceTime = hourly && input.sinceTime !== undefined ? Date.parse(input.sinceTime) : NaN;
  const untilTime = hourly && input.untilTime !== undefined ? Date.parse(input.untilTime) : NaN;
  if (hourly && (!Number.isFinite(sinceTime) || !Number.isFinite(untilTime) || untilTime <= sinceTime)) {
    throw new Error("Hourly usage aggregation requires valid exact time bounds");
  }
  const buckets = new Map<string, MutableBucket>();
  const sources = new Map<string, { source: UsageSource; sessions: Set<string>; occurrences: Map<string, number> }>();
  const seen = new Set<string>();
  const selected = input.instanceIds === undefined ? null : new Set(input.instanceIds);

  for (const scan of scans) {
    const ids = scan.source.instanceIds;
    if (selected && ids && !ids.some((id) => selected.has(id))) continue;
    const fingerprint = scan.source.fingerprint;
    const sourceKey = /^\d+:\d+$/.test(fingerprint.volumeId)
      ? JSON.stringify([fingerprint.hostId, fingerprint.provider, fingerprint.volumeId])
      : JSON.stringify([fingerprint.hostId, fingerprint.provider, fingerprint.resolvedHomePath, fingerprint.volumeId]);
    let state = sources.get(sourceKey);
    if (!state) {
      state = { source: { ...scan.source, ...(ids ? { instanceIds: [...ids] } : {}), distinctSessions: 0 }, sessions: new Set(), occurrences: new Map() };
      sources.set(sourceKey, state);
    } else {
      const source = state.source;
      if (ids) source.instanceIds = [...new Set([...(source.instanceIds ?? []), ...ids])];
      // The same physical source may be scanned for multiple configured instances.
      source.scannedFiles = Math.max(source.scannedFiles, scan.source.scannedFiles);
      source.skippedFiles = Math.max(source.skippedFiles, scan.source.skippedFiles);
      source.malformedRecords = Math.max(source.malformedRecords, scan.source.malformedRecords);
      if (source.status === "missing" && scan.source.status !== "missing") {
        source.status = scan.source.status;
        source.message = scan.source.message;
      }
    }
    const occurrences = new Map<string, number>();
    for (const original of scan.records) {
      if (selected && original.instanceId && !selected.has(original.instanceId) && !(ids?.some((id) => selected.has(id)))) continue;
      if (!Number.isFinite(original.timestampMs)) continue;
      if (hourly && (original.timestampMs < sinceTime || original.timestampMs >= untilTime)) continue;
      const day = toDay(original.timestampMs);
      if (!hourly && (day < input.sinceDay || day > input.untilDay)) continue;
      if (original.dedupeKey !== null) {
        const dedupeKey = JSON.stringify([original.provider, original.dedupeKey]);
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
      } else {
        // Preserve equal events within one scan, while avoiding copied physical-source scans.
        const key = JSON.stringify([original.provider, original.timestampMs, original.model, original.rateModel ?? null, original.sessionId, original.totals, original.reportedCostUsd, original.speed, original.nativeTurnId ?? null]);
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        if (occurrence <= (state.occurrences.get(key) ?? 0)) continue;
      }
      const model = resolveAlias(original.model, pricing.aliases);
      let record = original;
      if (model !== original.model) {
        const { rateModel: _rateModel, ...rest } = original;
        record = { ...rest, model };
      }
      const hourStart = hourly ? new Date(sinceTime + Math.floor((record.timestampMs - sinceTime) / HOUR_MS) * HOUR_MS).toISOString() : undefined;
      const sourcePath = state.source.fingerprint.resolvedHomePath;
      const key = JSON.stringify([day, hourStart ?? "", record.provider, model, sourcePath]);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { day, ...(hourStart ? { hourStart } : {}), provider: record.provider, model, sourcePath, totals: { ...EMPTY_TOTALS }, costUsd: 0, cacheSavingsUsd: 0, categoryCostUsd: null, fastCostUsd: 0, ultrafastCostUsd: 0, speedPremiumUsd: 0, records: 0, unpricedRecords: 0, providerReportedRecords: 0, sessions: new Set() };
        buckets.set(key, bucket);
      }
      const priced = priceUsage(pricing.table, record, pricing.overrides);
      bucket.totals.uncachedInputTokens += record.totals.uncachedInputTokens;
      bucket.totals.cachedInputTokens += record.totals.cachedInputTokens;
      bucket.totals.cacheCreationTokens += record.totals.cacheCreationTokens;
      bucket.totals.outputTokens += record.totals.outputTokens;
      bucket.totals.reasoningTokens += record.totals.reasoningTokens;
      bucket.costUsd += priced.costUsd;
      bucket.cacheSavingsUsd += cacheSavingsUsd(pricing.table, record, pricing.overrides);
      if (priced.categoryCostUsd !== null) {
        const category = bucket.categoryCostUsd ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
        category.input += priced.categoryCostUsd.input;
        category.cacheRead += priced.categoryCostUsd.cacheRead;
        category.cacheWrite += priced.categoryCostUsd.cacheWrite;
        category.output += priced.categoryCostUsd.output;
      }
      if (record.speed === "fast") bucket.fastCostUsd += priced.costUsd;
      if (record.speed === "ultrafast") bucket.ultrafastCostUsd += priced.costUsd;
      bucket.speedPremiumUsd += priced.speedPremiumUsd;
      bucket.records++;
      if (priced.costSource === "unpriced") bucket.unpricedRecords++;
      if (priced.costSource === "providerReported") bucket.providerReportedRecords++;
      if (record.sessionId) { bucket.sessions.add(record.sessionId); state.sessions.add(record.sessionId); }
    }
    for (const [key, count] of occurrences) state.occurrences.set(key, Math.max(state.occurrences.get(key) ?? 0, count));
  }
  const result: UsageBucket[] = [];
  for (const bucket of buckets.values()) {
    const category = bucket.categoryCostUsd;
    const fast = roundUsd(bucket.fastCostUsd), ultrafast = roundUsd(bucket.ultrafastCostUsd), premium = roundUsd(Math.max(0, bucket.speedPremiumUsd));
    result.push({ day: bucket.day, ...(bucket.hourStart ? { hourStart: bucket.hourStart } : {}), provider: bucket.provider, model: bucket.model, ...(bucket.sourcePath ? { sourcePath: bucket.sourcePath } : {}), totals: bucket.totals, costUsd: bucket.costUsd, cacheSavingsUsd: Math.max(0, bucket.cacheSavingsUsd), ...(category ? { categoryCostUsd: { input: roundUsd(category.input), cacheRead: roundUsd(category.cacheRead), cacheWrite: roundUsd(category.cacheWrite), output: roundUsd(category.output) } } : {}), ...(fast ? { fastCostUsd: fast } : {}), ...(ultrafast ? { ultrafastCostUsd: ultrafast } : {}), ...(premium ? { speedPremiumUsd: premium } : {}), costSource: bucket.unpricedRecords === bucket.records ? "unpriced" : bucket.providerReportedRecords === bucket.records ? "providerReported" : "modelPriced", records: bucket.records, unpricedRecords: bucket.unpricedRecords, sessions: bucket.sessions.size });
  }
  result.sort((a, b) => a.day.localeCompare(b.day) || (a.hourStart ?? "").localeCompare(b.hourStart ?? "") || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || (a.sourcePath ?? "").localeCompare(b.sourcePath ?? ""));
  return { buckets: result, sources: [...sources.values()].map(({ source, sessions }) => ({ ...source, distinctSessions: sessions.size })) };
}
