import { collectComposerInlineTokens } from "@agent-workspace/client-runtime";
import type { Editor, JSONContent } from "@tiptap/react";
import type { QuoteInfo } from "@assistant-ui/react";
import type { MessageContextDraftItem } from "./message-context-store";
import type { PmReference } from "../pm/pm-types";
import type { ComposerContextAttachment } from "./composer-context-attachments";
import { COMPOSER_MARKS, parseInlineMarkdown, serializeInlineText, serializedPrefixLength, sourceOffsetToTextIndex, type ComposerMark } from "./composer-inline-markdown.ts";

export type ComposerContextPayload = { type: "native"; item: MessageContextDraftItem } | { type: "pm"; reference: PmReference } | { type: "attachment"; attachment: ComposerContextAttachment };

type DocumentNode = Editor["state"]["doc"];

export function referenceLabel(kind: string, value: string): string {
  if (kind === "skill") return `$${value}`;
  const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return separator < 0 ? value : value.slice(separator + 1);
}

function inlineContent(text: string): JSONContent[] {
  const content: JSONContent[] = [];
  for (const piece of splitInlineLinks(text)) {
    if ("link" in piece) {
      content.push({ type: "text", text: piece.label, marks: [{ type: LINK_MARK, attrs: { href: piece.href, ...(piece.title ? { title: piece.title } : {}) } }] });
      continue;
    }
    for (const segment of parseInlineMarkdown(piece.text)) {
      const marks = segment.marks.length ? segment.marks.map(type => ({ type })) : undefined;
      let offset = 0;
      for (const token of collectComposerInlineTokens(`${segment.text} `)) {
        if (token.start < offset || token.end > segment.text.length) continue;
        if (token.start > offset) content.push({ type: "text", text: segment.text.slice(offset, token.start), ...(marks ? { marks } : {}) });
        content.push({ type: "composerReference", attrs: {
          kind: token.type === "skill" ? "skill" : "file", value: token.value, source: token.source,
        }, ...(marks ? { marks } : {}) });
        offset = token.end;
      }
      if (offset < segment.text.length) content.push({ type: "text", text: segment.text.slice(offset), ...(marks ? { marks } : {}) });
    }
  }
  return content;
}

const LINK_MARK = "link";

/** A text node's link, or undefined. Only text nodes carry it; atoms keep their own source. */
export type ComposerLinkAttributes = { href: string; title?: string };

const markNames = (node: DocumentNode): ComposerMark[] => node.isText
  ? node.marks.map(mark => mark.type.name).filter((name): name is ComposerMark => (COMPOSER_MARKS as readonly string[]).includes(name))
  : [];

function linkOf(node: DocumentNode): ComposerLinkAttributes | undefined {
  if (!node.isText) return undefined;
  const mark = node.marks.find(candidate => candidate.type.name === LINK_MARK);
  const href = mark?.attrs.href;
  if (typeof href !== "string" || !href) return undefined;
  const title = mark.attrs.title;
  return { href, ...(typeof title === "string" && title ? { title } : {}) };
}

/**
 * Only absolute `http(s)`/`mailto` destinations become link marks. Relative
 * destinations stay literal text because composer file links (`[name](path)`)
 * are tokenized into reference atoms and must keep their exact source.
 */
const INLINE_LINK = /\[((?:\\.|[^\]\\])*)\]\(((?:https?:\/\/|mailto:)[^\s)]*)(?:[ \t]+"((?:\\.|[^"\\])*)")?\)/giu;

type InlinePiece = { text: string } | { link: true; label: string; href: string; title?: string };

