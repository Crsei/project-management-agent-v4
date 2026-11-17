import assert from "node:assert/strict";
import test from "node:test";
import { indexMessageTimes } from "./generation-times-model.ts";

test("generation times map input and assistant messages without inventing missing links", () => {
  const times = indexMessageTimes([
    { inputMessageId: "u1", messageId: "a1", createdAt: "2026-01-01T00:00:00.000Z" },
    { inputMessageId: "u2", messageId: "a2", createdAt: "2026-01-01T00:01:00.000Z" },
    { messageId: "a3", createdAt: "2026-01-01T00:02:00.000Z" },
  ]);
  assert.equal(times.get("u1"), "2026-01-01T00:00:00.000Z");
  assert.equal(times.get("a1"), "2026-01-01T00:00:00.000Z");
  assert.equal(times.get("a3"), "2026-01-01T00:02:00.000Z");
  assert.equal(times.get("missing"), undefined);
  assert.equal(indexMessageTimes([]).size, 0);
});
