"use client"
import { useId } from "react"
import { Button } from "../ui/button"
import { ToolCall } from "./tool-call"
import { useI18n } from "../../lib/i18n-provider"
import { redact, previewText } from "../../lib/redact"
import type { AttentionAction, AttentionRecord } from "../../lib/agent-board-model"
import styles from "./agent-board.module.css"
export type ApprovalRequestPanelProps = {
  request: AttentionRecord
  draft?: string
  onDraftChange?: (value: string) => void
  onAction?: (action: AttentionAction | "reconcile") => Promise<void>
  canReconcile?: boolean
}
/** The adapter retains operation state, drafts and receipt/version guards. */
export function ApprovalRequestPanel({
  request,
  draft = "",
  onDraftChange,
  onAction,
  canReconcile,
}: ApprovalRequestPanelProps) {
  const { t } = useI18n()
  const responseId = useId()
  const unknown =
    request.operation?.state === "unknown" ||
    (request.kind === "unknown" && request.operation?.state !== "confirmed")
  const locked = Boolean(
    request.expired ||
    request.disabledReason ||
    request.operation?.state === "pending" ||
    request.operation?.state === "confirmed" ||
    unknown,
  )
  const invoke = onAction && !locked ? onAction : undefined
  const allowed = (action: AttentionAction) =>
    Boolean(invoke && request.allowedActions.includes(action))
  const toolPermission =
    request.tool && !unknown && (allowed("accept") || allowed("reject"))
      ? {
          scope: request.scope ?? "—",
          risk: request.risk ?? "—",
          onApprove: allowed("accept") ? () => invoke!("accept") : undefined,
          onReject: allowed("reject") ? () => invoke!("reject") : undefined,
        }
      : undefined
  return (
    <section className={styles.request} data-attention-id={request.attentionId}>
      <h3>{redact(request.title)}</h3>
      <p>{redact(request.reason)}</p>
      <p className={styles.meta}>
        {request.attentionId} · {t("agentBoard.requestVersion")}:{" "}
        {request.revision}
      </p>
      {request.deadline && (
        <p>
          {t("agentBoard.deadline")}: {request.deadline}
        </p>
      )}
      {request.expired && <p role="alert">{t("agentBoard.expired")}</p>}
      {request.disabledReason && <p>{redact(request.disabledReason)}</p>}
      {unknown && (
        <p role="alert" className={styles.warning}>
          {t("agentBoard.unknownOutcome")}
        </p>
      )}
      {request.operation && (
        <p role={request.operation.state === "rejected" ? "alert" : "status"}>
          {request.operation.state === "confirmed"
            ? t("agentBoard.submitted")
            : request.operation.state === "pending"
              ? t("agentBoard.submitting")
              : request.operation.state === "rejected"
                ? t("agentBoard.rejected")
                : ""}{" "}
          {request.operation.message && redact(request.operation.message)}
        </p>
      )}
      {!onAction && <p>{t("agentBoard.readOnly")}</p>}
      {request.tool ? (
        <ToolCall
          key={`${request.attentionId}:${request.revision}:${request.operation?.state ?? "ready"}`}
          call={{
            ...request.tool,
            status: request.tool.status ?? "waiting",
            outcome: unknown ? "unknown" : "known",
            target: request.target,
          }}
          defaultExpanded
          permission={toolPermission}
          onReconcile={
            unknown && canReconcile && onAction
              ? () => onAction("reconcile")
              : undefined
          }
        />
      ) : (
        <>
          <p>
            {t("agentBoard.scope")}:{" "}
            {redact(request.scope ?? request.target ?? "—")}
          </p>
          <p>
            {t("agentBoard.risk")}: {redact(request.risk ?? "—")}
          </p>
          {request.parameters !== undefined && (
            <pre className={styles.pre}>
              {previewText(redact(request.parameters)).text}
            </pre>
          )}
        </>
      )}
      {request.allowedActions.some(
        (action) => action === "edit" || action === "respond",
      ) &&
        onDraftChange && (
          <div className={styles.field}>
            <label htmlFor={responseId}>{t("agentBoard.response")}</label>
            <textarea
              id={responseId}
              value={draft}
              disabled={locked}
              onChange={(event) => onDraftChange(event.target.value)}
            />
          </div>
        )}
      <div className={styles.actions}>
        {request.allowedActions
          .filter(
            (action) =>
              !request.tool || (action !== "accept" && action !== "reject"),
          )
          .map(
            (action) =>
              onAction && (
                <Button
                  key={action}
                  variant="secondary"
                  disabled={
                    locked ||
                    ((action === "respond" || action === "edit") &&
                      !draft.trim())
                  }
                  onClick={() => void onAction(action)}
                >
                  {t(`agentBoard.${action}`)}
                </Button>
              ),
          )}
        {!request.tool && unknown && canReconcile && onAction && (
          <Button onClick={() => void onAction("reconcile")}>
            {t("agentBoard.reconcile")}
          </Button>
        )}
      </div>
    </section>
  )
}
