// Adapted from t3code usageAggregation.test.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import assert from "node:assert/strict";
import test from "node:test";
import type { UsageSource, UsageSummaryInput } from "@agent-workspace/contracts/usage";
import { aggregateUsage } from "./aggregation.ts";
import { createOverrideRateTable, type RateTable } from "./pricing.ts";
import type { UsageRecord, UsageScan } from "./types.ts";

const rates: RateTable = new Map([["fixture-model", {
  inputCostPerToken: 1e-5, outputCostPerToken: 5e-5, cacheReadCostPerToken: 1e-6, cacheCreationCostPerToken: 1.25e-5,
  fast: { inputCostPerToken: 2e-5, outputCostPerToken: 1e-4, cacheReadCostPerToken: 2e-6, cacheCreationCostPerToken: 2.5e-5 },
  ultrafast: { inputCostPerToken: 3e-5, outputCostPerToken: 1.5e-4, cacheReadCostPerToken: 3e-6, cacheCreationCostPerToken: 3.75e-5 },
}]]);
const input: UsageSummaryInput = { sinceDay: "2026-01-01", untilDay: "2026-12-31", timeZone: "UTC" };
function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return { provider: "claude", timestampMs: Date.parse("2026-08-07T04:05:13.944Z"), model: "fixture-model", sessionId: "session-a", totals: { uncachedInputTokens: 100, cachedInputTokens: 1000, cacheCreationTokens: 10, outputTokens: 50, reasoningTokens: 25 }, reportedCostUsd: null, speed: "standard", dedupeKey: null, ...overrides };
}
function scan(records: UsageRecord[], overrides: Partial<UsageSource> = {}): UsageScan {
  return { source: { fingerprint: { hostId: "local", provider: "claude", resolvedHomePath: "/fixture/home", volumeId: "1" }, status: "ok", scannedFiles: 1, skippedFiles: 0, malformedRecords: 0, distinctSessions: 1, message: null, instanceIds: ["one"], ...overrides }, records };
}
function near(actual: number | undefined, expected: number): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test("prices disjoint input categories and output without charging reasoning twice", () => {
  const { buckets } = aggregateUsage([scan([record(), record({ speed: "fast" }), record({ speed: "ultrafast" })])], input, { table: rates });
  const bucket = buckets[0]!;
  assert.deepEqual(bucket.totals, { uncachedInputTokens: 300, cachedInputTokens: 3000, cacheCreationTokens: 30, outputTokens: 150, reasoningTokens: 75 });
  near(bucket.costUsd, 0.02775);
  assert.deepEqual(bucket.categoryCostUsd, { input: 0.006, cacheRead: 0.006, cacheWrite: 0.00075, output: 0.015 });
  near(bucket.cacheSavingsUsd, 0.054);
  near(bucket.fastCostUsd, 0.00925);
  near(bucket.ultrafastCostUsd, 0.013875);
  near(bucket.speedPremiumUsd, 0.013875);
  assert.equal(bucket.costSource, "modelPriced");
  assert.equal(bucket.sessions, 1);
});

test("deduplicates explicit keys globally and physical source scans without collapsing repeated events within a scan", () => {
  const r = record();
  const duplicate = record({ dedupeKey: "message-1", sessionId: "other" });
  const first = scan([r, r, duplicate]);
  const second = scan([r, r, duplicate, record({ timestampMs: r.timestampMs + 1, sessionId: "new" })], { instanceIds: ["two"] });
  const third = scan([duplicate], { fingerprint: { ...first.source.fingerprint, resolvedHomePath: "/other" }, instanceIds: ["three"] });
  const { buckets, sources } = aggregateUsage([first, second, third], input, { table: rates });
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0]!.records, 4);
  assert.equal(buckets[0]!.sessions, 3);
  assert.deepEqual(sources[0]!.instanceIds, ["one", "two"]);
  assert.equal(sources[0]!.distinctSessions, 3);
  assert.equal(sources[1]!.distinctSessions, 0);
  assert.equal(sources[0]!.scannedFiles, 1);
});

test("merges equivalent source inodes even when their paths differ", () => {
  const a = scan([record()], { fingerprint: { hostId: "local", provider: "claude", resolvedHomePath: "/first", volumeId: "42:17" } });
  const b = scan([record()], { fingerprint: { ...a.source.fingerprint, resolvedHomePath: "/second" }, instanceIds: ["two"] });
  const { buckets, sources } = aggregateUsage([a, b], input, { table: rates });
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0]!.instanceIds, ["one", "two"]);
  assert.equal(buckets[0]!.records, 1);
  assert.equal(buckets[0]!.sourcePath, "/first");
});

