import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageBucket, UsageSource, UsageSummary } from "@agent-workspace/contracts/usage";
import { buildUsageView, usagePeriods } from "./usage-view-model.ts";
import { decodeUsageSummary } from "./usage-summary-data.ts";

const input = { sinceDay: "2026-03-07", untilDay: "2026-03-09", timeZone: "America/New_York" };
const source: UsageSource = { fingerprint: { hostId: "local", provider: "codex", resolvedHomePath: "/codex", volumeId: "1" }, status: "ok", scannedFiles: 2, skippedFiles: 0, malformedRecords: 0, distinctSessions: 3, message: null };
const bucket: UsageBucket = { day: "2026-03-08", provider: "codex", sourcePath: "/codex", model: "model", totals: { uncachedInputTokens: 10, cachedInputTokens: 20, cacheCreationTokens: 5, outputTokens: 8, reasoningTokens: 6 }, costUsd: 3, cacheSavingsUsd: 1, costSource: "modelPriced", providerReportedRecords: 1, records: 4, unpricedRecords: 1, sessions: 2 };
function summary(buckets: UsageBucket[] = [bucket], sources: UsageSource[] = [source]): UsageSummary {
  return { ...input, contractVersion: 6, readAt: "2026-03-10T00:00:00Z", buckets, sources, pricing: { status: "cached", source: "fixture", fetchedAt: null, knownModels: 1 }, scanDurationMs: 1 };
}

test("provider filter applies to sources, distinct sessions, quality and all breakdowns together", () => {
  const otherSource = { ...source, fingerprint: { ...source.fingerprint, provider: "claude" as const, resolvedHomePath: "/claude" }, distinctSessions: 9 };
  const other = { ...bucket, provider: "claude" as const, sourcePath: "/claude", costUsd: 100 };
  const view = buildUsageView(summary([bucket, { ...bucket, day: "2026-03-09" }, other], [source, otherSource]), input, ["claude"]);
  assert.equal(view.totals.cost, 6);
  assert.equal(view.totals.tokens, 86);
  assert.equal(view.sessions, 3); // Not 2+2 bucket sessions, and not the hidden source's 9.
  assert.equal(view.models[0]!.key, "codex\0model");
  assert.deepEqual(view.periods.map(row => row.totals.cost), [0, 3, 3]);
  assert.deepEqual(view.costQuality, { providerReportedShare: .25, modelPricedShare: .5, unpricedShare: .25 });
});

test("source ownership excludes orphan buckets and prefers a usable duplicate without double session counts", () => {
  const view = buildUsageView(summary([bucket, { ...bucket, sourcePath: "/other", costUsd: 99 }], [{ ...source, status: "failed", distinctSessions: 0 }, source]), input);
  assert.equal(view.totals.cost, 3);
  assert.equal(view.sessions, 3);
  assert.equal(view.partial, true);
  assert.match(view.warnings.join(" "), /来源/);
});

test("fully unpriced data has no cost share, while token participation remains visible", () => {
  const unknown = { ...bucket, costSource: "unpriced" as const, costUsd: 0, providerReportedRecords: 0, unpricedRecords: 4 };
  const view = buildUsageView(summary([unknown]), input);
  assert.equal(view.models[0]!.costShare, null);
  assert.equal(view.providers[0]!.costShare, null);
  assert.equal(view.models[0]!.tokenShare, 1);
  assert.equal(view.costQuality.unpricedShare, 1);
});

test("hour axis uses exact selected instants through both DST transitions", () => {
  for (const untilTime of ["2026-03-08T12:17:00Z", "2026-11-01T12:17:00Z"]) {
    const start = Date.parse(untilTime) - 86_400_000;
    const axis = usagePeriods({ ...input, resolution: "hour", sinceTime: new Date(start).toISOString(), untilTime });
    assert.equal(axis.length, 24);
    assert.equal(axis[0]!.hourStart, new Date(start).toISOString());
    assert.equal(new Set(axis.map(row => row.key)).size, 24);
    assert.equal(Date.parse(axis.at(-1)!.hourStart!) - start, 23 * 3_600_000);
  }
});

test("unknown providers are disclosed omissions, incompatible versions are not merged, malformed known data fails", () => {
  const futureProvider = { ...bucket, provider: "future-provider" };
  const decoded = decodeUsageSummary({ ...summary(), buckets: [bucket, futureProvider], sources: [source, { ...source, fingerprint: { ...source.fingerprint, provider: "future-provider" } }] });
  const view = buildUsageView(decoded, input);
  assert.equal(view.totals.cost, 3);
  assert.equal(view.partial, true);
  assert.match(view.warnings[0]!, /future-provider/);
  const incompatible = buildUsageView(decodeUsageSummary({ ...summary(), contractVersion: 99, buckets: [{ arbitrary: true }] }), input);
  assert.equal(incompatible.compatible, false);
  assert.equal(incompatible.totals.records, 0);
  assert.throws(() => decodeUsageSummary({ ...summary(), buckets: [{ ...bucket, costUsd: -1 }] }));
  const legacy = decodeUsageSummary({ ...summary([{ ...bucket, providerReportedRecords: undefined, costSource: "providerReported", unpricedRecords: 0 }]), contractVersion: 4 });
  assert.equal(buildUsageView(legacy, input).costQuality.providerReportedShare, 1);
});
