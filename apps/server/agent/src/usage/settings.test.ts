import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { closeStore, readRecord, writeRecord } from "../durable/store.ts";
import { getUsageSettings, updateUsageSettings } from "./settings.ts";
import type { UsageSettingsUpdate } from "@agent-workspace/contracts/usage";
import { acquireProviderSettingsSnapshot, subscribeProviderSettingsChanges } from "../providers/instances.ts";

let directory: string;
const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-usage-settings-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
});
afterEach(async () => {
  closeStore();
  if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
  else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
  await rm(directory, { recursive: true, force: true });
});

test("settings persist secret-free patches, preserve zero rates and delete entries", () => {
  assert.deepEqual(getUsageSettings(), { revision: 0, usagePriceOverrides: {}, usageModelAliases: {}, cursorKeychainUsageEnabled: false });
  const price = { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 6, cacheReadCostPerMillionTokens: 0 };
  const saved = updateUsageSettings({ revision: 0, usagePriceOverrides: { custom: price }, usageModelAliases: { preview: "custom" }, cursorKeychainUsageEnabled: true });
  closeStore();
  assert.deepEqual(getUsageSettings(), saved);
  assert.deepEqual(readRecord("settings:usage", "default"), saved);
  const next = updateUsageSettings({ revision: 1, usagePriceOverrides: { custom: null }, usageModelAliases: { preview: null }, cursorKeychainUsageEnabled: false });
  assert.deepEqual(next, { revision: 2, usagePriceOverrides: {}, usageModelAliases: {}, cursorKeychainUsageEnabled: false });
});

test("stale revisions, alias loops and secret fields never change persisted settings", () => {
  const saved = updateUsageSettings({ revision: 0, usageModelAliases: { a: "b", b: "model" } });
  assert.throws(() => updateUsageSettings({ revision: 0, cursorKeychainUsageEnabled: true }), { status: 409, code: "usage_settings_conflict" });
  assert.throws(() => updateUsageSettings({ revision: 1, usageModelAliases: { model: "a" } }), { status: 400, code: "usage_alias_cycle" });
  assert.throws(() => updateUsageSettings({ revision: 1, usageModelAliases: { loop: "loop" } }), { status: 400, code: "usage_alias_cycle" });
  assert.throws(() => updateUsageSettings({ revision: 1, apiKey: "fixture-secret" } as unknown as UsageSettingsUpdate));
  assert.deepEqual(getUsageSettings(), saved);
});

test("corrupt persisted settings are not silently replaced", () => {
  writeRecord("settings:usage", "default", { revision: 0, usagePriceOverrides: {}, usageModelAliases: { a: "a" }, cursorKeychainUsageEnabled: false });
  assert.throws(getUsageSettings, { status: 500, code: "invalid_usage_settings" });
});

test("native settings snapshots fence Usage preference writes and subscribers observe only committed revisions", () => {
  const published: number[] = [];
  const unsubscribe = subscribeProviderSettingsChanges(() => published.push(getUsageSettings().revision));
  try {
    const snapshot = acquireProviderSettingsSnapshot(getUsageSettings);
    try {
      assert.throws(() => updateUsageSettings({ revision: 0, cursorKeychainUsageEnabled: true }), { status: 409, code: "settings_busy" });
      assert.equal(snapshot.value.cursorKeychainUsageEnabled, false);
      assert.deepEqual(published, []);
    } finally { snapshot.release(); }
    updateUsageSettings({ revision: 0, cursorKeychainUsageEnabled: true });
    assert.equal(getUsageSettings().cursorKeychainUsageEnabled, true);
    assert.deepEqual(published, [1]);
    assert.throws(() => updateUsageSettings({ revision: 0, cursorKeychainUsageEnabled: false }), { status: 409, code: "usage_settings_conflict" });
    assert.deepEqual(published, [1]);
  } finally { unsubscribe(); }
});
