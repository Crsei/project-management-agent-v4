import {
  analyticsEntityKey,
  type AnalyticsQuery,
  type AnalyticsResult,
  type AnalyticsSeries,
  type AnalyticsPoint,
  type WorkItemAnalyticsSnapshot,
} from "./analytics-model"
import {
  analyticsQueryKey,
  matchesAnalyticsFilters,
  validateAnalyticsQuery,
} from "./analytics-query"
import {
  analyticsBucketId,
  effectiveWorkflowEvents,
  hasHistoryCoverage,
  replayWorkflowHistory,
  type AnalyticsHistory,
} from "./analytics-history"
export type BusinessCalendar = {
  id: string
  version: string
  timeZone: string
  workingBucketIds: readonly string[]
}
export type HistoryMetricInput = {
  history: AnalyticsHistory
  snapshotId: string
  asOf: string
  computedAt: string
  unit: "items" | string
  calendar?: BusinessCalendar
}
/** Find real local bucket boundaries, including DST and non-whole-hour UTC offsets. */
export function analyticsBucketWindows(query: AnalyticsQuery) {
  validateAnalyticsQuery(query)
  const result: { id: string; from: string; to: string }[] = []
  let start = Date.parse(query.range.from)
  const limit = Date.parse(query.range.to)
  while (start < limit) {
    if (result.length >= 10000) throw new Error("Too many analytics buckets")
    const id = analyticsBucketId(
      new Date(start).toISOString(),
      query.bucket,
      query.timeZone,
    )
    let hi = Math.min(start + 21600000, limit),
      lo = start
    while (
      hi < limit &&
      analyticsBucketId(
        new Date(hi).toISOString(),
        query.bucket,
        query.timeZone,
      ) === id
    ) {
      lo = hi
      hi = Math.min(hi + 21600000, limit)
    }
    if (
      analyticsBucketId(
        new Date(hi - 1).toISOString(),
        query.bucket,
        query.timeZone,
      ) !== id
    ) {
      while (hi - lo > 1) {
        const mid = Math.floor((hi + lo) / 2)
        if (
          analyticsBucketId(
            new Date(mid).toISOString(),
            query.bucket,
            query.timeZone,
          ) === id
        )
          lo = mid
        else hi = mid
      }
    }
    result.push({
      id,
      from: new Date(start).toISOString(),
      to: new Date(hi).toISOString(),
    })
    start = hi
  }
  return result
}
const eligible = (item: WorkItemAnalyticsSnapshot, q: AnalyticsQuery) =>
  item.entityRef.kind === "workItem" &&
  item.entityRef.sourceId === q.source &&
  q.scope.projectIds.includes(item.entityRef.projectId) &&
  item.inScope &&
  item.category !== "cancelled" &&
  matchesAnalyticsFilters(item, q.filters)
const amount = (item: WorkItemAnalyticsSnapshot, unit: string) =>
  unit === "items"
    ? 1
    : item.estimate?.unit === unit &&
        Number.isFinite(item.estimate.amount) &&
        item.estimate.amount >= 0
      ? item.estimate.amount
      : null
