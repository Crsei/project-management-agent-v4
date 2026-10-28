import { Component, Suspense, createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useBeforeUnload, useBlocker, useLocation } from "react-router-dom";
import { ArrowLeft, ChevronRight, Database, FolderOpen, History, Info, Loader2, MessageSquare, Monitor, Moon, Palette, Plug, RefreshCw, Server, Settings2, ShieldAlert, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTheme } from "@/hooks/use-theme";
import { useChatAppearance } from "./browser-preferences";
import pmTheme from "../../../web/src/views/pm/dashboards-views.module.css";
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

const scopeLabels: Record<SettingsScope, string> = {
  service: "本机 Agent 服务",
  browser: "此浏览器",
  workspace: "工作区 / 项目",
  session: "当前会话",
};

export function SettingsSection({ title, description, scope, children }: {
  title: string;
  description?: string;
  scope?: SettingsScope;
  children: ReactNode;
}) {
  const headingId = useId();
  return <section className="settings-section" aria-labelledby={headingId}>
    <div className="settings-section-heading">
      <h2 id={headingId}>{title}</h2>
      {scope && <span className="settings-scope-badge">{scopeLabels[scope]}</span>}
    </div>
    {description && <p className="settings-section-description">{description}</p>}
    <div className="settings-section-body">{children}</div>
  </section>;
}

export function SettingsNotice({ kind, children, onRetry }: {
  kind: "loading" | "error" | "info" | "success";
  children: ReactNode;
  onRetry?: () => void;
}) {
  const Icon = kind === "loading" ? Loader2 : kind === "error" ? ShieldAlert : Info;
  return <div className="settings-notice" data-kind={kind} role={kind === "error" ? "alert" : kind === "info" ? "note" : "status"}>
    <Icon aria-hidden="true" className={kind === "loading" ? "animate-spin" : undefined} />
    <div>{children}</div>
    {onRetry && <Button variant="outline" size="sm" onClick={onRetry}><RefreshCw aria-hidden="true" />重试读取</Button>}
  </div>;
}

const pages = [
  { id: "general", title: "通用", english: "General", icon: Settings2, group: "偏好设置", scope: "本机服务与此浏览器", owner: "按设置项分别保存", description: "默认值只影响新建会话；输入偏好仅保存在此浏览器，不改写已有会话。" },
  { id: "providers", title: "提供商", english: "Providers", icon: Plug, group: "偏好设置", scope: "所有工作区 / 项目", owner: "本机 Agent 服务", description: "提供商配置与凭据由本机 Agent 服务保存，不与 PM 任务助手或全局 CLI 账号混用。" },
  { id: "usage", title: "用量与价格", english: "Usage", icon: Database, group: "偏好设置", scope: "本机 Agent 服务", owner: "本机用量配置", description: "配置用量来源、模型价格与别名；费用为 API 等价估算，不是账单。" },
  { id: "appearance", title: "外观", english: "Appearance", icon: Palette, group: "偏好设置", scope: "此浏览器", owner: "PM 共用外观偏好", description: "主题、动效和侧栏密度与 PM 共用；聊天排版偏好只影响 Agent Chat。" },
  { id: "file-areas", title: "文件区域", english: "File areas", icon: FolderOpen, group: "会话与上下文", scope: "授权工作区 / 项目", owner: "PM 文件区域配置", description: "文件区域是会话执行目录，不是新的授权或沙箱；变更不改写已接受的执行快照。" },
  { id: "history", title: "历史与归档", english: "History", icon: History, group: "会话与上下文", scope: "原会话作用域", owner: "本机 Agent 服务", description: "归档与恢复保留原工作区 / 项目归属，不把不可访问或旧会话重新绑定到其他作用域。" },
  { id: "diagnostics", title: "诊断", english: "Diagnostics", icon: Server, group: "本机服务", scope: "本机 Agent 服务", owner: "只读诊断", description: "服务状态与提供商连接状态分别呈现；服务可响应不代表真实模型已验证。" },
  { id: "storage", title: "数据与存储", english: "Storage", icon: Database, group: "本机服务", scope: "本机 Agent 数据", owner: "显式维护", description: "查看实际存储归属与备份操作；不会自动清理历史、删除数据或修改 PM 存储。" },
] as const;
const groups = ["偏好设置", "会话与上下文", "本机服务"] as const;

function workspaceReturnTo(state: unknown, search: string): string {
  const candidate = state && typeof state === "object" && "settingsReturnTo" in state ? state.settingsReturnTo : undefined;
  if (typeof candidate === "string" && (candidate === "/workspace" || candidate.startsWith("/workspace?") || candidate.startsWith("/workspace#"))) return candidate;
  const source = new URLSearchParams(search);
  const params = new URLSearchParams();
  for (const name of ["workspace", "project", "thread", "returnTo"]) {
    const value = source.get(name);
    if (value) params.set(name, value);
  }
  const query = params.toString();
  return `/workspace${query ? `?${query}` : ""}`;
}

class SettingsContentBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <SettingsNotice kind="error">
      <p>无法显示此设置页面。请重新加载；此操作不会重试提交配置或取消后台生成。</p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>重新加载页面</Button>
    </SettingsNotice>;
    return this.props.children;
  }
}

export function SettingsNotFound() {
  return <SettingsNotice kind="error"><p>404 · 此设置页面不存在。</p><Link to="/settings/general">前往通用设置</Link></SettingsNotice>;
}

export function SettingsLayout() {
  useChatAppearance();
  const { theme, toggle } = useTheme();
  const location = useLocation();
  const [guards] = useState(() => new Map<symbol, SettingsGuardState>());
  const activeGuard = useRef<SettingsGuardState>("clean");
  const [guardState, setGuardState] = useState<SettingsGuardState>("clean");
  const heading = useRef<HTMLHeadingElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const page = pages.find((item) => location.pathname.replace(/\/+$/, "") === `/settings/${item.id}`);
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

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${page?.title ?? "页面不存在"} · Agent 设置`;
    heading.current?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 767px)").matches) {
      navigation.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    return () => { document.title = previousTitle; };
  }, [location.pathname, page]);

  return <SettingsGuardContext.Provider value={registerGuard}>
    <div className={`settings-shell ${pmTheme.page}`}>
      <a className="settings-skip-link" href="#settings-content">跳至设置内容</a>
      <aside className="settings-sidebar" aria-label="Agent 设置">
        <Link to={returnTo} className="settings-product"><MessageSquare aria-hidden="true" /><span>Agent Chat</span></Link>
        <p className="settings-nav-caption">设置</p>
        <nav ref={navigation} className="settings-navigation" aria-label="设置页面">
          {groups.map((group) => <div className="settings-nav-group" key={group}>
            <p>{group}</p>
            {pages.filter((item) => item.group === group).map((item) => <NavLink key={item.id} end to={{ pathname: `/settings/${item.id}`, search: location.search }} state={navigationState}>
              <item.icon aria-hidden="true" /><span>{item.title}</span><small lang="en">{item.english}</small>
            </NavLink>)}
          </div>)}
        </nav>
        <div className="settings-sidebar-footer">
          <Link to={returnTo}><ArrowLeft aria-hidden="true" /><span>返回对话</span></Link>
          <Button size="icon-sm" variant="ghost" onClick={toggle} aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"}>{theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}</Button>
        </div>
      </aside>
      <main className="settings-main" id="settings-content" tabIndex={-1}>
        <header className="settings-breadcrumb"><span>设置</span><ChevronRight aria-hidden="true" /><h1 ref={heading} tabIndex={-1}>{page?.title ?? "页面不存在"}</h1>
          <span className="settings-draft-status" role="status">{guardState === "busy" ? "操作进行中" : guardState === "dirty" ? "有未保存的修改" : ""}</span>
        </header>
        <div className="settings-content">
          {page && <div className="settings-page-scope"><div><span>配置适用于</span><strong>{page.scope}</strong><span className="settings-scope-owner"><Monitor aria-hidden="true" />{page.owner}</span></div><p>{page.description}</p></div>}
          <SettingsContentBoundary key={location.pathname}>
            <Suspense fallback={<SettingsNotice kind="loading">正在加载{page?.title ?? "设置页面"}…</SettingsNotice>}><Outlet /></Suspense>
          </SettingsContentBoundary>
        </div>
      </main>
    </div>
    <Dialog open={blocker.state === "blocked"} onOpenChange={(open) => { if (!open && blocker.state === "blocked") blocker.reset(); }}>
      <DialogContent showCloseButton={false} className="settings-leave-dialog">
        <DialogHeader>
          <DialogTitle>{guardState === "busy" ? "请等待当前操作完成" : guardState === "dirty" ? "放弃未保存的修改？" : "继续离开设置？"}</DialogTitle>
          <DialogDescription>{guardState === "busy" ? "当前操作尚未完成，请等待结果后再离开。离开页面不会自动取消服务端操作。" : guardState === "dirty" ? "此页面有未保存的设置。离开将放弃这些修改；留在此页可继续编辑或保存。" : "当前操作已结束，可以继续前往刚才选择的页面。"}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" autoFocus onClick={() => { if (blocker.state === "blocked") blocker.reset(); }}>留在此页</Button>
          {guardState !== "busy" && <Button onClick={() => { if (blocker.state === "blocked" && activeGuard.current !== "busy") blocker.proceed(); }}>{guardState === "dirty" ? "放弃修改并离开" : "继续离开"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </SettingsGuardContext.Provider>;
}
