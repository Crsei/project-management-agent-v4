import type { DataTableSort } from "@/components/blocks/data-table"
import {
  createDashboardFixture,
  type DashboardFixture,
  type DashboardIssue,
} from "./dashboard-1-fixtures"
import type { PmScenario } from "./model"
import { usePmScenarioState } from "./shared"

export type DashboardScope =
  "overview" | "assigned" | "reported" | "watching" | "updates"
export type FixtureOutcome = "confirmed" | "rejected" | "unknown"
export type DashboardDraft = {
  title: string
  status: string
  email: string
  outcome: FixtureOutcome
  result: FixtureOutcome | "idle"
  requestId: string | null
  submitted: { title: string; status: string; email: string } | null
  error: "required" | "email" | null
  checkOutcome: "confirmed" | "rejected"
}
export type DashboardState = DashboardFixture & {
  scope: DashboardScope
  query: string
  statusFilter: string
  period: number
  selectedDay: string | null
  selectedIds: string[]
  sort: DataTableSort
  selectedIssueId: string | null
  dialog: string | null
  agendaTab: string
  expandedAgenda: string[]
  drafts: Record<string, DashboardDraft>
  requestSequence: number
  timer: {
    issueId: string
    seconds: number
    running: boolean
    started: boolean
  }
  notice: "saved" | "discarded" | null
}
export function createDashboardState(scenario: PmScenario): DashboardState {
  const fixture = createDashboardFixture(scenario)
  return {
    ...fixture,
    scope: "overview",
    query: "",
    statusFilter: "all",
    period: 5,
    selectedDay: null,
    selectedIds: [],
    sort: null,
    selectedIssueId: null,
    dialog: null,
    agendaTab: "meetings",
    expandedAgenda: [],
    drafts: {},
    requestSequence: 0,
    timer: {
      issueId: fixture.issues[0]?.id ?? "",
      seconds: 0,
      running: false,
      started: false,
    },
    notice: null,
  }
}
export function useDashboardState(scenario: PmScenario) {
  return usePmScenarioState("dashboard-1-state", () =>
    createDashboardState(scenario),
  )
}
export function dashboardIssues(
  state: DashboardState,
  locale: "zh-CN" | "en",
): DashboardIssue[] {
  let issues = state.issues.filter((issue) =>
    state.scope === "assigned"
      ? issue.assignedToMe
      : state.scope === "reported"
        ? issue.createdByMe
        : state.scope === "watching"
          ? issue.watching
          : state.scope === "updates"
            ? issue.revision > 1
            : issue.assignedToMe || issue.watching,
  )
  if (state.statusFilter !== "all")
    issues = issues.filter((issue) => issue.stateId === state.statusFilter)
  const query = state.query.trim().toLocaleLowerCase()
  if (query)
    issues = issues.filter((issue) =>
      `${issue.identifier} ${issue.titleCopy[locale]} ${issue.titleCopy.en} ${issue.labelIds.join(" ")}`
        .toLocaleLowerCase()
        .includes(query),
    )
  if (state.selectedDay) {
    const worked = new Set(
      state.logs
        .filter((log) => log.date === state.selectedDay)
        .map((log) => log.issueId),
    )
    issues = issues.filter((issue) => worked.has(issue.id))
  }
  issues = issues.map((issue) => ({ ...issue, title: issue.titleCopy[locale] }))
  if (state.sort) {
    const { columnId, direction } = state.sort
    const priority: Record<string, number> = { high: 0, medium: 1, low: 2 }
    issues = [...issues].sort((a, b) => {
      const value =
        columnId === "priority"
          ? priority[a.priorityId] - priority[b.priorityId]
          : (columnId === "due" ? (a.dueDate ?? "") : a.title).localeCompare(
              columnId === "due" ? (b.dueDate ?? "") : b.title,
              locale,
            )
      return direction === "asc" ? value : -value
    })
  }
  return issues
}
export function dashboardLogs(state: DashboardState) {
  const end = state.clock.slice(0, 10)
  const from = new Date(state.clock)
  from.setUTCDate(from.getUTCDate() - state.period + 1)
  return state.logs.filter(
    (log) => log.date >= from.toISOString().slice(0, 10) && log.date <= end,
  )
}
export function openDashboardDraft(
  state: DashboardState,
  key: string,
): DashboardState {
  const issue = state.issues.find((item) => item.id === key)
  const draft = state.drafts[key] ?? {
    title: key === "profile" ? state.profile.name : (issue?.titleCopy.en ?? ""),
    status: issue?.stateId ?? "todo",
    email: state.profile.email,
    outcome: "confirmed",
    result: "idle",
    requestId: null,
    submitted: null,
    error: null,
    checkOutcome: "confirmed",
  }
  return {
    ...state,
    dialog: key,
    selectedIssueId: key === "profile" ? state.selectedIssueId : key,
    drafts: { ...state.drafts, [key]: draft },
    notice: null,
  }
}
function applyDraft(
  state: DashboardState,
  key: string,
  draft: DashboardDraft,
): DashboardState {
  const payload = draft.submitted ?? draft
  if (key === "profile")
    return {
      ...state,
      profile: {
        ...state.profile,
        name: payload.title.trim(),
        email: payload.email.trim(),
      },
    }
  return {
    ...state,
    issues: state.issues.map((issue) =>
      issue.id === key
        ? {
            ...issue,
            title: payload.title.trim(),
            titleCopy: {
              en: payload.title.trim(),
              "zh-CN": payload.title.trim(),
            },
            stateId: payload.status,
            revision: issue.revision + 1,
          }
        : issue,
    ),
  }
}
export function submitDashboardDraft(
  state: DashboardState,
  key: string,
  readonly: boolean,
): DashboardState {
  const draft = state.drafts[key]
  if (readonly || !draft || draft.result === "unknown") return state
  const error = !draft.title.trim()
    ? "required"
    : key === "profile" &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())
      ? "email"
      : null
  if (error)
    return { ...state, drafts: { ...state.drafts, [key]: { ...draft, error } } }
  const sequence = state.requestSequence + 1
  const next: DashboardDraft = {
    ...draft,
    requestId: `dashboard-1-local-${sequence}`,
    error: null,
    submitted: { title: draft.title, status: draft.status, email: draft.email },
    result: draft.outcome,
  }
  let updated = {
    ...state,
    requestSequence: sequence,
    drafts: { ...state.drafts, [key]: next },
  }
  if (draft.outcome === "confirmed")
    updated = {
      ...applyDraft(updated, key, next),
      notice: "saved",
      dialog: null,
    }
  return updated
}
export function checkDashboardResult(
  state: DashboardState,
  key: string,
  readonly: boolean,
): DashboardState {
  const draft = state.drafts[key]
  if (readonly || draft?.result !== "unknown") return state
  const next = { ...draft, result: draft.checkOutcome }
  const updated = { ...state, drafts: { ...state.drafts, [key]: next } }
  return next.result === "confirmed"
    ? { ...applyDraft(updated, key, next), notice: "saved", dialog: null }
    : updated
}
export function formatTimer(seconds: number) {
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((v) => String(v).padStart(2, "0"))
    .join(":")
}
