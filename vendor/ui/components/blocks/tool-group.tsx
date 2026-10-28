"use client"
import { useEffect, useId, useMemo, useState, type ReactNode } from "react"
import { ChevronRight, Layers } from "lucide-react"

import { useI18n } from "../../lib/i18n-provider"
import type { MessageKey } from "../../lib/i18n-core"
import { redact } from "../../lib/redact"
import { cn } from "../../lib/utils"
import type { WorkbenchTool } from "../../lib/agent-workbench-model"
import {
  formatElapsed,
  parseSourceTimestamp,
  relationshipIsActive,
  summarizeToolRelationships,
  toolCategories,
  type ToolCategory,
} from "../../lib/agent-tool-relationships"
import { RuntimeStatusBadge } from "../ui/runtime-status-badge"
import styles from "./agent-tool-relationships.module.css"

export type ToolGroupProps = {
  tools: readonly WorkbenchTool[]
  renderTool: (call: WorkbenchTool) => ReactNode
  title?: string
  status?: string
  defaultExpanded?: boolean
  startedAt?: string
  className?: string
}

const categoryLabels: Record<ToolCategory, MessageKey> = {
  files: "agentElements.files",
  searches: "agentElements.searches",
  commands: "agentElements.commands",
  other: "agentElements.other",
}

/**
 * Live elapsed text for a source-supplied `startedAt`. Renders nothing when the
 * source provided no start time, stops on terminal statuses, and clears its
 * interval on unmount. The clock reads the wall clock only; runtime state stays
 * with the caller.
 */
export function SourceElapsed({
  startedAt,
  active,
  className,
}: {
  startedAt?: string
  active: boolean
  className?: string
}) {
  const { t } = useI18n()
  const start = parseSourceTimestamp(startedAt)
  const [tick, setTick] = useState<{ at: number; value: number }>()

  useEffect(() => {
    if (start === undefined || !active) return
    const update = () => setTick({ at: start, value: Date.now() })
    const initial = window.setTimeout(update, 0)
    const timer = window.setInterval(update, 1000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [start, active])

  if (start === undefined) return null
  const elapsed = tick && tick.at === start ? tick.value - start : undefined
  if (elapsed !== undefined) {
    return (
      <span className={className}>
        {t("agentElements.elapsed", {
          duration: formatElapsed(Math.max(0, elapsed)),
        })}
      </span>
    )
  }
  if (active) return null
  return <span className={className}>{t("agentElements.durationUnknown")}</span>
}

export function ToolGroup({
  tools,
  renderTool,
  title,
  status,
  defaultExpanded = false,
  startedAt,
  className,
}: ToolGroupProps) {
  const { t, number } = useI18n()
  const bodyId = useId()
  const detailId = useId()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const summary = useMemo(
    () => summarizeToolRelationships(tools, status),
    [tools, status],
  )
  const active = useMemo(
    () => relationshipIsActive(status, tools),
    [status, tools],
  )
  const expandable = summary.total > 0
  const caption = title
    ? redact(title)
    : t("agentElements.toolCount", { count: summary.total })
  const categories = toolCategories
    .filter((category) => summary.counts[category] > 0)
    .map(
      (category) =>
        `${t(categoryLabels[category])} ${number(summary.counts[category])}`,
    )
    .join(" · ")

  const header = (
    <>
      <Layers size={16} aria-hidden="true" />
      <span className={styles.title}>{caption}</span>
      {title && (
        <span className={styles.count}>
          {t("agentElements.toolCount", { count: summary.total })}
        </span>
      )}
      {status && <RuntimeStatusBadge status={status} />}
      {summary.attention.map((marker) => (
        <span key={marker.status} className={styles.marker}>
          <RuntimeStatusBadge status={marker.status} />
          <span>× {number(marker.count)}</span>
        </span>
      ))}
      {summary.unknown > 0 && (
        <span className={styles.marker} data-tone="warning">
          {t("toolCall.outcomeUnknown")} × {number(summary.unknown)}
        </span>
      )}
      <span className={styles.trailing}>
        <SourceElapsed
          startedAt={startedAt}
          active={active}
          className={styles.duration}
        />
        {expandable && (
          <ChevronRight
            size={16}
            className={styles.chevron}
            data-open={expanded}
            aria-hidden="true"
          />
        )}
      </span>
    </>
  )

  return (
    <div className={cn(styles.root, className)} data-relationship="group">
      <div className={styles.disclosure}>
        {expandable ? (
          <button
            type="button"
            className={styles.header}
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-describedby={categories ? detailId : undefined}
            onClick={() => setExpanded((value) => !value)}
          >
            {header}
          </button>
        ) : (
          <div className={styles.header} data-static="true">
            {header}
          </div>
        )}
        {categories && (
          <p id={detailId} className={styles.detail}>
            {categories}
          </p>
        )}
        {expandable && expanded && (
          <div id={bodyId} className={styles.body}>
            <ul
              role="list"
              aria-label={t("agentElements.tools")}
              className={styles.list}
            >
              {tools.map((tool) => (
                <li key={tool.id}>{renderTool(tool)}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
