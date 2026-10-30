// Usage presentation adapted from t3code usageFormat and usageBreakdown.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { AgentText } from "../i18n";
import { agentText } from "../i18n-text.ts";
import type { UsageTotals } from "./page-data";

const compactNumber = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });
const exactNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });

export function formatUsageCount(value: number): string {
  for (const [scale, suffix] of [[1_000_000_000, "B"], [1_000_000, "M"], [1_000, "K"]] as const) {
    if (value >= scale) return `${compactNumber.format(value / scale)}${suffix}`;
  }
  return compactNumber.format(value);
}

export const formatUsageExact = (value: number) => exactNumber.format(value);
export const formatUsageMoney = (value: number) => value > 0 && value < 0.01
  ? "<$0.01"
  : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function formatUsageShare(share: number | null): string {
  if (share === null) return "—";
  if (share > 0 && share < 0.001) return "<0.1%";
  return `${(share * 100).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

export const usageInk = (percent: number) => `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;
export const isUsageUnpriced = (totals: UsageTotals) => totals.records > 0 && totals.unpriced >= totals.records;
export function formatUsageCost(totals: UsageTotals, t: AgentText = agentText): string {
  if (isUsageUnpriced(totals)) return t("未定价", "Unpriced");
  return `${formatUsageMoney(totals.cost)}${totals.unpriced > 0 ? t(" + 未定价", " + unpriced") : ""}`;
}
