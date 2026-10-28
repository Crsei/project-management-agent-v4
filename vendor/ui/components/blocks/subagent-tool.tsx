"use client"
import { useId, useMemo, useState, type ReactNode } from "react"
import { Bot, ChevronRight } from "lucide-react"

import { useI18n } from "../../lib/i18n-provider"
import { redact } from "../../lib/redact"
import type { WorkbenchTool } from "../../lib/agent-workbench-model"
import {
  currentActivityTool,
  subagentHierarchy,
  summarizeToolRelationships,
  toolStatusIsActive,
} from "../../lib/agent-tool-relationships"
import { RuntimeStatusBadge } from "../ui/runtime-status-badge"
import { SourceElapsed } from "./tool-group"
import styles from "./agent-tool-relationships.module.css"

export type SubagentToolProps = {
  call: WorkbenchTool
  tools: readonly WorkbenchTool[]
  renderTool: (call: WorkbenchTool) => ReactNode
  defaultExpanded?: boolean
}

/**
 * Subagent activity built from the source `parentId` association. Nested tools
 * are rendered through the caller's `renderTool`, so execution, approval, and
 * unknown-outcome handling stay with the single ToolCall owner.
 */
export function SubagentTool({
  call,
  tools,
  renderTool,
  defaultExpanded = false,
}: SubagentToolProps) {
  const { t, number } = useI18n()
  const bodyId = useId()
  const detailId = useId()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const hierarchy = useMemo(() => subagentHierarchy(call, tools), [call, tools])
  const childSummary = useMemo(
    () => summarizeToolRelationships(hierarchy.children, call.status),
    [hierarchy, call.status],
  )
  const display = call.display?.kind === "subagent" ? call.display : undefined
  const description = display?.description
  const title = display?.agentName?.trim() || t("agentElements.subagent")
  const active = toolStatusIsActive(call.status)
  const expandable = !hierarchy.cyclic && hierarchy.children.length > 0
  const current =
    hierarchy.cyclic || !active
      ? undefined
      : currentActivityTool(hierarchy.descendants)
  const interrupted =
    call.status === "cancelled" || call.status === "interrupted"

  const header = (
    <>
      <Bot size={16} aria-hidden="true" />
      <span className={styles.title}>{redact(title)}</span>
      {description && (
        <span className={styles.target}>{redact(description)}</span>
      )}
      <span className={styles.count}>
        {t("agentElements.toolCount", { count: hierarchy.children.length })}
      </span>
      <RuntimeStatusBadge status={call.status} />
      {childSummary.attention.map((marker) => (
        <span key={marker.status} className={styles.marker}>
          <RuntimeStatusBadge status={marker.status} />
          <span>× {number(marker.count)}</span>
        </span>
      ))}
      {childSummary.unknown > 0 && (
        <span className={styles.marker} data-tone="warning">
          {t("toolCall.outcomeUnknown")} × {number(childSummary.unknown)}
        </span>
      )}
      <span className={styles.trailing}>
        {call.duration ? (
          <span className={styles.duration}>{redact(call.duration)}</span>
        ) : call.startedAt ? (
          <SourceElapsed
            startedAt={call.startedAt}
            active={active}
            className={styles.duration}
          />
        ) : (
          <span className={styles.duration}>
            {t("agentElements.durationUnknown")}
          </span>
        )}
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

  if (hierarchy.cyclic) {
    return (
      <div className={styles.root} data-relationship="subagent">
        <div className={styles.disclosure}>
          <div className={styles.header} data-static="true">
            {header}
          </div>
          <p className={styles.alert} role="alert">
            {t("agentElements.invalidHierarchy")}
          </p>
        </div>
      </div>
    )
  }

  const detail =
    current || interrupted ? (
      <p id={detailId} className={styles.detail}>
        {current && (
          <span>
            {t("agentElements.currentTool", { name: redact(current.name) })}
          </span>
        )}
        {interrupted && (
          <span className={styles.marker} data-tone="warning">
            {t("agentElements.interrupted")}
          </span>
        )}
      </p>
    ) : null

  return (
    <div className={styles.root} data-relationship="subagent">
      <div className={styles.disclosure}>
        {expandable ? (
          <button
            type="button"
            className={styles.header}
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-describedby={detail ? detailId : undefined}
            onClick={() => setExpanded((value) => !value)}
          >
            {header}
          </button>
        ) : (
          <div className={styles.header} data-static="true">
            {header}
          </div>
        )}
        {detail}
        {expandable && expanded && (
          <div id={bodyId} className={styles.body}>
            <ul
              role="list"
              aria-label={t("agentElements.subagent")}
              className={styles.list}
              data-nested="true"
            >
              {hierarchy.children.map((tool) => (
                <li key={tool.id}>{renderTool(tool)}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
