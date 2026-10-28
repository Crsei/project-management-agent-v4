import type { DataTableSort } from "@easyuse-ui/ui/components/blocks/data-table"
import { creditReportExport, creditReportSelection } from "./report-controller.ts"
import { createCreditReportBuckets, type CreditReportBucket } from "./report-fixtures.ts"
import { apScope, type ApLocale, type ApScenario } from "../model.ts"
import {
  apUsageAgents,
  apUsageMembers,
  apUsagePeriod,
  createApUsageRequests,
  type ApUsageRequest,
} from "../fixtures/usage-ledger.ts"

export type CreditPeriod = "daily" | "weekly"
export type CreditBreakdown = "agents" | "members"
export type CreditFilter = {
  projectId: string
  from: string
  to: string
  identities: string[]
}
export type CreditUsageState = {
  requests: ApUsageRequest[]
  period: CreditPeriod
  breakdown: CreditBreakdown
  filter: CreditFilter
  draft: CreditFilter
  customRange: boolean
  searches: Record<CreditBreakdown, string>
  sorts: Record<CreditBreakdown, DataTableSort>
  identitySelections: Record<CreditBreakdown, string[]>
  recovered: boolean
  notice: string
  sourceOpen: boolean
  reportBuckets?: CreditReportBucket[]
  reportLongNames?: boolean
  groupSelections?: Record<CreditBreakdown, string[]>
}
export type CreditRanking = {
  id: string
  name: string
  unknownIdentity: boolean
  requests: number
  completedRequests: number
  hoursSaved: number | null
  category?: string | null
  groupId?: string
  knownCredits: number
  credits: number | null
  missingCredits: number
  share: number | null
}
const DAY = 86_400_000
const dateOf = (milliseconds: number) =>
  new Date(milliseconds).toISOString().slice(0, 10)
export function creditPeriodRange(period: CreditPeriod, ending: string) {
  const end = Date.parse(`${ending}T00:00:00Z`)
  return {
    from: dateOf(
      Math.max(
        Date.parse(apUsagePeriod.from),
        end - (period === "weekly" ? 6 : 0) * DAY,
      ),
    ),
    to: ending,
  }
}
export function createCreditUsageState(scenario: ApScenario, source: "ledger" | "run-report" = "ledger"): CreditUsageState {
  const range =
    scenario === "long-content"
      ? { from: "2026-09-01", to: "2026-09-30" }
      : creditPeriodRange(
          "weekly",
          scenario === "missing-data" && source === "ledger" ? "2026-09-07" : "2026-09-16",
        )
  const filter = { projectId: "all", ...range, identities: [] }
  return {
    requests: source === "ledger" ? createApUsageRequests(scenario) : [],
    period: "weekly",
    breakdown: "agents",
    filter,
    draft: { ...filter, identities: [] },
    customRange: scenario === "long-content",
    searches: { agents: "", members: "" },
    sorts: { agents: null, members: null },
    identitySelections: { agents: [], members: [] },
    recovered: false,
    notice: "",
    sourceOpen: false,
    ...(source === "run-report" ? {
      reportBuckets: createCreditReportBuckets(scenario),
      reportLongNames: scenario === "long-content",
      groupSelections: { agents: [], members: [] },
    } : {}),
  }
}
export function changeCreditPeriod(
  state: CreditUsageState,
  period: CreditPeriod,
): CreditUsageState {
  const range = creditPeriodRange(period, state.filter.to)
  return {
    ...state,
    period,
    customRange: false,
    filter: { ...state.filter, ...range },
    draft: { ...state.draft, ...range },
  }
}
export function creditRangeError(
  filter: CreditFilter,
): "invalid" | "outside-ledger" | null {
  const from = Date.parse(`${filter.from}T00:00:00Z`),
    to = Date.parse(`${filter.to}T00:00:00Z`)
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    dateOf(from) !== filter.from ||
    dateOf(to) !== filter.to ||
    from > to
  )
    return "invalid"
  if (
    from < Date.parse(apUsagePeriod.from) ||
    to >= Date.parse(apUsagePeriod.to)
  )
    return "outside-ledger"
  return null
}
export function applyCreditFilter(state: CreditUsageState): CreditUsageState {
  if (creditRangeError(state.draft)) return state
  return {
    ...state,
    filter: { ...state.draft, identities: [...state.draft.identities] },
    identitySelections: {
      ...state.identitySelections,
      [state.breakdown]: [...state.draft.identities],
    },
    customRange:
      state.draft.from !== creditPeriodRange(state.period, state.draft.to).from,
    notice: "",
  }
}
export function changeCreditRankingSort(state: CreditUsageState, requested: DataTableSort): CreditUsageState {
  const previous = state.sorts[state.breakdown]
  const columnId = requested?.columnId ?? previous?.columnId
  const sort: DataTableSort = state.reportBuckets && columnId ? { columnId, direction: previous?.columnId === columnId && previous.direction === "desc" ? "asc" : "desc" } : requested
  return { ...state, sorts: { ...state.sorts, [state.breakdown]: sort } }
}

