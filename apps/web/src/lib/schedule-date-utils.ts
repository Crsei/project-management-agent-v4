/** Civil dates, not instants. Arithmetic uses Gregorian day numbers, never local midnight. */
export function isScheduleDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false
  const [y, m, d] = value.split("-").map(Number)
  return (
    y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)
  )
}
export function daysInMonth(y: number, m: number) {
  return (
    [
      31,
      y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ][m - 1] ?? 0
  )
}
export function dateOrdinal(date: string) {
  if (!isScheduleDate(date)) throw new RangeError("Invalid calendar date")
  const parts = date.split("-").map(Number),
    d = parts[2]
  let y = parts[0],
    m = parts[1]
  y -= m <= 2 ? 1 : 0
  const era = Math.floor(y / 400),
    yoe = y - era * 400
  m += m > 2 ? -3 : 9
  return (
    era * 146097 +
    yoe * 365 +
    Math.floor(yoe / 4) -
    Math.floor(yoe / 100) +
    Math.floor((153 * m + 2) / 5) +
    d -
    1 -
    719468
  )
}
export function ordinalDate(ordinal: number) {
  const z = ordinal + 719468,
    era = Math.floor(z / 146097),
    doe = z - era * 146097
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36524) -
      Math.floor(doe / 146096)) /
      365,
  )
  let y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)),
    mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1,
    m = mp + (mp < 10 ? 3 : -9)
  y += m <= 2 ? 1 : 0
  const result = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  if (!isScheduleDate(result))
    throw new RangeError("Calendar date outside supported years")
  return result
}
export const addScheduleDays = (date: string, days: number) =>
  ordinalDate(dateOrdinal(date) + Math.trunc(days))
export const scheduleDayDifference = (a: string, b: string) =>
  dateOrdinal(a) - dateOrdinal(b)
export const scheduleWeekday = (date: string) =>
  (((dateOrdinal(date) + 4) % 7) + 7) % 7
export function addScheduleMonths(date: string, months: number) {
  const [y, m, d] = date.split("-").map(Number),
    index = y * 12 + m - 1 + months
  const year = Math.floor(index / 12),
    month = (((index % 12) + 12) % 12) + 1
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(d, daysInMonth(year, month))).padStart(2, "0")}`
}
export const startOfScheduleWeek = (date: string, weekStartsOn: number) =>
  addScheduleDays(date, -((scheduleWeekday(date) - weekStartsOn + 7) % 7))
export function scheduleDates(start: string, end: string) {
  const count = scheduleDayDifference(end, start) + 1
  if (count < 0 || count > 370)
    throw new RangeError("Invalid or oversized schedule viewport")
  return Array.from({ length: count }, (_, i) => addScheduleDays(start, i))
}
export function todayInTimeZone(timeZone: string, now: Date | number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value
  return `${get("year")}-${get("month")}-${get("day")}`
}
export function isScheduleTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    new Intl.DateTimeFormat("en", { timeZone: value })
    return true
  } catch {
    return false
  }
}
export type ScheduleDates = { startDate: string | null; dueDate: string | null }
export function scheduleDateError(
  dates: ScheduleDates,
): "invalidDate" | "invalidRange" | null {
  if (
    (dates.startDate !== null && !isScheduleDate(dates.startDate)) ||
    (dates.dueDate !== null && !isScheduleDate(dates.dueDate))
  )
    return "invalidDate"
  return dates.startDate && dates.dueDate && dates.dueDate < dates.startDate
    ? "invalidRange"
    : null
}
