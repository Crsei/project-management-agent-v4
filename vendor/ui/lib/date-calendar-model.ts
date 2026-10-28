/** Civil date keys never pass through local-time parsing or DST arithmetic. */
export type DateKey = string
export type DateRange = { from: DateKey | null; to: DateKey | null }
export function parseDateKey(key: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const [year, month, day] = key.split("-").map(Number)
  if (year < 1 || year > 9999) return null
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  return formatDateKey(date) === key ? date : null
}
export function formatDateKey(date: Date): DateKey {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`
}
export function addDateDays(key: DateKey, amount: number): DateKey {
  const date = parseDateKey(key)
  if (!date) return key
  date.setUTCDate(date.getUTCDate() + amount)
  return formatDateKey(date)
}
export function addDateMonths(key: DateKey, amount: number): DateKey {
  const date = parseDateKey(key)
  if (!date) return key
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + amount)
  const last = new Date(date)
  last.setUTCMonth(last.getUTCMonth() + 1, 0)
  date.setUTCDate(Math.min(day, last.getUTCDate()))
  return formatDateKey(date)
}
export function localTodayKey(): DateKey {
  const date = new Date()
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}
