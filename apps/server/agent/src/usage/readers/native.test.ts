import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { usageProviderKindSchema } from "@agent-workspace/contracts/usage";
import { closeStore } from "../../durable/store.ts";
import { createProviderInstance, getStoredInstance, updateProviderInstance } from "../../providers/instances.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../../providers/t3code/application.ts";
import { providerApplicationOptions } from "../../providers/t3code/production.ts";
import { scanNativeUsage } from "./native.ts";
import type { UsageReadContext } from "../types.ts";

test("all ten original readers preserve disabled history or explicitly disclose missing/unsupported sources without inference", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "original-usage-families-"));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR, previousFetch = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
  const network: string[] = [];
  globalThis.fetch = async input => { network.push(String(input)); throw new Error("No external requests in native history fixture."); };
  try {
    await mkdir(process.env.AGENT_WORKSPACE_DATA_DIR);
    await writeFile(path.join(process.env.AGENT_WORKSPACE_DATA_DIR, "provider-instances.json"), JSON.stringify({ version: 1, instances: [] }));
    const home = path.join(root, "home"), sessions = path.join(root, "pi-sessions");
    await mkdir(home); await mkdir(sessions);
    const environment = Object.entries({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
      CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), GROK_HOME: path.join(home, ".grok"),
      PI_CODING_AGENT_SESSION_DIR: sessions, ANTIGRAVITY_DATA_DIR: path.join(home, "antigravity"), OPENCODE_DATA_DIR: path.join(home, "opencode"),
      CURSOR_API_KEY: "", CURSOR_AUTH_TOKEN: "", AGENT_CLI_CREDENTIAL_STORE: "file" }).map(([name, value]) => ({ name, value, sensitive: false }));
    const instances = usageProviderKindSchema.options.map(driver => createProviderInstance({ instanceId: `usage-${driver}`, driver, enabled: false,
      config: driver === "acpRegistry"
        ? { source: "local", commandPath: path.join(root, "missing-native-binary"), commandArgs: [] }
        : { binaryPath: path.join(root, "missing-native-binary") }, environment }));
    await writeFile(path.join(sessions, "session.jsonl"), [
      { type: "session", id: "native-session" },
      { type: "usage", id: "native-turn", timestamp: "2026-10-20T12:00:00.000Z", provider: "fixture", model: "fixture-model", usage: { input: 7, output: 2, cost: { total: 0 } } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    await startPmProviderApplication(providerApplicationOptions);
    const context: UsageReadContext = { instances, sinceMs: Date.parse("2026-10-20"), untilMs: Date.parse("2026-10-21"), awaitRefresh: true,
      settings: { revision: 0, usagePriceOverrides: {}, usageModelAliases: {}, cursorKeychainUsageEnabled: false } };
    const scans = await scanNativeUsage(context);
    assert.deepEqual(new Set(scans.map(scan => scan.source.fingerprint.provider)), new Set(usageProviderKindSchema.options));
    assert.ok(scans.every(scan => scan.source.status === "ok" || scan.source.status === "missing"), JSON.stringify(scans.map(scan => scan.source)));
    const pi = scans.find(scan => scan.source.fingerprint.provider === "pi")!;
    assert.equal(pi.records[0]?.totals.uncachedInputTokens, 7); assert.equal(pi.records[0]?.reportedCostUsd, null);
    for (const driver of ["fx", "acpRegistry"] as const) {
      const unsupported = scans.find(scan => scan.source.fingerprint.provider === driver)!;
      assert.equal(unsupported.source.status, "missing"); assert.match(unsupported.source.message!, /does not support native usage history/);
    }
    const stale = instances.find(instance => instance.driver === "pi")!;
    updateProviderInstance(stale.instanceId, { label: "Changed usage binding" });
    const fenced = await scanNativeUsage({ ...context, instances: [stale] });
    assert.equal(fenced[0]?.source.status, "failed"); assert.equal(fenced[0]?.records.length, 0);
    const current = getStoredInstance(stale.instanceId)!;
    assert.equal((await scanNativeUsage({ ...context, instances: [current] }))[0]?.records.length, 1);
    assert.deepEqual(network, []);
  } finally {
    await stopPmProviderApplication(); closeStore(); globalThis.fetch = previousFetch;
    if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
