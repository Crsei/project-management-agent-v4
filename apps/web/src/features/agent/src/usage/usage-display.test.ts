import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate } from "./page-data.ts";
import { formatUsageCost, formatUsageCount, formatUsageMoney, formatUsageShare } from "./usage-display.ts";

test("compact counts retain distinct token units and tiny positive shares", () => {
  assert.equal(formatUsageCount(418_000_000), "418M");
  assert.equal(formatUsageCount(2_390_000), "2.39M");
  assert.equal(formatUsageCount(157_000), "157K");
  assert.equal(formatUsageCount(1_200_000_000), "1.2B");
  assert.equal(formatUsageShare(0.00001), "<0.1%");
  assert.equal(formatUsageShare(null), "—");
});

test("unknown cost remains distinct from a genuinely priced zero", () => {
  const empty = aggregate([]);
  assert.equal(formatUsageCost({ ...empty, records: 1, unpriced: 1 }), "未定价");
  assert.equal(formatUsageCost({ ...empty, records: 1 }), "$0.00");
  assert.equal(formatUsageCost({ ...empty, records: 2, unpriced: 1, cost: 0.96 }), "$0.96 + 未定价");
  assert.equal(formatUsageMoney(0.0002), "<$0.01");
});
