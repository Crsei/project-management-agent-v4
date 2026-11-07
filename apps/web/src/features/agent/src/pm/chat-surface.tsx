import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAui, useAuiState, ThreadListPrimitive, type AssistantRuntime } from "@assistant-ui/react";
import { ArchiveIcon, ArrowLeftIcon, ChartNoAxesCombinedIcon, FileTextIcon, FolderOpenIcon, KeyboardIcon, Loader2Icon, Maximize2Icon, PanelBottomIcon, PanelLeftIcon, PanelRightIcon, PlusIcon, SearchIcon, SettingsIcon, XIcon, ZapIcon } from "lucide-react";
import { DovspaceBrandLink } from "@/components/dovspace-brand";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { Thread } from "@agent/components/assistant-ui/elements/thread.aui";
import { useChatSettings } from "@agent/hooks/use-chat-settings";
import { useIsMobile } from "@agent/hooks/use-mobile";
import { ChatContinuity } from "../chat/continuity";
import { UsageNavigationLink } from "../usage/navigation";
import { initializeAgentThread, refreshThreadList } from "../chat/remote-adapter";
import { PmToolCallsProvider } from "../chat/pm-tool-calls";
import { PmRightPanel } from "./right-panel";
import { ThreadDetailsPanel } from "./thread-details-panel";
import { TerminalDrawer, TERMINAL_DRAWER_MIN_HEIGHT } from "./terminal-drawer";
import { ProductSwitcher } from "./product-switcher";
import { UserMenu } from "./user-menu";
import { useChatDrafts } from "./drafts";
import { SessionMenu } from "./session-menu";
import { PmIssueWorkspaceProvider } from "./pm-issue-workspace";
import { PmIssuePickerHost } from "./pm-issue-picker-host";
import { PmComposerReferenceAction, PmComposerReferences } from "./pm-composer-references";
import { createSidebarVisitCoordinator } from "./sidebar-visit";
import { workspaceClient } from "../network";
import { useAgentText, type AgentText } from "../i18n";
import { agentText } from "../i18n-text.ts";
import type { AgentWorkspace, ExecutionSelection, RemoteThread } from "@agent-workspace/contracts/chat";
import type { PmToolTarget } from "@agent-workspace/contracts/pm-tools";
import SessionSettingsDialog from "../settings/session-settings-dialog";
import { ShortcutCatalog } from "../settings/input-preferences";
import { useChatAppearance, useChatBrowserPreferences } from "../settings/browser-preferences";
import { acceptRemoteThread, availableProviderModel, bindDraftExecution, CHAT_ONLY_SELECTION, canSendThread, refreshAgentWorkspaces, refreshIdentity, refreshProviders, threadExecutionSelection, usePmChatState, workspaceExecutionSelection } from "./state";
import { OpenFolderDialog, ExecutionContextBar, ExecutionSelectionDialog, updateAgentWorkspace, useExecutionEnvironment } from "./execution-workspace";
import { ExecutionTerminals, useExecutionTerminals, type TerminalDock } from "./execution-terminals";
import type { StudioAssistRequest } from "./automation/studio-editor";
import pmTheme from "@/views/pm/dashboards-views.module.css";
import "../../styles/pm-chat.css";

const AutomationPage = lazy(() => import("./automation/page").then(module => ({ default: module.AutomationPage })));
const visitThread = createSidebarVisitCoordinator(
  async (id) => (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(id)}`)).thread,
  async (id, revision) => (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(id)}/sidebar`, {
    method: "POST", body: JSON.stringify({ action: "visit", revision }),
  })).thread,
);

const SessionActions = createContext<{
  disabled: boolean;
  automationsView: boolean;
  sortByCreated: boolean;
  onSwitch: (id: string) => void;
  onAction: (id: string, name: string, kind: "rename" | "delete") => void;
  thread: (id: string) => RemoteThread | undefined;
  path: (thread: RemoteThread) => string | null | undefined;
  scopeName: (thread: RemoteThread) => string;
  providerName: (thread: RemoteThread) => string;
  filtered: (thread: RemoteThread) => boolean;
  onSidebar: (thread: RemoteThread, action: "pin" | "unpin" | "settle" | "unsettle" | "snooze" | "wake" | "auto-settle" | "mark-unread" | "visit", options?: { snoozedUntil?: string; enabled?: boolean }) => void;
  onRegenerate: (thread: RemoteThread) => void;
  onSnooze: (thread: RemoteThread) => void;
  onFilter: (thread: RemoteThread) => void;
  onSettings: (thread: RemoteThread) => void;
  onArchive: (id: string, thread: RemoteThread) => void;
  onError: (message: string) => void;
} | null>(null);
function requestedPmTarget(params: URLSearchParams): PmToolTarget | undefined {
  const workspaceId = params.get("workspace");
  return workspaceId ? { workspaceId, projectId: params.get("project") || null } : undefined;
}
const relativeTimes = new Map<string, Intl.RelativeTimeFormat>();
function relativeTime(locale: string) {
  let format = relativeTimes.get(locale);
  if (!format) { format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }); relativeTimes.set(locale, format); }
  return format;
}
function sessionTime(value: string | undefined, t: AgentText) {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return t("时间未知", "Unknown time");
  const elapsed = time - Date.now();
  const magnitude = Math.abs(elapsed);
  if (magnitude < 60_000) return t("刚刚", "Just now");
  // The formatter locale follows the visible copy: zh-CN when text is Chinese, en otherwise.
  const format = relativeTime(agentText("zh-CN", "en"));
  if (magnitude < 3_600_000) return format.format(Math.round(elapsed / 60_000), "minute");
  if (magnitude < 86_400_000) return format.format(Math.round(elapsed / 3_600_000), "hour");
  if (magnitude < 30 * 86_400_000) return format.format(Math.round(elapsed / 86_400_000), "day");
  return new Date(time).toLocaleDateString();
}
function safeReturnTo(value: string | null, scope?: PmToolTarget) {
  // oxlint-disable-next-line no-control-regex -- reject normalized controls and backslashes in return navigation.
  if (value && /^\/pm(?:\/|$)/.test(value) && !/[\\\u0000-\u001f]/.test(value)) {
    try {
      const target = new URL(value, window.location.origin);
      if (target.origin === window.location.origin && /^\/pm(?:\/|$)/.test(target.pathname))
        return `${target.pathname}${target.search}${target.hash}`;
    } catch { /* Invalid or normalized non-PM paths use the current scope's PM entry. */ }
  }
  return scope ? `/pm/${encodeURIComponent(scope.workspaceId)}${scope.projectId ? `/projects/${encodeURIComponent(scope.projectId)}` : "/home"}` : "/pm";
}

