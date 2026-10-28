"use client"
import { WorkItemDateRangeField } from "./work-item-date-range-field"
import { useState } from "react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Field } from "../ui/field"
import {
  WorkItemProperties,
  WorkItemStatePicker,
  WorkItemPriorityPicker,
  type WorkItemPropertiesProps,
} from "./work-item-properties"
import { WorkItemIdentifier, WorkItemMutationNotice } from "./work-item"
import {
  isMutationLocked,
  type CreateResult,
  type WorkItemCatalog,
  type WorkItemDraft,
} from "../../lib/work-items-model"
import { useI18n } from "../../lib/i18n-provider"
import styles from "./work-items.module.css"
export function WorkItemDetail(
  props: WorkItemPropertiesProps & { onReconcile?: () => void },
) {
  return <DetailForm key={props.item.id} {...props} />
}
function DetailForm({
  onReconcile,
  ...props
}: WorkItemPropertiesProps & { onReconcile?: () => void }) {
  const { item, mutation, capabilities, onPatchItem } = props
  const [title, setTitle] = useState(item.title)
  const [description, setDescription] = useState(item.description ?? "")
  const { t } = useI18n()
  return (
    <div className={styles.detail} data-detail-item={item.id}>
      <WorkItemIdentifier identifier={item.identifier} />
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (
            title.trim() &&
            !isMutationLocked(mutation) &&
            capabilities?.canEditField(item, "title")
          )
            onPatchItem?.(item, { title: title.trim() })
        }}
      >
        <Field
          label={t("workItems.title")}
          error={mutation?.fieldErrors?.title}
        >
          {(control) => (
            <Input
              {...control}
              aria-label={t("workItems.title")}
              value={title}
              disabled={
                !onPatchItem ||
                !capabilities?.canEditField(item, "title") ||
                isMutationLocked(mutation)
              }
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
        </Field>
        {onPatchItem && capabilities?.canEditField(item, "title") && (
          <Button
            type="submit"
            variant="secondary"
            disabled={!title.trim() || isMutationLocked(mutation)}
          >
            {t("workItems.saveTitle")}
          </Button>
        )}
      </form>
      {props.onScheduleChange && (
        <WorkItemDateRangeField
          key={`${item.id}:${item.revision}`}
          item={item}
          capabilities={capabilities}
          mutation={mutation}
          queryKey={props.queryKey ?? ""}
          onDraftChange={(dates) => props.onScheduleDraftChange?.(item, dates)}
          onChange={props.onScheduleChange}
          proposedDates={props.proposedDates}
        />
      )}
      <WorkItemProperties
        {...props}
        visibleProperties={[
          "state",
          "priority",
          "assignees",
          "labels",
          ...(props.onScheduleChange
            ? []
            : (["startDate", "dueDate"] as const)),
          "counts",
        ]}
        layout="detail"
      />
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (
            !isMutationLocked(mutation) &&
            capabilities?.canEditField(item, "description")
          )
            onPatchItem?.(item, { description })
        }}
      >
        <Field
          label={t("workItems.description")}
          error={mutation?.fieldErrors?.description}
        >
          {(control) => (
            <textarea
              {...control}
              value={description}
              disabled={
                !onPatchItem ||
                !capabilities?.canEditField(item, "description") ||
                isMutationLocked(mutation)
              }
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        {onPatchItem && capabilities?.canEditField(item, "description") && (
          <Button
            type="submit"
            variant="secondary"
            disabled={isMutationLocked(mutation)}
          >
            {t("workItems.saveDescription")}
          </Button>
        )}
      </form>
      <WorkItemMutationNotice mutation={mutation} onReconcile={onReconcile} />
      {capabilities?.reason && (
        <p className="text-xs text-muted-foreground">{capabilities.reason}</p>
      )}
    </div>
  )
}
export function WorkItemQuickCreate({
  catalog,
  preset,
  disabled,
  onCreate,
  onCancel,
  unknown,
  onReconcile,
  onUnknown,
}: {
  catalog: WorkItemCatalog
  preset: WorkItemDraft
  disabled?: boolean
  onCreate: (draft: WorkItemDraft) => Promise<CreateResult>
  onUnknown: (draft: WorkItemDraft) => void
  onCancel: () => void
  unknown?: boolean
  onReconcile?: () => void
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(preset)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  return (
    <form
      className={styles.quick}
      onSubmit={async (event) => {
        event.preventDefault()
        if (!draft.title.trim() || pending || disabled || unknown) return
        setPending(true)
        setError("")
        try {
          const result = await onCreate({ ...draft, title: draft.title.trim() })
          if (result.status === "unknown") onUnknown(draft)
          if (result.status === "confirmed") onCancel()
          else
            setError(
              result.error ??
                t(
                  result.status === "unknown"
                    ? "workItems.unknown"
                    : "workItems.rejected",
                ),
            )
        } catch {
          onUnknown(draft)
          setError(t("workItems.unknown"))
        } finally {
          setPending(false)
        }
      }}
    >
      <h2 className="text-base font-medium">{t("workItems.create")}</h2>
      <Input
        autoFocus
        value={draft.title}
        aria-label={t("workItems.newTitle")}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        disabled={pending || disabled || unknown}
      />
      {preset.dueDate !== undefined && (
        <p>
          {t("workItems.dueDate")}: {preset.dueDate ?? "—"}
        </p>
      )}
      <WorkItemStatePicker
        value={draft.stateId}
        options={catalog.states}
        onChange={(stateId) => setDraft({ ...draft, stateId })}
        disabled={pending || disabled || unknown}
      />
      <WorkItemPriorityPicker
        value={draft.priorityId}
        options={catalog.priorities}
        onChange={(priorityId) => setDraft({ ...draft, priorityId })}
        disabled={pending || disabled || unknown}
      />
      {error && <p role="alert">{error}</p>}
      {unknown && onReconcile && (
        <Button type="button" variant="secondary" onClick={onReconcile}>
          {t("workItems.reconcile")}
        </Button>
      )}
      <Button
        type="submit"
        loading={pending}
        disabled={!draft.title.trim() || disabled || unknown}
      >
        {t("workItems.create")}
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel}>
        {t("workItems.cancel")}
      </Button>
    </form>
  )
}
