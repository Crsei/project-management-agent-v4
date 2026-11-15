import { StrictMode, useLayoutEffect, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router"
import { PmErrorBoundary } from "@/components/blocks/error-boundary"
import { DovspaceBrandLink } from "@/components/dovspace-brand"
import { AppProviders } from "@/providers/app-providers"
import { AppRoutes } from "@/routes"
import { installPageExit } from "@/lib/page-exit"
import { installDesktopShell } from "@/lib/desktop-shell"
import "@/index.css"

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root container in index.html")
}

installPageExit()
installDesktopShell()

// Clear the HTML fallback only after the routed application (or its own error
// boundary) commits. Module download/evaluation failures leave recovery visible.
function BootstrapReady({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    window.dispatchEvent(new Event("dovspace:ready"))
    document.getElementById("dovspace-boot")?.remove()
  }, [])
  return children
}

function BootstrapFailure() {
  useLayoutEffect(() => { window.dispatchEvent(new Event("dovspace:bootstrap-failed")) }, [])
  const en = document.documentElement.lang === "en"
  return <main className="route-feedback">
    <DovspaceBrandLink />
    <h1>{en ? "Application unavailable" : "应用暂时不可用"}</h1>
    <p role="alert">{en ? "The application could not start. Reload to retry; this screen does not resubmit messages or operations." : "应用未能启动。可重新加载后重试；此页面不会重新提交消息或操作。"}</p>
    <button type="button" onClick={() => window.location.reload()}>{en ? "Reload" : "重新加载"}</button>
    <a href="/pm">{en ? "Back to Project Management" : "返回项目管理"}</a>
  </main>
}

const router = createBrowserRouter([{
  path: "*",
  element: <BootstrapReady><AppProviders><PmErrorBoundary><AppRoutes /></PmErrorBoundary></AppProviders></BootstrapReady>,
  errorElement: <BootstrapFailure />,
}])

createRoot(container, {
  onUncaughtError: error => {
    window.dispatchEvent(new Event("dovspace:bootstrap-failed"))
    console.error(error)
  },
}).render(
  <StrictMode><RouterProvider router={router} /></StrictMode>,
)
