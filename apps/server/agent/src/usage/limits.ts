// Adapted from t3code provider-core usageLimits and UsageLimitSources.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { ProviderConsumeResetCreditInput, ProviderConsumeResetCreditResult, ProviderUsageLimitsUpdate, ServerProviderUsageLimits, UsageLimitSourceAccount, UsageLimitsReport } from "@agent-workspace/contracts/usage";
import { usageProviderKindSchema } from "@agent-workspace/contracts/usage";
import { applyUsageLimitsUpdate, dedupeAccounts, mergeUsageProbe, usageLimitsIdentityChanged } from "@agent-workspace/contracts/usage-limits";
import { getStoredInstance, listStoredInstances, providerDataDirectory, type StoredProviderInstance } from "../providers/instances.ts";
import { listStoredUsageSources, type StoredUsageSource } from "./hubs.ts";
import { readHubAccounts, consumeHubCredit } from "./cliproxy.ts";
import { probeCoreUsageLimits, consumeCoreResetCredit } from "./limits/core.ts";
import { waitForUsageRead } from "./cancellation.ts";
import { getUsageSettings } from "./settings.ts";

type HubSnapshot = { revision: number; accounts: UsageLimitSourceAccount[]; error?: string };
type State = { root: string; instances: Map<string, { revision: number; limits: ServerProviderUsageLimits }>; hubs: Map<string, HubSnapshot>; refresh: Promise<void>; resets: Set<string>; pending: Map<string, Promise<UsageLimitsReport>> };
const states = new Map<string, State>();
function state(): State {
  const root = providerDataDirectory(); let current = states.get(root);
  if (!current) { current = { root, instances: new Map(), hubs: new Map(), refresh: Promise.resolve(), resets: new Set(), pending: new Map() }; states.set(root, current); }
  return current;
}
function inRoot(current: State): boolean { return providerDataDirectory() === current.root; }
function currentInstance(current: State, instance: StoredProviderInstance): boolean {
  if (!inRoot(current)) return false;
  const latest = getStoredInstance(instance.instanceId);
  return Boolean(latest?.enabled && latest.revision === instance.revision && latest.driver === instance.driver && latest.homeDirectory === instance.homeDirectory);
}
function currentSource(current: State, source: StoredUsageSource): boolean {
  return inRoot(current) && listStoredUsageSources().some(entry => entry.id === source.id && entry.enabled && entry.revision === source.revision);
}
function enqueue<T>(current: State, operation: () => Promise<T>): Promise<T> {
  const result = current.refresh.then(operation);
  current.refresh = result.then(() => {}, () => {});
  return result;
}
export function ingestUsageLimits(instanceId: string, update: ProviderUsageLimitsUpdate, expectedRevision?: number): void {
  if (!update.windows.length) return;
  const instance = getStoredInstance(instanceId);
  if (!instance?.enabled || expectedRevision !== undefined && instance.revision !== expectedRevision) return;
  const current = state(), old = current.instances.get(instanceId);
  const previous = old?.revision === instance.revision ? old.limits : undefined;
  // Only Muse has a supported runtime-only quota protocol. An explicit account
  // probe declaring unsupported must not be undone by unrelated token ticks.
  const limits = applyUsageLimitsUpdate(previous, update, new Date().toISOString(), instance.driver === "muse");
  if (limits && limits !== previous) current.instances.set(instanceId, { revision: instance.revision, limits });
}
export function getUsageLimitsReport(): UsageLimitsReport {
  const current = state(), accounts: UsageLimitsReport["accounts"] = [], notices: string[] = [];
  for (const instance of listStoredInstances()) {
    const parsed = usageProviderKindSchema.safeParse(instance.driver); if (!parsed.success) continue;
    const entry = current.instances.get(instance.instanceId);
    if (!entry || entry.revision !== instance.revision) {
      notices.push(instance.enabled ? `${instance.label}: usage limits have not yet been checked.` : `${instance.label}: disabled; usage limits have not yet been checked.`);
      continue;
    }
    const limits = entry.limits;
    if (limits.unavailable?.reason === "probeFailed") notices.push(`${instance.label}: ${limits.unavailable.message ?? "The latest usage probe failed; retained windows are not a fresh check."}`);
    accounts.push({ id: `instance:${instance.instanceId}`, driver: parsed.data, label: instance.label, instanceId: instance.instanceId, instanceIds: [instance.instanceId], ...(limits.account?.email ? { email: limits.account.email } : {}), ...(limits.account?.plan ? { plan: limits.account.plan } : {}), ...(instance.accentColor ? { accentColor: instance.accentColor } : {}), limits, ...(instance.enabled && !limits.unavailable && (instance.driver === "codex" || instance.driver === "claude") && limits.resetCredits?.availableCount ? { resetCreditInput: { instanceId: instance.instanceId } } : {}) });
  }
  for (const source of listStoredUsageSources()) {
    if (!source.enabled) continue;
    const snapshot = current.hubs.get(source.id); if (!snapshot || snapshot.revision !== source.revision) continue;
    if (snapshot.error) notices.push(`${source.label}: ${snapshot.error}`);
    for (const account of snapshot.accounts) {
      const limits = account.usageLimits, creditId = limits.resetCredits?.nextCreditId;
      if (!snapshot.error && limits.unavailable?.reason === "probeFailed") notices.push(`${source.label} · ${account.email ?? account.id}: ${limits.unavailable.message ?? "The latest usage probe failed."}`);
      accounts.push({ id: `hub:${source.id}:${account.id}`, driver: account.driver, label: account.email ?? account.id, sourceLabel: source.label, ...(account.email ? { email: account.email } : {}), ...(account.plan ? { plan: account.plan } : {}), limits, ...(account.driver === "codex" && !limits.unavailable && (limits.resetCredits?.availableCount ?? 0) > 0 && creditId ? { resetCreditInput: { sourceId: source.id, accountId: account.id, creditId } } : {}) });
    }
  }
  return structuredClone({ createdAt: new Date().toISOString(), accounts: dedupeAccounts(accounts), notices });
}
async function refreshInstance(current: State, instance: StoredProviderInstance, signal?: AbortSignal): Promise<boolean> {
  const before = current.instances.get(instance.instanceId);
  let probed: ServerProviderUsageLimits;
  try { probed = await probeCoreUsageLimits(instance, signal); }
  catch { probed = { checkedAt: new Date().toISOString(), windows: [], unavailable: { reason: "probeFailed", message: "Provider usage probe failed." } }; }
  if (!currentInstance(current, instance)) return false;
  const old = current.instances.get(instance.instanceId);
  const previous = old?.revision === instance.revision ? old.limits : undefined;
  // Read order, not response arrival time: telemetry published during a slow
  // complete probe owns the windows, while a successful probe supplies metadata.
  const limits = mergeUsageProbe(previous, probed, { now: Date.now(), preservePublishedWindows: old !== before, runtimeOnly: instance.driver === "muse" });
  current.instances.set(instance.instanceId, { revision: instance.revision, limits });
  return !limits.unavailable;
}
async function refreshHub(current: State, source: StoredUsageSource, signal?: AbortSignal): Promise<boolean> {
  const previous = current.hubs.get(source.id), old = previous?.revision === source.revision ? previous : undefined;
  try {
    const accounts = await readHubAccounts(source, signal);
    if (!currentSource(current, source)) return false;
    const merged = accounts.map(account => ({ ...account, usageLimits: mergeUsageProbe(old?.accounts.find(item => item.id === account.id && item.driver === account.driver)?.usageLimits, account.usageLimits, { now: Date.now() }) }));
    current.hubs.set(source.id, { revision: source.revision, accounts: merged });
    return merged.every(account => !account.usageLimits.unavailable);
  } catch {
    if (!currentSource(current, source)) return false;
    const failed: ServerProviderUsageLimits = { checkedAt: new Date().toISOString(), windows: [], unavailable: { reason: "probeFailed", message: "The hub could not be refreshed." } };
    current.hubs.set(source.id, { revision: source.revision, accounts: (old?.accounts ?? []).map(account => ({ ...account, usageLimits: mergeUsageProbe(account.usageLimits, failed, { now: Date.now() }) })), error: "The hub could not be refreshed." });
    return false;
  }
}
export async function refreshUsageLimits(instanceIds?: string[], signal?: AbortSignal): Promise<UsageLimitsReport> {
  signal?.throwIfAborted();
  const current = state();
  const selected = instanceIds ? [...new Set(instanceIds)].sort() : undefined;
  const instances = listStoredInstances().filter(instance => instance.enabled && (!selected || selected.includes(instance.instanceId)) && usageProviderKindSchema.safeParse(instance.driver).success);
  const sources = selected ? [] : listStoredUsageSources().filter(source => source.enabled);
  const key = JSON.stringify([selected, getUsageSettings().revision, instances.map(instance => [instance.instanceId, instance.revision]), sources.map(source => [source.id, source.revision])]);
  let work = current.pending.get(key);
  if (!work) {
    const read = enqueue(current, async () => {
      if (!inRoot(current)) throw Object.assign(new Error("Usage storage changed; refresh the current environment."), { status: 409 });
      await Promise.all([
        ...instances.map(instance => refreshInstance(current, instance)),
        ...sources.map(source => refreshHub(current, source)),
      ]);
      if (!inRoot(current)) throw Object.assign(new Error("Usage storage changed; refresh the current environment."), { status: 409 });
      return getUsageLimitsReport();
    });
    const shared = read.finally(() => { if (current.pending.get(key) === shared) current.pending.delete(key); });
    current.pending.set(key, shared); work = shared;
  }
  return waitForUsageRead(work, signal);
}
function unconfirmedSnapshot(result: ProviderConsumeResetCreditResult): ProviderConsumeResetCreditResult {
  return { ...result, warning: [result.warning, "Reset-credit action confirmed, but the updated quota snapshot could not be confirmed. Refresh to check the balance; do not redeem again automatically."].filter(Boolean).join(" ") };
}
export async function consumeUsageReset(input: ProviderConsumeResetCreditInput): Promise<ProviderConsumeResetCreditResult> {
  const current = state();
  const target = "instanceId" in input ? getStoredInstance(input.instanceId) : listStoredUsageSources().find(entry => entry.id === input.sourceId);
  const key = "instanceId" in input ? JSON.stringify(["instance", input.instanceId]) : JSON.stringify(["hub", input.sourceId, input.accountId]);
  if (current.resets.has(key)) throw Object.assign(new Error("A reset is already in progress."), { status: 409 });
  current.resets.add(key);
  try {
    return await enqueue(current, async () => {
      if ("instanceId" in input) {
        const instance = getStoredInstance(input.instanceId);
        if (!instance || !target || !inRoot(current) || !instance.enabled || instance.revision !== target.revision) throw Object.assign(new Error("Provider instance is missing, disabled or changed; refresh before redeeming."), { status: 409 });
        if (instance.driver !== "codex" && instance.driver !== "claude") throw Object.assign(new Error("Reset credits are not supported by this provider."), { status: 409 });
        const entry = current.instances.get(instance.instanceId);
        const result = await consumeCoreResetCredit(instance, undefined, entry?.revision === instance.revision ? entry.limits : undefined);
        try {
          const refreshed = await refreshInstance(current, instance), updated = current.instances.get(instance.instanceId);
          return refreshed && updated?.limits.resetCredits && (!entry || !usageLimitsIdentityChanged(entry.limits, updated.limits)) ? result : unconfirmedSnapshot(result);
        } catch { return unconfirmedSnapshot(result); }
      }
      const source = listStoredUsageSources().find(entry => entry.id === input.sourceId && entry.enabled);
      if (!source || !target || !inRoot(current) || source.revision !== target.revision) throw Object.assign(new Error("Hub is missing, disabled or changed; refresh before redeeming."), { status: 409 });
      const snapshot = current.hubs.get(source.id), account = snapshot?.revision === source.revision ? snapshot.accounts.find(entry => entry.id === input.accountId) : undefined;
      if (!account || account.driver !== "codex" || account.usageLimits.unavailable || account.usageLimits.resetCredits?.nextCreditId !== input.creditId) throw Object.assign(new Error("The selected credit is no longer current; refresh before redeeming."), { status: 409 });
      const result = await consumeHubCredit(source, input.accountId, input.creditId, undefined, account.usageLimits);
      try {
        await refreshHub(current, source);
        const updated = current.hubs.get(source.id);
        const confirmed = currentSource(current, source) && updated?.revision === source.revision && !updated.error && updated.accounts.some(entry => entry.id === input.accountId && !entry.usageLimits.unavailable && entry.usageLimits.resetCredits !== undefined && !usageLimitsIdentityChanged(account.usageLimits, entry.usageLimits));
        return confirmed ? result : unconfirmedSnapshot(result);
      } catch { return unconfirmedSnapshot(result); }
    });
  } finally { current.resets.delete(key); }
}
