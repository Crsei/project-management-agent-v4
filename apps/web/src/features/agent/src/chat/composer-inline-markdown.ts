import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

export const COMPOSER_MARKS = ["bold", "italic", "strike", "code"] as const;
export type ComposerMark = (typeof COMPOSER_MARKS)[number];
export type InlineSegment = { text: string; marks: ComposerMark[] };

const parser = unified().use(remarkParse).use(remarkGfm);
const markName = (type: string): ComposerMark | undefined => type === "strong" ? "bold" : type === "emphasis" ? "italic" : type === "delete" ? "strike" : type === "inlineCode" ? "code" : undefined;

type MdNode = { type: string; value?: string; children?: MdNode[] };

function merge(out: InlineSegment[], text: string, marks: ComposerMark[]) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.marks.length === marks.length && last.marks.every((mark, index) => mark === marks[index])) last.text += text;
  else out.push({ text, marks: [...marks] });
}

function walk(nodes: readonly MdNode[], marks: ComposerMark[], out: InlineSegment[]) {
  for (const node of nodes) {
    if (node.type === "inlineCode") { merge(out, node.value ?? "", [...marks, "code"]); continue; }
    const mark = markName(node.type);
    if (mark) { walk(node.children ?? [], [...marks, mark], out); continue; }
    if (node.type === "text" || node.type === "html") { merge(out, node.value ?? "", marks); continue; }
    if (node.type === "break") { merge(out, "\n", marks); continue; }
    if (node.type === "link" || node.type === "image") { walk(node.children ?? [], marks, out); continue; }
    if (node.children) { walk(node.children, marks, out); continue; }
    if (node.value) merge(out, node.value, marks);
  }
}

/** Only a single plain paragraph is interpreted; headings/lists/HTML stay literal for now. */
export function parseInlineMarkdown(source: string): InlineSegment[] {
  if (!source) return [];
  // Markdown parsers trim boundary whitespace; keep such lines literal so
  // restored drafts preserve their exact spacing.
  if (source !== source.trim()) return [{ text: source, marks: [] }];
  // Composer file links are Markdown links; keep the line literal so the
  // reference tokenizer sees the exact wire text instead of a parsed link.
  if (/\[[^\]]*\]\([^)]*\)/u.test(source)) return [{ text: source, marks: [] }];
  let tree: { children?: MdNode[] };
  try { tree = parser.parse(source) as { children?: MdNode[] }; } catch { return [{ text: source, marks: [] }]; }
  const first = tree.children?.[0];
  if (!first || first.type !== "paragraph") return [{ text: source, marks: [] }];
  const out: InlineSegment[] = [];
  walk(first.children ?? [], [], out);
  return out.length ? out : [{ text: source, marks: [] }];
}

function escapeText(text: string): string {
  return text.replace(/[\\`*_~]/gu, "\\$&");
}

/** Deterministic marker order: code, strike, italic, bold (outermost). */
export function serializeInlineText(text: string, marks: readonly ComposerMark[]): string {
  if (!text) return "";
  // Unmarked text stays byte-for-byte; escaping is only needed to protect
  // marked spans from re-parsing.
  if (!marks.length) return text;
  if (marks.includes("code")) {
    // A backtick inside a code span cannot be escaped in Markdown; keep the
    // literal text rather than emitting a span that re-parses differently.
    if (text.includes("`")) return escapeText(text);
    return `\`${text}\``;
  }
  let value = escapeText(text);
  if (marks.includes("strike")) value = `~~${value}~~`;
  if (marks.includes("italic")) value = `*${value}*`;
  if (marks.includes("bold")) value = `**${value}**`;
  return value;
}

/** Source length for a prefix of a text node, excluding closing markers until the full text. */
export function serializedPrefixLength(text: string, count: number, marks: readonly ComposerMark[]): number {
  if (count <= 0) return 0;
  if (!marks.length) return count;
  if (marks.includes("code")) {
    if (text.includes("`")) return escapeText(text.slice(0, count)).length;
    return text.slice(0, count).length + (count === text.length ? 2 : 1);
  }
  const prefix = escapeText(text.slice(0, count)).length;
  const open = (marks.includes("strike") ? 2 : 0) + (marks.includes("italic") ? 1 : 0) + (marks.includes("bold") ? 2 : 0);
  const close = count === text.length ? open : 0;
  return open + prefix + close;
}

/** Find the plain-text index whose serialized prefix reaches the source offset. */
export function sourceOffsetToTextIndex(text: string, offset: number, marks: readonly ComposerMark[]): number {
  if (offset <= 0) return 0;
  if (!marks.length) return Math.min(text.length, offset);
  const opening = serializedMarkerOnly(marks);
  if (offset <= opening) return 0;
  let serialized = opening;
  for (let index = 0; index < text.length; index++) {
    const next = serialized + escapedLength(text[index]!);
    if (offset < next) return index;
    serialized = next;
  }
  return text.length;
}

function serializedMarkerOnly(marks: readonly ComposerMark[]): number {
  if (marks.includes("code")) return 1;
  return (marks.includes("strike") ? 2 : 0) + (marks.includes("italic") ? 1 : 0) + (marks.includes("bold") ? 2 : 0);
}

function escapedLength(value: string): number {
  return escapeText(value).length;
}
