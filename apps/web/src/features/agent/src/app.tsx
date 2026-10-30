import { Component, lazy, Suspense, useEffect, useLayoutEffect, type ReactNode } from "react";
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { TooltipProvider } from "@agent/components/ui/tooltip";
import { Assistant } from "./assistant";
import { AccessGate } from "./access-gate";
import { SettingsLayout, SettingsNotFound } from "./settings/settings-layout";
import { agentText } from "./i18n-text.ts";
import { USAGE_PATH } from "./usage/navigation";

const ShowcaseApp = lazy(() => import("./showcase/app"));
const GeneralPage = lazy(() => import("./settings/general-page"));
const ProvidersPage = lazy(() => import("./settings/providers-page"));
const AppearancePage = lazy(() => import("./settings/appearance-page"));
const FileAreasPage = lazy(() => import("./settings/file-areas-page"));
const HistoryPage = lazy(() => import("./settings/history-page"));
const DiagnosticsPage = lazy(() => import("./settings/diagnostics-page"));
const StoragePage = lazy(() => import("./settings/storage-page"));
const UsagePage = lazy(() => import("./usage/UsagePage"));
const UsageSettings = lazy(() => import("./usage/UsageSettings"));
export const showcaseEnabled = import.meta.env.DEV || import.meta.env.VITE_ENABLE_UI_LAB === "1";

function UsageRedirect() {
  const location = useLocation();
  return <Navigate to={{ pathname: USAGE_PATH, search: location.search, hash: location.hash }} replace state={location.state} />;
}

function ApplicationFrame() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "u") return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [data-terminal-drawer], .xterm, [role='dialog'], [role='alertdialog'], [role='menu'], [aria-modal='true']")) return;
      event.preventDefault();
      if (location.pathname === USAGE_PATH) return;
      const guardedLink = document.querySelector<HTMLAnchorElement>("[data-usage-navigation]");
      if (guardedLink) guardedLink.click();
      else navigate(USAGE_PATH, { state: { usageReturnTo: `${location.pathname}${location.search}${location.hash}`, usageReturnState: location.state } });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, location]);
  return <AccessGate>
    <Suspense fallback={<div role="status" className="p-8">{agentText("正在加载工作区…", "Loading workspace…")}</div>}>
      <Outlet />
    </Suspense>
  </AccessGate>;
}

function SettingsIndex() {
  const location = useLocation();
  return <Navigate to={{ pathname: "/agent/settings/general", search: location.search }} replace state={location.state} />;
}

class RouteBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="p-8">
      <h1>{agentText("页面暂时不可用", "Page unavailable")}</h1>
      <p role="alert">{agentText("无法显示当前页面，请重新加载后再试。", "This page could not be displayed. Reload and try again.")}</p>
      <button type="button" onClick={() => window.location.reload()}>{agentText("重新加载页面", "Reload page")}</button>
      <p><Link to="/agent/workspace">{agentText("返回 AI 对话", "Back to AI chat")}</Link></p>
    </main>;
  }
}

export function App() {
  useLayoutEffect(() => {
    document.documentElement.dataset.product = "agent";
    return () => { delete document.documentElement.dataset.product; };
  }, []);
  return <TooltipProvider><RouteBoundary><Routes>
  <Route element={<ApplicationFrame />}>
    <Route index element={<Assistant />} />
    <Route path="workspace" element={<Assistant />} />
    <Route path="usage" element={<UsageRedirect />} />
    <Route path="settings" element={<SettingsLayout />}>
      <Route index element={<SettingsIndex />} />
      <Route path="general" element={<GeneralPage />} />
      <Route path="providers" element={<ProvidersPage />} />
      <Route path="usage" element={<UsagePage />} />
      <Route path="usage/config" element={<UsageSettings />} />
      <Route path="appearance" element={<AppearancePage />} />
      <Route path="file-areas" element={<FileAreasPage />} />
      <Route path="history" element={<HistoryPage />} />
      <Route path="diagnostics" element={<DiagnosticsPage />} />
      <Route path="storage" element={<StoragePage />} />
      <Route path="*" element={<SettingsNotFound />} />
    </Route>
    {showcaseEnabled && <Route path="showcase/*" element={<ShowcaseApp />} />}
    <Route path="*" element={<main className="p-8">
      <h1>{agentText("404 · 页面不存在", "404 · Page not found")}</h1>
      <p>{agentText("展示实验室在生产环境默认关闭。", "The showcase is disabled in production.")}</p>
      <Link to="/agent/workspace">{agentText("返回 AI 对话", "Back to AI chat")}</Link>
    </main>} />
  </Route>
  </Routes></RouteBoundary></TooltipProvider>;
}
