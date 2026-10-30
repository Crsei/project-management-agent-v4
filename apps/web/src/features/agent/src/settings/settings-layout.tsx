import { Component, Suspense, createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useBeforeUnload, useBlocker, useLocation } from "react-router-dom";
import { ArrowLeft, ChartNoAxesCombined, ChevronRight, Database, FolderOpen, History, Info, Loader2, MessageSquare, Moon, Palette, Plug, RefreshCw, Server, Settings2, ShieldAlert, Sun } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { useTheme } from "@agent/hooks/use-theme";
import { useChatAppearance } from "./browser-preferences";
import { useAgentText } from "../i18n";
import { agentText } from "../i18n-text.ts";
import pmTheme from "@/views/pm/dashboards-views.module.css";
import "../../styles/pm-chat.css";
import "./settings.css";

export type SettingsGuardState = "clean" | "dirty" | "busy";
export type SettingsScope = "service" | "browser" | "workspace" | "session";

type GuardContextValue = (id: symbol, state: SettingsGuardState) => void;
const SettingsGuardContext = createContext<GuardContextValue | null>(null);

/** Each caller owns one registration; independent forms cannot clear each other's drafts. */
export function useSettingsGuard() {
  const register = useContext(SettingsGuardContext);
  if (!register) throw new Error("useSettingsGuard requires SettingsLayout.");
  const [id] = useState(() => Symbol("settings-draft"));
  const setGuard = useCallback((state: SettingsGuardState) => register(id, state), [id, register]);
  useEffect(() => () => register(id, "clean"), [id, register]);
  return useMemo(() => ({ setGuard }), [setGuard]);
}

const scopeLabels: Record<SettingsScope, [string, string]> = {
  service: ["本机 Agent 服务", "Local Agent service"],
  browser: ["此浏览器", "This browser"],
  workspace: ["工作区 / 项目", "Workspace / project"],
  session: ["当前会话", "Current session"],
};

export function SettingsSection({ title, scope, children }: {
  title: string;
  scope?: SettingsScope;
  children: ReactNode;
}) {
  const headingId = useId();
  const t = useAgentText();
  return <section className="settings-section" aria-labelledby={headingId}>
    <div className="settings-section-heading">
      <h2 id={headingId}>{title}</h2>
      {scope && <span className="settings-scope-badge">{t(scopeLabels[scope][0], scopeLabels[scope][1])}</span>}
    </div>
    <div className="settings-section-body">{children}</div>
  </section>;
}

export function SettingsNotice({ kind, children, onRetry }: {
  kind: "loading" | "error" | "info" | "success";
  children: ReactNode;
  onRetry?: () => void;
}) {
  const t = useAgentText();
  const Icon = kind === "loading" ? Loader2 : kind === "error" ? ShieldAlert : Info;
  return <div className="settings-notice" data-kind={kind} role={kind === "error" ? "alert" : kind === "info" ? "note" : "status"}>
    <Icon aria-hidden="true" className={kind === "loading" ? "animate-spin" : undefined} />
    <div>{children}</div>
    {onRetry && <Button variant="outline" size="sm" onClick={onRetry}><RefreshCw aria-hidden="true" />{t("重试读取", "Retry read")}</Button>}
  </div>;
}

const pages = [
  { id: "general", title: ["通用", "General"], icon: Settings2, group: "偏好设置" },
  { id: "providers", title: ["提供商", "Providers"], icon: Plug, group: "偏好设置" },
  { id: "usage", title: ["用量", "Usage"], icon: ChartNoAxesCombined, group: "偏好设置" },
  { id: "usage/config", title: ["用量与价格", "Usage"], icon: Database, group: "偏好设置" },
  { id: "appearance", title: ["外观", "Appearance"], icon: Palette, group: "偏好设置" },
  { id: "file-areas", title: ["文件区域", "File areas"], icon: FolderOpen, group: "会话与上下文" },
  { id: "history", title: ["历史与归档", "History"], icon: History, group: "会话与上下文" },
  { id: "diagnostics", title: ["诊断", "Diagnostics"], icon: Server, group: "本机服务" },
  { id: "storage", title: ["数据与存储", "Storage"], icon: Database, group: "本机服务" },
] as const;
const groups = [
  ["偏好设置", "Preferences"],
  ["会话与上下文", "Sessions & context"],
  ["本机服务", "Local service"],
] as const;

