// Adapted from t3code provider-core/shared usageLimits.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { ProviderUsageLimitsUpdate, ServerProviderUsageLimits, ServerProviderUsageWindow, UsageLimitsReport } from "./usage.ts";

export type LimitAccount = UsageLimitsReport["accounts"][number];
const order = { session: 0, weekly: 1, monthly: 2, other: 3 };
const time = (value: string | undefined) => value ? Date.parse(value) || 0 : 0;
const email = (value: string | undefined) => value?.trim().toLowerCase() || undefined;
const windowEquals = (a: ServerProviderUsageWindow, b: ServerProviderUsageWindow) => a.id === b.id && a.kind === b.kind && a.label === b.label && a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt && a.windowDurationMins === b.windowDurationMins;
const sparseWindow = (old: ServerProviderUsageWindow | undefined, window: ServerProviderUsageWindow): ServerProviderUsageWindow => ({ ...old, ...window, ...(window.resetsAt === undefined && old?.resetsAt !== undefined ? { resetsAt: old.resetsAt } : {}), ...(window.windowDurationMins === undefined && old?.windowDurationMins !== undefined ? { windowDurationMins: old.windowDurationMins } : {}) });
const sortWindows = (windows: Iterable<ServerProviderUsageWindow>) => [...windows].sort((a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id));

/** Native events are sparse: omitted windows and omitted clocks retain their values. */
export function mergeUsageWindows(previous: readonly ServerProviderUsageWindow[], update: readonly ServerProviderUsageWindow[]): ServerProviderUsageWindow[] {
  const merged = new Map(previous.map(window => [window.id, window]));
  for (const window of update) merged.set(window.id, sparseWindow(merged.get(window.id), window));
  return sortWindows(merged.values());
}

export function usageLimitsIdentityChanged(previous: ServerProviderUsageLimits, next: ServerProviderUsageLimits): boolean {
  const differs = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a !== b;
  return differs(previous.credentialFingerprint, next.credentialFingerprint)
    || differs(previous.account?.id, next.account?.id)
    || differs(email(previous.account?.email), email(next.account?.email))
    || (next.account?.workspaceId !== undefined && next.account.workspaceId !== previous.account?.workspaceId);
}

export function applyUsageLimitsUpdate(previous: ServerProviderUsageLimits | undefined, update: ProviderUsageLimitsUpdate, checkedAt: string, runtimeOnly = false): ServerProviderUsageLimits | undefined {
  if (!update.windows.length || previous?.unavailable?.reason === "unsupported" && !runtimeOnly) return previous;
  const merged = new Map(previous?.windows.map(window => [window.id, window]));
  let changed = false;
  for (const window of update.windows) {
    const old = merged.get(window.id), next = sparseWindow(old, window);
    if (!old || !windowEquals(old, next)) { merged.set(window.id, next); changed = true; }
  }
  if (!changed && previous) return previous;
  const windows = sortWindows(merged.values());
  const { unavailable, ...retained }: ServerProviderUsageLimits = previous ?? { checkedAt, windows: [] };
  return { ...retained, checkedAt, windows, ...(!runtimeOnly ? { unavailable: unavailable ?? (previous ? undefined : { reason: "probeFailed" as const, message: "Runtime limits reported; the account has not yet been independently checked." }) } : {}) };
}

/** Probe results are complete snapshots, unlike runtime events. Failure never dates old data as fresh. */
export function mergeUsageProbe(previous: ServerProviderUsageLimits | undefined, next: ServerProviderUsageLimits, options: { now: number; preservePublishedWindows?: boolean; runtimeOnly?: boolean }): ServerProviderUsageLimits {
  const lastProbeAt = next.lastProbeAt ?? next.checkedAt;
  if (!previous || usageLimitsIdentityChanged(previous, next)) return { ...next, lastProbeAt };
  if (options.runtimeOnly && next.unavailable?.reason === "unsupported" && previous.windows.length && !previous.unavailable) return { ...previous, lastProbeAt };
  if (next.unavailable?.reason === "unsupported") return { ...next, lastProbeAt };
  const identity = { credentialFingerprint: next.credentialFingerprint ?? previous.credentialFingerprint, account: previous.account || next.account ? { ...previous.account, ...next.account } : undefined };
  if (next.unavailable?.reason === "probeFailed") return {
    ...previous, ...next, ...identity, lastProbeAt, checkedAt: previous.checkedAt,
    windows: previous.windows.filter(window => !window.resetsAt || !Number.isFinite(Date.parse(window.resetsAt)) || Date.parse(window.resetsAt) > options.now),
  };
  const newer = options.preservePublishedWindows || time(previous.checkedAt) > time(next.checkedAt);
  return { ...next, ...identity, lastProbeAt, ...(newer ? { checkedAt: previous.checkedAt, windows: previous.windows } : {}) };
}

