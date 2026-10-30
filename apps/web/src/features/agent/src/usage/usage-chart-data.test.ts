import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageBucket, UsageSummaryInput } from "@agent-workspace/contracts/usage";
import { buildUsageChart, combineChartValues } from "./usage-chart-data.ts";

const input: UsageSummaryInput = { sinceDay: "2026-10-01", untilDay: "2026-10-03", timeZone: "UTC", resolution: "day" };
const bucket: UsageBucket = { day: "2026-10-02", provider: "codex", model: "one", totals: { uncachedInputTokens: 10, cachedInputTokens: 20, cacheCreationTokens: 30, outputTokens: 40, reasoningTokens: 15 }, costUsd: 4, cacheSavingsUsd: 0, costSource: "modelPriced", records: 1, unpricedRecords: 0, sessions: 1 };

test("provider curves combine models, include the entire selected axis, and scale to a series rather than a stack", () => {
  const result = buildUsageChart([bucket, { ...bucket, model: "two", costUsd: 2 }, { ...bucket, provider: "opencode", costUsd: 5 }, { ...bucket, day: "2026-10-04", costUsd: 100 }], "cost", input);
  assert.deepEqual(result.providers, ["codex", "opencode"]);
  assert.deepEqual(result.columns.map(column => column.key), ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.equal(result.columns[1]!.values.get("codex")!.value, 6);
  assert.equal(result.peak, 6);
  assert.equal(result.columns[0]!.values.get("codex")!.value, 0);
  assert.equal(result.columns[2]!.values.get("opencode")!.value, 0);
  const tokens = buildUsageChart([bucket], "tokens", input);
  assert.equal(tokens.peak, 100, "reasoning is already included in output");
});

test("partial and refreshing missing periods remain unknown instead of connecting a false zero", () => {
  const partial = buildUsageChart([bucket], "tokens", input, true);
  assert.equal(partial.columns[0]!.values.get("codex")!.value, null);
  assert.equal(partial.columns[1]!.values.get("codex")!.value, 100);
  assert.equal(partial.columns[1]!.values.get("codex")!.incomplete, true);
  assert.equal(partial.columns[2]!.values.get("codex")!.value, null);
  const refreshing = buildUsageChart([bucket], "cost", input, false, ["opencode"]);
  assert.equal(refreshing.columns[0]!.values.get("codex")!.value, 0);
  assert.equal(refreshing.columns[0]!.values.get("opencode")!.value, null);
  assert.equal(combineChartValues([...refreshing.columns[1]!.values.values()]).incomplete, true);
});

test("unknown pricing stays distinct from true free cost, and mixed totals retain their unknown remainder", () => {
  const unpriced = { ...bucket, costUsd: 0, costSource: "unpriced" as const, unpricedRecords: 1 };
  const result = buildUsageChart([unpriced], "cost", input);
  assert.equal(result.columns[1]!.values.get("codex")!.value, null);
  assert.equal(result.columns[1]!.values.get("codex")!.unknownCost, true);
  assert.equal(buildUsageChart([{ ...bucket, costUsd: 0 }], "cost", input).columns[1]!.values.get("codex")!.value, 0);
  const mixed = buildUsageChart([bucket, { ...unpriced, model: "unknown" }], "cost", input).columns[1]!.values.get("codex")!;
  assert.equal(mixed.value, 4);
  assert.equal(mixed.unpriced, 1);
  assert.equal(mixed.unknownCost, true);
  assert.equal(buildUsageChart([unpriced], "tokens", input).columns[1]!.values.get("codex")!.value, 100);
});

test("hourly axes use exact sinceTime offsets across DST and never include untilTime", () => {
  const hourly: UsageSummaryInput = { sinceDay: "2026-11-01", untilDay: "2026-11-01", resolution: "hour", timeZone: "America/New_York", sinceTime: "2026-11-01T04:17:00.000Z", untilTime: "2026-11-01T08:17:00.000Z" };
  const rows = ["2026-11-01T05:17:00.000Z", "2026-11-01T06:17:00.000Z", hourly.untilTime!].map(hourStart => ({ ...bucket, day: "2026-11-01", hourStart }));
  const result = buildUsageChart(rows, "tokens", hourly);
  assert.deepEqual(result.columns.map(column => column.key), ["2026-11-01T04:17:00.000Z", "2026-11-01T05:17:00.000Z", "2026-11-01T06:17:00.000Z", "2026-11-01T07:17:00.000Z"]);
  assert.equal(result.columns[1]!.values.get("codex")!.value, 100);
  assert.equal(result.columns[2]!.values.get("codex")!.value, 100);
  assert.equal(result.columns[3]!.values.get("codex")!.value, 0);
});

test("the model-detail fallback explicitly derives its observed range but never expands an explicit invalid query", () => {
  const result = buildUsageChart([bucket, { ...bucket, day: "2026-10-04" }], "tokens");
  assert.equal(result.observedRange, true);
  assert.deepEqual(result.columns.map(column => column.day), ["2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.deepEqual(buildUsageChart([bucket], "tokens", { ...input, untilDay: "2026-09-30" }).columns, []);
});
