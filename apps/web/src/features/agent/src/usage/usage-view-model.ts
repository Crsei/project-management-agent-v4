// Adapted from t3code usageMerge.ts and usageProgress.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { USAGE_CONTRACT_VERSION, type UsageBucket, type UsageProviderKind, type UsageSource, type UsageSummary, type UsageSummaryInput } from "@agent-workspace/contracts/usage";
import { agentText } from "../i18n";
import { aggregate, type UsageTotals } from "./page-data.ts";

export type UsageMetric = "cost" | "tokens";
export type UsageSummaryRead = UsageSummary & { compatibilityWarnings?: string[] };
export interface UsageProviderView {
  provider: UsageProviderKind;
  totals: UsageTotals;
  sessions: number;
  costShare: number | null;
  tokenShare: number;
}
export interface UsageModelView {
  key: string;
  provider: UsageProviderKind;
  model: string;
  buckets: UsageBucket[];
  totals: UsageTotals;
  costShare: number | null;
  tokenShare: number;
}
export interface UsagePeriodView {
  key: string;
  day: string;
  hourStart?: string;
  totals: UsageTotals;
  byProvider: Map<UsageProviderKind, UsageTotals>;
}
export interface UsageViewModel {
  buckets: UsageBucket[];
  sources: UsageSource[];
  totals: UsageTotals;
  sessions: number;
  providers: UsageProviderView[];
  models: UsageModelView[];
  periods: UsagePeriodView[];
  costQuality: { providerReportedShare: number; modelPricedShare: number; unpricedShare: number };
  partial: boolean;
  refreshingProviders: UsageProviderKind[];
  warnings: string[];
  compatible: boolean;
}

/** Versions 4–6 use the source's merge-compatible bucket semantics. */
export function isUsageContractCompatible(version: number): boolean {
  return Number.isInteger(version) && version >= 4 && version <= USAGE_CONTRACT_VERSION;
}