export function accountMatchesInstance(account: { instanceId?: string; instanceIds?: readonly string[] }, instanceId: string): boolean {
  return !instanceId || account.instanceId === instanceId || account.instanceIds?.includes(instanceId) === true;
}

/** Resolve ambiguous identities before merging; an unscoped login never bridges two workspaces. */
export function dedupeAccounts(accounts: readonly LimitAccount[]): LimitAccount[] {
  const fingerprintEmails = new Map<string, Set<string>>();
  for (const account of accounts) {
    const fingerprint = account.limits.credentialFingerprint, normalized = email(account.email ?? account.limits.account?.email);
    if (fingerprint && normalized) {
      const key = `${account.driver}:${fingerprint}`, known = fingerprintEmails.get(key) ?? new Set<string>();
      known.add(normalized); fingerprintEmails.set(key, known);
    }
  }
  const identityOf = (account: LimitAccount) => {
    const fingerprint = account.limits.credentialFingerprint;
    const known = fingerprint ? fingerprintEmails.get(`${account.driver}:${fingerprint}`) : undefined;
    return email(account.email ?? account.limits.account?.email) ?? (known?.size === 1 ? [...known][0] : undefined)
      ?? (known && known.size > 1 ? `ambiguous:${account.id}` : fingerprint ? `credential:${fingerprint}` : account.limits.account?.id ? `account:${account.limits.account.id}` : `id:${account.id}`);
  };
  const workspaces = new Map<string, Set<string>>();
  const accountIds = new Map<string, Set<string>>();
  for (const account of accounts) {
    const key = `${account.driver}:${identityOf(account)}`;
    for (const [map, value] of [[workspaces, account.limits.account?.workspaceId], [accountIds, account.limits.account?.id]] as const) {
      if (value) { const known = map.get(key) ?? new Set<string>(); known.add(value); map.set(key, known); }
    }
  }
  const grouped = new Map<string, LimitAccount[]>();
  for (const account of accounts) {
    let key = `${account.driver}:${identityOf(account)}`;
    for (const [map, value, label] of [[workspaces, account.limits.account?.workspaceId, "workspace"], [accountIds, account.limits.account?.id, "account"]] as const) {
      const known = map.get(`${account.driver}:${identityOf(account)}`);
      const resolved = value ?? (known?.size === 1 ? [...known][0] : undefined);
      if (resolved) key += `:${label}:${resolved}`;
      else if (known && known.size > 1) key += `:ambiguous:${account.id}`;
    }
    const group = grouped.get(key) ?? []; group.push(account); grouped.set(key, group);
  }
  return [...grouped.values()].map(group => {
    // A failed/unsupported copy must not hide a usable report for the same subscription.
    const sorted = [...group].sort((a, b) => Number(Boolean(a.limits.unavailable)) - Number(Boolean(b.limits.unavailable)) || time(b.limits.checkedAt) - time(a.limits.checkedAt));
    const winner = sorted[0]!;
    const usable = sorted.filter(account => !account.limits.unavailable);
    const creditOwner = usable.filter(account => account.limits.resetCredits).sort((a, b) => time(b.limits.checkedAt) - time(a.limits.checkedAt))[0];
    const hub = usable.filter(account => account.resetCreditInput && "sourceId" in account.resetCreditInput && (account.limits.resetCredits?.availableCount ?? 0) > 0).sort((a, b) => time(b.limits.checkedAt) - time(a.limits.checkedAt))[0];
    const resetCreditInput = !winner.limits.unavailable && (creditOwner?.limits.resetCredits?.availableCount ?? 0) > 0
      ? hub?.resetCreditInput ?? creditOwner?.resetCreditInput : undefined;
    const windows = winner.limits.unavailable ? winner.limits.windows : usable.slice(1).reverse().reduce((windows, account) => mergeUsageWindows(windows, account.limits.windows), [] as ServerProviderUsageWindow[]);
    return {
      ...winner, email: winner.email ?? group.find(account => account.email)?.email, plan: winner.plan ?? group.find(account => account.plan)?.plan,
      instanceIds: [...new Set(group.flatMap(account => [...(account.instanceIds ?? []), ...(account.instanceId ? [account.instanceId] : [])]))],
      sourceLabel: hub?.sourceLabel ?? winner.sourceLabel, resetCreditInput,
      limits: { ...winner.limits, windows: winner.limits.unavailable ? windows : mergeUsageWindows(windows, winner.limits.windows), resetCredits: creditOwner?.limits.resetCredits },
    };
  });
}

