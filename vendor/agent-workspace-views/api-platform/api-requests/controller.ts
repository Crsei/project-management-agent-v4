import type { DataTableColumnConfig } from "@easyuse-ui/ui/lib/data-table-model"
import type { DataTableSort } from "@easyuse-ui/ui/components/blocks/data-table"
import { apScope, type ApScenario } from "../model.ts"
import {
  apUsagePeriod,
  createApUsageRequests,
  type ApUsageRequest,
} from "../fixtures/usage-ledger.ts"
import {
  requestLogMetadata,
  requestPayload,
  type RequestPayload,
} from "./fixtures.ts"

export type RequestLevel = "success" | "warning" | "error" | "unknown"
export type RequestFilters = {
  search: string
  levels: string[]
  sources: string[]
  providers: string[]
  models: string[]
  date: string | null
  timelineDate: string | null
  minimumLatency: number
  statuses: number[]
  minimumFirstToken: number
  minimumCostMicroUsd: number
  cache: string | null
  environment: string | null
  projectId: string
}
export type RequestsState = {
  records: ApUsageRequest[]
  filters: RequestFilters
  selectedIds: string[]
  detailId: string | null
  tab: string
  expanded: string[]
  controlsVisible: boolean
  commandsOpen: boolean
  commandQuery: string
  loadedCount: number
  columns: DataTableColumnConfig
  sort: DataTableSort
  recovered: boolean
  partial: boolean
  invalidatedIds: string[]
  queriedIds: string[]
  notice: string
  lastAdvancedId: string | null
  operation: {
    operationId: string
    requestId: string
    payload: RequestPayload
  } | null
}
export function requestLevel(request: ApUsageRequest): RequestLevel {
  if (request.httpStatus === null) return "unknown"
  if (request.httpStatus >= 500) return "error"
  if (request.httpStatus >= 400) return "warning"
  return "success"
}
export function createRequestsState(scenario: ApScenario): RequestsState {
  return {
    records: createApUsageRequests(scenario),
    filters: {
      search: "",
      levels: [],
      sources: [],
      providers: [],
      models: [],
      date: null,
      timelineDate: null,
      minimumLatency: 0,
      statuses: [],
      minimumFirstToken: 0,
      minimumCostMicroUsd: 0,
      cache: null,
      environment: null,
      projectId: apScope.projectId,
    },
    selectedIds: [],
    detailId: null,
    tab: "request",
    expanded: ["level", "date"],
    controlsVisible: true,
    commandsOpen: false,
    commandQuery: "",
    loadedCount: 20,
    columns: {
      hiddenIds: [
        "source",
        "provider",
        "region",
        "ttft",
        "tokens",
        "cost",
        "project",
        "cache",
      ],
      widths: {
        level: 44,
        date: 184,
        id: 150,
        status: 60,
        model: 135,
        endpoint: 234,
        latency: 105,
        timing: 254,
      },
    },
    sort: { columnId: "date", direction: "desc" },
    recovered: false,
    partial: scenario === "missing-data",
    invalidatedIds: [],
    queriedIds: [],
    notice: "",
    lastAdvancedId: null,
    operation: null,
  }
}
export function scopeRequests(state: RequestsState) {
  return state.records.filter(
    (request) =>
      request.orgId === apScope.orgId &&
      (state.filters.projectId === "all" ||
        request.projectId === state.filters.projectId) &&
      request.startedAt >= apUsagePeriod.from &&
      request.startedAt < apUsagePeriod.to,
  )
}
export function filterRequests(
  state: RequestsState,
  ignoreTimeline = false,
): ApUsageRequest[] {
  const f = state.filters
  const search = f.search.trim().toLowerCase()
  const result = scopeRequests(state).filter((request) => {
    const meta = requestLogMetadata(request)
    return (
      (!f.levels.length || f.levels.includes(requestLevel(request))) &&
      (!f.sources.length || f.sources.includes(meta.source.id)) &&
      (!f.providers.length || f.providers.includes(request.providerId)) &&
      (!f.models.length || f.models.includes(request.modelId)) &&
      (!f.statuses.length ||
        (request.httpStatus !== null &&
          f.statuses.includes(request.httpStatus))) &&
      (!f.environment || meta.environment === f.environment) &&
      (!f.cache || meta.cacheStatus === f.cache) &&
      (f.minimumFirstToken === 0 ||
        (meta.firstTokenMs !== null &&
          meta.firstTokenMs >= f.minimumFirstToken)) &&
      (f.minimumCostMicroUsd === 0 ||
        (request.costMicroUsd !== null &&
          request.costMicroUsd >= f.minimumCostMicroUsd)) &&
      (!f.date || request.startedAt.slice(0, 10) === f.date) &&
      (ignoreTimeline ||
        !f.timelineDate ||
        request.startedAt.slice(0, 10) === f.timelineDate) &&
      (f.minimumLatency === 0 ||
        (request.latencyMs !== null &&
          request.latencyMs >= f.minimumLatency)) &&
      (!search ||
        [
          request.requestId,
          request.modelId,
          meta.model?.name,
          request.providerId,
          meta.source.label,
          meta.source.endpoint,
          request.httpStatus,
          request.projectId,
        ]
          .join(" ")
          .toLowerCase()
          .includes(search))
    )
  })
  const sort = state.sort
  if (!sort) return result
  const value = (request: ApUsageRequest): string | number | null => {
    const meta = requestLogMetadata(request)
    switch (sort.columnId) {
      case "date":
        return request.startedAt
      case "id":
        return request.requestId
      case "status":
        return request.httpStatus
      case "model":
        return request.modelId
      case "endpoint":
        return meta.source.endpoint
      case "latency":
        return request.latencyMs
      case "tokens":
        return request.inputTokens === null || request.outputTokens === null
          ? null
          : request.inputTokens + request.outputTokens
      case "cost":
        return request.costMicroUsd
      default:
        return request.requestId
    }
  }
  return result.sort((a, b) => {
    const x = value(a),
      y = value(b)
    if (x === null)
      return y === null ? a.requestId.localeCompare(b.requestId) : 1
    if (y === null) return -1
    const comparison =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y))
    return (
      comparison * (sort.direction === "asc" ? 1 : -1) ||
      a.requestId.localeCompare(b.requestId)
    )
  })
}
export function updateRequestFilter<K extends keyof RequestFilters>(
  state: RequestsState,
  key: K,
  value: RequestFilters[K],
): RequestsState {
  const next = {
    ...state,
    filters: { ...state.filters, [key]: value },
    loadedCount: 20,
    lastAdvancedId: null,
  }
  // Scope identity changes invalidate selection. Ordinary filters retain hidden selected IDs.
  return key === "projectId"
    ? { ...next, selectedIds: [], detailId: null }
    : next
}
export function advanceRequestSample(state: RequestsState): RequestsState {
  const filtered = filterRequests(state)
  if (state.loadedCount >= filtered.length) return state
  return {
    ...state,
    loadedCount: state.loadedCount + 1,
    lastAdvancedId: filtered[state.loadedCount].requestId,
    notice: "advanced",
  }
}
export function requestTimeline(state: RequestsState) {
  const records = filterRequests(state, true)
  return Array.from({ length: 30 }, (_, index) => {
    const date = `2026-09-${String(index + 1).padStart(2, "0")}`
    const rows = records.filter(
      (request) => request.startedAt.slice(0, 10) === date,
    )
    return {
      date,
      count: rows.length,
      errors: rows.filter((request) => requestLevel(request) === "error")
        .length,
      unknown: rows.filter((request) => request.outcome === "unknown").length,
    }
  })
}
export function requestExport(state: RequestsState, selectedOnly = false) {
  const records = filterRequests(state).filter(
    (request) => !selectedOnly || state.selectedIds.includes(request.requestId),
  )
  return JSON.stringify(
    {
      source: "local-fixture",
      revision: apUsagePeriod.revision,
      scope: { orgId: apScope.orgId, projectId: state.filters.projectId },
      period: apUsagePeriod,
      filters: state.filters,
      count: records.length,
      requests: records.map((request) => ({
        ...request,
        log: requestLogMetadata(request).source,
      })),
    },
    null,
    2,
  )
}
export function inspectRequest(
  state: RequestsState,
  requestId: string,
): RequestsState {
  const record = state.records.find(
    (request) => request.requestId === requestId,
  )
  if (!record) return state
  return {
    ...state,
    detailId: requestId,
    operation:
      record.outcome === "unknown"
        ? {
            operationId: `query-${requestId}`,
            requestId,
            payload: requestPayload(record),
          }
        : null,
  }
}

