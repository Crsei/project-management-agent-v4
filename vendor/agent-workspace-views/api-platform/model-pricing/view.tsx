"use client"
import { useEffect, useLayoutEffect, useRef } from "react"
import { RefreshCw, RotateCcw, ChevronDown } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Alert } from "@easyuse-ui/ui/components/ui/alert"
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
  capabilityCopy,
  type ApScenario,
  type ApModel,
  type ApTokenPriceUnit,
} from "../model"
import {
  beginCheck,
  beginRefresh,
  beginSave,
  cancelDraft,
  completeLoad,
  createPricingState,
  pricingPage,
  pricingQueryKey,
  resolvePending,
  selectDraft,
  settleRefresh,
  updatePricingFilter,
  type PricingState,
} from "./controller"
const operationDelayMs = 1000
export function ModelPricingView({ scenario }: { scenario: ApScenario }) {
  const { locale } = useI18n(),
    en = locale === "en"
  const [state, setState] = useApState("pricing", () =>
    createPricingState(scenario),
  )
  const cache = useApCache(),
    tableHost = useRef<HTMLDivElement>(null),
    panelRef = useRef<HTMLDivElement>(null),
    focusPanelOnOpen = useRef(false)
  const tableScrollKey = `table-scroll:${pricingQueryKey(state)}`
  const page = pricingPage(state),
    expanded = state.models.find((m) => m.modelId === state.expandedId),
    savedModel = state.models.find((m) => m.modelId === state.savedDefaultId),
    saveTarget = state.models.find((m) => m.modelId === state.save.targetId),
    draftModel = state.models.find((m) => m.modelId === state.draftDefaultId)
  const loading = scenario === "loading" && !state.recovered,
    refreshError = state.refresh === "error",
    pending = state.save.status === "pending",
    locked = !state.canWrite || pending || state.save.status === "unknown",
    unknown = en ? "Unknown" : "未知"
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
  useEffect(() => {
    if (state.save.status === "pending") {
      const timer = setTimeout(() => setState(resolvePending), operationDelayMs)
      return () => clearTimeout(timer)
    }
  }, [state.save.status, state.save.intent, state.save.operationId, setState])
  useEffect(() => {
    if (state.refresh !== "pending") return
    const timer = setTimeout(() => setState(settleRefresh), operationDelayMs)
    return () => clearTimeout(timer)
  }, [state.refresh, state.refreshIntent, setState])
  useEffect(() => {
    if (state.expandedId && focusPanelOnOpen.current) {
      focusPanelOnOpen.current = false
      panelRef.current?.focus()
    }
  }, [state.expandedId])
  const choose = <K extends keyof PricingState>(
    key: K,
    value: PricingState[K],
  ) => setState((s) => ({ ...s, [key]: value }))
  const filter = <K extends "search" | "provider" | "capability">(
    key: K,
    value: PricingState[K],
  ) => setState((s) => updatePricingFilter(s, key, value))
  const detailId = (modelId: string) =>
    `ap-pricing-detail-${encodeURIComponent(modelId)}`
  const toggleDetail = (modelId: string) => {
    const opening = state.expandedId !== modelId
    focusPanelOnOpen.current = opening
    setState((s) => ({
      ...s,
      expandedId: opening ? modelId : null,
    }))
  }
  const collapseDetail = () => {
    const previous = state.expandedId
    setState((s) => ({ ...s, expandedId: null }))
    if (previous)
      tableHost.current
        ?.querySelector<HTMLElement>(`[aria-controls="${detailId(previous)}"]`)
        ?.focus()
  }
  const columns: DataTableColumn<ApModel>[] = [
    {
      id: "model",
      header: en ? "Model" : "模型",
      primary: true,
      hideable: false,
      sortable: true,
      minWidth: 220,
      maxWidth: 480,
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-2">
          <ApModelIdentity model={m} />
          {m.modelId === state.savedDefaultId && (
            <Badge tone="info">{en ? "Default" : "默认"}</Badge>
          )}
        </span>
      ),
    },
    {
      id: "input",
      header: en ? "Input" : "输入",
      sortable: true,
      cell: (m) => (
        <ApPriceText price={m.inputPrice} tokenUnit={state.tokenUnit} />
      ),
    },
    {
      id: "output",
      header: en ? "Output" : "输出",
      sortable: true,
      cell: (m) => (
        <ApPriceText price={m.outputPrice} tokenUnit={state.tokenUnit} />
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
      id: "details",
      header: en ? "Details" : "详情",
      hideable: false,
      cell: (m) => {
        const open = state.expandedId === m.modelId
        return (
          <Button
            variant="ghost"
            size="icon"
            aria-expanded={open}
            aria-controls={detailId(m.modelId)}
            aria-label={
              open
                ? en
                  ? `Close ${m.name} details`
                  : `收起 ${m.name} 详情`
                : en
                  ? `Open ${m.name} details`
                  : `展开 ${m.name} 详情`
            }
            onClick={() => toggleDetail(m.modelId)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && open) collapseDetail()
            }}
          >
            <ChevronDown
              aria-hidden="true"
              className={open ? "rotate-180" : undefined}
            />
          </Button>
        )
      },
    },
  ]
  const defaultOptions = state.models.map((m) => ({
    value: m.modelId,
    label: `${m.name} · ${m.provider}`,
  }))
  const defaultWarning = !savedModel
    ? en
      ? `Saved default model ${state.savedDefaultId} is not in this collection.`
      : `已保存的默认模型 ${state.savedDefaultId} 不在当前集合中。`
    : savedModel.status === "unavailable"
      ? en
        ? `Saved default model ${savedModel.name} is unavailable; requests routed through it may fail.`
        : `已保存的默认模型 ${savedModel.name} 已不可用，经由它的请求可能失败。`
      : null
  return (
    <ApPage
      pageId="model-pricing"
      title={en ? "Model pricing" : "模型定价"}
      description={
        en
          ? "Compare token pricing and pick the workspace default model."
          : "比较 Token 报价并选择工作区默认模型。"
      }
      actions={
        <Button
          variant="outline"
          data-ap-refresh
          disabled={state.refresh === "pending" || loading}
          onClick={() => setState((s) => beginRefresh(s, "refresh"))}
        >
          <RefreshCw aria-hidden="true" />
          {en ? "Refresh prices" : "刷新价格"}
        </Button>
      }
      toolbar={
        <FilterToolbar
          label={en ? "Pricing filters" : "报价筛选"}
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
                  filter("capability", v as PricingState["capability"])
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
                label={en ? "Price unit" : "价格单位"}
                value={state.tokenUnit}
                onChange={(v) => choose("tokenUnit", v as ApTokenPriceUnit)}
                options={[
                  {
                    value: "million-tokens",
                    label: en ? "Per 1M tokens" : "每百万 Token",
                  },
                  {
                    value: "thousand-tokens",
                    label: en ? "Per 1K tokens" : "每千 Token",
                  },
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
      }
    >
      <section
        aria-labelledby="ap-pricing-default-heading"
        data-ap-default-editor
        className="mb-5 space-y-3 rounded border p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="ap-pricing-default-heading" className="text-sm font-medium">
            {en ? "Workspace default model" : "工作区默认模型"}
          </h2>
          <p className="text-xs text-muted-foreground">
            {en ? "Current default" : "当前默认"} ·{" "}
            <span data-ap-saved-default>
              {savedModel ? savedModel.name : state.savedDefaultId}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ApSelect
            label={en ? "Default model" : "默认模型"}
            value={state.draftDefaultId ?? state.savedDefaultId}
            onChange={(v) => setState((s) => selectDraft(s, v))}
            options={defaultOptions}
            disabled={locked || !defaultOptions.length}
          />
          <Button
            data-ap-save-default
            disabled={
              locked ||
              !state.canWrite ||
              state.draftDefaultId === null ||
              !draftModel
            }
            onClick={() => setState((s) => beginSave(s))}
          >
            {en ? "Save default" : "保存默认"}
          </Button>
          <Button
            variant="outline"
            data-ap-cancel-default
            disabled={locked || state.draftDefaultId === null}
            onClick={() => setState((s) => cancelDraft(s))}
          >
            {en ? "Cancel" : "取消"}
          </Button>
          {state.save.status === "unknown" && (
            <Button
              variant="secondary"
              data-ap-check-result
              disabled={pending || !state.canWrite}
              onClick={() => setState((s) => beginCheck(s))}
            >
              {en ? "Check result" : "查询结果"}
            </Button>
          )}
        </div>
        <p role="status" data-ap-save-status className="text-sm">
          {pending
            ? state.save.intent === "check"
              ? en
                ? `Checking operation ${state.save.operationId ?? ""}…`
                : `正在查询操作 ${state.save.operationId ?? ""} 的结果…`
              : en
                ? "Saving the default model…"
                : "正在保存默认模型…"
            : state.save.status === "confirmed"
              ? en
                ? `Default model saved: ${saveTarget?.name ?? state.save.targetId ?? ""}`
                : `默认模型已保存：${saveTarget?.name ?? state.save.targetId ?? ""}`
              : state.save.status === "rejected"
                ? en
                  ? "Save rejected. The default model was not changed."
                  : "保存被拒绝，未更改默认模型。"
                : state.save.status === "unknown"
                  ? en
                    ? `Result unknown (operation ${state.save.operationId ?? ""}). The default model was not changed; check the result before retrying.`
                    : `结果未知（操作 ${state.save.operationId ?? ""}），默认模型未更改；请先查询结果再重试。`
                  : state.draftDefaultId
                    ? en
                      ? "Unsaved default model change."
                      : "默认模型有未保存的更改。"
                    : en
                      ? "No pending default model change."
                      : "默认模型没有待保存的更改。"}
        </p>
        {!state.canWrite && (
          <p data-ap-readonly-note className="text-xs text-muted-foreground">
            {en
              ? "Read-only scope: the default model cannot be changed."
              : "只读范围：无法更改默认模型。"}
          </p>
        )}
        {defaultWarning && (
          <Alert tone="warning" role="status" data-ap-default-warning>
            {defaultWarning}
          </Alert>
        )}
      </section>
      <div className="mb-4 flex items-center justify-between gap-4 text-xs text-muted-foreground">
        <p aria-live="polite" data-ap-result-count>
          {loading
            ? en
              ? "Loading quotes…"
              : "正在加载报价…"
            : en
              ? `${page.total} of ${state.models.length} models`
              : `${page.total} / ${state.models.length} 个模型`}
        </p>
        <span>
          {en ? "Local fixture · snapshot" : "本地 fixture · 快照"}{" "}
          {apAsOf.slice(0, 10)} · UTC
        </span>
      </div>
      {state.notice === "refreshed" && (
        <p role="status" data-ap-refresh-notice className="mb-4 text-sm">
          {en
            ? `Quotes revalidated against the fixture snapshot as of ${apAsOf}`
            : `报价已按 fixture 快照重新校验 · asOf ${apAsOf}`}
        </p>
      )}
      {loading && (
        <Button
          className="mb-4"
          variant="secondary"
          onClick={() => setState((s) => completeLoad(s))}
        >
          {en ? "Complete simulated load" : "完成模拟加载"}
        </Button>
      )}
      <section
        className="relative"
        aria-labelledby="ap-pricing-results-heading"
      >
        <h2 id="ap-pricing-results-heading" className="sr-only">
          {en ? "Pricing results" : "报价结果"}
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
          refreshing={state.refresh === "pending"}
          updatedAt={apAsOf}
          error={{
            category: "network",
            message: en ? "The price refresh failed." : "报价刷新失败。",
            reason: en
              ? "Previous quotes, billing units and the asOf snapshot are retained."
              : "已保留上一次报价、计费单位与 asOf 快照。",
          }}
          onRetry={
            refreshError
              ? () => setState((s) => beginRefresh(s, "retry"))
              : undefined
          }
          emptyTitle={
            state.models.length
              ? en
                ? "No matching models"
                : "没有匹配的模型"
              : en
                ? "Pricing is empty"
                : "报价为空"
          }
          emptyDescription={
            state.models.length
              ? en
                ? "Adjust the search or filters to find a model."
                : "请调整搜索或筛选以查找模型。"
              : en
                ? "This scene has no models. Switch scenarios to explore pricing."
                : "本场景没有模型，请切换场景查看报价。"
          }
          partialDescription={
            en
              ? "Some prices, capabilities and context limits are unknown; they are not zero."
              : "部分价格、能力和上下文未知，不代表为零。"
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
              caption={en ? "Local model pricing" : "本地模型报价"}
              sort={state.sort}
              onSortChange={(sort) =>
                setState((s) => ({ ...s, sort, page: 1, expandedId: null }))
              }
              stickyHeader
              maxHeight={440}
            />
          </div>
          {expanded && (
            <div
              ref={panelRef}
              id={detailId(expanded.modelId)}
              data-ap-expanded-detail={expanded.modelId}
              tabIndex={-1}
              className="border-t px-3 py-4 outline-none"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation()
                  collapseDetail()
                }
              }}
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <ApModelIdentity model={expanded} detail />
                <div className="flex flex-wrap items-center gap-2">
                  {expanded.modelId === state.savedDefaultId && (
                    <Badge tone="info">
                      {en ? "Current default" : "当前默认"}
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    data-ap-set-default
                    disabled={
                      locked ||
                      !state.canWrite ||
                      (state.draftDefaultId ?? state.savedDefaultId) ===
                        expanded.modelId
                    }
                    onClick={() =>
                      setState((s) => selectDraft(s, expanded.modelId))
                    }
                  >
                    {en ? "Set as default" : "设为默认"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-ap-collapse-detail
                    onClick={collapseDetail}
                  >
                    {en ? "Collapse" : "收起"}
                  </Button>
                </div>
              </div>
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {en ? "Input" : "输入"}
                  </dt>
                  <dd className="mt-1">
                    <ApPriceText
                      price={expanded.inputPrice}
                      tokenUnit={state.tokenUnit}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {en ? "Output" : "输出"}
                  </dt>
                  <dd className="mt-1">
                    <ApPriceText
                      price={expanded.outputPrice}
                      tokenUnit={state.tokenUnit}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {en ? "Context" : "上下文"}
                  </dt>
                  <dd className="mt-1">
                    {expanded.contextTokens === null
                      ? unknown
                      : `${expanded.contextTokens.toLocaleString(locale)} Token`}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {en ? "Availability" : "可用性"}
                  </dt>
                  <dd className="mt-1">
                    {expanded.status === "available"
                      ? en
                        ? "Available"
                        : "可用"
                      : en
                        ? "Unavailable"
                        : "不可用"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {en ? "Capabilities" : "能力"}
                  </dt>
                  <dd className="mt-1 flex flex-wrap gap-2">
                    {expanded.capabilities ? (
                      expanded.capabilities.map((c) => (
                        <Badge key={c} tone="neutral">
                          {capabilityCopy[c][locale]}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs">{unknown}</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {en ? "Snapshot · UTC" : "快照 · UTC"}
                  </dt>
                  <dd className="mt-1 text-xs">{apAsOf}</dd>
                </div>
              </dl>
              <code
                className="mt-3 block select-text break-all text-xs"
                data-ap-expanded-model-id
              >
                {expanded.modelId}
              </code>
              <p className="mt-2 text-xs text-muted-foreground">
                {apFixtureRevision}
              </p>
            </div>
          )}
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
                setState((s) => ({
                  ...s,
                  pageSize: Number(v),
                  page: 1,
                  expandedId: null,
                }))
              }
              options={[10, 25, 50].map((n) => ({
                value: String(n),
                label: en ? `${n} rows` : `${n} 行`,
              }))}
            />
            <Pagination
              page={page.page}
              pageCount={page.pageCount}
              onPageChange={(v) =>
                setState((s) => ({
                  ...s,
                  page: v,
                  expandedId: null,
                }))
              }
            />
          </div>
        </div>
      )}
      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        {en
          ? "Illustrative local quotes and availability; not live provider prices. Amounts are USD micro precision rendered for display only."
          : "这些是本地样例报价与可用性，非实时提供商价格；金额为 USD 微单位精度，仅用于展示。"}
      </p>
    </ApPage>
  )
}
