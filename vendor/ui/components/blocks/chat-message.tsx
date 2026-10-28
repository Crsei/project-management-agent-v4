"use client"
import { useUiFeedback } from "../../lib/i18n-provider"
import { uiMessage } from "../../lib/i18n-core"
import { useI18n } from "../../lib/i18n-provider"
import { localizeStaticData } from "../../lib/i18n-core"

import {
  memo,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  useImperativeHandle,
  type Ref,
  type ReactNode,
  type ClipboardEventHandler,
} from "react"
import { Bot, Copy, MessageSquare, Square, Info } from "lucide-react"
import { Button } from "../ui/button"
import { DataRegion, type DataRegionProps } from "../ui/data-region"
import { useFollowTail } from "../../lib/use-follow-tail"
import { cn } from "../../lib/utils"
import styles from "./chat-message.module.css"
import { Suggestions, type SuggestionItem } from "./suggestions"

export type MessageState =
  "pending" | "streaming" | "completed" | "interrupted" | "failed" | "cancelled"
export type ChatMessageProps = {
  id: string
  role: "user" | "agent" | "system"
  author?: string
  time?: string
  content: string
  /** One body renderer; content remains the accessible plain text and copy source. */
  renderContent?: (content: string) => ReactNode
  state?: MessageState
  stage?: string
  elapsed?: string
  reason?: string
  attachments?: ReactNode
  children?: ReactNode
  onRetry?: () => void
  onStop?: () => void
  onContinue?: () => void
}
const states: Record<MessageState, string> = {
  pending: "正在提交",
  streaming: "正在接收",
  completed: "已完成",
  interrupted: "连接中断",
  failed: "发送或执行失败",
  cancelled: "已停止",
}
export const ChatMessage = memo(function ChatMessage({
  id,
  role,
  author,
  time,
  content,
  renderContent,
  state = "completed",
  stage,
  elapsed,
  reason,
  attachments,
  children,
  onRetry,
  onStop,
  onContinue,
}: ChatMessageProps) {
  const { t, locale } = useI18n()

  const localizedStates = localizeStaticData(states, locale)

  const [feedback, setFeedback] = useUiFeedback("")
  const Icon = role === "agent" ? Bot : role === "system" ? Info : MessageSquare
  return (
    <article
      className={styles.message}
      data-message-id={id}
      data-message-state={state}
      data-message-role={role}
    >
      <div className={styles.avatar}>
        <Icon size={16} aria-hidden="true" />
      </div>
      <div className={styles.main}>
        <header>
          <span>
            {author ??
              (role === "user"
                ? t("chatMessage.you")
                : role === "agent"
                  ? "Agent"
                  : "System")}
          </span>
          {time && <time>{time}</time>}
          <span className={styles.actions}>
            {content && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("chatMessage.copyMessage")}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(content)
                    setFeedback(uiMessage("chatMessage.messageCopied"))
                  } catch {
                    setFeedback(
                      uiMessage("chatMessage.clipboardUnavailableCopyManually"),
                    )
                  }
                }}
              >
                <Copy size={16} />
              </Button>
            )}
          </span>
        </header>
        <div className={styles.body}>
          {renderContent ? renderContent(content) : content && <p>{content}</p>}
          {children}
        </div>
        {attachments && <div className={styles.attachments}>{attachments}</div>}
        {state !== "completed" && (
          <div
            className={styles.state}
            data-error={state === "failed" || state === "interrupted"}
          >
            <span role="status">
              {localizedStates[state]}
              {stage && ` · ${stage}`}
            </span>
            {elapsed && <span>{elapsed}</span>}
            {reason && <p>{reason}</p>}
            {state === "streaming" && onStop && (
              <Button variant="secondary" size="sm" onClick={onStop}>
                <Square size={16} />
                {t("chatMessage.stopReceiving")}
              </Button>
            )}
            {state === "failed" && onRetry && (
              <Button variant="secondary" size="sm" onClick={onRetry}>
                {t("chatMessage.retryMessage")}
              </Button>
            )}
            {state === "interrupted" && onContinue && (
              <Button variant="secondary" size="sm" onClick={onContinue}>
                {t("chatMessage.continueReceiving")}
              </Button>
            )}
          </div>
        )}
        <p className={styles.feedback} role="status">
          {feedback}
        </p>
      </div>
    </article>
  )
})

