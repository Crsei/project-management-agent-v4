import { useRef, useState, type CSSProperties } from "react"
import type { Entity } from "@contracts"
import { Activity, ArrowRight, CalendarDays, ChevronLeft, ChevronRight, Clock3, Flag, ListPlus, MoreHorizontal, Plus, RefreshCw, SlidersHorizontal, Zap } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CountUp } from "@/components/ui/count-up"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs"
import { TimelineRow } from "@/components/blocks/timeline"
import { FilterCard, type FilterCondition, type FilterField } from "@/components/blocks/filter-card"
import { addScheduleDays, addScheduleMonths, isScheduleDate, scheduleDateError, scheduleDayDifference } from "@/lib/schedule-date-utils"
import { useI18n } from "@/lib/i18n-provider"
import { DashboardView } from "@/views/pm/dashboard"
import { DashboardNavigation } from "@/views/pm/dashboard-navigation"
import d2 from "@/views/pm/dashboard-2.module.css"
import { QueryNotice, string, type QueryState } from "./pm-ui"
import type { ServiceDashboardProps } from "./service-dashboard-contract"
import { NotesPanel } from "./dashboard-personal"
import { PresencePanel } from "./dashboard-time"
import { SprintPlanner } from "./dashboard-sprints"
import styles from "./service-dashboard-2.module.css"
import { RadixSelect } from "@/components/ui/radix-select"

type IssueMode = "scheduled" | "undated" | "all"
type ScheduledIssue = { entity: Entity; start: string; end: string }

const dateValue = (value: unknown): string | null => isScheduleDate(value) ? value : null
const shortId = (id: string): string => id.length > 16 ? `${id.slice(0, 8)}…` : id
const timelineStates: Record<string, string> = { todo: "backlog", in_progress: "progress", review: "review", in_review: "review", draft: "backlog" }
const timelineState = (status: string): string => timelineStates[status] ?? status

function SnapshotNotice({ query }: { query: QueryState }) {
  const en = useI18n().locale === "en"
  return <div className={styles.queryNotice}>
    <QueryNotice query={query} />
    {query.isFetching && query.data && <p role="status">{en ? "Refreshing; previous snapshot retained." : "正在刷新；保留上次快照。"}</p>}
    {!query.data && !query.isPending && !query.error && <p>{en ? "No authorized snapshot is available." : "授权快照不可用。"}</p>}
  </div>
}