test("filters instances, counts sessions only inside the requested window, and includes disabled source metadata", () => {
  const other = scan([record()], { instanceIds: ["other"], fingerprint: { hostId: "local", provider: "claude", resolvedHomePath: "/other", volumeId: "2" } });
  const a = scan([record(), record({ timestampMs: Date.parse("2025-01-01T00:00:00Z"), sessionId: "old" })]);
  const { buckets, sources } = aggregateUsage([other, a], { ...input, instanceIds: ["one"] }, { table: rates });
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.distinctSessions, 1);
  assert.equal(buckets[0]!.records, 1);
});

test("uses local calendar days across DST and quarter-hour midnight", () => {
  const values = ["2026-03-08T07:59:59Z", "2026-03-08T08:00:00Z", "2026-03-09T06:59:59Z", "2026-03-09T07:00:00Z"].map((date) => record({ timestampMs: Date.parse(date) }));
  const la = aggregateUsage([scan(values)], { ...input, timeZone: "America/Los_Angeles" }, { table: rates });
  assert.deepEqual(la.buckets.map((bucket) => [bucket.day, bucket.records]), [["2026-03-07", 1], ["2026-03-08", 2], ["2026-03-09", 1]]);
  const kathmandu = aggregateUsage([scan([record({ timestampMs: Date.parse("2026-08-01T18:14:59.999Z") }), record({ timestampMs: Date.parse("2026-08-01T18:15:00Z") })])], { ...input, timeZone: "Asia/Kathmandu" }, { table: rates });
  assert.deepEqual(kathmandu.buckets.map((bucket) => bucket.day), ["2026-08-01", "2026-08-02"]);
  const offset = aggregateUsage([scan([record({ timestampMs: Date.parse("2026-08-01T23:58:59.999Z") }), record({ timestampMs: Date.parse("2026-08-01T23:59:00Z") })])], { ...input, timeZone: "+00:01" }, { table: rates });
  assert.deepEqual(offset.buckets.map((bucket) => bucket.day), ["2026-08-01", "2026-08-02"]);
});

test("hourly windows use exact inclusive/exclusive instants through the repeated DST hour", () => {
  const hourly: UsageSummaryInput = { ...input, timeZone: "America/New_York", resolution: "hour", sinceTime: "2026-11-01T05:30:00Z", untilTime: "2026-11-01T07:30:00Z" };
  const times = ["2026-11-01T05:29:59.999Z", "2026-11-01T05:30:00Z", "2026-11-01T06:29:59.999Z", "2026-11-01T06:30:00Z", "2026-11-01T07:29:59.999Z", "2026-11-01T07:30:00Z"];
  const { buckets } = aggregateUsage([scan(times.map((time) => record({ timestampMs: Date.parse(time) })))], hourly, { table: rates });
  assert.deepEqual(buckets.map((bucket) => [bucket.day, bucket.hourStart, bucket.records]), [["2026-11-01", "2026-11-01T05:30:00.000Z", 2], ["2026-11-01", "2026-11-01T06:30:00.000Z", 2]]);
  assert.throws(() => aggregateUsage([], { ...hourly, sinceTime: undefined }, { table: rates }), /exact time bounds/);
});

test("preserves reported and unknown costs and folds aliases before applying override prices", () => {
  const overrides = createOverrideRateTable({ "fixture-model": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2, cacheReadCostPerMillionTokens: 0 } });
  const aliased = record({ model: "preview", rateModel: "irrelevant", reportedCostUsd: 100 });
  const { buckets } = aggregateUsage([scan([aliased, record({ model: "unknown", sessionId: "u" }), record({ model: "reported", reportedCostUsd: 1.25, sessionId: "r" })])], input, { table: rates, overrides, aliases: { preview: "mid", mid: "fixture-model" } });
  const priced = buckets.find((bucket) => bucket.model === "fixture-model")!;
  assert.equal(priced.costSource, "modelPriced");
  near(priced.costUsd, 0.00021);
  assert.equal(priced.categoryCostUsd!.cacheRead, 0);
  const unknown = buckets.find((bucket) => bucket.model === "unknown")!;
  assert.equal(unknown.costSource, "unpriced");
  assert.equal(unknown.unpricedRecords, 1);
  assert.equal(unknown.totals.reasoningTokens, 25);
  const reported = buckets.find((bucket) => bucket.model === "reported")!;
  assert.equal(reported.costSource, "providerReported");
  assert.equal(reported.costUsd, 1.25);
  assert.equal(reported.categoryCostUsd, undefined);
});

