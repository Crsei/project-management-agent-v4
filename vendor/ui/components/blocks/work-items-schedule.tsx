"use client"
import type { WorkItemsViewProps } from "./work-items-views"
import type { WorkItemRecord } from "../../lib/work-items-model"
import type {
  ScheduleChangeIntent,
  ScheduleRangeSnapshot,
  DateBucketSnapshot,
} from "../../lib/schedule-view-model"
import { workItemDates } from "../../lib/schedule-view-model"
import { WorkItemSchedulePopover } from "./work-item-date-range-field"
import { WorkItemMutationNotice } from "./work-item"
import { DataRegion } from "../ui/data-region"
import { Button } from "../ui/button"
import { Checkbox } from "../ui/checkbox"
import { useI18n } from "../../lib/i18n-provider"
import { isMutationLocked } from "../../lib/work-items-model"
import styles from "./schedule.module.css"
export type WorkItemsScheduleProps = {
  onReorder?: (intent: {
    operationId: string
    itemId: string
    baseRevision: number
    queryKey: string
    beforeId?: string
    afterId?: string
  }) => void
  queryKey: string
  unscheduled?: Omit<DateBucketSnapshot, "date">
  onLoadUnscheduled?: () => void
  onRetryUnscheduled?: () => void
  onDateDraftChange?: (
    item: WorkItemRecord,
    dates: import("../../lib/schedule-date-utils").ScheduleDates,
  ) => void
  onScheduleChange?: (intent: ScheduleChangeIntent) => void
  range?: ScheduleRangeSnapshot
  buckets?: readonly DateBucketSnapshot[]
  onLoadRange?: (range: ScheduleRangeSnapshot) => void
  onRetryRange?: (range: ScheduleRangeSnapshot) => void
  onLoadDate?: (bucket: DateBucketSnapshot) => void
  onRetryDate?: (bucket: DateBucketSnapshot) => void
  onCreateOnDate?: (date: string) => void
  proposedDates?: Readonly<
    Record<
      string,
      import("../../lib/schedule-date-utils").ScheduleDates | undefined
    >
  >
}
export type WorkItemScheduleViewProps = WorkItemsViewProps &
  WorkItemsScheduleProps
