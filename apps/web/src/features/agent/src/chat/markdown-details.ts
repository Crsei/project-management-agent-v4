export type MarkdownSegment = { kind: "markdown"; content: string } | { kind: "details"; summary: string; body: string };

const DETAILS = /<details\b[^>]*>([\s\S]*?)<\/details\s*>/gi;
const SUMMARY = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

/** Only the two structural tags are interpreted; attributes and all other HTML are ignored. */
export function splitDetailsBlocks(source: string): MarkdownSegment[] {
  if (!/<details\b/i.test(source)) return [{ kind: "markdown", content: source }];
  const segments: MarkdownSegment[] = [];
  let last = 0;
  for (const match of source.matchAll(DETAILS)) {
    const start = match.index ?? 0;
    const inner = match[1] ?? "";
    const summaryMatch = SUMMARY.exec(inner);
    if (!summaryMatch) continue;
    if (start > last) segments.push({ kind: "markdown", content: source.slice(last, start) });
    const summary = stripTags(summaryMatch[1] ?? "").replace(/\s+/gu, " ").trim();
    const body = `${inner.slice(0, summaryMatch.index)}${inner.slice((summaryMatch.index ?? 0) + summaryMatch[0].length)}`;
    segments.push({ kind: "details", summary, body });
    last = start + match[0].length;
  }
  if (!segments.length) return [{ kind: "markdown", content: source }];
  if (last < source.length) segments.push({ kind: "markdown", content: source.slice(last) });
  return segments;
}

/** Summary text is never re-parsed as HTML; tags are removed and React escapes the rest. */
export function stripTags(value: string): string {
  return value.replace(/<[^>]*>/gu, "");
}
