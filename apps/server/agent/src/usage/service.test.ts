import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageSettings, UsageSummaryInput } from "@agent-workspace/contracts/usage";
import type { StoredProviderInstance } from "../providers/instances.ts";
import { createUsageSummaryReader, UsageInputError } from "./service.ts";
import { parseRateTable } from "./pricing.ts";
import type { UsageReadContext, UsageScan } from "./types.ts";

const input: UsageSummaryInput = { sinceDay: "2026-10-01", untilDay: "2026-10-30", timeZone: "UTC" };
const instance = (id: string): StoredProviderInstance => ({ instanceId: id, driver: "codex", label: id, enabled: false,
  config: {}, env: {}, revision: 1, homeDirectory: `/fixture/${id}`, stateDirectory: `/fixture/state/${id}` });
const settings = (): UsageSettings => ({ revision: 0, usagePriceOverrides: {}, usageModelAliases: {}, cursorKeychainUsageEnabled: false });
const table = parseRateTable({ model: { input_cost_per_token: 1, output_cost_per_token: 2,
  input_cost_per_token_priority: 2, output_cost_per_token_priority: 4 } });
const pricing = async () => ({ table, pricing: { status: "cached" as const, source: "fixture", fetchedAt: null, knownModels: 1 } });

function reader(options: Parameters<typeof createUsageSummaryReader>[0] = {}) {
  return createUsageSummaryReader({ instances: () => [instance("one"), instance("two")], settings,
    native: async () => [], ledger: () => [],
    tiers: (scans) => [...scans], persist: async () => {}, identity: () => "fixture", pricing, ...options });
}

test("identical concurrent scopes share scanning and persistence, but completed queries rescan", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let scans = 0, persists = 0;
  const read = reader({ native: async () => { scans++; entered.resolve(); await release.promise; return []; }, persist: async () => { persists++; } });
  const first = read({ ...input, instanceIds: ["two", "one", "one"] });
  const second = read({ ...input, instanceIds: ["one", "two"] });
  assert.equal(first, second);
  await entered.promise;
  assert.equal(scans, 1);
  release.resolve();
  assert.equal(await first, await second);
  assert.equal(persists, 1);
  await read({ ...input, instanceIds: ["one", "two"] });
  assert.equal(scans, 2);
});

test("query, instance revision, settings and explicit-refresh identities cannot share in-flight work", async () => {
  const release = Promise.withResolvers<void>();
  let currentSettings = settings(), currentInstances = [instance("one"), instance("two")], scope = "fixture";
  const contexts: UsageReadContext[] = [];
  const read = reader({ settings: () => currentSettings, instances: () => currentInstances, identity: () => scope,
    native: async (context) => { contexts.push(context); await release.promise; return []; } });
  const requests = [read(input), read({ ...input, instanceIds: ["one"] }), read({ ...input, awaitRefresh: true }),
    read({ ...input, timeZone: "Asia/Kathmandu" }), read({ ...input, untilDay: "2026-10-29" }),
    read({ ...input, resolution: "hour", sinceTime: "2026-10-29T10:15:00Z", untilTime: "2026-10-30T10:15:00Z" })];
  currentInstances = [{ ...currentInstances[0]!, revision: 2 }, currentInstances[1]!];
  requests.push(read(input));
  currentSettings = { ...currentSettings, revision: 1 };
  requests.push(read(input));
  currentSettings = { ...currentSettings, usagePriceOverrides: { model: { inputCostPerMillionTokens: 0, outputCostPerMillionTokens: 0 } } };
  requests.push(read(input));
  scope = "another-durable-store";
  requests.push(read(input));
  await Promise.resolve();
  assert.equal(contexts.length, 10);
  assert.equal(contexts[0]!.instances[0]!.revision, 1);
  assert.equal(contexts[6]!.instances[0]!.revision, 2);
  assert.equal(contexts[0]!.settings.revision, 0);
  assert.equal(contexts[1]!.instances.length, 1);
  assert.equal(contexts[2]!.awaitRefresh, true);
  release.resolve();
  const outcomes = await Promise.allSettled(requests);
  assert.ok(outcomes.slice(0, -1).every(outcome => outcome.status === "rejected" && outcome.reason.code === "usage_configuration_changed"));
  assert.equal(outcomes.at(-1)?.status, "fulfilled");
});

