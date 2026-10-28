// Usage presentation adapted from t3code usageBreakdown.ts and usageLimits.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { ServerProviderUsageWindow, UsageBucket, UsageLimitsReport, UsageSummaryInput } from "@agent-workspace/contracts/usage";

export type Period = 1 | 7 | 30 | 90;
export type LimitAccount = UsageLimitsReport["accounts"][number];

export function accountMatchesInstance(account: LimitAccount, instanceId: string): boolean {
  return !instanceId || account.instanceId === instanceId || account.instanceIds?.includes(instanceId) === true;
}

function dayAt(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (name: string) => parts.find(part => part.type === name)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function summaryInput(period: Period, timeZone: string, instanceId: string, now = new Date()): UsageSummaryInput {
  const untilDay = dayAt(now, timeZone);
  // Calendar-day windows are inclusive. 24h instead uses exact instants across DST.
  const date = new Date(`${untilDay}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (period - 1));
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return { sinceDay: period === 1 ? dayAt(since, timeZone) : date.toISOString().slice(0, 10), untilDay, timeZone,
    resolution: period === 1 ? "hour" : "day", ...(period === 1 ? { sinceTime: since.toISOString(), untilTime: now.toISOString() } : {}),
    ...(instanceId ? { instanceIds: [instanceId] } : {}) };
}

export function tokenTotal(bucket: UsageBucket): number {
  const t = bucket.totals;
  return t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens + t.outputTokens;
}

export function aggregate(buckets: readonly UsageBucket[]) {
  const result = { tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0, savings: 0, unpriced: 0, records: 0,
    costInput: 0, costRead: 0, costWrite: 0, costOutput: 0, costOther: 0, fast: 0, ultrafast: 0, premium: 0 };
  for (const b of buckets) {
    result.tokens += tokenTotal(b); result.input += b.totals.uncachedInputTokens; result.cacheRead += b.totals.cachedInputTokens;
    result.cacheWrite += b.totals.cacheCreationTokens; result.output += b.totals.outputTokens; result.reasoning += b.totals.reasoningTokens;
    result.cost += b.costUsd; result.savings += b.cacheSavingsUsd; result.unpriced += b.unpricedRecords; result.records += b.records;
    if (b.categoryCostUsd) {
      result.costInput += b.categoryCostUsd.input; result.costRead += b.categoryCostUsd.cacheRead; result.costWrite += b.categoryCostUsd.cacheWrite; result.costOutput += b.categoryCostUsd.output;
      result.costOther += Math.max(0, b.costUsd - b.categoryCostUsd.input - b.categoryCostUsd.cacheRead - b.categoryCostUsd.cacheWrite - b.categoryCostUsd.output);
    } else result.costOther += b.costUsd;
    result.fast += b.fastCostUsd ?? 0; result.ultrafast += b.ultrafastCostUsd ?? 0; result.premium += b.speedPremiumUsd ?? 0;
  }
  return result;
}

export function dedupeAccounts(accounts: readonly LimitAccount[]): LimitAccount[] {
  const byKey = new Map<string, LimitAccount>();
  const fingerprintEmails = new Map<string, Set<string>>();
  for (const account of accounts) {
    const fingerprint = account.limits.credentialFingerprint;
    const email = (account.email ?? account.limits.account?.email)?.trim().toLowerCase();
    if (fingerprint && email) {
      const key = `${account.driver}:${fingerprint}`;
      const emails = fingerprintEmails.get(key) ?? new Set<string>();
      emails.add(email); fingerprintEmails.set(key, emails);
    }
  }
  const identityOf = (account: LimitAccount) => {
    const fingerprint = account.limits.credentialFingerprint;
    const emails = fingerprint ? fingerprintEmails.get(`${account.driver}:${fingerprint}`) : undefined;
    return (account.email ?? account.limits.account?.email)?.trim().toLowerCase() || (emails?.size === 1 ? [...emails][0] : undefined) || (fingerprint ? `credential:${fingerprint}` : account.limits.account?.id ? `account:${account.limits.account.id}` : `id:${account.id}`);
  };
  const workspaces = new Map<string, Set<string>>();
  for (const account of accounts) {
    const workspace = account.limits.account?.workspaceId;
    if (workspace) {
      const key = `${account.driver}:${identityOf(account)}`;
      const known = workspaces.get(key) ?? new Set<string>();
      known.add(workspace); workspaces.set(key, known);
    }
  }
  for (const account of accounts) {
    const identity = `${account.driver}:${identityOf(account)}`;
    const known = workspaces.get(identity);
    const workspace = account.limits.account?.workspaceId ?? (known?.size === 1 ? [...known][0] : undefined);
    const key = workspace ? `${identity}:workspace:${workspace}` : known && known.size > 1 ? `${identity}:ambiguous:${account.id}` : identity;
    const previous = byKey.get(key);
    if (!previous) { byKey.set(key, account); continue; }
    const latest = Date.parse(account.limits.checkedAt) > Date.parse(previous.limits.checkedAt) ? account : previous;
    const other = latest === account ? previous : account;
    const creditOwner = [account, previous].filter(item => item.limits.resetCredits).sort((a, b) => Date.parse(b.limits.checkedAt) - Date.parse(a.limits.checkedAt))[0];
    const hub = [account, previous].find(item => item.resetCreditInput && "sourceId" in item.resetCreditInput);
    const inherited = latest.limits.unavailable?.reason === "unsupported" ? [] : latest.limits.unavailable?.reason === "probeFailed"
      ? other.limits.windows.filter(window => !window.resetsAt || !Number.isFinite(Date.parse(window.resetsAt)) || Date.parse(window.resetsAt) > Date.now())
      : other.limits.windows;
    const windows = new Map(inherited.map(window => [window.id, window]));
    for (const window of latest.limits.windows) windows.set(window.id, window);
    byKey.set(key, { ...latest, email: latest.email ?? other.email, plan: latest.plan ?? other.plan, instanceIds: [...new Set([...(latest.instanceIds ?? []), ...(other.instanceIds ?? []), ...(latest.instanceId ? [latest.instanceId] : []), ...(other.instanceId ? [other.instanceId] : [])])], resetCreditInput: latest.limits.unavailable ? undefined : hub?.resetCreditInput ?? creditOwner?.resetCreditInput ?? latest.resetCreditInput ?? other.resetCreditInput,
      limits: { ...latest.limits, account: latest.limits.account ?? other.limits.account, windows: [...windows.values()], resetCredits: latest.limits.unavailable ? undefined : creditOwner?.limits.resetCredits } });
  }
  return [...byKey.values()];
}

export function effectiveWindow(account: LimitAccount, window: ServerProviderUsageWindow, now: number) {
  const weekly = window.kind === "session" && account.limits.windows.find(w => w.usedPercent >= 100 && (account.driver === "codex" ? w.kind === "weekly" : account.driver === "claude" && w.id === "seven_day"));
  if (!weekly) return { remaining: 100 - window.usedPercent, resetsAt: window.resetsAt, refill: window.usedPercent, blocked: false };
  const week = weekly.resetsAt ? Date.parse(weekly.resetsAt) : NaN;
  const session = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const cutoff = Math.max(now, Date.parse(account.limits.checkedAt) || 0);
  if (!(week > cutoff && session > cutoff)) return { remaining: 0, resetsAt: undefined, refill: 0, blocked: true };
  if (session <= week) return { remaining: 0, resetsAt: weekly.resetsAt, refill: 100, blocked: true };
  if (window.usedPercent >= 100) return { remaining: 0, resetsAt: window.resetsAt, refill: 100, blocked: true };
  return { remaining: 0, resetsAt: weekly.resetsAt, refill: 100 - window.usedPercent, blocked: true };
}

export function countdown(date: string | undefined, now: number): string {
  if (!date || !Number.isFinite(Date.parse(date))) return "重置时间未知";
  const minutes = Math.ceil((Date.parse(date) - now) / 60_000);
  if (minutes <= 0) return "重置时间已过，等待刷新";
  const days = Math.floor(minutes / 1440); const hours = Math.floor(minutes % 1440 / 60); const rest = minutes % 60;
  return `${days ? `${days}天 ` : ""}${hours ? `${hours}小时 ` : ""}${rest}分钟后`;
}
