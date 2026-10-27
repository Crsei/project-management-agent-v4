import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { Anchor as PopoverAnchor } from "@radix-ui/react-popover"
import { CalendarDays, Check, ChevronLeft, ChevronRight, Crosshair, Diamond, FolderKanban, UserRound, X } from "lucide-react"
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useI18n } from "@/lib/i18n-provider"
import { useWorkspaceStore } from "@/providers/app-providers"
import { useDisplayDateTime } from "@/features/workspace/preference-format"
import { addDays, dateOnly, dayNumber, itemDates, itemRange, itemStatus, itemText, itemTitle, ScheduleEditor, statusLabel, todayDate, type ScheduleItem, type ScheduleProps } from "./service-collection-shared"
import styles from "./service-gantt.module.css"

type Scale = "week" | "month" | "quarter"
type GroupBy = "status" | "assignee" | "project" | "none"
type StatusCategory = "backlog" | "unstarted" | "started" | "completed" | "canceled" | "unknown"

export type TimelineMilestone = {
  id: string
  title: string
  date: string
  projectId?: string
  projectTitle?: string
}

export type ServiceGanttProps<T extends ScheduleItem> = ScheduleProps<T> & {
  today?: string
  defaultGroupBy?: GroupBy
  milestones?: readonly TimelineMilestone[]
  onOpenMilestone?: (id: string) => void
  toolbarTarget?: HTMLElement | null
}

type TimelineRow<T> =
  | { type: "milestones" }
  | { type: "group"; key: string; title: string; count: number }
  | { type: "task"; item: T }

const legacyCategories: Record<string, StatusCategory> = { draft: "backlog", ready: "unstarted", in_progress: "started", in_review: "started", done: "completed", cancelled: "canceled" }

function category(item: ScheduleItem): StatusCategory {
  const configured = itemText(item, "statusCategory")
  if (configured === "backlog" || configured === "unstarted" || configured === "started" || configured === "completed" || configured === "canceled") return configured
  return legacyCategories[itemStatus(item)] ?? "unknown"
}

function taskStatus(item: ScheduleItem, locale: string) {
  return itemText(item, "statusLabel") || statusLabel(itemStatus(item), locale)
}

function StatusIcon({ item, locale }: { item: ScheduleItem; locale: string }) {
  const value = category(item)
  return <span className={styles.statusIcon} data-category={value} role="img" aria-label={taskStatus(item, locale)} title={taskStatus(item, locale)}>
    {value === "completed" && <Check size={9} strokeWidth={2.5} aria-hidden="true" />}
    {value === "canceled" && <X size={8} aria-hidden="true" />}
  </span>
}

function Assignee({ item }: { item: ScheduleItem }) {
  const name = itemText(item, "assigneeName")
  const id = itemText(item, "assigneeId")
  if (!name && !id) return null
  const initials = name.trim().split(/\s+/u).map(part => Array.from(part)[0] ?? "").slice(0, 2).join("").toLocaleUpperCase()
  return <span className={styles.assignee} title={name || id} aria-label={name || id}>
    {name ? initials : <UserRound size={11} aria-hidden="true" />}
  </span>
}

function timelinePeriod(anchor: string, scale: Scale, weekStartsOn: 0 | 1 | 6) {
  const before = scale === "week" ? 21 : scale === "month" ? 56 : 91
  const date = addDays(anchor, -before)
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  const start = addDays(date, -((weekday - weekStartsOn + 7) % 7))
  return { start, days: scale === "week" ? 91 : scale === "month" ? 238 : 364, dayWidth: scale === "week" ? 32 : scale === "month" ? 11 : 7 }
}

function moveAnchor(anchor: string, scale: Scale, direction: number) {
  if (scale === "week") return addDays(anchor, direction * 7)
  const date = new Date(`${anchor}T00:00:00Z`)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + direction * (scale === "quarter" ? 3 : 1))
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, last))
  return date.toISOString().slice(0, 10)
}

const noMilestones: readonly TimelineMilestone[] = []

