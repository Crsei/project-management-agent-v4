import { MESSAGE_CONTEXT_CLIPBOARD_TYPE, type ClipboardContextRecord } from "./message-context-clipboard.ts";

/**
 * Drag source contract for context chips. The payload is byte-identical to the
 * copy/paste record, so the composer validates a drop exactly like a paste.
 * A chip only needs `onDragStart` -> `writeComposerContextDrag(event.dataTransfer, payload)`.
 */
export const COMPOSER_CONTEXT_DRAG_TYPE = MESSAGE_CONTEXT_CLIPBOARD_TYPE;

export function composerContextDragPayload(text: string, records: readonly ClipboardContextRecord[]): string {
  return JSON.stringify({ version: 1, text, contexts: records });
}

export function writeComposerContextDrag(dataTransfer: Pick<DataTransfer, "setData" | "effectAllowed">, payload: string): void {
  dataTransfer.setData(COMPOSER_CONTEXT_DRAG_TYPE, payload);
  // The drop target copies the record; it never moves the source chip.
  dataTransfer.effectAllowed = "copy";
}
