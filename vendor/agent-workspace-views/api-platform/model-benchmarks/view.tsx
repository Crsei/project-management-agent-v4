"use client"
import { useLayoutEffect, useRef } from "react"
import { Download } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Tabs, TabsList, TabsTab } from "@easyuse-ui/ui/components/ui/tabs"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  DataTable,
  type DataTableColumn,
} from "@easyuse-ui/ui/components/blocks/data-table"
import { FilterToolbar } from "@easyuse-ui/ui/components/blocks/filter-toolbar"
import { MetricSummary } from "@easyuse-ui/ui/components/blocks/metric-summary"
import { StatisticalChart } from "@easyuse-ui/ui/components/blocks/charts/statistical-chart"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApPage, ApSelect, ApSearch, ApModelIdentity } from "../shared"
import { useApState, useApCache } from "../state"
import {
  apAsOf,
  apFixtureRevision,
  type ApLocale,
  type ApScenario,
} from "../model"
import type { ApBenchmarkResult } from "./fixtures"
import {
  benchmarkChart,
  benchmarkCohortKey,
  benchmarkExport,
  benchmarkQueryKey,
  benchmarkSelection,
  createBenchmarkState,
  measureMeta,
  modelFor,
  updateBenchmarkFilter,
  type BenchmarkMeasure,
  type BenchmarkState,
} from "./controller"

function formatScore(
  value: number | null,
  locale: ApLocale,
  unknown: string,
): string {
  if (value === null) return unknown
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)
}
function formatCost(
  value: number | null,
  locale: ApLocale,
): { usd: string; micro: string } | null {
  if (value === null) return null
  return {
    usd: `USD ${new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value / 1_000_000)}`,
    micro: `${new Intl.NumberFormat(locale).format(value)} microUSD`,
  }
}
function formatLatency(
  value: number | null,
  locale: ApLocale,
  unknown: string,
): string {
  if (value === null) return unknown
  return `${new Intl.NumberFormat(locale).format(value)} ms`
}
function cohortLabel(
  cohort: string,
  results: readonly ApBenchmarkResult[],
  locale: ApLocale,
): string {
  const row = results.find((r) => benchmarkCohortKey(r) === cohort)
  if (!row) return cohort
  return `${row.datasetLabel[locale]}@${row.datasetVersion} · ${row.configLabel[locale]} · ${row.metricLabel[locale]}`
}

