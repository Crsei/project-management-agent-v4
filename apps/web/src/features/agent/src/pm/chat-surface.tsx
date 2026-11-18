import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useBlocker, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAui, useAuiState, ThreadListPrimitive, type AssistantRuntime } from "@assistant-ui/react";
import { ArchiveIcon, ArrowLeftIcon, ChartNoAxesCombinedIcon, ChevronDownIcon, CircleAlertIcon, FileTextIcon, FolderOpenIcon, FolderPlusIcon, KeyboardIcon, ListFilterIcon, Loader2Icon, Maximize2Icon, MessageSquareIcon, MoreHorizontalIcon, PanelBottomIcon, PencilIcon, PanelLeftIcon, PanelRightIcon, PinIcon, SearchIcon, SettingsIcon, SquarePenIcon, XIcon, ZapIcon } from "lucide-react";
import { DovspaceBrandLink } from "@/components/dovspace-brand";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getProviderInstanceDisplayName, getProviderModelShortName } from "@agent-workspace/client-runtime/providers";
import type { ProviderInstance } from "@agent-workspace/contracts/provider";
import { ProviderGlyph } from "@agent/src/settings/provider-card";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { Thread } from "@agent/components/assistant-ui/elements/thread.aui";
import { useChatSettings } from "@agent/hooks/use-chat-settings";
import { useIsMobile } from "@agent/hooks/use-mobile";
import { ChatContinuity } from "../chat/continuity";
import { providerSendIssue } from "../chat/provider-send-issue";
import { UsageNavigationLink } from "../usage/navigation";
import { initializeAgentThread, refreshThreadList } from "../chat/remote-adapter";
import { PmToolCallsProvider } from "../chat/pm-tool-calls";
import { ChatActionsProvider, type ChatInspectorRequest } from "../chat/chat-actions";
import { ThreadHistoryNavigationProvider } from "../chat/history-navigation";
import { MessageContextDraftProvider } from "../chat/message-context";
import { MessageContextSelector } from "../chat/message-context-selector";
import { contextChipTheme } from "../chat/context-chip-parts";
import { copySelectedMessageContexts } from "../chat/message-context-clipboard";
import { PmRightPanel } from "./right-panel";
import { ThreadDetailsPanel } from "./thread-details-panel";
import { threadActivityPresentation, type ThreadActivity } from "./thread-activity";
import { TerminalDrawer, TERMINAL_DRAWER_MIN_HEIGHT } from "./terminal-drawer";
import { ProductSwitcher } from "./product-switcher";
import { UserMenu } from "./user-menu";
import { useChatDrafts } from "./drafts";
import { SessionMenu } from "./session-menu";
import { PmIssueWorkspaceProvider } from "./pm-issue-workspace";
import { PmIssuePickerHost } from "./pm-issue-picker-host";
import { PmComposerReferenceAction, PmComposerReferences } from "./pm-composer-references";
import { PmProjectFlowAction } from "./pm-project-flow";
import { createSidebarVisitCoordinator } from "./sidebar-visit";
import { workspaceClient } from "../network";
import { useAgentText, type AgentText } from "../i18n";
import type { AgentWorkspace, ExecutionSelection, RemoteThread } from "@agent-workspace/contracts/chat";
import type { PmToolTarget } from "@agent-workspace/contracts/pm-tools";
import SessionSettingsDialog from "../settings/session-settings-dialog";
import { ShortcutCatalog } from "../settings/input-preferences";
import { useChatAppearance, useChatBrowserPreferences } from "../settings/browser-preferences";
import { acceptRemoteThread, availableProviderModel, bindDraftExecution, CHAT_ONLY_SELECTION, canSendThread, refreshAgentWorkspaces, refreshIdentity, refreshProviders, threadExecutionSelection, usePmChatState, workspaceExecutionSelection } from "./state";
import { OpenFolderDialog, ExecutionSelectionDialog, updateAgentWorkspace, useExecutionEnvironment } from "./execution-workspace";
import { ExecutionTerminals, useExecutionTerminals, type TerminalDock } from "./execution-terminals";
import { consumedRunBoardTerminalParams, initializedDraftChatParams, newRunBoardSelection, resolvedRunBoardChatParams, runBoardChatHref, runBoardChatIntent, runBoardNavigationKey, runBoardRouteReplacementPending, safeRunBoardReturn, type RunBoardRouteReplacement } from "./run-board-navigation";
import { verifiedSessionTerminalTarget } from "./execution-terminal-selection";
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
  provider: (thread: RemoteThread) => ProviderInstance | undefined;
  providerName: (thread: RemoteThread) => string;
  modelName: (thread: RemoteThread) => string;
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
function sessionTime(value: string | undefined, t: AgentText) {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return t("时间未知", "Unknown time");
  // Sidebar timestamps stay compact, like t3code's "4m" / "2h" labels.
  const elapsed = Math.abs(time - Date.now());
  if (elapsed < 60_000) return t("刚刚", "now");
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return t(`${minutes}分钟`, `${minutes}m`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(`${hours}小时`, `${hours}h`);
  const days = Math.floor(hours / 24);
  if (days < 30) return t(`${days}天`, `${days}d`);
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

export function PmChatSurface({ runtime, entry, runBoard, onExpand, onClose, onThreadChange }: { runtime: AssistantRuntime; entry?: URLSearchParams; runBoard?: ReactNode; onExpand?: (params: URLSearchParams) => void; onClose?: () => void; onThreadChange?: (id: string | null) => void }) {
  const boardMode = runBoard !== undefined;
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
  const navigationKey = runBoardNavigationKey(params);
  const navigationIntent = runBoardChatIntent(params);
  const [navigationResult, setNavigationResult] = useState<{ key: string; ready: boolean; error?: string }>({ key: "", ready: false });
  const handledNavigation = useRef<string | undefined>(undefined);
  const navigationFlight = useRef(false);
  const pendingRouteReplacement = useRef<RunBoardRouteReplacement | undefined>(undefined);
  const activeNavigation = useRef<{ controller: AbortController; pathname: string; keys: readonly string[] } | undefined>(undefined);
  const latestRoute = useRef({ key: navigationKey, pathname: location.pathname });
  latestRoute.current = { key: navigationKey, pathname: location.pathname };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeNavigation.current?.controller.abort();
    };
  }, []);
  const popRouteApproved = useRef(false);
  const terminalIntentSeen = useRef<string | undefined>(undefined);
  const [boardTerminalError, setBoardTerminalError] = useState<string>();
  const [openingBoardTerminal, setOpeningBoardTerminal] = useState(false);
  const [entryObject, setEntryObject] = useState(() => ({ task: params.get("task"), entity: params.get("entity") }));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [embeddedAutomationsView, setEmbeddedAutomationsView] = useState(() => params.get("view") === "automations");
  const automationLeaveGuard = useRef<(() => boolean) | null>(null);
  const setAutomationLeaveGuard = useCallback((guard: (() => boolean) | null) => { automationLeaveGuard.current = guard; }, []);
  const [search, setSearch] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState<string>();
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
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
    if (boardMode) return 320;
    try {
      const stored = Number(localStorage.getItem("pm-v3:terminal-height"));
      if (Number.isFinite(stored) && stored > 0) return Math.max(TERMINAL_DRAWER_MIN_HEIGHT, Math.min(720, window.innerHeight * 0.7, stored));
    } catch { /* A blocked storage keeps the in-memory height. */ }
    return 320;
  });
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelMaximized, setRightPanelMaximized] = useState(false);
  const [inspectorRequest, setInspectorRequest] = useState<ChatInspectorRequest>();
  const openChatInspector = useCallback((request: ChatInspectorRequest) => {
    if (request.threadId !== currentRemote.current) throw new Error(t("会话已切换，请在当前会话中重新打开文件。", "The session changed; reopen the file from the current session."));
    setInspectorRequest(request);
    setRightPanelOpen(true);
  }, [t]);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  const [openFolder, setOpenFolder] = useState(false);
  const [executionDialog, setExecutionDialog] = useState<{ create: boolean; initial: ExecutionSelection }>();
  const [workspaceRename, setWorkspaceRename] = useState<{ workspace: AgentWorkspace; name: string }>();
  const [sessionAction, setSessionAction] = useState<{ id: string; title: string; kind: "rename" | "delete" }>();
  const [archiveTarget, setArchiveTarget] = useState<{ id: string; thread: RemoteThread }>();
  const [sessionTitle, setSessionTitle] = useState("");
  const localId = useAuiState((s) => s.threads.mainThreadId);
  const remoteId = useAuiState((s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.remoteId);
  currentRemote.current = remoteId;
  const creationIds = useRef(new Map<string, string>());
  const threadsLoading = useAuiState((s) => s.threads.isLoading);
  useEffect(() => { if (!boardMode && !threadsLoading && remoteId) onThreadChange?.(remoteId); }, [boardMode, onThreadChange, remoteId, threadsLoading]);
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
  const automationsView = !boardMode && (entry ? embeddedAutomationsView : /^\/agent\/automations(?:\/|$)/.test(location.pathname) || params.get("view") === "automations");
  // PM hand-offs are reference/business targets, never folder selections.
  const displayScope = useMemo(() => requestedPmTarget(params), [params]);
  const currentThread = remoteId ? state.threads.get(remoteId) : undefined;
  const parentThreadId = typeof currentThread?.custom?.parentThreadId === "string" ? currentThread.custom.parentThreadId : undefined;
  const parentThread = parentThreadId ? state.threads.get(parentThreadId) : undefined;
  const childThreads = remoteId ? [...state.threads.values()].filter(thread => thread.custom?.parentThreadId === remoteId).map(thread => ({ id: thread.remoteId, title: thread.title ?? t("未命名会话", "Untitled session") })) : [];
  const currentExecutionSelection = threadExecutionSelection(localId, remoteId);
  const currentWorkspace = state.workspaces.find(item => item.id === currentExecutionSelection?.agentWorkspaceId);
  const selectedWorkspace = state.workspaces.find(item => item.id === selectedWorkspaceId) ?? currentWorkspace;
  const execution = useExecutionEnvironment(boardMode ? undefined : remoteId, currentThread?.revision);
  const environment = execution.environment;
  const executionFrozen = environment?.frozen ?? currentThread?.executionEnvironment?.frozen ?? false;
  const showTerminal = useCallback(() => setTerminalOpen(true), []);
  const terminals = useExecutionTerminals({ workspace: selectedWorkspace, threadId: remoteId, environment: execution.error ? undefined : environment, onShow: showTerminal, enabled: !boardMode });
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
  const runReturn = safeRunBoardReturn(params.get("runReturn"));
  const boardReturn = safeRunBoardReturn(`${location.pathname}${location.search}`) ?? "/agent/runs";
  const navigationBlocked = !boardMode && !entry && !automationsView && (navigationIntent.kind === "invalid" || navigationIntent.kind !== "none"
    && (navigationResult.key !== navigationKey || !navigationResult.ready || navigationIntent.kind === "new" || navigationIntent.threadId !== remoteId));
  const { protect, storageError } = useChatDrafts(runtime, !boardMode);
  const initialize = useCallback(async () => (await aui.threads.item({ id: localId }).initialize()).remoteId, [aui, localId]);
  const { settings, setSettings, ready: settingsReady, settingsLoaded, loading: settingsLoading, saving: settingsSaving, error: settingsError, retry } = useChatSettings(remoteId, initialize, localId);
  const currentProvider = state.providers.find(provider => provider.instanceId === settings.providerInstanceId);
  const providerIssueCode = providerSendIssue(currentProvider);
  const providerIssue = providerIssueCode === "missing"
    ? t("未找到当前 Provider 配置。", "The selected Provider configuration was not found.")
    : providerIssueCode === "disabled"
      ? t("当前 Provider 已停用。", "The selected Provider is disabled.")
      : providerIssueCode === "not-installed"
        ? t("当前 Provider 未检测到可执行文件。", "The selected Provider has no detected executable.")
        : undefined;

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
    if (boardMode) return;
    try { localStorage.setItem("pm-v3:terminal-height", String(Math.round(terminalHeight))); } catch { /* The drawer still works without persistence. */ }
  }, [boardMode, terminalHeight]);
  useEffect(() => {
    if (boardMode) return;
    const onResize = () => setTerminalHeight((value) => Math.max(TERMINAL_DRAWER_MIN_HEIGHT, Math.min(720, window.innerHeight * 0.7, value)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [boardMode]);
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
    if (boardMode) return;
    if (!remoteId) { visitedThread.current = undefined; setVisiting(false); return; }
    const thread = state.threads.get(remoteId);
    if (!thread || visitedThread.current === remoteId) return;
    visitedThread.current = remoteId;
    setVisiting(true);
    void visitThread(remoteId).then((saved) => { if (currentRemote.current === remoteId) acceptRemoteThread(saved); }).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
      void refreshThreadList().catch(() => {});
    }).finally(() => { if (currentRemote.current === remoteId) setVisiting(false); });
  }, [boardMode, remoteId, state.threads]);
  useEffect(() => { if (automationsView) void refreshIdentity(); }, [automationsView]);
  useEffect(() => {
    if (boardMode || entry || params.get("view") !== "automations") return;
    const next = new URLSearchParams(params);
    next.delete("view");
    next.delete("thread");
    navigate({ pathname: "/agent/automations", search: next.toString() }, { replace: true });
  }, [boardMode, entry, params, navigate]);

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
    if (boardMode) { navigate("/agent/automations"); return; }
    const next = new URLSearchParams(params);
    next.delete("view");
    if (remoteId) next.set("thread", remoteId); else next.delete("thread");
    if (open) {
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
  const clearEntryObject = (exitView = false, selectedThreadId?: string | null) => {
    setEntryObject({ task: null, entity: null });
    if (entry) {
      if (exitView) setEmbeddedAutomationsView(false);
    } else if (params.has("task") || params.has("entity") || exitView || selectedThreadId !== undefined) {
      const next = new URLSearchParams(params);
      next.delete("task"); next.delete("entity");
      if (selectedThreadId !== undefined) {
        for (const key of ["newSession", "agentWorkspaceId", "chatOnly", "openTerminal"]) next.delete(key);
        if (selectedThreadId) next.set("thread", selectedThreadId); else next.delete("thread");
        const key = runBoardNavigationKey(next);
        pendingRouteReplacement.current = { fromKeys: [navigationKey], toKey: key };
        handledNavigation.current = key;
        setNavigationResult({ key, ready: true });
        setBoardTerminalError(undefined);
        setTerminalOpen(false);
      }
      if (exitView) {
        next.delete("view");
        navigate({ pathname: "/agent/workspace", search: next.toString() }, { replace: true });
      } else setParams(next, { replace: true });
    }
  };
  const createSession = (selection: ExecutionSelection) => {
    if (pending || !canLeaveAutomation() || !protect()) return;
    if (boardMode) {
      navigate(runBoardChatHref({ agentWorkspaceId: selection.agentWorkspaceId, returnTo: boardReturn }));
      setSidebarOpen(false);
      return;
    }
    if (!entry && !automationsView && navigationIntent.kind === "new" && navigationIntent.agentWorkspaceId === undefined) {
      const next = new URLSearchParams(params);
      next.delete("agentWorkspaceId"); next.delete("chatOnly");
      if (selection.agentWorkspaceId) next.set("agentWorkspaceId", selection.agentWorkspaceId); else next.set("chatOnly", "1");
      pendingRouteReplacement.current = { fromKeys: [navigationKey], toKey: runBoardNavigationKey(next) };
      handledNavigation.current = undefined;
      popRouteApproved.current = true;
      setNavigationResult({ key: runBoardNavigationKey(next), ready: false });
      setExecutionDialog(undefined);
      setParams(next, { replace: true });
      return;
    }
    void act(async () => {
      const key = JSON.stringify(selection);
      const id = creationIds.current.get(key) ?? crypto.randomUUID();
      creationIds.current.set(key, id);
      bindDraftExecution(id, selection);
      await initializeAgentThread(id);
      await refreshThreadList();
      await runtime.threads.switchToThread(id, { unarchive: false });
      clearEntryObject(automationsView, id);
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
    if (boardMode) {
      const target = runtime.threads.getItemById(id).getState().remoteId;
      if (!target) { setActionError(t("目标会话尚未登记，请重新读取会话列表。", "The target Session is not registered yet. Reload the Session list.")); return; }
      navigate(runBoardChatHref({ threadId: target, returnTo: boardReturn }));
      setSidebarOpen(false);
      return;
    }
    if (id === localId) {
      if (navigationBlocked) clearEntryObject(automationsView, remoteId ?? null);
      else if (automationsView) setAutomationView(false);
      const thread = remoteId && state.threads.get(remoteId);
      if (thread) void act(async () => {
        const saved = await visitThread(thread.remoteId);
        acceptRemoteThread(saved);
      });
      setSidebarOpen(false); return;
    }
    void act(async () => {
      const target = runtime.threads.getItemById(id).getState().remoteId;
      if (!target) throw new Error(t("目标会话尚未登记，请重新读取会话列表。", "The target Session is not registered yet. Reload the Session list."));
      await runtime.threads.switchToThread(target, { unarchive: false });
      clearEntryObject(automationsView, target);
      setFreshThreadId(undefined); setSidebarOpen(false);
    });
  };
  const navigateChatSession = async (id: string) => {
    if (pending || visiting) throw new Error(t("当前操作尚未结束，请稍后再打开会话。", "Another operation is in progress; open the session again when it finishes."));
    if (!canLeaveAutomation() || !protect()) throw new Error(t("已取消切换会话，草稿保持不变。", "Session navigation was cancelled; the draft is unchanged."));
    if (boardMode) {
      navigate(runBoardChatHref({ threadId: id, returnTo: boardReturn }));
      setSidebarOpen(false);
      return;
    }
    const origin = localId;
    setPending(true);
    setActionError(undefined);
    try {
      const { thread } = await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(id)}`);
      acceptRemoteThread(thread);
      await refreshThreadList();
      if (aui.threads.item("main").getState().id !== origin) throw new Error(t("读取期间会话已切换，请重新打开目标会话。", "The session changed while loading; reopen the target session."));
      await runtime.threads.switchToThread(thread.remoteId, { unarchive: false });
      clearEntryObject(automationsView, thread.remoteId);
      setFreshThreadId(undefined);
      setSidebarOpen(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally { setPending(false); }
  };

  const openVerifiedSessionTerminal = async (dock: TerminalDock) => {
    const origin = remoteId;
    setTerminalOpen(false);
    try {
      const target = !navigationBlocked && !execution.loading && !state.loading && remoteId && !execution.error && !state.error
        ? verifiedSessionTerminalTarget(remoteId, currentExecutionSelection, environment, currentWorkspace, params.get("agentWorkspaceId") ?? undefined) : null;
      if (!target) throw new Error(execution.error ?? state.error ?? t("原会话的执行文件夹尚未核验或不可用。请核对会话详情后重试；不会打开旧目录的终端。", "The original Session execution folder is unverified or unavailable. Check Session details and retry; no terminal from an old folder will be opened."));
      setOpeningBoardTerminal(true); setBoardTerminalError(undefined); setTerminalDock(dock);
      if (dock === "right") setRightPanelOpen(true);
      await terminals.openSession(target);
    } catch (cause) {
      if (currentRemote.current === origin) setBoardTerminalError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally { setOpeningBoardTerminal(false); }
  };

  // The runtime's initialThreadId is mount-only. Later deep links must pass the
  // same draft guard as the sidebar instead of being overwritten by URL syncing.
  useEffect(() => {
    if (boardMode) return;
    const active = activeNavigation.current;
    if (active && (active.pathname !== location.pathname || !active.keys.includes(navigationKey))) {
      active.controller.abort(new Error(t("导航目标已变化；请重新打开目标会话。", "The navigation target changed. Reopen the intended Session.")));
    }
    // setParams transitions asynchronously. Consume both old request URLs until
    // the resolved URL commits, even after pending has already been cleared.
    if (runBoardRouteReplacementPending(pendingRouteReplacement.current, navigationKey)) return;
    pendingRouteReplacement.current = undefined;
    if (handledNavigation.current === navigationKey && navigationResult.key === navigationKey && (navigationResult.ready || navigationResult.error !== undefined)) { popRouteApproved.current = false; return; }
    if (entry || automationsView || threadsLoading || pending || navigationFlight.current) return;
    if (navigationIntent.kind === "new" && state.loading) return;
    const intent = navigationIntent;
    if (intent.kind === "none") {
      handledNavigation.current = navigationKey;
      setNavigationResult({ key: navigationKey, ready: true });
      return;
    }
    if (intent.kind === "invalid" || intent.kind === "new" && state.error) {
      handledNavigation.current = navigationKey;
      setNavigationResult({ key: navigationKey, ready: false, error: intent.kind === "invalid"
        ? t("运行面板的会话目标无效。请返回面板重新选择，不会打开其他会话。", "The run board Session target is invalid. Return to the board and select it again; no other Session will be opened.")
        : state.error });
      return;
    }
    if (intent.kind === "new" && intent.agentWorkspaceId === undefined) {
      handledNavigation.current = navigationKey;
      setNavigationResult({ key: navigationKey, ready: false, error: t("请选择新会话的执行文件夹，或明确选择仅对话。", "Choose the new Session execution folder, or explicitly choose chat only.") });
      setExecutionDialog({ create: true, initial: CHAT_ONLY_SELECTION });
      return;
    }
    const selection = intent.kind === "new" ? newRunBoardSelection(intent, state.workspaces) : null;
    if (intent.kind === "new" && !selection) {
      handledNavigation.current = navigationKey;
      setNavigationResult({ key: navigationKey, ready: false, error: t("指定的文件夹未登记、已关闭或不可用。请重新读取文件夹或返回运行面板选择；不会改用其他目录或仅对话。", "The requested folder is unregistered, closed, or unavailable. Reload folders or return to the run board to choose again; no other folder or chat-only fallback is used.") });
      return;
    }
    if (intent.kind === "new" || intent.threadId !== remoteId) {
      const allowed = popRouteApproved.current || protectNavigation();
      popRouteApproved.current = false;
      if (!allowed) {
        const next = new URLSearchParams(params);
        for (const key of ["newSession", "agentWorkspaceId", "chatOnly", "openTerminal"]) next.delete(key);
        if (remoteId) next.set("thread", remoteId); else next.delete("thread");
        const key = runBoardNavigationKey(next);
        pendingRouteReplacement.current = { fromKeys: [navigationKey], toKey: key };
        handledNavigation.current = key;
        setNavigationResult({ key, ready: true });
        setParams(next, { replace: true });
        setActionError(t("已取消切换会话，草稿保持不变。", "Session navigation was cancelled; the draft is unchanged."));
        return;
      }
    }
    navigationFlight.current = true;
    setPending(true); setTerminalOpen(false); setBoardTerminalError(undefined);
    setNavigationResult({ key: navigationKey, ready: false });
    const originKey = navigationKey;
    const pathname = location.pathname;
    const next = new URLSearchParams(params);
    const id = intent.threadId ?? crypto.randomUUID();
    if (intent.kind === "new") {
      // Pin the existing creation request in the URL before initialization.
      // A refresh after a lost response reuses this id, never creates a second Session.
      next.set("thread", id);
      setParams(next, { replace: true });
    }
    const pinnedKey = runBoardNavigationKey(next);
    const controller = new AbortController();
    activeNavigation.current = { controller, pathname, keys: [originKey, pinnedKey] };
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (!mounted.current || latestRoute.current.pathname !== pathname || ![originKey, pinnedKey].includes(latestRoute.current.key))
        throw new Error(t("导航目标已变化；请在运行面板重新打开目标会话。", "The navigation target changed. Reopen the intended Session from the run board."));
    };
    const switchThread = async () => {
      assertCurrent();
      const aborted = Promise.withResolvers<never>();
      const supersede = () => {
        aborted.reject(controller.signal.reason);
        try {
          const committedId = runtime.threads.mainItem.getState().remoteId;
          if (committedId && committedId !== id)
            void runtime.threads.switchToThread(committedId, { unarchive: false }).catch(() => {});
        } catch { /* A disposed runtime cannot acknowledge the cancelled route. */ }
      };
      controller.signal.addEventListener("abort", supersede, { once: true });
      try {
        // Release our waiter immediately; reselection separately prevents a late SDK commit.
        await Promise.race([runtime.threads.switchToThread(id, { unarchive: false }), aborted.promise]);
        assertCurrent();
        if (runtime.threads.mainItem.getState().remoteId !== id)
          throw new Error(t("目标会话尚未成为当前会话，请重新打开。", "The requested Session did not become current. Reopen it."));
      } finally { controller.signal.removeEventListener("abort", supersede); }
    };
    void (async () => {
      try {
        let thread: RemoteThread;
        if (intent.kind === "new") {
          bindDraftExecution(id, selection!);
          await initializeAgentThread(id);
          assertCurrent();
          await refreshThreadList();
          assertCurrent();
          await switchThread();
          thread = (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(id)}`, { signal: controller.signal })).thread;
          assertCurrent();
          setFreshThreadId(id);
        } else {
          thread = (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(id)}`, { signal: controller.signal })).thread;
          assertCurrent();
          if (intent.agentWorkspaceId && thread.executionSelection?.agentWorkspaceId !== intent.agentWorkspaceId)
            throw new Error(t("原会话与指定文件夹不匹配。未切换到其他文件夹。", "The original Session does not match the requested folder. No other folder was selected."));
          acceptRemoteThread(thread);
          if (currentRemote.current !== id) {
            await refreshThreadList();
            assertCurrent();
          }
          await switchThread();
          setFreshThreadId(undefined);
        }
        assertCurrent();
        acceptRemoteThread(thread);
        setSelectedWorkspaceId(thread.executionSelection?.agentWorkspaceId ?? undefined);
        setEntryObject({ task: params.get("task"), entity: params.get("entity") });
        setSidebarOpen(false);
        const resolved = resolvedRunBoardChatParams(next, id);
        const key = runBoardNavigationKey(resolved);
        pendingRouteReplacement.current = { fromKeys: [originKey, pinnedKey], toKey: key };
        handledNavigation.current = key;
        setNavigationResult({ key, ready: true });
        if (resolved.toString() !== params.toString()) setParams(resolved, { replace: true });
      } catch (cause) {
        if (!controller.signal.aborted && mounted.current && latestRoute.current.pathname === pathname && [originKey, pinnedKey].includes(latestRoute.current.key)) {
          pendingRouteReplacement.current = { fromKeys: [originKey, pinnedKey], toKey: pinnedKey };
          handledNavigation.current = pinnedKey;
          setNavigationResult({ key: pinnedKey, ready: false, error: cause instanceof Error ? cause.message : String(cause) });
        }
      } finally {
        if (activeNavigation.current?.controller === controller) activeNavigation.current = undefined;
        navigationFlight.current = false;
        if (mounted.current) setPending(false);
      }
    })();
  });
  useEffect(() => {
    if (boardMode || entry || automationsView || threadsLoading || pending || navigationFlight.current || handledNavigation.current !== navigationKey || navigationResult.key !== navigationKey || !navigationResult.ready || params.has("newSession")) return;
    const next = initializedDraftChatParams(params, remoteId, draftOrigin.current.id === localId && draftOrigin.current.wasNew);
    if (!next) return;
    const main = aui.threads.item("main").getState();
    if (main.id !== localId || main.remoteId !== remoteId || main.status === "new") return;
    const key = runBoardNavigationKey(next);
    pendingRouteReplacement.current = { fromKeys: [navigationKey], toKey: key };
    handledNavigation.current = key;
    setNavigationResult({ key, ready: true });
    setParams(next, { replace: true });
  });
  useEffect(() => {
    if (boardMode || entry || automationsView || params.get("openTerminal") !== "1" || navigationBlocked || pending || execution.loading || state.loading) return;
    const intentKey = `${location.key}:${params}`;
    if (terminalIntentSeen.current === intentKey) return;
    terminalIntentSeen.current = intentKey;
    // Consume before any PTY side effect. Back/refresh cannot replay this intent.
    setParams(consumedRunBoardTerminalParams(params), { replace: true });
    void openVerifiedSessionTerminal("bottom").catch(() => {});
  });
  const openAutomationThread = (threadId: string) => {
    if (!canLeaveAutomation() || !protect() || !displayScope) return;
    void act(async () => {
      const { thread } = await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(threadId)}`);
      acceptRemoteThread(thread);
      await refreshThreadList();
      await runtime.threads.switchToThread(thread.remoteId, { unarchive: false });
      setFreshThreadId(undefined);
      clearEntryObject(true, thread.remoteId);
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
    await runtime.threads.switchToThread(id, { unarchive: false });
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
      else { await item.delete(); if (sessionAction.id === localId) { setFreshThreadId(undefined); clearEntryObject(false, null); onThreadChange?.(null); } }
      await refreshThreadList();
      setSessionAction(undefined);
    });
  };
  const openThreadByRemoteId = (id: string) => {
    const local = threadItems.find(item => item.remoteId === id)?.id;
    if (!local) { setActionError(t("父会话尚未登记，请重新读取会话列表。", "The parent Session is not registered yet; reload the Session list.")); return; }
    switchSession(local);
  };

  const archiveThread = (id: string, thread: RemoteThread) => {
    void act(async () => {
      try {
        const current = (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}`)).thread;
        const saved = current.status === "archived" ? current : (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}`, { method: "PUT", body: JSON.stringify({ status: "archived", lifecycleRevision: current.lifecycleRevision }) })).thread;
        acceptRemoteThread(saved);
        await refreshThreadList();
        if (id === localId) { await runtime.threads.switchToNewThread(); setFreshThreadId(undefined); clearEntryObject(false, null); onThreadChange?.(null); }
      } catch (error) { await refreshThreadList().catch(() => {}); throw error; }
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
          clearEntryObject(false, null);
          onThreadChange?.(null);
        }
      } catch (error) {
        await refreshThreadList().catch(() => {});
        throw error;
      }
    });
  };
  const threadScopeName = (thread: RemoteThread) => state.workspaces.find(item => item.id === thread.executionSelection?.agentWorkspaceId)?.name ?? t("仅对话", "Chat only");
  const threadProvider = (thread: RemoteThread) => state.providers.find(provider => provider.instanceId === thread.settings.providerInstanceId);
  const threadProviderName = (thread: RemoteThread) => {
    const provider = threadProvider(thread);
    return provider ? getProviderInstanceDisplayName(provider) : thread.settings.providerInstanceId || t("未选择 Provider", "No provider selected");
  };
  const threadModelName = (thread: RemoteThread) => {
    const provider = threadProvider(thread);
    const model = provider?.models.find(item => item.id === thread.settings.model);
    return model && provider ? getProviderModelShortName(provider.driver, model) ?? model.label : thread.settings.model;
  };
  const toggleGroup = (key: string) => setCollapsedGroups((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const filterWorkspace = state.workspaces.find(item => item.id === workspaceFilter);
  const filterLabel = filterWorkspace ? t(`筛选：${filterWorkspace.name}`, `Filter: ${filterWorkspace.name}`) : t("筛选文件夹", "Filter folders");
  const createSessionInScope = () => {
    const target = workspaceFilter ? filterWorkspace : selectedWorkspace && !selectedWorkspace.archivedAt ? selectedWorkspace : undefined;
    const available = target && !target.archivedAt && target.status === "available" ? target : undefined;
    createSession(available ? workspaceExecutionSelection(available) : CHAT_ONLY_SELECTION);
  };
  const renderSessions = () => {
    const query = search.trim().toLocaleLowerCase();
    const indices = threadIds.map((id, index) => {
      const item = threadItems.find(candidate => candidate.id === id);
      return { id, index, item, thread: item?.remoteId ? state.threads.get(item.remoteId) : undefined };
    }).filter(({ item, thread }) => item?.remoteId && (!workspaceFilter || thread?.executionSelection?.agentWorkspaceId === workspaceFilter) && (!query || [item.title, thread?.remoteId, thread && threadScopeName(thread), thread && state.workspaces.find(workspace => workspace.id === thread.executionSelection?.agentWorkspaceId)?.path, thread?.executionEnvironment?.sourcePath, thread?.settings.model, thread && threadProviderName(thread)].some(value => value?.toLocaleLowerCase().includes(query))));
    const groupFor = (workspaceId: string | null) => indices.filter(({ thread }) => (thread?.executionSelection?.agentWorkspaceId ?? null) === workspaceId);
    const sectionRows = (workspaceId: string | null, section: "pinned" | "active" | "snoozed" | "settled", slim: boolean) => groupFor(workspaceId).filter(({ thread }) => (thread?.sidebar.section ?? "active") === section).sort((a, b) => {
      if (section === "pinned") return (b.thread?.sidebar.pinnedAt ?? "").localeCompare(a.thread?.sidebar.pinnedAt ?? "");
      if (section === "snoozed") return (a.thread?.sidebar.snoozedUntil ?? "").localeCompare(b.thread?.sidebar.snoozedUntil ?? "");
      return ((preferences.threadSortOrder === "created_at" ? b.thread?.createdAt : b.thread?.updatedAt) ?? "").localeCompare((preferences.threadSortOrder === "created_at" ? a.thread?.createdAt : a.thread?.updatedAt) ?? "");
    }).map(({ id, index }) => <ThreadListPrimitive.ItemByIndex key={id} index={index} components={{ ThreadListItem: slim ? SessionSlimRow : SessionRow }} />);
    const rows = (workspaceId: string | null) => {
      const pinned = sectionRows(workspaceId, "pinned", false);
      const active = sectionRows(workspaceId, "active", false);
      const snoozed = sectionRows(workspaceId, "snoozed", true);
      const settled = sectionRows(workspaceId, "settled", true);
      return <>{pinned.length > 0 && <div className="pm-session-pinned-label"><PinIcon aria-hidden="true" /><span>{t("置顶", "Pinned")}</span><span className="pm-session-section-line" aria-hidden="true" /></div>}{pinned}{active}{snoozed.length > 0 && <SessionSection label={t("稍后提醒", "Snoozed")} count={snoozed.length} tone="info" forceOpen={!!query}>{snoozed}</SessionSection>}{settled.length > 0 && <SessionSection label={t("已归置", "Settled")} count={settled.length} forceOpen={!!query}>{settled}</SessionSection>}</>;
    };
    const workspaceMenu = (workspace: AgentWorkspace, archived: boolean) => <DropdownMenu>
      <DropdownMenuTrigger render={<button type="button" className="pm-agent-icon" aria-label={t(`${workspace.name} 的文件夹操作`, `Folder actions for ${workspace.name}`)} title={t("文件夹操作", "Folder actions")} />}><MoreHorizontalIcon /></DropdownMenuTrigger>
      <DropdownMenuContent className="pm-session-menu-popup" side="bottom" align="end" sideOffset={4}>
        {!archived && <DropdownMenuItem className="pm-session-menu-item" disabled={pending || workspace.status !== "available"} onSelect={() => createSession(workspaceExecutionSelection(workspace))}><SquarePenIcon />{t("新建会话", "New session")}</DropdownMenuItem>}
        {!archived && <DropdownMenuItem className="pm-session-menu-item" disabled={pending} onSelect={() => manageWorkspace(workspace, "rename")}><SettingsIcon />{t("重命名文件夹", "Rename folder")}</DropdownMenuItem>}
        {!archived && <DropdownMenuSeparator className="pm-agent-menu-separator" />}
        <DropdownMenuItem className="pm-session-menu-item" disabled={pending} onSelect={() => manageWorkspace(workspace, archived ? "reopen" : "close")}><FolderOpenIcon />{archived ? t("重新打开（保留会话）", "Reopen (sessions kept)") : t("关闭文件夹", "Close folder")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>;
    const workspaceGroup = (workspace: AgentWorkspace, archived = false) => {
      const key = `${archived ? "archived:" : ""}${workspace.id}`;
      const collapsed = !query && collapsedGroups.has(key);
      const count = groupFor(workspace.id).length;
      return <section className="pm-session-group" key={key} data-collapsed={collapsed || undefined}>
        <header className="pm-session-group-header">
          <button type="button" className="pm-session-group-toggle" aria-expanded={!collapsed} title={workspace.path} onClick={() => { if (!archived) setSelectedWorkspaceId(workspace.id); toggleGroup(key); }}>
            <ChevronDownIcon aria-hidden="true" />
            <FolderOpenIcon aria-hidden="true" />
            <span className="pm-session-group-name">{workspace.name}</span>
            {count > 0 && <span className="pm-session-group-count">{count}</span>}
            {workspace.status !== "available" && <span className="pm-session-group-warning" title={workspace.reason ?? t("目录不可用", "Folder unavailable")}><CircleAlertIcon aria-hidden="true" /></span>}
          </button>
          <div className="pm-session-group-actions">
            {!archived && <button type="button" className="pm-agent-icon" disabled={pending || workspace.status !== "available"} aria-label={t("在文件夹中新建会话", "New session in folder")} title={t("在文件夹中新建会话", "New session in folder")} onClick={() => createSession(workspaceExecutionSelection(workspace))}><SquarePenIcon /></button>}
            {workspaceMenu(workspace, archived)}
          </div>
        </header>
        {!collapsed && <>{workspace.status !== "available" && <p role="status" className="pm-session-group-error">{workspace.reason ?? t("目录不可用", "Folder unavailable")}</p>}{rows(workspace.id)}</>}
      </section>;
    };
    const chatOnlyGroup = () => {
      const key = "chat-only";
      const collapsed = !query && collapsedGroups.has(key);
      const count = groupFor(null).length;
      return <section className="pm-session-group" key={key} data-collapsed={collapsed || undefined}>
        <header className="pm-session-group-header">
          <button type="button" className="pm-session-group-toggle" aria-expanded={!collapsed} onClick={() => toggleGroup(key)}>
            <ChevronDownIcon aria-hidden="true" />
            <MessageSquareIcon aria-hidden="true" />
            <span className="pm-session-group-name">{t("仅对话", "Chat only")}</span>
            {count > 0 && <span className="pm-session-group-count">{count}</span>}
          </button>
          <div className="pm-session-group-actions">
            <button type="button" className="pm-agent-icon" disabled={pending} aria-label={t("新建仅对话会话", "New chat-only session")} title={t("新建仅对话会话", "New chat-only session")} onClick={() => createSession(CHAT_ONLY_SELECTION)}><SquarePenIcon /></button>
          </div>
        </header>
        {!collapsed && rows(null)}
      </section>;
    };
    const archived = state.workspaces.filter(item => item.archivedAt && (!workspaceFilter || item.id === workspaceFilter) && (!query || groupFor(item.id).length > 0));
    return <div className="pm-agent-sessions">
      {state.workspaces.filter(item => !item.archivedAt && (!workspaceFilter || item.id === workspaceFilter) && (!query || groupFor(item.id).length > 0)).map(workspace => workspaceGroup(workspace))}
      {!workspaceFilter && (!query || groupFor(null).length > 0) && chatOnlyGroup()}
      {archived.length > 0 && <SessionSection label={t("已关闭的文件夹", "Closed folders")} count={archived.length} className="pm-session-archived">{archived.map(workspace => workspaceGroup(workspace, true))}</SessionSection>}
      {query && indices.length === 0 && <p className="pm-agent-empty-group">{t("没有匹配的会话。", "No matching sessions.")}</p>}
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
  const toggleTerminalDrawer = () => {
    if (terminalOpen && terminalDock === "bottom") { setTerminalOpen(false); return; }
    if (navigationBlocked || pending || openingBoardTerminal || execution.loading || state.loading) return;
    if (runReturn) { void openVerifiedSessionTerminal("bottom").catch(() => {}); return; }
    setTerminalDock("bottom"); setTerminalOpen(true);
  };
  const dockTerminal = (dock: TerminalDock) => {
    if (runReturn) { void openVerifiedSessionTerminal(dock).catch(() => {}); return; }
    setTerminalDock(dock); setTerminalOpen(true); if (dock === "right") setRightPanelOpen(true);
  };
  const terminalSurface = <ExecutionTerminals controller={terminals} />;
  const pmHref = safeReturnTo(params.get("returnTo"), displayScope);
  const handoffParams = new URLSearchParams(params);
  if (displayScope) { handoffParams.set("workspace", displayScope.workspaceId); if (displayScope.projectId) handoffParams.set("project", displayScope.projectId); else handoffParams.delete("project"); }
  if (remoteId) handoffParams.set("thread", remoteId); else handoffParams.delete("thread");
  if (!entryObject.task) handoffParams.delete("task");
  if (!entryObject.entity) handoffParams.delete("entity");
  if (automationsView) handoffParams.set("view", "automations"); else handoffParams.delete("view");
  const settingsReturnTo = boardMode ? boardReturn : `/agent/workspace?${handoffParams}`;
  const boardChatWorkspace = workspaceFilter ? filterWorkspace : selectedWorkspace;
  const boardChatHref = boardMode ? runBoardChatHref({ agentWorkspaceId: boardChatWorkspace && !boardChatWorkspace.archivedAt && boardChatWorkspace.status === "available" ? boardChatWorkspace.id : null, returnTo: boardReturn }) : undefined;
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
      if (modifier && event.altKey && !event.shiftKey && event.key.toLowerCase() === "b" && !automationsView && !boardMode) {
        event.preventDefault();
        toggleRightPanel();
      } else if (modifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === "b" && !automationsView && !boardMode) {
        event.preventDefault();
        setDetailsOpen((open) => !open);
      } else if (modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j" && !automationsView && !boardMode) {
        event.preventDefault();
        if (terminals.enabled || terminals.selectedId) toggleTerminalDrawer();
      } else if (event.altKey) {
        return;
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === "o" && !pending) {
        event.preventDefault(); createSessionInScope();
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

  return <MessageContextDraftProvider><ChatActionsProvider threadId={remoteId} executionPath={environment?.executionPath ?? undefined} canOpenFiles={!inspectorDisabled} onOpenInspector={openChatInspector} onNavigateSession={navigateChatSession}><PmToolCallsProvider key={remoteId ?? localId} threadId={remoteId}><PmIssueWorkspaceProvider
    workspaceId={displayScope?.workspaceId ?? null}
    projectId={displayScope?.projectId ?? null}
    referenceKey={remoteId ? `thread:${remoteId}` : `draft:${localId}`}
    localThreadId={localId}
    initialIssueId={entryObject.task}
    initialEntityId={entryObject.entity}
  ><div className={`pm-agent-chat ${pmTheme.page}${boardMode ? " pm-chat-is-run-board" : ""}`} style={contextChipTheme} onCopyCapture={event => { try { copySelectedMessageContexts(event); } catch (cause) { event.preventDefault(); setActionError(cause instanceof Error ? cause.message : String(cause)); } }} data-embedded={!!entry} data-right-panel-maximized={!boardMode && rightPanelMaximized && rightPanelOpen ? "true" : undefined} data-sidebar-collapsed={sidebarCollapsed || undefined}>
    {!boardMode && !entry && !automationsView && !sessionSettingsOpen && <ChatBackNavigationProtection canLeave={protectNavigation} onApproved={(search, pathname) => { popRouteApproved.current = pathname === location.pathname && runBoardNavigationKey(new URLSearchParams(search)) !== navigationKey; }} />}
    {sidebarOpen && <button type="button" className="pm-agent-sidebar-backdrop" aria-label={t("关闭会话侧栏", "Close session sidebar")} onClick={closeSidebarDrawer} />}
    <aside id={sidebarId} className="pm-agent-sidebar" data-open={sidebarOpen} data-collapsed={sidebarCollapsed} aria-label={t("工作区与会话", "Workspaces and sessions")}>
      <header className="pm-agent-product desktop-titlebar desktop-titlebar-traffic-lights">
        <DovspaceBrandLink canLeave={protectNavigation} />
        <button type="button" className="pm-agent-icon" aria-label={drawerSidebar ? t("关闭侧栏", "Close sidebar") : t("折叠侧栏", "Collapse sidebar")} aria-controls={sidebarId} aria-expanded onClick={() => { toggleSidebar(); requestAnimationFrame(() => sidebarToggle.current?.focus()); }}>{drawerSidebar ? <XIcon /> : <PanelLeftIcon />}</button>
      </header>
      <div className="pm-agent-app-selector"><ProductSwitcher pending={pending} canLeave={protectNavigation} pmHref={pmHref} runHref={boardMode ? boardReturn : runReturn ?? undefined} product={boardMode ? "runs" : "chat"} chatHref={boardChatHref} /></div>
      <div className="pm-agent-sidebar-controls">
        <div className="pm-agent-toolbar">
          <label className="pm-agent-search">
            <SearchIcon aria-hidden="true" />
            <Input ref={searchInput} type="search" aria-label={t("搜索会话", "Search sessions")} placeholder={t("搜索会话…", "Search sessions…")} value={search} onChange={(event) => setSearch(event.target.value)} />
            {search && <button type="button" className="pm-agent-search-clear" aria-label={t("清除搜索", "Clear search")} title={t("清除搜索", "Clear search")} onClick={() => { setSearch(""); searchInput.current?.focus(); }}><XIcon aria-hidden="true" /></button>}
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger render={<button type="button" className="pm-agent-icon" data-active={workspaceFilter ? "true" : undefined} disabled={pending} aria-label={filterLabel} title={filterLabel} />}><ListFilterIcon /></DropdownMenuTrigger>
            <DropdownMenuContent className="pm-agent-filter-menu" side="bottom" align="start" sideOffset={6}>
              <DropdownMenuLabel className="pm-agent-filter-label">{t("按文件夹筛选", "Filter by folder")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={workspaceFilter ?? "__all__"} onValueChange={(value) => setWorkspaceFilter(value === "__all__" ? undefined : value)}>
                <DropdownMenuRadioItem className="pm-agent-filter-item" value="__all__">{t("全部文件夹", "All folders")}</DropdownMenuRadioItem>
                {state.workspaces.map(workspace => <DropdownMenuRadioItem className="pm-agent-filter-item" key={workspace.id} value={workspace.id}><FolderOpenIcon aria-hidden="true" /><span className="pm-agent-filter-name">{workspace.name}</span>{workspace.archivedAt && <span className="pm-agent-filter-tag">{t("已关闭", "Closed")}</span>}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <button type="button" className="pm-agent-icon" disabled={pending} aria-label={t("打开文件夹", "Open folder")} title={t("打开服务器文件夹", "Open server folder")} onClick={() => setOpenFolder(true)}><FolderPlusIcon /></button>
          <button type="button" className="pm-agent-icon" disabled={pending} aria-label={t("新建会话", "New session")} title={t("新建会话 (Ctrl / ⌘ + Shift + O)", "New session (Ctrl / ⌘ + Shift + O)")} onClick={createSessionInScope}><SquarePenIcon /></button>
        </div>
        <Link className="pm-agent-navigation-link" data-testid="agent-customize-link" data-automation-leave-guarded="true" to={{ pathname: "/agent/settings/mcp-servers", search: customizeParams.toString() }} state={{ settingsReturnTo }} title={t("自定义 Agent：MCP 服务器与 Skills", "Customize Agent: MCP servers and Skills")} onClick={(event) => { if (!protectNavigation()) event.preventDefault(); }}><SettingsIcon aria-hidden="true" /><span>{t("自定义", "Customize")}</span><small>MCP / Skills</small></Link>
        <button type="button" className="pm-agent-navigation-link" aria-current={automationsView ? "page" : undefined} onClick={openAutomation}><ZapIcon /><span>{t("自动化", "Automations")}</span></button>
        {actionError && <p role="alert" className="pm-agent-sidebar-error">{actionError}</p>}
      </div>
      <SessionActions.Provider value={{
        disabled: pending || visiting, automationsView, sortByCreated: preferences.threadSortOrder === "created_at", onSwitch: switchSession, onAction: openAction,
        thread: (id) => state.threads.get(id),
        path: (thread) => thread.executionEnvironment?.executionPath,
        scopeName: threadScopeName, provider: threadProvider, providerName: threadProviderName, modelName: threadModelName,
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
          if (preferences.confirmThreadArchive) { setArchiveTarget({ id, thread }); return; }
          archiveThread(id, thread);
        },
        onError: setActionError,
      }}><nav className="pm-agent-catalog" aria-label={t("会话", "Sessions")}>
        <div className="pm-agent-sessions-heading"><h2>{t("会话 · Sessions", "Sessions")}</h2><Link className="pm-agent-icon" data-automation-leave-guarded="true" aria-label={t("历史与归档", "History and archive")} title={t("历史与归档", "History and archive")} to="/agent/settings/history" state={{ settingsReturnTo }} onClick={(event) => { if (!protectNavigation()) event.preventDefault(); }}><ArchiveIcon /></Link></div>
        {state.loading && !state.workspaces.length && <p role="status" className="pm-agent-empty-group">{t("正在读取文件夹…", "Loading folders…")}</p>}
        {state.error && <div role="alert" className="pm-agent-sidebar-error">{state.error}<Button variant="outline" size="sm" onClick={() => void refreshAgentWorkspaces()}>{t("重新读取", "Reload")}</Button></div>}
        {!state.loading && !state.workspaces.length && <div className="pm-agent-empty-catalog"><p>{t("打开服务器文件夹即可开始代码会话，也可选择仅对话。", "Open a server folder to start coding, or choose chat only.")}</p><Button size="sm" variant="outline" disabled={pending} onClick={() => setOpenFolder(true)}><FolderPlusIcon />{t("打开文件夹", "Open folder")}</Button></div>}
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
      {!boardMode && <header className="pm-agent-context-header desktop-titlebar desktop-titlebar-reserve-controls">
        {(drawerSidebar || sidebarCollapsed) && <button ref={sidebarToggle} type="button" className="pm-agent-icon pm-agent-sidebar-toggle" aria-label={t("切换会话侧栏", "Toggle session sidebar")} aria-controls={sidebarId} aria-expanded={drawerSidebar ? sidebarOpen : !sidebarCollapsed} title={t("切换会话侧栏", "Toggle session sidebar")} onClick={() => { toggleSidebar(); if (!drawerSidebar) requestAnimationFrame(() => document.getElementById(sidebarId)?.querySelector<HTMLButtonElement>(".pm-agent-product button")?.focus()); }}><PanelLeftIcon /></button>}
        <nav className="pm-agent-context-title" aria-label={t("当前位置", "Current location")}><div>{currentWorkspace && <><span title={currentWorkspace.path}>{currentWorkspace.name}</span><span aria-hidden> / </span></>}{parentThreadId && <><button type="button" className="pm-agent-parent-thread" title={parentThread?.title ?? parentThreadId} onClick={() => openThreadByRemoteId(parentThreadId)}>{parentThread?.title ?? t("父会话", "Parent session")}</button><span aria-hidden> / </span></>}<strong onDoubleClick={() => { if (remoteId && !automationsView) openAction(remoteId, title ?? "", "rename"); }} title={remoteId && !automationsView ? t("双击重命名会话", "Double-click to rename session") : undefined}>{automationsView ? t("自动化", "Automations") : title ?? (remoteId ? t("未命名会话", "Untitled session") : t("新会话", "New session"))}</strong></div>{remoteId && !automationsView && <button type="button" className="pm-agent-icon pm-agent-title-edit" aria-label={t("重命名会话", "Rename session")} title={t("重命名会话", "Rename session")} onClick={() => openAction(remoteId, title ?? "", "rename")}><PencilIcon /></button>}</nav>
        {!entry && runReturn && <Link className="pm-agent-back" data-automation-leave-guarded="true" to={runReturn} onClick={(event) => { if (!protectNavigation()) event.preventDefault(); }}><ArrowLeftIcon /><span>{t("返回运行面板", "Back to run board")}</span></Link>}
        {!automationsView && <>
          {!entry && automationReturn && <Button variant="outline" size="sm" onClick={() => { if (protect()) navigate(automationReturn); }}><ZapIcon />{t("返回自动化配置", "Return to automation setup")}</Button>}
          <button type="button" className="pm-agent-icon" aria-label={t("切换会话详情", "Toggle session details")} aria-pressed={detailsOpen} title={t("切换会话详情 (Ctrl / ⌘ + Shift + B)", "Toggle session details (Ctrl / ⌘ + Shift + B)")} onClick={() => setDetailsOpen((open) => !open)}><FileTextIcon /></button>
          <button type="button" className="pm-agent-icon" aria-label={t("切换终端抽屉", "Toggle terminal drawer")} aria-pressed={terminalOpen && terminalDock === "bottom"} title={t("切换终端抽屉 (Ctrl / ⌘ + J)", "Toggle terminal drawer (Ctrl / ⌘ + J)")} disabled={(!terminals.enabled && !terminals.selectedId) || (!terminalOpen && (navigationBlocked || pending || openingBoardTerminal || execution.loading || state.loading))} onClick={toggleTerminalDrawer}><PanelBottomIcon /></button>
          <button type="button" className="pm-agent-icon" data-right-panel-toggle aria-label={t("切换右侧面板", "Toggle right panel")} aria-pressed={rightPanelOpen} title={t("切换右侧面板 (Ctrl / ⌘ + Alt + B)", "Toggle right panel (Ctrl / ⌘ + Alt + B)")} onClick={toggleRightPanel}><PanelRightIcon /></button>
        </>}
        {entry ? <><button type="button" className="pm-agent-back" aria-label={t("展开完整 Chat", "Open full Chat")} title={t("展开完整 Chat", "Open full Chat")} onClick={() => { if (protectNavigation()) onExpand?.(handoffParams); }}><Maximize2Icon /><span>{t("展开完整 Chat", "Open full Chat")}</span></button><button type="button" className="pm-agent-icon" onClick={() => { if (protectNavigation()) onClose?.(); }} aria-label={t("关闭 Agent 面板", "Close Agent panel")}><XIcon /></button></> : <Link className="pm-agent-back" data-automation-leave-guarded="true" to={pmHref} aria-label={t("返回 PM", "Back to PM")} title={t("返回 PM", "Back to PM")} onClick={(event) => { if (!protectNavigation()) event.preventDefault(); }} state={params.get("panel") === "1" && displayScope ? { agentPanelReturn: { workspaceId: displayScope.workspaceId, projectId: displayScope.projectId ?? undefined, taskId: entryObject.task ?? undefined, entityId: entryObject.entity ?? undefined, returnTo: pmHref, threadId: remoteId ?? null } } : undefined}><ArrowLeftIcon /><span>{t("返回 PM", "Back to PM")}</span></Link>}
      </header>}
      {boardMode ? <div className="pm-chat-run-board">
        {(drawerSidebar || sidebarCollapsed) && <button ref={sidebarToggle} type="button" className="pm-agent-icon pm-agent-sidebar-toggle pm-chat-run-board-toggle" aria-label={t("切换会话侧栏", "Toggle session sidebar")} aria-controls={sidebarId} aria-expanded={drawerSidebar ? sidebarOpen : !sidebarCollapsed} title={t("切换会话侧栏", "Toggle session sidebar")} onClick={() => { toggleSidebar(); if (!drawerSidebar) requestAnimationFrame(() => document.getElementById(sidebarId)?.querySelector<HTMLButtonElement>(".pm-agent-product button")?.focus()); }}><PanelLeftIcon /></button>}
        {runBoard}
      </div> : automationsView ? (automationWorkspace && displayScope
        ? <Suspense fallback={<div className="pm-agent-automation-empty" role="status">{t("正在加载自动化…", "Loading automations…")}</div>}><AutomationPage key={`${state.identity!.actor.id}:${automationWorkspace.id}:${automationWorkspace.version}`} workspace={automationWorkspace} actorId={state.identity!.actor.id} embedded={!!entry} onAssist={assistAutomation} onOpenThread={openAutomationThread} onExit={exitAutomation} onLeaveGuardChange={setAutomationLeaveGuard} onRecheckAccess={() => { void refreshIdentity(); }}
          projectFlow={<PmProjectFlowAction
            folder={{
              path: environment?.executionPath ?? currentWorkspace?.path ?? null,
              verified: !!environment?.agentWorkspaceId && !!environment.executionPath && !execution.loading && !execution.error,
              loading: execution.loading,
              error: execution.error ?? null,
            }}
            sessionTitle={title ?? t("新会话", "New session")}
            beforePrepare={canLeaveAutomation}
            onPrepared={exitAutomation}
          />}
        /></Suspense>
        : <section className="pm-agent-automation-empty"><ZapIcon /><h1>{t("选择 PM 业务工作区以管理自动化", "Choose a PM business workspace for automations")}</h1>{state.identityError && <p role="alert">{state.identityError}</p>}<Link to="/pm?pick=1" onClick={event => { if (!protectNavigation()) event.preventDefault(); }}>{t("前往 PM 选择业务工作区", "Choose a business workspace in PM")}</Link><Button variant="outline" onClick={exitAutomation}>{t("返回对话", "Back to chat")}</Button></section>) : <>
      {settingsError && <div role="alert" className="pm-agent-notice">{t("会话设置未保存，输入已保留：", "Session settings were not saved; your input is kept: ")}{settingsError}<Button size="sm" variant="outline" onClick={() => void retry().catch(() => {})}>{t("重试保存设置", "Retry saving settings")}</Button></div>}
      {navigationBlocked && !navigationResult.error && <p role="status" className="pm-agent-notice">{t("正在核对指定会话与文件夹；暂不能发送消息。", "Resolving the requested Session and folder; sending is temporarily disabled.")}</p>}
      {navigationResult.error && navigationResult.key === navigationKey && <div role="alert" className="pm-agent-notice pm-agent-error">{navigationResult.error}<Button size="sm" variant="outline" disabled={pending || state.loading} onClick={() => { handledNavigation.current = undefined; setNavigationResult({ key: navigationKey, ready: false }); void refreshAgentWorkspaces(); }}>{t("重新核对原目标", "Retry original target")}</Button></div>}
      {openingBoardTerminal && <p role="status" className="pm-agent-notice">{t("正在打开原会话终端，不会自动执行命令。", "Opening the original Session terminal. No commands are sent automatically.")}</p>}
      {boardTerminalError && <div role="alert" className="pm-agent-notice pm-agent-error">{boardTerminalError}<Button size="sm" variant="outline" disabled={openingBoardTerminal || pending || navigationBlocked} onClick={() => { terminalIntentSeen.current = undefined; execution.refresh(); void refreshAgentWorkspaces(); const next = new URLSearchParams(params); next.set("openTerminal", "1"); setParams(next, { replace: true }); }}>{t("重新核对并打开终端", "Recheck and open terminal")}</Button><Button size="sm" variant="outline" onClick={() => setDetailsOpen(true)}>{t("查看会话目录", "View Session folder")}</Button></div>}
      {(entryObject.task || entryObject.entity) && <div className="pm-agent-notice">{t("入口对象：", "Entry object: ")}<code>{entryObject.task || entryObject.entity}</code> <button type="button" onClick={() => {
        const id = entryObject.task || entryObject.entity;
        const text = aui.composer.getState().text;
        aui.composer.setText(`${text}${text ? "\n\n" : ""}${t(`引用 PM 对象：${id}`, `Reference PM object: ${id}`)}`);
      }}>{t("加入消息", "Add to message")}</button></div>}
      {(actionError || storageError) && <p role="alert" className="pm-agent-notice pm-agent-error">{actionError ?? storageError}</p>}
      {switchError && <p role="alert" className="pm-agent-notice pm-agent-error">{t("无法恢复会话：", "Could not restore session: ")}{switchError.error instanceof Error ? switchError.error.message : String(switchError.error)}<Button size="sm" variant="outline" onClick={() => void act(() => runtime.threads.switchToThread(switchError.threadId, { unarchive: false }))}>{t("重试打开会话", "Retry opening session")}</Button></p>}
      <ChatContinuity runtime={runtime} canContinue={!navigationBlocked && settingsReady && !settingsSaving && !settingsError && !execution.loading && !execution.error && canSendThread(localId, remoteId, settings.providerInstanceId, settings.model, settings.modelOptions)} />
      <div className="pm-agent-conversation" onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest("a[href]") && !protect()) { event.preventDefault(); event.stopPropagation(); }
      }}><ThreadHistoryNavigationProvider key={localId}><Thread
        providerInstanceId={settings.providerInstanceId}
        model={settings.model}
        modelOptions={settings.modelOptions}
        interactionMode={settings.interactionMode}
        onSettingsChange={setSettings}
        catalog={{ providers: state.providers, loaded: state.providersLoaded, loading: state.providersLoading && !state.providersLoaded, refreshing: state.providersLoading && state.providersLoaded, error: state.providerError, refresh: refreshProviders }}
        disabled={navigationBlocked || !settingsLoaded || settingsLoading || execution.loading || !!execution.error || pending || threadLoading || threadsLoading}
        saving={settingsSaving}
        saveError={settingsError}
        onRetry={retry}
        sendUnavailable={navigationBlocked || !currentExecutionSelection || !settingsReady || !!execution.error || !canSendThread(localId, remoteId, settings.providerInstanceId, settings.model, settings.modelOptions)}
        sendIssue={providerIssue}
        onOpenSessionSettings={() => setSessionSettingsOpen(true)}
        composerLeading={<PmComposerReferences />}
        composerActions={<><MessageContextSelector /><PmComposerReferenceAction /></>}
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
      /></ThreadHistoryNavigationProvider></div>
      {terminalOpen && terminalDock === "bottom" && <TerminalDrawer height={terminalHeight} onHeightChange={setTerminalHeight}>{terminalSurface}</TerminalDrawer>}
      </>}
    </main>
    {!boardMode && !automationsView && <ThreadDetailsPanel
      open={detailsOpen}
      onClose={() => setDetailsOpen(false)}
      workspaceName={currentWorkspace?.name}
      threadId={remoteId}
      threadTitle={title ?? (remoteId ? t("未命名会话", "Untitled session") : t("新会话", "New session"))}
      activity={currentThread?.sidebar.activity}
      environmentLabel={environment ? environment.agentWorkspaceId ? environment.agentWorkspaceName ?? currentWorkspace?.name ?? t("文件夹环境", "Folder environment") : t("仅对话", "Chat only") : currentWorkspace?.name}
      environmentPath={environment?.executionPath ?? currentWorkspace?.path}
      environmentStatus={execution.loading ? t("正在核验环境", "Validating environment") : undefined}
      environmentError={execution.error}
      childThreads={childThreads}
      onOpenThread={openThreadByRemoteId}
      onConfigureFiles={configureExecution}
      onSessionSettings={() => setSessionSettingsOpen(true)}
      sessionSettingsDisabled={sessionSettingsDisabled}
    />}
    {!boardMode && !automationsView && <PmRightPanel
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
      openRequest={inspectorRequest}
      disabled={inspectorDisabled} />}
    {executionDialog && <ExecutionSelectionDialog workspaces={state.workspaces} initial={executionDialog.initial} busy={pending || state.loading} error={actionError ?? state.error} onClose={() => setExecutionDialog(undefined)} onSave={saveExecution} />}
    {openFolder && <OpenFolderDialog onClose={() => setOpenFolder(false)} onOpened={workspace => { setSelectedWorkspaceId(workspace.id); setOpenFolder(false); }} />}
    {workspaceRename && <Dialog open onOpenChange={open => { if (!open && !pending) setWorkspaceRename(undefined); }}><DialogContent className="pm-agent-chat-dialog"><DialogHeader><DialogTitle>{t("重命名文件夹", "Rename folder")}</DialogTitle></DialogHeader><code>{workspaceRename.workspace.path}</code><Input autoFocus aria-label={t("文件夹显示名称", "Folder display name")} value={workspaceRename.name} disabled={pending} onChange={event => setWorkspaceRename({ ...workspaceRename, name: event.target.value })} />{actionError && <p role="alert" className="text-destructive">{actionError}</p>}<DialogFooter><Button variant="outline" disabled={pending} onClick={() => setWorkspaceRename(undefined)}>{t("取消", "Cancel")}</Button><Button disabled={pending || !workspaceRename.name.trim()} onClick={() => void act(async () => { await updateAgentWorkspace(workspaceRename.workspace, { name: workspaceRename.name.trim() }); setWorkspaceRename(undefined); })}>{t("保存名称", "Save name")}</Button></DialogFooter></DialogContent></Dialog>}
    {!boardMode && sessionSettingsOpen && <SessionSettingsDialog key={localId} settings={settings} providers={state.providers} providersLoading={state.providersLoading} providersError={state.providerError} onRefreshProviders={() => void refreshProviders()} saving={settingsSaving} onSave={setSettings} onClose={() => setSessionSettingsOpen(false)} />}
    {shortcutsOpen && <Dialog open onOpenChange={setShortcutsOpen}><DialogContent className="agent-session-dialog pm-agent-chat-dialog"><DialogHeader><DialogTitle>{t("对话快捷键", "Chat shortcuts")}</DialogTitle></DialogHeader><ShortcutCatalog /><DialogFooter><Button variant="outline" onClick={() => setShortcutsOpen(false)}>{t("关闭", "Close")}</Button></DialogFooter></DialogContent></Dialog>}
    {snoozeTarget && <Dialog open onOpenChange={(open) => { if (!open && !pending) setSnoozeTarget(undefined); }}><DialogContent className="pm-agent-chat-dialog">
      <DialogHeader><DialogTitle>{t("自定义稍后提醒 · Custom snooze", "Custom snooze")}</DialogTitle></DialogHeader>
      <Input type="datetime-local" aria-label={t("唤醒时间", "Wake time")} value={snoozeTime} onChange={(event) => setSnoozeTime(event.target.value)} />
      {snoozeTime && (!Number.isFinite(new Date(snoozeTime).getTime()) || new Date(snoozeTime).getTime() <= Date.now()) && <p role="alert" className="text-destructive">{t("请选择未来的时间。", "Choose a time in the future.")}</p>}
      <DialogFooter><Button variant="outline" onClick={() => setSnoozeTarget(undefined)}>{t("取消", "Cancel")}</Button><Button disabled={pending || !snoozeTime || !Number.isFinite(new Date(snoozeTime).getTime()) || new Date(snoozeTime).getTime() <= Date.now()} onClick={() => { sidebarAction(snoozeTarget, "snooze", { snoozedUntil: new Date(snoozeTime).toISOString() }); setSnoozeTarget(undefined); }}>{t("稍后提醒", "Snooze")}</Button></DialogFooter>
    </DialogContent></Dialog>}
    {archiveTarget && <Dialog open onOpenChange={(open) => { if (!open && !pending) setArchiveTarget(undefined); }}><DialogContent className="pm-agent-chat-dialog">
      <DialogHeader><DialogTitle>{t("归档会话", "Archive session")}</DialogTitle></DialogHeader>
      <p className="text-muted-foreground text-sm">{t(`归档会话「${archiveTarget.thread.title || t("未命名会话", "Untitled session")}」？归档会将会话移出当前侧栏，可稍后在归档中恢复。`, `Archive session "${archiveTarget.thread.title || t("Untitled session", "Untitled session")}"? Archiving removes it from this sidebar; you can restore it from the archive later.`)}</p>
      <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setArchiveTarget(undefined)}>{t("取消", "Cancel")}</Button><Button disabled={pending} onClick={() => { const target = archiveTarget; setArchiveTarget(undefined); archiveThread(target.id, target.thread); }}>{pending ? t("正在归档…", "Archiving…") : t("归档", "Archive")}</Button></DialogFooter>
    </DialogContent></Dialog>}
    {sessionAction && <Dialog open onOpenChange={(open) => { if (!open && !pending) setSessionAction(undefined); }}><DialogContent className="pm-agent-chat-dialog">
      <DialogHeader><DialogTitle>{sessionAction.kind === "rename" ? t("重命名会话", "Rename session") : t("删除会话", "Delete session")}</DialogTitle></DialogHeader>
      {sessionAction.kind === "delete" && <p className="text-muted-foreground text-sm">{t("删除只移除可见会话；必要执行证据和删除标记保留。若存在活动生成，还必须确认其精确 generation。未知副作用需先核对，删除不会撤销文件或 PM 修改。", "Deletion removes the visible session while retaining necessary execution evidence and tombstones. Active generation cancellation requires its exact-target confirmation. Reconcile unknown effects first; deletion does not undo file or PM changes.")}</p>}
      {sessionAction.kind === "rename" && <Input autoFocus aria-label={t("会话名称", "Session name")} value={sessionTitle} onChange={(event) => setSessionTitle(event.target.value)} />}
      {actionError && <p role="alert" className="text-destructive">{actionError}</p>}
      <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setSessionAction(undefined)}>{t("取消", "Cancel")}</Button><Button variant={sessionAction.kind === "delete" ? "destructive" : "default"} disabled={pending || (sessionAction.kind === "rename" && !sessionTitle.trim())} onClick={commitSessionAction}>{pending ? t("正在保存…", "Saving…") : sessionAction.kind === "rename" ? t("保存名称", "Save name") : t("删除会话", "Delete session")}</Button></DialogFooter>
    </DialogContent></Dialog>}
    {!boardMode && <PmIssuePickerHost />}
  </div></PmIssueWorkspaceProvider></PmToolCallsProvider></ChatActionsProvider></MessageContextDraftProvider>;
}

function ChatBackNavigationProtection({ canLeave, onApproved }: { canLeave: () => boolean; onApproved: (search: string, pathname: string) => void }) {
  const blocker = useBlocker(({ historyAction, currentLocation, nextLocation }) => historyAction === "POP"
    && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  const consumed = useRef<typeof blocker | undefined>(undefined);
  useEffect(() => {
    if (blocker.state !== "blocked" || consumed.current === blocker) return;
    consumed.current = blocker;
    if (canLeave()) { onApproved(blocker.location.search, blocker.location.pathname); blocker.proceed(); }
    else blocker.reset();
  }, [blocker, canLeave, onApproved]);
  return null;
}

function SessionSection({ label, count, tone, forceOpen, className, children }: { label: string; count: number; tone?: "info"; forceOpen?: boolean; className?: string; children: ReactNode }) {
  return <details className={`pm-session-section${className ? ` ${className}` : ""}`} data-tone={tone} open={forceOpen || undefined}>
    <summary className="pm-session-section-header"><span className="pm-session-section-label">{label}</span><span className="pm-session-section-line" aria-hidden="true" /><span className="pm-session-section-count">{count}</span><ChevronDownIcon className="pm-session-section-chevron" aria-hidden="true" /></summary>
    {children}
  </details>;
}

function useSessionRowState() {
  const actions = useContext(SessionActions)!;
  const t = useAgentText();
  const id = useAuiState((s) => s.threadListItem.id);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const active = useAuiState((s) => s.threads.mainThreadId === s.threadListItem.id);
  const title = useAuiState((s) => s.threadListItem.title) ?? (remoteId ? t("未命名会话", "Untitled session") : t("新会话", "New session"));
  const localRunning = useAuiState((s) => s.threadListItem.isRunning);
  const thread = remoteId ? actions.thread(remoteId) : undefined;
  return { actions, t, id, title, thread, activity: thread?.sidebar.activity, running: thread ? thread.sidebar.running : localRunning, current: active && !actions.automationsView, timestamp: thread && (actions.sortByCreated ? thread.createdAt : thread.updatedAt) };
}

function SessionMenuForThread({ thread, id, title, running, children }: { thread: RemoteThread; id: string; title: string; running: boolean; children: (ellipsis: ReactNode) => ReactElement }) {
  const actions = useContext(SessionActions)!;
  return <SessionMenu thread={thread} title={title} path={actions.path(thread)} disabled={actions.disabled} running={running} filtered={actions.filtered(thread)} onSidebar={(action, options) => actions.onSidebar(thread, action, options)} onRename={() => actions.onAction(id, title, "rename")} onRegenerate={() => actions.onRegenerate(thread)} onCustomSnooze={() => actions.onSnooze(thread)} onFilter={() => actions.onFilter(thread)} onSettings={() => actions.onSettings(thread)} onArchive={() => actions.onArchive(id, thread)} onDelete={() => actions.onAction(id, title, "delete")} onError={actions.onError}>{children}</SessionMenu>;
}
export function SessionActivity({ activity, timestamp }: { activity?: ThreadActivity; timestamp?: string }) {
  const t = useAgentText();
  const status = threadActivityPresentation(activity, t);
  return <span className="pm-agent-session-status" data-activity={status.status} data-tone={status.tone} data-priority={status.priority} title={status.label}>
    {status.status === "idle" ? <><span>{status.label}</span>{timestamp && <time dateTime={timestamp} title={timestamp}>{sessionTime(timestamp, t)}</time>}</> : <>{status.status === "running" && <Loader2Icon className="animate-spin" aria-hidden="true" />}{(status.status === "failed" || status.status === "interrupted") && <CircleAlertIcon aria-hidden="true" />}<span>{status.label}</span></>}
  </span>;
}


function SessionHoverCard({ title, scope, path, provider, model, timestamp, children }: {
  title: string; scope?: string; path?: string; provider?: string; model?: string; timestamp?: string; children: ReactNode;
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [position]);
  const show = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setPosition({ left: Math.min(rect.right + 8, Math.max(8, window.innerWidth - 300)), top: Math.max(8, Math.min(rect.top, window.innerHeight - 160)) });
  };
  return <div className="pm-session-hover-anchor" onMouseEnter={event => show(event.currentTarget)} onMouseLeave={() => setPosition(null)} onFocusCapture={event => show(event.currentTarget)} onBlurCapture={() => setPosition(null)}>
    {children}
    {position && createPortal(<div className="pm-session-hover-card" role="tooltip" style={{ left: position.left, top: position.top }}>
      <strong>{title}</strong>
      {scope && <span>{scope}{path ? ` · ${path}` : ""}</span>}
      {provider && <span>{provider}{model ? ` · ${model}` : ""}</span>}
      {timestamp && <span>{new Date(timestamp).toLocaleString()}</span>}
    </div>, document.body)}
  </div>;
}

function SessionRow() {
  const { actions, t, id, title, thread, activity, running, current, timestamp } = useSessionRowState();
  const provider = thread ? actions.provider(thread) : undefined;
  const modelName = thread ? actions.modelName(thread) : "";
  const renderRow = (ellipsis?: ReactNode) => {
    const content = <><button type="button" className="pm-agent-session-select" disabled={actions.disabled} onClick={() => actions.onSwitch(id)} aria-current={current ? "page" : undefined} title={thread ? `${title}\n${actions.scopeName(thread)}${actions.path(thread) ? `\n${actions.path(thread)}` : ""}\n${actions.providerName(thread)}${modelName ? ` · ${modelName}` : ""}` : title}>
      <span className="pm-agent-session-top">
        <span className="pm-agent-session-scope" title={thread ? actions.path(thread) ?? undefined : undefined}>
          {thread?.sidebar.pinnedAt && <PinIcon aria-hidden="true" />}
          {thread?.executionSelection?.agentWorkspaceId ? <FolderOpenIcon aria-hidden="true" /> : <MessageSquareIcon aria-hidden="true" />}
          <span>{thread ? actions.scopeName(thread) : t("历史会话", "Past session")}</span>
        </span>
        <span className="pm-agent-session-indicators">
          <SessionActivity activity={activity} timestamp={timestamp} />
          {thread?.sidebar.unread && <><span className="pm-session-unread" title={t("未读", "Unread")} aria-hidden="true" /><span className="sr-only">{t("未读", "Unread")}</span></>}
        </span>
      </span>
      <span className="pm-agent-session-title">{title}</span>
      <span className="pm-agent-session-footer">
        {thread ? <span className="pm-agent-session-provider" title={actions.providerName(thread)}>{provider && <ProviderGlyph driver={provider.driver} accentColor={provider.accentColor} iconUrl={provider.registryIconUrl} displayName={actions.providerName(thread)} />}<span className="pm-agent-session-provider-text">{actions.providerName(thread)}</span></span> : <span className="pm-agent-session-provider">{t("正在读取", "Loading")}</span>}
        {modelName && <span className="pm-agent-session-model" title={thread?.settings.model}>{modelName}</span>}
      </span>
      {thread?.sidebar.section === "snoozed" && <span className="sr-only">{t(`稍后提醒至 ${thread.sidebar.snoozedUntil}`, `Snoozed until ${thread.sidebar.snoozedUntil}`)}</span>}
    </button>{ellipsis}</>;
    return <div className="pm-agent-session" data-active={current} tabIndex={thread ? 0 : undefined}>
      {thread ? <SessionHoverCard title={title} scope={actions.scopeName(thread)} path={actions.path(thread) ?? undefined} provider={actions.providerName(thread)} model={modelName || undefined} timestamp={timestamp}>{content}</SessionHoverCard> : content}
    </div>;
  };
  return thread ? <SessionMenuForThread thread={thread} id={id} title={title} running={running}>{renderRow}</SessionMenuForThread> : renderRow();
}

function SessionSlimRow() {
  const { actions, t, id, title, thread, activity, running, current, timestamp } = useSessionRowState();
  const renderRow = (ellipsis?: ReactNode) => <div className="pm-agent-session pm-agent-session-slim" data-active={current} tabIndex={thread ? 0 : undefined}>
    <button type="button" className="pm-agent-session-select" disabled={actions.disabled} onClick={() => actions.onSwitch(id)} aria-current={current ? "page" : undefined} title={thread ? `${title}\n${actions.scopeName(thread)}${actions.path(thread) ? `\n${actions.path(thread)}` : ""}\n${actions.providerName(thread)}` : title}>
      <span className="pm-agent-session-title">{title}</span>
      <span className="pm-agent-session-slim-meta">
        <SessionActivity activity={activity} timestamp={timestamp} />
        {thread?.sidebar.unread && <><span className="pm-session-unread" title={t("未读", "Unread")} aria-hidden="true" /><span className="sr-only">{t("未读", "Unread")}</span></>}
      </span>
    </button>
    {ellipsis}
  </div>;
  return thread ? <SessionMenuForThread thread={thread} id={id} title={title} running={running}>{renderRow}</SessionMenuForThread> : renderRow();
}
