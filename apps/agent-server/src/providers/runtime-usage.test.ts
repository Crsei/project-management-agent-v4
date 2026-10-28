import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import { codexAdapter } from "./drivers/codex.ts";
import { getStoredInstance, updateProviderInstance } from "./instances.ts";
import { getUsageLimitsReport } from "../usage/limits.ts";
import { resolveProviderRuntime, runNativeRuntime } from "./runtime.ts";

test("native runtime forwards cumulative usage without interfering with text and propagates consumer errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-usage-runtime-"));
  const previousDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
  const original = { check: codexAdapter.check, run: codexAdapter.run };
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  try {
    codexAdapter.check = async () => ({ installation: { status: "installed" }, authentication: "authenticated", models: [], canLogout: false, methods: [] });
    updateProviderInstance("codex", { customModels: [{ id: "fixture-native", label: "Fixture" }] }, getStoredInstance("codex")!.revision);
    const runtime = await resolveProviderRuntime({ providerInstanceId: "codex", modelName: "fixture-native" });
    const update: NativeUsageUpdate = {
      turn: { totals: { uncachedInputTokens: 7, cachedInputTokens: 3, cacheCreationTokens: 0, outputTokens: 4, reasoningTokens: 2 } },
      context: { usedTokens: 10, maxTokens: 100, updatedAt: "2026-01-01T00:00:00.000Z" },
    };
    const session = { id: "session", kind: "session" as const, label: "Session", usedPercent: 20 };
    const weekly = { id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 30 };
    codexAdapter.run = async (_context, options) => {
      options.onText?.("native output");
      options.onUsage?.(update);
      options.onUsage?.(update);
      options.onUsage?.({ limits: { windows: [session] } });
      options.onUsage?.({ limits: { windows: [weekly] } });
      return { text: "native output" };
    };
    const events: NativeUsageUpdate[] = [];
    let text = "";
    const result = await runNativeRuntime(runtime, { prompt: "fixture", onText: delta => { text += delta; }, onUsage: event => events.push(event) });
    assert.equal(result.text, "native output");
    assert.equal(text, "native output");
    assert.deepEqual(events, [update, update, { limits: { windows: [session] } }, { limits: { windows: [weekly] } }]);
    const windows = getUsageLimitsReport().accounts.find(account => account.instanceId === "codex")?.limits.windows;
    assert.deepEqual(windows?.find(window => window.id === "session"), session);
    assert.deepEqual(windows?.find(window => window.id === "weekly"), weekly);
    const failure = new Error("usage consumer failed");
    await assert.rejects(runNativeRuntime(runtime, { prompt: "fixture", onUsage: () => { throw failure; } }), error => error === failure);
  } finally {
    Object.assign(codexAdapter, original);
    if (previousDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
    else process.env.AGENT_WORKSPACE_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
