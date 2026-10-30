import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageBucket, UsageSummary } from "@agent-workspace/contracts/usage";
import { modelDetailData } from "./usage-model-detail-data.ts";
import { buildUsageView } from "./usage-view-model.ts";

const priced: UsageBucket = { day: "2026-01-01", provider: "codex", model: "model/one", totals: { uncachedInputTokens: 100, cachedInputTokens: 50, cacheCreationTokens: 50, outputTokens: 200, reasoningTokens: 100 }, costUsd: 2, cacheSavingsUsd: 0, costSource: "modelPriced", records: 1, unpricedRecords: 0, sessions: 1 };
const unpriced: UsageBucket = { ...priced, day: "2026-01-02", costUsd: 0, costSource: "unpriced", unpricedRecords: 1 };

function selectedModel(buckets: UsageBucket[]) {
  const summary: UsageSummary = {
    contractVersion: 6, readAt: "2026-01-03T00:00:00Z", sinceDay: "2026-01-01", untilDay: "2026-01-02", timeZone: "UTC", scanDurationMs: 0,
    pricing: { status: "fresh", source: "fixture", fetchedAt: null, knownModels: 1 }, buckets,
    sources: [...new Set(buckets.map(bucket => bucket.provider))].map(provider => ({
      fingerprint: { hostId: "local", provider, resolvedHomePath: "/fixture", volumeId: provider },
      status: "ok", scannedFiles: 1, skippedFiles: 0, malformedRecords: 0, distinctSessions: 1, message: null,
    })),
  };
  const view = buildUsageView(summary, { sinceDay: summary.sinceDay, untilDay: summary.untilDay, timeZone: "UTC", resolution: "day" });
  return view.models.find(model => model.key === "codex\u0000model/one")!;
}

test("model detail consumes the shared provider/model selection and totals", () => {
  const model = selectedModel([priced, { ...priced, provider: "claude" }, { ...priced, model: "other" }]);
  const result = modelDetailData(model);
  assert.equal(result.rows.length, 1);
  assert.equal(result.totals, model.totals);
  assert.equal(result.totals.tokens, 400);
  assert.equal(result.cacheHit, .25);
  assert.equal(result.perMillion, 5000);
  assert.equal(result.unknown, false);
});

test("unpriced buckets are excluded from the realized rate, not treated as free", () => {
  const result = modelDetailData(selectedModel([priced, unpriced]));
  assert.equal(result.perMillion, 5000);
  assert.equal(result.unknown, true);
  assert.equal(result.entirelyUnpriced, false);
  const noPrice = modelDetailData(selectedModel([unpriced]));
  assert.equal(noPrice.perMillion, null);
  assert.equal(noPrice.entirelyUnpriced, true);
});

test("mixed priced and unpriced records cannot yield an exact realized rate", () => {
  const result = modelDetailData(selectedModel([priced, { ...priced, records: 2, unpricedRecords: 1 }]));
  assert.equal(result.mixed, true);
  assert.equal(result.perMillion, null);
  assert.equal(result.unknown, true);
});

test("no input or priced tokens yields unavailable ratios while a priced zero stays known", () => {
  const zero = { ...priced, costUsd: 0, totals: { uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 } };
  const result = modelDetailData(selectedModel([zero]));
  assert.equal(result.cacheHit, null);
  assert.equal(result.perMillion, null);
  assert.equal(result.entirelyUnpriced, false);
});
