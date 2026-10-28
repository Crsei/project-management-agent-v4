import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageBucket } from "@agent-workspace/contracts/usage";
import { modelDetailData } from "./usage-model-detail-data.ts";

const priced: UsageBucket = { day: "2026-01-01", provider: "codex", model: "model/one", totals: { uncachedInputTokens: 100, cachedInputTokens: 50, cacheCreationTokens: 50, outputTokens: 200, reasoningTokens: 100 }, costUsd: 2, cacheSavingsUsd: 0, costSource: "modelPriced", records: 1, unpricedRecords: 0, sessions: 1 };
const unpriced: UsageBucket = { ...priced, day: "2026-01-02", costUsd: 0, costSource: "unpriced", unpricedRecords: 1 };

test("model detail filters provider and model and computes cache hit and realized cost", () => {
  const result = modelDetailData("codex / model/one", [priced, { ...priced, provider: "claude" }, { ...priced, model: "other" }]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.totals.tokens, 400);
  assert.equal(result.cacheHit, .25);
  assert.equal(result.perMillion, 5000);
  assert.equal(result.unknown, false);
});

test("unpriced buckets are excluded from the realized rate, not treated as free", () => {
  const result = modelDetailData("codex / model/one", [priced, unpriced]);
  assert.equal(result.perMillion, 5000);
  assert.equal(result.unknown, true);
  assert.equal(result.entirelyUnpriced, false);
  const noPrice = modelDetailData("codex / model/one", [unpriced]);
  assert.equal(noPrice.perMillion, null);
  assert.equal(noPrice.entirelyUnpriced, true);
});

test("mixed priced and unpriced records cannot yield an exact realized rate", () => {
  const result = modelDetailData("codex / model/one", [priced, { ...priced, records: 2, unpricedRecords: 1 }]);
  assert.equal(result.mixed, true);
  assert.equal(result.perMillion, null);
  assert.equal(result.unknown, true);
});

test("no input or priced tokens yields unavailable ratios", () => {
  const zero = { ...priced, totals: { uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 } };
  const result = modelDetailData("codex / model/one", [zero]);
  assert.equal(result.cacheHit, null);
  assert.equal(result.perMillion, null);
  assert.deepEqual(modelDetailData(null, [priced]).rows, []);
});
