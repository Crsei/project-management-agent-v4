import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StoredProviderInstance } from "../../providers/instances.ts";
import { scanTranscriptUsage } from "./transcripts.ts";

test("Pi reads the explicitly configured session directory, never the default home", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "usage-root-"));
  try {
    const home = path.join(base, "home"), sessions = path.join(base, "configured");
    await mkdir(home); await mkdir(sessions);
    await writeFile(path.join(sessions, "session.jsonl"), [
      { type: "session", id: "session" },
      { type: "usage", id: "entry", timestamp: "2026-08-01T10:00:00Z", provider: "anthropic", model: "actual", usage: { input: 7, output: 2 } },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const instance: StoredProviderInstance = { instanceId: "pi", driver: "pi", label: "Pi", enabled: false, config: {}, env: { PI_CODING_AGENT_SESSION_DIR: sessions }, homeDirectory: home, revision: 1 };
    const scans = await scanTranscriptUsage({ instances: [instance], sinceMs: Date.parse("2026-08-01T00:00:00Z"), untilMs: Date.parse("2026-08-02T00:00:00Z"), awaitRefresh: true, settings: { revision: 0, usagePriceOverrides: {}, usageModelAliases: {}, cursorKeychainUsageEnabled: false } });
    assert.equal(scans.length, 1); assert.equal(scans[0]!.source.fingerprint.resolvedHomePath, sessions); assert.equal(scans[0]!.records[0]!.totals.uncachedInputTokens, 7);
  } finally { await rm(base, { recursive: true, force: true }); }
});
