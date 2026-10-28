"use client"
import { useEffect, useId, useRef, useState, type ComponentProps } from "react"
import { useI18n } from "../../lib/i18n-provider"
import {
  addDateDays,
  addDateMonths,
  localTodayKey,
  parseDateKey,
  type DateKey,
  type DateRange,
} from "../../lib/date-calendar-model"
import { cn } from "../../lib/utils"
import { Button } from "./button"
export type { DateKey, DateRange } from "../../lib/date-calendar-model"
type Shared = Omit<ComponentProps<"div">, "defaultValue" | "onChange"> & {
  month?: string
  defaultMonth?: string
  onMonthChange?: (month: string) => void
  today?: DateKey
  weekStartsOn?: 0 | 1
  disabled?: boolean
  isDateDisabled?: (date: DateKey) => boolean
  min?: DateKey
  max?: DateKey
}
export type DateCalendarProps = Shared &
  (
    | {
        mode?: "single"
        value?: DateKey | null
        defaultValue?: DateKey | null
        onValueChange?: (value: DateKey | null) => void
      }
    | {
        mode: "range"
        value?: DateRange
        defaultValue?: DateRange
        onValueChange?: (value: DateRange) => void
      }
  )
export function DateCalendar(props: DateCalendarProps) {
  const {
    month: providedMonth,
    defaultMonth,
    onMonthChange,
    today = localTodayKey(),
    weekStartsOn = 1,
    disabled,
    isDateDisabled,
    min,
    max,
    className,
    mode = "single",
    value: providedValue,
    defaultValue,
    onValueChange,
    ...divProps
  } = props
  const { t, locale } = useI18n()
  const id = useId()
  const [internalValue, setInternalValue] = useState<
    DateKey | null | DateRange
  >(defaultValue ?? (mode === "range" ? { from: null, to: null } : null))
  const value = providedValue === undefined ? internalValue : providedValue
  const selected = typeof value === "string" ? value : value?.from
  const initial = defaultMonth ?? selected?.slice(0, 7) ?? today.slice(0, 7)
  const [internalMonth, setInternalMonth] = useState(initial)
  const rawMonth = providedMonth ?? internalMonth
  const month = parseDateKey(rawMonth + "-01") ? rawMonth : today.slice(0, 7)
  const first = month + "-01"
  const date = parseDateKey(first)!
  const [focused, setFocused] = useState(selected ?? first)
  const focusRequested = useRef(false)
  const cells = useRef(new Map<string, HTMLButtonElement>())
  useEffect(() => {
    if (focusRequested.current) {
      cells.current.get(focused)?.focus()
      focusRequested.current = false
    }
  }, [focused, month])
  const blocked = (key: string) =>
    !!disabled ||
    !parseDateKey(key) ||
    !!(min && key < min) ||
    !!(max && key > max) ||
    !!isDateDisabled?.(key)
  const changeMonth = (next: string) => {
    if (!parseDateKey(next + "-01")) return
    if (providedMonth === undefined) setInternalMonth(next)
    onMonthChange?.(next)
  }
  const choose = (key: string) => {
    if (blocked(key)) return
    if (mode === "single") {
      if (providedValue === undefined) setInternalValue(key)
      ;(onValueChange as ((value: DateKey | null) => void) | undefined)?.(key)
    } else {
      const range =
        typeof value === "object" && value ? value : { from: null, to: null }
      let next: DateRange = { from: key, to: null }
      if (range.from && !range.to) {
        const from = key < range.from ? key : range.from
        const to = key < range.from ? range.from : key
        let valid = !blocked(from) && !blocked(to)
        if (valid && isDateDisabled) {
          let cursor = from
          while (cursor !== to) {
            cursor = addDateDays(cursor, 1)
            if (blocked(cursor)) {
              valid = false
              break
            }
          }
        }
        if (valid) next = { from, to }
      }
      if (providedValue === undefined) setInternalValue(next)
      ;(onValueChange as ((value: DateRange) => void) | undefined)?.(next)
    }
  }
  const offset = (date.getUTCDay() - weekStartsOn + 7) % 7
  const days = Array.from({ length: 42 }, (_, i) =>
    addDateDays(first, i - offset),
  )
  const focusKey = days.includes(focused)
    ? focused
    : days.includes(selected ?? "")
      ? selected!
      : first
  const monthLabel = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(date)
  return (
    <div
      {...divProps}
      className={cn(
        "w-[280px] max-w-full overflow-auto [@media(pointer:coarse)]:w-[344px]",
        className,
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled || first <= "0001-01-01"}
          aria-label={t("date.previousMonth")}
          onClick={() => changeMonth(addDateMonths(first, -1).slice(0, 7))}
        >
          ‹
        </Button>
        <h3 id={id} aria-live="polite" className="text-sm font-medium">
          {monthLabel}
        </h3>
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled || first >= "9999-12-01"}
          aria-label={t("date.nextMonth")}
          onClick={() => changeMonth(addDateMonths(first, 1).slice(0, 7))}
        >
          ›
        </Button>
      </div>
      <table
        role="grid"
        aria-labelledby={id}
        aria-multiselectable={mode === "range" || undefined}
        className="w-full table-fixed border-separate border-spacing-1 [@media(pointer:coarse)]:min-w-[336px]"
      >
        <thead>
          <tr>
            {Array.from({ length: 7 }, (_, i) =>
              addDateDays("2001-01-01", i + weekStartsOn - 1),
            ).map((key) => (
              <th
                key={key}
                scope="col"
                className="text-xs font-normal text-muted-foreground"
                aria-label={new Intl.DateTimeFormat(locale, {
                  weekday: "long",
                  timeZone: "UTC",
                }).format(parseDateKey(key)!)}
              >
                {new Intl.DateTimeFormat(locale, {
                  weekday: "short",
                  timeZone: "UTC",
                }).format(parseDateKey(key)!)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }, (_, row) => (
            <tr key={row}>
              {days.slice(row * 7, row * 7 + 7).map((key) => {
                if (!parseDateKey(key)) return <td key={key} />
                const range = typeof value === "object" && value ? value : null
                const isSelected =
                  value === key ||
                  !!(
                    range?.from &&
                    key >= range.from &&
                    key <= (range.to ?? range.from)
                  )
                return (
                  <td key={key} role="gridcell" aria-selected={isSelected}>
                    <button
                      ref={(node) => {
                        if (node) cells.current.set(key, node)
                        else cells.current.delete(key)
                      }}
                      type="button"
                      tabIndex={key === focusKey ? 0 : -1}
                      aria-label={new Intl.DateTimeFormat(locale, {
                        dateStyle: "full",
                        timeZone: "UTC",
                      }).format(parseDateKey(key)!)}
                      aria-disabled={blocked(key) || undefined}
                      aria-current={key === today ? "date" : undefined}
                      data-date={key}
                      data-selected={isSelected || undefined}
                      onFocus={() => setFocused(key)}
                      onClick={() => choose(key)}
                      onKeyDown={(event) => {
                        const rtl =
                          getComputedStyle(event.currentTarget).direction ===
                          "rtl"
                        let next: string | undefined
                        if (event.key === "ArrowRight")
                          next = addDateDays(key, rtl ? -1 : 1)
                        if (event.key === "ArrowLeft")
                          next = addDateDays(key, rtl ? 1 : -1)
                        if (event.key === "ArrowDown")
                          next = addDateDays(key, 7)
                        if (event.key === "ArrowUp") next = addDateDays(key, -7)
                        if (event.key === "Home")
                          next = addDateDays(
                            key,
                            -(
                              (parseDateKey(key)!.getUTCDay() -
                                weekStartsOn +
                                7) %
                              7
                            ),
                          )
                        if (event.key === "End")
                          next = addDateDays(
                            key,
                            6 -
                              ((parseDateKey(key)!.getUTCDay() -
                                weekStartsOn +
                                7) %
                                7),
                          )
                        if (event.key === "PageUp")
                          next = addDateMonths(key, event.shiftKey ? -12 : -1)
                        if (event.key === "PageDown")
                          next = addDateMonths(key, event.shiftKey ? 12 : 1)
                        if (next && parseDateKey(next)) {
                          event.preventDefault()
                          focusRequested.current = true
                          setFocused(next)
                          if (next.slice(0, 7) !== month)
                            changeMonth(next.slice(0, 7))
                        }
                      }}
                      className={cn(
                        "flex min-h-8 w-full items-center justify-center rounded-control text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-40 aria-disabled:cursor-not-allowed data-selected:bg-selection data-selected:text-primary [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11",
                        !blocked(key) && "hover:bg-surface-hover",
                        key.slice(0, 7) !== month && "text-muted-foreground",
                      )}
                    >
                      {Number(key.slice(8))}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
