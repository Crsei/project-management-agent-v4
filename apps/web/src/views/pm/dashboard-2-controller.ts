import type { DataTableSort } from "@/components/blocks/data-table"
import type { PmIssue } from "./issue-domain"
import type { PmScenario } from "./model"
import { usePmScenarioState } from "./shared"
import {
  dashboardNoteSeed,
  type DashboardNoteRecord,
} from "./dashboards-fixtures"
import {
  dashboardBucketStarts,
  dashboardWindow,
  issuesScheduledIn,
} from "./dashboards-views"

export type Dashboard2WindowDays = 7 | 14 | 28 | 56 | 84
export type Dashboard2State = {
  scope: string
  windowDays: Dashboard2WindowDays
  statusFilter: string
  weekFilter: string | null
  tableMode: "scheduled" | "unscheduled"
  query: string
  selectedIds: string[]
  sort: DataTableSort
  notes: DashboardNoteRecord[]
  noteDraft: { title: string; body: string } | null
  noteSequence: number
}
export function createDashboard2State(scenario: PmScenario): Dashboard2State {
  return {
    scope: "all",
    windowDays: 14,
    statusFilter: "all",
    weekFilter: null,
    tableMode: "scheduled",
    query: "",
    selectedIds: [],
    sort: null,
    notes: scenario === "empty" ? [] : [...dashboardNoteSeed],
    noteDraft: null,
    noteSequence: 0,
  }
}
export function useDashboard2State(scenario: PmScenario) {
  return usePmScenarioState("pm-dashboard-2-state", () =>
    createDashboard2State(scenario),
  )
}
/** Scope window applies to issue due dates; unscheduled issues are counted apart. */
export function dashboard2ScopedIssues(
  state: Dashboard2State,
  issues: readonly PmIssue[],
  locale: "en" | "zh-CN",
) {
  const query = state.query.trim().toLocaleLowerCase()
  return issues.filter((issue) => {
    if (state.scope !== "all" && issue.projectId !== state.scope) return false
    if (
      query &&
      !`${issue.identifier} ${issue.titleCopy[locale]} ${issue.titleCopy.en}`
        .toLocaleLowerCase()
        .includes(query)
    )
      return false
    return true
  })
}
export function dashboard2TableIssues(
  state: Dashboard2State,
  scoped: readonly PmIssue[],
  locale: "en" | "zh-CN",
) {
  let rows =
    state.tableMode === "unscheduled"
      ? scoped.filter((issue) => !issue.dueDate)
      : issuesScheduledIn(scoped, dashboardWindow(state.windowDays))
  if (state.weekFilter) {
    const starts = dashboardBucketStarts(state.windowDays)
    rows = rows.filter((issue) => {
      let match = ""
      for (const start of starts) if (issue.dueDate! >= start) match = start
      return match === state.weekFilter
    })
  }
  if (state.statusFilter === "open")
    rows = rows.filter((issue) => issue.stateId !== "done")
  else if (state.statusFilter !== "all")
    rows = rows.filter((issue) => issue.stateId === state.statusFilter)
  const mapped = rows.map((issue) => ({
    ...issue,
    title: issue.titleCopy[locale],
  }))
  if (!state.sort) return mapped
  const priority: Record<string, number> = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
  }
  const { columnId, direction } = state.sort
  return [...mapped].sort((a, b) => {
    const value =
      columnId === "priority"
        ? priority[a.priorityId] - priority[b.priorityId]
        : columnId === "estimate"
          ? (a.estimate ?? Number.MAX_SAFE_INTEGER) -
            (b.estimate ?? Number.MAX_SAFE_INTEGER)
          : columnId === "due"
            ? (a.dueDate ?? "").localeCompare(b.dueDate ?? "")
            : a.title.localeCompare(b.title, locale)
    return direction === "asc" ? value : -value
  })
}
/** Explicit confirm applies the note and clears only that draft. */
export function saveDashboard2Note(
  state: Dashboard2State,
  locked: boolean,
): Dashboard2State {
  const draft = state.noteDraft
  if (locked || !draft || !draft.title.trim()) return state
  const sequence = state.noteSequence + 1
  return {
    ...state,
    noteSequence: sequence,
    notes: [
      {
        id: `note-${sequence + 100}`,
        title: draft.title.trim(),
        body: draft.body.trim(),
        tag: "Local",
        at: "2026-01-12",
      },
      ...state.notes,
    ],
    noteDraft: null,
  }
}
export function discardDashboard2Note(state: Dashboard2State): Dashboard2State {
  return state.noteDraft ? { ...state, noteDraft: null } : state
}
