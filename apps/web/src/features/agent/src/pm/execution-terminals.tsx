import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentWorkspace, ExecutionEnvironment } from "@agent-workspace/contracts/chat";
import type { TerminalDescriptor } from "@agent-workspace/contracts/inspector";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import { Button } from "@agent/components/ui/button";
import { RadixSelect } from "@/components/ui/radix-select";
import { TerminalPanel } from "../workspace/inspector/terminal-panel";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import { terminalBelongsToSessionView } from "./execution-terminal-selection";
import { acceptTerminalDescriptor, terminalCreationReadback, type PendingTerminalCreation } from "./terminal-creation-state";

export type TerminalDock = "bottom" | "right";
export type FolderTerminalRequest = { relativePath: string; scope: "workspace" | "session" };
type TerminalCatalog = { serviceId: string; terminals: TerminalDescriptor[] };
const PENDING_CREATION_KEY = "pm-v4:terminal-creation:pending";
export type ExecutionTerminalController = {
  terminals: TerminalDescriptor[]; selectedId: string | null; selected: TerminalDescriptor | undefined;
  setSelectedId: (id: string | null) => void; error: string | undefined; busy: boolean;
  mode: "workspace" | "session"; setMode: (mode: "workspace" | "session") => void;
  startingPath: string | null; enabled: boolean; canCreate: boolean;
  pendingCreation: PendingTerminalCreation | undefined; creationOutcome: "unknown" | "not-found" | "service-changed";
  terminatingId: string | undefined;
  refresh: () => Promise<void>; create: (request?: FolderTerminalRequest) => Promise<void>; terminate: () => Promise<void>;
  reconcileCreation: () => Promise<void>; retryCreation: () => Promise<void>; acknowledgeExpiredCreation: () => void;
  acceptExit: (id: string, exitCode: number, signal?: number) => void;
};

