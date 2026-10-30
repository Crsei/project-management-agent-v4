import { agentText } from "../../i18n-text.ts";

const formatters = new Map<string, { date: Intl.DateTimeFormat; dateTime: Intl.DateTimeFormat; time: Intl.DateTimeFormat }>();

function formatterFor(locale: string) {
  const cached = formatters.get(locale);
  if (cached) return cached;
  const created = {
    date: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
    dateTime: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
    time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }),
  };
  formatters.set(locale, created);
  return created;
}

const locale = () => agentText("zh-CN", "en-US");

export const automationDate = (iso: string) => formatterFor(locale()).date.format(new Date(iso));
export const automationDateTime = (iso: string) => formatterFor(locale()).dateTime.format(new Date(iso));
export const automationTime = (iso: string) => formatterFor(locale()).time.format(new Date(iso));
