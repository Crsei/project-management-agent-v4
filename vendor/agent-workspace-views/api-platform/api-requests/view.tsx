"use client"
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react"
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Copy,
  Download,
  PanelLeft,
  Play,
  RotateCcw,
  Search,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@easyuse-ui/ui/components/ui/accordion"
import { DatePicker } from "@easyuse-ui/ui/components/ui/date-picker"
import { Slider } from "@easyuse-ui/ui/components/ui/slider"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from "@easyuse-ui/ui/components/ui/popover"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "@easyuse-ui/ui/components/ui/sheet"
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
} from "@easyuse-ui/ui/components/ui/tabs"
import {
  DataTable,
  type DataTableColumn,
} from "@easyuse-ui/ui/components/blocks/data-table"
import { DataTableControls } from "@easyuse-ui/ui/components/blocks/data-table-controls"
import { CodePreview } from "@easyuse-ui/ui/components/blocks/code-preview"
import {
  CommandPalette,
  type CommandPaletteGroup,
} from "@easyuse-ui/ui/components/blocks/command-palette"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApSelect } from "../shared"
import { useApCache, useApState } from "../state"
import { apScope, apScenarios, type ApScenario } from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import type { ApUsageRequest } from "../fixtures/usage-ledger"
import {
  createRequestsState,
  filterRequests,
  scopeRequests,
  updateRequestFilter,
  advanceRequestSample,
  requestTimeline,
  applyRequestCommand,
  requestLevel,
  requestExport,
  inspectRequest,
  type RequestFilters,
  type RequestsState,
} from "./controller"
import {
  requestSources,
  requestLogMetadata,
  requestPayload,
  responsePayload,
} from "./fixtures"
import styles from "./requests.module.css"

export const pageScenarios = apScenarios

export function RemainingPageView({ scenario, active }: RemainingPageProps) {
  return <ApiRequestsView scenario={scenario as ApScenario} active={active} />
}

