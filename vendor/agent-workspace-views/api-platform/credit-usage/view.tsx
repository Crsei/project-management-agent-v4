"use client"
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDownToLine,
  ArrowDownUp,
  ChartNoAxesColumn,
  Plus,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
} from "@easyuse-ui/ui/components/ui/tabs"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
  PopoverDescription,
} from "@easyuse-ui/ui/components/ui/popover"
import { SegmentBar } from "@easyuse-ui/ui/components/ui/segment-bar"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  DataTable,
  type DataTableColumn,
} from "@easyuse-ui/ui/components/blocks/data-table"
import { MetricSummary } from "@easyuse-ui/ui/components/blocks/metric-summary"
import {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
} from "@easyuse-ui/ui/components/ui/menu"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApPage, ApSearch, ApSelect } from "../shared"
import { useApCache, useApState } from "../state"
import { apScope, apScenarios, type ApScenario } from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import {
  creditReportSource,
  creditReportAgents,
  creditReportMembers,
} from "./report-fixtures"
import { apUsagePeriod } from "../fixtures/usage-ledger"
import { createApAccountData } from "../fixtures/accounts"
import {
  applyCreditFilter,
  changeCreditPeriod,
  changeCreditRankingSort,
  clearCreditRankingFilters,
  createCreditUsageState,
  creditRangeError,
  creditUsageExport,
  creditUsageSelection,
  type CreditBreakdown,
  type CreditPeriod,
  type CreditRanking,
} from "./controller"
import styles from "./view.module.css"

export const pageScenarios = apScenarios

export function RemainingPageView({ scenario }: RemainingPageProps) {
  return (
    <CreditUsageView scenario={scenario as ApScenario} source="run-report" />
  )
}

