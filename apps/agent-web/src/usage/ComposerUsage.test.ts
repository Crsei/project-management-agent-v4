// Usage semantics adapted from t3code. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadUsageSnapshot } from "@agent-workspace/contracts/usage";
import { accountMatchesInstance, consumeUsageLimitsCommand, contextPercent, isUsageLimitsCommand, scopedThreadSnapshot, turnUsageFields } from "./ComposerUsageModel.ts";

test("only the standalone usage-limits command is consumed, without losing attachments", () => {
  const state = { text: "  /usage-limits\n", attachments: ["draft-file"] };
  let opens = 0;
  const composer = { getState: () => state, setText: (text: string) => { state.text = text; } };
  assert.equal(consumeUsageLimitsCommand(composer, () => { opens++; }), true);
  assert.equal(state.text, "");
  assert.deepEqual(state.attachments, ["draft-file"]);
  assert.equal(opens, 1);
  for (const text of ["/usage-limits extra", "please /usage-limits", "/usage-limit", "/USAGE-LIMITS"]) {
    state.text = text;
    assert.equal(isUsageLimitsCommand(text), false);
    assert.equal(consumeUsageLimitsCommand(composer, () => { opens++; }), false);
    assert.equal(state.text, text);
  }
  assert.equal(opens, 1);
});

test("a snapshot is only visible for the current remote thread and provider instance", () => {
  const snapshot: ThreadUsageSnapshot = { threadId: "thread-a", providerInstanceId: "instance-a", costUsd: 0, context: { usedTokens: 150, updatedAt: "2026-01-01T00:00:00Z" } };
  assert.equal(scopedThreadSnapshot("thread-a", "instance-a", snapshot), snapshot);
  assert.equal(scopedThreadSnapshot("thread-b", "instance-a", snapshot), null);
  assert.equal(scopedThreadSnapshot("thread-a", "instance-b", snapshot), null);
  assert.equal(scopedThreadSnapshot(undefined, "instance-a", snapshot), null);
  assert.equal(scopedThreadSnapshot("thread-a", "instance-a", null), null);
  assert.equal(scopedThreadSnapshot("thread-a", "instance-a", snapshot)?.costUsd, 0);
});

test("context percentage is absent without a reported capacity and bounded when over capacity", () => {
  const base = { usedTokens: 150, updatedAt: "2026-01-01T00:00:00Z" };
  assert.equal(contextPercent(base), null);
  assert.equal(contextPercent({ ...base, maxTokens: 300 }), 50);
  assert.equal(contextPercent({ ...base, maxTokens: 100 }), 100);
  assert.equal(contextPercent({ ...base, usedTokens: 0, maxTokens: 100 }), 0);
});

test("deduplicated accounts match every associated instance without matching unrelated or unlinked accounts", () => {
  const account = { instanceId: "a", instanceIds: ["a", "b"] };
  assert.equal(accountMatchesInstance(account, "a"), true);
  assert.equal(accountMatchesInstance(account, "b"), true);
  assert.equal(accountMatchesInstance(account, "c"), false);
  assert.equal(accountMatchesInstance({ instanceId: "a" }, "a"), true);
  assert.equal(accountMatchesInstance({ instanceIds: ["b"] }, "b"), true);
  assert.equal(accountMatchesInstance({}, "a"), false);
});

test("partial native counters retain their native meaning without inventing categories", () => {
  const snapshot: ThreadUsageSnapshot = { threadId: "a", reportedTurn: { inputTokens: 100, outputTokens: 9, cachedInputTokens: 0, reasoningTokens: 2 } };
  assert.deepEqual(turnUsageFields(snapshot), { incomplete: true, fields: [
    { label: "供应商报告输入", value: 100 }, { label: "供应商报告输出", value: 9 },
    { label: "缓存读取", value: 0 }, { label: "其中 reasoning", value: 2 },
  ] });
  assert.equal(turnUsageFields({ threadId: "a" }), null);
  assert.deepEqual(turnUsageFields({ ...snapshot, totals: { uncachedInputTokens: 90, cachedInputTokens: 10, cacheCreationTokens: 0, outputTokens: 9, reasoningTokens: 2 } })?.fields[0], { label: "未缓存输入", value: 90 });
  assert.equal(turnUsageFields({ ...snapshot, totals: { uncachedInputTokens: 90, cachedInputTokens: 10, cacheCreationTokens: 0, outputTokens: 9, reasoningTokens: 2 } })?.incomplete, false);
});
