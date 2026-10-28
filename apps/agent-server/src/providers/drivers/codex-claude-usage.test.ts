import assert from "node:assert/strict";
import test from "node:test";
import { CodexUsage, codexLimitUpdate } from "./codex-usage.ts";
import { ClaudeUsage, claudeLimitUpdate } from "./claude-usage.ts";

test("Codex rejects impossible breakdowns, reports only actual context capacity and sparse limits", () => {
  const usage = new CodexUsage("fixture-model");
  const invalid = { inputTokens: 10, cachedInputTokens: 9, cacheWriteInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13 };
  assert.equal(usage.update({ total: invalid, last: invalid })?.turn, undefined);
  assert.deepEqual(usage.update({ total: invalid, last: invalid })?.reportedTurn, { inputTokens: 10, outputTokens: 3, cachedInputTokens: 9, cacheCreationTokens: 2, reasoningTokens: 1 });
  const missingCacheWrite = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13 };
  const missingUsage = new CodexUsage("fixture-model");
  assert.equal(missingUsage.update({ total: missingCacheWrite, last: missingCacheWrite })?.turn, undefined);
  assert.deepEqual(missingUsage.update({ total: missingCacheWrite, last: missingCacheWrite })?.reportedTurn, { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2, reasoningTokens: 1 });
  assert.equal(usage.update({ last: { totalTokens: 12 } })?.context?.maxTokens, undefined);
  assert.equal(codexLimitUpdate({ limitId: "spark", primary: { usedPercent: 42 } }), undefined);
  assert.deepEqual(codexLimitUpdate({ secondary: { usedPercent: 20 } }), { limits: { windows: [{ id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 20 }] } });
  assert.equal(codexLimitUpdate({ primary: { usedPercent: NaN } }), undefined);
});

test("Claude ignores synthetic and subagent context and invalidates pre-compaction snapshots", () => {
  const usage = new ClaudeUsage();
  const snapshot = { type: "assistant", parent_tool_use_id: null, message: { id: "m", model: "model", usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 3 } } };
  assert.equal(usage.update({ ...snapshot, parent_tool_use_id: "subagent" })?.context, undefined);
  assert.equal(usage.update({ ...snapshot, message: { ...snapshot.message, model: "<synthetic>" } }), undefined);
  assert.equal(usage.update(snapshot)?.context?.usedTokens, 38);
  assert.equal(usage.update({ type: "system", subtype: "compact_boundary", compact_metadata: { post_tokens: 8 } })?.context?.usedTokens, 8);
  const repeated = usage.update(snapshot);
  assert.equal(repeated?.context, undefined);
  assert.deepEqual(repeated?.turn?.totals, { uncachedInputTokens: 10, cachedInputTokens: 20, cacheCreationTokens: 5, outputTokens: 3, reasoningTokens: 0 });
  const result = usage.update({ type: "result", usage: { input_tokens: 12, output_tokens: 4 }, modelUsage: { model: { contextWindow: 1000 }, subagent: { contextWindow: 2000 } } });
  assert.deepEqual(result?.reportedTurn, { inputTokens: 12, outputTokens: 4 });
  assert.equal(result?.turn, undefined);
  assert.equal(result?.context?.usedTokens, 8);
  assert.equal(result?.context?.maxTokens, 1000);
  assert.equal(claudeLimitUpdate({ rateLimitType: "seven_day_overage_included", utilization: 0.5 }), undefined);
  assert.deepEqual(claudeLimitUpdate({ rateLimitType: "seven_day", utilization: 0.25 }), { limits: { windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", windowDurationMins: 10080, usedPercent: 25 }] } });
});

test("Claude assistant snapshots replace duplicate message usage and accumulate distinct requests", () => {
  const usage = new ClaudeUsage();
  const assistant = (id: string, input: number) => ({ type: "assistant", parent_tool_use_id: null, message: { id, model: "model", usage: { input_tokens: input, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, output_tokens: 4 } } });
  const one = usage.update(assistant("one", 10))?.turn?.totals;
  assert.deepEqual(one, { uncachedInputTokens: 10, cachedInputTokens: 2, cacheCreationTokens: 1, outputTokens: 4, reasoningTokens: 0 });
  assert.deepEqual(usage.update(assistant("one", 10))?.turn?.totals, one);
  assert.deepEqual(usage.update(assistant("two", 20))?.turn?.totals, { uncachedInputTokens: 30, cachedInputTokens: 4, cacheCreationTokens: 2, outputTokens: 8, reasoningTokens: 0 });
});

test("Codex reports native partial counters cumulatively without duplicating repeated snapshots", () => {
  const usage = new CodexUsage("fixture-model");
  const last = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningOutputTokens: 5 };
  const total = { inputTokens: 1100, outputTokens: 220, cachedInputTokens: 440, reasoningOutputTokens: 55 };
  const first = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 5 };
  assert.deepEqual(usage.update({ last, total })?.reportedTurn, first);
  assert.deepEqual(usage.update({ last, total })?.reportedTurn, first);
  const next = { inputTokens: 30, outputTokens: 8, cachedInputTokens: 10, reasoningOutputTokens: 2 };
  const nextTotal = { inputTokens: 1130, outputTokens: 228, cachedInputTokens: 450, reasoningOutputTokens: 57 };
  const accumulated = { inputTokens: 130, outputTokens: 28, cachedInputTokens: 50, reasoningTokens: 7 };
  assert.deepEqual(usage.update({ last: next, total: nextTotal })?.reportedTurn, accumulated);
  assert.deepEqual(usage.update({ last: next, total: nextTotal })?.reportedTurn, accumulated);
  assert.equal(usage.update({ last: next, total: nextTotal })?.turn, undefined);
});

