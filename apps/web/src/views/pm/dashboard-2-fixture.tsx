import { useRef, type CSSProperties } from "react"
import { Activity, ArrowRight, CalendarDays, CheckCircle2, Circle, Clock3, Flag, ListPlus, MoreHorizontal, Plus, RefreshCw, SlidersHorizontal, StickyNote, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Avatar } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger, DialogClose } from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { FilterCard } from "@/components/blocks/filter-card"
import type { FilterCondition, FilterField } from "@/lib/filter-model"
import { DataTable } from "@/components/blocks/data-table"
import { TimelineRow } from "@/components/blocks/timeline"
import { addScheduleDays, scheduleDayDifference } from "@/lib/schedule-date-utils"
import { useI18n } from "@/lib/i18n-provider"
import { PmSearch, PmMemberIdentity, usePmScenarioState } from "./shared"
import { type PmPageProps, pmMembers, pmClock } from "./model"
import { issueCatalog } from "./issue-domain"
import { useIssueDomain } from "./use-issue-domain"
import { usePeopleDomain } from "./use-people-domain"
import { usePmNavigation } from "./domain-session"
import { Picker, dashboardMember, dashboardWindow, issuesScheduledIn } from "./dashboards-views"
import { useDashboard2State, dashboard2ScopedIssues, dashboard2TableIssues, saveDashboard2Note, discardDashboard2Note, type Dashboard2WindowDays } from "./dashboard-2-controller"
import { usePmProjectDomain as useProjectFamilyDomain, ProjectBriefSection, ProjectCommentsPanel, ProjectMetadataPanel } from "./projects-views"
import { projectComments, appendProjectComment } from "./projects-domain"
import { DashboardView } from "./dashboard"
import { useFixtureDashboardSurface } from "./dashboard-fixture-surface"
import { DashboardNavigation } from "./dashboard-navigation"
import d2 from "./dashboard-2.module.css"