function sourceKey(source: UsageSource): string {
  const f = source.fingerprint;
  return JSON.stringify([f.hostId, f.provider, f.resolvedHomePath, f.volumeId]);
}
function localDay(time: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(time);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Exact-hour instants avoid duplicated/missing local hours across a DST change. */
export function usagePeriods(input: UsageSummaryInput): { key: string; day: string; hourStart?: string }[] {
  const result: { key: string; day: string; hourStart?: string }[] = [];
  if (input.resolution === "hour") {
    const start = Date.parse(input.sinceTime ?? "");
    const end = Date.parse(input.untilTime ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 24 * 3_600_000) return result;
    for (let time = start; time < end; time += 3_600_000) {
      const hourStart = new Date(time).toISOString();
      result.push({ key: hourStart, day: localDay(time, input.timeZone), hourStart });
    }
  } else {
    const start = Date.parse(`${input.sinceDay}T00:00:00Z`);
    const end = Date.parse(`${input.untilDay}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 366 * 86_400_000) return result;
    for (let time = start; time <= end; time += 86_400_000) {
      const day = new Date(time).toISOString().slice(0, 10);
      result.push({ key: day, day });
    }
  }
  return result;
}

function shares(totals: UsageTotals, all: UsageTotals) {
  return {
    costShare: totals.records > 0 && totals.unpriced >= totals.records ? null : all.cost > 0 ? totals.cost / all.cost : 0,
    tokenShare: all.tokens > 0 ? totals.tokens / all.tokens : 0,
  };
}
function append<K>(map: Map<K, UsageBucket[]>, key: K, bucket: UsageBucket): void {
  const rows = map.get(key);
  if (rows) rows.push(bucket); else map.set(key, [bucket]);
}

/** Single-environment source ownership; the server already deduplicates native records. */
export function buildUsageView(summary: UsageSummaryRead | null, input: UsageSummaryInput, hiddenProviders: readonly UsageProviderKind[] = []): UsageViewModel {
  const compatible = summary === null || isUsageContractCompatible(summary.contractVersion);
  const warnings = [...(summary?.compatibilityWarnings ?? [])];
  if (!compatible) warnings.push(agentText(`Usage 数据版本 ${summary!.contractVersion} 与此客户端不兼容，请更新服务与页面；未合并这些数据。`, `Usage data version ${summary!.contractVersion} is incompatible with this client; update the service and page. This data was not merged.`));
  const hidden = new Set(hiddenProviders);
  const owners = new Map<string, UsageSource>();
  const rank = { ok: 0, partial: 1, failed: 2, missing: 3 };
  for (const source of compatible ? summary?.sources ?? [] : []) {
    if (hidden.has(source.fingerprint.provider)) continue;
    const key = sourceKey(source);
    const existing = owners.get(key);
    if (!existing || rank[source.status] < rank[existing.status]) owners.set(key, source);
    else if (source !== existing) warnings.push(agentText(`${source.label ?? source.fingerprint.provider} 的重复来源描述仅计一次。`, `A duplicate source description for ${source.label ?? source.fingerprint.provider} is counted once.`));
  }
  const sources = [...owners.values()];
  const sourcePaths = new Set<string>();
  const sourceProviders = new Set<UsageProviderKind>();
  const sessionsByProvider = new Map<UsageProviderKind, number>();
  for (const source of sources) {
    if (source.status === "missing") continue;
    const provider = source.fingerprint.provider;
    sourcePaths.add(`${provider}\0${source.fingerprint.resolvedHomePath}`);
    sourceProviders.add(provider);
    sessionsByProvider.set(provider, (sessionsByProvider.get(provider) ?? 0) + source.distinctSessions);
  }
  const buckets: UsageBucket[] = [];
  let orphaned = false;
  for (const bucket of compatible ? summary?.buckets ?? [] : []) {
    if (hidden.has(bucket.provider)) continue;
    if (bucket.sourcePath === undefined ? !sourceProviders.has(bucket.provider) : !sourcePaths.has(`${bucket.provider}\0${bucket.sourcePath}`)) { orphaned = true; continue; }
    buckets.push(bucket);
  }
  if (orphaned) warnings.push(agentText("部分记录没有可核对的有效来源，未计入汇总；当前结果不完整。", "Some records have no verifiable source and were excluded from totals; the current result is incomplete."));
  const totals = aggregate(buckets);
  const providerRows = new Map<UsageProviderKind, UsageBucket[]>();
  const modelRows = new Map<string, UsageBucket[]>();
  const periodRows = new Map<string, UsageBucket[]>();
  let providerReportedRecords = 0;
  for (const bucket of buckets) {
    append(providerRows, bucket.provider, bucket);
    append(modelRows, `${bucket.provider}\0${bucket.model}`, bucket);
    append(periodRows, bucket.hourStart ?? bucket.day, bucket);
    providerReportedRecords += bucket.providerReportedRecords ?? (bucket.costSource === "providerReported" ? bucket.records : 0);
  }
  const providers = [...new Set([...providerRows.keys(), ...sessionsByProvider.keys()])].map(provider => {
    const subtotal = aggregate(providerRows.get(provider) ?? []);
    return { provider, totals: subtotal, sessions: sessionsByProvider.get(provider) ?? 0, ...shares(subtotal, totals) };
  }).sort((a, b) => b.totals.cost - a.totals.cost || b.totals.tokens - a.totals.tokens || a.provider.localeCompare(b.provider));
  const models = [...modelRows].map(([key, rows]) => {
    const subtotal = aggregate(rows);
    return { key, provider: rows[0]!.provider, model: rows[0]!.model, buckets: rows, totals: subtotal, ...shares(subtotal, totals) };
  });
  const periods = usagePeriods(input).map(period => {
    const rows = periodRows.get(period.key) ?? [];
    const groups = new Map<UsageProviderKind, UsageBucket[]>();
    for (const bucket of rows) append(groups, bucket.provider, bucket);
    return { ...period, totals: aggregate(rows), byProvider: new Map([...groups].map(([provider, group]) => [provider, aggregate(group)])) };
  });
  const refreshingProviders = [...new Set(sources.filter(source => source.refreshing).map(source => source.fingerprint.provider))];
  const partial = !compatible || warnings.length > 0 || sources.some(source => source.status !== "ok" || source.refreshing === true);
  return {
    buckets, sources, totals,
    sessions: [...sessionsByProvider.values()].reduce((sum, count) => sum + count, 0),
    providers, models, periods,
    costQuality: {
      providerReportedShare: totals.records ? providerReportedRecords / totals.records : 0,
      modelPricedShare: totals.records ? Math.max(0, totals.records - providerReportedRecords - totals.unpriced) / totals.records : 0,
      unpricedShare: totals.records ? totals.unpriced / totals.records : 0,
    },
    partial, refreshingProviders, warnings: [...new Set(warnings)], compatible,
  };
}
