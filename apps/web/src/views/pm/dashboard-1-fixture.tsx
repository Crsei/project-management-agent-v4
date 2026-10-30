import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react"
import { Bell, ChevronDown, Timer, FilePlus2, Pause, Pencil, Play, RotateCcw, UserRoundCheck, Video, Info, SlidersHorizontal, MoreHorizontal, Flag, CalendarDays, Tag } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Avatar } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { FilterCard, type FilterCondition, type FilterField } from "@/components/blocks/filter-card"
import { DataTable } from "@/components/blocks/data-table"
import { DashboardGrid, DashboardWidget } from "@/components/blocks/dashboard/dashboard"
import { useI18n } from "@/lib/i18n-provider"
import { PmSearch, PmMemberIdentity, usePmScenarioState } from "./shared"
import { pmClock, type PmPageProps } from "./model"
import { dashboardMembers, dashboardStates, dashboardCatalog, dashboardAvatarSources } from "./dashboard-1-fixtures"
import { useDashboardState, dashboardIssues, dashboardLogs, openDashboardDraft, submitDashboardDraft, checkDashboardResult, formatTimer, type DashboardScope, type FixtureOutcome } from "./dashboard-1-controller"
import { usePmProjectDomain } from "./dashboards-views"
import { useIssueDomain } from "./use-issue-domain"
import { usePeopleDomain } from "./use-people-domain"
import { DashboardView } from "./dashboard"
import { useFixtureDashboardSurface } from "./dashboard-fixture-surface"
import d1 from "./dashboard-1.module.css"

