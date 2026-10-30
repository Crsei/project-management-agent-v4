// Usage breakdown adapted from t3code usageBreakdown.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { UsageModelView } from "./usage-view-model";
import { tokenTotal } from "./page-data.ts";

/** Selection and totals come from the same shared view as the overview and table. */
export function modelDetailData(model: UsageModelView) {
  const rows = model.buckets;
  const totals = model.totals;
  const input = totals.input + totals.cacheRead + totals.cacheWrite;
  const unknown = totals.unpriced > 0 || rows.some(row => row.costSource === "unpriced");
  const entirelyUnpriced = model.costShare === null;
  // A mixed bucket has no priced-token count, so its realized rate cannot be recovered.
  const mixed = rows.some(row => row.unpricedRecords > 0 && row.unpricedRecords < row.records);
  let pricedTokens = 0;
  let pricedCost = 0;
  for (const row of rows) {
    if (row.unpricedRecords !== 0 || row.costSource === "unpriced") continue;
    pricedTokens += tokenTotal(row);
    pricedCost += row.costUsd;
  }
  return { rows, totals, unknown, entirelyUnpriced, mixed,
    cacheHit: input ? totals.cacheRead / input : null,
    perMillion: !mixed && pricedTokens > 0 ? pricedCost * 1_000_000 / pricedTokens : null };
}