export function ModelBenchmarksView({ scenario }: { scenario: ApScenario }) {
  const { locale } = useI18n(),
    en = locale === "en"
  const unknown = en ? "Unknown" : "未知"
  const [state, setState] = useApState("benchmarks", () =>
    createBenchmarkState(scenario),
  )
  const cache = useApCache(),
    tableHost = useRef<HTMLDivElement>(null)
  const tableScrollKey = `table-scroll:${benchmarkQueryKey(state)}`,
    selection = benchmarkSelection(state),
    chart = benchmarkChart(state, locale),
    loading = scenario === "loading" && !state.recovered,
    refreshError = scenario === "refresh-error" && !state.recovered,
    selected =
      selection.rows.find((row) => row.resultId === state.selectedId) ?? null
  const selectedInChart =
    selected && selection.cohort === benchmarkCohortKey(selected)
      ? selected
      : null
  useLayoutEffect(() => {
    const region =
      tableHost.current?.querySelector<HTMLElement>('[role="region"]')
    const saved = cache?.get(tableScrollKey) as
      { top: number; left: number } | undefined
    if (region) {
      region.scrollTop = saved?.top ?? 0
      region.scrollLeft = saved?.left ?? 0
    }
  }, [cache, tableScrollKey, loading])

  const choose = <K extends keyof BenchmarkState>(
    key: K,
    value: BenchmarkState[K],
  ) => setState((s) => ({ ...s, [key]: value }))
  const filter = <
    K extends "search" | "provider" | "model" | "dataset" | "config",
  >(
    key: K,
    value: BenchmarkState[K],
  ) => setState((s) => updateBenchmarkFilter(s, key, value))

  const missingScores = selection.rows.filter((r) => r.score === null).length,
    unknownCoverage = selection.rows.filter(
      (r) => r.samplesObserved === null,
    ).length,
    observedSum = selection.rows.reduce(
      (sum, r) => sum + (r.samplesObserved ?? 0),
      0,
    ),
    totalSum = selection.rows.reduce((sum, r) => sum + r.samplesTotal, 0),
    unequalSamples = selection.comparable.some(
      (r) => r.samplesObserved !== null && r.samplesObserved !== r.samplesTotal,
    )
  const missingChartValues =
    chart?.result.series[0]?.points.reduce(
      (count, point) => count + (point.value === null ? 1 : 0),
      0,
    ) ?? 0

  const exportResults = () => {
    const blob = new Blob([benchmarkExport(state)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      link = document.createElement("a")
    link.href = url
    link.download = "model-benchmarks-fixture.json"
    link.click()
    URL.revokeObjectURL(url)
    choose("notice", "exported")
  }

  const datasetOptions = [
      {
        value: "all",
        label: en ? "All datasets" : "全部数据集",
      },
      ...[
        ...new Map(
          state.results.map((r) => [
            r.datasetId,
            {
              value: r.datasetId,
              label: `${r.datasetLabel[locale]}@${r.datasetVersion}`,
            },
          ]),
        ).values(),
      ],
    ],
    configOptions = [
      { value: "all", label: en ? "All configs" : "全部配置" },
      ...[
        ...new Map(
          state.results.map((r) => [
            r.configId,
            { value: r.configId, label: r.configLabel[locale] },
          ]),
        ).values(),
      ],
    ],
    providerOptions = [
      { value: "all", label: en ? "All providers" : "全部提供商" },
      ...[
        ...new Map(
          state.results
            .map((r) => modelFor(state, r.modelId))
            .filter((m): m is NonNullable<typeof m> => !!m)
            .map((m) => [
              m.providerId,
              { value: m.providerId, label: m.provider },
            ]),
        ).values(),
      ],
    ],
    modelOptions = [
      { value: "all", label: en ? "All models" : "全部模型" },
      ...[...new Set(state.results.map((r) => r.modelId))].map((modelId) => ({
        value: modelId,
        label: modelFor(state, modelId)?.name ?? modelId,
      })),
    ],
    cohortOptions = selection.cohorts.map((cohort) => ({
      value: cohort,
      label: cohortLabel(cohort, selection.rows, locale),
    }))

  const columns: DataTableColumn<ApBenchmarkResult>[] = [
    {
      id: "model",
      header: en ? "Model" : "模型",
      primary: true,
      sortable: true,
      minWidth: 220,
      maxWidth: 420,
      cell: (row) => {
        const model = modelFor(state, row.modelId)
        return model ? (
          <ApModelIdentity model={model} />
        ) : (
          <span className="text-xs">{row.modelId}</span>
        )
      },
    },
    {
      id: "dataset",
      header: en ? "Dataset" : "数据集",
      sortable: true,
      minWidth: 180,
      cell: (row) => (
        <span className="text-xs">
          {row.datasetLabel[locale]}@{row.datasetVersion}
        </span>
      ),
    },
    {
      id: "config",
      header: en ? "Config" : "配置",
      sortable: true,
      cell: (row) => <span className="text-xs">{row.configLabel[locale]}</span>,
    },
    {
      id: "score",
      header: en ? "Score" : "分数",
      sortable: true,
      cell: (row) => (
        <span className="tabular-nums" data-ap-benchmark-score>
          {row.score === null ? (
            <span className="text-muted-foreground">{unknown}</span>
          ) : (
            `${formatScore(row.score, locale, unknown)} · ${row.metricLabel[locale]}`
          )}
        </span>
      ),
    },
    {
      id: "cost",
      header: en ? "Cost" : "成本",
      sortable: true,
      cell: (row) => {
        const cost = formatCost(row.costMicroUsd, locale)
        return cost === null ? (
          <span className="text-muted-foreground">{unknown}</span>
        ) : (
          <span className="block whitespace-nowrap text-xs tabular-nums">
            {cost.usd}
            <span className="block text-[11px] text-muted-foreground">
              {cost.micro}
            </span>
          </span>
        )
      },
    },
    {
      id: "latency",
      header: en ? "Latency" : "耗时",
      sortable: true,
      cell: (row) => (
        <span
          className="whitespace-nowrap tabular-nums"
          data-ap-benchmark-latency
        >
          {formatLatency(row.latencyMs, locale, unknown)}
        </span>
      ),
    },
    {
      id: "samples",
      header: en ? "Samples" : "样本",
      sortable: true,
      cell: (row) => (
        <span className="whitespace-nowrap text-xs tabular-nums">
          {row.samplesObserved === null
            ? `${unknown} / ${row.samplesTotal}`
            : `${new Intl.NumberFormat(locale).format(row.samplesObserved)} / ${new Intl.NumberFormat(locale).format(row.samplesTotal)}`}
          {row.samplesObserved !== null &&
            row.samplesObserved !== row.samplesTotal && (
              <Badge tone="warning">{en ? "Partial" : "未满"}</Badge>
            )}
        </span>
      ),
    },
    {
      id: "cohort",
      header: en ? "Comparability" : "可比性",
      minWidth: 150,
      cell: (row) =>
        selection.cohort === benchmarkCohortKey(row) ? (
          <Badge tone="neutral">{en ? "In chart" : "同组比较"}</Badge>
        ) : (
          <Badge tone="warning">
            {en ? "Separate cohort" : "不同组未比较"}
          </Badge>
        ),
    },
  ]

  return (
    <ApPage
      pageId="model-benchmarks"
      title={en ? "Model benchmarks" : "模型基准"}
      description={
        en
          ? "Compare compatible benchmark cohorts by score, cost and latency; every chart point maps to one result row."
          : "按分数、成本与耗时比较兼容的基准组；每个图表点对应唯一结果行。"
      }
      actions={
        <div className="flex items-center gap-2">
          {scenario === "readonly" && (
            <Badge tone="neutral">{en ? "Read only" : "只读"}</Badge>
          )}
          <Button
            variant="outline"
            onClick={exportResults}
            disabled={loading || !selection.rows.length}
            data-ap-benchmark-export
          >
            <Download aria-hidden="true" />
            {en ? "Export filtered results" : "导出筛选结果"}
          </Button>
        </div>
      }
      toolbar={
        <FilterToolbar
          label={en ? "Benchmark filters" : "基准筛选"}
          search={
            <ApSearch
              label={en ? "Search models or providers" : "搜索模型或提供商"}
              value={state.search}
              onChange={(v) => filter("search", v)}
            />
          }
          filters={
            <>
              <ApSelect
                label={en ? "Model filter" : "模型筛选"}
                value={state.model}
                onChange={(v) => filter("model", v)}
                options={modelOptions}
              />
              <ApSelect
                label={en ? "Provider filter" : "提供商筛选"}
                value={state.provider}
                onChange={(v) => filter("provider", v)}
                options={providerOptions}
              />
              <ApSelect
                label={en ? "Dataset filter" : "数据集筛选"}
                value={state.dataset}
                onChange={(v) => filter("dataset", v)}
                options={datasetOptions}
              />
              <ApSelect
                label={en ? "Config filter" : "配置筛选"}
                value={state.config}
                onChange={(v) => filter("config", v)}
                options={configOptions}
              />
            </>
          }
          actions={
            <Tabs
              value={state.measure}
              onValueChange={(v) => choose("measure", v as BenchmarkMeasure)}
            >
              <TabsList aria-label={en ? "Comparison measure" : "比较指标"}>
                {(Object.keys(measureMeta) as BenchmarkMeasure[]).map(
                  (measure) => (
                    <TabsTab key={measure} value={measure}>
                      {measureMeta[measure].label[locale]}
                    </TabsTab>
                  ),
                )}
              </TabsList>
            </Tabs>
          }
        />
      }
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 text-xs text-muted-foreground">
        <p aria-live="polite" data-ap-benchmark-count>
          {loading
            ? en
              ? "Loading benchmark results…"
              : "正在加载基准结果…"
            : en
              ? `${selection.rows.length} of ${state.results.length} results`
              : `${selection.rows.length} / ${state.results.length} 条结果`}
        </p>
        <span>
          {en ? "Local fixture · snapshot" : "本地 fixture · 快照"}{" "}
          {apAsOf.slice(0, 10)} · UTC · {apFixtureRevision}
        </span>
      </div>
      {scenario === "readonly" && (
        <p role="status" className="mb-4 text-sm" data-ap-readonly>
          {en
            ? "Read-only scope: inspection, filtering, charts and export stay available."
            : "只读范围：查看、筛选、图表与导出仍可使用。"}
        </p>
      )}
      {state.notice === "exported" && (
        <p role="status" className="mb-4 text-sm" data-ap-benchmark-notice>
          {en
            ? `${selection.rows.length} filtered results exported`
            : `已导出 ${selection.rows.length} 条筛选结果`}
        </p>
      )}
      {loading && (
        <Button
          className="mb-4"
          variant="secondary"
          onClick={() => choose("recovered", true)}
        >
          {en ? "Complete simulated load" : "完成模拟加载"}
        </Button>
      )}
      <MetricSummary
        className="grid grid-cols-2 gap-4 sm:grid-cols-4"
        items={[
          {
            id: "results",
            label: en ? "Filtered results" : "筛选结果",
            value: selection.rows.length,
            unit: `/ ${state.results.length}`,
          },
          {
            id: "cohorts",
            label: en ? "Comparable cohorts" : "可比组",
            value: selection.cohorts.length,
            description: selection.cohort
              ? cohortLabel(selection.cohort, selection.rows, locale)
              : undefined,
          },
          {
            id: "missing-scores",
            label: en ? "Results without score" : "无分数结果",
            value: missingScores,
            description: en ? "Unknown is not zero" : "未知不计为 0",
          },
          {
            id: "coverage",
            label: en ? "Sample coverage" : "样本覆盖",
            value: `${new Intl.NumberFormat(locale).format(observedSum)} / ${new Intl.NumberFormat(locale).format(totalSum)}`,
            description: unknownCoverage
              ? en
                ? `${unknownCoverage} result(s) with unknown coverage`
                : `${unknownCoverage} 条覆盖未知`
              : undefined,
          },
        ]}
      />

      {selection.rows.length > 0 && chart && (
        <section
          aria-labelledby="ap-benchmarks-chart-heading"
          className="mt-2"
          data-ap-benchmark-chart
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <h2
              id="ap-benchmarks-chart-heading"
              className="text-sm font-medium"
            >
              {en ? "Compatible comparison" : "兼容比较"}
            </h2>
            {selection.cohorts.length > 1 && (
              <ApSelect
                label={en ? "Comparison cohort" : "比较组筛选"}
                value={selection.cohort ?? selection.cohorts[0]}
                onChange={(v) => choose("cohort", v)}
                options={cohortOptions}
              />
            )}
          </div>
          {selection.separated.length > 0 && (
            <p
              role="status"
              className="mb-2 text-xs text-muted-foreground"
              data-ap-benchmark-separated
            >
              {en
                ? `${selection.separated.length} filtered result(s) belong to other datasets/configs/metrics and are not compared in this chart. Switch the cohort to compare them separately.`
                : `${selection.separated.length} 条筛选结果属于其它数据集/配置/指标，未纳入本图比较；请切换比较组分开查看。`}
            </p>
          )}
          <StatisticalChart
            widgetId="ap-benchmarks-chart"
            kind="bar"
            height={320}
            title={`${measureMeta[state.measure].label[locale]} · ${cohortLabel(selection.cohort ?? "", selection.rows, locale)}`}
            description={
              en
                ? "One bar per result row of the active cohort; select a bar to inspect that exact result."
                : "每个柱体对应当前比较组的唯一结果行；选择柱体可检查该结果。"
            }
            query={chart.query}
            result={loading ? null : chart.result}
            data={{
              partialDescription: en
                ? `Some ${measureMeta[state.measure].label.en.toLowerCase()} values or sample coverage in this cohort are unknown; unknown values are never shown as zero.`
                : `本比较组的部分${measureMeta[state.measure].label[locale]}或样本覆盖未知；未知值不会显示为 0。`,
              emptyTitle: en ? "No results to chart" : "没有可绘制的结果",
              emptyDescription: en
                ? "Adjust the filters to select a compatible cohort."
                : "请调整筛选以选择兼容的比较组。",
            }}
            selection={
              selectedInChart
                ? {
                    seriesId: state.measure,
                    bucketId: selectedInChart.resultId,
                  }
                : null
            }
            onSelectionChange={(next) =>
              setState((s) => ({
                ...s,
                selectedId: next?.bucketId ?? null,
                notice: "idle",
              }))
            }
          />
          {missingChartValues > 0 && (
            <p
              role="status"
              className="mt-2 text-xs text-muted-foreground"
              data-ap-benchmark-gap
            >
              {en
                ? `${missingChartValues} result(s) in this cohort have no ${measureMeta[state.measure].label.en.toLowerCase()} and are not drawn as zero.`
                : `本比较组 ${missingChartValues} 条结果没有${measureMeta[state.measure].label[locale]}，不会按 0 绘制。`}
            </p>
          )}
          {unequalSamples && (
            <p
              role="status"
              className="mt-1 text-xs text-muted-foreground"
              data-ap-benchmark-samples
            >
              {en
                ? "Sample denominators differ between results; compare scores with their coverage."
                : "各结果的样本分母不同，比较分数时请同时查看覆盖量。"}
            </p>
          )}
        </section>
      )}

      {/* position:relative keeps the sr-only heading's containing block
          inside the ApPage scroll body, so it never extends the root scroll
          area (G3: documentElement must not scroll past the viewport). */}
      <section
        aria-labelledby="ap-benchmarks-results-heading"
        className="relative mt-6"
      >
        <h2 id="ap-benchmarks-results-heading" className="sr-only">
          {en ? "Benchmark results" : "基准结果"}
        </h2>
        <DataRegion
          state={
            loading
              ? "loading"
              : refreshError
                ? "error"
                : !state.results.length || !selection.rows.length
                  ? "empty"
                  : scenario === "missing-data"
                    ? "partial"
                    : "success"
          }
          hasContent={!loading && !!selection.rows.length}
          updatedAt={apAsOf}
          error={{
            category: "network",
            message: en ? "The benchmark refresh failed." : "基准刷新失败。",
            reason: en
              ? "Previous results, filters and selection are retained."
              : "已有结果、筛选与选择均已保留。",
          }}
          onRetry={refreshError ? () => choose("recovered", true) : undefined}
          emptyTitle={
            state.results.length
              ? en
                ? "No matching results"
                : "没有匹配的结果"
              : en
                ? "This scene has no benchmark results"
                : "本场景没有基准结果"
          }
          emptyDescription={
            state.results.length
              ? en
                ? "Adjust the model, provider, dataset or config filters."
                : "请调整模型、提供商、数据集或配置筛选。"
              : en
                ? "Switch scenarios to explore benchmark comparisons."
                : "请切换场景查看基准比较。"
          }
          partialDescription={
            en
              ? "Some scores, costs or sample coverage are unknown; unknown values are not zero."
              : "部分分数、成本或样本覆盖未知；未知值不是 0。"
          }
        >
          <div
            ref={tableHost}
            onScrollCapture={(event) => {
              const region = event.target as HTMLElement
              if (region.getAttribute("role") === "region")
                cache?.set(tableScrollKey, {
                  top: region.scrollTop,
                  left: region.scrollLeft,
                })
            }}
          >
            <DataTable
              rows={selection.rows}
              columns={columns}
              getRowId={(row) => row.resultId}
              getRowLabel={(row) =>
                `${modelFor(state, row.modelId)?.name ?? row.modelId} ${row.configLabel[locale]}`
              }
              caption={en ? "Local benchmark results" : "本地基准结果"}
              sort={state.sort}
              onSortChange={(sort) => setState((s) => ({ ...s, sort }))}
              onActivateRow={(row) =>
                setState((s) => ({
                  ...s,
                  selectedId: row.resultId,
                  notice: "idle",
                }))
              }
              activeRowId={state.selectedId}
              stickyHeader
              maxHeight={440}
            />
          </div>
        </DataRegion>
      </section>

      {selected ? (
        <section
          aria-labelledby="ap-benchmarks-detail-heading"
          className="mt-6 border-t pt-4"
          data-ap-benchmark-detail
        >
          <h2 id="ap-benchmarks-detail-heading" className="text-sm font-medium">
            {en ? "Result detail" : "结果明细"}
          </h2>
          <p
            aria-live="polite"
            className="mt-1 text-xs text-muted-foreground"
            data-ap-benchmark-selected
          >
            {en ? "Inspecting " : "正在检查 "}
            {modelFor(state, selected.modelId)?.name ?? selected.modelId}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">
                {en ? "Model" : "模型"}
              </dt>
              <dd>
                {(() => {
                  const model = modelFor(state, selected.modelId)
                  return model ? (
                    <ApModelIdentity model={model} />
                  ) : (
                    <span className="text-xs">{selected.modelId}</span>
                  )
                })()}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {en ? "Dataset" : "数据集"}
              </dt>
              <dd className="text-xs">
                {selected.datasetLabel[locale]}@{selected.datasetVersion}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {en ? "Config" : "配置"}
              </dt>
              <dd className="text-xs">{selected.configLabel[locale]}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {en ? "Metric" : "指标"}
              </dt>
              <dd className="text-xs">{selected.metricLabel[locale]}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {en ? "Score" : "分数"}
              </dt>
              <dd className="tabular-nums" data-ap-benchmark-detail-score>
                {selected.score === null
                  ? `${unknown} · ${en ? "not scored" : "未评分"}`
                  : `${formatScore(selected.score, locale, unknown)} · ${selected.metricLabel[locale]}`}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {en ? "Cost" : "成本"}
              </dt>
              <dd className="tabular-nums">
                {(() => {
                  const cost = formatCost(selected.costMicroUsd, locale)
                  return cost === null ? (
                    unknown
                  ) : (
                    <span>
                      {cost.usd}
                      <span className="block text-xs text-muted-foreground">
                        {cost.micro}
                      </span>
                    </span>
                  )
                })()}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {en ? "Latency p50" : "耗时 p50"}
              </dt>
              <dd className="tabular-nums" data-ap-benchmark-detail-latency>
                {formatLatency(selected.latencyMs, locale, unknown)}
                {selected.latencyMs === 0 &&
                  (en ? " · measured zero" : " · 实测为 0")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {en ? "Samples" : "样本"}
              </dt>
              <dd className="tabular-nums">
                {selected.samplesObserved === null
                  ? `${unknown} / ${selected.samplesTotal}`
                  : `${selected.samplesObserved} / ${selected.samplesTotal}`}
                <span className="block text-xs text-muted-foreground">
                  {en ? "observed / planned denominator" : "已评 / 计划分母"}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {en ? "Comparability" : "可比性"}
              </dt>
              <dd className="text-xs">
                {selection.cohort === benchmarkCohortKey(selected)
                  ? en
                    ? "Same cohort as the chart"
                    : "与图表同组，可直接比较"
                  : en
                    ? "Different dataset/config/metric; not compared in this chart"
                    : "数据集/配置/指标不同，未与本图比较"}
              </dd>
            </div>
          </dl>
          <code
            className="mt-3 block select-text break-all text-xs text-muted-foreground"
            data-ap-benchmark-result-id
          >
            {selected.resultId}
          </code>
        </section>
      ) : (
        <p
          className="mt-6 text-xs text-muted-foreground"
          data-ap-benchmark-detail-empty
        >
          {en
            ? "Select a chart bar or a result row to inspect its detail."
            : "选择图表柱体或结果行以检查明细。"}
        </p>
      )}

      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        {en
          ? "Source: local fixture runs. Scores apply to their own dataset, version and config only; they are not a general model quality rating. Cost is integer microUSD for the whole run; latency is integer p50 ms per case."
          : "来源：本地 fixture 运行。分数仅适用于其自身的数据集、版本与配置，不是通用模型质量评分。成本为整次运行的整数 microUSD；耗时为单例整数 p50 毫秒。"}
      </p>
    </ApPage>
  )
}
