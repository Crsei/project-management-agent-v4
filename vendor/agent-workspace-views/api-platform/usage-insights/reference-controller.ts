import type { ApScenario } from "../model.ts"
import {
  createUsageInsightsState,
  updateUsageFilter,
  usageExport,
  usageInsights,
  usageProjects,
  type UsageAmount,
  type UsageBucket,
  type UsageInsightsState,
  type UsageInsightsResult,
} from "./controller.ts"
import {
  referenceUsageAggregates,
  referenceUsageModels,
  referenceUsagePeriod,
  referenceUsageProjects,
} from "./fixtures.ts"

const dayMs = 86_400_000
export const isReferencePeriod = (period: UsageInsightsState["period"]) =>
  period === "year" || period === "90-days"

export function createReferenceUsageState(): UsageInsightsState {
  return { ...createUsageInsightsState(), selectedDay: "2026-09-24" }
}

export function updateReferenceUsageFilter(
  state: UsageInsightsState,
  key: "project" | "period",
  value: string,
): UsageInsightsState {
  const next = { ...state, [key]: value, notice: "" } as UsageInsightsState
  if (!isReferencePeriod(next.period)) {
    if (!usageProjects.some((project) => project.projectId === next.project))
      next.project = "all"
    return updateUsageFilter(
      next,
      key,
      key === "project" ? next.project : value,
    )
  }
  if (!referenceUsageAggregates[next.project]) next.project = "all"
  const from = referenceRange(next.period).from.slice(0, 10)
  if (next.selectedDay < from || next.selectedDay > "2026-09-24")
    next.selectedDay = "2026-09-24"
  return next
}

function referenceRange(period: UsageInsightsState["period"]) {
  return {
    from:
      period === "90-days" ? "2026-06-27T00:00:00Z" : referenceUsagePeriod.from,
    to: referenceUsagePeriod.to,
    timeZone: "UTC" as const,
  }
}

const amount = (
  observed: number,
  complete = true,
  missing = 0,
): UsageAmount => ({
  value: complete && !missing ? observed : null,
  observed,
  missing,
})

