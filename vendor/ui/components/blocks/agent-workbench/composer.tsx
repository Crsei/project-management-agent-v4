"use client"
import { useEffect, useId, useRef, type ReactNode } from "react"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../../ui/select"
import { Paperclip, Square, AtSign, Slash } from "lucide-react"
import { RuntimeStatusBadge } from "../../ui/runtime-status-badge"
import { Button } from "../../ui/button"
import { ChatComposer } from "../chat-message"
import { useI18n } from "../../../lib/i18n-provider"
import {
  draftCanSubmit,
  activeReceipt,
  type DraftState,
  type SessionSnapshot,
  type WorkbenchChoice,
  type OperationReceipt,
} from "../../../lib/agent-workbench-model"
import styles from "./workbench.module.css"
import { ModelPicker } from "../model-picker"
import { ModeSelector } from "../mode-selector"
import type { SuggestionItem } from "../suggestions"
export type ComposerControlsProps = {
  draft: DraftState
  onChange: (draft: DraftState) => void
  models: readonly WorkbenchChoice[]
  permissions: readonly WorkbenchChoice[]
  environments: readonly WorkbenchChoice[]
  session: SessionSnapshot
  compact?: boolean
  modes?: readonly DraftState["mode"][]
  behaviorModes?: readonly WorkbenchChoice[]
}
export function ComposerControls({
  draft,
  onChange,
  models,
  permissions,
  environments,
  session,
  compact = false,
  modes = ["send", "queue", "steer"],
  behaviorModes,
}: ComposerControlsProps) {
  const { t } = useI18n()
  const id = useId()
  const fields = [
    {
      key: "permissionId",
      label: t("workbench.permission"),
      choices: permissions,
    },
    {
      key: "environmentId",
      label: t("workbench.environment"),
      choices: environments,
    },
  ] as const
  return (
    <div className={styles.controls} data-compact={compact || undefined}>
      <ModelPicker
        models={models}
        value={draft.modelId}
        onChange={(modelId) =>
          onChange({ ...draft, modelId, version: draft.version + 1 })
        }
      />
      {behaviorModes && draft.behaviorMode && (
        <ModeSelector
          modes={behaviorModes}
          value={draft.behaviorMode}
          onChange={(behaviorMode) =>
            onChange({ ...draft, behaviorMode, version: draft.version + 1 })
          }
        />
      )}
      {fields
        .filter((f) => !compact || f.key !== "environmentId")
        .map((f) => (
          <label
            className={styles.label}
            key={f.key}
            htmlFor={`${id}-${f.key}`}
          >
            <span className={compact ? "sr-only" : undefined}>{f.label}</span>
            {compact ? (
              <Select
                items={f.choices.map((c) => ({ value: c.id, label: c.label }))}
                value={draft[f.key]}
                onValueChange={(value) => {
                  if (value)
                    onChange({
                      ...draft,
                      [f.key]: value,
                      version: draft.version + 1,
                    })
                }}
              >
                <SelectTrigger id={`${id}-${f.key}`} aria-label={f.label}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {f.choices.map((c) => (
                    <SelectItem
                      key={c.id}
                      value={c.id}
                      disabled={Boolean(c.disabledReason)}
                    >
                      {c.label}
                      {c.disabledReason ? ` · ${c.disabledReason}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <select
                className={styles.select}
                id={`${id}-${f.key}`}
                value={draft[f.key]}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    [f.key]: e.target.value,
                    version: draft.version + 1,
                  })
                }
              >
                {f.choices.map((choice) => (
                  <option
                    key={choice.id}
                    value={choice.id}
                    disabled={Boolean(choice.disabledReason)}
                  >
                    {choice.label}
                    {choice.disabledReason ? ` · ${choice.disabledReason}` : ""}
                  </option>
                ))}
              </select>
            )}
          </label>
        ))}
      <label className={styles.label} htmlFor={`${id}-mode`}>
        <span className={compact ? "sr-only" : undefined}>
          {t("workbench.inputMode")}
        </span>
        <select
          className={styles.select}
          id={`${id}-mode`}
          value={draft.mode}
          onChange={(e) =>
            onChange({
              ...draft,
              mode: e.target.value as DraftState["mode"],
              version: draft.version + 1,
            })
          }
        >
          {modes.map((mode) => (
            <option
              key={mode}
              value={mode}
              disabled={!session.capabilities[mode]}
            >
              {t(`workbench.${mode}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
export type AgentComposerProps = ComposerControlsProps & {
  receipts: readonly OperationReceipt[]
  onSubmit: (draft: DraftState) => void | Promise<void>
  onInterrupt?: () => void
  onReconcile?: (receipt: OperationReceipt) => void
  onFiles?: (files: File[]) => void
  attachments?: ReactNode
  quickControls?: boolean
  referenceStrip?: ReactNode
  onOpenContext?: () => void
  onCommandMenu?: () => void
  onOpenSettings?: () => void
  editableOffline?: boolean
  suggestions?: readonly SuggestionItem[]
  questionBar?: ReactNode
  infoBar?: ReactNode
}
export function AgentComposer({
  draft,
  onChange,
  models,
  permissions,
  environments,
  session,
  receipts,
  onSubmit,
  onInterrupt,
  onReconcile,
  onFiles,
  attachments,
  quickControls = true,
  referenceStrip,
  onOpenContext,
  onCommandMenu,
  onOpenSettings,
  modes,
  editableOffline = false,
  behaviorModes,
  suggestions,
  questionBar,
  infoBar,
}: AgentComposerProps) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let frame = 0
    const revealFocusedInput = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const input = root.querySelector("textarea")
        if (
          !input ||
          document.activeElement !== input ||
          !root.getClientRects().length
        )
          return
        const bounds = root.getBoundingClientRect(),
          field = input.getBoundingClientRect()
        const top = bounds.top + root.clientTop + 2
        const bottom = bounds.top + root.clientTop + root.clientHeight - 2
        const primary = root.querySelector<HTMLButtonElement>(
          'button[type="submit"]',
        )
        const actionBottom =
          primary?.getBoundingClientRect().bottom ?? field.bottom
        // Keep both input and Send visible when the soft keyboard reduces the dock.
        const targetBottom =
          actionBottom - field.top <= bottom - top ? actionBottom : field.bottom
        if (field.top < top) root.scrollTop -= Math.ceil(top - field.top)
        else if (targetBottom > bottom)
          root.scrollTop += Math.ceil(targetBottom - bottom)
      })
    }
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(revealFocusedInput)
    observer?.observe(root)
    window.addEventListener("resize", revealFocusedInput)
    root.addEventListener("focusin", revealFocusedInput)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", revealFocusedInput)
      root.removeEventListener("focusin", revealFocusedInput)
      cancelAnimationFrame(frame)
    }
  }, [])
  const receipt = activeReceipt(receipts, session.sessionId)
  const latestReceipt = receipts.findLast(
    (entry) => entry.targetId === session.sessionId,
  )
  const connected = session.environment.connection === "connected"
  const canSubmit = draftCanSubmit(session, draft, receipts)
  const validChoices = [
    models.some((m) => m.id === draft.modelId && !m.disabledReason),
    permissions.some((p) => p.id === draft.permissionId && !p.disabledReason),
    environments.some((e) => e.id === draft.environmentId && !e.disabledReason),
  ].every(Boolean)
  return (
    <section
      ref={rootRef}
      className={styles.composer}
      aria-label={t("workbench.inputMode")}
      data-draft-id={draft.draftId}
    >
      {(["running", "thinking", "starting", "waiting", "queued"].includes(
        session.status,
      ) ||
        onInterrupt) && (
        <div className={styles.composerRun}>
          <span>{session.agent.name}</span>
          <RuntimeStatusBadge status={session.status} />
          {onInterrupt && session.capabilities.interrupt && (
            <Button
              variant="ghost"
              onClick={onInterrupt}
              disabled={Boolean(receipt)}
            >
              <Square size={14} />
              {t("workbench.interrupt")}
            </Button>
          )}
        </div>
      )}
      <ChatComposer
        presentation="workspace"
        suggestions={suggestions}
        questionBar={questionBar}
        infoBar={infoBar}
        onFiles={onFiles}
        outcome={receipt?.state ?? latestReceipt?.state}
        receiptRevision={receipt?.requestId ?? latestReceipt?.requestId}
        onReconcile={
          receipt && onReconcile ? () => onReconcile(receipt) : undefined
        }
        sendLabel={t(
          draft.mode === "queue"
            ? "workbench.submitQueue"
            : draft.mode === "steer"
              ? "workbench.submitSteer"
              : "workbench.send",
        )}
        controls={
          <ComposerControls
            {...{
              draft,
              onChange,
              models,
              permissions,
              environments,
              session,
              modes,
              behaviorModes,
            }}
            compact={quickControls}
          />
        }
        tools={
          <>
            {referenceStrip && (
              <div className={styles.composerReferences}>{referenceStrip}</div>
            )}
            {onOpenContext && (
              <Button variant="ghost" size="sm" onClick={onOpenContext}>
                <AtSign size={16} />
                {t("workbench.attachContext")}
              </Button>
            )}
            {onCommandMenu && (
              <Button variant="ghost" size="sm" onClick={onCommandMenu}>
                <Slash size={16} />
                {t("resource.commandMenu")}
              </Button>
            )}
            {onFiles && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip size={16} />
                  {t("workbench.attachments")}
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  multiple
                  onChange={(e) => {
                    onFiles(Array.from(e.target.files ?? []))
                    e.target.value = ""
                  }}
                />
              </>
            )}
            {(attachments || onOpenSettings || quickControls) && (
              <details
                className={styles.composerSettings}
                data-composer-settings
              >
                <summary>{t("workbench.composerSettings")}</summary>
                <div className={styles.composerOptions}>
                  {quickControls && (
                    <label className={styles.label}>
                      {t("workbench.environment")}
                      <select
                        className={styles.select}
                        value={draft.environmentId}
                        onChange={(e) =>
                          onChange({
                            ...draft,
                            environmentId: e.target.value,
                            version: draft.version + 1,
                          })
                        }
                      >
                        {environments.map((e) => (
                          <option
                            key={e.id}
                            value={e.id}
                            disabled={Boolean(e.disabledReason)}
                          >
                            {e.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {attachments}
                  {onOpenSettings && (
                    <Button variant="ghost" size="sm" onClick={onOpenSettings}>
                      {t("resource.settings")}
                    </Button>
                  )}
                </div>
              </details>
            )}
          </>
        }
        value={draft.text}
        onChange={(text) =>
          onChange({ ...draft, text, version: draft.version + 1 })
        }
        onSend={() => {
          if (canSubmit && validChoices) return onSubmit(draft)
        }}
        sendDisabled={!canSubmit || !validChoices}
        pending={receipt?.state === "pending"}
        disabled={!connected && !editableOffline}
        attachments={
          receipt || (!canSubmit && draft.text.trim()) || !validChoices ? (
            <>
              {receipt && (
                <div className={styles.row} role="status">
                  {t(`workbench.${receipt.state}`)}
                  {receipt.state === "unknown" && onReconcile && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onReconcile(receipt)}
                    >
                      {t("workbench.reconcile")}
                    </Button>
                  )}
                </div>
              )}
              {!canSubmit && draft.text.trim() && (
                <p className={styles.meta}>
                  {receipt
                    ? t(
                        receipt.state === "unknown"
                          ? "workbench.draftRetained"
                          : "workbench.draftPending",
                      )
                    : !connected
                      ? t("workbench.disconnected")
                      : draft.context.some(
                            (r) => r.included && r.availability !== "available",
                          )
                        ? t("workbench.blockedContext")
                        : t("workbench.noCapability")}
                </p>
              )}
              {!validChoices && (
                <p role="alert">{t("workbench.unavailable")}</p>
              )}
            </>
          ) : undefined
        }
      />
      <p className={styles.composerHint}>
        {t("chatMessage.enterToSendShiftEnterForANew")}
      </p>
    </section>
  )
}
