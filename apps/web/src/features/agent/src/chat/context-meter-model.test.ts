import assert from "node:assert/strict";
import test from "node:test";
import { contextMeterState, formatContextPercent } from "./context-meter-model.ts";

test("context meter never invents a maximum or a percentage", () => {
  assert.equal(contextMeterState(undefined), undefined);
  assert.deepEqual(contextMeterState({ threadId: "t", updatedAt: "2026-01-01T00:00:00.000Z" }), undefined);
  const withoutLimit = contextMeterState({ threadId: "t", updatedAt: "2026-01-01T00:00:00.000Z", context: { usedTokens: 42, updatedAt: "2026-01-01T00:00:00.000Z" } });
  assert.equal(withoutLimit?.percent, undefined);
  assert.equal(withoutLimit?.maxTokens, undefined);
  assert.equal(formatContextPercent(undefined), undefined);
});

test("context percentage is clamped and keeps a readable small value", () => {
  const state = contextMeterState({ threadId: "t", updatedAt: "2026-01-01T00:00:00.000Z", context: { usedTokens: 29_510, maxTokens: 828_400, updatedAt: "2026-01-01T00:00:00.000Z", model: "gpt" } });
  assert.equal(state?.model, "gpt");
  assert.equal(formatContextPercent(state?.percent), "3.6%");
  assert.equal(formatContextPercent(7.04), "7%");
  assert.equal(contextMeterState({ threadId: "t", updatedAt: "2026-01-01T00:00:00.000Z", context: { usedTokens: 900, maxTokens: 100, updatedAt: "x" } })?.percent, 100);
  assert.equal(contextMeterState({ threadId: "t", updatedAt: "2026-01-01T00:00:00.000Z", context: { usedTokens: 0, maxTokens: 100, updatedAt: "x" } })?.percent, 0);
});
