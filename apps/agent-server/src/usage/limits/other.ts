// Adapted from t3code provider-cursor/provider-opencode and antigravityUsageLimits.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@agent-workspace/contracts/usage";
import type { StoredProviderInstance } from "../../providers/instances.ts";
import { getUsageSettings } from "../settings.ts";
import { cursorAccount, cursorCredential, cursorEndpoint, hash, readInstanceFile } from "../cursor-auth.ts";

type Obj = Record<string, any>;
const obj = (x: unknown): Obj => x && typeof x === "object" && !Array.isArray(x) ? x as Obj : {};
const clamp = (n: number) => Math.max(0, Math.min(100, n));
const iso = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
};
const unavailable = (checkedAt: string, reason: "unsupported" | "probeFailed", message?: string): ServerProviderUsageLimits => ({ checkedAt, windows: [], unavailable: { reason, ...(message ? { message } : {}) } });
const signalFor = (signal: AbortSignal | undefined, ms: number) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(ms)]);
async function json(url: string, init: RequestInit, signal?: AbortSignal): Promise<Obj> {
  const response = await fetch(url, { ...init, redirect: "error", signal: signalFor(signal, 10_000) });
  if (!response.ok) throw new Error("Request failed");
  const result = await response.json();
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid response");
  return result as Obj;
}
function cursorWindows(body: Obj): ServerProviderUsageWindow[] {
  const plan = obj(body.planUsage), reset = iso(Number(body.billingCycleEnd));
  return ([ ["totalPercentUsed", "Overall"], ["autoPercentUsed", "Cursor Models"], ["apiPercentUsed", "Other Models"] ] as const).flatMap(([id, label]) => typeof plan[id] === "number" && Number.isFinite(plan[id]) ? [{ id, kind: "monthly" as const, label, usedPercent: clamp(plan[id]), ...(reset && Number(body.billingCycleEnd) > 0 ? { resetsAt: reset } : {}) }] : []);
}
async function cursor(instance: StoredProviderInstance, checkedAt: string, signal?: AbortSignal): Promise<ServerProviderUsageLimits> {
  const credential = await cursorCredential(instance, getUsageSettings().cursorKeychainUsageEnabled);
  if (!credential.token) return unavailable(checkedAt, "unsupported", credential.message);
  const token = credential.token;
  const body = await json(`${cursorEndpoint(instance)}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "connect-protocol-version": "1", "x-cursor-client-type": "cli", "content-type": "application/json" }, body: "{}" }, signal);
  const windows = cursorWindows(body);
  const account = cursorAccount(token);
  return windows.length ? { checkedAt, windows, credentialFingerprint: account?.account ?? hash(`cursor\0${token}`), ...(account ? { account: { id: account.userId } } : {}) } : unavailable(checkedAt, "unsupported");
}
function consoleKey(home: string, file: string): string | undefined {
  let db: DatabaseSync | undefined;
  try {
    const resolved = realpathSync(file), root = realpathSync(home);
    if (!resolved.startsWith(`${root}${path.sep}`)) return;
    db = new DatabaseSync(resolved, { readOnly: true }); db.exec("PRAGMA busy_timeout = 100");
    const row = db.prepare("SELECT value FROM credential WHERE integration_id = 'opencode' AND active IS NOT 0 ORDER BY active DESC, time_created DESC, id DESC LIMIT 1").get();
    const value = obj(JSON.parse(typeof row?.value === "string" ? row.value : "{}"));
    if (value.type !== "key" || typeof value.key !== "string") return;
    if (typeof value.metadata?.server === "string") { const u = new URL(value.metadata.server); if (`${u.origin}${u.pathname.replace(/\/+$/, "")}` !== "https://opencode.ai/console") return; }
    return value.key.trim() || undefined;
  } catch { return; } finally { db?.close(); }
}
async function opencode(instance: StoredProviderInstance, checkedAt: string, signal?: AbortSignal): Promise<ServerProviderUsageLimits> {
  if (String(instance.config.serverUrl || "").trim()) return unavailable(checkedAt, "unsupported", "Remote OpenCode servers manage their own credentials.");
  const root = path.join(instance.homeDirectory, ".local", "share", "opencode");
  let contents = instance.env.OPENCODE_AUTH_CONTENT;
  if (!contents) { try { contents = await readInstanceFile(instance.homeDirectory, path.join(root, "auth.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; contents = "{}"; } }
  const auth = obj(JSON.parse(contents)), entry = obj(auth["opencode-go"]);
  const go = (entry.type === "api" && typeof entry.key === "string" ? entry.key : instance.env.OPENCODE_API_KEY)?.trim();
  const name = instance.env.OPENCODE_DB || "opencode.db", file = path.resolve(root, name);
  const safeFile = file.startsWith(`${root}${path.sep}`);
  const console = instance.env.OPENCODE_AUTH_CONTENT || name === ":memory:" || !safeFile ? undefined : consoleKey(instance.homeDirectory, file);
  let key = console || go;
  if (!key) return unavailable(checkedAt, "unsupported");
  const request = (credential: string) => fetch("https://opencode.ai/zen/go/v1/usage", { headers: { Authorization: `Bearer ${credential}` }, redirect: "error", signal: signalFor(signal, 5_000) });
  let response = await request(key);
  if ((response.status === 401 || response.status === 403) && go && go !== key) { key = go; response = await request(key); }
  if (response.status === 403) return unavailable(checkedAt, "unsupported");
  if (!response.ok) throw new Error("Request failed");
  const usage = obj(obj(await response.json()).usage);
  const windows: ServerProviderUsageWindow[] = ([ ["rolling", "go_rolling", "session", "Go · Session", 300], ["weekly", "go_weekly", "weekly", "Go · Weekly", 10080], ["monthly", "go_monthly", "monthly", "Go · Monthly", undefined] ] as const).map(([name, id, kind, label, duration]) => {
    const window = obj(usage[name]), reset = iso(window.resetsAt);
    if (typeof window.percent !== "number" || !Number.isFinite(window.percent) || !reset) throw new Error("Invalid usage window");
    return { id, kind, label, usedPercent: clamp(window.percent), resetsAt: reset, ...(duration ? { windowDurationMins: duration } : {}) };
  });
  return { checkedAt, windows, credentialFingerprint: hash(`opencode-go\0${key}`) };
}
function quota(id: string, label: string, value: Obj, kind: ServerProviderUsageWindow["kind"], duration?: number): ServerProviderUsageWindow | undefined {
  if (typeof value.remainingFraction !== "number" || !Number.isFinite(value.remainingFraction)) return;
  const reset = iso(value.resetTime);
  return { id, label, kind, usedPercent: (1 - Math.max(0, Math.min(1, value.remainingFraction))) * 100, ...(reset ? { resetsAt: reset } : {}), ...(duration ? { windowDurationMins: duration } : {}) };
}
function summaryWindows(body: Obj): ServerProviderUsageWindow[] {
  const groups = Array.isArray(body.groups) && body.groups.some((g: Obj) => Array.isArray(g?.buckets) && g.buckets.length) ? body.groups : [{ buckets: body.buckets }];
  const result = new Map<string, ServerProviderUsageWindow>();
  for (const group of groups) for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
    if (!bucket || bucket.disabled || typeof bucket.bucketId !== "string" || !bucket.bucketId) continue;
    const family = bucket.bucketId.startsWith("gemini-") ? "Gemini" : bucket.bucketId.startsWith("3p-") ? "Claude & GPT (shared)" : group.displayName?.trim() || bucket.bucketId;
    const weekly = bucket.window === "weekly", session = bucket.window === "5h";
    const window = quota(bucket.bucketId, `${family} · ${weekly ? "Weekly" : session ? "5-hour" : bucket.displayName?.trim() || "Quota"}`, bucket, weekly ? "weekly" : session ? "session" : "other", weekly ? 10080 : session ? 300 : undefined);
    if (window) result.set(window.id, window);
  }
  return [...result.values()];
}
function modelWindows(body: Obj): ServerProviderUsageWindow[] {
  const result = new Map<string, ServerProviderUsageWindow>();
  for (const [id, raw] of Object.entries(obj(body.models))) {
    const model = obj(raw), family = model.modelProvider === "MODEL_PROVIDER_GOOGLE" || id.startsWith("gemini-") ? "Gemini" : model.modelProvider === "MODEL_PROVIDER_ANTHROPIC" || id.startsWith("claude-") ? "Claude" : model.modelProvider === "MODEL_PROVIDER_OPENAI" || id.startsWith("gpt-") ? "GPT" : undefined;
    if (!family) continue;
    for (const [suffix, data] of [["quota", model.quotaInfo], ["weekly", model.weeklyQuotaInfo]] as const) {
      const window = quota(`${family.toLowerCase()}-${suffix}`, `${family} · ${suffix === "weekly" ? "Weekly" : "Reported quota"}`, obj(data), suffix === "weekly" ? "weekly" : "other", suffix === "weekly" ? 10080 : undefined);
      if (window && (!result.has(window.id) || result.get(window.id)!.usedPercent < window.usedPercent)) result.set(window.id, window);
    }
  }
  return [...result.values()];
}
async function antigravity(instance: StoredProviderInstance, checkedAt: string, signal?: AbortSignal): Promise<ServerProviderUsageLimits> {
  if (!["oauth-personal", "oauth-business"].includes(String(instance.config.authMethod || "oauth-personal"))) return unavailable(checkedAt, "unsupported");
  let raw: string; try { raw = await readInstanceFile(instance.homeDirectory, path.join(instance.homeDirectory, "antigravity-acp", "acp_token.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return unavailable(checkedAt, "unsupported", "Sign in with Google to see Antigravity limits."); throw error; }
  const token = obj(JSON.parse(raw));
  if (![token.client_id, token.client_secret, token.refresh_token].every((s) => typeof s === "string" && s)) throw new Error("Invalid token");
  const refreshed = await json("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: token.client_id, client_secret: token.client_secret, refresh_token: token.refresh_token, grant_type: "refresh_token" }) }, signal);
  if (typeof refreshed.access_token !== "string" || !refreshed.access_token || typeof refreshed.expires_in !== "number" || refreshed.expires_in <= 0) throw new Error("Invalid token response");
  const headers = { Authorization: `Bearer ${refreshed.access_token}`, "content-type": "application/json", "User-Agent": `antigravity/hub/1.0.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=963137146)` };
  let fingerprint = hash(`${token.client_id}\0${token.refresh_token}\0${token.project_id ?? ""}`);
  let identity: ServerProviderUsageLimits["account"];
  try {
    const user = await json("https://www.googleapis.com/oauth2/v2/userinfo", { headers }, signal);
    if (typeof user.id === "string" && user.id) {
      fingerprint = hash(`google-account\0${user.id}`);
      identity = { id: user.id, ...(typeof user.email === "string" && user.email.trim() ? { email: user.email.trim() } : {}) };
    }
  } catch { /* identity fallback is scoped to this credential */ }
  const endpoints = ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"];
  const collect = async (operation: string, parse: (body: Obj) => ServerProviderUsageWindow[]) => {
    const responses = await Promise.all(endpoints.map(async (endpoint) => { try { return parse(await json(`${endpoint}/v1internal:${operation}`, { method: "POST", headers, body: JSON.stringify(token.project_id ? { project: token.project_id } : {}) }, signal)); } catch { return []; } }));
    const merged = new Map<string, ServerProviderUsageWindow>();
    for (const window of responses.flat()) if (!merged.has(window.id) || merged.get(window.id)!.usedPercent < window.usedPercent) merged.set(window.id, window);
    return [...merged.values()];
  };
  let windows = await collect("retrieveUserQuotaSummary", summaryWindows);
  if (!windows.length) windows = await collect("fetchAvailableModels", modelWindows);
  return windows.length ? { checkedAt, windows, credentialFingerprint: fingerprint, ...(identity ? { account: identity } : {}) } : unavailable(checkedAt, "probeFailed", "Antigravity did not return usable quota information.");
}
export async function probeOtherUsageLimits(instance: StoredProviderInstance, signal?: AbortSignal): Promise<ServerProviderUsageLimits> {
  const checkedAt = new Date().toISOString();
  try {
    switch (instance.driver) {
      case "cursor": return await cursor(instance, checkedAt, signal);
      case "opencode": return await opencode(instance, checkedAt, signal);
      case "antigravity": return await antigravity(instance, checkedAt, signal);
      case "muse": return unavailable(checkedAt, "unsupported", "Muse reports limits during model responses.");
      default: return unavailable(checkedAt, "unsupported");
    }
  } catch { return unavailable(checkedAt, "probeFailed", `${instance.driver} could not read usage limits.`); }
}
