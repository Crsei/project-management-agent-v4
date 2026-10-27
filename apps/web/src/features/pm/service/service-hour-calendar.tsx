import { useMemo, useState } from "react"
import type { Entity } from "@contracts"
import { HourCalendarView } from "@/views/pm/hour-calendar"
import { useWorkspaceStore } from "@/providers/app-providers"
import { useDisplayDateTime } from "@/features/workspace/preference-format"
import type {
  HourCalendarActions,
  HourCalendarCapabilities,
  HourCalendarEvent,
  HourCalendarInteraction,
  HourCalendarIssueSource,
  HourCalendarReadModel,
} from "@/views/pm/hour-calendar-contracts"
import type { PmControlledData } from "@/views/pm/controlled-contracts"
import { string, today, useText } from "./pm-ui"

const DAY_MS = 86_400_000

/** Read the date-only portion of a persisted work item date. Timestamps keep
 * their UTC calendar day; invalid values remain unscheduled instead of being
 * guessed into an hourly event. */
function isoDay(value: unknown): string | null {
  const text = string(value)
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (!match) return null
  const day = `${match[1]}-${match[2]}-${match[3]}`
  const parsed = new Date(day + "T00:00:00.000Z")
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null
}

function nextDay(day: string): string {
  return new Date(Date.parse(day + "T00:00:00.000Z") + DAY_MS).toISOString().slice(0, 10)
}

export type ServiceHourCalendarProps = {
  items: Entity[]
  projects: Entity[]
  data?: PmControlledData
  onOpenIssue: (item: Entity) => void
  interactive?: boolean
}

/** Read-only bridge from real work item dates to the showcase HourCalendarView.
 * Work items persist inclusive all-day start/due dates, so every event is an
 * all-day UTC span. No timed events, meetings or reconciliation are invented. */
export function ServiceHourCalendar({ items, projects, data, onOpenIssue, interactive }: ServiceHourCalendarProps) {
  const t = useText()
  const weekStartsOn = useWorkspaceStore(state => state.weekStartsOn)
  const timeFormat = useWorkspaceStore(state => state.timeFormat)
  const display = useDisplayDateTime("UTC")
  const [interaction, setInteraction] = useState<HourCalendarInteraction>(() => ({
    anchorDate: today(),
    displayZone: "UTC",
    selectedId: null,
    reading: { top: 0, left: 0 },
    mode: "week",
    filters: { query: "", projectIds: [] },
    secondaryOpen: false,
  }))

  const { events, issueSources, presentation } = useMemo(() => {
    const nextEvents: HourCalendarEvent[] = []
    const unscheduled: HourCalendarIssueSource[] = []
    const labels: Record<string, { identifier?: string }> = {}
    for (const item of items) {
      const startDay = isoDay(item.data.startDate)
      const dueDay = isoDay(item.data.dueDate)
      const title = string(item.data.title)
      if (!startDay && !dueDay) {
        unscheduled.push({ id: item.id, projectId: item.projectId ?? "", identifier: item.id, title, startDate: null, dueDate: null })
        continue
      }
      const first = startDay && dueDay ? (startDay <= dueDay ? startDay : dueDay) : (startDay ?? dueDay)!
      const last = startDay && dueDay ? (startDay <= dueDay ? dueDay : startDay) : first
      nextEvents.push({
        id: item.id,
        issueId: item.id,
        projectId: item.projectId ?? "",
        title,
        startAt: `${first}T00:00:00.000Z`,
        endAt: `${nextDay(last)}T00:00:00.000Z`,
        timeZone: "UTC",
        allDay: true,
        version: String(item.version),
      })
      labels[item.id] = { identifier: item.id }
    }
    return { events: nextEvents, issueSources: unscheduled, presentation: labels }
  }, [items])

  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const projectOptions = useMemo(
    () => projects.map((project) => ({ id: project.id, label: string(project.data.name) || project.id })),
    [projects],
  )

  const actions = useMemo<HourCalendarActions>(() => ({
    setInteraction,
    create: () => undefined,
    edit: () => undefined,
    move: () => undefined,
    resize: () => undefined,
    delete: () => undefined,
    openIssue: (issueId) => {
      const item = itemById.get(issueId)
      if (item) onOpenIssue(item)
    },
    reconcile: () => undefined,
  }), [itemById, onOpenIssue, setInteraction])

  const reason = t(
    "此页面只读：排期由工作项的全天开始/截止日期维护。",
    "This page is read-only: scheduling is maintained by all-day work item start/due dates.",
  )
  const capabilities = useMemo<HourCalendarCapabilities>(() => ({
    create: false,
    edit: () => false,
    move: () => false,
    resize: () => false,
    delete: () => false,
    reason,
  }), [reason])

  const readModel = useMemo<HourCalendarReadModel>(() => {
    const fallback: PmControlledData = {
      state: events.length || issueSources.length ? "success" : "empty",
      emptyDescription: t("此项目没有工作项。", "This project has no work items."),
    }
    return {
      events,
      issueSources,
      data: data ?? fallback,
      today: today(),
      mutations: {},
      projects: projectOptions,
      presentation,
      displayZones: ["UTC"],
      sourceDescription: t(
        "真实服务的全天任务日期；未虚构小时事件或会议。",
        "Real all-day task dates only; no hourly events or meetings were invented.",
      ),
    }
  }, [data, events, issueSources, presentation, projectOptions, t])

  return <HourCalendarView interactive={interactive} readModel={readModel} interaction={interaction} capabilities={capabilities} actions={actions} weekStartsOn={weekStartsOn} timeFormat={timeFormat} formatDate={display.date} />
}