export function clearCreditRankingFilters(state: CreditUsageState): CreditUsageState {
  return { ...state,
    searches: { ...state.searches, [state.breakdown]: "" },
    filter: { ...state.filter, identities: [] },
    identitySelections: { ...state.identitySelections, [state.breakdown]: [] },
    groupSelections: { agents: state.groupSelections?.agents ?? [], members: state.groupSelections?.members ?? [], [state.breakdown]: [] },
  }
}

export function creditScopedRequests(
  state: CreditUsageState,
): ApUsageRequest[] {
  const from = `${state.filter.from}T00:00:00.000Z`
  const to = new Date(
    Date.parse(`${state.filter.to}T00:00:00Z`) + DAY,
  ).toISOString()
  return state.requests.filter(
    (request) =>
      request.orgId === apScope.orgId &&
      (state.filter.projectId === "all" ||
        request.projectId === state.filter.projectId) &&
      request.startedAt >= from &&
      request.startedAt < to,
  )
}
export function creditUsageSelection(
  state: CreditUsageState,
  locale: ApLocale = "en",
) {
  if (state.reportBuckets) return creditReportSelection(state, locale)
  const requests = creditScopedRequests(state)
  const knownCredits = requests.reduce(
    (sum, request) => sum + (request.credits ?? 0),
    0,
  )
  const missingCredits = requests.filter(
    (request) => request.credits === null,
  ).length
  const credits = missingCredits ? null : knownCredits
  const directRequests = requests.filter((request) => !request.agentId)
  const agentRequests = requests.filter((request) => request.agentId)
  const roster =
    state.breakdown === "agents"
      ? apUsageAgents.map((agent) => ({ id: agent.agentId, name: agent.name }))
      : apUsageMembers.map((member) => ({
          id: member.memberId,
          name: member.name,
        }))
  const rows = new Map<string, CreditRanking>()
  // Include known identities with no activity: zero usage is not missing data.
  for (const identity of roster)
    rows.set(identity.id, {
      ...identity,
      unknownIdentity: false,
      requests: 0,
      completedRequests: 0,
      hoursSaved: null,
      knownCredits: 0,
      credits: 0,
      missingCredits: 0,
      share: null,
    })
  for (const request of requests) {
    const id =
      (state.breakdown === "agents" ? request.agentId : request.memberId) ||
      "identity-unassigned"
    let row = rows.get(id)
    if (!row) {
      row = {
        id,
        name: `${locale === "en" ? (state.breakdown === "agents" ? "Unknown agent" : "Unknown member") : state.breakdown === "agents" ? "未知 Agent" : "未知成员"} · ${id}`,
        unknownIdentity: true,
        requests: 0,
        completedRequests: 0,
        hoursSaved: null,
        knownCredits: 0,
        credits: 0,
        missingCredits: 0,
        share: null,
      }
      rows.set(id, row)
    }
    row.requests++
    if (request.outcome === "success") row.completedRequests++
    if (request.credits === null) row.missingCredits++
    else row.knownCredits += request.credits
  }
  const allRows = [...rows.values()]
  for (const row of allRows) {
    row.credits = row.missingCredits ? null : row.knownCredits
    row.share =
      credits !== null && credits > 0 && row.credits !== null
        ? (row.credits / credits) * 100
        : credits === 0 && row.credits === 0
          ? 0
          : null
  }
  const search = state.searches[state.breakdown]
    .trim()
    .toLocaleLowerCase(locale)
  const visibleRows = allRows.filter(
    (row) =>
      (!state.filter.identities.length ||
        state.filter.identities.includes(row.id)) &&
      (!search ||
        `${row.name} ${row.id}`.toLocaleLowerCase(locale).includes(search)),
  )
  const sort = state.sorts[state.breakdown]
  if (sort) {
    visibleRows.sort((a, b) => {
      const key = sort.columnId as
        "completedRequests" | "hoursSaved" | "credits"
      const av = a[key],
        bv = b[key]
      if (av === null) return bv === null ? a.id.localeCompare(b.id) : 1
      if (bv === null) return -1
      return (
        (av - bv) * (sort.direction === "asc" ? 1 : -1) ||
        a.id.localeCompare(b.id)
      )
    })
  }
  const completedRequests = requests.filter(
    (request) => request.outcome === "success",
  ).length
  const days =
    (Date.parse(`${state.filter.to}T00:00:00Z`) -
      Date.parse(`${state.filter.from}T00:00:00Z`)) /
      DAY +
    1
  const active = new Set(
    requests
      .map((request) =>
        state.breakdown === "agents" ? request.agentId : request.memberId,
      )
      .filter(Boolean),
  ).size
  return {
    requests,
    allRows,
    rows: visibleRows,
    knownCredits,
    missingCredits,
    credits,
    directCredits: directRequests.reduce(
      (total, row) => total + (row.credits ?? 0),
      0,
    ),
    directMissing: directRequests.filter((request) => request.credits === null)
      .length,
    agentCredits: agentRequests.reduce(
      (total, row) => total + (row.credits ?? 0),
      0,
    ),
    agentMissing: agentRequests.filter((request) => request.credits === null)
      .length,
    completedRequests,
    hoursSaved: null,
    active,
    days,
    average:
      completedRequests /
      (state.period === "daily" && !state.customRange ? 24 : days),
    creditCoverage: {
      observed: requests.length - missingCredits,
      total: requests.length,
    },
  }
}
export function creditUsageExport(
  state: CreditUsageState,
  locale: ApLocale = "en",
) {
  if (state.reportBuckets) return creditReportExport(state, locale)
  const selection = creditUsageSelection(state, locale)
  return JSON.stringify(
    {
      source: apUsagePeriod.source,
      ledgerRevision: apUsagePeriod.revision,
      scope: { orgId: apScope.orgId, projectId: state.filter.projectId },
      range: {
        from: `${state.filter.from}T00:00:00Z`,
        to: new Date(
          Date.parse(`${state.filter.to}T00:00:00Z`) + DAY,
        ).toISOString(),
        timeZone: apUsagePeriod.timeZone,
      },
      period: state.period,
      breakdown: state.breakdown,
      search: state.searches[state.breakdown],
      identities: state.filter.identities,
      sort: state.sorts[state.breakdown],
      unit: "credits",
      credits: selection.credits,
      knownCredits: selection.knownCredits,
      coverage: selection.creditCoverage,
      hoursSaved: null,
      countDefinition:
        "Completed requests, not Agent runs. Hours, categories and teams are not reported by the request ledger.",
      shareDefinition:
        "Credit share of the complete selected scope, not the visible/search-filtered rows. Unknown totals produce null shares.",
      rows: selection.rows,
      requestIds: selection.requests.map((request) => request.requestId),
    },
    null,
    2,
  )
}
