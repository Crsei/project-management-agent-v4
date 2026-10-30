import { isScheduleDate } from "./schedule-date-utils"
import type { RuntimeStatus } from "./runtime-status"
import type { CalendarSettings, TimelineSettings } from "./schedule-view-model"

export type WorkItemProperty =
  | "state"
  | "priority"
  | "assignees"
  | "labels"
  | "startDate"
  | "dueDate"
  | "counts"
export type WorkItemField =
  | "title"
  | "description"
  | "stateId"
  | "priorityId"
  | "assigneeIds"
  | "labelIds"
  | "startDate"
  | "dueDate"
export type WorkItemRecord = {
  id: string
  projectId: string
  identifier: string
  title: string
  description?: string
  stateId: string
  priorityId: string
  assigneeIds: readonly string[]
  labelIds: readonly string[]
  startDate?: string | null
  dueDate: string | null
  parentId?: string | null
  subItemCount?: number | null
  /** Checked/total source checklist items; absent when the host has no checklist data. */
  subtasks?: { completed: number; total: number } | null
  attachmentCount?: number | null
  linkCount?: number | null
  revision: number
  agentStatus?: RuntimeStatus
}
export type WorkItemOption = { id: string; label: string; color?: string }
export type WorkflowStateDefinition = WorkItemOption & { category?: string }
export type WorkItemCatalog = {
  states: readonly WorkflowStateDefinition[]
  priorities: readonly WorkItemOption[]
  assignees: readonly WorkItemOption[]
  labels: readonly WorkItemOption[]
}
export type WorkItemPatch = Partial<Pick<WorkItemRecord, WorkItemField>>
/** Filters are an ordered AND list; values inside one row are OR. */
export type WorkItemsFilterField =
  | "state"
  | "priority"
  | "assignees"
  | "labels"
export type WorkItemsFilterOperator = "is" | "isNot"
export type WorkItemsFilterCondition = {
  field: WorkItemsFilterField
  operator: WorkItemsFilterOperator
  values: string[]
}
export type WorkItemsFilters = readonly WorkItemsFilterCondition[]
export type WorkItemsSort =
  | "manual"
  | "title"
  | "dueDate"
  | "priority"
  | "state"
  | "assignees"
  | "labels"
export const workItemsFilterFields: readonly WorkItemsFilterField[] = [
  "state",
  "priority",
  "assignees",
  "labels",
]
export const workItemsSortFields: readonly Exclude<WorkItemsSort, "manual">[] =
  ["priority", "dueDate", "title", "state", "assignees", "labels"]
export function filterValues(
  filters: WorkItemsFilters,
  field: WorkItemsFilterField,
) {
  return filters.find((condition) => condition.field === field)?.values ?? []
}
/** Replaces the first row for a field; empty values remove that row. */
export function withFilterValues(
  filters: WorkItemsFilters,
  field: WorkItemsFilterField,
  values: readonly string[],
): WorkItemsFilters {
  const remaining = filters.filter((condition) => condition.field !== field)
  if (!values.length) return remaining
  return [
    ...remaining,
    { field, operator: "is" as const, values: [...values] },
  ]
}
export type WorkItemsViewState = {
  layout: "list" | "board" | "table" | "timeline" | "calendar"
  timeline?: TimelineSettings
  calendar?: CalendarSettings
  query: string
  filters: WorkItemsFilters
  groupBy: "state" | "priority"
  sort: WorkItemsSort
  sortDirection: "asc" | "desc"
  visibleProperties: WorkItemProperty[]
  showEmptyGroups: boolean
  /** Optional Board swimlane axis; must differ from groupBy. */
  subGroupBy?: "none" | "state" | "priority"
  /** List hierarchy only; Board/Table retain flat entity views. */
  showSubItems?: boolean
  /** Keep DOM/search/keyboard order while deferring offscreen layout. */
  deferOffscreen?: boolean
}
export type WorkItemsInteraction = {
  selectedIds: readonly string[]
  activeItemId: string | null
  collapsedGroupIds: readonly string[]
}
export type { GroupSnapshot } from "./grouped-items-model"
export type WorkItemCapabilities = {
  canCreate: boolean
  canEditField: (item: WorkItemRecord, field: WorkItemField) => boolean
  canMove: (item: WorkItemRecord, targetGroup: string) => boolean
  reason?: string
}
export type MutationState = {
  operationId: string
  itemId: string
  baseRevision: number
  status: "pending" | "confirmed" | "rejected" | "unknown"
  error?: string
  fieldErrors?: Partial<Record<WorkItemField, string>>
}
export type MoveIntent = {
  operationId: string
  itemId: string
  sourceGroup: string
  targetGroup: string
  beforeId?: string
  afterId?: string
  baseRevision: number
  queryKey: string
  /** Explicit append is allowed only when the caller supplies this capability. */
  append?: boolean
  laneKey?: string
}
export type WorkItemDraft = {
  startDate?: string | null
  dueDate?: string | null
  title: string
  stateId: string
  priorityId: string
}
export type CreateResult = {
  status: "confirmed" | "rejected" | "unknown"
  error?: string
}
export const defaultWorkItemsView: WorkItemsViewState = {
  layout: "list",
  query: "",
  filters: [],
  groupBy: "state",
  sort: "manual",
  sortDirection: "asc",
  visibleProperties: ["state", "priority", "assignees", "labels", "dueDate"],
  showEmptyGroups: true,
}
export function isMutationLocked(mutation?: MutationState) {
  return mutation?.status === "pending" || mutation?.status === "unknown"
}
/** Calendar dates stay strings. The caller supplies today's date in its intended timezone. */
export function isOverdue(date: string | null, today?: string) {
  return !!date && !!today && isScheduleDate(date) && date < today
}

/** Caller-provided authoritative groups; never infer remote lane totals from a page. */
export type WorkItemsLaneSnapshot = {
  key: string
  label: string
  groups: readonly import("./grouped-items-model").GroupSnapshot[]
}
export type WorkItemChildrenSnapshot = {
  totalCount?: number | null
  hasMore?: boolean
  state: import("./runtime-status").DataState
  error?: string
}
export type WorkItemsHierarchy = {
  expandedIds: readonly string[]
  onExpandedChange: (ids: string[]) => void
  children?: Readonly<Record<string, WorkItemChildrenSnapshot | undefined>>
  onLoadMore?: (item: WorkItemRecord) => void
  onRetry?: (item: WorkItemRecord) => void
}
export type WorkItemsBatchIntent = {
  operationId: string
  entries: readonly { itemId: string; baseRevision: number }[]
  patch: Pick<WorkItemPatch, "stateId" | "priorityId">
}
export type WorkItemsSavedView = {
  id: string
  name: string
  revision: number
  view: WorkItemsViewState
}
export type WorkItemsSaveViewIntent = {
  id?: string
  name: string
  baseRevision?: number
  view: WorkItemsViewState
}
