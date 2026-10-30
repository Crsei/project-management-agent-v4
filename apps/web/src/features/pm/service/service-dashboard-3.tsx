import { useState, type ReactNode } from "react"
import type { Entity } from "@contracts"
import { Activity, ArrowRight, Clock3, FileText, Filter, FolderKanban, MoreHorizontal, RefreshCw, Zap } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CountUp } from "@/components/ui/count-up"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DataTable } from "@/components/blocks/data-table"
import { FilterCard, type FilterCondition, type FilterField } from "@/components/blocks/filter-card"
import { DashboardView } from "@/views/pm/dashboard"
import { Choice, QueryNotice, string, useText, type QueryState } from "./pm-ui"
import type { ServiceDashboardProps } from "./service-dashboard-contract"
import { usePortfolioDashboard } from "./pm-service"
import { PortfolioBudget, PortfolioHealth } from "./dashboard-portfolio"
import { PresencePanel } from "./dashboard-time"
import { SprintProgress } from "./dashboard-sprints"
import d3 from "@/views/pm/dashboard-3.module.css"
import styles from "./service-dashboard-3.module.css"

type ProjectTaskCounts = { total: number; completed: number }

const dueBucket = (value: string, today: string): string => {
  if (!value || !Number.isFinite(Date.parse(value))) return "none"
  if (value < today) return "overdue"
  return value <= new Date(Date.parse(today) + 6 * 86_400_000).toISOString().slice(0, 10) ? "week" : "later"
}
const issueFieldValues = (issue: Entity, field: string, today: string): string[] => {
  switch (field) {
    case "status": return [string(issue.data.status) || "unspecified"]
    case "priority": return [string(issue.data.priority) || "unspecified"]
    case "assignee": return [string(issue.data.assigneeId) || "unassigned"]
    case "project": return issue.projectId ? [issue.projectId] : []
    case "due": return [dueBucket(string(issue.data.dueDate), today)]
    default: return []
  }
}
const conditionMatches = (condition: FilterCondition, values: readonly string[]): boolean => {
  if (!condition.values.length) return true
  const hit = values.some(value => condition.values.includes(value))
  return condition.operator === "is" ? hit : !hit
}

function SnapshotContent({ query, children }: { query: QueryState; children?: ReactNode }) {
  const t = useText()
  return <>
    {query.isFetching && query.data && <p role="status" className={d3.caption}>{t("正在刷新；保留上次快照。", "Refreshing; previous snapshot retained.")}</p>}
    <QueryNotice query={query}>{children}</QueryNotice>
  </>
}

/** Production command center: geometry is shared with Lab, facts come only from
 * authorized queries. Completion ratios are not portfolio health or risk. */
