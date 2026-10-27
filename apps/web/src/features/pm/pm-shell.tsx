import { Link, useLocation, useMatch, useParams } from "react-router"
import { useState, useSyncExternalStore, type ReactNode } from "react"
import { onlineManager } from "@tanstack/react-query"
import { ApiError } from "@contracts"
import {
  Bell,
  Check,
  CalendarDays,
  CalendarClock,
  ChartGantt,
  ChevronRight,
  FileText,
  Bot,
  FolderKanban,
  Home,
  LayoutDashboard,
  LayoutGrid,
  ListTodo,
  MoreHorizontal,
  Moon,
  Monitor,
  PanelsTopLeft,
  Settings as SettingsIcon,
  Sun,
  Star,
  Users,
  UsersRound,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react"
import { WorkspaceShell } from "@/components/blocks/workspace-shell"
import {
  ErrorPageScreen,
  type HttpErrorCode,
} from "@/components/blocks/error-page"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { useI18n } from "@/lib/i18n-provider"
import { useRouteEntrance } from "@/lib/use-route-entrance"
import { useWorkspaceStore } from "@/providers/app-providers"
import { pmActorKey, PmProvider, usePmClient } from "./pm-session"
import { PmServiceProvider, pmErrorMessage, PmServiceError, usePmEntities, usePmService } from "./service/pm-service"
import { PmAgentProvider } from "./agent/agent-panel-context"
import { PmCommandPalette } from "./service/pm-command-palette"
import { PmAuthPageShell } from "./service/pm-auth-page"
import { PmUserMenu } from "./service/pm-user-menu"
import { PmCommandRecovery } from "./service/pm-ui"
import { ServiceProjectSidebar } from "./service/service-project-layout"
import { ServiceProjectMenuProvider } from "./service/project-menu"
import { PmWorkspaceSwitcher } from "./service/pm-workspace-switcher"
import { useCoreDraftProtection } from "./markdown/session"
import { useNavigate } from "react-router"
import { PmShowcaseCatalog } from "./pm-showcase-catalog"
import dashboardStyles from "@/views/pm/dashboards-views.module.css"
import shellStyles from "./pm-shell.module.css"
import { dashboardViews, memberViews, projectDetailViews, projectListViews, projectListViewAliases, teamViews, resolveVariant, usePmDisplaySetting } from "./service/pm-display-settings"

function Preferences() {
  const { locale } = useI18n()
  const theme = useWorkspaceStore((state) => state.theme)
  const setTheme = useWorkspaceStore((state) => state.setTheme)
  const setLocale = useWorkspaceStore((state) => state.setLocale)
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={locale === "en" ? `Color theme: ${theme}. Cycle light, dark, system` : `主题：${theme === "system" ? "跟随系统" : theme === "dark" ? "深色" : "浅色"}。循环切换浅色、深色、系统`}
        onClick={() => setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light")}
      >
        {theme === "system" ? <Monitor aria-hidden="true" /> : theme === "light" ? (
          <Moon aria-hidden="true" />
        ) : (
          <Sun aria-hidden="true" />
        )}
      </Button>
      <Button
        variant="ghost"
        aria-label={
          locale === "en" ? "Switch interface language" : "切换界面语言"
        }
        onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}
      >
        {locale === "en" ? "中文" : "EN"}
      </Button>
    </>
  )
}

type PageSection =
  | "dashboard"
  | "project-list"
  | "project-detail"
  | "members"
  | "teams"

const pageVariants: Record<
  PageSection,
  {
    views: readonly string[]
    page: { zh: string; en: string }
    item: { zh: string; en: string }
  }
