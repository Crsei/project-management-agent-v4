"use client"
import { Button } from "../ui/button"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui/popover"
import { WorkItemMutationNotice } from "./work-item"
import { useState } from "react"
import { Timeline, type TimelineRecord } from "./timeline"
import {
  WorkItemDateRangeField,
  WorkItemSchedulePopover,
} from "./work-item-date-range-field"
import {
  UnscheduledWorkItems,
  WorkItemCalendarEntry,
  type WorkItemScheduleViewProps,
} from "./work-items-schedule"
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog"
import { DataRegion } from "../ui/data-region"
import { useI18n } from "../../lib/i18n-provider"
import { isMutationLocked } from "../../lib/work-items-model"
import {
  timelineViewport,
  workItemDates,
  validateScheduleChange,
  type TimelineSettings,
} from "../../lib/schedule-view-model"
import { scheduleDateError } from "../../lib/schedule-date-utils"
export type WorkItemTimelineProps = WorkItemScheduleViewProps & {
  settings: TimelineSettings
  today: string
  getScrollPosition?: () => { top: number; left: number }
  onScrollPosition?: (position: { top: number; left: number }) => void
}
export function WorkItemTimeline(props: WorkItemTimelineProps) {
  const { t } = useI18n(),
    [editing, setEditing] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null)
  const map = new Map(props.items.map((item) => [item.id, item])),
    viewport = timelineViewport(props.settings)
  const range =
    props.range?.queryKey === props.queryKey &&
    props.range.rangeStart === viewport.rangeStart &&
    props.range.rangeEnd === viewport.rangeEnd
      ? props.range
      : undefined
  const staleRange = !!props.range && !range
  const ids = range
    ? [...new Set(range.itemIds)]
    : staleRange
      ? []
      : props.items.map((item) => item.id)
  const records = ids.flatMap<TimelineRecord>((id) => {
    const item = map.get(id)
    if (!item)
      return [
        { id, label: id, startDate: null, dueDate: null, unavailable: true },
      ]
    const p = props.getPresentation(item),
      locked = isMutationLocked(p.mutation),
      dates = workItemDates(item),
      valid = !scheduleDateError(dates)
    return [
      {
        ...dates,
        id: item.id,
        label: item.identifier,
        revision: item.revision,
        canShift:
          valid &&
          !!dates.startDate &&
          !!dates.dueDate &&
          !!props.onScheduleChange &&
          !locked &&
          !!p.capabilities?.canEditField(item, "startDate") &&
          !!p.capabilities?.canEditField(item, "dueDate"),
        canResizeStart:
          !!props.onScheduleChange &&
          !locked &&
          !!p.capabilities?.canEditField(item, "startDate"),
        canResizeEnd:
          !!props.onScheduleChange &&
          !locked &&
          !!p.capabilities?.canEditField(item, "dueDate"),
      },
    ]
  })
  const item = editing ? map.get(editing) : undefined,
    p = item ? props.getPresentation(item) : undefined
  return (
    <>
      {error && (
        <p role="alert">{t(`schedule.${error}` as "schedule.invalidRange")}</p>
      )}
      <DataRegion
        state={
          staleRange
            ? "loading"
            : (range?.dataState ?? (records.length ? "success" : "empty"))
        }
        hasContent={records.length > 0}
        partialDescription={t("schedule.partial")}
        error={
          range?.error
            ? {
                category: "request",
                message: range.error,
                reason: t("workItems.retained"),
              }
            : undefined
        }
        onRetry={
          range && props.onRetryRange
            ? () => props.onRetryRange?.(range)
            : undefined
        }
        onLoadMore={
          range?.hasMore && props.onLoadRange
            ? () => props.onLoadRange?.(range)
            : undefined
        }
      >
        <Timeline
          getScrollPosition={props.getScrollPosition}
          onScrollPosition={props.onScrollPosition}
          items={records}
          queryKey={props.queryKey}
          viewport={viewport}
          today={props.today}
          scale={props.settings.scale}
          activeId={props.interaction.activeItemId}
          selectedIds={props.interaction.selectedIds}
          renderSidebar={(record) => {
            const item = map.get(record.id)
            if (!item) return <span>{record.id} · —</span>
            const p = props.getPresentation(item)
            return (
              <>
                <WorkItemCalendarEntry
                  item={item}
                  props={props}
                  agenda={false}
                  compact
                />
                {props.onReorder && !isMutationLocked(p.mutation) && (
                  <Popover>
                    <PopoverTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`${t("workItems.manual")} ${item.identifier}`}
                        />
                      }
                    >
                      ↕
                    </PopoverTrigger>
                    <PopoverContent>
                      {["up", "down"].map((direction) => {
                        const index = ids.indexOf(item.id),
                          target =
                            direction === "up" ? ids[index - 1] : ids[index + 1]
                        return (
                          <Button
                            key={direction}
                            variant="ghost"
                            disabled={!target}
                            onClick={() =>
                              props.onReorder?.({
                                operationId: crypto.randomUUID(),
                                itemId: item.id,
                                baseRevision: item.revision,
                                queryKey: props.queryKey,
                                ...(direction === "up"
                                  ? { beforeId: target }
                                  : { afterId: target }),
                              })
                            }
                          >
                            {t(
                              direction === "up"
                                ? "workItems.moveUp"
                                : "workItems.moveDown",
                            )}
                          </Button>
                        )
                      })}
                    </PopoverContent>
                  </Popover>
                )}
                <WorkItemMutationNotice
                  mutation={p.mutation}
                  onReconcile={p.onReconcile}
                />
                <WorkItemSchedulePopover
                  compact
                  item={item}
                  capabilities={p.capabilities}
                  mutation={p.mutation}
                  queryKey={props.queryKey}
                  onDraftChange={(dates) =>
                    props.onDateDraftChange?.(item, dates)
                  }
                  onChange={props.onScheduleChange}
                  proposedDates={props.proposedDates?.[item.id]}
                />
              </>
            )
          }}
          onEdit={(record) => {
            if (map.has(record.id)) setEditing(record.id)
          }}
          onDateChange={
            props.onScheduleChange
              ? (change) => {
                  const item = map.get(change.id)
                  if (!item) return
                  const presentation = props.getPresentation(item)
                  if (!presentation.capabilities) return
                  const intent = {
                    ...change,
                    itemId: item.id,
                    operationId: crypto.randomUUID(),
                    baseRevision: item.revision,
                    queryKey: props.queryKey,
                  }
                  const problem = validateScheduleChange(intent, {
                    item,
                    queryKey: props.queryKey,
                    capabilities: presentation.capabilities,
                    mutation: presentation.mutation,
                  })
                  setError(problem)
                  if (!problem) props.onScheduleChange?.(intent)
                }
              : undefined
          }
        />
      </DataRegion>
      <UnscheduledWorkItems props={props} kind="timeline" />
      <Dialog
        open={!!item}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        <DialogContent>
          <DialogTitle>
            {item?.identifier} · {t("schedule.schedule")}
          </DialogTitle>
          {item && p && (
            <WorkItemDateRangeField
              key={`${item.id}:${item.revision}`}
              item={item}
              capabilities={p.capabilities}
              mutation={p.mutation}
              queryKey={props.queryKey}
              onDraftChange={(dates) => props.onDateDraftChange?.(item, dates)}
              onChange={props.onScheduleChange}
              proposedDates={props.proposedDates?.[item.id]}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
