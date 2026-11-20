// Pure ordering model for the durable message queue. Mirrors the host `move` action,
// which re-inserts the row before `beforeId` (or appends when `beforeId` is null)
// after removing the moved row from the list.
// Adapted from t3code QueuedRunsControl.tsx at 7379f1969b0f4b579327cf81299ef8cc3ddf8e9c.
// Copyright (c) 2026 T3 Tools Inc. MIT; LICENSE.t3code.
import type { ChatDraftInput, QueuedChatMessage } from "@agent-workspace/contracts/chat";

export type QueueOrderRow = Pick<QueuedChatMessage, "id" | "status">;

/** Only plain text can round-trip through the composer without losing attachments or bound contexts. */
export function queueEditableText(draft: ChatDraftInput | null): string | undefined {
  if (!draft) return undefined;
  if (draft.message.parts.some(part => part.type !== "text")) return undefined;
  if ((draft.contextItems?.length ?? 0) > 0 || (draft.pmReferences?.length ?? 0) > 0) return undefined;
  if (draft.message.metadata?.custom?.quote) return undefined;
  const text = draft.message.parts.filter(part => part.type === "text").map(part => part.text).join("\n");
  return text.trim() ? text : undefined;
}

/** Sent receipts and unknown dispatches keep their position until reconciled or dismissed. */
export function queueRowReorderable(status: QueuedChatMessage["status"]): boolean {
  return status === "queued" || status === "blocked";
}

/** Pointer above the row midpoint inserts before it; below inserts after it. */
export function queueDropPosition(pointerY: number, rowTop: number, rowHeight: number): "above" | "below" {
  return pointerY < rowTop + rowHeight / 2 ? "above" : "below";
}

export function queueDropIndex(rowIndex: number, position: "above" | "below"): number {
  return position === "above" ? rowIndex : rowIndex + 1;
}

/**
 * `undefined` means the move is a no-op (dropping where the row already sits, or an
 * out-of-range source). `null` means append at the end; a string means insert before
 * that row. Both branches use the same pre-removal insertion index the pointer picked.
 */
export function queueMoveBeforeId(rows: readonly QueueOrderRow[], fromIndex: number, insertIndex: number): string | null | undefined {
  if (fromIndex < 0 || fromIndex >= rows.length) return undefined;
  const insert = Math.max(0, Math.min(insertIndex, rows.length));
  if (insert === fromIndex || insert === fromIndex + 1) return undefined;
  const remaining = rows.filter((_row, index) => index !== fromIndex);
  const target = insert > fromIndex ? insert - 1 : insert;
  return remaining[target]?.id ?? null;
}

/** Alt+Arrow reordering keeps the existing up/down button semantics. */
export function queueKeyboardBeforeId(rows: readonly QueueOrderRow[], index: number, direction: "up" | "down"): string | null | undefined {
  if (index < 0 || index >= rows.length) return undefined;
  if (direction === "up") return index > 0 ? rows[index - 1]!.id : undefined;
  return index < rows.length - 1 ? rows[index + 2]?.id ?? null : undefined;
}
