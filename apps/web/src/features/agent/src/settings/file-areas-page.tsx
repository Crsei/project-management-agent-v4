import { useEffect, useState } from "react";
import { FolderIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { FileAreaDialog } from "../pm/file-area-dialog";
import { pmJson, refreshCatalog, scopeKey, usePmChatState, type AgentFileArea, type AgentScope } from "../pm/state";
import { agentStorageSettingsSchema, type AgentStorageSettings } from "../../../../../../../packages/contracts/src/agent-file-areas";
import { useAgentText, type AgentText } from "../i18n";
import { SettingsNotice, SettingsSection, useSettingsGuard } from "./settings-layout";
import "../../styles/pm-chat.css";
import "./file-areas-history.css";
import { RadixSelect } from "@/components/ui/radix-select"

const statusLabels = (t: AgentText): Record<AgentFileArea["status"], string> => ({
  available: t("目录可用", "Directory available"), unconfigured: t("尚未配置", "Not configured"), unavailable: t("目录不可用", "Directory unavailable"),
});
const sourceLabels = (t: AgentText) => ({ explicit: t("显式配置", "Explicitly configured"), project_location: t("复用已登记的项目目录", "Reuses a registered project directory"), default: t("Chat Space 默认目录", "Chat Space default directory") });
type DirectoryTarget = { scope: AgentScope; name: string; fileArea: AgentFileArea };

export default function FileAreasPage() {
  const t = useAgentText();
  const state = usePmChatState();
  const [directory, setDirectory] = useState<DirectoryTarget>();
  const [workspaceId, setWorkspaceId] = useState("");
  const [rootEditing, setRootEditing] = useState(false);
  const workspace = state.catalog?.workspaces.find((item) => item.id === workspaceId) ?? state.catalog?.workspaces[0];
  const { setGuard } = useSettingsGuard();
  useEffect(() => { void refreshCatalog().catch(() => {}); }, []);
  const status = statusLabels(t);
  const source = sourceLabels(t);

  const areaRow = (target: DirectoryTarget) => <div className="agent-file-area-row" key={scopeKey(target.scope)}>
    <div className="agent-file-area-identity">
      <FolderIcon aria-hidden="true" />
      <div><h3>{target.name}</h3><p>{target.scope.projectId ? t(`项目 · ${target.scope.projectId}`, `Project · ${target.scope.projectId}`) : t("工作区级文件区域", "Workspace-level file area")}</p></div>
    </div>
    <dl className="agent-file-area-facts">
      <div><dt>{t("状态", "Status")}</dt><dd><span className="agent-file-area-status" data-status={target.fileArea.status}>{target.fileArea.reason === "initializes_on_first_use" ? t("默认目录 · 首次使用时创建", "Default directory · created on first use") : status[target.fileArea.status]}</span></dd></div>
      <div><dt>{t("目录来源", "Directory source")}</dt><dd>{target.fileArea.source ? source[target.fileArea.source] : t("未设置", "Not set")}</dd></div>
      <div><dt>{t("配置版本", "Config revision")}</dt><dd>revision {target.fileArea.revision}</dd></div>
      <div><dt>{t("当前权限", "Current permission")}</dt><dd>{target.fileArea.canManage ? t("可管理", "Manageable") : t("只读 · 不可管理", "Read-only · not manageable")}</dd></div>
      <div className="agent-file-area-path"><dt>{t("服务端路径", "Server path")}</dt><dd><code>{target.fileArea.path ?? t("未提供可访问路径", "No accessible path provided")}</code></dd></div>
    </dl>
    {target.fileArea.reason && target.fileArea.reason !== "initializes_on_first_use" && <p className="agent-file-area-reason">{target.fileArea.reason}</p>}
    <div className="agent-file-area-actions"><Button type="button" size="sm" variant="outline" disabled={state.loading || !!state.error || !target.fileArea.canManage} onClick={() => setDirectory(target)} aria-label={t(`配置${target.name}文件区域`, `Configure file area for ${target.name}`)}><SettingsIcon aria-hidden="true" />{t("配置文件区域", "Configure file area")}</Button></div>
  </div>;

  return <div className="agent-file-areas-settings">
    <SettingsSection title={t("工作区默认保存根目录", "Workspace default save root")} scope="workspace">
      <label className="pm-agent-directory-form">{t("选择工作区", "Select workspace")}
        <RadixSelect aria-label={t("默认保存根目录所属工作区", "Workspace for the default save root")} value={workspace?.id ?? ""} disabled={rootEditing || !!directory || state.loading || !!state.error} onChange={(event) => setWorkspaceId(event.target.value)}>
          {!workspace && <option value="">{t("没有可访问的工作区", "No accessible workspace")}</option>}
          {state.catalog?.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </RadixSelect>
      </label>
      {workspace && <WorkspaceSaveRoot key={workspace.id} workspaceId={workspace.id} name={workspace.name} disabled={state.loading || !!state.error || !!directory} onEditing={setRootEditing} />}
    </SettingsSection>
    <SettingsSection title={t("工作区与项目文件区域", "Workspace & project file areas")} scope="workspace">
      <div className="agent-settings-page-toolbar"><Button type="button" variant="outline" size="sm" disabled={state.loading || !!directory} onClick={() => void refreshCatalog().catch(() => {})}><RefreshCwIcon aria-hidden="true" className={state.loading ? "animate-spin" : undefined} />{state.loading ? t("正在刷新…", "Refreshing…") : t("刷新目录册", "Refresh catalog")}</Button></div>
      {state.loading && !state.catalog && <SettingsNotice kind="loading">{t("正在读取真实工作区与项目…", "Loading actual workspaces and projects…")}</SettingsNotice>}
      {state.error && <SettingsNotice kind="error" onRetry={() => void refreshCatalog().catch(() => {})}>{t(`目录册读取失败：${state.error}。已显示的数据可能过期，配置操作已禁用。请确认 PM 登录及当前访问范围。`, `Failed to load the catalog: ${state.error}. Displayed data may be stale and configuration actions are disabled. Confirm your PM sign-in and current access scope.`)}</SettingsNotice>}
      {!state.loading && !state.error && state.catalog?.workspaces.length === 0 && <SettingsNotice kind="info">{t("当前没有可访问的工作区。请先在 PM 登录并确认工作区访问权限；此处不会创建示例目录或回退仓库根目录。", "No accessible workspaces. Sign in to PM and confirm workspace access first; this page never creates sample directories or falls back to the repository root.")}</SettingsNotice>}
      {state.catalog?.workspaces.map((workspace) => <section className="agent-file-area-workspace" key={workspace.id} aria-label={t(`${workspace.name}文件区域`, `${workspace.name} file areas`)}>
        <header><h2>{workspace.name}</h2><code>{workspace.id}</code></header>
        {areaRow({ scope: { workspaceId: workspace.id, projectId: null }, name: `${workspace.name} · ${t("工作区", "Workspace")}`, fileArea: workspace.fileArea })}
        <div className="agent-file-area-projects"><h3>{t("项目文件区域", "Project file areas")}</h3>{workspace.projects.map((project) => areaRow({ scope: { workspaceId: workspace.id, projectId: project.id }, name: project.name, fileArea: project.fileArea }))}
          {!workspace.projects.length && <p className="agent-settings-empty">{t("此工作区暂无当前可访问的项目，工作区文件区域仍可单独配置。", "This workspace has no accessible projects right now; the workspace file area can still be configured on its own.")}</p>}
        </div>
      </section>)}
    </SettingsSection>
    {directory && <FileAreaDialog key={scopeKey(directory.scope)} {...directory} onDraftStateChange={setGuard} onClose={() => { setGuard("clean"); setDirectory(undefined); }} />}
  </div>;
}

function WorkspaceSaveRoot({ workspaceId, name, disabled, onEditing }: {
  workspaceId: string; name: string; disabled: boolean; onEditing: (editing: boolean) => void;
}) {
  const t = useAgentText();
  const [settings, setSettings] = useState<AgentStorageSettings>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  const { setGuard } = useSettingsGuard();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void pmJson<unknown>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-storage-settings`, { signal: controller.signal })
      .then((body) => { if (!controller.signal.aborted) setSettings(agentStorageSettingsSchema.parse(body)); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, reload]);
  useEffect(() => () => onEditing(false), [onEditing]);
  return <>
    {loading && <SettingsNotice kind="loading">{t("正在读取工作区默认保存设置…", "Loading workspace default save settings…")}</SettingsNotice>}
    {error && <SettingsNotice kind="error" onRetry={() => setReload((value) => value + 1)}>{t(`设置读取失败：${error}。不会使用猜测的路径或版本保存。`, `Failed to load settings: ${error}. Changes are never saved with a guessed path or revision.`)}</SettingsNotice>}
    {settings && <div className="agent-file-area-row">
      <dl className="agent-file-area-facts">
        <div className="agent-file-area-path"><dt>{t("部署默认根目录", "Deployment default root")}</dt><dd><code>{settings.defaultRoot ?? t("未提供", "Not provided")}</code></dd></div>
        <div className="agent-file-area-path"><dt>{t("工作区当前默认保存根目录", "Current workspace default save root")}</dt><dd><code>{settings.effectiveRoot ?? t("不可用", "Unavailable")}</code></dd></div>
        <div><dt>{t("设置版本", "Settings revision")}</dt><dd>revision {settings.revision}</dd></div>
        <div><dt>{t("当前权限", "Current permission")}</dt><dd>{settings.canManage ? t("可管理", "Manageable") : t("只读 · 不可管理", "Read-only · not manageable")}</dd></div>
      </dl>
      <div className="agent-file-area-actions"><Button type="button" variant="outline" size="sm" disabled={disabled || loading || !!error || !settings.canManage} onClick={() => { setEditing(true); onEditing(true); }}><SettingsIcon />{t("更改默认保存根目录", "Change default save root")}</Button></div>
    </div>}
    {editing && settings && <FileAreaDialog storageRoot scope={{ workspaceId, projectId: null }} name={name}
      fileArea={{ path: settings.effectiveRoot, revision: settings.revision, canManage: settings.canManage, source: "default", status: settings.effectiveRoot ? "available" : "unavailable" }}
      onStorageSaved={setSettings} onDraftStateChange={setGuard}
      onClose={() => { setGuard("clean"); setEditing(false); onEditing(false); setLoading(true); setReload((value) => value + 1); }} />}
  </>;
}
