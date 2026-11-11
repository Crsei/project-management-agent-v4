import { useEffect, useRef, useState } from "react";
import type { AgentWorkspace, ExecutionEnvironment, ExecutionSelection } from "@agent-workspace/contracts/chat";
import { executionPolicySchema, type ExecutionPolicy } from "@agent-workspace/contracts/pm-references";
import { FolderIcon, ArrowUpIcon } from "lucide-react";
import { RadixSelect } from "@/components/ui/radix-select";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import { acceptAgentWorkspace, CHAT_ONLY_SELECTION, refreshAgentWorkspaces, usePmChatState, workspaceExecutionSelection } from "./state";
import { agentWorkspaceSelectionIssue } from "./execution-selection-state";
import { desktopDirectoryBridge } from "../workspace/inspector/preview-bridge";

type DirectoryListing = { path: string | null; parentPath: string | null; roots: string[]; directories: { name: string; path: string }[] };

export function OpenFolderDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (workspace: AgentWorkspace) => void }) {
  const t = useAgentText();
  const nativeDirectories = desktopDirectoryBridge();
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const browseRequest = useRef(0);
  const locked = busy || choosing;
  const browse = async (target?: string) => {
    const request = ++browseRequest.current;
    setLoading(true); setError(undefined);
    try {
      const result = await workspaceClient.json<DirectoryListing>(`/api/agent-workspaces/directories${target ? `?${new URLSearchParams({ path: target })}` : ""}`);
      if (browseRequest.current !== request) return;
      setListing(result);
      setPath(result.path ?? "");
    } catch (cause) { if (browseRequest.current === request) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (browseRequest.current === request) setLoading(false); }
  };
  useEffect(() => { void browse(); return () => { browseRequest.current++; }; }, []);
  const choose = async () => {
    if (!nativeDirectories) { await browse(); return; }
    setChoosing(true); setError(undefined);
    try {
      const selected = await nativeDirectories.choose();
      if (selected !== null) {
        setPath(selected);
        await browse(selected);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChoosing(false); }
  };
  const open = async () => {
    setBusy(true); setError(undefined);
    try {
      const { workspace } = await workspaceClient.json<{ workspace: AgentWorkspace }>("/api/agent-workspaces/open", { method: "POST", body: JSON.stringify({ path: path.trim() }) });
      acceptAgentWorkspace(workspace);
      onOpened(workspace);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !locked) onClose(); }}><DialogContent className="pm-agent-directory-dialog max-h-[90dvh] overflow-y-auto sm:max-w-xl">
    <DialogHeader><DialogTitle>{t("打开文件夹", "Open folder")}</DialogTitle><DialogDescription>{nativeDirectories
      ? t("选择这台电脑上的已有目录；Agent 仍会核验允许范围与目录身份。不会创建目录或移动代码。", "Choose an existing folder on this computer. Agent still validates its allowed roots and directory identity; no folder is created or code moved.")
      : t("选择 Agent 服务机器上的已有目录。浏览器／远程模式不能选择或上传这台电脑的本地目录。", "Choose an existing directory on the Agent server. Browser and remote modes cannot select or upload folders from this computer.")}</DialogDescription></DialogHeader>
    <Button type="button" variant="outline" disabled={locked || loading} onClick={() => void choose()}><FolderIcon />{choosing ? t("正在选择…", "Choosing…") : nativeDirectories ? t("选择文件夹", "Choose folder") : t("选择服务器文件夹", "Choose server folder")}</Button>
    <label>{nativeDirectories ? t("本地绝对路径", "Local absolute path") : t("服务器绝对路径", "Server absolute path")}<Input autoFocus value={path} disabled={locked || loading} autoComplete="off" spellCheck={false} onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing && path.trim() && !loading && !locked) void open(); }} /></label>
    <div className="inspector-toolbar"><Button type="button" variant="outline" size="sm" disabled={locked || loading || !path.trim()} onClick={() => void browse(path.trim())}>{t("浏览此目录", "Browse directory")}</Button><Button type="button" variant="ghost" size="sm" disabled={locked || loading} onClick={() => void browse()}>{t("允许的目录", "Allowed roots")}</Button>{listing?.parentPath && <Button type="button" variant="ghost" size="sm" disabled={locked || loading} onClick={() => void browse(listing.parentPath!)}><ArrowUpIcon />{t("上一级", "Parent")}</Button>}</div>
    {loading && <p role="status">{t("正在浏览服务器目录…", "Browsing server directories…")}</p>}
    {listing && <section aria-label={t("允许的根目录", "Allowed workspace roots")} className="space-y-1 text-sm">
      <strong>{t("允许的根目录", "Allowed workspace roots")}</strong>
      {listing.roots.length ? listing.roots.map(root => <code key={root} className="block break-all">{root}</code>) : <p>{t("没有可用的允许目录；请核对服务配置与磁盘可用性。", "No allowed roots are available. Check the service configuration and mounted directories.")}</p>}
      <p className="text-muted-foreground">{nativeDirectories
        ? t("其他磁盘或目录须在桌面连接设置中明确配置项目父目录并重新连接；选择文件夹不会扩大允许范围。", "For another drive or folder, explicitly configure the project parent in desktop connection settings and reconnect. Choosing a folder never expands access.")
        : t("未列出的目录须由服务操作者配置 AGENT_WORKSPACE_ALLOWED_ROOTS；默认仅允许服务用户 Home。", "The service operator must configure AGENT_WORKSPACE_ALLOWED_ROOTS for other directories. The default is the service user's Home only.")}</p>
    </section>}
    <div className="pm-agent-folder-browser" aria-label={t("服务器目录", "Server directories")} aria-busy={loading}>
      {listing?.path && <code>{listing.path}</code>}
      {(listing?.path ? listing.directories : listing?.roots.map(root => ({ name: root, path: root })) ?? []).map(directory => <Button type="button" key={`${directory.name}:${directory.path}`} className="w-full justify-start" variant="ghost" disabled={locked || loading} title={directory.path} onClick={() => void browse(directory.path)}><FolderIcon /><span className="truncate">{directory.name}</span></Button>)}
      {listing?.path && !listing.directories.length && !loading && <p>{t("没有可浏览的子目录；仍可打开当前目录。", "No browsable subdirectories. You can still open this folder.")}</p>}
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={locked} onClick={onClose}>{t("取消", "Cancel")}</Button><Button disabled={locked || loading || !path.trim()} onClick={() => void open()}>{busy ? t("正在打开…", "Opening…") : t("打开文件夹", "Open folder")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export async function updateAgentWorkspace(workspace: AgentWorkspace, patch: { name?: string; archived?: boolean }): Promise<AgentWorkspace> {
  const result = await workspaceClient.json<{ workspace: AgentWorkspace }>(`/api/agent-workspaces/${encodeURIComponent(workspace.id)}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: workspace.revision, ...patch }) });
  acceptAgentWorkspace(result.workspace);
  return result.workspace;
}

export function useExecutionEnvironment(threadId?: string, revision?: number) {
  const key = JSON.stringify([threadId, revision]);
  const [result, setResult] = useState<{ key: string; environment?: ExecutionEnvironment; executionPolicy?: ExecutionPolicy; error?: string; loading: boolean }>({ key: "", loading: false });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!threadId) { setResult({ key, loading: false }); return; }
    const controller = new AbortController();
    setResult({ key, loading: true });
    void workspaceClient.json<{ environment: ExecutionEnvironment; executionPolicy?: unknown }>(`/api/chat/threads/${encodeURIComponent(threadId)}/execution`, { signal: controller.signal }).then(({ environment, executionPolicy }) => {
      const policy = executionPolicy === undefined ? undefined : executionPolicySchema.parse(executionPolicy);
      if (!controller.signal.aborted) setResult({ key, environment, executionPolicy: policy, loading: false });
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setResult({ key, loading: false, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => controller.abort();
  }, [key, reload]);
  return { environment: result.key === key ? result.environment : undefined, executionPolicy: result.key === key ? result.executionPolicy : undefined, error: result.key === key ? result.error : undefined, loading: result.key === key ? result.loading : !!threadId, refresh: () => setReload(value => value + 1) };
}

export function ExecutionSelectionDialog({ workspaces, initial = CHAT_ONLY_SELECTION, busy, error, allowChatOnly = true, onSave, onClose }: {
  workspaces: AgentWorkspace[]; initial?: ExecutionSelection; busy: boolean; error?: string; allowChatOnly?: boolean;
  onSave: (selection: ExecutionSelection) => void; onClose: () => void;
}) {
  const t = useAgentText();
  const [workspaceId, setWorkspaceId] = useState(initial.agentWorkspaceId ?? "");
  const [opening, setOpening] = useState(false);
  const selected = workspaces.find(item => item.id === workspaceId);
  const valid = selected ? (!selected.archivedAt || selected.id === initial.agentWorkspaceId) && selected.status === "available" : allowChatOnly && !workspaceId;
  return <><Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="pm-agent-chat-dialog"><DialogHeader><DialogTitle>{t("会话文件夹", "Session folder")}</DialogTitle><DialogDescription>{t("目录绑定属于会话。切换侧栏不会更改正在运行的会话目录。", "The folder belongs to the session. Sidebar navigation never rebinds a running session.")}</DialogDescription></DialogHeader>
    <RadixSelect aria-label={t("Agent Workspace 文件夹", "Agent Workspace folder")} value={workspaceId} disabled={busy} onChange={event => setWorkspaceId(event.target.value)}><option value="">{allowChatOnly ? t("仅对话", "Chat only") : t("请选择文件夹", "Choose folder")}</option>{workspaces.filter(item => !item.archivedAt || item.id === initial.agentWorkspaceId).map(item => <option key={item.id} value={item.id} disabled={item.status !== "available"}>{item.name} · {item.path}{item.archivedAt ? ` · ${t("已关闭", "Closed")}` : ""}{item.status !== "available" ? ` · ${item.reason ?? "Unavailable"}` : ""}</option>)}</RadixSelect>
    {selected && <code>{selected.path}</code>}<Button variant="outline" disabled={busy} onClick={() => setOpening(true)}><FolderIcon />{t("打开其他文件夹", "Open another folder")}</Button>
    {error && <p role="alert" className="text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>{t("取消", "Cancel")}</Button><Button disabled={busy || !valid} onClick={() => onSave(selected ? selected.id === initial.agentWorkspaceId && initial.agentWorkspaceRevision !== null && initial.agentWorkspaceRevision <= selected.revision ? initial : workspaceExecutionSelection(selected) : CHAT_ONLY_SELECTION)}>{t("确认文件夹", "Confirm folder")}</Button></DialogFooter>
  </DialogContent></Dialog>{opening && <OpenFolderDialog onClose={() => setOpening(false)} onOpened={workspace => { setWorkspaceId(workspace.id); setOpening(false); }} />}</>;
}

export function ExecutionSelectionField({ value = CHAT_ONLY_SELECTION, disabled = false, allowChatOnly = true, onChange, onAvailabilityChange }: {
  value?: ExecutionSelection; disabled?: boolean; allowChatOnly?: boolean; onChange: (selection: ExecutionSelection) => void; onAvailabilityChange?: (available: boolean) => void;
}) {
  const t = useAgentText();
  const state = usePmChatState();
  const [open, setOpen] = useState(false);
  useEffect(() => { void refreshAgentWorkspaces(); }, []);
  const workspace = state.workspaces.find(item => item.id === value.agentWorkspaceId);
  const issue = agentWorkspaceSelectionIssue(value, workspace, allowChatOnly);
  const unavailable = value.agentWorkspaceId && state.loading ? t("正在核验文件夹…", "Validating folder…") : value.agentWorkspaceId && state.error ? state.error
    : issue === "folder-required" ? t("请选择执行文件夹。", "Choose an execution folder.")
    : issue === "unavailable" ? workspace?.reason ?? t("所选文件夹不可用，请重新打开。", "The selected folder is unavailable. Open it again.")
    : issue === "revision-unavailable" ? t("文件夹版本不可用，请核对后重新确认。", "The folder revision is unavailable. Review and confirm it again.") : undefined;
  useEffect(() => { onAvailabilityChange?.(!unavailable); }, [unavailable, onAvailabilityChange]);
  return <div className="pm-execution-field"><p>{value.agentWorkspaceId ? `${workspace?.name ?? value.agentWorkspaceId} · ${workspace?.path ?? ""}` : t("仅对话 · 未选择代码目录", "Chat only · no code folder selected")}</p><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { void refreshAgentWorkspaces(); setOpen(true); }}>{t("选择执行文件夹", "Choose execution folder")}</Button>{unavailable && <p role="status" className="text-destructive">{unavailable}</p>}{open && <ExecutionSelectionDialog workspaces={state.workspaces} initial={value} busy={state.loading} error={state.error} allowChatOnly={allowChatOnly} onSave={selection => { onChange(selection); setOpen(false); }} onClose={() => setOpen(false)} />}</div>;
}
