import assert from "node:assert/strict";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import { pmTurnUsage } from "./usage.ts";

const turn = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderTurn));
const base = { id: "turn", providerThreadId: "thread", nodeId: "root", runAttemptId: "attempt", nativeTurnRef: null,
  ordinal: 1, status: "completed", startedAt: null, completedAt: null };
test("complete native turn counters partition input without double-counting reasoning", () => {
  const result = pmTurnUsage(turn({ ...base, turnTokenUsage: { usageScope: "main_agent", usageStatus: "complete", hasSubagents: false,
    inputTokens: 100, cachedInputTokens: 30, cacheCreationTokens: 20, outputTokens: 10, reasoningTokens: 4 } }), "explicit-model");
  assert.deepEqual(result, { turn: { model: "explicit-model", totals: { uncachedInputTokens: 50, cachedInputTokens: 30, cacheCreationTokens: 20, outputTokens: 10, reasoningTokens: 4 } } });
});
test("partial categorized counters remain reported and context counters never become a billable turn", () => {
  const result = pmTurnUsage(turn({ ...base, turnTokenUsage: { usageScope: "main_agent", usageStatus: "partial", hasSubagents: true,
    inputTokens: 100, outputTokens: 10 }, tokenUsage: { usedTokens: 20_000, updatedAt: "2026-10-30T00:00:00.000Z" } }), "explicit-model");
  assert.equal(result?.turn, undefined);
  assert.deepEqual(result?.reportedTurn, { inputTokens: 100, outputTokens: 10 });
  assert.equal(result?.context?.usedTokens, 20_000);
  assert.equal(pmTurnUsage(turn(base), "explicit-model"), undefined);
});

test("a complete upstream report with absent categories is not silently filled with zeroes", () => {
  const result = pmTurnUsage(turn({ ...base, turnTokenUsage: { usageScope: "main_agent", usageStatus: "complete",
    hasSubagents: false, inputTokens: 100, outputTokens: 10 } }), "explicit-model");
  assert.equal(result?.turn, undefined);
  assert.deepEqual(result?.reportedTurn, { inputTokens: 100, outputTokens: 10 });
});
