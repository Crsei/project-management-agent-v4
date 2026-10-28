import {
  analyticsEntityKey,
  type HistoryCoverage,
  type WorkflowEvent,
  type WorkItemAnalyticsSnapshot,
} from "./analytics-model"

export type AnalyticsHistory = {
  baseline: readonly WorkItemAnalyticsSnapshot[]
  events: readonly WorkflowEvent[]
  coverage: HistoryCoverage
}
const eventKey = (event: WorkflowEvent, id = event.eventId) =>
  JSON.stringify([event.entityRef.sourceId, id])
const stamp = (value: string) => {
  const time = Date.parse(value)
  if (!Number.isFinite(time))
    throw new Error(`Invalid analytics timestamp: ${value}`)
  return time
}
/** Corrections replace the original event at its effective time; retractions remove it. */
export function effectiveWorkflowEvents(
  events: readonly WorkflowEvent[],
  asOf: string,
): WorkflowEvent[] {
  const seen = new Map<string, WorkflowEvent>()
  for (const event of events) {
    stamp(event.recordedAt)
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0)
      throw new Error("Invalid event sequence")
    if (stamp(event.occurredAt) > stamp(asOf)) continue
    const key = eventKey(event)
    const old = seen.get(key)
    if (old && JSON.stringify(old) !== JSON.stringify(event))
      throw new Error(`Conflicting duplicate event: ${event.eventId}`)
    seen.set(key, event)
  }
  const ordered = [...seen.values()].sort(
    (a, b) =>
      stamp(a.occurredAt) - stamp(b.occurredAt) ||
      a.sequence - b.sequence ||
      eventKey(a).localeCompare(eventKey(b)),
  )
  const result = new Map<string, WorkflowEvent>()
  for (const event of ordered) {
    if (event.kind === "correction" || event.kind === "retraction") {
      const key = eventKey(event, event.targetEventId ?? "")
      const target = result.get(key)
      if (
        !target ||
        analyticsEntityKey(target.entityRef) !==
          analyticsEntityKey(event.entityRef)
      )
        throw new Error(`Unresolved event correction: ${event.eventId}`)
      if (event.kind === "retraction") result.delete(key)
      else
        result.set(key, {
          ...target,
          after: event.after,
          sourceVersion: event.sourceVersion,
        })
    } else result.set(eventKey(event), event)
  }
  return [...result.values()].sort(
    (a, b) =>
      stamp(a.occurredAt) - stamp(b.occurredAt) ||
      a.sequence - b.sequence ||
      eventKey(a).localeCompare(eventKey(b)),
  )
}
export function replayWorkflowHistory(history: AnalyticsHistory, asOf: string) {
  if (stamp(asOf) < stamp(history.coverage.baselineAsOf))
    throw new Error("Snapshot precedes baseline")
  const records = new Map(
    history.baseline.map((item) => [
      analyticsEntityKey(item.entityRef),
      { ...item },
    ]),
  )
  const completions: { item: WorkItemAnalyticsSnapshot; occurredAt: string }[] =
    []
  for (const event of effectiveWorkflowEvents(history.events, asOf)) {
    if (stamp(event.occurredAt) <= stamp(history.coverage.baselineAsOf))
      continue
    const key = analyticsEntityKey(event.entityRef)
    const previous = records.get(key)
    if (!previous && event.kind !== "created")
      throw new Error(`Missing baseline entity: ${event.entityRef.entityId}`)
    if (
      !previous &&
      (!event.after.stateId ||
        !event.after.category ||
        !event.after.title ||
        event.after.inScope === undefined)
    )
      throw new Error("Incomplete creation event")
    const next: WorkItemAnalyticsSnapshot = {
      title: "",
      stateId: "",
      category: "backlog",
      createdAt: null,
      actualStartedAt: null,
      completedAt: null,
      estimate: null,
      assigneeIds: [],
      blockers: [],
      inScope: true,
      revision: 0,
      ...previous,
      ...event.after,
      entityRef: event.entityRef,
    }
    if (
      next.estimate &&
      (!Number.isFinite(next.estimate.amount) || next.estimate.amount < 0)
    )
      throw new Error("Invalid estimate")
    if (
      event.kind === "state" &&
      next.category === "completed" &&
      previous?.category !== "completed" &&
      next.inScope
    )
      completions.push({ item: next, occurredAt: event.occurredAt })
    records.set(key, next)
  }
  return { items: [...records.values()], completions }
}
export function hasHistoryCoverage(
  coverage: HistoryCoverage,
  from: string,
  to: string,
  metricId: string,
): boolean {
  return (
    coverage.complete &&
    coverage.supportedMetrics.includes(metricId) &&
    stamp(coverage.baselineAsOf) <= stamp(from) &&
    stamp(coverage.from) <= stamp(from) &&
    stamp(coverage.to) >= stamp(to) &&
    !coverage.missingIntervals.some(
      (gap) => stamp(gap.from) < stamp(to) && stamp(gap.to) > stamp(from),
    )
  )
}
/** Calendar identity in the declared zone; DST never assumes 24-hour days. Weeks start Monday. */
export function analyticsBucketId(
  value: string,
  bucket: "day" | "week" | "month",
  timeZone: string,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(stamp(value))
  const get = (type: string) => parts.find((p) => p.type === type)!.value
  const date = `${get("year")}-${get("month")}-${get("day")}`
  if (bucket === "month") return date.slice(0, 7)
  if (bucket === "day") return date
  const local = new Date(`${date}T00:00:00Z`)
  local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7))
  return local.toISOString().slice(0, 10)
}
