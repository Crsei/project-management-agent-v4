import { useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Activity, ArrowRight, Bell, CircleCheck, Clock3, FileText, Filter, FolderKanban, Monitor, MoreHorizontal, RefreshCw, Zap } from "lucide-react"
import { Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import { Avatar } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { FilterCard, type FilterCondition, type FilterField } from "@/components/blocks/filter-card"
import { DataTable } from "@/components/blocks/data-table"
import { StatisticalChart } from "@/components/blocks/charts/statistical-chart"
import { useI18n } from "@/lib/i18n-provider"
import { issueCatalog } from "./issue-domain"
import { PmMemberIdentity, usePmScenarioState } from "./shared"
import { pmClock, type PmPageProps } from "./model"
import { usePmDomainState, usePmNavigation } from "./domain-session"
import { useIssueDomain } from "./use-issue-domain"
import { usePeopleDomain } from "./use-people-domain"
import { directoryRows } from "./people-controller"
import { availabilityLabels } from "./people-fixtures"
import { formatProjectDate, statusCopy } from "./project-list-1-fixtures"
import { projectHealthBand } from "./project-health"
import { AttentionList, currencySummaries, dashboardMoney, dashboardMoneyPrecisionLabel, healthAnalytics, healthBandColor, healthBandLabel, Picker, SectionTitle, usePmProjectDomain } from "./dashboards-views"
import { budgetStatusLabel, dashboard3Attention, dashboard3BudgetRows, dashboard3MonthlyBudgetRows, dashboard3SprintRows, useDashboard3State, type Dashboard3WindowDays } from "./dashboard-3-controller"
import { dashboard3ActivitySeed } from "./dashboard-3-fixtures"
import { useFixtureDashboardSurface } from "./dashboard-fixture-surface"
import { DashboardView } from "./dashboard"
import { DashboardNavigation } from "./dashboard-navigation"
import type { IssueDrilldown } from "./issues-controller"
import d3 from "./dashboard-3.module.css"

type IssueFilterTarget = {
  stateId: string
  priorityId: string
  assigneeIds: readonly string[]
  projectId: string
  dueDate: string | null
}
function issueDueBucket(date: string | null, today: string, weekEnd: string) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "none"
  if (date < today) return "overdue"
  if (date === today) return "today"
  return date <= weekEnd ? "week" : "later"
}
function matchesIssueFilter(issue: IssueFilterTarget, condition: FilterCondition, today: string, weekEnd: string) {
  if (!condition.values.length) return true
  let hit = false
  if (condition.field === "status") hit = condition.values.includes(issue.stateId)
  else if (condition.field === "priority") hit = condition.values.includes(issue.priorityId)
  else if (condition.field === "assignee") hit = issue.assigneeIds.length ? issue.assigneeIds.some((id) => condition.values.includes(id)) : condition.values.includes("unassigned")
  else if (condition.field === "project") hit = condition.values.includes(issue.projectId)
  else if (condition.field === "due") hit = condition.values.includes(issueDueBucket(issue.dueDate, today, weekEnd))
  return condition.operator === "isNot" ? !hit : hit
}

/** The portfolio showcase owns its finance, presence and sample history. Nothing
 * in this adapter is loaded by the production dashboard read model. */
