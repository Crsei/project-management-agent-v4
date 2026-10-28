"use client"
import { useI18n } from "../../lib/i18n-provider"

import { Box, AlertTriangle } from "lucide-react"
import { RuntimeStatusBadge } from "./runtime-status-badge"
import { CanvasPort } from "./canvas-port"
import type {
  CanvasNodeDefinition,
  CanvasNodeRecord,
  CanvasIssue,
  CanvasExecutionVisuals,
} from "../../lib/canvas-model"
import { redactText } from "../../lib/redact"
import styles from "./canvas-node.module.css"

export type CanvasNodeProps = {
  node: CanvasNodeRecord
  definition?: CanvasNodeDefinition
  selected?: boolean
  readOnly?: boolean
  status?: string
  executionVisuals?: CanvasExecutionVisuals
  outcome?: "known" | "unknown"
  issues?: CanvasIssue[]
  fallbackPorts?: CanvasNodeDefinition["ports"]
}
export function CanvasNode({
  node,
  definition,
  selected,
  readOnly,
  status,
  executionVisuals,
  outcome,
  issues = [],
  fallbackPorts = [],
}: CanvasNodeProps) {
  const { t, resolve } = useI18n()

  return (
    <div
      className={styles.node}
      data-canvas-node={node.id}
      data-selected={selected || undefined}
      data-execution-status={status}
      data-execution-active={
        (outcome !== "unknown" &&
          ["starting", "running", "thinking"].includes(status ?? "")) ||
        undefined
      }
      data-execution-paused={
        executionVisuals?.paused ||
        executionVisuals?.edgeEffect === "none" ||
        undefined
      }
      style={{
        animationDuration: `calc(var(--canvas-execution-duration) / ${executionVisuals?.speed ?? 1})`,
      }}
      data-unknown={!definition || undefined}
    >
      <header>
        <span>{definition?.icon ?? <Box size={16} />}</span>
        <strong>{redactText(node.title)}</strong>
        <small>
          {resolve(
            definition?.labelI18n,
            definition?.label ?? t("nodeInspector.unknownNode"),
          )}
        </small>
      </header>
      <div className={styles.summary}>
        {definition
          ? redactText(
              resolve(
                definition.summaryI18n,
                definition.summary?.(node) ??
                  resolve(definition.labelI18n, definition.label),
              ),
            )
          : t("canvasNode.originalDataPreservedInstallTheNodeDefinitionTo")}
      </div>
      <div>
        {(definition?.ports ?? fallbackPorts).map((port) => (
          <CanvasPort
            key={port.id}
            port={port}
            readOnly={readOnly || !definition}
            unknownType={!definition}
          />
        ))}
      </div>
      {(status || issues.length > 0 || outcome === "unknown") && (
        <footer>
          {status && <RuntimeStatusBadge status={status} />}
          {outcome === "unknown" && <span>{t("toolCall.outcomeUnknown")}</span>}
          {issues.length > 0 && (
            <span className={styles.issue}>
              <AlertTriangle size={14} />
              {issues.length} {t("canvasNode.validationIssues")}
            </span>
          )}
        </footer>
      )}
    </div>
  )
}