> = {
  dashboard: {
    views: dashboardViews,
    page: { zh: "概览", en: "Overview" },
    item: { zh: "仪表盘", en: "Dashboard" },
  },
  "project-list": {
    views: projectListViews,
    page: { zh: "项目", en: "Projects" },
    item: { zh: "项目列表", en: "Project List" },
  },
  "project-detail": {
    views: projectDetailViews,
    page: { zh: "项目详情", en: "Project Detail" },
    item: { zh: "项目详情", en: "Project Detail" },
  },
  members: {
    views: memberViews,
    page: { zh: "成员", en: "Members" },
    item: { zh: "成员列表", en: "Member List" },
  },
  teams: {
    views: teamViews,
    page: { zh: "团队", en: "Teams" },
    item: { zh: "团队列表", en: "Team List" },
  },
}

/** Icon dropdown after the language switch for the active page's variants. */
function PageSwitcher({
  section,
  activeView,
}: {
  section: PageSection
  activeView: string
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const navigate = useNavigate()
  const location = useLocation()
  const { views, page, item } = pageVariants[section]
  const select = (view: string) => {
    const query = new URLSearchParams(location.search)
    query.set("view", view)
    navigate(
      { pathname: location.pathname, search: `?${query.toString()}` },
      { state: location.state },
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={en ? "Switch page variant" : "切换页面版本"}
          />
        }
      >
        <PanelsTopLeft aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
          {en ? page.en : page.zh}
        </DropdownMenuLabel>
        {views.map((view, index) => {
          const active = activeView === view
          return (
            <DropdownMenuItem
              key={view}
              aria-current={active ? "page" : undefined}
              className={active ? "bg-selection font-medium" : undefined}
              onSelect={() => select(view)}
            >
              {en ? item.en : item.zh} {index + 1}
              {active && <Check aria-hidden="true" className="ml-auto" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PmFrame({ children }: { children: ReactNode }) {
  const client = usePmClient()
  const { locale } = useI18n()
  const en = locale === "en"
  const params = useParams()
  const location = useLocation()
  const pathname = location.pathname
  const entranceRef = useRouteEntrance<HTMLDivElement>()
  const dashboard = pathname.endsWith("/dashboard")
  const projectPage = /\/projects(?:\/[^/]+)?\/?$/.test(pathname)
  const memberPage = pathname.endsWith("/members")
  const teamsPage = pathname.endsWith("/teams")
  const referenceLayout = dashboard || projectPage || memberPage || teamsPage || pathname.includes("/settings")
  const requestedView = new URLSearchParams(location.search).get("view")
  const pageSection: PageSection | null = dashboard
    ? "dashboard"
    : projectPage
      ? params.projectId
        ? "project-detail"
        : "project-list"
      : memberPage
        ? "members"
        : teamsPage
          ? "teams"
          : null
  const pageVariant =
    pageSection === "dashboard"
      ? resolveVariant(requestedView, "dashboard1", dashboardViews)
      : pageSection === "project-list"
        ? resolveVariant(
            requestedView,
            "list1",
            projectListViews,
            projectListViewAliases,
          )
        : pageSection === "project-detail"
          ? resolveVariant(requestedView, "detail1", projectDetailViews)
          : pageSection === "members"
            ? resolveVariant(requestedView, "member1", memberViews)
            : pageSection === "teams"
              ? resolveVariant(requestedView, "team1", teamViews)
              : ""
  const workspace = params.workspaceSlug
  const session = client.session
  const nav = workspace
    ? [
        { slug: "projects", icon: FolderKanban, label: en ? "Projects" : "项目" },
        { slug: "issues", icon: ListTodo, label: en ? "Issues" : "任务" },
        {
          slug: "dashboard",
          icon: LayoutDashboard,
          label: en ? "Dashboard" : "工作区概览",
        },
        { slug: "members", icon: Users, label: en ? "Members" : "成员" },
        { slug: "teams", icon: UsersRound, label: en ? "Teams" : "团队" },
        {
          slug: "notifications",
          icon: Bell,
          label: en ? "Notifications" : "通知",
        },
        { slug: "settings/general", icon: SettingsIcon, label: en ? "Settings" : "设置" },
      ]
    : []
  const base = workspace ? `/lab/pm/${encodeURIComponent(workspace)}` : "/lab/pm"
  return (
    <div
      className={`h-dvh min-w-0 ${referenceLayout ? dashboardStyles.page : ""}`}
      data-pm-product
      data-pm-actor={session.actor ? pmActorKey(session.actor) : undefined}
    >
      <WorkspaceShell
        layoutMode="adaptive"
        mobileNavigation={referenceLayout}
        activityBar={referenceLayout ? undefined : <nav className="flex h-full flex-col items-center gap-1 py-1 max-md:flex-row max-md:px-1" aria-label={en ? "Quick navigation" : "快捷导航"}>{nav.map(({ slug, icon: Icon, label }) => <Link key={slug} to={`${base}/${slug}`} title={label} aria-label={label} className="flex size-10 shrink-0 items-center justify-center rounded-control hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring"><Icon className="size-4" aria-hidden="true" /></Link>)}</nav>}
        defaultSidebarWidth={234}
        sidebarWidth={referenceLayout ? 256 : undefined}
        sidebarMinWidth={200}
        sidebarMaxWidth={320}
        sidebarResizable={!referenceLayout}
        inspectorOpen={false}
        bottomPanelOpen={false}
        title={
          <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <Link to="/lab/pm" className="truncate font-medium">
              {referenceLayout ? (en ? "Project Management" : "项目管理") : `EasyuseUI · ${en ? "Project management" : "项目管理"}`}
            </Link>
            {referenceLayout && <div className="flex shrink-0 items-center gap-1"><span className="mr-2 text-xs text-muted-foreground">{en ? "Demo data" : "演示数据"}</span><Preferences />{pageSection && workspace && <PageSwitcher section={pageSection} activeView={pageVariant} />}</div>}
          </div>
        }
        toolbar={referenceLayout ? undefined : (
          <div className="flex items-center gap-2">
            <span className="max-w-60 truncate text-xs text-muted-foreground" title={session.user?.email}>
              {session.user?.name} · {en ? "Demo data" : "演示数据"}
            </span>
            <Preferences />
          </div>
        )}
        sidebar={
          <nav
            data-pm-sidebar
            className="flex h-full flex-col gap-1 p-3"
            aria-label={en ? "Project workspace navigation" : "项目工作区导航"}
          >
            <Link
              to="/lab/pm"
              data-navigation-close
              className="mb-3 truncate rounded-control px-3 py-2 text-[13px] font-medium hover:bg-surface-hover"
            >
              {workspace ?? (en ? "Choose workspace" : "选择工作区")}
            </Link>
            {nav.map(({ slug, icon: Icon, label }) => {
              const href = `${base}/${slug}`
              const active = pathname.startsWith(`${base}/${slug.split("/")[0]}`)
              return (
                <div key={slug}>
                  <Link
                    to={href}
                    data-navigation-close
                    aria-current={active ? "page" : undefined}
                    className={`flex h-control items-center gap-2 rounded-control px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-selection text-primary" : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"}`}
                  >
                    <Icon aria-hidden="true" className="size-4" />
                    {label}
                  </Link>
                </div>
              )
            })}
            {workspace && params.projectId && (
              <Link
                to={`${base}/projects/${encodeURIComponent(params.projectId)}/events`}
                className="flex h-control items-center gap-2 rounded-control px-3 text-[13px] text-muted-foreground hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CalendarClock aria-hidden="true" className="size-4" />
                {en ? "Hourly schedule" : "小时排期"}
              </Link>
            )}
            <p className="mt-auto border-t pt-3 text-xs leading-5 text-muted-foreground">
              {en
                ? "Component showcase only. These examples do not write to the backend."
                : "组件展示专用示例，不写入真实后端。"}
            </p>
          </nav>
        }
        className={`h-full! ${referenceLayout ? dashboardStyles.shell : ""}`}
      >
        <div
          key={session.actor ? pmActorKey(session.actor) : "anonymous"}
          ref={entranceRef}
          className="flex h-full min-h-0 min-w-0 flex-col"
          data-pm-route-surface
        >
          {children}
        </div>
      </WorkspaceShell>
    </div>
  )
}

export function PmLabLayout({ children }: { children: ReactNode }) {
  return (
    <PmProvider>
      <PmFrame>{children}</PmFrame>
    </PmProvider>
  )
}

export function PmHome() {
  return <PmShowcaseCatalog />
}

function serviceErrorStatus(error: Error | null): HttpErrorCode | null {
  if (error instanceof ApiError) {
    if (
      error.status === 401 ||
      error.status === 403 ||
      error.status === 404 ||
      error.status === 503
    ) {
      return error.status
    }
    if (error.status >= 500) return 500
    return null
  }
  if (
    (error instanceof PmServiceError &&
      error.code === "temporarily_unavailable") ||
    error instanceof TypeError
  ) {
    return 503
  }
  return null
}

function ServiceHeaderMenu({
  base,
  section,
  activeView,
}: {
  base: string
  section: Exclude<PageSection, "members" | "teams"> | null
  activeView: string
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const theme = useWorkspaceStore(state => state.theme)
  const setTheme = useWorkspaceStore(state => state.setTheme)
  const setLocale = useWorkspaceStore(state => state.setLocale)
  const location = useLocation()
  const navigate = useNavigate()
  const variants = section ? pageVariants[section] : null
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={en ? "Page and appearance options" : "页面与外观选项"} />}>
      <MoreHorizontal aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className={shellStyles.headerMenu}>
      <DropdownMenuLabel className={shellStyles.menuLabel}>{en ? "Appearance" : "外观"}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme} onValueChange={value => {
        if (value === "light" || value === "dark" || value === "system") setTheme(value)
      }}>
        <DropdownMenuRadioItem value="light"><Sun aria-hidden="true" />{en ? "Light" : "浅色"}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="dark"><Moon aria-hidden="true" />{en ? "Dark" : "深色"}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="system"><Monitor aria-hidden="true" />{en ? "System" : "跟随系统"}</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <DropdownMenuItem onSelect={() => setLocale(en ? "zh-CN" : "en")}>{en ? "语言 · 中文" : "Language · English"}</DropdownMenuItem>
      {variants && <>
        <DropdownMenuSeparator className={shellStyles.menuSeparator} />
        <DropdownMenuLabel className={shellStyles.menuLabel}>{en ? variants.page.en : variants.page.zh}</DropdownMenuLabel>
        {variants.views.map((view, index) => <DropdownMenuItem key={view} aria-current={activeView === view ? "page" : undefined} onSelect={() => {
          const query = new URLSearchParams(location.search)
          query.set("view", view)
          navigate({ pathname: location.pathname, search: `?${query.toString()}` }, { state: location.state })
        }}>
          {en ? variants.item.en : variants.item.zh} {index + 1}
          {activeView === view && <Check aria-hidden="true" className="ml-auto" />}
        </DropdownMenuItem>)}
      </>}
      <DropdownMenuSeparator className={shellStyles.menuSeparator} />
      <DropdownMenuItem render={<Link to={`${base}/settings/general`} data-navigation-close />}><SettingsIcon aria-hidden="true" />{en ? "Workspace settings" : "工作区设置"}</DropdownMenuItem>
      <DropdownMenuItem render={<Link to={`${base}/whiteboard`} data-navigation-close />}><PanelsTopLeft aria-hidden="true" />{en ? "Personal whiteboard" : "个人白板"}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
}

function AuthorizedProjectCrumb({ base, projectId, current }: { base: string; projectId: string; current: boolean }) {
  const projects = usePmEntities("project")
  const { workspace } = usePmService()
  const en = useI18n().locale === "en"
  const permitted = workspace?.projectIds === null || workspace?.projectIds.includes(projectId)
  const project = permitted ? projects.data?.find(candidate => candidate.id === projectId && candidate.kind === "project") : undefined
  const name = project && typeof project.data.name === "string" ? project.data.name : en ? "Project" : "项目"
  return <Link to={`${base}/projects/${encodeURIComponent(projectId)}`} className={shellStyles.projectCrumb} aria-current={current ? "page" : undefined} title={name}>{name}</Link>
}

function ConnectionDetails({ label, healthy, compact = false }: { label: string; healthy: boolean; compact?: boolean }) {
  const service = usePmService()
  const en = useI18n().locale === "en"
  return <Popover>
    <PopoverTrigger render={<button type="button" className={compact ? shellStyles.connectionCompact : shellStyles.connection} data-healthy={healthy} aria-label={`${en ? "Connection" : "连接"}: ${label}. ${en ? "View service details" : "查看服务详情"}`} title={label} />}>
      {healthy ? <Wifi aria-hidden="true" /> : <WifiOff aria-hidden="true" />}
      <span role={compact ? undefined : "status"}>{label}</span>
    </PopoverTrigger>
    <PopoverContent side={compact ? "bottom" : "top"} align={compact ? "end" : "start"} className={shellStyles.connectionDetails}>
      <PopoverTitle className="font-medium">{en ? "Service status" : "服务状态"}</PopoverTitle>
      <p>{en ? "Connection" : "连接"}: {label}</p>
      {!healthy && <p>{en ? "Live updates are not connected. The last snapshot may be stale; unknown writes still need their original receipts checked." : "实时更新当前未连接，上次快照可能已过期；结果未知的写入仍须核对原收据。"}</p>}
      {service.error && <p role="alert" className="text-destructive">{pmErrorMessage(service.error, en ? "en" : "zh")}</p>}
      {service.capabilities?.execution.enabled === false && <p>{en ? "Agent execution is not enabled." : "Agent 执行未启用。"}</p>}
    </PopoverContent>
  </Popover>
}

function ServiceFrame({ children }: { children: ReactNode }) {
  const service = usePmService()
  const { workspace, actor, streamState } = service
  useCoreDraftProtection(window.location.origin, actor?.id, service.actorEpoch)
  const en = useI18n().locale === "en"
  const location = useLocation()
  const pathname = location.pathname
  const entranceRef = useRouteEntrance<HTMLDivElement>()
  const projectDetailMatch = useMatch("/pm/:workspaceSlug/projects/:projectId")
  const projectMatch = useMatch("/pm/:workspaceSlug/projects/:projectId/*")
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const projectPage = pathname.endsWith("/projects") || !!projectDetailMatch
  const homePage = !!useMatch("/pm/:workspaceSlug/home")
  const dashboardPage = pathname.endsWith("/dashboard")
  const memberPage = pathname.endsWith("/members")
  const referenceLayout = homePage || projectPage || dashboardPage || memberPage || pathname.includes("/settings")
  const configuredDashboard = usePmDisplaySetting(workspace?.id, "dashboardView")
  const dashboardVariant = resolveVariant(new URLSearchParams(location.search).get("view"), configuredDashboard, dashboardViews)
  const configuredProjectList = usePmDisplaySetting(workspace?.id, "projectListView")
  const configuredProjectDetail = usePmDisplaySetting(workspace?.id, "projectDetailView")
  const requestedView = new URLSearchParams(location.search).get("view")
  const projectListVariant = resolveVariant(requestedView, configuredProjectList, projectListViews, projectListViewAliases)
  const projectDetailVariant = resolveVariant(requestedView, configuredProjectDetail, projectDetailViews)
  const configuredIssue = usePmDisplaySetting(workspace?.id, "issueView")
  const pageSection: Exclude<PageSection, "members" | "teams"> | null = dashboardPage
    ? "dashboard"
    : projectDetailMatch
      ? "project-detail"
      : projectPage
        ? "project-list"
        : null
  const pageVariant =
    pageSection === "dashboard"
      ? dashboardVariant
      : pageSection === "project-list"
        ? projectListVariant
        : pageSection === "project-detail"
          ? projectDetailVariant
          : ""
  const [logoutError, setLogoutError] = useState("")
  const [retrying, setRetrying] = useState(false)
  const [retryFeedback, setRetryFeedback] = useState("")
  const online = useSyncExternalStore(onlineManager.subscribe, () => onlineManager.isOnline(), () => true)
  const isServiceHome = pathname === "/pm" || pathname === "/pm/"
  const status = serviceErrorStatus(service.error)
  const errorCode =
    isServiceHome || service.loading
      ? null
      : actor
        ? status
        : status === 500 || status === 503
          ? status
          : 401
  const retryService = async () => {
    if (retrying) return
    setRetrying(true)
    setRetryFeedback("")
    try {
      await service.refresh()
    } catch (error) {
      setRetryFeedback(pmErrorMessage(error, en ? "en" : "zh"))
    } finally {
      setRetrying(false)
    }
  }
  if (errorCode) {
    return (
      <ErrorPageScreen
        code={errorCode}
        requestId={
          service.error instanceof ApiError ? service.error.requestId : undefined
        }
        onRetry={
          errorCode === 500 || errorCode === 503
            ? () => {
                void retryService()
              }
            : undefined
        }
        retrying={retrying}
        feedback={retryFeedback || undefined}
      />
    )
  }
  if (isServiceHome) {
    return (
      <div ref={entranceRef} data-pm-route-surface>
        <PmAuthPageShell
          split={!actor}
          toolbar={
            <>
              {actor && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setLogoutError("")
                    void service.logout().catch((error: unknown) =>
                      setLogoutError(pmErrorMessage(error, en ? "en" : "zh")),
                    )
                  }}
                >
                  {en ? "Sign out" : "退出"}
                </Button>
              )}
              <Preferences />
            </>
          }
        >
          {logoutError && (
            <p role="alert" className="w-full max-w-96 text-sm text-destructive">
              {logoutError}
            </p>
          )}
          {children}
        </PmAuthPageShell>
      </div>
    )
  }
  const base = workspace ? `/pm/${encodeURIComponent(workspaceSlug || workspace.id)}` : "/pm"
  const searchParams = new URLSearchParams(location.search)
  const issueCollection = pathname.replace(/\/$/, "") === `${base}/issues`
  const scope = searchParams.get("scope")
  const personalScope = scope === "mine" || scope === "important"
  const taskView = requestedView || (searchParams.get("savedView") ? "" : configuredIssue)
  const scheduleView = ["calendar", "calendar1", "calendar2", "hour-calendar"].includes(taskView)
    ? "calendar"
    : ["gantt", "gantt1"].includes(taskView)
      ? "gantt"
      : ""
  const homeLabel = en ? "Home" : "首页"
  const personalLinks = [
    ["mine", ListTodo, en ? "My Tasks" : "我的任务"],
    ["important", Star, en ? "Important / Watching" : "重要 / 我关注的"],
  ] as const
  const links = [
    ["dashboard", LayoutDashboard, en ? "Overview" : "概览", pathname === `${base}/dashboard`],
    ["projects", FolderKanban, en ? "All projects" : "全部项目", pathname === `${base}/projects`],
    ["issues", ListTodo, en ? "All tasks" : "全部任务", issueCollection && !personalScope && !scheduleView],
    ["issues?view=calendar", CalendarDays, en ? "Calendar" : "日历", issueCollection && !personalScope && scheduleView === "calendar"],
    ["issues?view=gantt", ChartGantt, en ? "Timeline" : "时间线", issueCollection && !personalScope && scheduleView === "gantt"],
    ["documents", FileText, en ? "Documents" : "文档", pathname === `${base}/documents`],
    ["views", LayoutGrid, en ? "Views" : "视图", pathname === `${base}/views`],
    ["members?tab=members", Users, en ? "Members & teams" : "成员与团队", memberPage],
    ["notifications", Bell, en ? "Activity" : "活动", pathname === `${base}/notifications`],
  ] as const
  const agentLinks = [
    ["agent", Bot, en ? "Chat" : "对话", pathname === `${base}/agent`],
    ["automations", Zap, en ? "Automations" : "自动化", pathname === `${base}/automations`],
  ] as const
  const navigationLinkClass = shellStyles.navigationLink
  const connectionStates: Record<string, string> = {
    "signed-out": en ? "Signed out" : "未登录",
    idle: en ? "Idle" : "空闲",
    disabled: en ? "Real-time updates unavailable" : "实时更新未启用",
    connecting: en ? "Connecting" : "正在连接",
    live: en ? "Live" : "已连接",
    reconnecting: en ? "Reconnecting" : "正在重连",
    resyncing: en ? "Resynchronizing" : "正在重新同步",
    "permission-denied": en ? "Access denied" : "无访问权限",
  }
  const connectionLabel = online ? connectionStates[streamState] ?? streamState : en ? "Offline" : "离线"
  const healthyConnection = online && streamState === "live"
  const currentProjectId = projectDetailMatch?.params.projectId ?? projectMatch?.params.projectId
  const pageLabel = pathname.endsWith("/issues/new")
    ? en ? "New task" : "新建任务"
    : pathname.includes("/entities/")
      ? en ? "Entity details" : "对象详情"
      : currentProjectId
        ? pathname.endsWith("/issues")
          ? en ? "Tasks" : "任务"
          : pathname.endsWith("/events") ? en ? "Calendar" : "日历" : null
        : issueCollection && personalScope
          ? personalLinks.find(([personal]) => personal === scope)?.[2]
          : pathname.startsWith(`${base}/settings`)
            ? en ? "Settings" : "设置"
            : pathname === `${base}/whiteboard`
              ? en ? "Personal whiteboard" : "个人白板"
              : homePage ? homeLabel : [...links, ...agentLinks].find(([, , , active]) => active)?.[2] ?? (en ? "Workspace" : "工作区")
  const controls = <div className={shellStyles.headerControls}>
    {actor && <div className={shellStyles.command}><PmCommandPalette /></div>}
    {workspace && !healthyConnection && <ConnectionDetails label={connectionLabel} healthy={healthyConnection} compact />}
    {workspace && <ServiceHeaderMenu base={base} section={pageSection} activeView={pageVariant} />}
  </div>
  const menuScope = `${actor?.id ?? "anonymous"}:${workspace?.id ?? "none"}`
  return <ServiceProjectMenuProvider key={menuScope}><div className={`fixed inset-0 min-w-0 ${referenceLayout ? dashboardStyles.page : ""}`} data-pm-product data-pm-actor={actor?.id}>
    <WorkspaceShell layoutMode="adaptive" mobileNavigation headerPlacement="main" defaultSidebarWidth={252} sidebarMinWidth={200} sidebarMaxWidth={360} sidebarResizable inspectorOpen={false} bottomPanelOpen={false}
      title={<nav className={shellStyles.breadcrumb} aria-label={en ? "Breadcrumb" : "面包屑导航"}>
        <Link to={base} className={shellStyles.workspaceCrumb} title={workspace?.name}>{workspace?.name ?? (en ? "Workspace" : "工作区")}</Link>
        <ChevronRight className={shellStyles.workspaceCrumbSeparator} aria-hidden="true" />
        {currentProjectId && <><AuthorizedProjectCrumb base={base} projectId={currentProjectId} current={!pageLabel} />{pageLabel && <ChevronRight aria-hidden="true" />}</>}
        {pageLabel && <span className={shellStyles.currentContext} aria-current="page" title={pageLabel}>{pageLabel}</span>}
      </nav>}
      toolbar={controls}
      sidebar={<nav data-pm-sidebar className={shellStyles.sidebar} aria-label={en ? "Workspace navigation" : "工作区导航"}>
        <PmWorkspaceSwitcher />
        <div className={shellStyles.sidebarScroll}>
          {workspace && <>
            <section aria-label={en ? "Personal" : "个人"} className={shellStyles.personalSection}>
              <h2 className={shellStyles.sectionHeading}>{en ? "Personal" : "个人"}</h2>
              <Link to={`${base}/home`} data-navigation-close aria-current={homePage ? "page" : undefined} className={navigationLinkClass}><Home className="size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 truncate" title={homeLabel}>{homeLabel}</span></Link>
              {personalLinks.map(([personal, Icon, label]) => <Link key={personal} to={`${base}/issues?scope=${personal}`} data-navigation-close aria-current={issueCollection && scope === personal ? "page" : undefined} className={navigationLinkClass}><Icon className="size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 truncate" title={label}>{label}</span></Link>)}
            </section>
            <section aria-label={en ? "Workspace" : "工作区"}>
              <div className={shellStyles.sectionHeader}>
                <h2 className={shellStyles.sectionHeading}>{en ? "Workspace" : "工作区"}</h2>
                <Link to={`${base}/issues/new`} data-navigation-close aria-current={pathname === `${base}/issues/new` ? "page" : undefined} className={shellStyles.newTask}>{en ? "+ New task" : "+ 新建任务"}</Link>
              </div>
              {links.map(([path, Icon, label, active]) => <Link key={path} to={`${base}/${path}`} data-navigation-close aria-current={active ? "page" : undefined} className={navigationLinkClass}><Icon className="size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 truncate" title={label}>{label}</span></Link>)}
            </section>
            <details className={shellStyles.agentGroup} open={agentLinks.some(([, , , active]) => active) || undefined}>
              <summary className={navigationLinkClass}><ChevronRight className={shellStyles.agentChevron} aria-hidden="true" /><span>Agent</span></summary>
              {agentLinks.map(([path, Icon, label, active]) => <Link key={path} to={`${base}/${path}`} data-navigation-close aria-current={active ? "page" : undefined} className={navigationLinkClass}><Icon className="size-4 shrink-0" aria-hidden="true" /><span>{label}</span></Link>)}
            </details>
            <ServiceProjectSidebar base={base} projectId={projectMatch?.params.projectId} />
          </>}
        </div>
        <div className={shellStyles.footer}>
          {actor && <PmUserMenu />}
          {workspace && <ConnectionDetails label={connectionLabel} healthy={healthyConnection} />}
        </div>
      </nav>} className={`h-full! ${shellStyles.shell}`}>
      <div key={`${actor?.id ?? "anonymous"}:${workspace?.id ?? "none"}`} ref={entranceRef} className="flex h-full min-h-0 min-w-0 flex-col" data-pm-route-surface>
        {!online && <p role="status" className="shrink-0 border-b border-warning bg-surface p-3 text-sm">{en ? "Offline. Showing the last snapshot, which may be stale. Reads resume when the network returns; unknown commands still require checking their original receipts." : "当前离线，显示的上次快照可能已过期。联网后恢复读取；结果未知的命令仍须查询原收据。"}</p>}
        {service.error && <p role="alert" className="shrink-0 border-b border-destructive bg-surface px-3 py-2 text-sm text-destructive">{pmErrorMessage(service.error, en ? "en" : "zh")}</p>}
        <PmCommandRecovery />
        <PmAgentProvider>{children}</PmAgentProvider>
      </div>
    </WorkspaceShell>
  </div></ServiceProjectMenuProvider>
}

export function PmProductLayout({ children }: { children: ReactNode }) {
  return <PmServiceProvider><ServiceFrame>{children}</ServiceFrame></PmServiceProvider>
}
