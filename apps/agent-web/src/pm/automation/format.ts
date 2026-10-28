const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const timeFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

export const automationDate = (iso: string) => dateFormatter.format(new Date(iso));
export const automationDateTime = (iso: string) => dateTimeFormatter.format(new Date(iso));
export const automationTime = (iso: string) => timeFormatter.format(new Date(iso));
