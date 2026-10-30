import { useState, type ReactNode } from "react"
import type { Entity } from "@contracts"
import { Bell, CalendarDays, ChevronDown, FilePlus2, Flag, MoreHorizontal, RefreshCw, SlidersHorizontal, UserRoundCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CountUp } from "@/components/ui/count-up"
import { Avatar } from "@/components/ui/avatar"
import { DataRegion } from "@/components/ui/data-region"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { DataTable, type DataTableSort } from "@/components/blocks/data-table"
import { DashboardGrid, DashboardWidget } from "@/components/blocks/dashboard/dashboard"
import { FilterCard, type FilterCondition, type FilterField } from "@/components/blocks/filter-card"
import { DashboardView } from "@/views/pm/dashboard"
import { PmSearch } from "@/views/pm/presentation-page"
import d1 from "@/views/pm/dashboard-1.module.css"
import { issueRecord, queryData, QueryNotice, string, useDraftState, useText } from "./pm-ui"
import type { ServiceDashboardProps } from "./service-dashboard-contract"
import { usePersonalDashboard } from "./pm-service"
import { MeetingsPanel, ProfilePanel, WatchControls, WatchingPanel } from "./dashboard-personal"
import { TimerPanel, TimeTrackingPanel } from "./dashboard-time"
import styles from "./service-dashboard-1.module.css"

type PersonalScope = "overview" | "assigned" | "reported" | "watching"
type StatusGroup = { id: string; label: string; states: string[]; color: string }
type AgendaEntry = { entity: Entity; date: string }

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className={d1.sectionTitle}>{children}</h2>
}

