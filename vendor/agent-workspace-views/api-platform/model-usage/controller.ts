import { apScope, type ApModel, type ApScenario } from "../model.ts"
import { apModels } from "../fixtures/models.ts"
import {
  apUsagePeriod,
  createApUsageRequests,
  type ApUsageRequest,
} from "../fixtures/usage-ledger.ts"

export type UsagePeriod = "14" | "30"
export type UsageStatementPeriod = {
  from: string
  to: string
  timeZone: string
  source: string
  revision: string
}
/** A row can be an individual request or an explicit same-outcome daily aggregate. */
export type UsageRequest = ApUsageRequest & { requestCount?: number }
export type ModelUsageFixture = {
  models: readonly ApModel[]
  projects: readonly { projectId: string; name: string }[]
  period: UsageStatementPeriod
  requests: UsageRequest[]
}
export type UsageTotals = {
  requests: number
  successful: number
  failed: number
  limited: number
  unknown: number
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  tokens: number | null
  costMicroUsd: number | null
  latencyMs: number | null
  missingUsage: number
}
export type UsageDay = UsageTotals & { date: string; requestIds: string[] }
export type UsageModel = {
  model: ApModel | null
  modelId: string
  totals: UsageTotals
  days: UsageDay[]
}
export type BudgetOperation = {
  operationId: string
  payload: {
    modelId: string
    budgetMicroUsd: number | null
    period: UsageStatementPeriod
  }
  status: "pending" | "rejected" | "unknown" | "confirmed"
}
export type ModelUsageState = {
  requests: UsageRequest[]
  models: readonly ApModel[]
  statementPeriod: UsageStatementPeriod
  projectId: string
  period: UsagePeriod
  selected: {
    modelId: string
    kind: "activity" | "budget" | "model"
    date: string | null
  } | null
  budgets: Record<string, number | null>
  drafts: Record<string, string>
  budgetError: boolean
  operation: BudgetOperation | null
  nextOperation: number
  result: "confirmed" | "pending" | "rejected" | "unknown"
  recovered: boolean
  notice: "exported" | "saved" | null
}
export const usageModels = apModels
  .filter((model) => model.modality === "text")
  .slice(0, 4)