export function PmChatSurface({ runtime, entry, onExpand, onClose, onThreadChange }: { runtime: AssistantRuntime; entry?: URLSearchParams; onExpand?: (params: URLSearchParams) => void; onClose?: () => void; onThreadChange?: (id: string | null) => void }) {
  const aui = useAui();
  const t = useAgentText();
  const state = usePmChatState();
  useChatAppearance();
  const { preferences } = useChatBrowserPreferences();
  const mobile = useIsMobile();
  const drawerSidebar = !!entry || mobile;
  const sidebarId = useId();
  const [routeParams, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const params = entry ?? routeParams;
  const [entryObject, setEntryObject] = useState(() => ({ task: params.get("task"), entity: params.get("entity") }));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [embeddedAutomationsView, setEmbeddedAutomationsView] = useState(() => params.get("view") === "automations");
  const automationLeaveGuard = useRef<(() => boolean) | null>(null);
  const setAutomationLeaveGuard = useCallback((guard: (() => boolean) | null) => { automationLeaveGuard.current = guard; }, []);
  const [search, setSearch] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState<string>();
  const [freshThreadId, setFreshThreadId] = useState<string>();
  const [snoozeTarget, setSnoozeTarget] = useState<RemoteThread>();
  const [snoozeTime, setSnoozeTime] = useState("");
  const visitedThread = useRef<string | undefined>(undefined);
  const [visiting, setVisiting] = useState(false);
  const currentRemote = useRef<string | undefined>(undefined);
  const wasRunning = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const closeSidebarDrawer = useCallback(() => {
    setSidebarOpen(false);
    requestAnimationFrame(() => sidebarToggle.current?.focus());
  }, []);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalDock, setTerminalDock] = useState<TerminalDock>("bottom");
  const [terminalHeight, setTerminalHeight] = useState(() => {
    try {
      const stored = Number(localStorage.getItem("pm-v3:terminal-height"));
      if (Number.isFinite(stored) && stored > 0) return Math.max(TERMINAL_DRAWER_MIN_HEIGHT, Math.min(720, window.innerHeight * 0.7, stored));
    } catch { /* A blocked storage keeps the in-memory height. */ }
    return 320;
  });
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelMaximized, setRightPanelMaximized] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  const [openFolder, setOpenFolder] = useState(false);
  const [executionDialog, setExecutionDialog] = useState<{ create: boolean; initial: ExecutionSelection }>();
  const [workspaceRename, setWorkspaceRename] = useState<{ workspace: AgentWorkspace; name: string }>();
  const [sessionAction, setSessionAction] = useState<{ id: string; title: string; kind: "rename" | "delete" }>();
  const [sessionTitle, setSessionTitle] = useState("");
  const localId = useAuiState((s) => s.threads.mainThreadId);
  const remoteId = useAuiState((s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.remoteId);
  currentRemote.current = remoteId;
  const creationIds = useRef(new Map<string, string>());
  const threadsLoading = useAuiState((s) => s.threads.isLoading);
  useEffect(() => { if (!threadsLoading && remoteId) onThreadChange?.(remoteId); }, [onThreadChange, remoteId, threadsLoading]);
  const threadLoading = useAuiState((s) => s.thread.isLoading);
  const threadRunning = useAuiState((s) => s.thread.isRunning);
  const switchError = useAuiState((s) => s.threads.switchError);
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const isDraftItem = threadItems.find((item) => item.id === localId)?.status === "new";
  const draftOrigin = useRef({ id: localId, wasNew: isDraftItem });
  if (draftOrigin.current.id !== localId) draftOrigin.current = { id: localId, wasNew: isDraftItem };
  else if (isDraftItem) draftOrigin.current.wasNew = true;
  const title = threadItems.find((item) => item.id === localId)?.title;
  const automationsView = entry ? embeddedAutomationsView : /^\/agent\/automations(?:\/|$)/.test(location.pathname) || params.get("view") === "automations";
  // PM hand-offs are reference/business targets, never folder selections.
  const displayScope = useMemo(() => requestedPmTarget(params), [params]);
  const currentThread = remoteId ? state.threads.get(remoteId) : undefined;
  const currentExecutionSelection = threadExecutionSelection(localId, remoteId);
  const currentWorkspace = state.workspaces.find(item => item.id === currentExecutionSelection?.agentWorkspaceId);
  const selectedWorkspace = state.workspaces.find(item => item.id === selectedWorkspaceId) ?? currentWorkspace;
  const execution = useExecutionEnvironment(remoteId, currentThread?.revision);
  const environment = execution.environment;
  const executionFrozen = environment?.frozen ?? currentThread?.executionEnvironment?.frozen ?? false;
  const showTerminal = useCallback(() => setTerminalOpen(true), []);
  const terminals = useExecutionTerminals({ workspace: selectedWorkspace, threadId: remoteId, environment: execution.error ? undefined : environment, onShow: showTerminal });
  const automationWorkspace = state.identity?.workspaces.find((workspace) => workspace.id === displayScope?.workspaceId);
  const automationReturn = useMemo(() => {
    const value = params.get("automationReturn");
    if (!value?.startsWith("/agent/automations/setup?")) return null;
    try {
      const url = new URL(value, window.location.origin);
      return url.origin === window.location.origin && url.pathname === "/agent/automations/setup" && url.searchParams.get("workspace") === displayScope?.workspaceId
        ? `${url.pathname}${url.search}` : null;
    } catch { return null; }
  }, [params, displayScope?.workspaceId]);
  const { protect, storageError } = useChatDrafts(runtime);
  const initialize = useCallback(async () => (await aui.threads.item({ id: localId }).initialize()).remoteId, [aui, localId]);
  const { settings, setSettings, ready: settingsReady, settingsLoaded, loading: settingsLoading, saving: settingsSaving, error: settingsError, retry } = useChatSettings(remoteId, initialize, localId);

  useEffect(() => {
    if (!drawerSidebar || !sidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      event.preventDefault();
      closeSidebarDrawer();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [drawerSidebar, sidebarOpen, closeSidebarDrawer]);
  useEffect(() => {
    void refreshAgentWorkspaces();
    void refreshProviders();
    const refresh = () => { void refreshAgentWorkspaces(); void refreshProviders(); void refreshThreadList().catch(() => {}); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", visible); };
  }, []);
  useEffect(() => {
    try { localStorage.setItem("pm-v3:terminal-height", String(Math.round(terminalHeight))); } catch { /* The drawer still works without persistence. */ }
  }, [terminalHeight]);
  useEffect(() => {
    const onResize = () => setTerminalHeight((value) => Math.max(TERMINAL_DRAWER_MIN_HEIGHT, Math.min(720, window.innerHeight * 0.7, value)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: number;
    const schedule = () => {
      const now = Date.now();
      let delay = [...state.threads.values()].some((thread) => thread.sidebar.running) ? 5_000 : 60_000;
      for (const thread of state.threads.values()) {
        const wake = thread.sidebar.snoozedUntil ? Date.parse(thread.sidebar.snoozedUntil) : NaN;
        if (thread.sidebar.snoozedAt && Number.isFinite(wake)) delay = Math.min(delay, wake > now ? wake - now + 100 : 5_000);
      }
      timer = window.setTimeout(() => {
        if (document.visibilityState !== "visible") { schedule(); return; }
        void refreshThreadList().catch(() => {}).finally(() => { if (!stopped) schedule(); });
      }, delay);
    };
    schedule();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [state.threads]);
  useEffect(() => {
    if (wasRunning.current && !threadRunning) void refreshThreadList().catch(() => {});
    wasRunning.current = threadRunning;
  }, [threadRunning]);
  useEffect(() => {
    if (!remoteId) { visitedThread.current = undefined; setVisiting(false); return; }
    const thread = state.threads.get(remoteId);
    if (!thread || visitedThread.current === remoteId) return;
    visitedThread.current = remoteId;
    setVisiting(true);
    void visitThread(remoteId).then((saved) => { if (currentRemote.current === remoteId) acceptRemoteThread(saved); }).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
      void refreshThreadList().catch(() => {});
    }).finally(() => { if (currentRemote.current === remoteId) setVisiting(false); });
  }, [remoteId, state.threads]);
  useEffect(() => {
    if (entry || automationsView || threadsLoading) return;
    const next = new URLSearchParams(params);
    if (remoteId) next.set("thread", remoteId); else next.delete("thread");
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [remoteId, threadsLoading, params, setParams, entry, automationsView]);
  useEffect(() => { if (automationsView) void refreshIdentity(); }, [automationsView]);
  useEffect(() => {
    if (entry || params.get("view") !== "automations") return;
    const next = new URLSearchParams(params);
    next.delete("view");
    next.delete("thread");
    navigate({ pathname: "/agent/automations", search: next.toString() }, { replace: true });
  }, [entry, params, navigate]);

  const act = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true); setActionError(undefined);
    try { await action(); } catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  const canLeaveAutomation = () => !automationsView || !automationLeaveGuard.current || automationLeaveGuard.current();
  const protectNavigation = () => canLeaveAutomation() && protect();
  const setAutomationView = (open: boolean) => {
    if (entry) { setEmbeddedAutomationsView(open); return; }
    const next = new URLSearchParams(params);
    next.delete("view");
    if (open) {
      next.delete("thread");
      if (displayScope) {
        next.set("workspace", displayScope.workspaceId);
        if (displayScope.projectId) next.set("project", displayScope.projectId); else next.delete("project");
      }
    }
    navigate({ pathname: open ? "/agent/automations" : "/agent/workspace", search: next.toString() });
  };
  const openAutomation = () => {
    if (!automationsView && !protect()) return;
    setAutomationView(true);
    setSidebarOpen(false);
  };
  const exitAutomation = () => {
    if (!canLeaveAutomation()) return;
    setAutomationView(false);
  };
  const clearEntryObject = (exitView = false) => {
    setEntryObject({ task: null, entity: null });
    if (entry) {
      if (exitView) setEmbeddedAutomationsView(false);
    } else if (params.has("task") || params.has("entity") || exitView) {
      const next = new URLSearchParams(params);
      next.delete("task"); next.delete("entity");
      if (exitView) {
        next.delete("view");
        navigate({ pathname: "/agent/workspace", search: next.toString() }, { replace: true });
      } else setParams(next, { replace: true });
    }
  };
  const createSession = (selection: ExecutionSelection) => {
    if (pending || !canLeaveAutomation() || !protect()) return;
    void act(async () => {
      const key = JSON.stringify(selection);
      const id = creationIds.current.get(key) ?? crypto.randomUUID();
      creationIds.current.set(key, id);
      bindDraftExecution(id, selection);
      await initializeAgentThread(id);
      await refreshThreadList();
      await runtime.threads.switchToThread(id);
      clearEntryObject(automationsView);
      setFreshThreadId(id);
      creationIds.current.delete(key);
      setSelectedWorkspaceId(selection.agentWorkspaceId ?? undefined);
      setSidebarOpen(false);
      setExecutionDialog(undefined);
    });
  };
  const configureExecution = () => {
    if (pending || threadRunning) return;
    setExecutionDialog({ create: executionFrozen || !currentExecutionSelection, initial: currentExecutionSelection ?? CHAT_ONLY_SELECTION });
  };
  const saveExecution = (selection: ExecutionSelection) => {
    if (!executionDialog) return;
    if (executionDialog.create) { createSession(selection); return; }
    void act(async () => {
      if (remoteId && currentThread) {
        const { thread } = await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(remoteId)}`, { method: "PUT", body: JSON.stringify({ executionSelection: selection, revision: currentThread.revision }) });
        acceptRemoteThread(thread);
        execution.refresh();
      } else bindDraftExecution(localId, selection);
      setExecutionDialog(undefined);
    });
  };
  const manageWorkspace = (workspace: AgentWorkspace, action: "rename" | "close" | "reopen") => {
    if (pending) return;
    if (action === "rename") {
      setWorkspaceRename({ workspace, name: workspace.name });
    } else {
      if (action === "close" && !window.confirm(t(`关闭「${workspace.name}」？只隐藏目录列表，不删除文件或会话。`, `Close "${workspace.name}"? This only hides the folder; files and sessions are kept.`))) return;
      void act(async () => { await updateAgentWorkspace(workspace, { archived: action === "close" }); });
    }
  };
  const switchSession = (id: string) => {
    if (!canLeaveAutomation() || !protect()) return;
    if (id === localId) {
      if (automationsView) setAutomationView(false);
      const thread = remoteId && state.threads.get(remoteId);
      if (thread) void act(async () => {
        const saved = await visitThread(thread.remoteId);
        acceptRemoteThread(saved);
      });
      setSidebarOpen(false); return;
    }
    clearEntryObject(automationsView);
    void act(async () => { await runtime.threads.switchToThread(id); setFreshThreadId(undefined); setSidebarOpen(false); });
  };
  const openAutomationThread = (threadId: string) => {
    if (!canLeaveAutomation() || !protect() || !displayScope) return;
    void act(async () => {
      const { thread } = await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(threadId)}`);
      acceptRemoteThread(thread);
      await refreshThreadList();
      await runtime.threads.switchToThread(thread.remoteId);
      setFreshThreadId(undefined);
      clearEntryObject(true);
    });
  };
  const assistAutomation = async (request: StudioAssistRequest) => {
    if (!canLeaveAutomation() || !protect() || !displayScope) return;
    const target = { workspaceId: displayScope.workspaceId, projectId: request.projectId };
    if (!state.identity?.workspaces.some(item => item.id === target.workspaceId)) throw new Error(t("自动化工作区当前不可访问。", "The automation workspace is no longer accessible."));
    const returnParams = new URLSearchParams({ workspace: target.workspaceId, project: target.projectId });
    if (request.definitionId) returnParams.set("automationId", request.definitionId);
    else if (request.draftId) returnParams.set("draftId", request.draftId);
    const returnPath = `/agent/automations/setup?${returnParams}`;
    const id = crypto.randomUUID();
    bindDraftExecution(id, CHAT_ONLY_SELECTION);
    await initializeAgentThread(id);
    await refreshThreadList();
    await runtime.threads.switchToThread(id);
    setFreshThreadId(id);
    aui.composer().setText(`${request.prompt}\n\n${t("返回自动化配置", "Return to automation setup")}: ${returnPath}`);
    if (entry) setEmbeddedAutomationsView(false);
    else navigate({ pathname: "/agent/workspace", search: new URLSearchParams({ workspace: target.workspaceId, project: target.projectId, thread: id, automationReturn: returnPath }).toString() });
  };
  const openAction = (id: string, sessionName: string, kind: "rename" | "delete") => {
    setSessionAction({ id, title: sessionName, kind }); setSessionTitle(sessionName);
  };
  const commitSessionAction = () => {
    if (!sessionAction) return;
    if (sessionAction.kind === "delete" && sessionAction.id === localId && (!canLeaveAutomation() || !protect())) return;
    void act(async () => {
      const item = runtime.threads.getItemById(sessionAction.id);
      if (sessionAction.kind === "rename") await item.rename(sessionTitle.trim());
      else { await item.delete(); if (sessionAction.id === localId) { setFreshThreadId(undefined); clearEntryObject(); onThreadChange?.(null); } }
      await refreshThreadList();
      setSessionAction(undefined);
    });
  };
  const sidebarAction = (thread: RemoteThread, action: "pin" | "unpin" | "settle" | "unsettle" | "snooze" | "wake" | "auto-settle" | "mark-unread" | "visit", options?: { snoozedUntil?: string; enabled?: boolean }) => {
    const parkingCurrent = thread.remoteId === remoteId && (action === "settle" || action === "snooze");
    if (parkingCurrent && (!canLeaveAutomation() || !protect())) return;
    void act(async () => {
      try {
        const result = await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}/sidebar`, {
          method: "POST", body: JSON.stringify({ action, revision: thread.sidebar.revision, ...options }),
        });
        acceptRemoteThread(result.thread);
        if (parkingCurrent && ((action === "settle" && result.thread.sidebar.section === "settled") || (action === "snooze" && result.thread.sidebar.section === "snoozed"))) {
          await runtime.threads.switchToNewThread();
          setFreshThreadId(undefined);
          clearEntryObject();
          onThreadChange?.(null);
        }
      } catch (error) {
        await refreshThreadList().catch(() => {});
        throw error;
      }
    });
  };
  const threadScopeName = (thread: RemoteThread) => {
    const workspace = state.workspaces.find(item => item.id === thread.executionSelection?.agentWorkspaceId);
    return workspace ? `${workspace.name} · ${workspace.path}` : thread.executionSelection?.agentWorkspaceId ?? t("仅对话", "Chat only");
  };
  const threadProviderName = (thread: RemoteThread) => {
    const providerId = thread.settings.providerInstanceId;
    return state.providers.find((provider) => provider.instanceId === providerId)?.label || providerId || t("未选择 Provider", "No provider selected");
  };
  const renderSessions = () => {
    const query = search.trim().toLocaleLowerCase();
    const indices = threadIds.map((id, index) => {
      const item = threadItems.find(candidate => candidate.id === id);
      return { id, index, item, thread: item?.remoteId ? state.threads.get(item.remoteId) : undefined };
    }).filter(({ item, thread }) => item?.remoteId && (!workspaceFilter || thread?.executionSelection?.agentWorkspaceId === workspaceFilter) && (!query || [item.title, thread?.remoteId, thread && threadScopeName(thread), thread && threadProviderName(thread)].some(value => value?.toLocaleLowerCase().includes(query))));
    const rows = (workspaceId: string | null) => {
      const group = indices.filter(({ thread }) => (thread?.executionSelection?.agentWorkspaceId ?? null) === workspaceId);
      const sectionRows = (section: "pinned" | "active" | "snoozed" | "settled") => group.filter(({ thread }) => (thread?.sidebar.section ?? "active") === section).sort((a, b) => {
        if (section === "pinned") return (b.thread?.sidebar.pinnedAt ?? "").localeCompare(a.thread?.sidebar.pinnedAt ?? "");
        if (section === "snoozed") return (a.thread?.sidebar.snoozedUntil ?? "").localeCompare(b.thread?.sidebar.snoozedUntil ?? "");
        return ((preferences.threadSortOrder === "created_at" ? b.thread?.createdAt : b.thread?.updatedAt) ?? "").localeCompare((preferences.threadSortOrder === "created_at" ? a.thread?.createdAt : a.thread?.updatedAt) ?? "");
      }).map(({ id, index }) => <ThreadListPrimitive.ItemByIndex key={id} index={index} components={{ ThreadListItem: SessionRow }} />);
      const pinned = sectionRows("pinned"), active = sectionRows("active"), snoozed = sectionRows("snoozed"), settled = sectionRows("settled");
      return <>{pinned.length > 0 && <><div className="pm-session-section-label">{t("置顶", "Pinned")}</div>{pinned}</>}{active}{snoozed.length > 0 && <details className="pm-session-section" open={search.trim() ? true : undefined}><summary>{t("稍后提醒", "Snoozed")} ({snoozed.length})</summary>{snoozed}</details>}{settled.length > 0 && <details className="pm-session-section" open={search.trim() ? true : undefined}><summary>{t("已归置", "Settled")} ({settled.length})</summary>{settled}</details>}</>;
    };
    const workspaceTree = (workspace: AgentWorkspace) => <details className="pm-session-section" key={workspace.id} open>
      <summary title={workspace.path} onClick={() => setSelectedWorkspaceId(workspace.id)}><FolderOpenIcon className="inline size-4" /> {workspace.name}</summary>
      <code className="block truncate px-3 text-xs text-muted-foreground" title={workspace.path}>{workspace.path}</code>
      {workspace.status !== "available" && <p role="status" className="px-3 text-xs text-destructive">{workspace.reason ?? t("目录不可用", "Folder unavailable")}</p>}
      <div className="flex gap-1 px-2"><Button size="sm" variant="ghost" disabled={pending || workspace.status !== "available"} onClick={() => createSession(workspaceExecutionSelection(workspace))}><PlusIcon />{t("会话", "Session")}</Button><Button size="sm" variant="ghost" disabled={pending} onClick={() => manageWorkspace(workspace, "rename")}>{t("重命名", "Rename")}</Button><Button size="sm" variant="ghost" disabled={pending} onClick={() => manageWorkspace(workspace, "close")}>{t("关闭", "Close")}</Button></div>
      {rows(workspace.id)}
    </details>;
    const archived = state.workspaces.filter(item => item.archivedAt);
    return <div className="pm-agent-sessions">
      {state.workspaces.filter(item => !item.archivedAt && (!workspaceFilter || item.id === workspaceFilter)).map(workspaceTree)}
      {!workspaceFilter && <details className="pm-session-section" open><summary>{t("仅对话", "Chat only")}</summary><Button size="sm" variant="ghost" disabled={pending} onClick={() => createSession(CHAT_ONLY_SELECTION)}><PlusIcon />{t("新会话", "New session")}</Button>{rows(null)}</details>}
      {archived.length > 0 && <details className="pm-session-section"><summary>{t("已关闭的文件夹", "Closed folders")}</summary>{archived.map(workspace => <div className="px-3 py-2" key={workspace.id}><strong>{workspace.name}</strong><code className="block truncate text-xs" title={workspace.path}>{workspace.path}</code><Button size="sm" variant="ghost" disabled={pending} onClick={() => manageWorkspace(workspace, "reopen")}>{t("重新打开（保留会话）", "Reopen (sessions kept)")}</Button>{rows(workspace.id)}</div>)}</details>}
    </div>;
  };
  const sessionSettingsDisabled = !settingsLoaded || settingsLoading || settingsSaving || threadRunning || threadLoading || threadsLoading || pending;
  const toggleSidebar = () => {
    if (drawerSidebar) {
      if (sidebarOpen) closeSidebarDrawer();
      else { setSidebarOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); }
    } else setSidebarCollapsed((collapsed) => !collapsed);
  };
  const inspectorDisabled = !remoteId || execution.loading || !!execution.error || !environment?.agentWorkspaceId || !environment.executionPath;
  const changeRightPanelOpen = (next: boolean) => {
    setRightPanelOpen(next);
    if (next) return;
    setRightPanelMaximized(false);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[data-right-panel-toggle]")?.focus());
  };
  const changeRightPanelMaximized = (next: boolean) => {
    if (next) {
      setDetailsOpen(false);
      if (terminalDock === "bottom") setTerminalOpen(false);
    }
    setRightPanelMaximized(next);
  };
  const toggleRightPanel = () => {
    if (rightPanelOpen) changeRightPanelOpen(false);
    else setRightPanelOpen(true);
  };
  const toggleTerminalDrawer = () => { setTerminalDock("bottom"); setTerminalOpen(value => terminalDock === "bottom" ? !value : true); };
  const dockTerminal = (dock: TerminalDock) => { setTerminalDock(dock); setTerminalOpen(true); if (dock === "right") setRightPanelOpen(true); };
  const terminalSurface = <ExecutionTerminals controller={terminals} dock={terminalDock} onDock={dockTerminal} onHide={() => setTerminalOpen(false)} />;
  const attachBrowserImage = useCallback(async (file: File) => {
    await runtime.thread.composer.addAttachment(file);
  }, [runtime]);
  const pmHref = safeReturnTo(params.get("returnTo"), displayScope);
  const handoffParams = new URLSearchParams(params);
  if (displayScope) { handoffParams.set("workspace", displayScope.workspaceId); if (displayScope.projectId) handoffParams.set("project", displayScope.projectId); else handoffParams.delete("project"); }
  if (remoteId) handoffParams.set("thread", remoteId); else handoffParams.delete("thread");
  if (!entryObject.task) handoffParams.delete("task");
  if (!entryObject.entity) handoffParams.delete("entity");
  if (automationsView) handoffParams.set("view", "automations"); else handoffParams.delete("view");
  const settingsReturnTo = `/agent/workspace?${handoffParams}`;
  const customizeParams = new URLSearchParams();
  if (displayScope) {
    customizeParams.set("workspace", displayScope.workspaceId);
    if (displayScope.projectId) customizeParams.set("project", displayScope.projectId);
  }
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"]')) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], details[open]:not(.pm-session-section)')) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.altKey && !event.shiftKey && event.key.toLowerCase() === "b" && !automationsView) {
        event.preventDefault();
        toggleRightPanel();
      } else if (modifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === "b" && !automationsView) {
        event.preventDefault();
        setDetailsOpen((open) => !open);
      } else if (modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j" && !automationsView) {
        event.preventDefault();
        if (terminals.enabled || terminals.selectedId) toggleTerminalDrawer();
      } else if (event.altKey) {
        return;
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === "o" && !pending) {
        event.preventDefault(); createSession(selectedWorkspace && !selectedWorkspace.archivedAt ? workspaceExecutionSelection(selectedWorkspace) : CHAT_ONLY_SELECTION);
      } else if (modifier && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault(); setSidebarCollapsed(false); setSidebarOpen(true);
        requestAnimationFrame(() => searchInput.current?.focus());
      } else if (modifier && !event.shiftKey && event.key === ".") {
        const stop = document.querySelector<HTMLButtonElement>(".pm-agent-chat .aui-composer-cancel");
        if (stop && !stop.disabled) { event.preventDefault(); stop.click(); }
      } else if (!modifier && event.key === "?") {
        event.preventDefault(); setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  return <PmToolCallsProvider key={remoteId ?? localId} threadId={remoteId}><PmIssueWorkspaceProvider
    workspaceId={displayScope?.workspaceId ?? null}
    projectId={displayScope?.projectId ?? null}
    referenceKey={remoteId ? `thread:${remoteId}` : `draft:${localId}`}
    localThreadId={localId}
    initialIssueId={entryObject.task}
    initialEntityId={entryObject.entity}
  ><div className={`pm-agent-chat ${pmTheme.page}`} data-embedded={!!entry} data-right-panel-maximized={rightPanelMaximized && rightPanelOpen ? "true" : undefined}>
    {sidebarOpen && <button type="button" className="pm-agent-sidebar-backdrop" aria-label={t("关闭会话侧栏", "Close session sidebar")} onClick={closeSidebarDrawer} />}
    <aside id={sidebarId} className="pm-agent-sidebar" data-open={sidebarOpen} data-collapsed={sidebarCollapsed} aria-label={t("工作区与会话", "Workspaces and sessions")}>
      <header className="pm-agent-product">
        <DovspaceBrandLink canLeave={protectNavigation} />
        <button type="button" className="pm-agent-icon" aria-label={drawerSidebar ? t("关闭侧栏", "Close sidebar") : t("折叠侧栏", "Collapse sidebar")} aria-controls={sidebarId} aria-expanded onClick={() => { toggleSidebar(); requestAnimationFrame(() => sidebarToggle.current?.focus()); }}>{drawerSidebar ? <XIcon /> : <PanelLeftIcon />}</button>
      </header>
      <div className="pm-agent-app-selector"><ProductSwitcher pending={pending} canLeave={protectNavigation} pmHref={pmHref} /></div>
      <div className="pm-agent-sidebar-controls">
        <div className="pm-agent-toolbar">
          <label className="pm-agent-search"><SearchIcon /><Input ref={searchInput} type="search" aria-label={t("搜索会话", "Search sessions")} placeholder={t("搜索会话…", "Search sessions…")} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <button type="button" className="pm-agent-icon" disabled={pending} aria-label={t("打开文件夹", "Open folder")} title={t("打开服务器文件夹", "Open server folder")} onClick={() => setOpenFolder(true)}><FolderOpenIcon /></button>
          <button type="button" className="pm-agent-icon" disabled={pending} aria-label={t("新建会话", "New session")} title={t("新建会话 (Ctrl / ⌘ + Shift + O)", "New session (Ctrl / ⌘ + Shift + O)")} onClick={() => createSession(selectedWorkspace && !selectedWorkspace.archivedAt ? workspaceExecutionSelection(selectedWorkspace) : CHAT_ONLY_SELECTION)}><PlusIcon /></button>
        </div>
        <Button className="w-full justify-start" variant="outline" disabled={pending} onClick={() => setOpenFolder(true)}><FolderOpenIcon />{t("打开文件夹", "Open folder")}</Button>
        {workspaceFilter && <button type="button" className="pm-session-filter" onClick={() => setWorkspaceFilter(undefined)}>{t("显示所有文件夹 ×", "Show all folders ×")}</button>}
        <Link className="pm-agent-navigation-link" data-testid="agent-customize-link" data-automation-leave-guarded="true" to={{ pathname: "/agent/settings/mcp-servers", search: customizeParams.toString() }} state={{ settingsReturnTo }} title={t("自定义 Agent：MCP 服务器与 Skills", "Customize Agent: MCP servers and Skills")} onClick={(event) => { if (!protectNavigation()) event.preventDefault(); }}><SettingsIcon aria-hidden="true" /><span>{t("自定义", "Customize")}</span><small>MCP / Skills</small></Link>
        <button type="button" className="pm-agent-navigation-link" aria-current={automationsView ? "page" : undefined} onClick={openAutomation}><ZapIcon /><span>{t("自动化", "Automations")}</span></button>
        {actionError && <p role="alert" className="pm-agent-sidebar-error">{actionError}</p>}
      </div>
      <SessionActions.Provider value={{
        disabled: pending || visiting, automationsView, sortByCreated: preferences.threadSortOrder === "created_at", onSwitch: switchSession, onAction: openAction,
        thread: (id) => state.threads.get(id),
        path: (thread) => thread.executionEnvironment?.executionPath,
        scopeName: threadScopeName, providerName: threadProviderName,
        filtered: (thread) => workspaceFilter === thread.executionSelection?.agentWorkspaceId,
        onSidebar: sidebarAction,
        onRegenerate: (thread) => void act(async () => {
          try {
            const result = await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}/regenerate-title`, { method: "POST", body: JSON.stringify({ revision: thread.revision }) });
            acceptRemoteThread(result.thread); await refreshThreadList();
          } catch (error) { await refreshThreadList().catch(() => {}); throw error; }
        }),
        onSnooze: (thread) => { setSnoozeTarget(thread); setSnoozeTime(""); },
        onFilter: (thread) => setWorkspaceFilter(workspaceFilter === thread.executionSelection?.agentWorkspaceId ? undefined : thread.executionSelection?.agentWorkspaceId ?? undefined),
        onSettings: (thread) => { const workspace = state.workspaces.find(item => item.id === thread.executionSelection?.agentWorkspaceId); if (workspace) manageWorkspace(workspace, "rename"); },
        onArchive: (id, thread) => {
          if (id === localId && (!canLeaveAutomation() || !protect())) return;
          const name = thread.title || t("未命名会话", "Untitled session");
          if (preferences.confirmThreadArchive && !window.confirm(t(`归档会话「${name}」？归档会将会话移出当前侧栏，可稍后在归档中恢复。`, `Archive session "${name}"? Archiving removes it from this sidebar; you can restore it from the archive later.`))) return;
          void act(async () => {
            const current = (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}`)).thread;
            const saved = current.status === "archived" ? current : (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}`, { method: "PUT", body: JSON.stringify({ status: "archived" }) })).thread;
            acceptRemoteThread(saved);
            await refreshThreadList();
            if (id === localId) { await runtime.threads.switchToNewThread(); setFreshThreadId(undefined); clearEntryObject(); onThreadChange?.(null); }
          });
        },
        onError: setActionError,
      }}><nav className="pm-agent-catalog" aria-label={t("会话", "Sessions")}>
        <div className="pm-agent-sessions-heading"><h2>{t("会话 · Sessions", "Sessions")}</h2><Link className="pm-agent-icon" data-automation-leave-guarded="true" aria-label={t("历史与归档", "History and archive")} title={t("历史与归档", "History and archive")} to="/agent/settings/history" state={{ settingsReturnTo }} onClick={(event) => { if (!protectNavigation()) event.preventDefault(); }}><ArchiveIcon /></Link></div>
        {state.loading && !state.workspaces.length && <p role="status" className="pm-agent-empty-group">{t("正在读取文件夹…", "Loading folders…")}</p>}
        {state.error && <div role="alert" className="pm-agent-sidebar-error">{state.error}<Button variant="outline" size="sm" onClick={() => void refreshAgentWorkspaces()}>{t("重新读取", "Reload")}</Button></div>}
        {!state.loading && !state.workspaces.length && <p className="pm-agent-empty-catalog">{t("打开服务器文件夹即可开始代码会话，也可选择仅对话。", "Open a server folder to start coding, or choose chat only.")}</p>}
        {threadsLoading && <p role="status" className="pm-agent-empty-group">{t("正在恢复会话…", "Restoring sessions…")}</p>}
        {state.threadError && <div role="alert" className="pm-agent-sidebar-error">{t("会话读取失败：", "Failed to load sessions: ")}{state.threadError}<Button size="sm" variant="outline" onClick={() => void act(refreshThreadList)}>{t("重试", "Retry")}</Button></div>}
        {renderSessions()}
      </nav></SessionActions.Provider>
      <footer className="pm-agent-sidebar-footer">
        <nav className="pm-agent-footer-actions" aria-label={t("Agent 设置与帮助", "Agent settings and help")}>
          <Link className="pm-agent-icon" data-automation-leave-guarded="true" to="/agent/settings/general" state={{ settingsReturnTo }} aria-label={t("设置", "Settings")} title={t("设置", "Settings")} onClick={(event) => { if (!protectNavigation()) event.preventDefault(); }}><SettingsIcon /></Link>
          <UsageNavigationLink className="pm-agent-icon" data-automation-leave-guarded="true" aria-label={t("用量", "Usage")} title={t("用量", "Usage")} onClick={(event) => { if (!protectNavigation()) event.preventDefault(); }}><ChartNoAxesCombinedIcon /></UsageNavigationLink>
          <button type="button" className="pm-agent-icon" aria-label={t("快捷键帮助", "Keyboard shortcuts")} title={t("快捷键帮助", "Keyboard shortcuts")} onClick={() => setShortcutsOpen(true)}><KeyboardIcon /></button>
        </nav>
        <UserMenu workspaceId={displayScope?.workspaceId} canLeave={protectNavigation} />
      </footer>
    </aside>
    <main className="pm-agent-main">
      <header className="pm-agent-context-header">
        {(drawerSidebar || sidebarCollapsed) && <button ref={sidebarToggle} type="button" className="pm-agent-icon pm-agent-sidebar-toggle" aria-label={t("切换会话侧栏", "Toggle session sidebar")} aria-controls={sidebarId} aria-expanded={drawerSidebar ? sidebarOpen : !sidebarCollapsed} title={t("切换会话侧栏", "Toggle session sidebar")} onClick={() => { toggleSidebar(); if (!drawerSidebar) requestAnimationFrame(() => document.getElementById(sidebarId)?.querySelector<HTMLButtonElement>(".pm-agent-product button")?.focus()); }}><PanelLeftIcon /></button>}
        <nav className="pm-agent-context-title" aria-label={t("当前位置", "Current location")}><div>{currentWorkspace && <><span title={currentWorkspace.path}>{currentWorkspace.name}</span><span aria-hidden> / </span></>}<strong>{automationsView ? t("自动化", "Automations") : title ?? (remoteId ? t("历史会话", "Past session") : t("新会话", "New session"))}</strong></div></nav>
        {!automationsView && <>
          {!entry && automationReturn && <Button variant="outline" size="sm" onClick={() => { if (protect()) navigate(automationReturn); }}><ZapIcon />{t("返回自动化配置", "Return to automation setup")}</Button>}
          <button type="button" className="pm-agent-icon" aria-label={t("切换会话详情", "Toggle session details")} aria-pressed={detailsOpen} title={t("切换会话详情 (Ctrl / ⌘ + Shift + B)", "Toggle session details (Ctrl / ⌘ + Shift + B)")} onClick={() => setDetailsOpen((open) => !open)}><FileTextIcon /></button>
          <button type="button" className="pm-agent-icon" aria-label={t("切换终端抽屉", "Toggle terminal drawer")} aria-pressed={terminalOpen && terminalDock === "bottom"} title={t("切换终端抽屉 (Ctrl / ⌘ + J)", "Toggle terminal drawer (Ctrl / ⌘ + J)")} disabled={!terminals.enabled && !terminals.selectedId} onClick={toggleTerminalDrawer}><PanelBottomIcon /></button>
          <button type="button" className="pm-agent-icon" data-right-panel-toggle aria-label={t("切换右侧面板", "Toggle right panel")} aria-pressed={rightPanelOpen} title={t("切换右侧面板 (Ctrl / ⌘ + Alt + B)", "Toggle right panel (Ctrl / ⌘ + Alt + B)")} onClick={toggleRightPanel}><PanelRightIcon /></button>
        </>}
        {entry ? <><button type="button" className="pm-agent-back" aria-label={t("展开完整 Chat", "Open full Chat")} title={t("展开完整 Chat", "Open full Chat")} onClick={() => { if (protectNavigation()) onExpand?.(handoffParams); }}><Maximize2Icon /><span>{t("展开完整 Chat", "Open full Chat")}</span></button><button type="button" className="pm-agent-icon" onClick={() => { if (protectNavigation()) onClose?.(); }} aria-label={t("关闭 Agent 面板", "Close Agent panel")}><XIcon /></button></> : <Link className="pm-agent-back" data-automation-leave-guarded="true" to={pmHref} aria-label={t("返回 PM", "Back to PM")} title={t("返回 PM", "Back to PM")} onClick={(event) => { if (!protectNavigation()) event.preventDefault(); }} state={params.get("panel") === "1" && displayScope ? { agentPanelReturn: { workspaceId: displayScope.workspaceId, projectId: displayScope.projectId ?? undefined, taskId: entryObject.task ?? undefined, entityId: entryObject.entity ?? undefined, returnTo: pmHref, threadId: remoteId ?? null } } : undefined}><ArrowLeftIcon /><span>{t("返回 PM", "Back to PM")}</span></Link>}
      </header>
      {automationsView ? (automationWorkspace && displayScope
        ? <Suspense fallback={<div className="pm-agent-automation-empty" role="status">{t("正在加载自动化…", "Loading automations…")}</div>}><AutomationPage key={`${state.identity!.actor.id}:${automationWorkspace.id}:${automationWorkspace.version}`} workspace={automationWorkspace} actorId={state.identity!.actor.id} embedded={!!entry} onAssist={assistAutomation} onOpenThread={openAutomationThread} onExit={exitAutomation} onLeaveGuardChange={setAutomationLeaveGuard} onRecheckAccess={() => { void refreshIdentity(); }} /></Suspense>
        : <section className="pm-agent-automation-empty"><ZapIcon /><h1>{t("选择 PM 业务工作区以管理自动化", "Choose a PM business workspace for automations")}</h1>{state.identityError && <p role="alert">{state.identityError}</p>}<Link to="/pm" onClick={event => { if (!protectNavigation()) event.preventDefault(); }}>{t("前往 PM 选择业务工作区", "Choose a business workspace in PM")}</Link><Button variant="outline" onClick={exitAutomation}>{t("返回对话", "Back to chat")}</Button></section>) : <>
      <ExecutionContextBar environment={environment} workspace={currentWorkspace} threadId={remoteId} error={execution.error} loading={execution.loading} onConfigure={configureExecution} frozen={executionFrozen} />
      {settingsError && <div role="alert" className="pm-agent-notice">{t("会话设置未保存，输入已保留：", "Session settings were not saved; your input is kept: ")}{settingsError}<Button size="sm" variant="outline" onClick={() => void retry().catch(() => {})}>{t("重试保存设置", "Retry saving settings")}</Button></div>}
      {(entryObject.task || entryObject.entity) && <div className="pm-agent-notice">{t("入口对象：", "Entry object: ")}<code>{entryObject.task || entryObject.entity}</code> <button type="button" onClick={() => {
        const id = entryObject.task || entryObject.entity;
        const text = aui.composer.getState().text;
        aui.composer.setText(`${text}${text ? "\n\n" : ""}${t(`引用 PM 对象：${id}`, `Reference PM object: ${id}`)}`);
      }}>{t("加入消息", "Add to message")}</button></div>}
      {(actionError || storageError) && <p role="alert" className="pm-agent-notice pm-agent-error">{actionError ?? storageError}</p>}
      {switchError && <p role="alert" className="pm-agent-notice pm-agent-error">{t("无法恢复会话：", "Could not restore session: ")}{switchError.error instanceof Error ? switchError.error.message : String(switchError.error)}<Button size="sm" variant="outline" onClick={() => void act(() => runtime.threads.switchToThread(switchError.threadId))}>{t("重试打开会话", "Retry opening session")}</Button></p>}
      <ChatContinuity runtime={runtime} canContinue={settingsReady && !settingsSaving && !settingsError && !execution.loading && !execution.error && canSendThread(localId, remoteId, settings.providerInstanceId, settings.model, settings.modelOptions)} />
      <div className="pm-agent-conversation" onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest("a[href]") && !protect()) { event.preventDefault(); event.stopPropagation(); }
      }}><Thread
        providerInstanceId={settings.providerInstanceId}
        model={settings.model}
        modelOptions={settings.modelOptions}
        interactionMode={settings.interactionMode}
        onSettingsChange={setSettings}
        catalog={{ providers: state.providers, loading: state.providersLoading, error: state.providerError, refresh: refreshProviders }}
        disabled={!settingsLoaded || settingsLoading || execution.loading || !!execution.error || pending || threadRunning || threadLoading || threadsLoading}
        saving={settingsSaving}
        saveError={settingsError}
        onRetry={retry}
        sendUnavailableReason={!currentExecutionSelection ? t("会话缺少执行绑定，请新建会话。", "This session has no execution binding. Start a new session.") : !settingsReady ? t("会话设置尚未就绪或有待保存的更改。", "Session settings are not ready or have unsaved changes.") : execution.error ?? (!canSendThread(localId, remoteId, settings.providerInstanceId, settings.model, settings.modelOptions) ? t("Provider、模型或模型选项当前不可用。", "The Provider, model or model options are unavailable.") : undefined)}
        composerLeading={<PmComposerReferences />}
        composerActions={<PmComposerReferenceAction />}
        welcome={{
          title: currentWorkspace ? t(`想在 ${currentWorkspace.name} 中做什么？`, `What do you want to do in ${currentWorkspace.name}?`) : t("你想做什么？", "What do you want to do?"),
          freshlyCreated: (!!remoteId && freshThreadId === remoteId) || draftOrigin.current.wasNew,
        }}
        onModelChange={async (providerInstanceId, model) => {
          if (!settingsLoaded || settingsLoading || settingsSaving || pending || threadRunning || threadLoading || threadsLoading)
            throw new Error(t("当前会话暂时无法更改模型。", "The model cannot be changed for this session right now."));
          if (!availableProviderModel(providerInstanceId, model))
            throw new Error(t("模型目录已变化，请刷新后重新选择。", "The model catalog changed; refresh and select again."));
          const selected = state.providers.find((entry) => entry.instanceId === providerInstanceId);
          await setSettings({ providerInstanceId, model, modelOptions: selected?.modelPreferences?.options[model] ?? [], interactionMode: settings.interactionMode ?? "default" });
        }}
      /></div>
      {terminalOpen && terminalDock === "bottom" && <TerminalDrawer height={terminalHeight} onHeightChange={setTerminalHeight}>{terminalSurface}</TerminalDrawer>}
      </>}
    </main>
    {!automationsView && <ThreadDetailsPanel
      open={detailsOpen}
      onClose={() => setDetailsOpen(false)}
      workspaceName={currentWorkspace?.name}
      threadTitle={title ?? (remoteId ? t("历史会话", "Past session") : t("新会话", "New session"))}
      path={environment?.executionPath}
      statusLabel={threadRunning ? t("正在生成", "Generating") : execution.error ?? (execution.loading ? t("正在核验环境", "Validating environment") : environment?.agentWorkspaceId ? environment.agentWorkspaceName ?? "Local" : t("仅对话", "Chat only"))}
      onConfigureFiles={configureExecution}
      onSessionSettings={() => setSessionSettingsOpen(true)}
      sessionSettingsDisabled={sessionSettingsDisabled}
    />}
    {!automationsView && <PmRightPanel
      threadId={remoteId}
      open={rightPanelOpen}
      onOpenChange={changeRightPanelOpen}
      maximized={rightPanelMaximized}
      onMaximizedChange={changeRightPanelMaximized}
      inspectorScope={environment ? { threadId: remoteId, environment, onOpenTerminal: request => { void terminals.create(request); } } : undefined}
      terminalSurface={terminalSurface}
      terminalVisible={terminalOpen && terminalDock === "right"}
      terminalAvailable={terminals.enabled || !!terminals.selectedId}
      onOpenTerminal={() => dockTerminal("right")}
      onAttachImage={attachBrowserImage}
      disabled={inspectorDisabled} />}
    {executionDialog && <ExecutionSelectionDialog workspaces={state.workspaces} initial={executionDialog.initial} busy={pending || state.loading} error={actionError ?? state.error} onClose={() => setExecutionDialog(undefined)} onSave={saveExecution} />}
    {openFolder && <OpenFolderDialog onClose={() => setOpenFolder(false)} onOpened={workspace => { setSelectedWorkspaceId(workspace.id); setOpenFolder(false); }} />}
    {workspaceRename && <Dialog open onOpenChange={open => { if (!open && !pending) setWorkspaceRename(undefined); }}><DialogContent className="pm-agent-chat-dialog"><DialogHeader><DialogTitle>{t("重命名文件夹", "Rename folder")}</DialogTitle></DialogHeader><code>{workspaceRename.workspace.path}</code><Input autoFocus aria-label={t("文件夹显示名称", "Folder display name")} value={workspaceRename.name} disabled={pending} onChange={event => setWorkspaceRename({ ...workspaceRename, name: event.target.value })} />{actionError && <p role="alert" className="text-destructive">{actionError}</p>}<DialogFooter><Button variant="outline" disabled={pending} onClick={() => setWorkspaceRename(undefined)}>{t("取消", "Cancel")}</Button><Button disabled={pending || !workspaceRename.name.trim()} onClick={() => void act(async () => { await updateAgentWorkspace(workspaceRename.workspace, { name: workspaceRename.name.trim() }); setWorkspaceRename(undefined); })}>{t("保存名称", "Save name")}</Button></DialogFooter></DialogContent></Dialog>}
    {sessionSettingsOpen && <SessionSettingsDialog key={localId} settings={settings} providers={state.providers} providersLoading={state.providersLoading} providersError={state.providerError} onRefreshProviders={() => void refreshProviders()} saving={settingsSaving} onSave={setSettings} onClose={() => setSessionSettingsOpen(false)} />}
    {shortcutsOpen && <Dialog open onOpenChange={setShortcutsOpen}><DialogContent className="agent-session-dialog pm-agent-chat-dialog"><DialogHeader><DialogTitle>{t("对话快捷键", "Chat shortcuts")}</DialogTitle></DialogHeader><ShortcutCatalog /><DialogFooter><Button variant="outline" onClick={() => setShortcutsOpen(false)}>{t("关闭", "Close")}</Button></DialogFooter></DialogContent></Dialog>}
    {snoozeTarget && <Dialog open onOpenChange={(open) => { if (!open && !pending) setSnoozeTarget(undefined); }}><DialogContent className="pm-agent-chat-dialog">
      <DialogHeader><DialogTitle>{t("自定义稍后提醒 · Custom snooze", "Custom snooze")}</DialogTitle></DialogHeader>
      <Input type="datetime-local" aria-label={t("唤醒时间", "Wake time")} value={snoozeTime} onChange={(event) => setSnoozeTime(event.target.value)} />
      {snoozeTime && (!Number.isFinite(new Date(snoozeTime).getTime()) || new Date(snoozeTime).getTime() <= Date.now()) && <p role="alert" className="text-destructive">{t("请选择未来的时间。", "Choose a time in the future.")}</p>}
      <DialogFooter><Button variant="outline" onClick={() => setSnoozeTarget(undefined)}>{t("取消", "Cancel")}</Button><Button disabled={pending || !snoozeTime || !Number.isFinite(new Date(snoozeTime).getTime()) || new Date(snoozeTime).getTime() <= Date.now()} onClick={() => { sidebarAction(snoozeTarget, "snooze", { snoozedUntil: new Date(snoozeTime).toISOString() }); setSnoozeTarget(undefined); }}>{t("稍后提醒", "Snooze")}</Button></DialogFooter>
    </DialogContent></Dialog>}
    {sessionAction && <Dialog open onOpenChange={(open) => { if (!open && !pending) setSessionAction(undefined); }}><DialogContent className="pm-agent-chat-dialog">
      <DialogHeader><DialogTitle>{sessionAction.kind === "rename" ? t("重命名会话", "Rename session") : t("删除会话", "Delete session")}</DialogTitle></DialogHeader>
      {sessionAction.kind === "rename" && <Input autoFocus aria-label={t("会话名称", "Session name")} value={sessionTitle} onChange={(event) => setSessionTitle(event.target.value)} />}
      {actionError && <p role="alert" className="text-destructive">{actionError}</p>}
      <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setSessionAction(undefined)}>{t("取消", "Cancel")}</Button><Button variant={sessionAction.kind === "delete" ? "destructive" : "default"} disabled={pending || (sessionAction.kind === "rename" && !sessionTitle.trim())} onClick={commitSessionAction}>{pending ? t("正在保存…", "Saving…") : sessionAction.kind === "rename" ? t("保存名称", "Save name") : t("删除会话", "Delete session")}</Button></DialogFooter>
    </DialogContent></Dialog>}
    <PmIssuePickerHost />
  </div></PmIssueWorkspaceProvider></PmToolCallsProvider>;
}