export function WorkItemCalendarEntry({
  item,
  props,
  agenda = true,
  dueOnly = true,
  compact = false,
}: {
  item: WorkItemRecord
  props: WorkItemScheduleViewProps
  agenda?: boolean
  dueOnly?: boolean
  compact?: boolean
}) {
  const { t } = useI18n(),
    presentation = props.getPresentation(item),
    { mutation, capabilities } = presentation
  const selected = props.interaction.selectedIds.includes(item.id)
  const editable =
    !!props.onScheduleChange &&
    !!capabilities?.canEditField(item, "dueDate") &&
    !isMutationLocked(mutation)
  const state = presentation.catalog.states.find(
    (state) => state.id === item.stateId,
  )
  return (
    <div
      className={styles.entry}
      data-compact={compact || undefined}
      data-work-item={item.id}
      data-calendar-entry={item.id}
      data-state={item.stateId}
      data-active={props.interaction.activeItemId === item.id || undefined}
      draggable={!compact && editable}
      onDragStart={(e) => {
        if (!compact && editable)
          e.dataTransfer.setData("application/x-easyuseui-schedule", item.id)
      }}
    >
      <div className={styles.entryMain}>
        {props.onSelectionChange && (
          <Checkbox
            tabIndex={agenda ? 0 : -1}
            aria-label={t("commonComponents.selectRow", {
              name: item.identifier,
            })}
            checked={selected}
            onCheckedChange={(checked) =>
              props.onSelectionChange?.(
                checked
                  ? [...new Set([...props.interaction.selectedIds, item.id])]
                  : props.interaction.selectedIds.filter(
                      (id) => id !== item.id,
                    ),
              )
            }
          />
        )}
        {presentation.onOpen ? (
          <Button
            variant="ghost"
            size="sm"
            tabIndex={agenda ? 0 : -1}
            className={styles.entryTitle}
            onClick={() => presentation.onOpen?.(item)}
            title={`${item.identifier} ${item.title}`}
          >
            <span className={styles.identifier}>{item.identifier}</span>
            <span>{item.title}</span>
          </Button>
        ) : (
          <span
            className={styles.entryTitle}
            title={`${item.identifier} ${item.title}`}
          >
            <span className={styles.identifier}>{item.identifier}</span>
            {item.title}
          </span>
        )}
        {agenda && (
          <WorkItemSchedulePopover
            item={item}
            capabilities={capabilities}
            mutation={mutation}
            queryKey={props.queryKey}
            dueOnly={dueOnly}
            onDraftChange={(dates) => props.onDateDraftChange?.(item, dates)}
            onChange={props.onScheduleChange}
            proposedDates={props.proposedDates?.[item.id]}
          />
        )}
      </div>
      {!compact && (
        <div className={styles.entryMeta}>
          {presentation.visibleProperties.includes("state") && (
            <span className={styles.state} title={state?.label}>
              {state?.label ?? item.stateId}
            </span>
          )}
          {agenda &&
            ["priority", "assignees", "labels"].map((property) => {
              if (
                !presentation.visibleProperties.includes(property as "priority")
              )
                return null
              const options =
                property === "priority"
                  ? presentation.catalog.priorities
                  : property === "assignees"
                    ? presentation.catalog.assignees
                    : presentation.catalog.labels
              const ids =
                property === "priority"
                  ? [item.priorityId]
                  : property === "assignees"
                    ? item.assigneeIds
                    : item.labelIds
              const label = ids
                .map(
                  (id) =>
                    options.find((option) => option.id === id)?.label ?? id,
                )
                .join(", ")
              return label ? (
                <span key={property} className={styles.state} title={label}>
                  {label}
                </span>
              ) : null
            })}
        </div>
      )}
      {agenda && (
        <WorkItemMutationNotice
          mutation={mutation}
          onReconcile={presentation.onReconcile}
        />
      )}
    </div>
  )
}
export function UnscheduledWorkItems({
  props,
  kind,
}: {
  props: WorkItemScheduleViewProps
  kind: "timeline" | "calendar"
}) {
  const { t } = useI18n(),
    unscheduled =
      props.unscheduled?.queryKey === props.queryKey
        ? props.unscheduled
        : undefined,
    items = [
      ...new Map(
        props.items
          .filter(
            (item) =>
              !props.unscheduled ||
              (!!unscheduled && unscheduled.itemIds.includes(item.id)),
          )
          .filter((item) =>
            kind === "calendar"
              ? !item.dueDate
              : !item.startDate && !item.dueDate,
          )
          .map((item) => [item.id, item]),
      ).values(),
    ]
  return (
    <details className={styles.queue} data-unscheduled>
      <summary>
        {t("schedule.unscheduled")} · {items.length}
      </summary>
      <DataRegion
        state={
          props.unscheduled && !unscheduled
            ? "loading"
            : (unscheduled?.dataState ?? (items.length ? "success" : "empty"))
        }
        hasContent={items.length > 0}
        onRetry={props.onRetryUnscheduled}
        onLoadMore={unscheduled?.hasMore ? props.onLoadUnscheduled : undefined}
        error={
          unscheduled?.error
            ? {
                category: "request",
                message: unscheduled.error,
                reason: t("workItems.retained"),
              }
            : undefined
        }
        emptyTitle={t("schedule.emptyDay")}
      >
        {items.map((item) => (
          <WorkItemCalendarEntry
            key={item.id}
            item={item}
            props={props}
            dueOnly={kind === "calendar"}
          />
        ))}
      </DataRegion>
      <p className={styles.meta}>
        {t("schedule.count", {
          loaded: items.length,
          total: unscheduled?.totalCount ?? t("schedule.unknownTotal"),
        })}
      </p>
      {!items.length && (
        <p className={styles.notice}>{t("schedule.emptyDay")}</p>
      )}
    </details>
  )
}
export const proposedOrConfirmedDates = (
  props: WorkItemsScheduleProps,
  item: WorkItemRecord,
) => props.proposedDates?.[item.id] ?? workItemDates(item)
