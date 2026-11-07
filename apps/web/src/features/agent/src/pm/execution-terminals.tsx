import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentWorkspace, ExecutionEnvironment } from "@agent-workspace/contracts/chat";
import type { TerminalDescriptor } from "@agent-workspace/contracts/inspector";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import { TerminalPanel } from "../workspace/inspector/terminal-panel";
import { workspaceClient } from "../network";
import { terminalBelongsToSessionView } from "./execution-terminal-selection";
import { acceptTerminalDescriptor, terminalCreationReadback, type PendingTerminalCreation } from "./terminal-creation-state";

export type TerminalDock = "bottom" | "right";
export type FolderTerminalRequest = { relativePath: string; scope: "workspace" | "session" };
type TerminalCatalog = { serviceId: string; terminals: TerminalDescriptor[] };
const PENDING_CREATION_KEY = "pm-v4:terminal-creation:pending";
export type ExecutionTerminalController = {
  selectedId: string | null; selected: TerminalDescriptor | undefined;
  enabled: boolean; create: (request: FolderTerminalRequest) => Promise<void>;
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
  const [serviceId, setServiceId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [readCompleted, setReadCompleted] = useState(false);
  const creating = useRef(false);
  const pendingRef = useRef(pendingCreation);
  const activeThread = useRef(threadId);
  activeThread.current = threadId;
  const readSequence = useRef(0);
  const visibleTerminals = terminals.filter(terminal => terminalBelongsToSessionView(terminal, threadId));
  // Filter during render: an old Session PTY detaches before switch effects run.
  const selected = visibleTerminals.find(terminal => terminal.id === selectedId);
  // Without a terminal toolbar, always resolve to a visible PTY once the service read completes.
  useEffect(() => {
    const current = terminals.find(terminal => terminal.id === selectedId);
    if (current?.scope === "workspace") return;
    if (current?.scope === "session" && current.threadId === threadId) {
      try { sessionStorage.setItem(`pm-v4:terminal-session:${threadId}`, current.id); } catch { /* The process remains service-owned. */ }
      return;
    }
    if (!readCompleted && !current) return;
    const visible = terminals.filter(terminal => terminalBelongsToSessionView(terminal, threadId));
    let remembered: string | null = null;
    try { remembered = threadId ? sessionStorage.getItem(`pm-v4:terminal-session:${threadId}`) : null; } catch { /* Leave this Session detached. */ }
    const known = terminals.find(terminal => terminal.id === remembered);
    const rememberedVisible = known && terminalBelongsToSessionView(known, threadId) ? known.id : null;
    const preferred = visible.find(terminal => terminal.scope === "session") ?? visible[0];
    setSelectedId(rememberedVisible ?? preferred?.id ?? null);
  }, [threadId, selectedId, terminals, readCompleted]);

  const refresh = useCallback(async () => {
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
    if (readSequence.current !== request) return;
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
  }, [workspace?.id, workspace?.revision, environment?.agentWorkspaceId, environment?.agentWorkspaceRevision, selectedId, threadId, pendingCreation]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const online = () => void refresh(); window.addEventListener("online", online); return () => window.removeEventListener("online", online); }, [refresh]);
  useEffect(() => { try { if (selectedId) sessionStorage.setItem("pm-v4:terminal-selected", selectedId); else sessionStorage.removeItem("pm-v4:terminal-selected"); } catch { /* Service terminal identity remains authoritative. */ } }, [selectedId]);

  const clearPendingCreation = () => {
    pendingRef.current = undefined; setPendingCreation(undefined);
    try { sessionStorage.removeItem(PENDING_CREATION_KEY); } catch { /* A retained original ID can only reconcile to the same process. */ }
  };
  const acceptCreation = (terminal: TerminalDescriptor, reveal = true) => {
    setTerminals(current => [...current.filter(item => item.id !== terminal.id), acceptTerminalDescriptor(current.find(item => item.id === terminal.id), terminal)]);
    if (terminal.scope === "workspace" || terminal.threadId === activeThread.current) setSelectedId(terminal.id);
    clearPendingCreation(); if (reveal) onShow();
  };
  const sendCreation = async (request: PendingTerminalCreation, reveal = true) => {
    if (creating.current) return;
    creating.current = true; setBusy(true);
    try {
      // Save the exact request before any PTY side effect; never mint a retry ID.
      sessionStorage.setItem(PENDING_CREATION_KEY, JSON.stringify(request));
    } catch {
      console.error("Cannot persist the original terminal request; nothing was sent.");
      creating.current = false; setBusy(false); if (reveal) onShow(); return;
    }
    pendingRef.current = request; setPendingCreation(request);
    try {
      const { terminal } = await workspaceClient.json<{ terminal: TerminalDescriptor }>("/api/inspector/terminals", { method: "POST", body: JSON.stringify(request) });
      acceptCreation(terminal, reveal);
    } catch (cause) {
      console.error("Terminal creation failed:", cause);
      if (cause instanceof WorkspaceClientError && cause.kind === "http") {
        if (cause.code === "terminal_service_changed" || cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status)) clearPendingCreation();
      }
      if (reveal) onShow();
    } finally { creating.current = false; setBusy(false); }
  };
  const create = async (folder: FolderTerminalRequest) => {
    if (creating.current) { onShow(); return; }
    if (pendingRef.current) { void reconcileCreation(true); onShow(); return; }
    if (!serviceId) { console.error("Terminal service is not ready; no terminal was created."); onShow(); return; }
    const agentWorkspaceId = folder.scope === "session" ? environment?.agentWorkspaceId : workspace?.id;
    const agentWorkspaceRevision = folder.scope === "session" ? environment?.agentWorkspaceRevision : workspace?.revision;
    if (!agentWorkspaceId || agentWorkspaceRevision == null || folder.scope === "session" && !threadId) return;
    await sendCreation({ requestId: crypto.randomUUID(), expectedServiceId: serviceId, scope: folder.scope, agentWorkspaceId, agentWorkspaceRevision, relativePath: folder.relativePath, ...(folder.scope === "session" ? { threadId: threadId! } : {}) });
  };
  const reconcileCreation = async (reveal = false) => {
    const request = pendingRef.current;
    if (!request || busy) return;
    setBusy(true);
    try {
      const query = new URLSearchParams({ agentWorkspaceId: request.agentWorkspaceId, agentWorkspaceRevision: String(request.agentWorkspaceRevision), requestId: request.requestId, ...(request.threadId ? { threadId: request.threadId } : {}) });
      const result = await workspaceClient.json<TerminalCatalog>(`/api/inspector/terminals?${query}`);
      setServiceId(result.serviceId);
      const outcome = terminalCreationReadback(request, result);
      if (outcome.status === "found") acceptCreation(outcome.terminal, reveal);
      else if (outcome.status === "service-changed") clearPendingCreation();
      else await sendCreation(request, reveal);
    } catch (cause) { console.error("Terminal creation reconciliation failed:", cause); }
    finally { setBusy(false); }
  };
  const recoveryAttempted = useRef<string | null>(null);
  useEffect(() => {
    const request = pendingCreation;
    if (!request || busy || recoveryAttempted.current === request.requestId) return;
    recoveryAttempted.current = request.requestId;
    void reconcileCreation(false);
  }, [pendingCreation, busy, reconcileCreation]);
  const acceptExit = (id: string, exitCode: number, signal?: number) => {
    setTerminals(current => current.map(terminal => terminal.id === id ? { ...terminal, status: "exited", exitCode, signal: signal ?? null } : terminal));
  };
  const oldSessionSelected = terminals.some(terminal => terminal.id === selectedId && terminal.scope === "session" && terminal.threadId !== threadId);
  return { selectedId: oldSessionSelected ? null : selectedId, selected, enabled: !!workspace || !!environment?.agentWorkspaceId || !!pendingCreation, create, acceptExit };
}

export function ExecutionTerminals({ controller: c }: { controller: ExecutionTerminalController }) {
  const selected = c.selected;
  return <div className="pm-execution-terminals">
    {selected && <TerminalPanel key={selected.id} terminal={selected} onExit={(exitCode, signal) => c.acceptExit(selected.id, exitCode, signal)} />}
  </div>;
}
