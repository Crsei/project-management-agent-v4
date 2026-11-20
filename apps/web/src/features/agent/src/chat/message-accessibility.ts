/**
 * Accessible per-message author title (t3code A12).
 *
 * The visible timestamp and long-message fold stay unchanged; this module only
 * composes the screen-reader label from the same message time so both surfaces
 * agree and never invent a timestamp when none was reported.
 */

export type MessageAuthorRole = "user" | "assistant";

export function messageAuthorName(role: MessageAuthorRole, locale: "zh-CN" | "en"): string {
  if (role === "user") return locale === "en" ? "User message" : "用户消息";
  return locale === "en" ? "Assistant message" : "助手消息";
}

export function formatMessageAuthorLabel(role: MessageAuthorRole, at: string | undefined, locale: "zh-CN" | "en"): string {
  const name = messageAuthorName(role, locale);
  if (!at) return name;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return name;
  const formatted = new Intl.DateTimeFormat(locale === "en" ? "en" : "zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
  return locale === "en" ? `${name}, ${formatted}` : `${name}，${formatted}`;
}