function workspaceReturnTo(state: unknown, search: string): string {
  const candidate = state && typeof state === "object" && "settingsReturnTo" in state ? state.settingsReturnTo : undefined;
  if (typeof candidate === "string" && (candidate === "/agent/workspace" || candidate.startsWith("/agent/workspace?") || candidate.startsWith("/agent/workspace#"))) return candidate;
  const source = new URLSearchParams(search);
  const params = new URLSearchParams();
  for (const name of ["workspace", "project", "thread", "returnTo"]) {
    const value = source.get(name);
    if (value) params.set(name, value);
  }
  const query = params.toString();
  return `/agent/workspace${query ? `?${query}` : ""}`;
}

class SettingsContentBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <SettingsNotice kind="error">
      <p>{agentText("无法显示此设置页面。请重新加载。", "This settings page could not be displayed. Reload the page.")}</p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>{agentText("重新加载页面", "Reload page")}</Button>
    </SettingsNotice>;
    return this.props.children;
  }
}

export function SettingsNotFound() {
  const t = useAgentText();
  return <SettingsNotice kind="error"><p>{t("404 · 此设置页面不存在。", "404 · This settings page does not exist.")}</p><Link to="/agent/settings/general">{t("前往通用设置", "Go to general settings")}</Link></SettingsNotice>;
}

