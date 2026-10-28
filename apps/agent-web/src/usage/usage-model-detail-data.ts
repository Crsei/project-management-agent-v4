// Usage breakdown adapted from t3code usageBreakdown.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { UsageBucket } from "@agent-workspace/contracts/usage";
import { aggregate, tokenTotal } from "./page-data.ts";

export function modelDetailData(model: string | null, buckets: readonly UsageBucket[]) {
  const rows = model === null ? [] : buckets.filter(bucket => `${bucket.provider} / ${bucket.model}` === model);
  const totals = aggregate(rows);
  const input = totals.input + totals.cacheRead + totals.cacheWrite;
  const unknown = totals.unpriced > 0 || rows.some(row => row.costSource === "unpriced");
  const entirelyUnpriced = rows.length > 0 && rows.every(row => row.costSource === "unpriced" || (row.records > 0 && row.unpricedRecords === row.records));
  // A mixed bucket has no priced-token count, so its realized rate cannot be recovered.
  const mixed = rows.some(row => row.unpricedRecords > 0 && row.unpricedRecords < row.records);
  const pricedRows = rows.filter(row => row.unpricedRecords === 0 && row.costSource !== "unpriced");
  const pricedTokens = pricedRows.reduce((sum, row) => sum + tokenTotal(row), 0);
  const pricedCost = pricedRows.reduce((sum, row) => sum + row.costUsd, 0);
  return { rows, totals, unknown, entirelyUnpriced, mixed,
    cacheHit: input ? totals.cacheRead / input : null,
    perMillion: !mixed && pricedTokens > 0 ? pricedCost * 1_000_000 / pricedTokens : null };
}
