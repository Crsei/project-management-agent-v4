import { useEffect, useId, useRef, useState } from "react"
import { ArrowRight, LoaderCircle, RefreshCw } from "lucide-react"
import { Link, useNavigate, useSearchParams } from "react-router"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-provider"
import { useWorkspaceStore } from "@/providers/app-providers"
import { pmErrorMessage, usePmService } from "./pm-service"
import { useText } from "./pm-ui"
import { readLastWorkspaceId, rememberLastWorkspaceId } from "./pm-last-workspace"
import { WorkspaceIdentityBadge } from "./pm-workspace-identity-badge"
import { PmWorkspaceCreate } from "./pm-workspace-create"
import { workspaceCreationStorageKey } from "./workspace-creation-model"

export function PmWorkspacePicker() {
  const { actor, workspaces, workspaceInitializations = [], loading, error, refresh } = usePmService()
  const { locale } = useI18n()
  const t = useText()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const startPage = useWorkspaceStore(state => state.startPage)
  const headingId = useId()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<Error | null>(null)
  const [autoEntering, setAutoEntering] = useState(false)
  const autoEnterStarted = useRef(false)
  const pending = loading || refreshing
  const visibleError = error ?? refreshError
  const suppressAutoEntry = searchParams.get("pick") === "1" || searchParams.get("create") === "1"
  const empty = !pending && !visibleError && workspaces.length === 0 && workspaceInitializations.length === 0

  const refreshWorkspaces = async () => {
    if (pending) return
    setRefreshing(true)
    setRefreshError(null)
    try {
      await refresh()
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause : new Error())
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!actor || suppressAutoEntry || pending || visibleError || autoEnterStarted.current) return
    if (workspaceInitializations.length > 0 || workspaces.length === 0) return
    try {
      // An uncertain creation request stays visible instead of disappearing
      // behind an automatic workspace entry.
      if (localStorage.getItem(workspaceCreationStorageKey(window.location.origin, actor.id)) !== null) return
    } catch {
      return
    }
    const lastWorkspaceId = readLastWorkspaceId(window.localStorage, window.location.origin, actor.id)
    const target = workspaces.length === 1 ? workspaces[0] : workspaces.find(workspace => workspace.id === lastWorkspaceId)
    if (!target) return
    autoEnterStarted.current = true
    setAutoEntering(true)
    rememberLastWorkspaceId(window.localStorage, window.location.origin, actor.id, target.id)
    navigate(`/pm/${encodeURIComponent(target.id)}/${startPage}`, { replace: true })
  }, [actor, suppressAutoEntry, pending, visibleError, workspaceInitializations.length, workspaces, startPage, navigate])

  if (!actor) return null

  const heading = empty ? t("创建工作区", "Create workspace") : t("选择工作区", "Choose workspace")
  const description = empty
    ? t("创建一个工作区，开始管理项目、成员和 Agent 会话。", "Create a workspace to manage projects, members, and Agent sessions.")
    : t("选择一个工作区继续，或创建新的工作区。", "Choose a workspace to continue, or create a new one.")

  return (
    <section aria-labelledby={headingId} className="mx-auto flex w-full min-w-0 max-w-[520px] flex-col gap-6">
      <header className="space-y-2">
        <h1 id={headingId} className="text-[28px] font-semibold leading-9 tracking-tight text-foreground">{heading}</h1>
        <p className="text-[13px] leading-5 text-muted-foreground">{description}</p>
      </header>

      {autoEntering ? (
        <p role="status" className="flex items-center gap-2 rounded-xl border bg-surface px-4 py-3 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {t("正在进入上次使用的工作区…", "Opening your last workspace…")}
        </p>
      ) : pending ? (
        <p role="status" className="flex items-center gap-2 rounded-xl border bg-surface px-4 py-3 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {refreshing ? t("正在刷新工作区…", "Refreshing workspaces…") : t("正在加载工作区…", "Loading workspaces…")}
        </p>
      ) : visibleError ? (
        <div role="alert" className="space-y-3 rounded-xl border border-destructive/30 bg-surface p-4 text-sm">
          <div className="space-y-1">
            <p className="font-medium">{t("暂时无法加载工作区信息", "Workspace information is unavailable")}</p>
            <p className="text-[13px] leading-5 text-destructive [overflow-wrap:anywhere]">
              {pmErrorMessage(visibleError, locale === "en" ? "en" : "zh")}
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={refreshing} loading={refreshing} onClick={() => { void refreshWorkspaces() }}>
            {!refreshing && <RefreshCw aria-hidden="true" className="size-3.5" />}
            {refreshing ? t("正在刷新…", "Refreshing…") : t("重试读取", "Retry")}
          </Button>
        </div>
      ) : workspaces.length > 0 ? (
        <ul className="grid min-w-0 gap-2">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="min-w-0">
              <Link
                to={`/pm/${encodeURIComponent(workspace.id)}/${startPage}`}
                onClick={() => { if (actor) rememberLastWorkspaceId(window.localStorage, window.location.origin, actor.id, workspace.id) }}
                className="group flex min-h-[72px] min-w-0 items-center gap-3 rounded-xl border bg-surface px-4 text-foreground outline-none transition-colors hover:border-border-hover hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-2"
              >
                <WorkspaceIdentityBadge icon={workspace.icon} color={workspace.color} className="size-10 [&>svg]:size-5" />
                <span className="min-w-0 flex-1 text-sm font-medium leading-6 [overflow-wrap:anywhere]">{workspace.name}</span>
                <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transform-none" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div role="status" className="space-y-2 rounded-xl border border-dashed bg-surface/50 px-6 py-8 text-center">
          <p className="text-sm font-medium">{workspaceInitializations.length ? t("工作区初始化尚未完成", "Workspace initialization is incomplete") : t("还没有工作区", "No workspace yet")}</p>
          <p className="text-[13px] leading-5 text-muted-foreground">
            {workspaceInitializations.length ? t("工作区身份已建立，但初始化尚未完成。请恢复原初始化；其他已就绪的工作区仍可使用。", "The workspace identity exists, but initialization is incomplete. Resume the original initialization; other ready workspaces remain available.") : t("创建一个工作区，或等待管理员授予访问权限。", "Create a workspace, or wait for an administrator to grant access.")}
          </p>
        </div>
      )}

      {!pending && !visibleError && workspaceInitializations.length > 0 && <section className="rounded-xl border bg-surface px-4 py-3" aria-label={t("待恢复的工作区初始化", "Workspace initializations to resume")}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="text-sm font-medium">{t("工作区初始化待恢复", "Workspace initialization needs recovery")}</h2>
            <p className="text-[13px] leading-5 text-muted-foreground">{t("尚不可进入；原工作区和初始化记录已保留，不会新建替代项。", "Not ready to open. Its original workspace and initialization record are retained without a replacement.")}</p>
          </div>
          <Button variant="outline" size="sm" disabled={pending} loading={refreshing} onClick={() => { void refreshWorkspaces() }}>
            {!refreshing && <RefreshCw aria-hidden="true" className="size-3.5" />}
            {refreshing ? t("正在刷新…", "Refreshing…") : t("恢复并刷新", "Resume and refresh")}
          </Button>
        </div>
        <ul className="mt-3 flex flex-wrap gap-2">{workspaceInitializations.map(item => <li key={item.workspaceId} className="rounded-control bg-surface-hover px-2 py-1 text-xs text-muted-foreground">{item.name}</li>)}</ul>
      </section>}

      {!autoEntering && <PmWorkspaceCreate />}

      <p className="text-center text-[13px] leading-5 text-muted-foreground">{t("需要帮助？请联系工作区管理员。", "Need help? Contact your workspace administrator.")}</p>
    </section>
  )
}
