import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useLocation, useNavigate } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { pmKeys } from "../service/pm-data"
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
  const queryClient = useQueryClient()
  useEffect(() => {
    const refresh = (event: Event) => {
      const id = (event as CustomEvent<{ workspaceId: string }>).detail?.workspaceId
      if (actor && workspace && id === workspace.id) void queryClient.invalidateQueries({ queryKey: pmKeys.workspace(window.location.origin, actor.id, workspace.id) })
    }
    window.addEventListener("pm-tool-committed", refresh)
    return () => window.removeEventListener("pm-tool-committed", refresh)
  }, [actor, workspace, queryClient])
  return <ScopedPmAgentProvider key={`${actor?.id ?? "anonymous"}:${actorEpoch}:${workspace?.id ?? ""}:${workspace?.version ?? ""}`}>{children}</ScopedPmAgentProvider>
}

function ScopedPmAgentProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { workspace } = usePmService()
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
  useEffect(() => {
    const handoff = (location.state as { agentPanelReturn?: AgentPanelContext & { threadId?: string | null } } | null)?.agentPanelReturn
    if (!handoff || !workspace || handoff.workspaceId !== workspace.id) return
    setContext({ ...handoff, returnTo: pathOf(location) })
    setThreadId(handoff.threadId ?? null)
    setPanelOpen(true)
    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null })
  }, [location, navigate, workspace])

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