test("Codex preserves reported cache writes and omits missing or invalid categories", () => {
  const usage = new CodexUsage("fixture-model");
  const last = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, cacheWriteInputTokens: 2, reasoningOutputTokens: 1 };
  assert.deepEqual(usage.update({ last, total: last })?.reportedTurn, { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, cacheCreationTokens: 2, reasoningTokens: 1 });
  const next = { inputTokens: 2, outputTokens: 1, cachedInputTokens: 1, cacheWriteInputTokens: 0 };
  const total = { inputTokens: 12, outputTokens: 5, cachedInputTokens: 4, cacheWriteInputTokens: 2, reasoningOutputTokens: -1 };
  assert.deepEqual(usage.update({ last: next, total })?.reportedTurn, { inputTokens: 12, outputTokens: 5, cachedInputTokens: 4, cacheCreationTokens: 2 });
  assert.deepEqual(usage.update({ last: next, total })?.reportedTurn, { inputTokens: 12, outputTokens: 5, cachedInputTokens: 4, cacheCreationTokens: 2 });
});

test("Codex cumulative resets use the actual last request and retain partiality", () => {
  const usage = new CodexUsage("fixture-model");
  const first = { inputTokens: 30, outputTokens: 5, cachedInputTokens: 4 };
  usage.update({ last: first, total: first });
  const reset = { inputTokens: 8, outputTokens: 2, cachedInputTokens: 1, cacheWriteInputTokens: 3 };
  assert.deepEqual(usage.update({ last: reset, total: reset })?.reportedTurn, { inputTokens: 38, outputTokens: 7, cachedInputTokens: 5 });
  assert.deepEqual(usage.update({ last: reset, total: reset })?.reportedTurn, { inputTokens: 38, outputTokens: 7, cachedInputTokens: 5 });
});

test("Claude accumulates partial message snapshots by id and reports result counters directly", () => {
  const usage = new ClaudeUsage();
  const assistant = (id: string, data: Record<string, number>) => ({ type: "assistant", message: { id, model: "model", usage: data } });
  const one = assistant("one", { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 4 });
  assert.deepEqual(usage.update(one)?.reportedTurn, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 });
  assert.deepEqual(usage.update(one)?.reportedTurn, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 });
  const two = assistant("two", { input_tokens: 20, output_tokens: 3, cache_creation_input_tokens: 1 });
  assert.deepEqual(usage.update(two)?.reportedTurn, { inputTokens: 30, outputTokens: 5 });
  const revised = assistant("one", { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 });
  assert.deepEqual(usage.update(revised)?.reportedTurn, { inputTokens: 32, outputTokens: 7, cacheCreationTokens: 1 });
  const result = usage.update({ type: "result", usage: { input_tokens: 31, output_tokens: 8, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } });
  assert.deepEqual(result?.reportedTurn, { inputTokens: 31, outputTokens: 8, cachedInputTokens: 5, cacheCreationTokens: 0 });
});

test("Claude stream deltas replace the same message and retain only observed categories", () => {
  const usage = new ClaudeUsage();
  const start = { type: "stream_event", event: { type: "message_start", message: { id: "m", model: "model", usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 3 } } } };
  assert.deepEqual(usage.update(start)?.reportedTurn, { inputTokens: 12, outputTokens: 0, cachedInputTokens: 3 });
  const delta = { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 4 } } };
  assert.deepEqual(usage.update(delta)?.reportedTurn, { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 });
  assert.deepEqual(usage.update(delta)?.reportedTurn, { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 });
  assert.deepEqual(usage.update({ type: "assistant", message: { id: "m", model: "model", usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 } } })?.reportedTurn, { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 });
  assert.equal(usage.update({ type: "result", usage: { input_tokens: -1, output_tokens: 4 } })?.reportedTurn, undefined);
});
