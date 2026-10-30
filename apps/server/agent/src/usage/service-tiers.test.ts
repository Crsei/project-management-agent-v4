import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NativeSessionRef, ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import { closeStore, writeRecord } from "../durable/store.ts";
import { recordUsageLaunch, recordUsageLaunchSession, resolveCodexLaunchServiceTiers, resolveCodexServiceTiers } from "./service-tiers.ts";
import type { UsageRecord, UsageScan } from "./types.ts";

const session: NativeSessionRef = { driver: "codex", providerInstanceId: "one", instanceRevision: 3, modelId: "model", sessionId: "session", turnId: "turn" };
function scan(overrides: Partial<UsageRecord> = {}): UsageScan {
  return { source: { fingerprint: { hostId: "local", provider: "codex", resolvedHomePath: "/fixture", volumeId: "1" }, status: "ok", scannedFiles: 1,
    skippedFiles: 0, malformedRecords: 0, distinctSessions: 1, message: null, instanceIds: ["one"] }, records: [{
    provider: "codex", timestampMs: 100, model: "model", sessionId: "session", nativeTurnId: "turn", unresolvedServiceTierTurnId: "turn",
    totals: { uncachedInputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 1, reasoningTokens: 0 },
    reportedCostUsd: null, speed: "standard", dedupeKey: null, ...overrides,
  }] };
}
function capture(id: string, options?: ProviderOptionSelection[], ref = session) {
  recordUsageLaunch({ generationId: id, instanceId: "one", instanceRevision: 3, provider: "codex", model: "model", modelOptions: options });
  recordUsageLaunchSession(id, ref);
}
async function isolated(run: () => void) {
  const directory = await mkdtemp(join(tmpdir(), "usage-tier-"));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  try { run(); }
  finally {
    closeStore();
    if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("launch selection survives durable reopen without canonical telemetry and cannot be overwritten by later selection", async () => {
  await isolated(() => {
    capture("generation", [{ id: "serviceTier", value: "priority" }]);
    // A later current-thread preference (or accidental recapture) is not launch evidence.
    writeRecord("threads", "thread", { settings: { modelOptions: [{ id: "serviceTier", value: "ultrafast" }] } });
    capture("generation", [{ id: "serviceTier", value: "ultrafast" }]);
    closeStore();
    const resolved = resolveCodexServiceTiers([scan()])[0]!.records[0]!;
    assert.equal(resolved.speed, "fast");
    assert.equal(resolved.unresolvedServiceTierTurnId, undefined);
  });
});

for (const tier of [undefined, true, "future-tier"] as const) {
  test(`inherited, invalid or unsupported tier remains unknown: ${tier}`, async () => {
    await isolated(() => {
      capture("generation", tier === undefined ? undefined : [{ id: "serviceTier", value: tier }]);
      const unresolved = resolveCodexServiceTiers([scan()])[0]!.records[0]!;
      assert.equal(unresolved.unresolvedServiceTierTurnId, "turn");
      assert.equal(unresolved.speed, "standard");
    });
  });
}

for (const [tier, speed] of [["standard", "standard"], ["default", "standard"], ["fast", "fast"], ["ultrafast", "ultrafast"]] as const) {
  test(`explicit ${tier} is proven only for exact session, turn, model and instance`, async () => {
    await isolated(() => {
      capture("generation", [{ id: "serviceTier", value: tier }]);
      assert.equal(resolveCodexServiceTiers([scan()])[0]!.records[0]!.speed, speed);
      for (const mismatch of [{ sessionId: "other" }, { model: "other" }, { nativeTurnId: "other" }]) {
        assert.equal(resolveCodexServiceTiers([scan(mismatch)])[0]!.records[0]!.unresolvedServiceTierTurnId, "turn");
      }
      const other = scan({ instanceId: "other" }); other.source.instanceIds = ["other"];
      assert.equal(resolveCodexServiceTiers([other])[0]!.records[0]!.unresolvedServiceTierTurnId, "turn");
      const shared = scan({ instanceId: "primary-home-instance" }); shared.source.instanceIds = ["primary-home-instance", "one"];
      assert.equal(resolveCodexServiceTiers([shared])[0]!.records[0]!.unresolvedServiceTierTurnId, undefined);
    });
  });
}

test("ambiguous native turns are not guessed even with equal options or a different destination", async () => {
  await isolated(() => {
    capture("first", [{ id: "serviceTier", value: "fast" }]);
    capture("second", [{ id: "serviceTier", value: "fast" }], { ...session, sessionId: "another-session" });
    assert.equal(resolveCodexServiceTiers([scan()])[0]!.records[0]!.unresolvedServiceTierTurnId, "turn");
  });
});

test("a resumed/fork source boundary is not the newly launched turn", async () => {
  await isolated(() => {
    recordUsageLaunch({ generationId: "generation", instanceId: "one", instanceRevision: 3, provider: "codex", model: "model",
      modelOptions: [{ id: "serviceTier", value: "fast" }], previousTurnIds: ["turn"] });
    recordUsageLaunchSession("generation", session);
    assert.equal(resolveCodexServiceTiers([scan()])[0]!.records[0]!.unresolvedServiceTierTurnId, "turn");
    recordUsageLaunchSession("generation", { ...session, turnId: "new-turn" });
    assert.equal(resolveCodexServiceTiers([scan({ nativeTurnId: "new-turn", unresolvedServiceTierTurnId: "new-turn" })])[0]!.records[0]!.speed, "fast");
  });
});

test("legacy completed generation uses frozen options; incomplete or contradictory metadata stays unknown", async () => {
  await isolated(() => {
    const generation = { id: "legacy", status: "completed", providerInstanceId: "one", providerInstanceRevision: 3,
      modelId: "model", modelOptions: [{ id: "serviceTier", value: "ultrafast" }], nativeSession: session };
    writeRecord("chat:generations", "legacy", generation);
    assert.equal(resolveCodexServiceTiers([scan()])[0]!.records[0]!.speed, "ultrafast");
    for (const altered of [{ status: "running" }, { modelOptions: [] }, { nativeSession: { ...session, instanceRevision: 2 } },
      { nativeSession: { ...session, modelId: "other" } }, { modelOptions: [{ id: "serviceTier", value: true }] }]) {
      writeRecord("chat:generations", "legacy", { ...generation, ...altered });
      assert.equal(resolveCodexServiceTiers([scan()])[0]!.records[0]!.unresolvedServiceTierTurnId, "turn");
    }
    writeRecord("chat:generations", "legacy", generation);
    writeRecord("chat:generations", "duplicate", { ...generation, id: "duplicate", nativeSession: { ...session, providerInstanceId: "wrong-instance" } });
    assert.equal(resolveCodexServiceTiers([scan()])[0]!.records[0]!.unresolvedServiceTierTurnId, "turn");
  });
});

test("an explicitly unrecognized native tier cannot be overwritten by a known launch choice", async () => {
  await isolated(() => {
    capture("generation", [{ id: "serviceTier", value: "fast" }]);
    const native = scan({ unrecognizedServiceTier: true });
    assert.equal(resolveCodexServiceTiers([native])[0]!.records[0], native.records[0]);
    assert.equal(native.records[0]!.unrecognizedServiceTier, true);
  });
});

test("original reader history port preserves instance identity, unknown tiers and ambiguous launches", async () => {
  await isolated(() => {
    capture("known", [{ id: "serviceTier", value: "priority" }]);
    capture("inherited", undefined, { ...session, turnId: "inherited-turn" });
    const known = { sessionId: "session", nativeTurnId: "turn", model: "model" };
    const inherited = { ...known, nativeTurnId: "inherited-turn" };
    const foreignSession = { ...known, sessionId: "foreign-session" };
    const foreignModel = { ...known, model: "foreign-model" };
    closeStore();
    assert.deepEqual([...resolveCodexLaunchServiceTiers("one", [known, inherited, foreignSession, foreignModel])], [[known, "fast"]]);
    assert.equal(resolveCodexLaunchServiceTiers("other-instance", [known]).has(known), false);
    capture("duplicate", [{ id: "serviceTier", value: "priority" }], { ...session, sessionId: "other-session" });
    assert.equal(resolveCodexLaunchServiceTiers("one", [known]).has(known), false);
  });
});
