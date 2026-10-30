import { useId, useState } from "react"
import type { Entity } from "@contracts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/lib/i18n-provider"
import styles from "./service-collections.module.css"

export type ScheduleItem = {
  id: string
  version: string | number
  data: Record<string, unknown>
  scheduleReadOnly?: boolean
  scheduleFields?: { start: boolean; due: boolean }
}

export type ScheduleProps<T extends ScheduleItem = Entity> = {
  items: T[]
  onOpen: (item: T) => void
  onSchedule?: (item: T, startDate: string | null, dueDate: string | null) => void
  pending?: boolean
}

export const workItemStatuses = ["draft", "ready", "in_progress", "in_review", "done", "cancelled"] as const
const statusLabels: Record<string, [string, string]> = {
  draft: ["Draft", "草稿"], ready: ["Ready", "就绪"], in_progress: ["In progress", "进行中"],
  in_review: ["In review", "审核中"], done: ["Done", "已完成"], cancelled: ["Cancelled", "已取消"],
}
export function statusLabel(status: string, locale: string) {
  return statusLabels[status]?.[locale === "en" ? 0 : 1] ?? status
}
export function itemText(item: ScheduleItem, field: string): string {
  const value = item.data[field]
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : ""
}
export function itemTitle(item: ScheduleItem) { return itemText(item, "title") || item.id }
export function itemStatus(item: ScheduleItem) { return itemText(item, "status") || "unknown" }

/** UTC arithmetic is only for calendar-day numbers, never conversion to local instants. */
export function dateOnly(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const stamp = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? value : null
}
export function dayNumber(value: string) { return Date.parse(`${value}T00:00:00Z`) / 86400000 }
export function addDays(value: string, days: number) {
  return new Date((dayNumber(value) + days) * 86400000).toISOString().slice(0, 10)
}
export function todayDate() {
  const today = new Date()
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
}
export function itemDates(item: ScheduleItem) {
  return {
    start: item.scheduleFields?.start === false ? null : dateOnly(item.data.startDate),
    due: item.scheduleFields?.due === false ? null : dateOnly(item.data.dueDate),
  }
}
export function itemRange(item: ScheduleItem) {
  const { start, due } = itemDates(item)
  if (!start && !due) return null
  if (start && due && start > due) return null
  return { start: start ?? due!, due: due ?? start! }
}

export function ScheduleEditor<T extends ScheduleItem>({ item, onSchedule, pending, initialDates }: {
  item: T
  onSchedule?: ScheduleProps<T>["onSchedule"]
  pending?: boolean
  initialDates?: { start: string; due: string }
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const id = useId()
  const supportsStart = item.scheduleFields?.start !== false
  const supportsDue = item.scheduleFields?.due !== false
  const saved = itemDates(item)
  const [start, setStart] = useState(supportsStart ? initialDates?.start ?? saved.start ?? "" : "")
  const [due, setDue] = useState(supportsDue ? initialDates?.due ?? saved.due ?? "" : "")
  const [submitted, setSubmitted] = useState(false)
  const [source, setSource] = useState(saved)
  const [base, setBase] = useState(item)
  const dirty = (start || null) !== source.start || (due || null) !== source.due
  if (item.version !== base.version && !dirty) setBase(item)
  // Refresh untouched inputs, but keep a user's draft across conflicts/refetches.
  if (source.start !== saved.start || source.due !== saved.due) {
    setStart((value) => value === (source.start ?? "") ? saved.start ?? "" : value)
    setDue((value) => value === (source.due ?? "") ? saved.due ?? "" : value)
    setSource(saved)
  }
  const invalid = Boolean((start && !dateOnly(start)) || (due && !dateOnly(due)) || (start && due && start > due))
  const changed = (start || null) !== saved.start || (due || null) !== saved.due
  const editable = Boolean(onSchedule) && (supportsStart || supportsDue) && !item.scheduleReadOnly && item.data.archivedAt == null
  return (
    <form className={styles.editor} aria-label={en ? "Edit schedule" : "编辑日程"} onSubmit={(event) => {
      event.preventDefault()
      if (invalid || !changed || !editable || pending) return
      onSchedule?.(base, supportsStart ? start || null : null, supportsDue ? due || null : null)
      setSubmitted(true)
    }}>
      <strong className={styles.editorTitle}>{itemTitle(item)}</strong>
      {supportsStart && <label htmlFor={`${id}-start`}>{en ? "Start date" : "开始日期"}
        <Input id={`${id}-start`} type="date" value={start} disabled={!editable || pending} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined} onChange={(event) => { setStart(event.target.value); setSubmitted(false) }} />
      </label>}
      {supportsDue && <label htmlFor={`${id}-due`}>{en ? "Due date (inclusive)" : "截止日期（含当天）"}
        <Input id={`${id}-due`} type="date" value={due} min={supportsStart ? start || undefined : undefined} disabled={!editable || pending} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined} onChange={(event) => { setDue(event.target.value); setSubmitted(false) }} />
      </label>}
      {!supportsStart && supportsDue && <p className={styles.hint}>{en ? "This entity supports a due date only." : "此对象仅支持截止日期。"}</p>}
      <Button type="submit" disabled={!editable || pending || invalid || !changed} loading={pending}>{en ? "Save dates" : "保存日期"}</Button>
      <Button variant="outline" disabled={!editable || pending || (!start && !due)} onClick={() => { setStart(""); setDue(""); setSubmitted(false) }}>{en ? "Clear dates" : "清除日期"}</Button>
      {invalid && <p id={`${id}-error`} role="alert" className={styles.error}>{en ? "Enter valid dates; the due date cannot precede the start date." : "请输入有效日期；截止日期不能早于开始日期。"}</p>}
      {!editable && <p className={styles.hint}>{en ? "Schedule editing is unavailable for this item or your current permissions." : "此工作项或当前权限不支持编辑日程。"}</p>}
      {base.version !== item.version && <div role="alert" className={styles.hint}>
        <p>{en ? "The task changed on the server. Your draft keeps its original version; saving detects conflicts." : "服务端任务已变化。草稿仍使用原版本，保存将检测冲突。"}</p>
        <Button variant="outline" disabled={pending} onClick={() => setBase(item)}>{en ? "Use current version, retain draft" : "采用当前版本并保留草稿"}</Button>
      </div>}
      {submitted && changed && <p role="status" className={styles.hint}>{en ? "Dates requested. The view changes only after server confirmation; any error is shown by the page." : "已请求更新日期。服务端确认后视图才会更新；错误将在页面显示。"}</p>}
      {submitted && !changed && <p role="status" className={styles.hint}>{en ? "Saved dates confirmed by the server." : "服务端已确认保存日期。"}</p>}
    </form>
  )
}
