"use client"

import { Copy } from "lucide-react"
import type { WorkbenchMessage } from "../../lib/agent-workbench-model"
import { useI18n, useUiFeedback } from "../../lib/i18n-provider"
import { uiMessage } from "../../lib/i18n-core"
import { Button } from "../ui/button"
import { messageCopyText } from "./agent-message"
import styles from "./agent-message.module.css"

export function AgentTurnActions({
  messages,
  turnId,
}: {
  messages: readonly WorkbenchMessage[]
  turnId: string
}) {
  const { t } = useI18n()
  const [feedback, setFeedback] = useUiFeedback("")
  return (
    <div className={styles.turnActions} data-agent-turn-id={turnId}>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t("agentElements.copyTurn")}
        onClick={async () => {
          const content = messages
            .filter((message) => message.turnId === turnId)
            .map((message) => messageCopyText(message))
            .join("\n\n")
          try {
            await navigator.clipboard.writeText(content)
            setFeedback(uiMessage("agentElements.turnCopied"))
          } catch {
            setFeedback(
              uiMessage("chatMessage.clipboardUnavailableCopyManually"),
            )
          }
        }}
      >
        <Copy size={16} aria-hidden="true" />
      </Button>
      <span role="status">{feedback}</span>
    </div>
  )
}