export type EffectiveUsageWindow = { remaining: number; resetsAt: string | undefined; refill: number; blocked: boolean };

export function effectiveWindow(account: LimitAccount, window: ServerProviderUsageWindow, now: number): EffectiveUsageWindow {
  const weekly = window.kind === "session" && account.limits.windows.find(w => w.usedPercent >= 100 && (account.driver === "codex" ? w.kind === "weekly" : account.driver === "claude" && w.id === "seven_day"));
  if (!weekly) return { remaining: 100 - window.usedPercent, resetsAt: window.resetsAt, refill: window.usedPercent, blocked: false };
  const week = weekly.resetsAt ? Date.parse(weekly.resetsAt) : NaN;
  const session = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const cutoff = Math.max(now, time(account.limits.checkedAt));
  if (!(week > cutoff && session > cutoff)) return { remaining: 0, resetsAt: undefined, refill: 0, blocked: true };
  if (session <= week) return { remaining: 0, resetsAt: weekly.resetsAt, refill: 100, blocked: true };
  if (window.usedPercent >= 100) return { remaining: 0, resetsAt: window.resetsAt, refill: 100, blocked: true };
  return { remaining: 0, resetsAt: weekly.resetsAt, refill: 100 - window.usedPercent, blocked: true };
}

export function countdown(date: string | undefined, now: number): string {
  if (!date || !Number.isFinite(Date.parse(date))) return "重置时间未知";
  const minutes = Math.ceil((Date.parse(date) - now) / 60_000);
  if (minutes <= 0) return "重置时间已过，等待刷新";
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  return `${days ? `${days}天 ` : ""}${hours ? `${hours}小时 ` : ""}${rest}分钟后`;
}

export type LimitPoolWindow = {
  id: string; label: string; kind: ServerProviderUsageWindow["kind"]; remaining: number;
  rows: { account: LimitAccount; window: ServerProviderUsageWindow; effective: EffectiveUsageWindow }[];
};
export type LimitPool = { driver: LimitAccount["driver"]; accounts: LimitAccount[]; windows: LimitPoolWindow[] };

/** Missing windows stay absent from the denominator; Codex slot ids pool by actual duration kind. */
export function collectLimitPools(accounts: readonly LimitAccount[], now: number): LimitPool[] {
  const drivers = new Map<LimitAccount["driver"], LimitAccount[]>();
  const poolKey = (driver: LimitAccount["driver"], window: ServerProviderUsageWindow) => driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
  for (const account of accounts) {
    const members = drivers.get(account.driver) ?? []; members.push(account); drivers.set(account.driver, members);
  }
  return [...drivers].map(([driver, accounts]) => {
    const firstWindow = accounts.flatMap(account => account.limits.windows).sort((a, b) => order[a.kind] - order[b.kind])[0];
    const resetTime = (account: LimitAccount) => {
      const window = account.limits.windows.find(window => firstWindow && poolKey(driver, window) === poolKey(driver, firstWindow));
      const reset = window ? time(effectiveWindow(account, window, now).resetsAt) : 0;
      return reset > now ? reset : Number.POSITIVE_INFINITY;
    };
    const members = [...accounts].sort((a, b) => resetTime(a) - resetTime(b) || (a.displayName || a.email || a.label).localeCompare(b.displayName || b.email || b.label) || a.id.localeCompare(b.id));
    const windows = new Map<string, LimitPoolWindow>();
    for (const account of members) for (const window of account.limits.windows) {
      const pooled = poolKey(driver, window);
      const id = windows.get(pooled)?.rows.some(row => row.account.id === account.id) ? `${window.kind}:${window.id}` : pooled;
      const group: LimitPoolWindow = windows.get(id) ?? { id, label: window.label, kind: window.kind, remaining: 0, rows: [] };
      const effective = effectiveWindow(account, window, now);
      group.rows.push({ account, window, effective }); windows.set(id, group);
    }
    const pooled = [...windows.values()].sort((a, b) => order[a.kind] - order[b.kind]);
    for (const window of pooled) window.remaining = window.rows.reduce((sum, row) => sum + row.effective.remaining, 0) / window.rows.length;
    return { driver, accounts: members, windows: pooled };
  });
}