export function ServiceDashboard3({ surface, projects, issues, milestones, members, changes, openEntity, openActivity }: ServiceDashboardProps) {
  const t = useText()
  const portfolio = usePortfolioDashboard()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [conditions, setConditions] = useState<FilterCondition[]>([])
  const today = surface.readModel.today
  const selectedId = surface.interaction.selectedProjectId
  const query = surface.interaction.query.trim().toLocaleLowerCase()
  const scopedProjects = projects.data?.filter(project => (!selectedId || project.id === selectedId) && (!query || `${project.id} ${string(project.data.name)}`.toLocaleLowerCase().includes(query)))
  const projectIds = new Set(scopedProjects?.map(project => project.id))
  const scopeKnown = !query || projects.data !== undefined
  const inScope = (projectId: string | null) => (!selectedId || projectId === selectedId) && (!query || !!projectId && projectIds.has(projectId))
  const scopedMilestones = scopeKnown ? milestones.data?.filter(milestone => inScope(milestone.projectId)) : undefined
  const current = scopedProjects?.[0]
  const activeMembers = members.data?.filter(member => !member.revokedAt)
  const filteredIssues = scopeKnown ? issues.data?.filter(issue => inScope(issue.projectId) && conditions.every(condition => conditionMatches(condition, issueFieldValues(issue, condition.field, today)))) : undefined
  const activeConditionCount = conditions.filter(condition => condition.values.length > 0).length
  const issueStatuses = [...new Set((issues.data ?? []).map(issue => string(issue.data.status) || "unspecified"))].sort()
  const issuePriorities = [...new Set((issues.data ?? []).map(issue => string(issue.data.priority) || "unspecified"))].sort()
  const filterFields: FilterField[] = [
    { id: "status", label: t("状态", "Status"), options: issueStatuses.map(value => ({ value, label: value === "unspecified" ? t("未提供状态", "State not provided") : value })) },
    { id: "priority", label: t("优先级", "Priority"), options: issuePriorities.map(value => ({ value, label: value === "unspecified" ? t("未提供优先级", "Priority not provided") : value })) },
    { id: "assignee", label: t("负责人", "Assignee"), options: [...(activeMembers ?? []).map(member => ({ value: member.userId, label: member.name })), { value: "unassigned", label: t("未分配", "Unassigned") }] },
    { id: "project", label: t("项目", "Project"), options: (projects.data ?? []).map(project => ({ value: project.id, label: string(project.data.name) || project.id })) },
    { id: "due", label: t("截止日期", "Due date"), options: [
      { value: "overdue", label: t("已逾期", "Overdue") },
      { value: "week", label: t("未来 7 天", "Next 7 days") },
      { value: "later", label: t("7 天后", "Later than 7 days") },
      { value: "none", label: t("未排期", "Unscheduled") },
    ] },
  ]
  const ownerId = current ? string(current.data.ownerId) : ""
  const owner = activeMembers?.find(member => member.userId === ownerId)
  const taskCounts = new Map<string, ProjectTaskCounts>()
  for (const issue of filteredIssues ?? []) {
    if (!issue.projectId) continue
    const counts = taskCounts.get(issue.projectId) ?? { total: 0, completed: 0 }
    counts.total += 1
    if (issue.data.status === "done") counts.completed += 1
    taskCounts.set(issue.projectId, counts)
  }
  const currentCounts = current && filteredIssues ? taskCounts.get(current.id) ?? { total: 0, completed: 0 } : null
  const scheduledMilestones = scopedMilestones?.filter(milestone => string(milestone.data.targetDate)).sort((a, b) => string(a.data.targetDate).localeCompare(string(b.data.targetDate)))
  const entityById = new Map<string, Entity>()
  for (const snapshot of [projects.data, issues.data, milestones.data]) {
    for (const entity of snapshot ?? []) entityById.set(entity.id, entity)
  }
  const scopedChanges = scopeKnown ? changes.data?.filter(event => inScope(event.projectId) || event.aggregateKind === "project" && inScope(event.aggregateId)).toSorted((a, b) => b.occurredAt.localeCompare(a.occurredAt)) : undefined
  const formatDate = (value: string, includeTime = false) => {
    if (!value || !Number.isFinite(Date.parse(value))) return value || t("未排期", "Unscheduled")
    return new Intl.DateTimeFormat(t("zh-CN", "en"), { month: "short", day: "numeric", ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : { year: "numeric", timeZone: "UTC" }) }).format(new Date(value))
  }
  const notProvided = t("未提供", "Not provided")
  const noMatches = t("当前项目筛选下无记录。", "No records match the current project filters.")
  const portfolioProjects = scopedProjects && portfolio.data ? portfolio.data.projects.filter(project => projectIds.has(project.projectId)) : undefined
  const assessed = portfolioProjects?.filter(project => project.health !== null)
  const budgets = portfolioProjects?.flatMap(project => project.budget ? [project.budget] : [])
  const currencies = new Set(budgets?.map(budget => budget.data.currency))
  const budgetTotal = budgets?.reduce((sum, budget) => sum + BigInt(budget.data.budgetMinor), 0n) ?? 0n
  const actualTotal = budgets?.reduce((sum, budget) => sum + BigInt(budget.actualMinor), 0n) ?? 0n
  const healthDetail = portfolioProjects ? t("已评估 / 范围内项目", "Assessed / projects in scope") : portfolio.error ? t("读取失败", "Read failed") : t("读取中", "Loading")
  const burn = !portfolioProjects || !budgets?.length || currencies.size === 1 && budgetTotal === 0n ? "—" : currencies.size > 1 ? `${currencies.size} ${t("币种", "currencies")}` : `${Number(actualTotal * 1000n / budgetTotal) / 10}%`
  const summary = [
    { label: t("组合健康度", "Portfolio Health"), value: portfolioProjects ? `${assessed?.length ?? 0} / ${portfolioProjects.length}` : "—", detail: healthDetail },
    { label: t("项目", "Projects"), value: scopedProjects?.length ?? "—", detail: t("授权项目", "Authorized projects") },
    { label: t("正常", "On Track"), value: assessed?.filter(project => project.health?.data.status === "on_track").length ?? "—", detail: t("显式健康评估", "Recorded health assessment") },
    { label: t("有风险", "At Risk"), value: assessed?.filter(project => project.health?.data.status === "at_risk").length ?? "—", detail: t("显式健康评估", "Recorded health assessment") },
    { label: t("偏离计划", "Off Track"), value: assessed?.filter(project => project.health?.data.status === "off_track").length ?? "—", detail: t("显式健康评估", "Recorded health assessment") },
    { label: t("预算消耗", "Budget Burn"), value: burn, detail: currencies.size > 1 ? t("按币种分别查看", "View each currency separately") : budgets?.length ? t("实际支出 / 已记录预算", "Actual spend / recorded budget") : t("尚无预算快照", "No budget snapshot") },
  ]
  const details = <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
    <DialogContent className={d3.dialog}>
      <DialogTitle>{t("授权服务明细", "Authorized service details")}</DialogTitle>
      <DialogDescription>{t("仅展示当前服务快照；任务完成率不是健康度或风险评估。缺失信息不计为零。", "Current service snapshots only. Task completion is not a health or risk assessment. Missing facts are never counted as zero.")}</DialogDescription>
      <div className={d3.dialogTools}>
        <Choice label={t("项目范围", "Project scope")} value={selectedId ?? "all"} disabled={!projects.data?.length} options={[{ value: "all", label: t("所有授权项目", "All authorized projects") }, ...(projects.data ?? []).map(project => ({ value: project.id, label: string(project.data.name) || project.id }))]} onChange={value => surface.actions.setInteraction(previous => ({ ...previous, selectedProjectId: value === "all" ? null : value }))} />
      </div>
      <section className={d3.detailsCard}>
        <h2>{t("项目与实际任务完成数", "Projects & actual completed tasks")}</h2>
        <SnapshotContent query={projects}>
          <DataTable rows={scopedProjects ?? []} getRowId={project => project.id} getRowLabel={project => string(project.data.name) || project.id} onActivateRow={project => openEntity(project.id)} caption={t("当前项目筛选下的授权服务快照", "Authorized service snapshots under the current project filters")} columns={[
            { id: "project", header: t("项目", "Project"), primary: true, cell: project => <Button variant="ghost" className={d3.rowLink} onClick={() => openEntity(project.id)}><span className={d3.rowTitle}>{string(project.data.name) || project.id}</span><span className={d3.identifier}>{project.id}</span></Button> },
            { id: "status", header: t("记录状态", "Recorded status"), cell: project => string(project.data.status) || notProvided },
            { id: "owner", header: t("负责人", "Owner"), cell: project => { const id = string(project.data.ownerId); return activeMembers?.find(member => member.userId === id)?.name || id || t("未记录", "Not recorded") } },
            { id: "tasks", header: t("已完成 / 总任务", "Done / total tasks"), cell: project => filteredIssues ? `${taskCounts.get(project.id)?.completed ?? 0} / ${taskCounts.get(project.id)?.total ?? 0}` : "—" },
          ]} />
        </SnapshotContent>
        <SnapshotContent query={issues} />
      </section>
      <section className={d3.detailsCard}>
        <h2>{t("任务明细", "Issue details")}</h2>
        <SnapshotContent query={issues}>
          {!scopeKnown ? <SnapshotContent query={projects} /> : <DataTable rows={filteredIssues ?? []} getRowId={issue => issue.id} getRowLabel={issue => string(issue.data.title) || issue.id} onActivateRow={issue => openEntity(issue.id)} caption={t("当前筛选条件下的授权任务快照", "Authorized issue snapshots under the current filter conditions")} data={{ state: filteredIssues?.length ? "success" : "empty", emptyTitle: t("无匹配任务", "No matching issues"), emptyDescription: t("调整或清除筛选条件。", "Adjust or clear the filter conditions.") }} columns={[
            { id: "issue", header: t("任务", "Issue"), primary: true, cell: issue => <Button variant="ghost" className={d3.rowLink} onClick={() => openEntity(issue.id)}><span className={d3.rowTitle}>{string(issue.data.title) || issue.id}</span><span className={d3.identifier}>{issue.id}</span></Button> },
            { id: "project", header: t("项目", "Project"), cell: issue => issue.projectId ? string(entityById.get(issue.projectId)?.data.name) || issue.projectId : notProvided },
            { id: "status", header: t("状态", "Status"), cell: issue => string(issue.data.status) || notProvided },
            { id: "priority", header: t("优先级", "Priority"), cell: issue => string(issue.data.priority) || notProvided },
            { id: "assignee", header: t("负责人", "Assignee"), cell: issue => { const id = string(issue.data.assigneeId); return id ? activeMembers?.find(member => member.userId === id)?.name || id : t("未分配", "Unassigned") } },
            { id: "due", header: t("截止日期", "Due date"), cell: issue => formatDate(string(issue.data.dueDate)) },
          ]} />}
        </SnapshotContent>
      </section>
      <section className={d3.detailsCard}>
        <h2>{t("里程碑目标日期", "Milestone target dates")}</h2>
        <SnapshotContent query={milestones}>
          <DataTable rows={scopedMilestones ?? []} getRowId={milestone => milestone.id} getRowLabel={milestone => string(milestone.data.title) || milestone.id} onActivateRow={milestone => openEntity(milestone.id)} caption={t("服务里程碑记录；无日期显示为未排期", "Service milestone records; missing dates are unscheduled")} columns={[
            { id: "milestone", header: t("里程碑", "Milestone"), primary: true, cell: milestone => <Button variant="ghost" className={d3.rowLink} onClick={() => openEntity(milestone.id)}><span className={d3.rowTitle}>{string(milestone.data.title) || milestone.id}</span><span className={d3.identifier}>{milestone.id}</span></Button> },
            { id: "target", header: t("目标日期", "Target date"), cell: milestone => formatDate(string(milestone.data.targetDate)) },
            { id: "status", header: t("记录状态", "Recorded status"), cell: milestone => string(milestone.data.status) || notProvided },
          ]} />
        </SnapshotContent>
      </section>
    </DialogContent>
  </Dialog>

  return <DashboardView {...surface}
    variant="dashboard3"
    headerActions={<div className={d3.pageActions}>
      <span className={d3.snapshot}><Clock3 size={14} aria-hidden="true" />{t("服务快照", "Service snapshot")}</span>
      <Popover><PopoverTrigger render={<Button variant="outline" size="sm" />}><Filter size={14} aria-hidden="true" />{t("筛选", "Filter")}{activeConditionCount > 0 && <Badge size="sm" tone="neutral">{activeConditionCount}</Badge>}</PopoverTrigger><PopoverContent className={`${styles.filterPanel} p-0`} align="end" aria-label={t("任务筛选", "Issue filters")}>
        <FilterCard title={t("任务筛选", "Issue filters")} fields={filterFields} conditions={conditions} onChange={setConditions} emptyHint={t("添加条件以筛选任务。", "Add a condition to filter issues.")} addLabel={t("添加条件", "Add")} clearLabel={t("清除全部", "Clear")} whereLabel={t("其中", "Where")} andLabel={t("并且", "and")} anyLabel={t("任意", "Any")} removeLabel={t("移除条件", "Remove filter")} />
      </PopoverContent></Popover>
      <Button variant="ghost" size="icon" className={d3.refresh} disabled={surface.readModel.data.refreshing} aria-label={t("刷新仪表盘", "Refresh dashboard")} onClick={surface.actions.refresh}><RefreshCw size={16} aria-hidden="true" /></Button>
    </div>}
    toolbar={null}
    feedback={<>{surface.feedback}<QueryNotice query={{ ...portfolio, data: portfolio.data?.projects }} /></>}
    createDialog={<>{surface.createDialog}{details}</>}
    regions={{
      metrics: <section aria-label={t("组合概览", "Portfolio overview")} className={d3.summaryStrip} data-pm-dashboard3="portfolio-header">
        {summary.map(stat => <button type="button" className={d3.stat} key={stat.label} onClick={() => setDetailsOpen(true)} aria-label={`${stat.label}: ${stat.value} · ${stat.detail}`}><p>{stat.label}</p><strong><CountUp value={typeof stat.value === "number" ? stat.value : null} fallback={String(stat.value)} /></strong><span>{stat.detail}</span></button>)}
      </section>,
      timeline: <section className={d3.card} data-pm-dashboard3="trends" aria-label={t("迭代进度", "Sprint progress")}><div className={styles.queryContent}><SprintProgress projectId={selectedId ?? undefined} /></div></section>,
      cards: <section className={d3.card} data-pm-dashboard3="budget-burn" aria-label={t("预算消耗", "Budget Burn")}><div className={styles.queryContent}><PortfolioBudget projects={scopedProjects} projectId={selectedId ?? undefined} /></div></section>,
      currentProject: <section className={d3.card} data-pm-dashboard3="current-project" aria-label={t("当前项目", "Current Project")}>
        <header className={d3.cardHeader}><h2><span className={d3.titleIcon}><Zap size={16} aria-hidden="true" />{t("当前项目", "Current Project")}</span></h2><Button variant="outline" onClick={() => setDetailsOpen(true)}>{t("查看全部", "See All")}</Button></header>
        <div className={styles.queryContent}><SnapshotContent query={projects}>
          {current ? <div className={d3.projectBody}>
            <p className={d3.caption}>{t("项目名称", "Project Name")}</p>
            <div className={d3.projectHeader}><Button variant="ghost" className={d3.projectLink} aria-label={`${t("打开项目", "Open project")} ${string(current.data.name) || current.id}`} title={string(current.data.name) || current.id} onClick={() => openEntity(current.id)}><FolderKanban size={18} aria-hidden="true" /><span className={d3.rowTitle}>{string(current.data.name) || current.id}</span></Button><Badge size="sm" tone="neutral">{string(current.data.status) || notProvided}</Badge></div>
            <div className={d3.projectFields}>
              <div><p className={d3.caption}>{t("项目负责人", "Project Owner")}</p><span className={styles.identity}>{owner && <Avatar name={owner.name} size={24} />}<span title={owner?.name || ownerId}>{owner?.name || ownerId || t("未记录", "Not recorded")}</span></span></div>
              <div><p className={d3.caption}>{t("已完成 / 总任务", "Done / total tasks")}</p><span>{currentCounts ? `${currentCounts.completed} / ${currentCounts.total}` : "—"}</span></div>
            </div>
            <p className={d3.caption}>{t("当前项目任务", "Current project tasks")}</p><Button variant="ghost" className={styles.issueAction} onClick={() => surface.actions.openIssues({ projectId: current.id })}>{t("打开任务工作区", "Open issue workspace")}<ArrowRight size={14} aria-hidden="true" /></Button>
          </div> : !!projects.data?.length && <p className={d3.caption}>{noMatches}</p>}
        </SnapshotContent>{current && <><SnapshotContent query={issues} /><SnapshotContent query={members} /><PortfolioHealth projects={scopedProjects} projectId={current.id} /></>}</div>
      </section>,
      projects: <section className={d3.card} data-pm-dashboard3="milestones" aria-label={t("里程碑日期", "Milestone dates")}>
        <header className={d3.cardHeader}><h2>{t("里程碑日期", "Milestone dates")}</h2></header>
        <div className={d3.rowList}><SnapshotContent query={milestones}>
          {!scopeKnown ? <SnapshotContent query={projects} /> : <>
            <ul data-pm-stagger className={styles.plainList}>{scheduledMilestones?.map(milestone => <li key={milestone.id} className={d3.milestoneRow}><Button variant="ghost" className={d3.rowLink} title={string(milestone.data.title) || milestone.id} onClick={() => openEntity(milestone.id)}><span className={d3.rowTitle}>{string(milestone.data.title) || milestone.id}</span><span className={d3.identifier}>{milestone.id}</span></Button><time dateTime={string(milestone.data.targetDate)}>{formatDate(string(milestone.data.targetDate))}</time><Badge size="sm" tone="neutral">{string(milestone.data.status) || notProvided}</Badge></li>)}</ul>
            {!!milestones.data?.length && !scheduledMilestones?.length && <p className={d3.caption}>{scopedMilestones?.length ? t("当前范围内的里程碑尚未记录目标日期。", "Milestones in this scope have no recorded target dates.") : noMatches}</p>}
            {!!scopedMilestones?.some(milestone => !string(milestone.data.targetDate)) && <p className={d3.caption}>{t("未排期里程碑可在全部明细中查看。", "Unscheduled milestones are available in all details.")}</p>}
          </>}
        </SnapshotContent></div>
        <Button variant="ghost" className={d3.footerAction} onClick={() => setDetailsOpen(true)}>{t("查看全部里程碑", "View all milestones")}<ArrowRight size={14} aria-hidden="true" /></Button>
      </section>,
      rail: <section className={d3.card} data-pm-dashboard3="status-tracker" aria-label={t("成员状态", "Member status")}><div className={styles.queryContent}><PresencePanel /></div><Button variant="ghost" className={d3.footerAction} onClick={surface.actions.openPeople}>{t("查看全部成员", "See all members")}<ArrowRight size={14} aria-hidden="true" /></Button></section>,
      activity: <section className={d3.card} data-pm-dashboard3="recent-activity" aria-label={t("最近活动", "Recent activity")}>
        <header className={d3.cardHeader}><h2>{t("最近活动", "Recent activity")}</h2><Button variant="ghost" size="icon" className={d3.moreAction} aria-label={t("查看服务明细与能力边界", "View service details and capability boundaries")} onClick={() => setDetailsOpen(true)}><MoreHorizontal size={16} aria-hidden="true" /></Button></header>
        <div className={d3.rowList}>
          {changes.historyTruncated && <p className={d3.caption}>{t("旧事件已超出保留期；并非完整审计历史。", "Older events are outside retention; this is not a complete audit history.")}</p>}
          <SnapshotContent query={changes}>
            {!scopeKnown ? <SnapshotContent query={projects} /> : <ul data-pm-stagger className={styles.plainList}>{scopedChanges?.map(event => { const entity = entityById.get(event.aggregateId); const title = entity ? string(entity.data.name) || string(entity.data.title) || entity.id : event.aggregateId; return <li key={event.eventId} className={d3.activityRow}><span className={d3.activityIcon}><FileText size={16} aria-hidden="true" /></span><div>{entity ? <Button variant="ghost" className={d3.rowLink} title={`${event.eventType} · ${title}`} onClick={() => openEntity(entity.id)}><span className={d3.rowTitle}>{event.eventType}</span><span className={d3.identifier}>{title}</span></Button> : <div className={d3.rowLink}><span className={d3.rowTitle} title={event.eventType}>{event.eventType}</span><span className={d3.identifier} title={`${event.aggregateKind} · ${event.aggregateId} · v${event.aggregateVersion}`}>{event.aggregateKind} · {event.aggregateId} · v{event.aggregateVersion}</span></div>}</div><time dateTime={event.occurredAt} title={event.occurredAt}>{formatDate(event.occurredAt, true)}</time></li> })}{!!changes.data?.length && !scopedChanges?.length && <li className={d3.activityEmpty}><Activity size={20} aria-hidden="true" /><p>{noMatches}</p></li>}</ul>}
          </SnapshotContent>
        </div>
        <Button variant="ghost" className={d3.footerAction} onClick={openActivity}>{t("查看全部活动", "View all activity")}<ArrowRight size={14} aria-hidden="true" /></Button>
      </section>,
      distribution: null,
      issues: null,
    }} />
}
