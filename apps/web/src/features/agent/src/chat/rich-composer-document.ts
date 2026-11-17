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
  for (const segment of parseInlineMarkdown(text)) {
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
  return content;
}

const markNames = (node: DocumentNode): ComposerMark[] => node.isText
  ? node.marks.map(mark => mark.type.name).filter((name): name is ComposerMark => (COMPOSER_MARKS as readonly string[]).includes(name))
  : [];
const textSourceLength = (text: string, marks: readonly ComposerMark[], count = text.length): number =>
  serializedPrefixLength(text, count, marks);

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
    const listMatch = /^([-*+]|\d+[.)])\s+(.*)$/u.exec(line);
    if (listMatch) {
      const ordered = /^\d/u.test(listMatch[1]!);
      const start = ordered ? Number.parseInt(listMatch[1]!, 10) : undefined;
      const items: JSONContent[] = [];
      let itemIndex = index;
      while (itemIndex < lines.length) {
        const item = /^([-*+]|\d+[.)])\s+(.*)$/u.exec(lines[itemIndex]!);
        if (!item || /^\d/u.test(item[1]!) !== ordered) break;
        items.push({ type: "listItem", content: [{ type: "paragraph", content: inlineContent(item[2]!) }] });
        itemIndex++;
      }
      content.push({ type: ordered ? "orderedList" : "bulletList", ...(ordered ? { attrs: { start } } : {}), content: items });
      index = itemIndex - 1;
      continue;
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
  if (node.isText) return serializeInlineText(node.text ?? "", markNames(node));
  if (node.type.name === "composerReference") return String(node.attrs.source ?? "");
  if (node.type.name === "composerCitation" || node.type.name === "composerContext") return "";
  if (node.type.name === "hardBreak") return "\n";
  let text = "";
  node.forEach((child) => { text += composerInlineSource(child); });
  return text;
}

function listItemSource(item: DocumentNode, index: number, ordered: boolean, start: number): string {
  const paragraph = item.firstChild;
  const prefix = ordered ? `${start + index}. ` : "- ";
  return prefix + (paragraph ? composerInlineSource(paragraph) : "");
}

function listSource(node: DocumentNode): string {
  const ordered = node.type.name === "orderedList";
  const start = ordered && Number.isFinite(Number(node.attrs.start)) ? Number(node.attrs.start) : 1;
  const lines: string[] = [];
  node.forEach((item, _position, index) => { lines.push(listItemSource(item, index, ordered, start)); });
  return lines.join("\n");
}

function blockSource(node: DocumentNode): string {
  if (node.type.name === "blockquote") {
    const lines: string[] = [];
    node.forEach(child => { lines.push(`> ${composerInlineSource(child)}`); });
    return lines.join("\n");
  }
  if (node.type.name === "bulletList" || node.type.name === "orderedList") return listSource(node);
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

function listPrefix(node: DocumentNode, index: number): string {
  const ordered = node.type.name === "orderedList";
  const start = ordered && Number.isFinite(Number(node.attrs.start)) ? Number(node.attrs.start) : 1;
  return ordered ? `${start + index}. ` : "- ";
}

function listItemParagraph(item: DocumentNode): DocumentNode | null {
  const child = item.firstChild;
  return child && child.type.name === "paragraph" ? child : null;
}

function inlineSourceOffset(paragraph: DocumentNode, local: number): number {
  let offset = 0;
  paragraph.forEach((child, childPosition) => {
    if (childPosition >= local) return;
    if (child.isText) {
      const text = child.text ?? "";
      offset += textSourceLength(text, markNames(child), Math.min(text.length, local - childPosition));
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
      const value = textSourceLength(text, markNames(child));
      if (local <= offset + value) {
        answer = childPosition + sourceOffsetToTextIndex(text, local - offset, markNames(child));
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
      } else if (block.type.name === "bulletList" || block.type.name === "orderedList") {
        let offset = 0;
        let itemIndex = 0;
        let done = false;
        block.forEach((item, itemPosition) => {
          if (done) return;
          const prefix = listPrefix(block, itemIndex);
          const paragraph = listItemParagraph(item);
          const paragraphLocal = Math.max(0, local - itemPosition - 2);
          if (local <= itemPosition + item.nodeSize) {
            answer = sourceOffset + offset + prefix.length + (paragraph ? inlineSourceOffset(paragraph, paragraphLocal) : 0);
            done = true;
          }
          offset += prefix.length + (paragraph ? composerInlineSource(paragraph).length : 0);
          itemIndex++;
        });
        if (!done) answer = sourceOffset + offset;
      } else {
        let offset = 0;
        block.forEach((child, childPosition) => {
          if (childPosition >= local) return;
          if (child.isText) {
            const text = child.text ?? "";
            const count = Math.min(text.length, local - childPosition);
            offset += textSourceLength(text, markNames(child), count);
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
      } else if (block.type.name === "bulletList" || block.type.name === "orderedList") {
        let offset = 0;
        let itemIndex = 0;
        let found = false;
        block.forEach((item, itemPosition) => {
          if (found) return;
          const prefix = listPrefix(block, itemIndex);
          const paragraph = listItemParagraph(item);
          const paragraphSource = paragraph ? composerInlineSource(paragraph) : "";
          const total = prefix.length + paragraphSource.length;
          if (local <= offset + total) {
            const relative = local - offset - prefix.length;
            answer = blockPosition + 3 + itemPosition + (paragraph ? inlinePositionAtSource(paragraph, Math.max(0, relative)) : 0);
            found = true;
          }
          offset += total;
          itemIndex++;
        });
        if (!found) answer = blockPosition + block.nodeSize;
      } else {
        let offset = 0;
        let found = false;
        block.forEach((child, childPosition) => {
          if (found) return;
          if (child.isText) {
            const text = child.text ?? "";
            const value = textSourceLength(text, markNames(child));
            if (local <= offset + value) {
              answer = blockPosition + 1 + childPosition + sourceOffsetToTextIndex(text, local - offset, markNames(child));
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
    if (!node.isText) return;
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
