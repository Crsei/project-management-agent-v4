import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useLocation } from "react-router"
import { usePmService } from "../service/pm-service"
import { AgentPanel } from "./agent-panel"
import styles from "./agent-panel.module.css"

export type AgentPanelContext = {
  workspaceId: string
  projectId?: string
  entityId?: string
  taskId?: string
  title?: string
  hasDraft?: boolean
  returnTo?: string
}

type Value = {
  context: AgentPanelContext | null
  panelOpen: boolean
  threadId: string | null
  openPanel: (context: AgentPanelContext) => void
  closePanel: () => void
  setThreadId: (id: string | null) => void
}

const Context = createContext<Value | null>(null)
const pathOf = (location: { pathname: string; search: string; hash: string }) => `${location.pathname}${location.search}${location.hash}`
const contextKey = (context: AgentPanelContext) => [context.workspaceId, context.projectId ?? "", context.entityId ?? "", context.taskId ?? ""].join(":")

export function PmAgentProvider({ children }: { children: ReactNode }) {
  const { actor, actorEpoch, workspace } = usePmService()
  return <ScopedPmAgentProvider key={`${actor?.id ?? "anonymous"}:${actorEpoch}:${workspace?.id ?? ""}:${workspace?.version ?? ""}`}>{children}</ScopedPmAgentProvider>
}

function ScopedPmAgentProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [context, setContext] = useState<AgentPanelContext | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [threadId, setThreadId] = useState<string | null>(null)
  const focusRef = useRef<HTMLElement | null>(null)
  const pathRef = useRef(pathOf(location))

  // Page navigation while the panel is open closes the panel; the target page
  // becomes the active surface and no stale entity context remains.
  useEffect(() => {
    const next = pathOf(location)
    if (pathRef.current === next) return
    pathRef.current = next
    setPanelOpen(false)
    setContext(null)
    setThreadId(null)
  }, [location])

  const openPanel = useCallback((next: AgentPanelContext) => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    focusRef.current = active
    if (!context || contextKey(context) !== contextKey(next)) setThreadId(null)
    setContext({ ...next, returnTo: next.returnTo ?? pathOf(location) })
    setPanelOpen(true)
  }, [context, location])

  const closePanel = useCallback(() => {
    setPanelOpen(false)
    window.requestAnimationFrame(() => {
      if (focusRef.current?.isConnected) focusRef.current.focus({ preventScroll: true })
    })
  }, [])

  const value = useMemo<Value>(() => ({ context, panelOpen, threadId, openPanel, closePanel, setThreadId }), [closePanel, context, openPanel, panelOpen, threadId])
  return <Context.Provider value={value}>
    <div className={styles.host} data-pm-agent-host>
      <div className={styles.source} data-pm-agent-source>{children}</div>
      {panelOpen && <button type="button" className={styles.backdrop} onClick={closePanel} aria-label="关闭 Agent 面板" />}
      {context && <AgentPanel key={contextKey(context)} context={context} threadId={threadId} onThreadId={setThreadId} onClose={closePanel} open={panelOpen && pathRef.current === pathOf(location)} />}
    </div>
  </Context.Provider>
}

export function usePmAgentPanel(): Value {
  const value = useContext(Context)
  if (!value) throw new Error("PmAgentProvider is required inside the PM service")
  return value
}

export function useOptionalPmAgentPanel(): Value | null {
  return useContext(Context)
}
