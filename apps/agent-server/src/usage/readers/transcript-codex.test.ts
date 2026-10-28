// Codex JSONL edge cases adapted from t3code's MIT usage fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { initialState, parseTranscriptRecord } from "./transcript-parsers.ts";

const time = "2026-08-01T10:00:00.000Z";
const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, total_tokens: input + output });
const event = (last: unknown, total: unknown, timestamp = time) => ({ type: "event_msg", timestamp, payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } } });
test("Codex re-emissions, malformed counter deltas, restarts and equal genuine requests", () => {
  const state = initialState();
  const consume = (value: unknown) => parseTranscriptRecord("codex", value, state);
  consume({ type: "session_meta", timestamp: time, payload: { id: "s", model_provider: "openai" } });
  consume({ type: "turn_context", payload: { model: "gpt", turn_id: "t" } });
  assert.equal(consume(event(usage(10, 2), usage(10, 2))).length, 1);
  assert.equal(consume(event(usage(10, 2), usage(10, 2))).length, 0);
  assert.equal(consume(event(usage(10, 2), usage(20, 4))).length, 1);
  assert.equal(consume(event(usage(2, 1), usage(30, 5))).length, 0);
  assert.equal(state.malformed, 1);
  // A malformed paired request still advances the valid cumulative baseline.
  assert.equal(consume(event(usage(5, 1), usage(35, 6))).length, 1);
  assert.equal(consume(event(usage(4, 1), usage(4, 1))).length, 1);
  assert.equal(consume(event({ input_tokens: 1, cached_input_tokens: 2, output_tokens: 1 }, usage(5, 2))).length, 0);
  assert.equal(state.malformed, 2);
});

test("Codex forks establish a copied-history baseline without rebilling the parent", () => {
  const state = initialState();
  const consume = (value: unknown) => parseTranscriptRecord("codex", value, state);
  consume({ type: "session_meta", timestamp: time, payload: { id: "child", forked_from_id: "parent" } });
  consume({ type: "session_meta", timestamp: time, payload: { id: "parent" } });
  consume({ type: "turn_context", payload: { model: "gpt" } });
  assert.equal(consume(event(usage(10, 2), usage(10, 2), "2026-08-01T10:00:00.100Z")).length, 0);
  const records = consume(event(usage(5, 1), usage(15, 3), "2026-08-01T10:00:05.000Z"));
  assert.equal(records.length, 1); assert.equal(records[0]!.sessionId, "child"); assert.equal(records[0]!.totals.uncachedInputTokens, 5);
});
