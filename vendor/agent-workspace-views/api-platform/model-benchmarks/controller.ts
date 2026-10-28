import type { DataTableSort } from "@easyuse-ui/ui/components/blocks/data-table"
import { analyticsQueryKey } from "@easyuse-ui/ui/lib/analytics-query"
import type {
  AnalyticsQuery,
  AnalyticsResult,
} from "@easyuse-ui/ui/lib/analytics-model"
import { createCatalogModels } from "../fixtures/models.ts"
import {
  apAsOf,
  apFixtureRevision,
  apScope,
  type ApCopy,
  type ApLocale,
  type ApModel,
  type ApScenario,
} from "../model.ts"
import { createBenchmarkResults, type ApBenchmarkResult } from "./fixtures.ts"

export type BenchmarkMeasure = "score" | "cost" | "latency"
export const measureMeta: Record<
  BenchmarkMeasure,
  { unit: string; label: ApCopy }
> = {
  score: { unit: "score", label: { "zh-CN": "分数", en: "Score" } },
  cost: { unit: "USD", label: { "zh-CN": "成本", en: "Cost" } },
  latency: { unit: "ms", label: { "zh-CN": "耗时", en: "Latency" } },
}
export type BenchmarkState = {
  models: ApModel[]
  results: ApBenchmarkResult[]
  search: string
  provider: string
  model: string
  dataset: string
  config: string
  measure: BenchmarkMeasure
  /** Explicit comparison cohort key; null picks the first filtered cohort. */
  cohort: string | null
  sort: DataTableSort
  selectedId: string | null
  recovered: boolean
  notice: "idle" | "exported"
}
export type BenchmarkSelection = {
  rows: ApBenchmarkResult[]
  cohorts: string[]
  cohort: string | null
  comparable: ApBenchmarkResult[]
  separated: ApBenchmarkResult[]
}

export function createBenchmarkState(scenario: ApScenario): BenchmarkState {
  return {
    models: createCatalogModels(scenario),
    results: createBenchmarkResults(scenario),
    search: "",
    provider: "all",
    model: "all",
    dataset: "all",
    config: "all",
    measure: "score",
    cohort: null,
    sort: { columnId: "score", direction: "desc" },
    selectedId: null,
    recovered: false,
    notice: "idle",
  }
}

/** Dataset + version + config + metric define one comparable cohort. */
export function benchmarkCohortKey(result: ApBenchmarkResult): string {
  return `${result.datasetId}@${result.datasetVersion}|${result.configId}|${result.metricId}`
}

export function modelFor(
  state: BenchmarkState,
  modelId: string,
): ApModel | undefined {
  return state.models.find((model) => model.modelId === modelId)
}

export function filterBenchmarkResults(state: BenchmarkState) {
  const search = state.search.trim().toLowerCase()
  return state.results.filter((result) => {
    const model = modelFor(state, result.modelId)
    return (
      (!search ||
        `${result.modelId} ${model?.name ?? ""} ${model?.provider ?? ""}`
          .toLowerCase()
          .includes(search)) &&
      (state.provider === "all" || model?.providerId === state.provider) &&
      (state.model === "all" || result.modelId === state.model) &&
      (state.dataset === "all" || result.datasetId === state.dataset) &&
      (state.config === "all" || result.configId === state.config)
    )
  })
}

function sortValue(
  state: BenchmarkState,
  result: ApBenchmarkResult,
): string | number | null {
  switch (state.sort?.columnId) {
    case "model":
      return modelFor(state, result.modelId)?.name ?? result.modelId
    case "dataset":
      return `${result.datasetId}@${result.datasetVersion}`
    case "config":
      return result.configLabel.en
    case "score":
      return result.score
    case "cost":
      return result.costMicroUsd
    case "latency":
      return result.latencyMs
    case "samples":
      return result.samplesObserved
    default:
      return result.score
  }
}

export function sortBenchmarkResults(
  state: BenchmarkState,
  rows: readonly ApBenchmarkResult[],
): ApBenchmarkResult[] {
  // Cohorts group first: rows of different datasets/configs/metrics are never
  // ranked against each other, whatever column the user sorts by.
  return [...rows].sort((a, b) => {
    const cohort = benchmarkCohortKey(a).localeCompare(benchmarkCohortKey(b))
    if (cohort) return cohort
    const av = sortValue(state, a),
      bv = sortValue(state, b)
    if (av === null)
      return bv === null ? a.resultId.localeCompare(b.resultId) : 1
    if (bv === null) return -1
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv))
    return (
      cmp * (state.sort?.direction === "desc" ? -1 : 1) ||
      a.resultId.localeCompare(b.resultId)
    )
  })
}

