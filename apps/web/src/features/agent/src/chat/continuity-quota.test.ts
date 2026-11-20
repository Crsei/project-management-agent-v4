import assert from "node:assert/strict";
import test from "node:test";
import {
  QUOTA_ACTIVE_POLL_MS,
  QUOTA_WAITING_POLL_MS,
  formatQuotaCountdown,
  quotaPollDelayMs,
  quotaRecoveryFailure,
  quotaResetReached,
  quotaResetTime,
  quotaSnoozeActive,
  quotaSnoozeKey,
  quotaSnoozeTarget,
  quotaWakeAction,
  readQuotaSnooze,
  writeQuotaSnooze,
  clearQuotaSnooze,
} from "./continuity-quota.ts";

const en = (_zh: string, value: string) => value;
const now = Date.parse("2026-11-18T12:00:00.000Z");
const later = (ms: number) => new Date(now + ms).toISOString();

function failedGeneration(resetAt: string | undefined = later(60_000)) {
  return { id: "run-1", status: "failed" as const, errorClass: "usage_limit", resetAt };
}

function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}

test("countdown formats each unit and clamps at the reset boundary", () => {
  assert.equal(formatQuotaCountdown(-1, en), "Reset time reached");
  assert.equal(formatQuotaCountdown(0, en), "Reset time reached");
  assert.equal(formatQuotaCountdown(9_400, en), "10s");
  assert.equal(formatQuotaCountdown(3_604_000, en), "1h 0m");
  assert.equal(formatQuotaCountdown(125_000, en), "2m 5s");
  assert.equal(formatQuotaCountdown(93_600_000, en), "1d 2h");
  assert.equal(formatQuotaCountdown(Number.NaN, en), "Reset time unknown");
});

test("reset time parsing never invents a deadline", () => {
  assert.equal(quotaResetTime(undefined), null);
  assert.equal(quotaResetTime(null), null);
  assert.equal(quotaResetTime("not-a-date"), null);
  assert.equal(quotaResetTime("2026-11-18T12:01:00.000Z"), now + 60_000);
  assert.equal(quotaResetReached(later(-1), now), true);
  assert.equal(quotaResetReached(later(1), now), false);
  assert.equal(quotaResetReached(undefined, now), false);
});

test("snooze is per session and per failed generation", () => {
  assert.equal(quotaSnoozeKey("session-1"), "agent-workspace.quota-snooze:session-1");
  assert.notEqual(quotaSnoozeKey("session-1"), quotaSnoozeKey("session-2"));
  const generation = failedGeneration();
  assert.deepEqual(quotaSnoozeTarget(generation), { runId: "run-1", resetAt: generation.resetAt });
  assert.equal(quotaSnoozeTarget({ ...generation, resetAt: undefined }), null);
  assert.equal(quotaSnoozeTarget({ ...generation, errorClass: "network" }), null);

  const storage = memoryStorage();
  const target = quotaSnoozeTarget(generation)!;
  writeQuotaSnooze(storage, "session-1", target);
  assert.deepEqual(readQuotaSnooze(storage, "session-1", generation, now), target);
  assert.equal(readQuotaSnooze(storage, "session-2", generation, now), null);
  // A changed reset deadline invalidates the old dismissal.
  assert.equal(
    readQuotaSnooze(storage, "session-1", { ...generation, resetAt: later(120_000) }, now),
    null,
  );
  // A different failed run must resurface the banner.
  assert.equal(readQuotaSnooze(storage, "session-1", { ...generation, id: "run-2" }, now), null);
  // Reaching the reset restores the banner.
  assert.equal(readQuotaSnooze(storage, "session-1", generation, now + 60_000), null);
  clearQuotaSnooze(storage, "session-1");
  assert.equal(readQuotaSnooze(storage, "session-1", generation, now), null);
});

test("corrupt snooze records and blocked storage degrade to visible state", () => {
  const storage = memoryStorage();
  storage.setItem(quotaSnoozeKey("session-1"), "{");
  assert.equal(readQuotaSnooze(storage, "session-1", failedGeneration(), now), null);
  storage.setItem(quotaSnoozeKey("session-1"), JSON.stringify({ runId: 7, resetAt: true }));
  assert.equal(readQuotaSnooze(storage, "session-1", failedGeneration(), now), null);
  const hostile = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readQuotaSnooze(hostile, "session-1", failedGeneration(), now), null);
  writeQuotaSnooze(hostile, "session-1", quotaSnoozeTarget(failedGeneration())!);
  clearQuotaSnooze(hostile, "session-1");
});