function splitInlineLinks(source: string): InlinePiece[] {
  const pieces: InlinePiece[] = [];
  let cursor = 0;
  for (const match of source.matchAll(INLINE_LINK)) {
    const start = match.index ?? 0;
    if (start > cursor) pieces.push({ text: source.slice(cursor, start) });
    pieces.push({
      link: true,
      label: (match[1] ?? "").replace(/\\([\\`*_~[\]])/gu, "$1"),
      href: match[2] ?? "",
      ...(match[3] ? { title: match[3].replace(/\\(.)/gu, "$1") } : {}),
    });
    cursor = start + match[0].length;
  }
  if (cursor < source.length) pieces.push({ text: source.slice(cursor) });
  return pieces;
}

/** `](destination "title")`: everything a linked text node appends after its label. */
function linkTail(link: ComposerLinkAttributes): string {
  const destination = link.href.replace(/[()<>"]/gu, char => encodeURIComponent(char));
  return `](${destination}${link.title ? ` "${link.title.replace(/[\\"]/gu, "\\$&")}"` : ""})`;
}

function serializeLinkedText(text: string, marks: readonly ComposerMark[], link: ComposerLinkAttributes): string {
  return `[${serializeInlineText(text, marks).replace(/[[\]]/gu, "\\$&")}${linkTail(link)}`;
}

/** Extra source length the label's bracket escaping adds to a serialized prefix. */
function linkLabelEscapeLength(text: string, count: number, marks: readonly ComposerMark[]): number {
  if (count <= 0) return 0;
  return (serializeInlineText(text.slice(0, count), marks).match(/[[\]]/gu) ?? []).length;
}

/**
 * Source length of a text node prefix. A linked node only counts its
 * `](destination)` tail once the caret has moved past the label.
 */
const textSourceLength = (text: string, marks: readonly ComposerMark[], count = text.length, link?: ComposerLinkAttributes, closed = true): number => {
  const inner = serializedPrefixLength(text, count, marks);
  if (!link) return inner;
  return 1 + inner + linkLabelEscapeLength(text, count, marks) + (closed && count === text.length ? linkTail(link).length : 0);
};

const textSourceIndex = (text: string, offset: number, marks: readonly ComposerMark[], link?: ComposerLinkAttributes): number => {
  if (!link) return sourceOffsetToTextIndex(text, offset, marks);
  if (offset <= 1) return 0;
  for (let index = 0; index < text.length; index++) {
    const next = 1 + serializedPrefixLength(text, index + 1, marks) + linkLabelEscapeLength(text, index + 1, marks);
    if (offset < next) return index;
  }
  return text.length;
};

const TASK_PREFIX = /^\[([ xX])\](?:([ \t]+)([\s\S]*))?$/u;

type ListKind = "bullet" | "ordered" | "task";
type TaskPrefix = { checked: boolean; space: string; text: string };

function taskPrefix(content: string): TaskPrefix | undefined {
  const match = TASK_PREFIX.exec(content);
  if (!match) return undefined;
  return { checked: match[1]!.toLowerCase() === "x", space: match[2] ?? "", text: match[3] ?? "" };
}

function listKind(marker: string, content: string): ListKind {
  if (/^\d/u.test(marker)) return "ordered";
  return taskPrefix(content) ? "task" : "bullet";
}

function parseListBlock(lines: readonly string[], start: number, baseIndent: number): { node: JSONContent; next: number } | undefined {
  const pattern = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u;
  const first = pattern.exec(lines[start] ?? "");
  if (!first || first[1]!.length !== baseIndent) return undefined;
  const kind = listKind(first[2]!, first[3]!);
  const ordered = kind === "ordered";
  const startNumber = ordered ? Number.parseInt(first[2]!, 10) : undefined;
  const items: JSONContent[] = [];
  let index = start;
  while (index < lines.length) {
    const item = pattern.exec(lines[index]!);
    if (!item || item[1]!.length !== baseIndent || listKind(item[2]!, item[3]!) !== kind) break;
    const task = kind === "task" ? taskPrefix(item[3]!) : undefined;
    const content: JSONContent[] = [{ type: "paragraph", content: inlineContent(task ? task.text : item[3]!) }];
    index++;
    const nested = pattern.exec(lines[index] ?? "");
    if (nested && nested[1]!.length > baseIndent) {
      const child = parseListBlock(lines, index, nested[1]!.length);
      if (child) { content.push(child.node); index = child.next; }
    }
    items.push(task
      ? { type: "taskItem", attrs: { checked: task.checked, space: task.space }, content }
      : { type: "listItem", content });
  }
  const type = kind === "ordered" ? "orderedList" : kind === "task" ? "taskList" : "bulletList";
  return { node: { type, ...(ordered ? { attrs: { start: startNumber } } : {}), content: items }, next: index };
}

/** Source text, not editor HTML, remains the assistant-ui draft and wire format. */
export function parseComposerDocument(source: string, citation?: QuoteInfo, contexts: readonly ComposerContextPayload[] = []): JSONContent {
  const lines = source.split("\n");
  const content: JSONContent[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const opening = /^(`{3,}|~{3,})([^\s`~]*)[\t \r]*$/.exec(line);
    let close = -1;
    if (opening) {
      const marker = opening[1]!;
      for (let next = index + 1; next < lines.length; next++) {
        const candidate = lines[next]!.trimEnd();
        if (candidate.length >= marker.length && [...candidate].every((char) => char === marker[0])) {
          close = next;
          break;
        }
      }
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(line)) {
      content.push({ type: "horizontalRule" });
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (headingMatch) {
      content.push({ type: "heading", attrs: { level: headingMatch[1]!.length }, content: inlineContent(headingMatch[2]!) });
      continue;
    }
    const quoteMatch = /^>\s?(.*)$/u.exec(line);
    if (quoteMatch) {
      const paragraphs: JSONContent[] = [];
      let quoteIndex = index;
      while (quoteIndex < lines.length) {
        const quoted = /^>\s?(.*)$/u.exec(lines[quoteIndex]!);
        if (!quoted) break;
        paragraphs.push({ type: "paragraph", content: inlineContent(quoted[1]!) });
        quoteIndex++;
      }
      content.push({ type: "blockquote", content: paragraphs });
      index = quoteIndex - 1;
      continue;
    }
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(line);
    if (listMatch && listMatch[1]!.length === 0) {
      const parsed = parseListBlock(lines, index, 0);
      if (parsed) {
        content.push(parsed.node);
        index = parsed.next - 1;
        continue;
      }
    }
    if (opening && close >= 0) {
      const body = lines.slice(index + 1, close).join("\n");
      content.push({ type: "codeBlock", attrs: {
        language: opening[2] || "", fence: opening[1], originalOpening: line,
        originalLanguage: opening[2] || "", closing: lines[close], hasBodyLine: close > index + 1,
      }, ...(body ? { content: [{ type: "text", text: body }] } : {}) });
      index = close;
    } else {
      content.push({ type: "paragraph", content: inlineContent(line) });
    }
  }
  if (citation) {
    const first = content[0];
    const chip = { type: "composerCitation", attrs: { quote: citation } };
    if (first?.type === "paragraph") first.content = [chip, ...(first.content ?? [])];
    else content.unshift({ type: "paragraph", attrs: { citationOnly: true }, content: [chip] });
  }
  if (contexts.length) {
    const chips = contexts.map(payload => ({ type: "composerContext", attrs: { payload } }));
    const first = content[0];
    if (first?.type === "paragraph") first.content = [...chips, ...(first.content ?? [])];
    else content.unshift({ type: "paragraph", attrs: { citationOnly: true }, content: chips });
  }
  return { type: "doc", content };
}

/** Full transport metadata lives in the undoable node, not a display-only label. */
export function readComposerCitation(doc: DocumentNode): QuoteInfo | undefined {
  let quote: QuoteInfo | undefined;
  doc.descendants((node) => {
    if (node.type.name !== "composerCitation") return;
    const candidate: unknown = node.attrs.quote;
    if (candidate && typeof candidate === "object" && "text" in candidate && typeof candidate.text === "string" &&
      "messageId" in candidate && typeof candidate.messageId === "string") quote = candidate as QuoteInfo;
  });
  return quote;
}

/** Nodes carry their whole accepted preview/input or PM revision, including through undo. */
export function readComposerContexts(doc: DocumentNode): ComposerContextPayload[] {
  const contexts: ComposerContextPayload[] = [];
  doc.descendants(node => {
    if (node.type.name === "composerContext" && node.attrs.payload) contexts.push(node.attrs.payload as ComposerContextPayload);
  });
  return contexts;
}

/** Open paragraph boundaries merge pasted lines with the surrounding draft text. */
export function composerPasteSlice(schema: Editor["schema"], source: string, language?: string) {
  const content = language && source.includes("\n")
    ? { type: "doc", content: [{ type: "codeBlock", attrs: { language }, content: [{ type: "text", text: source }] }] }
    : parseComposerDocument(source);
  const doc = schema.nodeFromJSON(content);
  const from = doc.firstChild?.type.name === "paragraph" ? 1 : 0;
  const to = doc.content.size - (doc.lastChild?.type.name === "paragraph" ? 1 : 0);
  return doc.slice(from, to);
}

export function codeBlockOpening(node: DocumentNode): string {
  const language = String(node.attrs.language ?? "");
  const originalFence = String(node.attrs.fence || "```");
  let length = originalFence.length;
  for (const line of node.textContent.split("\n")) {
    const candidate = line.trimEnd();
    if (candidate.length >= length && [...candidate].every((char) => char === originalFence[0])) length = candidate.length + 1;
  }
  if (length !== originalFence.length) return `${originalFence[0]!.repeat(length)}${language}`;
  return node.attrs.originalOpening && node.attrs.originalLanguage === language
    ? String(node.attrs.originalOpening)
    : `${originalFence}${language}`;
}

export function composerInlineSource(node: DocumentNode): string {
  if (node.isText) {
    const link = linkOf(node);
    return link ? serializeLinkedText(node.text ?? "", markNames(node), link) : serializeInlineText(node.text ?? "", markNames(node));
  }
  if (node.type.name === "composerReference") return String(node.attrs.source ?? "");
  if (node.type.name === "composerCitation" || node.type.name === "composerContext") return "";
  if (node.type.name === "hardBreak") return "\n";
  let text = "";
  node.forEach((child) => { text += composerInlineSource(child); });
  return text;
}

const listStart = (node: DocumentNode): number =>
  node.type.name === "orderedList" && Number.isFinite(Number(node.attrs.start)) ? Number(node.attrs.start) : 1;

/** One list line: marker, optional task checkbox, and its first paragraph's text. */
function listItemLine(item: DocumentNode, ordered: boolean, start: number, index: number): { text: string; prefixLength: number; body: string } {
  const paragraph = item.firstChild?.type.name === "paragraph" ? item.firstChild : null;
  const text = paragraph ? composerInlineSource(paragraph) : "";
  if (item.type.name === "taskItem") {
    const prefix = `- [${item.attrs.checked === true ? "x" : " "}]`;
    const space = typeof item.attrs.space === "string" ? item.attrs.space : "";
    const body = text ? `${prefix} ${text}` : `${prefix}${space}`;
    return { text, prefixLength: body.length - text.length, body };
  }
  const prefix = ordered ? `${start + index}. ` : "- ";
  return { text, prefixLength: prefix.length, body: prefix + text };
}

function listSource(node: DocumentNode, depth = 0): string {
  const ordered = node.type.name === "orderedList";
  const start = listStart(node);
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  node.forEach((item, _position, index) => {
    lines.push(`${indent}${listItemLine(item, ordered, start, index).body}`);
    item.forEach(child => {
      if (child.type.name === "bulletList" || child.type.name === "orderedList" || child.type.name === "taskList") lines.push(listSource(child, depth + 1));
    });
  });
  return lines.join("\n");
}

function listSourceOffsetAt(node: DocumentNode, position: number, sourceBase: number, depth: number): number {
  const ordered = node.type.name === "orderedList";
  const start = listStart(node);
  const indent = 2 * depth;
  let sourceCursor = sourceBase;
  let answer: number | undefined;
  node.forEach((item, itemPosition, index) => {
    if (answer !== undefined) return;
    const paragraph = item.firstChild?.type.name === "paragraph" ? item.firstChild : null;
    const line = listItemLine(item, ordered, start, index);
    const lineLength = indent + line.body.length;
    const paragraphStart = itemPosition + 2;
    const paragraphEnd = paragraphStart + (paragraph?.content.size ?? 0);
    const nested = item.childCount > 1 ? item.child(1) : null;
    const nestedStart = itemPosition + 3 + (paragraph?.content.size ?? 0);
    if (position <= paragraphEnd) {
      const local = Math.max(0, position - paragraphStart);
      answer = sourceCursor + indent + line.prefixLength + (paragraph ? inlineSourceOffset(paragraph, Math.min(local, paragraph.content.size)) : 0);
    } else if (nested && position <= nestedStart + 1 + nested.content.size) {
      answer = listSourceOffsetAt(nested, Math.max(0, position - nestedStart - 1), sourceCursor + lineLength + 1, depth + 1);
    }
    sourceCursor += lineLength + (nested ? 1 + listSource(nested, depth + 1).length : 0);
  });
  return answer ?? sourceCursor;
}

function listPositionAtSource(node: DocumentNode, sourceOffset: number, listPosition: number, depth: number): number {
  const ordered = node.type.name === "orderedList";
  const start = listStart(node);
  const indent = 2 * depth;
  let sourceCursor = 0;
  let answer: number | undefined;
  node.forEach((item, itemPosition, index) => {
    if (answer !== undefined) return;
    const paragraph = item.firstChild?.type.name === "paragraph" ? item.firstChild : null;
    const line = listItemLine(item, ordered, start, index);
    const lineLength = indent + line.body.length;
    const nested = item.childCount > 1 ? item.child(1) : null;
    const nestedLength = nested ? 1 + listSource(nested, depth + 1).length : 0;
    const total = lineLength + nestedLength;
    const local = sourceOffset - sourceCursor;
    if (local <= lineLength) {
      const relative = Math.max(0, local - indent - line.prefixLength);
      const paragraphIndex = paragraph ? inlinePositionAtSource(paragraph, Math.min(relative, paragraph.content.size)) : 0;
      answer = listPosition + 3 + itemPosition + paragraphIndex;
    } else if (nested && local <= total) {
      const nestedPosition = listPosition + 1 + itemPosition + 3 + (paragraph?.content.size ?? 0);
      answer = listPositionAtSource(nested, local - lineLength - 1, nestedPosition, depth + 1);
    }
    sourceCursor += total;
  });
  return answer ?? listPosition + 1 + node.content.size;
}

function blockSource(node: DocumentNode): string {
  if (node.type.name === "horizontalRule") return "---";
  if (node.type.name === "heading") {
    const level = Math.min(6, Math.max(1, Number(node.attrs.level) || 1));
    return `${"#".repeat(level)} ${composerInlineSource(node)}`;
  }
  if (node.type.name === "blockquote") {
    const lines: string[] = [];
    node.forEach(child => { lines.push(`> ${composerInlineSource(child)}`); });
    return lines.join("\n");
  }
  if (node.type.name === "bulletList" || node.type.name === "orderedList" || node.type.name === "taskList") return listSource(node);
  if (node.type.name !== "codeBlock") return composerInlineSource(node);
  const body = node.textContent;
  const opening = codeBlockOpening(node);
  const fence = /^(`{3,}|~{3,})/.exec(opening)?.[1] || "```";
  const closing = fence !== String(node.attrs.fence || "```") ? fence : node.attrs.closing || fence;
  return `${opening}\n${body}${body || node.attrs.hasBodyLine !== false ? "\n" : ""}${closing}`;
}

function citationOnly(node: DocumentNode): boolean {
  if (node.attrs.citationOnly !== true) return false;
  let onlyContexts = true;
  node.forEach(child => { if (child.type.name !== "composerCitation" && child.type.name !== "composerContext") onlyContexts = false; });
  return onlyContexts;
}

function inlineSourceOffset(paragraph: DocumentNode, local: number): number {
  let offset = 0;
  paragraph.forEach((child, childPosition) => {
    if (childPosition > local) return;
    if (childPosition === local) {
      // A linked label's first character sits after its opening bracket.
      if (child.isText && linkOf(child)) offset += 1;
      return;
    }
    if (child.isText) {
      const text = child.text ?? "";
      const inside = Math.min(text.length, local - childPosition);
      offset += textSourceLength(text, markNames(child), inside, linkOf(child), local - childPosition > text.length);
    } else offset += composerInlineSource(child).length;
  });
  return offset;
}

function inlinePositionAtSource(paragraph: DocumentNode, local: number): number {
  let offset = 0;
  let answer: number | undefined;
  paragraph.forEach((child, childPosition) => {
    if (answer !== undefined) return;
    if (child.isText) {
      const text = child.text ?? "";
      const marks = markNames(child);
      const link = linkOf(child);
      const value = textSourceLength(text, marks, text.length, link);
      if (local <= offset + value) {
        answer = childPosition + textSourceIndex(text, local - offset, marks, link);
      }
      offset += value;
    } else {
      const value = composerInlineSource(child);
      if (local <= offset + value.length) answer = childPosition + (local > offset ? child.nodeSize : 0);
      offset += value.length;
    }
  });
  return answer ?? paragraph.content.size;
}

export function serializeComposerDocument(doc: DocumentNode): string {
  const blocks: string[] = [];
  doc.forEach((node) => { if (!citationOnly(node)) blocks.push(blockSource(node)); });
  return blocks.join("\n");
}

/** Map ProseMirror positions to source offsets, including atom source lengths and fences. */
export function composerSourceCursor(doc: DocumentNode, position: number): number {
  let sourceOffset = 0;
  let answer: number | undefined;
  let first = true;
  doc.forEach((block, blockPosition) => {
    if (citationOnly(block)) return;
    if (!first) sourceOffset++;
    first = false;
    const source = blockSource(block);
    if (answer === undefined && position <= blockPosition + block.nodeSize) {
      const local = Math.max(0, position - blockPosition - 1);
      if (block.type.name === "codeBlock") {
        answer = sourceOffset + codeBlockOpening(block).length + 1 + Math.min(local, block.content.size);
      } else if (block.type.name === "horizontalRule") {
        answer = sourceOffset + (local > 0 ? 3 : 0);
      } else if (block.type.name === "heading") {
        const prefix = Math.min(6, Math.max(1, Number(block.attrs.level) || 1)) + 1;
        answer = sourceOffset + prefix + inlineSourceOffset(block, Math.min(block.content.size, local));
      } else if (block.type.name === "blockquote") {
        let offset = 0;
        let done = false;
        block.forEach((child, childPosition) => {
          if (done) return;
          const paragraphLocal = Math.max(0, local - childPosition - 1);
          if (local <= childPosition + child.nodeSize) {
            answer = sourceOffset + offset + 2 + (child.type.name === "paragraph" ? inlineSourceOffset(child, paragraphLocal) : 0);
            done = true;
          }
          offset += 2 + composerInlineSource(child).length + 1;
        });
        if (!done) answer = sourceOffset + Math.max(0, offset - 1);
      } else if (block.type.name === "bulletList" || block.type.name === "orderedList" || block.type.name === "taskList") {
        answer = sourceOffset + listSourceOffsetAt(block, local, 0, 0);
      } else {
        let offset = 0;
        block.forEach((child, childPosition) => {
          if (childPosition > local) return;
          if (childPosition === local) {
            if (child.isText && linkOf(child)) offset += 1;
            return;
          }
          if (child.isText) {
            const text = child.text ?? "";
            const count = Math.min(text.length, local - childPosition);
            offset += textSourceLength(text, markNames(child), count, linkOf(child), local - childPosition > text.length);
          } else {
            offset += composerInlineSource(child).length;
          }
        });
        answer = sourceOffset + offset;
      }
    }
    sourceOffset += source.length;
  });
  return answer ?? sourceOffset;
}

export function composerDocumentCursor(doc: DocumentNode, sourcePosition: number): number {
  let sourceOffset = 0;
  let answer: number | undefined;
  let first = true;
  doc.forEach((block, blockPosition) => {
    if (citationOnly(block)) return;
    if (!first) sourceOffset++;
    first = false;
    const source = blockSource(block);
    if (answer === undefined && sourcePosition <= sourceOffset + source.length) {
      const local = Math.max(0, sourcePosition - sourceOffset);
      if (block.type.name === "codeBlock") {
        answer = blockPosition + 1 + Math.min(block.content.size, Math.max(0, local - codeBlockOpening(block).length - 1));
      } else if (block.type.name === "horizontalRule") {
        answer = blockPosition + 1;
      } else if (block.type.name === "heading") {
        const prefix = Math.min(6, Math.max(1, Number(block.attrs.level) || 1)) + 1;
        answer = blockPosition + 1 + (local > prefix ? inlinePositionAtSource(block, local - prefix) : 0);
      } else if (block.type.name === "blockquote") {
        let offset = 0;
        let found = false;
        block.forEach((child, childPosition) => {
          if (found) return;
          const total = 2 + composerInlineSource(child).length;
          if (local <= offset + total) {
            const relative = local - offset - 2;
            answer = blockPosition + 2 + childPosition + (child.type.name === "paragraph" ? inlinePositionAtSource(child, Math.max(0, relative)) : 0);
            found = true;
          }
          offset += total + 1;
        });
        if (!found) answer = blockPosition + block.nodeSize;
      } else if (block.type.name === "bulletList" || block.type.name === "orderedList" || block.type.name === "taskList") {
        answer = listPositionAtSource(block, local, blockPosition, 0);
      } else {
        let offset = 0;
        let found = false;
        block.forEach((child, childPosition) => {
          if (found) return;
          if (child.isText) {
            const text = child.text ?? "";
            const marks = markNames(child);
            const link = linkOf(child);
            const value = textSourceLength(text, marks, text.length, link);
            if (local <= offset + value) {
              answer = blockPosition + 1 + childPosition + textSourceIndex(text, local - offset, marks, link);
              found = true;
            }
            offset += value;
          } else {
            const value = composerInlineSource(child);
            if (local <= offset + value.length) {
              answer = blockPosition + 1 + childPosition + (local > offset ? child.nodeSize : 0);
              found = true;
            }
            offset += value.length;
          }
        });
        if (!found) answer = blockPosition + 1 + block.content.size;
      }
    }
    sourceOffset += source.length;
  });
  return answer ?? Math.max(1, doc.content.size - 1);
}

/** Tokenize only newly typed text. Atomic replacements preserve native editor undo and IME. */
export function normalizeComposerReferences(editor: Editor): void {
  const replacements: Array<{ from: number; to: number; attrs: Record<string, string> }> = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "codeBlock") return false;
    if (!node.isText || node.marks.some(mark => mark.type.name === LINK_MARK)) return;
    const text = node.text ?? "";
    for (const token of collectComposerInlineTokens(text)) {
      replacements.push({ from: position + token.start, to: position + token.end, attrs: {
        kind: token.type === "skill" ? "skill" : "file", value: token.value, source: token.source,
      } });
    }
  });
  if (!replacements.length) return;
  editor.commands.command(({ tr, state, dispatch }) => {
    for (const replacement of replacements.reverse()) {
      tr.replaceWith(replacement.from, replacement.to, state.schema.nodes.composerReference!.create(replacement.attrs));
    }
    if (dispatch) dispatch(tr.setMeta("addToHistory", false));
    return true;
  });
}
