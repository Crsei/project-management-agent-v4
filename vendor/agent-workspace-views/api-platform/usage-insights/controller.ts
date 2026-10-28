import { apScope, type ApLocale, type ApScenario } from "../model.ts"
import { apModels } from "../fixtures/models.ts"
import { createApAccountData } from "../fixtures/accounts.ts"
import {
  apUsagePeriod,
  createApUsageRequests,
  type ApUsageRequest,
} from "../fixtures/usage-ledger.ts"

export type UsageMetric = "requests" | "tokens" | "spend"
export type UsagePeriod = "year" | "90-days" | "fixture" | "7-days"
export type UsageRange = { from: string; to: string; timeZone: "UTC" }
export type UsageAmount = {
  value: number | null
  observed: number
  missing: number
}
export type UsageBucket = {
  id: string
  from: string
  to: string
  requests: number | null
  amount: UsageAmount
  complete: boolean
}
export type UsageInsightsState = {
  project: string
  period: UsagePeriod
  metric: UsageMetric
  selectedDay: string
  table: "daily" | "weekly" | "hourly" | "models"
  coverageDemo: "normal" | "missing-day"
  recovered: boolean
  notice: string
}
export type UsageInsightsResult = {
  queryKey: string
  range: UsageRange
  rows: ApUsageRequest[]
  days: UsageBucket[]
  weeks: (UsageBucket & { models: Record<string, UsageAmount> })[]
  hours: { id: string; amount: UsageAmount }[]
  models: { id: string; name: string; amount: UsageAmount }[]
  complete: boolean
  missingDays: number
  totals: UsageAmount
  requestCount: number
  streak: number
  longest: number
  busiest: UsageBucket | null
  peak: { id: string; amount: UsageAmount }
}
const dayMs = 86_400_000
export const usageProjects = createApAccountData("default").projects
export function usageRange(period: UsagePeriod): UsageRange {
  const to = apUsagePeriod.to
  const days =
    period === "year"
      ? 365
      : period === "90-days"
        ? 90
        : period === "7-days"
          ? 7
          : 30
  return {
    from: new Date(Date.parse(to) - days * dayMs).toISOString(),
    to,
    timeZone: "UTC",
  }
}
export function createUsageInsightsState(): UsageInsightsState {
  return {
    project: "all",
    period: "year",
    metric: "requests",
    selectedDay: "2026-09-30",
    table: "daily",
    coverageDemo: "normal",
    recovered: false,
    notice: "",
  }
}
export function usageQueryKey(
  state: Pick<
    UsageInsightsState,
    "project" | "period" | "metric" | "coverageDemo"
  >,
): string {
  const range = usageRange(state.period)
  return JSON.stringify([
    apScope.orgId,
    state.project,
    range.from,
    range.to,
    range.timeZone,
    state.metric,
    state.coverageDemo,
  ])
}
export function selectUsageRequests(
  requests: readonly ApUsageRequest[],
  range: UsageRange,
  project = "all",
): ApUsageRequest[] {
  const from = Date.parse(range.from),
    to = Date.parse(range.to)
  return requests.filter(
    (request) =>
      request.orgId === apScope.orgId &&
      (project === "all" || request.projectId === project) &&
      Date.parse(request.startedAt) >= from &&
      Date.parse(request.startedAt) < to,
  )
}
export function usageAmount(
  requests: readonly ApUsageRequest[],
  metric: UsageMetric,
): UsageAmount {
  let observed = 0,
    missing = 0
  for (const request of requests) {
    const value =
      metric === "requests"
        ? 1
        : metric === "spend"
          ? request.costMicroUsd
          : request.inputTokens === null || request.outputTokens === null
            ? null
            : request.inputTokens + request.outputTokens
    if (value === null) missing++
    else observed += value
  }
  return { value: missing ? null : observed, observed, missing }
}
export function updateUsageFilter(
  state: UsageInsightsState,
  key: "project" | "period",
  value: string,
): UsageInsightsState {
  const next = { ...state, [key]: value, notice: "" } as UsageInsightsState
  const range = usageRange(next.period)
  if (
    next.selectedDay < range.from.slice(0, 10) ||
    next.selectedDay >= range.to.slice(0, 10)
  )
    next.selectedDay = new Date(Date.parse(range.to) - dayMs)
      .toISOString()
      .slice(0, 10)
  return next
}
export function usageModelName(modelId: string): string {
  return apModels.find((model) => model.modelId === modelId)?.name ?? modelId
}
export function formatUsageAmount(
  amount: UsageAmount,
  metric: UsageMetric,
  locale: ApLocale,
  compact = true,
): string {
  const number =
    metric === "spend"
      ? new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 2,
          maximumFractionDigits: compact ? 2 : 6,
        }).format(amount.observed / 1_000_000)
      : new Intl.NumberFormat(locale, {
          notation: compact ? "compact" : "standard",
          maximumFractionDigits: compact ? 1 : 0,
        }).format(amount.observed)
  return amount.value === null
    ? `${number} + ${locale === "en" ? "unknown" : "未知"}`
    : number
}
export function usageInsights(
  state: Pick<
    UsageInsightsState,
    "project" | "period" | "metric" | "coverageDemo"
  >,
  scenario: ApScenario,
): UsageInsightsResult {
  const range = usageRange(state.period)
  const rows = selectUsageRequests(
    createApUsageRequests(scenario),
    range,
    state.project,
  )
  const unavailableDay =
    state.coverageDemo === "missing-day" ? "2026-09-15" : null
  const observedRows = rows.filter(
    (row) =>
      new Date(row.startedAt).toISOString().slice(0, 10) !== unavailableDay,
  )
  const from = Date.parse(range.from),
    to = Date.parse(range.to)
  const coverageFrom = Date.parse(apUsagePeriod.from),
    coverageTo = Date.parse(apUsagePeriod.to)
  const days: UsageBucket[] = []
  for (let date = from; date < to; date += dayMs) {
    const start = new Date(date).toISOString(),
      end = new Date(Math.min(date + dayMs, to)).toISOString(),
      id = start.slice(0, 10)
    const complete =
      date >= coverageFrom &&
      date + dayMs <= coverageTo &&
      id !== unavailableDay
    const dayRows = observedRows.filter(
      (row) =>
        Date.parse(row.startedAt) >= date &&
        Date.parse(row.startedAt) < Math.min(date + dayMs, to),
    )
    const amount = usageAmount(dayRows, state.metric)
    days.push({
      id,
      from: start,
      to: end,
      requests: complete ? dayRows.length : null,
      amount: complete ? amount : { ...amount, value: null },
      complete,
    })
  }
  const modelIds = [
    ...new Set([
      ...apModels
        .filter((model) => model.modality === "text")
        .slice(0, 4)
        .map((model) => model.modelId),
      ...observedRows.map((row) => row.modelId),
    ]),
  ]
  const first = new Date(from),
    weekStart = from - first.getUTCDay() * dayMs
  const weeks: (UsageBucket & { models: Record<string, UsageAmount> })[] = []
  for (let week = weekStart; week < to; week += 7 * dayMs) {
    const start = new Date(Math.max(from, week)).toISOString(),
      end = new Date(Math.min(to, week + 7 * dayMs)).toISOString()
    const weekDays = days.filter((day) => day.from >= start && day.from < end),
      complete = weekDays.every((day) => day.complete)
    const weekRows = observedRows.filter(
      (row) =>
        Date.parse(row.startedAt) >= Math.max(from, week) &&
        Date.parse(row.startedAt) < Math.min(to, week + 7 * dayMs),
    )
    const amount = usageAmount(weekRows, state.metric)
    weeks.push({
      id: start.slice(0, 10),
      from: start,
      to: end,
      requests: complete ? weekRows.length : null,
      complete,
      amount: complete ? amount : { ...amount, value: null },
      models: Object.fromEntries(
        modelIds.map((id) => {
          const modelAmount = usageAmount(
            weekRows.filter((row) => row.modelId === id),
            state.metric,
          )
          return [id, complete ? modelAmount : { ...modelAmount, value: null }]
        }),
      ),
    })
  }
  const complete = days.every((day) => day.complete)
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    id: String(hour).padStart(2, "0"),
    amount: usageAmount(
      observedRows.filter(
        (row) => new Date(row.startedAt).getUTCHours() === hour,
      ),
      state.metric,
    ),
  }))
  const models = modelIds
    .map((id) => ({
      id,
      name: usageModelName(id),
      amount: usageAmount(
        observedRows.filter((row) => row.modelId === id),
        state.metric,
      ),
    }))
    .sort((a, b) => b.amount.observed - a.amount.observed)
  let streak = 0,
    longest = 0
  for (const day of days) {
    streak = day.requests !== null && day.requests > 0 ? streak + 1 : 0
    longest = Math.max(longest, streak)
  }
  const busiest = days
    .filter((day) => day.requests !== null)
    .reduce<UsageBucket | null>(
      (best, day) =>
        !best || (day.requests ?? 0) > (best.requests ?? 0) ? day : best,
      null,
    )
  const peak = hours.reduce(
    (best, hour) => (hour.amount.observed > best.amount.observed ? hour : best),
    hours[0],
  )
  return {
    queryKey: usageQueryKey(state),
    range,
    rows: observedRows,
    days,
    weeks,
    hours,
    models,
    complete,
    missingDays: days.filter((day) => !day.complete).length,
    totals: usageAmount(observedRows, state.metric),
    requestCount: observedRows.length,
    streak,
    longest,
    busiest,
    peak,
  }
}
export function usageExport(
  state: UsageInsightsState,
  scenario: ApScenario,
): string {
  const result = usageInsights(state, scenario)
  return JSON.stringify(
    {
      source: "fixture",
      revision: apUsagePeriod.revision,
      queryKey: result.queryKey,
      scope: { orgId: apScope.orgId, projectId: state.project },
      range: result.range,
      coverage: apUsagePeriod,
      metric: state.metric,
      unit: state.metric === "spend" ? "microUSD" : state.metric,
      complete: result.complete,
      totals: result.totals,
      days: result.days,
      weeks: result.weeks,
      hours: result.hours,
      models: result.models,
      requestIds: result.rows.map((row) => row.requestId),
    },
    null,
    2,
  )
}
