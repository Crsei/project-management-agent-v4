import type { DataState } from "./runtime-status"
import type {
  WorkItemCapabilities,
  WorkItemRecord,
  MutationState,
} from "./work-items-model"
import { isMutationLocked } from "./work-items-model"
import {
  addScheduleDays,
  addScheduleMonths,
  startOfScheduleWeek,
  scheduleDateError,
  isScheduleDate,
  isScheduleTimeZone,
  scheduleDayDifference,
  type ScheduleDates,
} from "./schedule-date-utils"
export type TimelineScale = "week" | "month" | "quarter"
export type CalendarMode = "month" | "week"
export type ScheduleSettings = {
  anchorDate: string
  timeZone: string
  weekStartsOn: number
}
export type TimelineSettings = ScheduleSettings & { scale: TimelineScale }
export type CalendarSettings = ScheduleSettings & {
  mode: CalendarMode
  showWeekends: boolean
  selectedDate: string
}
export type ScheduleViewport = ScheduleSettings & {
  rangeStart: string
  rangeEnd: string
}
/** Deterministic migration baseline; applications should supply their own initial anchor. */
export const scheduleBaseline = "2026-10-09"
export function normalizeTimeline(
  value?: Partial<TimelineSettings>,
): TimelineSettings {
  return {
    ...normalizeSettings(value),
    scale:
      value?.scale === "week" || value?.scale === "quarter"
        ? value.scale
        : "month",
  }
}
export function normalizeCalendar(
  value?: Partial<CalendarSettings>,
): CalendarSettings {
  return {
    ...normalizeSettings(value),
    mode: value?.mode === "week" ? "week" : "month",
    showWeekends: value?.showWeekends !== false,
    selectedDate: isScheduleDate(value?.selectedDate)
      ? value.selectedDate
      : isScheduleDate(value?.anchorDate)
        ? value.anchorDate
        : scheduleBaseline,
  }
}
function normalizeSettings(
  value?: Partial<ScheduleSettings>,
): ScheduleSettings {
  return {
    anchorDate: isScheduleDate(value?.anchorDate)
      ? value.anchorDate
      : scheduleBaseline,
    timeZone: isScheduleTimeZone(value?.timeZone)
      ? value.timeZone
      : "Asia/Shanghai",
    weekStartsOn:
      Number.isInteger(value?.weekStartsOn) &&
      value!.weekStartsOn! >= 0 &&
      value!.weekStartsOn! <= 6
        ? value!.weekStartsOn!
        : 1,
  }
}
export function timelineViewport(settings: TimelineSettings): ScheduleViewport {
  const start =
    settings.scale === "week"
      ? startOfScheduleWeek(settings.anchorDate, settings.weekStartsOn)
      : settings.scale === "quarter"
        ? `${settings.anchorDate.slice(0, 4)}-${String(Math.floor((Number(settings.anchorDate.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`
        : `${settings.anchorDate.slice(0, 7)}-01`
  return {
    ...settings,
    rangeStart: start,
    rangeEnd:
      settings.scale === "week"
        ? addScheduleDays(start, 6)
        : addScheduleDays(
            addScheduleMonths(start, settings.scale === "quarter" ? 3 : 1),
            -1,
          ),
  }
}
export function calendarViewport(settings: CalendarSettings): ScheduleViewport {
  const start =
    settings.mode === "week"
      ? startOfScheduleWeek(settings.anchorDate, settings.weekStartsOn)
      : startOfScheduleWeek(
          `${settings.anchorDate.slice(0, 7)}-01`,
          settings.weekStartsOn,
        )
  const last =
    settings.mode === "week"
      ? addScheduleDays(start, 6)
      : addScheduleDays(
          addScheduleMonths(`${settings.anchorDate.slice(0, 7)}-01`, 1),
          -1,
        )
  return {
    ...settings,
    rangeStart: start,
    rangeEnd:
      settings.mode === "week"
        ? last
        : addScheduleDays(startOfScheduleWeek(last, settings.weekStartsOn), 6),
  }
}
export type ScheduleChangeIntent = {
  operationId: string
  itemId: string
  baseRevision: number
  queryKey: string
  kind:
    | "shift"
    | "resizeStart"
    | "resizeEnd"
    | "setDueDate"
    | "setRange"
    | "clearDates"
  previousDates: ScheduleDates
  nextDates: ScheduleDates
}
export const workItemDates = (item: WorkItemRecord): ScheduleDates => ({
  startDate: item.startDate ?? null,
  dueDate: item.dueDate,
})
export type ScheduleValidationError =
  "stale" | "locked" | "noop" | "denied" | "invalidDate" | "invalidRange"
