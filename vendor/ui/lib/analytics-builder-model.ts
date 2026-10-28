import type { AnalyticsQuery, MetricDefinition } from "./analytics-model"
import type { ChartKind } from "./chart-model"
import { analyticsQueryKey, validateAnalyticsQuery } from "./analytics-query"
export type AnalyticsBuilderMetric = MetricDefinition & {
  charts: readonly ChartKind[]
  segments: readonly string[]
  units: readonly string[]
  exclusiveDimensions?: readonly string[]
}
export type AnalyticsBuilderDraft = {
  query: AnalyticsQuery
  chart: ChartKind
  unit: string
  stacked: boolean
}
export function validateAnalyticsBuilder(
  draft: AnalyticsBuilderDraft,
  metrics: readonly AnalyticsBuilderMetric[],
  authority: AnalyticsQuery,
): string | null {
  const metric = metrics.find(
    (m) =>
      m.id === draft.query.measureId &&
      m.version === draft.query.measureVersion,
  )
  if (!metric) return "analytics.builderMetric"
  if (
    !metric.dimensions.includes(draft.query.dimension) ||
    (draft.query.segment && !metric.segments.includes(draft.query.segment))
  )
    return "analytics.builderDimension"
  if (
    !metric.units.includes(draft.unit) ||
    !metric.charts.includes(draft.chart)
  )
    return "analytics.builderCombination"
  if (
    draft.chart === "donut" &&
    (!metric.exclusiveDimensions?.includes(draft.query.dimension) ||
      draft.query.segment ||
      draft.stacked)
  )
    return "analytics.builderComposition"
  if (draft.stacked && !["bar", "area"].includes(draft.chart))
    return "analytics.builderCombination"
  const scope = (q: AnalyticsQuery) =>
    JSON.stringify({
      source: q.source,
      scope: { ...q.scope, projectIds: [...q.scope.projectIds].sort() },
    })
  if (scope(draft.query) !== scope(authority)) return "analytics.builderScope"
  if (draft.query.timeField !== metric.timeField)
    return "analytics.builderTimeField"
  try {
    validateAnalyticsQuery(draft.query)
  } catch {
    return "analytics.builderRange"
  }
  return null
}
export function analyticsBuilderKey(draft: AnalyticsBuilderDraft) {
  return JSON.stringify([
    analyticsQueryKey(draft.query),
    draft.chart,
    draft.unit,
    draft.stacked,
  ])
}
