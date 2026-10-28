"use client"
import { useUiFeedback } from "../../lib/i18n-provider"
import { uiMessage } from "../../lib/i18n-core"
import { useI18n } from "../../lib/i18n-provider"

import { type ReactNode } from "react"
import { Copy } from "lucide-react"
import { Button } from "../ui/button"
import { RuntimeStatusBadge } from "../ui/runtime-status-badge"
import { DataRegion, type RegionError } from "../ui/data-region"
import type { DataState } from "../../lib/runtime-status"
import styles from "./inspector.module.css"

export type InspectorObject = {
  id: string
  title: string
  kind: string
  status?: string
  metadata: { label: string; value?: ReactNode; copyValue?: string }[]
}
export type InspectorProps = {
  object: InspectorObject | null
  state?: DataState
  error?: RegionError
  onRetry?: () => void
  refreshing?: boolean
  children?: ReactNode
  emptyDescription?: string
}
/** Object data is controlled; docking, resizing and modal focus belong to WorkspaceShell. */
export function Inspector({
  object,
  state = "success",
  error,
  onRetry,
  refreshing,
  children,
  emptyDescription,
}: InspectorProps) {
  // Keying the body also clears per-object copy feedback on a selection change.
  return (
    <InspectorBody
      key={object?.id ?? "no-selection"}
      object={object}
      state={state}
      error={error}
      onRetry={onRetry}
      refreshing={refreshing}
      emptyDescription={emptyDescription}
    >
      {children}
    </InspectorBody>
  )
}
function InspectorBody({
  object,
  state,
  error,
  onRetry,
  refreshing,
  children,
  emptyDescription,
}: InspectorProps) {
  const { t } = useI18n()

  const [feedback, setFeedback] = useUiFeedback("")
  if (!object)
    return (
      <DataRegion
        state="empty"
        emptyTitle={t("inspector.noObjectSelected")}
        emptyDescription={
          emptyDescription ??
          t("inspector.selectASessionAgentOrActivityToInspect")
        }
      />
    )
  return (
    <div className={styles.content} data-inspector-object={object.id}>
      <section>
        <h3>
          {t("inspector.currentObject")}
          {object.kind}
        </h3>
        <p className={styles.title}>{object.title}</p>
        {object.status && <RuntimeStatusBadge status={object.status} />}
      </section>
      <DataRegion
        state={state}
        hasContent={object.metadata.length > 0}
        error={error}
        onRetry={onRetry}
        refreshing={refreshing}
        loadingLabel={t("inspector.loadingObjectDetails")}
        partialDescription={t(
          "inspector.objectDetailsAreIncompleteMissingFieldsAppearAs",
        )}
      >
        <section>
          <h3>Metadata</h3>
          <dl>
            {object.metadata.map((field) => (
              <div key={field.label} className={styles.field}>
                <dt>{field.label}</dt>
                <dd>
                  <span>{field.value ?? "—"}</span>
                  {field.copyValue !== undefined && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("common.copyValue", {
                        value0: field.label,
                      })}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(field.copyValue!)
                          setFeedback(
                            uiMessage("common.valueCopied", {
                              value0: field.label,
                            }),
                          )
                        } catch {
                          setFeedback(
                            uiMessage(
                              "chatMessage.clipboardUnavailableCopyManually",
                            ),
                          )
                        }
                      }}
                    >
                      <Copy size={16} />
                    </Button>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        {children}
      </DataRegion>
      <p role="status" className={styles.feedback}>
        {feedback}
      </p>
    </div>
  )
}
