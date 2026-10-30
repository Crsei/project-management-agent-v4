import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAui, useAuiState, ThreadListPrimitive, type AssistantRuntime } from "@assistant-ui/react";
import { Menu } from "@base-ui/react/menu";
import { ArchiveIcon, ArrowLeftIcon, ChartNoAxesCombinedIcon, FileTextIcon, KeyboardIcon, ListFilterIcon, Loader2Icon, Maximize2Icon, PanelBottomIcon, PanelLeftIcon, PanelRightIcon, PlusIcon, SearchIcon, SettingsIcon, XIcon, ZapIcon } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { Thread } from "@agent/components/assistant-ui/elements/thread.aui";
import { useChatSettings } from "@agent/hooks/use-chat-settings";
import { useIsMobile } from "@agent/hooks/use-mobile";
import { ChatContinuity } from "../chat/continuity";
import { UsageNavigationLink } from "../usage/navigation";
import { initializeScopedThread, refreshThreadList } from "../chat/remote-adapter";
import { PmToolCallsProvider } from "../chat/pm-tool-calls";
import { FileAreaDialog } from "./file-area-dialog";
import { DEFAULT_INSPECTOR_PANEL, PmInspector, type InspectorPanel } from "./inspector";
import { ThreadDetailsPanel } from "./thread-details-panel";
import { TerminalDrawer, TERMINAL_DRAWER_MIN_HEIGHT } from "./terminal-drawer";
import { ProductSwitcher } from "./product-switcher";
import { UserMenu } from "./user-menu";
import { SidebarProjectChooser } from "./sidebar-project-chooser";
import { useChatDrafts } from "./drafts";
import { SessionMenu } from "./session-menu";
import { PmIssueWorkspaceProvider } from "./pm-issue-workspace";
import { PmIssuePickerHost } from "./pm-issue-picker-host";
import { PmComposerReferenceAction, PmComposerReferences } from "./pm-composer-references";
import { createSidebarVisitCoordinator } from "./sidebar-visit";
import { workspaceClient } from "../network";
import { useAgentText, type AgentText } from "../i18n";
import { agentText } from "../i18n-text.ts";
import type { RemoteThread } from "@agent-workspace/contracts/chat";
import SessionSettingsDialog from "../settings/session-settings-dialog";
import { ShortcutCatalog } from "../settings/input-preferences";
import { useChatAppearance, useChatBrowserPreferences } from "../settings/browser-preferences";
import { acceptRemoteThread, availableProviderModel, bindDraftScope, canSendThread, refreshCatalog, refreshIdentity, refreshProviders, sameScope, scopeContext, scopeKey, threadScope, usePmChatState, type AgentScope, type AgentFileArea } from "./state";
import pmTheme from "@/views/pm/dashboards-views.module.css";
import "../../styles/pm-chat.css";

const AutomationPage = lazy(() => import("./automation/page").then(module => ({ default: module.AutomationPage })));
const visitThread = createSidebarVisitCoordinator(
  async (id) => (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(id)}`)).thread,
  async (id, revision) => (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(id)}/sidebar`, {
    method: "POST", body: JSON.stringify({ action: "visit", revision }),
  })).thread,
);