export function validateScheduleChange(
  intent: ScheduleChangeIntent,
  context: {
    item: WorkItemRecord
    queryKey: string
    capabilities: WorkItemCapabilities
    mutation?: MutationState
  },
): ScheduleValidationError | null {
  const { item, capabilities, mutation } = context,
    prev = workItemDates(item),
    next = intent.nextDates
  if (
    intent.itemId !== item.id ||
    intent.queryKey !== context.queryKey ||
    intent.baseRevision !== item.revision ||
    prev.startDate !== intent.previousDates.startDate ||
    prev.dueDate !== intent.previousDates.dueDate
  )
    return "stale"
  if (!intent.operationId || isMutationLocked(mutation)) return "locked"
  const error = scheduleDateError(next)
  if (error) return error
  const start = prev.startDate !== next.startDate,
    due = prev.dueDate !== next.dueDate
  if (!start && !due) return "noop"
  if (
    (start && !capabilities.canEditField(item, "startDate")) ||
    (due && !capabilities.canEditField(item, "dueDate"))
  )
    return "denied"
  if (intent.kind === "shift") {
    if (
      !prev.startDate ||
      !prev.dueDate ||
      !next.startDate ||
      !next.dueDate ||
      scheduleDateError(prev) ||
      !capabilities.canEditField(item, "startDate") ||
      !capabilities.canEditField(item, "dueDate") ||
      scheduleDayDifference(next.startDate, prev.startDate) !==
        scheduleDayDifference(next.dueDate, prev.dueDate)
    )
      return "invalidRange"
  }
  if ((intent.kind === "setDueDate" || intent.kind === "resizeEnd") && start)
    return "invalidRange"
  if (intent.kind === "resizeStart" && due) return "invalidRange"
  if (intent.kind === "clearDates" && (next.startDate || next.dueDate))
    return "invalidRange"
  return null
}
export type DateBucketSnapshot = {
  date: string
  queryKey: string
  itemIds: readonly string[]
  loadedCount: number
  totalCount: number | null
  cursor?: string
  hasMore?: boolean
  dataState: DataState
  error?: string
}
export type ScheduleRangeSnapshot = Omit<DateBucketSnapshot, "date"> & {
  rangeStart: string
  rangeEnd: string
}
export function mergeSchedulePage<
  T extends DateBucketSnapshot | ScheduleRangeSnapshot,
>(current: T, page: T): T {
  if (
    current.queryKey !== page.queryKey ||
    ("date" in current && "date" in page && current.date !== page.date) ||
    ("rangeStart" in current &&
      "rangeStart" in page &&
      (current.rangeStart !== page.rangeStart ||
        current.rangeEnd !== page.rangeEnd))
  )
    return current
  const itemIds = [...new Set([...current.itemIds, ...page.itemIds])]
  return { ...page, itemIds, loadedCount: itemIds.length }
}
/** Complete local sources only. Remote services must query range intersection, not start-in-range. */
export function scheduleIntersects(
  item: WorkItemRecord,
  viewport: ScheduleViewport,
  missing: "include" | "exclude" = "include",
) {
  const dates = workItemDates(item)
  if (scheduleDateError(dates)) return true
  if (dates.startDate && dates.dueDate)
    return (
      dates.startDate <= viewport.rangeEnd &&
      dates.dueDate >= viewport.rangeStart
    )
  const date = dates.startDate ?? dates.dueDate
  return date
    ? date >= viewport.rangeStart && date <= viewport.rangeEnd
    : missing === "include"
}