function SessionRow() {
  const actions = useContext(SessionActions)!;
  const t = useAgentText();
  const id = useAuiState((s) => s.threadListItem.id);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const active = useAuiState((s) => s.threads.mainThreadId === s.threadListItem.id);
  const title = useAuiState((s) => s.threadListItem.title) ?? t("新会话", "New session");
  const running = useAuiState((s) => s.threadListItem.isRunning);
  const thread = remoteId ? actions.thread(remoteId) : undefined;
  const isRunning = running || !!thread?.sidebar.running;
  const current = active && !actions.automationsView;
  const timestamp = thread && (actions.sortByCreated ? thread.createdAt : thread.updatedAt);
  const renderRow = (ellipsis?: ReactNode) => <div className="pm-agent-session" data-active={current} tabIndex={thread ? 0 : undefined}>
    <button type="button" className="pm-agent-session-select" disabled={actions.disabled} onClick={() => actions.onSwitch(id)} aria-current={current ? "page" : undefined} title={title}>
      <span className="pm-agent-session-meta"><span className="pm-agent-session-scope">{thread ? actions.scopeName(thread) : t("历史会话", "Past session")}</span><time dateTime={timestamp} title={timestamp}>{sessionTime(timestamp, t)}</time></span>
      <span className="pm-agent-session-main"><span className="pm-agent-session-title">{title}</span><span className="pm-agent-session-provider" title={thread ? actions.providerName(thread) : undefined}>{thread ? actions.providerName(thread) : t("正在读取", "Loading")}</span>{isRunning && <><Loader2Icon className="animate-spin" aria-hidden="true" /><span className="sr-only">{t("正在后台生成", "Generating in background")}</span></>}{thread?.sidebar.unread && <><span className="pm-session-unread" title={t("未读", "Unread")} aria-hidden="true" /><span className="sr-only">{t("未读", "Unread")}</span></>}</span>
      {thread?.sidebar.section === "snoozed" && <span className="sr-only">{t(`稍后提醒至 ${thread.sidebar.snoozedUntil}`, `Snoozed until ${thread.sidebar.snoozedUntil}`)}</span>}
    </button>
    {ellipsis}
  </div>;
  return thread ? <SessionMenu thread={thread} title={title} path={actions.path(thread)} disabled={actions.disabled} running={isRunning} filtered={actions.filtered(thread)} onSidebar={(action, options) => actions.onSidebar(thread, action, options)} onRename={() => actions.onAction(id, title, "rename")} onRegenerate={() => actions.onRegenerate(thread)} onCustomSnooze={() => actions.onSnooze(thread)} onFilter={() => actions.onFilter(thread)} onSettings={() => actions.onSettings(thread)} onArchive={() => actions.onArchive(id, thread)} onDelete={() => actions.onAction(id, title, "delete")} onError={actions.onError}>{renderRow}</SessionMenu> : renderRow();
}
