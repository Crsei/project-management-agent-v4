import assert from "node:assert/strict";
import { test } from "node:test";
import { paginateHistory } from "./history-page.ts";
import type { StoredMessage } from "./threads.ts";
const graph: StoredMessage[] = Array.from({ length: 205 }, (_, index) => ({ id: `message-${index}`, parent_id: index ? `message-${index - 1}` : null,
  format: "ai-sdk/v6", content: { role: index % 2 ? "assistant" : "user", parts: [{ type: "text", text: `body ${index}` }] } }));
test("history pages cover the entire stored graph without dropping parents, order or branch head", () => {
  let page = paginateHistory(graph, "message-204", { limit: "80" });
  const collected = [...page.messages];
  assert.equal(page.page!.total, 205); assert.equal(page.messages[0]!.id, "message-125");
  while (page.page!.hasMore) { page = paginateHistory(graph, "message-204", { limit: "80", before: page.page!.beforeCursor! }); collected.unshift(...page.messages); }
  assert.deepEqual(collected.map(message => message.id), graph.map(message => message.id));
  assert.equal(page.page!.beforeCursor, null);
});
test("branch changes invalidate cursors; body-only streaming updates do not corrupt graph pagination", () => {
  const first = paginateHistory(graph, "message-204", { limit: "80" });
  assert.throws(() => paginateHistory([...graph, { ...graph[0]!, id: "new-branch", parent_id: "message-3" }], "new-branch", { limit: "80", before: first.page!.beforeCursor! }), { code: "history_changed" });
  const changed = graph.map(message => message.id === "message-0" ? { ...message, content: { role: "user", parts: [{ type: "text", text: "updated" }] } } : message);
  assert.equal(paginateHistory(changed, "message-204", { limit: "80", before: first.page!.beforeCursor! }).page!.snapshot, first.page!.snapshot);
});
test("invalid/oversize cursors and limits are explicit, while legacy bare history remains complete", () => {
  assert.equal(paginateHistory(graph, "message-204", {}).messages, graph);
  for (const limit of ["0", "201", "1.5", "-1", "garbage"]) assert.throws(() => paginateHistory(graph, "message-204", { limit }), { code: "invalid_history_page" });
  for (const before of ["", "not-json", Buffer.from(JSON.stringify({ snapshot: "x", offset: -1 })).toString("base64url")])
    assert.throws(() => paginateHistory(graph, "message-204", { before }), { code: "invalid_history_cursor" });
});
