import assert from "node:assert/strict";
import test from "node:test";
import type { QueuedChatMessage } from "@agent-workspace/contracts/chat";
import {
  queueDropIndex, queueDropPosition, queueEditableText, queueKeyboardBeforeId, queueMoveBeforeId, queueRowReorderable,
} from "./composer-queue-order.ts";
import type { ChatDraftInput } from "@agent-workspace/contracts/chat";

const row = (id: string, status: QueuedChatMessage["status"] = "queued"): Pick<QueuedChatMessage, "id" | "status"> => ({ id, status });
const rows = [row("a"), row("b"), row("c"), row("d")];
const draft = (parts: ChatDraftInput["message"]["parts"], extra: Partial<ChatDraftInput> = {}): ChatDraftInput => ({
  message: { id: "m", role: "user", parts },
  ...extra,
});

test("only plain text queue drafts round-trip through the composer", () => {
  assert.equal(queueEditableText(draft([{ type: "text", text: "hello" }])), "hello");
  assert.equal(queueEditableText(draft([{ type: "text", text: "  " }])), undefined);
  assert.equal(queueEditableText(null), undefined);
  assert.equal(queueEditableText(draft([{ type: "file", url: "data:,", mediaType: "image/png" }])), undefined);
  assert.equal(queueEditableText(draft([{ type: "text", text: "hi" }], { contextItems: [{ contextId: "c" } as never] })), undefined);
  assert.equal(queueEditableText(draft([{ type: "text", text: "hi" }], { pmReferences: [{ id: "r" } as never] })), undefined);
  assert.equal(queueEditableText({ ...draft([{ type: "text", text: "hi" }]), message: { ...draft([{ type: "text", text: "hi" }]).message, metadata: { custom: { quote: {} } } } }), undefined);
});

test("drag midpoint decides the insertion edge", () => {
  assert.equal(queueDropPosition(9, 0, 20), "above");
  assert.equal(queueDropPosition(11, 0, 20), "below");
  assert.equal(queueDropIndex(2, "above"), 2);
  assert.equal(queueDropIndex(2, "below"), 3);
});

test("dropping onto the current position is a no-op", () => {
  assert.equal(queueMoveBeforeId(rows, 1, 1), undefined);
  assert.equal(queueMoveBeforeId(rows, 1, 2), undefined);
  assert.equal(queueMoveBeforeId(rows, -1, 0), undefined);
  assert.equal(queueMoveBeforeId(rows, 4, 0), undefined);
});

test("moving down maps to the next surviving row, moving up to the previous row", () => {
  // a dropped below b (insert 2) => a goes before c.
  assert.equal(queueMoveBeforeId(rows, 0, 2), "c");
  // c dropped above a (insert 0) => c goes before a.
  assert.equal(queueMoveBeforeId(rows, 2, 0), "a");
  // b dropped below d (insert 4) => b appends.
  assert.equal(queueMoveBeforeId(rows, 1, 4), null);
  // d dropped above b (insert 1) => d goes before b.
  assert.equal(queueMoveBeforeId(rows, 3, 1), "b");
  // c dropped at the very end after removal => append.
  assert.equal(queueMoveBeforeId(rows, 2, 4), null);
});

test("out-of-range insert indices clamp instead of throwing", () => {
  assert.equal(queueMoveBeforeId(rows, 0, 99), null);
  assert.equal(queueMoveBeforeId(rows, 3, -5), "a");
  assert.equal(queueMoveBeforeId([], 0, 0), undefined);
});

test("keyboard reordering reuses the up/down button beforeId semantics", () => {
  assert.equal(queueKeyboardBeforeId(rows, 0, "up"), undefined);
  assert.equal(queueKeyboardBeforeId(rows, 3, "down"), undefined);
  assert.equal(queueKeyboardBeforeId(rows, 2, "up"), "b");
  assert.equal(queueKeyboardBeforeId(rows, 1, "down"), "d");
  assert.equal(queueKeyboardBeforeId(rows, 2, "down"), null);
  assert.equal(queueKeyboardBeforeId(rows, 5, "up"), undefined);
});

test("only queued and blocked rows expose a reorder grip", () => {
  assert.equal(queueRowReorderable("queued"), true);
  assert.equal(queueRowReorderable("blocked"), true);
  assert.equal(queueRowReorderable("sent"), false);
  assert.equal(queueRowReorderable("unknown"), false);
  assert.equal(queueRowReorderable("dispatching"), false);
  assert.equal(queueRowReorderable("removed"), false);
});
