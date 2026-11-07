import { agentText } from "../../i18n-text.ts";

export type BrowserViewport = "fit" | "desktop" | "tablet" | "mobile";
export type BrowserRecentEntry = { url: string; title?: string; faviconUrl?: string; visitedAt: number };
export type BrowserAddressResult = { url: string } | { search: string } | { error: string };

export const VIEWPORT_VALUES: ReadonlyArray<BrowserViewport> = ["fit", "desktop", "tablet", "mobile"];
export const BROWSER_RECENTS_KEY = "pm-v3:browser-recents";
const MAX_RECENTS = 12;

const WEB_SCHEME = /^https?:\/\//i;
const ANY_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
const HOST_PORT = /^[a-z\d.-]+:\d+(?:[/?#]|$)/i;
const DOMAIN_HOST = /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+(?::\d+)?(?:[/?#]|$)/i;

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

export function isBrowserViewport(value: string): value is BrowserViewport {
  return (VIEWPORT_VALUES as ReadonlyArray<string>).includes(value);
}

export function normalizeBrowserAddress(raw: string): BrowserAddressResult {
  const trimmed = raw.trim();
  if (!trimmed) return { error: agentText("请输入网址或搜索内容。", "Enter a URL or search term.") };

  const webScheme = WEB_SCHEME.test(trimmed);
  const anyScheme = ANY_SCHEME.test(trimmed);
  const hostLike = LOOPBACK_HOST.test(trimmed) || HOST_PORT.test(trimmed) || DOMAIN_HOST.test(trimmed);
  if (anyScheme && !webScheme && !hostLike) {
    return { error: agentText("只支持 http:// 或 https:// 网址。", "Only http:// and https:// URLs are supported.") };
  }
  if (!webScheme && !hostLike) {
    return { search: `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}` };
  }

  const candidate = webScheme
    ? trimmed
    : `${LOOPBACK_HOST.test(trimmed) ? "http" : "https"}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: agentText("网址格式无效。", "That URL is not valid.") };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: agentText("只支持 http:// 或 https:// 网址。", "Only http:// and https:// URLs are supported.") };
  }
  if (parsed.username || parsed.password) {
    return { error: agentText("网址不能包含凭据。", "Preview URLs cannot contain credentials.") };
  }
  return { url: parsed.toString() };
}

export function recentHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function recentPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch {
    return "";
  }
}

export function recentLabel(url: string): string {
  return `${recentHost(url)}${recentPath(url)}`;
}

export function relativeTime(timestamp: number): string {
  const elapsed = timestamp - Date.now();
  const magnitude = Math.abs(elapsed);
  const locale = typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "zh-CN";
  let format = relativeFormats.get(locale);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
    relativeFormats.set(locale, format);
  }
  if (magnitude < 60_000) return locale === "en" ? "just now" : "刚刚";
  if (magnitude < 3_600_000) return format.format(Math.round(elapsed / 60_000), "minute");
  if (magnitude < 86_400_000) return format.format(Math.round(elapsed / 3_600_000), "hour");
  if (magnitude < 30 * 86_400_000) return format.format(Math.round(elapsed / 86_400_000), "day");
  return new Date(timestamp).toLocaleDateString(locale);
}

export function readBrowserRecents(): BrowserRecentEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(BROWSER_RECENTS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap<BrowserRecentEntry>((value) => {
      if (!value || typeof value !== "object") return [];
      const { url, title, faviconUrl, visitedAt } = value as Record<string, unknown>;
      if (typeof url !== "string" || typeof visitedAt !== "number" || !Number.isFinite(visitedAt)) return [];
      try {
        const address = new URL(url);
        if (address.protocol !== "http:" && address.protocol !== "https:") return [];
      } catch {
        return [];
      }
      return [{
        url,
        visitedAt,
        ...(typeof title === "string" && title.trim() ? { title: title.trim().slice(0, 120) } : {}),
        ...(typeof faviconUrl === "string" && faviconUrl.trim() ? { faviconUrl: faviconUrl.trim().slice(0, 2048) } : {}),
      }];
    }).slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

export function writeBrowserRecents(entries: BrowserRecentEntry[]) {
  try {
    localStorage.setItem(BROWSER_RECENTS_KEY, JSON.stringify(entries));
  } catch { /* A blocked storage keeps the in-memory recents. */ }
}

export function addBrowserRecent(entries: BrowserRecentEntry[], url: string): BrowserRecentEntry[] {
  const existing = entries.find((entry) => entry.url === url);
  return [
    {
      url,
      visitedAt: Date.now(),
      ...(existing?.title ? { title: existing.title } : {}),
      ...(existing?.faviconUrl ? { faviconUrl: existing.faviconUrl } : {}),
    },
    ...entries.filter((entry) => entry.url !== url),
  ].slice(0, MAX_RECENTS);
}

export function updateBrowserRecentMetadata(
  entries: BrowserRecentEntry[],
  url: string,
  metadata: { title?: string; faviconUrl?: string },
): BrowserRecentEntry[] {
  return entries.map((entry) => entry.url === url
    ? {
      ...entry,
      ...(metadata.title?.trim() ? { title: metadata.title.trim().slice(0, 120) } : {}),
      ...(metadata.faviconUrl?.trim() ? { faviconUrl: metadata.faviconUrl.trim().slice(0, 2048) } : {}),
    }
    : entry);
}
