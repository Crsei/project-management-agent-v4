import { useId, useState } from "react"
import { ArrowRight, CircleCheck, RefreshCw } from "lucide-react"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-provider"
import { useWorkspaceStore } from "@/providers/app-providers"
import { pmErrorMessage, usePmService } from "./pm-service"
import { useText } from "./pm-ui"
import { WorkspaceIdentityBadge } from "./pm-workspace-identity-badge"

export function PmWorkspacePicker() {
  const { actor, workspaces, loading, error, refresh } = usePmService()
  const { locale } = useI18n()
  const t = useText()
  const startPage = useWorkspaceStore(state => state.startPage)
  const headingId = useId()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<Error | null>(null)
  const pending = loading || refreshing
  const visibleError = error ?? refreshError

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

  if (!actor) return null

  return (
    <section aria-labelledby={headingId} className="mx-auto flex w-full min-w-0 max-w-96 flex-col gap-7" data-pm-route-page>
      <div className="flex min-w-0 flex-col items-center gap-3 text-center">
        <span className="flex size-11 items-center justify-center rounded-full border bg-surface text-foreground">
          <CircleCheck aria-hidden="true" className="size-5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 max-w-full space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("已登录", "Signed in")}</p>
          <p className="text-sm font-medium [overflow-wrap:anywhere]">{actor.name}</p>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{actor.email}</p>
        </div>
      </div>

      <div className="space-y-2 text-center">
        <h1 id={headingId} className="text-2xl font-semibold tracking-tight">{t("选择工作区", "Choose workspace")}</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          {t("此处仅显示当前账号获准访问的工作区。", "Only workspaces this account is authorized to access appear here.")}
        </p>
      </div>

      {pending ? (
        <p role="status" className="rounded-lg border bg-surface p-5 text-center text-sm text-muted-foreground">
          {refreshing ? t("正在刷新工作区…", "Refreshing workspaces…") : t("正在加载工作区…", "Loading workspaces…")}
        </p>
      ) : visibleError ? (
        <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 bg-surface p-5 text-sm">
          <p className="font-medium">{t("暂时无法加载工作区信息", "Workspace information is unavailable")}</p>
          <p className="leading-6 text-destructive [overflow-wrap:anywhere]">
            {pmErrorMessage(visibleError, locale === "en" ? "en" : "zh")}
          </p>
        </div>
      ) : workspaces.length > 0 ? (
        <ul className="grid min-w-0 gap-3">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="min-w-0">
              <Link
                to={`/pm/${encodeURIComponent(workspace.id)}/${startPage}`}
                className="group flex min-h-20 min-w-0 items-center gap-3 rounded-lg border bg-surface p-4 text-foreground outline-none transition-colors hover:border-border-hover hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-2"
              >
                <WorkspaceIdentityBadge icon={workspace.icon} color={workspace.color} className="size-10 [&>svg]:size-5" />
                <span className="min-w-0 flex-1 text-sm font-medium leading-6 [overflow-wrap:anywhere]">{workspace.name}</span>
                <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div role="status" className="space-y-2 rounded-lg border bg-surface p-5 text-center text-sm">
          <p className="font-medium">{t("尚未获准访问任何工作区", "No workspace access yet")}</p>
          <p className="leading-6 text-muted-foreground">
            {t("请联系管理员为此账号授予工作区访问权限，然后刷新列表。", "Ask an administrator to grant this account workspace access, then refresh the list.")}
          </p>
        </div>
      )}

      <div className="flex justify-center">
        <Button variant="outline" disabled={pending} loading={refreshing} onClick={() => { void refreshWorkspaces() }}>
          {!refreshing && <RefreshCw aria-hidden="true" className="size-4" />}
          {refreshing ? t("正在刷新…", "Refreshing…") : t("刷新工作区", "Refresh workspaces")}
        </Button>
        <Link to="/pm/account/security" className="self-center px-3 text-sm underline">{t("本人账号安全（无需工作区）", "Account security (no workspace required)")}</Link>
      </div>
    </section>
  )
}
