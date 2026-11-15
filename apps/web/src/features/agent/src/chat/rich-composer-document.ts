import { collectComposerInlineTokens } from "@agent-workspace/client-runtime";
import type { Editor, JSONContent } from "@tiptap/react";
import type { QuoteInfo } from "@assistant-ui/react";
import type { MessageContextDraftItem } from "./message-context-store";
import type { PmReference } from "../pm/pm-types";
import type { ComposerContextAttachment } from "./composer-context-attachments";

export type ComposerContextPayload = { type: "native"; item: MessageContextDraftItem } | { type: "pm"; reference: PmReference } | { type: "attachment"; attachment: ComposerContextAttachment };

type DocumentNode = Editor["state"]["doc"];

export function referenceLabel(kind: string, value: string): string {
  if (kind === "skill") return `$${value}`;
  const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return separator < 0 ? value : value.slice(separator + 1);
}

function inlineContent(text: string): JSONContent[] {
  const content: JSONContent[] = [];
  let offset = 0;
  for (const token of collectComposerInlineTokens(`${text} `)) {
    if (token.start < offset || token.end > text.length) continue;
    if (token.start > offset) content.push({ type: "text", text: text.slice(offset, token.start) });
    content.push({ type: "composerReference", attrs: {
      kind: token.type === "skill" ? "skill" : "file", value: token.value, source: token.source,
    } });
    offset = token.end;
  }
  if (offset < text.length) content.push({ type: "text", text: text.slice(offset) });
  return content;
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
  if (node.isText) return node.text ?? "";
  if (node.type.name === "composerReference") return String(node.attrs.source ?? "");
  if (node.type.name === "composerCitation" || node.type.name === "composerContext") return "";
  if (node.type.name === "hardBreak") return "\n";
  let text = "";
  node.forEach((child) => { text += composerInlineSource(child); });
  return text;
}

function blockSource(node: DocumentNode): string {
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
      } else {
        let offset = 0;
        block.forEach((child, childPosition) => {
          if (childPosition >= local) return;
          const value = composerInlineSource(child);
          offset += child.isText ? Math.min(value.length, local - childPosition) : value.length;
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
      } else {
        let offset = 0;
        let found = false;
        block.forEach((child, childPosition) => {
          if (found) return;
          const value = composerInlineSource(child);
          if (local <= offset + value.length) {
            answer = blockPosition + 1 + childPosition + (child.isText ? local - offset : local > offset ? child.nodeSize : 0);
            found = true;
          }
          offset += value.length;
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
