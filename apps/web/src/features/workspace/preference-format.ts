import { useMemo } from "react"
import { useWorkspaceStore } from "@/providers/app-providers"
import type { DisplayPreferences } from "./store"

/** Date-only values stay UTC calendar days; display preferences never rewrite them. */
export function formatPreferenceDate(value: string | null | undefined, format: DisplayPreferences["dateFormat"], locale: string, timeZone?: string): string {
  if (!value) return "—"
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = new Date(allDay ? `${value}T00:00:00Z` : value)
  if (!Number.isFinite(date.getTime()) || allDay && date.toISOString().slice(0, 10) !== value) return "—"
  const zone = allDay ? "UTC" : timeZone
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "numeric", day: "numeric", ...(zone ? { timeZone: zone } : {}) }).formatToParts(date)
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === name)?.value ?? ""
  const year = part("year"), month = part("month"), day = part("day")
  if (format === "yyyy-MM-dd") return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
  if (format === "d/M") return `${day}/${month}`
  if (format === "M/d") return `${month}/${day}`
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(zone ? { timeZone: zone } : {}) }).format(date)
}

export function formatPreferenceTime(value: string, format: DisplayPreferences["timeFormat"], locale: string, timeZone?: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "—"
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", hourCycle: format === "12" ? "h12" : "h23", ...(timeZone ? { timeZone } : {}) }).format(date)
}

export function useDisplayDateTime(timeZone?: string) {
  const locale = useWorkspaceStore(state => state.locale)
  const dateFormat = useWorkspaceStore(state => state.dateFormat)
  const timeFormat = useWorkspaceStore(state => state.timeFormat)
  return useMemo(() => {
    const date = (value: string | null | undefined) => formatPreferenceDate(value, dateFormat, locale, timeZone)
    const time = (value: string) => formatPreferenceTime(value, timeFormat, locale, timeZone)
    return { date, time, dateTime: (value: string | null | undefined) => !value || !Number.isFinite(Date.parse(value)) ? "—" : `${date(value)} · ${time(value)}` }
  }, [locale, dateFormat, timeFormat, timeZone])
}