const windowPresets: readonly {
    days: Dashboard2WindowDays;
    label: string;
}[] = [
    { days: 7, label: "1W" },
    { days: 14, label: "2W" },
    { days: 28, label: "4W" },
    { days: 56, label: "8W" },
];
type IssueFilterTarget = {
    stateId: string;
    priorityId: string;
    assigneeIds: readonly string[];
    projectId: string;
    dueDate: string | null;
};
function issueDueBucket(date: string | null, today: string, weekEnd: string) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
        return "none";
    if (date < today)
        return "overdue";
    if (date === today)
        return "today";
    return date <= weekEnd ? "week" : "later";
}
function matchesIssueFilter(issue: IssueFilterTarget, condition: FilterCondition, today: string, weekEnd: string) {
    if (!condition.values.length)
        return true;
    let hit = false;
    if (condition.field === "status")
        hit = condition.values.includes(issue.stateId);
    else if (condition.field === "priority")
        hit = condition.values.includes(issue.priorityId);
    else if (condition.field === "assignee")
        hit = issue.assigneeIds.length ? issue.assigneeIds.some((id) => condition.values.includes(id)) : condition.values.includes("unassigned");
    else if (condition.field === "project")
        hit = condition.values.includes(issue.projectId);
    else if (condition.field === "due")
        hit = condition.values.includes(issueDueBucket(issue.dueDate, today, weekEnd));
    return condition.operator === "isNot" ? !hit : hit;
}
export function OverviewDashboardFixture({ scenario }: PmPageProps) {
const { locale } = useI18n();
const en = locale === "en";
const text = (zh: string, english: string) => (en ? english : zh);
const { navigate } = usePmNavigation();
const [issueDomain] = useIssueDomain(scenario);
const [people] = usePeopleDomain(scenario);
const { projects, family, setFamily } = useProjectFamilyDomain(scenario);
const [state, setState] = useDashboard2State(scenario);
const [projectQuery, setProjectQuery] = usePmScenarioState("pm-dashboard-2-project-search", () => "");
const [view, setView] = usePmScenarioState("pm-dashboard-2-view", () => ({
    noteOpen: false,
    allProjects: false,
    allIssues: false,
    readAt: pmClock,
    readSequence: 0,
}));
const [chartMonths, setChartMonths] = usePmScenarioState<1 | 3 | 6 | 12>("pm-dashboard-2-chart-months", () => 6);
const [milestoneMonth, setMilestoneMonth] = usePmScenarioState<string | null>("pm-dashboard-2-milestone-month", () => null);
const [completedNotes, setCompletedNotes] = usePmScenarioState<string[]>("pm-dashboard-2-completed-notes", () => []);
const [issuesExpanded, setIssuesExpanded] = usePmScenarioState("pm-dashboard-2-issue-details", () => false);
const [conditions, setConditions] = usePmScenarioState<FilterCondition[]>("pm-dashboard-2-issue-filters", () => []);
const issueDetailsRef = useRef<HTMLDetailsElement>(null);
const [details, setDetails] = usePmScenarioState<{
    projectId: string | null;
    tab: "description" | "comments" | "settings";
}>("pm-dashboard-2-project-dialog", () => ({
    projectId: null,
    tab: "comments",
}));
const detailsTrigger = useRef<HTMLButtonElement>(null);
const detailProject = projects.find((project) => project.id === details.projectId);
const detailMembers = detailProject
    ? people.memberships.flatMap((membership) => {
        if (membership.teamId !== detailProject.teamId)
            return [];
        const member = dashboardMember(membership.memberId);
        return member ? [member] : [];
    })
    : [];
const readonly = scenario === "readonly";
const locked = readonly || scenario === "loading";
const window = dashboardWindow(state.windowDays);
const normalizedProjectQuery = projectQuery.trim().toLocaleLowerCase(locale);
const scopedProjects = projects.filter((project) => (state.scope === "all" || project.id === state.scope) && (!normalizedProjectQuery || `${project.identifier} ${project.title[locale]} ${project.title.en}`.toLocaleLowerCase(locale).includes(normalizedProjectQuery)));
const missingScope = state.scope !== "all" && !projects.some((project) => project.id === state.scope);
const issueFilterToday = pmClock.slice(0, 10);
const issueFilterWeekEnd = new Date(Date.parse(`${issueFilterToday}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
const scoped = missingScope ? [] : dashboard2ScopedIssues(state, issueDomain.items, locale).filter((issue) => scopedProjects.some((project) => project.id === issue.projectId) && conditions.every((condition) => matchesIssueFilter(issue, condition, issueFilterToday, issueFilterWeekEnd)));
const activeFilterCount = conditions.filter((condition) => condition.values.length > 0).length;
const scheduled = issuesScheduledIn(scoped, window);
const unscheduled = scoped.filter((issue) => !issue.dueDate);
const rows = dashboard2TableIssues(state, scoped, locale);
const statusCounts: Record<string, number> = {};
for (const issue of scheduled)
    statusCounts[issue.stateId] = (statusCounts[issue.stateId] ?? 0) + 1;
const monthStart = new Date(`${pmClock.slice(0, 7)}-01T00:00:00Z`);
const milestones = family.milestones.filter((milestone) => scopedProjects.some((project) => project.id === milestone.projectId));
const milestoneBuckets = Array.from({ length: chartMonths }, (_, index) => {
    const date = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + index, 1));
    const id = date.toISOString().slice(0, 7);
    const items = milestones.filter((milestone) => milestone.dueDate?.startsWith(id));
    return {
        id,
        label: new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(date),
        planned: items.filter((milestone) => milestone.status !== "done").length,
        done: items.filter((milestone) => milestone.status === "done").length,
        items,
    };
});
const milestoneMaximum = Math.max(1, ...milestoneBuckets.flatMap((bucket) => [bucket.planned, bucket.done]));
const selectedMilestones = milestoneBuckets.find((bucket) => bucket.id === milestoneMonth);
const shortDate = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" });
const localActivity = family.activity.filter((entry) => scopedProjects.some((project) => project.id === entry.projectId)).slice(-3).reverse();
const catalog = issueCatalog(locale);
const projectOptions = projects.map((project) => ({ value: project.id, label: `${project.identifier} ${project.title[locale]}` }));
const filterFields: FilterField[] = [
    { id: "status", label: text("状态", "Status"), options: catalog.states.map((status) => ({ value: status.id, label: status.label })) },
    { id: "priority", label: text("优先级", "Priority"), options: catalog.priorities.map((priority) => ({ value: priority.id, label: priority.label })) },
    { id: "assignee", label: text("负责人", "Assignee"), options: [...catalog.assignees.map((assignee) => ({ value: assignee.id, label: assignee.label })), { value: "unassigned", label: text("未分配", "Unassigned") }] },
    ...(projectOptions.length ? [{ id: "project", label: text("项目", "Project"), options: projectOptions }] : []),
    { id: "due", label: text("截止日期", "Due date"), options: [
        { value: "overdue", label: text("已逾期", "Overdue") },
        { value: "today", label: text("今天到期", "Due today") },
        { value: "week", label: text("未来 7 天", "Next 7 days") },
        { value: "later", label: text("更晚", "Later") },
        { value: "none", label: text("无到期日", "No due date") },
    ] },
];
const visibleProjects = view.allProjects
    ? scopedProjects
    : scopedProjects.slice(0, 2);
const viewport = {
    rangeStart: addScheduleDays(window.from, -Math.floor(state.windowDays / 2)),
    rangeEnd: addScheduleDays(window.to, -Math.floor(state.windowDays / 2) - 1),
};
const timelineItems = scoped.filter((issue) => issue.stateId !== "done" && (issue.startDate ?? issue.dueDate ?? "") <= viewport.rangeEnd && (issue.dueDate ?? issue.startDate ?? "") >= viewport.rangeStart);
const visibleTimeline = view.allIssues ? timelineItems : timelineItems.slice(0, 4);
const todayOffset = scheduleDayDifference(pmClock.slice(0, 10), viewport.rangeStart) / state.windowDays;
const focusScope = (scope: string) => setState((previous) => ({ ...previous, scope, weekFilter: null }));
const setWindow = (windowDays: Dashboard2WindowDays) => setState((previous) => ({ ...previous, windowDays, weekFilter: null }));
const drilldown = (statusFilter: string, tableMode: "scheduled" | "unscheduled" = "scheduled") => {
    setState((previous) => ({ ...previous, statusFilter, tableMode, weekFilter: null }));
    setIssuesExpanded(true);
    requestAnimationFrame(() => issueDetailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
};
const statusLabel = state.statusFilter === "open"
    ? text("未完成", "Still open")
    : (catalog.states.find((status) => status.id === state.statusFilter)
        ?.label ?? text("所有状态", "All statuses"));
const members = pmMembers.filter((member) => people.people.some((person) => person.memberId === member.id));
const stats = [
    {
        id: "projects",
        label: text("项目总数", "Total Projects"),
        value: String(scopedProjects.length),
        hint: text("当前项目范围", "Projects in scope"),
        pressed: false,
        apply: () => setView((previous) => ({ ...previous, allProjects: true })),
    },
    {
        id: "scheduled",
        label: text("任务总数", "Total Task"),
        value: String(scheduled.length),
        hint: text("窗口内到期", "Due in window"),
        pressed: state.tableMode === "scheduled" && state.statusFilter === "all",
        apply: () => drilldown("all"),
    },
    {
        id: "progress",
        label: text("进行中", "In Progress"),
        value: String(statusCounts.progress ?? 0),
        hint: text("任务", "Task"),
        pressed: state.statusFilter === "progress",
        apply: () => drilldown("progress"),
    },
    {
        id: "completed",
        label: text("已完成", "Completed"),
        value: String(statusCounts.done ?? 0),
        hint: text("任务", "Task"),
        pressed: state.statusFilter === "done",
        apply: () => drilldown("done"),
    },
];
const surface = useFixtureDashboardSurface(scenario, "dashboard2", scopedProjects, scoped, people, issueDomain.activity)

return <DashboardView {...surface}
navigation={<DashboardNavigation query={projectQuery} onQueryChange={setProjectQuery} onPeople={() => navigate("member-list-1")} onActivity={() => navigate("inbox-1")} members={members} disabled={scenario === "loading"}/>}
readModel={{ ...surface.readModel, title: (text("概览", "Dashboard")), data: { ...surface.readModel.data, emptyDescription: (text("当前本地场景没有项目或任务。请选择其他场景查看示例。", "This local scene has no projects or issues. Choose another scene to inspect the examples.")) } }}
headerActions={<>{(<div className={d2.headerActions}>
        <Popover>
          <PopoverTrigger render={<Button variant="ghost" size="icon" className={d2.scopeTrigger} disabled={scenario === "loading"} aria-label={text("筛选项目范围", "Filter project scope")}/>}>
            <MoreHorizontal size={16} aria-hidden="true"/>
          </PopoverTrigger>
          <PopoverContent align="end" className={d2.scopeMenu}>
            <p className={d2.caption}>{text("项目范围", "Project scope")}</p>
        <Picker label={text("项目范围", "Project scope")} value={state.scope} disabled={scenario === "loading"} options={[
        { value: "all", label: text("所有项目", "All projects") },
        ...(missingScope
            ? [
                {
                    value: state.scope,
                    label: text("项目不可用", "Unavailable project"),
                },
            ]
            : []),
        ...projects.map((project) => ({
            value: project.id,
            label: `${project.identifier} ${project.title[locale]}`,
        })),
    ]} onChange={focusScope}/>
          </PopoverContent>
        </Popover>
        {readonly && <Badge>{text("只读", "Read only")}</Badge>}
        <time className={d2.snapshot} dateTime={view.readAt} title={`${text("本地快照", "Local snapshot")} · ${view.readAt}`}>
          <Clock3 size={14} aria-hidden="true"/>
          {view.readSequence > 0
            ? <span role="status">{text("已重读", "Re-read")} {view.readSequence}</span>
            : text("本地快照", "Local snapshot")}
        </time>
        <Button variant="ghost" size="icon" disabled={scenario === "loading"} aria-label={text("重读本地快照", "Refresh local snapshot")} onClick={() => setView((previous) => ({
        ...previous,
        readAt: pmClock,
        readSequence: previous.readSequence + 1,
    }))}>
          <RefreshCw aria-hidden="true"/>
        </Button>
      </div>)}</>}
toolbar={null}

feedback={<>
{surface.feedback}
    {missingScope && (<p role="alert" className={d2.missingScope}>
          {text("所选项目已不可用；保留筛选与选择，不将旧任务视为当前项目。", "The selected project is unavailable. Filters and selection are retained; old issues are not treated as an available project.")}{" "}
          <Button variant="outline" onClick={() => focusScope("all")}>
            {text("查看所有项目", "View all projects")}
          </Button>
        </p>)}
</>}
createDialog={(<>
<Dialog open={details.projectId !== null} onOpenChange={(open) => {
        if (!open)
            setDetails((previous) => ({ ...previous, projectId: null }));
    }}>
      <DialogContent className={d2.projectDialog} finalFocus={detailsTrigger} data-pm-dashboard2="project-dialog">
        {detailProject ? (<>
            <header className={d2.projectDialogHeader}>
              <DialogTitle>{detailProject.title[locale]}</DialogTitle>
              <DialogDescription>
                {detailProject.description[locale]}
              </DialogDescription>
            </header>
            <div className={d2.projectDialogGrid}>
              <Tabs value={details.tab} onValueChange={(tab) => {
            if (tab === "description" ||
                tab === "comments" ||
                tab === "settings")
                setDetails((previous) => ({ ...previous, tab }));
        }} className={d2.projectDialogTabs}>
                <TabsList aria-label={text("项目详情内容", "Project details sections")}>
                  <TabsTab value="description">
                    {text("描述", "Description")}
                  </TabsTab>
                  <TabsTab value="comments">
                    {text("评论", "Comment")}
                  </TabsTab>
                  <TabsTab value="settings">
                    {text("设置", "Setting")}
                  </TabsTab>
                </TabsList>
                <TabsPanel value="description">
                  <ProjectBriefSection project={detailProject}/>
                </TabsPanel>
                <TabsPanel value="comments">
                  <ProjectCommentsPanel projectId={detailProject.id} comments={projectComments(family, detailProject.id)} canMutate={!locked} onAppend={(comment) => {
            if (!locked)
                setFamily((previous) => appendProjectComment(previous, comment));
        }}/>
                </TabsPanel>
                <TabsPanel value="settings">
                  <ProjectMetadataPanel project={detailProject} scenario={scenario}/>
                </TabsPanel>
              </Tabs>
              <aside className={d2.projectDialogRail} aria-label={text("项目事实", "Project facts")}>
                <dl>
                  <div>
                    <dt>{text("状态", "State")}</dt>
                    <dd>
                      <Badge shape="pill" size="sm">
                        {detailProject.status === "active"
            ? text("进行中", "Active")
            : detailProject.status === "paused"
                ? text("暂停", "Paused")
                : text("已完成", "Completed")}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt>{text("截止日期", "Due date")}</dt>
                    <dd>
                      {detailProject.dueDate ? (<time dateTime={detailProject.dueDate}>
                          {detailProject.dueDate}
                        </time>) : (text("无截止日期", "No due date"))}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      {text("协作者 · 团队成员", "Collaborators · team memberships")}
                    </dt>
                    <dd className={d2.teamAvatars}>
                      {detailMembers.length
            ? detailMembers.map((member) => (<Avatar key={member.id} name={member.name} size={24}/>))
            : text("无已知成员", "No known members")}
                    </dd>
                  </div>
                </dl>
              </aside>
            </div>
            <footer className={d2.projectDialogFooter}>
              <span className={d2.caption}>
                {text("仅本地模拟；草稿保留", "Local simulation only · drafts retained")}
              </span>
              <div>
                <DialogClose render={<Button variant="outline"/>}>
                  {text("取消", "Cancel")}
                </DialogClose>
                <Button onClick={() => {
            setDetails((previous) => ({
                ...previous,
                projectId: null,
            }));
            navigate("project-detail-1", detailProject.id);
        }}>
                  {text("打开完整项目", "Open full project")}
                </Button>
              </div>
            </footer>
          </>) : (<header className={d2.projectDialogHeader}>
            <DialogTitle>
              {text("项目不可用", "Project unavailable")}
            </DialogTitle>
            <DialogDescription>
              {text("已选择的项目事实未知；不会替换成另一个项目。", "The selected project's facts are unknown; another project is never substituted.")}
            </DialogDescription>
          </header>)}
      </DialogContent>
    </Dialog>
</>)}
regions={{
metrics: (<>
<nav className={d2.quickActions} aria-label={text("项目管理快捷入口", "Project management shortcuts")}>
            {[
        {
            label: text("创建任务", "Create issue"),
            icon: ListPlus,
            slug: "issue-list-1",
        },
        {
            label: text("安排里程碑", "Schedule milestone"),
            icon: Flag,
            slug: "issue-calendar-1",
        },
        {
            label: text("规划迭代", "Plan sprint"),
            icon: CalendarDays,
            slug: "issue-kanban-1",
        },
        {
            label: text("添加项目", "Add project"),
            icon: Plus,
            slug: "project-list-1",
        },
    ].map((action) => (<Button key={action.slug} variant="outline" disabled={locked} title={text("打开对应的本地工作流；此入口不执行写入", "Open the corresponding local workflow; this shortcut does not perform a write")} onClick={() => navigate(action.slug)}>
                <span className={d2.actionIcon}>
                  <action.icon aria-hidden="true"/>
                </span>
                {action.label}
              </Button>))}
          </nav>
<section aria-label={text("窗口指标", "Window metrics")} className={d2.stats} data-pm-dashboard2="kpi-row">
            {stats.map((stat) => (<button key={stat.id} type="button" className={d2.statCard} aria-pressed={stat.pressed} onClick={stat.apply}>
                <span className={d2.statLabel}>{stat.label}<MoreHorizontal size={16} aria-hidden="true"/></span>
                <strong>{missingScope ? "—" : stat.value}</strong>
                <span className={d2.caption}>{stat.hint}</span>
              </button>))}
          </section>
</>),
timeline: (<section className={`${d2.panel} ${d2.schedule}`} aria-label={text("时间任务地图", "Time-Based Issue Map")} data-pm-dashboard2="schedule">
            <header className={d2.panelHeader}>
              <div>
                <h2>{text("时间任务地图", "Time-Based Issue Map")}</h2>
                <p className={d2.caption}>
                  {state.windowDays <= 14 ? text("活跃任务的周甘特摘要", "Weekly Gantt summary from active issues") : state.windowDays <= 28 ? text("活跃任务的月度路线图", "Monthly roadmap summary from active issues") : text("活跃任务的季度路线图", "Quarterly roadmap summary from active issues")}
                </p>
              </div>
              <Tabs value={state.windowDays} onValueChange={(value) => setWindow(value as Dashboard2WindowDays)}>
                <TabsList className={d2.rangeTabs} aria-label={text("时间窗口", "Issue map range")}>
                  {([
        { days: 14, zh: "周", en: "Week" },
        { days: 28, zh: "月", en: "Month" },
        { days: 84, zh: "季度", en: "Quarter" },
    ] as const).map((preset) => (<TabsTab key={preset.days} value={preset.days}>
                      {text(preset.zh, preset.en)}
                    </TabsTab>))}
                </TabsList>
              </Tabs>
            </header>
            <div className={d2.timeline} style={{ "--today-ratio": todayOffset } as CSSProperties}>
              <div className={d2.timelineAxis}>
                <time dateTime={viewport.rangeStart}>{shortDate.format(new Date(`${viewport.rangeStart}T00:00:00Z`))}</time>
                <span>{text("今日", "Today")}</span>
                <time dateTime={viewport.rangeEnd}>{shortDate.format(new Date(`${viewport.rangeEnd}T00:00:00Z`))}</time>
              </div>
              {visibleTimeline.length === 0 ? (<p className={d2.scheduleEmpty}>
                  {missingScope
            ? text("所选项目不可用，请返回所有项目查看已知排期。", "The selected project is unavailable. Return to all projects to inspect known schedules.")
            : text("此范围没有已排期的未完成任务。无到期日的任务单独保留。", "No scheduled open issues in this window. Undated issues remain available separately.")}
                </p>) : (visibleTimeline.map((issue) => {
                  const first = issue.startDate ?? issue.dueDate!;
                  const last = issue.dueDate ?? issue.startDate!;
                  const from = first < viewport.rangeStart ? viewport.rangeStart : first;
                  const to = last > viewport.rangeEnd ? viewport.rangeEnd : last;
                  const status = catalog.states.find((item) => item.id === issue.stateId);
                  return <TimelineRow key={issue.id} id={issue.id} sidebar={<span className={d2.timelineLabel} data-issue-state={issue.stateId}>
                    <span>{issue.identifier}</span>
                    <span>{status?.label}</span>
                  </span>}>
                    <button type="button" className={d2.timelineBar} data-issue-state={issue.stateId} style={{
                      left: `${scheduleDayDifference(from, viewport.rangeStart) / state.windowDays * 100}%`,
                      width: `${Math.max(1, scheduleDayDifference(to, from) + 1) / state.windowDays * 100}%`,
                    }} aria-label={`${issue.identifier}: ${issue.titleCopy[locale]} · ${status?.label} · ${first} → ${last}`} title={`${issue.identifier} · ${issue.titleCopy[locale]}\n${status?.label} · ${first} → ${last}`} onClick={() => navigate("issue-detail-1", issue.id)}>
                      <span className={d2.timelineAvatars}>{issue.assigneeIds.slice(0, 2).map((id) => {
                        const member = dashboardMember(id);
                        return member ? <Avatar key={id} name={member.name} size={24}/> : null;
                      })}</span>
                      <span className={d2.timelineBarCopy}>
                        <strong>{issue.identifier} · {issue.titleCopy[locale]}</strong>
                        <small>{status?.label} · {shortDate.format(new Date(`${first}T00:00:00Z`))} - {shortDate.format(new Date(`${last}T00:00:00Z`))}</small>
                      </span>
                    </button>
                  </TimelineRow>;
                }))}
            </div>
            <Popover>
              <PopoverTrigger render={<Button variant="ghost" size="icon" className={d2.scheduleOptions} aria-label={text("排期选项", "Schedule options")}/>}>
                <MoreHorizontal size={16} aria-hidden="true"/>
              </PopoverTrigger>
              <PopoverContent align="end" className={d2.scheduleMenu}>
                <Button variant="ghost" size="sm" onClick={() => drilldown("all", "unscheduled")}>{text("无到期日", "Unscheduled")} · {unscheduled.length}</Button>
                {timelineItems.length > 4 && <Button variant="ghost" size="sm" aria-expanded={view.allIssues} onClick={() => setView((previous) => ({ ...previous, allIssues: !previous.allIssues }))}>{view.allIssues ? text("收起", "Show less") : text(`全部 ${timelineItems.length} 项`, `All ${timelineItems.length} issues`)}</Button>}
                <p className={d2.caption}>{text("UTC 日期；窗口内到期任务单独统计。", "UTC dates; issues due in the window are counted separately.")}</p>
                <div className={d2.windowGroup}>{windowPresets.map((preset) => <Button key={preset.days} variant="ghost" aria-pressed={state.windowDays === preset.days} onClick={() => setWindow(preset.days)}>{preset.label}</Button>)}</div>
              </PopoverContent>
            </Popover>
          </section>),
cards: (<section aria-label={text("项目卡片", "Project cards")} data-pm-dashboard2="project-cards">
            <header className={d2.sectionHeader}>
              <h2>{text("当前项目", "Current Projects")}</h2>
              <div className={d2.projectActions}>
                {scopedProjects.length > 2 && <Button variant="ghost" size="icon" aria-expanded={view.allProjects} aria-label={view.allProjects ? text("收起项目", "Show fewer projects") : text(`查看全部 ${scopedProjects.length} 个项目`, `View all ${scopedProjects.length} projects`)} onClick={() => setView((previous) => ({ ...previous, allProjects: !previous.allProjects }))}><MoreHorizontal size={16} aria-hidden="true"/></Button>}
                <Button variant="outline" size="sm" disabled={locked} onClick={() => navigate("project-list-1")}>
                  <Plus size={16} aria-hidden="true"/>
                  {text("新建项目", "New Project")}
                </Button>
              </div>
            </header>
            <div className={d2.projectCards}>
              {visibleProjects.map((project) => {
        const owner = dashboardMember(project.ownerId);
        const memberships = people.memberships.filter((item) => item.teamId === project.teamId);
        const leadId = memberships.find((item) => item.role === "maintainer")?.memberId;
        const lead = leadId ? dashboardMember(leadId) : undefined;
        const team = memberships.flatMap((item) => {
            const member = dashboardMember(item.memberId);
            return member ? [member] : [];
        });
        return (<article key={project.id} className={d2.projectCard} data-project-card={project.id}>
                    <header className={d2.projectHeader}>
                      <span>
                        <Zap size={16} aria-hidden="true"/>
                        {project.identifier}
                      </span>
                      <Button variant="outline" size="sm" aria-label={`${text("查看项目详情", "See project details")}: ${project.identifier}`} onClick={(event) => {
                detailsTrigger.current = event.currentTarget;
                setDetails((previous) => ({
                    ...previous,
                    projectId: project.id,
                }));
            }}>
                        {text("查看详情", "See details")}
                      </Button>
                    </header>
                    <div className={d2.projectName}>
                      <p className={d2.caption}>
                        {text("项目名称", "Project Name")}
                      </p>
                      <div className={d2.projectTitle}>
                        <h3 title={project.title[locale]}>
                          {project.title[locale]}
                        </h3>
                        <Badge shape="pill" size="sm">
                          {project.status === "active"
                ? text("进行中", "Active")
                : project.status === "paused"
                    ? text("暂停", "Paused")
                    : text("已完成", "Completed")}
                        </Badge>
                      </div>
                    </div>
                    <div className={d2.projectPeople}>
                      <div>
                        <p className={d2.caption}>
                          {text("项目负责人", "Project Manager")}
                        </p>
                        {owner ? (<PmMemberIdentity member={owner}/>) : (<span className={d2.caption}>
                            {text("负责人不可用", "Owner unavailable")}
                          </span>)}
                      </div>
                      <div>
                        <p className={d2.caption}>
                          {text("团队主管", "Team Lead")}
                        </p>
                        {lead ? (<PmMemberIdentity member={lead}/>) : (<span className={d2.caption}>
                            {text("未记录", "Not recorded")}
                          </span>)}
                      </div>
                    </div>
                    <div>
                      <p className={d2.caption}>{text("团队", "Team")}</p>
                      <div className={d2.teamAvatars}>
                        {team.slice(0, 4).map((member) => (<Avatar key={member.id} name={member.name} size={24}/>))}
                        <span className={d2.caption}>
                          {team.length} {text("位本地成员", "local members")}
                        </span>
                      </div>
                    </div>
                    <footer className={d2.projectTimeline}>
                      <div>
                        <p className={d2.caption}>
                          {text("截止日期", "Timeline · due date")}
                        </p>
                        <span>
                          <CalendarDays size={16} aria-hidden="true"/>
                          {project.dueDate ? shortDate.format(new Date(`${project.dueDate}T00:00:00Z`)) + `, ${project.dueDate.slice(0, 4)}` : text("无排期", "Unscheduled")}
                        </span>
                      </div>
                    </footer>
                  </article>);
    })}
            </div>
          </section>),
distribution: (<div className={d2.lowerGrid}>
            <section className={`${d2.panel} ${d2.milestonePanel}`} aria-label={text("里程碑跟踪", "Milestone Tracker")}>
              <header className={d2.panelHeader}><h2>{text("里程碑跟踪", "Milestone Tracker")}</h2></header>
              <Tabs value={chartMonths} onValueChange={(value) => { setChartMonths(value as 1 | 3 | 6 | 12); setMilestoneMonth(null); }}>
                <TabsList className={d2.rangeTabs} aria-label={text("里程碑时间范围", "Milestone range")}>
                  {([1, 3, 6, 12] as const).map((months) => <TabsTab key={months} value={months}>{months === 12 ? text("1 年", "1 Year") : months === 1 ? text("1 个月", "1 Month") : months === 6 ? text("6 个月", "6 Month") : text("3 个月", "3 Months")}</TabsTab>)}
                </TabsList>
              </Tabs>
              {missingScope ? <p className={d2.caption}>{text("项目不可用；里程碑总数未知。", "Project unavailable; milestone totals are unknown.")}</p> : <>
                <div className={d2.milestoneChart} aria-label={text("按月显示未完成和已完成里程碑，选择查看详情", "Monthly open and completed milestones; select a month for details")}>
                  {milestoneBuckets.map((bucket) => <button key={bucket.id} type="button" className={d2.milestoneBucket} aria-pressed={milestoneMonth === bucket.id} aria-label={`${bucket.label}: ${text("未完成", "Open")} ${bucket.planned}, ${text("已完成", "Completed")} ${bucket.done}`} title={`${bucket.label} · ${text("未完成", "Open")}: ${bucket.planned} · ${text("已完成", "Completed")}: ${bucket.done}`} onClick={() => setMilestoneMonth(milestoneMonth === bucket.id ? null : bucket.id)}>
                    <span className={d2.milestoneBars}>
                      <i style={{ height: `${bucket.planned / milestoneMaximum * 100}%` }} data-series="open"/>
                      <i style={{ height: `${bucket.done / milestoneMaximum * 100}%` }} data-series="done"/>
                    </span>
                    <span>{bucket.label}</span>
                  </button>)}
                </div>
                {selectedMilestones && <div className={d2.milestoneDetails} role="status">
                  <strong>{selectedMilestones.label} · {selectedMilestones.items.length} {text("个里程碑", "milestones")}</strong>
                  {selectedMilestones.items.length === 0 ? <p>{text("本月无已知里程碑。", "No known milestones this month.")}</p> : selectedMilestones.items.map((milestone) => <Button key={milestone.id} variant="ghost" size="sm" onClick={() => { setDetails((previous) => ({ ...previous, projectId: milestone.projectId, tab: "description" })); }}>{milestone.title[locale]} · {milestone.dueDate}</Button>)}
                </div>}
              </>}
            </section>
            <section className={d2.panel} aria-label={text("便签", "Notes")}>
              <Dialog open={view.noteOpen} onOpenChange={(noteOpen) => setView((previous) => ({ ...previous, noteOpen }))}>
                <header className={d2.panelHeader}>
                  <h2>
                    <StickyNote size={16} aria-hidden="true"/>
                    {text("便签", "Notes")}
                  </h2>
                  <DialogTrigger render={<Button variant="outline" size="sm" disabled={locked} onClick={() => setState((previous) => ({
            ...previous,
            noteDraft: previous.noteDraft ?? {
                title: "",
                body: "",
            },
        }))}/>}>
                    <Plus size={16} aria-hidden="true"/>
                    {state.noteDraft
        ? text("继续草稿", "Resume draft")
        : text("添加便签", "Add Note")}
                  </DialogTrigger>
                </header>
                <ul className={d2.noteList}>
                  {state.notes.map((note) => (<li key={note.id} className={d2.noteItem}>
                      <button type="button" className={d2.noteCheck} aria-label={`${completedNotes.includes(note.id) ? text("重新打开", "Reopen") : text("完成", "Complete")}: ${note.title}`} aria-pressed={completedNotes.includes(note.id)} disabled={locked} onClick={() => setCompletedNotes((previous) => previous.includes(note.id) ? previous.filter((id) => id !== note.id) : [...previous, note.id])}>
                        {completedNotes.includes(note.id) ? <CheckCircle2 size={15} aria-hidden="true"/> : <Circle size={15} aria-hidden="true"/>}
                      </button>
                      <div>
                        <strong>{note.title}</strong>
                        <p className={d2.caption}>{note.body}</p>
                        <span className={d2.noteTag}>{note.tag}</span>
                      </div>
                      <time className={d2.caption} dateTime={note.at}>
                        <CalendarDays size={12} aria-hidden="true"/>{shortDate.format(new Date(`${note.at}T00:00:00Z`))}
                      </time>
                    </li>))}
                </ul>
                <DialogContent className={d2.noteDialog}>
                  <DialogTitle>{text("本地便签", "Local note")}</DialogTitle>
                  <DialogDescription>
                    {text("关闭或 Escape 保留草稿；只有明确保存才更新本地列表，不写入服务。", "Closing or Escape retains your draft. Only an explicit save updates the local list; no service write is made.")}
                  </DialogDescription>
                  {state.noteDraft && (<div className={d2.noteDraft}>
                      <Input aria-label={text("便签标题", "Note title")} placeholder={text("便签标题", "Note title")} value={state.noteDraft.title} disabled={locked} onChange={(event) => setState((previous) => ({
            ...previous,
            noteDraft: previous.noteDraft
                ? {
                    ...previous.noteDraft,
                    title: event.target.value,
                }
                : null,
        }))}/>
                      <Textarea aria-label={text("便签内容", "Note body")} placeholder={text("便签内容", "Note body")} value={state.noteDraft.body} disabled={locked} onChange={(event) => setState((previous) => ({
            ...previous,
            noteDraft: previous.noteDraft
                ? {
                    ...previous.noteDraft,
                    body: event.target.value,
                }
                : null,
        }))}/>
                      <div className={d2.noteActions}>
                        <Button disabled={locked || !state.noteDraft.title.trim()} onClick={() => {
            setState((previous) => saveDashboard2Note(previous, locked));
            setView((previous) => ({
                ...previous,
                noteOpen: false,
            }));
        }}>
                          {text("保存便签", "Save note")}
                        </Button>
                        <Button variant="ghost" disabled={locked} onClick={() => {
            setState(discardDashboard2Note);
            setView((previous) => ({
                ...previous,
                noteOpen: false,
            }));
        }}>
                          {text("丢弃草稿", "Discard draft")}
                        </Button>
                      </div>
                    </div>)}
                </DialogContent>
              </Dialog>
            </section>
          </div>),
issues: (<details ref={issueDetailsRef} className={d2.issueDetails} open={issuesExpanded} onToggle={(event) => setIssuesExpanded(event.currentTarget.open)} data-pm-dashboard2="issues">
            <summary>{text("任务明细", "Issue details")}<span className={d2.caption}>{rows.length} {text("项", "issues")} · {statusLabel}</span></summary>
            <div className={d2.issueDetailsBody}>
            <div className="flex flex-wrap items-center gap-2 py-3">
              <PmSearch label={text("搜索任务", "Search issues")} value={state.query} onChange={(query) => setState((previous) => ({ ...previous, query }))}/>
              <Popover>
                <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label={text("筛选任务", "Filter issues")} />}>
                  <SlidersHorizontal size={14} aria-hidden="true"/>{text("筛选", "Filter")}{activeFilterCount > 0 && ` (${activeFilterCount})`}
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[min(460px,calc(100vw-2rem))] p-0">
                  <FilterCard title={text("任务筛选", "Issue filters")} fields={filterFields} conditions={conditions} onChange={setConditions} emptyHint={text("尚未添加筛选条件，显示当前范围内的全部任务。", "No filter conditions yet; every issue in scope is shown.")} addLabel={text("添加条件", "Add filter")} clearLabel={text("清除条件", "Clear conditions")} whereLabel={text("条件", "Where")} andLabel={text("且", "and")} anyLabel={text("任一", "Any")} removeLabel={text("移除条件", "Remove filter")}/>
                </PopoverContent>
              </Popover>
              <span className={d2.caption}>{state.tableMode === "unscheduled" ? text("无到期日", "Unscheduled") : text("窗口内到期", "Due in window")} · {statusLabel} · {rows.length} {text("项", "issues")} · {state.selectedIds.length} {text("已选", "selected")}</span>
              <Button variant="ghost" onClick={() => { setConditions([]); drilldown("all") }} disabled={state.statusFilter === "all" &&
            !state.weekFilter && activeFilterCount === 0 &&
            state.tableMode === "scheduled"}>
                  {text("清除钻取", "Clear drilldown")}
                </Button>
            </div>
            <DataTable rows={missingScope ? [] : rows} getRowId={(issue) => issue.id} getRowLabel={(issue) => issue.identifier} caption={text("当前范围与窗口内的任务", "Issues in the current scope and window")} selectedIds={state.selectedIds} onSelectionChange={(selectedIds) => setState((previous) => ({ ...previous, selectedIds }))} sort={state.sort} onSortChange={(sort) => setState((previous) => ({ ...previous, sort }))} columns={[
        {
            id: "title",
            header: text("任务", "Issues"),
            sortable: true,
            primary: true,
            cell: (issue) => (<Button variant="ghost" className={d2.issueTitle} aria-label={`${text("打开任务", "Open issue")} ${issue.identifier}: ${issue.title}`} onClick={() => navigate("issue-detail-1", issue.id)}>
                      <span className={d2.identifier}>
                        {issue.identifier}
                      </span>
                      <span className={d2.issueText}>{issue.title}</span>
                    </Button>),
        },
        {
            id: "status",
            header: text("状态", "Status"),
            cell: (issue) => catalog.states.find((status) => status.id === issue.stateId)?.label,
        },
        {
            id: "priority",
            header: text("优先级", "Priority"),
            sortable: true,
            cell: (issue) => catalog.priorities.find((priority) => priority.id === issue.priorityId)?.label,
        },
        {
            id: "assignee",
            header: text("负责人", "Assignee"),
            cell: (issue) => issue.assigneeIds.length ? (issue.assigneeIds.map((id) => {
                const member = dashboardMember(id);
                return member ? (<PmMemberIdentity key={id} member={member}/>) : (id);
            })) : (<span className={d2.caption}>
                        {text("未分配", "No owner")}
                      </span>),
        },
        {
            id: "estimate",
            header: text("估点", "Estimate"),
            sortable: true,
            cell: (issue) => issue.estimate ?? text("未设定", "Not set"),
        },
        {
            id: "due",
            header: text("到期日", "Due date"),
            sortable: true,
            cell: (issue) => issue.dueDate ?? "—",
        },
    ]}/>
            </div>
          </details>),
rail: (<aside className={d2.rail} data-pm-dashboard2="rail" aria-label={text("概览辅助信息", "Dashboard supporting information")}>
          <section className={`${d2.panel} ${d2.activityPanel}`} aria-label={text("本地动态", "Local activity")}>
            <header className={d2.panelHeader}>
              <h2>
                <Activity size={18} aria-hidden="true"/>
                {text("动态", "Activity")}
              </h2>
            </header>
            {localActivity.length === 0 && issueDomain.activity.length === 0 ? (<p className={d2.activityEmpty}>
                {text("本场景尚无已确认的本地更新。", "No confirmed local updates in this scene yet.")}
              </p>) : (<ul className={d2.activityList}>
                {issueDomain.activity.slice(-3).reverse().map((entry) => <li key={entry.id} className={d2.activityItem}>
                  <Avatar name={text("本地更新", "Local update")} size={32}/>
                  <div><Button variant="ghost" className={d2.activityLink} onClick={() => navigate("issue-detail-1", entry.itemId)}>{entry.description[locale]}</Button><p className={d2.caption}>{entry.itemId}</p><time className={d2.caption} dateTime={entry.at}>{entry.at.slice(11, 16)} UTC</time></div>
                </li>)}
                {localActivity.slice(0, Math.max(0, 3 - issueDomain.activity.length)).map((entry) => {
                  const actor = entry.actorId ? dashboardMember(entry.actorId) : null;
                  return <li key={entry.id} className={d2.activityItem}>
                    <Avatar name={actor?.name ?? text("本地更新", "Local update")} size={32}/>
                    <div><Button variant="ghost" className={d2.activityLink} onClick={() => navigate("project-detail-1", entry.projectId)}>{actor?.name && <strong>{actor.name}</strong>}{entry.title[locale]}</Button><p className={d2.caption}>{entry.detail?.[locale] ?? projects.find((project) => project.id === entry.projectId)?.title[locale]}</p><time className={d2.caption} dateTime={entry.at}>{shortDate.format(new Date(entry.at))} · {entry.at.slice(11, 16)} UTC</time></div>
                  </li>;
                })}
              </ul>)}
            <Button className={d2.railAction} variant="outline" onClick={() => navigate("inbox-1")}>
              {text("打开动态日志", "Open activity log")}
              <ArrowRight size={16} aria-hidden="true"/>
            </Button>
          </section>
          <section className={d2.panel} aria-label={text("概览成员", "Dashboard members")}>
            <header className={d2.panelHeader}>
              <h2>
                {text("成员", "Members")}{" "}
                <span className={d2.memberCount}>{members.length}</span>
              </h2>
            </header>
            <div className={d2.memberGrid}>
              {members.map((member) => (<Avatar key={member.id} name={member.name} size={32}/>))}
            </div>
            <Button className={d2.railAction} variant="outline" onClick={() => navigate("member-list-1")}>
              {text("管理成员", "Manage members")}
              <ArrowRight size={16} aria-hidden="true"/>
            </Button>
          </section>
          <section className={`${d2.panel} ${d2.statusPanel}`} aria-label={text("任务状态", "Issue Status")} data-pm-dashboard2="status-distribution">
            <header className={d2.panelHeader}>
              <h2>{text("任务状态", "Issue Status")}</h2>
            </header>
            <p className={d2.caption}>
              {missingScope
        ? text("项目不可用；状态分布未知。", "Project unavailable; status distribution is unknown.")
        : `${scheduled.length} ${text("项任务分布在活跃状态中", "issues distributed across active statuses")}`}
            </p>
            <div className={d2.statusTrack} aria-hidden="true">
              {catalog.states.map((status) => (<span key={status.id} style={{
            flex: statusCounts[status.id] ?? 0,
            background: status.color,
        }}/>))}
            </div>
            <ul className={d2.statusList}>
              {catalog.states.map((status) => (<li key={status.id}>
                  <Button variant="ghost" disabled={missingScope} aria-pressed={state.statusFilter === status.id} aria-label={`${status.label}: ${missingScope ? "—" : (statusCounts[status.id] ?? 0)} ${text("项任务", "issues")}`} onClick={() => drilldown(state.statusFilter === status.id ? "all" : status.id)}>
                    <span>
                      <i style={{ background: status.color }} aria-hidden="true"/>
                      {status.label}
                    </span>
                    <strong>
                      {missingScope ? "—" : (statusCounts[status.id] ?? 0)}
                    </strong>
                  </Button>
                </li>))}
            </ul>
          </section>
        </aside>),
projects: (null),
currentProject: (null),
activity: (null)
}} />
}
