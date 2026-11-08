import { lazy, Suspense, useEffect, useLayoutEffect } from "react";
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { TooltipProvider } from "@agent/components/ui/tooltip";
import { Assistant } from "./assistant";
import { AccessGate } from "./access-gate";
import { SettingsLayout, SettingsNotFound } from "./settings/settings-layout";
import { agentText } from "./i18n-text.ts";
import { USAGE_PATH } from "./usage/navigation";
import { RouteErrorBoundary, RouteLoading } from "@/components/blocks/route-feedback";

const GeneralPage = lazy(() => import("./settings/general-page"));
const ProvidersPage = lazy(() => import("./settings/providers-page"));
const AppearancePage = lazy(() => import("./settings/appearance-page"));
const HistoryPage = lazy(() => import("./settings/history-page"));
const UsagePage = lazy(() => import("./usage/UsagePage"));
const UsageSettings = lazy(() => import("./usage/UsageSettings"));
const ExtensionsPage = lazy(() => import("./settings/extensions-page"));
const NativeSkillsPage = lazy(() => import("./settings/extensions-page").then(module => ({ default: module.NativeSkillsPage })));

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
    <Suspense fallback={<RouteLoading message={agentText("正在加载工作区…", "Loading workspace…")} />}>
      <Outlet />
    </Suspense>
  </AccessGate>;
}

function SettingsIndex() {
  const location = useLocation();
  return <Navigate to={{ pathname: "/agent/settings/general", search: location.search }} replace state={location.state} />;
}


export function App() {
  const location = useLocation();
  useLayoutEffect(() => {
    document.documentElement.dataset.product = "agent";
    return () => { delete document.documentElement.dataset.product; };
  }, []);
  return <TooltipProvider><RouteErrorBoundary resetKey={location.pathname}><Routes>
  <Route element={<ApplicationFrame />}>
    <Route index element={<Assistant />} />
    <Route path="workspace" element={<Assistant />} />
    <Route path="automations/*" element={<Assistant />} />
    <Route path="usage" element={<UsageRedirect />} />
    <Route path="settings" element={<SettingsLayout />}>
      <Route index element={<SettingsIndex />} />
      <Route path="general" element={<GeneralPage />} />
      <Route path="providers" element={<ProvidersPage />} />
      <Route path="mcp-servers" element={<ExtensionsPage />} />
      <Route path="skills" element={<NativeSkillsPage />} />
      <Route path="usage" element={<UsagePage />} />
      <Route path="usage/config" element={<UsageSettings />} />
      <Route path="appearance" element={<AppearancePage />} />
      <Route path="history" element={<HistoryPage />} />
      <Route path="*" element={<SettingsNotFound />} />
    </Route>
    <Route path="*" element={<main className="p-8">
      <h1>{agentText("404 · 页面不存在", "404 · Page not found")}</h1>
      <Link to="/agent/workspace">{agentText("返回 AI 对话", "Back to AI chat")}</Link>
    </main>} />
  </Route>
  </Routes></RouteErrorBoundary></TooltipProvider>;
}
