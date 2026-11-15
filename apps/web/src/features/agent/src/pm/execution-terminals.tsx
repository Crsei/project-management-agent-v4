import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentWorkspace, ExecutionEnvironment } from "@agent-workspace/contracts/chat";
import type { TerminalDescriptor } from "@agent-workspace/contracts/inspector";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import { TerminalPanel } from "../workspace/inspector/terminal-panel";
import { workspaceClient } from "../network";
import { sessionTerminalMatches, sessionTerminalTarget, terminalBelongsToSessionView, type SessionTerminalTarget } from "./execution-terminal-selection";
import { acceptTerminalDescriptor, terminalCreationReadback, type PendingTerminalCreation } from "./terminal-creation-state";
import { agentText } from "../i18n-text";

export type TerminalDock = "bottom" | "right";
export type FolderTerminalRequest = { relativePath: string; scope: "workspace" | "session" };
type TerminalCatalog = { serviceId: string; terminals: TerminalDescriptor[] };
const PENDING_CREATION_KEY = "pm-v4:terminal-creation:pending";
export type ExecutionTerminalController = {
  selectedId: string | null; selected: TerminalDescriptor | undefined;
  enabled: boolean; create: (request: FolderTerminalRequest) => Promise<void>;
  openSession: (target: SessionTerminalTarget) => Promise<void>;
  busy: boolean; error?: string; retry: () => void;
  acceptExit: (id: string, exitCode: number, signal?: number) => void;
};

