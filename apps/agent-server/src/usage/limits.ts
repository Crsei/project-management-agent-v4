// Adapted from t3code provider-core usageLimits and UsageLimitSources.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { ProviderConsumeResetCreditInput, ProviderConsumeResetCreditResult, ProviderUsageLimitsUpdate, ServerProviderUsageLimits, ServerProviderUsageWindow, UsageLimitSourceAccount, UsageLimitsReport } from "@agent-workspace/contracts/usage";
import { usageProviderKindSchema } from "@agent-workspace/contracts/usage";
import { getStoredInstance, listStoredInstances, providerDataDirectory, type StoredProviderInstance } from "../providers/instances.ts";
import { listStoredUsageSources } from "./hubs.ts";
import { readHubAccounts, consumeHubCredit } from "./cliproxy.ts";
import { probeCoreUsageLimits, consumeCoreResetCredit } from "./limits/core.ts";
import { probeOtherUsageLimits } from "./limits/other.ts";

type HubSnapshot = { revision: number; accounts: UsageLimitSourceAccount[]; error?: string };
type State = { instances: Map<string, { revision: number; limits: ServerProviderUsageLimits }>; hubs: Map<string, HubSnapshot>; refresh: Promise<void>; resets: Set<string> };
const states = new Map<string, State>();
function state(): State {
  const root = providerDataDirectory(); let current = states.get(root);
  if (!current) { current = { instances: new Map(), hubs: new Map(), refresh: Promise.resolve(), resets: new Set() }; states.set(root, current); }
  return current;
}
function mergeWindows(previous: ServerProviderUsageWindow[], update: ServerProviderUsageWindow[]): ServerProviderUsageWindow[] {
  const merged = new Map(previous.map((window) => [window.id, window]));
  for (const window of update) { const old = merged.get(window.id); merged.set(window.id, { ...old, ...window }); }
  const order = { session: 0, weekly: 1, monthly: 2, other: 3 };
  return [...merged.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id));
}
function mergeProbe(previous: ServerProviderUsageLimits | undefined, next: ServerProviderUsageLimits): ServerProviderUsageLimits {
  if (!previous || next.unavailable?.reason === "unsupported") return next;
  if (previous.credentialFingerprint && next.credentialFingerprint && previous.credentialFingerprint !== next.credentialFingerprint) return next;
  if (next.unavailable?.reason === "probeFailed") {
    const now = Date.now();
    return { ...next, windows: previous.windows.filter((window) => !window.resetsAt || !Number.isFinite(Date.parse(window.resetsAt)) || Date.parse(window.resetsAt) > now), ...(next.credentialFingerprint || !previous.credentialFingerprint ? {} : { credentialFingerprint: previous.credentialFingerprint }), ...(next.account || !previous.account ? {} : { account: previous.account }) };
  }
  const newer = Date.parse(previous.checkedAt) > Date.parse(next.checkedAt);
  return { ...next, checkedAt: newer ? previous.checkedAt : next.checkedAt, windows: newer ? mergeWindows(next.windows, previous.windows) : mergeWindows(previous.windows, next.windows), ...(next.credentialFingerprint || !previous.credentialFingerprint ? {} : { credentialFingerprint: previous.credentialFingerprint }), ...(next.account || !previous.account ? {} : { account: previous.account }) };
}
export function ingestUsageLimits(instanceId: string, update: ProviderUsageLimitsUpdate): void {
  if (!update.windows.length) return;
  const instance = getStoredInstance(instanceId); if (!instance) return;
  const current = state(); const old = current.instances.get(instanceId);
  const previous = old?.revision === instance.revision ? old.limits : undefined;
  if (previous?.unavailable?.reason === "unsupported") {
    const { unavailable: _unavailable, ...supported } = previous ?? { checkedAt: "", windows: [] };
    current.instances.set(instanceId, { revision: instance.revision, limits: { ...supported, checkedAt: new Date().toISOString(), windows: mergeWindows(previous?.windows ?? [], update.windows) } });
  } else {
    current.instances.set(instanceId, { revision: instance.revision, limits: { ...previous, checkedAt: new Date().toISOString(), windows: mergeWindows(previous?.windows ?? [], update.windows) } });
  }
}
export function getUsageLimitsReport(): UsageLimitsReport {
  const current = state(); const accounts: UsageLimitsReport["accounts"] = []; const notices: string[] = []; const fingerprints = new Map<string, number>();
  const add = (account: UsageLimitsReport["accounts"][number]) => {
    const fingerprint = account.limits.credentialFingerprint; const key = fingerprint ? `${account.driver}:${fingerprint}` : undefined; const index = key ? fingerprints.get(key) : undefined;
    if (index === undefined) { if (key) fingerprints.set(key, accounts.length); accounts.push(account); return; }
    const existing = accounts[index]!; const first = Date.parse(existing.limits.checkedAt) >= Date.parse(account.limits.checkedAt) ? existing.limits : account.limits; const second = first === existing.limits ? account.limits : existing.limits;
    const instanceIds = [...new Set([...(existing.instanceIds ?? []), ...(account.instanceIds ?? [])])];
    const limits = first.unavailable ? mergeProbe(second, first) : { ...first, windows: mergeWindows(second.windows, first.windows), ...(first.resetCredits || !second.resetCredits ? {} : { resetCredits: second.resetCredits }) };
    const hubReset = account.resetCreditInput && "sourceId" in account.resetCreditInput ? account.resetCreditInput : undefined;
    const resetCreditInput = limits.unavailable ? undefined : hubReset ?? existing.resetCreditInput ?? account.resetCreditInput;
    if (resetCreditInput && hubReset && account.limits.resetCredits) limits.resetCredits = account.limits.resetCredits;
    accounts[index] = { ...existing, ...(instanceIds.length ? { instanceIds } : {}), ...(!existing.email && account.email ? { email: account.email } : {}), ...(!existing.plan && account.plan ? { plan: account.plan } : {}), ...(hubReset && account.sourceLabel ? { sourceLabel: account.sourceLabel } : {}), limits, ...(resetCreditInput ? { resetCreditInput } : {}) };
    if (!resetCreditInput) delete accounts[index]!.resetCreditInput;
  };
  for (const instance of listStoredInstances()) {
    const parsed = usageProviderKindSchema.safeParse(instance.driver); if (!parsed.success) continue;
    const entry = current.instances.get(instance.instanceId);
    if (!entry || entry.revision !== instance.revision) {
      notices.push(instance.enabled ? `${instance.label}: usage limits have not yet been checked.` : `${instance.label}: disabled; usage limits have not yet been checked.`);
      continue;
    }
    const limits = entry.limits;
    add({ id: `instance:${instance.instanceId}`, driver: parsed.data, label: instance.label, instanceId: instance.instanceId, instanceIds: [instance.instanceId], ...(limits.account?.email ? { email: limits.account.email } : {}), ...(limits.account?.plan ? { plan: limits.account.plan } : {}), ...(instance.accentColor ? { accentColor: instance.accentColor } : {}), limits, ...(instance.enabled && (instance.driver === "codex" || instance.driver === "claude") && limits.resetCredits?.availableCount ? { resetCreditInput: { instanceId: instance.instanceId } } : {}) });
  }
  for (const source of listStoredUsageSources()) {
    if (!source.enabled) continue;
    const snapshot = current.hubs.get(source.id); if (!snapshot || snapshot.revision !== source.revision) continue;
    if (snapshot.error) notices.push(`${source.label}: ${snapshot.error}`);
    for (const account of snapshot.accounts) {
      const creditId = account.usageLimits.resetCredits?.nextCreditId;
      add({ id: `hub:${source.id}:${account.id}`, driver: account.driver, label: account.email ?? account.id, sourceLabel: source.label, ...(account.email ? { email: account.email } : {}), ...(account.plan ? { plan: account.plan } : {}), limits: account.usageLimits, ...(account.driver === "codex" && creditId ? { resetCreditInput: { sourceId: source.id, accountId: account.id, creditId } } : {}) });
    }
  }
  return structuredClone({ createdAt: new Date().toISOString(), accounts, notices });
}
async function refreshInstance(current: State, instance: StoredProviderInstance, signal?: AbortSignal): Promise<void> {
  let probed: ServerProviderUsageLimits;
  try { probed = ["codex", "claude", "grok"].includes(instance.driver) ? await probeCoreUsageLimits(instance, signal) : await probeOtherUsageLimits(instance, signal); }
  catch { probed = { checkedAt: new Date().toISOString(), windows: [], unavailable: { reason: "probeFailed", message: "Provider usage probe failed." } }; }
  const latest = getStoredInstance(instance.instanceId); if (!latest || latest.revision !== instance.revision) return;
  const old = current.instances.get(instance.instanceId);
  const previous = old?.revision === instance.revision ? old.limits : undefined;
  // Muse reports real limits only through native runtime events, not an independent account endpoint.
  const limits = instance.driver === "muse" && probed.unavailable?.reason === "unsupported" && previous?.windows.length && !previous.unavailable ? previous : mergeProbe(previous, probed);
  current.instances.set(instance.instanceId, { revision: instance.revision, limits });
}
export async function refreshUsageLimits(instanceIds?: string[], signal?: AbortSignal): Promise<UsageLimitsReport> {
  const current = state();
  const operation = current.refresh.then(async () => {
    const instances = listStoredInstances().filter((instance) => instance.enabled && (!instanceIds || instanceIds.includes(instance.instanceId)) && usageProviderKindSchema.safeParse(instance.driver).success);
    const sources = instanceIds ? [] : listStoredUsageSources().filter((source) => source.enabled);
    await Promise.all([...instances.map((instance) => refreshInstance(current, instance, signal)), ...sources.map(async (source) => {
      const previous = current.hubs.get(source.id); const old = previous?.revision === source.revision ? previous : undefined;
      try {
        const accounts = await readHubAccounts(source, signal); const latest = listStoredUsageSources().find((entry) => entry.id === source.id); if (!latest || latest.revision !== source.revision) return;
        current.hubs.set(source.id, { revision: source.revision, accounts: accounts.map((account) => ({ ...account, usageLimits: mergeProbe(old?.accounts.find((item) => item.id === account.id && item.driver === account.driver)?.usageLimits, account.usageLimits) })) });
      } catch {
        const latest = listStoredUsageSources().find((entry) => entry.id === source.id); if (!latest || latest.revision !== source.revision) return;
        const failed: ServerProviderUsageLimits = { checkedAt: new Date().toISOString(), windows: [], unavailable: { reason: "probeFailed", message: "The hub could not be refreshed." } };
        current.hubs.set(source.id, { revision: source.revision, accounts: (old?.accounts ?? []).map((account) => ({ ...account, usageLimits: mergeProbe(account.usageLimits, failed) })), error: "The hub could not be refreshed." });
      }
    })]);
  });
  current.refresh = operation.catch(() => {}); await operation; return getUsageLimitsReport();
}
export async function consumeUsageReset(input: ProviderConsumeResetCreditInput): Promise<ProviderConsumeResetCreditResult> {
  const current = state();
  const key = "instanceId" in input ? JSON.stringify(["instance", input.instanceId]) : JSON.stringify(["hub", input.sourceId, input.accountId, input.creditId]);
  if (current.resets.has(key)) throw Object.assign(new Error("A reset is already in progress."), { status: 409 });
  current.resets.add(key);
  try {
    if ("instanceId" in input) {
      const instance = getStoredInstance(input.instanceId);
      if (!instance || !instance.enabled) throw Object.assign(new Error("Provider instance is missing or disabled."), { status: 404 });
      if (instance.driver !== "codex" && instance.driver !== "claude") throw Object.assign(new Error("Reset credits are not supported by this provider."), { status: 409 });
      return await consumeCoreResetCredit(instance);
    }
    const source = listStoredUsageSources().find((entry) => entry.id === input.sourceId && entry.enabled);
    if (!source) throw Object.assign(new Error("Hub is missing or disabled."), { status: 404 });
    const snapshot = current.hubs.get(source.id); const account = snapshot?.revision === source.revision ? snapshot.accounts.find((entry) => entry.id === input.accountId) : undefined;
    if (!account || account.driver !== "codex" || account.usageLimits.unavailable || account.usageLimits.resetCredits?.nextCreditId !== input.creditId) throw Object.assign(new Error("The selected credit is no longer current; refresh before redeeming."), { status: 409 });
    return await consumeHubCredit(source, input.accountId, input.creditId);
  } finally { current.resets.delete(key); }
}