test("failed shared scans release their key so a later request can recover", async () => {
  const failure = new Error("fixture reader unavailable");
  let calls = 0;
  const read = reader({ native: async () => { if (++calls === 1) throw failure; return []; } });
  const first = read(input), second = read(input);
  await assert.rejects(first, (error) => error === failure);
  await assert.rejects(second, (error) => error === failure);
  await read(input);
  assert.equal(calls, 2);
});


test("calendar and exact-hour validation happens before starting readers", () => {
  const read = reader();
  assert.throws(() => read({ ...input, sinceDay: "2026-02-30" }), UsageInputError);
  assert.throws(() => read({ ...input, timeZone: "not/a/zone" }), UsageInputError);
  assert.throws(() => read({ ...input, resolution: "hour" }), UsageInputError);
});

test("unverified tiers remain visible while explicit zero price overrides remain authoritative", async () => {
  const source: UsageScan["source"] = { fingerprint: { hostId: "local", provider: "codex", resolvedHomePath: "/fixture/one", volumeId: "1" },
    status: "ok", scannedFiles: 1, skippedFiles: 0, malformedRecords: 0, distinctSessions: 1, message: null, instanceIds: ["one"] };
  const record: UsageScan["records"][number] = { provider: "codex", timestampMs: Date.parse("2026-10-20T12:00:00Z"), model: "model",
    sessionId: "session", nativeTurnId: "turn", unresolvedServiceTierTurnId: "turn",
    totals: { uncachedInputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 1, reasoningTokens: 0 },
    reportedCostUsd: 999, speed: "standard", dedupeKey: "turn" };
  const unverified = await reader({ native: async () => [{ source, records: [record] }] })(input);
  assert.ok(unverified.sources[0]!.message?.includes("unreported service tier"));
  assert.equal(unverified.buckets[0]!.costUsd, 999);
  const overridden = await reader({ native: async () => [{ source, records: [record] }],
    settings: () => ({ ...settings(), usagePriceOverrides: { model: { inputCostPerMillionTokens: 0, outputCostPerMillionTokens: 0 } } }),
  })(input);
  assert.equal(overridden.buckets[0]!.costUsd, 0);
  assert.equal(overridden.buckets[0]!.providerReportedRecords, 0);
  assert.equal(overridden.buckets[0]!.speedPremiumUsd, undefined);
});

test("explicit unknown native tiers remain visible even without a backfill turn marker", async () => {
  const read = reader({ native: async () => [{ source: {
    fingerprint: { hostId: "local", provider: "codex", resolvedHomePath: "/fixture/one", volumeId: "1" },
    status: "ok", scannedFiles: 1, skippedFiles: 0, malformedRecords: 0, distinctSessions: 1, message: null, instanceIds: ["one"],
  }, records: [{ provider: "codex", timestampMs: Date.parse("2026-10-20T12:00:00Z"), model: "model",
    sessionId: "session", nativeTurnId: "turn", unrecognizedServiceTier: true,
    totals: { uncachedInputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 1, reasoningTokens: 0 },
    reportedCostUsd: null, speed: "standard", dedupeKey: "turn" }] }] });
  const summary = await read(input);
  assert.equal(summary.buckets[0]!.costUsd, 3);
  assert.ok(summary.sources[0]!.message?.includes("unrecognized service tier"));
  assert.ok(summary.sources[0]!.message?.includes("unverified"));
});

test("an effective native environment change cannot reuse another in-flight instance summary", async () => {
  const release = Promise.withResolvers<void>();
  let current = { ...instance("one"), config: { homePath: "/fixture/usage-home" }, env: { USAGE_BOUNDARY_FIXTURE: "first" } };
  let reads = 0;
  const read = reader({ instances: () => [current], native: async () => { reads++; await release.promise; return []; } });
  const first = read(input);
  current = { ...current, env: { USAGE_BOUNDARY_FIXTURE: "second" } };
  const second = read(input);
  assert.notEqual(first, second);
  await Promise.resolve(); assert.equal(reads, 2);
  release.resolve(); await Promise.all([first, second]);
});
