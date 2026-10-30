// Adapted from t3code usage settings semantics. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageSettings } from "@agent-workspace/contracts/usage";
import { settingsDraft, settingsPatch, sourceDraft, sourceInput } from "./usage-settings-draft.ts";

const settings: UsageSettings = { revision: 3, usagePriceOverrides: { old: { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2, cacheReadCostPerMillionTokens: 0 } }, usageModelAliases: { alias: "old" }, cursorKeychainUsageEnabled: false };

test("price edits preserve zero, omit optional cache prices, delete renamed entries and allow unknown models", () => {
  const draft = settingsDraft(settings);
  draft.prices[0] = { model: "unknown-model", input: "0", output: "4.5", cacheRead: "0", cacheWrite: "" };
  draft.aliases[0] = { model: "new-alias", target: "unknown-model" };
  draft.cursorKeychainUsageEnabled = true;
  const patch = settingsPatch(settings, draft);
  assert.deepEqual({ ...patch.usagePriceOverrides }, { old: null, "unknown-model": { inputCostPerMillionTokens: 0, outputCostPerMillionTokens: 4.5, cacheReadCostPerMillionTokens: 0 } });
  assert.deepEqual({ ...patch.usageModelAliases }, { alias: null, "new-alias": "unknown-model" });
  assert.equal(patch.cursorKeychainUsageEnabled, true);
});

test("revision retry keeps the original edit patch rather than deleting concurrent additions", () => {
  const draft = settingsDraft(settings);
  draft.prices[0]!.output = "7";
  const patch = settingsPatch(settings, draft, 9);
  assert.equal(patch.revision, 9);
  assert.deepEqual(Object.keys(patch.usagePriceOverrides ?? {}), ["old"]);
  assert.equal(patch.usageModelAliases, undefined);
  assert.equal(patch.cursorKeychainUsageEnabled, undefined);
});

test("invalid or duplicate models and nonfinite or missing prices are rejected", () => {
  const draft = settingsDraft(settings);
  draft.prices.push({ ...draft.prices[0]! });
  assert.throws(() => settingsPatch(settings, draft));
  draft.prices.pop(); draft.prices[0]!.input = "";
  assert.throws(() => settingsPatch(settings, draft));
  draft.prices[0]!.input = "Infinity";
  assert.throws(() => settingsPatch(settings, draft));
  draft.prices[0]!.input = "-1";
  assert.throws(() => settingsPatch(settings, draft));
  draft.prices[0]!.input = "1"; draft.aliases[0]!.target = " ";
  assert.throws(() => settingsPatch(settings, draft));
});

test("hub drafts never receive the configured secret and only explicitly set or clear it", () => {
  const view = { id: "hub", kind: "cliproxy" as const, label: "Hub", url: "https://hub.example", enabled: true, revision: 4, managementKeyConfigured: true };
  const draft = sourceDraft(view);
  assert.equal(draft.managementKey, "");
  assert.deepEqual(sourceInput(draft, view.revision), { kind: "cliproxy", label: "Hub", url: "https://hub.example", enabled: true, revision: 4 });
  draft.managementKey = "replacement";
  assert.equal(sourceInput(draft, 5).managementKey, "replacement");
  draft.managementKey = ""; draft.enabled = false; draft.clearManagementKey = true;
  assert.deepEqual(sourceInput(draft, 5), { kind: "cliproxy", label: "Hub", url: "https://hub.example", enabled: false, clearManagementKey: true, revision: 5 });
});
