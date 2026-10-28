import { useState } from "react"
import { useParams } from "react-router"
import { Bot, Check, ChevronsUpDown, FolderKanban, LayoutGrid, LoaderCircle, RefreshCw, Settings, Users } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useI18n } from "@/lib/i18n-provider"
import { useWorkspaceStore } from "@/providers/app-providers"
import { pmErrorMessage, usePmService } from "./pm-service"
import { allowed } from "./pm-ui"
import styles from "./service-project-layout.module.css"
import { WorkspaceIdentityBadge } from "./pm-workspace-identity-badge"


export function PmWorkspaceSwitcher() {
  const { workspace, workspaces, loading, error, refresh } = usePmService()
  const { workspaceSlug } = useParams<{ workspaceSlug?: string }>()
  const en = useI18n().locale === "en"
  const startPage = useWorkspaceStore(state => state.startPage)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<Error | null>(null)
  const pending = loading || refreshing
  const visibleError = error ?? refreshError
  const name = workspace?.name ?? (en ? "Choose workspace" : "选择工作区")
  const base = workspace ? `/pm/${encodeURIComponent(workspaceSlug || workspace.id)}` : ""
  const products = [
    {
      id: "project-management" as const,
      title: "Project Management",
      description: en ? "Projects, tasks and plans" : "项目、任务和计划",
      href: workspace ? `${base}/${startPage}` : "",
      icon: FolderKanban,
    },
    {
      id: "agent-workspace" as const,
      title: "Agent Chat",
      description: en ? "Sessions and conversations" : "会话和对话",
      href: workspace ? `/agent/workspace?${new URLSearchParams({ workspace: workspace.id, returnTo: `${base}/${startPage}` })}` : "",
      icon: Bot,
    },
  ]
  const currentProduct = products[0]
  const CurrentProductIcon = currentProduct.icon
  const canManageMembers = allowed(workspace, "access.manage")
  const canReadMembers = canManageMembers || !!workspace?.capabilities.includes("directory.read")

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

  return <div className="mb-1 shrink-0">
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={en
          ? `Workspace: ${name}. Current workspace type: ${currentProduct.title}. Switch workspace or workspace type`
          : `工作区：${name}。当前工作空间：${currentProduct.title}。切换工作区或工作空间`}
        aria-busy={pending}
        className={`${styles.workspaceTrigger} flex w-full min-w-0 items-center gap-2 rounded-control px-3 py-1 text-left text-sm font-medium outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring`}
      >
        <WorkspaceIdentityBadge icon={workspace?.icon} color={workspace?.color} />
        <span className="min-w-0 flex-1">
          <span className="block truncate" title={name}>{name}</span>
          <span className="flex min-w-0 items-center gap-1 text-[11px] font-normal text-muted-foreground">
            <CurrentProductIcon className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate" title={currentProduct.description}>{currentProduct.description}</span>
          </span>
        </span>
        {pending ? <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto">
        {workspace && !visibleError && <>
          <DropdownMenuLabel className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground">{en ? "Workspace type" : "工作空间"}</DropdownMenuLabel>
          <DropdownMenuGroup aria-label={en ? "Workspace types" : "工作空间类型"}>
            {products.map(product => {
              const current = product.id === currentProduct.id
              const Icon = product.icon
              return <DropdownMenuItem
                key={product.id}
                textValue={product.title}
                disabled={current || !product.href}
                aria-current={current ? "location" : undefined}
                className={`min-h-11 gap-2.5 py-1.5 ${current ? "bg-selection data-disabled:opacity-100" : ""}`}
                render={current || !product.href ? undefined : <a href={product.href} data-navigation-close />}
              >
                <span className={`inline-flex size-8 shrink-0 items-center justify-center rounded-control ${product.id === "agent-workspace" ? "bg-agent text-primary-foreground" : "bg-primary text-primary-foreground"}`} aria-hidden="true">
                  <Icon className="size-4" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{product.title}</span>
                  <span className="block text-[11px] font-normal text-muted-foreground">{product.description}</span>
                </span>
                {current && <><span className="shrink-0 text-[11px] text-muted-foreground">{en ? "Current" : "当前"}</span><Check className="size-3.5 shrink-0" aria-hidden="true" /></>}
              </DropdownMenuItem>
            })}
          </DropdownMenuGroup>
          <DropdownMenuSeparator className="my-1 h-px bg-border" />
        </>}
        {workspace && !pending && !visibleError && <>
          <DropdownMenuGroup aria-label={en ? "Current workspace links" : "当前工作区入口"}>
            <DropdownMenuItem render={<a href={`${base}/settings/general`} data-navigation-close />}>
              <Settings className="size-4 shrink-0" aria-hidden="true" />{en ? "Workspace settings" : "工作区设置"}
            </DropdownMenuItem>
            {canReadMembers && <DropdownMenuItem render={<a href={`${base}/members?tab=members`} data-navigation-close />}>
              <Users className="size-4 shrink-0" aria-hidden="true" />{en ? "Members & teams" : "成员与团队"}
            </DropdownMenuItem>}
          </DropdownMenuGroup>
          <DropdownMenuSeparator className="my-1 h-px bg-border" />
        </>}
        {(pending || visibleError || workspaces.some(candidate => candidate.id !== workspace?.id)) && <>
        <DropdownMenuLabel className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground">{en ? "Switch workspace" : "切换工作区"}</DropdownMenuLabel>
        <DropdownMenuGroup aria-label={en ? "Authorized workspaces" : "有权访问的工作区"}>
          {pending ? <DropdownMenuItem disabled><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{en ? "Loading workspaces…" : "正在加载工作区…"}</DropdownMenuItem> : visibleError ? <DropdownMenuItem disabled>{en ? "Workspace information is unavailable" : "暂时无法读取工作区"}</DropdownMenuItem> : workspaces.length ? workspaces.map(candidate => {
            const current = candidate.id === workspace?.id
            // Document navigation invokes the existing beforeunload draft guard
            // and leaves no old-workspace subscriptions mounted after switching.
            return <DropdownMenuItem
              key={candidate.id}
              textValue={candidate.name}
              disabled={current}
              aria-current={current ? "location" : undefined}
              className={`min-h-10 gap-2.5 py-1 ${current ? "bg-selection font-medium data-disabled:opacity-100" : ""}`}
              render={current ? undefined : <a href={`/pm/${encodeURIComponent(candidate.id)}/${startPage}`} data-navigation-close />}
            >
              <WorkspaceIdentityBadge icon={candidate.icon} color={candidate.color} />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{candidate.name}</span>
              {current && <><span className="shrink-0 text-[11px] text-muted-foreground">{en ? "Current" : "当前"}</span><Check className="size-3.5 shrink-0" aria-hidden="true" /></>}
            </DropdownMenuItem>
          }) : <DropdownMenuItem disabled>{en ? "No authorized workspaces" : "尚无有权访问的工作区"}</DropdownMenuItem>}
        </DropdownMenuGroup>
        </>}
        <DropdownMenuSeparator className="my-1 h-px bg-border" />
        <DropdownMenuItem disabled={pending} onSelect={event => { event.preventDefault(); void refreshWorkspaces() }}>
          <RefreshCw className="size-4 shrink-0" aria-hidden="true" />
          {refreshing ? en ? "Refreshing…" : "正在刷新…" : en ? "Refresh workspaces" : "刷新工作区"}
        </DropdownMenuItem>
        <DropdownMenuItem render={<a href="/pm" data-navigation-close />}>
          <LayoutGrid className="size-4 shrink-0" aria-hidden="true" />
          {en ? "All workspaces" : "全部工作区"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {pending && <p role="status" className="px-3 text-xs text-muted-foreground">{refreshing ? en ? "Refreshing workspaces…" : "正在刷新工作区…" : en ? "Loading workspaces…" : "正在加载工作区…"}</p>}
    {visibleError && <p role="alert" className="px-3 text-xs leading-5 text-destructive [overflow-wrap:anywhere]">{pmErrorMessage(visibleError, en ? "en" : "zh")}</p>}
  </div>
}
