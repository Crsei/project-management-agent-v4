/** Portable read-only analytics contracts. Services own history, authorization and queries. */
export type AnalyticsEntityRef = {
  kind: "idea" | "workItem" | "session" | "run" | "artifact"
  sourceId: string
  projectId: string
  entityId: string
  href?: string
}
export type AnalyticsCategory = "backlog" | "active" | "completed" | "cancelled"
export type WorkItemAnalyticsSnapshot = {
  entityRef: AnalyticsEntityRef
  title: string
  stateId: string
  category: AnalyticsCategory
  createdAt: string | null
  actualStartedAt: string | null
  completedAt: string | null
  lastStateEnteredAt?: string | null
  plannedStartDate?: string | null
  plannedDueDate?: string | null
  estimate: { amount: number; unit: string } | null
  assigneeIds: readonly string[]
  blockers: readonly { id: string; label: string; since: string | null }[]
  inScope: boolean
  revision: number
}
export type WorkflowEvent = {
  eventId: string
  entityRef: AnalyticsEntityRef
  sequence: number
  occurredAt: string
  recordedAt: string
  sourceVersion: string
  kind:
    | "created"
    | "state"
    | "estimate"
    | "assignment"
    | "scope"
    | "blocker"
    | "correction"
    | "retraction"
  before?: Partial<WorkItemAnalyticsSnapshot>
  after: Partial<Omit<WorkItemAnalyticsSnapshot, "entityRef">>
  /** Same-source event identity, never an array position. */
  targetEventId?: string
}
export type HistoryCoverage = {
  from: string
  to: string
  baselineAsOf: string
  baselineVersion: string
  watermark: string
  missingIntervals: readonly { from: string; to: string }[]
  supportedMetrics: readonly string[]
  complete: boolean
}
export type MetricDefinition = {
  id: string
  version: number
  entityKind: AnalyticsEntityRef["kind"]
  unit: string
  aggregation: "distinct" | "ratio" | "duration"
  cohort: string
  timeField: "createdAt" | "completedAt" | "asOf"
  history: "none" | "baseline-events"
  denominator: string | null
  reopenRule: string
  dimensions: readonly string[]
}
export type AnalyticsFilter = {
  field:
    | "entityId"
    | "projectId"
    | "stateId"
    | "category"
    | "assigneeIds"
    | "blockerId"
  values: readonly string[]
}
export type AnalyticsQuery = {
  source: string
  scope: {
    id: string
    permissionVersion: string
    projectIds: readonly string[]
  }
  measureId: string
  measureVersion: number
  dimension: string
  segment?: string
  timeField: MetricDefinition["timeField"]
  range: { from: string; to: string }
  bucket: "day" | "week" | "month"
  timeZone: string
  /** Every clause is intersected, including clauses on the same field. */
  filters: readonly AnalyticsFilter[]
}
export type DrilldownSelection = {
  queryKey: string
  snapshotId: string
  widgetId: string
  seriesId: string
  bucketId: string
  targetKind: AnalyticsEntityRef["kind"]
  predicate: readonly AnalyticsFilter[]
  token?: string
  entityRefs?: readonly AnalyticsEntityRef[]
  totalCount: number | null
  membership: "snapshot" | "historical"
}
export type AnalyticsPoint = {
  bucketId: string
  label: string
  value: number | null
  /** Timestamp for continuous time charts, or a numeric scatter coordinate. */
  x?: number
  unfinished?: boolean
  estimated?: boolean
  drilldown?: Omit<DrilldownSelection, "widgetId">
}
export type AnalyticsSeries = {
  id: string
  label: string
  /** Stable theme slot; identity never derives from current sort order. */
  color:
    | "1"
    | "2"
    | "3"
    | "4"
    | "5"
    | "backlog"
    | "active"
    | "completed"
    | "cancelled"
  points: readonly AnalyticsPoint[]
}
export type AnalyticsResult = {
  queryKey: string
  snapshotId: string
  asOf: string
  computedAt: string
  unit: string
  series: readonly AnalyticsSeries[]
  coverage: HistoryCoverage | null
  total: number | null
  limitations: readonly string[]
  sampleCoverage?: { observed: number; total: number }
  completeness: "complete" | "partial" | "unavailable"
}
export type CapacitySnapshot = {
  resourceRef: string
  bucket: string
  availableAmount: number | null
  allocatedAmount: number | null
  unit: string
  allocationRule: string
  calendarVersion: string
}
export type AnalyticsRelation = {
  id: string
  from: AnalyticsEntityRef
  to: AnalyticsEntityRef
  kind: "trace" | "contains" | "blocks" | "execution-parent" | "idea-link"
  label: string
}
export function analyticsEntityKey(ref: AnalyticsEntityRef): string {
  return JSON.stringify([ref.sourceId, ref.projectId, ref.kind, ref.entityId])
}
