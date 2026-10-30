import type { UsageBucket, UsageProviderKind, UsageSummaryInput } from "@agent-workspace/contracts/usage";
import { tokenTotal } from "./page-data.ts";
import { usagePeriods } from "./usage-view-model.ts";

export type ChartMetric = "cost" | "tokens";
export interface UsageChartValue {
  value: number | null;
  records: number;
  unpriced: number;
  unknownCost: boolean;
  incomplete: boolean;
}
export interface UsageChartColumn {
  key: string;
  day: string;
  hourStart?: string;
  values: Map<UsageProviderKind, UsageChartValue>;
}

/** Only projects already-filtered buckets; the shared view owns scope and period semantics. */
export function buildUsageChart(buckets: readonly UsageBucket[], metric: ChartMetric, input?: UsageSummaryInput, partial = false, refreshingProviders: readonly UsageProviderKind[] = []) {
  const observed = input ? [] : [...new Map(buckets.map(bucket => {
    const key = bucket.hourStart ?? bucket.day;
    return [key, { key, day: bucket.day, ...(bucket.hourStart ? { hourStart: bucket.hourStart } : {}) }];
  })).values()].sort((a, b) => a.key.localeCompare(b.key));
  const first = observed[0];
  const last = observed[observed.length - 1];
  const lastHour = last?.hourStart ? Date.parse(last.hourStart) : NaN;
  const inferredInput: UsageSummaryInput | undefined = first && last && (!last.hourStart || Number.isFinite(lastHour)) ? {
    sinceDay: first.day, untilDay: last.day, timeZone: "UTC",
    ...(first.hourStart && last.hourStart ? { resolution: "hour", sinceTime: first.hourStart, untilTime: new Date(lastHour + 3_600_000).toISOString() } : { resolution: "day" }),
  } : undefined;
  const window = input ?? inferredInput;
  const periods = window ? usagePeriods(window) : [];
  // An explicit invalid query must not silently turn into an observed-range query.
  const axis = input || periods.length > 0 ? periods : observed;
  const axisKeys = new Set(axis.map(period => period.key));
  const selected = buckets.filter(bucket => axisKeys.has(bucket.hourStart ?? bucket.day));
  const providers = [...new Set([...selected.map(bucket => bucket.provider), ...refreshingProviders])].sort();
  const refreshing = new Set(refreshingProviders);
  const columns: UsageChartColumn[] = axis.map(period => ({ ...period, values: new Map(providers.map(provider => [provider, {
    value: partial || refreshing.has(provider) ? null : 0,
    records: 0, unpriced: 0, unknownCost: false, incomplete: partial || refreshing.has(provider),
  }])) }));
  const byKey = new Map(columns.map(column => [column.key, column]));
  const observedValues = new Set<UsageChartValue>();
  let unknownCost = false;
  for (const bucket of selected) {
    const value = byKey.get(bucket.hourStart ?? bucket.day)!.values.get(bucket.provider)!;
    if (!observedValues.has(value)) { value.value = null; observedValues.add(value); }
    const hasKnownCost = bucket.costUsd > 0 || (bucket.costSource !== "unpriced" && (bucket.records === 0 || bucket.unpricedRecords < bucket.records));
    if (metric === "tokens" || hasKnownCost) value.value = (value.value ?? 0) + (metric === "tokens" ? tokenTotal(bucket) : bucket.costUsd);
    value.records += bucket.records;
    value.unpriced += bucket.unpricedRecords;
    value.unknownCost ||= bucket.unpricedRecords > 0 || bucket.costSource === "unpriced";
    unknownCost ||= value.unknownCost;
  }
  // Lines are layered from zero, not stacked: scale to the largest individual provider.
  let peak = 0;
  for (const column of columns) for (const value of column.values.values()) peak = Math.max(peak, value.value ?? 0);
  return { providers, columns, peak, unknownCost, resolution: window?.resolution ?? (first?.hourStart ? "hour" : "day"), observedRange: input === undefined };
}

export function combineChartValues(values: readonly UsageChartValue[]): UsageChartValue {
  const sum: UsageChartValue = { value: null, records: 0, unpriced: 0, unknownCost: false, incomplete: false };
  for (const value of values) {
    if (value.value !== null) sum.value = (sum.value ?? 0) + value.value;
    sum.records += value.records;
    sum.unpriced += value.unpriced;
    sum.unknownCost ||= value.unknownCost;
    sum.incomplete ||= value.incomplete || value.value === null;
  }
  return sum;
}