/** Filtered rows, distinct cohorts and the split between charted and separated rows. */
export function benchmarkSelection(state: BenchmarkState): BenchmarkSelection {
  const rows = sortBenchmarkResults(state, filterBenchmarkResults(state)),
    cohorts = [...new Set(rows.map(benchmarkCohortKey))].sort(),
    cohort =
      state.cohort && cohorts.includes(state.cohort)
        ? state.cohort
        : (cohorts[0] ?? null)
  return {
    rows,
    cohorts,
    cohort,
    comparable: cohort
      ? rows.filter((r) => benchmarkCohortKey(r) === cohort)
      : [],
    separated: cohort
      ? rows.filter((r) => benchmarkCohortKey(r) !== cohort)
      : rows,
  }
}

export function updateBenchmarkFilter<
  K extends "search" | "provider" | "model" | "dataset" | "config",
>(state: BenchmarkState, key: K, value: BenchmarkState[K]): BenchmarkState {
  return { ...state, [key]: value, selectedId: null, notice: "idle" }
}

export function measureValue(
  result: ApBenchmarkResult,
  measure: BenchmarkMeasure,
): number | null {
  if (measure === "score") return result.score
  if (measure === "cost") return result.costMicroUsd
  return result.latencyMs
}

/** Chart plots integer microUSD runs as USD so the shared axis stays readable. */
function chartValue(
  result: ApBenchmarkResult,
  measure: BenchmarkMeasure,
): number | null {
  const raw = measureValue(result, measure)
  if (raw === null) return null
  return measure === "cost" ? raw / 1_000_000 : raw
}

/**
 * One analytics query/result pair for the active cohort. Rows from other
 * datasets/configs/metrics are never mixed into this chart.
 */
export function benchmarkChart(
  state: BenchmarkState,
  locale: ApLocale,
): { query: AnalyticsQuery; result: AnalyticsResult } | null {
  const { comparable, cohort } = benchmarkSelection(state)
  if (!cohort || !comparable.length) return null
  const query: AnalyticsQuery = {
    source: "api-platform-benchmark-fixture",
    scope: {
      id: `${apScope.orgId}:${apScope.projectId}`,
      permissionVersion: apFixtureRevision,
      projectIds: [apScope.projectId],
    },
    measureId: `benchmark-${state.measure}`,
    measureVersion: 1,
    dimension: "model",
    segment: cohort,
    timeField: "asOf",
    range: { from: "2026-09-01T00:00:00Z", to: "2026-10-13T00:00:00Z" },
    bucket: "month",
    timeZone: apScope.timeZone,
    filters: [],
  }
  const ordered = [...comparable].sort((a, b) => {
      const av = chartValue(a, state.measure),
        bv = chartValue(b, state.measure)
      if (av === null)
        return bv === null ? a.resultId.localeCompare(b.resultId) : 1
      if (bv === null) return -1
      return bv - av || a.resultId.localeCompare(b.resultId)
    }),
    missingValues = comparable.reduce(
      (count, r) => count + (chartValue(r, state.measure) === null ? 1 : 0),
      0,
    ),
    unknownCoverage = comparable.filter(
      (r) => r.samplesObserved === null,
    ).length,
    observed = comparable.reduce((sum, r) => sum + (r.samplesObserved ?? 0), 0),
    total = comparable.reduce((sum, r) => sum + r.samplesTotal, 0)
  return {
    query,
    result: {
      queryKey: analyticsQueryKey(query),
      snapshotId: `benchmarks:${cohort}`,
      asOf: apAsOf,
      computedAt: apAsOf,
      unit: measureMeta[state.measure].unit,
      series: [
        {
          id: state.measure,
          label: measureMeta[state.measure].label[locale],
          color: "1",
          points: ordered.map((result) => ({
            bucketId: result.resultId,
            label: modelFor(state, result.modelId)?.name ?? result.modelId,
            value: chartValue(result, state.measure),
          })),
        },
      ],
      coverage: null,
      total: comparable.length,
      limitations: [],
      sampleCoverage: { observed, total },
      completeness: missingValues || unknownCoverage ? "partial" : "complete",
    },
  }
}

/** Complete filtered collection, independent of the visible chart cohort. */
export function benchmarkExport(state: BenchmarkState): string {
  const { rows, cohort } = benchmarkSelection(state)
  return JSON.stringify(
    {
      source: "local-fixture",
      fixtureRevision: apFixtureRevision,
      asOf: apAsOf,
      scope: {
        orgId: apScope.orgId,
        projectId: apScope.projectId,
        timeZone: apScope.timeZone,
      },
      filters: {
        search: state.search,
        provider: state.provider,
        model: state.model,
        dataset: state.dataset,
        config: state.config,
        measure: state.measure,
      },
      activeCohort: cohort,
      results: rows.map((result) => ({
        ...result,
        cohortKey: benchmarkCohortKey(result),
        inActiveChartCohort: benchmarkCohortKey(result) === cohort,
      })),
    },
    null,
    2,
  )
}

export function benchmarkQueryKey(state: BenchmarkState): string {
  return JSON.stringify([
    apScope.orgId,
    apScope.projectId,
    state.search,
    state.provider,
    state.model,
    state.dataset,
    state.config,
    state.measure,
    state.sort,
  ])
}
