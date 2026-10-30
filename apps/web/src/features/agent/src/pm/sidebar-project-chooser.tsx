import { useState } from "react";
import { Link } from "react-router-dom";
import { Popover } from "@base-ui/react/popover";
import { ExternalLinkIcon, FolderIcon, FolderPlusIcon, MessageSquareIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { sameScope, type AgentCatalog, type AgentFileArea, type AgentScope, type PmIdentity } from "./state";
import { useAgentText } from "../i18n";

type ScopeGroup = { scope: AgentScope; name: string; fileArea: AgentFileArea };

/** The chooser is populated from the authorized catalog, not from existing threads. */
export function SidebarProjectChooser({ catalog, identity, scope, pending, loading, error, canLeave, onSelect, onConfigure, onRefresh }: {
  catalog: AgentCatalog | null;
  identity: PmIdentity | null;
  scope?: AgentScope;
  pending: boolean;
  loading: boolean;
  error?: string;
  canLeave: () => boolean;
  onSelect: (scope: AgentScope, create?: boolean) => void;
  onConfigure: (group: ScopeGroup) => void;
  onRefresh: () => void;
}) {
  const t = useAgentText();
  const [open, setOpen] = useState(false);
  const select = (target: AgentScope, create = false) => { setOpen(false); onSelect(target, create); };
  const groupRow = (group: ScopeGroup) => <div className="pm-agent-chooser-row" key={JSON.stringify([group.scope.workspaceId, group.scope.projectId])} data-active={sameScope(scope, group.scope)}>
    <button type="button" className="pm-agent-chooser-select" disabled={pending || !!error} onClick={() => select(group.scope)} title={group.name}>
      {group.scope.projectId ? <FolderIcon /> : <MessageSquareIcon />}<span>{group.name}</span>
      {group.fileArea.status !== "available" && <span className="pm-agent-scope-warning" title={group.fileArea.status === "unconfigured" ? t("未配置目录", "Directory not configured") : t("目录不可用", "Directory unavailable")} aria-label={group.fileArea.status === "unconfigured" ? t("未配置目录", "Directory not configured") : t("目录不可用", "Directory unavailable")}>!</span>}
    </button>
    <button type="button" className="pm-agent-icon" aria-label={t(`配置${group.name}文件区域`, `Configure file area for ${group.name}`)} title={t("配置文件区域", "Configure file area")} onClick={() => { setOpen(false); onConfigure(group); }}><SettingsIcon /></button>
    <button type="button" className="pm-agent-icon" disabled={pending || !!error} aria-label={t(`在${group.name}新建会话`, `New session in ${group.name}`)} title={t("新建会话", "New session")} onClick={() => select(group.scope, true)}><PlusIcon /></button>
    {group.scope.projectId && <Link className="pm-agent-icon" data-automation-leave-guarded="true" aria-label={t(`在 PM 中管理${group.name}`, `Manage ${group.name} in PM`)} title={t("在 PM 中管理项目", "Manage project in PM")} to={`/pm/${encodeURIComponent(group.scope.workspaceId)}/projects/${encodeURIComponent(group.scope.projectId)}`} onClick={(event) => { if (!canLeave()) event.preventDefault(); }}><ExternalLinkIcon /></Link>}
  </div>;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="pm-agent-icon" aria-label={t("选择工作区或项目", "Select workspace or project")} title={t("选择工作区或项目", "Select workspace or project")}><FolderPlusIcon /></Popover.Trigger>
    <Popover.Portal><Popover.Positioner className="pm-agent-chooser-positioner" side="bottom" align="start" sideOffset={6}>
      <Popover.Popup className="pm-agent-chooser">
        <Popover.Title className="pm-agent-chooser-title">{t("工作区与项目", "Workspaces & projects")}</Popover.Title>
        {loading && !catalog && <p role="status" className="pm-agent-empty-group">{t("正在读取工作区…", "Loading workspaces…")}</p>}
        {error && <div role="alert" className="pm-agent-sidebar-error">{t("工作区读取失败：", "Failed to load workspaces: ")}{error}<button type="button" className="pm-agent-chooser-retry" onClick={onRefresh}>{t("重新读取", "Retry")}</button></div>}
        {catalog?.workspaces.map((workspace) => {
          const root = `/pm/${encodeURIComponent(workspace.id)}`;
          const current = identity?.workspaces.find((item) => item.id === workspace.id);
          const canCreate = !!current && current.projectIds === null && current.capabilities.includes("planning.edit");
          return <section className="pm-agent-chooser-workspace" key={workspace.id}>
            <div className="pm-agent-chooser-heading"><strong title={workspace.name}>{workspace.name}</strong><Link data-automation-leave-guarded="true" to={`${root}/projects`} title={t("在 PM 中管理项目", "Manage projects in PM")} aria-label={t(`在 PM 中管理${workspace.name}的项目`, `Manage projects of ${workspace.name} in PM`)} onClick={(event) => { if (!canLeave()) event.preventDefault(); }}>{t("管理", "Manage")}</Link>{canCreate && <Link data-automation-leave-guarded="true" to={`${root}/views?${new URLSearchParams({ kind: "project", create: "1", returnTo: `${root}/projects` })}`} title={t("在 PM 中新建项目", "Create project in PM")} aria-label={t(`在${workspace.name}新建项目`, `Create project in ${workspace.name}`)} onClick={(event) => { if (!canLeave()) event.preventDefault(); }}>{t("新建项目", "New project")}</Link>}</div>
            {groupRow({ scope: { workspaceId: workspace.id, projectId: null }, name: t("工作区会话", "Workspace sessions"), fileArea: workspace.fileArea })}
            {workspace.projects.map((project) => groupRow({ scope: { workspaceId: workspace.id, projectId: project.id }, name: project.name, fileArea: project.fileArea }))}
            {!workspace.projects.length && <p className="pm-agent-empty-group">{t("此工作区暂无项目", "No projects in this workspace yet")}</p>}
          </section>;
        })}
        {!loading && !error && !catalog?.workspaces.length && <p className="pm-agent-empty-group">{t("没有可访问的 PM 工作区。", "No PM workspaces you can access.")}</p>}
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}
