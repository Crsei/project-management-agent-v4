import { useEffect, useRef, useState, type MouseEvent } from "react"
import { useParams } from "react-router"
import { Bot, Check, ChevronDown, ChevronsUpDown, Ellipsis, FolderKanban, LayoutGrid, LoaderCircle, Plus, RefreshCw, Settings, Users } from "lucide-react"
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
import { loadAgentApp } from "@/lib/agent-app-module"
import { pmErrorMessage, usePmService } from "./pm-service"
import { allowed } from "./pm-ui"
import styles from "./service-project-layout.module.css"
import { WorkspaceIdentityBadge } from "./pm-workspace-identity-badge"


export function PmWorkspaceSwitcher({ collapsed = false }: { collapsed?: boolean } = {}) {
  const { workspace, workspaces, loading, error, refresh } = usePmService()
  const { workspaceSlug } = useParams<{ workspaceSlug?: string }>()
  const en = useI18n().locale === "en"
  const startPage = useWorkspaceStore(state => state.startPage)
  const [refreshing, setRefreshing] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [refreshError, setRefreshError] = useState<Error | null>(null)
  const [openingAgent, setOpeningAgent] = useState<string | null>(null)
  const [agentLoadError, setAgentLoadError] = useState<{ href: string; message: string } | null>(null)
  const agentRequest = useRef<symbol | null>(null)
  useEffect(() => () => { agentRequest.current = null }, [])
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
      href: workspace ? `/agent/workspace?${new URLSearchParams({ workspace: workspace.id, returnTo: `${base}/${startPage}` })}` : "/agent/workspace",
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

  const openAgent = async (href: string) => {
    if (agentRequest.current) return
    const request = Symbol("agent-navigation")
    agentRequest.current = request
    setOpeningAgent(href)
    setAgentLoadError(null)
    try {
      await loadAgentApp()
      if (agentRequest.current !== request) return
      // Keep document navigation: PM editors also protect drafts via beforeunload.
      // A cancelled native confirmation returns here without leaving a pending lock.
      window.location.assign(href)
    } catch (cause) {
      if (agentRequest.current === request) setAgentLoadError({ href, message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (agentRequest.current === request) {
        agentRequest.current = null
        setOpeningAgent(null)
      }
    }
  }
  const startAgentNavigation = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    setSwitcherOpen(false)
    void openAgent(href)
  }
  const cancelAgentNavigation = () => {
    agentRequest.current = null
    setOpeningAgent(null)
  }

  return <div className="mb-3 shrink-0">
    <DropdownMenu open={switcherOpen} onOpenChange={open => { setSwitcherOpen(open); if (!open) setMoreOpen(false) }}>
      <DropdownMenuTrigger
        aria-label={en
          ? `Switch app. Current app: ${currentProduct.title}. Workspace: ${name}`
          : `切换应用。当前应用：${currentProduct.title}。工作区：${name}`}
        aria-busy={pending || !!openingAgent}
        title={collapsed ? currentProduct.title : undefined}
        className={`${styles.workspaceTrigger} ${collapsed ? styles.collapsedTrigger : ""}`}
      >
        <span className={styles.applicationIcon}><CurrentProductIcon className="size-4" aria-hidden="true" /></span>
        {!collapsed && <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium" title={currentProduct.title}>{currentProduct.title}</span>
          <span className="block truncate text-[11px] font-normal text-muted-foreground">{currentProduct.description}</span>
        </span>}
        {collapsed ? null : pending || openingAgent ? <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto">
          <DropdownMenuLabel className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground">{en ? "Switch app" : "切换应用"}</DropdownMenuLabel>
          <DropdownMenuGroup aria-label={en ? "Applications" : "应用"}>
            {products.map(product => {
              const current = product.id === currentProduct.id
              const Icon = product.icon
              return <DropdownMenuItem
                key={product.id}
                textValue={product.title}
                disabled={current || !product.href || !!openingAgent}
                aria-current={current ? "location" : undefined}
                className={`min-h-11 gap-2.5 py-1.5 ${current ? "bg-selection data-disabled:opacity-100" : ""}`}
                render={current || !product.href ? undefined : <a href={product.href} onClick={event => startAgentNavigation(event, product.href)} />}
              >
                <span className={`inline-flex size-8 shrink-0 items-center justify-center rounded-control ${product.id === "agent-workspace" ? "bg-agent text-primary-foreground" : "bg-primary text-primary-foreground"}`} aria-hidden="true">
                  <Icon className="size-4" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{product.title}</span>
                  <span className="block text-[11px] font-normal text-muted-foreground">{product.description}</span>
                </span>
                {current && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
              </DropdownMenuItem>
            })}
          </DropdownMenuGroup>
          <DropdownMenuSeparator className="my-1 h-px bg-border" />
        <DropdownMenuGroup aria-label={en ? "Manage" : "管理"}>
          <DropdownMenuLabel className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground">{en ? "Manage" : "管理"} · <span title={name}>{name}</span></DropdownMenuLabel>
          {workspace && !pending && !visibleError && <>
            <DropdownMenuItem render={<a href={`${base}/settings/general`} data-navigation-close />}>
              <Settings className="size-4 shrink-0" aria-hidden="true" />{en ? "Workspace settings" : "工作区设置"}
            </DropdownMenuItem>
            {canReadMembers && <DropdownMenuItem render={<a href={`${base}/members?tab=members`} data-navigation-close />}>
              <Users className="size-4 shrink-0" aria-hidden="true" />{en ? "Members & teams" : "成员与团队"}
            </DropdownMenuItem>}
          </>}
          <DropdownMenuItem render={<a href="/pm?pick=1" data-navigation-close />}>
            <LayoutGrid className="size-4 shrink-0" aria-hidden="true" />
            {en ? "All workspaces" : "全部工作区"}
          </DropdownMenuItem>
          <DropdownMenuItem render={<a href="/pm?create=1" data-navigation-close />}>
            <Plus className="size-4 shrink-0" aria-hidden="true" />
            {en ? "New workspace" : "新建工作区"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {(pending || visibleError || workspaces.some(candidate => candidate.id !== workspace?.id)) && <>
        <DropdownMenuSeparator className="my-1 h-px bg-border" />
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
              {current && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
            </DropdownMenuItem>
          }) : <DropdownMenuItem disabled>{en ? "No authorized workspaces" : "尚无有权访问的工作区"}</DropdownMenuItem>}
        </DropdownMenuGroup>
        </>}
        <DropdownMenuSeparator className="my-1 h-px bg-border" />
        {visibleError && <DropdownMenuItem disabled={pending} onSelect={event => { event.preventDefault(); void refreshWorkspaces() }}>
          <RefreshCw className="size-4 shrink-0" aria-hidden="true" />{en ? "Retry workspace loading" : "重试读取工作区"}
        </DropdownMenuItem>}
        <DropdownMenuItem closeOnClick={false} aria-expanded={moreOpen} onSelect={() => setMoreOpen(open => !open)}>
          <Ellipsis className="size-4" aria-hidden="true" />{en ? "More actions" : "更多操作"}
          <ChevronDown className={`ml-auto size-3.5 ${moreOpen ? "rotate-180" : ""}`} aria-hidden="true" />
        </DropdownMenuItem>
        {moreOpen && <DropdownMenuItem disabled={pending} onSelect={event => { event.preventDefault(); void refreshWorkspaces() }}>
          <RefreshCw className="size-4 shrink-0" aria-hidden="true" />
          {refreshing ? en ? "Refreshing…" : "正在刷新…" : en ? "Refresh workspaces" : "刷新工作区"}
        </DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    {!collapsed && pending && <p role="status" className="px-3 text-xs text-muted-foreground">{refreshing ? en ? "Refreshing workspaces…" : "正在刷新工作区…" : en ? "Loading workspaces…" : "正在加载工作区…"}</p>}
    {!collapsed && visibleError && <p role="alert" className="px-3 text-xs leading-5 text-destructive [overflow-wrap:anywhere]">{pmErrorMessage(visibleError, en ? "en" : "zh")}</p>}
    {openingAgent && <div role="status" className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
      <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <span>{en ? "Loading Agent Chat…" : "正在加载 Agent Chat…"}</span>
      <button type="button" className="underline underline-offset-2" onClick={cancelAgentNavigation}>{en ? "Cancel switch" : "取消切换"}</button>
    </div>}
    {agentLoadError && <div role="alert" className="space-y-2 px-3 py-2 text-xs leading-5 text-destructive [overflow-wrap:anywhere]">
      <p>{en ? "Agent Chat could not be loaded. Your current page and drafts are unchanged." : "无法加载 Agent Chat；当前页面与草稿未改变。"}</p>
      <p>{agentLoadError.message}</p>
      <button type="button" className="underline underline-offset-2" onClick={() => void openAgent(agentLoadError.href)}>{en ? "Retry loading Agent Chat" : "重试加载 Agent Chat"}</button>
      <button type="button" className="ml-3 underline underline-offset-2" onClick={() => window.location.reload()}>{en ? "Reload current page" : "重新加载当前页"}</button>
    </div>}
  </div>
}