export function applyRequestCommand(
  state: RequestsState,
  command: string,
): RequestsState {
  if (command === "search") return state
  if (command.startsWith("level:"))
    return updateRequestFilter(state, "levels", [command.slice(6)])
  if (command.startsWith("source:"))
    return updateRequestFilter(state, "sources", [command.slice(7)])
  if (command.startsWith("status:"))
    return updateRequestFilter(state, "statuses", [Number(command.slice(7))])
  if (command.startsWith("provider:"))
    return updateRequestFilter(state, "providers", [command.slice(9)])
  if (command.startsWith("model:"))
    return updateRequestFilter(state, "models", [command.slice(6)])
  if (command.startsWith("project:"))
    return updateRequestFilter(state, "projectId", command.slice(8))
  if (command.startsWith("environment:"))
    return updateRequestFilter(state, "environment", command.slice(12))
  if (command.startsWith("cache:"))
    return updateRequestFilter(state, "cache", command.slice(6))
  const cleared: RequestsState = {
    ...state,
    filters: {
      ...state.filters,
      search: "",
      levels: [],
      sources: [],
      providers: [],
      models: [],
      date: null,
      timelineDate: null,
      minimumLatency: 0,
      statuses: [],
      minimumFirstToken: 0,
      minimumCostMicroUsd: 0,
      cache: null,
      environment: null,
    },
    loadedCount: 20,
    lastAdvancedId: null,
  }
  if (command === "all") return cleared
  if (command === "errors")
    return updateRequestFilter(cleared, "levels", ["error"])
  if (command === "slow-first-token")
    return updateRequestFilter(cleared, "minimumFirstToken", 1500)
  if (command === "high-cost")
    return updateRequestFilter(cleared, "minimumCostMicroUsd", 20000)
  if (command === "cache-misses")
    return updateRequestFilter(
      updateRequestFilter(cleared, "statuses", [200]),
      "cache",
      "miss",
    )
  return state
}
