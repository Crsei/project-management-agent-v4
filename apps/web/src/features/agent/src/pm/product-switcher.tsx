import { useState } from "react";
import { Link } from "react-router-dom";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Bot, Check, ChevronDown, ChevronsUpDown, Ellipsis, FolderKanban, LayoutGrid, LoaderCircle, RefreshCw, Settings, Users } from "lucide-react";
import { WorkspaceBadge } from "./workspace-badge";
import { refreshCatalog, refreshIdentity, usePmChatState, type AgentScope, type Workspace } from "./state";
import { useAgentText } from "../i18n";

type ProductSwitcherProps = {
  scope?: AgentScope;
  pending: boolean;
  canLeave: () => boolean;
  pmHref: string;
  onSelectScope: (scope: AgentScope) => void;
};

const PRODUCTS = [
  { id: "project-management", title: "Project Management", description: ["项目、任务和计划", "Projects, tasks and plans"], icon: FolderKanban },
  { id: "agent-workspace", title: "Agent Chat", description: ["会话和对话", "Sessions and conversations"], icon: Bot },
] as const;

type WorkspaceOption = { id: string; name: string; icon?: Workspace["icon"]; color?: Workspace["color"]; capabilities: string[] };

/**
 * Same panel PM exposes for switching between products and workspaces. PM stays the
 * owner of the directory; this shell only mirrors the account-scoped workspace list.
 */
