import { useLayoutEffect, useMemo, useRef, type KeyboardEvent } from "react"
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Plus, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DataRegion } from "@/components/ui/data-region"
import { useI18n } from "@/lib/i18n-provider"
import { addScheduleDays, startOfScheduleWeek } from "@/lib/schedule-date-utils"
import { PmPage } from "./presentation-page"
import { ControlledFeedback, ControlledFocus } from "./controlled-presentation"
import type { HourCalendarEvent, HourCalendarMutation, HourCalendarViewProps } from "./hour-calendar-contracts"
import styles from "./schedule-views.module.css"
import { RadixSelect } from "@/components/ui/radix-select"

// Approved reference geometry: header 65px, each elapsed hour 112px, seven days.
export const HOUR_HEIGHT = 112
const MINUTE_HEIGHT = HOUR_HEIGHT / 60
const hourCalendarCss = `
.pm-hour-calendar [data-pm-header]{min-height:65px;padding:16px 24px;gap:16px}
.pm-hour-calendar [data-pm-header] h1{font-size:16px;line-height:24px}
.pm-hour-calendar [data-pm-scroll]{display:flex;flex-direction:column;overflow:hidden;padding:0}
.pm-hour-calendar [data-pm-scroll]>[data-data-state]{display:flex;flex:1;min-height:0;flex-direction:column;gap:0}
.pm-hour-calendar [data-pm-hour-frame]{display:flex;flex:1;min-height:0;flex-direction:column;border:0;border-radius:0}
.pm-hour-calendar [data-pm-hour-header]{flex:none;min-height:56px}
.pm-hour-calendar [data-pm-hour-header]>div{flex-direction:row;justify-content:center;gap:4px;font-size:14px;padding:12px 4px;background-image:none;background-color:var(--surface)}
.pm-hour-calendar [data-pm-hour-header]>div>span:last-child{font-weight:600;color:var(--foreground)}
.pm-hour-calendar [data-pm-hour-header]>div[data-today]>span:last-child{color:var(--background)}
.pm-hour-calendar [data-pm-all-day]{flex:none}
.pm-hour-calendar [data-pm-hour-scroller]{flex:1;min-height:0;max-height:none}
.pm-hour-calendar [data-pm-hour-grid]{padding-top:28px}
.pm-hour-calendar [data-pm-hour-label]{height:112px;flex-shrink:0;padding:0 8px 0 0;font-size:12px;line-height:20px}
.pm-hour-calendar [data-pm-hour-label]>span{display:block;transform:translateY(-50%)}
.pm-hour-calendar [data-pm-hour-day]{background-image:repeating-linear-gradient(to bottom,var(--border) 0,var(--border) 1px,transparent 1px,transparent 112px)}
.pm-hour-calendar [data-pm-hour-day][data-weekend]{background-color:var(--surface);background-image:repeating-linear-gradient(135deg,transparent,transparent 6px,var(--border) 6px,var(--border) 7px),repeating-linear-gradient(to bottom,var(--border) 0,var(--border) 1px,transparent 1px,transparent 112px)}
.pm-hour-calendar [data-pm-hour-day] [data-pm-event]{display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;padding:10px 12px;border-width:1px;border-radius:8px;font-size:12px;line-height:20px}
.pm-hour-calendar [data-pm-hour-day] [data-pm-event][data-narrow]{padding:8px 6px}
.pm-hour-calendar [data-pm-hour-day] [data-pm-event]>span:first-child{display:block;font-size:12px;line-height:20px;color:inherit}
.pm-hour-calendar [data-pm-event-heading]>span:first-child{display:inline;margin-right:4px;font-size:12px;line-height:20px;color:var(--text-secondary)}
.pm-hour-calendar [data-pm-event-title]{display:inline;font-weight:600;line-height:20px;word-break:break-word}
.pm-hour-calendar [data-pm-event-time]{display:block;font-size:11px;line-height:20px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-hour-calendar [data-pm-hour-footer]{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--border);padding:4px 12px;font-size:12px;color:var(--text-secondary)}
.pm-hour-calendar [data-pm-hour-secondary]{flex:none;border-top:1px solid var(--border);background:var(--surface)}
.pm-hour-calendar [data-pm-hour-secondary]>summary{padding:8px 12px;font-size:12px;cursor:pointer}
.pm-hour-calendar [data-pm-hour-secondary]>div{max-height:190px;overflow:auto}
.pm-hour-calendar [data-pm-hour-agenda],.pm-hour-calendar [data-pm-unscheduled]{margin:0;border:0;border-radius:0}
.pm-hour-calendar [data-pm-hour-menu]{position:relative}
.pm-hour-calendar [data-pm-hour-menu]>summary{display:flex;height:32px;align-items:center;gap:8px;padding:0 12px;font-size:13px;font-weight:500;list-style:none;cursor:pointer}
.pm-hour-editor [data-pm-time-fields]{border-top:1px solid var(--border);padding-top:16px}
.pm-hour-editor [data-pm-time-row]{display:grid;align-items:start;gap:8px}
.pm-hour-editor [data-pm-time-row] input{width:100%;min-width:0}
.pm-hour-editor [data-pm-time-pair]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.pm-hour-editor [data-pm-time-pair] .pm-hour-duration{grid-column:1/-1}
.pm-hour-calendar [data-pm-hour-menu]>summary::-webkit-details-marker{display:none}
.pm-hour-calendar [data-pm-hour-menu]>summary:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.pm-hour-calendar [data-pm-hour-menu]>div{position:absolute;right:0;top:40px;z-index:30;width:340px;display:grid;gap:12px;padding:16px;border:1px solid var(--border);border-radius:8px;background:var(--surface);box-shadow:var(--shadow-floating)}
.pm-hour-calendar [data-pm-hour-menu]>div label{font-size:13px}
.pm-hour-calendar [data-pm-week-range]{display:flex;height:32px;align-items:center;gap:8px;padding:0 12px;border-left:1px solid var(--border);font-size:13px;font-weight:500;white-space:nowrap}
`

