import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { WorkItemIdentifier, WorkItemMutationNotice } from "@/components/blocks/work-item"
import { WorkItemProperties } from "@/components/blocks/work-item-properties"
import { isMutationLocked, type WorkItemRecord, type WorkItemCatalog, type WorkItemCapabilities, type MutationState, type WorkItemProperty } from "@/lib/work-items-model"
import { useI18n } from "@/lib/i18n-provider"
import type { PmIssuePatch } from "./issue-domain"
import styles from "./boards-views.module.css"

export type BoardDraft = { title: string; description: string }
const detailProperties: WorkItemProperty[] = ["state", "priority", "assignees", "labels", "startDate", "dueDate", "counts"]

/** Controlled title/body inspector: the text lives in the page cache, not in the field. */
export function BoardsDraftDetail({
  item,
  draft,
  hasDraft,
  catalog,
  capabilities,
  mutation,
  editable,
  discardLabel,
  today,
  onEdit,
  onSave,
  onDiscard,
  onPatch,
  onReconcile,
}: {
  item: WorkItemRecord
  draft: BoardDraft
  hasDraft: boolean
  catalog: WorkItemCatalog
  capabilities: WorkItemCapabilities
  mutation?: MutationState
  editable: boolean
  discardLabel: string
  today: string
  onEdit: (field: keyof BoardDraft, value: string) => void
  onSave: (field: keyof BoardDraft) => void
  onDiscard: () => void
  onPatch: (item: WorkItemRecord, patch: PmIssuePatch) => void
  onReconcile?: () => void
}) {
  const { t } = useI18n()
  const locked = isMutationLocked(mutation)
  return (
    <div
      className={styles.detail}
      data-detail-item={item.id}
      data-detail-draft={hasDraft ? "dirty" : undefined}
    >
      <WorkItemIdentifier identifier={item.identifier} />
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (editable && !locked && draft.title.trim()) onSave("title")
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
              value={draft.title}
              disabled={!editable || locked}
              onChange={(event) => onEdit("title", event.target.value)}
            />
          )}
        </Field>
        {editable && (
          <Button
            type="submit"
            variant="secondary"
            disabled={!draft.title.trim() || locked}
          >
            {t("workItems.saveTitle")}
          </Button>
        )}
      </form>
      <WorkItemProperties
        item={item}
        catalog={catalog}
        layout="detail"
        capabilities={capabilities}
        visibleProperties={detailProperties}
        mutation={mutation}
        today={today}
        onPatchItem={editable ? onPatch : undefined}
      />
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (editable && !locked) onSave("description")
        }}
      >
        <Field
          label={t("workItems.description")}
          error={mutation?.fieldErrors?.description}
        >
          {(control) => (
            <textarea
              {...control}
              rows={4}
              className={styles.bodyInput}
              value={draft.description}
              disabled={!editable || locked}
              onChange={(event) => onEdit("description", event.target.value)}
            />
          )}
        </Field>
        {editable && (
          <Button type="submit" variant="secondary" disabled={locked}>
            {t("workItems.saveDescription")}
          </Button>
        )}
      </form>
      {hasDraft && editable && (
        <Button
          variant="ghost"
          size="sm"
          disabled={locked}
          data-detail-discard={item.id}
          onClick={onDiscard}
        >
          {discardLabel}
        </Button>
      )}
      <WorkItemMutationNotice mutation={mutation} onReconcile={onReconcile} />
      {capabilities.reason && (
        <p className={styles.hint}>{capabilities.reason}</p>
      )}
    </div>
  )
}
