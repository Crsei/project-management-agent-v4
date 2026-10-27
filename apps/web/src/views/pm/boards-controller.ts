import type {
  MoveIntent,
  WorkItemRecord,
} from "@/lib/work-items-model"
import { isMutationLocked } from "@/lib/work-items-model"
import type { WorkItemsBoardMove } from "@/components/blocks/work-items-views"
import type { GroupSnapshot } from "@/lib/grouped-items-model"
import type { PmIssue, PmIssueDomain } from "./issue-domain"
import { issueCatalog, issueGroups, issueRecord } from "./issue-domain"

export type BoardVariant = "plain" | "metrics" | "distribution"
export type BoardOutcome = "confirmed" | "rejected" | "unknown"
export type BoardReconcile = "confirmed" | "rejected"
/** Every board page groups and queries the shared issue domain with one key. */
export const boardQueryKey = "pm-issues"
export const boardToday = "2026-01-12"
export const boardStatusIds: readonly string[] = issueCatalog("en").states.map(
  (state) => state.id,
)
export type BoardFilters = {
  query: string
  statuses: readonly string[]
  /** "all" | "unassigned" | member id */
  assignee: string
}
export function createBoardFilters(): BoardFilters {
  return { query: "", statuses: boardStatusIds, assignee: "all" }
}
/** Pending requests and locked mutations block every writing callback. */
export function boardItemLocked(state: PmIssueDomain, itemId: string): boolean {
  return !!state.requests[itemId] || isMutationLocked(state.mutations[itemId])
}
/** Authoritative groups; a group without visible cards asks for the empty state. */
export function boardGroups(
  items: readonly PmIssue[],
  locale: "en" | "zh-CN",
): GroupSnapshot[] {
  return issueGroups(items, locale, boardQueryKey).map((group) =>
    group.itemIds.length === 0 ? { ...group, dataState: "empty" } : group,
  )
}
/** Localised records narrowed by search, status and assignee together. */
export function filterBoardItems(
  items: readonly PmIssue[],
  filters: BoardFilters,
  locale: "en" | "zh-CN",
): PmIssue[] {
  const query = filters.query.trim().toLowerCase()
  return items
    .map((item) => issueRecord(item, locale))
    .filter(
      (item) =>
        filters.statuses.includes(item.stateId) &&
        (filters.assignee === "all"
          ? true
          : filters.assignee === "unassigned"
            ? item.assigneeIds.length === 0
            : item.assigneeIds.includes(filters.assignee)) &&
        (!query ||
          item.identifier.toLowerCase().includes(query) ||
          item.title.toLowerCase().includes(query) ||
          (item.description ?? "").toLowerCase().includes(query)),
    )
}
export type BoardStatusStat = {
  key: string
  label: string
  color: string
  count: number
  /** Share of the filtered set in percent; null when the denominator is 0. */
  share: number | null
}
export type BoardStats = {
  total: number
  open: number
  active: number
  attention: number
  assigned: number
  done: number
  /** Percent of the filtered set; null when the denominator is 0. */
  completion: number | null
  assignedShare: number | null
  statuses: BoardStatusStat[]
}
function percent(count: number, total: number): number | null {
  return total === 0 ? null : Math.round((count / total) * 100)
}
/** Summary numbers and status distribution derive from the same filtered array. */
export function boardStats(
  items: readonly WorkItemRecord[],
  locale: "en" | "zh-CN",
): BoardStats {
  const total = items.length
  const open = items.filter((item) => item.stateId !== "done").length
  const active = items.filter(
    (item) => item.stateId === "progress" || item.stateId === "review",
  ).length
  const attention = items.filter(
    (item) =>
      item.stateId !== "done" &&
      (item.priorityId === "urgent" || item.priorityId === "high"),
  ).length
  const assigned = items.filter((item) => item.assigneeIds.length > 0).length
  const done = total - open
  const catalog = issueCatalog(locale)
  return {
    total,
    open,
    active,
    attention,
    assigned,
    done,
    completion: percent(done, total),
    assignedShare: percent(assigned, total),
    statuses: catalog.states.map((state) => {
      const count = items.filter((item) => item.stateId === state.id).length
      return {
        key: state.id,
        label: state.label,
        color: state.color ?? "var(--status-neutral)",
        count,
        share: percent(count, total),
      }
    }),
  }
}
/** Pointer drag and the keyboard/menu commands share one intent conversion. */
export function toBoardMoveIntent(
  intent: WorkItemsBoardMove,
  item: WorkItemRecord,
  sequence: number,
): MoveIntent | null {
  if (intent.queryKey !== boardQueryKey || intent.itemId !== item.id)
    return null
  return {
    operationId: `pm-board-move-${sequence}`,
    itemId: intent.itemId,
    sourceGroup: intent.sourceGroup,
    targetGroup: intent.targetGroup,
    beforeId: intent.beforeId,
    afterId: intent.afterId,
    append: intent.append,
    laneKey: intent.laneKey,
    baseRevision: intent.baseRevision ?? item.revision,
    queryKey: intent.queryKey,
  }
}
export function toggleStatusFilter(
  statuses: readonly string[],
  statusId: string,
): string[] {
  if (!statuses.includes(statusId)) return [...statuses, statusId]
  const next = statuses.filter((id) => id !== statusId)
  return next.length === 0 ? [...statuses] : next
}
