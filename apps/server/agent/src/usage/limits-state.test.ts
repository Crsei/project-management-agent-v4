import assert from "node:assert/strict";
import test from "node:test";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@agent-workspace/contracts/usage";
import { accountMatchesInstance, applyUsageLimitsUpdate, collectLimitPools, dedupeAccounts, effectiveWindow, mergeUsageProbe, type LimitAccount } from "@agent-workspace/contracts/usage-limits";

const checkedAt = "2026-10-01T00:00:00.000Z";
const attemptedAt = "2026-10-01T00:05:00.000Z";
const session: ServerProviderUsageWindow = { id: "primary", kind: "session", label: "Session", usedPercent: 30, resetsAt: "2026-10-01T05:00:00.000Z", windowDurationMins: 300 };
const weekly: ServerProviderUsageWindow = { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 100, resetsAt: "2026-10-02T00:00:00.000Z" };
const published: ServerProviderUsageLimits = { checkedAt, windows: [session, weekly], account: { email: "one@example.test", workspaceId: "workspace-a" }, credentialFingerprint: "credential-a", resetCredits: { availableCount: 1, nextCreditId: "credit" } };
const account = (id: string, limits: ServerProviderUsageLimits = published): LimitAccount => ({ id, driver: "codex", label: id, email: "one@example.test", limits });

test("empty and identical native ticks are object-identity no-ops and sparse ticks retain clocks", () => {
  assert.equal(applyUsageLimitsUpdate(published, { windows: [] }, attemptedAt), published);
  assert.equal(applyUsageLimitsUpdate(published, { windows: [{ ...session, resetsAt: undefined, windowDurationMins: undefined }] }, attemptedAt), published);
  const changed = applyUsageLimitsUpdate(published, { windows: [{ ...session, usedPercent: 40, resetsAt: undefined }] }, attemptedAt)!;
  assert.equal(changed.checkedAt, attemptedAt);
  assert.equal(changed.windows[0]?.resetsAt, session.resetsAt);
  assert.equal(changed.windows[1], weekly);
  assert.deepEqual(changed.resetCredits, published.resetCredits);
});

test("a failed probe retains the data time, removes expired windows, and remains visibly failed until a successful probe", () => {
  const failed = mergeUsageProbe(published, { checkedAt: attemptedAt, windows: [], account: { email: "one@example.test" }, unavailable: { reason: "probeFailed", message: "Controlled failure" } }, { now: Date.parse("2026-10-01T06:00:00Z") });
  assert.equal(failed.checkedAt, checkedAt);
  assert.equal(failed.lastProbeAt, attemptedAt);
  assert.deepEqual(failed.account, published.account);
  assert.deepEqual(failed.windows, [weekly]);
  assert.equal(failed.unavailable?.reason, "probeFailed");
  const tick = applyUsageLimitsUpdate(failed, { windows: [{ ...weekly, usedPercent: 90 }] }, "2026-10-01T06:01:00Z")!;
  assert.equal(tick.unavailable?.reason, "probeFailed");
  const restored = mergeUsageProbe(tick, { ...published, checkedAt: "2026-10-01T06:02:00Z" }, { now: Date.parse(attemptedAt) });
  assert.equal(restored.unavailable, undefined);
});

test("complete probe omissions replace windows while older probes cannot erase newer native telemetry", () => {
  const complete = mergeUsageProbe(published, { ...published, checkedAt: attemptedAt, windows: [weekly] }, { now: Date.parse(attemptedAt) });
  assert.deepEqual(complete.windows, [weekly]);
  const empty = mergeUsageProbe(published, { ...published, checkedAt: attemptedAt, windows: [] }, { now: Date.parse(attemptedAt) });
  assert.deepEqual(empty.windows, []);
  const live = { ...published, checkedAt: attemptedAt, windows: [{ ...session, usedPercent: 70 }] };
  const slow = mergeUsageProbe(live, { ...published, checkedAt: "2026-10-01T00:06:00Z", resetCredits: { availableCount: 2 } }, { now: Date.parse(attemptedAt), preservePublishedWindows: true });
  assert.equal(slow.checkedAt, live.checkedAt);
  assert.equal(slow.windows, live.windows);
  assert.equal(slow.resetCredits?.availableCount, 2);
});

test("account and workspace changes cannot inherit old quota, credits, or live windows", () => {
  for (const identity of [{ account: { email: "different@example.test" } }, { account: { workspaceId: "workspace-b" } }, { account: { id: "new" }, credentialFingerprint: "credential-b" }]) {
    const failed = mergeUsageProbe(published, { checkedAt: attemptedAt, windows: [], ...identity, unavailable: { reason: "probeFailed" } }, { now: Date.parse(attemptedAt), preservePublishedWindows: true });
    assert.deepEqual(failed.windows, []);
    assert.equal(failed.resetCredits, undefined);
    assert.equal(failed.checkedAt, attemptedAt);
  }
});