export function useExecutionTerminals({ workspace, threadId, environment, onShow, enabled = true }: {
  workspace?: AgentWorkspace; threadId?: string; environment?: ExecutionEnvironment; onShow: () => void; enabled?: boolean;
}): ExecutionTerminalController {
  const [terminals, setTerminals] = useState<TerminalDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => { if (!enabled) return null; try { return sessionStorage.getItem("pm-v4:terminal-selected"); } catch { return null; } });
  const [pendingCreation, setPendingCreation] = useState<PendingTerminalCreation | undefined>(() => {
    if (!enabled) return undefined;
    try {
      const saved = JSON.parse(sessionStorage.getItem(PENDING_CREATION_KEY) ?? "null") as PendingTerminalCreation | null;
      if (saved && typeof saved.requestId === "string" && typeof saved.expectedServiceId === "string" && typeof saved.agentWorkspaceId === "string" && Number.isInteger(saved.agentWorkspaceRevision) && ["session", "workspace"].includes(saved.scope)) return saved;
    } catch { /* No request is dispatched from invalid browser recovery data. */ }
    return undefined;
  });
  const [serviceId, setServiceId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [readCompleted, setReadCompleted] = useState(false);
  const creating = useRef(false);
  const openingSession = useRef(false);
  const [error, setError] = useState<string>();
  const [sessionTarget, setSessionTarget] = useState<SessionTerminalTarget>();
  const pendingRef = useRef(pendingCreation);
  const activeThread = useRef(threadId);
  activeThread.current = threadId;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const assertEnabled = () => {
    if (!enabledRef.current) throw new Error(agentText("此视图未启用终端。请明确打开会话终端。", "Terminals are not enabled in this view. Explicitly open the Session terminal."));
  };
  const activeEnvironment = useRef<SessionTerminalTarget | null>(null);
  activeEnvironment.current = environment && threadId ? sessionTerminalTarget(threadId, environment) : null;
  const readSequence = useRef(0);
  const belongsToView = (terminal: TerminalDescriptor) => terminalBelongsToSessionView(terminal, activeEnvironment.current, sessionTarget);
  useEffect(() => {
    const actual = activeEnvironment.current;
    if (sessionTarget && (!actual || actual.threadId !== sessionTarget.threadId || actual.agentWorkspaceId !== sessionTarget.agentWorkspaceId || actual.agentWorkspaceRevision !== sessionTarget.agentWorkspaceRevision))
      setSessionTarget(undefined);
  }, [threadId, environment?.agentWorkspaceId, environment?.agentWorkspaceRevision, environment?.executionPath, sessionTarget]);
  const visibleTerminals = enabled ? terminals.filter(belongsToView) : [];
  // Filter during render: an old Session PTY detaches before switch effects run.
  const selected = visibleTerminals.find(terminal => terminal.id === selectedId);
  // Without a terminal toolbar, always resolve to a visible PTY once the service read completes.
  useEffect(() => {
    if (!enabled) return;
    const current = visibleTerminals.find(terminal => terminal.id === selectedId);
    if (current?.scope === "workspace") return;
    if (current?.scope === "session" && current.threadId === threadId) {
      try { sessionStorage.setItem(`pm-v4:terminal-session:${threadId}`, current.id); } catch { /* The process remains service-owned. */ }
      return;
    }
    if (!readCompleted && !current) return;
    const visible = visibleTerminals;
    let remembered: string | null = null;
    try { remembered = threadId ? sessionStorage.getItem(`pm-v4:terminal-session:${threadId}`) : null; } catch { /* Leave this Session detached. */ }
    const known = terminals.find(terminal => terminal.id === remembered);
    const rememberedVisible = known && belongsToView(known) ? known.id : null;
    const preferred = visible.find(terminal => terminal.scope === "session") ?? visible[0];
    setSelectedId(rememberedVisible ?? preferred?.id ?? null);
  }, [enabled, threadId, selectedId, terminals, readCompleted, sessionTarget, environment?.agentWorkspaceId, environment?.agentWorkspaceRevision, environment?.executionPath]);

  const refresh = useCallback(async () => {
    if (!enabledRef.current) return;
    const request = ++readSequence.current;
    const bindings = [
      workspace ? { agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision } : undefined,
      environment?.agentWorkspaceId && environment.agentWorkspaceRevision !== null ? { agentWorkspaceId: environment.agentWorkspaceId, agentWorkspaceRevision: environment.agentWorkspaceRevision } : undefined,
      pendingCreation ? { agentWorkspaceId: pendingCreation.agentWorkspaceId, agentWorkspaceRevision: pendingCreation.agentWorkspaceRevision } : undefined,
    ].filter((item): item is { agentWorkspaceId: string; agentWorkspaceRevision: number } => !!item);
    const unique = [...new Map(bindings.map(item => [item.agentWorkspaceId, item])).values()];
    const reads: Promise<TerminalCatalog>[] = unique.map(item => workspaceClient.json<TerminalCatalog>(`/api/inspector/terminals?${new URLSearchParams({ agentWorkspaceId: item.agentWorkspaceId, agentWorkspaceRevision: String(item.agentWorkspaceRevision) })}`));
    // A selected Workspace PTY can outlive the selected Session and its filter.
    if (selectedId) reads.push(workspaceClient.json<{ terminal: TerminalDescriptor }>(`/api/inspector/terminals/${encodeURIComponent(selectedId)}`).then(result => ({ serviceId: result.terminal.serviceId, terminals: [result.terminal] })));
    const results = await Promise.allSettled(reads);
    if (!enabledRef.current || readSequence.current !== request) return;
    setReadCompleted(true);
    const actual = results.flatMap(result => result.status === "fulfilled" ? result.value.terminals : []);
    // Only authoritative binding reads may decide the current service; a stale selected
    // terminal from an earlier service lifetime must not poison creation.
    const services = new Set(results.slice(0, unique.length).flatMap(result => result.status === "fulfilled" ? [result.value.serviceId] : []));
    setServiceId(services.size === 1 ? [...services][0] : undefined);
    const selectedRead = selectedId ? results.at(-1) : undefined;
    const selectedFailure = selectedRead?.status === "rejected" ? selectedRead.reason : undefined;
    const selectedDenied = selectedFailure instanceof WorkspaceClientError && selectedFailure.kind === "http" && [400, 401, 403, 404, 409, 410, 412].includes(selectedFailure.status);
    setTerminals(current => {
      const visible = selectedDenied ? actual.filter(terminal => terminal.id !== selectedId) : actual;
      const previous = selectedRead?.status === "rejected" && !selectedDenied ? current.find(terminal => terminal.id === selectedId) : undefined;
      return [...new Map([...visible, ...(previous && !visible.some(terminal => terminal.id === previous.id) ? [previous] : [])].map(terminal => [terminal.id, terminal])).values()].map(terminal => acceptTerminalDescriptor(current.find(item => item.id === terminal.id), terminal));
    });
  }, [enabled, workspace?.id, workspace?.revision, environment?.agentWorkspaceId, environment?.agentWorkspaceRevision, selectedId, threadId, pendingCreation]);
  useEffect(() => { if (enabled) void refresh(); return () => { readSequence.current++; }; }, [enabled, refresh]);
  useEffect(() => { if (!enabled) return; const online = () => void refresh(); window.addEventListener("online", online); return () => window.removeEventListener("online", online); }, [enabled, refresh]);
  useEffect(() => { if (!enabled) return; try { if (selectedId) sessionStorage.setItem("pm-v4:terminal-selected", selectedId); else sessionStorage.removeItem("pm-v4:terminal-selected"); } catch { /* Service terminal identity remains authoritative. */ } }, [enabled, selectedId]);

  const clearPendingCreation = () => {
    pendingRef.current = undefined; setPendingCreation(undefined);
    try { sessionStorage.removeItem(PENDING_CREATION_KEY); } catch { /* A retained original ID can only reconcile to the same process. */ }
  };
  const acceptCreation = (terminal: TerminalDescriptor, reveal = true) => {
    assertEnabled();
    setTerminals(current => [...current.filter(item => item.id !== terminal.id), acceptTerminalDescriptor(current.find(item => item.id === terminal.id), terminal)]);
    const actual = activeEnvironment.current;
    const stillCurrent = terminal.scope === "workspace" || !!actual && terminal.threadId === activeThread.current && sessionTerminalMatches(terminal, actual);
    if (stillCurrent) {
      if (terminal.scope === "session" && actual) setSessionTarget(actual);
      setSelectedId(terminal.id);
    }
    clearPendingCreation(); if (reveal && stillCurrent) onShow();
  };
  const sendCreation = async (request: PendingTerminalCreation, reveal = true) => {
    assertEnabled();
    if (creating.current) throw new Error(agentText("终端请求尚未完成，请先核对原请求。", "A terminal request is still pending. Reconcile the original request first."));
    creating.current = true; setBusy(true); setError(undefined);
    try {
      // Save the exact request before any PTY side effect; never mint a retry ID.
      sessionStorage.setItem(PENDING_CREATION_KEY, JSON.stringify(request));
    } catch {
      creating.current = false; setBusy(false);
      throw new Error(agentText("无法保存原终端请求；未创建终端。请允许此标签页存储后重试。", "The original terminal request could not be saved. No terminal was created; enable tab storage and retry."));
    }
    pendingRef.current = request; setPendingCreation(request);
    try {
      const { terminal } = await workspaceClient.json<{ terminal: TerminalDescriptor }>("/api/inspector/terminals", { method: "POST", body: JSON.stringify(request) });
      acceptCreation(terminal, reveal);
      return terminal;
    } catch (cause) {
      console.error("Terminal creation failed:", cause);
      if (cause instanceof WorkspaceClientError && cause.kind === "http") {
        if (cause.code === "terminal_service_changed" || cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status)) clearPendingCreation();
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      if (reveal && (!request.threadId || request.threadId === activeThread.current)) onShow();
      throw cause;
    } finally { creating.current = false; setBusy(false); }
  };
  const create = async (folder: FolderTerminalRequest) => {
    assertEnabled();
    try {
      if (openingSession.current) throw new Error(agentText("正在核对会话终端，请等待原操作结束。", "The Session terminal is being resolved. Wait for the original operation to finish."));
      if (creating.current) { onShow(); return; }
      if (pendingRef.current) { await reconcileCreation(true); onShow(); return; }
      if (!serviceId) throw new Error(agentText("终端服务尚未就绪，请重新读取后重试。", "The terminal service is not ready. Reload and retry."));
      const target = folder.scope === "session" ? activeEnvironment.current : null;
      const agentWorkspaceId = folder.scope === "session" ? target?.agentWorkspaceId : workspace?.id;
      const agentWorkspaceRevision = folder.scope === "session" ? target?.agentWorkspaceRevision : workspace?.revision;
      if (!agentWorkspaceId || agentWorkspaceRevision == null || folder.scope === "session" && !target) throw new Error(agentText("会话执行目录未核验，未创建终端。", "The Session execution folder has not been verified. No terminal was created."));
      setSessionTarget(target ?? undefined);
      await sendCreation({ requestId: crypto.randomUUID(), expectedServiceId: serviceId, scope: folder.scope, agentWorkspaceId, agentWorkspaceRevision, relativePath: folder.relativePath, ...(target ? { threadId: target.threadId } : {}) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); onShow(); }
  };
  const reconcileCreation = async (reveal = false) => {
    assertEnabled();
    const request = pendingRef.current;
    if (!request) return;
    if (creating.current) throw new Error(agentText("终端请求尚未完成，请稍后核对。", "A terminal request is still pending. Reconcile it when it finishes."));
    setBusy(true);
    try {
      const query = new URLSearchParams({ agentWorkspaceId: request.agentWorkspaceId, agentWorkspaceRevision: String(request.agentWorkspaceRevision), requestId: request.requestId, ...(request.threadId ? { threadId: request.threadId } : {}) });
      const result = await workspaceClient.json<TerminalCatalog>(`/api/inspector/terminals?${query}`);
      assertEnabled();
      setServiceId(result.serviceId);
      const outcome = terminalCreationReadback(request, result);
      if (outcome.status === "found") { acceptCreation(outcome.terminal, reveal); return outcome.terminal; }
      if (outcome.status === "service-changed") {
        clearPendingCreation();
        throw new Error(agentText("终端服务已重启；原请求不会重放。请明确重新打开终端。", "The terminal service restarted. The original request will not be replayed; explicitly open a new terminal."));
      }
      return await sendCreation(request, reveal);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    finally { setBusy(false); }
  };
  const recoveryAttempted = useRef<string | null>(null);
  useEffect(() => {
    const request = pendingCreation;
    if (!enabled || !request || busy || recoveryAttempted.current === request.requestId) return;
    recoveryAttempted.current = request.requestId;
    void reconcileCreation(false).catch(() => {});
  }, [enabled, pendingCreation, busy, reconcileCreation]);
  const openSession = async (target: SessionTerminalTarget) => {
    assertEnabled();
    const actual = activeEnvironment.current;
    if (!actual || actual.threadId !== target.threadId || actual.agentWorkspaceId !== target.agentWorkspaceId || actual.agentWorkspaceRevision !== target.agentWorkspaceRevision || activeThread.current !== target.threadId)
      throw new Error(agentText("会话或执行目录已变化，请重新打开原会话终端。", "The Session or execution folder changed. Reopen the original Session terminal."));
    if (openingSession.current) throw new Error(agentText("正在核对原会话终端，请稍后重试。", "The original Session terminal is being resolved. Retry when it finishes."));
    openingSession.current = true;
    setSessionTarget(target); setSelectedId(null); setError(undefined); setBusy(true);
    const assertCurrent = () => {
      assertEnabled();
      const current = activeEnvironment.current;
      if (!current || activeThread.current !== target.threadId || current.agentWorkspaceId !== target.agentWorkspaceId || current.agentWorkspaceRevision !== target.agentWorkspaceRevision)
        throw new Error(agentText("会话或目录已切换，未打开其他目标的终端。", "The Session or folder changed. No terminal for another target was opened."));
    };
    try {
      const pending = pendingRef.current;
      if (pending) {
        if (pending.scope !== "session" || pending.threadId !== target.threadId || pending.agentWorkspaceId !== target.agentWorkspaceId || pending.agentWorkspaceRevision !== target.agentWorkspaceRevision)
          throw new Error(agentText("另一目录的终端创建结果未决，请先返回原目录核对请求。", "A terminal creation in another folder is unresolved. Return to that folder and reconcile the original request first."));
        assertCurrent();
        await reconcileCreation(true);
        assertCurrent();
        return;
      }
      const query = new URLSearchParams({ threadId: target.threadId, agentWorkspaceId: target.agentWorkspaceId, agentWorkspaceRevision: String(target.agentWorkspaceRevision) });
      const catalog = await workspaceClient.json<TerminalCatalog>(`/api/inspector/terminals?${query}`);
      assertCurrent();
      const candidates = catalog.terminals.filter(terminal => terminal.serviceId === catalog.serviceId && sessionTerminalMatches(terminal, target));
      let remembered: string | null = null;
      try { remembered = sessionStorage.getItem(`pm-v4:terminal-session:${target.threadId}`); } catch { /* Only the authoritative catalog is used. */ }
      const existing = candidates.find(terminal => terminal.id === remembered) ?? candidates.find(terminal => terminal.status === "running") ?? candidates[0];
      if (existing) {
        setTerminals(current => [...current.filter(item => item.id !== existing.id), acceptTerminalDescriptor(current.find(item => item.id === existing.id), existing)]);
        setSelectedId(existing.id); onShow();
      } else {
        await sendCreation({ requestId: crypto.randomUUID(), expectedServiceId: catalog.serviceId, scope: "session", ...target, relativePath: "" });
        assertCurrent();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    finally { openingSession.current = false; setBusy(false); }
  };
  const acceptExit = (id: string, exitCode: number, signal?: number) => {
    assertEnabled();
    setTerminals(current => current.map(terminal => terminal.id === id ? { ...terminal, status: "exited", exitCode, signal: signal ?? null } : terminal));
  };
  return {
    selectedId: selected?.id ?? null, selected, enabled: enabled && (!!workspace || !!environment?.agentWorkspaceId || !!pendingCreation),
    create, openSession, busy, error, retry: () => { assertEnabled(); setError(undefined); void (pendingRef.current ? reconcileCreation(true) : refresh()).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }, acceptExit,
  };
}

export function ExecutionTerminals({ controller: c }: { controller: ExecutionTerminalController }) {
  const selected = c.selected;
  return <div className="pm-execution-terminals">
    {c.busy && !selected && <p role="status">{agentText("正在核对会话终端…", "Resolving the Session terminal…")}</p>}
    {c.error && <p role="alert">{c.error} <button type="button" disabled={c.busy} onClick={c.retry}>{agentText("核对原请求", "Reconcile original request")}</button></p>}
    {!selected && !c.busy && !c.error && <p role="status">{agentText("尚未打开终端。请从运行面板明确打开会话终端，或在 Files 中选择目录创建。", "No terminal is open. Explicitly open the Session terminal from the run board, or create one for a folder in Files.")}</p>}
    {selected && <TerminalPanel key={selected.id} terminal={selected} onExit={(exitCode, signal) => c.acceptExit(selected.id, exitCode, signal)} />}
  </div>;
}
