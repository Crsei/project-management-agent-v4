import { useRef, useState, type ReactNode, type KeyboardEvent } from "react"
import { Button } from "../ui/button"
import { DataRegion } from "../ui/data-region"
import { useI18n } from "../../lib/i18n-provider"
import {
  addScheduleDays,
  addScheduleMonths,
  scheduleDates,
  scheduleWeekday,
  startOfScheduleWeek,
} from "../../lib/schedule-date-utils"
import {
  calendarViewport,
  type CalendarSettings,
  type DateBucketSnapshot,
} from "../../lib/schedule-view-model"
import styles from "./calendar.module.css"
export type CalendarProps<T> = {
  value: CalendarSettings
  onChange: (value: CalendarSettings) => void
  today: string
  buckets: readonly DateBucketSnapshot[]
  queryKey: string
  getItem: (id: string) => T | undefined
  renderEntry: (
    item: T,
    context: { agenda: boolean; date: string },
  ) => ReactNode
  onLoadMore?: (bucket: DateBucketSnapshot) => void
  onRetry?: (bucket: DateBucketSnapshot) => void
  onDropItem?: (itemId: string, date: string) => void
  onCreate?: (date: string) => void
  createLabel?: ReactNode
  maxVisible?: number
}
export function CalendarHeader({ dates }: { dates: readonly string[] }) {
  const { locale } = useI18n()
  return (
    <div
      className={styles.weekdays}
      style={{ gridTemplateColumns: `repeat(${dates.length},minmax(0,1fr))` }}
    >
      {dates.map((date) => (
        <span key={date}>
          {new Intl.DateTimeFormat(locale, {
            weekday: "short",
            timeZone: "UTC",
          }).format(new Date(`${date}T12:00:00Z`))}
        </span>
      ))}
    </div>
  )
}
export function CalendarAgenda({
  date,
  children,
  onEscape,
}: {
  date: string
  children: ReactNode
  onEscape?: () => void
}) {
  const { t } = useI18n()
  return (
    <section
      className={styles.agenda}
      aria-label={t("schedule.agenda")}
      tabIndex={-1}
      data-calendar-agenda
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation()
          onEscape?.()
        }
      }}
    >
      <h3>
        {date} · {t("schedule.agenda")}
      </h3>
      {children}
    </section>
  )
}
export function CalendarDay({
  date,
  today,
  selected,
  adjacent,
  button,
  children,
  onDropItem,
}: {
  date: string
  today: boolean
  selected: boolean
  adjacent: boolean
  button: ReactNode
  children: ReactNode
  onDropItem?: (id: string, date: string) => void
}) {
  return (
    <div
      className={styles.day}
      data-calendar-day={date}
      data-today={today || undefined}
      data-selected={selected || undefined}
      data-adjacent={adjacent || undefined}
      onDragOver={(e) => {
        if (
          onDropItem &&
          e.dataTransfer.types.includes("application/x-easyuseui-schedule")
        )
          e.preventDefault()
      }}
      onDrop={(e) => {
        if (!onDropItem) return
        const id = e.dataTransfer.getData("application/x-easyuseui-schedule")
        if (id) {
          e.preventDefault()
          onDropItem(id, date)
        }
      }}
    >
      {button}
      <div className={styles.dayEntries}>{children}</div>
    </div>
  )
}
export function Calendar<T>(props: CalendarProps<T>) {
  const { t } = useI18n(),
    root = useRef<HTMLDivElement>(null),
    [expanded, setExpanded] = useState<string[]>([])
  const viewport = calendarViewport(props.value),
    dates = scheduleDates(viewport.rangeStart, viewport.rangeEnd)
  const visibleDates = dates.filter(
    (date) =>
      props.value.showWeekends || ![0, 6].includes(scheduleWeekday(date)),
  )
  const [focusDate, setFocusDate] = useState(props.value.selectedDate)
  const roving = visibleDates.includes(focusDate)
    ? focusDate
    : visibleDates.includes(props.value.selectedDate)
      ? props.value.selectedDate
      : visibleDates[0]
  const buckets = new Map(
    props.buckets
      .filter((b) => b.queryKey === props.queryKey)
      .map((bucket) => [bucket.date, bucket]),
  )
  const selectedBucket = buckets.get(props.value.selectedDate)
  function focus(date: string) {
    setFocusDate(date)
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLButtonElement>(`[data-date-button="${date}"]`)
        ?.focus(),
    )
  }
  function keyboard(e: KeyboardEvent<HTMLButtonElement>, date: string) {
    let next: string | undefined
    if (e.key === "ArrowLeft") next = addScheduleDays(date, -1)
    if (e.key === "ArrowRight") next = addScheduleDays(date, 1)
    if (e.key === "ArrowUp") next = addScheduleDays(date, -7)
    if (e.key === "ArrowDown") next = addScheduleDays(date, 7)
    if (e.key === "Home")
      next = startOfScheduleWeek(date, props.value.weekStartsOn)
    if (e.key === "End")
      next = addScheduleDays(
        startOfScheduleWeek(date, props.value.weekStartsOn),
        6,
      )
    if (e.key === "PageUp") next = addScheduleMonths(date, -1)
    if (e.key === "PageDown") next = addScheduleMonths(date, 1)
    if (next) {
      e.preventDefault()
      if (!props.value.showWeekends)
        while ([0, 6].includes(scheduleWeekday(next)))
          next = addScheduleDays(
            next,
            e.key === "ArrowLeft" || e.key === "End" || e.key === "PageUp"
              ? -1
              : 1,
          )
      if (!dates.includes(next))
        props.onChange({ ...props.value, anchorDate: next, selectedDate: next })
      focus(next)
    }
    if (e.key === "Enter") {
      e.preventDefault()
      props.onChange({ ...props.value, selectedDate: date })
      requestAnimationFrame(() =>
        root.current
          ?.querySelector<HTMLElement>("[data-calendar-agenda]")
          ?.focus(),
      )
    }
  }
  function entries(date: string, agenda: boolean) {
    const bucket = buckets.get(date),
      ids = [...new Set(bucket?.itemIds ?? [])],
      limit =
        agenda || expanded.includes(date) ? ids.length : (props.maxVisible ?? 3)
    const content = ids.slice(0, limit).map((id) => {
      const item = props.getItem(id)
      return item ? (
        <div key={id}>{props.renderEntry(item, { agenda, date })}</div>
      ) : (
        <p key={id}>{id} · —</p>
      )
    })
    return (
      <>
        {bucket && (
          <DataRegion
            state={bucket.dataState}
            hasContent={ids.length > 0}
            rowHeight={32}
            emptyTitle={t("schedule.emptyDay")}
            partialDescription={t("schedule.partial")}
            error={
              bucket.error
                ? {
                    category: "request",
                    message: bucket.error,
                    reason: t("workItems.retained"),
                  }
                : undefined
            }
            onRetry={props.onRetry ? () => props.onRetry?.(bucket) : undefined}
          >
            {content}
          </DataRegion>
        )}
        {!bucket && <p className={styles.notice}>—</p>}
        {bucket && (
          <p className={styles.count}>
            {t("schedule.count", {
              loaded: bucket.loadedCount,
              total: bucket.totalCount ?? t("schedule.unknownTotal"),
            })}
          </p>
        )}
        {ids.length > limit && (
          <Button
            variant="ghost"
            size="sm"
            tabIndex={agenda ? 0 : -1}
            onClick={() => setExpanded((before) => [...before, date])}
          >
            {t("schedule.more", { count: ids.length - limit })}
          </Button>
        )}
        {bucket?.hasMore && props.onLoadMore && (
          <Button
            variant="ghost"
            size="sm"
            tabIndex={agenda ? 0 : -1}
            disabled={bucket.dataState === "loading"}
            onClick={() => props.onLoadMore?.(bucket)}
          >
            {t("schedule.loadMore")}
          </Button>
        )}
        {props.onCreate && (
          <Button
            variant="ghost"
            size="sm"
            tabIndex={agenda ? 0 : -1}
            aria-label={t("schedule.create", { date })}
            onClick={() => props.onCreate?.(date)}
          >
            +{props.createLabel !== undefined && <span>{props.createLabel}</span>}
          </Button>
        )}
      </>
    )
  }
  const weekendDates = dates.filter(
    (date) =>
      [0, 6].includes(scheduleWeekday(date)) &&
      (buckets.get(date)?.itemIds.length || buckets.get(date)?.hasMore),
  )
  return (
    <div
      ref={root}
      className={styles.calendar}
      data-calendar-mode={props.value.mode}
    >
      <p className={styles.hint}>{t("schedule.enter")}</p>
      <CalendarHeader
        dates={visibleDates.slice(0, props.value.showWeekends ? 7 : 5)}
      />
      <div
        className={styles.days}
        style={{
          gridTemplateColumns: `repeat(${props.value.showWeekends ? 7 : 5},minmax(0,1fr))`,
        }}
      >
        {visibleDates.map((date) => (
          <CalendarDay
            key={date}
            date={date}
            today={date === props.today}
            selected={date === props.value.selectedDate}
            adjacent={date.slice(0, 7) !== props.value.anchorDate.slice(0, 7)}
            onDropItem={props.onDropItem}
            button={
              <button
                className={styles.dateButton}
                data-date-button={date}
                tabIndex={date === roving ? 0 : -1}
                aria-label={date}
                aria-current={date === props.today ? "date" : undefined}
                aria-pressed={date === props.value.selectedDate}
                onFocus={() => setFocusDate(date)}
                onClick={() =>
                  props.onChange({ ...props.value, selectedDate: date })
                }
                onKeyDown={(e) => keyboard(e, date)}
              >
                {Number(date.slice(8))}
              </button>
            }
          >
            {entries(date, false)}
          </CalendarDay>
        ))}
      </div>
      <CalendarAgenda
        date={props.value.selectedDate}
        onEscape={() => focus(props.value.selectedDate)}
      >
        {selectedBucket ? (
          entries(props.value.selectedDate, true)
        ) : (
          <p>{t("schedule.emptyDay")}</p>
        )}
      </CalendarAgenda>
      {!props.value.showWeekends && (
        <details className={styles.weekends}>
          <summary>{t("schedule.weekendAgenda")}</summary>
          {weekendDates.map((date) => (
            <section key={date}>
              <Button
                variant="ghost"
                onClick={() =>
                  props.onChange({ ...props.value, selectedDate: date })
                }
              >
                {date}
              </Button>
              {entries(date, true)}
            </section>
          ))}
        </details>
      )}
    </div>
  )
}
