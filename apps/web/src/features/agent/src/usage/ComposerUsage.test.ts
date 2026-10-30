// Usage semantics adapted from t3code. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeUsageLimitsCommand, isUsageLimitsCommand } from "./ComposerUsageModel.ts";
import { accountMatchesInstance } from "@agent-workspace/contracts/usage-limits";

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

test("deduplicated accounts match every associated instance without matching unrelated or unlinked accounts", () => {
  const account = { instanceId: "a", instanceIds: ["a", "b"] };
  assert.equal(accountMatchesInstance(account, "a"), true);
  assert.equal(accountMatchesInstance(account, "b"), true);
  assert.equal(accountMatchesInstance(account, "c"), false);
  assert.equal(accountMatchesInstance({ instanceId: "a" }, "a"), true);
  assert.equal(accountMatchesInstance({ instanceIds: ["b"] }, "b"), true);
  assert.equal(accountMatchesInstance({}, "a"), false);
});
