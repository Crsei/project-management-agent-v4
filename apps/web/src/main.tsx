import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router"
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

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <AppProviders>
        <PmErrorBoundary>
          <AppRoutes />
        </PmErrorBoundary>
      </AppProviders>
    </BrowserRouter>
  </StrictMode>,
)
