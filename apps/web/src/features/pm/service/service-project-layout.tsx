import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Link, Outlet, useLocation, useParams } from "react-router"
import { Activity, Archive, CalendarDays, ChevronRight, Columns3, GitBranch, LayoutDashboard, ListTodo, Paperclip, Search, Star, Table2, ChartGantt } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useWorkspaceStore } from "@/providers/app-providers"
import { safeWorkspaceReturn } from "../markdown/task-collection-model"
import { projectDetailViews, resolveVariant, usePmDisplaySetting } from "./pm-display-settings"
import { usePmEntities, usePmEntity, usePmService, useProjectExtras } from "./pm-service"
import { QueryNotice, ServiceGuard, string, useText } from "./pm-ui"
import { ProjectIdentityIcon, ProjectMenuButton, useProjectMenuActions } from "./project-menu"
import { projectArchived } from "./project-menu-model"
import styles from "./service-project-layout.module.css"

const projectViews = [
  { key: "roadmap", path: "/roadmap", zh: "产品规划", en: "Product roadmap", icon: GitBranch },
  { key: "overview", path: "?tab=overview", zh: "概览", en: "Overview", icon: LayoutDashboard },
  { key: "kanban", path: "/issues?view=kanban", zh: "看板", en: "Board", icon: Columns3 },
  { key: "list", path: "/issues?view=list", zh: "列表", en: "List", icon: ListTodo },
  { key: "table", path: "/issues?view=table", zh: "表格", en: "Table", icon: Table2 },
  { key: "calendar", path: "/issues?view=calendar", zh: "日历", en: "Calendar", icon: CalendarDays },
  { key: "gantt", path: "/issues?view=gantt", zh: "时间线", en: "Timeline", icon: ChartGantt },
  { key: "tree", path: "/issues?view=tree", zh: "树形图", en: "Tree", icon: GitBranch },
  { key: "graph", path: "?tab=graph", zh: "关系图", en: "Dependencies", icon: GitBranch },
  { key: "comments", path: "?view=detail2&tab=comments", zh: "讨论", en: "Discussion", icon: Activity },
  { key: "files", path: "?tab=files", zh: "文件", en: "Files", icon: Paperclip },
  { key: "activity", path: "?tab=activity", zh: "活动", en: "Activity", icon: Activity },
] as const

const sidebarViews = [
  ...projectViews.filter(view => ["roadmap", "kanban", "list", "gantt", "files"].includes(view.key)),
]
const issueViewKeys: Readonly<Record<string, string>> = {
  board: "kanban", kanban: "kanban", board1: "kanban", board2: "kanban", board3: "kanban", "dnd-board": "kanban",
  list: "list", list1: "list", list2: "list",
  table: "table", spreadsheet1: "table",
  calendar: "calendar", calendar1: "calendar", calendar2: "calendar", "hour-calendar": "calendar",
  gantt: "gantt", gantt1: "gantt", tree: "tree",
}
const detailTabs = ["overview", "board", "list", "table", "calendar", "timeline", "tree", "graph", "files", "activity"]

/** Match the rendered surface, including legacy detail tabs and explicit return context. */
function useActiveProjectView(base: string) {
  const location = useLocation()
  const { workspace } = usePmService()
  const configuredView = usePmDisplaySetting(workspace?.id, "issueView")
  const configuredDetail = usePmDisplaySetting(workspace?.id, "projectDetailView")
  const configuredTab = useWorkspaceStore(state => state.projectTab)
  let params = new URLSearchParams(location.search)
  let pathname = location.pathname.replace(/\/+$/, "")
  if (pathname === `${base}/issues/new` || pathname.startsWith(`${base}/entities/`)) {
    const state = location.state as { returnTo?: string } | null
    const returnTo = safeWorkspaceReturn(params.get("returnTo") || state?.returnTo, base, "")
    if (!returnTo) return ""
    const origin = new URL(returnTo, "https://project.invalid")
    pathname = origin.pathname.replace(/\/+$/, "")
    params = origin.searchParams
  }
  if (pathname === base) {
    const requested = params.get("tab")
    const taskView = params.get("taskView")
    const issueLayout = taskView === "list" || taskView === "table" ? taskView : configuredTab === "list" ? "list" : "table"
    const requestedTab = requested === "tasks" ? "board" : requested === "issues" ? issueLayout : requested === "dependencies" ? "graph" : requested
    const variant = resolveVariant(params.get("view"), configuredDetail, projectDetailViews)
    const validTab = requestedTab && (detailTabs.includes(requestedTab) || requestedTab === "comments" && variant === "detail2")
    const tab = validTab ? requestedTab : configuredTab
    return tab === "board" ? "kanban" : tab === "timeline" ? "gantt" : tab
  }
  if (pathname === `${base}/issues`) {
    // A saved view owns its layout; do not guess from the default presentation.
    if (!params.get("view") && params.get("savedView")) return ""
    return issueViewKeys[params.get("view") || configuredView] || ""
  }
  if (pathname === `${base}/roadmap`) return "roadmap"
  return pathname === `${base}/events` ? "calendar" : ""
}