export function ApiRequestsView({
  scenario,
  active = true,
}: {
  scenario: ApScenario
  active?: boolean
}) {
  const { locale } = useI18n(),
    en = locale === "en"
  const filterLabelId = useId()
  const [state, setState] = useApState("api-requests", () =>
    createRequestsState(scenario),
  )
  const cache = useApCache(),
    tableHost = useRef<HTMLDivElement>(null),
    searchRef = useRef<HTMLInputElement>(null),
    detailBody = useRef<HTMLDivElement>(null)
  const filtered = filterRequests(state),
    scoped = scopeRequests(state),
    rows = filtered.slice(0, state.loadedCount)
  const detail = state.records.find(
    (request) => request.requestId === state.detailId,
  )
  const meta = detail ? requestLogMetadata(detail) : null
  const detailIndex = filtered.findIndex(
    (request) => request.requestId === state.detailId,
  )
  const loading = scenario === "loading" && !state.recovered
  const error = scenario === "refresh-error" && !state.recovered
  const readonly = scenario === "readonly" || !apScope.canWrite
  const expired = !!detail && state.invalidatedIds.includes(detail.requestId)
  const unknown = en ? "Unknown" : "未知"
  const scrollKey = `api-requests:${scenario}:scroll:${JSON.stringify(state.filters)}:${JSON.stringify(state.sort)}`
  useEffect(() => {
    if (!active) return
    const openCommands = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      )
        return
      if (document.querySelector('[role="dialog"]') && !state.commandsOpen)
        return
      event.preventDefault()
      setState((before) => ({ ...before, commandsOpen: !before.commandsOpen }))
    }
    window.addEventListener("keydown", openCommands)
    return () => window.removeEventListener("keydown", openCommands)
  }, [active, setState, state.commandsOpen])
  useLayoutEffect(() => {
    const element =
      tableHost.current?.querySelector<HTMLElement>('[role="region"]')
    const saved = cache?.get(scrollKey) as
      { top: number; left: number } | undefined
    if (element) {
      element.scrollTop = saved?.top ?? 0
      element.scrollLeft = saved?.left ?? 0
    }
  }, [cache, scrollKey, loading])
  useLayoutEffect(() => {
    if (detailBody.current && detail)
      detailBody.current.scrollTop = Number(
        cache?.get(
          `api-requests:${scenario}:detail-scroll:${detail.requestId}`,
        ) ?? 0,
      )
  }, [cache, detail, scenario])
  function choose<K extends keyof RequestsState>(
    key: K,
    value: RequestsState[K],
  ) {
    setState((before) => ({ ...before, [key]: value }))
  }
  function filter<K extends keyof RequestFilters>(
    key: K,
    value: RequestFilters[K],
  ) {
    setState((before) => updateRequestFilter(before, key, value))
  }
  function toggleFilter(
    key: "levels" | "sources" | "providers" | "models",
    value: string,
    checked: boolean,
  ) {
    filter(
      key,
      checked
        ? [...state.filters[key], value]
        : state.filters[key].filter((item) => item !== value),
    )
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      choose("notice", "copied")
    } catch {
      choose("notice", "copy-error")
    }
  }
  function exportRecords(selectedOnly = false) {
    const url = URL.createObjectURL(
      new Blob([requestExport(state, selectedOnly)], {
        type: "application/json",
      }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = selectedOnly
      ? "selected-api-requests.json"
      : "api-requests.json"
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    choose("notice", "exported")
  }
  const number = (value: number | null) =>
    value === null ? unknown : new Intl.NumberFormat(locale).format(value)
  const cost = (value: number | null) =>
    value === null
      ? unknown
      : new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 4,
          maximumFractionDigits: 6,
        }).format(value / 1_000_000)
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC",
    })
      .format(new Date(value))
      .replace(/, /g, " ")
  const levelLabels = {
    success: en ? "Success" : "成功",
    warning: en ? "Warning" : "警告",
    error: en ? "Error" : "错误",
    unknown,
  }
  function cell(
    request: ApUsageRequest,
    name: string,
    content: ReactNode,
    raw: string,
  ) {
    return (
      <span className={styles.cell}>
        <span className={styles.cellText} title={raw}>
          {content}
        </span>
        <Button
          className={styles.copyCell}
          size="icon-sm"
          variant="ghost"
          aria-label={`${en ? "Copy" : "复制"} ${name} ${request.requestId}`}
          onClick={() => void copy(raw)}
        >
          <Copy size={14} aria-hidden="true" />
        </Button>
      </span>
    )
  }
  function timing(request: ApUsageRequest) {
    const m = requestLogMetadata(request)
    if (request.latencyMs === null)
      return <span className={styles.muted}>{unknown}</span>
    return (
      <span
        className={styles.timing}
        role="img"
        aria-label={`${en ? "Gateway" : "网关"} ${m.gatewayMs} ms; ${en ? "first token" : "首 Token"} ${m.firstTokenMs} ms; ${en ? "generation" : "生成"} ${m.generationMs} ms`}
      >
        <i
          style={{
            width: `${(m.gatewayMs! / Math.max(1, request.latencyMs)) * 100}%`,
          }}
        />
        <i
          style={{
            width: `${(m.firstTokenMs! / Math.max(1, request.latencyMs)) * 100}%`,
          }}
        />
        <i style={{ flex: 1 }} />
      </span>
    )
  }
  const columns: DataTableColumn<ApUsageRequest>[] = [
    {
      id: "level",
      header: <span className="sr-only">{en ? "Level" : "级别"}</span>,
      hideable: false,
      minWidth: 44,
      cell: (request) => (
        <span
          className={styles.level}
          data-level={requestLevel(request)}
          title={levelLabels[requestLevel(request)]}
          aria-label={levelLabels[requestLevel(request)]}
          role="img"
        />
      ),
    },
    {
      id: "date",
      header: en ? "Date" : "日期",
      sortable: true,
      cell: (request) =>
        cell(
          request,
          en ? "Date" : "日期",
          <span className={styles.mono}>{date(request.startedAt)}</span>,
          request.startedAt,
        ),
    },
    {
      id: "id",
      header: en ? "Request Id" : "请求 ID",
      sortable: true,
      hideable: false,
      cell: (request) =>
        cell(
          request,
          "ID",
          <Button
            className={styles.inspect}
            variant="ghost"
            aria-label={`${en ? "Inspect" : "查看"} ${request.requestId}`}
            onClick={() =>
              setState((before) => inspectRequest(before, request.requestId))
            }
          >
            {request.requestId}
          </Button>,
          request.requestId,
        ),
    },
    {
      id: "status",
      header: en ? "Status" : "状态",
      minWidth: 44,
      sortable: true,
      cell: (request) => (
        <span className={styles.status} data-level={requestLevel(request)}>
          {request.httpStatus ?? "—"}
        </span>
      ),
    },
    {
      id: "source",
      header: en ? "Log source" : "日志来源",
      cell: (request) =>
        cell(
          request,
          en ? "Log source" : "来源",
          requestLogMetadata(request).source.label,
          requestLogMetadata(request).source.label,
        ),
    },
    {
      id: "provider",
      header: en ? "Provider" : "提供商",
      cell: (request) =>
        requestLogMetadata(request).model?.provider ?? request.providerId,
    },
    {
      id: "model",
      header: en ? "Model" : "模型",
      sortable: true,
      cell: (request) =>
        cell(
          request,
          en ? "Model" : "模型",
          request.modelId.split("/").at(-1),
          request.modelId,
        ),
    },
    {
      id: "endpoint",
      header: en ? "Endpoint" : "端点",
      sortable: true,
      cell: (request) =>
        cell(
          request,
          en ? "Endpoint" : "端点",
          requestLogMetadata(request).source.endpoint,
          requestLogMetadata(request).source.endpoint,
        ),
    },
    {
      id: "latency",
      header: en ? "Latency" : "延迟",
      sortable: true,
      cell: (request) =>
        cell(
          request,
          en ? "Latency" : "延迟",
          `${number(request.latencyMs)}${request.latencyMs === null ? "" : "ms"}`,
          String(request.latencyMs ?? unknown),
        ),
    },
    {
      id: "region",
      header: en ? "Regions" : "区域",
      cell: (request) => requestLogMetadata(request).region,
    },
    { id: "timing", header: en ? "Timing Phases" : "计时阶段", cell: timing },
    {
      id: "ttft",
      header: "TTFT",
      cell: (request) =>
        `${number(requestLogMetadata(request).firstTokenMs)} ms`,
    },
    {
      id: "tokens",
      header: "Tokens",
      sortable: true,
      cell: (request) =>
        number(
          request.inputTokens === null || request.outputTokens === null
            ? null
            : request.inputTokens + request.outputTokens,
        ),
    },
    {
      id: "cost",
      header: en ? "Cost" : "费用",
      sortable: true,
      cell: (request) => cost(request.costMicroUsd),
    },
    {
      id: "project",
      header: en ? "Project" : "项目",
      cell: (request) => request.projectId,
    },
    {
      id: "cache",
      header: en ? "Cache" : "缓存",
      cell: (request) =>
        request.cachedTokens === null
          ? unknown
          : `${number(request.cachedTokens)} tokens`,
    },
  ]
  const visibleSelected = filtered.filter((request) =>
    state.selectedIds.includes(request.requestId),
  ).length
  const providers = [
    ...new Map(
      scoped.map((request) => {
        const m = requestLogMetadata(request)
        return [request.providerId, m.model?.provider ?? request.providerId]
      }),
    ).entries(),
  ]
  const models = [...new Set(scoped.map((request) => request.modelId))]
  const counts = requestTimeline(state)
  const maximumBucketCount = Math.max(
    1,
    ...counts.map((bucket) => bucket.count),
  )
  const commandQuery = state.commandQuery.trim().toLowerCase()
  const commandGroups: CommandPaletteGroup[] = [
    {
      id: "saved",
      label: en ? "Saved views" : "已存视图",
      items: [
        { id: "all", label: en ? "All requests" : "全部请求" },
        { id: "errors", label: en ? "Errors" : "错误请求" },
        {
          id: "slow-first-token",
          label: en ? "Slow first token" : "首 Token 缓慢",
        },
        { id: "high-cost", label: en ? "High cost" : "高费用" },
        { id: "cache-misses", label: en ? "Cache misses" : "缓存未命中" },
      ],
    },
    {
      id: "filters",
      label: en ? "Add a filter" : "添加筛选",
      items: [
        ...requestSources.map((source) => ({
          id: `source:${source.id}`,
          label: `${en ? "source" : "来源"}: ${source.label}`,
          description: source.endpoint,
        })),
        ...[200, 429, 500, 503].map((status) => ({
          id: `status:${status}`,
          label: `${en ? "status" : "状态"}: ${status}`,
          description:
            status === 429
              ? levelLabels.warning
              : status >= 500
                ? levelLabels.error
                : levelLabels.success,
        })),
        ...providers.map(([id, label]) => ({
          id: `provider:${id}`,
          label: `${en ? "provider" : "提供商"}: ${label}`,
        })),
        ...models.map((id) => ({
          id: `model:${id}`,
          label: `${en ? "model" : "模型"}: ${id.split("/").at(-1)}`,
        })),
        ...[
          { id: apScope.projectId, label: "Demo" },
          { id: "api-project-research", label: "Research" },
        ].map((project) => ({
          id: `project:${project.id}`,
          label: `${en ? "project" : "项目"}: ${project.label}`,
        })),
        ...["Production", "Preview"].map((environment) => ({
          id: `environment:${environment}`,
          label: `${en ? "environment" : "环境"}: ${environment}`,
        })),
        ...["hit", "miss", "bypass"].map((cache) => ({
          id: `cache:${cache}`,
          label: `${en ? "cache" : "缓存"}: ${cache === "hit" ? (en ? "Hit" : "命中") : cache === "miss" ? (en ? "Miss" : "未命中") : en ? "Bypass" : "绕过"}`,
        })),
      ],
    },
  ]
  const filteredCommandGroups = commandGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        `${item.label} ${item.description ?? ""}`
          .toLowerCase()
          .includes(commandQuery),
      ),
    }))
    .filter((group) => group.items.length > 0)
  return (
    <main
      className={styles.page}
      ref={(element) => {
        if (element) element.dataset.apHydrated = "true"
      }}
      data-ap-page="api-requests"
      data-ap-ready={!loading}
      data-ap-hydrated="false"
      aria-busy={loading}
      aria-label={en ? "API requests" : "API 请求"}
    >
      <h1 className="sr-only">{en ? "API requests" : "API 请求"}</h1>
      {state.controlsVisible && (
        <aside
          className={styles.filters}
          aria-label={en ? "Request filters" : "请求筛选"}
        >
          <h2 className={styles.filterHeading}>{en ? "Filters" : "筛选"}</h2>
          <Accordion
            value={state.expanded}
            onValueChange={(value) => choose("expanded", value as string[])}
            multiple
          >
            <AccordionItem value="level">
              <AccordionTrigger className={styles.filterTrigger}>
                {en ? "Level" : "级别"}
              </AccordionTrigger>
              <AccordionContent className={styles.filterContent}>
                {(
                  [
                    "success",
                    "warning",
                    "error",
                    ...(state.partial ? ["unknown"] : []),
                  ] as const
                ).map((level) => (
                  <label className={styles.filterRow} key={level}>
                    <Checkbox
                      aria-labelledby={`${filterLabelId}-level-${level}`}
                      checked={state.filters.levels.includes(level)}
                      onCheckedChange={(checked) =>
                        toggleFilter("levels", level, checked)
                      }
                    />
                    <span
                      id={`${filterLabelId}-level-${level}`}
                      className="sr-only"
                    >
                      {`${levelLabels[level as keyof typeof levelLabels]} ${level === "success" ? "2xx" : level === "warning" ? "4xx" : level === "error" ? "5xx" : ""}`.trim()}
                    </span>
                    <span>
                      {levelLabels[level as keyof typeof levelLabels]}
                    </span>
                    <span className={styles.level} data-level={level} />
                    <span className={styles.muted}>
                      {level === "success"
                        ? "2xx"
                        : level === "warning"
                          ? "4xx"
                          : level === "error"
                            ? "5xx"
                            : "—"}
                    </span>
                    <span className={styles.filterCount}>
                      {
                        scoped.filter(
                          (request) => requestLevel(request) === level,
                        ).length
                      }
                    </span>
                  </label>
                ))}
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="date">
              <AccordionTrigger className={styles.filterTrigger}>
                {en ? "Date" : "日期"}
              </AccordionTrigger>
              <AccordionContent className={styles.filterContent}>
                <div className={styles.date}>
                  <CalendarDays size={16} aria-hidden="true" />
                  <DatePicker
                    label={en ? "Pick a date" : "选择日期"}
                    placeholder={en ? "Pick a date" : "选择日期"}
                    value={state.filters.date}
                    onValueChange={(value) => filter("date", value)}
                    defaultMonth="2026-09"
                    today="2026-09-30"
                    weekStartsOn={0}
                  />
                </div>
                {state.filters.date && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => filter("date", null)}
                  >
                    {en ? "All dates" : "全部日期"}
                  </Button>
                )}
              </AccordionContent>
            </AccordionItem>
            {(
              [
                {
                  id: "source",
                  key: "sources",
                  title: en ? "Log source" : "日志来源",
                  options: requestSources.map((source) => ({
                    id: source.id,
                    label: source.label,
                    count: scoped.filter(
                      (request) =>
                        requestLogMetadata(request).source.id === source.id,
                    ).length,
                  })),
                },
                {
                  id: "provider",
                  key: "providers",
                  title: en ? "Provider" : "提供商",
                  options: providers.map(([id, label]) => ({
                    id,
                    label,
                    count: scoped.filter((request) => request.providerId === id)
                      .length,
                  })),
                },
                {
                  id: "model",
                  key: "models",
                  title: en ? "Model" : "模型",
                  options: models.map((id) => ({
                    id,
                    label: id.split("/").at(-1)!,
                    count: scoped.filter((request) => request.modelId === id)
                      .length,
                  })),
                },
              ] as const
            ).map((group) => (
              <AccordionItem key={group.id} value={group.id}>
                <AccordionTrigger className={styles.filterTrigger}>
                  {group.title}
                </AccordionTrigger>
                <AccordionContent className={styles.filterContent}>
                  {group.options.map((option) => (
                    <label key={option.id} className={styles.filterRow}>
                      <Checkbox
                        aria-labelledby={`${filterLabelId}-${group.id}-${option.id}`}
                        checked={state.filters[group.key].includes(option.id)}
                        onCheckedChange={(checked) =>
                          toggleFilter(group.key, option.id, checked)
                        }
                      />
                      <span
                        id={`${filterLabelId}-${group.id}-${option.id}`}
                        title={option.id}
                      >
                        {option.label}
                      </span>
                      <span className={styles.filterCount}>{option.count}</span>
                    </label>
                  ))}
                </AccordionContent>
              </AccordionItem>
            ))}
            <AccordionItem value="latency">
              <AccordionTrigger className={styles.filterTrigger}>
                {en ? "Latency" : "延迟"}
              </AccordionTrigger>
              <AccordionContent className={styles.filterContent}>
                <p className={styles.muted}>
                  {en ? "Minimum" : "最小值"} ·{" "}
                  {(state.filters.minimumLatency / 1000).toFixed(1)} s
                </p>
                <Slider
                  label={en ? "Minimum latency" : "最小延迟"}
                  value={state.filters.minimumLatency}
                  onChange={(value) => filter("minimumLatency", value)}
                  min={0}
                  max={4000}
                  step={100}
                  valueText={(value) => `${value / 1000} seconds`}
                />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </aside>
      )}
      <div className={styles.content}>
        <div className={styles.search}>
          <Search size={16} aria-hidden="true" />
          <Input
            type="search"
            ref={searchRef}
            aria-label={en ? "Search requests" : "搜索请求"}
            placeholder={en ? "Search data table..." : "搜索数据表…"}
            value={state.filters.search}
            onChange={(event) => filter("search", event.target.value)}
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label={en ? "Open filter commands" : "打开筛选命令"}
            onClick={() => choose("commandsOpen", true)}
          >
            ⌘ K
          </Button>
        </div>
        <div className={styles.controls}>
          <div className={styles.controlStart}>
            <Button
              size="icon"
              variant="ghost"
              aria-label={
                state.controlsVisible
                  ? en
                    ? "Hide controls"
                    : "隐藏筛选"
                  : en
                    ? "Show controls"
                    : "显示筛选"
              }
              aria-expanded={state.controlsVisible}
              onClick={() => choose("controlsVisible", !state.controlsVisible)}
            >
              <PanelLeft size={16} aria-hidden="true" />
            </Button>
            <span data-ap-result-count>
              {filtered.length} {en ? "of" : "/"} {scoped.length}{" "}
              {en ? "row(s) filtered" : "条筛选结果"}
            </span>
          </div>
          <div className={styles.controlEnd}>
            <Button
              variant="outline"
              size="icon"
              aria-label={en ? "Reset all filters" : "重置全部筛选"}
              onClick={() =>
                setState((before) => ({
                  ...before,
                  filters: createRequestsState(scenario).filters,
                  selectedIds: [],
                  loadedCount: 20,
                  notice: "",
                }))
              }
            >
              <RotateCcw size={16} aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              aria-label={en ? "Advance sample" : "推进样例"}
              disabled={
                readonly || loading || state.loadedCount >= filtered.length
              }
              title={
                en
                  ? "Explicitly reveal one existing ledger request. No automatic traffic."
                  : "显式展示下一条固定 ledger 请求；不生成自动流量。"
              }
              onClick={() => setState(advanceRequestSample)}
            >
              <Play size={16} aria-hidden="true" />
              {en ? "Advance sample" : "推进样例"}
            </Button>
            <DataTableControls
              variant="compact"
              triggerLabel={en ? "Table settings" : "表格设置"}
              columns={columns.map((column) => ({
                ...column,
                label:
                  typeof column.header === "string"
                    ? column.header
                    : en
                      ? "Level"
                      : "级别",
              }))}
              value={state.columns}
              onValueChange={(value) => choose("columns", value)}
              actions={
                <div className={styles.settings}>
                  <Button variant="ghost" onClick={() => exportRecords()}>
                    <Download size={16} aria-hidden="true" />
                    {en ? "Export filtered rows" : "导出筛选结果"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!visibleSelected}
                    onClick={() => exportRecords(true)}
                  >
                    {en
                      ? `Export ${visibleSelected} selected filtered rows`
                      : `导出 ${visibleSelected} 条选中筛选结果`}
                  </Button>
                  <ApSelect
                    label={en ? "Project scope" : "项目范围"}
                    value={state.filters.projectId}
                    onChange={(value) => filter("projectId", value)}
                    options={[
                      { value: apScope.projectId, label: "Demo" },
                      { value: "api-project-research", label: "Research" },
                      { value: "all", label: en ? "All projects" : "全部项目" },
                    ]}
                  />
                </div>
              }
            />
          </div>
        </div>
        <div className={styles.source}>
          <span>{en ? "Log source" : "日志来源"}</span>
          <ApSelect
            label={en ? "Log source" : "日志来源"}
            value={
              state.filters.sources.length === 1
                ? state.filters.sources[0]
                : "all"
            }
            onChange={(value) =>
              filter("sources", value === "all" ? [] : [value])
            }
            options={[
              { value: "all", label: en ? "All sources" : "全部来源" },
              ...requestSources.map((source) => ({
                value: source.id,
                label: source.label,
              })),
            ]}
          />
          {state.filters.minimumFirstToken > 0 && (
            <Button
              size="sm"
              variant="outline"
              aria-label={en ? "Clear TTFT filter" : "清除首 Token 筛选"}
              onClick={() => filter("minimumFirstToken", 0)}
            >
              TTFT ≥ {(state.filters.minimumFirstToken / 1000).toFixed(2)} s ×
            </Button>
          )}
          {state.filters.minimumCostMicroUsd > 0 && (
            <Button
              size="sm"
              variant="outline"
              aria-label={en ? "Clear cost filter" : "清除费用筛选"}
              onClick={() => filter("minimumCostMicroUsd", 0)}
            >
              {en ? "cost" : "费用"} ≥ $
              {(state.filters.minimumCostMicroUsd / 1000000).toFixed(2)} ×
            </Button>
          )}
          {state.filters.statuses.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              aria-label={en ? "Clear status filter" : "清除状态筛选"}
              onClick={() => filter("statuses", [])}
            >
              {en ? "status" : "状态"}: {state.filters.statuses.join(", ")} ×
            </Button>
          )}
          {state.filters.cache && (
            <Button
              size="sm"
              variant="outline"
              aria-label={en ? "Clear cache filter" : "清除缓存筛选"}
              onClick={() => filter("cache", null)}
            >
              {en ? "cache" : "缓存"}: {state.filters.cache} ×
            </Button>
          )}
          {state.filters.environment && (
            <Button
              size="sm"
              variant="outline"
              aria-label={en ? "Clear environment filter" : "清除环境筛选"}
              onClick={() => filter("environment", null)}
            >
              {en ? "environment" : "环境"}: {state.filters.environment} ×
            </Button>
          )}
          {state.filters.timelineDate ||
          state.filters.date ||
          state.filters.search ||
          state.filters.levels.length ||
          state.filters.sources.length ||
          state.filters.providers.length ||
          state.filters.models.length ||
          state.filters.minimumLatency > 0 ||
          state.filters.statuses.length ||
          state.filters.minimumFirstToken ||
          state.filters.minimumCostMicroUsd ||
          state.filters.cache ||
          state.filters.environment ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setState((before) => ({
                  ...before,
                  filters: {
                    ...createRequestsState(scenario).filters,
                    projectId: before.filters.projectId,
                  },
                }))
              }
            >
              {en ? "Clear filters" : "清除筛选"}
            </Button>
          ) : null}
          {state.selectedIds.length > 0 && (
            <span>
              {state.selectedIds.length} {en ? "selected" : "条已选"} ·{" "}
              {visibleSelected} {en ? "in filter" : "条在筛选内"}
            </span>
          )}
        </div>
        <section
          className={styles.timeline}
          aria-label={en ? "Request timeline" : "请求时间线"}
        >
          <div className={styles.bars}>
            {counts.map((bucket) => (
              <Button
                key={bucket.date}
                variant="ghost"
                className={styles.bar}
                aria-label={`${en ? "Filter" : "筛选"} ${bucket.date} UTC, ${bucket.count} ${en ? "requests" : "条请求"}, ${bucket.errors} ${en ? "errors" : "条错误"}`}
                aria-pressed={state.filters.timelineDate === bucket.date}
                onClick={() =>
                  filter(
                    "timelineDate",
                    state.filters.timelineDate === bucket.date
                      ? null
                      : bucket.date,
                  )
                }
              >
                <span
                  style={{
                    height: bucket.count
                      ? Math.max(4, (bucket.count / maximumBucketCount) * 24)
                      : 2,
                  }}
                />
                <span
                  style={{
                    height: bucket.count
                      ? ((bucket.errors + bucket.unknown) / bucket.count) *
                        Math.max(4, (bucket.count / maximumBucketCount) * 24)
                      : 0,
                  }}
                />
              </Button>
            ))}
          </div>
          <div className={styles.axis}>
            {["01", "08", "15", "22", "30"].map((day) => (
              <span key={day}>{en ? `Sep ${day}` : `9月${day}日`}</span>
            ))}
          </div>
        </section>
        {loading && (
          <div className={styles.recovery}>
            <Button variant="outline" onClick={() => choose("recovered", true)}>
              {en ? "Complete local loading" : "完成本地加载"}
            </Button>
          </div>
        )}
        <div
          className={styles.tableHost}
          ref={tableHost}
          onScrollCapture={(event) => {
            const element = event.target as HTMLElement
            if (element.getAttribute("role") === "region")
              cache?.set(scrollKey, {
                top: element.scrollTop,
                left: element.scrollLeft,
              })
          }}
        >
          <DataTable
            className={styles.table}
            rows={loading ? [] : rows}
            columns={columns}
            columnConfig={state.columns}
            getRowId={(request) => request.requestId}
            getRowLabel={(request) => request.requestId}
            caption={en ? "API requests" : "API 请求"}
            selectedIds={state.selectedIds}
            onSelectionChange={(value) => choose("selectedIds", value)}
            activeRowId={state.lastAdvancedId ?? state.detailId}
            sort={state.sort}
            onSortChange={(value) => choose("sort", value)}
            stickyHeader
            data={{
              state: loading
                ? "loading"
                : error
                  ? "error"
                  : !rows.length
                    ? "empty"
                    : state.partial
                      ? "partial"
                      : "success",
              onRetry: () => choose("recovered", true),
              error: {
                category: "network",
                message: en ? "Request refresh failed" : "请求刷新失败",
                reason: en
                  ? "Local fixture failure. Existing records and selection are preserved."
                  : "本地样例读取失败；保留已有记录和选择。",
              },
              partialDescription: en
                ? "Partial sample · unknown fields stay unknown; available records remain inspectable."
                : "部分样例：未知字段保持未知；仍可查看已有记录。",
              emptyTitle: en ? "No matching requests" : "没有匹配的请求",
              emptyDescription: en
                ? "No ledger records match this scope and filters."
                : "当前范围及筛选条件没有匹配记录。",
              emptyAction: (
                <Button
                  variant="outline"
                  onClick={() =>
                    setState((before) => ({
                      ...before,
                      filters: createRequestsState(scenario).filters,
                    }))
                  }
                >
                  {en ? "Clear filters" : "清除筛选"}
                </Button>
              ),
              rowHeight: 37,
            }}
          />
        </div>
        <footer className={styles.footer}>
          <span>
            {en
              ? `Showing ${rows.length} of ${filtered.length} requests · All times UTC · Local fixture`
              : `显示 ${rows.length} / ${filtered.length} 条请求 · UTC · 本地样例`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || rows.length >= filtered.length}
            onClick={() => choose("loadedCount", state.loadedCount + 60)}
          >
            {en ? "Load 60 more" : "再加载 60 条"}
          </Button>
        </footer>
        <span role="status" className={styles.notice}>
          {state.notice === "copied"
            ? en
              ? "Copied"
              : "已复制"
            : state.notice === "copy-error"
              ? en
                ? "Clipboard unavailable. Select the displayed value to copy."
                : "剪贴板不可用，请选择显示内容复制。"
              : state.notice === "exported"
                ? en
                  ? "Filtered records exported"
                  : "筛选记录已导出"
                : state.notice === "advanced"
                  ? en
                    ? `Revealed ${state.lastAdvancedId}; no traffic generated.`
                    : `已展示 ${state.lastAdvancedId}；未生成流量。`
                  : ""}
        </span>
      </div>
      <Sheet
        open={active && !!state.detailId}
        onOpenChange={(open) => {
          if (!open && active) choose("detailId", null)
        }}
      >
        <SheetContent size={560} className={styles.detail}>
          <SheetHeader className={styles.detailHeader}>
            <SheetTitle>{en ? "Request details" : "请求详情"}</SheetTitle>
            <SheetDescription>
              {en
                ? "Inspect a single request through your AI gateway."
                : "查看经由 AI 网关的一条请求。"}
            </SheetDescription>
          </SheetHeader>
          {detail && meta && (
            <>
              <div className={styles.detailNavigation}>
                <span className={styles.mono} title={detail.requestId}>
                  {detail.requestId}
                </span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={en ? "Copy request ID" : "复制请求 ID"}
                  onClick={() => void copy(detail.requestId)}
                >
                  <Copy size={14} />
                </Button>
                <span>
                  {detailIndex >= 0
                    ? `${detailIndex + 1} / ${filtered.length}`
                    : en
                      ? "Outside current filter"
                      : "不在当前筛选内"}
                </span>
                {[-1, 1].map((direction) => (
                  <Button
                    key={direction}
                    size="icon-sm"
                    variant="ghost"
                    aria-label={
                      direction < 0
                        ? en
                          ? "Previous request"
                          : "上一条请求"
                        : en
                          ? "Next request"
                          : "下一条请求"
                    }
                    disabled={
                      detailIndex < 0 ||
                      detailIndex + direction < 0 ||
                      detailIndex + direction >= filtered.length
                    }
                    onClick={() =>
                      setState((before) =>
                        inspectRequest(
                          before,
                          filtered[detailIndex + direction].requestId,
                        ),
                      )
                    }
                  >
                    {direction < 0 ? (
                      <ArrowUp size={14} />
                    ) : (
                      <ArrowDown size={14} />
                    )}
                  </Button>
                ))}
              </div>
              <SheetBody
                className={styles.detailBody}
                ref={detailBody}
                onScroll={(event) =>
                  cache?.set(
                    `api-requests:${scenario}:detail-scroll:${detail.requestId}`,
                    event.currentTarget.scrollTop,
                  )
                }
              >
                {expired ? (
                  <div role="alert">
                    <h2>{en ? "Request detail expired" : "请求详情已失效"}</h2>
                    <p>
                      {en
                        ? "The snapshot is no longer available. The stable ID and original record are preserved."
                        : "详情快照不再可用；仍保留稳定 ID 和原始记录。"}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() =>
                        choose(
                          "invalidatedIds",
                          state.invalidatedIds.filter(
                            (id) => id !== detail.requestId,
                          ),
                        )
                      }
                    >
                      {en ? "Reload local detail" : "重新加载本地详情"}
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className={styles.modelSummary}>
                      <div>
                        <h2>{meta.model?.name ?? detail.modelId}</h2>
                        <p>
                          {meta.model?.provider ?? detail.providerId} ·{" "}
                          {date(detail.startedAt)} UTC
                        </p>
                      </div>
                      <span
                        className={styles.status}
                        data-level={requestLevel(detail)}
                      >
                        {detail.httpStatus ?? unknown}
                      </span>
                    </div>
                    <div className={styles.metrics}>
                      {[
                        [
                          en ? "Latency" : "延迟",
                          `${number(detail.latencyMs)}${detail.latencyMs === null ? "" : " ms"}`,
                        ],
                        [
                          "Tokens",
                          number(
                            detail.inputTokens === null ||
                              detail.outputTokens === null
                              ? null
                              : detail.inputTokens + detail.outputTokens,
                          ),
                        ],
                        [en ? "Cost" : "费用", cost(detail.costMicroUsd)],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <span>{label}</span>
                          <strong>{value}</strong>
                        </div>
                      ))}
                    </div>
                    <dl className={styles.metadata}>
                      {[
                        [en ? "Log source" : "日志来源", meta.source.label],
                        [
                          en ? "Endpoint" : "端点",
                          `POST ${meta.source.endpoint}`,
                        ],
                        [en ? "Project" : "项目", detail.projectId],
                        [en ? "Environment" : "环境", meta.environment],
                        [
                          en ? "API key" : "API 密钥",
                          en ? "Omitted · no real key" : "已省略 · 无真实密钥",
                        ],
                        [en ? "Region" : "区域", meta.region],
                        [
                          en ? "Cache" : "缓存",
                          `${number(detail.cachedTokens)} tokens`,
                        ],
                        [
                          en ? "Input / output" : "输入 / 输出",
                          `${number(detail.inputTokens)} / ${number(detail.outputTokens)} tokens`,
                        ],
                        [en ? "Credits" : "积分", number(detail.credits)],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <section className={styles.timingSection}>
                      <h3>
                        {en ? "Request timing" : "请求计时"}
                        <span>{number(detail.latencyMs)} ms</span>
                      </h3>
                      {timing(detail)}
                      {[
                        [en ? "Gateway" : "网关", meta.gatewayMs],
                        [
                          en ? "Time to first token" : "首 Token 时间",
                          meta.firstTokenMs,
                        ],
                        [en ? "Generation" : "生成", meta.generationMs],
                      ].map(([label, value]) => (
                        <p key={label as string}>
                          <span>{label}</span>
                          <span>{number(value as number | null)} ms</span>
                        </p>
                      ))}
                    </section>
                    {detail.outcome === "unknown" && (
                      <section
                        className={styles.unknown}
                        aria-label={en ? "Unconfirmed result" : "未确认结果"}
                      >
                        <p>
                          {en
                            ? "Result unknown; no automatic replay."
                            : "结果未知；不会自动重放。"}
                        </p>
                        <p className={styles.mono}>
                          {state.operation?.operationId}
                        </p>
                        <Button
                          variant="outline"
                          onClick={() =>
                            choose("queriedIds", [
                              ...new Set([
                                ...state.queriedIds,
                                detail.requestId,
                              ]),
                            ])
                          }
                        >
                          {en ? "Query sample result" : "查询样例结果"}
                        </Button>
                        {state.queriedIds.includes(detail.requestId) && (
                          <p role="status">
                            {en
                              ? "Query completed: no confirmed result in this fixture. Original payload retained."
                              : "查询完成：此样例没有已确认结果；保留原始请求。"}
                          </p>
                        )}
                      </section>
                    )}
                    <Tabs
                      value={state.tab}
                      onValueChange={(value) => choose("tab", String(value))}
                    >
                      <TabsList className={styles.tabs}>
                        {[
                          ["request", en ? "Request" : "请求"],
                          ["events", en ? "Events" : "事件"],
                          ["response", en ? "Response" : "响应"],
                        ].map(([value, label]) => (
                          <TabsTab key={value} value={value}>
                            {label}
                          </TabsTab>
                        ))}
                      </TabsList>
                      <TabsPanel value="request">
                        <CodePreview
                          identity={`${detail.requestId}:request`}
                          code={JSON.stringify(
                            state.operation?.requestId === detail.requestId
                              ? state.operation.payload
                              : requestPayload(detail),
                            null,
                            2,
                          )}
                          path="request.json"
                          ariaLabel={en ? "Request JSON" : "请求 JSON"}
                          maximumLines={200}
                        />
                      </TabsPanel>
                      <TabsPanel value="events">
                        <ol className={styles.events}>
                          {[
                            [
                              0,
                              en
                                ? "Request accepted by gateway"
                                : "网关已接收请求",
                            ],
                            [
                              meta.gatewayMs,
                              `${meta.model?.provider ?? detail.providerId} · ${detail.modelId}`,
                            ],
                            [
                              detail.latencyMs,
                              detail.outcome === "success"
                                ? en
                                  ? "Request completed"
                                  : "请求已完成"
                                : detail.outcome === "failed"
                                  ? en
                                    ? detail.httpStatus === 429
                                      ? "Rate limit response · not retried"
                                      : `HTTP ${detail.httpStatus ?? unknown} response · not retried`
                                    : detail.httpStatus === 429
                                      ? "限流响应 · 未重试"
                                      : `HTTP ${detail.httpStatus ?? unknown} 响应 · 未重试`
                                  : en
                                    ? "Result unconfirmed"
                                    : "结果未确认",
                            ],
                          ].map(([elapsed, message], index) => (
                            <li key={index}>
                              <span>{number(elapsed as number | null)} ms</span>
                              <div>
                                <strong>
                                  {meta.source.id}.
                                  {index === 0
                                    ? "created"
                                    : index === 1
                                      ? "processing"
                                      : detail.outcome}
                                </strong>
                                <p>{message}</p>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </TabsPanel>
                      <TabsPanel value="response">
                        <CodePreview
                          identity={`${detail.requestId}:response`}
                          code={JSON.stringify(
                            responsePayload(detail),
                            null,
                            2,
                          )}
                          path="response.json"
                          ariaLabel={en ? "Response JSON" : "响应 JSON"}
                          maximumLines={200}
                        />
                      </TabsPanel>
                    </Tabs>
                  </>
                )}
              </SheetBody>
              <SheetFooter className={styles.detailFooter}>
                <span>
                  {en
                    ? "Sample payload · Sensitive fields omitted"
                    : "样例载荷 · 已省略敏感字段"}
                </span>
                <Popover>
                  <PopoverTrigger render={<Button size="sm" variant="ghost" />}>
                    {en ? "Fixture state" : "样例状态"}
                  </PopoverTrigger>
                  <PopoverContent>
                    <PopoverTitle>
                      {en ? "Detail fixture" : "详情样例"}
                    </PopoverTitle>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        choose("invalidatedIds", [
                          ...new Set([
                            ...state.invalidatedIds,
                            detail.requestId,
                          ]),
                        ])
                      }
                    >
                      {en ? "Expire detail sample" : "使详情样例失效"}
                    </Button>
                  </PopoverContent>
                </Popover>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void copy(
                      JSON.stringify(
                        {
                          ...detail,
                          request: requestPayload(detail),
                          response: responsePayload(detail),
                        },
                        null,
                        2,
                      ),
                    )
                  }
                >
                  <Copy size={14} />
                  {en ? "Copy record" : "复制记录"}
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
      <CommandPalette
        title={en ? "Command Menu" : "筛选命令"}
        description={
          en
            ? "Filter the local request log. No external requests are made."
            : "筛选本地请求日志，不发起外部请求。"
        }
        open={active && state.commandsOpen}
        onOpenChange={(open) => {
          if (active) choose("commandsOpen", open)
        }}
        query={state.commandQuery}
        onQueryChange={(query) => choose("commandQuery", query)}
        finalFocus={searchRef}
        groups={filteredCommandGroups}
        onSelect={(item) =>
          setState((before) => applyRequestCommand(before, item.id))
        }
      />
    </main>
  )
}
