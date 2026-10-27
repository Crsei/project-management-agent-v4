import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useStore, type StoreApi } from "zustand"
import { I18nProvider } from "@/lib/i18n-provider"
import { createQueryClient } from "@/lib/query-client"
import { RowStagger } from "@/lib/row-stagger"
import {
  createWorkspaceStore,
  type WorkspaceState,
} from "@/features/workspace/store"
import { Preferences } from "@/features/workspace/preferences"

const WorkspaceContext = createContext<StoreApi<WorkspaceState> | null>(null)

export function useWorkspaceStore<T>(selector: (state: WorkspaceState) => T) {
  const store = useContext(WorkspaceContext)
  if (!store) throw new Error("Workspace provider is missing")
  return useStore(store, selector)
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient)
  const [store] = useState(createWorkspaceStore)
  return (
    <QueryClientProvider client={queryClient}>
      <WorkspaceContext.Provider value={store}>
        <TooltipProvider>
          <RowStagger />
          <Preferences>{children}</Preferences>
        </TooltipProvider>
      </WorkspaceContext.Provider>
    </QueryClientProvider>
  )
}

// Re-exported so ported views keep the original import path shape.
export { I18nProvider }
