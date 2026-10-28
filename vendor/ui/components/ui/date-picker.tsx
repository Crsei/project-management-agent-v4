"use client"
import { useState } from "react"
import { useI18n } from "../../lib/i18n-provider"
import { Button } from "./button"
import {
  DateCalendar,
  type DateCalendarProps,
  type DateKey,
  type DateRange,
} from "./date-calendar"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from "./popover"
export type DatePickerProps = DateCalendarProps & {
  label: string
  placeholder?: string
}
/** Caller date keys remain civil dates. This component never parses them in a browser time zone. */
export function DatePicker({ label, placeholder, ...props }: DatePickerProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [internal, setInternal] = useState<DateKey | null | DateRange>(
    props.defaultValue ??
      (props.mode === "range" ? { from: null, to: null } : null),
  )
  const value = props.value === undefined ? internal : props.value
  const text =
    typeof value === "string"
      ? value
      : value?.from
        ? `${value.from}${value.to ? ` – ${value.to}` : " …"}`
        : (placeholder ?? t("date.choose"))
  const changed = (next: DateKey | null | DateRange) => {
    if (props.value === undefined) setInternal(next)
    if (props.mode === "range") {
      props.onValueChange?.(next as DateRange)
      if ((next as DateRange).to) setOpen(false)
    } else {
      props.onValueChange?.(next as DateKey | null)
      setOpen(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="secondary" disabled={props.disabled} />}
        aria-label={label}
      >
        {text}
      </PopoverTrigger>
      <PopoverContent className="p-3">
        <PopoverTitle className="sr-only">{label}</PopoverTitle>
        {props.mode === "range" ? (
          <DateCalendar
            {...props}
            value={value as DateRange}
            onValueChange={changed}
          />
        ) : (
          <DateCalendar
            {...props}
            value={value as DateKey | null}
            onValueChange={changed}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}
