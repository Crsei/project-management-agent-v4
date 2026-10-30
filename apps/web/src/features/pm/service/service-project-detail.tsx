import { useCallback, useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router"
import { statusCategory, workflowFor, type ViewConfig } from "@pm-schema"
import { PMView } from "@pm-views"
import { CalendarDays, CheckCheck, ChevronRight, ClipboardList, Clock3, FileText, FolderKanban, Paperclip, Users, Zap } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { FilterCondition, FilterField } from "@/components/blocks/filter-card"
import { MessageContent } from "@/components/blocks/message-content"
import { useWorkspaceStore } from "@/providers/app-providers"
import { useDisplayDateTime } from "@/features/workspace/preference-format"
import { ProjectDetailView } from "@/views/pm/project-detail"
import type { ControlledIssueCatalog, ProjectDetailRecord, ProjectDetailViewProps } from "@/views/pm/controlled-contracts"
import reference from "@/views/pm/projects-views.module.css"
import workspaceStyles from "@/views/pm/project-detail-2.module.css"
import { CoreSessionProvider, useCoreSession, useSessionDrafts } from "../markdown/session"
import { ApiError as CoreApiError } from "../markdown/api"
import { ServiceDependencyGraph } from "../components/service-dependency-graph"
import { projectDetailViews, resolveVariant, usePmDisplaySetting } from "./pm-display-settings"
import { usePmEntities, usePmEntity, usePmService, useProjectDirectory, useProjectExtras, type Entity } from "./pm-service"
import { allowed, CommandNotice, issueRecord, makeCommand, QueryNotice, ServiceGuard, string, strings, today, useAction, useDraftState, useText, writable } from "./pm-ui"
import { downloadProjectAttachment, ProjectSourceUpdates, ProjectConversations, ProjectIssueRows, ProjectTaskBoard } from "./service-project-detail-panels"
import { ProjectFilesPage } from "./project-files"
import styles from "./service-project-detail.module.css"
import { ProjectCoverEditor, ProjectFavoriteButton, ProjectScopeEditor } from "./project-extras"
import { ProjectTeamAssignment } from "./project-directory"
import { ProjectFinancialRegion, ProjectHealthRegion, ProjectPortfolioSummary } from "./project-portfolio"
import { ProjectTimeline, ProjectCalendar, useProjectTaskEditing } from "./project-task-editing"
import { ProjectTaskToolbar, type ProjectTaskSort } from "./project-task-toolbar"
import { ProjectAuditHistory } from "./project-audit"
import { ProjectAgentPanelAction } from "../agent/agent-entry"
import { ProjectMenuButton, useProjectMenuActions } from "./project-menu"

type Tab = ProjectDetailViewProps["interaction"]["tab"]
const briefTabs: readonly Tab[] = ["overview", "board", "list", "table", "calendar", "timeline", "tree", "graph", "files", "activity"]
const workspaceTabs: readonly Tab[] = ["overview", "board", "list", "table", "calendar", "timeline", "tree", "graph", "files", "activity", "comments"]
const inaccessible = (error: unknown) => error instanceof CoreApiError && [401, 403, 404].includes(error.status)

/** Presentation-only tones; business state and permissions stay in the workflow. */
const labelTones = ["var(--accent)", "var(--info)", "var(--success)", "var(--warning)", "var(--agent)", "var(--destructive)"]
const labelTone = (id: string) => labelTones[Array.from(id).reduce((hash, character) => (hash * 31 + (character.codePointAt(0) ?? 0)) % 997, 0) % labelTones.length]

/** Mirrors the task query DSL: overdue excludes terminal categories, and week includes today. */
const taskDueBuckets = (due: string | null, date: string, terminal: boolean) => {
  if (!due) return ["none"]
  const week = new Date(Date.parse(`${date}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10)
  const buckets: string[] = []
  if (due < date && !terminal) buckets.push("overdue")
  if (due === date) buckets.push("today")
  if (due >= date && due <= week) buckets.push("week")
  if (due > week) buckets.push("later")
  return buckets
}

/** Formal project details retain the same Markdown editing session as the entity page. */
export function ServiceProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>()
  const { actor, workspace, actorEpoch, refresh } = usePmService()
  const t = useText()
  return <ServiceGuard>{workspace && actor && projectId ? workspace.capabilities.includes("domain.read") ?
    <CoreSessionProvider key={`${workspace.id}:${actor.id}:${workspace.version}:${actorEpoch}`} hostNamespace={window.location.origin} workspaceId={workspace.id} actorId={actor.id} membershipVersion={workspace.version} actorEpoch={actorEpoch} onAccessFailure={refresh}>
      <ProjectDetailContent key={projectId} projectId={projectId} />
    </CoreSessionProvider> : <p role="alert" className="p-6">{t("当前无权读取项目。", "You do not have permission to read projects.")}</p> : <p role="alert" className="p-6">{t("缺少项目编号。", "A project identifier is required.")}</p>}</ServiceGuard>
}

function ProjectDetailContent({ projectId }: { projectId: string }) {
  const projectQuery = usePmEntity(projectId)
  const items = usePmEntities("work_item", projectId)
  const versions = usePmEntities("artifact_version", projectId)
  const conversations = usePmEntities("conversation", projectId)
  const directory = useProjectDirectory()
  const extras = useProjectExtras()
  const editing = useProjectTaskEditing(projectId)
  const service = usePmService()
  const menu = useProjectMenuActions()
  const session = useCoreSession()
  const [drafts] = useSessionDrafts()
  const queryClient = useQueryClient()
  const [blockedAccess, setBlockedAccess] = useState<Error | null>(null)
  const core = useQuery({ queryKey: session.queryKey, queryFn: ({ signal }) => session.api.workspace(signal), enabled: !blockedAccess, retry: false, refetchOnWindowFocus: true })
  const accessError = blockedAccess ?? (inaccessible(core.error) ? core.error : null)
  useEffect(() => {
    if (!inaccessible(core.error) || blockedAccess) return
    setBlockedAccess(core.error)
    void queryClient.cancelQueries({ queryKey: session.queryKey, exact: true }).then(() => queryClient.removeQueries({ queryKey: session.queryKey, exact: true }))
    void session.onAccessFailure().catch(() => {})
  }, [blockedAccess, core.error, queryClient, session])
  const snapshot = accessError || projectQuery.error && !projectQuery.data ? undefined : core.data
  const source = snapshot?.files.find(file => file.id === projectId && file.entity.entity === "project")
  const sourceById = new Map(snapshot?.files.map(file => [file.id, file]))
  const entity = projectQuery.data?.kind === "project" ? projectQuery.data : undefined
  const t = useText()
  const navigate = useNavigate()
  const location = useLocation()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const [params, setParams] = useSearchParams()
  const configured = usePmDisplaySetting(service.workspace?.id, "projectDetailView")
  const projectTab = useWorkspaceStore(state => state.projectTab)
  const taskOpenMode = useWorkspaceStore(state => state.taskOpenMode)
  const display = useDisplayDateTime()
  const variant = resolveVariant(params.get("view"), configured, projectDetailViews)
  const brief = variant === "detail1"
  const tabs = brief ? briefTabs : workspaceTabs
  const requested = params.get("tab")
  const issueLayout = params.get("taskView") === "list" || params.get("taskView") === "table" ? params.get("taskView") as "list" | "table" : requested === "list" || requested === "table" ? requested : projectTab === "list" ? "list" : "table"
  const requestedTab = (requested === "tasks" ? "board" : requested === "issues" ? issueLayout : requested === "dependencies" ? "graph" : requested) as Tab | null
  const defaultTab: Tab = projectTab
  const activeTab = requestedTab && tabs.includes(requestedTab) ? requestedTab : defaultTab
  const [metadataOpen, setMetadataOpen] = useDraftState(`project-detail:${projectId}`, "metadataOpen", () => window.matchMedia("(min-width: 1280px)").matches)
  const [scrolls, setScrolls] = useDraftState<Partial<Record<string, number>>>(`project-detail:${projectId}`, "scrolls", {})
  const [taskQuery, setTaskQuery] = useDraftState(`project-tasks:${projectId}`, "query", "")
  const [taskConditions, setTaskConditions] = useDraftState<FilterCondition[]>(`project-tasks:${projectId}`, "conditions", [])
  const [taskSort, setTaskSort] = useDraftState<ProjectTaskSort>(`project-tasks:${projectId}`, "sort", "default")
  const [uploadOpen, setUploadOpen] = useState(false)
  const action = useAction()
  const root = `/pm/${encodeURIComponent(workspaceSlug || service.workspace!.id)}`
  const projectRoot = `${root}/projects/${encodeURIComponent(projectId)}`
  const navigationState: { returnTo?: unknown } | null = location.state
  const requestedReturn = params.get("returnTo") ?? navigationState?.returnTo
  const backTo = typeof requestedReturn === "string" && (requestedReturn === `${root}/projects` || requestedReturn.startsWith(`${root}/projects?`))
    ? requestedReturn : `${root}/projects`
  const detailParams = new URLSearchParams(params)
  detailParams.set("view", variant)
  detailParams.set("tab", activeTab)
  const returnTo = `${location.pathname}?${detailParams}`
  const openEntityId = useCallback((id: string) => navigate(`${projectRoot}/entities/${encodeURIComponent(id)}?${new URLSearchParams({ returnTo })}`, { state: { returnTo } }), [navigate, projectRoot, returnTo])
  const openEntity = useCallback((item: { id: string }) => {
    if (taskOpenMode === "page") openEntityId(item.id)
    else navigate(`${projectRoot}/issues?${new URLSearchParams({ entity: item.id, returnTo })}`, { state: { returnTo } })
  }, [navigate, openEntityId, projectRoot, returnTo, taskOpenMode])
  const openProjectSource = () => {
    session.detail.update(current => ({ ...current, entityId: projectId, tab: "source" }))
    openEntityId(projectId)
  }
  const createIssue = () => navigate(`${projectRoot}/issues/new?${new URLSearchParams({ returnTo })}`, { state: { returnTo } })
  const setInteraction: ProjectDetailViewProps["actions"]["setInteraction"] = update => {
    const previous = { tab: activeTab, metadataOpen }
    const next = typeof update === "function" ? update(previous) : update
    setMetadataOpen(next.metadataOpen)
    if (next.tab !== activeTab) { const search = new URLSearchParams(params); search.set("tab", next.tab); setParams(search, { replace: true }) }
  }
  const date = today()
  const ownItems = items.data ?? []
  const projectDirectory = directory.data?.projects.find(project => project.projectId === projectId)
  const identityNames = new Map(projectDirectory?.identities.map(person => [person.id, person.name]))
  const teamMembers = projectDirectory ? [...new Map(projectDirectory.teams.flatMap(team => team.members).map(member => [member.id, member])).values()] : undefined
  const projectExtras = extras.data?.projects.find(project => project.projectId === projectId)
  const records = ownItems.map(item => {
    const file = sourceById.get(item.id)
    const checklist = file?.entity.checklist ?? []
    return {
      ...issueRecord(item),
      stateId: string(item.data.labStatus) || string(item.data.status),
      labelIds: strings(item.data.labels),
      subItemCount: file ? checklist.length : null,
      subtasks: file ? { completed: checklist.filter(entry => entry.checked).length, total: checklist.length } : null,
    }
  })
  const workflow = snapshot ? workflowFor("work_item", snapshot.configuration) : undefined
  const categories = new Map(ownItems.map(item => [item.id, sourceById.has(item.id) && snapshot ? statusCategory(sourceById.get(item.id)!.entity, snapshot.configuration) : undefined]))
  const taskNeedle = taskQuery.trim().toLocaleLowerCase()
  const taskFilters = taskConditions.filter(condition => condition.values.length)
  const matchesTaskFilters = (record: (typeof records)[number], condition: FilterCondition) => {
    const selected = new Set(condition.values)
    const category = categories.get(record.id)
    const hit = condition.field === "status" ? selected.has(record.stateId)
      : condition.field === "assignee" ? record.assigneeIds.some(id => selected.has(id))
      : condition.field === "priority" ? selected.has(record.priorityId)
      : condition.field === "labels" ? record.labelIds.some(id => selected.has(id))
      : condition.field === "due" ? taskDueBuckets(record.dueDate, date, category === "completed" || category === "canceled").some(bucket => selected.has(bucket))
      : undefined
    return hit === undefined ? true : condition.operator === "isNot" ? !hit : hit
  }
  const filteredRecords = records.filter(record => taskFilters.every(condition => matchesTaskFilters(record, condition)) && (!taskNeedle || `${record.identifier} ${record.title}`.toLocaleLowerCase().includes(taskNeedle)))
  const priorityOrder: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
  const visibleRecords = [...filteredRecords].sort((a, b) => {
    if (taskSort === "title") return a.title.localeCompare(b.title)
    if (taskSort === "due") return (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31")
    if (taskSort === "priority") return (priorityOrder[a.priorityId] ?? 9) - (priorityOrder[b.priorityId] ?? 9)
    return 0
  })
  const visibleIds = new Set(visibleRecords.map(record => record.id))
  const visibleOwnItems = ownItems.filter(item => visibleIds.has(item.id))
  const taskView = activeTab === "board" || activeTab === "list" || activeTab === "table" || activeTab === "calendar" || activeTab === "timeline" || activeTab === "tree" || activeTab === "graph"
  const filteredView = !!taskNeedle || taskFilters.length > 0
  const completed = ownItems.filter(item => categories.get(item.id) === "completed").length
  const overdue = ownItems.filter(item => string(item.data.dueDate) && string(item.data.dueDate) < date && !["completed", "canceled"].includes(categories.get(item.id) ?? "")).length
  const contributors = [...new Set([string(entity?.data.ownerId), ...ownItems.map(item => string(item.data.assigneeId))].filter(Boolean))]
  const total = items.data ? ownItems.length : null
  const completionKnown = !!items.data && !!snapshot && ownItems.every(item => categories.get(item.id) !== undefined)
  const percentage = completionKnown && total ? Math.round(completed / total * 100) : null
  const issueCatalog: ControlledIssueCatalog = {
    states: [...(workflow?.states ?? []).map(state => ({ id: state.id, label: state.label, category: state.category, color: state.category === "completed" ? "var(--success)" : state.category === "started" ? "var(--info)" : "var(--text-muted)" })), ...[...new Set(records.map(record => record.stateId))].filter(id => !workflow?.states.some(state => state.id === id)).map(id => ({ id, label: id, color: "var(--text-muted)" }))],
    priorities: [...new Set(records.map(record => record.priorityId).filter(Boolean))].map(id => ({ id, label: id, color: id === "urgent" ? "var(--destructive)" : id === "high" ? "var(--warning)" : id === "low" ? "var(--text-muted)" : "var(--text-secondary)" })),
    assignees: [...new Set([...(projectDirectory?.identities.map(person => person.id) ?? []), ...contributors])].map(id => ({ id, label: identityNames.get(id) ?? (id === service.actor?.id ? service.actor.name : id) })),
    labels: [...new Set(records.flatMap(record => record.labelIds))].map(id => ({ id, label: id, color: labelTone(id) })),
    projects: entity ? [{ id: entity.id, label: string(entity.data.name) }] : [], modules: [], cycles: [], estimatePoints: [],
  }
  const due = string(entity?.data.dueDate) || null
  const days = due ? Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000) : null
  const record: ProjectDetailRecord | null = entity && source ? {
    id: entity.id, identifier: entity.id, title: source.entity.title, description: source.entity.body || string(entity.data.goal) || null,
    owner: entity.data.ownerId ? { id: string(entity.data.ownerId), name: identityNames.get(string(entity.data.ownerId)) ?? (entity.data.ownerId === service.actor?.id ? service.actor.name : string(entity.data.ownerId)), role: null } : null,
    status: { value: string(source.entity.status), label: workflowFor("project", snapshot!.configuration)?.states.find(state => state.id === source.entity.status)?.label ?? string(source.entity.status), tone: "neutral" },
    cycle: null, cycleWeeks: null, teamSize: teamMembers?.length ?? null, members: teamMembers, teams: projectDirectory?.teams ?? null, health: null, budget: null, dueDate: due, startDate: string(entity.data.startDate) || null,
    archived: !!entity.data.archivedAt || entity.data.archived === true, artwork: null, starred: projectExtras ? projectExtras.favorite?.data.favorite ?? false : null, coverVersionId: projectExtras?.cover?.data.artifactVersionId ?? null,
    taskCounts: completionKnown ? { closed: completed, total: ownItems.length } : null,
    updatedAt: entity.updatedAt || null, version: String(entity.version), revision: entity.version,
  } : null
  const sourceIssue = !!source && (!!source.stale || !!source.error || source.diagnostics?.some(diagnostic => diagnostic.severity === "error") || !!snapshot?.configurationErrors.some(diagnostic => diagnostic.severity === "error"))
  const canEdit = !!entity && !!source && !sourceIssue && !drafts[projectId] && writable(entity) && allowed(service.workspace, "planning.edit", projectId) && service.capabilities?.business.enabled === true
  const canCreate = canEdit && !action.locked && !editing.locked
  const taskFilterFields: FilterField[] = [
    { id: "status", label: t("状态", "Status"), options: issueCatalog.states.map(state => ({ value: state.id, label: state.label })) },
    { id: "assignee", label: t("负责人", "Assignee"), options: issueCatalog.assignees.map(person => ({ value: person.id, label: person.label })) },
    { id: "priority", label: t("优先级", "Priority"), options: issueCatalog.priorities.map(priority => ({ value: priority.id, label: priority.label })) },
    { id: "due", label: t("截止日期", "Due date"), options: [
      { value: "overdue", label: t("已逾期", "Overdue") },
      { value: "today", label: t("今天", "Today") },
      { value: "week", label: t("未来 7 天", "Next 7 days") },
      { value: "later", label: t("更晚", "Later") },
      { value: "none", label: t("无截止日期", "No due date") },
    ] },
    { id: "labels", label: t("标签", "Labels"), options: issueCatalog.labels.map(label => ({ value: label.id, label: label.label })) },
  ]
  const taskToolbar = taskView ? <ProjectTaskToolbar query={taskQuery} conditions={taskConditions} fields={taskFilterFields} sort={taskSort} canCreate={canCreate} t={t} agent={<ProjectAgentPanelAction compact projectId={projectId} title={source?.entity.title ?? string(entity?.data.name)} hasDraft={!!drafts[projectId]} />} onQueryChange={setTaskQuery} onConditionsChange={setTaskConditions} onSortChange={setTaskSort} onCreate={createIssue} /> : undefined
  const editable = (item: Entity) => canEdit && !editing.locked && writable(item) && !drafts[item.id] && sourceById.has(item.id) && !sourceById.get(item.id)?.stale && !sourceById.get(item.id)?.error && !sourceById.get(item.id)?.diagnostics?.some(diagnostic => diagnostic.severity === "error")
  const canDependency = ownItems.some(editable)
  const refresh = () => { setBlockedAccess(null); void projectQuery.refetch(); void core.refetch() }
  const error = projectQuery.error ?? accessError ?? core.error
  const loading = !error && (projectQuery.isPending || core.isPending)
  const count = (value: number | null, description: string) => ({ value, description })
  const files = entity ? <ProjectFilesPage project={entity} open={uploadOpen} onOpenChange={setUploadOpen} /> : null
  const treeConfig: ViewConfig = { layout: "tree", entity: "work_item", project: projectId }
  const projectTree = snapshot ? <div className={`markdown-workbench ${styles.treeView}`}><PMView files={snapshot.files.filter(file => file.entity.entity === "work_item" && file.entity.project === projectId && visibleIds.has(file.id))} config={treeConfig} configuration={snapshot.configuration} onSelect={id => openEntity({ id })} onPatch={async () => {}} canEdit={() => false} /></div> : <QueryNotice query={items} />
  const briefRegion = <section className={reference.section} data-pm-project-brief><h2 className={reference.sectionTitle}>{t("项目简报", "Project brief")}</h2>{record?.description ? <MessageContent content={record.description} className={reference.brief} /> : <p className={reference.muted}>{t("尚无项目正文或目标。可在完整对象页编写 Markdown。", "No project body or goal has been written. Use the full entity page to edit Markdown.")}</p>}<Button variant="ghost" size="sm" className="justify-self-start" onClick={openProjectSource}>{t("打开 Markdown 源码", "Open Markdown source")}</Button></section>
  const overview = <div className={styles.overviewGrid} data-pm-overview-panel>
    <section className={reference.section}><h2>{t("目标成果", "Outcomes")}</h2>{string(entity?.data.goal) ? <MessageContent content={string(entity?.data.goal)} /> : <p>{t("未设置独立目标；项目正文见下方简报。", "No separate goal is set; see the project brief below.")}</p>}{source?.entity.checklist.length ? <ul data-pm-project-outcomes>{source.entity.checklist.map((item, index) => <li key={`${item.line}:${index}`}>{item.checked ? "☑" : "☐"} {item.text}</li>)}</ul> : null}</section>
    {entity && <section className={reference.section}><h2>{t("范围", "Scope")}</h2><ProjectScopeEditor project={entity} /></section>}
    {briefRegion}
    <section className={reference.section}><h2>{t("里程碑", "Milestones")}</h2>{snapshot?.files.filter(file => file.entity.entity === "milestone" && file.entity.project === projectId).length ? <ul>{snapshot.files.filter(file => file.entity.entity === "milestone" && file.entity.project === projectId).map(file => <li key={file.id}><Button variant="ghost" onClick={() => openEntityId(file.id)}>{file.entity.title}</Button><span>{string(file.entity.status)} · {string(file.entity.due) || t("未排期", "Unscheduled")}</span></li>)}</ul> : <p>{t("没有关联里程碑。", "No linked milestones.")}</p>}</section>
  </div>
  const summaryCounters: [string, number | null][] = [
    [t("任务总数", "Issues"), total],
    [t("进行中", "In progress"), completionKnown ? ownItems.filter(item => categories.get(item.id) === "started").length : null],
    [t("已完成", "Done"), completionKnown ? completed : null],
    [t("已取消", "Canceled"), completionKnown ? ownItems.filter(item => categories.get(item.id) === "canceled").length : null],
    [t("无负责人", "Unassigned"), items.data ? ownItems.filter(item => !item.data.assigneeId).length : null],
  ]
  const metrics = <>
    <section className={reference.metrics} data-pm-project-metrics aria-label={t("项目指标", "Project metrics")}>
      {[
        { icon: CheckCheck, label: t("任务完成率", "Task completion"), value: percentage === null ? "—" : `${percentage}%`, sub: t("按工作流完成类别统计", "Workflow completed category") },
        { icon: CalendarDays, label: t("截止日期", "Due date"), value: display.date(due), sub: days === null ? t("未设置截止日期", "No due date") : days < 0 ? t(`已逾期 ${-days} 天`, `${-days} days overdue`) : t(`还剩 ${days} 天`, `${days} days left`) },
        { icon: ClipboardList, label: t("已完成任务", "Tasks closed"), value: completionKnown ? `${completed}/${ownItems.length}` : "—", sub: t("不自动关闭项目", "Does not close the project") },
        { icon: Paperclip, label: t("附件版本", "File versions"), value: versions.data ? String(versions.data.length) : "—", sub: t("服务端不可变版本", "Immutable service versions") },
      ].map(metric => <div key={metric.label} className={reference.metricCard} data-pm-metric><span className={reference.metricLabel}><metric.icon size={16} aria-hidden="true" />{metric.label}</span><strong className={reference.metricValue} title={metric.sub}>{metric.value}</strong><span className={reference.metricSub}>{metric.sub}</span></div>)}
    </section>
    {!brief && <>
      <section className={reference.issueSummary} data-pm-issue-summary>
        <div className={reference.counters}>{summaryCounters.map(([label, value]) => <div key={label} className={reference.counter}><span className={reference.metricLabel}>{label}</span><strong className={reference.metricValue}>{value ?? "—"}</strong></div>)}</div>
        <div className={reference.shares} role="group" aria-label={t("任务占比", "Issue shares")}>
          <span aria-hidden="true" />
          {summaryCounters.slice(1).map(([label, value]) => {
            const share = total && value !== null ? `${Math.round(value / total * 100)}%` : "—"
            return <Badge key={label} size="sm" aria-label={`${label} ${share}`}>{share} →</Badge>
          })}
        </div>
        <p className={reference.insight}>{t("基于当前项目完整任务快照。", "Based on the complete current project task snapshot.")}<Button variant="ghost" size="sm" onClick={() => setInteraction(previous => ({ ...previous, tab: "graph" }))}>{t("检查依赖路径", "Review dependencies")}<ChevronRight size={14} /></Button></p>
      </section>
    </>}
    {(items.error || !items.data) && <QueryNotice query={items} />}
    {(versions.error || !versions.data) && <QueryNotice query={versions} />}
  </>
  const overviewWithMetrics = <div className={styles.overviewMetrics}>{metrics}{overview}</div>
  const metadata = record && <div className={`${reference.rail} ${workspaceStyles.rail} ${styles.rail}`} data-pm-detail-rail data-pm-rail-variant={brief ? "brief" : "workspace"}>
    {brief && <section className={reference.railSection}><h2 tabIndex={-1}>{t("项目属性", "Project properties")}</h2><dl className={reference.metaFields}>{[
      [t("编号", "Identifier"), record.id], [t("状态", "Status"), record.status?.label ?? "—"], [t("负责人", "Owner"), record.owner?.name ?? t("未分配", "Unassigned")],
      [t("开始日期", "Start date"), display.date(record.startDate)], [t("目标日期", "Target date"), display.date(record.dueDate)], [t("最近更新", "Updated"), display.dateTime(record.updatedAt)],
    ].map(([label, value]) => <div key={label} className={reference.metaField}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><Button variant="outline" onClick={() => openEntityId(projectId)}>{t("打开完整对象 / 编辑", "Open entity / edit")}</Button></section>}
    <section className={reference.railSection}><ProjectPortfolioSummary projectId={projectId} />{entity && <details className="min-w-0 space-y-3"><summary className="cursor-pointer text-sm font-medium">{t("编辑评估、预算与历史", "Assessments, budget and history")}</summary><ProjectHealthRegion project={entity} /><ProjectFinancialRegion project={entity} /></details>}</section>
    {entity && <section className={reference.railSection}><h2>{t("项目团队", "Project teams")}</h2><ProjectTeamAssignment project={entity} /></section>}
    {entity && <section className={reference.railSection}><details><summary className="cursor-pointer text-sm font-medium">{t("项目封面", "Project cover")}</summary><div className="pt-3"><ProjectCoverEditor project={entity} /></div></details></section>}
    {!brief && <section className={reference.railSection} data-pm-project-backlog><h2><span className={workspaceStyles.railHeading}><ClipboardList />{t("待办池", "Backlog")}</span><Badge>{items.data ? ownItems.filter(item => ["backlog", "unstarted"].includes(categories.get(item.id) ?? "")).length : "—"}</Badge></h2><ul>{ownItems.filter(item => ["backlog", "unstarted"].includes(categories.get(item.id) ?? "")).map(item => <li key={item.id}><Button variant="ghost" onClick={() => openEntity(item)}><span>{string(item.data.title)}</span><ChevronRight /></Button></li>)}</ul><Button variant="outline" onClick={() => navigate(`${root}/projects/${encodeURIComponent(projectId)}/issues`)}>{t("查看全部任务", "View all issues")}</Button></section>}
    <section className={reference.railSection}><h2><span className={workspaceStyles.railHeading}><Users />{t("贡献者", "Contributors")}</span><Badge>{items.data ? contributors.length : "—"}</Badge></h2><ul className={styles.identities}>{contributors.map(id => <li key={id}><Users size={16} aria-hidden="true" /><span>{identityNames.get(id) ?? (id === service.actor?.id ? service.actor.name : id)}</span></li>)}</ul><p className={reference.muted}>{t("项目负责人及已分派任务的真实身份；团队成员单独列出。", "Actual project owners and task assignees; team membership is displayed separately.")}</p>{directory.error && <p role="alert">{directory.error.message}</p>}</section>
    <section className={reference.railSection}><h2><span className={workspaceStyles.railHeading}><Clock3 />{t("时间", "Time")}</span></h2><p className={styles.timeRow}>{t("创建", "Created")}<span>{display.dateTime(entity?.createdAt)}</span></p><p className={styles.timeRow}>{t("更新", "Updated")}<span>{display.dateTime(entity?.updatedAt)}</span></p></section>
    <section className={reference.railSection}><h2><span className={workspaceStyles.railHeading}><FileText />{t("备注与讨论", "Notes and discussion")}</span></h2><p>{t("没有独立评论存储。项目对话中的消息可在真实服务中追加和查看。", "There is no separate comments store. Project conversation messages can be read and appended through the real service.")}</p><Button variant="outline" onClick={() => brief ? navigate(`${location.pathname}?${new URLSearchParams({ ...Object.fromEntries(params), view: "detail2", tab: "comments" })}`) : setInteraction(previous => ({ ...previous, tab: "comments" }))}>{t("打开项目讨论", "Open project discussion")}</Button></section>
  </div>
  return <ProjectDetailView variant={variant} interactive tabs={tabs} interaction={{ tab: activeTab, metadataOpen }} readingPosition={scrolls[`${variant}:${activeTab}`] ?? 0} onReadingPositionChange={top => setScrolls(previous => ({ ...previous, [`${variant}:${activeTab}`]: top }))}
    readModel={{ project: record, issues: editing.present(records), catalog: issueCatalog, activity: [], attachments: versions.data?.map(version => ({ id: version.id, name: string(version.data.fileName), description: string(version.data.sha256) || null, sizeLabel: typeof version.data.size === "number" ? `${version.data.size} bytes` : null })) ?? [],
      counts: { total: count(total, t("项目任务", "Project tasks")), completed: count(completionKnown ? completed : null, t("工作流完成类别", "Workflow completed category")), overdue: count(completionKnown ? overdue : null, t("逾期未关闭任务", "Overdue open tasks")), members: count(teamMembers?.length ?? null, t("当前有项目访问权限的关联团队成员", "Authorized members of assigned project teams")) },
      data: { state: error ? "error" : loading ? "loading" : record ? "success" : "empty", refreshing: !!record && (projectQuery.isFetching || core.isFetching), error: error ? { category: "request", message: error.message, reason: record ? t("显示上次快照，可能已过期。", "The retained snapshot may be stale.") : t("未加载任何示例数据。", "No example data has been loaded.") } : undefined, onRetry: refresh, emptyTitle: t("项目不存在或不可访问", "Project not found or unavailable"), emptyDescription: t("当前正式服务中没有可读取的项目记录，不回退示例。", "No readable project record exists in the formal service. There is no fixture fallback."), emptyHeadingLevel: 2 }, today: date }}
    capabilities={{ edit: canEdit, createIssue: canCreate, attach: !!entity && allowed(service.workspace, "delivery.write", projectId), dependency: canDependency }}
    actions={{ back: () => navigate(backTo), edit: () => menu.openDialog(projectId, "settings"), setInteraction, openIssue: openEntity, createIssue, patchIssue: editing.patch, issueCapabilities: { canCreate, canEditField: (item, field) => ["title", "state", "priority", "assignees", "startDate", "dueDate"].includes(field) && editing.canEdit(item.id), canMove: (item, target) => editing.canMove(item.id, target), canEditRelation: () => false }, attach: () => setUploadOpen(true), openAttachment: id => { const version = versions.data?.find(candidate => candidate.id === id); if (version) void action.run(() => downloadProjectAttachment(service.client, service.workspace!.id, version)) }, reconcile: () => { void action.run(() => action.reconcile()) } }}
    headerActions={<>{!taskView && <ProjectAgentPanelAction compact projectId={projectId} title={source?.entity.title ?? string(entity?.data.name)} hasDraft={!!drafts[projectId]} />}{entity && <><ProjectFavoriteButton project={entity} /><ProjectMenuButton projectId={projectId} /></>}<div className={styles.viewToggle} role="group" aria-label={t("项目详情视图", "Project detail view")}>{projectDetailViews.map(view => <Button key={view} variant={variant === view ? "secondary" : "ghost"} size="sm" aria-pressed={variant === view} aria-label={view === "detail1" ? t("项目简报视图", "Project brief view") : t("项目工作区视图", "Project workspace view")} onClick={() => { const search = new URLSearchParams(params); search.set("view", view); if (view === "detail1" && !briefTabs.includes(activeTab)) search.set("tab", "timeline"); setParams(search) }}>{view === "detail1" ? <FileText size={14} /> : <Zap size={14} />}<span>{view === "detail1" ? t("简报", "Brief") : t("工作区", "Workspace")}</span></Button>)}</div><Button variant="ghost" size="icon" disabled={!record} aria-label={t("打开项目源码与编辑器", "Open project source and editor")} onClick={openProjectSource}><FileText size={16} /></Button></>}
    feedback={<><CommandNotice />{action.localError && <p role="alert">{action.localError}</p>}{sourceIssue && <p role="alert" className="text-sm">{t("源文件或配置存在诊断；请在完整对象页处理后编辑。", "Source or configuration diagnostics must be resolved in the full entity page before editing.")}</p>}{drafts[projectId] && <p className="text-sm">{t("保留有未保存的 Markdown 草稿。请打开完整对象继续编辑；此页显示服务端版本。", "An unsaved Markdown draft is retained. Open the entity to continue editing; this page shows the server version.")}<Button variant="ghost" onClick={() => openEntityId(projectId)}>{t("继续编辑", "Resume editing")}</Button></p>}</>}
    toolbar={taskToolbar}
    metricsInOverview
    regions={record && entity ? {
      metadata,
      chips: <div data-pm-meta-chips><ul className={reference.chips} data-pm-project-badges><li><Badge size="sm">{record.status?.label}</Badge></li>{record.archived && <li><Badge>{t("已归档", "Archived")}</Badge></li>}<li><Badge size="sm"><FolderKanban size={12} />{record.id}</Badge></li></ul><ul className={reference.chips} data-pm-project-facts>{record.owner && <li><Users />{record.owner.name}</li>}<li><CalendarDays />{record.dueDate ? display.date(record.dueDate) : t("无目标日期", "No target date")}</li><li><Clock3 />{record.updatedAt ? display.dateTime(record.updatedAt) : t("更新时间未知", "Update time unavailable")}</li></ul></div>,
      overview: overviewWithMetrics, files: files ?? undefined,
      board: <QueryNotice query={items}><ProjectTaskBoard key={projectId} projectId={projectId} items={visibleRecords} catalog={issueCatalog} onOpen={openEntity} onCreate={createIssue} canCreate={canCreate} editing={editing} hideToolbar search="" status="" emptyFiltered={filteredView} /></QueryNotice>,
      list: <QueryNotice query={items}><ProjectIssueRows layout="list" items={visibleRecords} catalog={issueCatalog} onOpen={openEntity} onCreate={createIssue} canCreate={canCreate} editing={editing} hideToolbar search="" status="" emptyFiltered={filteredView} /></QueryNotice>,
      table: <QueryNotice query={items}><ProjectIssueRows layout="table" items={visibleRecords} catalog={issueCatalog} onOpen={openEntity} onCreate={createIssue} canCreate={canCreate} editing={editing} hideToolbar search="" status="" emptyFiltered={filteredView} /></QueryNotice>,
      calendar: <QueryNotice query={items}><ProjectCalendar projectId={projectId} items={visibleRecords} onOpen={openEntity} editing={editing} visibleIds={visibleIds} today={date} /></QueryNotice>,
      timeline: <QueryNotice query={items}><ProjectTimeline projectId={projectId} items={visibleRecords} onOpen={openEntity} editing={editing} /></QueryNotice>,
      tree: projectTree,
      graph: <QueryNotice query={items}><div data-pm-dependency-graph><ServiceDependencyGraph items={visibleOwnItems} onOpen={openEntity} pending={action.locked} onAdd={canDependency ? (item, prerequisiteId) => { if (editable(item)) void action.run(() => action.execute(makeCommand("AddDependency", { prerequisiteId }, item, projectId))) } : undefined} onRemove={canDependency ? (item, prerequisiteId) => { if (editable(item)) void action.run(() => action.execute(makeCommand("RemoveDependency", { prerequisiteId }, item, projectId))) } : undefined} /></div></QueryNotice>,
      activity: <div className={reference.panelStack}><ProjectAuditHistory projectId={projectId} /><ProjectSourceUpdates projectId={projectId} sourceFiles={snapshot?.files ?? []} onOpen={openEntityId} /></div>,
      comments: <ProjectConversations project={entity} conversations={conversations} />,
    } : undefined}
  />
}
