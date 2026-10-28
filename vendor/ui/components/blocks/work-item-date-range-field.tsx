"use client"
import { useState } from "react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Field } from "../ui/field"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui/popover"
import { useI18n } from "../../lib/i18n-provider"
import {
  scheduleDateError,
  type ScheduleDates,
} from "../../lib/schedule-date-utils"
import {
  validateScheduleChange,
  workItemDates,
  type ScheduleChangeIntent,
} from "../../lib/schedule-view-model"
import {
  isMutationLocked,
  type WorkItemCapabilities,
  type WorkItemRecord,
  type MutationState,
} from "../../lib/work-items-model"
import styles from "./schedule.module.css"
export type WorkItemDateRangeFieldProps = {
  item: WorkItemRecord
  capabilities?: WorkItemCapabilities
  mutation?: MutationState
  queryKey: string
  dueOnly?: boolean
  proposedDates?: ScheduleDates
  onDraftChange?: (dates: ScheduleDates) => void
  onChange?: (intent: ScheduleChangeIntent) => void
}
export function WorkItemDateRangeField(props: WorkItemDateRangeFieldProps) {
  return <DateForm key={props.item.id} {...props} />
}
function DateForm({
  item,
  capabilities,
  mutation,
  queryKey,
  dueOnly,
  proposedDates,
  onChange,
  onDraftChange,
}: WorkItemDateRangeFieldProps) {
  const { t } = useI18n(),
    [draft, setDraft] = useState<ScheduleDates>(
      proposedDates ?? workItemDates(item),
    ),
    [error, setError] = useState<string | null>(null)
  const locked = isMutationLocked(mutation),
    startEditable =
      !!onChange && !!capabilities?.canEditField(item, "startDate") && !locked,
    dueEditable =
      !!onChange && !!capabilities?.canEditField(item, "dueDate") && !locked
  // Preserve unsaved/rejected edits through locale changes; a newly confirmed revision starts a new form in the caller.
  function edit(next: ScheduleDates) {
    setDraft(next)
    onDraftChange?.(next)
  }
  function submit(next: ScheduleDates, clear = false) {
    if (!capabilities || !onChange) return
    const intent: ScheduleChangeIntent = {
      itemId: item.id,
      baseRevision: item.revision,
      operationId: crypto.randomUUID(),
      queryKey,
      previousDates: workItemDates(item),
      nextDates: next,
      kind: clear ? "clearDates" : dueOnly ? "setDueDate" : "setRange",
    }
    const problem = validateScheduleChange(intent, {
      item,
      queryKey,
      capabilities,
      mutation,
    })
    setError(problem)
    if (!problem) onChange(intent)
  }
  const problem = scheduleDateError(workItemDates(item))
  return (
    <form
      className={styles.dateForm}
      data-schedule-form={item.id}
      onSubmit={(e) => {
        e.preventDefault()
        submit(
          dueOnly ? { ...workItemDates(item), dueDate: draft.dueDate } : draft,
        )
      }}
    >
      {capabilities?.reason && <p>{capabilities.reason}</p>}
      {proposedDates &&
        (proposedDates.startDate !== (item.startDate ?? null) ||
          proposedDates.dueDate !== item.dueDate) && (
          <p>{t("schedule.retained")}</p>
        )}
      {problem && (
        <p role="alert">
          {t("schedule.correction", {
            start: item.startDate ?? "—",
            end: item.dueDate ?? "—",
          })}
        </p>
      )}
      {!dueOnly && (
        <Field
          label={t("schedule.start")}
          error={mutation?.fieldErrors?.startDate}
        >
          {(control) => (
            <Input
              {...control}
              type="date"
              aria-label={t("schedule.start")}
              value={draft.startDate ?? ""}
              disabled={!startEditable}
              onChange={(e) =>
                edit({ ...draft, startDate: e.target.value || null })
              }
            />
          )}
        </Field>
      )}
      <Field label={t("schedule.due")} error={mutation?.fieldErrors?.dueDate}>
        {(control) => (
          <Input
            {...control}
            type="date"
            aria-label={t("schedule.due")}
            value={draft.dueDate ?? ""}
            disabled={!dueEditable}
            onChange={(e) =>
              edit({
                ...(dueOnly ? workItemDates(item) : draft),
                dueDate: e.target.value || null,
              })
            }
          />
        )}
      </Field>
      {error && (
        <p role="alert">{t(`schedule.${error}` as "schedule.invalidRange")}</p>
      )}
      {locked && <p role="status">{t("schedule.locked")}</p>}
      <div className={styles.controls}>
        <Button
          type="submit"
          disabled={locked || (!startEditable && !dueEditable)}
        >
          {t("schedule.save")}
        </Button>
        {!dueOnly && (
          <Button
            type="button"
            variant="ghost"
            disabled={!startEditable || !dueEditable}
            onClick={() => {
              edit({ startDate: null, dueDate: null })
              submit({ startDate: null, dueDate: null }, true)
            }}
          >
            {t("schedule.clear")}
          </Button>
        )}
      </div>
    </form>
  )
}
export function WorkItemSchedulePopover(
  props: WorkItemDateRangeFieldProps & { compact?: boolean },
) {
  const { t } = useI18n()
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size={props.compact ? "icon-sm" : "sm"}
            aria-label={t("schedule.edit", { name: props.item.identifier })}
          />
        }
      >
        {props.compact ? "↔" : t("schedule.schedule")}
      </PopoverTrigger>
      <PopoverContent>
        <WorkItemDateRangeField
          key={`${props.item.id}:${props.item.revision}`}
          {...props}
        />
      </PopoverContent>
    </Popover>
  )
}
