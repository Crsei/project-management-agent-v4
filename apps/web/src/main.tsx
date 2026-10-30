import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router"
import { PmErrorBoundary } from "@/components/blocks/error-boundary"
import { AppProviders } from "@/providers/app-providers"
import { AppRoutes } from "@/routes"
import { installPageExit } from "@/lib/page-exit"
import "@/index.css"

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root container in index.html")
}

installPageExit()

const router = createBrowserRouter([{
  path: "*",
  element: <AppProviders><PmErrorBoundary><AppRoutes /></PmErrorBoundary></AppProviders>,
}])

createRoot(container).render(
  <StrictMode><RouterProvider router={router} /></StrictMode>,
)
