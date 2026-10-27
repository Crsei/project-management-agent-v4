import { useState, type ReactNode } from "react"
import { Calendar } from "./calendar"
import {
  UnscheduledWorkItems,
  WorkItemCalendarEntry,
  type WorkItemScheduleViewProps,
} from "./work-items-schedule"
import { useI18n } from "../../lib/i18n-provider"
import {
  workItemDates,
  validateScheduleChange,
  type CalendarSettings,
} from "../../lib/schedule-view-model"
export { WorkItemCalendarEntry } from "./work-items-schedule"
export type WorkItemCalendarProps = WorkItemScheduleViewProps & {
  settings: CalendarSettings
  onSettingsChange: (value: CalendarSettings) => void
  today: string
  createLabel?: ReactNode
}
export function WorkItemCalendar(props: WorkItemCalendarProps) {
  const { t } = useI18n(),
    [error, setError] = useState<string | null>(null),
    map = new Map(props.items.map((item) => [item.id, item]))
  return (
    <>
      {error && (
        <p role="alert">{t(`schedule.${error}` as "schedule.invalidRange")}</p>
      )}
      <Calendar
        value={props.settings}
        onChange={props.onSettingsChange}
        today={props.today}
        buckets={props.buckets ?? []}
        queryKey={props.queryKey}
        getItem={(id) => map.get(id)}
        renderEntry={(item, { agenda }) => (
          <WorkItemCalendarEntry item={item} props={props} agenda={agenda} />
        )}
        onCreate={props.onCreateOnDate}
        createLabel={props.createLabel}
        onLoadMore={props.onLoadDate}
        onRetry={props.onRetryDate}
        onDropItem={
          props.onScheduleChange
            ? (id, date) => {
                const item = map.get(id)
                if (!item) return
                const p = props.getPresentation(item)
                if (!p.capabilities) return
                const intent = {
                  itemId: id,
                  queryKey: props.queryKey,
                  operationId: crypto.randomUUID(),
                  baseRevision: item.revision,
                  kind: "setDueDate" as const,
                  previousDates: workItemDates(item),
                  nextDates: { ...workItemDates(item), dueDate: date },
                }
                const problem = validateScheduleChange(intent, {
                  item,
                  queryKey: props.queryKey,
                  capabilities: p.capabilities,
                  mutation: p.mutation,
                })
                setError(problem)
                if (!problem) props.onScheduleChange?.(intent)
              }
            : undefined
        }
      />
      <UnscheduledWorkItems props={props} kind="calendar" />
    </>
  )
}
