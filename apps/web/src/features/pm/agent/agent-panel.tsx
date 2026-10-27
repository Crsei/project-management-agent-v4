import { useCallback, useState } from "react"
import { useNavigate, useParams } from "react-router"
import { Bot, ExternalLink, MessagesSquare, Plus, X } from "lucide-react"
import { usePmService } from "../service/pm-service"
import { useText } from "../service/pm-ui"
import { AgentConversation } from "./agent-conversation"
import { agentConversationParams, type AgentConversationLocation } from "./agent-conversation-state"
import type { AgentPanelContext } from "./agent-panel-context"
import styles from "./agent-panel.module.css"

/** The panel owns only its entry header, local navigation, and compact size. */
export function AgentPanel({ context, threadId, onThreadId, onClose, open }: {
  context: AgentPanelContext
  threadId: string | null
  onThreadId: (id: string | null) => void
  onClose: () => void
  open: boolean
}) {
  const { workspace } = usePmService()
  const t = useText()
  const navigate = useNavigate()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const root = `/pm/${encodeURIComponent(workspaceSlug || workspace?.id || "")}`
  const [location, setLocation] = useState<AgentConversationLocation>(() => ({ threadId, projectId: context.projectId ?? null, taskId: context.taskId ?? null, returnTo: context.returnTo ?? null, newChat: !threadId }))
  const onNavigate = useCallback((next: AgentConversationLocation) => {
    setLocation(next)
    onThreadId(next.threadId)
  }, [onThreadId])
  return <aside className={styles.panel} hidden={!open} aria-label={t("Agent 助手面板", "Agent assistant panel")}>
    <AgentConversation
      location={location}
      onNavigate={onNavigate}
      root={root}
      compact
      onExpand={(current, handoff) => {
        navigate(`${root}/agent?${agentConversationParams(current)}`, { state: { agentConversation: handoff } })
        onClose()
      }}
      renderHeader={({ title, busy, onNewChat, onOpenHistory, onExpand }) => <header className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.icon}><Bot size={15} aria-hidden="true" /></span>
          <div className={styles.titleWrap}>
            <h2>{t("Agent 助手", "Agent assistant")}</h2>
            <p title={title}>{title}</p>
          </div>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.iconButton} onClick={onOpenHistory} aria-label={t("打开对话历史", "Open conversation history")} title={t("对话历史", "Conversation history")}><MessagesSquare size={15} aria-hidden="true" /></button>
          <button type="button" className={styles.iconButton} onClick={onNewChat} disabled={busy} aria-label={t("新对话", "New chat")} title={t("新对话", "New chat")}><Plus size={15} aria-hidden="true" /></button>
          <button type="button" className={styles.iconButton} onClick={onExpand} disabled={busy} aria-label={t("展开完整工作台", "Open full workspace")} title={t("展开完整工作台", "Open full workspace")}><ExternalLink size={15} aria-hidden="true" /></button>
          <button type="button" className={styles.iconButton} onClick={onClose} aria-label={t("关闭 Agent 面板", "Close Agent panel")} title={t("关闭 Agent 面板", "Close Agent panel")}><X size={15} aria-hidden="true" /></button>
        </div>
      </header>}
      entryNotice={context.hasDraft ? <div className={styles.context}><span className={styles.draft}>{t("打开面板时的未保存草稿未发送；仅发送下方输入的消息。", "The unsaved draft present when this panel opened was not sent; only messages entered below are sent.")}</span></div> : undefined}
    />
  </aside>
}
