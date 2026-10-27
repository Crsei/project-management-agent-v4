import { useState } from "react"
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import type { Entity } from "@contracts"
import { useWorkspaceStore } from "@/providers/app-providers"
import { DashboardNavigation } from "@/views/pm/dashboard-navigation"
import type { DashboardViewProps } from "@/views/pm/controlled-contracts"
import { dashboardViews, notificationViews, resolveVariant, usePmDisplaySetting } from "./pm-display-settings"
import { ServiceDependencyGraph } from "../components/service-dependency-graph"
import { usePmService, usePmEntities, usePmMembers, usePmChanges } from "./pm-service"
import { useAction, useText, string, allowed, writable, makeCommand, issueRecord, projectRecord, catalog, today, states, CommandNotice, ServiceGuard } from "./pm-ui"
import { ServiceMarkdown } from "../markdown/page"
import { ServiceSettings } from "./pm-settings"
import { ServiceNotifications as NotificationInboxPage } from "./service-notifications"
import { ServiceDashboard1 } from "./service-dashboard-1"
import { ServiceDashboard2 } from "./service-dashboard-2"
import { ServiceDashboard3 } from "./service-dashboard-3"
import { ServiceDashboard4 } from "./service-dashboard-4"
import type { ServiceDashboardProps } from "./service-dashboard-contract"
import { pmKeys, refreshPmSnapshots } from "./pm-data"
import { DashboardPresenceHeartbeat } from "./dashboard-time"
import { PmLoginPage } from "./pm-auth-page"
import { PmWorkspacePicker } from "./pm-workspace-picker"
import { workspaceSettingsPages } from "./settings/settings-catalog"
import { LocalProjectStorageSettings } from "./local-project-settings"
export { ServiceEvents } from "./service-events"
export { ServiceProjects } from "./service-project-list"

const count = (value: number | null) => ({ value, description: "Authorized service snapshot" })
function usePaths() {
  const { workspaceSlug } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const taskOpenMode = useWorkspaceStore(state => state.taskOpenMode)
  const root = `/pm/${encodeURIComponent(workspaceSlug ?? "")}`
  const returnTo = `${location.pathname}${location.search}${location.hash}`
  const openEntity = (id: string, isTask = false) => navigate(isTask && taskOpenMode === "panel"
    ? `${root}/issues?${new URLSearchParams({ entity: id, returnTo })}`
    : `${root}/entities/${encodeURIComponent(id)}?${new URLSearchParams({ returnTo })}`, { state: { returnTo } })
  return { root, navigate, entity: openEntity, project: (id: string) => navigate(`${root}/projects/${encodeURIComponent(id)}?${new URLSearchParams({ returnTo })}`, { state: { returnTo } }), issue: (item: { id: string }) => openEntity(item.id, true) }
}

export function ServiceIssues() {
  const { projectId } = useParams()
  const [params] = useSearchParams()
  return <ServiceMarkdown entityKind="work_item" projectId={projectId} initialCreate={params.get("create") === "1"} />
}

export function ServiceEntityPage() {
  const { entityId, projectId } = useParams()
  return <ServiceMarkdown mode="entity" entityId={entityId} projectId={projectId} />
}

export function ServiceDocuments() {
  const [params] = useSearchParams()
  return <ServiceMarkdown entityKind="document" initialCreate={params.get("create") === "1"} />
}

export function ServiceViews() {
  const [params] = useSearchParams()
  return <ServiceMarkdown entityKind="" initialCreate={params.get("create") === "1"} />
}

export function ServiceWorkspaceSettings() {
  const [params] = useSearchParams()
  const paths = usePaths()
  const t = useText()
  const section = params.get("section")
  const preferences = section === "preferences"
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <nav aria-label={t("工作区设置导航", "Workspace settings navigation")} className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
      <Link className="rounded-control px-3 py-2 text-sm text-muted-foreground hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring" to={`${paths.root}/settings/general`}>
        {t("返回设置中心", "Settings center")}
      </Link>
      {workspaceSettingsPages.map(item => <Link key={item.section} to={`${paths.root}/settings?section=${item.section}`} aria-current={(section ?? "configuration") === item.section ? "page" : undefined} className={`rounded-control px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring ${(section ?? "configuration") === item.section ? "bg-selection font-medium" : "text-muted-foreground hover:bg-surface-hover"}`}>{t(item.zh, item.en)}</Link>)}
    </nav>
    {preferences ? <ServiceSettings /> : section === "local-storage" ? <LocalProjectStorageSettings /> : <ServiceMarkdown mode="settings" settingsSection={section === "migrations" || section === "diagnostics" ? section : "configuration"} />}
  </div>
}

