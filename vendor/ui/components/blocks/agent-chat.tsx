"use client"

import { useMemo, type ReactNode, type Ref } from "react"
import type {
  WorkbenchMessage,
  WorkbenchTool,
  WorkbenchChoice,
} from "../../lib/agent-workbench-model"
import type { AgentAttachment } from "../../lib/agent-elements-model"
import type { AgentQuestionRequest } from "../../lib/questionnaire-model"
import { useI18n } from "../../lib/i18n-provider"
import {
  Conversation,
  ChatComposer,
  type ConversationActions,
  type ChatComposerProps,
  type ConversationProps,
} from "./chat-message"
import {
  AgentMessageContent,
  messageCopyText,
  type AgentMessageContentProps,
} from "./agent-message"
import { AgentTurnActions } from "./agent-turn-actions"
import { AgentAttachments } from "./agent-attachments"
import { QuestionTool } from "./question-tool"
import { ModelPicker, ModelBadge } from "./model-picker"
import { ModeSelector } from "./mode-selector"
import { cn } from "../../lib/utils"
import styles from "./agent-chat.module.css"

const emptyTools: readonly WorkbenchTool[] = []
export type AgentChatProps = Omit<
  AgentMessageContentProps,
  "message" | "tools" | "questions" | "questionInComposer"
> & {
  messages: readonly WorkbenchMessage[]
  tools?: readonly WorkbenchTool[]
  questions?: readonly AgentQuestionRequest[]
  revision: string | number
  value: string
  onChange: (value: string) => void
  onSend: (value: string) => void | Promise<void>
  onStop?: () => void
  pending?: boolean
  streaming?: boolean
  disabled?: boolean
  sendDisabled?: boolean
  outcome?: ChatComposerProps["outcome"]
  receiptRevision?: string | number
  onReconcile?: () => void | Promise<void>
  suggestions?: ChatComposerProps["suggestions"]
  attachments?: readonly AgentAttachment[]
  onRemoveAttachment?: (id: string) => void
  onFiles?: (files: File[]) => void
  models?: readonly WorkbenchChoice[]
  modelId?: string
  onModelChange?: (id: string) => void
  behaviorModes?: readonly WorkbenchChoice[]
  behaviorMode?: string
  onBehaviorModeChange?: (id: string) => void
  controls?: ReactNode
  infoBar?: ReactNode
  data?: ConversationProps["data"]
  title?: string
  agentName?: string
  className?: string
  initialScroll?: "top" | "bottom"
  actionsRef?: Ref<ConversationActions>
  showTurnActions?: boolean
}

export function AgentChat({
  messages,
  tools = emptyTools,
  questions,
  revision,
  value,
  onChange,
  onSend,
  onStop,
  pending,
  streaming,
  disabled,
  sendDisabled,
  outcome,
  receiptRevision,
  onReconcile,
  suggestions,
  attachments,
  onRemoveAttachment,
  onFiles,
  models,
  modelId,
  onModelChange,
  behaviorModes,
  behaviorMode,
  onBehaviorModeChange,
  controls,
  infoBar,
  data,
  title,
  agentName = "Agent",
  className,
  initialScroll = "bottom",
  actionsRef,
  showTurnActions = true,
  ...contentProps
}: AgentChatProps) {
  const { t, locale } = useI18n()
  const request = questions?.find(
    (question) => question.id === contentProps.activeQuestionId,
  )
  const questionInComposer = Boolean(request && request.outcome !== "confirmed")
  const entries = useMemo(() => {
    const lastInTurn = new Map<string, string>()
    for (const message of messages)
      lastInTurn.set(message.turnId, message.messageId)
    return messages.map((message) => ({
      id: message.messageId,
      role: message.role,
      state: message.state,
      author: message.role === "agent" ? agentName : undefined,
      time: message.timestamp
        ? new Date(message.timestamp).toLocaleTimeString(locale, {
            hour: "2-digit",
            minute: "2-digit",
          })
        : undefined,
      content: messageCopyText(message),
      renderContent: () => (
        <AgentMessageContent
          {...contentProps}
          message={message}
          tools={tools}
          questions={questions}
          questionInComposer={questionInComposer}
        />
      ),
      after:
        showTurnActions &&
        lastInTurn.get(message.turnId) === message.messageId ? (
          <AgentTurnActions messages={messages} turnId={message.turnId} />
        ) : undefined,
    }))
  }, [
    messages,
    tools,
    questions,
    agentName,
    locale,
    contentProps,
    questionInComposer,
    showTurnActions,
  ])
  const questionBar =
    request && questionInComposer ? (
      <QuestionTool
        request={request}
        onAnswersChange={
          contentProps.onQuestionAnswersChange
            ? (answers) =>
                contentProps.onQuestionAnswersChange!(
                  request.id,
                  request.revision,
                  answers,
                )
            : undefined
        }
        onSubmit={
          contentProps.onQuestionSubmit
            ? (answers) =>
                contentProps.onQuestionSubmit!(
                  request.id,
                  request.revision,
                  answers,
                )
            : undefined
        }
        onActiveIdChange={
          contentProps.onQuestionActiveIdChange
            ? (id) => contentProps.onQuestionActiveIdChange!(request.id, id)
            : undefined
        }
        onReconcile={
          contentProps.onQuestionReconcile
            ? () =>
                contentProps.onQuestionReconcile!(request.id, request.revision)
            : undefined
        }
      />
    ) : undefined
  return (
    <section
      className={cn(styles.chat, className)}
      aria-label={title ?? t("agentElements.chatTitle")}
      data-agent-chat
    >
      <header className={styles.header}>
        <h2>{title ?? t("agentElements.chatTitle")}</h2>
      </header>
      <Conversation
        layout="fill"
        messages={entries}
        revision={revision}
        initialScroll={initialScroll}
        actionsRef={actionsRef}
        data={{ emptyTitle: t("agentElements.noMessages"), ...data }}
        composer={
          <ChatComposer
            value={value}
            onChange={onChange}
            onSend={onSend}
            presentation="workspace"
            streaming={streaming}
            onStop={onStop}
            pending={pending}
            disabled={disabled}
            sendDisabled={sendDisabled || questionInComposer}
            outcome={outcome}
            receiptRevision={receiptRevision}
            onReconcile={onReconcile}
            suggestions={suggestions}
            questionBar={questionBar}
            infoBar={infoBar}
            onFiles={onFiles}
            attachments={
              attachments && (
                <AgentAttachments
                  attachments={attachments}
                  onRemove={onRemoveAttachment}
                  onOpenFile={contentProps.onOpenFile}
                />
              )
            }
            controls={
              <div className={styles.controls}>
                {models &&
                  modelId &&
                  (onModelChange ? (
                    <ModelPicker
                      models={models}
                      value={modelId}
                      onChange={onModelChange}
                      disabled={disabled}
                    />
                  ) : (
                    <ModelBadge models={models} value={modelId} />
                  ))}
                {behaviorModes && behaviorMode && onBehaviorModeChange && (
                  <ModeSelector
                    modes={behaviorModes}
                    value={behaviorMode}
                    onChange={onBehaviorModeChange}
                    disabled={disabled}
                  />
                )}
                {controls}
              </div>
            }
          />
        }
      />
    </section>
  )
}