type ScopeGroup = { scope: AgentScope; name: string; fileArea: AgentFileArea };
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
function requestedScope(params: URLSearchParams): AgentScope | undefined {
  const workspaceId = params.get("workspace");
  if (params.has("workspace")) return workspaceId ? { workspaceId, projectId: params.get("project") || null } : undefined;
  try {
    const saved = JSON.parse(sessionStorage.getItem("pm-v3:agent-scope") ?? "null") as AgentScope | null;
    if (saved && typeof saved.workspaceId === "string" && (saved.projectId === null || typeof saved.projectId === "string")) return saved;
  } catch { /* A new chat remains unscoped if browser storage is unavailable. */ }
  return undefined;
}
function fileAreaLabel(area: AgentFileArea | undefined, t: AgentText) {
  return !area ? t("未选择上下文", "No context selected") : area.status === "available" ? area.reason === "initializes_on_first_use" ? t("默认目录", "Default directory") : t("目录可用", "Directory available") : area.status === "unconfigured" ? t("未配置目录", "Directory not configured") : t("目录不可用", "Directory unavailable");
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
function safeReturnTo(value: string | null, scope?: AgentScope) {
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
  const params = entry ?? routeParams;
  const initialScope = useRef(requestedScope(params));
  const [entryObject, setEntryObject] = useState(() => ({ task: params.get("task"), entity: params.get("entity") }));
  const [selectedScope, setSelectedScope] = useState<AgentScope | undefined>(initialScope.current);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [embeddedAutomationsView, setEmbeddedAutomationsView] = useState(() => params.get("view") === "automations");
  const automationLeaveGuard = useRef<(() => boolean) | null>(null);
  const setAutomationLeaveGuard = useCallback((guard: (() => boolean) | null) => { automationLeaveGuard.current = guard; }, []);
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<AgentScope>();
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
  const [terminalHeight, setTerminalHeight] = useState(() => {
    try {
      const stored = Number(localStorage.getItem("pm-v3:terminal-height"));
      if (Number.isFinite(stored) && stored > 0) return Math.max(TERMINAL_DRAWER_MIN_HEIGHT, Math.min(720, window.innerHeight * 0.7, stored));
    } catch { /* A blocked storage keeps the in-memory height. */ }
    return 320;
  });
  const [inspectorPanel, setInspectorPanel] = useState<InspectorPanel | null>(null);
  const [lastInspectorPanel, setLastInspectorPanel] = useState<InspectorPanel>(DEFAULT_INSPECTOR_PANEL);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [directory, setDirectory] = useState<ScopeGroup>();
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
  const scope = threadScope(localId, remoteId);
  const context = scopeContext(state.catalog, scope);
  const displayScope = scope ?? (!remoteId ? selectedScope : undefined);
  const displayContext = scopeContext(state.catalog, displayScope);
  const automationsView = entry ? embeddedAutomationsView : params.get("view") === "automations";
  const automationWorkspace = state.identity?.workspaces.find((workspace) => workspace.id === displayScope?.workspaceId);
  const { protect, storageError } = useChatDrafts(runtime, displayScope);
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
    void refreshCatalog().catch(() => {});
    void refreshIdentity();
    void refreshProviders();
    const refresh = () => { void refreshCatalog().catch(() => {}); void refreshIdentity(); void refreshProviders(); void refreshThreadList().catch(() => {}); };
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
    if (!remoteId && !scope && selectedScope && scopeContext(state.catalog, selectedScope)) bindDraftScope(localId, selectedScope);
  }, [localId, remoteId, scope, selectedScope, state.catalog]);
  useEffect(() => {
    if (entry || threadsLoading || state.loading) return;
    const next = new URLSearchParams(params);
    if (displayScope) {
      try { sessionStorage.setItem("pm-v3:agent-scope", JSON.stringify(displayScope)); } catch { /* URL remains authoritative for this mounted view. */ }
      next.set("workspace", displayScope.workspaceId);
      if (displayScope.projectId) next.set("project", displayScope.projectId); else next.delete("project");
    } else { next.delete("workspace"); next.delete("project"); }
    if (remoteId) next.set("thread", remoteId); else next.delete("thread");
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [displayScope, remoteId, threadsLoading, state.loading, params, setParams, entry]);

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
    if (open) next.set("view", "automations"); else next.delete("view");
    setParams(next, { replace: false });
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
      if (exitView) next.delete("view");
      setParams(next, { replace: true });
    }
  };
  const selectScope = (target: AgentScope, create = false) => {
    if (pending || state.loading || state.error || !scopeContext(state.catalog, target) || !canLeaveAutomation()) return;
    if (!create && sameScope(scope, target)) {
      if (automationsView) setAutomationView(false);
      setSidebarOpen(false);
      return;
    }
    if (!protect()) return;
    clearEntryObject(automationsView);
    void act(async () => {
      const key = scopeKey(target);
      const id = creationIds.current.get(key) ?? crypto.randomUUID();
      creationIds.current.set(key, id);
      bindDraftScope(id, target);
      // An explicit new session for a scope starts without the previous entry's
      // PM binding; the entry object is cleared right above.
      await initializeScopedThread(id, null);
      await refreshThreadList();
      await runtime.threads.switchToThread(id);
      setFreshThreadId(id);
      creationIds.current.delete(key);
      setSelectedScope(target);
      setSidebarOpen(false);
    });
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
          setSelectedScope(thread.scope);
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
    const owner = scopeContext(state.catalog, thread.scope);
    return owner ? owner.project?.name ?? t(`${owner.workspace.name} · 工作区`, `${owner.workspace.name} · Workspace`) : thread.scope ? t("原作用域不可访问", "Original scope unavailable") : t("未绑定作用域", "No scope bound");
  };
  const threadProviderName = (thread: RemoteThread) => {
    const providerId = thread.settings.providerInstanceId;
    return state.providers.find((provider) => provider.instanceId === providerId)?.label || providerId || t("未选择 Provider", "No provider selected");
  };
  const renderSessions = () => {
    const query = search.trim().toLocaleLowerCase();
    const indices = threadIds.map((id, index) => {
      const item = threadItems.find((candidate) => candidate.id === id);
      return { id, index, item, thread: item?.remoteId ? state.threads.get(item.remoteId) : undefined };
    }).filter(({ item, thread }) => {
      if (!item?.remoteId || (projectFilter && !sameScope(thread?.scope, projectFilter))) return false;
      return !query || [item.title ?? t("新会话", "New session"), thread?.remoteId, thread && threadScopeName(thread), thread && threadProviderName(thread)]
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });
    const sortByCreated = preferences.threadSortOrder === "created_at";
    const rows = (section: "pinned" | "active" | "snoozed" | "settled") => indices.filter(({ thread }) => (thread?.sidebar.section ?? "active") === section).sort((a, b) => {
      if (section === "pinned") return (b.thread?.sidebar.pinnedAt ?? "").localeCompare(a.thread?.sidebar.pinnedAt ?? "");
      if (section === "snoozed") return (a.thread?.sidebar.snoozedUntil ?? "").localeCompare(b.thread?.sidebar.snoozedUntil ?? "");
      return ((sortByCreated ? b.thread?.createdAt : b.thread?.updatedAt) ?? "").localeCompare((sortByCreated ? a.thread?.createdAt : a.thread?.updatedAt) ?? "");
    }).map(({ id, index }) => <ThreadListPrimitive.ItemByIndex key={id} index={index} components={{ ThreadListItem: SessionRow }} />);
    const pinned = rows("pinned"), active = rows("active"), snoozed = rows("snoozed"), settled = rows("settled");
    return <div className="pm-agent-sessions">
      {pinned.length > 0 && <><div className="pm-session-section-label">{t("置顶 · Pinned", "Pinned")}</div>{pinned}</>}
      {active.length > 0 && <><div className="pm-session-section-label">{t("会话 · Active", "Active")}</div>{active}</>}
      {snoozed.length > 0 && <details className="pm-session-section" open={search.trim() ? true : undefined}><summary>{t(`稍后提醒 · Snoozed (${snoozed.length})`, `Snoozed (${snoozed.length})`)}</summary>{snoozed}</details>}
      {settled.length > 0 && <details className="pm-session-section" open={search.trim() ? true : undefined}><summary>{t(`已归置 · Settled (${settled.length})`, `Settled (${settled.length})`)}</summary>{settled}</details>}
      {!indices.length && <p className="pm-agent-empty-group">{search ? t("没有匹配会话", "No matching sessions") : t("暂无会话", "No sessions")}</p>}
    </div>;
  };
  const sessionSettingsDisabled = !scope || !settingsLoaded || settingsLoading || settingsSaving || threadRunning || threadLoading || threadsLoading || pending;
  const toggleSidebar = () => {
    if (drawerSidebar) {
      if (sidebarOpen) closeSidebarDrawer();
      else { setSidebarOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); }
    } else setSidebarCollapsed((collapsed) => !collapsed);
  };
  const noScope = !scope;
  const inspectorDisabled = !state.catalog || !!state.error || !displayContext || displayContext.fileArea.status !== "available" || (!!remoteId && !scope);
  const changeInspectorPanel = (next: InspectorPanel | null) => {
    setInspectorPanel(next);
    if (next) setLastInspectorPanel(next);
  };
  const toggleRightPanel = () => changeInspectorPanel(inspectorPanel ? null : lastInspectorPanel);
  const toggleTerminalDrawer = () => setTerminalOpen((value) => !value);
  const pmHref = safeReturnTo(params.get("returnTo"), displayScope);
  const handoffParams = new URLSearchParams(params);
  if (displayScope) { handoffParams.set("workspace", displayScope.workspaceId); if (displayScope.projectId) handoffParams.set("project", displayScope.projectId); else handoffParams.delete("project"); }
  if (remoteId) handoffParams.set("thread", remoteId); else handoffParams.delete("thread");
  if (!entryObject.task) handoffParams.delete("task");
  if (!entryObject.entity) handoffParams.delete("entity");
  if (automationsView) handoffParams.set("view", "automations"); else handoffParams.delete("view");
  const settingsReturnTo = `/agent/workspace?${handoffParams}`;
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"]')) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], details[open]:not(.pm-session-section)')) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.altKey && !event.shiftKey && event.key.toLowerCase() === "b" && !automationsView) {
        event.preventDefault();
        if (!inspectorDisabled) toggleRightPanel();
      } else if (modifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === "b" && !automationsView) {
        event.preventDefault();
        setDetailsOpen((open) => !open);
      } else if (modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j" && !automationsView) {
        event.preventDefault();
        if (!inspectorDisabled) toggleTerminalDrawer();
      } else if (event.altKey) {
        return;
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === "o" && !pending && displayScope && displayContext) {
        event.preventDefault(); selectScope(displayScope, true);
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
    referenceKey={remoteId ? `thread:${remoteId}` : displayScope ? `new:${scopeKey(displayScope)}` : `unscoped:${localId}`}
    localThreadId={localId}
    initialIssueId={entryObject.task}
    initialEntityId={entryObject.entity}
  ><div className={`pm-agent-chat ${pmTheme.page}`} data-embedded={!!entry}>
    {sidebarOpen && <button type="button" className="pm-agent-sidebar-backdrop" aria-label={t("关闭会话侧栏", "Close session sidebar")} onClick={closeSidebarDrawer} />}
    <aside id={sidebarId} className="pm-agent-sidebar" data-open={sidebarOpen} data-collapsed={sidebarCollapsed} aria-label={t("工作区与会话", "Workspaces and sessions")}>
      <header className="pm-agent-product">
        <ProductSwitcher scope={displayScope} pending={pending} canLeave={protectNavigation} pmHref={pmHref} onSelectScope={selectScope} />
        <button type="button" className="pm-agent-icon pm-agent-mobile-close" aria-label={t("关闭侧栏", "Close sidebar")} onClick={closeSidebarDrawer}><XIcon /></button>
      </header>
      <div className="pm-agent-sidebar-controls">
        <div className="pm-agent-toolbar">
          <label className="pm-agent-search"><SearchIcon /><Input ref={searchInput} type="search" aria-label={t("搜索会话", "Search sessions")} placeholder={t("搜索会话…", "Search sessions…")} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <Menu.Root>
            <Menu.Trigger className="pm-agent-icon" aria-label={t("筛选会话作用域", "Filter session scope")} title={t("筛选会话作用域", "Filter session scope")} data-active={!!projectFilter}><ListFilterIcon /></Menu.Trigger>
            <Menu.Portal><Menu.Positioner className="pm-session-positioner" side="bottom" align="start" sideOffset={6}><Menu.Popup className="pm-session-menu-popup">
              <Menu.Item className="pm-session-menu-item" onClick={() => setProjectFilter(undefined)}>{!projectFilter ? "✓ " : ""}{t("所有会话", "All sessions")}</Menu.Item>
              {state.catalog?.workspaces.map((workspace) => <Menu.Group key={workspace.id}>
                <Menu.GroupLabel className="pm-agent-menu-label">{workspace.name}</Menu.GroupLabel>
                <Menu.Item className="pm-session-menu-item" onClick={() => setProjectFilter({ workspaceId: workspace.id, projectId: null })}>{sameScope(projectFilter, { workspaceId: workspace.id, projectId: null }) ? "✓ " : ""}{t("工作区会话", "Workspace sessions")}</Menu.Item>
                {workspace.projects.map((project) => <Menu.Item key={project.id} className="pm-session-menu-item" onClick={() => setProjectFilter({ workspaceId: workspace.id, projectId: project.id })}>{sameScope(projectFilter, { workspaceId: workspace.id, projectId: project.id }) ? "✓ " : ""}{project.name}</Menu.Item>)}
              </Menu.Group>)}
            </Menu.Popup></Menu.Positioner></Menu.Portal>
          </Menu.Root>
          <SidebarProjectChooser catalog={state.catalog} identity={state.identityLoading || state.identityError ? null : state.identity} scope={displayScope} pending={pending || state.loading} loading={state.loading} error={state.error} canLeave={protectNavigation} onSelect={selectScope} onConfigure={setDirectory} onRefresh={() => void refreshCatalog().catch(() => {})} />
          <button type="button" className="pm-agent-icon" disabled={pending || state.loading || !displayScope || !displayContext || !!state.error} aria-label={t("新建当前作用域会话", "New session in current scope")} title={t("新建当前作用域会话 (Ctrl / ⌘ + Shift + O)", "New session in current scope (Ctrl / ⌘ + Shift + O)")} onClick={() => { if (displayScope) selectScope(displayScope, true); }}><PlusIcon /></button>
        </div>
        {projectFilter && <button type="button" className="pm-session-filter" onClick={() => setProjectFilter(undefined)}>{t("筛选：", "Filter: ")}{scopeContext(state.catalog, projectFilter)?.project?.name ?? scopeContext(state.catalog, projectFilter)?.workspace.name ?? projectFilter.projectId ?? t("工作区", "Workspace")}{t(" · 显示所有会话 ×", " · Show all sessions ×")}</button>}
        <button type="button" className="pm-agent-automation-link" aria-current={automationsView ? "page" : undefined} disabled={!displayScope} title={!displayScope ? t("请先选择工作区", "Select a workspace first") : undefined} onClick={openAutomation}><ZapIcon /><span>{t("自动化", "Automations")}</span></button>
        {actionError && <p role="alert" className="pm-agent-sidebar-error">{actionError}</p>}
      </div>
      <SessionActions.Provider value={{
        disabled: pending || visiting, automationsView, sortByCreated: preferences.threadSortOrder === "created_at", onSwitch: switchSession, onAction: openAction,
        thread: (id) => state.threads.get(id),
        path: (thread) => scopeContext(state.catalog, thread.scope)?.fileArea.path,
        scopeName: threadScopeName, providerName: threadProviderName,
        filtered: (thread) => sameScope(projectFilter, thread.scope),
        onSidebar: sidebarAction,
        onRegenerate: (thread) => void act(async () => {
          try {
            const result = await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}/regenerate-title`, { method: "POST", body: JSON.stringify({ revision: thread.revision }) });
            acceptRemoteThread(result.thread); await refreshThreadList();
          } catch (error) { await refreshThreadList().catch(() => {}); throw error; }
        }),
        onSnooze: (thread) => { setSnoozeTarget(thread); setSnoozeTime(""); },
        onFilter: (thread) => setProjectFilter(sameScope(projectFilter, thread.scope) ? undefined : thread.scope),
        onSettings: (thread) => {
          const context = scopeContext(state.catalog, thread.scope);
          if (thread.scope && context) setDirectory({ scope: thread.scope, name: context.project?.name ?? context.workspace.name, fileArea: context.fileArea });
          else setActionError(t("此会话的原始作用域不可访问，无法配置文件区域。", "This session's original scope is unavailable, so its file area cannot be configured."));
        },
        onArchive: (id, thread) => {
          if (id === localId && (!canLeaveAutomation() || !protect())) return;
          const name = thread.title || t("未命名会话", "Untitled session");
          if (preferences.confirmThreadArchive && !window.confirm(t(`归档会话「${name}」？归档会将会话移出当前侧栏，可稍后在归档中恢复。`, `Archive session "${name}"? Archiving removes it from this sidebar; you can restore it from the archive later.`))) return;
          void act(async () => {
            const current = (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}`)).thread;
            const catalog = await refreshCatalog();
            if (!current.scope || !scopeContext(catalog, current.scope)) throw new Error(t("此历史会话没有可访问的原始作用域，不能归档，也不会重新归属。请刷新 PM 访问范围。", "This past session has no accessible original scope, so it cannot be archived or reassigned. Refresh the PM access scope."));
            const saved = current.status === "archived" ? current : (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}`, { method: "PUT", body: JSON.stringify({ status: "archived" }) })).thread;
            acceptRemoteThread(saved);
            await refreshThreadList();
            if (id === localId) { setSelectedScope(displayScope); await runtime.threads.switchToNewThread(); setFreshThreadId(undefined); clearEntryObject(); onThreadChange?.(null); }
          });
        },
        onError: setActionError,
      }}><nav className="pm-agent-catalog" aria-label={t("会话", "Sessions")}>
        <div className="pm-agent-sessions-heading"><h2>{t("会话 · Sessions", "Sessions")}</h2><Link className="pm-agent-icon" data-automation-leave-guarded="true" aria-label={t("历史与归档", "History and archive")} title={t("历史与归档", "History and archive")} to="/agent/settings/history" state={{ settingsReturnTo }} onClick={(event) => { if (!protectNavigation()) event.preventDefault(); }}><ArchiveIcon /></Link></div>
        {state.loading && !state.catalog && <p role="status" className="pm-agent-empty-group">{t("正在读取工作区…", "Loading workspaces…")}</p>}
        {state.error && <div role="alert" className="pm-agent-sidebar-error">{t("工作区读取失败：", "Failed to load workspaces: ")}{state.error}<Button variant="outline" size="sm" onClick={() => void refreshCatalog().catch(() => {})}>{t("重新读取", "Reload")}</Button><Link to="/pm" data-automation-leave-guarded="true" onClick={(event) => { if (!protectNavigation()) event.preventDefault(); }}>{t("前往 PM 登录", "Go to PM sign-in")}</Link></div>}
        {!state.loading && !state.error && !state.catalog?.workspaces.length && <p className="pm-agent-empty-catalog">{t("没有可访问的 PM 工作区。", "No accessible PM workspaces.")}</p>}
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
        <button ref={sidebarToggle} type="button" className="pm-agent-icon pm-agent-sidebar-toggle" aria-label={t("切换会话侧栏", "Toggle session sidebar")} aria-controls={sidebarId} aria-expanded={drawerSidebar ? sidebarOpen : !sidebarCollapsed} title={t("切换会话侧栏", "Toggle session sidebar")} onClick={toggleSidebar}><PanelLeftIcon /></button>
        <nav className="pm-agent-context-title" aria-label={t("当前位置", "Current location")}><div>{displayContext ? <><span>{displayContext.workspace.name}</span><span aria-hidden> / </span><span>{displayContext.project?.name ?? t("工作区会话", "Workspace session")}</span><span aria-hidden> / </span></> : null}<strong>{automationsView ? t("自动化", "Automations") : title ?? (remoteId ? t("历史会话", "Past session") : t("新会话", "New session"))}</strong></div></nav>
        {!automationsView && <>
          <button type="button" className="pm-agent-icon" aria-label={t("切换会话详情", "Toggle session details")} aria-pressed={detailsOpen} title={t("切换会话详情 (Ctrl / ⌘ + Shift + B)", "Toggle session details (Ctrl / ⌘ + Shift + B)")} onClick={() => setDetailsOpen((open) => !open)}><FileTextIcon /></button>
          <button type="button" className="pm-agent-icon" aria-label={t("切换终端抽屉", "Toggle terminal drawer")} aria-pressed={terminalOpen} title={t("切换终端抽屉 (Ctrl / ⌘ + J)", "Toggle terminal drawer (Ctrl / ⌘ + J)")} disabled={inspectorDisabled} onClick={toggleTerminalDrawer}><PanelBottomIcon /></button>
          <button type="button" className="pm-agent-icon" aria-label={t("切换右侧面板", "Toggle right panel")} aria-pressed={!!inspectorPanel} title={t("切换右侧面板 (Ctrl / ⌘ + Alt + B)", "Toggle right panel (Ctrl / ⌘ + Alt + B)")} disabled={inspectorDisabled} onClick={toggleRightPanel}><PanelRightIcon /></button>
        </>}
        {entry ? <><button type="button" className="pm-agent-back" aria-label={t("展开完整 Chat", "Open full Chat")} title={t("展开完整 Chat", "Open full Chat")} onClick={() => { if (protectNavigation()) onExpand?.(handoffParams); }}><Maximize2Icon /><span>{t("展开完整 Chat", "Open full Chat")}</span></button><button type="button" className="pm-agent-icon" onClick={() => { if (protectNavigation()) onClose?.(); }} aria-label={t("关闭 Agent 面板", "Close Agent panel")}><XIcon /></button></> : <Link className="pm-agent-back" data-automation-leave-guarded="true" to={pmHref} aria-label={t("返回 PM", "Back to PM")} title={t("返回 PM", "Back to PM")} onClick={(event) => { if (!protectNavigation()) event.preventDefault(); }} state={params.get("panel") === "1" && displayScope ? { agentPanelReturn: { workspaceId: displayScope.workspaceId, projectId: displayScope.projectId ?? undefined, taskId: entryObject.task ?? undefined, entityId: entryObject.entity ?? undefined, returnTo: pmHref, threadId: remoteId ?? null } } : undefined}><ArrowLeftIcon /><span>{t("返回 PM", "Back to PM")}</span></Link>}
      </header>
      {automationsView ? (automationWorkspace && displayScope
        ? <Suspense fallback={<div className="pm-agent-automation-empty" role="status">{t("正在加载自动化…", "Loading automations…")}</div>}><AutomationPage key={automationWorkspace.id} workspace={automationWorkspace} actorId={state.identity!.actor.id} root={`/pm/${encodeURIComponent(automationWorkspace.id)}`} onExit={exitAutomation} onLeaveGuardChange={setAutomationLeaveGuard} onRecheckAccess={() => { void refreshIdentity(); }} /></Suspense>
        : <section className="pm-agent-automation-empty"><ZapIcon /><h1>{t("需要先选择工作区", "Select a workspace first")}</h1><Button variant="outline" onClick={exitAutomation}>{t("返回对话", "Back to chat")}</Button></section>) : <>
      {(noScope || !context || context.fileArea.status !== "available" || state.error) && <p className="pm-agent-notice">{remoteId && noScope ? t("此历史会话没有绑定作用域。", "This past session has no scope bound.") : initialScope.current && !scopeContext(state.catalog, initialScope.current) && !state.loading ? t("入口工作区或项目不可访问，请从左侧重新选择。", "The entry workspace or project is unavailable; choose another on the left.") : t("请先选择工作区或项目，并配置可用的文件区域。", "Select a workspace or project and configure an available file area first.")}</p>}
      {settingsError && <div role="alert" className="pm-agent-notice">{t("会话设置未保存，输入已保留：", "Session settings were not saved; your input is kept: ")}{settingsError}<Button size="sm" variant="outline" onClick={() => void retry().catch(() => {})}>{t("重试保存设置", "Retry saving settings")}</Button></div>}
      {(entryObject.task || entryObject.entity) && <div className="pm-agent-notice">{t("入口对象：", "Entry object: ")}<code>{entryObject.task || entryObject.entity}</code> <button type="button" onClick={() => {
        const id = entryObject.task || entryObject.entity;
        const text = aui.composer.getState().text;
        aui.composer.setText(`${text}${text ? "\n\n" : ""}${t(`引用 PM 对象：${id}`, `Reference PM object: ${id}`)}`);
      }}>{t("加入消息", "Add to message")}</button></div>}
      {(actionError || storageError) && <p role="alert" className="pm-agent-notice pm-agent-error">{actionError ?? storageError}</p>}
      {switchError && <p role="alert" className="pm-agent-notice pm-agent-error">{t("无法恢复会话：", "Could not restore session: ")}{switchError.error instanceof Error ? switchError.error.message : String(switchError.error)}<Button size="sm" variant="outline" onClick={() => void act(() => runtime.threads.switchToThread(switchError.threadId))}>{t("重试打开会话", "Retry opening session")}</Button></p>}
      <ChatContinuity runtime={runtime} canContinue={settingsReady && !settingsSaving && !settingsError && canSendThread(localId, remoteId, settings.providerInstanceId, settings.model, settings.modelOptions)} />
      <div className="pm-agent-conversation" onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest("a[href]") && !protect()) { event.preventDefault(); event.stopPropagation(); }
      }}><Thread
        providerInstanceId={settings.providerInstanceId}
        model={settings.model}
        modelOptions={settings.modelOptions}
        interactionMode={settings.interactionMode}
        onSettingsChange={setSettings}
        catalog={{ providers: state.providers, loading: state.providersLoading, error: state.providerError, refresh: refreshProviders }}
        disabled={!scope || !settingsLoaded || settingsLoading || state.loading || !!state.error || pending || threadRunning || threadLoading || threadsLoading}
        saving={settingsSaving}
        saveError={settingsError}
        onRetry={retry}
        sendUnavailableReason={!settingsReady ? t("会话设置尚未就绪或有待保存的更改。", "Session settings are not ready or have unsaved changes.") : !canSendThread(localId, remoteId, settings.providerInstanceId, settings.model, settings.modelOptions) ? t("工作区、文件区域、Provider、模型或模型选项当前不可用。", "The workspace, file area, provider, model, or model options are currently unavailable.") : undefined}
        composerLeading={<PmComposerReferences />}
        composerActions={<PmComposerReferenceAction />}
        welcome={{
          title: displayContext ? t(`想在 ${displayContext.project?.name ?? displayContext.workspace.name} 中做什么？`, `What do you want to do in ${displayContext.project?.name ?? displayContext.workspace.name}?`) : t("你想做什么？", "What do you want to do?"),
          freshlyCreated: (!!remoteId && freshThreadId === remoteId) || draftOrigin.current.wasNew,
          ...(displayScope?.projectId ? { alternateLabel: t("或开始工作区会话", "Or start a workspace session"), onAlternate: () => selectScope({ workspaceId: displayScope.workspaceId, projectId: null }, true) } : {}),
        }}
        onModelChange={async (providerInstanceId, model) => {
          if (!scope || !settingsLoaded || settingsLoading || settingsSaving || state.loading || state.error || pending || threadRunning || threadLoading || threadsLoading)
            throw new Error(t("当前会话暂时无法更改模型。", "The model cannot be changed for this session right now."));
          if (!availableProviderModel(providerInstanceId, model))
            throw new Error(t("模型目录已变化，请刷新后重新选择。", "The model catalog changed; refresh and select again."));
          const selected = state.providers.find((entry) => entry.instanceId === providerInstanceId);
          await setSettings({ providerInstanceId, model, modelOptions: selected?.modelPreferences?.options[model] ?? [], interactionMode: settings.interactionMode ?? "default" });
        }}
      /></div>
      {terminalOpen && displayScope && !inspectorDisabled && <TerminalDrawer
        key={`terminal:${scopeKey(displayScope)}:${remoteId ?? ""}`}
        scope={displayScope}
        threadId={remoteId}
        path={displayContext?.fileArea.path}
        height={terminalHeight}
        onHeightChange={setTerminalHeight}
        onClose={() => setTerminalOpen(false)}
      />}
      </>}
    </main>
    {!automationsView && <ThreadDetailsPanel
      open={detailsOpen}
      onClose={() => setDetailsOpen(false)}
      workspaceName={displayContext?.workspace.name}
      projectName={displayContext ? displayContext.project?.name ?? t("工作区会话", "Workspace session") : undefined}
      threadTitle={title ?? (remoteId ? t("历史会话", "Past session") : t("新会话", "New session"))}
      path={displayContext?.fileArea.path}
      statusLabel={threadRunning || (remoteId && state.threads.get(remoteId)?.sidebar.running) ? t("正在生成", "Generating") : threadLoading || threadsLoading || visiting ? t("正在读取", "Loading") : switchError ? t("会话读取失败", "Session load failed") : fileAreaLabel(displayContext?.fileArea, t)}
      onConfigureFiles={displayScope && displayContext && displayContext.fileArea.canManage && !state.loading && !state.error ? () => setDirectory({ scope: displayScope, name: displayContext.project?.name ?? displayContext.workspace.name, fileArea: displayContext.fileArea }) : undefined}
      onSessionSettings={() => setSessionSettingsOpen(true)}
      sessionSettingsDisabled={sessionSettingsDisabled}
    />}
    {!automationsView && <PmInspector key={JSON.stringify([displayScope?.workspaceId, displayScope?.projectId, localId, remoteId, displayContext?.fileArea.path, displayContext?.fileArea.revision, displayContext?.fileArea.status, state.error])}
      scope={displayScope} threadId={remoteId} path={displayContext?.fileArea.path} panel={inspectorPanel} onPanelChange={changeInspectorPanel}
      disabled={inspectorDisabled} />}
    {directory && <FileAreaDialog key={scopeKey(directory.scope)} {...directory} onClose={() => setDirectory(undefined)} />}
    {sessionSettingsOpen && <SessionSettingsDialog key={localId} settings={settings} providers={state.providers} providersLoading={state.providersLoading} providersError={state.providerError} onRefreshProviders={() => void refreshProviders()} saving={settingsSaving} onSave={setSettings} onClose={() => setSessionSettingsOpen(false)} />}
    {shortcutsOpen && <Dialog open onOpenChange={setShortcutsOpen}><DialogContent className="agent-session-dialog"><DialogHeader><DialogTitle>{t("对话快捷键", "Chat shortcuts")}</DialogTitle></DialogHeader><ShortcutCatalog /><DialogFooter><Button variant="outline" onClick={() => setShortcutsOpen(false)}>{t("关闭", "Close")}</Button></DialogFooter></DialogContent></Dialog>}
    {snoozeTarget && <Dialog open onOpenChange={(open) => { if (!open && !pending) setSnoozeTarget(undefined); }}><DialogContent>
      <DialogHeader><DialogTitle>{t("自定义稍后提醒 · Custom snooze", "Custom snooze")}</DialogTitle></DialogHeader>
      <Input type="datetime-local" aria-label={t("唤醒时间", "Wake time")} value={snoozeTime} onChange={(event) => setSnoozeTime(event.target.value)} />
      {snoozeTime && (!Number.isFinite(new Date(snoozeTime).getTime()) || new Date(snoozeTime).getTime() <= Date.now()) && <p role="alert" className="text-destructive">{t("请选择未来的时间。", "Choose a time in the future.")}</p>}
      <DialogFooter><Button variant="outline" onClick={() => setSnoozeTarget(undefined)}>{t("取消", "Cancel")}</Button><Button disabled={pending || !snoozeTime || !Number.isFinite(new Date(snoozeTime).getTime()) || new Date(snoozeTime).getTime() <= Date.now()} onClick={() => { sidebarAction(snoozeTarget, "snooze", { snoozedUntil: new Date(snoozeTime).toISOString() }); setSnoozeTarget(undefined); }}>{t("稍后提醒", "Snooze")}</Button></DialogFooter>
    </DialogContent></Dialog>}
    {sessionAction && <Dialog open onOpenChange={(open) => { if (!open && !pending) setSessionAction(undefined); }}><DialogContent>
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
  const openMenu = (row: HTMLElement) => row.querySelector<HTMLButtonElement>(".pm-agent-session-menu-trigger")?.click();
  const isRunning = running || !!thread?.sidebar.running;
  const current = active && !actions.automationsView;
  const timestamp = thread && (actions.sortByCreated ? thread.createdAt : thread.updatedAt);
  return <div className="pm-agent-session" data-active={current} onContextMenu={(event) => { if (!thread) return; event.preventDefault(); openMenu(event.currentTarget); }} onKeyDown={(event) => { if (thread && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) { event.preventDefault(); openMenu(event.currentTarget); } }}>
    <button type="button" className="pm-agent-session-select" disabled={actions.disabled} onClick={() => actions.onSwitch(id)} aria-current={current ? "page" : undefined} title={title}>
      <span className="pm-agent-session-meta"><span className="pm-agent-session-scope">{thread ? actions.scopeName(thread) : t("历史会话", "Past session")}</span><time dateTime={timestamp} title={timestamp}>{sessionTime(timestamp, t)}</time></span>
      <span className="pm-agent-session-main"><span className="pm-agent-session-title">{title}</span><span className="pm-agent-session-provider" title={thread ? actions.providerName(thread) : undefined}>{thread ? actions.providerName(thread) : t("正在读取", "Loading")}</span>{isRunning && <><Loader2Icon className="animate-spin" aria-hidden="true" /><span className="sr-only">{t("正在后台生成", "Generating in background")}</span></>}{thread?.sidebar.unread && <><span className="pm-session-unread" title={t("未读", "Unread")} aria-hidden="true" /><span className="sr-only">{t("未读", "Unread")}</span></>}</span>
      {thread?.sidebar.section === "snoozed" && <span className="sr-only">{t(`稍后提醒至 ${thread.sidebar.snoozedUntil}`, `Snoozed until ${thread.sidebar.snoozedUntil}`)}</span>}
    </button>
    {thread && <SessionMenu thread={thread} title={title} path={actions.path(thread)} disabled={actions.disabled} running={isRunning} filtered={actions.filtered(thread)} onSidebar={(action, options) => actions.onSidebar(thread, action, options)} onRename={() => actions.onAction(id, title, "rename")} onRegenerate={() => actions.onRegenerate(thread)} onCustomSnooze={() => actions.onSnooze(thread)} onFilter={() => actions.onFilter(thread)} onSettings={() => actions.onSettings(thread)} onArchive={() => actions.onArchive(id, thread)} onDelete={() => actions.onAction(id, title, "delete")} onError={actions.onError} />}
  </div>;
}