export type ConversationActions = {
  scrollToMessage: (id: string, options?: { focus?: boolean }) => boolean
  jumpToLatest: () => void
}
export type ConversationProps = {
  /** Optional workspace appearance; compact shared defaults remain unchanged. */
  presentation?: "default" | "workspace"
  /** Fill a bounded parent while keeping the composer outside the history scroller. */
  layout?: "content" | "fill"
  actionsRef?: Ref<ConversationActions>
  /** Opt in to browser offscreen layout deferral; records remain in the DOM. */
  deferOffscreen?: boolean
  /** Advance on every append, history edit, deletion, reorder or state change. */
  revision?: string | number
  messages: (ChatMessageProps & { after?: ReactNode })[]
  data?: Omit<DataRegionProps, "children" | "hasContent">
  workspace?: ReactNode
  composer?: ReactNode
  className?: string
  initialScroll?: "top" | "bottom"
}
export function Conversation({
  presentation = "default",
  layout = "content",
  actionsRef,
  deferOffscreen = false,
  messages,
  revision,
  data,
  workspace,
  composer,
  className,
  initialScroll = "bottom",
}: ConversationProps) {
  const { t } = useI18n()

  const id = useId()
  const [view, setView] = useState("conversation")
  const unique = [
    ...new Map(messages.map((message) => [message.id, message])).values(),
  ]
  const {
    ref: scrollRef,
    unread,
    onScroll,
    jumpToLatest,
    scrollToId,
  } = useFollowTail(
    unique.map((message) => message.id),
    revision ??
      JSON.stringify(
        unique.map((message) => [
          message.id,
          message.role,
          message.author,
          message.time,
          message.content,
          message.state,
          message.stage,
          message.elapsed,
          message.reason,
        ]),
      ),
    true,
    initialScroll,
  )
  useImperativeHandle(actionsRef, () => ({
    scrollToMessage: scrollToId,
    jumpToLatest,
  }))
  return (
    <div
      className={cn(styles.conversation, className)}
      data-layout={layout}
      data-presentation={presentation}
    >
      {workspace && (
        <div
          className={styles.tabs}
          role="tablist"
          aria-label={t("chatMessage.conversationAndWorkspace")}
        >
          {["conversation", "workspace"].map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`${id}-${tab}-tab`}
              aria-controls={`${id}-${tab}`}
              aria-selected={view === tab}
              tabIndex={view === tab ? 0 : -1}
              onClick={() => setView(tab)}
              onKeyDown={(event) => {
                if (
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault()
                  const next =
                    event.key === "Home"
                      ? "conversation"
                      : event.key === "End"
                        ? "workspace"
                        : view === "conversation"
                          ? "workspace"
                          : "conversation"
                  setView(next)
                  document.getElementById(`${id}-${next}-tab`)?.focus()
                }
              }}
            >
              {tab === "conversation" ? "Conversation" : "Workspace"}
            </button>
          ))}
        </div>
      )}
      <div
        className={styles.panes}
        data-view={view}
        data-split={Boolean(workspace)}
      >
        <div
          className={styles.chatPane}
          id={`${id}-conversation`}
          role={workspace ? "tabpanel" : undefined}
          aria-labelledby={workspace ? `${id}-conversation-tab` : undefined}
        >
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className={styles.scroll}
            aria-label={t("chatMessage.conversationHistory")}
            tabIndex={0}
          >
            <DataRegion
              state={unique.length ? "success" : "empty"}
              emptyTitle={t("chatMessage.startAConversation")}
              emptyDescription={t(
                "chatMessage.enterATaskBelowSendingItPreservesThe",
              )}
              {...data}
              hasContent={unique.length > 0}
            >
              <div
                className={styles.messages}
                data-defer-offscreen={deferOffscreen || undefined}
                data-follow-tail-list
              >
                {unique.map((message) => (
                  <ConversationRow key={message.id} message={message} />
                ))}
              </div>
            </DataRegion>
          </div>
          {unread > 0 && (
            <Button
              className={styles.latest}
              variant="secondary"
              size="sm"
              onClick={jumpToLatest}
            >
              {t("chatMessage.jumpToLatest")}
            </Button>
          )}
        </div>
        {workspace && (
          <section
            className={styles.workspace}
            id={`${id}-workspace`}
            role="tabpanel"
            aria-labelledby={`${id}-workspace-tab`}
          >
            {workspace}
          </section>
        )}
      </div>
      {composer}
    </div>
  )
}