export function ServiceHome() {
  const { actor } = usePmService()
  return actor ? <PmWorkspacePicker /> : <PmLoginPage />
}


export function ServiceDashboard() {
  const queryClient = useQueryClient()
  const projects = usePmEntities("project")
  const items = usePmEntities("work_item")
  const milestones = usePmEntities("milestone")
  const members = usePmMembers()
  const changes = usePmChanges()
  const { workspace, actor } = usePmService()
  const paths = usePaths()
  const location = useLocation()
  const t = useText()
  const [searchParams] = useSearchParams()
  const configured = usePmDisplaySetting(workspace?.id, "dashboardView")
  const variant = resolveVariant(searchParams.get("view"), configured, dashboardViews)
  const [interaction, setInteraction] = useState<DashboardViewProps["interaction"]>({ selectedProjectId: null, query: "" })
  const query = interaction.query.trim().toLowerCase()
  const projectRows = (projects.data ?? []).filter(row => `${row.id} ${string(row.data.name)}`.toLowerCase().includes(query))
  const matchingProjects = new Set(projectRows.map(row => row.id))
  const filtered = (items.data ?? []).filter(item =>
    (!interaction.selectedProjectId || item.projectId === interaction.selectedProjectId)
    && (!query || `${item.id} ${string(item.data.title)}`.toLowerCase().includes(query) || matchingProjects.has(item.projectId ?? "")),
  )
  const known = items.data !== undefined
  const refresh = () => {
    void projects.refetch()
    void items.refetch()
    void milestones.refetch()
    void members.refetch()
    void changes.refetch()
    if (actor && workspace) void refreshPmSnapshots(queryClient, [...pmKeys.workspace(window.location.origin, actor.id, workspace.id), "dashboard"])
  }
  const openActivity = () => paths.navigate(`${paths.root}/notifications`)
  const openDashboardIssues = (filter?: { projectId?: string; stateId?: string; overdue?: boolean; completed?: boolean }) => {
    const query = new URLSearchParams()
    if (filter?.stateId) query.set("state", filter.stateId)
    if (filter?.completed) query.set("state", "done")
    if (filter?.overdue) query.set("overdue", "1")
    paths.navigate(`${paths.root}${filter?.projectId ? `/projects/${encodeURIComponent(filter.projectId)}` : ""}/issues?${query}`)
  }
  const title = {
    dashboard1: t("我的工作区", "My workspace"),
    dashboard2: t("概览", "Dashboard"),
    dashboard3: t("指挥中心", "Command Center"),
    dashboard4: t("项目依赖地图", "Project Dependency Map"),
  }[variant]
  const stateLabels: Record<string, string> = {
    draft: t("草稿", "Draft"),
    ready: t("就绪", "Ready"),
    in_progress: t("进行中", "In progress"),
    in_review: t("审核中", "In review"),
    done: t("已完成", "Done"),
    cancelled: t("已取消", "Cancelled"),
  }
  const coreError = projects.error ?? items.error
  const refreshing = [projects, items, milestones, members, changes].some(snapshot => snapshot.isFetching && snapshot.data !== undefined)
  const surface: DashboardViewProps = {
    interactive: true,
    variant,
    navigation: variant === "dashboard1" ? undefined : <DashboardNavigation query={interaction.query} onQueryChange={query => setInteraction(previous => ({ ...previous, query }))} members={members.data?.filter(member => !member.revokedAt).map(member => ({ id: member.userId, name: member.name }))} onPeople={() => paths.navigate(`${paths.root}/members?tab=members`)} onActivity={openActivity} />,
    toolbar: variant === "dashboard2" || variant === "dashboard3" ? null : undefined,
    readModel: {
      title,
      description: "",
      projects: projectRows.map(row => projectRecord(row, items.data, members.data)),
      issues: filtered.map(issueRecord),
      catalog: {
        ...catalog(projects.data ?? [], members.data),
        states: states.map(id => ({ id, label: stateLabels[id], category: id === "done" ? "completed" : "started" })),
      },
      counts: {
        projects: count(projects.data ? projectRows.length : null),
        issues: count(known ? filtered.length : null),
        completed: count(known ? filtered.filter(row => row.data.status === "done").length : null),
        overdue: count(known ? filtered.filter(row => string(row.data.dueDate) && string(row.data.dueDate) < today() && !["done", "cancelled"].includes(string(row.data.status))).length : null),
        members: count(members.data?.filter(row => !row.revokedAt).length ?? null),
        teams: count(null),
      },
      stateCounts: states.map(id => ({ id, label: stateLabels[id], count: count(known ? filtered.filter(row => row.data.status === id).length : null) })),
      activity: [],
      data: {
        // An empty successful dashboard still has meaningful zero-count cards.
        // Auxiliary query failures stay local to their corresponding panels.
        state: coreError ? "error" : projects.data === undefined || items.data === undefined ? "loading" : "success",
        refreshing,
        error: coreError ? { category: "request", message: coreError.message, reason: t("部分业务快照不可用；已显示的数据可能过期。", "Some service snapshots are unavailable; displayed data may be stale.") } : undefined,
        onRetry: refresh,
      },
      today: today(),
      dependencyDescription: t("项目依赖与任务前置关系分别管理", "Project dependencies and task prerequisites are managed separately"),
      unavailableDescription: t("未记录的评估、预算和工期保持未知；不生成示例事实。", "Unrecorded assessments, budgets and durations remain unknown; no sample facts are generated."),
    },
    interaction,
    actions: {
      setInteraction,
      refresh,
      openProject: paths.project,
      openIssue: paths.issue,
      openIssues: openDashboardIssues,
      createProject: () => paths.navigate(`${paths.root}/views?kind=project&create=1`),
      createIssue: () => paths.navigate(`${paths.root}/issues/new?${new URLSearchParams({ ...(interaction.selectedProjectId ? { project: interaction.selectedProjectId } : {}), returnTo: `${location.pathname}${location.search}` })}`),
      openPeople: () => paths.navigate(`${paths.root}/members?tab=members`),
    },
    capabilities: {
      createProject: allowed(workspace, "planning.edit"),
      createIssue: allowed(workspace, "planning.edit") || (projects.data ?? []).some(row => writable(row) && allowed(workspace, "planning.edit", row.id)),
    },
  }
  const pageProps: ServiceDashboardProps = {
    surface, projects, issues: items, milestones, members, changes, actor,
    openEntity: id => paths.entity(id, items.data?.some(item => item.id === id) ?? false),
    openActivity,
    dependencyEditor: <DependencyPanel items={filtered} />,
  }
  return <ServiceGuard><div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <CommandNotice />
    <DashboardPresenceHeartbeat />
    {variant === "dashboard1" ? <ServiceDashboard1 {...pageProps} />
      : variant === "dashboard2" ? <ServiceDashboard2 {...pageProps} />
        : variant === "dashboard3" ? <ServiceDashboard3 {...pageProps} />
          : <ServiceDashboard4 {...pageProps} />}
  </div></ServiceGuard>
}

function DependencyPanel({ items }: { items: Entity[] }) { const { workspace } = usePmService(); const action = useAction(); const paths = usePaths(); const editable = (item: Entity) => writable(item) && allowed(workspace, "planning.edit", item.projectId); const canEdit = items.some(editable); return <><ServiceDependencyGraph items={items} onOpen={paths.issue} pending={action.locked} onAdd={canEdit ? (item, prerequisiteId) => { if (editable(item)) void action.run(() => action.execute(makeCommand("AddDependency", { prerequisiteId }, item, item.projectId!))) } : undefined} onRemove={canEdit ? (item, prerequisiteId) => { if (editable(item)) void action.run(() => action.execute(makeCommand("RemoveDependency", { prerequisiteId }, item, item.projectId!))) } : undefined} />{action.localError && <p role="alert">{action.localError}</p>}</> }



export function ServiceNotifications() {
  const { workspace } = usePmService()
  const [params] = useSearchParams()
  const configured = usePmDisplaySetting(workspace?.id, "notificationView")
  const variant = resolveVariant(params.get("view"), configured, notificationViews)
  return <NotificationInboxPage variant={variant} />
}