function sum(items: readonly WorkItemAnalyticsSnapshot[], unit: string) {
  const values = items.map((i) => amount(i, unit))
  return values.some((v) => v === null)
    ? null
    : values.reduce<number>((s, v) => s + v!, 0)
}
function result(
  q: AnalyticsQuery,
  input: HistoryMetricInput,
  series: AnalyticsSeries[],
  limitations: string[] = [],
  total: number | null = null,
): AnalyticsResult {
  return {
    queryKey: analyticsQueryKey(q),
    snapshotId: input.snapshotId,
    asOf: input.asOf,
    computedAt: input.computedAt,
    unit: input.unit,
    coverage: input.history.coverage,
    series,
    total,
    limitations,
    completeness: limitations.length ? "partial" : "complete",
  }
}
function point(
  q: AnalyticsQuery,
  input: HistoryMetricInput,
  id: string,
  value: number | null,
  items: readonly WorkItemAnalyticsSnapshot[],
  seriesId: string,
  x?: number,
): AnalyticsPoint {
  return {
    bucketId: id,
    label: id,
    value,
    x,
    drilldown: {
      queryKey: analyticsQueryKey(q),
      snapshotId: input.snapshotId,
      seriesId,
      bucketId: id,
      targetKind: "workItem",
      predicate: [],
      entityRefs: items.map((i) => i.entityRef),
      totalCount: items.length,
      membership: "historical",
    },
  }
}
export function computeHistoricalMetric(
  q: AnalyticsQuery,
  input: HistoryMetricInput,
): AnalyticsResult {
  validateAnalyticsQuery(q)
  const metric = q.measureId
  if (q.timeField !== (metric === "cycle-time" ? "completedAt" : "asOf"))
    throw new Error("Historical metric time field mismatch")
  if (
    !["burndown", "burnup", "cumulative-flow", "cycle-time"].includes(metric) ||
    q.measureVersion !== 1
  )
    throw new Error("Unsupported history metric version")
  if (
    !hasHistoryCoverage(
      input.history.coverage,
      q.range.from,
      q.range.to,
      metric,
    ) ||
    Date.parse(input.asOf) < Date.parse(q.range.to)
  )
    return {
      ...result(q, input, [], ["analytics.noHistory"]),
      completeness: "unavailable",
    }
  const windows = analyticsBucketWindows(q),
    baseline = replayWorkflowHistory(input.history, q.range.from).items.filter(
      (i) => eligible(i, q),
    )
  if (metric === "cycle-time") {
    const cohort = replayWorkflowHistory(
      input.history,
      new Date(Date.parse(q.range.to) - 1).toISOString(),
    ).items.filter(
      (i) =>
        eligible(i, q) &&
        i.category === "completed" &&
        i.completedAt &&
        Date.parse(i.completedAt) >= Date.parse(q.range.from) &&
        Date.parse(i.completedAt) < Date.parse(q.range.to),
    )
    const firstStarts = new Map<string, number>()
    const observe = (
      ref: WorkItemAnalyticsSnapshot["entityRef"],
      value: string | null | undefined,
    ) => {
      const time = Date.parse(value ?? "")
      const key = analyticsEntityKey(ref)
      if (Number.isFinite(time))
        firstStarts.set(key, Math.min(firstStarts.get(key) ?? Infinity, time))
    }
    input.history.baseline.forEach((i) =>
      observe(i.entityRef, i.actualStartedAt),
    )
    effectiveWorkflowEvents(input.history.events, input.asOf).forEach((e) =>
      observe(e.entityRef, e.after.actualStartedAt),
    )
    const valid = cohort
      .map((i) => ({
        ...i,
        actualStartedAt: firstStarts.has(analyticsEntityKey(i.entityRef))
          ? new Date(
              firstStarts.get(analyticsEntityKey(i.entityRef))!,
            ).toISOString()
          : null,
      }))
      .filter(
        (i) =>
          i.actualStartedAt &&
          Date.parse(i.actualStartedAt) <= Date.parse(i.completedAt!) &&
          Number.isFinite(Date.parse(i.actualStartedAt)),
      )
    const points = valid.map((i) =>
      point(
        q,
        input,
        analyticsEntityKey(i.entityRef),
        (Date.parse(i.completedAt!) - Date.parse(i.actualStartedAt!)) /
          86400000,
        [i],
        "cycle",
        Date.parse(i.completedAt!),
      ),
    )
    return {
      ...result(
        q,
        { ...input, unit: "days" },
        [{ id: "cycle", label: "cycle-time", color: "2", points }],
        valid.length === cohort.length ? [] : ["analytics.missingStart"],
        cohort.length,
      ),
      sampleCoverage: { observed: valid.length, total: cohort.length },
    }
  }
  const series: AnalyticsSeries[] =
    metric === "cumulative-flow"
      ? ["backlog", "active", "completed"].map((id) => ({
          id,
          label: id,
          color: id as "backlog" | "active" | "completed",
          points: [],
        }))
      : metric === "burnup"
        ? [
            { id: "scope", label: "scope", color: "1" as const, points: [] },
            {
              id: "completed",
              label: "completed",
              color: "completed" as const,
              points: [],
            },
          ]
        : [
            {
              id: "remaining",
              label: "remaining",
              color: "2" as const,
              points: [],
            },
            { id: "ideal", label: "ideal", color: "5" as const, points: [] },
          ]
  const warnings = new Set<string>()
  const startAmount = sum(
      baseline.filter((i) => i.category !== "completed"),
      input.unit,
    ),
    calendar = input.calendar
  if (
    metric === "burndown" &&
    (!calendar || calendar.timeZone !== q.timeZone || q.bucket !== "day")
  )
    warnings.add("analytics.calendarMissing")
  const work =
    calendar?.workingBucketIds.filter((id) =>
      windows.some((w) => w.id === id),
    ) ?? []
  if (metric === "burndown" && !work.length)
    warnings.add("analytics.calendarMissing")
  for (const window of windows) {
    const at = new Date(Date.parse(window.to) - 1).toISOString(),
      items = replayWorkflowHistory(input.history, at).items.filter((i) =>
        eligible(i, q),
      )
    const x = Date.parse(window.to) - 1
    for (const s of series) {
      let members = items,
        value: number | null
      if (metric === "cumulative-flow") {
        members = items.filter((i) => i.category === s.id)
        value = members.length
      } else if (s.id === "ideal") {
        members = baseline
        value =
          calendar &&
          work.length &&
          calendar.timeZone === q.timeZone &&
          q.bucket === "day" &&
          startAmount !== null
            ? startAmount *
              (work.filter((id) => id > window.id).length / work.length)
            : null
      } else {
        if (s.id === "completed")
          members = items.filter((i) => i.category === "completed")
        if (s.id === "remaining")
          members = items.filter((i) => i.category !== "completed")
        value = sum(members, input.unit)
      }
      if (value === null)
        warnings.add(
          s.id === "ideal" && startAmount !== null
            ? "analytics.calendarMissing"
            : "analytics.missingEstimate",
        )
      const p = point(q, input, window.id, value, members, s.id, x)
      if (s.id === "ideal") delete p.drilldown
      ;(s.points as AnalyticsPoint[]).push(p)
    }
  }
  return result(
    q,
    { ...input, unit: metric === "cumulative-flow" ? "items" : input.unit },
    series,
    [...warnings],
    series[0]?.points.at(-1)?.value ?? null,
  )
}
/** Nearest-rank quantile: sorted[ceil(p*n)-1], no interpolation. */
export function nearestRank(
  values: readonly number[],
  p: number,
): number | null {
  if (!(p > 0 && p <= 1)) throw new Error("Invalid quantile")
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b)
  return sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null
}
export type IterationHistory = {
  id: string
  from: string
  to: string
  closed: boolean
  history: AnalyticsHistory
}
export function computeVelocity(
  q: AnalyticsQuery,
  input: Omit<HistoryMetricInput, "history">,
  iterations: readonly IterationHistory[],
): AnalyticsResult {
  const series: AnalyticsSeries[] = [
      { id: "committed", label: "committed", color: "1", points: [] },
      { id: "delivered", label: "delivered", color: "completed", points: [] },
      { id: "added", label: "added", color: "4", points: [] },
    ],
    limitations = new Set<string>()
  for (const iteration of iterations) {
    if (
      Date.parse(iteration.to) <= Date.parse(q.range.from) ||
      Date.parse(iteration.to) > Date.parse(q.range.to)
    )
      continue
    if (
      !iteration.closed ||
      Date.parse(iteration.to) > Date.parse(input.asOf)
    ) {
      limitations.add("analytics.openIteration")
      continue
    }
    if (Date.parse(iteration.from) >= Date.parse(iteration.to))
      throw new Error("Invalid iteration range")
    if (
      !hasHistoryCoverage(
        iteration.history.coverage,
        iteration.from,
        iteration.to,
        "velocity",
      )
    ) {
      limitations.add("analytics.noHistory")
      continue
    }
    const baseline = replayWorkflowHistory(
        iteration.history,
        iteration.from,
      ).items.filter((i) => eligible(i, q)),
      current = replayWorkflowHistory(
        iteration.history,
        new Date(Date.parse(iteration.to) - 1).toISOString(),
      ).items.filter((i) => eligible(i, q)),
      ids = new Set(baseline.map((i) => analyticsEntityKey(i.entityRef)))
    for (const s of series) {
      const members =
        s.id === "committed"
          ? baseline.filter((i) => i.category !== "completed")
          : s.id === "delivered"
            ? current.filter(
                (i) =>
                  i.category === "completed" &&
                  i.completedAt &&
                  Date.parse(i.completedAt) >= Date.parse(iteration.from) &&
                  Date.parse(i.completedAt) < Date.parse(iteration.to),
              )
            : current.filter((i) => !ids.has(analyticsEntityKey(i.entityRef)))
      const value = sum(members, input.unit)
      if (value === null) limitations.add("analytics.missingEstimate")
      ;(s.points as AnalyticsPoint[]).push(
        point(
          q,
          { ...input, history: iteration.history },
          iteration.id,
          value,
          members,
          s.id,
        ),
      )
    }
  }
  return {
    queryKey: analyticsQueryKey(q),
    snapshotId: input.snapshotId,
    asOf: input.asOf,
    computedAt: input.computedAt,
    unit: input.unit,
    coverage: null,
    series,
    total: null,
    completeness: limitations.size ? "partial" : "complete",
    limitations: [...limitations],
  }
}
export function computeStateResidence(
  q: AnalyticsQuery,
  items: readonly WorkItemAnalyticsSnapshot[],
  snapshotId: string,
  asOf: string,
): AnalyticsResult {
  const selected = items.filter(
      (i) => eligible(i, q) && i.category !== "completed",
    ),
    points = selected.map((i) => {
      const entered = i.lastStateEnteredAt
        ? Date.parse(i.lastStateEnteredAt)
        : NaN
      return {
        bucketId: analyticsEntityKey(i.entityRef),
        label: i.title,
        value:
          Number.isFinite(entered) && entered <= Date.parse(asOf)
            ? (Date.parse(asOf) - entered) / 86400000
            : null,
        drilldown: {
          queryKey: analyticsQueryKey(q),
          snapshotId,
          seriesId: "residence",
          bucketId: analyticsEntityKey(i.entityRef),
          targetKind: "workItem" as const,
          predicate: [],
          entityRefs: [i.entityRef],
          totalCount: 1,
          membership: "snapshot" as const,
        },
      }
    })
  return {
    queryKey: analyticsQueryKey(q),
    snapshotId,
    asOf,
    computedAt: asOf,
    unit: "days",
    coverage: null,
    total: selected.length,
    series: [{ id: "residence", label: "state-residence", color: "3", points }],
    completeness: points.some((p) => p.value === null) ? "partial" : "complete",
    limitations: points.some((p) => p.value === null)
      ? ["analytics.missingStateEntry"]
      : [],
  }
}
