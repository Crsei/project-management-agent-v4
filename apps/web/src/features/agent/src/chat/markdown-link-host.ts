/**
 * External-link presentation helpers for Markdown (t3code A10).
 *
 * Only the parts of a URL needed for local decoration are derived here: the
 * display host and a stable icon key. Nothing is fetched and the URL policy
 * itself still lives in `markdown-url.ts`; these helpers only describe a URL
 * that already passed that policy.
 */

export type MarkdownLinkHostIcon =
  | "code"
  | "package"
  | "book"
  | "video"
  | "discussion"
  | "document"
  | "external";

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * Returns the normalized display host for an absolute http(s) URL, or
 * `undefined` for anything else (fragments, relative paths, mailto, invalid
 * input). The result never includes credentials, a trailing dot or the
 * redundant `www.` prefix; a non-default port stays visible.
 */
export function markdownExternalHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const value = url.trim();
  // oxlint-disable-next-line no-control-regex -- ambiguous URLs are not decorated.
  if (!value || /[\u0000-\u0020\u007f\\]/u.test(value)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (!hostname) return undefined;
  const display = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  if (!display) return undefined;
  const port = parsed.port && parsed.port !== DEFAULT_PORTS[parsed.protocol] ? `:${parsed.port}` : "";
  return `${display}${port}`;
}

const HOST_ICONS: readonly (readonly [MarkdownLinkHostIcon, readonly string[]])[] = [
  ["code", ["github.com", "githubusercontent.com", "gitlab.com", "bitbucket.org", "codeberg.org", "gitea.com"]],
  ["package", ["npmjs.com", "npmjs.org", "pypi.org", "crates.io", "hub.docker.com", "nuget.org"]],
  ["book", ["developer.mozilla.org", "readthedocs.io", "docs.rs", "wikipedia.org", "wikimedia.org", "gitbook.io", "learn.microsoft.com", "docs.python.org"]],
  ["video", ["youtube.com", "youtu.be", "vimeo.com", "bilibili.com", "loom.com"]],
  ["discussion", ["stackoverflow.com", "stackexchange.com", "news.ycombinator.com", "reddit.com", "discord.com", "discourse.org"]],
  ["document", ["arxiv.org", "doi.org", "openreview.net", "scholar.google.com", "ssrn.com"]],
];

/** Known documentation/code/community domains get a specific glyph; the rest share ExternalLink. */
export function markdownLinkHostIcon(host: string | undefined): MarkdownLinkHostIcon {
  if (!host) return "external";
  const hostname = host.replace(/:\d+$/u, "").toLowerCase();
  for (const [icon, domains] of HOST_ICONS) {
    if (domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) return icon;
  }
  return "external";
}
