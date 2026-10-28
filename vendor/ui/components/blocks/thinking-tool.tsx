"use client"
import { useId, useState } from "react"
import { Brain, ChevronRight } from "lucide-react"

import { useI18n } from "../../lib/i18n-provider"
import { redact } from "../../lib/redact"
import { RuntimeStatusBadge } from "../ui/runtime-status-badge"
import { MessageContent } from "./message-content"
import styles from "./agent-tool-relationships.module.css"

export type ThinkingToolProps = {
  /** Public progress supplied by the source; never expanded into a hidden reasoning trace. */
  text?: string
  status?: string
  defaultExpanded?: boolean
}

/**
 * Disclosure for source-published progress. The caller passes the text; nothing
 * here infers or composes reasoning content. Source text is redacted; disclosure
 * stays independent from the runtime status.
 */
export function ThinkingTool({
  text,
  status,
  defaultExpanded = false,
}: ThinkingToolProps) {
  const { t } = useI18n()
  const bodyId = useId()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const progress = text && text.trim() !== "" ? redact(text) : undefined

  return (
    <div className={styles.root} data-relationship="thinking">
      <div className={styles.disclosure}>
        <button
          type="button"
          className={styles.header}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
        >
          <Brain size={16} aria-hidden="true" />
          <span className={styles.title}>{t("agentElements.thinking")}</span>
          <span className={styles.trailing}>
            {status && <RuntimeStatusBadge status={status} />}
            <ChevronRight
              size={16}
              className={styles.chevron}
              data-open={expanded}
              aria-hidden="true"
            />
          </span>
        </button>
        {expanded && (
          <div id={bodyId} className={styles.body}>
            <p className={styles.caption}>
              {t("agentElements.publicProgress")}
            </p>
            {progress ? (
              <MessageContent content={progress} />
            ) : (
              <p className={styles.notice}>{t("agentElements.noProgress")}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
