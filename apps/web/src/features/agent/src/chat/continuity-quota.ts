import type { QuotaRecovery } from "@agent-workspace/contracts/automation";
import type { ChatGenerationView } from "@agent-workspace/contracts/chat";

/**
 * Quota-reset scheduling is driven by the server: this browser only reads the
 * generation and recovery state, never re-dispatches the continuation.
 * Keep the timing rules pure so they can be tested without a UI.
 */

export const QUOTA_ACTIVE_POLL_MS = 2_000;
export const QUOTA_WAITING_POLL_MS = 30_000;
/** setTimeout cannot exceed a signed 32-bit millisecond count. */
export const QUOTA_MAX_TIMER_MS = 2_147_483_647;
export const QUOTA_SNOOZE_KEY_PREFIX = "agent-workspace.quota-snooze:";

export type QuotaText = (zh: string, en: string) => string;
export type QuotaSnooze = { runId: string; resetAt: string };
export type QuotaSnoozeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};
type QuotaGeneration = Pick<ChatGenerationView, "id" | "status" | "errorClass" | "resetAt">;
type QuotaRecoveryView = Pick<
  QuotaRecovery,
  "state" | "error" | "enabled" | "resetAt" | "continuationRunId"
>;

export function quotaSnoozeKey(threadId: string): string {
  return `${QUOTA_SNOOZE_KEY_PREFIX}${threadId}`;
}

/** A missing or unparsable reset time stays null: never invent a reset deadline. */
export function quotaResetTime(resetAt: string | null | undefined): number | null {
  if (!resetAt) return null;
  const value = Date.parse(resetAt);
  return Number.isFinite(value) ? value : null;
}

export function quotaResetReached(resetAt: string | null | undefined, now: number): boolean {
  const at = quotaResetTime(resetAt);
  return at !== null && now >= at;
}

export function quotaSnoozeTarget(latest: QuotaGeneration | null): QuotaSnooze | null {
  if (!latest || latest.errorClass !== "usage_limit") return null;
  if (quotaResetTime(latest.resetAt) === null) return null;
  return { runId: latest.id, resetAt: latest.resetAt! };
}

export function quotaSnoozeActive(
  snooze: QuotaSnooze | null | undefined,
  latest: QuotaGeneration | null,
  now: number,
): boolean {
  if (!snooze || !latest) return false;
  if (snooze.runId !== latest.id || snooze.resetAt !== latest.resetAt) return false;
  const at = quotaResetTime(snooze.resetAt);
  return at !== null && now < at;
}

/** Snooze belongs to one session and one failed generation; anything else is stale. */
export function readQuotaSnooze(
  storage: QuotaSnoozeStorage,
  threadId: string,
  latest: QuotaGeneration | null,
  now: number,
): QuotaSnooze | null {
  if (!threadId) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(quotaSnoozeKey(threadId));
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as { runId?: unknown; resetAt?: unknown };
  if (typeof candidate.runId !== "string" || typeof candidate.resetAt !== "string") return null;
  const snooze: QuotaSnooze = { runId: candidate.runId, resetAt: candidate.resetAt };
  return quotaSnoozeActive(snooze, latest, now) ? snooze : null;
}

export function writeQuotaSnooze(
  storage: QuotaSnoozeStorage,
  threadId: string,
  snooze: QuotaSnooze,
): void {
  try {
    storage.setItem(quotaSnoozeKey(threadId), JSON.stringify(snooze));
  } catch {
    /* A blocked storage write only loses the dismissal; state stays visible. */
  }
}

export function clearQuotaSnooze(storage: QuotaSnoozeStorage, threadId: string): void {
  try {
    storage.removeItem(quotaSnoozeKey(threadId));
  } catch {
    /* Ignore; a stale value is ignored by readQuotaSnooze anyway. */
  }
}

export function formatQuotaCountdown(remainingMs: number, t: QuotaText): string {
  if (!Number.isFinite(remainingMs)) return t("重置时间未知", "Reset time unknown");
  if (remainingMs <= 0) return t("已到重置时间", "Reset time reached");
  const total = Math.ceil(remainingMs / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (days > 0) return t(`${days} 天 ${hours} 小时`, `${days}d ${hours}h`);
  if (hours > 0) return t(`${hours} 小时 ${minutes} 分`, `${hours}h ${minutes}m`);
  if (minutes > 0) return t(`${minutes} 分 ${seconds} 秒`, `${minutes}m ${seconds}s`);
  return t(`${seconds} 秒`, `${seconds}s`);
}

/**
 * Poll cadence: active generations reconnect every 2s; an authorized recovery
 * polls slowly until reset, then fast enough to observe the dispatch. Without
 * authorization the only wake is the single timer at the reset deadline.
 */
export function quotaPollDelayMs(input: {
  hidden: boolean;
  latest: QuotaGeneration | null;
  recovery: QuotaRecoveryView | null;
  now: number;
}): number | null {
  const { hidden, latest, recovery, now } = input;
  if (hidden || !latest) return null;
  if (latest.status === "queued" || latest.status === "running") return QUOTA_ACTIVE_POLL_MS;
  if (latest.errorClass !== "usage_limit") return null;
  const at = quotaResetTime(recovery?.resetAt ?? latest.resetAt);
  if (at === null) return null;
  const waiting = recovery?.state === "waiting" && recovery.enabled;
  if (now >= at) {
    if (waiting || recovery?.state === "dispatched") return QUOTA_ACTIVE_POLL_MS;
    return null;
  }
  const remaining = at - now;
  if (waiting) return Math.min(remaining, QUOTA_WAITING_POLL_MS);
  return Math.min(remaining, QUOTA_MAX_TIMER_MS);
}

export type QuotaWakeAction = "none" | "reread" | "resume";

/**
 * What a due reset authorizes this browser to do: at most re-read state, or
 * attach to the continuation the server already dispatched. Never dispatch.
 */
export function quotaWakeAction(input: {
  latest: QuotaGeneration | null;
  recovery: QuotaRecoveryView | null;
  now: number;
}): QuotaWakeAction {
  const { latest, recovery, now } = input;
  if (!latest) return "none";
  const at = quotaResetTime(recovery?.resetAt ?? latest.resetAt);
  if (at === null || now < at) return "none";
  if (recovery?.state === "dispatched" && recovery.continuationRunId) return "resume";
  if (
    latest.errorClass === "usage_limit" &&
    (recovery?.enabled || recovery?.state === "waiting" || recovery?.state === "dispatched")
  )
    return "reread";
  return "none";
}

export type QuotaRecoveryFailure = { state: string; error: string | null };

const FAILED_RECOVERY_STATES: Record<string, true> = { blocked: true, failed: true, skipped: true };

/**
 * Backend `blocked` plus any recorded error is a failure; cancellation is not.
 * The state is typed as a string so a future or legacy failure state still surfaces.
 */
export function quotaRecoveryFailure(
  recovery: { state: string; error?: string | null } | null | undefined,
): QuotaRecoveryFailure | null {
  if (!recovery) return null;
  if (FAILED_RECOVERY_STATES[recovery.state] || recovery.error)
    return { state: recovery.state, error: recovery.error ?? null };
  return null;
}
