import { CalendarDays, Zap } from "lucide-react";
import { Input } from "@agent/components/ui/input";
import type { StudioConfig } from "../../../../../../../../packages/contracts/src/automation-studio";
import type { AutomationCatalogTemplate } from "../../../../../../../../packages/contracts/src/automation-catalog";
import { useAgentText } from "../../i18n";
import { StudioSetupField as Field } from "./studio-setup-field";
import type { StudioFrequency } from "./studio-setup";
import styles from "./studio-setup.module.css";
import { RadixSelect } from "@/components/ui/radix-select";

type EventOption = { value: string; label: string };
type Props = {
  trigger: StudioConfig["trigger"];
  template?: AutomationCatalogTemplate;
  frequency: StudioFrequency;
  time: string;
  weekday: string;
  once: string;
  timezone: string;
  filterText: string;
  issues: Record<string, string>;
  disabled: boolean;
  onMode: (mode: "schedule" | "event") => void;
  onFrequency: (value: StudioFrequency) => void;
  onTime: (value: string) => void;
  onWeekday: (value: string) => void;
  onOnce: (value: string) => void;
  onTimezone: (value: string) => void;
  onCron: (value: string) => void;
  onEventKey: (value: string) => void;
  onFilterText: (value: string) => void;
};

const TIMEZONES = ["UTC", "Asia/Shanghai", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Australia/Sydney"];

/** OpenHands-style choice first: a schedule or an arriving event, then only the fields that choice needs. */
export function StudioTrigger({ trigger, template, frequency, time, weekday, once, timezone, filterText, issues, disabled, onMode, onFrequency, onTime, onWeekday, onOnce, onTimezone, onCron, onEventKey, onFilterText }: Props) {
  const t = useAgentText();
  const eventFields = template?.setup?.form.triggers?.event;
  const supportsEvent = Boolean(eventFields);
  const isEvent = trigger.kind === "event";
  const eventOptions: EventOption[] = eventFields?.on?.options ?? [];
  const eventKey = isEvent ? trigger.key : "";
  const frequencyOptions: { value: StudioFrequency; label: string }[] = [
    { value: "manual", label: t("仅手动", "Manual") },
    { value: "once", label: t("单次", "Once") },
    { value: "hourly", label: t("每小时", "Hourly") },
    { value: "daily", label: t("每天", "Daily") },
    { value: "weekdays", label: t("工作日", "Weekdays") },
    { value: "weekly", label: t("每周", "Weekly") },
    { value: "custom", label: t("Cron", "Cron") },
  ];
  return <section className={styles.trigger} aria-label={t("何时运行", "When it runs")}>
    <h2>{t("何时运行", "When it runs")}</h2>
    <div className={styles.triggerModeGrid} role="radiogroup" aria-label={t("触发方式", "Trigger type")}>
      <button type="button" role="radio" aria-checked={!isEvent} disabled={disabled} className={styles.triggerModeCard} onClick={() => onMode("schedule")}>
        <CalendarDays size={18} aria-hidden="true" />
        <span><strong>{t("按时间", "On a schedule")}</strong><small>{t("按日程自动运行", "Run on a recurring schedule")}</small></span>
      </button>
      <button type="button" role="radio" aria-checked={isEvent} disabled={disabled || !supportsEvent} className={styles.triggerModeCard} onClick={() => onMode("event")} title={!supportsEvent ? t("此模板没有可订阅的内部事件", "This template declares no internal event") : undefined}>
        <Zap size={18} aria-hidden="true" />
        <span><strong>{t("按事件", "On an event")}</strong><small>{supportsEvent ? t("匹配事件到达时运行", "Run when a matching event arrives") : t("此模板没有内部事件", "No internal event for this template")}</small></span>
      </button>
    </div>
    {isEvent ? <div className={styles.triggerPanel}>
      <div className={styles.eventSource}><Zap size={14} aria-hidden="true" /><span>{t("PM 内部事件", "PM internal events")}</span><small>{t("由授权事件桥持久化投递，不依赖页面计时器或公共 Webhook", "Durably delivered by the authorized event bridge; no page timer or public webhook")}</small></div>
      <Field label={eventFields?.on?.label ?? t("事件", "Event")} help={eventFields?.on?.help} issue={issues["trigger.key"]}>{id =>
        eventOptions.length ? <RadixSelect id={id} value={eventKey} onChange={event => onEventKey(event.target.value)}>{eventOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</RadixSelect>
        : <Input id={id} value={eventKey} onChange={event => onEventKey(event.target.value)} />
      }</Field>
      <details className={styles.triggerDetails}><summary>{t("事件过滤器（可选）", "Event filter (optional)")}</summary>
        <Field label={t("过滤器 JSON object", "Filter JSON object")} help={t('支持路径/相等过滤或 {"expression":"JMESPath"}。留空表示匹配该事件键的全部事件。', 'Use path/equality filters or {"expression":"JMESPath"}. Empty matches every event with this key.')} issue={issues["trigger.filter"]}>{id =>
          <textarea id={id} rows={4} value={filterText} onChange={event => onFilterText(event.target.value)} />
        }</Field>
      </details>
    </div> : <div className={styles.triggerPanel}>
      <div className={styles.frequencyTabs} role="radiogroup" aria-label={t("运行频率", "Frequency")}>
        {frequencyOptions.map(option => <button key={option.value} type="button" role="radio" aria-checked={frequency === option.value} disabled={disabled} onClick={() => onFrequency(option.value)}>{option.label}</button>)}
      </div>
      {frequency === "manual" ? <p className={styles.triggerHint}>{t("不会自动运行；保存后可在详情页手动运行或试运行。", "Nothing runs automatically; after saving you can run it manually or test it from its details.")}</p> : null}
      {frequency !== "manual" ? <div className={styles.triggerRow}>
        {frequency === "once" ? <Field label={t("日期与时间", "Date and time")} issue={issues["trigger.at"]}>{id => <Input id={id} type="datetime-local" value={once} disabled={disabled} onChange={event => onOnce(event.target.value)} />}</Field> : null}
        {frequency !== "once" && frequency !== "custom" ? <Field label={frequency === "hourly" ? t("每小时的分钟", "Minute within each hour") : t("本地时间", "Local time")}>{id => <Input id={id} type="time" value={time} disabled={disabled} onChange={event => onTime(event.target.value)} />}</Field> : null}
        {frequency === "weekly" ? <Field label={t("星期", "Day of week")}>{id => <RadixSelect id={id} value={weekday} disabled={disabled} onChange={event => onWeekday(event.target.value)}>{[t("周日", "Sunday"), t("周一", "Monday"), t("周二", "Tuesday"), t("周三", "Wednesday"), t("周四", "Thursday"), t("周五", "Friday"), t("周六", "Saturday")].map((day, index) => <option value={index} key={day}>{day}</option>)}</RadixSelect>}</Field> : null}
        {frequency === "custom" ? <Field label="Cron (minute hour day month weekday)" issue={issues["trigger.expression"]}>{id => <Input id={id} value={trigger.kind === "cron" ? trigger.expression : ""} disabled={disabled} onChange={event => onCron(event.target.value)} />}</Field> : null}
        <Field label={t("时区", "Timezone")} issue={issues["trigger.timezone"]}>{id => <Input id={id} list="studio-trigger-timezones" value={timezone} disabled={disabled} onChange={event => onTimezone(event.target.value)} />}</Field>
        <datalist id="studio-trigger-timezones">{TIMEZONES.map(zone => <option key={zone} value={zone} />)}</datalist>
      </div> : null}
    </div>}
  </section>;
}
