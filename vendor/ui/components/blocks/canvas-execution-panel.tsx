"use client"
import { useUiFeedback } from "../../lib/i18n-provider"
import { uiMessage } from "../../lib/i18n-core"
import { useI18n } from "../../lib/i18n-provider"

import { useMemo, useState } from "react"
import { Button } from "../ui/button"
import { RuntimeStatusBadge } from "../ui/runtime-status-badge"
import { ActivityTimeline } from "./activity-timeline"
import { ToolCall } from "./tool-call"
import { Inspector } from "./inspector"
import { DataRegion } from "../ui/data-region"
import { previewText, redact, redactText } from "../../lib/redact"
import { canvasRunProblem, canvasRuntimeUnknown } from "../../lib/canvas-runtime"
import type { CanvasRuntimeController } from "../../lib/use-canvas-runtime"
import type { CanvasDocument, CanvasNodeDefinition } from "../../lib/canvas-model"
import styles from "./canvas-controls.module.css"

function bounded(value: unknown, truncatedLabel: string) {
  if (value === undefined) return "—"
  const preview = previewText(redact(value))
  return preview.text + (preview.truncated ? truncatedLabel : "")
}
export type CanvasExecutionPanelProps = {
  runtime: CanvasRuntimeController
  document: CanvasDocument
  definitions: CanvasNodeDefinition[]
  nodeId?: string
  readOnly?: boolean
}
export function CanvasRunControls({
  runtime,
  document,
  definitions,
  nodeId,
  readOnly,
}: CanvasExecutionPanelProps) {
  const { t } = useI18n()

  const { state, adapter } = runtime
  const [scope, setScope] = useState<"all" | "node" | "from" | "to">("all")
  const targetId = scope === "all" ? undefined : nodeId
  const problem = useMemo(
    () => canvasRunProblem(document, definitions, scope, targetId),
    [document, definitions, scope, targetId],
  )
  const active =
    state.snapshot &&
    !["completed", "failed", "cancelled"].includes(state.snapshot.status)
  const locked =
    readOnly ||
    !!state.pending ||
    !!state.uncertain ||
    !!state.awaiting ||
    canvasRuntimeUnknown(state.snapshot)
  return (
    <div
      className={styles.actions}
      aria-label={t("canvasExecutionPanel.runControls")}
    >
      <label>
        {t("canvasExecutionPanel.runScope")}{" "}
        <select
          aria-label={t("canvasExecutionPanel.runScope")}
          value={scope}
          onChange={(event) => setScope(event.target.value as typeof scope)}
        >
          {adapter.scopes.map((value) => (
            <option key={value} value={value}>
              {
                {
                  all: t("canvasExecutionPanel.entireWorkflow"),
                  node: t("canvasExecutionPanel.singleNode"),
                  from: t("canvasExecutionPanel.fromThisNode"),
                  to: t("canvasExecutionPanel.upToThisNode"),
                }[value]
              }
            </option>
          ))}
        </select>
      </label>
      <Button
        size="sm"
        disabled={
          locked || !!active || !!problem || !adapter.scopes.includes(scope)
        }
        onClick={() => runtime.run(scope, nodeId)}
      >
        {t("canvasExecutionPanel.runWorkflow")}
      </Button>
      {adapter.stop && active && (
        <Button
          size="sm"
          variant="outline"
          disabled={locked}
          onClick={runtime.stop}
        >
          {t("canvasExecutionPanel.requestStop")}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={!!state.pending || (!state.snapshot && !state.uncertain)}
        onClick={runtime.query}
      >
        {t("canvasExecutionPanel.queryRun")}
      </Button>
      {state.snapshot && (
        <RuntimeStatusBadge status={redactText(state.snapshot.status)} />
      )}
      {problem && <span className={styles.muted}>{problem}</span>}
    </div>
  )
}
export function CanvasExecutionPanel({
  runtime,
  document,
}: CanvasExecutionPanelProps) {
  const { t } = useI18n()

  const [view, setView] = useState("Activity")
  const [feedback, setFeedback] = useUiFeedback("")
  const { state } = runtime,
    snapshot = state.snapshot
  const payload =
    view === "Variables"
      ? snapshot?.variables
      : view === "Errors"
        ? Object.fromEntries(
            Object.entries(snapshot?.nodes ?? {})
              .filter(([, node]) => node.error)
              .map(([id, node]) => [id, node.error]),
          )
        : snapshot?.events.map((event) => ({
            ...event,
            detail: bounded(event.detail, t("canvas.truncatedPreview")),
          }))
  const text = bounded(payload, t("canvas.truncatedPreview"))
  return (
    <section
      className={styles.execution}
      aria-label={t("canvasExecutionPanel.executionDebugger")}
    >
      <div className={styles.actions}>
        {["Activity", "Logs", "Variables", "Errors"].map((value) => (
          <Button
            key={value}
            size="sm"
            variant="ghost"
            aria-pressed={view === value}
            onClick={() => setView(value)}
          >
            {value}
          </Button>
        ))}
        {snapshot && (
          <span className={styles.muted}>
            Run {redactText(snapshot.runId)}{" "}
            {t("canvasExecutionPanel.documentR")}
            {snapshot.documentRevision}
            {snapshot.documentRevision !== document.revision
              ? t("canvasExecutionPanel.resultsFromAnOlderRevision")
              : ""}
          </span>
        )}
        {snapshot && view !== "Activity" && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text)
                setFeedback(
                  uiMessage("canvasExecutionPanel.redactedPreviewCopied"),
                )
              } catch {
                setFeedback(
                  uiMessage(
                    "canvasExecutionPanel.copyFailedSelectThePreviewManually",
                  ),
                )
              }
            }}
          >
            {t("canvasExecutionPanel.copyRedactedPreview")}
          </Button>
        )}
      </div>
      {state.pending && (
        <p role="status">
          {state.pending}
          {t("canvasExecutionPanel.requestInProgressTheSourceConfirmsTheFinal")}
        </p>
      )}
      {canvasRuntimeUnknown(snapshot) && (
        <p role="alert" className={styles.error}>
          {t(
            "canvasExecutionPanel.executionOutcomeUnknownQueryTheSourceBeforeAnother",
          )}
        </p>
      )}
      {state.awaiting && <p role="status">{state.awaiting}</p>}
      {state.uncertain && (
        <p role="alert" className={styles.error}>
          {state.uncertain}
        </p>
      )}
      {state.transport === "disconnected" && (
        <p className={styles.muted}>
          {t("canvasExecutionPanel.disconnectedLastSnapshotPreserved")}
        </p>
      )}
      <DataRegion
        state={
          state.readError
            ? "error"
            : state.pending && !snapshot
              ? "loading"
              : snapshot
                ? "success"
                : "empty"
        }
        hasContent={!!snapshot}
        error={
          state.readError
            ? {
                category: "network",
                message: state.readError,
                reason: t(
                  "canvasExecutionPanel.theExistingRunSnapshotIsPreservedRetryThe",
                ),
              }
            : undefined
        }
        onRetry={runtime.query}
        emptyTitle={t("canvasExecutionPanel.noExecutionRecordsYet")}
        emptyDescription={t(
          "canvasExecutionPanel.runOrQueryTheExecutionAdapterSuppliedBy",
        )}
      >
        {view === "Activity" || view === "Logs" ? (
          <ActivityTimeline
            compact
            events={(snapshot?.events ?? []).map((event) => ({
              id: event.id,
              time: redactText(event.time),
              type: view === "Logs" ? "Log" : "Execution",
              action: redactText(event.action),
              target: event.nodeId,
              status: redactText(event.status),
              details:
                event.detail === undefined ? undefined : (
                  <pre>
                    {bounded(event.detail, t("canvas.truncatedPreview"))}
                  </pre>
                ),
            }))}
          />
        ) : (
          <pre className={styles.output}>{text}</pre>
        )}
      </DataRegion>
      <p role="status" className={styles.muted}>
        {feedback}
      </p>
    </section>
  )
}
export function CanvasExecutionInspector({
  runtime,
  document,
  nodeId,
  readOnly,
}: CanvasExecutionPanelProps) {
  const { t } = useI18n()

  const [view, setView] = useState("Output")
  const [feedback, setFeedback] = useUiFeedback("")
  const snapshot = runtime.state.snapshot,
    execution = nodeId ? snapshot?.nodes[nodeId] : undefined
  const node = document.nodes.find((node) => node.id === nodeId)
  const payload =
    execution?.[view.toLowerCase() as "input" | "output" | "details" | "trace"]
  const text = bounded(payload, t("canvas.truncatedPreview"))
  const unknown =
    !!runtime.state.uncertain ||
    snapshot?.outcome === "unknown" ||
    execution?.outcome === "unknown"
  const actionAllowed =
    !readOnly && !runtime.state.pending && !unknown && !!runtime.adapter.decide
  return (
    <Inspector
      object={
        node
          ? {
              id: node.id,
              title: node.title,
              kind: "Execution",
              status: execution?.status,
              metadata: [
                {
                  label: t("canvasExecutionPanel.revision"),
                  value: snapshot
                    ? `r${snapshot.documentRevision}${snapshot.documentRevision !== document.revision ? t("canvas.previousRevision") : ""}`
                    : "—",
                },
                { label: "Run", value: snapshot?.runId ?? "—" },
                { label: "Tokens", value: execution?.tokens ?? "—" },
                { label: "Duration", value: execution?.duration ?? "—" },
                { label: "Model", value: execution?.model ?? "—" },
                { label: "Context", value: execution?.context ?? "—" },
              ],
            }
          : null
      }
      emptyDescription={t(
        "canvasExecutionPanel.selectANodeToInspectItsExecutionInput",
      )}
    >
      <div className={styles.actions}>
        {["Input", "Output", "Details", "Trace"].map((value) => (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={view === value}
            key={value}
            onClick={() => setView(value)}
          >
            {value}
          </Button>
        ))}
      </div>
      {execution ? (
        <>
          <pre className={styles.output}>{text}</pre>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text)
                setFeedback(
                  uiMessage("canvasExecutionPanel.redactedPreviewCopied"),
                )
              } catch {
                setFeedback(
                  uiMessage(
                    "canvasExecutionPanel.copyFailedSelectThePreviewManually",
                  ),
                )
              }
            }}
          >
            {t("canvasExecutionPanel.copyRedactedPreview")}
          </Button>
          <p role="status" className={styles.muted}>
            {feedback}
          </p>
          <ToolCall
            key={`${snapshot!.runId}:${nodeId}:${execution.attemptId}:${execution.approval?.id ?? ""}`}
            defaultExpanded
            call={{
              id: `${snapshot!.runId}:${nodeId}:${execution.attemptId}`,
              name: node?.title ?? nodeId!,
              status: redactText(execution.status),
              arguments: bounded(execution.input, t("canvas.truncatedPreview")),
              output: bounded(execution.output, t("canvas.truncatedPreview")),
              outputTruncated: true,
              outcome: unknown ? "unknown" : execution.outcome,
              receipt: snapshot?.receipt,
              error: execution.error
                ? bounded(execution.error, t("canvas.truncatedPreview"))
                : undefined,
              duration: execution.duration,
            }}
            permission={
              execution.approval
                ? {
                    ...execution.approval,
                    onApprove: actionAllowed
                      ? () => runtime.decide(nodeId!, "approve")
                      : undefined,
                    onReject: actionAllowed
                      ? () => runtime.decide(nodeId!, "reject")
                      : undefined,
                  }
                : undefined
            }
            onReconcile={runtime.query}
          />
          {execution.artifacts && (
            <pre className={styles.output}>
              {bounded(execution.artifacts, t("canvas.truncatedPreview"))}
            </pre>
          )}
        </>
      ) : (
        <p className={styles.muted}>
          {t("canvasExecutionPanel.thisRunHasNoExecutionRecordForThis")}
        </p>
      )}
    </Inspector>
  )
}
