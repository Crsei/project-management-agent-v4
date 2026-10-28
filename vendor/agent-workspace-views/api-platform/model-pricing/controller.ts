import type { DataTableSort } from "@easyuse-ui/ui/components/blocks/data-table"
import type { DataTableColumnConfig } from "@easyuse-ui/ui/lib/data-table-model"
import { dataTableQueryKey } from "@easyuse-ui/ui/lib/data-table-model"
import { createCatalogModels } from "../fixtures/models.ts"
import { apScope } from "../model.ts"
import type {
  ApModel,
  ApScenario,
  ApCapability,
  ApPrice,
  ApOperationResult,
  ApTokenPriceUnit,
} from "../model"
/**
 * Explicit local outcome of a default-model save attempt. `recorded` is the
 * fixture-stored result that only an explicit check may reveal after `unknown`;
 * the fixture never records a confirmation behind an unknown result, so an
 * unknown outcome can never update the default model.
 */
export type PricingSaveFixture = {
  outcome: "confirmed" | "rejected" | "unknown"
  recorded?: "confirmed" | "rejected"
}
export const pricingSaveFixture: Readonly<Record<string, PricingSaveFixture>> =
  {
    "sakana/fugu-max": { outcome: "rejected" },
    "openai/gpt-live-1": { outcome: "unknown", recorded: "rejected" },
  }
export function fixtureSaveOutcome(modelId: string): PricingSaveFixture {
  return pricingSaveFixture[modelId] ?? { outcome: "confirmed" }
}
/** Seeded workspace default; all later changes go through the local save flow. */
export const apInitialDefaultModelId = "google/gemini-3.8-flash"
export type PricingSaveState = {
  status: ApOperationResult
  intent: "save" | "check" | null
  operationId: string | null
  targetId: string | null
}
export type PricingState = {
  models: ApModel[]
  canWrite: boolean
  search: string
  provider: string
  capability: "all" | ApCapability
  tokenUnit: ApTokenPriceUnit
  sort: DataTableSort
  page: number
  pageSize: number
  columns: DataTableColumnConfig
  expandedId: string | null
  savedDefaultId: string
  draftDefaultId: string | null
  save: PricingSaveState
  saveCount: number
  refresh: "idle" | "pending" | "error"
  refreshIntent: "refresh" | "retry" | null
  refreshFails: boolean
  recovered: boolean
  notice: "idle" | "refreshed"
}
export function createPricingState(scenario: ApScenario): PricingState {
  return {
    models: createCatalogModels(scenario),
    canWrite: apScope.canWrite && scenario !== "readonly",
    search: "",
    provider: "all",
    capability: "all",
    tokenUnit: "million-tokens",
    sort: { columnId: "model", direction: "asc" },
    page: 1,
    pageSize: 10,
    columns: {},
    expandedId: null,
    savedDefaultId: apInitialDefaultModelId,
    draftDefaultId: null,
    save: { status: "idle", intent: null, operationId: null, targetId: null },
    saveCount: 0,
    refresh: scenario === "refresh-error" ? "error" : "idle",
    refreshIntent: null,
    refreshFails: scenario === "refresh-error",
    recovered: false,
    notice: "idle",
  }
}
type KnownApPrice = Extract<ApPrice, { kind: "known" }>
/** Fixed billing-unit cohort order; cohorts stay together in both sort directions. */
const priceUnitOrder: Readonly<Record<KnownApPrice["unit"], number>> = {
  "million-tokens": 0,
  second: 1,
  hour: 2,
  "thousand-requests": 3,
}
type PriceRank = { cohort: number; microUsd: number } | null
/** Canonical micro-USD rank; free is known zero, unknown/not-applicable stay unranked. */
function priceRank(price: ApPrice): PriceRank {
  if (price.kind !== "known") return null
  return { cohort: priceUnitOrder[price.unit], microUsd: price.microUsd }
}
/**
 * Sort by billing-unit cohort first (fixed order, never reversed), then by
 * canonical micro-USD within the cohort (direction applies here only), so a
 * low per-second price never outranks an unrelated per-token price.
 * Unknown/not-applicable values stay last in both directions.
 */