export function SettingsLayout() {
  useChatAppearance();
  const t = useAgentText();
  const { theme, toggle } = useTheme();
  const location = useLocation();
  const [guards] = useState(() => new Map<symbol, SettingsGuardState>());
  const activeGuard = useRef<SettingsGuardState>("clean");
  const [guardState, setGuardState] = useState<SettingsGuardState>("clean");
  const heading = useRef<HTMLHeadingElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const page = pages.find((item) => location.pathname.replace(/\/+$/, "") === `/agent/settings/${item.id}`);
  const returnTo = workspaceReturnTo(location.state, location.search);
  const navigationState = useMemo(() => ({ settingsReturnTo: returnTo }), [returnTo]);
  const registerGuard = useCallback<GuardContextValue>((id, state) => {
    if (state === "clean") guards.delete(id);
    else guards.set(id, state);
    let next: SettingsGuardState = "clean";
    for (const value of guards.values()) {
      if (value === "busy") { next = "busy"; break; }
      next = "dirty";
    }
    if (activeGuard.current !== next) {
      activeGuard.current = next;
      setGuardState(next);
    }
  }, [guards]);
  const shouldBlock = useCallback(({ currentLocation, nextLocation }: {
    currentLocation: { pathname: string; search: string; hash: string };
    nextLocation: { pathname: string; search: string; hash: string };
  }) => activeGuard.current !== "clean" && (
    currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search || currentLocation.hash !== nextLocation.hash
  ), []);
  const blocker = useBlocker(shouldBlock);
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
    if (activeGuard.current === "clean") return;
    event.preventDefault();
    event.returnValue = "";
  }, []), { capture: true });

  const pageTitle = page ? t(page.title[0], page.title[1]) : t("页面不存在", "Page not found");
  const fullBleed = page?.id === "usage";

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${pageTitle} · ${t("Agent 设置", "Agent settings")}`;
    heading.current?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 767px)").matches) {
      navigation.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    return () => { document.title = previousTitle; };
  }, [location.pathname, pageTitle, t]);

  return <SettingsGuardContext.Provider value={registerGuard}>
    <div className={`settings-shell ${pmTheme.page}`}>
      <a className="settings-skip-link" href="#settings-content">{t("跳至设置内容", "Skip to settings")}</a>
      <aside className="settings-sidebar" aria-label={t("Agent 设置", "Agent settings")}>
        <Link to={returnTo} className="settings-product"><MessageSquare aria-hidden="true" /><span>Agent Chat</span></Link>
        <p className="settings-nav-caption">{t("设置", "Settings")}</p>
        <nav ref={navigation} className="settings-navigation" aria-label={t("设置页面", "Settings pages")}>
          {groups.map((group) => <div className="settings-nav-group" key={group[0]}>
            <p>{t(group[0], group[1])}</p>
            {pages.filter((item) => item.group === group[0] && !item.id.includes("/")).map((item) => <NavLink key={item.id} end={item.id !== "usage"} to={{ pathname: `/agent/settings/${item.id}`, search: location.search }} state={navigationState}>
              <item.icon aria-hidden="true" /><span>{t(item.title[0], item.title[1])}</span>
            </NavLink>)}
          </div>)}
        </nav>
        <div className="settings-sidebar-footer">
          <Link to={returnTo}><ArrowLeft aria-hidden="true" /><span>{t("返回对话", "Back to chat")}</span></Link>
          <Button size="icon-sm" variant="ghost" onClick={toggle} aria-label={theme === "dark" ? t("切换浅色主题", "Switch to light theme") : t("切换深色主题", "Switch to dark theme")}>{theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}</Button>
        </div>
      </aside>
      <main className="settings-main" id="settings-content" tabIndex={-1}>
        {fullBleed ? <SettingsContentBoundary key={location.pathname}>
          <Suspense fallback={<p role="status" className="p-8">{t("正在加载用量…", "Loading usage…")}</p>}><Outlet /></Suspense>
        </SettingsContentBoundary> : <>
          <header className="settings-breadcrumb"><span>{t("设置", "Settings")}</span><ChevronRight aria-hidden="true" /><h1 ref={heading} tabIndex={-1}>{pageTitle}</h1>
            <span className="settings-draft-status" role="status">{guardState === "busy" ? t("操作进行中", "Working") : guardState === "dirty" ? t("有未保存的修改", "Unsaved changes") : ""}</span>
          </header>
          <div className="settings-content">
            <SettingsContentBoundary key={location.pathname}>
              <Suspense fallback={<SettingsNotice kind="loading">{t("正在加载设置页面…", "Loading settings…")}</SettingsNotice>}><Outlet /></Suspense>
            </SettingsContentBoundary>
          </div>
        </>}
      </main>
    </div>
    <Dialog open={blocker.state === "blocked"} onOpenChange={(open) => { if (!open && blocker.state === "blocked") blocker.reset(); }}>
      <DialogContent showCloseButton={false} className="settings-leave-dialog">
        <DialogHeader>
          <DialogTitle>{guardState === "busy" ? t("请等待当前操作完成", "Wait for the current operation") : guardState === "dirty" ? t("放弃未保存的修改？", "Discard unsaved changes?") : t("继续离开设置？", "Leave settings?")}</DialogTitle>
          <DialogDescription>{guardState === "busy" ? t("当前操作尚未完成，请等待结果后再离开。离开页面不会自动取消服务端操作。", "The current operation is still running. Wait for the result before leaving; leaving does not cancel server work.") : guardState === "dirty" ? t("此页面有未保存的设置。离开将放弃这些修改；留在此页可继续编辑或保存。", "This page has unsaved settings. Leaving discards them; stay to keep editing or save.") : t("当前操作已结束，可以继续前往刚才选择的页面。", "The operation finished. Continue to the selected page.")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" autoFocus onClick={() => { if (blocker.state === "blocked") blocker.reset(); }}>{t("留在此页", "Stay on this page")}</Button>
          {guardState !== "busy" && <Button onClick={() => { if (blocker.state === "blocked" && activeGuard.current !== "busy") blocker.proceed(); }}>{guardState === "dirty" ? t("放弃修改并离开", "Discard and leave") : t("继续离开", "Leave")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </SettingsGuardContext.Provider>;
}
