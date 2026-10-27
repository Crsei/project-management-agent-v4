import type {
  AnalyticsPoint,
  AnalyticsResult,
  AnalyticsSeries,
  DrilldownSelection,
} from "./analytics-model"
export type ChartKind = "bar" | "line" | "area" | "donut" | "scatter"
export type ChartSelection = { seriesId: string; bucketId: string } | null
export type ChartReferenceDefinition = {
  id: string
  value: number
  label: string
  upper?: number
}
export type ChartDatum = {
  series: AnalyticsSeries
  point: AnalyticsPoint
  key: string
}
/** Literal tokens allow Registry host/scoped namespace rewriting. */
export function chartSeriesColor(
  color: AnalyticsSeries["color"],
  category?: string,
): string {
  const slot =
    category === "backlog" ||
    category === "active" ||
    category === "completed" ||
    category === "cancelled"
      ? category
      : color
  return {
    "1": "var(--chart-1)",
    "2": "var(--chart-2)",
    "3": "var(--chart-3)",
    "4": "var(--chart-4)",
    "5": "var(--chart-5)",
    backlog: "var(--chart-backlog)",
    active: "var(--chart-active)",
    completed: "var(--chart-completed)",
    cancelled: "var(--chart-cancelled)",
  }[slot]
}
export function chartData(result: AnalyticsResult): ChartDatum[] {
  const seen = new Set<string>()
  return result.series.flatMap((series) =>
    series.points.map((point) => {
      const key = JSON.stringify([series.id, point.bucketId])
      if (seen.has(key)) throw new Error("Duplicate chart point identity")
      seen.add(key)
      return {
        series,
        point: {
          ...point,
          value:
            point.value !== null && Number.isFinite(point.value)
              ? point.value
              : null,
        },
        key,
      }
    }),
  )
}
export function chartDrilldown(
  datum: ChartDatum,
  widgetId: string,
): DrilldownSelection | null {
  return datum.point.drilldown
    ? {
        ...datum.point.drilldown,
        seriesId: datum.series.id,
        bucketId: datum.point.bucketId,
        widgetId,
      }
    : null
}
