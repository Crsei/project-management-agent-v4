import { agentText } from "../../i18n-text.ts";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(locale: string) {
  const cached = formatters.get(locale);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  formatters.set(locale, created);
  return created;
}

const locale = () => agentText("zh-CN", "en-US");

export const automationDateTime = (iso: string) => formatterFor(locale()).format(new Date(iso));
