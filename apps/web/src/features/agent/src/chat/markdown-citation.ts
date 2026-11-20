/**
 * Inline citation links for Markdown (t3code A11, host-owned format).
 *
 * A citation is a same-document fragment link, so it passes the existing
 * Markdown URL policy (`#...` fragments are allowed verbatim) without widening
 * that policy. Only an explicitly encoded source message id becomes a
 * navigable anchor; anything else stays a plain quote excerpt. No id is ever
 * generated here.
 */

export const MARKDOWN_CITATION_PREFIX = "#assistant-citation/v1/";
export const MAX_CITATION_TEXT_LENGTH = 16_000;
const MAX_CITATION_ID_LENGTH = 256;
// Percent encoding can need up to nine characters per UTF-16 unit.
const MAX_CITATION_HREF_LENGTH = 9 * MAX_CITATION_TEXT_LENGTH + 9 * MAX_CITATION_ID_LENGTH * 2 + 64;

export interface MarkdownCitationAnchor {
  /** Source message id. Never synthesized from local state. */
  messageId: string;
  /** Source session id when the citation points outside the current thread. */
  threadId?: string;
  /** Saved excerpt shown in the source popover. */
  text: string;
}

// oxlint-disable-next-line no-control-regex -- ids with control characters are not valid anchors.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CITATION_ID_LENGTH && !CONTROL_CHARS.test(value);
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CITATION_TEXT_LENGTH && !value.includes("\u0000");
}

function citationBody(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value.startsWith(MARKDOWN_CITATION_PREFIX)) return undefined;
  if (value.length > MAX_CITATION_HREF_LENGTH) return undefined;
  return value.slice(MARKDOWN_CITATION_PREFIX.length);
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Builds the Markdown link target for a citation, or `undefined` when any part is invalid. */
export function serializeMarkdownCitation(anchor: MarkdownCitationAnchor): string | undefined {
  if (!validId(anchor.messageId) || !validText(anchor.text)) return undefined;
  if (anchor.threadId !== undefined && !validId(anchor.threadId)) return undefined;
  const segments = anchor.threadId === undefined ? [anchor.messageId] : [anchor.threadId, anchor.messageId];
  const query = new URLSearchParams({ text: anchor.text }).toString();
  const href = `${MARKDOWN_CITATION_PREFIX}${segments.map(encodeURIComponent).join("/")}?${query}`;
  return href.length <= MAX_CITATION_HREF_LENGTH ? href : undefined;
}

export function isMarkdownCitationHref(raw: string | undefined): boolean {
  return citationBody(raw) !== undefined;
}

/**
 * Parses a citation anchor. Returns `null` when the link has no usable source
 * message id; callers degrade to the plain quote card instead of inventing one.
 */
export function parseMarkdownCitationHref(raw: string | undefined): MarkdownCitationAnchor | null {
  const body = citationBody(raw);
  if (!body) return null;
  const queryStart = body.indexOf("?");
  if (queryStart <= 0) return null;
  const segments = body.slice(0, queryStart).split("/");
  if (segments.length < 1 || segments.length > 2 || segments.some(segment => !segment)) return null;
  const text = citationText(body.slice(queryStart + 1));
  if (!text) return null;
  const decoded = segments.map(decodeSegment);
  if (decoded.some(segment => segment === undefined)) return null;
  if (segments.length === 2) {
    const [threadId, messageId] = decoded as [string, string];
    if (!validId(threadId) || !validId(messageId)) return null;
    return { threadId, messageId, text };
  }
  const [messageId] = decoded as [string];
  if (!validId(messageId)) return null;
  return { messageId, text };
}

function citationText(query: string): string | undefined {
  const params = new URLSearchParams(query);
  const values = params.getAll("text");
  if (values.length !== 1 || params.size !== 1) return undefined;
  const text = values[0] ?? "";
  return validText(text) ? text : undefined;
}

/**
 * Excerpt for an anchorless citation link. Returns `undefined` when there is no
 * usable saved text, so malformed links keep their ordinary fragment behavior.
 */
export function markdownCitationExcerpt(raw: string | undefined): string | undefined {
  const body = citationBody(raw);
  if (!body) return undefined;
  const queryStart = body.indexOf("?");
  if (queryStart < 0) return undefined;
  return citationText(body.slice(queryStart + 1));
}

/** Collapses whitespace and truncates by code point, never inside a surrogate pair. */
export function markdownCitationLabel(anchor: Pick<MarkdownCitationAnchor, "text">, maxCharacters = 64): string {
  const normalized = anchor.text.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length > maxCharacters ? `${characters.slice(0, Math.max(0, maxCharacters - 1)).join("")}…` : normalized;
}

/** Validates a stored quote's claim about its source; invalid anchors stay anchorless. */
export function citationAnchorFromQuote(quote: { messageId?: unknown; text?: unknown } | undefined): MarkdownCitationAnchor | null {
  if (!quote || !validId(quote.messageId) || !validText(quote.text)) return null;
  return { messageId: quote.messageId, text: quote.text };
}