export function formatHourDuration(minutes: number): string {
  if (minutes <= 0) return "0m"
  const hours = Math.floor(minutes / 60), rest = Math.round(minutes % 60)
  return hours ? rest ? hours + "h " + rest + "m" : hours + "h" : rest + "m"
}
function dateFormatter(zone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
}
function dateAt(ms: number, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(new Date(ms))
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return get("year") + "-" + get("month") + "-" + get("day")
}
/** Rendering-only date boundary. Inspect actual offsets on both sides so a
 * repeated midnight uses its first instant. Gaps and skipped dates use the first
 * real instant of the next displayed date; no user-entered wall is normalized. */
function dateBoundary(day: string, formatter: Intl.DateTimeFormat) {
  const midnight = Date.parse(day + "T00:00:00Z")
  const wall = new Intl.DateTimeFormat("en-CA", { timeZone: formatter.resolvedOptions().timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
  let earliest = Number.POSITIVE_INFINITY
  for (let step = -8; step <= 8; step++) {
    const instant = midnight + step * 6 * 3600000
    const parts = wall.formatToParts(new Date(instant))
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
    const offset = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - instant
    const candidate = midnight - offset
    if (dateAt(candidate, formatter) === day && dateAt(candidate - 1, formatter) !== day) earliest = Math.min(earliest, candidate)
  }
  if (Number.isFinite(earliest)) return earliest
  let low = midnight - 48 * 3600000, high = midnight + 48 * 3600000
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)
    if (dateAt(mid, formatter) < day) low = mid
    else high = mid
  }
  return high
}
type Segment = { event: HourCalendarEvent; start: number; end: number; continuesLeft: boolean; continuesRight: boolean; column: number; columns: number }
function overlapColumns(segments: Omit<Segment, "column" | "columns">[]): Segment[] {
  const result: Segment[] = []
  let groupStart = 0
  while (groupStart < segments.length) {
    let groupEnd = groupStart + 1, latestEnd = segments[groupStart].end
    while (groupEnd < segments.length && segments[groupEnd].start < latestEnd) {
      latestEnd = Math.max(latestEnd, segments[groupEnd].end)
      groupEnd++
    }
    const ends: number[] = []
    for (let index = groupStart; index < groupEnd; index++) {
      let column = ends.findIndex((end) => end <= segments[index].start)
      if (column === -1) column = ends.length
      ends[column] = segments[index].end
      result[index] = { ...segments[index], column, columns: 0 }
    }
    for (let index = groupStart; index < groupEnd; index++) result[index].columns = ends.length
    groupStart = groupEnd
  }
  return result
}