/** The personal layout shares Lab geometry, never its records or simulator. */
export function ServiceDashboard1({ surface, issues, projects, milestones, members, actor, openEntity, openActivity }: ServiceDashboardProps) {
  const t = useText()
  const personalQuery = usePersonalDashboard()
  const [scope, setScope] = useDraftState<PersonalScope>("dashboard1", "scope", "overview")
  const [filters, setFilters] = useDraftState<FilterCondition[]>("dashboard1", "filters", [])
  const [agendaTab, setAgendaTab] = useDraftState("dashboard1", "agenda", "tasks")
  const [sort, setSort] = useState<DataTableSort>(null)
  const statusLabels: Record<string, [string, string]> = {
    todo: ["待办", "To do"], in_progress: ["进行中", "In progress"], review: ["审核中", "In review"],
    done: ["已完成", "Done"], canceled: ["已取消", "Canceled"], cancelled: ["已取消", "Cancelled"],
    draft: ["草稿", "Draft"], ready: ["待开始", "Ready"], in_review: ["审核中", "In review"],
  }
  const observedStatuses = [...new Set((issues.data ?? []).map(issue => string(issue.data.status)).filter(Boolean))]
  const issueStatuses = observedStatuses.length ? observedStatuses : ["draft", "ready", "in_progress", "in_review", "done", "cancelled"]
  const statusNames: Record<string, string> = Object.fromEntries(issueStatuses.map(id => [id, statusLabels[id] ? t(statusLabels[id][0], statusLabels[id][1]) : id]))
  const priorityNames: Record<string, string> = { low: t("低", "Low"), normal: t("普通", "Normal"), high: t("高", "High"), urgent: t("紧急", "Urgent") }
  const statusColors: Record<string, string> = { todo: "var(--text-secondary)", in_progress: "var(--warning)", review: "var(--agent)", done: "var(--success)", canceled: "var(--text-secondary)", cancelled: "var(--text-secondary)", draft: "var(--text-secondary)", ready: "var(--info)", in_review: "var(--agent)" }
  const statusCategoryOf = (entity: Entity) => {
    const status = string(entity.data.status)
    return status === "done" ? "completed" : status === "canceled" || status === "cancelled" ? "canceled" : "started"
  }
  const statusGroups: StatusGroup[] = issueStatuses.map(id => ({ id, label: statusNames[id], states: [id], color: statusColors[id] ?? "var(--text-secondary)" }))
  const actorId = actor?.id
  const created = actorId && issues.data ? issues.data.filter(issue => issue.createdBy === actorId) : undefined
  const assigned = actorId && issues.data ? issues.data.filter(issue => issue.data.assigneeId === actorId) : undefined
  const personal = actorId && issues.data ? issues.data.filter(issue => issue.createdBy === actorId || issue.data.assigneeId === actorId) : undefined
  const watchedIds = new Set(personalQuery.data?.watches.map(watch => watch.data.taskId))
  const watched = personalQuery.data && issues.data ? issues.data.filter(issue => watchedIds.has(issue.id)) : undefined
  const scoped = scope === "watching" ? watched : scope === "reported" ? created : scope === "assigned" ? assigned : personal
  const projectNames = new Map((projects.data ?? []).map(project => [project.id, string(project.data.name) || project.id]))
  const memberNames = new Map((members.data ?? []).filter(member => !member.revokedAt).map(member => [member.userId, member.name]))
  const query = surface.interaction.query.trim().toLocaleLowerCase()
  const today = surface.readModel.today
  const weekEnd = new Date(`${today}T00:00:00Z`)
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7)
  const weekEndDate = weekEnd.toISOString().slice(0, 10)
  const dueBucket = (entity: Entity): string => {
    const due = string(entity.data.dueDate) || string(entity.data.targetDate)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return "none"
    if (due < today) return "overdue"
    if (due === today) return "today"
    return due <= weekEndDate ? "week" : "later"
  }
  const filterValue = (entity: Entity, field: string): string => {
    if (field === "status") return string(entity.data.status)
    if (field === "priority") return string(entity.data.priority)
    if (field === "assignee") return string(entity.data.assigneeId) || "unassigned"
    if (field === "project") return entity.projectId ?? "none"
    if (field === "due") return dueBucket(entity)
    return ""
  }
  const matchesFilter = (entity: Entity, condition: FilterCondition): boolean => {
    if (!condition.values.length) return true
    const hit = condition.values.includes(filterValue(entity, condition.field))
    return condition.operator === "isNot" ? !hit : hit
  }
  const activeFilters = filters.filter(condition => condition.values.length).length
  const activeStatuses = filters.filter(condition => condition.field === "status" && condition.operator === "is").flatMap(condition => condition.values)
  const rows = (scoped ?? []).filter(issue => filters.every(condition => matchesFilter(issue, condition)) && (!query || [issue.id, string(issue.data.title), issue.projectId ? projectNames.get(issue.projectId) ?? issue.projectId : ""].some(value => value.toLocaleLowerCase().includes(query))))
  if (sort) {
    const sortValue = (entity: Entity): string => sort.columnId === "title" ? string(entity.data.title) : sort.columnId === "priority" ? string(entity.data.priority) : string(entity.data.dueDate)
    rows.sort((a, b) => sortValue(a).localeCompare(sortValue(b)) * (sort.direction === "asc" ? 1 : -1))
  }
  const scopeLabels: { value: PersonalScope; label: string }[] = [
    { value: "overview", label: t("概览", "Overview") },
    { value: "assigned", label: t("分配给我", "Assigned to me") },
    { value: "reported", label: t("由我创建", "Reported by me") },
    { value: "watching", label: t("我关注的", "Watching") },
  ]
  const unavailable = t("未提供", "Not provided")
  const title = (entity: Entity) => string(entity.data.title) || entity.id
  const stateName = (entity: Entity) => statusNames[string(entity.data.status)] ?? (string(entity.data.status) || unavailable)
  const assigneeName = (entity: Entity) => {
    const id = string(entity.data.assigneeId)
    return id ? memberNames.get(id) ?? (id === actorId && actor ? actor.name : id) : t("未分配", "No owner")
  }
  const projectName = (entity: Entity) => entity.projectId ? projectNames.get(entity.projectId) ?? entity.projectId : t("未关联项目", "No project")
  const assigneeIds = [...new Set((issues.data ?? []).map(issue => string(issue.data.assigneeId)).filter(Boolean))]
  const assigneeOptions = [...new Set([...memberNames.keys(), ...assigneeIds])].map(id => ({ value: id, label: memberNames.get(id) ?? (id === actorId && actor ? actor.name : id) }))
  const projectOptions = [...projectNames].map(([value, label]) => ({ value, label }))
  const filterFields: FilterField[] = [
    { id: "status", label: t("状态", "Status"), options: Object.entries(statusNames).map(([value, label]) => ({ value, label })) },
    { id: "priority", label: t("优先级", "Priority"), options: Object.entries(priorityNames).map(([value, label]) => ({ value, label })) },
    ...(assigneeOptions.length ? [{ id: "assignee", label: t("负责人", "Assignee"), options: [{ value: "unassigned", label: t("未分配", "Unassigned") }, ...assigneeOptions] }] : []),
    ...(projectOptions.length ? [{ id: "project", label: t("项目", "Project"), options: [...projectOptions, { value: "none", label: t("未关联项目", "No project") }] }] : []),
    { id: "due", label: t("截止日期", "Due date"), options: [
      { value: "overdue", label: t("已逾期", "Overdue") },
      { value: "today", label: t("今天到期", "Due today") },
      { value: "week", label: t("未来 7 天", "Next 7 days") },
      { value: "later", label: t("更晚", "Later") },
      { value: "none", label: t("无到期日", "No due date") },
    ] },
  ]
  const statusBadge = (entity: Entity) => <span className={`${d1.statusBadge} ${styles.status}`} data-status={string(entity.data.status)}><span className={d1.dot} style={{ background: "currentColor" }} />{stateName(entity)}</span>
  const assignee = (entity: Entity) => <span className={`${d1.memberIdentity} ${styles.member}`}>
    {string(entity.data.assigneeId) && <Avatar name={assigneeName(entity)} size={24} />}<span>{assigneeName(entity)}</span>
  </span>
  const priority = (entity: Entity) => <span className={d1.priority}><Flag size={13} aria-hidden="true" />{priorityNames[string(entity.data.priority)] ?? (string(entity.data.priority) || unavailable)}</span>
  const drill = (nextScope: PersonalScope, nextStatus: string | string[] = "all") => {
    setScope(nextScope)
    const nextStates = Array.isArray(nextStatus) ? nextStatus : nextStatus === "all" ? [] : [nextStatus]
    setFilters(previous => [...previous.filter(condition => condition.field !== "status"), ...(nextStates.length ? [{ field: "status", operator: "is" as const, values: nextStates }] : [])])
    surface.actions.setInteraction(previous => ({ ...previous, query: "" }))
  }
  const upcoming = (entities: Entity[] | undefined, field: "dueDate" | "targetDate"): AgendaEntry[] => (entities ?? []).flatMap(entity => {
    const date = string(entity.data[field])
    const category = statusCategoryOf(entity)
    const terminal = category === "completed" || category === "canceled"
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= surface.readModel.today && !terminal && filters.every(condition => matchesFilter(entity, condition)) ? [{ entity, date }] : []
  }).sort((a, b) => a.date.localeCompare(b.date) || a.entity.id.localeCompare(b.entity.id))
  const upcomingTasks = upcoming(personal, "dueDate")
  const upcomingMilestones = upcoming(milestones.data, "targetDate")
  const taskQuery = scope === "watching" ? { ...issues, data: watched, error: issues.error ?? personalQuery.error, isPending: issues.isPending || personalQuery.isPending, isFetching: issues.isFetching || personalQuery.isFetching, refetch: () => { void issues.refetch(); void personalQuery.refetch() } } : issues
  const tableData = { ...queryData(taskQuery, rows.length), showRefreshingNotice: false, emptyTitle: t("没有匹配的任务", "No matching issues") }
  const stats = [
    { scope: "reported" as const, icon: FilePlus2, title: t("创建的任务", "Issues created"), count: created?.length },
    { scope: "assigned" as const, icon: UserRoundCheck, title: t("分配的任务", "Issues assigned"), count: assigned?.length },
  ]

  return <DashboardView {...surface}
    variant="dashboard1"
    pageId="pm-service-dashboard-1"
    navigation={null}
    readModel={{ ...surface.readModel, data: { ...surface.readModel.data, showRefreshingNotice: false }, title: t("我的工作区", "My workspace"), description: "", issues: rows.map(issueRecord) }}
    headerActions={<><Dialog><DialogTrigger render={<Button variant="ghost" size="sm" />}><Bell size={14} aria-hidden="true" />{t("管理关注", "Manage watching")}</DialogTrigger><DialogContent><DialogTitle>{t("关注任务", "Watch tasks")}</DialogTitle><DialogDescription>{t("关注当前有权访问的任务；关注关系仅本人可见。", "Watch authorized tasks; your subscriptions are private.")}</DialogDescription><WatchingPanel issues={issues.data} /></DialogContent></Dialog><Button variant="ghost" size="sm" disabled={issues.isFetching || personalQuery.isFetching} onClick={() => { surface.actions.refresh(); void personalQuery.refetch() }}><RefreshCw size={14} aria-hidden="true" />{t("刷新", "Refresh")}</Button></>}
    toolbar={<nav aria-label={t("工作区视图", "Workspace views")} className={d1.navigation}>
      {scopeLabels.map(tab => <Button key={tab.value} variant="ghost" aria-pressed={scope === tab.value} onClick={() => drill(tab.value)}>{tab.label}</Button>)}
      <Button variant="ghost" onClick={openActivity}>{t("动态", "Updates")}</Button>
    </nav>}
    regions={{
      metrics: <section aria-label={t("个人任务统计", "Personal issue statistics")}>
        <SectionTitle>{t("概览", "Overview")}</SectionTitle>
        <div className={styles.queryNotice}><QueryNotice query={issues} /></div>
        {(personalQuery.isPending || personalQuery.error) && <div className={styles.queryNotice}><QueryNotice query={{ ...personalQuery, data: personalQuery.data?.watches }} /></div>}
        <div className={d1.stats}>
          {stats.map(stat => <Button key={stat.scope} variant="outline" className={d1.stat} disabled={!actorId || !issues.data} aria-pressed={scope === stat.scope} onClick={() => drill(stat.scope)}>
            <span className={d1.statIcon}><stat.icon size={20} strokeWidth={1.75} aria-hidden="true" /></span>
            <span><span className={d1.muted}>{stat.title}</span><strong className={`${d1.statNumber} ${stat.count === undefined ? styles.unavailableCount : ""}`}><CountUp value={stat.count} fallback={unavailable} /></strong></span>
          </Button>)}
          <Button variant="outline" className={d1.stat} disabled={!actorId || !watched} aria-pressed={scope === "watching"} onClick={() => drill("watching")}>
            <span className={d1.statIcon}><Bell size={20} strokeWidth={1.75} aria-hidden="true" /></span>
            <span><span className={d1.muted}>{t("关注的任务", "Issues subscribed")}</span><strong className={`${d1.statNumber} ${watched === undefined ? styles.unavailableCount : ""}`}><CountUp value={watched?.length} fallback={unavailable} /></strong></span>
          </Button>
        </div>
      </section>,
      distribution: <section aria-label={t("我创建的任务状态", "Status of issues created by me")}>
        <SectionTitle>{t("任务状态", "Issue status")}</SectionTitle>
        <div className={`${d1.statusStats} ${styles.statusStats}`}>
          {statusGroups.map(group => <Button key={group.id} variant="outline" className={d1.statusStat} disabled={!created} aria-pressed={scope === "reported" && activeStatuses.length === group.states.length && group.states.every(state => activeStatuses.includes(state))} onClick={() => drill("reported", group.states)}>
            <span className={d1.statusLabel}><span className={d1.dot} style={{ background: group.color }} /><span>{group.label}</span></span>
            <strong className={d1.statNumber}><CountUp value={created ? created.filter(issue => group.states.includes(string(issue.data.status))).length : null} /></strong>
          </Button>)}
        </div>
      </section>,
      timeline: <DashboardGrid>
        <DashboardWidget id="pm-dashboard-1-work-hours" title={t("工时分析", "Work Hour Analysis")} width={8}>
          <div className={d1.widgetCard}><TimeTrackingPanel issues={issues.data} /></div>
        </DashboardWidget>
        <DashboardWidget id="pm-dashboard-1-timer" title={t("时间追踪", "Time Tracker")} width={4}>
          <div className={d1.widgetCard}><TimerPanel issues={issues.data} /></div>
        </DashboardWidget>
      </DashboardGrid>,
      issues: <section aria-label={t("我的任务", "My issues")} data-dashboard-issues className={d1.issues}>
        <SectionTitle>{t("我的任务", "My issues")}</SectionTitle>
        <div className={`${styles.filters} flex flex-wrap items-center gap-2`}>
          <PmSearch label={t("搜索任务", "Search issues")} value={surface.interaction.query} onChange={value => surface.actions.setInteraction(previous => ({ ...previous, query: value }))} />
          <span className={d1.caption}>{scopeLabels.find(tab => tab.value === scope)?.label} · {issues.data && actorId ? rows.length : "—"} {t("项", "issues")}{activeFilters ? ` · ${activeFilters} ${t("个筛选条件", "filters")}` : ""}</span>
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label={t("筛选任务", "Filter issues")} />}><SlidersHorizontal size={14} aria-hidden="true" />{t("筛选", "Filter")}{activeFilters > 0 && ` (${activeFilters})`}</PopoverTrigger>
            <PopoverContent align="start" className="w-[min(460px,calc(100vw-2rem))] p-0">
              <FilterCard
                title={t("筛选任务", "Issue filters")}
                fields={filterFields}
                conditions={filters}
                onChange={setFilters}
                emptyHint={t("尚未添加筛选条件，显示当前范围内的全部任务。", "No filter conditions yet; every issue in scope is shown.")}
                addLabel={t("添加条件", "Add filter")}
                clearLabel={t("清除", "Clear")}
                whereLabel={t("条件", "Where")}
                andLabel={t("且", "and")}
                anyLabel={t("任一", "Any")}
                removeLabel={t("移除条件", "Remove filter")}
              />
            </PopoverContent>
          </Popover>
          <Button variant="ghost" size="sm" onClick={() => { setFilters([]); setScope("overview"); setSort(null); surface.actions.setInteraction(previous => ({ ...previous, query: "" })) }}>{t("清除筛选", "Clear filters")}</Button>
        </div>
        {!actorId && <p className={d1.caption}>{t("当前身份信息不可用，无法确定个人任务。", "Actor identity is unavailable; personal tasks cannot be determined.")}</p>}
        {actorId && <DataRegion {...tableData} hasContent={rows.length > 0}>
          <DataTable className={d1.issueTable} rows={rows} getRowId={issue => issue.id} getRowLabel={issue => title(issue)} caption={t("当前筛选的个人任务", "Personal issues in the current filter")} sort={sort} onSortChange={setSort} columnConfig={{ widths: { title: 388, status: 144, priority: 128, assignee: 176, project: 224, due: 160, actions: 160 } }} columns={[
            { id: "title", header: t("任务", "Issues"), sortable: true, cell: issue => <Button variant="ghost" className={`${d1.issueTitle} ${styles.issueTitle}`} title={`${issue.id}: ${title(issue)}`} aria-label={`${t("打开任务", "Open issue")} ${title(issue)}`} onClick={() => openEntity(issue.id)}><span className={`${d1.identifier} ${styles.identifier}`}>{issue.id}</span><span className={d1.issueText}>{title(issue)}</span></Button> },
            { id: "status", header: t("状态", "Status"), cell: statusBadge },
            { id: "priority", header: t("优先级", "Priority"), sortable: true, cell: priority },
            { id: "assignee", header: t("负责人", "Assignee"), cell: assignee },
            { id: "project", header: t("项目", "Project"), cell: issue => <span className={styles.projectName} title={projectName(issue)}>{projectName(issue)}</span> },
            { id: "due", header: t("截止日期", "Due date"), sortable: true, cell: issue => <time dateTime={string(issue.data.dueDate) || undefined}>{string(issue.data.dueDate) || "—"}</time> },
            { id: "actions", header: <span className="sr-only">{t("操作", "Actions")}</span>, cell: issue => <div className="flex items-center"><WatchControls task={issue} /><Button variant="ghost" size="icon" aria-label={`${t("查看任务详情", "Open details for")} ${title(issue)}`} onClick={() => openEntity(issue.id)}><MoreHorizontal size={16} aria-hidden="true" /></Button></div> },
          ]} />
          <div className={d1.mobileIssues}>{rows.map(issue => <article key={issue.id} className={d1.mobileIssue}>
            <div className={d1.mobileIssueHeading}><Button variant="ghost" className={`${d1.issueTitle} ${styles.issueTitle}`} title={title(issue)} onClick={() => openEntity(issue.id)}><span className={`${d1.identifier} ${styles.identifier}`}>{issue.id}</span><span className={d1.issueText}>{title(issue)}</span></Button><Button variant="ghost" size="icon" aria-label={`${t("查看任务详情", "Open details for")} ${title(issue)}`} onClick={() => openEntity(issue.id)}><MoreHorizontal size={16} aria-hidden="true" /></Button></div>
            <div className={d1.mobileIssueProperties}>{statusBadge(issue)}{priority(issue)}</div>
            <div className={d1.mobileIssueMeta}>{assignee(issue)}<time dateTime={string(issue.data.dueDate) || undefined}><CalendarDays size={13} aria-hidden="true" />{string(issue.data.dueDate) || "—"}</time></div>
            <p className={styles.projectName}>{projectName(issue)}</p>
            <WatchControls task={issue} />
          </article>)}</div>
        </DataRegion>}
      </section>,
      rail: <aside className={`${d1.aside} ${styles.rail}`} aria-label={t("个人信息与日程", "Profile and agenda")}>
        <div className={d1.cover} aria-hidden="true" />
        <ProfilePanel />
        <Tabs value={agendaTab} onValueChange={value => setAgendaTab(String(value))}>
          <TabsList className={d1.agendaTabs}><TabsTab value="tasks">{t("到期任务", "Due tasks")}</TabsTab><TabsTab value="milestones">{t("里程碑", "Milestones")}</TabsTab><TabsTab value="meetings">{t("会议", "Meetings")}</TabsTab></TabsList>
          {(["tasks", "milestones"] as const).map(kind => {
            const entries = kind === "tasks" ? upcomingTasks : upcomingMilestones
            const source = kind === "tasks" ? issues : milestones
            return <TabsPanel key={kind} value={kind} className={d1.agendaPanel}>
              <p className={styles.agendaScope}>{kind === "tasks" ? t("我创建或分配给我的任务，截止日期为今天或之后。", "Your created or assigned tasks due today or later.") : t("当前授权快照中目标日期为今天或之后的里程碑。", "Authorized milestones with target dates today or later.")}</p>
              {kind === "tasks" && !actorId ? <p className={d1.caption}>{t("当前身份信息不可用，无法确定个人日程。", "Actor identity is unavailable; your agenda cannot be determined.")}</p> : <QueryNotice query={source}>{entries.map(entry => <article key={entry.entity.id} className={d1.agendaEntry}>
                <div className={d1.agendaHeading}><div><h3>{title(entry.entity)}</h3><p className={d1.caption}><time dateTime={entry.date}>{entry.date}</time> · {stateName(entry.entity)}</p></div><Button variant="ghost" size="icon" aria-label={`${t("打开", "Open")} ${title(entry.entity)}`} onClick={() => openEntity(entry.entity.id)}><ChevronDown size={16} aria-hidden="true" /></Button></div>
                <p className={d1.eventDescription}>{projectName(entry.entity)}</p>
                {kind === "tasks" && <div className={styles.agendaOwner}>{assignee(entry.entity)}</div>}
              </article>)}{entries.length === 0 && source.data && source.data.length > 0 && <p className={d1.caption}>{t("没有已排期的后续事项。", "No scheduled upcoming items.")}</p>}</QueryNotice>}
            </TabsPanel>
          })}
          <TabsPanel value="meetings" className={d1.agendaPanel}><MeetingsPanel projects={projects.data} /></TabsPanel>
        </Tabs>
      </aside>,
      projects: null, cards: null, currentProject: null, activity: null,
    }}
  />
}
