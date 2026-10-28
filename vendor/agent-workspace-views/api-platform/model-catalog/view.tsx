"use client"
import { useLayoutEffect, useRef } from "react"
import { Copy, Download, RotateCcw } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Tabs, TabsList, TabsTab } from "@easyuse-ui/ui/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@easyuse-ui/ui/components/ui/dialog"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  DataTable,
  type DataTableColumn,
} from "@easyuse-ui/ui/components/blocks/data-table"
import { DataTableControls } from "@easyuse-ui/ui/components/blocks/data-table-controls"
import { FilterToolbar } from "@easyuse-ui/ui/components/blocks/filter-toolbar"
import { Pagination } from "@easyuse-ui/ui/components/ui/pagination"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import {
  ApPage,
  ApSelect,
  ApSearch,
  ApModelIdentity,
  ApPriceText,
} from "../shared"
import { useApState, useApCache } from "../state"
import {
  apAsOf,
  apFixtureRevision,
  modalityCopy,
  capabilityCopy,
  type ApScenario,
  type ApModel,
  type ApModality,
} from "../model"
import {
  catalogExport,
  catalogPage,
  catalogQueryKey,
  createCatalogState,
  updateCatalogFilter,
  type CatalogState,
} from "./controller"
export function ModelCatalogView({
  scenario,
  onOpenModel,
}: {
  scenario: ApScenario
  onOpenModel?: (modelId: string) => void
}) {
  const { locale } = useI18n(),
    en = locale === "en"
  const [state, setState] = useApState("catalog", () =>
    createCatalogState(scenario),
  )
  const cache = useApCache(),
    tableHost = useRef<HTMLDivElement>(null)
  const inspectionId = useRef(state.selectedId)
  const tableScrollKey = `table-scroll:${catalogQueryKey(state)}`
  const page = catalogPage(state),
    selected = state.models.find((m) => m.modelId === state.selectedId)
  const loading = scenario === "loading" && !state.recovered,
    refreshError = scenario === "refresh-error" && !state.recovered
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
  const choose = <K extends keyof CatalogState>(
    key: K,
    value: CatalogState[K],
  ) => setState((s) => ({ ...s, [key]: value }))
  const filter = <
    K extends "search" | "modality" | "provider" | "capability" | "privacy",
  >(
    key: K,
    value: CatalogState[K],
  ) => setState((s) => updateCatalogFilter(s, key, value))
  const unknown = en ? "Unknown" : "未知"
  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id)
      choose("notice", "copied")
    } catch {
      choose("notice", "copy-error")
    }
  }
  const boolean = (v: boolean | null) =>
    v === null ? unknown : v ? (en ? "Yes" : "是") : en ? "No" : "否"
  const columns: DataTableColumn<ApModel>[] = [
    {
      id: "model",
      header: en ? "Model" : "模型",
      primary: true,
      hideable: false,
      sortable: true,
      minWidth: 220,
      maxWidth: 480,
      cell: (m) => <ApModelIdentity model={m} />,
    },
    {
      id: "input",
      header: en ? "Input price" : "输入价格",
      cell: (m) => <ApPriceText price={m.inputPrice} />,
    },
    {
      id: "output",
      header: en ? "Output price" : "输出价格",
      cell: (m) => <ApPriceText price={m.outputPrice} />,
    },
    {
      id: "latency",
      header: en ? "Latency" : "延迟",
      sortable: true,
      cell: (m) => (m.latencyMs === null ? unknown : `${m.latencyMs} ms`),
    },
    {
      id: "provider",
      header: en ? "Provider" : "提供商",
      sortable: true,
      cell: (m) => m.provider,
    },
    {
      id: "privacy",
      header: en ? "Privacy" : "隐私",
      cell: (m) => (
        <span className="text-xs">
          ZDR {boolean(m.zeroRetention)}
          <br />
          {en ? "No training" : "不训练"} {boolean(m.noTraining)}
        </span>
      ),
    },
    {
      id: "free",
      header: en ? "Free tier" : "免费层",
      cell: (m) => boolean(m.freeTier),
    },
    {
      id: "capabilities",
      header: en ? "Capabilities" : "能力",
      minWidth: 160,
      cell: (m) =>
        m.capabilities === null ? (
          unknown
        ) : (
          <span className="block max-w-56 text-xs">
            {m.capabilities.map((c) => capabilityCopy[c][locale]).join(" · ")}
          </span>
        ),
    },
    {
      id: "context",
      header: en ? "Context" : "上下文",
      sortable: true,
      cell: (m) =>
        m.contextTokens === null
          ? unknown
          : `${m.contextTokens.toLocaleString(locale)} Token`,
    },
    {
      id: "released",
      header: en ? "Released · UTC" : "发布 · UTC",
      sortable: true,
      cell: (m) => (
        <span className="whitespace-nowrap text-xs">{m.releasedAt}</span>
      ),
    },
    {
      id: "actions",
      header: en ? "Actions" : "操作",
      hideable: false,
      cell: (m) => (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${en ? "Copy" : "复制"} ${m.modelId}`}
          onClick={() => void copyId(m.modelId)}
        >
          <Copy aria-hidden="true" />
        </Button>
      ),
    },
  ]
  const modalities = Object.keys(modalityCopy) as ApModality[]
  const exportModels = () => {
    const blob = new Blob([catalogExport(state)], { type: "application/json" }),
      url = URL.createObjectURL(blob),
      link = document.createElement("a")
    link.href = url
    link.download = "model-catalog-fixture.json"
    link.click()
    URL.revokeObjectURL(url)
    choose("notice", "exported")
  }
  return (
    <ApPage
      pageId="model-catalog"
      title={en ? "Model catalog" : "模型目录"}
      description={
        en
          ? "Compare model capabilities, routing privacy and billing units."
          : "比较模型能力、路由隐私和计费单位。"
      }
      actions={
        <Button
          variant="outline"
          onClick={exportModels}
          disabled={loading || !page.total}
        >
          <Download aria-hidden="true" />
          {en ? "Export catalog" : "导出目录"}
        </Button>
      }
      toolbar={
        <>
          <Tabs
            value={state.modality}
            onValueChange={(v) =>
              filter("modality", v as CatalogState["modality"])
            }
          >
            <TabsList aria-label={en ? "Model modalities" : "模型模态"}>
              <TabsTab value="all">
                {en ? "All" : "全部"}{" "}
                <span className="ml-1 text-xs text-muted-foreground">
                  {state.models.length}
                </span>
              </TabsTab>
              {modalities.map((id) => (
                <TabsTab key={id} value={id}>
                  {modalityCopy[id][locale]}{" "}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {state.models.filter((m) => m.modality === id).length}
                  </span>
                </TabsTab>
              ))}
            </TabsList>
          </Tabs>
          <FilterToolbar
            label={en ? "Catalog filters" : "目录筛选"}
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
                  label={en ? "Provider filter" : "提供商筛选"}
                  value={state.provider}
                  onChange={(v) => filter("provider", v)}
                  options={[
                    {
                      value: "all",
                      label: en ? "All providers" : "全部提供商",
                    },
                    ...Array.from(
                      new Map(
                        state.models.map((m) => [
                          m.providerId,
                          { value: m.providerId, label: m.provider },
                        ]),
                      ).values(),
                    ),
                  ]}
                />
                <ApSelect
                  label={en ? "Capability filter" : "能力筛选"}
                  value={state.capability}
                  onChange={(v) =>
                    filter("capability", v as CatalogState["capability"])
                  }
                  options={[
                    {
                      value: "all",
                      label: en ? "All capabilities" : "全部能力",
                    },
                    ...Object.entries(capabilityCopy).map(([value, label]) => ({
                      value,
                      label: label[locale],
                    })),
                  ]}
                />
                <ApSelect
                  label={en ? "Privacy filter" : "隐私筛选"}
                  value={state.privacy}
                  onChange={(v) =>
                    filter("privacy", v as CatalogState["privacy"])
                  }
                  options={[
                    {
                      value: "all",
                      label: en ? "Privacy & access" : "隐私与访问",
                    },
                    { value: "zdr", label: "ZDR" },
                    {
                      value: "no-training",
                      label: en ? "No training" : "不训练",
                    },
                    { value: "free", label: en ? "Free tier" : "免费层" },
                  ]}
                />
              </>
            }
            actions={
              <>
                <DataTableControls
                  columns={columns.map((c) => ({
                    ...c,
                    label: String(c.header),
                  }))}
                  value={state.columns}
                  onValueChange={(v) => choose("columns", v)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={en ? "Restore columns" : "恢复默认列"}
                  onClick={() => choose("columns", {})}
                >
                  <RotateCcw aria-hidden="true" />
                </Button>
              </>
            }
          />
        </>
      }
    >
      <div className="mb-4 flex items-center justify-between gap-4 text-xs text-muted-foreground">
        <p aria-live="polite" data-ap-result-count>
          {loading
            ? en
              ? "Loading catalog…"
              : "正在加载目录…"
            : en
              ? `${page.total} of ${state.models.length} models`
              : `${page.total} / ${state.models.length} 个模型`}
        </p>
        <span>
          {en ? "Local fixture · snapshot" : "本地 fixture · 快照"}{" "}
          {apAsOf.slice(0, 10)} · UTC
        </span>
      </div>
      {state.notice !== "idle" && (
        <p role="status" className="mb-4 text-sm">
          {state.notice === "copied"
            ? en
              ? "Model ID copied"
              : "已复制模型 ID"
            : state.notice === "copy-error"
              ? en
                ? "Clipboard unavailable; select the ID in details."
                : "剪贴板不可用，请在详情中选择 ID。"
              : en
                ? "Filtered catalog exported"
                : "已导出筛选目录"}
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
      <section
        className="relative"
        aria-labelledby="ap-catalog-results-heading"
      >
        <h2 id="ap-catalog-results-heading" className="sr-only">
          {en ? "Catalog results" : "目录结果"}
        </h2>
        <DataRegion
          state={
            loading
              ? "loading"
              : refreshError
                ? "error"
                : !page.total
                  ? "empty"
                  : scenario === "missing-data"
                    ? "partial"
                    : "success"
          }
          hasContent={!loading && !!state.models.length}
          updatedAt={apAsOf}
          error={{
            category: "network",
            message: en ? "The catalog refresh failed." : "目录刷新失败。",
            reason: en
              ? "Previous snapshot, filters and columns are retained."
              : "已有快照、筛选和列设置已保留。",
          }}
          onRetry={refreshError ? () => choose("recovered", true) : undefined}
          emptyTitle={
            state.models.length
              ? en
                ? "No matching models"
                : "没有匹配的模型"
              : en
                ? "Catalog is empty"
                : "目录为空"
          }
          emptyDescription={
            state.models.length
              ? en
                ? "Adjust the search or filters to find a model."
                : "请调整搜索或筛选以查找模型。"
              : en
                ? "This scene has no models. Switch scenarios to explore a catalog."
                : "本场景没有模型，请切换场景查看目录。"
          }
          partialDescription={
            en
              ? "Some capabilities, prices and latency are unknown; they are not zero."
              : "部分能力、价格和延迟未知，不代表为零。"
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
              rows={page.visible}
              columns={columns}
              columnConfig={state.columns}
              getRowId={(m) => m.modelId}
              getRowLabel={(m) => m.name}
              caption={en ? "Local model catalog" : "本地模型目录"}
              sort={state.sort}
              onSortChange={(sort) =>
                setState((s) => ({ ...s, sort, page: 1 }))
              }
              onActivateRow={(m) => {
                inspectionId.current = m.modelId
                setState((s) => ({
                  ...s,
                  selectedId: m.modelId,
                  notice: "idle",
                }))
              }}
              activeRowId={state.selectedId}
              stickyHeader
              maxHeight={440}
            />
          </div>
        </DataRegion>
      </section>
      {!loading && page.total > 0 && (
        <div className="mt-4 flex items-center justify-between gap-4">
          <span className="text-xs text-muted-foreground">
            {(page.page - 1) * state.pageSize + 1}–
            {Math.min(page.page * state.pageSize, page.total)} / {page.total}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <ApSelect
              label={en ? "Rows per page" : "每页行数"}
              value={String(state.pageSize)}
              onChange={(v) =>
                setState((s) => ({ ...s, pageSize: Number(v), page: 1 }))
              }
              options={[10, 25, 50].map((n) => ({
                value: String(n),
                label: en ? `${n} rows` : `${n} 行`,
              }))}
            />
            <Pagination
              page={page.page}
              pageCount={page.pageCount}
              onPageChange={(v) => choose("page", v)}
            />
          </div>
        </div>
      )}
      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        {en
          ? "Prices retain their billing units. Privacy eligibility is a routing property. These are demonstrative samples, not live quotes."
          : "价格保留各自计费单位，隐私资格取决于路由。这些数据为演示样例，非实时报价。"}
      </p>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) choose("selectedId", null)
        }}
      >
        <DialogContent
          finalFocus={() =>
            inspectionId.current
              ? (tableHost.current?.querySelector<HTMLElement>(
                  `tr[data-row-id="${CSS.escape(inspectionId.current)}"] button`,
                ) ?? false)
              : false
          }
        >
          <DialogTitle>{en ? "Model details" : "模型详情"}</DialogTitle>
          <DialogDescription>
            {en
              ? "Local catalog identity and sample capabilities."
              : "本地目录中的模型身份与样例能力。"}
          </DialogDescription>
          {selected && (
            <div className="space-y-4">
              <ApModelIdentity model={selected} detail />
              <code
                className="block select-text break-all text-xs"
                data-ap-model-id
              >
                {selected.modelId}
              </code>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">
                    {en ? "Input" : "输入"}
                  </dt>
                  <dd>
                    <ApPriceText price={selected.inputPrice} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {en ? "Output" : "输出"}
                  </dt>
                  <dd>
                    <ApPriceText price={selected.outputPrice} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {en ? "Context" : "上下文"}
                  </dt>
                  <dd>
                    {selected.contextTokens === null
                      ? unknown
                      : `${selected.contextTokens.toLocaleString(locale)} Token`}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {en ? "Availability" : "可用性"}
                  </dt>
                  <dd>
                    {selected.status === "available"
                      ? en
                        ? "Available"
                        : "可用"
                      : en
                        ? "Unavailable"
                        : "不可用"}
                  </dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2">
                {selected.capabilities?.map((c) => (
                  <Badge key={c} tone="neutral">
                    {capabilityCopy[c][locale]}
                  </Badge>
                )) ?? unknown}
              </div>
              <p className="text-xs text-muted-foreground">
                {apFixtureRevision}
              </p>
            </div>
          )}
          {(state.notice === "copied" || state.notice === "copy-error") && (
            <p role="status" className="my-3 text-sm">
              {state.notice === "copied"
                ? en
                  ? "Model ID copied"
                  : "已复制模型 ID"
                : en
                  ? "Clipboard unavailable; select the ID above."
                  : "剪贴板不可用，请选择上方的 ID。"}
            </p>
          )}
          <DialogFooter className="px-1 pb-1">
            <Button
              variant="secondary"
              onClick={() => choose("selectedId", null)}
            >
              {en ? "Close" : "关闭"}
            </Button>
            {selected && (
              <Button
                variant="outline"
                onClick={() => void copyId(selected.modelId)}
              >
                {en ? "Copy ID" : "复制 ID"}
              </Button>
            )}
            {selected && onOpenModel && (
              <Button onClick={() => onOpenModel(selected.modelId)}>
                {en ? "Open model page" : "打开模型页面"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ApPage>
  )
}