function HourMutationNotice({ mutation, onReconcile }: { mutation?: HourCalendarMutation; onReconcile: () => void }) {
  const { t } = useI18n()
  if (!mutation || (mutation.status === "confirmed" && !Object.keys(mutation.fieldErrors ?? {}).length)) return null
  return <div className="flex flex-wrap items-center gap-2 text-xs" data-mutation={mutation.status === "confirmed" ? "rejected" : mutation.status} role={mutation.status === "rejected" ? "alert" : "status"}>
    <span>{mutation.status === "pending" ? t("workItems.pending") : mutation.status === "unknown" ? t("workItems.unknown") : t("workItems.rejected")}</span>
    {mutation.error && <span>{mutation.error}</span>}
    {Object.entries(mutation.fieldErrors ?? {}).map(([field, error]) => <span key={field}>{error}</span>)}
    {mutation.status === "unknown" && <Button variant="secondary" size="sm" onClick={onReconcile}>{t("workItems.reconcile")}</Button>}
  </div>
}

/** Controlled seven-day calendar. No fixture data, service hooks, local drafts,
 * default scenario, synthetic revisions, CAS checks or outcome decisions. */
export function HourCalendarView(props: HourCalendarViewProps) {
  const { readModel: model, interaction, actions, capabilities } = props
  const { locale } = useI18n()
  const en = locale === "en"
  const { anchorDate: anchor, displayZone: zone, selectedId } = interaction
  const weekStart = useMemo(() => startOfScheduleWeek(anchor, props.weekStartsOn ?? 1), [anchor, props.weekStartsOn])
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addScheduleDays(weekStart, index)), [weekStart])
  const dayRanges = useMemo(() => {
    const formatter = dateFormatter(zone)
    const boundaries = [...days, addScheduleDays(days[6], 1)].map((day) => dateBoundary(day, formatter))
    return days.map((day, index) => ({ day, start: boundaries[index], end: boundaries[index + 1] }))
  }, [days, zone])
  const transitionWeek = dayRanges.some((day) => day.end - day.start !== 24 * 3600000)
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, { timeZone: zone, hour: "numeric", minute: "2-digit", timeZoneName: "shortOffset", ...(props.timeFormat ? { hourCycle: props.timeFormat === "12" ? "h12" as const : "h23" as const } : {}) }), [zone, locale, props.timeFormat])
  const hourFormat = useMemo(() => new Intl.DateTimeFormat(locale, { timeZone: "UTC", hour: "numeric", ...(props.timeFormat ? { hourCycle: props.timeFormat === "12" ? "h12" as const : "h23" as const } : {}) }), [locale, props.timeFormat])
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short", day: "numeric" }), [locale])
  const weekdayFormat = useMemo(() => new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }), [locale])
  const filtered = useMemo(() => {
    const query = interaction.filters.query.trim().toLocaleLowerCase()
    return model.events.filter((event) => (!interaction.filters.projectIds.length || interaction.filters.projectIds.includes(event.projectId)) && (!query || event.title.toLocaleLowerCase().includes(query) || model.presentation?.[event.id]?.identifier?.toLocaleLowerCase().includes(query)))
  }, [model.events, model.presentation, interaction.filters])
  const allDay = useMemo(() => filtered.filter((event) => event.allDay).map((event) => {
    const formatter = dateFormatter(event.timeZone)
    return { event, startDate: dateAt(Date.parse(event.startAt), formatter), endDate: dateAt(Date.parse(event.endAt), formatter) }
  }), [filtered])
  const timed = useMemo(() => filtered.filter((event) => !event.allDay), [filtered])
  const daySegments = useMemo(() => dayRanges.map(({ start, end }) => {
    const clipped: Omit<Segment, "column" | "columns">[] = []
    for (const event of timed) {
      const eventStart = Date.parse(event.startAt), eventEnd = Date.parse(event.endAt)
      const segmentStart = Math.max(start, eventStart), segmentEnd = Math.min(end, eventEnd)
      if (segmentEnd <= segmentStart) continue
      clipped.push({ event, start: segmentStart, end: segmentEnd, continuesLeft: eventStart < start, continuesRight: eventEnd > end })
    }
    clipped.sort((a, b) => a.start - b.start || b.end - a.end || a.event.id.localeCompare(b.event.id))
    return overlapColumns(clipped)
  }), [timed, dayRanges])
  const agenda = useMemo(() => filtered.filter((event) => {
    if (!event.allDay) return Date.parse(event.endAt) > dayRanges[0].start && Date.parse(event.startAt) < dayRanges[6].end
    const range = allDay.find((entry) => entry.event.id === event.id)
    return !!range && range.endDate > days[0] && range.startDate <= days[6]
  }).sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || Date.parse(a.endAt) - Date.parse(b.endAt) || a.id.localeCompare(b.id)), [filtered, dayRanges, allDay, days])
  const issueSources = useMemo(() => model.issueSources.filter((issue) => (!interaction.filters.projectIds.length || interaction.filters.projectIds.includes(issue.projectId)) && (!interaction.filters.query.trim() || (issue.identifier + " " + issue.title).toLocaleLowerCase().includes(interaction.filters.query.trim().toLocaleLowerCase()))), [model.issueSources, interaction.filters])
  const hasContent = model.events.length > 0 || model.issueSources.length > 0
  const loading = model.data.state === "loading" && !hasContent
  const hourScroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const scroller = hourScroller.current
    if (scroller) { scroller.scrollTop = interaction.reading.top; scroller.scrollLeft = interaction.reading.left }
  }, [interaction.reading.top, interaction.reading.left, hasContent, interaction.mode])
  const setAnchor = (date: string) => actions.setInteraction((current) => ({ ...current, anchorDate: date }))
  const edit = (event: HourCalendarEvent, trigger: HTMLElement) => {
    if (loading) return
    actions.setInteraction((current) => ({ ...current, selectedId: event.id }))
    actions.edit(event, trigger)
  }
  const locked = (event: HourCalendarEvent) => loading || model.mutations[event.id]?.status === "pending" || model.mutations[event.id]?.status === "unknown"
  const rangeLabel = (event: HourCalendarEvent, start = Date.parse(event.startAt), end = Date.parse(event.endAt)) => event.allDay ? en ? "All day" : "全天" : timeFormat.format(new Date(start)) + " – " + timeFormat.format(new Date(end))
  const label = (event: HourCalendarEvent) => [model.presentation?.[event.id]?.identifier, event.title].filter(Boolean).join(" ")
  const reconcile = (event: HourCalendarEvent) => {
    const mutation = model.mutations[event.id]
    if (mutation?.status === "unknown") actions.reconcile(event.id, mutation.operationId)
  }
  const eventKeys = (event: HourCalendarEvent, key: KeyboardEvent<HTMLButtonElement>) => {
    if (locked(event)) return
    if (key.key === "Delete" && capabilities.delete(event)) { key.preventDefault(); actions.delete(event, key.currentTarget); return }
    if (!key.altKey) return
    if ((key.key === "ArrowUp" || key.key === "ArrowDown") && !event.allDay) {
      const deltaMinutes = key.key === "ArrowUp" ? -15 : 15
      if (key.shiftKey && capabilities.resize(event)) { key.preventDefault(); actions.resize(event, { edge: "end", deltaMinutes }, key.currentTarget) }
      else if (!key.shiftKey && capabilities.move(event)) { key.preventDefault(); actions.move(event, { kind: "elapsed", deltaMinutes }, key.currentTarget) }
    } else if ((key.key === "ArrowLeft" || key.key === "ArrowRight") && capabilities.move(event)) {
      key.preventDefault(); actions.move(event, { kind: "calendar-days", days: key.key === "ArrowLeft" ? -1 : 1 }, key.currentTarget)
    }
  }
  const agendaView = <section className={styles.section} data-pm-hour-agenda aria-label={en ? "Keyboard agenda" : "键盘议程"}>
    <header className={styles.sectionHeader}><span>{en ? "Keyboard agenda" : "键盘议程"}</span><span className="text-xs font-normal text-muted-foreground">{agenda.length} {en ? "events" : "个事件"}</span></header>
    <ul className={styles.agendaList}>{agenda.map((event) => <li key={event.id} className={styles.agendaRow}>
      <span className={styles.agendaTime}>{rangeLabel(event)}{!event.allDay && " · " + formatHourDuration((Date.parse(event.endAt) - Date.parse(event.startAt)) / 60000)}</span>
      <span className={styles.agendaTitle}><span className={styles.eventIdentifier}>{model.presentation?.[event.id]?.identifier}</span>{event.title}</span>
      <HourMutationNotice mutation={model.mutations[event.id]} onReconcile={() => reconcile(event)} />
      <Button id={"pm-hour-agenda-" + event.id} size="sm" variant="outline" disabled={loading} onClick={(key) => edit(event, key.currentTarget)}>{capabilities.edit(event) ? en ? "Edit" : "编辑" : en ? "Details" : "详情"}</Button>
      {event.issueId && <Button size="sm" variant="ghost" onClick={(key) => actions.openIssue(event.issueId!, key.currentTarget)}>{en ? "Open issue" : "打开任务"}</Button>}
      {capabilities.move(event) && <><Button size="sm" variant="ghost" disabled={locked(event)} aria-label={(en ? "Move previous day: " : "移至前一天：") + label(event)} onClick={(key) => actions.move(event, { kind: "calendar-days", days: -1 }, key.currentTarget)}><ChevronLeft className="size-4" aria-hidden="true" /></Button><Button size="sm" variant="ghost" disabled={locked(event)} aria-label={(en ? "Move next day: " : "移至后一天：") + label(event)} onClick={(key) => actions.move(event, { kind: "calendar-days", days: 1 }, key.currentTarget)}><ChevronRight className="size-4" aria-hidden="true" /></Button></>}
      {!event.allDay && capabilities.resize(event) && <Button size="sm" variant="ghost" disabled={locked(event)} onClick={(key) => actions.resize(event, { edge: "end", deltaMinutes: 15 }, key.currentTarget)}>{en ? "Extend 15m" : "延长15分钟"}</Button>}
      {capabilities.delete(event) && <Button size="sm" variant="ghost" disabled={locked(event)} onClick={(key) => actions.delete(event, key.currentTarget)}>{en ? "Delete" : "删除"}</Button>}
    </li>)}{!agenda.length && <li className={styles.agendaRow}><span className="text-sm text-muted-foreground">{en ? "No events in this week." : "本周没有事件。"}</span></li>}</ul>
  </section>
  const sourcesView = <section className={styles.section} data-pm-unscheduled aria-label={en ? "Date-only issue sources" : "仅日期任务来源"}>
    <header className={styles.sectionHeader}><span>{props.onScheduleIssue ? en ? "Unscheduled" : "未排期" : en ? "Date-only issue sources · read only" : "仅日期任务来源 · 只读"}</span><span className="text-xs font-normal text-muted-foreground">{issueSources.length}</span></header>
    <ul className={styles.agendaList}>{issueSources.map((issue) => <li key={issue.id} className={styles.agendaRow}>
      <span className={styles.agendaTitle}><span className={styles.eventIdentifier}>{issue.identifier}</span>{issue.title}</span>
      <span className="text-xs text-muted-foreground">{en ? "Issue dates (not hour events)" : "任务日期（不是小时事件）"}: {issue.startDate ?? "—"} → {issue.dueDate ?? "—"}</span>
      {props.onScheduleIssue ? <Button size="sm" variant="outline" disabled={loading} onClick={(key) => props.onScheduleIssue?.(issue, key.currentTarget)}>{en ? "Schedule" : "排期"}</Button> : <Button size="sm" variant="outline" disabled={loading} onClick={(key) => actions.openIssue(issue.id, key.currentTarget)}>{en ? "Open issue" : "打开任务"}</Button>}
    </li>)}{!issueSources.length && <li className={styles.agendaRow}><span className="text-sm text-muted-foreground">{props.onScheduleIssue ? en ? "All issues are scheduled." : "所有任务均已排期。" : en ? "No date-only sources in this page." : "当前页没有仅日期来源。"}</span></li>}</ul>
  </section>
  const body = <>
    {interaction.mode === "week" ? <div className={styles.grid} data-pm-hour-frame>
      <div className={styles.dayHeader} data-pm-hour-header><span className={styles.gutterHeader} aria-hidden="true" />{days.map((day) => <div key={day} className={styles.dayHeaderCell} data-weekend={[0, 6].includes(new Date(day + "T12:00:00Z").getUTCDay()) || undefined} data-today={day === model.today || undefined}><span>{weekdayFormat.format(new Date(day + "T12:00:00Z"))}</span><span className={styles.dayNumber}>{Number(day.slice(8))}</span></div>)}</div>
      <div className={styles.allDayLane} data-pm-all-day><span className={styles.allDayLabel}>{en ? "All day" : "全天"}</span>{days.map((day) => <div key={day} className={styles.allDayCell}>{allDay.filter((entry) => entry.startDate <= day && day < entry.endDate).map(({ event }) => <button key={event.id} id={"pm-hour-all-day-" + day + "-" + event.id} type="button" className={styles.allDayChip} style={{ borderLeftColor: model.presentation?.[event.id]?.color ?? "var(--status-neutral)" }} data-pm-event={event.id} data-selected={selectedId === event.id || undefined} data-locked={locked(event) || undefined} disabled={loading} title={label(event) + " · " + rangeLabel(event)} aria-label={label(event) + " · " + rangeLabel(event)} onClick={(key) => edit(event, key.currentTarget)} onKeyDown={(key) => eventKeys(event, key)}><span className={styles.eventIdentifier}>{model.presentation?.[event.id]?.identifier}</span><span className={styles.chipTitle}>{event.title}</span></button>)}</div>)}</div>
      <div className={styles.scroller} data-pm-hour-scroller ref={hourScroller} onScroll={(event) => {
        const top = event.currentTarget.scrollTop, left = event.currentTarget.scrollLeft
        actions.setInteraction((current) => current.reading.top === top && current.reading.left === left ? current : { ...current, reading: { top, left } })
      }}><div className={styles.hoursBody} data-pm-hour-grid>
        <div className={styles.hourLabels}>
          {Array.from({ length: Math.max(24, ...dayRanges.map((day) => Math.ceil((day.end - day.start) / 3600000))) }, (_, hour) => (
            <span key={hour} className={styles.hourLabel} data-pm-hour-label={hour}>
              <span>{transitionWeek ? hour + "h" : hourFormat.format(new Date(Date.UTC(2000, 0, 1, hour)))}</span>
            </span>
          ))}
        </div>
        {daySegments.map((segments, index) => {
          const day = dayRanges[index], minutes = (day.end - day.start) / 60000, transition = minutes !== 1440
          return <div key={day.day} className={styles.dayColumn} data-weekend={[0, 6].includes(new Date(day.day + "T12:00:00Z").getUTCDay()) || undefined} data-pm-hour-day={day.day} data-pm-hour-rows={index === 0 ? "" : undefined} data-pm-zone-transition={transition || undefined} style={{ height: Math.max(32, minutes * MINUTE_HEIGHT) }}>
            {transition && <><p className="pointer-events-none absolute left-1 top-0 z-10 bg-surface text-[10px] text-muted-foreground">{minutes ? (en ? "Local day " : "本地日 ") + formatHourDuration(minutes) : en ? "Skipped local date" : "不存在的本地日期"}</p>{Array.from({ length: Math.ceil(minutes / 60) }, (_, hour) => <span key={hour} aria-hidden="true" className="pointer-events-none absolute right-1 z-10 bg-surface text-[10px] text-muted-foreground" style={{ top: hour * HOUR_HEIGHT + 20 }}>{timeFormat.format(new Date(day.start + hour * 3600000))}</span>)}</>}
            {segments.map((segment) => {
              const event = segment.event, width = 100 / segment.columns, range = rangeLabel(event, segment.start, segment.end)
              const chipLabel = label(event) + ", " + range + (segment.columns > 1 ? ", " + (en ? "overlap " : "重叠 ") + segment.columns : "")
              const color = model.presentation?.[event.id]?.color ?? "var(--status-neutral)"
              return <button key={event.id} id={"pm-hour-event-" + day.day + "-" + event.id} type="button" className={styles.eventChip} style={{ top: (segment.start - day.start) / 60000 * MINUTE_HEIGHT + 4, height: Math.max(32, (segment.end - segment.start) / 60000 * MINUTE_HEIGHT - 8), left: "calc(" + segment.column * width + "% + 4px)", width: "calc(" + width + "% - 8px)", borderColor: "color-mix(in srgb, " + color + " 30%, var(--border))", background: "color-mix(in srgb, " + color + " 7%, var(--surface))" }} data-pm-event={event.id} data-selected={selectedId === event.id || undefined} data-locked={locked(event) || undefined} data-narrow={segment.columns > 1 || undefined} disabled={loading} title={chipLabel} aria-label={chipLabel} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown Delete" onClick={(key) => edit(event, key.currentTarget)} onKeyDown={(key) => eventKeys(event, key)}>
                <span data-pm-event-heading><span className={styles.eventIdentifier}>{model.presentation?.[event.id]?.identifier}</span>{" "}<span className={styles.chipTitle} data-pm-event-title>{event.title}</span></span>
                {segment.columns === 1 && <span className={styles.eventTime} data-pm-event-time>{range}{" · " + formatHourDuration((segment.end - segment.start) / 60000)}</span>}
                {segment.continuesLeft && <span className={styles.continueMarker + " " + styles.continueLeft} aria-hidden="true">←</span>}{segment.continuesRight && <span className={styles.continueMarker + " " + styles.continueRight} aria-hidden="true">→</span>}
              </button>
            })}
          </div>
        })}
      </div></div>
      <p data-pm-hour-footer><span>{en ? "UTC instants; displayed in " : "UTC瞬时；显示时区："}{zone}. {model.sourceDescription}</span><span>{en ? "Alt+arrows move · Alt+Shift+↑/↓ resize" : "Alt+方向键移动 · Alt+Shift+↑/↓调整时长"}</span></p>
    </div> : agendaView}
    {interaction.mode === "week" ? <details data-pm-hour-secondary open={interaction.secondaryOpen} onToggle={(event) => {
      const secondaryOpen = event.currentTarget.open
      actions.setInteraction((current) => current.secondaryOpen === secondaryOpen ? current : { ...current, secondaryOpen })
    }}><summary>{en ? "Agenda & issue sources" : "议程与任务来源"} · {agenda.length} / {issueSources.length}</summary><div>{agendaView}{sourcesView}</div></details> : sourcesView}
  </>
  return <ControlledFocus surface={props}><PmPage pageId="pm-issue-calendar-2" className="pm-hour-calendar" interactive={props.interactive} readingPosition={props.readingPosition} onReadingPositionChange={props.onReadingPositionChange} title={new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(anchor + "T12:00:00Z"))} actions={<div className="flex items-center gap-3">
    <Button variant="secondary" onClick={() => setAnchor(model.today)}>{en ? "Today" : "今天"}</Button>
    <div className="flex items-center rounded-md border bg-surface"><details data-pm-hour-menu onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus() } }}><summary>{en ? "Last 7 days" : "最近 7 天"}<ChevronDown className="size-4" aria-hidden="true" /></summary><div><div className="flex items-center justify-between gap-2"><Button variant="secondary" aria-label={en ? "Previous week" : "上一周"} onClick={() => setAnchor(addScheduleDays(weekStart, -7))}><ChevronLeft className="size-4" aria-hidden="true" />{en ? "Previous week" : "上一周"}</Button><Button variant="secondary" aria-label={en ? "Next week" : "下一周"} onClick={() => setAnchor(addScheduleDays(weekStart, 7))}>{en ? "Next week" : "下一周"}<ChevronRight className="size-4" aria-hidden="true" /></Button></div><label className="grid gap-2">{en ? "Go to date" : "转到日期"}<Input type="date" value={anchor} onChange={(event) => { if (event.target.value) setAnchor(event.target.value) }} /></label></div></details><span data-pm-week-range><CalendarDays className="size-4 text-muted-foreground" aria-hidden="true" />{(props.formatDate?.(weekStart) ?? dateFormat.format(new Date(weekStart + "T12:00:00Z")))}{" – "}{(props.formatDate?.(days[6]) ?? dateFormat.format(new Date(days[6] + "T12:00:00Z")))}</span></div>
    <details data-pm-hour-menu onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus() } }}><summary aria-label={en ? "Calendar controls" : "日历设置"} title={en ? "Calendar controls" : "日历设置"}><Settings2 className="size-4" aria-hidden="true" /></summary><div>
      <label className="grid gap-2">{en ? "Display time zone" : "显示时区"}<RadixSelect aria-label={en ? "Display time zone" : "显示时区"} className="h-8 rounded-md border bg-surface px-2 text-sm" value={zone} onChange={(event) => { const displayZone = event.target.value; actions.setInteraction((current) => ({ ...current, displayZone })) }}>{Array.from(new Set([zone, ...(model.displayZones ?? Intl.supportedValuesOf("timeZone")), "UTC"])).map((value) => <option key={value} value={value}>{value}</option>)}</RadixSelect></label>
      <label className="grid gap-2">{en ? "View" : "视图"}<RadixSelect aria-label={en ? "Calendar view" : "日历视图"} className="h-8 rounded-md border bg-surface px-2 text-sm" value={interaction.mode} onChange={(event) => { const mode = event.target.value as "week" | "agenda"; actions.setInteraction((current) => ({ ...current, mode })) }}><option value="week">{en ? "Week" : "周"}</option><option value="agenda">{en ? "Agenda" : "议程"}</option></RadixSelect></label>
      <label className="grid gap-2">{en ? "Filter events" : "筛选事件"}<Input value={interaction.filters.query} onChange={(event) => { const query = event.target.value; actions.setInteraction((current) => ({ ...current, filters: { ...current.filters, query } })) }} /></label>
      {!!model.projects.length && <label className="grid gap-2">{en ? "Project" : "项目"}<RadixSelect multiple aria-label={en ? "Project filter" : "项目筛选"} className="min-h-16 rounded-md border bg-surface px-2 text-sm" value={[...interaction.filters.projectIds]} onChange={(event) => { const projectIds = Array.from(event.target.selectedOptions, (option) => option.value); actions.setInteraction((current) => ({ ...current, filters: { ...current.filters, projectIds } })) }}>{model.projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}</RadixSelect></label>}
      {props.settingsSlot}
    </div></details>
    <Button id="pm-hour-create" disabled={loading || !capabilities.create} title={capabilities.reason} onClick={(event) => actions.create({ date: anchor, timeZone: zone, allDay: false }, event.currentTarget)}><Plus className="size-4" aria-hidden="true" />{props.onScheduleIssue ? en ? "Add issue" : "添加任务" : en ? "Add event" : "添加事件"}</Button>
  </div>}>
    <style>{hourCalendarCss}</style><ControlledFeedback surface={props} />{model.announcement && <p className="sr-only" role="status">{model.announcement}</p>}
    {props.dataBoundary ? props.dataBoundary(body) : <DataRegion {...model.data} hasContent={hasContent}>{body}</DataRegion>}
    {props.editDialog}{props.createDialog}
  </PmPage></ControlledFocus>
}