export function CreditUsageView({
  scenario,
  source = "ledger",
}: {
  scenario: ApScenario
  source?: "ledger" | "run-report"
}) {
  const { locale } = useI18n(),
    en = locale === "en"
  const report = source === "run-report"
  const [state, setState] = useApState(
    report ? "credit-usage-run-report" : "credit-usage",
    () => createCreditUsageState(scenario, source),
  )
  const [filterOpen, setFilterOpen] = useState(false)
  const cache = useApCache(),
    page = useRef<HTMLDivElement>(null)
  const selection = useMemo(
    () => creditUsageSelection(state, locale),
    [state, locale],
  )
  const projects = useMemo(() => createApAccountData("default").projects, [])
  const loading = scenario === "loading" && !state.recovered
  const refreshError = scenario === "refresh-error" && !state.recovered
  const agents = state.breakdown === "agents"
  const rangeError = creditRangeError(state.draft)
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  const compactNumber = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  })
  const groupChoices = [
    ...new Map(
      (agents ? creditReportAgents : creditReportMembers).map((identity) => [
        identity.group.en,
        identity.group[locale],
      ]),
    ).entries(),
  ]
  const selectedGroups = state.groupSelections?.[state.breakdown] ?? []
  const date = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
  const from = new Date(`${state.filter.from}T00:00:00Z`),
    to = new Date(`${state.filter.to}T00:00:00Z`)
  const range = en
    ? `${from.getUTCDate()}${state.filter.from === state.filter.to ? "" : `–${to.getUTCDate()}`} ${new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(to)} ${to.getUTCFullYear()}`
    : state.filter.from === state.filter.to
      ? date.format(from)
      : date.formatRange(from, to)
  const unavailable = report
    ? en
      ? "Not reported by the run report"
      : "运行报告未提供此字段"
    : en
      ? "Not reported by the request ledger"
      : "请求账本未提供此字段"
  const creditTotal =
    selection.credits === null
      ? `≥ ${number.format(selection.knownCredits)}`
      : number.format(selection.credits)
  useLayoutEffect(() => {
    const table = page.current?.querySelector<HTMLElement>(
      "[data-credit-table] [role=region]",
    )
    if (table)
      table.scrollLeft = Number(cache?.get("credit-table-position") ?? 0)
  }, [cache, loading])
  const openFilter = (open: boolean) => {
    if (open)
      setState((before) => ({
        ...before,
        draft: { ...before.filter, identities: [...before.filter.identities] },
      }))
    setFilterOpen(open)
  }
  const exportUsage = () => {
    const url = URL.createObjectURL(
      new Blob([creditUsageExport(state, locale)], {
        type: "application/json",
      }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = `credit-usage-${state.breakdown}-${state.filter.from}-${state.filter.to}.json`
    link.click()
    URL.revokeObjectURL(url)
    setState((before) => ({ ...before, notice: "exported" }))
  }
  const columns: DataTableColumn<CreditRanking>[] = [
    {
      id: "name",
      header: agents ? (en ? "Agent" : "Agent") : en ? "User" : "成员",
      minWidth: 220,
      cell: (row) => (
        <span className={styles.identity} title={row.name}>
          {row.name}
        </span>
      ),
    },
    {
      id: "category",
      header: agents ? (en ? "Category" : "分类") : en ? "Team" : "团队",
      minWidth: 190,
      cell: (row) => (
        <span
          className={styles.muted}
          title={row.category ? undefined : unavailable}
        >
          {row.category ?? "—"}
        </span>
      ),
    },
    {
      id: "completedRequests",
      header: (
        <span
          title={
            report
              ? undefined
              : en
                ? "Completed API requests; the ledger has no Agent run IDs"
                : "已完成 API 请求；账本未提供 Agent 运行 ID"
          }
        >
          {report ? (en ? "Runs" : "运行次数") : en ? "Requests" : "请求"}
          <ArrowDownUp aria-hidden="true" size={12} />
        </span>
      ),
      sortable: true,
      align: "right",
      minWidth: 90,
      cell: (row) => number.format(row.completedRequests),
    },
    {
      id: "hoursSaved",
      header: (
        <span>
          {en ? "Hours saved" : "节省小时"}
          <ArrowDownUp aria-hidden="true" size={12} />
        </span>
      ),
      sortable: true,
      align: "right",
      minWidth: 120,
      cell: (row) => (
        <span title={row.hoursSaved === null ? unavailable : undefined}>
          {row.hoursSaved === null ? "—" : number.format(row.hoursSaved)}
        </span>
      ),
    },
    {
      id: "credits",
      header: (
        <span>
          {en ? "Credits used" : "已用积分"}
          <ArrowDownUp aria-hidden="true" size={12} />
        </span>
      ),
      sortable: true,
      align: "right",
      minWidth: 120,
      cell: (row) => (
        <span
          title={
            row.missingCredits
              ? en
                ? `${row.missingCredits} ${report ? "report bucket(s)" : "request(s)"} have unknown credits. Known subtotal: ${row.knownCredits}`
                : `${row.missingCredits} ${report ? "个报告桶" : "条请求"}积分未知；已知小计 ${row.knownCredits}`
              : undefined
          }
        >
          {row.credits === null
            ? `≥ ${number.format(row.knownCredits)} · ?`
            : number.format(row.credits)}
        </span>
      ),
    },
    {
      id: "share",
      header: en ? "Share" : "占比",
      align: "right",
      minWidth: 70,
      cell: (row) =>
        row.share === null ? (
          <span
            title={
              en
                ? "Unknown total credits; no percentage can be calculated"
                : "总积分未知，无法计算占比"
            }
          >
            —
          </span>
        ) : (
          `${report ? row.share.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : number.format(row.share)}%`
        ),
    },
  ]
  const filterCount =
    selectedGroups.length +
    state.filter.identities.length +
    (state.filter.projectId === "all" ? 0 : 1) +
    (state.customRange ? 1 : 0)
  const recover = () =>
    setState((before) => ({ ...before, recovered: true, notice: "refreshed" }))
  return (
    <div
      ref={page}
      className={styles.page}
      onScrollCapture={(event) => {
        const target = event.target as HTMLElement
        if (target.matches("[data-credit-table] [role=region]"))
          cache?.set("credit-table-position", target.scrollLeft)
      }}
    >
      <ApPage
        pageId="credit-usage"
        variant="reference"
        contentWidth={1024}
        title={en ? "Credit usage" : "积分用量"}
        description={
          en
            ? "A closer look at what your team is creating, running, and saving."
            : "深入了解团队的创作、运行与节省情况。"
        }
        actions={
          <Tabs
            value={state.period}
            onValueChange={(value) =>
              setState((before) =>
                changeCreditPeriod(before, value as CreditPeriod),
              )
            }
          >
            <TabsList
              activateOnFocus
              className={styles.tabs}
              aria-label={en ? "Usage period" : "用量周期"}
            >
              <TabsTab value="daily">{en ? "Daily" : "每日"}</TabsTab>
              <TabsTab value="weekly">{en ? "Weekly" : "每周"}</TabsTab>
            </TabsList>
          </Tabs>
        }
      >
        <div className={styles.content}>
          <section
            className={styles.summary}
            aria-label={en ? "Credit usage summary" : "积分用量摘要"}
            data-credit-summary
          >
            <div className={styles.plan}>
              <div className={styles.planIdentity}>
                <span className={styles.planIcon}>
                  <ChartNoAxesColumn aria-hidden="true" size={24} />
                </span>
                <div>
                  <p>{en ? "Business plan" : "商业计划"}</p>
                  <p className={styles.muted}>
                    {en
                      ? "Team workspace · Monthly billing"
                      : "团队工作区 · 按月计费"}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="lg"
                render={
                  <a
                    href={
                      report
                        ? `/showcase/billing?scenario=${scenario}`
                        : "/showcase/billing"
                    }
                  />
                }
              >
                {en ? "Manage plan" : "管理计划"}
              </Button>
            </div>
            <DataRegion
              state={
                loading
                  ? "loading"
                  : selection.missingCredits
                    ? "partial"
                    : "success"
              }
              partialDescription={
                en
                  ? "Some credit values are unknown. The displayed total is a known lower bound; full credit shares are unavailable."
                  : "部分积分未知；总量仅显示已知下限，无法计算完整积分占比。"
              }
              loadingLabel={en ? "Loading credit summary" : "加载积分摘要"}
              rowHeight={48}
            >
              <div className={styles.consumption}>
                <div className={styles.totalLine}>
                  <div>
                    <p className={styles.totalLabel}>
                      {state.customRange
                        ? en
                          ? "Credits used in selected range"
                          : "所选范围已用积分"
                        : state.period === "weekly"
                          ? en
                            ? "Credits used this week"
                            : "本周已用积分"
                          : en
                            ? "Credits used this day"
                            : "当天已用积分"}
                    </p>
                    <p className={styles.total} data-credit-total>
                      {creditTotal}
                    </p>
                  </div>
                  <p className={styles.range} data-credit-range>
                    {range}
                  </p>
                </div>
                {report ? (
                  <div
                    className={styles.stackedBar}
                    role="img"
                    aria-label={
                      en
                        ? `Credit usage: organization ${selection.directCredits} credits, agents ${selection.agentCredits} credits${selection.missingCredits ? "; partial coverage" : ""}`
                        : `积分用量：组织 ${selection.directCredits}，Agent ${selection.agentCredits}${selection.missingCredits ? "，覆盖不完整" : ""}`
                    }
                  >
                    <span style={{ flexGrow: selection.directCredits }} />
                    <span style={{ flexGrow: selection.agentCredits }} />
                  </div>
                ) : (
                  <SegmentBar
                    className={styles.creditBar}
                    label={en ? "Credit usage" : "积分用量"}
                    segments={1}
                    value={selection.credits}
                    max={Math.max(1, selection.knownCredits)}
                    color="var(--credit-accent)"
                    valueText={
                      en
                        ? `${creditTotal} credits; ${selection.missingCredits} missing request credit values`
                        : `${creditTotal} 积分；${selection.missingCredits} 条请求缺失积分值`
                    }
                  />
                )}
                <div className={styles.legendLine}>
                  <div className={styles.legend}>
                    <span>
                      <i />
                      {en ? "Organization usage" : "组织直接用量"} (
                      {selection.directMissing ? "≥ " : ""}
                      {report
                        ? compactNumber.format(selection.directCredits)
                        : number.format(selection.directCredits)}{" "}
                      {en ? "credits" : "积分"})
                    </span>
                    <span>
                      <i />
                      {en ? "Agent usage" : "Agent 用量"} (
                      {selection.agentMissing ? "≥ " : ""}
                      {report
                        ? compactNumber.format(selection.agentCredits)
                        : number.format(selection.agentCredits)}{" "}
                      {en ? "credits" : "积分"})
                    </span>
                  </div>
                  <span>
                    {report
                      ? en
                        ? "Renews on 28 Sep 2026"
                        : "2026年9月28日续订"
                      : en
                        ? "Ledger · Sep 2026 · UTC"
                        : "账本 · 2026年9月 · UTC"}
                  </span>
                </div>
              </div>
              <MetricSummary
                className={styles.metrics}
                items={[
                  {
                    id: "hours",
                    label: en ? "Hours saved" : "节省小时",
                    value: (
                      <span
                        title={
                          selection.hoursSaved === null
                            ? unavailable
                            : undefined
                        }
                      >
                        {selection.hoursSaved === null
                          ? "—"
                          : number.format(selection.hoursSaved)}
                      </span>
                    ),
                  },
                  {
                    id: "active",
                    label: agents
                      ? en
                        ? "Active agents"
                        : "活跃 Agent"
                      : en
                        ? "Active users"
                        : "活跃成员",
                    value: number.format(selection.active),
                  },
                  {
                    id: "completed",
                    label: report
                      ? en
                        ? "Completed runs"
                        : "已完成运行"
                      : en
                        ? "Completed requests"
                        : "已完成请求",
                    value: number.format(selection.completedRequests),
                  },
                  {
                    id: "average",
                    label: report
                      ? state.period === "daily" && !state.customRange
                        ? en
                          ? "Runs / hour avg."
                          : "每小时平均运行"
                        : en
                          ? "Runs / day avg."
                          : "每日平均运行"
                      : state.period === "daily" && !state.customRange
                        ? en
                          ? "Requests / hour avg."
                          : "每小时平均请求"
                        : en
                          ? "Requests / day avg."
                          : "每日平均请求",
                    value: number.format(
                      report
                        ? Math.round(selection.average)
                        : selection.average,
                    ),
                  },
                ]}
              />
            </DataRegion>
          </section>
          <Tabs
            value={state.breakdown}
            onValueChange={(value) =>
              setState((before) => ({
                ...before,
                breakdown: value as CreditBreakdown,
                filter: {
                  ...before.filter,
                  identities: [
                    ...before.identitySelections[value as CreditBreakdown],
                  ],
                },
                draft: {
                  ...before.draft,
                  identities: [
                    ...before.identitySelections[value as CreditBreakdown],
                  ],
                },
              }))
            }
            className={styles.breakdown}
          >
            <div className={styles.toolbar}>
              <TabsList
                activateOnFocus
                className={styles.tabs}
                aria-label={en ? "Usage breakdown" : "用量排行"}
              >
                <TabsTab value="agents">{en ? "Agents" : "Agent"}</TabsTab>
                <TabsTab value="members">
                  {en ? "Power users" : "高用量成员"}
                </TabsTab>
              </TabsList>
              <div className={styles.actions}>
                <ApSearch
                  label={
                    agents
                      ? en
                        ? "Search agents"
                        : "搜索 Agent"
                      : en
                        ? "Search users"
                        : "搜索成员"
                  }
                  placeholder={
                    agents
                      ? en
                        ? "Search agents…"
                        : "搜索 Agent…"
                      : en
                        ? "Search users…"
                        : "搜索成员…"
                  }
                  value={state.searches[state.breakdown]}
                  onChange={(value) =>
                    setState((before) => ({
                      ...before,
                      searches: {
                        ...before.searches,
                        [before.breakdown]: value,
                      },
                    }))
                  }
                />
                <Button
                  variant="outline"
                  size="lg"
                  onClick={exportUsage}
                  disabled={loading}
                >
                  <ArrowDownToLine aria-hidden="true" size={16} />
                  {en ? "Export" : "导出"}
                </Button>
                {report ? (
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          variant="outline"
                          size="lg"
                          className={styles.filterButton}
                        />
                      }
                    >
                      <Plus aria-hidden="true" size={16} />
                      {en ? "Filter" : "筛选"}
                      {selectedGroups.length > 0 &&
                        ` (${selectedGroups.length})`}
                    </MenuTrigger>
                    <MenuContent
                      align="end"

                      aria-label={en ? "Filter" : "筛选"}
                      className={styles.groupMenu}
                    >
                      <MenuGroup>
                        <MenuGroupLabel className={styles.groupLabel}>
                          {agents
                            ? en
                              ? "Category"
                              : "分类"
                            : en
                              ? "Team"
                              : "团队"}
                        </MenuGroupLabel>
                        {groupChoices.map(([id, label]) => (
                          <MenuPrimitive.CheckboxItem
                            key={id}
                            checked={selectedGroups.includes(id)}
                            closeOnClick={false}
                            className={styles.groupItem}
                            onCheckedChange={(checked) =>
                              setState((before) => ({
                                ...before,
                                groupSelections: {
                                  agents: before.groupSelections?.agents ?? [],
                                  members:
                                    before.groupSelections?.members ?? [],
                                  [before.breakdown]: checked
                                    ? [
                                        ...(before.groupSelections?.[
                                          before.breakdown
                                        ] ?? []),
                                        id,
                                      ]
                                    : (
                                        before.groupSelections?.[
                                          before.breakdown
                                        ] ?? []
                                      ).filter((group) => group !== id),
                                },
                              }))
                            }
                          >
                            <span
                              className={styles.groupCheck}
                              aria-hidden="true"
                            >
                              <MenuPrimitive.CheckboxItemIndicator>
                                ✓
                              </MenuPrimitive.CheckboxItemIndicator>
                            </span>
                            {label}
                          </MenuPrimitive.CheckboxItem>
                        ))}
                      </MenuGroup>
                    </MenuContent>
                  </Menu>
                ) : (
                  <Popover open={filterOpen} onOpenChange={openFilter}>
                    <PopoverTrigger
                      render={
                        <Button
                          variant="outline"
                          size="lg"
                          className={styles.filterButton}
                        />
                      }
                    >
                      <Plus aria-hidden="true" size={16} />
                      {en ? "Filter" : "筛选"}
                      {filterCount > 0 && ` (${filterCount})`}
                    </PopoverTrigger>
                    <PopoverContent align="end" className={styles.filterPanel}>
                      <PopoverTitle className={styles.filterTitle}>
                        {en ? "Usage filters" : "用量筛选"}
                      </PopoverTitle>
                      <PopoverDescription className={styles.filterDescription}>
                        {en
                          ? "UTC dates are inclusive here. Exports use an exclusive end boundary."
                          : "此处 UTC 日期含首尾；导出使用不含结束时刻的范围。"}
                      </PopoverDescription>
                      <label className={styles.field}>
                        <span>{en ? "Project" : "项目"}</span>
                        <ApSelect
                          label={en ? "Project scope" : "项目范围"}
                          value={state.draft.projectId}
                          onChange={(value) =>
                            setState((before) => ({
                              ...before,
                              draft: { ...before.draft, projectId: value },
                            }))
                          }
                          options={[
                            {
                              value: "all",
                              label: en ? "All projects" : "全部项目",
                            },
                            ...projects
                              .filter(
                                (project) => project.orgId === apScope.orgId,
                              )
                              .map((project) => ({
                                value: project.projectId,
                                label: project.name,
                              })),
                          ]}
                        />
                      </label>
                      <div className={styles.dateFields}>
                        <label className={styles.field}>
                          <span>{en ? "From (UTC)" : "开始日期（UTC）"}</span>
                          <Input
                            type="date"
                            min="2026-09-01"
                            max="2026-09-30"
                            aria-invalid={Boolean(rangeError)}
                            aria-describedby={
                              rangeError ? "credit-range-error" : undefined
                            }
                            value={state.draft.from}
                            onChange={(event) =>
                              setState((before) => ({
                                ...before,
                                draft: {
                                  ...before.draft,
                                  from: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                        <label className={styles.field}>
                          <span>
                            {en ? "Through (UTC)" : "结束日期（UTC）"}
                          </span>
                          <Input
                            type="date"
                            min="2026-09-01"
                            max="2026-09-30"
                            aria-invalid={Boolean(rangeError)}
                            aria-describedby={
                              rangeError ? "credit-range-error" : undefined
                            }
                            value={state.draft.to}
                            onChange={(event) =>
                              setState((before) => ({
                                ...before,
                                draft: {
                                  ...before.draft,
                                  to: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                      </div>
                      {rangeError && (
                        <p
                          id="credit-range-error"
                          className={styles.error}
                          role="alert"
                        >
                          {rangeError === "outside-ledger"
                            ? en
                              ? "The fixture covers 1–30 Sep 2026 only. Choose dates within its coverage."
                              : "此账本仅覆盖 2026年9月1–30日，请选择覆盖范围内的日期。"
                            : en
                              ? "Choose valid dates with From on or before Through."
                              : "请选择有效日期，开始日期不得晚于结束日期。"}
                        </p>
                      )}
                      <fieldset>
                        <legend>
                          {agents
                            ? en
                              ? "Agents"
                              : "Agent"
                            : en
                              ? "Members"
                              : "成员"}
                        </legend>
                        {selection.allRows.map((row) => (
                          <label className={styles.checkField} key={row.id}>
                            <Checkbox
                              checked={state.draft.identities.includes(row.id)}
                              onCheckedChange={(checked) =>
                                setState((before) => ({
                                  ...before,
                                  draft: {
                                    ...before.draft,
                                    identities: checked
                                      ? [...before.draft.identities, row.id]
                                      : before.draft.identities.filter(
                                          (id) => id !== row.id,
                                        ),
                                  },
                                }))
                              }
                            />
                            <span>{row.name}</span>
                          </label>
                        ))}
                        <p className={styles.filterDescription}>
                          {en
                            ? "No selection includes all identities. Ranking filters do not change scope totals."
                            : "未勾选表示全部身份；排行筛选不改变范围汇总。"}
                        </p>
                      </fieldset>
                      <div className={styles.filterActions}>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setState((before) => ({
                              ...before,
                              draft: {
                                ...before.draft,
                                projectId: "all",
                                from: "2026-09-01",
                                to: "2026-09-30",
                                identities: [],
                              },
                            }))
                          }
                        >
                          {en ? "Full period" : "完整周期"}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => setFilterOpen(false)}
                        >
                          {en ? "Cancel" : "取消"}
                        </Button>
                        <Button
                          onClick={() => {
                            setState(applyCreditFilter)
                            setFilterOpen(false)
                          }}
                          disabled={Boolean(rangeError)}
                        >
                          {en ? "Apply" : "应用"}
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            </div>
            {(["agents", "members"] as const).map((tab) => (
              <TabsPanel key={tab} value={tab} className={styles.panel}>
                <DataRegion
                  state={refreshError ? "error" : "success"}
                  hasContent={!loading}
                  updatedAt="2026-10-01T00:00:00Z"
                  onRetry={recover}
                  error={{
                    category: "request",
                    message: en
                      ? "Credit usage refresh failed."
                      : "积分用量刷新失败。",
                    reason: en
                      ? "The local read was rejected. The last ledger snapshot and your filters are preserved."
                      : "本地读取被拒绝，保留上次账本快照与筛选。",
                  }}
                >
                  <div data-credit-table>
                    <DataTable
                      rows={loading ? [] : selection.rows}
                      columns={columns}
                      getRowId={(row) => row.id}
                      getRowLabel={(row) => row.name}
                      caption={en ? "Credit usage rankings" : "积分用量排行"}
                      className={styles.table}
                      columnConfig={
                        report
                          ? {
                              widths: {
                                name: 305,
                                category: 220,
                                completedRequests: 92,
                                hoursSaved: 134,
                                credits: 135,
                                share: 72,
                              },
                            }
                          : undefined
                      }

                      sort={state.sorts[state.breakdown]}
                      onSortChange={(sort) =>
                        setState((before) =>
                          changeCreditRankingSort(before, sort),
                        )
                      }

                      data={{
                        state: loading
                          ? "loading"
                          : selection.rows.length
                            ? "success"
                            : "empty",
                        rowHeight: 61,
                        emptyTitle: en ? "No matching usage" : "没有匹配的用量",
                        emptyDescription: en
                          ? "No identities match these ranking filters. Clear them or choose another range."
                          : "当前排行筛选没有匹配身份，请清除筛选或选择其他范围。",
                        emptyAction: (
                          <Button
                            variant="outline"
                            onClick={() =>
                              setState((before) => ({
                                ...before,
                                searches: {
                                  ...before.searches,
                                  [before.breakdown]: "",
                                },
                                groupSelections: {
                                  agents: before.groupSelections?.agents ?? [],
                                  members:
                                    before.groupSelections?.members ?? [],
                                  [before.breakdown]: [],
                                },
                                filter: { ...before.filter, identities: [] },
                                identitySelections: {
                                  ...before.identitySelections,
                                  [before.breakdown]: [],
                                },
                              }))
                            }
                          >
                            {en ? "Clear filters" : "清除筛选"}
                          </Button>
                        ),
                      }}
                    />
                  </div>
                </DataRegion>
                <div className={styles.tableFooter} data-credit-count>
                  <span>
                    {selection.rows.length}{" "}
                    {en
                      ? `of ${selection.allRows.length} ${agents ? "agents" : "users"}`
                      : `/ ${selection.allRows.length} 个${agents ? "Agent" : "成员"}`}
                    {report &&
                      (selectedGroups.length > 0 ||
                        state.searches[state.breakdown]) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setState(clearCreditRankingFilters)}
                        >
                          {en ? "Clear filters" : "清除筛选"}
                        </Button>
                      )}
                  </span>
                  <span>
                    {range} ·{" "}
                    {report
                      ? agents
                        ? en
                          ? "Share of agent credits"
                          : "Agent 积分占比"
                        : en
                          ? "Share of total credits"
                          : "总积分占比"
                      : en
                        ? "Share of scope credits"
                        : "范围积分占比"}
                  </span>
                </div>
              </TabsPanel>
            ))}
          </Tabs>
          <div className={styles.fixtureNotes}>
            {loading && (
              <Button variant="outline" onClick={recover}>
                {en ? "Complete fixture load" : "完成样例加载"}
              </Button>
            )}
            <p data-credit-coverage>
              {en ? "Local fixture" : "本地样例"} ·{" "}
              {report ? creditReportSource.revision : apUsagePeriod.revision} ·{" "}
              {en ? "Credit coverage" : "积分覆盖"}:{" "}
              {selection.creditCoverage.observed}/
              {selection.creditCoverage.total}{" "}
              {report
                ? en
                  ? "daily report buckets"
                  : "个日报数据桶"
                : en
                  ? "requests"
                  : "条请求"}
              {selection.missingCredits > 0 &&
                (en
                  ? " · Partial: unknown credits remain unknown; totals are lower bounds."
                  : " · 不完整：未知积分保持未知，总量仅表示已知下限。")}
            </p>
            {!loading && selection.creditCoverage.total === 0 && (
              <p>
                {en
                  ? "No usage recorded in this scope. Known identities are shown with zero credits."
                  : "此范围暂无用量记录，已知身份的积分显示为零。"}
              </p>
            )}
            <p>
              {report
                ? en
                  ? "Local run-report fixture, separate from the API request ledger. Credits are not tokens or currency; hours saved are reported estimates."
                  : "本地运行报告样例，与 API 请求账本独立。积分不等于 Token 或货币；节省时间为报告估计值。"
                : en
                  ? "Credits are not tokens or currency. All recorded usage is Agent-attributed; direct organization usage is zero. Hours, categories and teams are not reported. Request counts do not claim Agent runs or time saved."
                  : "积分不等于 Token 或货币。记录均归属于 Agent，组织直接用量为零；账本未提供节省时间、分类与团队。请求计数不代表 Agent 运行次数或节省时间。"}
            </p>
            <p role="status">
              {state.notice === "exported"
                ? en
                  ? `Exported ${selection.rows.length} visible ranking rows with range, units and coverage.`
                  : `已导出 ${selection.rows.length} 条可见排行，包含范围、单位与覆盖信息。`
                : state.notice === "refreshed"
                  ? en
                    ? "Local ledger snapshot restored; filters preserved."
                    : "本地账本快照已恢复，筛选已保留。"
                  : ""}
            </p>
            {!report && (
              <details
                className={styles.sourceRequests}
                open={state.sourceOpen}
                onToggle={(event) => {
                  const open = event.currentTarget.open
                  setState((before) => ({ ...before, sourceOpen: open }))
                }}
              >
                <summary>
                  {en ? "Inspect source requests" : "查看来源请求"} (
                  {selection.requests.length})
                </summary>
                <ul>
                  {selection.requests.map((request) => (
                    <li key={request.requestId}>
                      <code>{request.requestId}</code>
                      <span>
                        {request.startedAt} ·{" "}
                        {request.credits === null
                          ? en
                            ? "Unknown credits"
                            : "积分未知"
                          : `${request.credits} ${en ? "credits" : "积分"}`}{" "}
                        · {request.outcome}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      </ApPage>
    </div>
  )
}