export function createModelUsageState(
  scenario: ApScenario,
  fixture?: ModelUsageFixture,
): ModelUsageState {
  const models = fixture?.models ?? usageModels
  return {
    requests: fixture?.requests ?? createApUsageRequests(scenario),
    models,
    statementPeriod: fixture?.period ?? apUsagePeriod,
    projectId: "all",
    period:
      scenario === "missing-data" || scenario === "long-content" ? "30" : "14",
    selected: null,
    budgets: Object.fromEntries(
      models.map((model, index) => [
        model.modelId,
        [600_000_000, 500_000_000, null, 0][index],
      ]),
    ),
    drafts: {},
    budgetError: false,
    operation: null,
    nextOperation: 1,
    result: "confirmed",
    recovered: false,
    notice: null,
  }
}
export function usageRange(
  period: UsagePeriod,
  statement: UsageStatementPeriod = apUsagePeriod,
) {
  const to = statement.to
  return {
    from: new Date(Date.parse(to) - Number(period) * 86_400_000).toISOString(),
    to,
    timeZone: statement.timeZone,
  }
}
export function usageQueryKey(
  state: Pick<ModelUsageState, "projectId" | "period"> &
    Partial<Pick<ModelUsageState, "statementPeriod">>,
) {
  return JSON.stringify([
    apScope.orgId,
    state.projectId,
    usageRange(state.period, state.statementPeriod),
  ])
}
export function inUsageRange(
  request: ApUsageRequest,
  range: { from: string; to: string },
) {
  const instant = Date.parse(request.startedAt)
  return instant >= Date.parse(range.from) && instant < Date.parse(range.to)
}
export function usageRequests(state: ModelUsageState, monthly = false) {
  const range = monthly
    ? state.statementPeriod
    : usageRange(state.period, state.statementPeriod)
  return state.requests.filter(
    (request) =>
      request.orgId === apScope.orgId &&
      (monthly ||
        state.projectId === "all" ||
        request.projectId === state.projectId) &&
      inUsageRange(request, range),
  )
}
function sumKnown(
  rows: readonly ApUsageRequest[],
  field: "inputTokens" | "outputTokens" | "cachedTokens" | "costMicroUsd",
) {
  return rows.some((row) => row[field] === null)
    ? null
    : rows.reduce((sum, row) => sum + row[field]!, 0)
}
export function usageTotals(rows: readonly UsageRequest[]): UsageTotals {
  const count = (row: UsageRequest) => row.requestCount ?? 1
  const inputTokens = sumKnown(rows, "inputTokens"),
    outputTokens = sumKnown(rows, "outputTokens")
  const requests = rows.reduce((sum, row) => sum + count(row), 0)
  let latencyMs: number | null = null
  if (requests && rows.every((row) => row.latencyMs !== null)) {
    const sorted = [...rows].sort((a, b) => a.latencyMs! - b.latencyMs!)
    let cumulative = 0,
      lower: number | null = null
    for (const row of sorted) {
      cumulative += count(row)
      if (lower === null && cumulative >= Math.ceil(requests / 2))
        lower = row.latencyMs
      if (cumulative > requests / 2) {
        latencyMs = (lower! + row.latencyMs!) / 2
        break
      }
    }
  }
  return {
    requests,
    successful: rows.reduce(
      (sum, row) => sum + (row.outcome === "success" ? count(row) : 0),
      0,
    ),
    failed: rows.reduce(
      (sum, row) =>
        sum +
        (row.outcome === "failed" && row.httpStatus !== 429 ? count(row) : 0),
      0,
    ),
    limited: rows.reduce(
      (sum, row) => sum + (row.httpStatus === 429 ? count(row) : 0),
      0,
    ),
    unknown: rows.reduce(
      (sum, row) => sum + (row.outcome === "unknown" ? count(row) : 0),
      0,
    ),
    inputTokens,
    outputTokens,
    cachedTokens: sumKnown(rows, "cachedTokens"),
    tokens:
      inputTokens === null || outputTokens === null
        ? null
        : inputTokens + outputTokens,
    costMicroUsd: sumKnown(rows, "costMicroUsd"),
    latencyMs,
    missingUsage: rows.filter(
      (row) =>
        row.inputTokens === null ||
        row.outputTokens === null ||
        row.costMicroUsd === null,
    ).length,
  }
}
export function modelUsageSelection(state: ModelUsageState) {
  const rows = usageRequests(state),
    range = usageRange(state.period, state.statementPeriod)
  const ids = [
    ...state.models.map((model) => model.modelId),
    ...new Set(
      rows
        .filter(
          (row) => !state.models.some((model) => model.modelId === row.modelId),
        )
        .map((row) => row.modelId),
    ),
  ]
  const models: UsageModel[] = ids.map((modelId) => {
    const requests = rows.filter((row) => row.modelId === modelId)
    return {
      modelId,
      model: state.models.find((model) => model.modelId === modelId) ?? null,
      totals: usageTotals(requests),
      days: Array.from({ length: Number(state.period) }, (_, index) => {
        const date = new Date(Date.parse(range.from) + index * 86_400_000)
          .toISOString()
          .slice(0, 10)
        const daily = requests.filter(
          (request) =>
            new Date(request.startedAt).toISOString().slice(0, 10) === date,
        )
        return {
          date,
          ...usageTotals(daily),
          requestIds: daily.map((request) => request.requestId),
        }
      }),
    }
  })
  return { rows, models, totals: usageTotals(rows), range }
}