export function ProjectViewNavigation({ base }: { base: string }) {
  const active = useActiveProjectView(base)
  const t = useText()
  return <nav aria-label={t("项目视图", "Project views")} className={`${styles.projectViews} flex min-w-0 gap-1 overflow-x-auto`}>
    {projectViews.map(({ key, path, zh, en, icon: Icon }) => <Link key={key} to={`${base}${path}`} data-navigation-close aria-current={active === key ? "page" : undefined} className={`${styles.projectView} flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-control px-2.5 text-[13px] text-muted-foreground hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-selection aria-[current=page]:text-foreground`}><Icon className="size-3.5 shrink-0" aria-hidden="true" />{t(zh, en)}</Link>)}
  </nav>
}

// Identifier colors distinguish projects; they do not encode state or health.
function projectColor(identifier: string) {
  let hash = 0
  for (let index = 0; index < identifier.length; index++) hash = (hash * 31 + identifier.charCodeAt(index)) >>> 0
  return hash % 6
}

function readProjectExpansion(key: string | null): Record<string, boolean> {
  if (!key) return {}
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) || "{}")
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([, expanded]) => typeof expanded === "boolean"))
      : {}
  } catch {
    return {}
  }
}

function ProjectSidebarContent({ base, projectId }: { base: string; projectId?: string }) {
  const projects = usePmEntities("project")
  const extras = useProjectExtras()
  const { actor, workspace } = usePmService()
  const location = useLocation()
  const menu = useProjectMenuActions()
  const t = useText()
  const id = useId()
  const storageKey = actor && workspace ? `pm.project-tree.v1:${actor.id}:${workspace.id}` : null
  const [expanded, setExpanded] = useState(() => readProjectExpansion(storageKey))
  const [persistenceError, setPersistenceError] = useState(false)
  const [search, setSearch] = useState("")
  const revealedRoute = useRef(location.key)
  const authorized = (projects.data ?? []).filter(project => project.kind === "project" && (workspace?.projectIds === null || workspace?.projectIds.includes(project.id)))
  const accessible = menu.orderedProjects
  const archivedCount = authorized.filter(projectArchived).length
  const activeProject = accessible.some(project => project.id === projectId)
  const activeView = useActiveProjectView(projectId ? `${base}/projects/${encodeURIComponent(projectId)}` : "")
  const needle = search.trim().toLocaleLowerCase()
  const visible = accessible.filter(project => !needle || `${project.id} ${string(project.data.name)}`.toLocaleLowerCase().includes(needle))
  const favoriteIds = useMemo(() => {
    const ids = new Set<string>()
    if (extras.data && !extras.error) {
      for (const project of extras.data.projects) if (project.favorite?.data.favorite === true) ids.add(project.projectId)
    }
    return ids
  }, [extras.data, extras.error])

  useEffect(() => {
    if (projectId && !activeProject) return
    const navigating = revealedRoute.current !== location.key
    revealedRoute.current = location.key
    if (!projectId) return
    // Restore explicit choices on reload; later navigation reveals the active route.
    setExpanded(previous => previous[projectId] === true || !navigating && previous[projectId] === false ? previous : { ...previous, [projectId]: true })
  }, [activeProject, location.key, projectId])

  useEffect(() => { setSearch("") }, [projectId])

  useEffect(() => {
    if (!storageKey) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(expanded))
      setPersistenceError(false)
    } catch {
      setPersistenceError(true)
    }
  }, [expanded, storageKey])

  return <div className="mt-1 border-t pt-1">
    <section aria-label={t("可访问的项目", "Accessible projects")}>
      <h2 className="flex h-6 items-center px-3 text-[11px] font-medium text-muted-foreground">{t("项目", "Projects")}</h2>
      {(accessible.length > 8 || search) && <label className="relative mx-2 mb-2 block">
        <span className="sr-only">{t("搜索项目", "Search projects")}</span>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t("搜索项目…", "Search projects…")} aria-controls={`${id}-projects`} className={`${styles.projectSearch} pl-8 text-xs`} />
      </label>}
      <div className="text-sm">
        <QueryNotice query={{ ...projects, data: projects.data ? accessible : undefined }}>
          <ul id={`${id}-projects`}>
            {visible.map(project => {
              const name = string(project.data.name) || project.id
              const projectBase = `${base}/projects/${encodeURIComponent(project.id)}`
              const current = project.id === projectId
              const open = expanded[project.id] === true
              const childrenId = `${id}-${encodeURIComponent(project.id)}-views`
              return <li key={project.id}>
                <div className="flex min-w-0 items-center gap-0.5">
                  <Link to={projectBase} data-navigation-close aria-current={current ? "location" : undefined} className={`${styles.projectLink} flex min-w-0 flex-1 items-center rounded-control text-[13px] text-muted-foreground hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring aria-[current=location]:bg-selection aria-[current=location]:text-foreground`}>
                    <span className={styles.projectToken} data-color={projectColor(project.id)} aria-hidden="true"><ProjectIdentityIcon project={project} /></span>
                    <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
                    {favoriteIds.has(project.id) && <span className={styles.favorite} title={t("已收藏的项目", "Favorite project")}><Star className="size-3 fill-current" aria-hidden="true" /><span className="sr-only">{t("已收藏的项目", "Favorite project")}</span></span>}
                  </Link>
                  <ProjectMenuButton projectId={project.id} />
                  <button type="button" aria-expanded={open} aria-controls={childrenId} aria-label={`${t(open ? "收起项目" : "展开项目", open ? "Collapse project" : "Expand project")}: ${name}`} onClick={() => setExpanded(previous => ({ ...previous, [project.id]: !open }))} className={`${styles.expandProject} flex shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}><ChevronRight className={`size-3.5 ${open ? "rotate-90" : ""}`} aria-hidden="true" /></button>
                </div>
                <ul id={childrenId} hidden={!open} aria-label={`${name}: ${t("项目视图", "Project views")}`} className="ml-[21px] border-l pl-2">
                  {sidebarViews.map(({ key, path, zh, en, icon: Icon }) => <li key={key}><Link to={`${projectBase}${path}`} data-navigation-close aria-current={current && activeView === key ? "page" : undefined} className={`${styles.projectChildLink} flex min-w-0 items-center rounded-control text-[13px] text-muted-foreground hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-selection aria-[current=page]:text-foreground`}><Icon className="size-3.5 shrink-0" aria-hidden="true" />{t(zh, en)}</Link></li>)}
                </ul>
              </li>
            })}
          </ul>
          {!!needle && visible.length === 0 && accessible.length > 0 && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t("没有匹配的项目。", "No matching projects.")}</p>}
        </QueryNotice>
        {extras.isPending && !extras.data && <p role="status" className="px-3 py-1 text-xs text-muted-foreground">{t("正在读取收藏…", "Loading favorites…")}</p>}
        {extras.error && <div role="alert" className="px-3 py-1 text-xs text-muted-foreground [overflow-wrap:anywhere]"><p>{t("无法读取项目收藏；未显示收藏标记。", "Project favorites are unavailable; favorite markers are not shown.")}</p><p>{extras.error.message}</p><Button variant="ghost" size="sm" onClick={() => { void extras.refetch() }}>{t("重试读取", "Retry read")}</Button></div>}
        {menu.orderError && <p role="alert" className="px-3 py-1 text-xs [overflow-wrap:anywhere]">{menu.orderError}</p>}
        {menu.orderNotice && <p role="status" className="px-3 py-1 text-xs [overflow-wrap:anywhere]">{menu.orderNotice}</p>}
        <Link to={`${base}/projects?archive=archived`} data-navigation-close className="flex min-h-9 items-center gap-2 px-3 text-xs text-muted-foreground hover:underline"><Archive className="size-3.5" aria-hidden="true" />{t("已归档项目", "Archived projects")}{archivedCount > 0 && <span>({archivedCount})</span>}</Link>
        {persistenceError && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t("无法保存展开偏好；当前标签页仍可使用。", "Expansion preferences could not be saved; they still work in this tab.")}</p>}
      </div>
    </section>
  </div>
}

/** Both the directory and active project use authorized service reads, never fixtures. */
export function ServiceProjectSidebar({ base, projectId }: { base: string; projectId?: string }) {
  const { actor, workspace } = usePmService()
  return <ProjectSidebarContent key={`${actor?.id ?? "anonymous"}:${workspace?.id ?? "none"}`} base={base} projectId={projectId} />
}

function ProjectEntityScope({ projectId, entityId }: { projectId: string; entityId: string }) {
  const query = usePmEntity(entityId)
  const t = useText()
  if (query.isPending) return <p role="status" className="p-6">{t("正在加载对象…", "Loading entity…")}</p>
  if (query.error) return <div role="alert" className="space-y-3 p-6"><p>{query.error.message}</p><Button onClick={() => { void query.refetch() }}>{t("重试读取", "Retry read")}</Button></div>
  if (!query.data || (query.data.projectId !== projectId && !(query.data.id === projectId && query.data.kind === "project"))) return <p role="alert" className="p-6">{t("对象不属于当前项目，或不可访问。", "The entity does not belong to this project or is unavailable.")}</p>
  return <Outlet />
}

function ProjectLayoutContent({ projectId, workspaceSlug }: { projectId: string; workspaceSlug: string }) {
  const query = usePmEntity(projectId)
  const { workspace } = usePmService()
  const { entityId } = useParams<{ entityId: string }>()
  const location = useLocation()
  const t = useText()
  const root = `/pm/${encodeURIComponent(workspaceSlug)}`
  const base = `${root}/projects/${encodeURIComponent(projectId)}`
  const permitted = !!workspace && (workspace.projectIds === null || workspace.projectIds.includes(projectId))
  const unavailable = !permitted || !query.isPending && !query.error && query.data?.kind !== "project"
  if (unavailable) return <div role="alert" className="space-y-3 p-6"><p>{t("项目不存在或不可访问。", "Project not found or unavailable.")}</p><Link to={`${root}/projects`} className="underline">{t("返回项目列表", "Back to projects")}</Link></div>
  if (query.isPending) return <p role="status" className="p-6">{t("正在加载项目…", "Loading project…")}</p>
  if (query.error) return <div role="alert" className="space-y-3 p-6"><p>{query.error.message}</p><Button onClick={() => { void query.refetch() }}>{t("重试读取", "Retry read")}</Button><Link to={`${root}/projects`} className="block underline">{t("返回项目列表", "Back to projects")}</Link></div>
  if (!query.data) return null
  // The existing detail variants already own their heading and project tabs.
  if (location.pathname.replace(/\/$/, "") === base) return <Outlet />
  const name = string(query.data.data.name) || projectId
  // The right task panel owns the vertical space; keep the project nav out of that surface.
  const inspectingEntity = !!new URLSearchParams(location.search).get("entity")
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-pm-project-workspace={projectId}>
    {!inspectingEntity && <header className="shrink-0 border-b bg-surface px-3 pt-2 sm:px-5">
      <div className="mb-1 flex min-w-0 items-center justify-between gap-2"><h1 className="min-w-0 break-words text-base font-semibold leading-6" title={projectId}>{name}</h1><ProjectMenuButton projectId={projectId} /></div>
      <ProjectViewNavigation base={base} />
    </header>}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
      {entityId ? <ProjectEntityScope key={entityId} projectId={projectId} entityId={entityId} /> : <Outlet />}
    </div>
  </div>
}

/** One project context around all nested pages, inside the existing global shell. */
export function ServiceProjectLayout() {
  const { projectId, workspaceSlug } = useParams<{ projectId: string; workspaceSlug: string }>()
  const t = useText()
  return <ServiceGuard>{projectId && workspaceSlug ? <ProjectLayoutContent key={`${workspaceSlug}:${projectId}`} projectId={projectId} workspaceSlug={workspaceSlug} /> : <p role="alert" className="p-6">{t("缺少项目编号。", "A project identifier is required.")}</p>}</ServiceGuard>
}
