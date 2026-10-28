"use client"

import {
  useLayoutEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react"
import {
  ArrowUpRight,
  ChevronRight,
  Download,
  Siren,
  Trash2,
} from "lucide-react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { NativeSelect } from "@easyuse-ui/ui/components/ui/native-select"
import { Tabs, TabsList, TabsTab } from "@easyuse-ui/ui/components/ui/tabs"
import { Pagination } from "@easyuse-ui/ui/components/ui/pagination"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@easyuse-ui/ui/components/ui/dialog"
import {
  DataTable,
  type DataTableColumn,
} from "@easyuse-ui/ui/components/blocks/data-table"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { useApCache, useApState } from "../state"
import { apAsOf, apScenarioIds, apScenarios, type ApScenario } from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import {
  incidentFixtureRevision,
  incidentScope,
  incidentSeverities,
  severityCopy,
  stageCopy,
  type IncidentSeverity,
} from "./fixtures"
import {
  createIncidentState,
  incidentDailyRows,
  incidentExport,
  incidentGroups,
  incidentSelection,
  retainIncidentSelection,
  setIncidentSeverity,
  settleIncidentNote,
  submitIncidentNote,
  type IncidentState,
} from "./controller"
import type { IncidentRecord, IncidentPeriod } from "./service-fixtures"
import styles from "./incidents.module.css"

const severityColor: Record<IncidentSeverity, string> = {
  critical: "var(--incident-critical)",
  high: "var(--incident-high)",
  medium: "var(--incident-medium)",
  low: "var(--incident-low)",
}
const severityTone: Record<IncidentSeverity, "danger" | "warning" | "neutral"> =
  {
    critical: "danger",
    high: "danger",
    medium: "warning",
    low: "neutral",
  }
type PageState = IncidentState<IncidentRecord>
type UpdateState = Dispatch<SetStateAction<PageState>>

function Notes({
  state,
  update,
  targetId,
}: {
  state: PageState
  update: UpdateState
  targetId: string
}) {
  const { locale } = useI18n(),
    en = locale === "en"
  const blocked =
    state.readonly ||
    state.receipt?.result === "pending" ||
    state.receipt?.result === "unknown"
  const notes = state.notes[targetId] ?? [],
    draft = state.drafts[targetId] ?? ""
  const receipt = state.receipt?.targetId === targetId ? state.receipt : null
  return (
    <section
      className={styles.notes}
      aria-label={en ? "Internal notes" : "内部笔记"}
      data-incident-notes={targetId}
    >
      <h3>{en ? "Internal notes" : "内部笔记"}</h3>
      {notes.length > 0 && (
        <ul>
          {notes.map((note) => (
            <li key={note.noteId}>
              <span>{note.copy?.[locale] ?? note.text}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={en ? "Delete internal note" : "删除内部笔记"}
                disabled={blocked}
                onClick={() =>
                  update((s) => submitIncidentNote(s, targetId, note))
                }
              >
                <Trash2 size={12} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className={styles.noteForm}
        onSubmit={(event) => {
          event.preventDefault()
          update((s) => submitIncidentNote(s, targetId))
        }}
      >
        <Input
          aria-label={en ? "Add an internal note" : "添加内部笔记"}
          placeholder={en ? "Write a note…" : "写下笔记…"}
          value={draft}
          readOnly={state.readonly}
          onChange={(event) =>
            update((s) => ({
              ...s,
              drafts: { ...s.drafts, [targetId]: event.target.value },
            }))
          }
        />
        <Button type="submit" disabled={blocked || !draft.trim()}>
          {en ? "Add" : "添加"}
        </Button>
      </form>
      {state.readonly && (
        <p className={styles.muted}>
          {en ? "Read only — notes cannot be changed." : "只读：不能修改笔记。"}
        </p>
      )}
      {receipt && (
        <div
          className={styles.receipt}
          role="status"
          data-note-result={receipt.result}
        >
          <p>
            {receipt.result === "pending"
              ? en
                ? "Note operation pending; no changes applied."
                : "笔记操作待确认，尚未更改。"
              : receipt.result === "unknown"
                ? en
                  ? "Result unknown. Check the original operation; do not resubmit."
                  : "结果未知。请查询原操作，不能重新提交。"
                : receipt.result === "rejected"
                  ? en
                    ? "Note operation rejected. Your draft is retained."
                    : "笔记操作被拒绝，草稿已保留。"
                  : en
                    ? "Local note operation confirmed."
                    : "本地笔记操作已确认。"}
          </p>
          <code>{receipt.operationId}</code>
          {(receipt.result === "pending" || receipt.result === "unknown") && (
            <p className={styles.payload}>{receipt.payload.text}</p>
          )}
          {receipt.result === "pending" && (
            <Button
              variant="outline"
              onClick={() => update((s) => settleIncidentNote(s))}
            >
              {en ? "Resolve pending operation" : "确认待处理操作"}
            </Button>
          )}
          {receipt.result === "unknown" && (
            <Button
              variant="outline"
              onClick={() => update((s) => settleIncidentNote(s, true))}
            >
              {en ? "Check operation result" : "查询操作结果"}
            </Button>
          )}
        </div>
      )}
      {targetId === "platform" &&
        state.receipt &&
        state.receipt.targetId !== "platform" &&
        (state.receipt.result === "pending" ||
          state.receipt.result === "unknown") && (
          <div className={styles.receipt} role="status">
            <p>
              {en
                ? "An incident note operation needs confirmation."
                : "一个事件笔记操作需要确认。"}
            </p>
            <code>{state.receipt.operationId}</code>
            <Button
              variant="outline"
              onClick={() =>
                update((s) => ({
                  ...s,
                  listOpen: true,
                  listDimension: null,
                  listPage:
                    Math.floor(
                      Math.max(
                        0,
                        s.incidents.findIndex(
                          (row) => row.incidentId === s.receipt?.targetId,
                        ),
                      ) / 20,
                    ) + 1,
                  selectedId: s.receipt?.targetId ?? null,
                  endpoint: null,
                  region: null,
                  severities: [...incidentSeverities],
                }))
              }
            >
              {en ? "Inspect original note operation" : "检查原始笔记操作"}
            </Button>
          </div>
        )}
      <details className={styles.simulation}>
        <summary>{en ? "Local note simulation" : "本地笔记模拟"}</summary>
        <label>
          {en ? "Next note result" : "下一次笔记结果"}
          <NativeSelect
            aria-label={en ? "Next note result" : "下一次笔记结果"}
            disabled={blocked}
            value={state.noteOutcome}
            onChange={(event) =>
              update((s) => ({
                ...s,
                noteOutcome: event.target.value as IncidentState["noteOutcome"],
              }))
            }
          >
            <option value="confirmed">{en ? "Confirmed" : "确认"}</option>
            <option value="rejected">{en ? "Rejected" : "拒绝"}</option>
            <option value="unknown">{en ? "Unknown" : "未知"}</option>
          </NativeSelect>
        </label>
        <p>
          {en
            ? "No backend writes. Resolve is an explicit fixture step; an unknown receipt is checked, never replayed."
            : "不会写入后端。确认是显式样例步骤；未知回执只查询，不重放。"}
        </p>
      </details>
    </section>
  )
}

function DailyChart({
  rows,
  severities,
  stacked,
  period,
}: {
  rows: IncidentRecord[]
  severities: IncidentSeverity[]
  stacked?: boolean
  period: IncidentPeriod
}) {
  const { locale } = useI18n(),
    en = locale === "en"
  const data = incidentDailyRows(rows, period)
  const domainMax = Math.max(
    20,
    Math.ceil(Math.max(...data.map((day) => day.total)) / 20) * 20,
  )
  const dateLabel = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      timeZone: period.timeZone,
    }).format(new Date(`${value}T00:00:00Z`))
  return (
    <figure
      className={styles.plot}
      aria-label={en ? "Daily incident counts" : "每日事件数"}
      data-chart-count={rows.length}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          accessibilityLayer
        >
          <CartesianGrid
            vertical={false}
            stroke="var(--border)"
            strokeDasharray="4 4"
            strokeOpacity={0.3}
          />
          <XAxis
            dataKey="date"
            tickFormatter={dateLabel}
            interval={1}
            tickLine={false}
            axisLine={false}
            fontSize={11}
            tick={{ fill: "var(--muted-foreground)" }}
          />
          <YAxis
            width={36}
            allowDecimals={false}
            domain={
              period.from.startsWith("2026-08") ? [0, domainMax] : undefined
            }
            ticks={
              period.from.startsWith("2026-08")
                ? [
                    0,
                    domainMax / 4,
                    domainMax / 2,
                    (domainMax * 3) / 4,
                    domainMax,
                  ]
                : undefined
            }
            tickLine={false}
            axisLine={false}
            fontSize={11}
            tick={{ fill: "var(--muted-foreground)" }}
          />
          <Tooltip
            labelFormatter={(value) => dateLabel(String(value))}
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
            }}
            cursor={{ fill: "var(--surface-hover)" }}
          />
          {stacked ? (
            severities.map((severity) => (
              <Bar
                key={severity}
                dataKey={severity}
                name={severityCopy[severity][locale]}
                stackId="severity"
                fill={severityColor[severity]}
                isAnimationActive={false}
                maxBarSize={16}
              />
            ))
          ) : (
            <Bar
              dataKey="total"
              name={en ? "Incidents" : "事件"}
              fill="var(--incident-total)"
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
              maxBarSize={16}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
      <figcaption className="sr-only">
        {en
          ? `${rows.length} incidents in [${period.from}, ${period.to}) UTC. View data opens the corresponding local records.`
          : `UTC [${period.from}, ${period.to}) 共 ${rows.length} 个事件。查看数据可打开对应本地记录。`}
      </figcaption>
    </figure>
  )
}

function Breakdown({
  rows,
  dimension,
  open,
}: {
  rows: IncidentRecord[]
  dimension: "endpoint" | "region"
  open: (id?: string) => void
}) {
  const { locale } = useI18n(),
    en = locale === "en"
  const groups = incidentGroups(rows, dimension)
  return (
    <figure
      className={styles.breakdownPlot}
      aria-label={
        dimension === "endpoint"
          ? en
            ? "Endpoint incident counts"
            : "端点事件数"
          : en
            ? "Region incident counts"
            : "区域事件数"
      }
      data-chart-count={rows.length}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={groups}
          layout="vertical"
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          accessibilityLayer
        >
          <XAxis
            type="number"
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            fontSize={11}
            tick={{ fill: "var(--muted-foreground)" }}
          />
          <YAxis
            dataKey="id"
            type="category"
            width={168}
            tickLine={false}
            axisLine={false}
            tick={({ x, y, payload }) => {
              const group = groups.find((entry) => entry.id === payload.value)
              const label =
                payload.value === "unknown"
                  ? en
                    ? "Unknown"
                    : "未知"
                  : String(payload.value)
              return (
                <foreignObject
                  x={Number(x) - 168}
                  y={Number(y) - 14}
                  width={160}
                  height={28}
                >
                  <Button
                    variant="ghost"
                    className={styles.axisButton}
                    aria-label={`${label}: ${group?.value ?? 0}`}
                    data-incident-breakdown-id={String(payload.value)}
                    onClick={() => open(String(payload.value))}
                  >
                    {label}
                  </Button>
                </foreignObject>
              )
            }}
          />
          <Tooltip
            labelFormatter={(id) =>
              id === "unknown" ? (en ? "Unknown" : "未知") : String(id)
            }
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
            }}
            cursor={{ fill: "var(--surface-hover)" }}
          />
          <Bar
            dataKey="value"
            name={en ? "Incidents" : "事件"}
            fill="var(--incident-total)"
            barSize={18}
            radius={[0, 4, 4, 0]}
            isAnimationActive={false}
            onClick={(entry) => {
              if (typeof entry.id === "string") open(entry.id)
            }}
          />
        </BarChart>
      </ResponsiveContainer>
      <figcaption className="sr-only">
        {groups
          .map(
            (group) =>
              `${group.id === "unknown" ? (en ? "Unknown" : "未知") : group.id}: ${group.value}`,
          )
          .join("; ")}
      </figcaption>
    </figure>
  )
}

export function IncidentsView({
  scenario,
  source = "ledger",
  active = true,
}: {
  scenario: ApScenario
  source?: "ledger" | "reference"
  active?: boolean
}) {
  const { locale } = useI18n(),
    en = locale === "en"
  const [state, update] = useApState<PageState>(`incidents:${source}`, () =>
    createIncidentState(scenario, source),
  )
  const cache = useApCache(),
    viewport = useRef<HTMLElement>(null)
  const rows = incidentSelection(state)
  const period = state.period
  const month = new Intl.DateTimeFormat(locale, {
    month: "long",
    timeZone: period.timeZone,
  }).format(new Date(period.from))
  const breakdownDimension = state.tab === "endpoints" ? "endpoint" : "region"
  const breakdownRows =
    source === "reference"
      ? rows.filter((row) => row[breakdownDimension] !== null)
      : rows
  const listDimension = state.listDimension
  const listRows =
    source === "reference" && listDimension
      ? rows.filter((row) => row[listDimension] !== null)
      : rows
  const listPage = Math.min(
    state.listPage,
    Math.max(1, Math.ceil(listRows.length / 20)),
  )
  const selected = listRows.find((row) => row.incidentId === state.selectedId)
  const number = (value: number) => new Intl.NumberFormat(locale).format(value)
  const unknown = en ? "Unknown" : "未知"
  const loading = scenario === "loading" && !state.recovered
  const displayedCount = loading ? "—" : number(rows.length)
  const refreshError = scenario === "refresh-error" && !state.recovered
  const regionCount = incidentGroups(state.incidents, "region").filter(
    (group) => group.id !== "unknown",
  ).length
  useLayoutEffect(() => {
    if (active && viewport.current)
      viewport.current.scrollTop = Number(
        cache?.get(`incidents:${source}:scroll`) ?? 0,
      )
  }, [cache, source, active])
  const openList = (dimension?: "endpoint" | "region", id?: string) =>
    update((s) =>
      retainIncidentSelection({
        ...s,
        listOpen: true,
        listPage: 1,
        listDimension: dimension && !id ? dimension : null,
        ...(dimension && id ? { [dimension]: id } : {}),
      }),
    )
  const exportRows = () => {
    const url = URL.createObjectURL(
      new Blob([incidentExport(state)], { type: "application/json" }),
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `incidents-${period.from.slice(0, 7)}-fixture.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  const columns: DataTableColumn<IncidentRecord>[] = [
    {
      id: "incident",
      header: en ? "Incident" : "事件",
      primary: true,
      minWidth: 160,
      cell: (row) => row.incidentId,
    },
    {
      id: "severity",
      header: en ? "Severity" : "严重级别",
      cell: (row) => (
        <Badge size="sm" tone={severityTone[row.severity]}>
          {severityCopy[row.severity][locale]}
        </Badge>
      ),
    },
    {
      id: "stage",
      header: en ? "Stage" : "处理阶段",
      cell: (row) => stageCopy[row.stage][locale],
    },
    {
      id: "endpoint",
      header: en ? "Endpoint" : "端点",
      cell: (row) => row.endpoint ?? unknown,
    },
    {
      id: "region",
      header: en ? "Region" : "区域",
      cell: (row) => row.region ?? unknown,
    },
    {
      id: "time",
      header: en ? "Started (UTC)" : "开始（UTC）",
      cell: (row) => (
        <time dateTime={row.startedAt}>
          {row.startedAt.slice(0, 16).replace("T", " ")}
        </time>
      ),
    },
  ]
  const details = [
    [en ? "Internal name" : "内部名称", "chat-completions"],
    [en ? "Version" : "版本", period.from.slice(0, 10)],
    [
      en ? "Provider" : "提供商",
      source === "reference"
        ? "Northstar inference"
        : en
          ? "Local inference fixture"
          : "本地推理样例",
    ],
    [
      en ? "Primary region" : "主要区域",
      source === "reference" ? "us-east" : "iad1",
    ],
    [en ? "Owner" : "负责人", "ML platform"],
    [en ? "Added" : "添加日期", en ? "Mar 14, 2026" : "2026 年 3 月 14 日"],
    ["SLO", en ? "99.95% monthly" : "每月 99.95%"],
    [
      en ? "Base URL" : "基础 URL",
      source === "reference"
        ? "api.northstar.dev/v1"
        : "api.fixture.invalid/v1",
    ],
    [en ? "Status" : "状态", en ? "Operational" : "正常"],
    [
      en
        ? `Filtered ${source === "ledger" ? "Sep" : month} incidents`
        : `筛选的${month}事件`,
      number(rows.length),
    ],
  ]
  return (
    <main
      ref={viewport}
      className={styles.viewport}
      data-ap-page="incidents"
      onScroll={(event) =>
        cache?.set(`incidents:${source}:scroll`, event.currentTarget.scrollTop)
      }
    >
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.identity}>
            <span className={styles.icon}>
              <Siren size={20} aria-hidden="true" />
            </span>
            <div>
              <h1>
                {en ? "API platform · production" : "API 平台 · 生产环境"}
              </h1>
              <p>
                {en
                  ? `${regionCount} ${regionCount === 1 ? "region" : "regions"} · 99.95% monthly SLO · ${displayedCount} ${month} incidents`
                  : `${regionCount} 个区域 · 每月 SLO 99.95% · ${month} ${displayedCount} 个事件`}
              </p>
            </div>
          </div>
          <div className={styles.actions}>
            <Button
              variant="outline"
              nativeButton={false}
              role="link"
              render={<a href="/showcase/profile" />}
            >
              {en ? "Profile" : "个人资料"}
              <ArrowUpRight size={12} />
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              role="link"
              render={<a href="/showcase/api-requests" />}
            >
              {en ? "Logs" : "日志"}
              <ArrowUpRight size={12} />
            </Button>
            <Button
              variant="outline"
              onClick={() => update((s) => ({ ...s, runbookOpen: true }))}
            >
              {en ? "Runbook" : "操作手册"}
              <ArrowUpRight size={12} />
            </Button>
            <Button variant="outline" disabled={loading} onClick={exportRows}>
              <Download size={14} />
              {en ? "Export" : "导出"}
            </Button>
          </div>
        </header>
        <Tabs
          value={state.tab}
          onValueChange={(tab) =>
            update((s) => ({ ...s, tab: tab as IncidentState["tab"] }))
          }
        >
          <TabsList
            aria-label={en ? "Incident views" : "事件视图"}
            className={styles.tabs}
          >
            <TabsTab value="overview">{en ? "Overview" : "概览"}</TabsTab>
            <TabsTab value="endpoints">{en ? "Endpoints" : "端点"}</TabsTab>
            <TabsTab value="regions">{en ? "Regions" : "区域"}</TabsTab>
          </TabsList>
        </Tabs>
        {(state.endpoint || state.region) && (
          <div className={styles.filterNotice} role="status">
            {en ? "Current scope" : "当前范围"}:{" "}
            {[state.endpoint, state.region]
              .filter(Boolean)
              .map((value) => (value === "unknown" ? unknown : value))
              .join(" · ")}
            <Button
              variant="ghost"
              onClick={() =>
                update((s) => ({ ...s, endpoint: null, region: null }))
              }
            >
              {en ? "Clear filters" : "清除筛选"}
            </Button>
          </div>
        )}
        <div className={styles.grid}>
          <aside
            aria-label={en ? "Platform details" : "平台详情"}
            className={styles.details}
          >
            <h2>{en ? "Details" : "详情"}</h2>
            <dl>
              {details.map(([label, value], index) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd
                    className={
                      index === 0 || index === 7 ? styles.mono : undefined
                    }
                  >
                    {index === 8 && (
                      <span className={styles.operational} aria-hidden="true" />
                    )}
                    {index === 9 ? (
                      <span data-incident-count>{loading ? "—" : value}</span>
                    ) : (
                      value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <Notes state={state} update={update} targetId="platform" />
          </aside>
          <div
            className={styles.charts}
            aria-label={en ? "Incident analytics" : "事件分析"}
          >
            {loading && (
              <Button
                variant="outline"
                onClick={() => update((s) => ({ ...s, recovered: true }))}
              >
                {en ? "Load local sample" : "加载本地样例"}
              </Button>
            )}
            <DataRegion
              state={loading ? "loading" : refreshError ? "error" : "success"}
              hasContent={!loading && rows.length > 0}
              error={{
                category: "network",
                message: en ? "Could not refresh incidents." : "无法刷新事件。",
                reason: en
                  ? "The last fixture snapshot, selection and notes are retained."
                  : "保留上次样例快照、选择和笔记。",
              }}
              updatedAt={apAsOf}
              onRetry={() => update((s) => ({ ...s, recovered: true }))}
            >
              {state.tab === "overview" ? (
                <section
                  className={styles.overview}
                  aria-label={en ? "Incident overview" : "事件概览"}
                >
                  <section
                    className={`${styles.card} ${styles.totalCard}`}
                    aria-label={en ? "Total incidents" : "事件总数"}
                  >
                    <div className={styles.cardHeader}>
                      <h2>{en ? "Incidents" : "事件"}</h2>
                      <Button
                        variant="ghost"
                        className={styles.viewData}
                        onClick={() => openList()}
                      >
                        {en ? "View data" : "查看数据"}
                        <ChevronRight size={12} />
                      </Button>
                    </div>
                    <p className={styles.total} data-incident-total>
                      {number(rows.length)}
                    </p>
                    <p className={styles.muted}>{en ? "Total" : "总计"}</p>
                    <DailyChart
                      rows={rows}
                      severities={state.severities}
                      period={period}
                    />
                  </section>
                  <section
                    className={`${styles.card} ${styles.severityCard}`}
                    aria-label={
                      en ? "Incidents by severity" : "按严重级别划分的事件"
                    }
                  >
                    <div className={styles.cardHeader}>
                      <h2>
                        {en ? "Incidents by severity" : "按严重级别划分的事件"}
                      </h2>
                      <Button
                        variant="ghost"
                        className={styles.viewData}
                        onClick={() => openList()}
                      >
                        {en ? "View data" : "查看数据"}
                        <ChevronRight size={12} />
                      </Button>
                    </div>
                    <div className={styles.severities}>
                      {incidentSeverities.map((severity) => (
                        <Button
                          variant="ghost"
                          key={severity}
                          className={styles.severity}
                          aria-label={`${number(state.incidents.filter((row) => row.severity === severity && (!state.endpoint || (row.endpoint ?? "unknown") === state.endpoint) && (!state.region || (row.region ?? "unknown") === state.region)).length)} ${severityCopy[severity][locale]}`}
                          aria-pressed={state.severities.includes(severity)}
                          title={`${state.severities.includes(severity) ? (en ? "Hide" : "隐藏") : en ? "Show" : "显示"} ${severityCopy[severity][locale]}`}
                          onClick={() =>
                            update((s) => setIncidentSeverity(s, severity))
                          }
                        >
                          <strong>
                            {number(
                              state.incidents.filter(
                                (row) =>
                                  row.severity === severity &&
                                  (!state.endpoint ||
                                    (row.endpoint ?? "unknown") ===
                                      state.endpoint) &&
                                  (!state.region ||
                                    (row.region ?? "unknown") === state.region),
                              ).length,
                            )}
                          </strong>
                          <span>
                            <i
                              style={{ background: severityColor[severity] }}
                            />
                            {severityCopy[severity][locale]}
                          </span>
                        </Button>
                      ))}
                    </div>
                    <DailyChart
                      rows={rows}
                      severities={state.severities}
                      stacked
                      period={period}
                    />
                    <p className={styles.hint}>
                      {en
                        ? "Select a severity above to isolate it."
                        : "选择上方严重级别以筛选事件。"}
                    </p>
                  </section>
                </section>
              ) : (
                <section
                  className={`${styles.card} ${styles.breakdownCard}`}
                  aria-label={
                    state.tab === "endpoints"
                      ? en
                        ? "Incidents by endpoint"
                        : "按端点划分的事件"
                      : en
                        ? "Incidents by region"
                        : "按区域划分的事件"
                  }
                >
                  <div className={styles.cardHeader}>
                    <h2>
                      {state.tab === "endpoints"
                        ? en
                          ? "Incidents by endpoint"
                          : "按端点划分的事件"
                        : en
                          ? "Incidents by region"
                          : "按区域划分的事件"}
                    </h2>
                    <Button
                      variant="ghost"
                      className={styles.viewData}
                      onClick={() => openList(breakdownDimension)}
                    >
                      {en ? "View data" : "查看数据"}
                      <ChevronRight size={12} />
                    </Button>
                  </div>
                  <div className={styles.breakdownCaption}>
                    <p className={styles.muted}>
                      {en
                        ? `${month} total · ${state.severities.length === 4 ? "all severities" : "selected severities"}`
                        : `${month}总计 · ${state.severities.length === 4 ? "所有严重级别" : "所选严重级别"}`}
                    </p>
                    {source === "reference" &&
                      rows.length > breakdownRows.length && (
                        <Button
                          variant="ghost"
                          className={styles.viewData}
                          onClick={() =>
                            openList(breakdownDimension, "unknown")
                          }
                        >
                          {en
                            ? `${rows.length - breakdownRows.length} unknown impact`
                            : `${rows.length - breakdownRows.length} 个影响范围未知`}
                        </Button>
                      )}
                  </div>
                  <Breakdown
                    rows={breakdownRows}
                    dimension={
                      state.tab === "endpoints" ? "endpoint" : "region"
                    }
                    open={(id) =>
                      openList(
                        state.tab === "endpoints" ? "endpoint" : "region",
                        id,
                      )
                    }
                  />
                </section>
              )}
              {!rows.length && (
                <div className={styles.empty} role="status">
                  <p>
                    {state.incidents.length
                      ? en
                        ? "No incidents match the current filters."
                        : "没有符合当前筛选的事件。"
                      : en
                        ? "No incidents in this fixture period."
                        : "此样例周期没有事件。"}
                  </p>
                  {state.incidents.length > 0 && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        update((s) => ({
                          ...s,
                          severities: [...incidentSeverities],
                          endpoint: null,
                          region: null,
                        }))
                      }
                    >
                      {en ? "Clear filters" : "清除筛选"}
                    </Button>
                  )}
                </div>
              )}
            </DataRegion>
          </div>
        </div>
        <p className={styles.footer} role="status">
          {en
            ? `Static ${month} fixture · chart and detail counts share the same filtered records. `
            : `固定${month}样例 · 图表与明细计数使用同一筛选记录。`}
          {incidentScope.orgId} / {incidentScope.projectId} · [{period.from},{" "}
          {period.to}) · {period.timeZone} ·{" "}
          {source === "reference" ? period.revision : incidentFixtureRevision} ·{" "}
          {en ? "snapshot" : "快照"} {apAsOf}
        </p>
      </div>
      <Dialog
        open={active && state.listOpen}
        onOpenChange={(open) => update((s) => ({ ...s, listOpen: open }))}
      >
        <DialogContent
          className={styles.listDialog}
          {...(state.endpoint || state.region
            ? {
                finalFocus: () =>
                  document.querySelector<HTMLButtonElement>(
                    `[data-incident-breakdown-id="${CSS.escape(state.endpoint ?? state.region ?? "")}"]`,
                  ),
              }
            : {})}
        >
          <DialogTitle>{en ? "Incident records" : "事件记录"}</DialogTitle>
          <DialogDescription>
            {en
              ? `${listRows.length} local records in this chart scope. Select a stable incident ID for event details.`
              : `此图表范围内 ${listRows.length} 条本地记录。选择稳定事件 ID 查看详情。`}
          </DialogDescription>
          <DataTable
            rows={listRows.slice((listPage - 1) * 20, listPage * 20)}
            columns={columns}
            getRowId={(row) => row.incidentId}
            getRowLabel={(row) => row.incidentId}
            caption={en ? "Filtered incident records" : "筛选后的事件记录"}
            activeRowId={state.selectedId}
            onActivateRow={(row) =>
              update((s) => ({ ...s, selectedId: row.incidentId }))
            }
            maxHeight={240}
          />
          {listRows.length > 20 && (
            <Pagination
              page={listPage}
              pageCount={Math.ceil(listRows.length / 20)}
              onPageChange={(page) => update((s) => ({ ...s, listPage: page }))}
            />
          )}
          {selected && (
            <section
              className={styles.incidentDetail}
              aria-label={en ? "Incident detail" : "事件详情"}
            >
              <h2>{selected.title[locale]}</h2>
              <p className={styles.mono}>{selected.incidentId}</p>
              <div className={styles.detailBadges}>
                <Badge tone={severityTone[selected.severity]}>
                  {severityCopy[selected.severity][locale]}
                </Badge>
                <Badge>{stageCopy[selected.stage][locale]}</Badge>
                <Badge>
                  {selected.request?.httpStatus == null
                    ? en
                      ? "HTTP unknown"
                      : "HTTP 未知"
                    : `HTTP ${selected.request.httpStatus}`}
                </Badge>
              </div>
              <dl>
                <div>
                  <dt>{en ? "Impact endpoint" : "受影响端点"}</dt>
                  <dd>{selected.endpoint ?? unknown}</dd>
                </div>
                <div>
                  <dt>{en ? "Impact region" : "受影响区域"}</dt>
                  <dd>{selected.region ?? unknown}</dd>
                </div>
                <div>
                  <dt>{en ? "Scope" : "范围"}</dt>
                  <dd>
                    {selected.orgId} / {selected.projectId}
                  </dd>
                </div>
                <div>
                  <dt>{en ? "Request ID" : "请求 ID"}</dt>
                  <dd>
                    {selected.request?.requestId ??
                      (en
                        ? "Not reported — service sample only"
                        : "未提供——仅为服务样例")}
                  </dd>
                </div>
              </dl>
              <p>
                {selected.description?.[locale] ??
                  (en
                    ? "Partial incident detail: impact coverage, description and event timeline were not reported. No HTTP result or request identity is inferred."
                    : "部分事件详情：未提供影响范围、描述和事件时间线。不推断 HTTP 结果或请求身份。")}
              </p>
              <h3>{en ? "Event timeline" : "事件时间线"}</h3>
              {selected.events ? (
                <ol className={styles.timeline}>
                  {selected.events.map((event) => (
                    <li key={event.eventId}>
                      <time dateTime={event.at}>{event.at}</time>
                      <strong>{stageCopy[event.stage][locale]}</strong>
                      <p>{event.text[locale]}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>
                  {en ? "Event timeline unavailable." : "事件时间线不可用。"}
                </p>
              )}
              <Notes
                state={state}
                update={update}
                targetId={selected.incidentId}
              />
            </section>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={active && state.runbookOpen}
        onOpenChange={(open) => update((s) => ({ ...s, runbookOpen: open }))}
      >
        <DialogContent>
          <DialogTitle>
            {en ? "Local incident runbook" : "本地事件操作手册"}
          </DialogTitle>
          <DialogDescription>
            {en
              ? "Read-only fixture guidance; no service actions are executed."
              : "只读样例指引，不执行服务操作。"}
          </DialogDescription>
          <ol className={styles.runbook}>
            <li>
              {en
                ? "Inspect the incident severity, stage and linked request independently."
                : "分别检查事件严重级别、处理阶段和关联请求。"}
            </li>
            <li>
              {en
                ? "Preserve evidence and note drafts before changing the scope."
                : "切换范围前保留证据和笔记草稿。"}
            </li>
            <li>
              {en
                ? "Query an unknown note operation by its original operation ID. Never replay it."
                : "按原始操作 ID 查询未知笔记操作，切勿重放。"}
            </li>
          </ol>
        </DialogContent>
      </Dialog>
    </main>
  )
}

export const pageScenarios = apScenarios

/** The shared Lab host supplies the page/scenario-scoped API state provider. */
export function RemainingPageView({ scenario, active }: RemainingPageProps) {
  const selectedScenario =
    apScenarioIds.find((id) => id === scenario) ?? "default"
  return (
    <IncidentsView
      scenario={selectedScenario}
      source="reference"
      active={active}
    />
  )
}