export function useExecutionTerminals({ workspace, threadId, environment, onShow }: {
  workspace?: AgentWorkspace; threadId?: string; environment?: ExecutionEnvironment; onShow: () => void;
}): ExecutionTerminalController {
  const [terminals, setTerminals] = useState<TerminalDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => { try { return sessionStorage.getItem("pm-v4:terminal-selected"); } catch { return null; } });
  const [pendingCreation, setPendingCreation] = useState<PendingTerminalCreation | undefined>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(PENDING_CREATION_KEY) ?? "null") as PendingTerminalCreation | null;
      if (saved && typeof saved.requestId === "string" && typeof saved.expectedServiceId === "string" && typeof saved.agentWorkspaceId === "string" && Number.isInteger(saved.agentWorkspaceRevision) && ["session", "workspace"].includes(saved.scope)) return saved;
    } catch { /* No request is dispatched from invalid browser recovery data. */ }
    return undefined;
  });
  const [creationOutcome, setCreationOutcome] = useState<"unknown" | "not-found" | "service-changed">("unknown");
  const [serviceId, setServiceId] = useState<string>();
  const [terminatingId, setTerminatingId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"workspace" | "session">("session");
  const creating = useRef(false);
  const pendingRef = useRef(pendingCreation);
  const activeThread = useRef(threadId);
  activeThread.current = threadId;
  const readSequence = useRef(0);
  const visibleTerminals = terminals.filter(terminal => terminalBelongsToSessionView(terminal, threadId));
  // Filter during render: an old Session PTY detaches before switch effects run.
  const selected = visibleTerminals.find(terminal => terminal.id === selectedId);
  const previousThread = useRef(threadId);
  useEffect(() => {
    const changed = previousThread.current !== threadId;
    previousThread.current = threadId;
    const current = terminals.find(terminal => terminal.id === selectedId);
    if (current?.scope === "workspace") return;
    if (current?.scope === "session" && current.threadId === threadId) {
      try { sessionStorage.setItem(`pm-v4:terminal-session:${threadId}`, current.id); } catch { /* The process remains service-owned. */ }
      return;
    }
    if ((current?.scope === "session" && current.threadId !== threadId) || (changed && selectedId === null)) {
      let remembered: string | null = null;
      try { remembered = threadId ? sessionStorage.getItem(`pm-v4:terminal-session:${threadId}`) : null; } catch { /* Leave this Session detached. */ }
      const known = terminals.find(terminal => terminal.id === remembered);
      setSelectedId(known && !terminalBelongsToSessionView(known, threadId) ? null : remembered);
    }
  }, [threadId, selectedId, terminals]);

  const refresh = useCallback(async () => {
    const request = ++readSequence.current;
    const bindings = [
      workspace ? { agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision } : undefined,
      environment?.agentWorkspaceId && environment.agentWorkspaceRevision !== null ? { agentWorkspaceId: environment.agentWorkspaceId, agentWorkspaceRevision: environment.agentWorkspaceRevision } : undefined,
      pendingCreation ? { agentWorkspaceId: pendingCreation.agentWorkspaceId, agentWorkspaceRevision: pendingCreation.agentWorkspaceRevision } : undefined,
    ].filter((item): item is { agentWorkspaceId: string; agentWorkspaceRevision: number } => !!item);
    const unique = [...new Map(bindings.map(item => [item.agentWorkspaceId, item])).values()];
    const reads: Promise<TerminalCatalog>[] = unique.map(item => workspaceClient.json<TerminalCatalog>(`/api/inspector/terminals?${new URLSearchParams({ agentWorkspaceId: item.agentWorkspaceId, agentWorkspaceRevision: String(item.agentWorkspaceRevision) })}`));
    if (terminatingId && terminatingId !== selectedId) reads.push(workspaceClient.json<{ terminal: TerminalDescriptor }>(`/api/inspector/terminals/${encodeURIComponent(terminatingId)}`).then(result => ({ serviceId: result.terminal.serviceId, terminals: [result.terminal] })));
    // A selected Workspace PTY can outlive the selected Session and its filter.
    if (selectedId) reads.push(workspaceClient.json<{ terminal: TerminalDescriptor }>(`/api/inspector/terminals/${encodeURIComponent(selectedId)}`).then(result => ({ serviceId: result.terminal.serviceId, terminals: [result.terminal] })));
    const results = await Promise.allSettled(reads);
    if (readSequence.current !== request) return;
    const actual = results.flatMap(result => result.status === "fulfilled" ? result.value.terminals : []);
    const services = new Set(results.flatMap(result => result.status === "fulfilled" ? [result.value.serviceId] : []));
    setServiceId(services.size === 1 ? [...services][0] : undefined);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    const selectedRead = selectedId ? results.at(-1) : undefined;
    const selectedFailure = selectedRead?.status === "rejected" ? selectedRead.reason : undefined;
    const selectedDenied = selectedFailure instanceof WorkspaceClientError && selectedFailure.kind === "http" && [400, 401, 403, 404, 409, 410, 412].includes(selectedFailure.status);
    setTerminals(current => {
      const visible = selectedDenied ? actual.filter(terminal => terminal.id !== selectedId) : actual;
      const previous = selectedRead?.status === "rejected" && !selectedDenied ? current.find(terminal => terminal.id === selectedId) : undefined;
      return [...new Map([...visible, ...(previous && !visible.some(terminal => terminal.id === previous.id) ? [previous] : [])].map(terminal => [terminal.id, terminal])).values()].map(terminal => acceptTerminalDescriptor(current.find(item => item.id === terminal.id), terminal));
    });
    setError(errors.length ? errors.join(" · ") : services.size > 1 ? "Terminal service changed during read; reload before creating." : undefined);
  }, [workspace?.id, workspace?.revision, environment?.agentWorkspaceId, environment?.agentWorkspaceRevision, selectedId, threadId, pendingCreation, terminatingId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const online = () => void refresh(); window.addEventListener("online", online); return () => window.removeEventListener("online", online); }, [refresh]);
  useEffect(() => { try { if (selectedId) sessionStorage.setItem("pm-v4:terminal-selected", selectedId); else sessionStorage.removeItem("pm-v4:terminal-selected"); } catch { /* Service terminal identity remains authoritative. */ } }, [selectedId]);
  useEffect(() => {
    if (!terminatingId) return;
    if (terminals.find(terminal => terminal.id === terminatingId)?.status === "exited") { setTerminatingId(undefined); return; }
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [terminatingId, terminals, refresh]);

  const startingPath = mode === "workspace" ? workspace && !workspace.archivedAt && workspace.status === "available" ? workspace.path : null : environment?.executionPath ?? null;
  const clearPendingCreation = () => {
    pendingRef.current = undefined; setPendingCreation(undefined); setCreationOutcome("unknown");
    try { sessionStorage.removeItem(PENDING_CREATION_KEY); } catch { /* A retained original ID can only reconcile to the same process. */ }
  };
  const acceptCreation = (terminal: TerminalDescriptor) => {
    setTerminals(current => [...current.filter(item => item.id !== terminal.id), acceptTerminalDescriptor(current.find(item => item.id === terminal.id), terminal)]);
    if (terminal.scope === "workspace" || terminal.threadId === activeThread.current) setSelectedId(terminal.id);
    clearPendingCreation(); onShow();
  };
  const sendCreation = async (request: PendingTerminalCreation) => {
    if (creating.current) return;
    creating.current = true; setBusy(true); setError(undefined);
    try {
      // Save the exact request before any PTY side effect; never mint a retry ID.
      sessionStorage.setItem(PENDING_CREATION_KEY, JSON.stringify(request));
    } catch {
      setError("Cannot persist the original terminal request; nothing was sent.");
      creating.current = false; setBusy(false); onShow(); return;
    }
    pendingRef.current = request; setPendingCreation(request); setCreationOutcome("unknown");
    try {
      const { terminal } = await workspaceClient.json<{ terminal: TerminalDescriptor }>("/api/inspector/terminals", { method: "POST", body: JSON.stringify(request) });
      acceptCreation(terminal);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof WorkspaceClientError && cause.kind === "http") {
        if (cause.code === "terminal_service_changed") setCreationOutcome("service-changed");
        else if (cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status)) clearPendingCreation();
      }
      onShow();
    } finally { creating.current = false; setBusy(false); }
  };
  const create = async (folder?: FolderTerminalRequest) => {
    if (creating.current || pendingRef.current) { onShow(); return; }
    if (!serviceId) { setError("Read the actual terminal service before creating a terminal."); onShow(); return; }
    const terminalScope = folder?.scope ?? mode;
    const agentWorkspaceId = folder || terminalScope === "session" ? environment?.agentWorkspaceId : workspace?.id;
    const agentWorkspaceRevision = folder || terminalScope === "session" ? environment?.agentWorkspaceRevision : workspace?.revision;
    if (!agentWorkspaceId || agentWorkspaceRevision == null || terminalScope === "session" && !threadId) return;
    await sendCreation({ requestId: crypto.randomUUID(), expectedServiceId: serviceId, scope: terminalScope, agentWorkspaceId, agentWorkspaceRevision, relativePath: folder?.relativePath ?? "", ...(terminalScope === "session" ? { threadId: threadId! } : {}) });
  };
  const reconcileCreation = async () => {
    const request = pendingRef.current;
    if (!request || busy) return;
    setBusy(true); setError(undefined);
    try {
      const query = new URLSearchParams({ agentWorkspaceId: request.agentWorkspaceId, agentWorkspaceRevision: String(request.agentWorkspaceRevision), requestId: request.requestId, ...(request.threadId ? { threadId: request.threadId } : {}) });
      const result = await workspaceClient.json<TerminalCatalog>(`/api/inspector/terminals?${query}`);
      setServiceId(result.serviceId);
      const outcome = terminalCreationReadback(request, result);
      if (outcome.status === "found") acceptCreation(outcome.terminal);
      else setCreationOutcome(outcome.status);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const retryCreation = async () => {
    if (pendingRef.current && creationOutcome === "not-found" && !busy) await sendCreation(pendingRef.current);
  };
  const acknowledgeExpiredCreation = () => {
    if (creationOutcome === "service-changed" && !busy) clearPendingCreation();
  };
  const terminate = async () => {
    if (!selected || busy || terminatingId === selected.id) return;
    setBusy(true); setError(undefined); setTerminatingId(selected.id);
    try {
      const { terminal } = await workspaceClient.json<{ terminal: TerminalDescriptor }>(`/api/inspector/terminals/${encodeURIComponent(selected.id)}`, { method: "DELETE" });
      setTerminals(current => current.map(item => item.id === terminal.id ? acceptTerminalDescriptor(item, terminal) : item));
      if (terminal.status === "exited") setTerminatingId(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof WorkspaceClientError && cause.kind === "http" && cause.status >= 400 && cause.status < 500) setTerminatingId(undefined);
    } finally { setBusy(false); }
  };
  const acceptExit = (id: string, exitCode: number, signal?: number) => {
    setTerminals(current => current.map(terminal => terminal.id === id ? { ...terminal, status: "exited", exitCode, signal: signal ?? null } : terminal));
    setTerminatingId(current => current === id ? undefined : current);
  };
  const oldSessionSelected = terminals.some(terminal => terminal.id === selectedId && terminal.scope === "session" && terminal.threadId !== threadId);
  return { terminals: visibleTerminals, selectedId: oldSessionSelected ? null : selectedId, selected, setSelectedId, error, busy, mode, setMode, startingPath, enabled: !!workspace || !!environment?.agentWorkspaceId || !!pendingCreation, canCreate: !!serviceId && !pendingCreation && !!startingPath, pendingCreation, creationOutcome, terminatingId, refresh, create, terminate, reconcileCreation, retryCreation, acknowledgeExpiredCreation, acceptExit };
}

export function ExecutionTerminals({ controller: c, dock, onDock, onHide }: { controller: ExecutionTerminalController; dock: TerminalDock; onDock: (dock: TerminalDock) => void; onHide: () => void }) {
  const t = useAgentText();
  return <div className="pm-execution-terminals">
    <div className="inspector-toolbar">
      <RadixSelect aria-label={t("终端范围", "Terminal scope")} value={c.mode} onChange={event => c.setMode(event.target.value as "workspace" | "session")}><option value="workspace">Workspace</option><option value="session">Session</option></RadixSelect>
      <code className="truncate text-xs" title={c.startingPath ?? undefined}>{c.startingPath ?? t("未选择代码文件夹", "No code folder selected")}</code>
      <Button variant="ghost" size="sm" disabled={c.busy || !c.canCreate} onClick={() => void c.create()}>{t("新建", "New")}</Button>
      <Button variant="ghost" size="sm" onClick={() => void c.refresh()}>{t("重读", "Reload")}</Button>
      <span className="inspector-toolbar-spacer" />
      <Button variant="ghost" size="sm" onClick={() => onDock(dock === "bottom" ? "right" : "bottom")}>{dock === "bottom" ? t("停靠右侧", "Dock right") : t("停靠底部", "Dock bottom")}</Button>
      <Button variant="ghost" size="sm" onClick={onHide}>{t("隐藏（仅分离）", "Hide (detach)")}</Button>
    </div>
    {c.pendingCreation && <section role="status" className="p-2 text-xs">
      <p>{t("终端创建结果待核对；新建已锁定，不自动重发。原请求：", "Terminal creation needs reconciliation. New creation is locked and nothing is automatically resent. Original request: ")}<code>{c.pendingCreation.requestId}</code></p>
      <Button size="sm" variant="outline" disabled={c.busy} onClick={() => void c.reconcileCreation()}>{t("核对原请求", "Reconcile original request")}</Button>
      {c.creationOutcome === "not-found" && <><p>{t("原服务未找到此请求的终端。只允许明确重发完全相同的原请求；不会生成新 ID。", "The original service lists no terminal for this request. Only an explicit resend of the identical original request is allowed; no new ID is generated.")}</p><Button size="sm" variant="outline" disabled={c.busy} onClick={() => void c.retryCreation()}>{t("重发同一原请求", "Resend identical original request")}</Button></>}
      {c.creationOutcome === "service-changed" && <><p>{t("原终端服务已结束；不会恢复进程，也不会向新服务重放原创建请求。", "The original terminal service ended. No process is restored and the original creation request is never replayed to the new service.")}</p><Button size="sm" variant="outline" disabled={c.busy} onClick={() => { if (window.confirm(t("确认结束原请求的核对？之后可另行明确新建终端。", "Acknowledge the old request has ended? You may explicitly create a separate new terminal afterward."))) c.acknowledgeExpiredCreation(); }}>{t("确认原服务已结束", "Acknowledge original service ended")}</Button></>}
    </section>}
    <div className="pm-terminal-tabs" role="tablist" aria-label={t("终端实例", "Terminal instances")}>{c.terminals.map(terminal => <button type="button" role="tab" aria-selected={terminal.id === c.selectedId} key={terminal.id} title={`${terminal.scope} · ${terminal.threadId ?? terminal.agentWorkspaceId}\n${terminal.startCwd}\n${terminal.id}`} onClick={() => c.setSelectedId(terminal.id)}>{terminal.scope === "workspace" ? "Workspace" : "Session"} · {terminal.startCwd} · {c.terminatingId === terminal.id ? t("正在终止（待确认）", "Terminating (unconfirmed)") : terminal.status === "running" ? t("运行中", "Running") : t("已结束", "Exited")}</button>)}</div>
    {c.error && <p role="alert" className="text-destructive">{c.error}</p>}
    {c.selected ? <>
      <div className="inspector-toolbar"><code className="inspector-muted" title={c.selected.startCwd}>{c.selected.startCwd} · {c.selected.scope === "workspace" ? "Workspace" : "Session"}</code><span className="inspector-toolbar-spacer" />
        <Button variant="ghost" size="sm" disabled={c.busy || c.selected.status !== "running" || c.terminatingId === c.selected.id} onClick={() => { if (window.confirm(t("明确终止此终端及其正在运行的进程？", "Terminate this terminal and its running process?"))) void c.terminate(); }}>{c.terminatingId === c.selected.id ? t("终止请求待确认", "Termination unconfirmed") : t("终止进程", "Terminate process")}</Button>
        <Button variant="ghost" size="sm" onClick={() => c.setSelectedId(null)}>{t("关闭视图（仅分离）", "Close view (detach)")}</Button>
      </div>
      <TerminalPanel key={c.selected.id} terminal={c.selected} onExit={(exitCode, signal) => c.acceptExit(c.selected!.id, exitCode, signal)} />
    </> : <div className="inspector-empty">{c.selectedId ? t("原终端不可用：可能已终止、权限失效或服务已重启。不会恢复进程或重放命令；可明确新建终端。", "The original terminal is unavailable: it may have ended, lost authorization, or the service restarted. No process is restored and no command is rerun. Create a new terminal explicitly.") : t("选择当前 Session 的终端，或保留独立 Workspace 终端。Shell 中 cd 不会更改 Agent 主目录。", "Select a terminal belonging to the current Session, or retain an independent Workspace terminal. Shell cd never changes the Agent primary cwd.")}</div>}
  </div>;
}