export function PortfolioDashboardFixture({ scenario }: PmPageProps) {
  const { locale } = useI18n()
  const en = locale === "en"
  const text = (zh: string, english: string) => en ? english : zh
  const { navigate } = usePmNavigation()
  const [issueDomain] = useIssueDomain(scenario)
  const [peopleDomain] = usePeopleDomain(scenario)
  const members = useMemo(() => directoryRows(peopleDomain), [peopleDomain])
  const projects = usePmProjectDomain(scenario)
  const [state, setState] = useDashboard3State()
  const [currency, setCurrency] = usePmScenarioState("pm-dashboard-3-currency", () => "USD")
  const [query, setQuery] = usePmScenarioState("pm-dashboard-3-query", () => "")
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [conditions, setConditions] = usePmScenarioState<FilterCondition[]>("pm-dashboard-3-issue-filters", () => [])
  const [, setIssueDrilldown] = usePmDomainState<IssueDrilldown | null>("issue-list-1:drilldown", () => null)
  const [listScroll, setListScroll] = usePmScenarioState<Record<string, number>>("pm-dashboard-3-list-scroll", () => ({}))
  const milestonesRef = useRef<HTMLUListElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const activityRef = useRef<HTMLUListElement>(null)
  const gradientId = `portfolio-budget-${useId().replace(/:/g, "")}`
  useLayoutEffect(() => {
    for (const [id, element] of [["milestones", milestonesRef.current], ["status", statusRef.current], ["activity", activityRef.current]] as const) {
      if (element) element.scrollTop = listScroll[id] ?? 0
    }
  }, [listScroll])
  const rememberScroll = (id: string, element: HTMLElement) => {
    const top = element.scrollTop
    setListScroll(previous => previous[id] === top ? previous : { ...previous, [id]: top })
  }
  const normalizedQuery = query.trim().toLocaleLowerCase(locale)
  const scopedProjects = projects.filter(project => (state.projectId === "all" || project.id === state.projectId) && (!normalizedQuery || `${project.identifier} ${project.title[locale]}`.toLocaleLowerCase(locale).includes(normalizedQuery)))
  const issueFilterToday = pmClock.slice(0, 10)
  const issueFilterWeekEnd = new Date(Date.parse(`${issueFilterToday}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10)
  const scopedIssues = issueDomain.items.filter(issue => scopedProjects.some(project => project.id === issue.projectId) && conditions.every(condition => matchesIssueFilter(issue, condition, issueFilterToday, issueFilterWeekEnd)))
  const activeFilterCount = conditions.filter(condition => condition.values.length > 0).length
  const issueFilterCatalog = issueCatalog(locale)
  const issueProjectOptions = projects.map(project => ({ value: project.id, label: `${project.identifier} ${project.title[locale]}` }))
  const filterFields: FilterField[] = [
    { id: "status", label: text("状态", "Status"), options: issueFilterCatalog.states.map(status => ({ value: status.id, label: status.label })) },
    { id: "priority", label: text("优先级", "Priority"), options: issueFilterCatalog.priorities.map(priority => ({ value: priority.id, label: priority.label })) },
    { id: "assignee", label: text("负责人", "Assignee"), options: [...issueFilterCatalog.assignees.map(assignee => ({ value: assignee.id, label: assignee.label })), { value: "unassigned", label: text("未分配", "Unassigned") }] },
    ...(issueProjectOptions.length ? [{ id: "project", label: text("项目", "Project"), options: issueProjectOptions }] : []),
    { id: "due", label: text("截止日期", "Due date"), options: [
      { value: "overdue", label: text("已逾期", "Overdue") },
      { value: "today", label: text("今天到期", "Due today") },
      { value: "week", label: text("未来 7 天", "Next 7 days") },
      { value: "later", label: text("更晚", "Later") },
      { value: "none", label: text("无到期日", "No due date") },
    ] },
  ]
  const budgetRows = dashboard3BudgetRows(scopedProjects)
  const summaries = currencySummaries(scopedProjects.map(project => project.id))
  const summary = summaries.find(row => row.currency === currency) ?? summaries[0]
  const activeCurrency = summary?.currency ?? currency
  const actualKnown = !!summary && summary.reporting > summary.withoutActual
  const capKnown = !!summary && summary.reporting > summary.withoutCap
  const percent = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : "—"
  const money = (amount: number) => new Intl.NumberFormat(locale, { style: "currency", currency: activeCurrency, notation: "compact", maximumFractionDigits: 1 }).format(amount)
  const burn = summary && actualKnown && summary.cap > 0 ? percent(summary.actual, summary.cap) : "—"
  const bands: Record<string, number> = { "on-track": 0, "at-risk": 0, "off-track": 0, unknown: 0 }
  for (const project of scopedProjects) bands[projectHealthBand(project.health)] += 1
  const reporting = scopedProjects.filter(project => project.health !== null)
  const meanHealth = reporting.length ? reporting.reduce((sum, project) => sum + project.health!, 0) / reporting.length : null
  const portfolioBand = projectHealthBand(meanHealth)
  const portfolioLabel = meanHealth === null ? text("未知", "Unknown") : meanHealth >= 70 ? text("良好", "Good") : meanHealth >= 45 ? text("需关注", "Watch") : text("有风险", "At risk")
  const attention = dashboard3Attention(scopedProjects, scopedIssues, locale)
  const health = healthAnalytics(scopedProjects, locale)
  const sprintRows = dashboard3SprintRows(scopedIssues, state.windowDays, locale)
  const completed = sprintRows.at(-1)?.completed ?? 0
  const planned = sprintRows.at(-1)?.scope ?? 0
  const monthlyRows = dashboard3MonthlyBudgetRows(scopedProjects, activeCurrency, locale)
  const current = scopedProjects.find(project => project.id === state.projectId) ?? scopedProjects[0]
  const owner = current ? members.find(row => row.member.id === current.ownerId)?.member : undefined
  const teamMembers = current ? peopleDomain.memberships.filter(member => member.teamId === current.teamId).map(member => members.find(row => row.member.id === member.memberId)?.member).filter(member => member !== undefined) : []
  const team = current ? peopleDomain.teams.find(team => team.id === current.teamId) : undefined
  const milestones = scopedProjects.filter(project => project.dueDate).toSorted((a, b) => a.dueDate!.localeCompare(b.dueDate!))
  const scopedActivity = issueDomain.activity.filter(event => scopedIssues.some(issue => issue.id === event.itemId)).toSorted((a, b) => b.at.localeCompare(a.at))
  const activity = [
    ...scopedActivity.map(event => ({ ...event, kind: "updated", title: event.description[locale] })),
    ...dashboard3ActivitySeed.flatMap(event => {
      const issue = scopedIssues.find(row => row.id === event.itemId)
      if (!issue) return []
      const action = event.kind === "comment" ? text("评论了", "commented on") : event.kind === "review" ? text("移至评审", "moved to Review:") : event.kind === "completed" ? text("完成了", "closed") : text("更新了", "updated")
      return [{ id: event.id, itemId: issue.id, kind: event.kind, at: new Date(Date.parse(pmClock) - event.minutesAgo * 60000).toISOString(), title: `${action} ${issue.identifier}` }]
    }),
  ].toSorted((a, b) => b.at.localeCompare(a.at))
  const surface = useFixtureDashboardSurface(scenario, "dashboard3", scopedProjects, scopedIssues, peopleDomain, scopedActivity)
  const openIssues = (onlyCompleted = false) => {
    const projectId = state.projectId !== "all" ? state.projectId : scopedProjects.length === 1 ? scopedProjects[0].id : null
    setIssueDrilldown({ projectId, query: "", stateIds: onlyCompleted ? ["done"] : [], overdue: false })
    navigate("issue-list-1", projectId ?? undefined)
  }
  const relativeTime = (at: string) => {
    const minutes = Math.max(0, Math.round((Date.parse(pmClock) - Date.parse(at)) / 60000))
    return minutes < 60 ? `${minutes}${text("分钟前", "m ago")}` : minutes < 1440 ? `${Math.floor(minutes / 60)}${text("小时前", "h ago")}` : `${Math.floor(minutes / 1440)}${text("天前", "d ago")}`
  }
  const scopePicker = <Picker label={text("当前项目", "Current project")} value={state.projectId} disabled={!projects.length} options={[{ value: "all", label: text("所有项目", "All projects") }, ...projects.map(project => ({ value: project.id, label: `${project.identifier} ${project.title[locale]}` }))]} onChange={projectId => setState(previous => ({ ...previous, projectId }))} />
  const sprintDescription = text("按到期日累计的当前任务状态，不代表历史完成时间。图表可下钻至当前项目任务；缺少到期日的任务不计入。", "Current issue states accumulated by due date, not historical completion timestamps. Open the chart to inspect this project's issues. Unscheduled issues are excluded.")
  const sprintChart = <ResponsiveContainer width="100%" height={176} minWidth={1}>
    <ComposedChart data={sprintRows} margin={{ top: 5, right: 5, bottom: 5, left: 5 }} accessibilityLayer>
      <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={.13} />
      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "var(--text-secondary)" }} tickMargin={10} interval={0} />
      <YAxis hide domain={[0, Math.max(planned + 1, 5)]} />
      <Tooltip content={({ active, payload, label }) => active && payload?.length ? <div className={d3.tooltip}><strong>{label}</strong>{payload.map(entry => <p key={String(entry.dataKey)}>{entry.name}: {entry.value}</p>)}</div> : null} />
      <Bar dataKey="completed" name={text("已完成", "Completed")} fill="var(--foreground)" radius={[3, 3, 0, 0]} barSize={14} isAnimationActive={false} onClick={() => openIssues(true)} />
      <Line dataKey="scope" name={text("范围", "Scope")} type="monotone" stroke="var(--text-secondary)" strokeWidth={2} dot={{ r: 3, fill: "var(--surface)", strokeWidth: 1.5 }} activeDot={{ r: 4 }} isAnimationActive={false} onClick={() => openIssues()} />
    </ComposedChart>
  </ResponsiveContainer>
  const details = <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
    <DialogContent className={d3.dialog}>
      <DialogTitle>{text("组合明细与关注事项", "Portfolio details & attention")}</DialogTitle>
      <DialogDescription>{text("显式本地样例。预算按原币种分别汇总；缺失数据不计为零。", "Explicit local fixtures. Budgets are grouped by recorded currency; missing data is never counted as zero.")}</DialogDescription>
      <div className={d3.dialogTools}>{scopePicker}<Picker label={text("预算币种", "Budget currency")} value={activeCurrency} disabled={!summaries.length} options={summaries.map(row => ({ value: row.currency, label: row.currency }))} onChange={setCurrency} />{scenario === "readonly" && <Badge>{text("只读", "Read only")}</Badge>}</div>
      <div className={d3.detailsGrid}>
        <section className={d3.detailsCard} data-pm-dashboard3="budget"><SectionTitle>{text("预算明细", "Budget detail")}</SectionTitle>
          <DataTable rows={budgetRows} getRowId={row => row.project.id} getRowLabel={row => row.project.identifier} caption={text("按记录币种显示的项目预算", "Project budgets in their recorded currency")} columns={[
            { id: "project", header: text("项目", "Project"), primary: true, cell: row => <Button variant="ghost" className={d3.rowLink} title={row.project.title[locale]} onClick={() => navigate("project-detail-1", row.project.id)}><span className={d3.rowTitle}>{row.project.title[locale]}</span><span className={d3.identifier}>{row.project.identifier}</span></Button> },
            { id: "currency", header: text("币种", "Currency"), cell: row => row.currency ?? "—" },
            { id: "cap", header: text("预算", "Cap"), cell: row => row.cap === null ? text("未设置", "Not set") : dashboardMoney(row.cap, row.currency!, locale) },
            { id: "actual", header: text("实际", "Actual"), cell: row => row.actual === null ? text("未记录", "Not recorded") : dashboardMoney(row.actual, row.currency!, locale) },
            { id: "forecast", header: text("预测", "Forecast"), cell: row => row.forecast === null ? text("未记录", "Not recorded") : dashboardMoney(row.forecast, row.currency!, locale) },
            { id: "burn", header: text("消耗", "Burn"), cell: row => row.burn === null ? "—" : `${Math.round(row.burn * 100)}%` },
            { id: "status", header: text("状态", "Status"), cell: row => budgetStatusLabel(row.status, en) },
          ]} />
          <p className={d3.caption}>{dashboardMoneyPrecisionLabel(locale)}</p>
          <p className={d3.caption}>{text("预算覆盖", "Budget coverage")}: {budgetRows.filter(row => row.cap !== null).length}/{budgetRows.length} · {text("缺失不计为零", "Missing is not zero")}</p>
          <ul className={d3.currencyChips}>{summaries.map(row => <li key={row.currency} className={d3.currencyChip}><strong>{row.currency}</strong> {row.reporting > row.withoutActual ? dashboardMoney(row.actual, row.currency, locale) : "—"} / {row.reporting > row.withoutCap ? dashboardMoney(row.cap, row.currency, locale) : "—"}</li>)}</ul>
        </section>
        <section className={d3.detailsCard} data-pm-dashboard3="health-donut"><SectionTitle>{text("健康度分布", "Health distribution")}</SectionTitle><StatisticalChart widgetId="pm-dashboard-3-health" presentation="embedded" kind="donut" composition="exclusive" height={210} title={text("健康度分布", "Health distribution")} description={text("未记录健康度单独显示为未知。", "Unrecorded project health is shown separately as unknown.")} query={health.query} result={health.result} /></section>
      </div>
      <section className={d3.detailsCard} aria-label={text("需要关注", "Needs attention")} data-pm-dashboard3="attention"><SectionTitle>{text("需要关注", "Needs attention")}</SectionTitle><AttentionList items={attention} onOpen={(slug, entityId) => navigate(slug, entityId)} emptyLabel={text("当前筛选下没有需要关注的项目。", "Nothing needs attention under the current filter.")} /></section>
      <section className={d3.detailsCard}><SectionTitle>{text("月度预算记录", "Monthly budget observations")}</SectionTitle><table className={d3.historyTable}><caption>{activeCurrency} · {text("显式本地月度样例；未来值为预测。覆盖率按项目计，未报告的值不计为零。", "Explicit local monthly samples; future values are forecasts. Coverage counts projects; missing values are not zero.")}</caption><thead><tr><th>{text("月份", "Month")}</th><th>{text("实际", "Actual")}</th><th>{text("预测", "Forecast")}</th><th>{text("覆盖：实际 / 预测", "Coverage: actual / forecast")}</th></tr></thead><tbody>{monthlyRows.map(row => <tr key={row.at}><td>{row.at.slice(0, 7)}</td><td>{row.actual === null ? "—" : dashboardMoney(row.actual, activeCurrency, locale)}</td><td>{row.forecast === null ? "—" : dashboardMoney(row.forecast, activeCurrency, locale)}</td><td>{row.actualReporting}/{row.projects} · {row.forecastReporting}/{row.projects}</td></tr>)}</tbody></table></section>
    </DialogContent>
  </Dialog>

  return <DashboardView {...surface}
    readModel={{ ...surface.readModel, title: text("指挥中心", "Command Center") }}
    navigation={<DashboardNavigation query={query} onQueryChange={setQuery} onPeople={() => navigate("member-list-1")} onActivity={() => navigate("inbox-1")} members={members.map(row => ({ id: row.member.id, name: row.member.name }))} disabled={scenario === "loading"} />}
    headerActions={<div className={d3.pageActions}><Popover><PopoverTrigger render={<Button variant="outline" size="sm" />}><Filter size={14} aria-hidden="true" />{text("筛选", "Filter")}{activeFilterCount > 0 && <Badge size="sm" tone="neutral">{activeFilterCount}</Badge>}</PopoverTrigger><PopoverContent className="w-[min(460px,calc(100vw-2rem))] p-0" align="end" aria-label={text("任务筛选", "Issue filters")}><FilterCard title={text("任务筛选", "Issue filters")} fields={filterFields} conditions={conditions} onChange={setConditions} emptyHint={text("尚未添加筛选条件，显示当前范围内的全部任务。", "No filter conditions yet; every issue in scope is shown.")} addLabel={text("添加条件", "Add condition")} clearLabel={text("清除条件", "Clear conditions")} whereLabel={text("条件", "Where")} andLabel={text("并且", "and")} anyLabel={text("任意", "Any")} removeLabel={text("移除条件", "Remove filter")}/></PopoverContent></Popover>{scenario === "readonly" && <Badge>{text("只读", "Read only")}</Badge>}<span className={d3.snapshot}><Clock3 size={14} aria-hidden="true" />{text("本地快照", "Local snapshot")}</span><Button variant="ghost" size="icon" className={d3.refresh} disabled={scenario === "loading" || surface.readModel.data.refreshing} aria-label={text("刷新仪表盘", "Refresh dashboard")} onClick={surface.actions.refresh}><RefreshCw size={16} aria-hidden="true" /></Button></div>}
    toolbar={null}
    createDialog={details}
    regions={{
      metrics: <section aria-label={text("组合概览", "Portfolio overview")} className={d3.summaryStrip} data-pm-dashboard3="portfolio-header">
        <button type="button" className={`${d3.stat} ${d3.healthStat}`} aria-label={text("查看组合健康度与关注事项", "View portfolio health and attention")} onClick={() => setDetailsOpen(true)}><p>{text("组合健康度", "Portfolio Health")}</p><strong style={{ color: healthBandColor(portfolioBand) }}>{portfolioLabel}</strong><span style={{ color: healthBandColor(portfolioBand) }}>{healthBandLabel(portfolioBand, en)}</span>{reporting.length > 1 && <svg className={d3.healthSpark} viewBox="0 0 100 24" aria-hidden="true"><polyline points={reporting.map((project, index) => `${index / (reporting.length - 1) * 96 + 2},${22 - project.health! / 100 * 20}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>}</button>
        <button type="button" className={d3.stat} onClick={() => setDetailsOpen(true)} aria-label={text("筛选项目与查看组合明细", "Filter projects and view portfolio details")}><p>{text("项目", "Projects")}</p><strong>{scopedProjects.length}</strong><span>{text("本地项目", "Local projects")}</span></button>
        {(["on-track", "at-risk", "off-track"] as const).map(band => <button type="button" key={band} className={d3.stat} onClick={() => setDetailsOpen(true)} aria-label={`${healthBandLabel(band, en)}: ${bands[band]}`}><p>{healthBandLabel(band, en)}</p><strong>{bands[band]}</strong><span>{percent(bands[band], reporting.length)}</span></button>)}
        <button type="button" className={d3.stat} onClick={() => setDetailsOpen(true)} aria-label={text("查看预算明细", "View budget details")}><p>{text("预算消耗", "Budget Burn")}</p><strong>{burn}</strong><span>{actualKnown ? money(summary!.actual) : "—"} / {capKnown ? money(summary!.cap) : "—"}</span></button>
      </section>,
      timeline: <section className={d3.card} data-pm-dashboard3="trends" aria-label={text("迭代健康度", "Sprint health")}>
        <header className={d3.cardHeader}><div><SectionTitle>{text("迭代健康度", "Sprint health")}</SectionTitle><div className={d3.legend}><span>{text("已完成", "Completed")}</span><span>{text("范围", "Scope")}</span></div></div><Picker label={text("统计窗口", "Reporting window")} value={String(state.windowDays)} options={[{ value: "14", label: text("本次迭代", "This sprint") }, { value: "28", label: text("4 周", "4 weeks") }, { value: "56", label: text("8 周", "8 weeks") }]} onChange={value => setState(previous => ({ ...previous, windowDays: Number(value) as Dashboard3WindowDays }))} /></header>
        <div className={d3.sprintBody}><div className={d3.chart} role="group" aria-label={sprintDescription} tabIndex={0} onKeyDown={event => { if (event.key === "Enter") openIssues() }}>{sprintChart}</div><dl className={d3.sprintStats}><div><dt>{text("迭代进度", "Sprint progress")}</dt><dd>{percent(completed, planned)}</dd></div><div><dt>{text("已完成", "Completed")}</dt><dd>{completed}</dd></div><div><dt>{text("任务总计", "Total issues")}</dt><dd>{planned}</dd></div></dl></div>
      </section>,
      cards: <section className={d3.card} data-pm-dashboard3="budget-burn" aria-label={text("预算消耗", "Budget Burn")}>
        <header className={d3.cardHeader}><div><SectionTitle>{text("预算消耗", "Budget Burn")}</SectionTitle><div className={`${d3.legend} ${d3.lineLegend}`}><span>{text("实际", "Actual")}</span><span>{text("预测", "Forecast")}</span></div></div><Picker label={text("预算币种", "Budget currency")} value={activeCurrency} disabled={!summaries.length} options={summaries.map(row => ({ value: row.currency, label: row.currency }))} onChange={setCurrency} /></header>
        <div className={`${d3.chart} ${d3.budgetChart}`} role="group" tabIndex={0} aria-label={text("本地月度预算记录；按 Enter 查看明细与数据覆盖。", "Local monthly budget observations; press Enter for details and data coverage.")} onKeyDown={event => { if (event.key === "Enter") setDetailsOpen(true) }}><ResponsiveContainer width="100%" height={176} minWidth={1}><ComposedChart data={monthlyRows} margin={{ top: 8, right: 6, bottom: 0, left: 0 }} accessibilityLayer><defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--foreground)" stopOpacity={.18} /><stop offset="100%" stopColor="var(--foreground)" stopOpacity={.03} /></linearGradient></defs><CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={.14} /><XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "var(--text-secondary)" }} tickMargin={10} interval={0} /><YAxis width={32} axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "var(--text-secondary)" }} tickCount={5} tickFormatter={value => money(Number(value))} /><Tooltip content={({ active, payload, label }) => active && payload?.length ? <div className={d3.tooltip}><strong>{label}</strong>{payload.map(entry => <p key={String(entry.dataKey)}>{entry.name}: {entry.value === null ? "—" : money(Number(entry.value))}</p>)}</div> : null} /><Area dataKey="actual" name={text("实际", "Actual")} type="monotone" stroke="var(--foreground)" strokeWidth={2} fill={`url(#${gradientId})`} isAnimationActive={false} /><Line dataKey="forecast" name={text("预测", "Forecast")} type="monotone" stroke="var(--text-secondary)" strokeWidth={2} strokeDasharray="3 3" dot={false} connectNulls={false} isAnimationActive={false} /></ComposedChart></ResponsiveContainer>{actualKnown && <div className={d3.budgetCallout}><strong>{money(summary!.actual)}</strong><span>{burn} {text("预算消耗", "of budget")}</span></div>}</div>
      </section>,
      currentProject: <section className={d3.card} data-pm-dashboard3="current-project" aria-label={text("当前项目", "Current Project")}><header className={d3.cardHeader}><SectionTitle><span className={d3.titleIcon}><Zap size={16} aria-hidden="true" />{text("当前项目", "Current Project")}</span></SectionTitle><Button variant="outline" onClick={() => navigate("project-list-1")}>{text("查看全部", "See All")}</Button></header>{current && <div className={d3.projectBody}><p className={d3.caption}>{text("项目名称", "Project Name")}</p><div className={d3.projectHeader}><Button variant="ghost" className={d3.projectLink} aria-label={`${text("打开项目", "Open project")} ${current.identifier}`} title={current.title[locale]} onClick={() => navigate("project-detail-1", current.id)}><FolderKanban size={18} aria-hidden="true" /><span className={d3.rowTitle}>{current.title[locale]}</span></Button><Badge size="sm" tone="warning">{statusCopy[current.status][locale]}</Badge></div><div className={d3.projectFields}><div><p className={d3.caption}>{text("项目负责人", "Project Manager")}</p>{owner ? <PmMemberIdentity member={owner} /> : <span className={d3.muted}>{text("未记录", "Not recorded")}</span>}</div><div><p className={d3.caption}>{text("设计负责人", "Design Lead")}</p><span className={d3.muted}>{text("未记录", "Not recorded")}</span></div></div><p className={d3.caption} title={team?.name[locale]}>{text("团队", "Team")}</p><div className={d3.team} aria-label={team?.name[locale]}>{teamMembers.slice(0, 4).map(member => <Avatar key={member.id} name={member.name} size={24} />)}{teamMembers.length > 4 && <span className={d3.teamRemainder}>+{teamMembers.length - 4}</span>}{!teamMembers.length && <span className={d3.caption}>{text("没有已记录成员", "No recorded members")}</span>}</div></div>}</section>,
      projects: <section className={d3.card} data-pm-dashboard3="milestones" aria-label={text("即将到来的里程碑", "Upcoming milestones")}><header className={d3.cardHeader}><SectionTitle>{text("即将到来的里程碑", "Upcoming milestones")}</SectionTitle></header><ul ref={milestonesRef} onScroll={event => rememberScroll("milestones", event.currentTarget)} className={d3.rowList}>{milestones.map(project => <li key={project.id} className={d3.milestoneRow}><Button variant="ghost" className={d3.rowLink} title={project.title[locale]} onClick={() => navigate("project-detail-1", project.id)}><span className={d3.rowTitle}>{project.title[locale]}</span><span className={d3.identifier}>{project.identifier}</span></Button><time dateTime={project.dueDate!}>{formatProjectDate(project.dueDate, locale)}</time><Badge size="sm" tone={projectHealthBand(project.health) === "on-track" ? "success" : project.health === null ? "neutral" : "warning"}>{healthBandLabel(projectHealthBand(project.health), en)}</Badge></li>)}</ul><Button variant="ghost" className={d3.footerAction} onClick={() => navigate("project-list-1")}>{text("查看全部里程碑", "View all milestones")}<ArrowRight size={14} aria-hidden="true" /></Button></section>,
      rail: <section className={d3.card} data-pm-dashboard3="status-tracker" aria-label={text("状态追踪", "Status Tracker")}><header className={d3.cardHeader}><SectionTitle><span className={d3.titleIcon}><Monitor size={16} aria-hidden="true" />{text("状态追踪", "Status Tracker")}</span></SectionTitle><Button variant="outline" onClick={() => navigate("member-list-2")}>{text("查看全部", "See All")}</Button></header><div role="region" aria-label={text("成员状态列表", "Member status list")} tabIndex={0} ref={statusRef} onScroll={event => rememberScroll("status", event.currentTarget)} className={`${d3.rowList} ${d3.statusList}`}>{(["offline", "away", "available"] as const).map(availability => { const people = peopleDomain.people.filter(person => person.availability === availability && (state.projectId === "all" || peopleDomain.memberships.some(member => member.teamId === current?.teamId && member.memberId === person.memberId))); return people.length ? <section key={availability}><p className={d3.caption}>{availabilityLabels[availability][locale]}</p><ul className={d3.presenceList}>{people.map(person => { const member = members.find(row => row.member.id === person.memberId)?.member; return member ? <li key={person.memberId} className={d3.presenceRow}><div><PmMemberIdentity member={member} /><p className={d3.presenceDetail} title={person.ownership[locale]}>{person.ownership[locale]}</p></div><span className={d3.presenceBadge} data-availability={availability}><i aria-hidden="true" />{availabilityLabels[availability][locale]}</span></li> : null })}</ul></section> : null })}</div></section>,
      activity: <section className={d3.card} data-pm-dashboard3="recent-activity" aria-label={text("最近活动", "Recent activity")}><header className={d3.cardHeader}><SectionTitle>{text("最近活动", "Recent activity")}</SectionTitle><Button variant="ghost" size="icon" className={d3.moreAction} aria-label={text("查看组合关注事项", "View portfolio attention")} onClick={() => setDetailsOpen(true)}><MoreHorizontal size={16} aria-hidden="true" /></Button></header><ul ref={activityRef} onScroll={event => rememberScroll("activity", event.currentTarget)} className={d3.rowList}>{activity.length ? activity.map(event => { const issue = scopedIssues.find(row => row.id === event.itemId); const Icon = event.kind === "completed" ? CircleCheck : event.kind === "review" ? Clock3 : event.kind === "comment" ? Bell : FileText; return <li key={event.id} className={d3.activityRow}><span className={d3.activityIcon} data-kind={event.kind}><Icon size={16} aria-hidden="true" /></span><div><Button variant="ghost" className={d3.rowLink} title={event.title} onClick={() => navigate("issue-detail-1", event.itemId)}><span className={d3.rowTitle}>{event.title}</span><span className={d3.identifier} title={issue?.titleCopy[locale]}>{issue?.titleCopy[locale]}</span></Button></div><time dateTime={event.at} title={event.at}>{relativeTime(event.at)}</time></li> }) : <li className={d3.activityEmpty}><Activity size={20} /><p>{text("暂无本地活动", "No local activity")}</p><span>{text("当前项目没有活动记录。", "No activity is recorded for this project.")}</span></li>}</ul><Button variant="ghost" className={d3.footerAction} onClick={() => navigate("inbox-1")}>{text("查看全部活动", "View all activity")}<ArrowRight size={14} aria-hidden="true" /></Button></section>,
      distribution: null,
      issues: <section className={`${d3.detailsCard} ${d3.mobileThroughput}`} aria-label={text("交付吞吐量", "Delivery throughput")}><SectionTitle>{text("交付吞吐量", "Delivery throughput")}</SectionTitle><p className={d3.caption}>{text("按到期日分组的当前任务状态", "Current issue states grouped by due date")}</p><div className={d3.chart}><ResponsiveContainer width="100%" height={220} minWidth={1}><ComposedChart data={sprintRows} margin={{ top: 12, right: 4, bottom: 4, left: 4 }} accessibilityLayer><CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={.35} /><XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "var(--text-secondary)" }} tickMargin={12} interval={0} /><YAxis hide /><Tooltip /><Bar dataKey="scope" name={text("范围", "Scope")} fill="var(--text-secondary)" radius={[3, 3, 0, 0]} isAnimationActive={false} /><Bar dataKey="completed" name={text("已完成", "Completed")} fill="var(--foreground)" radius={[3, 3, 0, 0]} isAnimationActive={false} onClick={() => openIssues(true)} /></ComposedChart></ResponsiveContainer></div></section>,
    }} />
}