/** Production overview: reference geometry with authorized service snapshots only. */
export function ServiceDashboard2({ surface, projects, issues, milestones, members, changes, openEntity, openActivity }: ServiceDashboardProps) {
  const { locale } = useI18n()
  const en = locale === "en"
  const text = (zh: string, english: string): string => en ? english : zh
  const statusLabels: Record<string, string> = {
    todo: text("待办", "To do"), in_progress: text("进行中", "In Progress"), review: text("审核中", "In Review"),
    done: text("已完成", "Completed"), canceled: text("已取消", "Canceled"),
    planned: text("已规划", "Planned"), active: text("活跃", "Active"), completed: text("已完成", "Completed"),
    on_hold: text("已暂停", "On hold"), achieved: text("已达成", "Achieved"),
    draft: text("草稿", "Draft"), ready: text("待开始", "Ready"), in_review: text("审核中", "In Review"),
    cancelled: text("已取消", "Cancelled"),
  }
  const statusLabel = (id: string): string => statusLabels[id] ?? (id || text("状态未提供", "Status not provided"))
  const statusCategoryOf = (entity: Entity) => {
    const status = string(entity.data.status)
    return status === "done" ? "completed" : status === "canceled" || status === "cancelled" ? "canceled" : "started"
  }
  const priorityLabels: Record<string, string> = { low: text("低", "Low"), normal: text("普通", "Normal"), high: text("高", "High"), urgent: text("紧急", "Urgent") }
  const colors: Record<string, string> = { todo: "#a1a1aa", in_progress: "#eab308", review: "#d946ef", done: "#10b981", canceled: "#71717a", planned: "#06c6df", active: "#0891a2", completed: "#10b981", on_hold: "#b86a00" }
  const [windowDays, setWindowDays] = useState(14)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [allProjects, setAllProjects] = useState(false)
  const [allTimeline, setAllTimeline] = useState(false)
  const [chartMonths, setChartMonths] = useState(6)
  const [milestoneMonth, setMilestoneMonth] = useState<string | null>(null)
  const [issuesExpanded, setIssuesExpanded] = useState(false)
  const [issueMode, setIssueMode] = useState<IssueMode>("scheduled")
  const [filters, setFilters] = useState<FilterCondition[]>([])
  const [issueQuery, setIssueQuery] = useState("")
  const issueDetailsRef = useRef<HTMLDetailsElement>(null)
  const projectSectionRef = useRef<HTMLElement>(null)
  const milestoneSectionRef = useRef<HTMLElement>(null)
  const { selectedProjectId, query } = surface.interaction
  const projectQuery = query.trim().toLocaleLowerCase(locale)
  const missingScope = !!selectedProjectId && !!projects.data && !projects.data.some(project => project.id === selectedProjectId)
  const scopedProjects = projects.data?.filter(project => (!selectedProjectId || project.id === selectedProjectId) && (!projectQuery || `${project.id} ${string(project.data.name)} ${string(project.data.goal)}`.toLocaleLowerCase(locale).includes(projectQuery)))
  const projectIds = new Set(scopedProjects?.map(project => project.id))
  const scopeKnown = !missingScope && (!projectQuery || !!projects.data)
  const scopedIssues = scopeKnown ? issues.data?.filter(issue => (!selectedProjectId || issue.projectId === selectedProjectId) && (!projectQuery || !!issue.projectId && projectIds.has(issue.projectId))) : undefined
  const scopedMilestones = scopeKnown ? milestones.data?.filter(milestone => (!selectedProjectId || milestone.projectId === selectedProjectId) && (!projectQuery || !!milestone.projectId && projectIds.has(milestone.projectId))) : undefined
  const today = surface.readModel.today
  const center = anchor ?? today
  const rangeStart = addScheduleDays(center, -Math.floor(windowDays / 2))
  const rangeEnd = addScheduleDays(rangeStart, windowDays - 1)
  const scheduled = scopedIssues?.filter(issue => {
    const due = dateValue(issue.data.dueDate)
    return due !== null && due >= rangeStart && due <= rangeEnd
  })
  const undated = scopedIssues?.filter(issue => !dateValue(issue.data.dueDate))
  const timelineIssues: ScheduledIssue[] = (scopedIssues ?? []).flatMap(entity => {
    const startDate = string(entity.data.startDate) || null
    const dueDate = string(entity.data.dueDate) || null
    const category = statusCategoryOf(entity)
    if (scheduleDateError({ startDate, dueDate }) || (!startDate && !dueDate) || category === "completed" || category === "canceled") return []
    const start = startDate ?? dueDate!
    const end = dueDate ?? startDate!
    return start <= rangeEnd && end >= rangeStart ? [{ entity, start, end }] : []
  }).sort((a, b) => a.start.localeCompare(b.start) || a.entity.id.localeCompare(b.entity.id))
  const visibleTimeline = allTimeline ? timelineIssues : timelineIssues.slice(0, 4)
  const invalidScheduleCount = scopedIssues?.filter(entity => scheduleDateError({ startDate: string(entity.data.startDate) || null, dueDate: string(entity.data.dueDate) || null })).length ?? 0
  const observedStatuses = [...new Set((scopedIssues ?? []).map(issue => string(issue.data.status)).filter(Boolean))]
  const statusIds = observedStatuses.length ? observedStatuses : ["draft", "ready", "in_progress", "in_review", "done", "cancelled"]
  const statusCounts = new Map(statusIds.map(id => [id, scheduled?.filter(issue => string(issue.data.status) === id).length ?? null]))
  const people = members.data?.filter(member => !member.revokedAt)
  const knownMembers = new Map(people?.map(member => [member.userId, member]))
  const shortDate = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" })
  const longDate = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
  const formatDate = (date: string): string => shortDate.format(new Date(`${date}T12:00:00Z`))
  const monthStart = `${center.slice(0, 7)}-01`
  const monthBuckets = Array.from({ length: chartMonths }, (_, index) => {
    const first = addScheduleMonths(monthStart, index)
    const id = first.slice(0, 7)
    const items = scopedMilestones?.filter(milestone => dateValue(milestone.data.targetDate)?.startsWith(id)) ?? []
    return { id, label: new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(new Date(`${first}T12:00:00Z`)), items, planned: items.filter(item => item.data.status === "planned").length, achieved: items.filter(item => item.data.status === "achieved").length }
  })
  const milestoneMaximum = Math.max(1, ...monthBuckets.flatMap(bucket => [bucket.planned, bucket.achieved]))
  const selectedBucket = monthBuckets.find(bucket => bucket.id === milestoneMonth)
  const milestoneOtherCount = scopedMilestones?.filter(item => !["planned", "achieved"].includes(string(item.data.status)) && dateValue(item.data.targetDate) !== null && string(item.data.targetDate) >= monthStart && string(item.data.targetDate) < addScheduleMonths(monthStart, chartMonths)).length ?? 0
  const undatedMilestones = scopedMilestones?.filter(item => !dateValue(item.data.targetDate)) ?? []
  const entities = new Map([...(projects.data ?? []), ...(issues.data ?? []), ...(milestones.data ?? [])].map(entity => [entity.id, entity]))
  const activity = changes.data?.filter(event => (!selectedProjectId || event.projectId === selectedProjectId || event.aggregateId === selectedProjectId) && (!projectQuery || !!event.projectId && projectIds.has(event.projectId) || projectIds.has(event.aggregateId))).slice().sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 3)
  const daysUntil = addScheduleDays(today, 7)
  const issueFilterValue = (entity: Entity, field: string): string => {
    if (field === "status") return string(entity.data.status)
    if (field === "priority") return string(entity.data.priority)
    if (field === "assignee") return string(entity.data.assigneeId) || "unassigned"
    if (field === "project") return entity.projectId ?? "none"
    if (field === "due") {
      const due = string(entity.data.dueDate)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return "none"
      if (due < today) return "overdue"
      if (due === today) return "today"
      return due <= daysUntil ? "week" : "later"
    }
    return ""
  }
  const matchesIssueFilter = (entity: Entity, condition: FilterCondition): boolean => {
    if (!condition.values.length) return true
    const hit = condition.values.includes(issueFilterValue(entity, condition.field))
    return condition.operator === "isNot" ? !hit : hit
  }
  const activeStatuses = filters.filter(condition => condition.field === "status" && condition.operator === "is").flatMap(condition => condition.values)
  const activeFilters = filters.filter(condition => condition.values.length).length
  const issueAssigneeIds = [...new Set((scopedIssues ?? []).map(issue => string(issue.data.assigneeId)).filter(Boolean))]
  const assigneeOptions = [...new Set([...knownMembers.keys(), ...issueAssigneeIds])].map(id => ({ value: id, label: knownMembers.get(id)?.name ?? id }))
  const priorityIds = [...new Set([...Object.keys(priorityLabels), ...(scopedIssues ?? []).map(issue => string(issue.data.priority))])].filter(Boolean)
  const projectOptions = (scopedProjects ?? []).map(project => ({ value: project.id, label: string(project.data.name) || project.id }))
  const filterFields: FilterField[] = [
    { id: "status", label: text("状态", "Status"), options: statusIds.filter(Boolean).map(id => ({ value: id, label: statusLabel(id) })) },
    { id: "priority", label: text("优先级", "Priority"), options: priorityIds.map(id => ({ value: id, label: priorityLabels[id] ?? id })) },
    ...(assigneeOptions.length ? [{ id: "assignee", label: text("负责人", "Assignee"), options: [{ value: "unassigned", label: text("未分配", "Unassigned") }, ...assigneeOptions] }] : []),
    ...(projectOptions.length ? [{ id: "project", label: text("项目", "Project"), options: [...projectOptions, { value: "none", label: text("未关联项目", "No project") }] }] : []),
    { id: "due", label: text("截止日期", "Due date"), options: [
      { value: "overdue", label: text("已逾期", "Overdue") },
      { value: "today", label: text("今天到期", "Due today") },
      { value: "week", label: text("未来 7 天", "Next 7 days") },
      { value: "later", label: text("更晚", "Later") },
      { value: "none", label: text("无到期日", "No due date") },
    ] },
  ]
  const issueRows = (issueMode === "scheduled" ? scheduled : issueMode === "undated" ? undated : scopedIssues)?.filter(issue => filters.every(condition => matchesIssueFilter(issue, condition)) && (!issueQuery.trim() || `${issue.id} ${string(issue.data.title)}`.toLocaleLowerCase(locale).includes(issueQuery.trim().toLocaleLowerCase(locale))))
  const drilldown = (status: string, mode: IssueMode = "scheduled"): void => {
    setIssueMode(mode)
    setFilters(previous => [...previous.filter(condition => condition.field !== "status"), ...(status === "all" ? [] : [{ field: "status", operator: "is" as const, values: [status] }])])
    setIssuesExpanded(true)
    requestAnimationFrame(() => issueDetailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }))
  }
  const focusProject = (id: string): void => surface.actions.setInteraction(previous => ({ ...previous, selectedProjectId: id || null }))
  const stats = [
    { id: "projects", label: text("项目总数", "Total Projects"), value: scopedProjects?.length ?? null, hint: text("当前项目范围", "Projects in scope"), apply: () => { setAllProjects(true); projectSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }) } },
    { id: "issues", label: text("任务总数", "Total Task"), value: scheduled?.length ?? null, hint: text("窗口内到期", "Due in window"), apply: () => drilldown("all") },
    { id: "progress", label: text("进行中", "In Progress"), value: statusCounts.get("in_progress") ?? null, hint: text("窗口内任务", "Tasks in window"), apply: () => drilldown("in_progress") },
    { id: "completed", label: text("已完成", "Completed"), value: statusCounts.get("done") ?? null, hint: text("窗口内任务", "Tasks in window"), apply: () => drilldown("done") },
  ]
  const refresh = surface.actions.refresh
  const fetching = projects.isFetching || issues.isFetching || milestones.isFetching || members.isFetching || changes.isFetching

  return <DashboardView {...surface}
    variant="dashboard2"
    navigation={<DashboardNavigation query={query} onQueryChange={value => surface.actions.setInteraction(previous => ({ ...previous, query: value }))} onPeople={surface.actions.openPeople} onActivity={openActivity} members={people?.map(member => ({ id: member.userId, name: member.name }))} />}
    readModel={{ ...surface.readModel, description: "" }}
    toolbar={null}
    headerActions={<div className={d2.headerActions}>
      <Popover>
        <PopoverTrigger render={<Button variant="ghost" size="icon" className={d2.scopeTrigger} aria-label={text("筛选项目范围", "Filter project scope")} />}><MoreHorizontal size={16} aria-hidden="true" /></PopoverTrigger>
        <PopoverContent align="end" className={d2.scopeMenu}>
          <label className={styles.selectField}><span>{text("项目范围", "Project scope")}</span><RadixSelect value={selectedProjectId ?? ""} onChange={event => focusProject(event.target.value)} disabled={!projects.data}><option value="">{text("所有授权项目", "All authorized projects")}</option>{missingScope && <option value={selectedProjectId!}>{text("项目不可用", "Unavailable project")}</option>}{projects.data?.map(project => <option key={project.id} value={project.id}>{string(project.data.name) || project.id}</option>)}</RadixSelect></label>
        </PopoverContent>
      </Popover>
      <span className={d2.snapshot}><Clock3 size={14} aria-hidden="true" />{fetching ? text("正在读取", "Refreshing") : text("服务快照", "Service snapshot")}</span>
      <Button variant="ghost" size="icon" disabled={fetching} aria-label={text("刷新服务快照", "Refresh service snapshots")} onClick={refresh}><RefreshCw aria-hidden="true" /></Button>
    </div>}
    feedback={<>{surface.feedback}{missingScope && <p role="alert" className={d2.missingScope}>{text("所选项目不可用；排期与任务总数未知。", "The selected project is unavailable; its schedule and issue totals are unknown.")}<Button variant="outline" onClick={() => focusProject("")}>{text("查看所有项目", "View all projects")}</Button></p>}</>}
    regions={{
      metrics: <>
        <nav className={d2.quickActions} aria-label={text("项目管理快捷入口", "Project management shortcuts")}>
          <Button variant="outline" disabled={!surface.capabilities.createIssue} title={text("打开任务创建工作流；此按钮不提交写入", "Open the issue creation workflow; this button does not submit a write")} onClick={event => surface.actions.createIssue(event.currentTarget)}><span className={d2.actionIcon}><ListPlus aria-hidden="true" /></span>{text("创建任务", "Create issue")}</Button>
          <Button variant="outline" onClick={() => milestoneSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}><span className={d2.actionIcon}><Flag aria-hidden="true" /></span>{text("查看里程碑", "View milestones")}</Button>
          <SprintPlanner projects={scopedProjects} projectId={selectedProjectId ?? undefined} />
          <Button variant="outline" disabled={!surface.capabilities.createProject} title={text("打开项目创建工作流；此按钮不提交写入", "Open the project creation workflow; this button does not submit a write")} onClick={event => surface.actions.createProject(event.currentTarget)}><span className={d2.actionIcon}><Plus aria-hidden="true" /></span>{text("添加项目", "Add project")}</Button>
        </nav>
        <section aria-label={text("窗口指标", "Window metrics")} className={d2.stats} data-pm-dashboard2="kpi-row">{stats.map(stat => <button key={stat.id} type="button" className={d2.statCard} onClick={stat.apply} disabled={stat.value === null}><span className={d2.statLabel}>{stat.label}<MoreHorizontal size={16} aria-hidden="true" /></span><strong><CountUp value={missingScope ? null : stat.value} /></strong><span className={d2.caption}>{stat.hint}</span></button>)}</section>
      </>,
      timeline: <section className={`${d2.panel} ${d2.schedule}`} aria-label={text("时间任务地图", "Time-Based Issue Map")} data-pm-dashboard2="schedule">
        <header className={d2.panelHeader}>
          <div><h2>{text("时间任务地图", "Time-Based Issue Map")}</h2><p className={d2.caption}>{text("来自真实任务日期的活跃排期 · UTC", "Active schedules from actual issue dates · UTC")}</p></div>
          <Tabs value={windowDays} onValueChange={value => setWindowDays(Number(value))}>
            <TabsList className={d2.rangeTabs} aria-label={text("时间窗口", "Issue map range")}>
              {[{ days: 14, label: text("周", "Week") }, { days: 28, label: text("月", "Month") }, { days: 84, label: text("季度", "Quarter") }].map(preset => <TabsTab key={preset.days} value={preset.days}>{preset.label}</TabsTab>)}
            </TabsList>
          </Tabs>
        </header>
        <SnapshotNotice query={issues} />
        <div className={`${d2.timeline} ${styles.timeline}`} data-today-visible={today >= rangeStart && today <= rangeEnd || undefined} style={{ "--today-ratio": scheduleDayDifference(today, rangeStart) / windowDays } as CSSProperties}>
          <div className={d2.timelineAxis}><time dateTime={rangeStart}>{formatDate(rangeStart)}</time><span>{today >= rangeStart && today <= rangeEnd ? text("今日", "Today") : center}</span><time dateTime={rangeEnd}>{formatDate(rangeEnd)}</time></div>
          {scopedIssues && (visibleTimeline.length ? visibleTimeline.map(({ entity, start, end }) => {
            const from = start < rangeStart ? rangeStart : start
            const to = end > rangeEnd ? rangeEnd : end
            const status = string(entity.data.status)
            const assignee = knownMembers.get(string(entity.data.assigneeId))
            return <TimelineRow key={entity.id} id={entity.id} sidebar={<span className={d2.timelineLabel}><span title={entity.id}>{shortId(entity.id)}</span><span>{statusLabel(status)}</span></span>}><button type="button" className={d2.timelineBar} data-issue-state={timelineState(status)} style={{ left: `${scheduleDayDifference(from, rangeStart) / windowDays * 100}%`, width: `${Math.max(1, scheduleDayDifference(to, from) + 1) / windowDays * 100}%` }} aria-label={`${entity.id}: ${string(entity.data.title)} · ${statusLabel(status)} · ${start} → ${end}`} title={`${entity.id} · ${string(entity.data.title)}\n${statusLabel(status)} · ${start} → ${end}`} onClick={() => openEntity(entity.id)}><span className={d2.timelineAvatars}>{assignee && <Avatar name={assignee.name} size={24} />}</span><span className={d2.timelineBarCopy}><strong>{shortId(entity.id)} · {string(entity.data.title)}</strong><small>{statusLabel(status)} · {formatDate(start)} – {formatDate(end)}</small></span></button></TimelineRow>
          }) : <p className={d2.scheduleEmpty}>{text("此窗口没有已排期的未完成任务；未提供到期日的任务仍可在明细中查看。", "No scheduled open issues in this window. Issues without due dates remain available in the details.")}</p>)}
          {!scopedIssues && <p className={d2.scheduleEmpty}>{text("排期数据未知；等待授权任务与项目快照。", "Schedule unknown; an authorized issue and project snapshot is required.")}</p>}
        </div>
        <Popover><PopoverTrigger render={<Button variant="ghost" size="icon" className={d2.scheduleOptions} aria-label={text("排期选项", "Schedule options")} />}><MoreHorizontal size={16} aria-hidden="true" /></PopoverTrigger><PopoverContent align="end" className={d2.scheduleMenu}>
          <label className={styles.selectField}><span>{text("窗口中心日期", "Window center date")}</span><Input type="date" value={center} onChange={event => { if (isScheduleDate(event.target.value)) setAnchor(event.target.value) }} /></label>
          <div className={styles.dateActions}><Button variant="outline" size="icon" aria-label={text("上一时间窗口", "Previous date window")} onClick={() => setAnchor(addScheduleDays(center, -windowDays))}><ChevronLeft size={14} /></Button><Button variant="outline" size="sm" onClick={() => setAnchor(null)}>{text("今日", "Today")}</Button><Button variant="outline" size="icon" aria-label={text("下一时间窗口", "Next date window")} onClick={() => setAnchor(addScheduleDays(center, windowDays))}><ChevronRight size={14} /></Button></div>
          <Button variant="ghost" size="sm" disabled={!scopedIssues} onClick={() => drilldown("all", "undated")}>{text("无有效到期日", "Without a valid due date")} · {undated?.length ?? "—"}</Button>
          {timelineIssues.length > 4 && <Button variant="ghost" size="sm" aria-expanded={allTimeline} onClick={() => setAllTimeline(!allTimeline)}>{allTimeline ? text("收起", "Show less") : text(`全部 ${timelineIssues.length} 项`, `All ${timelineIssues.length} issues`)}</Button>}
          {invalidScheduleCount > 0 && <p className={d2.caption}>{text(`${invalidScheduleCount} 项任务的日期无效或顺序不符，未绘制排期。`, `${invalidScheduleCount} issues have invalid dates or date order and are not plotted.`)}</p>}
        </PopoverContent></Popover>
      </section>,
      cards: <section ref={projectSectionRef} className={styles.scrollTarget} aria-label={text("项目卡片", "Project cards")} data-pm-dashboard2="project-cards">
        <header className={d2.sectionHeader}><h2>{text("当前项目", "Current Projects")}</h2><div className={d2.projectActions}>{(scopedProjects?.length ?? 0) > 2 && <Button variant="ghost" size="icon" aria-expanded={allProjects} aria-label={allProjects ? text("收起项目", "Show fewer projects") : text("查看全部项目", "View all projects")} onClick={() => setAllProjects(!allProjects)}><MoreHorizontal size={16} aria-hidden="true" /></Button>}<Button variant="outline" size="sm" disabled={!surface.capabilities.createProject} onClick={event => surface.actions.createProject(event.currentTarget)}><Plus size={16} aria-hidden="true" />{text("新建项目", "New Project")}</Button></div></header>
        <SnapshotNotice query={projects} />
        {scopedProjects?.length === 0 && !!projects.data?.length && <p className={styles.empty}>{text("没有匹配当前范围或搜索的项目。", "No projects match the current scope or search.")}</p>}
        <div className={d2.projectCards}>{(allProjects ? scopedProjects : scopedProjects?.slice(0, 2))?.map(project => {
          const ownerId = string(project.data.ownerId)
          const owner = knownMembers.get(ownerId)
          const projectIssues = issues.data?.filter(issue => issue.projectId === project.id)
          const assigneeIds = projectIssues ? [...new Set(projectIssues.map(issue => string(issue.data.assigneeId)).filter(Boolean))] : null
          const due = dateValue(project.data.dueDate)
          return <article key={project.id} className={d2.projectCard} data-project-card={project.id}>
            <header className={d2.projectHeader}><span title={project.id}><Zap size={16} aria-hidden="true" />{shortId(project.id)}</span><Button variant="outline" size="sm" aria-label={`${text("查看项目详情", "See project details")}: ${string(project.data.name)}`} onClick={() => surface.actions.openProject(project.id)}>{text("查看详情", "See details")}</Button></header>
            <div className={d2.projectName}><p className={d2.caption}>{text("项目名称", "Project Name")}</p><div className={d2.projectTitle}><h3 title={string(project.data.name)}>{string(project.data.name) || text("未提供名称", "Name not provided")}</h3><Badge shape="pill" size="sm">{statusLabel(string(project.data.status))}</Badge></div></div>
            <div className={d2.projectPeople}><div><p className={d2.caption}>{text("项目负责人", "Project Manager")}</p>{owner ? <span className={styles.identity}><Avatar name={owner.name} size={24} /><span>{owner.name}</span></span> : <span className={d2.caption} title={ownerId || undefined}>{ownerId ? text("成员身份不可用", "Member identity unavailable") : text("未指定", "Not assigned")}</span>}</div><div><p className={d2.caption}>{text("团队主管", "Team Lead")}</p><span className={d2.caption}>{text("服务未提供", "Not provided")}</span></div></div>
            <div><p className={d2.caption}>{text("任务受派人", "Issue assignees")}</p><div className={d2.teamAvatars}>{assigneeIds?.slice(0, 4).map(id => { const member = knownMembers.get(id); return member ? <Avatar key={id} name={member.name} size={24} /> : null })}<span className={d2.caption}>{assigneeIds ? text(`${assigneeIds.length} 位任务受派人`, `${assigneeIds.length} issue assignees`) : text("任务快照不可用", "Issue snapshot unavailable")}</span></div></div>
            <footer className={d2.projectTimeline}><div><p className={d2.caption}>{text("截止日期", "Timeline · due date")}</p><span><CalendarDays size={16} aria-hidden="true" />{due ? <time dateTime={due}>{longDate.format(new Date(`${due}T12:00:00Z`))}</time> : text("项目日期未提供", "Project date not provided")}</span></div></footer>
          </article>
        })}</div>
      </section>,
      distribution: <div className={d2.lowerGrid}>
        <section ref={milestoneSectionRef} className={`${d2.panel} ${d2.milestonePanel} ${styles.scrollTarget}`} aria-label={text("里程碑跟踪", "Milestone Tracker")}>
          <header className={d2.panelHeader}><h2>{text("里程碑跟踪", "Milestone Tracker")}</h2></header>
          <Tabs value={chartMonths} onValueChange={value => { setChartMonths(Number(value)); setMilestoneMonth(null) }}>
            <TabsList className={`${d2.rangeTabs} ${styles.milestoneTabs}`} aria-label={text("里程碑时间范围", "Milestone range")}>
              {[1, 3, 6, 12].map(months => <TabsTab key={months} value={months}>{months === 12 ? text("1 年", "1 Year") : text(`${months} 个月`, `${months} ${months === 1 ? "Month" : "Months"}`)}</TabsTab>)}
            </TabsList>
          </Tabs>
          <SnapshotNotice query={milestones} />
          {scopedMilestones && <>
            <div className={d2.milestoneChart} aria-label={text("按目标日期统计已规划与已达成的里程碑", "Planned and achieved milestones by actual target date")}>
              {monthBuckets.map(bucket => <button key={bucket.id} type="button" className={d2.milestoneBucket} aria-pressed={milestoneMonth === bucket.id} aria-label={`${bucket.id}: ${text("已规划", "Planned")} ${bucket.planned}, ${text("已达成", "Achieved")} ${bucket.achieved}`} title={`${bucket.id} · ${bucket.planned} ${text("已规划", "planned")} · ${bucket.achieved} ${text("已达成", "achieved")}`} onClick={() => setMilestoneMonth(milestoneMonth === bucket.id ? null : bucket.id)}>
                <span className={d2.milestoneBars}><i style={{ height: `${bucket.planned / milestoneMaximum * 100}%` }} data-series="open" /><i style={{ height: `${bucket.achieved / milestoneMaximum * 100}%` }} data-series="done" /></span><span>{bucket.label}</span>
              </button>)}
            </div>
            <p className={styles.chartCaption}>
              {text(`${scopedMilestones.length} 个范围内里程碑`, `${scopedMilestones.length} milestones in scope`)} · {monthStart.slice(0, 7)} – {addScheduleMonths(monthStart, chartMonths - 1).slice(0, 7)}
              <br />{text("灰：已规划 · 深色：已达成", "Gray: planned · Dark: achieved")}
              {undatedMilestones.length > 0 && ` · ${undatedMilestones.length} ${text("项无有效目标日期", "without valid target dates")}`}
              {milestoneOtherCount > 0 && ` · ${milestoneOtherCount} ${text("项其他状态不计入柱状图", "other statuses excluded from bars")}`}
            </p>
            {selectedBucket && <div className={d2.milestoneDetails} role="status">
              <strong>{selectedBucket.id} · {selectedBucket.items.length} {text("个里程碑", "milestones")}</strong>
              {selectedBucket.items.length === 0 && <p>{text("本月没有目标里程碑。", "No milestone target dates this month.")}</p>}
              {selectedBucket.items.map(milestone => <Button key={milestone.id} variant="ghost" size="sm" onClick={() => openEntity(milestone.id)}>{string(milestone.data.title) || milestone.id} · {statusLabel(string(milestone.data.status))} · {string(milestone.data.targetDate)}</Button>)}
            </div>}
            {undatedMilestones.length > 0 && <details className={styles.undatedMilestones}>
              <summary>{text("未排期里程碑", "Undated milestones")} · {undatedMilestones.length}</summary>
              {undatedMilestones.map(milestone => <Button key={milestone.id} variant="ghost" size="sm" onClick={() => openEntity(milestone.id)}>{string(milestone.data.title) || milestone.id} · {statusLabel(string(milestone.data.status))}</Button>)}
            </details>}
          </>}
          {!scopedMilestones && <p className={styles.empty}>{text("里程碑总数未知。", "Milestone totals are unknown.")}</p>}
        </section>
        <NotesPanel />
      </div>,
      issues: <details ref={issueDetailsRef} className={d2.issueDetails} open={issuesExpanded} onToggle={event => setIssuesExpanded(event.currentTarget.open)} data-pm-dashboard2="issues"><summary>{text("任务明细", "Issue details")}<span className={d2.caption}>{issueRows?.length ?? "—"} {text("项", "issues")} · {activeStatuses.length ? activeStatuses.map(statusLabel).join(", ") : text("所有状态", "All statuses")}{activeFilters ? ` · ${activeFilters} ${text("个筛选条件", "filters")}` : ""}</span></summary><div className={d2.issueDetailsBody}>
        <div className={styles.issueFilters}><Input aria-label={text("搜索任务", "Search issues")} placeholder={text("搜索任务…", "Search issues…")} value={issueQuery} onChange={event => setIssueQuery(event.target.value)} /><RadixSelect aria-label={text("任务日期范围", "Issue date scope")} value={issueMode} onChange={event => setIssueMode(event.target.value as IssueMode)}><option value="scheduled">{text("窗口内到期", "Due in window")}</option><option value="undated">{text("无有效到期日", "Without a valid due date")}</option><option value="all">{text("当前范围全部任务", "All issues in scope")}</option></RadixSelect><Popover>
          <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label={text("筛选任务", "Filter issues")} />}><SlidersHorizontal size={14} aria-hidden="true" />{text("筛选", "Filter")}{activeFilters > 0 && ` (${activeFilters})`}</PopoverTrigger>
          <PopoverContent align="start" className="w-[min(460px,calc(100vw-2rem))] p-0">
            <FilterCard
              title={text("筛选任务", "Issue filters")}
              fields={filterFields}
              conditions={filters}
              onChange={setFilters}
              emptyHint={text("尚未添加筛选条件，显示当前范围内的全部任务。", "No filter conditions yet; every issue in scope is shown.")}
              addLabel={text("添加条件", "Add filter")}
              clearLabel={text("清除", "Clear")}
              whereLabel={text("条件", "Where")}
              andLabel={text("且", "and")}
              anyLabel={text("任一", "Any")}
              removeLabel={text("移除条件", "Remove filter")}
            />
          </PopoverContent>
        </Popover></div>
        <SnapshotNotice query={issues} />
        {issueRows?.length === 0 && <p className={styles.empty}>{text("没有匹配的任务。", "No matching issues.")}</p>}
        <ul data-pm-stagger className={styles.issueList}>{issueRows?.map(issue => <li key={issue.id}><Button variant="ghost" onClick={() => openEntity(issue.id)} title={`${issue.id} · ${string(issue.data.title)}`}><span className={styles.issueIdentity}>{shortId(issue.id)}</span><strong>{string(issue.data.title) || text("未提供标题", "Title not provided")}</strong><span>{statusLabel(string(issue.data.status))}</span><time dateTime={dateValue(issue.data.dueDate) ?? undefined}>{dateValue(issue.data.dueDate) ?? text("无到期日", "No due date")}</time><ArrowRight size={14} aria-hidden="true" /></Button></li>)}</ul>
        <Button variant="outline" size="sm" onClick={() => surface.actions.openIssues(selectedProjectId ? { projectId: selectedProjectId } : undefined)}>{text("打开任务工作区", "Open issue workspace")}<ArrowRight size={14} aria-hidden="true" /></Button>
      </div></details>,
      rail: <aside className={d2.rail} data-pm-dashboard2="rail" aria-label={text("概览辅助信息", "Dashboard supporting information")}>
        <section className={`${d2.panel} ${d2.activityPanel}`} aria-label={text("服务变更动态", "Service change activity")}><header className={d2.panelHeader}><h2><Activity size={18} aria-hidden="true" />{text("动态", "Activity")}</h2></header><SnapshotNotice query={changes} />{activity?.length ? <ul data-pm-stagger className={d2.activityList}>{activity.map(event => {
          const entity = entities.get(event.aggregateId)
          const label = entity ? string(entity.data.name) || string(entity.data.title) || event.aggregateId : event.aggregateId
          return <li key={event.eventId} className={d2.activityItem}><span className={styles.eventIcon}><Activity size={16} aria-hidden="true" /></span><div><Button variant="ghost" className={d2.activityLink} title={event.eventType} onClick={() => entity ? openEntity(entity.id) : openActivity()}>{event.eventType}</Button><p className={d2.caption} title={label}>{label}</p><time className={d2.caption} dateTime={event.occurredAt}>{event.occurredAt.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC")}</time></div></li>
        })}</ul> : <p className={d2.activityEmpty}>{changes.data ? text("当前范围暂无已确认的变更。", "No confirmed changes in the current scope.") : text("变更快照不可用。", "Change snapshot unavailable.")}</p>}<p className={styles.activityBoundary}>{text("仅服务事件元数据；不推测操作者或消息正文。", "Service event metadata only; actors and message content are not inferred.")}{changes.historyTruncated && ` ${text("旧事件已超出保留期，不是完整审计记录。", "Older events are outside retention; this is not a complete audit history.")}`}</p><Button className={d2.railAction} variant="outline" onClick={openActivity}>{text("打开动态日志", "Open activity log")}<ArrowRight size={16} aria-hidden="true" /></Button></section>
        <section className={d2.panel} aria-label={text("概览成员", "Dashboard members")}><PresencePanel /><Button className={d2.railAction} variant="outline" onClick={surface.actions.openPeople}>{text("查看成员", "View members")}<ArrowRight size={16} aria-hidden="true" /></Button></section>
        <section className={`${d2.panel} ${d2.statusPanel}`} aria-label={text("任务状态", "Issue Status")} data-pm-dashboard2="status-distribution"><header className={d2.panelHeader}><h2>{text("任务状态", "Issue Status")}</h2></header><p className={d2.caption}>{scheduled ? text(`${scheduled.length} 项窗口内到期任务`, `${scheduled.length} issues due in this window`) : text("任务状态分布未知。", "Issue status distribution is unknown.")}</p><div className={d2.statusTrack} aria-hidden="true">{statusIds.map(id => <span key={id} style={{ flex: statusCounts.get(id) ?? 0, background: colors[id] ?? "#a1a1aa" }} />)}</div><ul data-pm-stagger className={d2.statusList}>{statusIds.map(id => <li key={id}><Button variant="ghost" disabled={!scheduled} aria-pressed={activeStatuses.includes(id) && issueMode === "scheduled"} onClick={() => drilldown(activeStatuses.includes(id) ? "all" : id)}><span><i style={{ background: colors[id] ?? "#a1a1aa" }} aria-hidden="true" />{statusLabel(id)}</span><strong>{statusCounts.get(id) ?? "—"}</strong></Button></li>)}</ul></section>
      </aside>,
      projects: null,
      currentProject: null,
      activity: null,
    }}
  />
}
