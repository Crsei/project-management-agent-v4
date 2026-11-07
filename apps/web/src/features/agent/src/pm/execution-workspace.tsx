import { useEffect, useRef, useState } from "react";
import type { AgentWorkspace, ExecutionEnvironment, ExecutionSelection } from "@agent-workspace/contracts/chat";
import type { GitStatusResponse } from "@agent-workspace/contracts/inspector";
import { FolderIcon, ArrowUpIcon } from "lucide-react";
import { RadixSelect } from "@/components/ui/radix-select";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import { acceptAgentWorkspace, CHAT_ONLY_SELECTION, refreshAgentWorkspaces, usePmChatState, workspaceExecutionSelection } from "./state";
import { agentWorkspaceSelectionIssue } from "./execution-selection-state";

type DirectoryListing = { path: string | null; parentPath: string | null; roots: string[]; directories: { name: string; path: string }[] };

export function OpenFolderDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (workspace: AgentWorkspace) => void }) {
  const t = useAgentText();
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const browseRequest = useRef(0);
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
  const open = async () => {
    setBusy(true); setError(undefined);
    try {
      const { workspace } = await workspaceClient.json<{ workspace: AgentWorkspace }>("/api/agent-workspaces/open", { method: "POST", body: JSON.stringify({ path: path.trim() }) });
      acceptAgentWorkspace(workspace);
      onOpened(workspace);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="pm-agent-directory-dialog max-h-[90dvh] overflow-y-auto sm:max-w-xl">
    <DialogHeader><DialogTitle>{t("打开文件夹", "Open folder")}</DialogTitle><DialogDescription>{t("选择 Agent 服务器上的已有目录。不会上传浏览器文件、创建目录或移动代码。", "Choose an existing directory on the Agent server. This does not upload browser files, create folders, or move code.")}</DialogDescription></DialogHeader>
    <label>{t("服务器绝对路径", "Server absolute path")}<Input autoFocus value={path} disabled={busy} onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && path.trim() && !loading && !busy) void open(); }} /></label>
    <div className="inspector-toolbar"><Button variant="outline" size="sm" disabled={busy || loading || !path.trim()} onClick={() => void browse(path.trim())}>{t("浏览此目录", "Browse directory")}</Button><Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => void browse()}>{t("允许的目录", "Allowed roots")}</Button>{listing?.parentPath && <Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => void browse(listing.parentPath!)}><ArrowUpIcon />{t("上一级", "Parent")}</Button>}</div>
    {loading && <p role="status">{t("正在浏览服务器目录…", "Browsing server directories…")}</p>}
    <div className="pm-agent-folder-browser" aria-label={t("服务器目录", "Server directories")} aria-busy={loading}>
      {listing?.path && <code>{listing.path}</code>}
      {(listing?.path ? listing.directories : listing?.roots.map(root => ({ name: root, path: root })) ?? []).map(directory => <Button key={directory.path} className="w-full justify-start" variant="ghost" disabled={busy || loading} title={directory.path} onClick={() => void browse(directory.path)}><FolderIcon /><span className="truncate">{directory.name}</span></Button>)}
      {listing?.path && !listing.directories.length && !loading && <p>{t("没有可浏览的子目录；仍可打开当前目录。", "No browsable subdirectories. You can still open this folder.")}</p>}
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>{t("取消", "Cancel")}</Button><Button disabled={busy || !path.trim()} onClick={() => void open()}>{busy ? t("正在打开…", "Opening…") : t("打开文件夹", "Open folder")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export async function updateAgentWorkspace(workspace: AgentWorkspace, patch: { name?: string; archived?: boolean }): Promise<AgentWorkspace> {
  const result = await workspaceClient.json<{ workspace: AgentWorkspace }>(`/api/agent-workspaces/${encodeURIComponent(workspace.id)}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: workspace.revision, ...patch }) });
  acceptAgentWorkspace(result.workspace);
  return result.workspace;
}

export function useExecutionEnvironment(threadId?: string, revision?: number) {
  const key = JSON.stringify([threadId, revision]);
  const [result, setResult] = useState<{ key: string; environment?: ExecutionEnvironment; error?: string; loading: boolean }>({ key: "", loading: false });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!threadId) { setResult({ key, loading: false }); return; }
    const controller = new AbortController();
    setResult({ key, loading: true });
    void workspaceClient.json<{ environment: ExecutionEnvironment }>(`/api/chat/threads/${encodeURIComponent(threadId)}/execution`, { signal: controller.signal }).then(({ environment }) => {
      if (!controller.signal.aborted) setResult({ key, environment, loading: false });
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setResult({ key, loading: false, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => controller.abort();
  }, [key, reload]);
  return { environment: result.key === key ? result.environment : undefined, error: result.key === key ? result.error : undefined, loading: result.key === key ? result.loading : !!threadId, refresh: () => setReload(value => value + 1) };
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

export function ExecutionContextBar({ environment, workspace, threadId, error, loading, onConfigure, frozen }: { environment?: ExecutionEnvironment; workspace?: AgentWorkspace; threadId?: string; error?: string; loading: boolean; onConfigure: () => void; frozen: boolean }) {
  const t = useAgentText();
  const name = workspace?.name ?? environment?.agentWorkspaceName;
  const sourcePath = environment?.sourcePath ?? workspace?.path;
  const executionPath = environment?.executionPath ?? workspace?.path;
  const branchKey = JSON.stringify([threadId, environment?.agentWorkspaceId, environment?.executionPath]);
  const [branch, setBranch] = useState<{ key: string; name: string }>();
  useEffect(() => {
    if (!threadId || !environment?.agentWorkspaceId || !environment.executionPath) return;
    const controller = new AbortController();
    void workspaceClient.json<GitStatusResponse>(`/api/inspector/git?${new URLSearchParams({ threadId })}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setBranch(result.repo && result.branch ? { key: branchKey, name: result.branch } : undefined);
    }).catch(() => { if (!controller.signal.aborted) setBranch(undefined); });
    return () => controller.abort();
  }, [threadId, environment]);
  return <div className="pm-execution-context" aria-label={t("会话执行上下文", "Session execution context")}><span>Local</span>
    {loading ? <span role="status">{t("正在核验环境…", "Validating environment…")}</span> : error ? <span role="alert" className="text-destructive">{error}</span> : name ? <><strong>{name}</strong><details className="pm-execution-path"><summary>{environment?.worktree ? t("隔离 Worktree", "Isolated worktree") : t("执行目录", "Execution folder")}</summary><dl><dt>{t("来源目录", "Source folder")}</dt><dd><code>{sourcePath}</code></dd><dt>{t("实际执行目录", "Actual execution folder")}</dt><dd><code>{executionPath}</code></dd>{environment?.worktree && <><dt>Branch</dt><dd>{environment.worktree.branch}</dd></>}</dl></details><code className="truncate" title={executionPath ?? undefined}>{executionPath}</code></> : <span>{t("仅对话 · 无代码环境", "Chat only · no code environment")}</span>}
    {branch?.key === branchKey && <span title={t("当前会话目录分支", "Branch in the current session folder")}>{branch.name}</span>}
    <Button size="sm" variant="ghost" onClick={onConfigure}>{frozen ? t("新会话更换文件夹", "New session in another folder") : t("选择文件夹", "Choose folder")}</Button>
  </div>;
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