test("poll cadence follows generation and recovery state", () => {
  const generation = failedGeneration();
  assert.equal(quotaPollDelayMs({ hidden: true, latest: generation, recovery: null, now }), null);
  assert.equal(quotaPollDelayMs({ hidden: false, latest: null, recovery: null, now }), null);
  assert.equal(
    quotaPollDelayMs({ hidden: false, latest: { ...generation, status: "running" }, recovery: null, now }),
    QUOTA_ACTIVE_POLL_MS,
  );
  assert.equal(
    quotaPollDelayMs({
      hidden: false,
      latest: generation,
      recovery: { state: "waiting", enabled: true, resetAt: generation.resetAt, error: undefined },
      now,
    }),
    Math.min(60_000, QUOTA_WAITING_POLL_MS),
  );
  // Unauthorized: only one wake timer, scheduled at the reset deadline.
  assert.equal(quotaPollDelayMs({ hidden: false, latest: generation, recovery: null, now }), 60_000);
  // A missing reset time cannot be scheduled.
  assert.equal(
    quotaPollDelayMs({ hidden: false, latest: { ...generation, resetAt: undefined }, recovery: null, now }),
    null,
  );
  // Due with an authorized recovery: watch quickly for dispatch or a block.
  assert.equal(
    quotaPollDelayMs({
      hidden: false,
      latest: generation,
      recovery: { state: "waiting", enabled: true, resetAt: generation.resetAt, error: undefined },
      now: now + 60_000,
    }),
    QUOTA_ACTIVE_POLL_MS,
  );
  assert.equal(
    quotaPollDelayMs({
      hidden: false,
      latest: generation,
      recovery: { state: "dispatched", enabled: false, resetAt: generation.resetAt, continuationRunId: "run-2" },
      now: now + 60_000,
    }),
    QUOTA_ACTIVE_POLL_MS,
  );
  // Due but never authorized: no continuous polling.
  assert.equal(quotaPollDelayMs({ hidden: false, latest: generation, recovery: null, now: now + 60_000 }), null);
});

test("wake action only rereads or resumes a server-dispatched continuation", () => {
  const generation = failedGeneration();
  assert.equal(quotaWakeAction({ latest: generation, recovery: null, now }), "none");
  assert.equal(
    quotaWakeAction({
      latest: generation,
      recovery: { state: "waiting", enabled: true, resetAt: generation.resetAt, error: undefined },
      now: now + 60_000,
    }),
    "reread",
  );
  assert.equal(
    quotaWakeAction({
      latest: generation,
      recovery: { state: "dispatched", enabled: false, resetAt: generation.resetAt, continuationRunId: "run-2" },
      now: now + 60_000,
    }),
    "resume",
  );
  assert.equal(
    quotaWakeAction({
      latest: { ...generation, id: "run-2", status: "running", resetAt: undefined },
      recovery: { state: "dispatched", enabled: false, resetAt: generation.resetAt, continuationRunId: "run-2" },
      now: now + 60_000,
    }),
    "resume",
  );
  // Not yet due: never act early.
  assert.equal(
    quotaWakeAction({
      latest: generation,
      recovery: { state: "dispatched", enabled: false, resetAt: generation.resetAt, continuationRunId: "run-2" },
      now,
    }),
    "none",
  );
});

test("recovery failures surface backend reason without treating cancellation as failure", () => {
  assert.equal(quotaRecoveryFailure(null), null);
  assert.equal(quotaRecoveryFailure({ state: "waiting" }), null);
  assert.equal(quotaRecoveryFailure({ state: "cancelled" }), null);
  assert.equal(quotaRecoveryFailure({ state: "dispatched" }), null);
  assert.deepEqual(quotaRecoveryFailure({ state: "blocked" }), { state: "blocked", error: null });
  assert.deepEqual(quotaRecoveryFailure({ state: "failed", error: "provider rejected" }), {
    state: "failed",
    error: "provider rejected",
  });
  assert.deepEqual(quotaRecoveryFailure({ state: "skipped" }), { state: "skipped", error: null });
  assert.deepEqual(quotaRecoveryFailure({ state: "waiting", error: "scope changed" }), {
    state: "waiting",
    error: "scope changed",
  });
  assert.equal(quotaSnoozeActive(null, failedGeneration(), now), false);
});
