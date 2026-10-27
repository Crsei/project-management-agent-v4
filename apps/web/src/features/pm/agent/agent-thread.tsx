import type { ReactNode } from "react"
import { ArrowDown, ArrowUp, Bot, Check, Copy, PanelLeft, Plus, Square } from "lucide-react"
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  groupPartByType,
} from "@assistant-ui/react"
import type { AgentChatMessage } from "@contracts"
import { MessageContent } from "@/components/blocks/message-content"
import { useText } from "../service/pm-ui"
import { AgentActivityGroup, AgentActivityItem, AgentMessageSources } from "./agent-tool-call-card"
import { previousReadEntity, toolTarget } from "./agent-tool-presentation"
import styles from "./agent-chat.module.css"

const groupBy = groupPartByType({ "tool-call": ["group-actions"] })

export function AgentThread({ title, model, modelReady, messageCount, context, contextPicker, notices, blocked = false, reconciling = false, compact = false, onReconcile, onNewChat, onOpenSidebar }: {
  title: string
  model: string | null
  modelReady: boolean
  messageCount: number | null
  context?: ReactNode
  contextPicker?: ReactNode
  notices?: ReactNode
  blocked?: boolean
  reconciling?: boolean
  compact?: boolean
  onReconcile?: () => Promise<void>
  onNewChat: () => void
  onOpenSidebar?: () => void
}) {
  const t = useText()
  const empty = useAuiState(state => state.thread.messages.length === 0 && !state.thread.isLoading)
  const running = useAuiState(state => state.thread.isRunning)
  return <section className={`${styles.main}${compact ? ` ${styles.panelThread}` : ""}`} aria-label={t("Agent 对话", "Agent chat")}>
    {!compact && <header className={styles.threadHeader}>
      {onOpenSidebar && <button type="button" className={`${styles.iconButton} ${styles.mobileOpenButton}`} onClick={onOpenSidebar} aria-label={t("打开侧栏", "Open sidebar")}>
        <PanelLeft size={16} aria-hidden="true" />
      </button>}
      <div className={styles.threadHeading}>
        <h1 className={styles.headerTitle} title={title}>{title}</h1>
        <div className={styles.headerBadges}>
          {modelReady ? <span>{model ?? t("模型已配置", "Model configured")}</span> : <span>{t("模型未配置", "Model not configured")}</span>}
          {messageCount !== null && <span>{t(`${messageCount} 条消息`, `${messageCount} messages`)}</span>}
        </div>
      </div>
      <div className={styles.headerActions}>
        <button type="button" className={styles.iconButton} onClick={onNewChat} aria-label={t("新对话", "New chat")} title={t("新对话", "New chat")} disabled={running || blocked}>
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
    </header>}
    {context}
    {notices}
    <ThreadPrimitive.Root className={styles.threadRoot}>
      <ThreadPrimitive.Viewport className={styles.threadViewport} turnAnchor="top">
        <div className={`${styles.threadInner}${empty ? ` ${styles.threadInnerEmpty}` : ""}`}>
          <ThreadWelcome />
          <div className={styles.messages}>
            <ThreadPrimitive.Messages>{() => <ThreadMessage onReconcile={onReconcile} reconciling={reconciling} />}</ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter className={styles.composerArea}>
            <ThreadPrimitive.ScrollToBottom asChild>
              <button type="button" className={styles.scrollBottom}>
                <ArrowDown size={13} aria-hidden="true" />
                <AuiIf condition={state => state.thread.isRunning}>{t("新内容", "New content")}</AuiIf>
                <span className="sr-only">{t("滚动到底部", "Scroll to bottom")}</span>
              </button>
            </ThreadPrimitive.ScrollToBottom>
            <Composer model={model} modelReady={modelReady} contextPicker={contextPicker} />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  </section>
}

function ThreadWelcome() {
  const t = useText()
  const empty = useAuiState(state => state.thread.messages.length === 0 && !state.thread.isLoading)
  if (!empty) return null
  return <div className={styles.welcome}>
    <div className={styles.welcomeIcon}><Bot size={19} aria-hidden="true" /></div>
    <h2 className={styles.welcomeTitle}>{t("有什么可以帮你？", "How can I help you today?")}</h2>
    <p className={styles.welcomeText}>{t("未启用工具时仅对话。明确选择范围并启用 Full access 后，允许的普通 PM 操作会自动执行；受保护流程仍由人工完成。", "Chat only until you explicitly choose a scope and enable Full access. Permitted ordinary PM actions then execute automatically; protected workflows remain manual.")}</p>
  </div>
}

function ThreadMessage({ onReconcile, reconciling }: { onReconcile?: () => Promise<void>; reconciling: boolean }) {
  const role = useAuiState(state => state.message.role)
  return role === "user" ? <UserMessage /> : <AssistantMessage onReconcile={onReconcile} reconciling={reconciling} />
}

function UserMessage() {
  return <MessagePrimitive.Root className={styles.userRow}>
    <div className={styles.userBubble}><MessagePrimitive.Parts /></div>
  </MessagePrimitive.Root>
}

