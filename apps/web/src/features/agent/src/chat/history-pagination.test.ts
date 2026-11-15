import assert from "node:assert/strict";
import test from "node:test";
import { loadCompleteHistory, type HistoryEntry, type HistoryPage } from "./history-pagination.ts";

const entry = (id: string, parent_id: string | null): HistoryEntry => ({ id, parent_id, format: "test", content: { id } });
function page(messages: HistoryEntry[], beforeCursor: string | null, total: number, headId: string | null = "a2", snapshot = "snapshot"): HistoryPage {
  return { headId, messages, activeGenerationId: "generation", page: { hasMore: beforeCursor !== null, beforeCursor, total, snapshot } };
}

test("hydrates every branch and parent in original graph order before runtime import", async () => {
  const calls: Array<string | undefined> = [];
  const progress: number[] = [];
  const pages = new Map<string | undefined, HistoryPage>([
    [undefined, page([entry("a2", "u2"), entry("alternate", "u1")], "older", 5)],
    ["older", page([entry("a1", "u1"), entry("u2", "a1")], "oldest", 5)],
    ["oldest", page([entry("u1", null)], null, 5)],
  ]);
  const history = await loadCompleteHistory(async (before) => { calls.push(before); return pages.get(before)!; }, (loaded) => progress.push(loaded));
  assert.deepEqual(calls, [undefined, "older", "oldest"]);
  assert.deepEqual(progress, [2, 4, 5]);
  assert.deepEqual(history.messages.map((message) => message.id), ["u1", "a1", "u2", "a2", "alternate"]);
  assert.equal(history.messages.at(-1)?.parent_id, "u1");
  assert.equal(history.headId, "a2");
  assert.equal(history.activeGenerationId, "generation");
});

test("rejects snapshot/head changes rather than importing a mixed branch", async () => {
  let calls = 0;
  await assert.rejects(loadCompleteHistory(async () => ++calls === 1 ? page([entry("a2", "u1")], "older", 2) : page([entry("u1", null)], null, 2, "a2", "changed")), /history changed|历史已变化/);
});

test("rejects orphaned parents, omitted head, duplicates and missing pages", async () => {
  for (const invalid of [
    page([entry("a2", "missing")], null, 1),
    page([entry("u1", null)], null, 1),
    page([entry("a2", null), entry("a2", null)], null, 2),
    page([entry("a2", null)], null, 2),
  ]) await assert.rejects(loadCompleteHistory(async () => invalid), /incomplete|不完整/);
});

test("rejects repeated cursors and accepts a real empty graph", async () => {
  await assert.rejects(loadCompleteHistory(async () => page([], "same-cursor", 2)), /cursor|游标/);
  const empty = await loadCompleteHistory(async () => page([], null, 0, null));
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.headId, null);
});