test("mixed priced and unpriced records retain both token totals and unpriced counts", () => {
  const a = record({ model: "unknown", reportedCostUsd: 1.5 });
  const b = record({ model: "unknown", reportedCostUsd: null, sessionId: "another" });
  const bucket = aggregateUsage([scan([a, b])], input, { table: rates }).buckets[0]!;
  assert.equal(bucket.costSource, "modelPriced");
  assert.equal(bucket.costUsd, 1.5);
  assert.equal(bucket.unpricedRecords, 1);
  assert.equal(bucket.records, 2);
  assert.equal(bucket.totals.outputTokens, 100);
  assert.equal(bucket.sessions, 2);
});

test("mixed buckets expose exact reported provenance and preserve unsplit Other cost", () => {
  const bucket = aggregateUsage([scan([
    record({ model: "unknown", reportedCostUsd: 2 }),
    record({ model: "unknown", reportedCostUsd: 0 }),
    record({ model: "unknown" }),
  ])], input, { table: rates }).buckets[0]!;
  assert.equal(bucket.records, 3);
  assert.equal(bucket.providerReportedRecords, 2);
  assert.equal(bucket.unpricedRecords, 1);
  assert.equal(bucket.costUsd, 2);
  assert.equal(bucket.categoryCostUsd, undefined);
});

test("source sessions stay distinct across day/model buckets and partial native/ledger contributions", () => {
  const native = scan([record({ provider: "codex", model: "first", sessionId: "shared" }),
    record({ provider: "codex", model: "second", sessionId: "shared", timestampMs: Date.parse("2026-08-08T04:00:00Z") })],
    { fingerprint: { hostId: "local", provider: "codex", resolvedHomePath: "/native", volumeId: "1" } });
  const ledger = scan([record({ provider: "codex", sessionId: "shared" }), record({ provider: "codex", sessionId: "ledger-only" })],
    { fingerprint: { hostId: "local", provider: "codex", resolvedHomePath: "ledger:one", volumeId: "ledger" } });
  const result = aggregateUsage([ledger, native], input, { table: rates });
  assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.records, 0), 4);
  assert.equal(result.sources.reduce((sum, source) => sum + source.distinctSessions, 0), 2);
  assert.equal(result.sources.find((source) => source.fingerprint.volumeId === "ledger")!.distinctSessions, 1);
  const otherInstance = { ...ledger, source: { ...ledger.source, instanceIds: ["unrelated"] } };
  assert.equal(aggregateUsage([otherInstance, native], input, { table: rates }).sources.reduce((sum, source) => sum + source.distinctSessions, 0), 3);
});

test("equivalent source merges preserve partial/refreshing diagnostics instead of reporting complete", () => {
  const first = scan([record()]);
  const partial = scan([record()], { status: "partial", refreshing: true, message: "history is incomplete" });
  const source = aggregateUsage([first, partial], input, { table: rates }).sources[0]!;
  assert.equal(source.status, "partial");
  assert.equal(source.refreshing, true);
  assert.equal(source.message, "history is incomplete");
});

test("hour buckets preserve midnight splits, exact bounds and daily totals without losing tokens", () => {
  const values = ["2026-10-29T23:44:59.999Z", "2026-10-29T23:45:00Z", "2026-10-30T00:15:00Z", "2026-10-30T00:45:00Z"].map((timestamp) => record({ timestampMs: Date.parse(timestamp) }));
  const hourly = aggregateUsage([scan(values)], { sinceDay: "2026-10-29", untilDay: "2026-10-30", timeZone: "UTC",
    resolution: "hour", sinceTime: "2026-10-29T23:45:00Z", untilTime: "2026-10-30T00:45:00Z" }, { table: rates });
  assert.deepEqual(hourly.buckets.map((bucket) => [bucket.day, bucket.hourStart, bucket.records]), [
    ["2026-10-29", "2026-10-29T23:45:00.000Z", 1], ["2026-10-30", "2026-10-29T23:45:00.000Z", 1],
  ]);
  const daily = aggregateUsage([scan(values.slice(1, 3))], { sinceDay: "2026-10-29", untilDay: "2026-10-30", timeZone: "UTC" }, { table: rates });
  near(hourly.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0), daily.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0));
  assert.equal(hourly.sources[0]!.distinctSessions, 1);
});
