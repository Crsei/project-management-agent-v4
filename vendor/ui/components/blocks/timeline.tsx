"use client"
import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  type ReactNode,
  type CSSProperties,
  type PointerEvent,
} from "react"
import { Button } from "../ui/button"
import { useI18n } from "../../lib/i18n-provider"
import {
  addScheduleDays,
  scheduleDayDifference,
  scheduleDates,
  scheduleDateError,
  type ScheduleDates,
} from "../../lib/schedule-date-utils"
import type { ScheduleViewport, TimelineScale } from "../../lib/schedule-view-model"
import styles from "./timeline.module.css"
export type TimelineRecord = ScheduleDates & {
  id: string
  label: string
  unavailable?: boolean
  revision?: number
  canShift?: boolean
  canResizeStart?: boolean
  canResizeEnd?: boolean
}
export type TimelineDateChange = {
  id: string
  kind: "shift" | "resizeStart" | "resizeEnd"
  previousDates: ScheduleDates
  nextDates: ScheduleDates
}
export type TimelineProps<T extends TimelineRecord = TimelineRecord> = {
  items: readonly T[]
  viewport: ScheduleViewport
  scale: TimelineScale
  today: string
  renderSidebar: (item: T) => ReactNode
  /** CSS pixels per day; also used for pointer date changes. */
  dayWidth?: number
  sidebarHeader?: ReactNode
  axisHeader?: ReactNode
  onDateChange?: (change: TimelineDateChange) => void
  onEdit?: (item: T) => void
  selectedIds?: readonly string[]
  activeId?: string | null
  queryKey: string
  getScrollPosition?: () => { top: number; left: number }
  onScrollPosition?: (position: { top: number; left: number }) => void
}
export function TimelineAxis({
  viewport,
  dayWidth,
  today,
}: {
  viewport: ScheduleViewport
  dayWidth: number
  today: string
}) {
  const { locale } = useI18n(),
    dates = scheduleDates(viewport.rangeStart, viewport.rangeEnd)
  const months = new Map<string, number>()
  for (const date of dates)
    months.set(date.slice(0, 7), (months.get(date.slice(0, 7)) ?? 0) + 1)
  return (
    <div className={styles.axis}>
      <div className={styles.months}>
        {[...months].map(([month, count]) => (
          <span key={month} style={{ width: count * dayWidth }}>
            {month}
          </span>
        ))}
      </div>
      <div className={styles.dayTicks}>
        {dates.map((date) => (
          <div
            key={date}
            style={{ width: dayWidth }}
            data-today={date === today || undefined}
          >
            <span>{date.slice(8)}</span>
            <small>
              {dayWidth >= 40
                ? new Intl.DateTimeFormat(locale, {
                    weekday: "short",
                    timeZone: "UTC",
                  }).format(new Date(`${date}T12:00:00Z`))
                : ""}
            </small>
          </div>
        ))}
      </div>
    </div>
  )
}
export function TimelineRow({
  sidebar,
  children,
  selected,
  active,
  id,
}: {
  sidebar: ReactNode
  children: ReactNode
  selected?: boolean
  active?: boolean
  id: string
}) {
  return (
    <div
      className={styles.row}
      data-timeline-row={id}
      data-selected={selected || undefined}
      data-active={active || undefined}
    >
      <div className={styles.sidebar}>{sidebar}</div>
      <div className={styles.track}>{children}</div>
    </div>
  )
}
export function TimelineBar({
  item,
  viewport,
  dayWidth,
  onEdit,
  onPointerDown,
}: {
  item: TimelineRecord
  viewport: ScheduleViewport
  dayWidth: number
  onEdit?: () => void
  onPointerDown?: (
    event: PointerEvent<HTMLButtonElement>,
    kind: TimelineDateChange["kind"],
  ) => void
}) {
  const { t } = useI18n(),
    error = scheduleDateError(item)
  if (item.unavailable) return <span className={styles.missing}>—</span>
  if (error)
    return <span className={styles.invalid}>{t(`schedule.${error}`)}</span>
  const first = item.startDate ?? item.dueDate,
    last = item.dueDate ?? item.startDate
  if (!first || !last)
    return <span className={styles.missing}>{t("schedule.noDates")}</span>
  if (first > viewport.rangeEnd || last < viewport.rangeStart) return null
  const left =
    scheduleDayDifference(
      first < viewport.rangeStart ? viewport.rangeStart : first,
      viewport.rangeStart,
    ) * dayWidth
  const width =
    (scheduleDayDifference(
      last > viewport.rangeEnd ? viewport.rangeEnd : last,
      first < viewport.rangeStart ? viewport.rangeStart : first,
    ) +
      1) *
    dayWidth
  const complete = !!item.startDate && !!item.dueDate
  return (
    <div
      className={styles.bar}
      style={{ left, width }}
      data-schedule-start={item.startDate ?? ""}
      data-schedule-end={item.dueDate ?? ""}
      data-single={!complete || undefined}
      data-clip-start={first < viewport.rangeStart || undefined}
      data-clip-end={last > viewport.rangeEnd || undefined}
      title={`${item.label}: ${item.startDate ?? t("schedule.missingStart")} → ${item.dueDate ?? t("schedule.missingEnd")}`}
    >
      {first < viewport.rangeStart && (
        <span
          className={styles.continueStart}
          aria-label={t("schedule.continuesBefore")}
        >
          ‹
        </span>
      )}
      {item.startDate && item.canResizeStart && (
        <button
          className={styles.handle}
          aria-label={`${t("schedule.resizeStart")} ${item.label}`}
          onPointerDown={(e) => onPointerDown?.(e, "resizeStart")}
          onClick={onEdit}
        >
          │
        </button>
      )}
      <button
        className={styles.barMain}
        disabled={!onEdit && !item.canShift}
        data-draggable={(complete && item.canShift) || undefined}
        aria-label={`${item.label}: ${item.startDate ?? t("schedule.missingStart")} → ${item.dueDate ?? t("schedule.missingEnd")}`}
        onClick={onEdit}
        onPointerDown={(e) => {
          if (complete && item.canShift) onPointerDown?.(e, "shift")
        }}
      >
        <span>
          {complete
            ? item.label
            : item.startDate
              ? t("schedule.missingEnd")
              : t("schedule.missingStart")}
        </span>
      </button>
      {item.dueDate && item.canResizeEnd && (
        <button
          className={styles.handle}
          aria-label={`${t("schedule.resizeEnd")} ${item.label}`}
          onPointerDown={(e) => onPointerDown?.(e, "resizeEnd")}
          onClick={onEdit}
        >
          │
        </button>
      )}
      {last > viewport.rangeEnd && (
        <span
          className={styles.continueEnd}
          aria-label={t("schedule.continuesAfter")}
        >
          ›
        </span>
      )}
    </div>
  )
}
export function Timeline<T extends TimelineRecord>(props: TimelineProps<T>) {
  const { t } = useI18n(),
    root = useRef<HTMLDivElement>(null),
    [expanded, setExpanded] = useState(false)
  const dayWidth =
    props.dayWidth ?? (props.scale === "week" ? 112 : props.scale === "month" ? 40 : 16)
  const previousDayWidth = useRef(dayWidth)
  useLayoutEffect(() => {
    const node = root.current
    if (!node) return
    node.scrollLeft = (node.scrollLeft / previousDayWidth.current) * dayWidth
    previousDayWidth.current = dayWidth
  }, [dayWidth])
  const getScrollPosition = props.getScrollPosition
  useLayoutEffect(() => {
    const position = getScrollPosition?.()
    if (position) root.current?.scrollTo(position.left, position.top)
  }, [getScrollPosition])
  const width =
    scheduleDates(props.viewport.rangeStart, props.viewport.rangeEnd).length *
    dayWidth
  type Drag = {
    item: T
    kind: TimelineDateChange["kind"]
    x: number
    next: ScheduleDates
    key: string
    revisionItem: T
  }
  const drag = useRef<Drag | null>(null),
    [preview, setPreview] = useState<ScheduleDates | null>(null),
    suppressClick = useRef(false)
  const [dragError, setDragError] = useState<
    "invalidDate" | "invalidRange" | null
  >(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  function cancel() {
    drag.current = null
    setPreviewId(null)
    setPreview(null)
  }
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        drag.current = null
        setPreviewId(null)
        setPreview(null)
      }
    }
    window.addEventListener("keydown", escape)
    return () => window.removeEventListener("keydown", escape)
  }, [])
  function start(
    item: T,
    e: PointerEvent<HTMLButtonElement>,
    kind: TimelineDateChange["kind"],
  ) {
    if (e.button !== 0 || e.pointerType === "touch" || !props.onDateChange)
      return
    setDragError(null)
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = {
      item,
      kind,
      x: e.clientX,
      next: { startDate: item.startDate, dueDate: item.dueDate },
      key: props.queryKey,
      revisionItem: item,
    }
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (!current) return
    const delta = Math.round((e.clientX - current.x) / dayWidth),
      { item, kind } = current
    const next = { startDate: item.startDate, dueDate: item.dueDate }
    if ((kind === "shift" || kind === "resizeStart") && item.startDate)
      next.startDate = addScheduleDays(item.startDate, delta)
    if ((kind === "shift" || kind === "resizeEnd") && item.dueDate)
      next.dueDate = addScheduleDays(item.dueDate, delta)
    current.next = next
    setPreviewId(current.item.id)
    setPreview(next)
    suppressClick.current = Math.abs(e.clientX - current.x) > 3
  }
  function finish() {
    setTimeout(() => {
      suppressClick.current = false
    }, 0)
    const current = drag.current
    cancel()
    if (!current) return
    const dateError = scheduleDateError(current.next)
    if (dateError) {
      setDragError(dateError)
      return
    }
    const item = props.items.find((row) => row.id === current.item.id)
    if (
      current.key !== props.queryKey ||
      item?.revision !== current.item.revision ||
      item?.startDate !== current.item.startDate ||
      item?.dueDate !== current.item.dueDate
    )
      return
    if (
      current.next.startDate === current.item.startDate &&
      current.next.dueDate === current.item.dueDate
    )
      return
    props.onDateChange?.({
      id: current.item.id,
      kind: current.kind,
      previousDates: {
        startDate: current.item.startDate,
        dueDate: current.item.dueDate,
      },
      nextDates: current.next,
    })
  }
  function locate() {
    const x =
      scheduleDayDifference(props.today, props.viewport.rangeStart) * dayWidth
    root.current?.scrollTo({ left: Math.max(0, x - 160) })
  }
  return (
    <section
      className={`${styles.timeline} ${expanded ? styles.expanded : ""}`}
      data-timeline-scale={props.scale}
    >
      <div className={styles.actions}>
        <Button
          variant="ghost"
          disabled={
            props.today < props.viewport.rangeStart ||
            props.today > props.viewport.rangeEnd
          }
          onClick={locate}
        >
          {t("schedule.today")}
        </Button>
        <Button variant="ghost" onClick={() => setExpanded(!expanded)}>
          {t(expanded ? "schedule.collapse" : "schedule.expand")}
        </Button>
        {dragError && <span role="alert">{t(`schedule.${dragError}`)}</span>}
        <span role="status">
          {preview &&
            t("schedule.preview", {
              start: preview.startDate ?? "—",
              end: preview.dueDate ?? "—",
              days:
                preview.startDate && preview.dueDate
                  ? scheduleDayDifference(preview.dueDate, preview.startDate) +
                    1
                  : "—",
            })}
        </span>
      </div>
      <div
        className={styles.scroll}
        ref={root}
        onScroll={(e) =>
          props.onScrollPosition?.({
            top: e.currentTarget.scrollTop,
            left: e.currentTarget.scrollLeft,
          })
        }
        data-timeline-scroll
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            e.preventDefault()
            e.stopPropagation()
            suppressClick.current = false
          }
        }}
        style={
          {
            "--timeline-width": `${width}px`,
            "--day-width": `${dayWidth}px`,
          } as CSSProperties
        }
      >
        <div className={styles.header}>
          <div className={styles.sidebar}>{props.sidebarHeader ?? t("workItems.title")}</div>
          {props.axisHeader ?? (
            <TimelineAxis
              viewport={props.viewport}
              dayWidth={dayWidth}
              today={props.today}
            />
          )}
        </div>
        {props.items.map((item) => (
          <TimelineRow
            key={item.id}
            id={item.id}
            sidebar={props.renderSidebar(item)}
            selected={props.selectedIds?.includes(item.id)}
            active={props.activeId === item.id}
          >
            <TimelineBar
              item={
                previewId === item.id && preview
                  ? { ...item, ...preview }
                  : item
              }
              viewport={props.viewport}
              dayWidth={dayWidth}
              onEdit={props.onEdit ? () => props.onEdit?.(item) : undefined}
              onPointerDown={(e, kind) => start(item, e, kind)}
            />
            {props.today >= props.viewport.rangeStart &&
              props.today <= props.viewport.rangeEnd && (
                <div
                  className={styles.todayLine}
                  aria-hidden
                  style={{
                    left:
                      scheduleDayDifference(
                        props.today,
                        props.viewport.rangeStart,
                      ) *
                        dayWidth +
                      dayWidth / 2,
                  }}
                />
              )}
          </TimelineRow>
        ))}
      </div>
    </section>
  )
}
