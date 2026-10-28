"use client"
import { uiMessage, resolveUiText, type UiText } from "../../lib/i18n-core"
import { useI18n } from "../../lib/i18n-provider"

import { useRef, useState } from "react"
import { Button } from "../ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog"
import { DataRegion, type RegionError } from "../ui/data-region"
import { previewText, redactText } from "../../lib/redact"
import { canvasId } from "../../lib/canvas-model"
import type { DataState } from "../../lib/runtime-status"
import type {
  CanvasCollaborationSnapshot,
  CanvasPublicationReceipt,
} from "../../lib/canvas-services"
import styles from "./canvas-controls.module.css"

export type CanvasServicePayload =
  | { kind: "restore"; versionId: string }
  | { kind: "comment"; text: string; threadId?: string }
  | { kind: "publish"; environmentId: string }
  | { kind: "share" }
export type CanvasServiceCommand = {
  requestId: string
  documentId: string
  expectedServerRevision: string
} & CanvasServicePayload

export type CanvasServicePanelProps = {
  sourceLabel: string
  snapshot: CanvasCollaborationSnapshot
  serverRevision: string
  versions?: {
    id: string
    serverRevision: string
    createdAt: string
    author?: string
  }[]
  environments?: { id: string; name: string; available: boolean }[]
  environmentId?: string
  onEnvironmentChange?: (id: string) => void
  publication?: CanvasPublicationReceipt
  shareUrl?: string
  operation?: {
    requestId: string
    kind: CanvasServiceCommand["kind"]
    status: "pending" | "submitted" | "unknown" | "confirmed" | "rejected"
    message?: string
  }
  onCommand?: (command: CanvasServiceCommand) => void | Promise<void>
  /** Must retain unknown in caller state before a possible remount. */
  onUncertain: (command: CanvasServiceCommand) => void
  onQueryReceipt?: (requestId: string) => void | Promise<void>
  state?: DataState
  error?: RegionError
  onRetry?: () => void
  readOnly?: boolean
}
export function CanvasServicePanel({
  sourceLabel,
  snapshot,
  serverRevision,
  versions = [],
  environments = [],
  environmentId,
  onEnvironmentChange,
  publication,
  shareUrl,
  operation,
  onCommand,
  onUncertain,
  onQueryReceipt,
  state = "success",
  error,
  onRetry,
  readOnly,
}: CanvasServicePanelProps) {
  const { t, locale, resolve } = useI18n()

  const [restore, setRestore] = useState<string>()
  const [draft, setDraft] = useState("")
  const [local, setLocal] = useState<{
    key: string
    requestId: string
    message: UiText
    unknown?: boolean
  }>()
  const busy = useRef(false)
  const key = `${snapshot.documentId}:${snapshot.revision}`
  const localWaiting =
    local?.key === key &&
    !(
      operation?.requestId === local.requestId &&
      ["confirmed", "rejected"].includes(operation.status)
    )
  const waiting =
    localWaiting ||
    (operation &&
      ["pending", "submitted", "unknown"].includes(operation.status))
  const locked = readOnly || !onCommand || !!waiting
  async function dispatch(payload: CanvasServicePayload) {
    if (
      locked ||
      busy.current ||
      !snapshot.permissions[
        payload.kind === "comment" ? "comment" : payload.kind
      ]
    )
      return
    const command = {
      ...payload,
      requestId: canvasId("service-request"),
      documentId: snapshot.documentId,
      expectedServerRevision: serverRevision,
    }
    busy.current = true
    setLocal({
      key,
      requestId: command.requestId,
      message: uiMessage(
        "canvasServicePanel.submittingRequestTheSourceConfirmsTheResult",
      ),
    })
    try {
      await onCommand?.(command)
      setLocal({
        key,
        requestId: command.requestId,
        message: uiMessage(
          "canvasServicePanel.requestSubmittedWaitingForSourceConfirmation",
        ),
      })
    } catch {
      onUncertain(command)
      setLocal({
        key,
        requestId: command.requestId,
        message: uiMessage(
          "canvasServicePanel.outcomeUnknownQueryTheReceiptBeforeSubmittingAgain",
        ),
        unknown: true,
      })
    } finally {
      busy.current = false
    }
  }
  const unknown =
    operation?.status === "unknown" || (local?.key === key && local.unknown)
  const requestId = operation?.requestId ?? local?.requestId
  const publicationValid =
    publication?.documentId === snapshot.documentId &&
    publication?.serverRevision === serverRevision
  const safeUrl = (value: string) => {
    try {
      const url = new URL(value)
      return ["https:", "http:"].includes(url.protocol) ? url.href : undefined
    } catch {
      return undefined
    }
  }
  return (
    <section
      className={styles.execution}
      aria-label={t("canvasServicePanel.serviceIntegration")}
    >
      <p className={styles.muted}>
        {redactText(sourceLabel)} · {redactText(serverRevision)}
        {t("canvasServicePanel.localUndoIsSeparateFromServerVersionHistory")}
      </p>
      <DataRegion
        state={state}
        hasContent={
          versions.length > 0 ||
          snapshot.threads.length > 0 ||
          environments.length > 0
        }
        error={
          error
            ? {
                ...error,
                message: redactText(resolve(error.messageI18n, error.message)),
                messageI18n: undefined,
                reason: redactText(resolve(error.reasonI18n, error.reason)),
                reasonI18n: undefined,
              }
            : undefined
        }
        onRetry={onRetry}
        emptyTitle={t(
          "canvasServicePanel.theSourceHasNotProvidedServiceContent",
        )}
        emptyDescription={t(
          "canvasServicePanel.versionsPermissionsDiscussionsEnvironmentsAndReceiptsAppearWhen",
        )}
      >
        <details open>
          <summary>
            {t("canvasServicePanel.versionHistory")}
            {versions.length}
          </summary>
          <ul className={styles.list}>
            {versions.map((version) => (
              <li key={version.id} className={styles.actions}>
                <span>
                  {redactText(version.id)} · {redactText(version.createdAt)} ·{" "}
                  {redactText(version.author ?? "—")}
                </span>
                {snapshot.permissions.restore && onCommand && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={locked}
                    onClick={() => setRestore(version.id)}
                  >
                    {t("canvasServicePanel.restoreVersionWithId", {
                      id: redactText(version.id),
                    })}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
        <details open>
          <summary>
            {t("canvasServicePanel.discussions")}
            {snapshot.threads.length}
            {t("canvasServicePanel.separateFromNotes")}
          </summary>
          <ul className={styles.list}>
            {snapshot.threads.map((thread) => (
              <li key={thread.id}>
                <strong>
                  {redactText(thread.id)}
                  {thread.resolved ? t("canvasServicePanel.resolved") : ""}
                </strong>
                {thread.messages.map((message) => (
                  <p key={message.id}>
                    {redactText(message.author)} ·{" "}
                    {previewText(redactText(message.text)).text}
                  </p>
                ))}
              </li>
            ))}
          </ul>
          {snapshot.permissions.comment && onCommand && (
            <div className={styles.field}>
              <label htmlFor={`comment-${snapshot.documentId}`}>
                {t("canvasServicePanel.discussionDraft")}
              </label>
              <textarea
                id={`comment-${snapshot.documentId}`}
                value={draft}
                maxLength={4000}
                disabled={readOnly}
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button
                size="sm"
                disabled={locked || !draft.trim()}
                onClick={() =>
                  dispatch({
                    kind: "comment",
                    text: draft.trim(),
                  })
                }
              >
                {t("canvasServicePanel.submitDiscussion")}
              </Button>
              <span className={styles.muted}>
                {t(
                  "canvasServicePanel.submittingDoesNotInsertAMessageTheDraft",
                )}
              </span>
            </div>
          )}
        </details>
        <details>
          <summary>{t("canvasServicePanel.collaborationPresence")}</summary>
          <ul>
            {snapshot.presence
              .filter((member) => member.expiresAt > snapshot.asOf)
              .map((member) => (
                <li key={member.memberId}>
                  {redactText(member.name)}
                  {member.cursor
                    ? t("canvas.cursorPosition", {
                        x: member.cursor.x,
                        y: member.cursor.y,
                      })
                    : ""}
                </li>
              ))}
          </ul>
          <p className={styles.muted}>
            {t(
              "canvasServicePanel.transientStateUsesSourceAsofAndExpiresatValues",
            )}
          </p>
        </details>
        <div className={styles.actions}>
          {environments.length > 0 && (
            <label>
              {t("canvasServicePanel.environments")}
              <select
                aria-label={t("canvasServicePanel.publishEnvironment")}
                value={environmentId ?? ""}
                disabled={readOnly || !!waiting || !onEnvironmentChange}
                onChange={(event) => onEnvironmentChange?.(event.target.value)}
              >
                <option value="">
                  {t("canvasServicePanel.selectAnEnvironment")}
                </option>
                {environments.map((environment) => (
                  <option
                    key={environment.id}
                    value={environment.id}
                    disabled={!environment.available}
                  >
                    {redactText(environment.name)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {snapshot.permissions.publish && onCommand && (
            <Button
              size="sm"
              disabled={
                locked ||
                !environments.some(
                  (environment) =>
                    environment.id === environmentId && environment.available,
                )
              }
              onClick={() =>
                dispatch({
                  kind: "publish",
                  environmentId: environmentId!,
                })
              }
            >
              {t("canvasServicePanel.publishSavedRevision")}
            </Button>
          )}
          {snapshot.permissions.share && onCommand && (
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => dispatch({ kind: "share" })}
            >
              {t("canvasServicePanel.requestSharingLink")}
            </Button>
          )}
        </div>
        {publication &&
          (publicationValid ? (
            <p>
              {t("canvasServicePanel.publicationConfirmedBySource")}
              {redactText(publication.publicationId)} ·{" "}
              {redactText(publication.environmentId)}
            </p>
          ) : (
            <p className={styles.error}>
              {t(
                "canvasServicePanel.thisPublicationReceiptBelongsToAnotherDocumentOr",
              )}
            </p>
          ))}
        {shareUrl && safeUrl(shareUrl) && (
          <a href={safeUrl(shareUrl)} target="_blank" rel="noreferrer">
            {t("canvasServicePanel.openSharingLinkSuppliedBySource")}
          </a>
        )}
      </DataRegion>
      <p role="status">
        {redactText(
          operation?.message ??
            (local?.key === key ? resolveUiText(locale, local.message) : ""),
        )}
      </p>
      {unknown && requestId && onQueryReceipt && (
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            if (busy.current) return
            busy.current = true
            try {
              await onQueryReceipt(requestId)
            } catch {
              setLocal({
                key,
                requestId,
                message: uiMessage(
                  "canvasServicePanel.receiptQueryFailedTheOriginalRequestAndUnknown",
                ),
                unknown: true,
              })
            } finally {
              busy.current = false
            }
          }}
        >
          {t("canvasServicePanel.queryOperationReceipt")}
        </Button>
      )}
      <Dialog
        open={!!restore}
        onOpenChange={(open) => {
          if (!open) setRestore(undefined)
        }}
      >
        <DialogContent>
          <DialogTitle>
            {t("canvasServicePanel.restoreServerVersion")}
          </DialogTitle>
          <DialogDescription>
            {t("canvasServicePanel.useVersion")}
            {redactText(restore ?? "")}{" "}
            {t("canvasServicePanel.asANewServerRevisionTheCallerPreserves")}
          </DialogDescription>
          <Button
            disabled={locked || !snapshot.permissions.restore}
            onClick={() => {
              if (restore)
                void dispatch({
                  kind: "restore",
                  versionId: restore,
                })
              setRestore(undefined)
            }}
          >
            {t("canvasServicePanel.confirmVersionRestore")}
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  )
}
