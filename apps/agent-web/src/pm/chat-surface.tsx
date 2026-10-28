import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useAui, useAuiState, ThreadListPrimitive, type AssistantRuntime } from "@assistant-ui/react";
import { ArrowLeftIcon, ChartNoAxesCombinedIcon, FolderIcon, KeyboardIcon, Loader2Icon, MenuIcon, MessageSquareIcon, PanelBottomIcon, PanelRightIcon, PlusIcon, SearchIcon, SettingsIcon, SlidersHorizontalIcon, XIcon, ZapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { useChatSettings } from "@/hooks/use-chat-settings";
import { ChatContinuity } from "../chat/continuity";
import { UsageNavigationLink } from "../usage/navigation";
import { initializeScopedThread, refreshThreadList } from "../chat/remote-adapter";
import { FileAreaDialog } from "./file-area-dialog";
import { DEFAULT_INSPECTOR_PANEL, PmInspector, type InspectorPanel } from "./inspector";
import { TerminalDrawer, TERMINAL_DRAWER_MIN_HEIGHT } from "./terminal-drawer";
import { ProductSwitcher } from "./product-switcher";
import { UserMenu } from "./user-menu";
import { useChatDrafts } from "./drafts";
import { SessionMenu } from "./session-menu";
import { workspaceClient } from "../network";
import type { RemoteThread } from "@agent-workspace/contracts/chat";
import SessionSettingsDialog from "../settings/session-settings-dialog";
import { ShortcutCatalog } from "../settings/input-preferences";
import { useChatAppearance } from "../settings/browser-preferences";
import { acceptRemoteThread, availableProviderModel, bindDraftScope, canSendThread, refreshCatalog, refreshIdentity, refreshProviders, sameScope, scopeContext, scopeKey, threadScope, usePmChatState, type AgentScope, type AgentFileArea } from "./state";
import pmTheme from "../../../web/src/views/pm/dashboards-views.module.css";
import "../../styles/pm-chat.css";

const AutomationPage = lazy(() => import("./automation/page").then(module => ({ default: module.AutomationPage })));

type ScopeGroup = { scope: AgentScope; name: string; fileArea: AgentFileArea };
const SessionActions = createContext<{
  disabled: boolean;
  onSwitch: (id: string) => void;
  onAction: (id: string, name: string, kind: "rename" | "delete") => void;
  thread: (id: string) => RemoteThread | undefined;
  path: (thread: RemoteThread) => string | null | undefined;
  titleUnavailable: (thread: RemoteThread) => string | undefined;
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
function fileAreaLabel(area?: AgentFileArea) {
  return !area ? "未选择上下文" : area.status === "available" ? area.reason === "initializes_on_first_use" ? "默认目录 · 首次使用时创建" : "目录可用" : area.status === "unconfigured" ? "未配置目录" : "目录不可用";
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

export function PmChatSurface({ runtime }: { runtime: AssistantRuntime }) {
  const aui = useAui();
  const state = usePmChatState();
  const location = useLocation();
  useChatAppearance();
  const [params, setParams] = useSearchParams();
  const initialScope = useRef(requestedScope(params));
  const [selectedScope, setSelectedScope] = useState<AgentScope | undefined>(initialScope.current);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<AgentScope>();
  const [snoozeTarget, setSnoozeTarget] = useState<RemoteThread>();
  const [snoozeTime, setSnoozeTime] = useState("");
  const visitedThread = useRef<string | undefined>(undefined);
  const [visiting, setVisiting] = useState(false);
  const currentRemote = useRef<string | undefined>(undefined);
  const wasRunning = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
  const threadLoading = useAuiState((s) => s.thread.isLoading);
  const threadRunning = useAuiState((s) => s.thread.isRunning);
  const switchError = useAuiState((s) => s.threads.switchError);
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const title = threadItems.find((item) => item.id === localId)?.title;
  const scope = threadScope(localId, remoteId);
  const context = scopeContext(state.catalog, scope);
  const displayScope = scope ?? (!remoteId ? selectedScope : undefined);
  const displayContext = scopeContext(state.catalog, displayScope);
  const automationsView = params.get("view") === "automations";
  const automationWorkspace = state.identity?.workspaces.find((workspace) => workspace.id === displayScope?.workspaceId);
  const { protect, storageError } = useChatDrafts(runtime, displayScope);
  const initialize = useCallback(async () => (await aui.threads.item({ id: localId }).initialize()).remoteId, [aui, localId]);
  const { settings, setSettings, ready: settingsReady, settingsLoaded, loading: settingsLoading, saving: settingsSaving, error: settingsError, retry } = useChatSettings(remoteId, initialize, localId);
  const provider = state.providers.find((item) => item.instanceId === settings.providerInstanceId);

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
    void workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(remoteId)}/sidebar`, {
      method: "POST", body: JSON.stringify({ action: "visit", revision: thread.sidebar.revision }),
    }).then(({ thread: saved }) => { if (currentRemote.current === remoteId) acceptRemoteThread(saved); }).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
      void refreshThreadList().catch(() => {});
    }).finally(() => { if (currentRemote.current === remoteId) setVisiting(false); });
  }, [remoteId, state.threads]);
  useEffect(() => {
    if (!remoteId && !scope && selectedScope && scopeContext(state.catalog, selectedScope)) bindDraftScope(localId, selectedScope);
  }, [localId, remoteId, scope, selectedScope, state.catalog]);
  useEffect(() => {
    if (threadsLoading || state.loading) return;
    const next = new URLSearchParams(params);
    if (displayScope) {
      try { sessionStorage.setItem("pm-v3:agent-scope", JSON.stringify(displayScope)); } catch { /* URL remains authoritative for this mounted view. */ }
      next.set("workspace", displayScope.workspaceId);
      if (displayScope.projectId) next.set("project", displayScope.projectId); else next.delete("project");
    } else { next.delete("workspace"); next.delete("project"); }
    if (remoteId) next.set("thread", remoteId); else next.delete("thread");
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [displayScope, remoteId, threadsLoading, state.loading, params, setParams]);

  const act = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true); setActionError(undefined);
    try { await action(); } catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  const setAutomationView = (open: boolean) => {
    const next = new URLSearchParams(params);
    if (open) next.set("view", "automations"); else next.delete("view");
    setParams(next, { replace: false });
  };
  const selectScope = (target: AgentScope, create = false) => {
    if (automationsView) setAutomationView(false);
    if (!create && sameScope(scope, target)) { setSidebarOpen(false); return; }
    if (!protect()) return;
    void act(async () => {
      const key = scopeKey(target);
      const id = creationIds.current.get(key) ?? crypto.randomUUID();
      creationIds.current.set(key, id);
      bindDraftScope(id, target);
      await initializeScopedThread(id);
      await refreshThreadList();
      await runtime.threads.switchToThread(id);
      creationIds.current.delete(key);
      setSelectedScope(target);
      setSidebarOpen(false);
    });
  };
  const switchSession = (id: string) => {
    if (automationsView) setAutomationView(false);
    if (!protect()) return;
    if (id === localId) {
      const thread = remoteId && state.threads.get(remoteId);
      if (thread) void act(async () => {
        const saved = await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}/sidebar`, { method: "POST", body: JSON.stringify({ action: "visit", revision: thread.sidebar.revision }) });
        acceptRemoteThread(saved.thread);
      });
      setSidebarOpen(false); return;
    }
    void act(async () => { await runtime.threads.switchToThread(id); setSidebarOpen(false); });
  };
  const openAction = (id: string, sessionName: string, kind: "rename" | "delete") => {
    setSessionAction({ id, title: sessionName, kind }); setSessionTitle(sessionName);
  };
  const commitSessionAction = () => {
    if (!sessionAction) return;
    if (sessionAction.kind === "delete" && sessionAction.id === localId && !protect()) return;
    void act(async () => {
      const item = runtime.threads.getItemById(sessionAction.id);
      if (sessionAction.kind === "rename") await item.rename(sessionTitle.trim());
      else await item.delete();
      await refreshThreadList();
      setSessionAction(undefined);
    });
  };
  const sidebarAction = (thread: RemoteThread, action: "pin" | "unpin" | "settle" | "unsettle" | "snooze" | "wake" | "auto-settle" | "mark-unread" | "visit", options?: { snoozedUntil?: string; enabled?: boolean }) => {
    const parkingCurrent = thread.remoteId === remoteId && (action === "settle" || action === "snooze");
    if (parkingCurrent && !protect()) return;
    void act(async () => {
      try {
        const result = await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}/sidebar`, {
          method: "POST", body: JSON.stringify({ action, revision: thread.sidebar.revision, ...options }),
        });
        acceptRemoteThread(result.thread);
        if (parkingCurrent && ((action === "settle" && result.thread.sidebar.section === "settled") || (action === "snooze" && result.thread.sidebar.section === "snoozed"))) {
          setSelectedScope(thread.scope);
          await runtime.threads.switchToNewThread();
        }
      } catch (error) {
        await refreshThreadList().catch(() => {});
        throw error;
      }
    });
  };
  const renderSessions = (target?: AgentScope, orphan = false) => {
    const indices = threadIds.map((id, index) => {
      const item = threadItems.find((candidate) => candidate.id === id);
      return { id, index, item, thread: item?.remoteId ? state.threads.get(item.remoteId) : undefined };
    }).filter(({ item, thread }) => {
      if (!item?.remoteId) return false;
      const owner = thread?.scope;
      const matches = orphan ? !owner || !scopeContext(state.catalog, owner) : sameScope(owner, target);
      return matches && (!search.trim() || (item.title ?? "新会话").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
    });
    const rows = (section: "pinned" | "active" | "snoozed" | "settled") => indices.filter(({ thread }) => (thread?.sidebar.section ?? "active") === section).sort((a, b) => {
      if (section === "pinned") return (b.thread?.sidebar.pinnedAt ?? "").localeCompare(a.thread?.sidebar.pinnedAt ?? "");
      if (section === "snoozed") return (a.thread?.sidebar.snoozedUntil ?? "").localeCompare(b.thread?.sidebar.snoozedUntil ?? "");
      return 0;
    }).map(({ id, index }) => <ThreadListPrimitive.ItemByIndex key={id} index={index} components={{ ThreadListItem: SessionRow }} />);
    const pinned = rows("pinned"), active = rows("active"), snoozed = rows("snoozed"), settled = rows("settled");
    return <div className="pm-agent-sessions">
      {pinned.length > 0 && <><div className="pm-session-section-label">置顶 · Pinned</div>{pinned}</>}
      {active.length > 0 && <><div className="pm-session-section-label">会话 · Active</div>{active}</>}
      {snoozed.length > 0 && <details className="pm-session-section" open={search.trim() ? true : undefined}><summary>稍后提醒 · Snoozed ({snoozed.length})</summary>{snoozed}</details>}
      {settled.length > 0 && <details className="pm-session-section" open={search.trim() ? true : undefined}><summary>已归置 · Settled ({settled.length})</summary>{settled}</details>}
      {!indices.length && <p className="pm-agent-empty-group">{search ? "没有匹配会话" : "暂无会话"}</p>}
    </div>;
  };
  const renderGroup = (group: ScopeGroup) => <div className="pm-agent-scope-group" key={scopeKey(group.scope)}>
    <div className="pm-agent-scope-row" data-active={sameScope(displayScope, group.scope)}>
      <button type="button" className="pm-agent-scope-select" disabled={pending} onClick={() => selectScope(group.scope)} title={group.name}>
        {group.scope.projectId ? <FolderIcon /> : <MessageSquareIcon />}<span>{group.name}</span>
        {group.fileArea.status !== "available" && <span className="pm-agent-scope-warning" title={fileAreaLabel(group.fileArea)} aria-label={fileAreaLabel(group.fileArea)}>!</span>}
      </button>
      <button type="button" className="pm-agent-icon" aria-label={`配置${group.name}文件区域`} title="配置文件区域" onClick={() => setDirectory(group)}><SettingsIcon /></button>
      <button type="button" className="pm-agent-icon" disabled={pending} aria-label={`在${group.name}新建会话`} title="新建会话" onClick={() => selectScope(group.scope, true)}><PlusIcon /></button>
    </div>
    {renderSessions(group.scope)}
  </div>;
  const providerStatus = state.providersLoading ? "正在读取 Provider…" : state.providerError ? `Provider 状态读取失败：${state.providerError}`
    : !settings.providerInstanceId || !settings.model ? "尚未选择模型；请设置当前会话，或在通用设置中选择新会话默认模型。"
    : !provider ? `所选 Provider 不可用：${settings.providerInstanceId}` : !provider.enabled ? `${provider.label} 已停用；请明确启用或重新选择。` : !provider.configured ? `${provider.label} 未配置：${provider.message ?? provider.authLabel ?? "请先完成配置"}`
    : !provider.models.some((item) => item.id === settings.model) ? `所选模型不再可用：${settings.model}；不会自动替换。`
    : `${provider.label} · ${settings.model} · 已配置（不代表已连通）`;
  const noScope = !scope;
  const inspectorDisabled = !state.catalog || !!state.error || !displayContext || displayContext.fileArea.status !== "available" || (!!remoteId && !scope);
  const changeInspectorPanel = (next: InspectorPanel | null) => {
    setInspectorPanel(next);
    if (next) setLastInspectorPanel(next);
  };
  const toggleRightPanel = () => changeInspectorPanel(inspectorPanel ? null : lastInspectorPanel);
  const toggleTerminalDrawer = () => setTerminalOpen((value) => !value);
  const pmHref = safeReturnTo(params.get("returnTo"), displayScope);
  const settingsNavigation = { settingsReturnTo: `/workspace${location.search}` };
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"]')) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], details[open]')) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.altKey && !event.shiftKey && event.key.toLowerCase() === "b" && !automationsView) {
        event.preventDefault();
        if (!inspectorDisabled) toggleRightPanel();
      } else if (modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j" && !automationsView) {
        event.preventDefault();
        if (!inspectorDisabled) toggleTerminalDrawer();
      } else if (event.altKey) {
        return;
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === "o" && !pending && displayScope && displayContext) {
        event.preventDefault(); selectScope(displayScope, true);
      } else if (modifier && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault(); setSidebarOpen(true);
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

  return <div className={`pm-agent-chat ${pmTheme.page}`}>
    {sidebarOpen && <button type="button" className="pm-agent-sidebar-backdrop" aria-label="关闭会话侧栏" onClick={() => setSidebarOpen(false)} />}
    <aside className="pm-agent-sidebar" data-open={sidebarOpen} aria-label="工作区与会话">
      <header className="pm-agent-product">
        <ProductSwitcher scope={displayScope} pending={pending} canLeave={protect} pmHref={pmHref} onSelectScope={selectScope} />
        <button type="button" className="pm-agent-icon pm-agent-mobile-close" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)}><XIcon /></button>
      </header>
      <div className="pm-agent-sidebar-controls">
        <nav className="pm-agent-app-tabs" role="tablist" aria-label="Agent Chat 功能">
          <button type="button" role="tab" aria-selected={!automationsView} onClick={() => setAutomationView(false)}><MessageSquareIcon />对话</button>
          <button type="button" role="tab" aria-selected={automationsView} disabled={!displayScope} title={!displayScope ? "请先选择工作区" : undefined} onClick={() => setAutomationView(true)}><ZapIcon />自动化</button>
        </nav>
        <UsageNavigationLink className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:outline-2" onClick={(event) => { if (!protect()) event.preventDefault(); else setSidebarOpen(false); }}><ChartNoAxesCombinedIcon className="size-4" />用量</UsageNavigationLink>
        <Button variant="outline" className="w-full justify-start" disabled={pending || !displayScope || !displayContext} onClick={() => { if (displayScope) selectScope(displayScope, true); }}><PlusIcon />新建会话</Button>
        <label className="pm-agent-search"><SearchIcon /><Input ref={searchInput} type="search" aria-label="搜索会话" placeholder="搜索会话…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        {projectFilter && <button type="button" className="pm-session-filter" onClick={() => setProjectFilter(undefined)}>筛选：{scopeContext(state.catalog, projectFilter)?.project?.name ?? projectFilter.projectId} · 显示所有项目 ×</button>}
        {actionError && <p role="alert" className="pm-agent-sidebar-error">{actionError}</p>}
      </div>
      <SessionActions.Provider value={{
        disabled: pending || visiting, onSwitch: switchSession, onAction: openAction,
        thread: (id) => state.threads.get(id),
        path: (thread) => scopeContext(state.catalog, thread.scope)?.fileArea.path,
        titleUnavailable: (thread) => {
          if (state.providersLoading || state.providerError) return undefined;
          const selected = state.providers.find((candidate) => candidate.instanceId === thread.settings.providerInstanceId);
          if (!selected || !selected.enabled) return "请先为此会话选择并启用 Provider。";
          if (selected.driver !== "codex" && selected.driver !== "claude") return "此 Provider 暂不支持隔离的标题生成；需要 Codex 或 Claude。";
          return undefined;
        },
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
          else setActionError("此会话的原始作用域不可访问，无法配置文件区域。");
        },
        onArchive: (id, thread) => {
          if (id === localId && !protect()) return;
          void act(async () => {
            const current = (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}`)).thread;
            const catalog = await refreshCatalog();
            if (!current.scope || !scopeContext(catalog, current.scope)) throw new Error("此历史会话没有可访问的原始作用域，不能归档，也不会重新归属。请刷新 PM 访问范围。");
            const saved = current.status === "archived" ? current : (await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}`, { method: "PUT", body: JSON.stringify({ status: "archived" }) })).thread;
            acceptRemoteThread(saved);
            await refreshThreadList();
            if (id === localId) { setSelectedScope(displayScope); await runtime.threads.switchToNewThread(); }
          });
        },
        onError: setActionError,
      }}><nav className="pm-agent-catalog" aria-label="真实 PM 工作区与项目">
        {state.loading && !state.catalog && <p role="status">正在读取工作区…</p>}
        {state.error && <div role="alert" className="pm-agent-sidebar-error">工作区读取失败：{state.error}<Button variant="outline" size="sm" onClick={() => void refreshCatalog().catch(() => {})}>重新读取</Button><a href="/pm" onClick={(event) => { if (!protect()) event.preventDefault(); }}>前往 PM 登录</a></div>}
        {state.catalog?.workspaces.filter((workspace) => !projectFilter || workspace.id === projectFilter.workspaceId).map((workspace) => <section className="pm-agent-workspace" key={workspace.id}>
          <h2>{workspace.name}</h2>
          {!projectFilter && renderGroup({ scope: { workspaceId: workspace.id, projectId: null }, name: "工作区会话", fileArea: workspace.fileArea })}
          <div className="pm-agent-projects-label">项目</div>
          {workspace.projects.filter((project) => !projectFilter || project.id === projectFilter.projectId).map((project) => renderGroup({ scope: { workspaceId: workspace.id, projectId: project.id }, name: project.name, fileArea: project.fileArea }))}
          {!workspace.projects.length && <p className="pm-agent-empty-group">此工作区暂无项目</p>}
        </section>)}
        {!state.loading && !state.error && !state.catalog?.workspaces.length && <p className="pm-agent-empty-catalog">没有可访问的 PM 工作区。请先在 PM 中登录或创建工作区。</p>}
        {threadsLoading && <p role="status" className="pm-agent-empty-group">正在恢复会话…</p>}
        {state.threadError && <div role="alert" className="pm-agent-sidebar-error">会话读取失败：{state.threadError}<Button size="sm" variant="outline" onClick={() => void act(refreshThreadList)}>重试</Button></div>}
        {!projectFilter && threadItems.some((item) => item.remoteId && (!state.threads.get(item.remoteId)?.scope || !scopeContext(state.catalog, state.threads.get(item.remoteId)?.scope))) && <section className="pm-agent-workspace"><h2>其他历史会话</h2><p className="pm-agent-empty-group">无作用域或当前不可访问的历史；不会重新归属。</p>{renderSessions(undefined, true)}</section>}
      </nav></SessionActions.Provider>
      <footer className="pm-agent-sidebar-footer"><UserMenu workspaceId={displayScope?.workspaceId} canLeave={protect} onShortcuts={() => setShortcutsOpen(true)} /></footer>
    </aside>
    <main className="pm-agent-main">
      {automationsView ? (automationWorkspace && displayScope
        ? <Suspense fallback={<div className="pm-agent-automation-empty" role="status">正在加载自动化…</div>}><AutomationPage key={automationWorkspace.id} workspace={automationWorkspace} actorId={state.identity!.actor.id} root={`/pm/${encodeURIComponent(automationWorkspace.id)}`} onExit={() => setAutomationView(false)} onRecheckAccess={() => { void refreshIdentity(); }} /></Suspense>
        : <section className="pm-agent-automation-empty"><ZapIcon /><h1>需要先选择工作区</h1><p>自动化规则属于 PM 工作区；请从左侧选择工作区后再打开。</p><Button variant="outline" onClick={() => setAutomationView(false)}>返回对话</Button></section>) : <>
      <header className="pm-agent-context-header">
        <button type="button" className="pm-agent-icon pm-agent-mobile-menu" aria-label="打开工作区与会话" onClick={() => setSidebarOpen(true)}><MenuIcon /></button>
        <div className="pm-agent-context-title"><div>{displayContext ? <><span>{displayContext.workspace.name}</span><span aria-hidden> / </span><strong>{displayContext.project?.name ?? "工作区会话"}</strong></> : <strong>{remoteId ? "历史会话（无可用作用域）" : "选择工作区或项目"}</strong>}</div><small>{title ?? "新会话"}</small></div>
        <button type="button" className="pm-agent-icon" aria-label="当前会话参数" title="当前会话参数" disabled={!scope || !settingsLoaded || settingsLoading || settingsSaving || threadRunning || threadLoading || threadsLoading || pending} onClick={() => setSessionSettingsOpen(true)}><SlidersHorizontalIcon /></button>
        <button type="button" className="pm-agent-icon" aria-label="快捷键帮助" title="快捷键帮助" onClick={() => setShortcutsOpen(true)}><KeyboardIcon /></button>
        <button type="button" className="pm-agent-icon" aria-label="切换终端抽屉" aria-pressed={terminalOpen} title="切换终端抽屉 (Ctrl / ⌘ + J)" disabled={inspectorDisabled} onClick={toggleTerminalDrawer}><PanelBottomIcon /></button>
        <button type="button" className="pm-agent-icon" aria-label="切换右侧面板" aria-pressed={!!inspectorPanel} title="切换右侧面板 (Ctrl / ⌘ + Alt + B)" disabled={inspectorDisabled} onClick={toggleRightPanel}><PanelRightIcon /></button>
        <a className="pm-agent-back" href={pmHref} aria-label="返回 PM" title="返回 PM" onClick={(event) => { if (!protect()) event.preventDefault(); }}><ArrowLeftIcon /><span>返回 PM</span></a>
      </header>
      <section className="pm-agent-context-status" aria-label="当前执行上下文">
        <div><span className="pm-agent-status-dot" data-status={displayContext?.fileArea.status ?? "unconfigured"} /><strong>{fileAreaLabel(displayContext?.fileArea)}</strong><code title={displayContext?.fileArea.path ?? ""}>{displayContext?.fileArea.path ?? displayContext?.fileArea.reason ?? "请选择明确作用域并配置执行目录"}</code>
          {displayContext && displayScope && <Button size="sm" variant="ghost" onClick={() => setDirectory({ scope: displayScope, name: displayContext.project?.name ?? displayContext.workspace.name, fileArea: displayContext.fileArea })}>配置目录</Button>}</div>
        <div className="pm-agent-provider-status"><span>{providerStatus}</span>{(!provider?.configured || state.providerError) && <Link to="/settings/providers" state={settingsNavigation} onClick={(event) => { if (!protect()) event.preventDefault(); }}>配置 Provider</Link>}<button type="button" onClick={() => { void refreshProviders(); void refreshCatalog().catch(() => {}); }}>刷新状态</button></div>
      </section>
      {(noScope || !context || context.fileArea.status !== "available" || state.error) && <p className="pm-agent-notice">{remoteId && noScope ? "此历史会话没有绑定作用域，仅供查看。请在左侧选择真实工作区或项目新建会话。" : initialScope.current && !scopeContext(state.catalog, initialScope.current) && !state.loading ? "入口工作区或项目不可访问，请从左侧重新选择；不会自动绑定其他项目。" : "发送前请先选择工作区或项目，并配置可用的文件区域。历史会话的归属不会随选择改变。"}</p>}
      {settingsLoaded && (!settings.providerInstanceId || !settings.model) && <p className="pm-agent-notice">尚未选择有效模型，不会自动使用其他 Provider。<Button size="sm" variant="outline" disabled={!scope || settingsLoading || settingsSaving || threadRunning || threadLoading || threadsLoading || pending} onClick={() => setSessionSettingsOpen(true)}>选择当前会话模型</Button><Link to="/settings/general" state={settingsNavigation} onClick={(event) => { if (!protect()) event.preventDefault(); }}>设置新会话默认值</Link></p>}
      {settingsError && <div role="alert" className="pm-agent-notice">会话设置未保存，输入已保留：{settingsError}<Button size="sm" variant="outline" onClick={() => void retry().catch(() => {})}>重试保存设置</Button></div>}
      {(actionError || storageError) && <p role="alert" className="pm-agent-notice pm-agent-error">{actionError ?? storageError}</p>}
      {switchError && <p role="alert" className="pm-agent-notice pm-agent-error">无法恢复会话：{switchError.error instanceof Error ? switchError.error.message : String(switchError.error)}<Button size="sm" variant="outline" onClick={() => void act(() => runtime.threads.switchToThread(switchError.threadId))}>重试打开会话</Button></p>}
      <ChatContinuity runtime={runtime} canContinue={settingsReady && !settingsSaving && !settingsError && canSendThread(localId, remoteId, settings.providerInstanceId, settings.model)} />
      <div className="pm-agent-conversation" onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest("a[href]") && !protect()) { event.preventDefault(); event.stopPropagation(); }
      }}><Thread
        providerInstanceId={settings.providerInstanceId}
        model={settings.model}
        catalog={{ providers: state.providers, loading: state.providersLoading, error: state.providerError, refresh: refreshProviders }}
        disabled={!scope || !settingsLoaded || settingsLoading || state.loading || !!state.error || pending || threadRunning || threadLoading || threadsLoading}
        saving={settingsSaving}
        saveError={settingsError}
        onRetry={retry}
        onModelChange={async (providerInstanceId, model) => {
          if (!scope || !settingsLoaded || settingsLoading || settingsSaving || state.loading || state.error || pending || threadRunning || threadLoading || threadsLoading)
            throw new Error("当前会话暂时无法更改模型。");
          if (!availableProviderModel(providerInstanceId, model))
            throw new Error("模型目录已变化，请刷新后重新选择。");
          await setSettings({ providerInstanceId, model });
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
      <div className="pm-agent-chat-footnote">离开页面不会停止后台回复。目录只决定执行位置，不代表额外权限或隔离沙箱。</div>
      </>}
    </main>
    {!automationsView && <PmInspector key={JSON.stringify([displayScope?.workspaceId, displayScope?.projectId, localId, remoteId, displayContext?.fileArea.path, displayContext?.fileArea.revision, displayContext?.fileArea.status, state.error])}
      scope={displayScope} threadId={remoteId} path={displayContext?.fileArea.path} panel={inspectorPanel} onPanelChange={changeInspectorPanel}
      disabled={inspectorDisabled} />}
    {directory && <FileAreaDialog key={scopeKey(directory.scope)} {...directory} onClose={() => setDirectory(undefined)} />}
    {sessionSettingsOpen && <SessionSettingsDialog key={localId} settings={settings} providers={state.providers} providersLoading={state.providersLoading} providersError={state.providerError} onRefreshProviders={() => void refreshProviders()} saving={settingsSaving} onSave={setSettings} onClose={() => setSessionSettingsOpen(false)} />}
    {shortcutsOpen && <Dialog open onOpenChange={setShortcutsOpen}><DialogContent className="agent-session-dialog"><DialogHeader><DialogTitle>对话快捷键</DialogTitle><DialogDescription>操作真实会话；弹窗、菜单与其他输入不会被全局快捷键接管。</DialogDescription></DialogHeader><ShortcutCatalog /><DialogFooter><Button variant="outline" onClick={() => setShortcutsOpen(false)}>关闭</Button></DialogFooter></DialogContent></Dialog>}
    {snoozeTarget && <Dialog open onOpenChange={(open) => { if (!open && !pending) setSnoozeTarget(undefined); }}><DialogContent>
      <DialogHeader><DialogTitle>自定义稍后提醒 · Custom snooze</DialogTitle><DialogDescription>选择本地时间，届时会话将自动唤醒。</DialogDescription></DialogHeader>
      <Input type="datetime-local" aria-label="唤醒时间" value={snoozeTime} onChange={(event) => setSnoozeTime(event.target.value)} />
      {snoozeTime && (!Number.isFinite(new Date(snoozeTime).getTime()) || new Date(snoozeTime).getTime() <= Date.now()) && <p role="alert" className="text-destructive">请选择未来的时间。</p>}
      <DialogFooter><Button variant="outline" onClick={() => setSnoozeTarget(undefined)}>取消</Button><Button disabled={pending || !snoozeTime || !Number.isFinite(new Date(snoozeTime).getTime()) || new Date(snoozeTime).getTime() <= Date.now()} onClick={() => { sidebarAction(snoozeTarget, "snooze", { snoozedUntil: new Date(snoozeTime).toISOString() }); setSnoozeTarget(undefined); }}>稍后提醒</Button></DialogFooter>
    </DialogContent></Dialog>}
    {sessionAction && <Dialog open onOpenChange={(open) => { if (!open && !pending) setSessionAction(undefined); }}><DialogContent>
      <DialogHeader><DialogTitle>{sessionAction.kind === "rename" ? "重命名会话" : "删除会话"}</DialogTitle><DialogDescription>{sessionAction.kind === "delete" ? `永久删除“${sessionAction.title}”的真实历史；若仍在生成，服务端会先请求并等待取消。不会撤销已发生的外部操作。` : "名称保存到真实会话，不会更改工作区或项目归属。"}</DialogDescription></DialogHeader>
      {sessionAction.kind === "rename" && <Input autoFocus aria-label="会话名称" value={sessionTitle} onChange={(event) => setSessionTitle(event.target.value)} />}
      {actionError && <p role="alert" className="text-destructive">{actionError}</p>}
      <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setSessionAction(undefined)}>取消</Button><Button variant={sessionAction.kind === "delete" ? "destructive" : "default"} disabled={pending || (sessionAction.kind === "rename" && !sessionTitle.trim())} onClick={commitSessionAction}>{pending ? "正在保存…" : sessionAction.kind === "rename" ? "保存名称" : "删除会话"}</Button></DialogFooter>
    </DialogContent></Dialog>}
  </div>;
}

function SessionRow() {
  const actions = useContext(SessionActions)!;
  const id = useAuiState((s) => s.threadListItem.id);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const active = useAuiState((s) => s.threads.mainThreadId === s.threadListItem.id);
  const title = useAuiState((s) => s.threadListItem.title) ?? "新会话";
  const running = useAuiState((s) => s.threadListItem.isRunning);
  const thread = remoteId ? actions.thread(remoteId) : undefined;
  const openMenu = (row: HTMLElement) => row.querySelector<HTMLButtonElement>(".pm-agent-session-menu-trigger")?.click();
  const isRunning = running || !!thread?.sidebar.running;
  return <div className="pm-agent-session" data-active={active} onContextMenu={(event) => { if (!thread) return; event.preventDefault(); openMenu(event.currentTarget); }} onKeyDown={(event) => { if (thread && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) { event.preventDefault(); openMenu(event.currentTarget); } }}>
    <button type="button" className="pm-agent-session-select" disabled={actions.disabled} onClick={() => actions.onSwitch(id)} aria-current={active ? "page" : undefined} title={title}>{isRunning ? <Loader2Icon className="animate-spin" /> : <MessageSquareIcon />}<span>{title}</span>{isRunning && <span className="sr-only">正在后台生成</span>}{thread?.sidebar.unread && <span className="pm-session-unread" title="未读" aria-label="未读" />}{thread?.sidebar.section === "snoozed" && <span className="sr-only">稍后提醒至 {thread.sidebar.snoozedUntil}</span>}</button>
    {thread && <SessionMenu thread={thread} title={title} path={actions.path(thread)} disabled={actions.disabled} running={isRunning} titleUnavailable={actions.titleUnavailable(thread)} filtered={actions.filtered(thread)} onSidebar={(action, options) => actions.onSidebar(thread, action, options)} onRename={() => actions.onAction(id, title, "rename")} onRegenerate={() => actions.onRegenerate(thread)} onCustomSnooze={() => actions.onSnooze(thread)} onFilter={() => actions.onFilter(thread)} onSettings={() => actions.onSettings(thread)} onArchive={() => actions.onArchive(id, thread)} onDelete={() => actions.onAction(id, title, "delete")} onError={actions.onError} />}
  </div>;
}