export function modelUsageHealth(
  entry: UsageModel,
): "missing" | "errors" | "limited" | "healthy" | "ready" {
  if (entry.totals.missingUsage || entry.totals.unknown) return "missing"
  if (!entry.totals.requests) return "ready"
  const recent = entry.days.slice(-7)
  const requests = recent.reduce((sum, day) => sum + day.requests, 0)
  if (
    requests &&
    recent.reduce((sum, day) => sum + day.failed, 0) / requests > 0.02
  )
    return "errors"
  if (
    requests &&
    recent.reduce((sum, day) => sum + day.limited, 0) / requests > 0.1
  )
    return "limited"
  return "healthy"
}
export function changeUsageRange(
  state: ModelUsageState,
  change: Partial<Pick<ModelUsageState, "projectId" | "period">>,
): ModelUsageState {
  return {
    ...state,
    ...change,
    selected: null,
    budgetError: false,
    notice: null,
  }
}
export function openUsageDetail(
  state: ModelUsageState,
  modelId: string,
  kind: "activity" | "budget" | "model",
  date: string | null = null,
): ModelUsageState {
  return {
    ...state,
    selected: { modelId, kind, date },
    budgetError: false,
    notice: null,
    drafts: Object.hasOwn(state.drafts, modelId)
      ? state.drafts
      : {
          ...state.drafts,
          [modelId]:
            state.budgets[modelId] == null
              ? ""
              : String(state.budgets[modelId] / 1_000_000),
        },
  }
}
export function closeUsageDetail(state: ModelUsageState): ModelUsageState {
  const id = state.selected?.modelId
  return {
    ...state,
    selected: null,
    budgetError: false,
    drafts:
      id &&
      state.operation?.status !== "pending" &&
      state.operation?.status !== "unknown"
        ? {
            ...state.drafts,
            [id]:
              state.budgets[id] == null
                ? ""
                : String(state.budgets[id] / 1_000_000),
          }
        : state.drafts,
  }
}
export function parseBudget(value: string): {
  valid: boolean
  microUsd: number | null
} {
  if (value.trim() === "") return { valid: true, microUsd: null }
  if (!/^\d+(?:\.\d{1,6})?$/.test(value))
    return { valid: false, microUsd: null }
  const [dollars, fraction = ""] = value.split(".")
  const microUsd = Number(dollars) * 1_000_000 + Number(fraction.padEnd(6, "0"))
  return { valid: Number.isSafeInteger(microUsd), microUsd }
}
export function budgetUsageStatus(
  budget: number | null,
  cost: number | null,
): "unset" | "missing" | "zero" | "exceeded" | "within" {
  if (budget === null) return "unset"
  if (cost === null) return "missing"
  if (cost > budget) return "exceeded"
  return budget === 0 ? "zero" : "within"
}
export function saveUsageBudget(
  state: ModelUsageState,
  canWrite: boolean,
): ModelUsageState {
  if (
    !canWrite ||
    !state.selected ||
    ["pending", "unknown"].includes(state.operation?.status ?? "")
  )
    return state
  const modelId = state.selected.modelId,
    parsed = parseBudget(state.drafts[modelId] ?? "")
  if (!parsed.valid) return { ...state, budgetError: true }
  const operation: BudgetOperation = {
    operationId: `model-budget-fixture-${state.nextOperation}`,
    payload: {
      modelId,
      budgetMicroUsd: parsed.microUsd,
      period: state.statementPeriod,
    },
    status: state.result,
  }
  const next = {
    ...state,
    budgetError: false,
    operation,
    nextOperation: state.nextOperation + 1,
    notice: null,
  }
  return state.result === "confirmed" ? confirmUsageBudget(next) : next
}
export function confirmUsageBudget(state: ModelUsageState): ModelUsageState {
  const operation = state.operation
  if (!operation) return state
  return {
    ...state,
    budgets: {
      ...state.budgets,
      [operation.payload.modelId]: operation.payload.budgetMicroUsd,
    },
    drafts: {
      ...state.drafts,
      [operation.payload.modelId]:
        operation.payload.budgetMicroUsd === null
          ? ""
          : String(operation.payload.budgetMicroUsd / 1_000_000),
    },
    operation: { ...operation, status: "confirmed" },
    notice: "saved",
    selected: null,
  }
}
export function modelUsageExport(state: ModelUsageState) {
  const selection = modelUsageSelection(state)
  return JSON.stringify(
    {
      source: "fixture",
      revision: state.statementPeriod.revision,
      queryKey: usageQueryKey(state),
      range: selection.range,
      projectId: state.projectId,
      tokenAccounting: "inputTokens includes cachedTokens; total=input+output",
      totals: selection.totals,
      requestIds: selection.rows.map((row) => row.requestId),
      models: selection.models.map(({ modelId, totals, days }) => ({
        modelId,
        totals,
        days,
      })),
    },
    null,
    2,
  )
}
