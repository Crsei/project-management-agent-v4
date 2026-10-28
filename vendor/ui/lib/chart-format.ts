export function formatChartValue(
  value: number | null,
  locale: string,
  unit?: string,
): string {
  if (value === null || !Number.isFinite(value)) return "—"
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)}${unit ? ` ${unit}` : ""}`
}
export function formatMetricComparison(
  current: number | null,
  baseline: number | null,
): { kind: "unavailable" | "new" | "ratio"; value: number | null } {
  if (
    current === null ||
    baseline === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(baseline)
  )
    return { kind: "unavailable", value: null }
  if (baseline === 0)
    return { kind: current === 0 ? "unavailable" : "new", value: null }
  return { kind: "ratio", value: (current - baseline) / Math.abs(baseline) }
}
