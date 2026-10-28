import {
  analyticsEntityKey,
  type AnalyticsQuery,
  type AnalyticsResult,
  type AnalyticsPoint,
  type MetricDefinition,
  type WorkItemAnalyticsSnapshot,
} from "./analytics-model"
import {
  analyticsQueryKey,
  matchesAnalyticsFilters,
  validateAnalyticsQuery,
} from "./analytics-query"
import {
  analyticsBucketId,
  hasHistoryCoverage,
  replayWorkflowHistory,
  type AnalyticsHistory,
} from "./analytics-history"

export const workflowMetricDefinitions: readonly MetricDefinition[] = [
  {
    id: "status-distribution",
    version: 1,
    entityKind: "workItem",
    unit: "items",
    aggregation: "distinct",
    cohort: "in-scope excluding cancelled",
    timeField: "asOf",
    history: "none",
    denominator: "eligible distinct items",
    reopenRule: "current snapshot category",
    dimensions: ["category", "stateId"],
  },
  {
    id: "completion-trend",
    version: 1,
    entityKind: "workItem",
    unit: "items",
    aggregation: "distinct",
    cohort: "completion transitions while in scope",
    timeField: "completedAt",
    history: "baseline-events",
    denominator: null,
    reopenRule: "distinct entity per bucket; repeat across buckets allowed",
    dimensions: ["time"],
  },
  {
    id: "work-item-aging",
    version: 1,
    entityKind: "workItem",
    unit: "days",
    aggregation: "duration",
    cohort: "in-scope unfinished items with observed createdAt",
    timeField: "asOf",
    history: "none",
    denominator: null,
    reopenRule: "asOf minus original creation",
    dimensions: ["entityId"],
  },
  {
    id: "blocker-distribution",
    version: 1,
    entityKind: "workItem",
    unit: "items",
    aggregation: "distinct",
    cohort: "in-scope unfinished items with explicit blockers",
    timeField: "asOf",
    history: "none",
    denominator: null,
    reopenRule: "current explicit blocker relationships; overlapping groups",
    dimensions: ["blockerId"],
  },
]
export type WorkflowAnalyticsInput = {
  items: readonly WorkItemAnalyticsSnapshot[]
  snapshotId: string
  asOf: string
  computedAt: string
  /** A loaded page must be declared partial. This helper never infers remote totals. */
  completeness: "complete" | "partial"
  history?: AnalyticsHistory
}
function uniqueItems(items: readonly WorkItemAnalyticsSnapshot[]) {
  const map = new Map<string, WorkItemAnalyticsSnapshot>()
  for (const item of items) {
    const key = analyticsEntityKey(item.entityRef)
    if (!map.has(key) || map.get(key)!.revision < item.revision)
      map.set(key, item)
  }
  return [...map.values()]
}
function bucketStart(id: string, timeZone: string) {
  const target = Date.parse(`${id.length === 7 ? `${id}-01` : id}T00:00:00Z`)
  let time = target
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
  for (let i = 0; i < 4; i++) {
    const p = formatter.formatToParts(time)
    const get = (key: string) => p.find((part) => part.type === key)!.value
    const local = Date.parse(
      `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`,
    )
    const delta = target - local
    time += delta
    if (!delta) break
  }
  return time
}
export function computeWorkflowMetric(
  query: AnalyticsQuery,
  input: WorkflowAnalyticsInput,
): AnalyticsResult {
  validateAnalyticsQuery(query)
  const definition = workflowMetricDefinitions.find(
    (metric) =>
      metric.id === query.measureId && metric.version === query.measureVersion,
  )
  if (
    !definition ||
    definition.timeField !== query.timeField ||
    !definition.dimensions.includes(query.dimension)
  )
    throw new Error("Unsupported metric definition or time field")
  const queryKey = analyticsQueryKey(query)
  const result: AnalyticsResult = {
    queryKey,
    snapshotId: input.snapshotId,
    asOf: input.asOf,
    computedAt: input.computedAt,
    unit: definition.unit,
    series: [],
    coverage: input.history?.coverage ?? null,
    total: null,
    limitations: [],
    completeness: input.completeness,
  }
  const matchesScope = (item: WorkItemAnalyticsSnapshot) =>
    item.entityRef.kind === definition.entityKind &&
    item.entityRef.sourceId === query.source &&
    query.scope.projectIds.includes(item.entityRef.projectId) &&
    matchesAnalyticsFilters(item, query.filters)
  const items = uniqueItems(input.items).filter(
    (item) =>
      item.inScope && item.category !== "cancelled" && matchesScope(item),
  )
  const point = (
    bucketId: string,
    label: string,
    value: number | null,
    members: readonly WorkItemAnalyticsSnapshot[],
    membership: "snapshot" | "historical" = "snapshot",
  ): AnalyticsPoint => ({
    bucketId,
    label,
    value,
    drilldown: {
      queryKey,
      snapshotId: input.snapshotId,
      seriesId: query.measureId,
      bucketId,
      targetKind: "workItem",
      predicate: query.filters,
      entityRefs: members.map((item) => item.entityRef),
      totalCount: members.length,
      membership,
    },
  })
  if (query.measureId === "status-distribution") {
    result.total = items.length
    result.series = [
      {
        id: query.measureId,
        label: query.measureId,
        color: "1",
        points: ["backlog", "active", "completed"].map((category) => {
          const members = items.filter((item) => item.category === category)
          return point(category, category, members.length, members)
        }),
      },
    ]
  } else if (query.measureId === "blocker-distribution") {
    const blockerIds = [
      ...new Set(
        items.flatMap((item) =>
          item.category === "completed" ? [] : item.blockers.map((b) => b.id),
        ),
      ),
    ].sort()
    result.series = [
      {
        id: query.measureId,
        label: query.measureId,
        color: "4",
        points: blockerIds.map((id) => {
          const members = items.filter(
            (item) =>
              item.category !== "completed" &&
              item.blockers.some((b) => b.id === id),
          )
          return point(
            id,
            members[0].blockers.find((b) => b.id === id)!.label,
            members.length,
            members,
          )
        }),
      },
    ]
    result.total = items.filter(
      (item) => item.category !== "completed" && item.blockers.length,
    ).length
  } else if (query.measureId === "work-item-aging") {
    let missing = 0
    result.series = [
      {
        id: query.measureId,
        label: query.measureId,
        color: "3",
        points: items
          .filter((item) => item.category !== "completed")
          .map((item) => {
            const elapsed =
              Date.parse(input.asOf) - Date.parse(item.createdAt ?? "")
            const valid = Number.isFinite(elapsed) && elapsed >= 0
            if (!valid) missing++
            return {
              ...point(
                analyticsEntityKey(item.entityRef),
                item.title,
                valid ? elapsed / 86400000 : null,
                [item],
              ),
              x: valid ? Date.parse(item.createdAt!) : undefined,
            }
          }),
      },
    ]
    if (missing) {
      result.completeness = "partial"
      result.limitations = [`missing-createdAt:${missing}`]
    }
  } else {
    if (
      !input.history ||
      !hasHistoryCoverage(
        input.history.coverage,
        query.range.from,
        query.range.to,
        query.measureId,
      ) ||
      Date.parse(input.asOf) < Date.parse(query.range.to)
    ) {
      return {
        ...result,
        completeness: "unavailable",
        limitations: ["history-unavailable"],
      }
    }
    const { completions } = replayWorkflowHistory(input.history, input.asOf)
    const members = new Map<string, Map<string, WorkItemAnalyticsSnapshot>>()
    for (const completion of completions) {
      const time = Date.parse(completion.occurredAt)
      if (
        time < Date.parse(query.range.from) ||
        time >= Date.parse(query.range.to) ||
        !matchesScope(completion.item)
      )
        continue
      const id = analyticsBucketId(
        completion.occurredAt,
        query.bucket,
        query.timeZone,
      )
      const group = members.get(id) ?? new Map()
      group.set(analyticsEntityKey(completion.item.entityRef), completion.item)
      members.set(id, group)
    }
    const points: AnalyticsPoint[] = []
    let id = analyticsBucketId(query.range.from, query.bucket, query.timeZone)
    for (let i = 0; i < 10000; i++) {
      const start = bucketStart(id, query.timeZone)
      if (start >= Date.parse(query.range.to)) break
      const next = new Date(`${id.length === 7 ? `${id}-01` : id}T00:00:00Z`)
      if (query.bucket === "month") next.setUTCMonth(next.getUTCMonth() + 1)
      else
        next.setUTCDate(next.getUTCDate() + (query.bucket === "week" ? 7 : 1))
      const nextId = next
        .toISOString()
        .slice(0, query.bucket === "month" ? 7 : 10)
      const group = [...(members.get(id)?.values() ?? [])]
      points.push({
        ...point(id, id, group.length, group, "historical"),
        x: start,
        unfinished:
          bucketStart(nextId, query.timeZone) > Date.parse(input.asOf),
      })
      id = nextId
      if (i === 9999)
        throw new Error("Bucket limit exceeded; aggregate at the service")
    }
    result.series = [
      { id: query.measureId, label: query.measureId, color: "2", points },
    ]
    result.total = points.reduce((sum, p) => sum + (p.value ?? 0), 0)
  }
  return result
}
export type RiskEvidence = {
  id: string
  entityRef: WorkItemAnalyticsSnapshot["entityRef"]
  title: string
  rule: "overdue" | "blocked" | "missing-due-date" | "aging"
  threshold: string
  asOf: string
  source: string
}
export function workflowRiskEvidence(
  items: readonly WorkItemAnalyticsSnapshot[],
  asOf: string,
  timeZone: string,
  ageThresholdDays = 14,
): RiskEvidence[] {
  if (!Number.isFinite(ageThresholdDays) || ageThresholdDays < 0)
    throw new Error("Invalid risk threshold")
  const today = analyticsBucketId(asOf, "day", timeZone)
  return uniqueItems(items)
    .filter(
      (item) =>
        item.inScope &&
        item.category !== "completed" &&
        item.category !== "cancelled",
    )
    .flatMap((item) => {
      const facts: RiskEvidence[] = []
      const add = (
        rule: RiskEvidence["rule"],
        threshold: string,
        source: string,
      ) =>
        facts.push({
          id: `${analyticsEntityKey(item.entityRef)}:${rule}`,
          entityRef: item.entityRef,
          title: item.title,
          rule,
          threshold,
          asOf,
          source,
        })
      if (
        item.plannedDueDate &&
        /^\d{4}-\d{2}-\d{2}$/.test(item.plannedDueDate) &&
        item.plannedDueDate < today
      )
        add("overdue", item.plannedDueDate, "plannedDueDate")
      if (!item.plannedDueDate) add("missing-due-date", "—", "plannedDueDate")
      if (item.blockers.length)
        add(
          "blocked",
          item.blockers.map((b) => b.label).join(", "),
          "explicit blockers",
        )
      if (
        item.createdAt &&
        Date.parse(asOf) - Date.parse(item.createdAt) >
          ageThresholdDays * 86400000
      )
        add("aging", String(ageThresholdDays), "createdAt")
      return facts
    })
}