function AssistantMessage({ onReconcile, reconciling }: { onReconcile?: () => Promise<void>; reconciling: boolean }) {
  const t = useText()
  const status = useAuiState(state => state.message.status)
  const parts = useAuiState(state => state.message.parts.length)
  const message = useAuiState(state => state.message.metadata.custom.agentMessage as AgentChatMessage | undefined)
  const streaming = status?.type === "running"
  const label = status?.type === "running"
    ? t("正在生成…", "Generating…")
    : status?.type === "incomplete" && status.reason === "cancelled"
      ? t("已停止", "Stopped")
      : status?.type === "incomplete" && status.reason === "error"
        ? t("生成失败", "Generation failed")
        : status?.type === "incomplete"
          ? t("已中断", "Interrupted")
          : null
  const toolCalls = message?.toolCalls ?? []
  return <MessagePrimitive.Root className={styles.assistantRow}>
    <div className={styles.messageMeta}>
      <span>Agent</span>
      {label && <span className={`${styles.messageStatus}${status?.type === "incomplete" && status.reason === "error" ? ` ${styles.messageStatusError}` : ""}`}>{label}</span>}
    </div>
    <div className={styles.assistantContent}>
      <MessagePrimitive.GroupedParts groupBy={groupBy} indicator="never">
        {({ part, children }) => {
          if (part.type === "group-actions") return <AgentActivityGroup calls={toolCalls}>{children}</AgentActivityGroup>
          if (part.type === "tool-call") {
            const index = toolCalls.findIndex(call => call.id === part.toolCallId)
            const call = index >= 0 ? toolCalls[index] : undefined
            if (!call) return <p className={styles.activityFallback}>{part.toolName ?? "tool"}</p>
            return <AgentActivityItem call={call} previousRead={previousReadEntity(toolCalls, index, toolTarget(call).id)} onReconcile={onReconcile} reconciling={reconciling} />
          }
          if (part.type === "text") return <section className={styles.outputBlock}>
            <MessageContent content={part.text} streaming={streaming} />
          </section>
          if (part.type === "reasoning") return <details className={styles.reasoningBlock}>
            <summary>{t("思考摘要", "Reasoning summary")}</summary>
            <p>{part.text}</p>
          </details>
          if (part.type === "indicator") return <span className={styles.typing} aria-label={t("Agent 正在输入", "Agent is typing")}><span /><span /><span /></span>
          return null
        }}
      </MessagePrimitive.GroupedParts>
      {message && <AgentMessageSources message={message} />}
      {streaming && parts === 0 && <span className={styles.typing} aria-label={t("Agent 正在输入", "Agent is typing")}><span /><span /><span /></span>}
    </div>
    <div className={styles.messageActions}>
      <ActionBarPrimitive.Root hideWhenRunning autohide="not-last">
        <ActionBarPrimitive.Copy asChild>
          <button type="button" className={styles.messageAction} aria-label={t("复制回复", "Copy reply")} title={t("复制回复", "Copy reply")}>
            <AuiIf condition={state => state.message.isCopied}><Check size={14} aria-hidden="true" /></AuiIf>
            <AuiIf condition={state => !state.message.isCopied}><Copy size={14} aria-hidden="true" /></AuiIf>
          </button>
        </ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </div>
  </MessagePrimitive.Root>
}

function Composer({ model, modelReady, contextPicker }: { model: string | null; modelReady: boolean; contextPicker?: ReactNode }) {
  const t = useText()
  return <ComposerPrimitive.Root className={styles.composer}>
    <ComposerPrimitive.Input
      className={styles.composerInput}
      placeholder={modelReady ? t("向 Agent 发送消息…", "Message the Agent…") : t("配置模型后即可开始对话", "Configure a model to start chatting")}
      aria-label={t("发送给 Agent 的消息", "Message to the Agent")}
      rows={1}
      autoFocus
    />
    <div className={styles.composerActions}>
      <div className={styles.composerMeta}>
        {contextPicker}
        {model ? <span>{model}</span> : <span>{t("模型未配置", "Model not configured")}</span>}
        <span className={styles.composerHint}>{t("Enter 发送，Shift+Enter 换行", "Enter to send, Shift+Enter for a new line")}</span>
      </div>
      <div className={styles.composerButtons}>
        <AuiIf condition={state => state.composer.canCancel}>
          <ComposerPrimitive.Cancel asChild>
            <button type="button" className={styles.stopButton} aria-label={t("停止生成", "Stop generating")}>
              <Square size={12} aria-hidden="true" />
              {t("停止", "Stop")}
            </button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
        <AuiIf condition={state => !state.composer.canCancel}>
          <ComposerPrimitive.Send asChild>
            <button type="button" className={`${styles.iconButton} ${styles.sendButton}`} aria-label={t("发送消息", "Send message")} disabled={!modelReady}>
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          </ComposerPrimitive.Send>
        </AuiIf>
      </div>
    </div>
  </ComposerPrimitive.Root>
}
