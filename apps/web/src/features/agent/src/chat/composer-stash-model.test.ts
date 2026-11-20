import assert from "node:assert/strict";
import test from "node:test";
import type { ChatDraftInput } from "@agent-workspace/contracts/chat";
import {
  moveStashHighlight, stashDrawerCommand, stashDraftCounts, stashDraftEmpty, stashDraftSnippet,
  stashDraftText, stashRelativeTime,
} from "./composer-stash-model.ts";

const draft = (overrides: Partial<ChatDraftInput> & { parts?: ChatDraftInput["message"]["parts"] } = {}): ChatDraftInput => ({
  message: { id: "m", role: "user", parts: overrides.parts ?? [{ type: "text", text: "Fix the failing test" }],
    ...(overrides.message?.metadata ? { metadata: overrides.message.metadata } : {}) },
  ...(overrides.contextItems ? { contextItems: overrides.contextItems } : {}),
  ...(overrides.pmReferences ? { pmReferences: overrides.pmReferences } : {}),
});

test("snippet collapses whitespace and truncates by code point", () => {
  assert.equal(stashDraftText(draft({ parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })), "a\nb");
  assert.equal(stashDraftSnippet(draft({ parts: [{ type: "text", text: "  hello \n\n world  " }] })), "hello world");
  assert.equal(stashDraftSnippet(draft({ parts: [{ type: "text", text: "x".repeat(200) }] }), 10), "xxxxxxxxx…");
  assert.equal(stashDraftSnippet(draft({ parts: [{ type: "text", text: "   " }] })), null);
  assert.equal(stashDraftSnippet(null), null);
});

test("counts distinguish attachments, context, references and quotes", () => {
  const counts = stashDraftCounts({
    message: { id: "m", role: "user", parts: [
      { type: "text", text: "look" },
      { type: "file", url: "data:image/png;base64,AA", mediaType: "image/png" },
      { type: "file", url: "data:text/plain;base64,AA", mediaType: "text/plain" },
    ], metadata: { custom: { quote: { text: "q", messageId: "x" } } } },
    contextItems: [{ contextId: "c1", kind: "thread", source: { type: "thread", threadId: "t", headMessageId: "h" } }],
    pmReferences: [{ workspaceId: "11111111-1111-4111-8111-111111111111", kind: "issue", id: "ISSUE-1", projectId: null, revision: null }],
  });
  assert.deepEqual(counts, { attachments: 2, contexts: 1, references: 1, quoted: true });
  assert.deepEqual(stashDraftCounts(null), { attachments: 0, contexts: 0, references: 0, quoted: false });
});

test("empty detection treats attachment-only drafts as restorable content", () => {
  assert.equal(stashDraftEmpty(draft()), false);
  assert.equal(stashDraftEmpty(draft({ parts: [{ type: "text", text: "  " }] })), true);
  assert.equal(stashDraftEmpty(draft({ parts: [{ type: "file", url: "data:image/png;base64,AA", mediaType: "image/png" }] })), false);
});

test("relative time uses stable buckets and never reports negative elapsed time", () => {
  const now = Date.parse("2026-01-02T12:00:00.000Z");
  assert.deepEqual(stashRelativeTime("2026-01-02T11:59:40.000Z", now), { unit: "now", value: 0 });
  assert.deepEqual(stashRelativeTime("2026-01-02T11:59:00.000Z", now), { unit: "minute", value: 1 });
  assert.deepEqual(stashRelativeTime("2026-01-02T11:30:00.000Z", now), { unit: "minute", value: 30 });
  assert.deepEqual(stashRelativeTime("2026-01-02T09:00:00.000Z", now), { unit: "hour", value: 3 });
  assert.deepEqual(stashRelativeTime("2026-01-01T06:00:00.000Z", now), { unit: "day", value: 1 });
  assert.deepEqual(stashRelativeTime("2025-12-01T00:00:00.000Z", now), { unit: "date", value: Date.parse("2025-12-01T00:00:00.000Z") });
  assert.deepEqual(stashRelativeTime("2026-01-03T12:00:00.000Z", now), { unit: "now", value: 0 });
  assert.deepEqual(stashRelativeTime("not a date", now), { unit: "unknown", value: 0 });
});

test("highlight movement wraps and handles an empty list", () => {
  assert.equal(moveStashHighlight(-1, 1, 3), 0);
  assert.equal(moveStashHighlight(-1, -1, 3), 2);
  assert.equal(moveStashHighlight(2, 1, 3), 0);
  assert.equal(moveStashHighlight(0, -1, 3), 2);
  assert.equal(moveStashHighlight(0, 1, 0), -1);
});

test("drawer keys map to navigation, restore, delete and close", () => {
  assert.equal(stashDrawerCommand({ key: "Escape", hasHighlight: true }), "close");
  assert.equal(stashDrawerCommand({ key: "ArrowDown", hasHighlight: true }), "next");
  assert.equal(stashDrawerCommand({ key: "ArrowUp", hasHighlight: true }), "previous");
  assert.equal(stashDrawerCommand({ key: "ArrowDown", shiftKey: true, hasHighlight: true }), null);
  assert.equal(stashDrawerCommand({ key: "Enter", hasHighlight: true }), "restore");
  assert.equal(stashDrawerCommand({ key: "Enter", hasHighlight: false }), null);
  assert.equal(stashDrawerCommand({ key: "Enter", shiftKey: true, hasHighlight: true }), null);
  assert.equal(stashDrawerCommand({ key: "Backspace", metaKey: true, hasHighlight: true }), "delete");
  assert.equal(stashDrawerCommand({ key: "Backspace", ctrlKey: true, hasHighlight: true }), "delete");
  assert.equal(stashDrawerCommand({ key: "Backspace", hasHighlight: true }), null);
  assert.equal(stashDrawerCommand({ key: "Backspace", metaKey: true, hasHighlight: false }), null);
  assert.equal(stashDrawerCommand({ key: "Enter", composing: true, hasHighlight: true }), null);
});
