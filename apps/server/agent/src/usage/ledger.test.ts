import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeStore } from "../durable/store.ts";
import { beginThreadUsage, recordNativeUsage, getThreadUsage, scanLedgerUsage, updateUsageSession } from "./ledger.ts";
import type { UsageReadContext, UsageScan } from "./types.ts";

const totals = { uncachedInputTokens: 5, cachedInputTokens: 2, cacheCreationTokens: 1, outputTokens: 3, reasoningTokens: 1 };
test("telemetry overwrites cumulative turns, survives reopen and defers only covered history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-ledger-"));
  const old = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  try {
    const base = { threadId: "thread", instanceId: "one", provider: "codex" as const, model: "model" };
    const session = { providerInstanceId: "one", driver: "codex" as const, sessionId: "session", turnId: "turn-1" };
    recordNativeUsage({ ...base, generationId: "g1", session, update: { turn: { totals }, context: { usedTokens: 11, maxTokens: 100, updatedAt: new Date().toISOString() } } });
    recordNativeUsage({ ...base, generationId: "g1", update: { turn: { totals: { ...totals, outputTokens: 8 } } } });
    updateUsageSession("g1", session);
    recordNativeUsage({ ...base, generationId: "g2", session: { ...session, turnId: "turn-2" }, update: { turn: { totals } } });
    closeStore();
    assert.equal(getThreadUsage("thread").totals?.outputTokens, 3);
    assert.equal(getThreadUsage("thread").context?.usedTokens, 11);
    const instance = { instanceId: "one", driver: "codex", label: "fixture", enabled: true, config: {}, env: {}, revision: 1, homeDirectory: directory, stateDirectory: directory } as const;
    const context: UsageReadContext = { instances: [instance], sinceMs: 0, untilMs: Date.now() + 10000, awaitRefresh: false, settings: { revision: 0, usagePriceOverrides: {}, usageModelAliases: {}, cursorKeychainUsageEnabled: false } };
    assert.equal(scanLedgerUsage(context, [])[0]!.records.length, 2);
    const native: UsageScan = { source: { fingerprint: { hostId: "local", provider: "codex", resolvedHomePath: directory, volumeId: "1" }, status: "partial", scannedFiles: 1, skippedFiles: 0, malformedRecords: 0, distinctSessions: 1, message: null, instanceIds: ["one"] }, records: [{ provider: "codex", timestampMs: Date.now(), model: "model", sessionId: "session", totals, reportedCostUsd: null, speed: "standard", dedupeKey: "native", nativeTurnId: "turn-1" }] };
    assert.deepEqual(scanLedgerUsage(context, [native])[0]!.records.map((r) => r.nativeTurnId), ["turn-2"]);
    delete native.records[0]!.nativeTurnId;
    assert.deepEqual(scanLedgerUsage(context, [native]), []);
    beginThreadUsage({ threadId: "thread", generationId: "next", instanceId: "other", model: "model" });
    assert.equal(getThreadUsage("thread").totals, undefined);
    assert.equal(getThreadUsage("thread").context, undefined);
    recordNativeUsage({ ...base, generationId: "g3", session: { ...session, sessionId: "new-session" }, update: { turn: { totals } } });
    assert.equal(getThreadUsage("thread").context, undefined);
    recordNativeUsage({ ...base, generationId: "g3", update: { reportedTurn: { inputTokens: 99, outputTokens: 9 } } });
    assert.equal(getThreadUsage("thread").totals, undefined);
    assert.equal(scanLedgerUsage(context, []).flatMap((scan) => scan.records).some((record) => record.sessionId === "new-session"), false);
    beginThreadUsage({ threadId: "thread", generationId: "partial", instanceId: "one", model: "model" });
    recordNativeUsage({ ...base, generationId: "partial", session: { ...session, sessionId: "partial-session" }, update: { reportedTurn: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 } } });
    recordNativeUsage({ ...base, generationId: "partial", update: { reportedTurn: { inputTokens: 110, outputTokens: 12, cachedInputTokens: 45 } } });
    closeStore();
    assert.deepEqual(getThreadUsage("thread").reportedTurn, { inputTokens: 110, outputTokens: 12, cachedInputTokens: 45 });
    assert.equal(getThreadUsage("thread").totals, undefined);
    assert.equal(scanLedgerUsage(context, []).flatMap((scan) => scan.records).some((record) => record.sessionId === "partial-session"), false);
  } finally {
    closeStore(); if (old === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = old;
    await rm(directory, { recursive: true, force: true });
  }
});

test("duplicate canonical reports for one native turn use the latest totals and retain unresolved speed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-ledger-turn-"));
  const old = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  try {
    const base = { threadId: "thread", instanceId: "one", provider: "codex" as const, model: "model" };
    const session = { providerInstanceId: "one", driver: "codex" as const, sessionId: "session", turnId: "turn" };
    recordNativeUsage({ ...base, generationId: "first", session, update: { turn: { totals } } });
    recordNativeUsage({ ...base, generationId: "duplicate", session, update: { turn: { totals: { ...totals, outputTokens: 8 } } } });
    const context: UsageReadContext = { instances: [{ instanceId: "one", driver: "codex", label: "fixture", enabled: true, config: {}, env: {},
      revision: 1, homeDirectory: directory, stateDirectory: directory }], sinceMs: 0, untilMs: Date.now() + 10000, awaitRefresh: false,
      settings: { revision: 0, usagePriceOverrides: {}, usageModelAliases: {}, cursorKeychainUsageEnabled: false } };
    const records = scanLedgerUsage(context, [])[0]!.records;
    assert.equal(records.length, 1);
    assert.equal(records[0]!.totals.outputTokens, 8);
    assert.equal(records[0]!.unresolvedServiceTierTurnId, "turn");
    const native: UsageScan = { source: { fingerprint: { hostId: "local", provider: "codex", resolvedHomePath: directory, volumeId: "1" },
      status: "partial", scannedFiles: 1, skippedFiles: 0, malformedRecords: 0, distinctSessions: 1, message: null, instanceIds: ["one"] },
      records: [{ ...records[0]!, dedupeKey: "native" }] };
    assert.deepEqual(scanLedgerUsage(context, [native]), []);
    native.records[0]!.nativeTurnId = undefined;
    assert.deepEqual(scanLedgerUsage(context, [native]), []);
    native.records[0]!.sessionId = "other-session";
    assert.equal(scanLedgerUsage(context, [native])[0]!.records.length, 1);
    context.instances[0]!.driver = "claude";
    assert.deepEqual(scanLedgerUsage(context, []), []);
  } finally {
    closeStore();
    if (old === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = old;
    await rm(directory, { recursive: true, force: true });
  }
});