export type ChatComposerProps = {
  inputLabel?: string
  placeholder?: string
  formLabel?: string
  sendContent?: ReactNode
  textareaMinHeight?: number
  value: string
  onChange: (value: string) => void
  onSend: (value: string) => void | Promise<void>
  pending?: boolean
  sendDisabled?: boolean
  streaming?: boolean
  disabled?: boolean
  onStop?: () => void
  attachments?: ReactNode
  presentation?: "default" | "workspace"
  controls?: ReactNode
  tools?: ReactNode
  sendLabel?: string
  suggestions?: readonly SuggestionItem[]
  questionBar?: ReactNode
  infoBar?: ReactNode
  onFiles?: (files: File[]) => void
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>
  autoFocus?: boolean
  outcome?: "pending" | "confirmed" | "failed" | "unknown"
  receiptRevision?: string | number
  onReconcile?: () => void | Promise<void>
}
export function ChatComposer({
  value,
  onChange,
  onSend,
  pending,
  sendDisabled,
  streaming,
  disabled,
  onStop,
  attachments,
  presentation = "default",
  controls,
  tools,
  sendLabel,
  inputLabel,
  placeholder,
  formLabel,
  sendContent,
  textareaMinHeight = 80,
  suggestions,
  questionBar,
  infoBar,
  onFiles,
  onPaste,
  autoFocus,
  outcome,
  receiptRevision,
  onReconcile,
}: ChatComposerProps) {
  const { t } = useI18n()
  const id = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const sending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [querying, setQuerying] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [uncertain, setUncertain] = useState<{
    revision: string | number | undefined
    outcome: ChatComposerProps["outcome"]
  } | null>(null)
  const [error, setError] = useUiFeedback("")
  const reconciled =
    uncertain &&
    (outcome === "confirmed" || outcome === "failed") &&
    (receiptRevision !== uncertain.revision || outcome !== uncertain.outcome)
  const unknown = outcome === "unknown" || Boolean(uncertain && !reconciled)
  useLayoutEffect(() => {
    if (presentation !== "workspace") return
    const field = textareaRef.current
    if (!field) return
    const resize = () => {
      if (!field.getClientRects().length) return
      field.style.height = "0px"
      field.style.height =
        Math.min(300, Math.max(textareaMinHeight, field.scrollHeight + 2)) + "px"
    }
    resize()
    let width = field.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const next = field.getBoundingClientRect().width
      if (next !== width) {
        width = next
        resize()
      }
    })
    observer.observe(field)
    window.addEventListener("resize", resize)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", resize)
    }
  }, [value, presentation, textareaMinHeight])
  const canSend = Boolean(
    value.trim() &&
    !pending &&
    !busy &&
    !streaming &&
    !disabled &&
    !sendDisabled &&
    !unknown &&
    outcome !== "pending",
  )
  async function send() {
    if (!canSend || sending.current || composing.current) return
    sending.current = true
    setBusy(true)
    setError("")
    try {
      await onSend(value.trim())
    } catch {
      setUncertain({ revision: receiptRevision, outcome })
      setError(
        uiMessage(
          "chatMessage.messageDeliveryIsUnconfirmedYourDraftIsPreserved",
        ),
      )
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  async function reconcile() {
    if (!onReconcile || querying || pending) return
    setQuerying(true)
    try {
      await onReconcile()
    } catch {
      setError(
        uiMessage(
          "chatMessage.messageDeliveryIsUnconfirmedYourDraftIsPreserved",
        ),
      )
    } finally {
      setQuerying(false)
    }
  }
  return (
    <>
      {questionBar && (
        <div className={styles.composerQuestion}>{questionBar}</div>
      )}
      <form
        className={styles.composer}
        aria-label={formLabel}
        data-presentation={presentation}
        data-drag-over={dragging || undefined}
        onClick={(event) => {
          if (event.target === event.currentTarget) textareaRef.current?.focus()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
        onDragOver={(event) => {
          if (
            !onFiles ||
            disabled ||
            !event.dataTransfer.types.includes("Files")
          )
            return
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
          setDragging(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDragging(false)
        }}
        onDrop={(event) => {
          setDragging(false)
          if (!onFiles || disabled || !event.dataTransfer.files.length) return
          event.preventDefault()
          onFiles(Array.from(event.dataTransfer.files))
        }}
      >
        {infoBar && <div className={styles.composerInfo}>{infoBar}</div>}
        {attachments && <div className={styles.attachments}>{attachments}</div>}
        <label htmlFor={id} className="sr-only">
          {inputLabel ?? t("chatMessage.messageInput")}
        </label>
        <textarea
          ref={textareaRef}
          id={id}
          value={value}
          autoFocus={autoFocus}
          placeholder={placeholder ?? t("chatMessage.enterATask")}
          disabled={disabled}
          aria-invalid={Boolean(error && !reconciled)}
          aria-describedby={error && !reconciled ? id + "-error" : undefined}
          onChange={(event) => onChange(event.target.value)}
          onPaste={(event) => {
            onPaste?.(event)
            if (
              event.defaultPrevented ||
              disabled ||
              !onFiles ||
              !event.clipboardData.files.length
            )
              return
            event.preventDefault()
            onFiles(Array.from(event.clipboardData.files))
          }}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229 &&
              !composing.current
            ) {
              event.preventDefault()
              void send()
            }
          }}
        />
        {dragging && (
          <p role="status" className={styles.composerInfo}>
            {t("agentElements.dropFiles")}
          </p>
        )}
        {suggestions && (
          <Suggestions
            items={suggestions}
            disabled={Boolean(disabled || pending || busy || unknown)}
            onSelect={(item) => {
              onChange(item.prompt)
              requestAnimationFrame(() => {
                const field = textareaRef.current
                field?.focus()
                field?.setSelectionRange(field.value.length, field.value.length)
              })
            }}
          />
        )}
        {tools && <div className={styles.composerTools}>{tools}</div>}
        <div className={styles.composerActions}>
          {controls ?? (
            <span>{t("chatMessage.enterToSendShiftEnterForANew")}</span>
          )}
          {streaming ? (
            onStop && (
              <Button variant="secondary" onClick={onStop}>
                <Square size={16} />
                {t("chatMessage.stop")}
              </Button>
            )
          ) : (
            <Button type="submit" disabled={!canSend} loading={pending || busy} size={sendContent === undefined ? "default" : "icon"} aria-label={sendLabel ?? t("chatMessage.send")}>
              {sendContent ?? sendLabel ?? t("chatMessage.send")}
            </Button>
          )}
        </div>
        {unknown && onReconcile && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={querying}
            disabled={Boolean(pending)}
            onClick={() => void reconcile()}
          >
            {t("toolCall.queryResult")}
          </Button>
        )}
        {error && !reconciled && (
          <p id={id + "-error"} role="alert" className={styles.composerError}>
            {error}
          </p>
        )}
      </form>
    </>
  )
}

const ConversationRow = memo(function ConversationRow({
  message,
}: {
  message: ChatMessageProps & { after?: ReactNode }
}) {
  const { after, ...props } = message
  return (
    <div className={styles.messageEntry} data-follow-tail-id={message.id}>
      <ChatMessage {...props} />
      {after && <div className={styles.after}>{after}</div>}
    </div>
  )
})