function PersonalPicker({ label, value, options, onChange, disabled = false, }: {
    label: string;
    value: string;
    options: {
        value: string;
        label: string;
    }[];
    onChange: (value: string) => void;
    disabled?: boolean;
}) {
    return (<Select value={value} items={options} disabled={disabled} onValueChange={(next) => {
            if (next !== null)
                onChange(next);
        }}>
      <SelectTrigger aria-label={label} className={d1.picker}>
        <SelectValue />
        <ChevronDown size={16} aria-hidden="true"/>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (<SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>))}
      </SelectContent>
    </Select>);
}
function closeDisclosure(event: KeyboardEvent<HTMLDetailsElement>) {
    if (event.key !== "Escape" || event.defaultPrevented)
        return;
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
    event.stopPropagation();
}
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
function PersonalSectionTitle({ children }: {
    children: ReactNode;
}) {
    return <h2 className={d1.sectionTitle}>{children}</h2>;
}
export function PersonalDashboardFixture({ scenario }: PmPageProps) {
const { locale } = useI18n();
const en = locale === "en";
const text = (zh: string, english: string) => (en ? english : zh);
const [state, setState] = useDashboardState(scenario);
const [agendaScroll, setAgendaScroll] = usePmScenarioState("dashboard-1-agenda-reading", () => 0);
const agendaRef = useRef<HTMLElement>(null);
const [conditions, setConditions] = usePmScenarioState<FilterCondition[]>("dashboard-1-issue-filters", () => []);
useLayoutEffect(() => {
    if (agendaRef.current)
        agendaRef.current.scrollTop = agendaScroll;
}, [agendaScroll]);
const readonly = scenario === "readonly";
const issueFilterToday = pmClock.slice(0, 10);
const issueFilterWeekEnd = new Date(Date.parse(`${issueFilterToday}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
const filteredIssues = state.issues.filter((issue) => conditions.every((condition) => matchesIssueFilter(issue, condition, issueFilterToday, issueFilterWeekEnd)));
const activeFilterCount = conditions.filter((condition) => condition.values.length > 0).length;
const items = dashboardIssues({ ...state, issues: filteredIssues }, locale);
const logs = dashboardLogs(state);
const minutes = logs.reduce((total, log) => total + log.minutes, 0);
const chartSamples = logs.flatMap(log => log.samples);
const maxSampleMinutes = Math.max(...chartSamples, 1);
const catalog = dashboardCatalog(locale);
const scopeLabels: {
    value: DashboardScope;
    label: string;
}[] = [
    { value: "overview", label: text("概览", "Overview") },
    { value: "assigned", label: text("分配给我", "Assigned to me") },
    { value: "reported", label: text("由我创建", "Reported by me") },
    { value: "watching", label: text("我关注的", "Watching") },
    { value: "updates", label: text("本地更新", "Updates") },
];
useEffect(() => {
    if (!state.timer.running || readonly || scenario === "loading")
        return;
    const timer = window.setInterval(() => setState((previous) => ({
        ...previous,
        timer: { ...previous.timer, seconds: previous.timer.seconds + 1 },
    })), 1000);
    return () => window.clearInterval(timer);
}, [state.timer.running, readonly, scenario, setState]);
function drill(scope: DashboardScope, statusFilter = "all") {
    setState((previous) => ({
        ...previous,
        scope,
        statusFilter,
        query: "",
        selectedDay: null,
    }));
}
function inspectIssue(id: string) {
    setState((previous) => openDashboardDraft(previous, id));
}
const draft = state.dialog ? state.drafts[state.dialog] : undefined;
const locked = readonly || draft?.result === "unknown";
const activeIssue = state.issues.find((issue) => issue.id === state.dialog);
const timeLabel = (value: string) => new Intl.DateTimeFormat(locale, {
    timeZone: state.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
}).format(new Date(value));
const stats = [
    {
        scope: "reported" as const,
        icon: FilePlus2,
        title: text("创建的任务", "Issues created"),
        count: filteredIssues.filter((issue) => issue.createdByMe).length,
    },
    {
        scope: "assigned" as const,
        icon: UserRoundCheck,
        title: text("分配的任务", "Issues assigned"),
        count: filteredIssues.filter((issue) => issue.assignedToMe).length,
    },
    {
        scope: "watching" as const,
        icon: Bell,
        title: text("关注的任务", "Issues subscribed"),
        count: filteredIssues.filter((issue) => issue.watching).length,
    },
];
const fixtureProjects = usePmProjectDomain(scenario)
const [fixtureIssueDomain] = useIssueDomain(scenario)
const [fixturePeople] = usePeopleDomain(scenario)
const surface = useFixtureDashboardSurface(scenario, "dashboard1", fixtureProjects, fixtureIssueDomain.items, fixturePeople)
const issueProjectOptions = [...new Set(state.issues.map((issue) => issue.projectId))].map((id) => ({ value: id, label: fixtureProjects.find((project) => project.id === id)?.title[locale] ?? (id === "roadmap" ? text("路线图", "Roadmap") : id) }));
const filterFields: FilterField[] = [
    { id: "status", label: text("状态", "Status"), options: dashboardStates.map((status) => ({ value: status.id, label: status.label[locale] })) },
    { id: "priority", label: text("优先级", "Priority"), options: catalog.priorities.map((priority) => ({ value: priority.id, label: priority.label })) },
    { id: "assignee", label: text("负责人", "Assignee"), options: [...catalog.assignees.map((assignee) => ({ value: assignee.id, label: assignee.label })), { value: "unassigned", label: text("未分配", "Unassigned") }] },
    ...(issueProjectOptions.length ? [{ id: "project", label: text("项目", "Project"), options: issueProjectOptions }] : []),
    { id: "due", label: text("截止日期", "Due date"), options: [
        { value: "overdue", label: text("已逾期", "Overdue") },
        { value: "today", label: text("今天到期", "Due today") },
        { value: "week", label: text("未来 7 天", "Next 7 days") },
        { value: "later", label: text("更晚", "Later") },
        { value: "none", label: text("无到期日", "No due date") },
    ] },
];
useLayoutEffect(() => {
    const page = document.querySelector<HTMLElement>('[data-pm-page="pm-dashboard-1"]');
    if (!page)
        return;
    const narrow = window.matchMedia("(max-width: 767px)");
    if (narrow.matches)
        page.scrollTop = surface.readingPosition ?? 0;
    const retainReadingPosition = () => {
        if (narrow.matches)
            surface.onReadingPositionChange?.(page.scrollTop);
    };
    page.addEventListener("scroll", retainReadingPosition, { passive: true });
    return () => page.removeEventListener("scroll", retainReadingPosition);
}, [surface.readingPosition, surface.onReadingPositionChange]);

return <DashboardView {...surface}
readModel={{ ...surface.readModel, title: (text("我的工作区", "My workspace")), issues: scenario === "loading" ? [] : items.map(item => ({ ...item, version: `fixture:${item.revision}`, moduleIds: [], cycleId: null, estimatePointId: null })),
catalog: { ...catalog, projects: [], modules: [], cycles: [], estimatePoints: [] },
stateCounts: dashboardStates.map(status => ({ id: status.id, label: status.label[locale], count: { value: filteredIssues.filter(issue => issue.createdByMe && issue.stateId === status.id).length, description: text("由我创建的任务", "Issues reported by me") } })),
counts: { ...surface.readModel.counts, issues: { value: scenario === "loading" ? null : filteredIssues.length, description: text("显式个人场景计数", "Explicit personal fixture count") }, completed: { value: scenario === "loading" ? null : filteredIssues.filter(issue => issue.stateId === "done").length, description: text("显式个人场景计数", "Explicit personal fixture count") } },
data: { ...surface.readModel.data, emptyDescription: (text("当前本地场景没有任务。请选择其他场景查看示例。", "This local scene has no issues. Choose another scene to inspect the examples.")) } }}
headerActions={<>{(readonly ? <Badge>{text("只读", "Read only")}</Badge> : undefined)}</>}
toolbar={(<nav aria-label={text("工作区视图", "Workspace views")} className={d1.navigation}>
        {scopeLabels.map((scope) => (<Button key={scope.value} variant="ghost" aria-pressed={state.scope === scope.value} onClick={() => drill(scope.value)}>
            {scope.label}
          </Button>))}
      </nav>)}


createDialog={(<>
<Dialog open={Boolean(state.dialog)} onOpenChange={(open) => {
        if (!open)
            setState((previous) => ({ ...previous, dialog: null }));
    }}>
      <DialogContent>
        {draft && state.dialog && (<>
            <DialogTitle>
              {state.dialog === "profile"
            ? text("个人信息 · 本地编辑", "Profile · local edit")
            : `${activeIssue?.identifier} · ${text("任务详情", "Issue details")}`}
            </DialogTitle>
            <DialogDescription>
              {readonly
            ? text("当前场景只读，允许查看详情。", "This scene is read only; inspection is available.")
            : text("修改只应用到内存；取消会保留草稿。", "Changes apply only in memory; cancelling retains your draft.")}
            </DialogDescription>
            {activeIssue && (<p className={d1.caption}>
                {text("任务标题", "Issue title")}:{" "}
                {activeIssue.titleCopy[locale]}
              </p>)}
            <form className={d1.form} onSubmit={(event) => {
            event.preventDefault();
            const key = state.dialog;
            if (key)
                setState((previous) => submitDashboardDraft(previous, key, readonly));
        }}>
              <label>
                {state.dialog === "profile"
            ? text("名称", "Name")
            : text("标题", "Title")}
                <Input value={draft.title} disabled={locked} aria-invalid={draft.error === "required"} onChange={(event) => {
            const title = event.target.value;
            const key = state.dialog!;
            setState((previous) => ({
                ...previous,
                drafts: {
                    ...previous.drafts,
                    [key]: {
                        ...previous.drafts[key],
                        title,
                        error: null,
                    },
                },
            }));
        }}/>
              </label>
              {state.dialog === "profile" ? (<label>
                  {text("电子邮件", "Email")}
                  <Input type="email" value={draft.email} disabled={locked} aria-invalid={draft.error === "email"} onChange={(event) => {
                const email = event.target.value;
                const key = state.dialog!;
                setState((previous) => ({
                    ...previous,
                    drafts: {
                        ...previous.drafts,
                        [key]: {
                            ...previous.drafts[key],
                            email,
                            error: null,
                        },
                    },
                }));
            }}/>
                </label>) : (<label>
                  {text("状态", "Status")}
                  <PersonalPicker label={text("编辑任务状态", "Edit issue status")} value={draft.status} disabled={locked} options={dashboardStates.map((status) => ({
                value: status.id,
                label: status.label[locale],
            }))} onChange={(status) => {
                const key = state.dialog!;
                setState((previous) => ({
                    ...previous,
                    drafts: {
                        ...previous.drafts,
                        [key]: { ...previous.drafts[key], status },
                    },
                }));
            }}/>
                </label>)}
              {!readonly && (<label>
                  {text("本地 fixture 结果", "Local fixture outcome")}
                  <PersonalPicker label={text("本地 fixture 结果", "Local fixture outcome")} value={draft.outcome} disabled={locked} options={[
                {
                    value: "confirmed",
                    label: text("确认", "Confirmed"),
                },
                { value: "rejected", label: text("拒绝", "Rejected") },
                {
                    value: "unknown",
                    label: text("结果未知", "Unknown"),
                },
            ]} onChange={(outcome) => {
                const key = state.dialog!;
                setState((previous) => ({
                    ...previous,
                    drafts: {
                        ...previous.drafts,
                        [key]: {
                            ...previous.drafts[key],
                            outcome: outcome as FixtureOutcome,
                        },
                    },
                }));
            }}/>
                </label>)}
              {draft.error && (<p role="alert" className={d1.error}>
                  {draft.error === "email"
                ? text("请输入有效的电子邮件。", "Enter a valid email.")
                : text("标题或名称不能为空。", "Title or name cannot be empty.")}
                </p>)}
              {draft.result === "rejected" && (<p role="alert" className={d1.error}>
                  {text("模拟请求被拒绝，集合未改动；草稿保留，可修改后重试。", "Simulated request rejected; collection unchanged. Draft retained for revision and retry.")}{" "}
                  <code>{draft.requestId}</code>
                </p>)}
              {draft.result === "unknown" && (<div className={d1.unknown} role="status">
                  <p>
                    {text("结果未知，草稿与请求身份已保留。禁止重复提交；请显式检查模拟结果。", "Result unknown; draft and request identity retained. Resubmission blocked; explicitly check the simulated result.")}
                  </p>
                  <code>{draft.requestId}</code>
                  <PersonalPicker label={text("模拟检查结果", "Simulated check result")} value={draft.checkOutcome} disabled={readonly} options={[
                {
                    value: "confirmed",
                    label: text("确认原请求", "Confirm original request"),
                },
                {
                    value: "rejected",
                    label: text("拒绝原请求", "Reject original request"),
                },
            ]} onChange={(checkOutcome) => {
                const key = state.dialog!;
                setState((previous) => ({
                    ...previous,
                    drafts: {
                        ...previous.drafts,
                        [key]: {
                            ...previous.drafts[key],
                            checkOutcome: checkOutcome as "confirmed" | "rejected",
                        },
                    },
                }));
            }}/>
                  <Button type="button" variant="secondary" disabled={readonly} onClick={() => {
                const key = state.dialog!;
                setState((previous) => checkDashboardResult(previous, key, readonly));
            }}>
                    {text("检查模拟结果", "Check simulated result")}
                  </Button>
                </div>)}
              <div className={d1.formActions}>
                <Button type="button" variant="ghost" disabled={locked} onClick={() => {
            const key = state.dialog!;
            setState((previous) => {
                const drafts = { ...previous.drafts };
                delete drafts[key];
                return {
                    ...previous,
                    drafts,
                    dialog: null,
                    notice: "discarded",
                };
            });
        }}>
                  {text("丢弃草稿", "Discard draft")}
                </Button>
                <Button type="button" variant="outline" onClick={() => setState((previous) => ({ ...previous, dialog: null }))}>
                  {text("取消并保留", "Cancel and retain")}
                </Button>
                {!readonly && (<Button type="submit" disabled={locked}>
                    {text("应用本地修改", "Apply local change")}
                  </Button>)}
              </div>
            </form>
          </>)}
      </DialogContent>
    </Dialog>
</>)}
regions={{
metrics: (<section aria-label={text("个人任务统计", "Personal issue statistics")}>
            <PersonalSectionTitle>{text("概览", "Overview")}</PersonalSectionTitle>
            <div className={d1.stats}>
              {stats.map((stat) => (<Button key={stat.scope} variant="outline" className={d1.stat} aria-label={`${stat.title}: ${stat.count}`} aria-pressed={state.scope === stat.scope} onClick={() => drill(stat.scope)}>
                  <span className={d1.statIcon}>
                    <stat.icon size={20} strokeWidth={1.75} aria-hidden="true"/>
                  </span>
                  <span>
                    <span className={d1.muted}>{stat.title}</span>
                    <strong className={d1.statNumber}>
                      {stat.count}
                    </strong>
                  </span>
                </Button>))}
            </div>
          </section>),
distribution: (<section aria-label={text("任务状态统计", "Issue status statistics")}>
            <PersonalSectionTitle>{text("任务状态", "Issue status")}</PersonalSectionTitle>
            <div className={d1.statusStats}>
              {dashboardStates.map((status) => (<Button key={status.id} variant="outline" className={d1.statusStat} aria-pressed={state.statusFilter === status.id} onClick={() => drill("reported", status.id)}>
                  <span className={d1.statusLabel}>
                    <span className={d1.dot} style={{ background: status.color }}/>
                    <span>{status.label[locale]}</span>
                  </span>
                  <strong className={d1.statNumber}>
                    {filteredIssues.filter((issue) => issue.createdByMe && issue.stateId === status.id).length}
                  </strong>
                </Button>))}
            </div>
            <p className="sr-only">
              {text("状态统计范围：由我创建的任务。点击指标查看相同集合。", "Status counts cover issues reported by me. Select a metric to inspect that collection.")}
            </p>
          </section>),
timeline: (<DashboardGrid>
            <DashboardWidget id="pm-dashboard-1-work-hours" title={text("工时分析", "Work Hour Analysis")} width={8}>
              <PersonalSectionTitle>
                {text("工时分析", "Work Hour Analysis")}
              </PersonalSectionTitle>
              <div className={d1.widgetCard}>
              <div className={d1.total}>
                <Timer size={20} aria-hidden="true"/>
                <div>
                  <p className={d1.caption}>
                    {text("总工时", "Total Work")}
                  </p>
                  <strong>
                    {Math.floor(minutes / 60)} {text("小时", "hours")} ·{" "}
                    {minutes % 60} {text("分钟", "mins")}
                  </strong>
                </div>
              </div>
              <div className={d1.periods} role="group" aria-label={text("工时时间范围", "Work hour period")}>
                {[
        { days: 5, label: "5D" },
        { days: 14, label: "2W" },
        { days: 30, label: "1M" },
        { days: 180, label: "6M" },
        { days: 365, label: "1Y" },
    ].map((period) => (<Button key={period.days} variant={state.period === period.days ? "secondary" : "ghost"} aria-pressed={state.period === period.days} onClick={() => setState((previous) => ({
            ...previous,
            period: period.days,
            selectedDay: null,
        }))}>
                    {period.label}
                  </Button>))}
              </div>
              <svg className={d1.chart} viewBox="0 0 600 120" preserveAspectRatio="none" role="img" aria-label={text(`工时折线图，共 ${minutes} 分钟。使用“工作日期”控件查看明细。`, `Work hour line chart, ${minutes} minutes. Use the Work dates control to inspect details.`)}>
                {[8, 62, 116].map((y) => (<line key={y} x1="0" x2="600" y1={y} y2={y} className={d1.gridLine}/>))}
                {chartSamples.length > 0 && (<polyline points={chartSamples
            .map((sample, index) => `${(index * 600) / Math.max(1, chartSamples.length - 1)},${116 - (sample / maxSampleMinutes) * 90}`)
            .join(" ")} className={d1.line}/>)}
              </svg>
              <details className={d1.chartControls} onKeyDown={closeDisclosure}>
                <summary title={text("工作日期", "Work dates")}><SlidersHorizontal size={13} aria-hidden="true"/><span className="sr-only">{text("工作日期", "Work dates")}</span></summary>
              <div className={d1.datePicker}>
                <PersonalPicker label={text("按工作日期钻取", "Drill down by work date")} value={state.selectedDay ?? "all"} options={[
        {
            value: "all",
            label: text("全部工作日期", "All work dates"),
        },
        ...logs.map((log) => ({
            value: log.date,
            label: `${log.date} · ${log.minutes} ${text("分钟", "mins")}`,
        })),
    ]} onChange={(value) => setState((previous) => ({
        ...previous,
        selectedDay: value === "all" ? null : value,
        scope: "reported",
        statusFilter: "all",
        query: "",
    }))}/>
              </div>
              </details>
              <p className={d1.chartNote} title={text(`额外工时：${logs.reduce((total, log) => total + log.extraMinutes, 0)} 分钟。`, `Extra work: ${logs.reduce((total, log) => total + log.extraMinutes, 0)} minutes.`)}>
                <Info size={12} aria-hidden="true"/>
                {text("总工时包含额外工时。", "Total work hours include extra hours.")}
                {state.period > 30 && <span>{text("仅有最近 30 天的本地记录。", "Only 30 days of local records are available.")}</span>}
              </p>
              {state.selectedDay && (<p className={d1.caption}>
                  {state.selectedDay} ·{" "}
                  {logs
            .filter((log) => log.date === state.selectedDay)
            .reduce((sum, log) => sum + log.minutes, 0)}{" "}
                  {text("分钟，任务明细见下方。", "minutes; related issues below.")}
                </p>)}
              </div>
            </DashboardWidget>
            <DashboardWidget id="pm-dashboard-1-timer" title={text("时间追踪", "Time Tracker")} width={4}>
              <PersonalSectionTitle>{text("时间追踪", "Time Tracker")}</PersonalSectionTitle>
              <div className={d1.widgetCard}>
              <PersonalPicker label={text("计时任务", "Tracked issue")} value={state.timer.issueId} disabled={readonly || state.timer.running || state.issues.length === 0} options={state.issues.map((issue) => ({
        value: issue.id,
        label: `${issue.identifier} ${issue.titleCopy[locale]}`,
    }))} onChange={(issueId) => setState((previous) => ({
        ...previous,
        timer: { ...previous.timer, issueId },
    }))}/>
              <div className={d1.timer} data-timer-state={state.timer.running
        ? "running"
        : state.timer.started
            ? "paused"
            : "awaiting"}>
                <p className={d1.caption}>
                  {state.timer.running
        ? text("计时中", "Running")
        : state.timer.started
            ? text("已暂停", "Paused")
            : text("等待开始", "Awaiting")}
                </p>
                <output aria-label={text("模拟已用时间", "Simulated elapsed time")} className={d1.timerDigits}>
                  {formatTimer(state.timer.seconds)}
                </output>
                <div className={d1.timerActions}>
                  <Button variant="ghost" disabled={readonly || !state.timer.issueId} onClick={() => setState((previous) => ({
        ...previous,
        timer: {
            ...previous.timer,
            running: !previous.timer.running,
            started: true,
        },
    }))}>
                    {state.timer.running ? (<Pause size={16} aria-hidden="true"/>) : (<Play size={16} aria-hidden="true"/>)}
                    {state.timer.running
        ? text("暂停", "Pause")
        : text("开始", "Start")}
                  </Button>
                  <Button variant="ghost" size="icon" disabled={readonly || !state.timer.started} aria-label={text("重置模拟计时器", "Reset simulated time tracker")} onClick={() => setState((previous) => ({
        ...previous,
        timer: {
            ...previous.timer,
            seconds: 0,
            running: false,
            started: false,
        },
    }))}>
                    <RotateCcw size={16} aria-hidden="true"/>
                  </Button>
                </div>
              </div>
              <p className={d1.simulationNote} title={text("离开页面不累计，不写入工时记录。", "No accrual while away and no work log writes.")}>
                <Info size={10} aria-hidden="true"/>{text("本地模拟", "Local simulation")}
              </p>
              </div>
            </DashboardWidget>
          </DashboardGrid>),
issues: (<>
<section aria-label={text("我的任务", "My issues")} data-dashboard-issues className={d1.issues}>
            <PersonalSectionTitle>{text("我的任务", "My issues")}</PersonalSectionTitle>
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
              <span className={d1.caption}>{scopeLabels.find((scope) => scope.value === state.scope)?.label} · {items.length} {text("项", "issues")} · {state.selectedIds.length} {text("已选", "selected")}</span>
              <Button variant="ghost" onClick={() => { setConditions([]); setState((previous) => ({
            ...previous,
            scope: "overview",
            query: "",
            statusFilter: "all",
            selectedDay: null,
            selectedIds: [],
            sort: null,
        })); }}>
                {text("清除筛选", "Clear filters")}
              </Button>
            </div>
            <DataTable className={d1.issueTable} columnConfig={{ widths: { title: 388, status: 144, priority: 128, assignee: 176, labels: 224, due: 160, actions: 44 } }} rows={items} getRowId={(issue) => issue.id} getRowLabel={(issue) => issue.identifier} caption={text("当前筛选的任务", "Issues in current filter")} selectedIds={state.selectedIds} onSelectionChange={(selectedIds) => setState((previous) => ({ ...previous, selectedIds }))} activeRowId={state.selectedIssueId} sort={state.sort} onSortChange={(sort) => setState((previous) => ({ ...previous, sort }))} columns={[
        {
            id: "title",
            header: text("任务", "Issues"),
            minWidth: 388,
            sortable: true,
            cell: (issue) => (<Button variant="ghost" className={d1.issueTitle} title={issue.title} aria-label={`${text("查看", "Inspect")} ${issue.identifier}: ${issue.title}`} onClick={() => inspectIssue(issue.id)}>
                      <span className={d1.identifier}>
                        {issue.identifier}
                      </span>
                      <span className={d1.issueText}>{issue.title}</span>
                    </Button>),
        },
        {
            id: "status",
            header: text("状态", "Status"),
            minWidth: 144,
            cell: (issue) => (<span className={d1.statusBadge} data-status={issue.stateId}>
                      <span className={d1.dot} style={{ background: dashboardStates.find(status => status.id === issue.stateId)?.color }}/>
                      {catalog.states.find((status) => status.id === issue.stateId)?.label}
                    </span>),
        },
        {
            id: "priority",
            header: text("优先级", "Priority"),
            minWidth: 128,
            sortable: true,
            cell: (issue) => <span className={d1.priority}><Flag size={13} aria-hidden="true"/>{catalog.priorities.find((priority) => priority.id === issue.priorityId)?.label}</span>,
        },
        {
            id: "assignee",
            header: text("负责人", "Assignee"),
            minWidth: 176,
            cell: (issue) => issue.assigneeIds.length ? (issue.assigneeIds.map((id) => {
                const member = dashboardMembers.find((person) => person.id === id);
                return member ? (<span key={id} className={d1.memberIdentity}><Avatar name={member.name} src={dashboardAvatarSources[id]} size={24}/><span>{member.name}</span></span>) : (id);
            })) : (<span className={d1.muted}>
                        {text("未分配", "No owner")}
                      </span>),
        },
        {
            id: "labels",
            header: text("标签", "Labels"),
            minWidth: 224,
            cell: (issue) => (<div className={d1.labels}>
                      {issue.labelIds.map((id) => (<Badge key={id}><Tag size={12} aria-hidden="true"/>{id}</Badge>))}
                    </div>),
        },
        {
            id: "due",
            header: text("截止日期", "Due date"),
            minWidth: 160,
            sortable: true,
            cell: (issue) => issue.dueDate ?? "—",
        },
        {
            id: "actions",
            minWidth: 44,
            header: <span className="sr-only">{text("操作", "Actions")}</span>,
            cell: (issue) => (<Button variant="ghost" size="icon" aria-label={`${text("查看任务操作", "Open actions for")} ${issue.identifier}`} onClick={() => inspectIssue(issue.id)}>
                      <MoreHorizontal size={16} aria-hidden="true"/>
                    </Button>),
        },
    ]}/>
            <div className={d1.mobileIssues}>
              {items.length === 0 && <p className={d1.caption}>{text("当前筛选下没有任务。", "No issues match this filter.")}</p>}
              {items.map(issue => <article key={issue.id} className={d1.mobileIssue}>
                <div className={d1.mobileIssueHeading}>
                  <Button variant="ghost" className={d1.issueTitle} onClick={() => inspectIssue(issue.id)} title={issue.title}><span className={d1.identifier}>{issue.identifier}</span><span className={d1.issueText}>{issue.title}</span></Button>
                  <Button variant="ghost" size="icon" aria-label={`${text("查看任务操作", "Open actions for")} ${issue.identifier}`} onClick={() => inspectIssue(issue.id)}><MoreHorizontal size={16} aria-hidden="true"/></Button>
                </div>
                <div className={d1.mobileIssueProperties}>
                  <span className={d1.statusBadge} data-status={issue.stateId}><span className={d1.dot} style={{background: dashboardStates.find(status => status.id === issue.stateId)?.color}}/>{catalog.states.find(status => status.id === issue.stateId)?.label}</span>
                  <span className={d1.priority}><Flag size={13} aria-hidden="true"/>{catalog.priorities.find(priority => priority.id === issue.priorityId)?.label}</span>
                </div>
                <div className={d1.mobileIssueMeta}>
                  <span>{issue.assigneeIds.length ? issue.assigneeIds.map(id => {
                    const member = dashboardMembers.find(person => person.id === id);
                    return member ? <span key={id} className={d1.memberIdentity}><Avatar name={member.name} src={dashboardAvatarSources[id]} size={24}/><span>{member.name}</span></span> : id;
                  }) : text("未分配", "No owner")}</span>
                  <time><CalendarDays size={13} aria-hidden="true"/>{issue.dueDate ?? "—"}</time>
                </div>
                <div className={d1.labels}>{issue.labelIds.map(id => <Badge key={id}><Tag size={12} aria-hidden="true"/>{id}</Badge>)}</div>
                <label className={d1.mobileSelection}><input type="checkbox" checked={state.selectedIds.includes(issue.id)} onChange={event => setState(previous => ({...previous, selectedIds: event.target.checked ? [...previous.selectedIds, issue.id] : previous.selectedIds.filter(id => id !== issue.id)}))}/>{text("选择", "Select")} {issue.identifier}</label>
              </article>)}
            </div>
          </section>
    {state.notice && (<p className={d1.caption} role="status">
              {state.notice === "saved"
            ? text("修改已确认并应用到当前内存场景。", "Change confirmed and applied to this in-memory scene.")
            : text("已明确丢弃草稿。", "Draft explicitly discarded.")}
            </p>)}
</>),
rail: (<aside ref={agendaRef} onScroll={(event) => {
        const position = event.currentTarget.scrollTop;
        if (position !== agendaScroll)
            setAgendaScroll(position);
    }} className={d1.aside} aria-label={text("个人信息与日程", "Profile and agenda")}>
          <div className={d1.cover} aria-hidden="true"/>
          <div className={d1.profile}>
            <div className={d1.profileTop}>
              <Avatar name={state.profile.name} src={dashboardAvatarSources.profile} size={40} className={d1.profileAvatar}/>
              <Button variant="ghost" size="icon" aria-label={text("编辑个人信息", "Edit profile")} className={d1.profileEdit} disabled={readonly} onClick={() => setState((previous) => openDashboardDraft(previous, "profile"))}>
                <Pencil size={16} aria-hidden="true"/>
              </Button>
            </div>
            <h2 className={d1.profileName}>{state.profile.name}</h2>
            <p className={d1.email}>{state.profile.email}</p>
            <dl className={d1.profileMeta}>
              <dt>{text("加入时间", "Joined on")}</dt>
              <dd>
                {new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
    }).format(new Date(`${state.profile.joined}T00:00:00Z`))}
              </dd>
              <dt>{text("时区", "Timezone")}</dt>
              <dd>
                {timeLabel(state.clock)} {state.timeZone}
              </dd>
            </dl>
          </div>
          <Tabs value={state.agendaTab} onValueChange={(value) => setState((previous) => ({
        ...previous,
        agendaTab: String(value),
    }))}>
            <TabsList className={d1.agendaTabs}>
              {[
        { id: "meetings", label: text("会议", "Meetings") },
        { id: "events", label: text("活动", "Events") },
        { id: "focus", label: text("专注", "Focus") },
    ].map((tab) => (<TabsTab key={tab.id} value={tab.id}>
                  {tab.label}
                </TabsTab>))}
            </TabsList>
            {["meetings", "events", "focus"].map((kind) => (<TabsPanel key={kind} value={kind} className={d1.agendaPanel}>
                {state.agenda
            .filter((entry) => entry.kind === kind)
            .map((entry) => (<article key={entry.id} className={d1.agendaEntry} data-agenda-kind={kind} data-agenda-id={entry.id}>
                      <div className={d1.agendaHeading}>
                        <div>
                          <h3 title={entry.title[locale]}>{entry.title[locale]}</h3>
                          <p className={d1.caption}>
                            {kind === "focus" ? entry.label[locale] : entry.timeCopy?.[locale] ?? `${timeLabel(entry.startsAt)} – ${timeLabel(entry.endsAt)} ${state.timeZone}`}
                          </p>
                        </div>
                        {kind === "events" && <Badge>{entry.label[locale]}</Badge>}
                        <Button variant="ghost" size="icon" aria-label={`${text("展开", "Open")} ${entry.title[locale]}`} aria-expanded={state.expandedAgenda.includes(entry.id)} aria-controls={`pm-dashboard-agenda-${entry.id}`} onClick={() => setState((previous) => ({
                ...previous,
                expandedAgenda: previous.expandedAgenda.includes(entry.id)
                    ? previous.expandedAgenda.filter((id) => id !== entry.id)
                    : [...previous.expandedAgenda, entry.id],
            }))}>
                          <ChevronDown size={16} aria-hidden="true"/>
                        </Button>
                      </div>
                      {kind === "meetings" && (<div className={d1.agendaPeople}>
                        {entry.memberIds.map((id) => {
                    const member = dashboardMembers.find((person) => person.id === id);
                    return member ? (<Avatar key={id} name={member.name} src={dashboardAvatarSources[id]} size={24}/>) : null;
                })}
                        {entry.additionalMembers && <span className={d1.additionalMembers}>+{entry.additionalMembers}</span>}
                        <Badge className="ml-auto">
                          {entry.label[locale]}
                        </Badge>
                      </div>)}
                      {kind === "focus" && entry.issueId && <Button variant="ghost" className={d1.focusIssue} onClick={() => inspectIssue(entry.issueId!)}>{state.issues.find(issue => issue.id === entry.issueId)?.identifier}</Button>}
                      {kind === "events" ? (<p className={d1.eventDescription}>{entry.description[locale]}</p>) : kind === "meetings" ? (<p className={d1.location}>
                          <Video size={14} aria-hidden="true"/>
                          {entry.location[locale]}
                        </p>) : null}
                      {state.expandedAgenda.includes(entry.id) && (<div id={`pm-dashboard-agenda-${entry.id}`} className={d1.agendaDetails}>
                          {kind !== "events" && <p>{entry.description[locale]}</p>}
                          {kind !== "meetings" && <p>{entry.location[locale]}</p>}
                          {entry.memberIds.map((id) => {
                    const member = dashboardMembers.find((person) => person.id === id);
                    return member ? (<PmMemberIdentity key={id} member={member} detail/>) : null;
                })}
                        </div>)}
                    </article>))}
              </TabsPanel>))}
          </Tabs>
        </aside>),
projects: (null),
cards: (null),
currentProject: (null),
activity: (null)
}} />
}