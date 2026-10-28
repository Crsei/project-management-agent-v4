// Adapted from t3code cliproxyApi.ts; Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { createHash } from "node:crypto";
import type { ProviderConsumeResetCreditResult, ServerProviderUsageWindow, UsageLimitSourceAccount } from "@agent-workspace/contracts/usage";
import { validateHubUrl, type StoredUsageSource } from "./hubs.ts";

type ObjectValue = Record<string, unknown>;
type Auth = { id: string; auth_index: string; provider: string; email?: string; disabled?: boolean; id_token?: ObjectValue };
const CODEX_BASE = "https://chatgpt.com/backend-api/wham";
const CREDIT_URL = `${CODEX_BASE}/rate-limit-reset-credits`;
const namespace = Buffer.from("6f1c2a9e2d4b4c1e9a7f3b8d5e0c1a42", "hex");
const obj = (v: unknown): ObjectValue => v && typeof v === "object" && !Array.isArray(v) ? v as ObjectValue : {};
const str = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v.trim() : undefined;
const percent = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined;
const iso = (v: unknown): string | undefined => { const n = typeof v === "number" ? v * 1000 : typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(n) && n > 0 && n <= 8640000000000000 ? new Date(n).toISOString() : undefined; };
export function creditRedeemRequestId(accountId: string, creditId: string): string {
  const bytes = createHash("sha1").update(namespace).update(`${accountId}:${creditId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function management(source: StoredUsageSource, endpoint: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!source.enabled || !source.managementKey) throw new Error("Hub is disabled or has no management key.");
  const url = new URL(`v0/management/${endpoint}`, `${validateHubUrl(source.url)}/`);
  try {
    const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${source.managementKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Hub request failed (HTTP ${response.status}).`);
    return await response.json();
  } catch (error) {
    if (error instanceof Error && /^Hub request failed \(HTTP \d+\)\.$/.test(error.message)) throw error;
    throw new Error("Hub request failed or returned invalid data.");
  }
}
async function authFiles(source: StoredUsageSource, signal?: AbortSignal): Promise<Auth[]> {
  const raw = obj(await management(source, "auth-files", undefined, signal));
  if (!Array.isArray(raw.files)) throw new Error("Hub returned an invalid account list.");
  return raw.files.map((value: unknown) => { const a = obj(value); if (!str(a.id) || !str(a.auth_index) || !str(a.provider)) throw new Error("Hub returned an invalid account list."); return a as Auth; });
}
async function apiCall(source: StoredUsageSource, account: Auth, url: string, data?: unknown, signal?: AbortSignal): Promise<ObjectValue> {
  const accountId = str(obj(account.id_token).chatgpt_account_id);
  const header = account.provider === "codex" ? { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", "OpenAI-Beta": "codex-1", Originator: "Codex Desktop", ...(accountId ? { "Chatgpt-Account-Id": accountId } : {}) } : { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.273" };
  const response = obj(await management(source, "api-call", { auth_index: account.auth_index, method: data === undefined ? "GET" : "POST", url, header, ...(data === undefined ? {} : { data: JSON.stringify(data) }) }, signal));
  if (typeof response.status_code !== "number" || response.status_code < 200 || response.status_code >= 300 || typeof response.body !== "string") throw new Error("Provider refused the hub request.");
  try { const result = JSON.parse(response.body); if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(); return result as ObjectValue; } catch { throw new Error("Provider returned invalid data."); }
}
function codexWindows(usage: ObjectValue, plan: string | undefined): ServerProviderUsageWindow[] {
  const rate = obj(usage.rate_limit); const windows: ServerProviderUsageWindow[] = [];
  for (const [id, fallback] of [["primary", plan === "free" || plan === "go" ? 43200 : 300], ["secondary", 10080]] as const) {
    const raw = obj(rate[`${id}_window`]); const usedPercent = percent(raw.used_percent); if (usedPercent === undefined) continue;
    const mins = typeof raw.limit_window_seconds === "number" && Number.isFinite(raw.limit_window_seconds) && raw.limit_window_seconds > 0 ? Math.round(raw.limit_window_seconds / 60) : fallback;
    const kind = mins >= 43200 ? "monthly" : mins >= 10080 ? "weekly" : "session";
    const resetsAt = iso(raw.reset_at); windows.push({ id, kind, label: kind === "monthly" ? "Monthly" : kind === "weekly" ? "Weekly" : "Session", usedPercent, windowDurationMins: mins, ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows;
}
function claudeWindows(usage: ObjectValue): ServerProviderUsageWindow[] {
  const windows: ServerProviderUsageWindow[] = [];
  const add = (id: string, label: string, kind: "session" | "weekly", raw: ObjectValue, field: string) => { const usedPercent = percent(raw[field]); if (usedPercent === undefined) return; const resetsAt = iso(raw.resets_at); windows.push({ id, kind, label, usedPercent, windowDurationMins: kind === "session" ? 300 : 10080, ...(resetsAt ? { resetsAt } : {}) }); };
  add("five_hour", "Session", "session", obj(usage.five_hour), "utilization"); add("seven_day", "Weekly", "weekly", obj(usage.seven_day), "utilization");
  if (Array.isArray(usage.limits)) for (const entry of usage.limits) { const raw = obj(entry); const name = str(obj(obj(raw.scope).model).display_name); if (raw.kind === "weekly_scoped" && name) add(`seven_day_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`, `Weekly ${name}`, "weekly", raw, "percent"); }
  return windows;
}
async function readAccount(source: StoredUsageSource, account: Auth, signal?: AbortSignal): Promise<UsageLimitSourceAccount> {
  const checkedAt = new Date().toISOString(); const token = obj(account.id_token); const workspaceId = str(token.chatgpt_account_id);
  const fingerprint = account.provider === "codex" && workspaceId ? `codex:${createHash("sha256").update(workspaceId.toLowerCase()).digest("hex")}` : undefined;
  const base = { id: account.id, driver: account.provider as "codex" | "claude", ...(account.email ? { email: account.email } : {}), ...(workspaceId ? { workspaceId } : {}) };
  try {
    const usage = await apiCall(source, account, account.provider === "codex" ? `${CODEX_BASE}/usage` : "https://api.anthropic.com/api/oauth/usage", undefined, signal);
    if (account.provider === "claude") return { ...base, plan: "Claude Subscription", usageLimits: { checkedAt, windows: claudeWindows(usage), account: { ...(account.email ? { email: account.email } : {}), plan: "Claude Subscription" } } };
    if (!("rate_limit" in usage)) throw new Error("Invalid usage response.");
    const plan = str(usage.plan_type) ?? str(token.plan_type) ?? str(token.chatgpt_plan_type);
    let resetCredits: { availableCount: number; nextCreditId?: string; nextExpiresAt?: string } | undefined;
    try {
      const result = await apiCall(source, account, CREDIT_URL, undefined, signal);
      if (!Array.isArray(result.credits)) throw new Error();
      const credits = result.credits.map(obj).filter((credit) => str(credit.id) && credit.status === "available" && credit.reset_type === "codex_rate_limits" && typeof credit.expires_at === "string" && Date.parse(credit.expires_at) > Date.now()).sort((a, b) => Date.parse(String(a.expires_at)) - Date.parse(String(b.expires_at)));
      const first = credits[0]; resetCredits = { availableCount: credits.length, ...(first ? { nextCreditId: String(first.id), nextExpiresAt: iso(first.expires_at) } : {}) };
    } catch { /* Credits are optional; a failed credits request must not discard usage. */ }
    const plans: Record<string, string> = { free: "ChatGPT Free Subscription", go: "ChatGPT Go Subscription", plus: "ChatGPT Plus Subscription", pro: "ChatGPT Pro Subscription" };
    const planLabel = plan ? plans[plan] ?? plan : undefined;
    return { ...base, ...(planLabel ? { plan: planLabel } : {}), usageLimits: { checkedAt, windows: codexWindows(usage, plan), account: { ...(workspaceId ? { workspaceId } : {}), ...(account.email ? { email: account.email } : {}), ...(planLabel ? { plan: planLabel } : {}) }, ...(fingerprint ? { credentialFingerprint: fingerprint } : {}), ...(resetCredits ? { resetCredits } : {}) } };
  } catch { return { ...base, usageLimits: { checkedAt, windows: [], account: { ...(workspaceId ? { workspaceId } : {}), ...(account.email ? { email: account.email } : {}) }, ...(fingerprint ? { credentialFingerprint: fingerprint } : {}), unavailable: { reason: "probeFailed", message: "The hub could not read this account's usage." } } }; }
}
export async function readHubAccounts(source: StoredUsageSource, signal?: AbortSignal): Promise<UsageLimitSourceAccount[]> {
  const accounts = (await authFiles(source, signal)).filter((a) => !a.disabled && (a.provider === "codex" || a.provider === "claude"));
  const result: UsageLimitSourceAccount[] = []; for (let i = 0; i < accounts.length; i += 4) result.push(...await Promise.all(accounts.slice(i, i + 4).map((account) => readAccount(source, account, signal)))); return result;
}
export async function consumeHubCredit(source: StoredUsageSource, accountId: string, creditId: string, signal?: AbortSignal): Promise<ProviderConsumeResetCreditResult> {
  const account = (await authFiles(source, signal)).find((a) => a.id === accountId && !a.disabled && a.provider === "codex");
  if (!account) throw new Error("The Codex hub account is missing or disabled.");
  const result = await apiCall(source, account, `${CREDIT_URL}/consume`, { redeem_request_id: creditRedeemRequestId(str(obj(account.id_token).chatgpt_account_id) ?? account.id, creditId), credit_id: creditId }, signal);
  const outcomes = { reset: "reset", nothing_to_reset: "nothingToReset", no_credit: "noCredit", already_redeemed: "alreadyRedeemed" } as const;
  const outcome = typeof result.code === "string" ? outcomes[result.code as keyof typeof outcomes] : undefined;
  if (!outcome) throw new Error("The hub returned an unexpected reset-credit response; the outcome may be unknown.");
  if (outcome !== "reset" && outcome !== "alreadyRedeemed") return { outcome };
  try { await management(source, "reset-quota", { auth_index: account.auth_index }, signal); return { outcome }; }
  catch { return { outcome, warning: "Credit redeemed, but the hub cooldown could not be cleared. Routing may resume after its cooldown expires." }; }
}
