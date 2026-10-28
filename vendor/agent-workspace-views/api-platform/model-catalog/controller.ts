import type { DataTableSort } from "@easyuse-ui/ui/components/blocks/data-table"
import type { DataTableColumnConfig } from "@easyuse-ui/ui/lib/data-table-model"
import { dataTableQueryKey } from "@easyuse-ui/ui/lib/data-table-model"
import { createCatalogModels } from "../fixtures/models.ts"
import { apScope } from "../model.ts"
import type { ApModel, ApScenario, ApModality, ApCapability } from "../model"
export type CatalogState = {
  models: ApModel[]
  search: string
  modality: "all" | ApModality
  provider: string
  capability: "all" | ApCapability
  privacy: "all" | "zdr" | "no-training" | "free"
  sort: DataTableSort
  page: number
  pageSize: number
  columns: DataTableColumnConfig
  selectedId: string | null
  recovered: boolean
  notice: "idle" | "copied" | "copy-error" | "exported"
}
export function createCatalogState(scenario: ApScenario): CatalogState {
  return {
    models: createCatalogModels(scenario),
    search: "",
    modality: "all",
    provider: "all",
    capability: "all",
    privacy: "all",
    sort: { columnId: "released", direction: "desc" },
    page: 1,
    pageSize: 10,
    columns: {},
    selectedId: null,
    recovered: false,
    notice: "idle",
  }
}
export function filterCatalog(state: CatalogState): ApModel[] {
  const search = state.search.trim().toLowerCase()
  const rows = state.models.filter(
    (m) =>
      (!search ||
        `${m.modelId} ${m.name} ${m.provider}`
          .toLowerCase()
          .includes(search)) &&
      (state.modality === "all" || m.modality === state.modality) &&
      (state.provider === "all" || m.providerId === state.provider) &&
      (state.capability === "all" ||
        m.capabilities?.includes(state.capability)) &&
      (state.privacy === "all" ||
        (state.privacy === "zdr" && m.zeroRetention === true) ||
        (state.privacy === "no-training" && m.noTraining === true) ||
        (state.privacy === "free" && m.freeTier === true)),
  )
  const value = (m: ApModel): string | number | null => {
    switch (state.sort?.columnId) {
      case "model":
        return m.name
      case "provider":
        return m.provider
      case "released":
        return m.releasedAt
      case "latency":
        return m.latencyMs
      case "context":
        return m.contextTokens
      default:
        return m.modelId
    }
  }
  return rows.sort((a, b) => {
    const av = value(a),
      bv = value(b)
    if (av === null) return bv === null ? a.modelId.localeCompare(b.modelId) : 1
    if (bv === null) return -1
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv))
    return (
      cmp * (state.sort?.direction === "desc" ? -1 : 1) ||
      a.modelId.localeCompare(b.modelId)
    )
  })
}
export function catalogPage(state: CatalogState) {
  const rows = filterCatalog(state),
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
export function updateCatalogFilter<
  K extends "search" | "modality" | "provider" | "capability" | "privacy",
>(state: CatalogState, key: K, value: CatalogState[K]): CatalogState {
  return { ...state, [key]: value, page: 1, selectedId: null }
}
/** Export the complete filtered/sorted collection, independent of pagination or hidden columns. */
export function catalogExport(state: CatalogState) {
  return JSON.stringify(
    {
      source: "local-fixture",
      asOf: "2026-10-12T00:00:00Z",
      priceCurrency: "USD",
      models: filterCatalog(state),
    },
    null,
    2,
  )
}

export function catalogQueryKey(state: CatalogState) {
  return dataTableQueryKey({
    scope: `${apScope.orgId}:${apScope.projectId}`,
    filter: JSON.stringify([
      state.search,
      state.modality,
      state.provider,
      state.capability,
      state.privacy,
    ]),
    sort: state.sort,
    page: state.page,
    pageSize: state.pageSize,
  })
}
