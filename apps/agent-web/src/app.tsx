import { lazy, Suspense, useEffect } from "react";
import { createBrowserRouter, createRoutesFromElements, Link, Navigate, Outlet, Route, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { Assistant } from "./assistant";
import { AccessGate } from "./access-gate";
import { SettingsLayout, SettingsNotFound } from "./settings/settings-layout";

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

function ApplicationFrame() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "u") return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [data-terminal-drawer], .xterm, [role='dialog'], [role='alertdialog'], [role='menu'], [aria-modal='true']")) return;
      event.preventDefault();
      if (location.pathname === "/usage") return;
      const guardedLink = document.querySelector<HTMLAnchorElement>("[data-usage-navigation]");
      if (guardedLink) guardedLink.click();
      else navigate("/usage", { state: { usageReturnTo: `${location.pathname}${location.search}${location.hash}`, usageReturnState: location.state } });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, location]);
  return <AccessGate>
    <Suspense fallback={<div role="status" className="p-8">正在加载工作区…</div>}>
      <Outlet />
    </Suspense>
  </AccessGate>;
}

function SettingsIndex() {
  const location = useLocation();
  return <Navigate to={{ pathname: "/settings/general", search: location.search }} replace state={location.state} />;
}

function RouteFailure() {
  return <main className="p-8">
    <h1>页面暂时不可用</h1>
    <p role="alert">无法显示当前页面，请重新加载后再试。此操作不会重试提交或取消后台生成。</p>
    <button type="button" onClick={() => window.location.reload()}>重新加载页面</button>
    <p><Link to="/workspace">返回 AI 对话</Link></p>
  </main>;
}

const router = createBrowserRouter(createRoutesFromElements(
  <Route element={<ApplicationFrame />} errorElement={<RouteFailure />}>
    <Route index element={<Assistant />} />
    <Route path="/workspace" element={<Assistant />} />
    <Route path="/usage" element={<UsagePage />} />
    <Route path="/settings" element={<SettingsLayout />}>
      <Route index element={<SettingsIndex />} />
      <Route path="general" element={<GeneralPage />} />
      <Route path="providers" element={<ProvidersPage />} />
      <Route path="usage" element={<UsageSettings />} />
      <Route path="appearance" element={<AppearancePage />} />
      <Route path="file-areas" element={<FileAreasPage />} />
      <Route path="history" element={<HistoryPage />} />
      <Route path="diagnostics" element={<DiagnosticsPage />} />
      <Route path="storage" element={<StoragePage />} />
      <Route path="*" element={<SettingsNotFound />} />
    </Route>
    {showcaseEnabled && <Route path="/showcase/*" element={<ShowcaseApp />} />}
    <Route path="*" element={<main className="p-8">
      <h1>404 · 页面不存在</h1>
      <p>展示实验室在生产环境默认关闭。</p>
      <Link to="/workspace">返回 AI 对话</Link>
    </main>} />
  </Route>,
), { basename: "/agent" });

export function App() {
  return <RouterProvider router={router} />;
}
