import { useMemo, useRef, useState } from "react"
import FullCalendar from "@fullcalendar/react"
import dayGridPlugin from "@fullcalendar/daygrid"
import timeGridPlugin from "@fullcalendar/timegrid"
import interactionPlugin from "@fullcalendar/interaction"
import type { EventInput, EventApi } from "@fullcalendar/core"
import zhCnLocale from "@fullcalendar/core/locales/zh-cn"
import { useWorkspaceStore } from "@/providers/app-providers"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-provider"
import { addDays, dateOnly, itemDates, itemRange, itemTitle, ScheduleEditor, ScheduleSelection, UnscheduledItems, type ScheduleItem, type ScheduleProps } from "./service-collection-shared"
import styles from "./service-collections.module.css"

export function ServiceCalendar<T extends ScheduleItem>({ items, onOpen, onSchedule, pending = false, hourly = false, onCreate, today }: ScheduleProps<T> & { hourly?: boolean; onCreate?: ((due: string) => void) | undefined; today?: string | undefined }) {
  const { locale } = useI18n()
  const weekStartsOn = useWorkspaceStore(state => state.weekStartsOn)
  const timeFormat = useWorkspaceStore(state => state.timeFormat)
  const en = locale === "en"
  const calendar = useRef<FullCalendar>(null)
  const [view, setView] = useState<"month" | "week" | "day">("month")
  const [title, setTitle] = useState("")
  const [selectedId, setSelectedId] = useState("")
  const [selection, setSelection] = useState<{ start: string; due: string } | undefined>()
  const [notice, setNotice] = useState("")
  const selected = items.find((item) => item.id === selectedId)
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const events = useMemo<EventInput[]>(() => items.flatMap((item) => {
    const range = itemRange(item)
    if (!range) return []
    const editable = Boolean(onSchedule) && !pending && !item.scheduleReadOnly && item.data.archivedAt == null && (item.scheduleFields?.start !== false || item.scheduleFields?.due !== false)
    return [{ id: item.id, title: itemTitle(item), start: range.start, end: addDays(range.due, 1), allDay: true, editable, durationEditable: editable && item.scheduleFields?.start !== false && item.scheduleFields?.due !== false }]
  }), [items, onSchedule, pending])
  function selectItem(id: string) { setSelectedId(id); setSelection(undefined) }
  function requestDates(event: EventApi, revert: () => void, resize: boolean) {
    const item = byId.get(event.id)
    // FullCalendar uses exclusive ends; the domain stores inclusive date-only ends.
    const start = dateOnly(event.startStr.slice(0, 10))
    const exclusiveEnd = dateOnly(event.endStr.slice(0, 10))
    const allDay = event.allDay
    revert()
    if (!item || !onSchedule || pending || item.scheduleReadOnly || item.data.archivedAt != null || !allDay || !start) return
    if (resize && (item.scheduleFields?.start === false || item.scheduleFields?.due === false)) return
    const due = exclusiveEnd ? addDays(exclusiveEnd, -1) : start
    if (due < start) return
    const original = itemDates(item)
    const nextStart = item.scheduleFields?.start !== false && (resize || original.start) ? start : null
    const nextDue = item.scheduleFields?.due !== false && (resize || original.due) ? due : null
    setSelectedId(item.id)
    setSelection({ start: nextStart ?? "", due: nextDue ?? "" })
    onSchedule(item, nextStart, nextDue)
    setNotice(en ? "Schedule requested. Displayed dates remain unchanged until server confirmation." : "已请求更新日程，服务端确认前仍显示原日期。")
  }
  return <div className={styles.root} aria-busy={pending}>
    <div className={styles.toolbar}>
      <div className={styles.navigation}>
        <Button variant="outline" size="icon" aria-label={en ? "Previous period" : "上一时段"} onClick={() => calendar.current?.getApi().prev()}><ChevronLeft size={16} /></Button>
        <Button variant="outline" onClick={() => calendar.current?.getApi().today()}>{en ? "Today" : "今天"}</Button>
        <Button variant="outline" size="icon" aria-label={en ? "Next period" : "下一时段"} onClick={() => calendar.current?.getApi().next()}><ChevronRight size={16} /></Button>
      </div>
      <h3 className={styles.periodTitle} aria-live="polite">{title}</h3>
      <div className={styles.navigation} aria-label={en ? "Calendar view" : "日历视图"}>
        {(["month", "week", "day"] as const).map((mode) => <Button key={mode} variant="outline" aria-pressed={view === mode} onClick={() => {
          setView(mode)
          calendar.current?.getApi().changeView(mode === "month" ? "dayGridMonth" : `${hourly ? "timeGrid" : "dayGrid"}${mode === "week" ? "Week" : "Day"}`)
        }}>{en ? { month: "Month", week: "Week", day: "Day" }[mode] : { month: "月", week: "周", day: "日" }[mode]}</Button>)}
      </div>
    </div>
    {onCreate && <div className={styles.navigation}><label className="grid min-w-0 gap-1 text-sm">{en ? "New task due date" : "新任务截止日期"}<input type="date" className="min-w-0 rounded border bg-background p-2" value={selection?.due || ""} onChange={event => { const due = dateOnly(event.target.value); setSelection(due ? { start: due, due } : undefined) }} /></label><Button variant="outline" disabled={pending || !selection?.due} onClick={() => { if (selection?.due) onCreate(selection.due) }}>{en ? "Create task on this date" : "在此日期新建任务"}</Button></div>}
    <p className={styles.hint}>{en ? "Dates are all-day and the due date is inclusive. Select a work item, then select a date range or edit its dates below." : "日程仅支持全天日期，截止日期包含当天。选择工作项后，可选择日期范围或在下方编辑日期。"}</p>
    {hourly && <p className={styles.hint}>{en ? "Hourly layout is for orientation only; the service does not store start/end times. Use the all-day row." : "小时布局仅作参考；服务端不保存具体时间，请使用全天行。"}</p>}
    {!onSchedule && <p className={styles.hint}>{en ? "Read-only schedule: editing is unavailable with the current capabilities." : "只读日程：当前能力不支持修改日期。"}</p>}
    {!items.length && <p className={styles.empty}>{en ? "No work items to schedule." : "暂无可排期的工作项。"}</p>}
    <div className={styles.calendar}>
      <FullCalendar ref={calendar} plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]} initialView="dayGridMonth" headerToolbar={false} locale={en ? "en" : zhCnLocale} firstDay={weekStartsOn} slotLabelFormat={{ hour: "numeric", minute: "2-digit", hour12: timeFormat === "12" }} height="auto" timeZone="UTC" events={events} editable={Boolean(onSchedule) && !pending} eventResizableFromStart selectable={Boolean(onSchedule || onCreate) && !pending} selectAllow={(range) => range.allDay} eventAllow={(range) => range.allDay} selectMirror dayMaxEvents={4} nowIndicator={false} navLinks={false} buttonText={{ today: en ? "Today" : "今天", month: en ? "Month" : "月", week: en ? "Week" : "周", day: en ? "Day" : "日" }} allDayText={en ? "All day" : "全天"} moreLinkText={(count) => en ? `+${count} more` : `另 ${count} 项`} noEventsText={en ? "No scheduled work items" : "暂无已排期工作项"}
        now={today}
        initialDate={today}
        eventInteractive
        datesSet={(info) => setTitle(info.view.title)}
        eventClick={({ event }) => { const item = byId.get(event.id); if (item) { selectItem(item.id); onOpen(item) } }}
        eventClassNames={({ event }) => event.id === selectedId ? [styles.selectedEvent] : []}
        eventDrop={(info) => requestDates(info.event, info.revert, false)}
        eventResize={(info) => requestDates(info.event, info.revert, true)}
        dateClick={info => {
          const due = dateOnly(info.dateStr);
          if (due && info.allDay && onCreate && !pending) { setSelection({ start: due, due }); setNotice(en ? "Date selected. Use Create task to open the shared task draft." : "已选择日期，请使用新建任务打开统一草稿。") }
        }}
        select={(info) => {
          const start = dateOnly(info.startStr)
          const end = dateOnly(info.endStr)
          if (!start || !end) return
          setSelection({ start, due: addDays(end, -1) })
          setNotice(en ? "Date range selected. Choose a work item and save dates to apply it." : "已选择日期范围。请选择工作项并保存日期以应用。")
        }}
      />
    </div>
    <ScheduleSelection items={items} selectedId={selectedId} onSelect={(id) => setSelectedId(id)} onOpen={onOpen} />
    {selected && <ScheduleEditor key={`${selected.id}:${selection?.start ?? ""}:${selection?.due ?? ""}`} item={selected} onSchedule={onSchedule} pending={pending} initialDates={selection} />}
    <UnscheduledItems items={items} selectedId={selectedId} onSelect={selectItem} />
    <p role="status" className={styles.hint}>{pending ? (en ? "Saving…" : "正在保存…") : notice}</p>
  </div>
}
