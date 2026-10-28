import type {
  AnalyticsFilter,
  AnalyticsQuery,
  AnalyticsResult,
  WorkItemAnalyticsSnapshot,
} from "./analytics-model"

export function intersectAnalyticsFilters(
  ...layers: readonly (readonly AnalyticsFilter[])[]
): AnalyticsFilter[] {
  return layers.flatMap((layer) =>
    layer.map((clause) => ({
      field: clause.field,
      values: [...new Set(clause.values)].sort(),
    })),
  )
}
export function analyticsQueryKey(query: AnalyticsQuery): string {
  return JSON.stringify({
    source: query.source,
    measureId: query.measureId,
    measureVersion: query.measureVersion,
    dimension: query.dimension,
    segment: query.segment,
    timeField: query.timeField,
    range: { from: query.range.from, to: query.range.to },
    bucket: query.bucket,
    timeZone: query.timeZone,
    scope: {
      id: query.scope.id,
      permissionVersion: query.scope.permissionVersion,
      projectIds: [...new Set(query.scope.projectIds)].sort(),
    },
    filters: intersectAnalyticsFilters(query.filters).sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
  })
}
export function matchesAnalyticsFilters(
  item: WorkItemAnalyticsSnapshot,
  filters: readonly AnalyticsFilter[],
): boolean {
  return filters.every(({ field, values }) => {
    const actual =
      field === "entityId" || field === "projectId"
        ? [item.entityRef[field]]
        : field === "blockerId"
          ? item.blockers.map((b) => b.id)
          : field === "assigneeIds"
            ? item.assigneeIds
            : [item[field]]
    return values.some((value) => actual.includes(value))
  })
}
export function validateAnalyticsQuery(query: AnalyticsQuery): void {
  if (
    !query ||
    typeof query.source !== "string" ||
    !query.source ||
    !query.scope ||
    typeof query.scope.id !== "string" ||
    typeof query.scope.permissionVersion !== "string" ||
    !Array.isArray(query.scope.projectIds) ||
    !query.scope.projectIds.every((v: unknown) => typeof v === "string") ||
    !query.range ||
    typeof query.measureId !== "string" ||
    !Number.isSafeInteger(query.measureVersion) ||
    query.measureVersion < 1 ||
    typeof query.dimension !== "string" ||
    !["asOf", "createdAt", "completedAt"].includes(query.timeField) ||
    !["day", "week", "month"].includes(query.bucket) ||
    !Array.isArray(query.filters) ||
    !query.filters.every(
      (f) =>
        [
          "entityId",
          "projectId",
          "stateId",
          "category",
          "assigneeIds",
          "blockerId",
        ].includes(f.field) &&
        Array.isArray(f.values) &&
        f.values.every((v: unknown) => typeof v === "string"),
    )
  )
    throw new Error("Invalid analytics query")
  if (
    !Number.isFinite(Date.parse(query.range.from)) ||
    !Number.isFinite(Date.parse(query.range.to)) ||
    Date.parse(query.range.from) >= Date.parse(query.range.to)
  )
    throw new Error("Invalid half-open analytics range")
  new Intl.DateTimeFormat("en", { timeZone: query.timeZone }).format(0)
}
/** Consumers call this before replacing controlled results; no global cache. */
export function acceptAnalyticsResponse(
  active: { queryKey: string; generation: number },
  response: { result: AnalyticsResult; generation: number },
): boolean {
  return (
    active.queryKey === response.result.queryKey &&
    active.generation === response.generation
  )
}
export function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value)
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}
export function analyticsCsv(
  query: AnalyticsQuery,
  result: AnalyticsResult,
): string {
  if (analyticsQueryKey(query) !== result.queryKey)
    throw new Error("Snapshot query mismatch")
  const rows: (string | number | null)[][] = [
    ["snapshotId", result.snapshotId],
    ["asOf", result.asOf],
    ["measure", `${query.measureId}@${query.measureVersion}`],
    ["timeField", query.timeField],
    ["from (inclusive)", query.range.from],
    ["to (exclusive)", query.range.to],
    ["timeZone", query.timeZone],
    ["unit", result.unit],
    ["completeness", result.completeness],
    [
      "coverage",
      result.coverage ? JSON.stringify(result.coverage) : "current snapshot",
    ],
    ["limitations", result.limitations.join("; ")],
    [
      "seriesId",
      "series",
      "bucketId",
      "bucket",
      "value",
      "unfinished",
      "estimated",
    ],
    ...result.series.flatMap((series) =>
      series.points.map((point) => [
        series.id,
        series.label,
        point.bucketId,
        point.label,
        point.value,
        String(!!point.unfinished),
        String(!!point.estimated),
      ]),
    ),
  ]
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n")
}
