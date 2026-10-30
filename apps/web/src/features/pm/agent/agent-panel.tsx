import { useCallback, useMemo } from "react"
import { useNavigate } from "react-router"
import { TooltipProvider } from "@agent/components/ui/tooltip"
import { AccessGate } from "@agent/src/access-gate"
import { Assistant } from "@agent/src/assistant"
import type { AgentPanelContext } from "./agent-panel-context"
import styles from "./agent-panel.module.css"

const entryKey = (context: AgentPanelContext) => `pm-v3:agent-panel:${JSON.stringify([context.workspaceId, context.projectId ?? null, context.entityId ?? null, context.taskId ?? null])}`

/** The PM host supplies context; Chat owns the thread, provider and runtime. */
export function AgentPanel({ context, threadId, onThreadId, onClose, open }: {
  context: AgentPanelContext
  threadId: string | null
  onThreadId: (id: string | null) => void
  onClose: () => void
  open: boolean
}) {
  const navigate = useNavigate()
  const entry = useMemo(() => {
    const params = new URLSearchParams({ workspace: context.workspaceId })
    params.set("panel", "1")
    if (context.projectId) params.set("project", context.projectId)
    if (context.taskId) params.set("task", context.taskId)
    if (context.entityId) params.set("entity", context.entityId)
    if (context.returnTo) params.set("returnTo", context.returnTo)
    try { const thread = threadId || sessionStorage.getItem(entryKey(context)); if (thread) params.set("thread", thread) } catch { if (threadId) params.set("thread", threadId) }
    return params
  }, [context, threadId])
  const onThreadChange = useCallback((id: string | null) => {
    onThreadId(id)
    try { if (id) sessionStorage.setItem(entryKey(context), id); else sessionStorage.removeItem(entryKey(context)) } catch { /* The mounted Chat still retains its selection. */ }
  }, [context, onThreadId])
  return <aside className={styles.panel} hidden={!open} aria-label="Agent 助手面板">
    {context.hasDraft && <div className={styles.context}>PM 中未保存的草稿不会自动发送或覆盖。</div>}
    <TooltipProvider><AccessGate><Assistant entry={entry} onClose={onClose} onThreadChange={onThreadChange} onExpand={params => {
      onThreadChange(params.get("thread"))
      navigate(`/agent/workspace?${params}`)
      onClose()
    }} /></AccessGate></TooltipProvider>
  </aside>
}
