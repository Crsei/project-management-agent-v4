import { useState } from "react";
import { Link } from "react-router-dom";
import { Menu } from "@base-ui/react/menu";
import { Bot, Check, ChevronsUpDown, FolderKanban, LayoutGrid, LoaderCircle, RefreshCw, Settings, Users } from "lucide-react";
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
  { id: "project-management", title: "Project Management", icon: FolderKanban },
  { id: "agent-workspace", title: "Agent Chat", icon: Bot },
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
  const canReadMembers = !!identityWorkspace && (identityWorkspace.capabilities.includes("access.manage") || identityWorkspace.capabilities.includes("directory.read"));
  const busy = pending || refreshing;

  const refresh = async () => {
    if (busy) return;
    setRefreshing(true);
    try { await Promise.all([refreshIdentity(), refreshCatalog().catch(() => {})]); }
    finally { setRefreshing(false); }
  };

  return <Menu.Root>
    <Menu.Trigger
      className="pm-agent-switcher-trigger"
      aria-label={t(`工作区：${name}。当前工作空间：${currentProduct.title}。切换工作区或工作空间`, `Workspace: ${name}. Current product: ${currentProduct.title}. Switch workspace or product`)}
      aria-busy={pending || state.identityLoading}
    >
      <WorkspaceBadge icon={identityWorkspace?.icon} color={identityWorkspace?.color} />
      <span className="pm-agent-switcher-text">
        <span className="pm-agent-switcher-name" title={name}>{name}</span>
        <span className="pm-agent-switcher-desc"><CurrentProductIcon />{currentProduct.title}</span>
      </span>
      {pending || state.identityLoading ? <LoaderCircle className="animate-spin" /> : <ChevronsUpDown className="pm-agent-switcher-chevron" />}
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner side="bottom" align="start" sideOffset={6}>
        <Menu.Popup className="pm-agent-switcher-menu">
          {scope && !state.identityError && <>
            <Menu.Group>
              <Menu.GroupLabel className="pm-agent-menu-label">{t("工作空间", "Product")}</Menu.GroupLabel>
              {PRODUCTS.map((product) => {
                const current = product.id === currentProduct.id;
                const Icon = product.icon;
                return <Menu.Item
                  key={product.id}
                  label={product.title}
                  disabled={current}
                  closeOnClick={!current}
                  render={current ? undefined : <Link to={pmHref} data-navigation-close data-automation-leave-guarded="true" onClick={(event) => { if (!canLeave()) event.preventDefault(); }} />}
                  className="pm-agent-menu-item"
                  data-current={current || undefined}
                >
                  <span className="pm-agent-menu-icon" data-product={product.id}><Icon /></span>
                  <span className="pm-agent-menu-text"><strong>{product.title}</strong></span>
                  {current && <span className="pm-agent-menu-meta">{t("当前", "Current")}<Check /></span>}
                </Menu.Item>;
              })}
            </Menu.Group>
            <Menu.Separator className="pm-agent-menu-separator" />
            <Menu.Group>
              <Menu.GroupLabel className="pm-agent-menu-label">{t("当前工作区入口", "Current workspace")}</Menu.GroupLabel>
              <Menu.Item className="pm-agent-menu-item" render={<Link to={`${base}/settings/general`} data-navigation-close data-automation-leave-guarded="true" onClick={(event) => { if (!canLeave()) event.preventDefault(); }} />}>
                <Settings /><span className="pm-agent-menu-text"><strong>{t("工作区设置", "Workspace settings")}</strong></span>
              </Menu.Item>
              {canReadMembers && <Menu.Item className="pm-agent-menu-item" render={<Link to={`${base}/members?tab=members`} data-navigation-close data-automation-leave-guarded="true" onClick={(event) => { if (!canLeave()) event.preventDefault(); }} />}>
                <Users /><span className="pm-agent-menu-text"><strong>{t("成员与团队", "Members & teams")}</strong></span>
              </Menu.Item>}
            </Menu.Group>
            <Menu.Separator className="pm-agent-menu-separator" />
          </>}
          <Menu.Group>
            <Menu.GroupLabel className="pm-agent-menu-label">{t("切换工作区", "Switch workspace")}</Menu.GroupLabel>
            {state.identityLoading && !state.identity ? <Menu.Item className="pm-agent-menu-item" disabled>
              <LoaderCircle className="animate-spin" /><span className="pm-agent-menu-text"><strong>{t("正在加载工作区…", "Loading workspaces…")}</strong></span>
            </Menu.Item> : state.identityError ? <Menu.Item className="pm-agent-menu-item" disabled>
              <span className="pm-agent-menu-text"><strong>{t("暂时无法读取工作区", "Workspaces unavailable")}</strong></span>
            </Menu.Item> : workspaces.length ? workspaces.map((workspace) => {
              const current = workspace.id === scope?.workspaceId;
              return <Menu.Item
                key={workspace.id}
                label={workspace.name}
                disabled={current || pending}
                closeOnClick={!current}
                onClick={() => onSelectScope({ workspaceId: workspace.id, projectId: null })}
                className="pm-agent-menu-item"
                data-current={current || undefined}
              >
                <WorkspaceBadge icon={workspace.icon} color={workspace.color} />
                <span className="pm-agent-menu-text"><strong>{workspace.name}</strong></span>
                {current && <span className="pm-agent-menu-meta">{t("当前", "Current")}<Check /></span>}
              </Menu.Item>;
            }) : <Menu.Item className="pm-agent-menu-item" disabled>
              <span className="pm-agent-menu-text"><strong>{t("尚无有权访问的工作区", "No workspaces you can access")}</strong></span>
            </Menu.Item>}
          </Menu.Group>
          {state.identityError && <p role="alert" className="pm-agent-menu-error">{t("工作区读取失败：", "Failed to load workspaces: ")}{state.identityError}</p>}
          <Menu.Separator className="pm-agent-menu-separator" />
          <Menu.Item className="pm-agent-menu-item" disabled={busy} closeOnClick={false} onClick={() => { void refresh(); }}>
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            <span className="pm-agent-menu-text"><strong>{refreshing ? t("正在刷新…", "Refreshing…") : t("刷新工作区", "Refresh workspaces")}</strong></span>
          </Menu.Item>
          <Menu.Item className="pm-agent-menu-item" render={<Link to="/pm" data-navigation-close data-automation-leave-guarded="true" onClick={(event) => { if (!canLeave()) event.preventDefault(); }} />}>
            <LayoutGrid /><span className="pm-agent-menu-text"><strong>{t("全部工作区", "All workspaces")}</strong></span>
          </Menu.Item>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
}