function compareRanked(
  av: PriceRank,
  bv: PriceRank,
  modelA: ApModel,
  modelB: ApModel,
  direction: number,
) {
  if (av === null || bv === null) {
    if (av === null && bv === null)
      return modelA.modelId.localeCompare(modelB.modelId)
    return av === null ? 1 : -1
  }
  if (av.cohort !== bv.cohort) return av.cohort - bv.cohort
  return (
    (av.microUsd - bv.microUsd) * direction ||
    modelA.modelId.localeCompare(modelB.modelId)
  )
}
export function filterPricing(state: PricingState): ApModel[] {
  const search = state.search.trim().toLowerCase()
  const rows = state.models.filter(
    (m) =>
      (!search ||
        `${m.modelId} ${m.name} ${m.provider}`
          .toLowerCase()
          .includes(search)) &&
      (state.provider === "all" || m.providerId === state.provider) &&
      (state.capability === "all" ||
        m.capabilities?.includes(state.capability)),
  )
  const direction = state.sort?.direction === "desc" ? -1 : 1
  if (state.sort?.columnId === "input")
    return rows.sort((a, b) =>
      compareRanked(
        priceRank(a.inputPrice),
        priceRank(b.inputPrice),
        a,
        b,
        direction,
      ),
    )
  if (state.sort?.columnId === "output")
    return rows.sort((a, b) =>
      compareRanked(
        priceRank(a.outputPrice),
        priceRank(b.outputPrice),
        a,
        b,
        direction,
      ),
    )
  const value = (m: ApModel): string | number | null =>
    state.sort?.columnId === "context" ? m.contextTokens : m.name
  return rows.sort((a, b) => {
    const av = value(a),
      bv = value(b)
    // Missing context sorts last in both directions.
    if (av === null || bv === null) {
      if (av === null && bv === null) return a.modelId.localeCompare(b.modelId)
      return av === null ? 1 : -1
    }
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv))
    return cmp * direction || a.modelId.localeCompare(b.modelId)
  })
}
export function pricingPage(state: PricingState) {
  const rows = filterPricing(state),
    pageCount = Math.max(1, Math.ceil(rows.length / state.pageSize)),
    page = Math.min(state.page, pageCount)
  return {
    rows,
    total: rows.length,
    page,
    pageCount,
    visible: rows.slice((page - 1) * state.pageSize, page * state.pageSize),
  }
}
export function updatePricingFilter<
  K extends "search" | "provider" | "capability",
>(state: PricingState, key: K, value: PricingState[K]): PricingState {
  return { ...state, [key]: value, page: 1, expandedId: null }
}
export function pricingQueryKey(state: PricingState) {
  return dataTableQueryKey({
    scope: `${apScope.orgId}:${apScope.projectId}`,
    filter: JSON.stringify([state.search, state.provider, state.capability]),
    sort: state.sort,
    page: state.page,
    pageSize: state.pageSize,
  })
}
export function selectDraft(
  state: PricingState,
  modelId: string,
): PricingState {
  if (!state.canWrite || state.save.status === "unknown") return state
  if (state.save.status === "pending") return state
  return {
    ...state,
    draftDefaultId: modelId === state.savedDefaultId ? null : modelId,
    save: { status: "idle", intent: null, operationId: null, targetId: null },
  }
}
export function beginSave(state: PricingState): PricingState {
  if (!state.canWrite || state.draftDefaultId === null) return state
  if (state.save.status === "pending" || state.save.status === "unknown")
    return state
  const count = state.saveCount + 1
  return {
    ...state,
    saveCount: count,
    save: {
      status: "pending",
      intent: "save",
      operationId: `op-pricing-${count}`,
      targetId: state.draftDefaultId,
    },
  }
}
export function beginCheck(state: PricingState): PricingState {
  if (!state.canWrite || state.save.status !== "unknown") return state
  return {
    ...state,
    save: { ...state.save, status: "pending", intent: "check" },
  }
}
export function resolvePending(state: PricingState): PricingState {
  const { intent, targetId, operationId } = state.save
  if (state.save.status !== "pending" || !targetId) return state
  if (intent === "check") {
    const recorded = fixtureSaveOutcome(targetId).recorded ?? "rejected"
    return {
      ...state,
      save: {
        status: recorded,
        intent: null,
        operationId: null,
        targetId,
      },
    }
  }
  const { outcome } = fixtureSaveOutcome(targetId)
  if (outcome === "confirmed")
    return {
      ...state,
      savedDefaultId: targetId,
      draftDefaultId: null,
      save: {
        status: "confirmed",
        intent: null,
        operationId: null,
        targetId,
      },
    }
  if (outcome === "rejected")
    return {
      ...state,
      save: {
        status: "rejected",
        intent: null,
        operationId: null,
        targetId,
      },
    }
  // Unknown keeps the operation ID, never the default, and blocks replay.
  return {
    ...state,
    save: {
      status: "unknown",
      intent: null,
      operationId,
      targetId,
    },
  }
}
export function cancelDraft(state: PricingState): PricingState {
  if (!state.canWrite) return state
  if (state.save.status === "pending" || state.save.status === "unknown")
    return state
  return {
    ...state,
    draftDefaultId: null,
    save: { status: "idle", intent: null, operationId: null, targetId: null },
  }
}
export function completeLoad(state: PricingState): PricingState {
  return { ...state, recovered: true }
}
export function beginRefresh(
  state: PricingState,
  intent: "refresh" | "retry",
): PricingState {
  if (state.refresh === "pending") return state
  return {
    ...state,
    refresh: "pending",
    refreshIntent: intent,
    notice: "idle",
  }
}
export function settleRefresh(state: PricingState): PricingState {
  if (state.refresh !== "pending") return state
  if (state.refreshIntent === "retry" || !state.refreshFails)
    return {
      ...state,
      refresh: "idle",
      refreshIntent: null,
      refreshFails: false,
      recovered: true,
      notice: "refreshed",
    }
  return {
    ...state,
    refresh: "error",
    refreshIntent: null,
    notice: "idle",
  }
}
