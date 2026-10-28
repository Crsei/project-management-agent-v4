import { useEffect, useState } from "react";
import { FolderIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileAreaDialog } from "../pm/file-area-dialog";
import { pmJson, refreshCatalog, scopeKey, usePmChatState, type AgentFileArea, type AgentScope } from "../pm/state";
import { agentStorageSettingsSchema, type AgentStorageSettings } from "../../../../packages/contracts/src/agent-file-areas";
import { SettingsNotice, SettingsSection, useSettingsGuard } from "./settings-layout";
import "../../styles/pm-chat.css";
import "./file-areas-history.css";

const statusLabels: Record<AgentFileArea["status"], string> = {
  available: "目录可用", unconfigured: "尚未配置", unavailable: "目录不可用",
};
const sourceLabels = { explicit: "显式配置", project_location: "复用已登记的项目目录", default: "Chat Space 默认目录" };
type DirectoryTarget = { scope: AgentScope; name: string; fileArea: AgentFileArea };

export default function FileAreasPage() {
  const state = usePmChatState();
  const [directory, setDirectory] = useState<DirectoryTarget>();
  const [workspaceId, setWorkspaceId] = useState("");
  const [rootEditing, setRootEditing] = useState(false);
  const workspace = state.catalog?.workspaces.find((item) => item.id === workspaceId) ?? state.catalog?.workspaces[0];
  const { setGuard } = useSettingsGuard();
  useEffect(() => { void refreshCatalog().catch(() => {}); }, []);

  const areaRow = (target: DirectoryTarget) => <div className="agent-file-area-row" key={scopeKey(target.scope)}>
    <div className="agent-file-area-identity">
      <FolderIcon aria-hidden="true" />
      <div><h3>{target.name}</h3><p>{target.scope.projectId ? `项目 · ${target.scope.projectId}` : "工作区级文件区域"}</p></div>
    </div>
    <dl className="agent-file-area-facts">
      <div><dt>状态</dt><dd><span className="agent-file-area-status" data-status={target.fileArea.status}>{target.fileArea.reason === "initializes_on_first_use" ? "默认目录 · 首次使用时创建" : statusLabels[target.fileArea.status]}</span></dd></div>
      <div><dt>目录来源</dt><dd>{target.fileArea.source ? sourceLabels[target.fileArea.source] : "未设置"}</dd></div>
      <div><dt>配置版本</dt><dd>revision {target.fileArea.revision}</dd></div>
      <div><dt>当前权限</dt><dd>{target.fileArea.canManage ? "可管理" : "只读 · 不可管理"}</dd></div>
      <div className="agent-file-area-path"><dt>服务端路径</dt><dd><code>{target.fileArea.path ?? "未提供可访问路径"}</code></dd></div>
    </dl>
    {target.fileArea.reason && target.fileArea.reason !== "initializes_on_first_use" && <p className="agent-file-area-reason">{target.fileArea.reason}</p>}
    <div className="agent-file-area-actions"><Button type="button" size="sm" variant="outline" disabled={state.loading || !!state.error || !target.fileArea.canManage} onClick={() => setDirectory(target)} aria-label={`配置${target.name}文件区域`}><SettingsIcon aria-hidden="true" />配置文件区域</Button></div>
  </div>;

  return <div className="agent-file-areas-settings">
    <SettingsSection title="工作区默认保存根目录" scope="workspace" description="Chat Space 的部署默认值为 ~/.pmv3，其中 ~ 指运行 PM 服务的用户主目录，不是浏览器所在电脑或当前仓库。">
      <label className="pm-agent-directory-form">选择工作区
        <select aria-label="默认保存根目录所属工作区" value={workspace?.id ?? ""} disabled={rootEditing || !!directory || state.loading || !!state.error} onChange={(event) => setWorkspaceId(event.target.value)}>
          {!workspace && <option value="">没有可访问的工作区</option>}
          {state.catalog?.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {workspace && <WorkspaceSaveRoot key={workspace.id} workspaceId={workspace.id} name={workspace.name} disabled={state.loading || !!state.error || !!directory} onEditing={setRootEditing} />}
      <p className="text-sm text-muted-foreground">覆盖值只影响所选工作区将来首次分配的默认文件区域，工作区与各项目使用不同子目录。显式配置和已登记的项目目录优先；现有目录与已保存文件不会移动，不迁移 PM 数据库、Agent SQLite 或 Provider homes。</p>
    </SettingsSection>
    <SettingsSection title="工作区与项目文件区域" scope="workspace" description="与聊天侧栏共用真实 PM 目录册和配置。更改只影响后续接受的执行，不修改历史归属或已接受的目录快照。">
      <div className="agent-settings-page-toolbar"><p>展示当前身份获授权的全部工作区与项目，包括没有会话的分组。</p><Button type="button" variant="outline" size="sm" disabled={state.loading || !!directory} onClick={() => void refreshCatalog().catch(() => {})}><RefreshCwIcon aria-hidden="true" className={state.loading ? "animate-spin" : undefined} />{state.loading ? "正在刷新…" : "刷新目录册"}</Button></div>
      {state.loading && !state.catalog && <SettingsNotice kind="loading">正在读取真实工作区与项目…</SettingsNotice>}
      {state.error && <SettingsNotice kind="error" onRetry={() => void refreshCatalog().catch(() => {})}>目录册读取失败：{state.error}。已显示的数据可能过期，配置操作已禁用。请确认 PM 登录及当前访问范围。</SettingsNotice>}
      {!state.loading && !state.error && state.catalog?.workspaces.length === 0 && <SettingsNotice kind="info">当前没有可访问的工作区。请先在 PM 登录并确认工作区访问权限；此处不会创建示例目录或回退仓库根目录。</SettingsNotice>}
      {state.catalog?.workspaces.map((workspace) => <section className="agent-file-area-workspace" key={workspace.id} aria-label={`${workspace.name}文件区域`}>
        <header><h2>{workspace.name}</h2><code>{workspace.id}</code></header>
        {areaRow({ scope: { workspaceId: workspace.id, projectId: null }, name: `${workspace.name} · 工作区`, fileArea: workspace.fileArea })}
        <div className="agent-file-area-projects"><h3>项目文件区域</h3>{workspace.projects.map((project) => areaRow({ scope: { workspaceId: workspace.id, projectId: project.id }, name: project.name, fileArea: project.fileArea }))}
          {!workspace.projects.length && <p className="agent-settings-empty">此工作区暂无当前可访问的项目，工作区文件区域仍可单独配置。</p>}
        </div>
      </section>)}
    </SettingsSection>
    <SettingsNotice kind="info">目录不是新的授权或隔离沙箱。浏览与保存继续使用服务端 allowedRoots、当前管理权限和 revision 检查。安全的默认目录在首次使用时由服务端创建并登记；目录册读取不创建目录，已登记但丢失的目录不会自动重建。</SettingsNotice>
    {directory && <FileAreaDialog key={scopeKey(directory.scope)} {...directory} onDraftStateChange={setGuard} onClose={() => { setGuard("clean"); setDirectory(undefined); }} />}
  </div>;
}

function WorkspaceSaveRoot({ workspaceId, name, disabled, onEditing }: {
  workspaceId: string; name: string; disabled: boolean; onEditing: (editing: boolean) => void;
}) {
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
    {loading && <SettingsNotice kind="loading">正在读取工作区默认保存设置…</SettingsNotice>}
    {error && <SettingsNotice kind="error" onRetry={() => setReload((value) => value + 1)}>设置读取失败：{error}。不会使用猜测的路径或版本保存。</SettingsNotice>}
    {settings && <div className="agent-file-area-row">
      <dl className="agent-file-area-facts">
        <div className="agent-file-area-path"><dt>部署默认根目录</dt><dd><code>{settings.defaultRoot ?? "未提供"}</code></dd></div>
        <div className="agent-file-area-path"><dt>工作区当前默认保存根目录</dt><dd><code>{settings.effectiveRoot ?? "不可用"}</code></dd></div>
        <div><dt>设置版本</dt><dd>revision {settings.revision}</dd></div>
        <div><dt>当前权限</dt><dd>{settings.canManage ? "可管理" : "只读 · 不可管理"}</dd></div>
      </dl>
      <div className="agent-file-area-actions"><Button type="button" variant="outline" size="sm" disabled={disabled || loading || !!error || !settings.canManage} onClick={() => { setEditing(true); onEditing(true); }}><SettingsIcon />更改默认保存根目录</Button></div>
    </div>}
    {editing && settings && <FileAreaDialog storageRoot scope={{ workspaceId, projectId: null }} name={name}
      fileArea={{ path: settings.effectiveRoot, revision: settings.revision, canManage: settings.canManage, source: "default", status: settings.effectiveRoot ? "available" : "unavailable" }}
      onStorageSaved={setSettings} onDraftStateChange={setGuard}
      onClose={() => { setGuard("clean"); setEditing(false); onEditing(false); setLoading(true); setReload((value) => value + 1); }} />}
  </>;
}
