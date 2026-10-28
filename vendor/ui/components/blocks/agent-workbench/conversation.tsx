"use client"

import { useMemo, type ReactNode, type Ref } from "react"
import { Button } from "../../ui/button"
import { Conversation, type ConversationActions } from "../chat-message"
import {
  AgentMessageContent,
  messageCopyText,
  type AgentMessageContentProps,
} from "../agent-message"
import { AgentTurnActions } from "../agent-turn-actions"
import { useI18n } from "../../../lib/i18n-provider"
import type { SessionSnapshot } from "../../../lib/agent-workbench-model"
import styles from "./workbench.module.css"

export type AgentConversationProps = Omit<
  AgentMessageContentProps,
  "message" | "tools" | "questions" | "changes" | "plan"
> & {
  session: SessionSnapshot
  composer?: ReactNode
  attention?: ReactNode
  onLoadHistory?: () => void
  actionsRef?: Ref<ConversationActions>
  deferOffscreen?: boolean
  onRetry?: () => void
  presentation?: "default" | "workspace"
  initialScroll?: "top" | "bottom"
  showTurnActions?: boolean
}

export function AgentConversation({
  session,
  composer,
  attention,
  onLoadHistory,
  actionsRef,
  deferOffscreen,
  onRetry,
  presentation = "default",
  initialScroll = "bottom",
  showTurnActions = false,
  ...contentProps
}: AgentConversationProps) {
  const { t, locale } = useI18n()
  const messages = useMemo(() => {
    const lastInTurn = new Map<string, string>()
    for (const message of session.messages)
      lastInTurn.set(message.turnId, message.messageId)
    return session.messages.map((message, index) => ({
      id: message.messageId,
      role: message.role,
      author: message.role === "agent" ? session.agent.name : undefined,
      state: message.state,
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
          tools={session.tools}
          questions={session.questions}
          changes={session.changes}
          plan={session.plan}
        />
      ),
      after: (
        <>
          {showTurnActions &&
            lastInTurn.get(message.turnId) === message.messageId && (
              <AgentTurnActions
                messages={session.messages}
                turnId={message.turnId}
              />
            )}
          {index === session.messages.length - 1 && attention}
        </>
      ),
    }))
  }, [
    session.messages,
    session.tools,
    session.questions,
    session.changes,
    session.plan,
    session.agent,
    contentProps,
    locale,
    attention,
    showTurnActions,
  ])
  return (
    <div className={styles.chat}>
      {session.history.hasMore && (
        <div className={styles.toolbar}>
          <Button
            variant="ghost"
            size="sm"
            loading={session.history.loading}
            onClick={onLoadHistory}
            disabled={!onLoadHistory}
          >
            {t("workbench.loadHistory")}
          </Button>
        </div>
      )}
      <Conversation
        presentation={presentation}
        layout="fill"
        className={styles.conversation}
        messages={messages}
        revision={session.revision}
        actionsRef={actionsRef}
        initialScroll={initialScroll}
        deferOffscreen={deferOffscreen}
        data={{
          state: session.dataState,
          onRetry,
          error: session.error
            ? {
                category: "network",
                message: session.error,
                reason: session.error,
              }
            : undefined,
        }}
        composer={composer}
      />
    </div>
  )
}
