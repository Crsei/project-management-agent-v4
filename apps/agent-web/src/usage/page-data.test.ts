// Usage presentation adapted from t3code usageBreakdown.ts and usageLimits.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageBucket, UsageLimitsReport } from "@agent-workspace/contracts/usage";
import { accountMatchesInstance, aggregate, countdown, dedupeAccounts, effectiveWindow, summaryInput, tokenTotal } from "./page-data.ts";

const bucket: UsageBucket = { day: "2026-03-08", provider: "codex", model: "test", totals: { uncachedInputTokens: 10, cachedInputTokens: 20, cacheCreationTokens: 5, outputTokens: 8, reasoningTokens: 6 }, costUsd: 3, cacheSavingsUsd: 1, costSource: "providerReported", records: 2, unpricedRecords: 1, sessions: 1 };
const account: UsageLimitsReport["accounts"][number] = { id: "one", driver: "codex", label: "first", email: "USER@example.test", instanceId: "i1", limits: { checkedAt: "2026-01-01T00:00:00Z", windows: [ { id: "primary", kind: "session", label: "Session", usedPercent: 30, resetsAt: "2026-01-01T05:00:00Z" }, { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 100, resetsAt: "2026-01-02T00:00:00Z" } ] } };

test("24 hours is an exact interval across DST, and calendar ranges include today", () => {
  const now = new Date("2026-03-08T12:00:00Z");
  const day = summaryInput(1, "America/New_York", "i1", now);
  assert.equal(day.sinceTime, "2026-03-07T12:00:00.000Z");
  assert.equal(day.untilTime, "2026-03-08T12:00:00.000Z");
  assert.equal(day.resolution, "hour");
  assert.deepEqual(day.instanceIds, ["i1"]);
  const week = summaryInput(7, "America/New_York", "", now);
  assert.equal(week.sinceDay, "2026-03-02");
  assert.equal(week.untilDay, "2026-03-08");
  assert.equal(week.sinceTime, undefined);
});

test("reasoning is not double counted, and reported unsplit cost remains visible", () => {
  assert.equal(tokenTotal(bucket), 43);
  const result = aggregate([bucket, { ...bucket, costUsd: 2, categoryCostUsd: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, fastCostUsd: 2, speedPremiumUsd: .5 }]);
  assert.equal(result.tokens, 86);
  assert.equal(result.reasoning, 12);
  assert.equal(result.cost, 5);
  assert.equal(result.costOther, 3);
  assert.equal(result.unpriced, 2);
  assert.equal(result.premium, .5);
  assert.equal(aggregate([{ ...bucket, costUsd: 5, categoryCostUsd: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } }]).costOther, 3);
});

test("accounts deduplicate by provider and normalized identity, not across providers", () => {
  const duplicate = { ...account, id: "two", email: "user@example.test", limits: { ...account.limits, checkedAt: "2026-01-01T01:00:00Z", resetCredits: { availableCount: 1 } }, resetCreditInput: { sourceId: "hub", accountId: "a", creditId: "c" } };
  const other = { ...duplicate, id: "three", driver: "claude" as const };
  const result = dedupeAccounts([account, duplicate, other]);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.id, "two");
  assert.deepEqual(result[0]?.resetCreditInput, duplicate.resetCreditInput);
});

test("email bridges a fingerprint-only account and sparse windows survive merging", () => {
  const native = { ...account, email: undefined, limits: { ...account.limits, credentialFingerprint: "fp" } };
  const hub = { ...account, id: "hub", limits: { ...account.limits, credentialFingerprint: "fp", checkedAt: "2026-01-01T01:00:00Z", windows: [account.limits.windows[1]!] } };
  const merged = dedupeAccounts([native, hub]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.limits.windows.map(window => window.id), ["primary", "secondary"]);
});

test("a newer unsupported result does not retain old windows", () => {
  const unsupported = { ...account, id: "new", limits: { checkedAt: "2026-01-03T00:00:00Z", windows: [], unavailable: { reason: "unsupported" as const } } };
  const merged = dedupeAccounts([account, unsupported]);
  assert.deepEqual(merged[0]?.limits.windows, []);
  assert.equal(merged[0]?.limits.unavailable?.reason, "unsupported");
});

test("shared email does not merge different workspaces or ambiguous reports", () => {
  const first = { ...account, limits: { ...account.limits, account: { workspaceId: "one" } } };
  const second = { ...account, id: "two", limits: { ...account.limits, account: { workspaceId: "two" } } };
  const ambiguous = { ...account, id: "three" };
  assert.equal(dedupeAccounts([first, second, ambiguous]).length, 3);
  assert.equal(dedupeAccounts([first, ambiguous]).length, 1);
});

test("instance filtering includes all deduplicated instance IDs", () => {
  const merged = { ...account, instanceIds: ["i1", "i2"] };
  assert.equal(accountMatchesInstance(merged, ""), true);
  assert.equal(accountMatchesInstance(merged, "i2"), true);
  assert.equal(accountMatchesInstance(merged, "other"), false);
});

test("weekly exhaustion suppresses session and computes actual next refill", () => {
  const now = Date.parse("2026-01-01T02:00:00Z");
  const session = account.limits.windows[0]!;
  assert.deepEqual(effectiveWindow(account, session, now), { remaining: 0, resetsAt: "2026-01-02T00:00:00Z", refill: 100, blocked: true });
  const later = { ...session, resetsAt: "2026-01-03T00:00:00Z" };
  assert.equal(effectiveWindow(account, later, now).refill, 70);
  assert.equal(effectiveWindow(account, { ...session, resetsAt: undefined }, now).resetsAt, undefined);
  assert.equal(effectiveWindow(account, session, Date.parse("2026-01-04T00:00:00Z")).resetsAt, undefined);
  const modelSpecific = { ...account, driver: "claude" as const, limits: { ...account.limits, windows: [session, { ...account.limits.windows[1]!, id: "seven_day_sonnet" }] } };
  assert.equal(effectiveWindow(modelSpecific, session, now).remaining, 70);
});

test("countdown distinguishes unknown and stale reset timestamps", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(countdown(undefined, now), "重置时间未知");
  assert.equal(countdown("not-a-date", now), "重置时间未知");
  assert.equal(countdown("2025-12-31T23:59:00Z", now), "重置时间已过，等待刷新");
  assert.equal(countdown("2026-01-02T01:01:00Z", now), "1天 1小时 1分钟后");
});
