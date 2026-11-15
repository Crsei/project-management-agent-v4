import type { ClipboardEvent } from "react";
import type { ChatContextInput } from "@agent-workspace/contracts/message-context";
import type { PmReference } from "../pm/pm-types";
import type { ClipboardAttachment } from "./composer-context-attachments";

export const MESSAGE_CONTEXT_CLIPBOARD_TYPE = "application/x-dovspace-message-context+json";
export type ClipboardContextRecord = { type: "native"; item: { input: ChatContextInput } } | { type: "pm"; reference: PmReference } | { type: "attachment"; attachment: ClipboardAttachment };
const records = new WeakMap<Element, () => ClipboardContextRecord>();
export function bindClipboardContext(element: HTMLElement | null, record: () => ClipboardContextRecord) { if (element) records.set(element, record); }
export function contextClipboardPlainText(text: string, selected: readonly ClipboardContextRecord[]): string {
  return [text, ...selected.map(record => record.type === "native" ? `[${record.item.input.kind} context]\n${JSON.stringify(record.item.input)}` : record.type === "pm" ? `[PM reference]\n${JSON.stringify(record.reference)}` : `[Attachment ${record.attachment.name}]\n${JSON.stringify(record.attachment)}`)].filter(Boolean).join("\n\n");
}

/** Copy only records intersecting the actual selection. Composer copy owns its undoable document. */
export function copySelectedMessageContexts(event: ClipboardEvent<HTMLDivElement>): boolean {
  if (event.target instanceof Element && event.target.closest(".rich-composer")) return false;
  const selection = window.getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  const selected = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-message-context-record]")].filter(element => range.intersectsNode(element)).flatMap(element => { const record = records.get(element); return record ? [record()] : []; });
  const sourceTokens = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-message-source-token]")].filter(element => range.intersectsNode(element));
  if (!selected.length && !sourceTokens.length) return false;
  const fragment = range.cloneContents();
  for (const chip of fragment.querySelectorAll("[data-message-context-record]")) chip.remove();
  for (const token of fragment.querySelectorAll<HTMLElement>("[data-message-source-token]")) token.replaceWith(document.createTextNode(token.dataset.messageSourceToken || ""));
  const text = fragment.textContent || "";
  event.clipboardData.setData(MESSAGE_CONTEXT_CLIPBOARD_TYPE, JSON.stringify({ version: 1, text, contexts: selected }));
  event.clipboardData.setData("text/plain", contextClipboardPlainText(text, selected));
  event.preventDefault(); return true;
}