test("explicit unsupported probes invalidate account endpoints but Muse keeps its real runtime-only reports", () => {
  const unsupported: ServerProviderUsageLimits = { checkedAt: attemptedAt, windows: [], unavailable: { reason: "unsupported" } };
  const endpoint = mergeUsageProbe(published, unsupported, { now: Date.parse(attemptedAt) });
  assert.deepEqual(endpoint.windows, []);
  assert.equal(applyUsageLimitsUpdate(endpoint, { windows: [session] }, attemptedAt), endpoint);
  const muse = applyUsageLimitsUpdate(unsupported, { windows: [session] }, attemptedAt, true)!;
  assert.equal(muse.unavailable, undefined);
  const refreshed = mergeUsageProbe(muse, unsupported, { now: Date.parse(attemptedAt), runtimeOnly: true });
  assert.deepEqual(refreshed.windows, [session]);
  assert.equal(refreshed.unavailable, undefined);
});

test("pooling resolves all account copies at once, keeps ambiguous workspace identities separate, and prefers usable reports", () => {
  const first = { ...account("native"), instanceId: "instance-a" };
  const hub = { ...account("hub", { ...published, checkedAt: attemptedAt, windows: [weekly] }), resetCreditInput: { sourceId: "hub", accountId: "auth", creditId: "credit" }, sourceLabel: "Hub" };
  const failed = account("failed", { ...published, checkedAt: "2026-10-01T00:10:00Z", windows: [], unavailable: { reason: "probeFailed" } });
  const merged = dedupeAccounts([first, hub, failed]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.limits.unavailable, undefined);
  assert.deepEqual(merged[0]?.limits.windows, [session, weekly]);
  assert.deepEqual(merged[0]?.resetCreditInput, hub.resetCreditInput);
  assert.equal(accountMatchesInstance(merged[0]!, "instance-a"), true);
  assert.equal(effectiveWindow(merged[0]!, session, Date.parse(attemptedAt)).remaining, 0);
  const differentWorkspace = account("second-workspace", { ...published, account: { email: "one@example.test", workspaceId: "workspace-b" } });
  const ambiguous = account("ambiguous", { ...published, account: { email: "one@example.test" } });
  assert.equal(dedupeAccounts([first, differentWorkspace, ambiguous]).length, 3);
});

test("fresh zero credits suppress stale hub actions and source-order does not choose credit balance", () => {
  const hub = { ...account("hub"), resetCreditInput: { sourceId: "hub", accountId: "auth", creditId: "credit" } };
  const newest = { ...account("native", { ...published, checkedAt: attemptedAt, resetCredits: { availableCount: 0 } }), instanceId: "native", resetCreditInput: { instanceId: "native" } };
  for (const members of [[hub, newest], [newest, hub]]) {
    const merged = dedupeAccounts(members)[0]!;
    assert.equal(merged.limits.resetCredits?.availableCount, 0);
    assert.equal(merged.resetCreditInput, undefined);
  }
  const nativeCredit = { ...newest, limits: { ...newest.limits, resetCredits: { availableCount: 4 } } };
  const merged = dedupeAccounts([hub, nativeCredit])[0]!;
  assert.equal(merged.limits.resetCredits?.availableCount, 4);
  assert.deepEqual(merged.resetCreditInput, hub.resetCreditInput);
});

test("Codex weekly slots pool by kind and missing windows do not masquerade as zero usage", () => {
  const first = account("paid", { checkedAt, windows: [{ ...weekly, usedPercent: 50 }] });
  const free = account("weekly-only", { checkedAt, windows: [{ ...weekly, id: "primary", usedPercent: 100 }] });
  const missing = account("missing", { checkedAt, windows: [] });
  const pool = collectLimitPools([first, free, missing], Date.parse(attemptedAt))[0]!;
  assert.equal(pool.accounts.length, 3);
  assert.equal(pool.windows.length, 1);
  assert.equal(pool.windows[0]?.rows.length, 2);
  assert.equal(pool.windows[0]?.remaining, 25);
  assert.equal(pool.windows[0]?.kind, "weekly");
  const other = collectLimitPools([{ ...first, driver: "claude" }, { ...free, driver: "claude" }], Date.parse(attemptedAt))[0]!;
  assert.equal(other.windows.length, 2); // Claude ids designate different allowances, not slots.
});

test("runtime-only Muse is usable without an endpoint, but an unchecked endpoint account is not verified by telemetry", () => {
  const unchecked = applyUsageLimitsUpdate(undefined, { windows: [session] }, checkedAt)!;
  assert.equal(unchecked.unavailable?.reason, "probeFailed");
  assert.equal(unchecked.lastProbeAt, undefined);
  assert.equal(unchecked.checkedAt, checkedAt);
  const muse = applyUsageLimitsUpdate(undefined, { windows: [session] }, checkedAt, true)!;
  assert.equal(muse.unavailable, undefined);
  assert.deepEqual(muse.windows, [session]);
});
