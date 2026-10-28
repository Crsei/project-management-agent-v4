// Pricing fixtures adapted from t3code usagePricing.test.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheSavingsUsd, createOverrideRateTable, createUsagePricingCache, LITELLM_RATES_URL, lookupRate, parseRateTable, priceUsage } from "./pricing.ts";
import type { PricedRecord } from "./pricing.ts";

const document = {
  "vendor/model": {
    input_cost_per_token: 0.000002, output_cost_per_token: 0.000004,
    cache_read_input_token_cost: 0, cache_creation_input_token_cost: 0.000003,
    input_cost_per_token_priority: 0.000004, output_cost_per_token_priority: 0.000008,
  },
  "vendor/half": { input_cost_per_token: 0.000001 },
};
const record: PricedRecord = {
  model: "vendor/model", totals: { uncachedInputTokens: 1_000_000, cachedInputTokens: 1_000_000, cacheCreationTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 900_000 },
  speed: "standard", reportedCostUsd: null,
};

test("LiteLLM pricing preserves free cache, premium and reasoning semantics", () => {
  const rates = parseRateTable(document);
  assert.equal(lookupRate(rates, "vendor/half"), null);
  assert.equal(lookupRate(rates, "MODEL[1m]")?.cacheReadCostPerToken, 0);
  assert.deepEqual(priceUsage(rates, record), { costUsd: 9, costSource: "modelPriced", categoryCostUsd: { input: 2, cacheRead: 0, cacheWrite: 3, output: 4 }, speedPremiumUsd: 0 });
  assert.equal(cacheSavingsUsd(rates, record), 2);
  const fast = priceUsage(rates, { ...record, speed: "fast" });
  assert.equal(fast.costUsd, 18);
  assert.equal(fast.speedPremiumUsd, 9);
  assert.equal(fast.categoryCostUsd?.cacheRead, 0);
  const reported = priceUsage(rates, { ...record, reportedCostUsd: 18 });
  assert.equal(reported.costSource, "providerReported");
  assert.equal(reported.categoryCostUsd?.output, 8);
  assert.equal(priceUsage(rates, { ...record, model: "unknown", reportedCostUsd: null }).costSource, "unpriced");
});

test("aliases select the target rate and overrides, including zero-priced cache", () => {
  const rates = parseRateTable(document);
  const overrides = createOverrideRateTable({ custom: { inputCostPerMillionTokens: 5, outputCostPerMillionTokens: 7, cacheReadCostPerMillionTokens: 0 } });
  const input = { ...record, model: "preview", rateModel: "vendor/model", reportedCostUsd: 999 };
  const aliases = { preview: "next", next: "custom" };
  const price = priceUsage(rates, input, overrides, aliases);
  assert.equal(price.costSource, "modelPriced");
  assert.equal(price.costUsd, 17);
  assert.equal(price.categoryCostUsd?.cacheRead, 0);
  assert.equal(price.categoryCostUsd?.cacheWrite, 5);
  assert.equal(cacheSavingsUsd(rates, input, overrides, aliases), 5);
});

test("public cache shares requests, obeys TTL, uses mirror and retains stale prices on errors", async () => {
  let clock = 1_000_000;
  let saved: unknown = null;
  let failing = false;
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (failing || url === LITELLM_RATES_URL) return new Response("failed", { status: 503 });
    assert.equal(new Headers(init?.headers).get("accept"), "application/vnd.github.raw+json");
    return Response.json(document);
  };
  const options = { fetch: fakeFetch, now: () => clock, read: () => saved, write: (value: unknown) => { saved = value; } };
  const load = createUsagePricingCache(options);
  const [first, concurrent] = await Promise.all([load(), load()]);
  assert.equal(first.pricing.status, "fresh");
  assert.equal(concurrent.pricing.knownModels, first.pricing.knownModels);
  assert.equal(requests.length, 2);
  await load();
  await load(true);
  assert.equal(requests.length, 2);
  const restored = createUsagePricingCache(options);
  assert.equal((await restored()).pricing.status, "cached");
  clock += 24 * 60 * 60 * 1000 + 1;
  failing = true;
  const stale = await restored();
  assert.equal(stale.pricing.status, "cached");
  assert.equal(lookupRate(stale.table, "vendor/model")?.cacheReadCostPerToken, 0);
  assert.equal(requests.length, 4);
  await restored();
  assert.equal(requests.length, 4);
  clock += 60_001;
  const empty = createUsagePricingCache({ ...options, read: () => null });
  assert.equal((await empty()).pricing.status, "unavailable");
});

test("ambiguous bare model prices and malformed rates are not guessed", () => {
  const rates = parseRateTable({ "a/shared": { input_cost_per_token: 1, output_cost_per_token: 2 }, "b/shared": { input_cost_per_token: 3, output_cost_per_token: 4 }, bad: { input_cost_per_token: -1, output_cost_per_token: 2 } });
  assert.equal(lookupRate(rates, "shared"), null);
  assert.equal(lookupRate(rates, "a/shared")?.inputCostPerToken, 1);
  assert.equal(lookupRate(rates, "bad"), null);
});
