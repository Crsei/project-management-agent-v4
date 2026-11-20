import test from "node:test";
import assert from "node:assert/strict";
import {
  fanoutBlocker,
  fanoutOutcomeSummary,
  fanoutRequestBody,
  fanoutSelectionKey,
  normalizeFanoutSelections,
  toggleFanoutSelection,
  type FanoutModelSelection,
} from "./model-fanout.ts";

const a: FanoutModelSelection = { providerInstanceId: "p", model: "a" };
const b: FanoutModelSelection = { providerInstanceId: "p", model: "b" };
const c: FanoutModelSelection = { providerInstanceId: "p", model: "c", modelOptions: [{ id: "reasoning", value: "high" }] };

test("selection keys sort provider options but keep distinct option sets", () => {
  const key = fanoutSelectionKey({ providerInstanceId: "p", model: "m", modelOptions: [
    { id: "b", value: "2" }, { id: "a", value: "1" },
  ] });
  assert.equal(key, fanoutSelectionKey({ providerInstanceId: "p", model: "m", modelOptions: [
    { id: "a", value: "1" }, { id: "b", value: "2" },
  ] }));
  assert.notEqual(key, fanoutSelectionKey({ providerInstanceId: "p", model: "m" }));
});

test("toggle returns null below two selections and dedupes above", () => {
  assert.equal(toggleFanoutSelection([], a), null);
  assert.deepEqual(toggleFanoutSelection([a], b), [a, b]);
  assert.equal(toggleFanoutSelection([a, b], a), null);
  assert.deepEqual(toggleFanoutSelection([a], a), null);
  const many = Array.from({ length: 10 }, (_, index) => ({ providerInstanceId: "p", model: `m${index}` }));
  const toggled = toggleFanoutSelection(many, { providerInstanceId: "p", model: "extra" });
  assert.equal(toggled?.length, 8);
});

test("normalize rejects one model and more than eight", () => {
  assert.throws(() => normalizeFanoutSelections([a]), /fanout_requires_two_models/);
  assert.throws(() => normalizeFanoutSelections(Array.from({ length: 9 }, (_, index) => ({ providerInstanceId: "p", model: `m${index}` }))), /fanout_exceeds_limit/);
  assert.deepEqual(normalizeFanoutSelections([a, a, b]), [a, b]);
});

test("blocker mirrors server restrictions instead of faking success", () => {
  const base = { selectionCount: 2, running: false, historyBlocked: false, pmReferenceCount: 0, contextItemCount: 0, quote: false, providerAvailable: true };
  assert.equal(fanoutBlocker(base), null);
  assert.equal(fanoutBlocker({ ...base, selectionCount: 1 }), "fanout_requires_two_models");
  assert.equal(fanoutBlocker({ ...base, running: true }), "fanout_session_running");
  assert.equal(fanoutBlocker({ ...base, pmReferenceCount: 1 }), "fanout_context_unsupported");
  assert.equal(fanoutBlocker({ ...base, contextItemCount: 1 }), "fanout_context_unsupported");
  assert.equal(fanoutBlocker({ ...base, quote: true }), "fanout_quote_unsupported");
  assert.equal(fanoutBlocker({ ...base, providerAvailable: false }), "fanout_provider_unavailable");
});

test("request body omits metadata and carries deduped selections", () => {
  const body = fanoutRequestBody({
    operationId: "op",
    sourceThreadId: "source",
    message: { id: "message", role: "user", parts: [{ type: "text", text: "hi" }], metadata: { custom: { ignored: true } } },
    selections: [a, a, c],
  });
  assert.deepEqual(body.selections, [a, c]);
  assert.deepEqual(body.message, { id: "message", role: "user", parts: [{ type: "text", text: "hi" }] });
  assert.equal("metadata" in (body.message as object), false);
});

test("outcome summary counts partial failures without hiding them", () => {
  const summary = fanoutOutcomeSummary({
    operationId: "op", sourceThreadId: "s", createdAt: "now", status: "partial",
    children: [
      { selection: a, threadId: "t1", generationId: "g1" },
      { selection: b, threadId: "t2", error: "provider failed" },
      { selection: c, threadId: "t3", generationId: "g3" },
    ],
  });
  assert.deepEqual(summary, { created: 2, failed: 1, generationIds: ["g1", "g3"] });
});