export function ProductSwitcher({ scope, pending, canLeave, pmHref, onSelectScope }: ProductSwitcherProps) {
  const t = useAgentText();
  const state = usePmChatState();
  const [refreshing, setRefreshing] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const currentProduct = PRODUCTS[1];
  const CurrentProductIcon = currentProduct.icon;
  const identityWorkspace = state.identity?.workspaces.find((item) => item.id === scope?.workspaceId);
  const catalogWorkspace = state.catalog?.workspaces.find((item) => item.id === scope?.workspaceId);
  const name = identityWorkspace?.name ?? catalogWorkspace?.name ?? t("选择工作区", "Select workspace");
  const workspaces: WorkspaceOption[] = state.catalog
    ? state.catalog.workspaces.map((item) => {
      const detail = state.identity?.workspaces.find((workspace) => workspace.id === item.id);
      return { id: item.id, name: item.name, icon: detail?.icon, color: detail?.color, capabilities: detail?.capabilities ?? [] };
    })
    : state.identity?.workspaces ?? [];
  const base = scope ? `/pm/${encodeURIComponent(scope.workspaceId)}` : "";
  const pmAppHref = pmHref === base || pmHref.startsWith(`${base}/`) ? pmHref : `${base}/home`;
  const canReadMembers = !!identityWorkspace && (identityWorkspace.capabilities.includes("access.manage") || identityWorkspace.capabilities.includes("directory.read"));
  const busy = pending || refreshing;

  const refresh = async () => {
    if (busy) return;
    setRefreshing(true);
    try { await Promise.all([refreshIdentity(), refreshCatalog().catch(() => {})]); }
    finally { setRefreshing(false); }
  };

  return <DropdownMenu onOpenChange={open => { if (!open) setMoreOpen(false); }}>
    <DropdownMenuTrigger
      className="pm-agent-switcher-trigger"
      aria-label={t(`切换应用。当前应用：${currentProduct.title}。工作区：${name}`, `Switch app. Current app: ${currentProduct.title}. Workspace: ${name}`)}
      aria-busy={pending || state.identityLoading}
    >
      <span className="pm-agent-app-icon"><CurrentProductIcon aria-hidden="true" /></span>
      <span className="pm-agent-switcher-text">
        <span className="pm-agent-switcher-name">{currentProduct.title}</span>
        <span className="pm-agent-switcher-desc">{t(...currentProduct.description)}</span>
      </span>
      {pending || state.identityLoading ? <LoaderCircle className="animate-spin" /> : <ChevronsUpDown className="pm-agent-switcher-chevron" />}
    </DropdownMenuTrigger>
    <DropdownMenuContent className="pm-agent-switcher-menu" side="bottom" align="start" sideOffset={6}>
          {scope && !state.identityError && <>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="pm-agent-menu-label">{t("切换应用", "Switch app")}</DropdownMenuLabel>
              {PRODUCTS.map((product) => {
                const current = product.id === currentProduct.id;
                const Icon = product.icon;
                return <DropdownMenuItem
                  key={product.id}
                  disabled={current}
                  closeOnClick={!current}
                  render={current ? undefined : <Link to={pmAppHref} data-navigation-close data-automation-leave-guarded="true" onClick={(event) => { if (!canLeave()) event.preventDefault(); }} />}
                  className="pm-agent-menu-item"
                  aria-current={current ? "location" : undefined}
                  data-current={current || undefined}
                >
                  <span className="pm-agent-menu-icon" data-product={product.id}><Icon /></span>
                  <span className="pm-agent-menu-text"><strong>{product.title}</strong><small>{t(product.description[0], product.description[1])}</small></span>
                  {current && <span className="pm-agent-menu-meta"><Check aria-hidden="true" /></span>}
                </DropdownMenuItem>;
              })}
            </DropdownMenuGroup>
            <DropdownMenuSeparator className="pm-agent-menu-separator" />
          </>}
            <DropdownMenuGroup aria-label={t("管理", "Manage")}>
              <DropdownMenuLabel className="pm-agent-menu-label">{t("管理", "Manage")} · <span title={name}>{name}</span></DropdownMenuLabel>
              {scope && !state.identityError && <>
              <DropdownMenuItem className="pm-agent-menu-item" render={<Link to={`${base}/settings/general`} data-navigation-close data-automation-leave-guarded="true" onClick={(event) => { if (!canLeave()) event.preventDefault(); }} />}>
                <Settings /><span className="pm-agent-menu-text"><strong>{t("工作区设置", "Workspace settings")}</strong></span>
              </DropdownMenuItem>
              {canReadMembers && <DropdownMenuItem className="pm-agent-menu-item" render={<Link to={`${base}/members?tab=members`} data-navigation-close data-automation-leave-guarded="true" onClick={(event) => { if (!canLeave()) event.preventDefault(); }} />}>
                <Users /><span className="pm-agent-menu-text"><strong>{t("成员与团队", "Members & teams")}</strong></span>
              </DropdownMenuItem>}
              </>}
              <DropdownMenuItem className="pm-agent-menu-item" render={<Link to="/pm" data-navigation-close data-automation-leave-guarded="true" onClick={(event) => { if (!canLeave()) event.preventDefault(); }} />}>
                <LayoutGrid /><span className="pm-agent-menu-text"><strong>{t("全部工作区", "All workspaces")}</strong></span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          {(state.identityLoading || state.identityError || workspaces.some(workspace => workspace.id !== scope?.workspaceId)) && <>
          <DropdownMenuSeparator className="pm-agent-menu-separator" />
          <DropdownMenuGroup>
            <DropdownMenuLabel className="pm-agent-menu-label">{t("切换工作区", "Switch workspace")}</DropdownMenuLabel>
            {state.identityLoading && !state.identity ? <DropdownMenuItem className="pm-agent-menu-item" disabled>
              <LoaderCircle className="animate-spin" /><span className="pm-agent-menu-text"><strong>{t("正在加载工作区…", "Loading workspaces…")}</strong></span>
            </DropdownMenuItem> : state.identityError ? <DropdownMenuItem className="pm-agent-menu-item" disabled>
              <span className="pm-agent-menu-text"><strong>{t("暂时无法读取工作区", "Workspaces unavailable")}</strong></span>
            </DropdownMenuItem> : workspaces.length ? workspaces.map((workspace) => {
              const current = workspace.id === scope?.workspaceId;
              return <DropdownMenuItem
                key={workspace.id}
                disabled={current || pending}
                closeOnClick={!current}
                onClick={() => onSelectScope({ workspaceId: workspace.id, projectId: null })}
                className="pm-agent-menu-item"
                data-current={current || undefined}
                aria-current={current ? "location" : undefined}
              >
                <WorkspaceBadge icon={workspace.icon} color={workspace.color} />
                <span className="pm-agent-menu-text"><strong>{workspace.name}</strong></span>
                {current && <span className="pm-agent-menu-meta"><Check aria-hidden="true" /></span>}
              </DropdownMenuItem>;
            }) : <DropdownMenuItem className="pm-agent-menu-item" disabled>
              <span className="pm-agent-menu-text"><strong>{t("尚无有权访问的工作区", "No workspaces you can access")}</strong></span>
            </DropdownMenuItem>}
          </DropdownMenuGroup>
          </>}
          {state.identityError && <p role="alert" className="pm-agent-menu-error">{t("工作区读取失败：", "Failed to load workspaces: ")}{state.identityError}</p>}
          <DropdownMenuSeparator className="pm-agent-menu-separator" />
          {state.identityError && <DropdownMenuItem className="pm-agent-menu-item" disabled={busy} closeOnClick={false} onClick={() => { void refresh(); }}>
            <RefreshCw />{t("重试读取工作区", "Retry workspace loading")}
          </DropdownMenuItem>}
          <DropdownMenuItem className="pm-agent-menu-item" closeOnClick={false} aria-expanded={moreOpen} onSelect={() => setMoreOpen(open => !open)}>
            <Ellipsis />{t("更多操作", "More actions")}<ChevronDown className={`ml-auto ${moreOpen ? "rotate-180" : ""}`} aria-hidden="true" />
          </DropdownMenuItem>
          {moreOpen && <DropdownMenuItem className="pm-agent-menu-item" disabled={busy} closeOnClick={false} onClick={() => { void refresh(); }}>
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            <span className="pm-agent-menu-text"><strong>{refreshing ? t("正在刷新…", "Refreshing…") : t("刷新工作区", "Refresh workspaces")}</strong></span>
          </DropdownMenuItem>}
        </DropdownMenuContent>
  </DropdownMenu>;
}