/** Aggregate snapshots stay separate from the account's thirty-row request ledger. */
export function referenceUsageInsights(
  state: Pick<
    UsageInsightsState,
    "project" | "period" | "metric" | "coverageDemo"
  >,
  scenario: ApScenario,
): UsageInsightsResult {
  if (!isReferencePeriod(state.period)) return usageInsights(state, scenario)
  const fixture =
    referenceUsageAggregates[state.project] ?? referenceUsageAggregates.all
  const range = referenceRange(state.period)
  const start = Date.parse(referenceUsagePeriod.from)
  const offset = Math.round((Date.parse(range.from) - start) / dayMs)
  const metric = state.metric
  const dailyModels: UsageAmount[][] = []
  const days: UsageBucket[] = []
  for (let index = offset; index < fixture.requests.length; index++) {
    const week = Math.floor(index / 7)
    const weekStart = week * 7
    const weekRequests = fixture.requests.slice(weekStart, weekStart + 7)
    const denominator = weekRequests.reduce((sum, value) => sum + value, 0)
    const before = weekRequests
      .slice(0, index % 7)
      .reduce((sum, value) => sum + value, 0)
    const requests = scenario === "empty" ? 0 : fixture.requests[index]
    const id = new Date(start + index * dayMs).toISOString().slice(0, 10)
    const complete = !(
      state.coverageDemo === "missing-day" && id === "2026-09-15"
    )
    const unknown =
      scenario === "missing-data" &&
      id === "2026-09-04" &&
      metric !== "requests"
    const modelAmounts = referenceUsageModels.map((_, model) => {
      const weekValue = fixture.weeks[metric][week][model]
      const observed =
        denominator && scenario !== "empty" && complete
          ? Math.round((weekValue * (before + requests)) / denominator) -
            Math.round((weekValue * before) / denominator)
          : 0
      return amount(
        unknown && model === 0 ? 0 : observed,
        complete,
        unknown && model === 0 ? 1 : 0,
      )
    })
    if (metric === "requests" && complete)
      modelAmounts[2] = amount(
        requests - modelAmounts[0].observed - modelAmounts[1].observed,
      )
    dailyModels.push(modelAmounts)
    const observed = modelAmounts.reduce((sum, item) => sum + item.observed, 0)
    days.push({
      id,
      from: `${id}T00:00:00Z`,
      to: new Date(start + (index + 1) * dayMs).toISOString(),
      requests: complete ? requests : null,
      amount: amount(observed, complete, unknown ? 1 : 0),
      complete,
    })
  }
  const sum = (values: UsageAmount[], complete = true) =>
    amount(
      values.reduce((total, value) => total + value.observed, 0),
      complete,
      values.reduce((total, value) => total + value.missing, 0),
    )
  const complete = days.every((day) => day.complete)
  const models = referenceUsageModels.map((model, index) => ({
    id: model.id,
    name: scenario === "long-content" && index === 0
      ? `${model.name} · Production customer-support and multilingual document-retrieval workspace`
      : model.name,
    amount: sum(
      dailyModels.map((values) => values[index]),
      complete,
    ),
  }))
  const weeks: UsageInsightsResult["weeks"] = []
  for (let index = 0; index < days.length;) {
    const count = Math.min(7 - ((offset + index) % 7), days.length - index)
    const weekDays = days.slice(index, index + count)
    const covered = weekDays.every((day) => day.complete)
    weeks.push({
      id: weekDays[0].id,
      from: weekDays[0].from,
      to: weekDays[weekDays.length - 1].to,
      requests: covered
        ? weekDays.reduce((total, day) => total + (day.requests ?? 0), 0)
        : null,
      complete: covered,
      amount: sum(
        weekDays.map((day) => day.amount),
        covered,
      ),
      models: Object.fromEntries(
        models.map((model, modelIndex) => [
          model.id,
          sum(
            dailyModels
              .slice(index, index + count)
              .map((values) => values[modelIndex]),
            covered,
          ),
        ]),
      ),
    })
    index += count
  }
  const totals = sum(
    days.map((day) => day.amount),
    complete,
  )
  const hourWeight = fixture.hours.reduce((total, value) => total + value, 0)
  let previous = 0
  const hours = fixture.hours.map((weight, hour) => {
    const cumulative = Math.round(
      (totals.observed *
        fixture.hours
          .slice(0, hour + 1)
          .reduce((total, value) => total + value, 0)) /
        hourWeight,
    )
    const value = cumulative - previous
    previous = cumulative
    return {
      id: String(hour).padStart(2, "0"),
      amount: amount(value, complete, totals.missing),
    }
  })
  let streak = 0,
    longest = 0
  for (const day of days) {
    streak = day.requests !== null && day.requests > 0 ? streak + 1 : 0
    longest = Math.max(longest, streak)
  }
  return {
    queryKey: JSON.stringify([
      referenceUsagePeriod.revision,
      state.project,
      range.from,
      range.to,
      metric,
      state.coverageDemo,
      scenario,
    ]),
    range,
    rows: [],
    days,
    weeks,
    hours,
    models,
    complete,
    missingDays: days.filter((day) => !day.complete).length,
    totals,
    requestCount: days.reduce((total, day) => total + (day.requests ?? 0), 0),
    streak,
    longest,
    busiest: days
      .filter((day) => day.requests !== null)
      .reduce<UsageBucket | null>(
        (best, day) =>
          !best || (day.requests ?? 0) > (best.requests ?? 0) ? day : best,
        null,
      ),
    peak: hours.reduce(
      (best, hour) =>
        hour.amount.observed > best.amount.observed ? hour : best,
      hours[0],
    ),
  }
}

export function referenceUsageExport(
  state: UsageInsightsState,
  scenario: ApScenario,
): string {
  if (!isReferencePeriod(state.period)) return usageExport(state, scenario)
  const result = referenceUsageInsights(state, scenario)
  return JSON.stringify(
    {
      source: referenceUsagePeriod.source,
      revision: referenceUsagePeriod.revision,
      queryKey: result.queryKey,
      scope: { projectId: state.project },
      range: result.range,
      metric: state.metric,
      unit: state.metric === "spend" ? "microUSD" : state.metric,
      complete: result.complete,
      precision:
        "Captured daily counts; rounded visible weekly token totals and USD cents; daily/model and hourly allocations are local aggregate fixtures, not request records.",
      totals: result.totals,
      days: result.days,
      weeks: result.weeks,
      hours: result.hours,
      models: result.models,
    },
    null,
    2,
  )
}

export { referenceUsageProjects, referenceUsageModels, referenceUsagePeriod }
