"use client"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { useI18n } from "../../lib/i18n-provider"
import {
  addScheduleDays,
  addScheduleMonths,
  isScheduleDate,
} from "../../lib/schedule-date-utils"
import type {
  TimelineSettings,
  CalendarSettings,
} from "../../lib/schedule-view-model"
import styles from "./schedule.module.css"
export type ScheduleViewControlsProps = { today: string } & (
  | {
      kind: "timeline"
      value: TimelineSettings
      onChange: (value: TimelineSettings) => void
    }
  | {
      kind: "calendar"
      value: CalendarSettings
      onChange: (value: CalendarSettings) => void
    }
)
export function ScheduleViewControls(props: ScheduleViewControlsProps) {
  const { t, locale } = useI18n(),
    { value } = props
  function update(patch: Partial<TimelineSettings & CalendarSettings>) {
    if (props.kind === "timeline") props.onChange({ ...props.value, ...patch })
    else props.onChange({ ...props.value, ...patch })
  }
  function navigate(direction: number) {
    const weekly =
      props.kind === "timeline"
        ? props.value.scale === "week"
        : props.value.mode === "week"
    const anchorDate = weekly
      ? addScheduleDays(value.anchorDate, 7 * direction)
      : addScheduleMonths(
          value.anchorDate,
          direction *
            (props.kind === "timeline" && props.value.scale === "quarter"
              ? 3
              : 1),
        )
    update({
      anchorDate,
      ...(props.kind === "calendar" ? { selectedDate: anchorDate } : {}),
    })
  }
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, {
      weekday: "short",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(2026, 9, 4 + i))),
  )
  return (
    <div className={styles.controls}>
      <Button
        variant="ghost"
        aria-label={t("schedule.previous")}
        onClick={() => navigate(-1)}
      >
        ‹
      </Button>
      <label>
        {t("schedule.anchor")}
        <Input
          type="date"
          aria-label={t("schedule.anchor")}
          value={value.anchorDate}
          onChange={(e) => {
            if (isScheduleDate(e.target.value))
              update({ anchorDate: e.target.value })
          }}
        />
      </label>
      <Button
        variant="ghost"
        aria-label={t("schedule.next")}
        onClick={() => navigate(1)}
      >
        ›
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          update({
            anchorDate: props.today,
            ...(props.kind === "calendar" ? { selectedDate: props.today } : {}),
          })
        }
      >
        {t("schedule.today")}
      </Button>
      <label>
        {t(props.kind === "timeline" ? "schedule.scale" : "schedule.mode")}
        <select
          aria-label={t(
            props.kind === "timeline" ? "schedule.scale" : "schedule.mode",
          )}
          value={
            props.kind === "timeline" ? props.value.scale : props.value.mode
          }
          onChange={(e) =>
            update(
              props.kind === "timeline"
                ? { scale: e.target.value as TimelineSettings["scale"] }
                : { mode: e.target.value as CalendarSettings["mode"] },
            )
          }
        >
          {(props.kind === "timeline"
            ? (["week", "month", "quarter"] as const)
            : (["week", "month"] as const)
          ).map((v) => (
            <option key={v} value={v}>
              {t(`schedule.${v}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("schedule.weekStartsOn")}
        <select
          aria-label={t("schedule.weekStartsOn")}
          value={value.weekStartsOn}
          onChange={(e) => update({ weekStartsOn: Number(e.target.value) })}
        >
          {weekdays.map((day, i) => (
            <option key={i} value={i}>
              {day}
            </option>
          ))}
        </select>
      </label>
      {props.kind === "calendar" && (
        <label>
          <input
            type="checkbox"
            checked={props.value.showWeekends}
            onChange={(e) => update({ showWeekends: e.target.checked })}
          />
          {t("schedule.weekends")}
        </label>
      )}
      <span className={styles.meta}>
        {t("schedule.timeZone")}: {value.timeZone}
      </span>
    </div>
  )
}