export function ServiceGantt<T extends ScheduleItem>({ items, onOpen, onSchedule, pending = false, today: suppliedToday, defaultGroupBy = "project", milestones = noMilestones, onOpenMilestone, toolbarTarget }: ServiceGanttProps<T>) {
  const { locale } = useI18n()
  const en = locale === "en"
  const weekStartsOn = useWorkspaceStore(state => state.weekStartsOn)
  const display = useDisplayDateTime("UTC")
  const today = dateOnly(suppliedToday) ?? todayDate()
  const [scale, setScale] = useState<Scale>("week")
  const [groupBy, setGroupBy] = useState<GroupBy>(defaultGroupBy)
  const [anchor, setAnchor] = useState(today)
  const [jumpVersion, setJumpVersion] = useState(0)
  const [selectedId, setSelectedId] = useState("")
  const [selectedMilestoneIds, setSelectedMilestoneIds] = useState<readonly string[]>([])
  const viewport = useRef<HTMLDivElement>(null)
  const scheduleAnchor = useRef<HTMLElement | null>(null)
  const milestoneAnchor = useRef<HTMLElement | null>(null)
  const scheduleTitleId = useId()
  const scheduleDescriptionId = useId()
  const milestoneTitleId = useId()
  const selected = items.find(item => item.id === selectedId)
  const selectedMilestones = milestones.filter(milestone => selectedMilestoneIds.includes(milestone.id))
  const period = useMemo(() => timelinePeriod(anchor, scale, weekStartsOn), [anchor, scale, weekStartsOn])
  const width = period.days * period.dayWidth
  const end = addDays(period.start, period.days - 1)

  const rows = useMemo(() => {
    const result: TimelineRow<T>[] = []
    if (milestones.length) result.push({ type: "milestones" })
    if (groupBy === "none") return [...result, ...items.map(item => ({ type: "task" as const, item }))]
    const groups = new Map<string, { title: string; items: T[] }>()
    for (const item of items) {
      const key = groupBy === "project" ? itemText(item, "projectId") || itemText(item, "projectTitle") : groupBy === "assignee" ? itemText(item, "assigneeId") || itemText(item, "assigneeName") : itemStatus(item)
      const title = groupBy === "project" ? itemText(item, "projectTitle") || key || (en ? "No project" : "未关联项目") : groupBy === "assignee" ? itemText(item, "assigneeName") || key || (en ? "Unassigned" : "未分配") : taskStatus(item, locale)
      const group = groups.get(key)
      if (group) group.items.push(item)
      else groups.set(key, { title, items: [item] })
    }
    for (const [key, group] of groups) {
      result.push({ type: "group", key, title: group.title, count: group.items.length })
      result.push(...group.items.map(item => ({ type: "task" as const, item })))
    }
    return result
  }, [items, milestones.length, groupBy, en, locale])

  const ticks = useMemo(() => Array.from({ length: period.days }, (_, index) => {
    const date = addDays(period.start, index)
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
    return { date, index, weekend: weekday === 0 || weekday === 6 }
  }), [period.start, period.days])

  const months = useMemo(() => {
    const segments: { date: string; days: number }[] = []
    for (const { date } of ticks) {
      const last = segments[segments.length - 1]
      if (last && last.date.slice(0, 7) === date.slice(0, 7)) last.days++
      else segments.push({ date, days: 1 })
    }
    return segments
  }, [ticks])

  const milestonePoints = useMemo(() => {
    const dates = new Map<string, TimelineMilestone[]>()
    for (const milestone of milestones) {
      const date = dateOnly(milestone.date)
      if (!date) continue
      const list = dates.get(date)
      if (list) list.push(milestone)
      else dates.set(date, [milestone])
    }
    return [...dates].sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => ({ date, list, x: (dayNumber(date) - dayNumber(period.start) + 0.5) * period.dayWidth }))
  }, [milestones, period.start, period.dayWidth])

  const dependencyPaths = useMemo(() => {
    const positions = new Map<string, { start: number; end: number; y: number }>()
    rows.forEach((row, index) => {
      if (row.type !== "task") return
      const range = itemRange(row.item)
      if (!range) return
      const start = (dayNumber(range.start) - dayNumber(period.start)) * period.dayWidth
      const end = (dayNumber(range.due) - dayNumber(period.start) + 1) * period.dayWidth
      if (end <= 0 || start >= width) return
      positions.set(row.item.id, { start: Math.max(0, start), end: Math.min(width, end), y: index * 36 + 18 })
    })
    return rows.flatMap(row => {
      if (row.type !== "task" || !Array.isArray(row.item.data.dependencies)) return []
      const to = positions.get(row.item.id)
      if (!to) return []
      return [...new Set(row.item.data.dependencies.filter((id): id is string => typeof id === "string"))].flatMap(id => {
        const from = positions.get(id)
        if (!from || id === row.item.id) return []
        const x1 = from.end
        const x2 = to.start
        return [{
          key: `${id}:${row.item.id}`,
          curve: `M${x1} ${from.y} C${Math.max(x1 + 10, x2 - 10)} ${from.y}, ${Math.min(x1 + 10, x2 - 10)} ${to.y}, ${x2 - 1} ${to.y}`,
          arrow: `M${x2 - 6} ${to.y - 3.5} L${x2 - 1} ${to.y} L${x2 - 6} ${to.y + 3.5}`,
          reversed: x2 < x1,
        }]
      })
    })
  }, [rows, period.start, period.dayWidth, width])

  const hasRows = rows.length > 0
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const laneWidth = Number.parseFloat(getComputedStyle(element).getPropertyValue("--task-lane-width")) || 300
    const inset = Math.min(160, Math.max(20, (element.clientWidth - laneWidth) / 3))
    element.scrollLeft = Math.max(0, (dayNumber(anchor) - dayNumber(period.start)) * period.dayWidth - inset)
  }, [anchor, period.start, period.dayWidth, jumpVersion, hasRows])

  function goToDate(date: string) {
    setAnchor(date)
    setJumpVersion(value => value + 1)
  }
  function selectSchedule(item: T, element: HTMLElement) {
    scheduleAnchor.current = element
    setSelectedId(item.id)
  }
  function selectMilestones(list: readonly TimelineMilestone[], element: HTMLElement) {
    milestoneAnchor.current = element
    setSelectedMilestoneIds(list.map(milestone => milestone.id))
  }
  function openItem(item: T) {
    setSelectedId("")
    onOpen(item)
  }

  const monthFormat = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" })
  const weekFormat = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" })
  const controls = <div className={styles.controls} role="group" aria-label={en ? "Timeline controls" : "时间线控制"}>
    <div className={styles.segment} aria-label={en ? "Timeline scale" : "时间线比例"}>
      {(["week", "month", "quarter"] as const).map(value => <button type="button" key={value} aria-pressed={scale === value} className={value === "quarter" ? styles.quarter : undefined} onClick={() => setScale(value)}>{en ? { week: "Weeks", month: "Months", quarter: "Quarter" }[value] : { week: "周", month: "月", quarter: "季度" }[value]}</button>)}
    </div>
    <select className={styles.groupSelect} value={groupBy} aria-label={en ? "Group by" : "分组方式"} onChange={event => setGroupBy(event.target.value as GroupBy)}>
      <option value="status">{en ? "Group: Status" : "按状态分组"}</option>
      <option value="assignee">{en ? "Group: Assignee" : "按负责人分组"}</option>
      <option value="project">{en ? "Group: Project" : "按项目分组"}</option>
      <option value="none">{en ? "No grouping" : "不分组"}</option>
    </select>
    <button type="button" className={styles.controlButton} onClick={() => goToDate(today)}><Crosshair size={14} aria-hidden="true" />{en ? "Today" : "今天"}</button>
    <div className={styles.periodNavigation}>
      <button type="button" className={styles.iconButton} aria-label={en ? "Previous period" : "上一时段"} onClick={() => goToDate(moveAnchor(anchor, scale, -1))}><ChevronLeft size={14} aria-hidden="true" /></button>
      <button type="button" className={styles.iconButton} aria-label={en ? "Next period" : "下一时段"} onClick={() => goToDate(moveAnchor(anchor, scale, 1))}><ChevronRight size={14} aria-hidden="true" /></button>
      <Popover>
        <PopoverTrigger render={<button type="button" className={styles.iconButton} aria-label={en ? "Go to date" : "跳转日期"} />}><CalendarDays size={14} aria-hidden="true" /></PopoverTrigger>
        <PopoverContent className={styles.navigationPanel} align="end">
          <label>{en ? "Go to date" : "跳转日期"}<input type="date" value={anchor} onChange={event => { const date = dateOnly(event.target.value); if (date) goToDate(date) }} /></label>
          <p>{display.date(period.start)} — {display.date(end)}</p>
        </PopoverContent>
      </Popover>
    </div>
    <span className={styles.srOnly} aria-live="polite">{display.date(period.start)} — {display.date(end)}</span>
  </div>

  const todayX = (dayNumber(today) - dayNumber(period.start) + 0.5) * period.dayWidth
  return <div className={styles.root} aria-busy={pending}>
    {toolbarTarget ? createPortal(controls, toolbarTarget) : <div className={styles.localToolbar}>{controls}</div>}
    {!hasRows ? <div className={styles.empty}><CalendarDays size={28} strokeWidth={1.2} aria-hidden="true" /><strong>{en ? "Nothing on the timeline" : "时间线暂无内容"}</strong><p>{en ? "Tasks and their saved schedules will appear here." : "任务及其已保存的日程将在此显示。"}</p></div> : <div ref={viewport} className={styles.viewport} tabIndex={0} role="region" aria-label={en ? "Scrollable task timeline" : "可滚动任务时间线"}>
      <div className={styles.timeline} style={{ "--timeline-width": `${width}px` } as CSSProperties}>
        <div className={styles.header}>
          <div className={styles.taskHeading}>{en ? "Task" : "任务"}</div>
          <div className={styles.dateHeading}>
            <div className={styles.months}>{months.map(month => <div key={month.date} style={{ width: month.days * period.dayWidth }}><span>{monthFormat.format(new Date(`${month.date}T00:00:00Z`))}</span></div>)}</div>
            <div className={styles.days}>{ticks.filter(tick => scale === "week" || tick.index % 7 === 0).map(tick => <div key={tick.date} style={{ width: period.dayWidth * (scale === "week" ? 1 : 7) }} data-today={tick.date === today || undefined} title={display.date(tick.date)}>{scale === "week" ? Number(tick.date.slice(8)) : weekFormat.format(new Date(`${tick.date}T00:00:00Z`))}</div>)}</div>
          </div>
        </div>
        <div className={styles.body}>
          <div className={styles.taskLane}>
            {rows.map(row => {
              if (row.type === "milestones") return <button type="button" key="milestones" className={`${styles.laneRow} ${styles.groupRow} ${styles.milestoneHeading}`} onClick={event => selectMilestones(milestones, event.currentTarget)}><Diamond size={12} aria-hidden="true" />{en ? "Milestones" : "里程碑"}<span className={styles.count}>{milestones.length}</span></button>
              if (row.type === "group") return <div key={`group:${row.key}`} className={`${styles.laneRow} ${styles.groupRow}`}>{groupBy === "project" ? <FolderKanban size={13} aria-hidden="true" /> : groupBy === "assignee" ? <UserRound size={13} aria-hidden="true" /> : null}<span className={styles.truncate}>{row.title}</span><span className={styles.count}>{row.count}</span></div>
              const item = row.item
              return <div key={item.id} className={styles.laneRow} data-selected={selectedId === item.id || undefined} data-category={category(item)}>
                <StatusIcon item={item} locale={locale} />
                <button type="button" className={styles.taskTitle} title={itemTitle(item)} onClick={() => openItem(item)}>{itemTitle(item)}</button>
                <Assignee item={item} />
                <button type="button" className={styles.scheduleTrigger} aria-label={`${en ? "View or edit dates" : "查看或编辑日期"} · ${itemTitle(item)}`} onClick={event => selectSchedule(item, event.currentTarget)}><CalendarDays size={13} aria-hidden="true" /></button>
              </div>
            })}
            <div className={styles.laneFooter} />
          </div>
          <div className={styles.grid} style={{ height: rows.length * 36 + 40 }}>
            {scale === "week" && ticks.filter(tick => tick.weekend).map(tick => <div key={`weekend:${tick.date}`} className={styles.weekend} style={{ left: tick.index * period.dayWidth, width: period.dayWidth }} aria-hidden="true" />)}
            {ticks.filter(tick => tick.index % 7 === 0).map(tick => <div key={`line:${tick.date}`} className={styles.gridLine} style={{ left: tick.index * period.dayWidth }} aria-hidden="true" />)}
            {todayX >= 0 && todayX < width && <div className={styles.todayLine} style={{ left: todayX }} title={`${en ? "Today" : "今天"} · ${display.date(today)}`} aria-hidden="true" />}
            {rows.map((row, index) => {
              const top = index * 36
              if (row.type === "group" || row.type === "milestones") return <div key={`band:${index}`} className={styles.groupBand} style={{ top }} aria-hidden="true" />
              const item = row.item
              const range = itemRange(item)
              const dates = itemDates(item)
              const start = range ? (dayNumber(range.start) - dayNumber(period.start)) * period.dayWidth : 0
              const finish = range ? (dayNumber(range.due) - dayNumber(period.start) + 1) * period.dayWidth : 0
              const left = Math.max(0, start)
              const barWidth = Math.min(width, finish) - left
              const editable = Boolean(onSchedule) && !item.scheduleReadOnly && item.data.archivedAt == null && (item.scheduleFields?.start !== false || item.scheduleFields?.due !== false)
              if (!range || barWidth <= 0 || start >= width) return <div key={item.id} className={styles.scheduleState} style={{ top }}>
                <button type="button" className={styles.scheduleAction} onClick={event => range ? goToDate(range.start) : selectSchedule(item, event.currentTarget)}>{range ? `${display.date(range.start)} · ${en ? "Go to date" : "跳转日期"}` : dates.start && dates.due ? (en ? `Invalid date range · ${editable ? "edit" : "view"}` : `日期范围异常 · ${editable ? "编辑" : "查看"}`) : (en ? `Unscheduled · ${editable ? "set dates" : "view dates"}` : `未排期 · ${editable ? "设置日期" : "查看日期"}`)}</button>
              </div>
              const detail = `${en ? "Start" : "开始"}: ${dates.start ? display.date(dates.start) : "—"} · ${en ? "Due (inclusive)" : "截止（含当天）"}: ${dates.due ? display.date(dates.due) : "—"}`
              return <div key={item.id}>
                <button type="button" className={styles.bar} data-category={category(item)} data-partial={!dates.start || !dates.due || undefined} data-clipped-start={start < 0 || undefined} data-clipped-end={finish > width || undefined} aria-pressed={selectedId === item.id} aria-label={`${itemTitle(item)} · ${detail} · ${en ? "View or edit dates" : "查看或编辑日期"}`} title={`${itemTitle(item)} · ${taskStatus(item, locale)} · ${detail}`} style={{ left, top: top + 6, width: barWidth, ...(itemText(item, "color") ? { "--bar-color": itemText(item, "color") } : {}) } as CSSProperties} onClick={event => selectSchedule(item, event.currentTarget)}>
                  {barWidth > 110 && <><Assignee item={item} /><span className={styles.truncate}>{itemTitle(item)}</span></>}
                </button>
                {barWidth <= 110 && left + barWidth + 8 < width && <span className={styles.barLabel} style={{ left: left + barWidth + 8, top: top + 9, maxWidth: Math.min(280, width - left - barWidth - 12) }} aria-hidden="true">{itemTitle(item)}</span>}
              </div>
            })}
            {milestonePoints.map((point, index) => {
              if (point.x < 0 || point.x >= width) return null
              const room = Math.min(milestonePoints[index + 1]?.x ?? width, width) - point.x - 24
              const title = `${point.list.map(milestone => `${milestone.title}${milestone.projectTitle || milestone.projectId ? ` (${milestone.projectTitle || milestone.projectId})` : ""}`).join(" · ")} · ${display.date(point.date)}`
              return <button type="button" key={point.date} className={styles.milestone} style={{ left: point.x - 6, top: 9 }} title={title} aria-label={`${en ? "Milestone" : "里程碑"}: ${title}`} onClick={event => selectMilestones(point.list, event.currentTarget)}><span className={styles.diamond} aria-hidden="true" />{room >= 28 && <span className={styles.milestoneLabel} style={{ maxWidth: room }}>{point.list[0]!.title}{point.list.length > 1 ? ` +${point.list.length - 1}` : ""}</span>}</button>
            })}
            <svg className={styles.dependencies} width={width} height={rows.length * 36} viewBox={`0 0 ${width} ${rows.length * 36}`} aria-hidden="true">{dependencyPaths.map(path => <g key={path.key}><path d={path.curve} strokeDasharray={path.reversed ? "3 3" : undefined} /><path d={path.arrow} /></g>)}</svg>
          </div>
        </div>
      </div>
    </div>}
    <Popover open={Boolean(selected)} onOpenChange={open => { if (!open) setSelectedId("") }}>
      <PopoverAnchor virtualRef={scheduleAnchor} />
      {selected && <PopoverContent className={styles.schedulePanel} aria-labelledby={scheduleTitleId} aria-describedby={scheduleDescriptionId} side="bottom" align="end" collisionPadding={12} onCloseAutoFocus={event => { event.preventDefault(); scheduleAnchor.current?.focus({ preventScroll: true }) }}>
        <div className={styles.panelHeading}><h3 id={scheduleTitleId}>{en ? "Task dates" : "任务日期"}</h3><PopoverClose render={<button type="button" className={styles.iconButton} aria-label={en ? "Close date editor" : "关闭日期编辑"} />}><X size={15} aria-hidden="true" /></PopoverClose></div>
        <p id={scheduleDescriptionId} className={styles.panelDescription}>{en ? "All-day dates. Save explicitly; the due date is inclusive." : "全天日期，截止日包含当天；修改后请显式保存。"}</p>
        <ScheduleEditor key={selected.id} item={selected} onSchedule={onSchedule} pending={pending} />
        <button type="button" className={styles.detailsLink} onClick={() => openItem(selected)}>{en ? "Open task details" : "打开任务详情"}<ChevronRight size={13} aria-hidden="true" /></button>
      </PopoverContent>}
    </Popover>
    <Popover open={selectedMilestones.length > 0} onOpenChange={open => { if (!open) setSelectedMilestoneIds([]) }}>
      <PopoverAnchor virtualRef={milestoneAnchor} />
      {selectedMilestones.length > 0 && <PopoverContent className={styles.milestonePanel} aria-labelledby={milestoneTitleId} side="bottom" align="start" collisionPadding={12} onCloseAutoFocus={event => { event.preventDefault(); milestoneAnchor.current?.focus({ preventScroll: true }) }}>
        <div className={styles.panelHeading}><h3 id={milestoneTitleId}>{en ? "Milestones" : "里程碑"}</h3><PopoverClose render={<button type="button" className={styles.iconButton} aria-label={en ? "Close milestones" : "关闭里程碑"} />}><X size={15} aria-hidden="true" /></PopoverClose></div>
        <ul className={styles.milestoneList}>{selectedMilestones.map(milestone => <li key={milestone.id}>
          {onOpenMilestone ? <button type="button" className={styles.milestoneTitle} onClick={() => { setSelectedMilestoneIds([]); onOpenMilestone(milestone.id) }}>{milestone.title}</button> : <strong>{milestone.title}</strong>}
          {(milestone.projectTitle || milestone.projectId) && <span>{milestone.projectTitle || milestone.projectId}</span>}
          {dateOnly(milestone.date) ? <button type="button" className={styles.milestoneDate} onClick={() => { goToDate(milestone.date); setSelectedMilestoneIds([]) }}>{display.date(milestone.date)}<Crosshair size={12} aria-hidden="true" /></button> : <span>{en ? "No valid date" : "日期无效"}</span>}
        </li>)}</ul>
      </PopoverContent>}
    </Popover>
    {pending && <span role="status" className={styles.saving}>{en ? "Saving dates…" : "正在保存日期…"}</span>}
  </div>
}
