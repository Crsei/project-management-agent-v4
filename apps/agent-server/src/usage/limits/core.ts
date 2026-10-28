// Adapted from t3code CodexProvider, claudeUsageLimits, claudeResetCredits and
// provider-grok/server/usageLimits. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderConsumeResetCreditResult, ServerProviderResetCredits, ServerProviderUsageLimits, ServerProviderUsageWindow } from "@agent-workspace/contracts/usage";
import { getStoredInstance, providerContext, type StoredProviderInstance } from "../../providers/instances.ts";
import { CodexRpc, object } from "../../providers/drivers/codex-rpc.ts";
import { claudeQueryOptions } from "../../providers/drivers/claude.ts";
import { runProviderCommand } from "../../providers/process.ts";

type Obj = Record<string, unknown>;
const clamp = (n: number) => Math.max(0, Math.min(100, n));
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const text = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v.trim() : undefined;
const iso = (v: unknown): string | undefined => { if (typeof v !== "string") return undefined; const n = Date.parse(v); return Number.isFinite(n) ? new Date(n).toISOString() : undefined; };
const epoch = (v: unknown): string | undefined => number(v) && v > 0 && Number.isFinite(new Date(v * 1000).getTime()) ? new Date(v * 1000).toISOString() : undefined;
const fingerprint = (provider: string, value: string | undefined) => value ? `${provider}:${createHash("sha256").update(value.trim().toLowerCase()).digest("hex")}` : undefined;
const unavailable = (reason: "unsupported" | "probeFailed", message?: string): ServerProviderUsageLimits => ({ checkedAt: new Date().toISOString(), windows: [], unavailable: { reason, ...(message ? { message } : {}) } });
function validCalendarDate(value: string): boolean {
  const day = value.slice(0, 10); const timestamp = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === day;
}
const withFingerprint = (limits: ServerProviderUsageLimits, provider: string, value: string | undefined): ServerProviderUsageLimits => { const credentialFingerprint = fingerprint(provider, value); return credentialFingerprint ? { ...limits, credentialFingerprint } : limits; };
async function jsonFile(file: string): Promise<Obj> { try { return object(JSON.parse(await readFile(file, "utf8"))); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; } }
function assertRevision(instance: StoredProviderInstance) { const current = getStoredInstance(instance.instanceId); if (!current || current.revision !== instance.revision || current.driver !== instance.driver || current.homeDirectory !== instance.homeDirectory || !current.enabled) throw new Error("Provider account changed during the usage operation."); }
function timeout(signal: AbortSignal | undefined, milliseconds: number): AbortSignal { return signal ? AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds); }
async function requestJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<Obj> {
  const response = await fetch(url, { ...init, redirect: "error", signal: timeout(signal, 10_000) });
  if (!response.ok) throw new Error("Provider usage request failed.");
  const length = Number(response.headers.get("content-length")); if (length > 1_000_000) throw new Error("Provider usage response too large.");
  const reader = response.body?.getReader(); let body = "";
  if (reader) { const decoder = new TextDecoder(); let size = 0; try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1_000_000) throw new Error("Provider usage response too large."); body += decoder.decode(part.value, { stream: true }); } body += decoder.decode(); } finally { await reader.cancel().catch(() => undefined); } }
  const parsed: unknown = JSON.parse(body); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid provider usage response."); return object(parsed);
}

export function codexLimitsFromResponse(response: Obj, checkedAt: string): ServerProviderUsageLimits {
  const snapshot = object(object(response.rateLimitsByLimitId).codex ?? response.rateLimits);
  const windows: ServerProviderUsageWindow[] = [];
  if (!snapshot.limitId || snapshot.limitId === "codex") {
    for (const [id, fallback] of [["primary", snapshot.planType === "free" || snapshot.planType === "go" ? 43200 : 300], ["secondary", 10080]] as const) {
      const w = object(snapshot[id]); if (!number(w.usedPercent)) continue;
      const mins = number(w.windowDurationMins) && w.windowDurationMins >= 0 ? Math.trunc(w.windowDurationMins) : fallback;
      const kind = mins >= 43200 ? "monthly" : mins >= 10080 ? "weekly" : "session";
      const resetsAt = epoch(w.resetsAt); windows.push({ id, kind, label: kind === "monthly" ? "Monthly" : kind === "weekly" ? "Weekly" : "Session", usedPercent: clamp(w.usedPercent), windowDurationMins: mins, ...(resetsAt ? { resetsAt } : {}) });
    }
    const individual = object(snapshot.individualLimit);
    if (number(individual.remainingPercent)) { const resetsAt = epoch(individual.resetsAt); windows.push({ id: "individual", kind: "monthly", label: "Monthly credit limit", usedPercent: clamp(100 - individual.remainingPercent), ...(resetsAt ? { resetsAt } : {}) }); }
  }
  const credits = object(response.rateLimitResetCredits); let resetCredits: ServerProviderResetCredits | undefined;
  if (number(credits.availableCount)) {
    const expiries = (Array.isArray(credits.credits) ? credits.credits : []).map(object).filter(c => c.status === "available").map(c => c.expiresAt).filter(number);
    const nextExpiresAt = expiries.length ? epoch(Math.min(...expiries)) : undefined;
    resetCredits = { availableCount: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(credits.availableCount))), ...(nextExpiresAt ? { nextExpiresAt } : {}) };
  }
  return { checkedAt, windows, ...(resetCredits ? { resetCredits } : {}) };
}

export function claudeLimitsFromResponse(response: Obj, checkedAt: string): ServerProviderUsageLimits {
  if (response.rate_limits_available !== true) return { checkedAt, windows: [], unavailable: { reason: response.rate_limits_available === false ? "unsupported" : "probeFailed" } };
  if (!response.rate_limits || typeof response.rate_limits !== "object" || Array.isArray(response.rate_limits)) return { checkedAt, windows: [], unavailable: { reason: "probeFailed" } };
  const limits = object(response.rate_limits); const windows: ServerProviderUsageWindow[] = [];
  for (const [id, kind, label, mins] of [["five_hour", "session", "Session", 300], ["seven_day", "weekly", "Weekly", 10080]] as const) {
    const w = object(limits[id]); if (!number(w.utilization)) continue; const resetsAt = iso(w.resets_at);
    windows.push({ id, kind, label, usedPercent: clamp(w.utilization), windowDurationMins: mins, ...(resetsAt ? { resetsAt } : {}) });
  }
  for (const entry of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    const w = object(entry); const name = text(w.display_name); if (!name || !number(w.utilization)) continue; const resetsAt = iso(w.resets_at);
    windows.push({ id: `seven_day_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, kind: "weekly", label: `Weekly · ${name}`, windowDurationMins: 10080, usedPercent: clamp(w.utilization), ...(resetsAt ? { resetsAt } : {}) });
  }
  const spend = object(limits.spend), used = object(spend.used), limit = object(spend.limit), extra = object(limits.extra_usage);
  let percent: number | undefined;
  if (spend.enabled === true && text(used.currency) && used.currency === limit.currency && used.exponent === limit.exponent && number(used.amount_minor) && used.amount_minor >= 0 && number(limit.amount_minor) && limit.amount_minor > 0) percent = 100 * used.amount_minor / limit.amount_minor;
  else if (extra.is_enabled === true) percent = number(extra.used_credits) && extra.used_credits >= 0 && number(extra.monthly_limit) && extra.monthly_limit > 0 ? 100 * extra.used_credits / extra.monthly_limit : number(extra.utilization) && extra.utilization >= 0 ? extra.utilization : undefined;
  if (number(percent)) windows.push({ id: "monthly_spend", kind: "monthly", label: "Monthly spend", usedPercent: clamp(percent) });
  return { checkedAt, windows };
}

export function claudeCreditsFromResponse(block: unknown, now: number): ServerProviderResetCredits | undefined {
  const b = object(block); if (b.eligible !== true) return undefined;
  const live = (Array.isArray(b.grants) ? b.grants : []).map(object).filter(g => typeof g.id === "string" && /^[a-z0-9_-]{1,40}$/.test(g.id) && Number.isSafeInteger(g.resets_left) && (g.resets_left as number) >= 0 && g.paused !== true && g.usable_now === true && (g.ends_at == null || (typeof g.ends_at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(g.ends_at) && Date.parse(g.ends_at) > now && validCalendarDate(g.ends_at))));
  const next = live.find(g => g.id === b.next_grant_id); const nextExpiresAt = next ? iso(next.ends_at) : undefined;
  return { availableCount: next ? Math.min(Number.MAX_SAFE_INTEGER, live.reduce((n, g) => n + (g.resets_left as number), 0)) : 0, ...(nextExpiresAt ? { nextExpiresAt } : {}), ...(next && typeof next.id === "string" ? { nextCreditId: next.id } : {}) };
}

export function grokLimitsFromResponse(response: Obj, checkedAt: string): ServerProviderUsageLimits {
  const config = object(response.config), period = object(config.currentPeriod); const kind = period.type === "USAGE_PERIOD_TYPE_WEEKLY" || period.type === "WEEKLY" ? "weekly" : period.type === "USAGE_PERIOD_TYPE_MONTHLY" || period.type === "MONTHLY" ? "monthly" : "other";
  let percent = config.creditUsagePercent;
  const validPeriod = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)) && validCalendarDate(v);
  if (percent === undefined && kind !== "other" && validPeriod(period.start) && validPeriod(period.end) && Date.parse(period.start) < Date.parse(period.end)) percent = 0;
  if (!number(percent)) return { checkedAt, windows: [] };
  const resetsAt = iso(period.end); return { checkedAt, windows: [{ id: "subscription", kind, label: kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Subscription", usedPercent: clamp(percent), ...(resetsAt ? { resetsAt } : {}) }] };
}

function hasExplicitProxy(instance: StoredProviderInstance): boolean {
  return Object.entries(instance.env).some(([key, value]) => /^(?:https?_proxy|all_proxy)$/i.test(key) && Boolean(value.trim()));
}
async function grokProbe(instance: StoredProviderInstance, signal?: AbortSignal): Promise<ServerProviderUsageLimits> {
  const env = providerContext(instance).env;
  if (hasExplicitProxy(instance) || ["XAI_API_KEY", "GROK_OIDC_ISSUER", "GROK_OIDC_CLIENT_ID", "GROK_OAUTH2_ISSUER", "GROK_OAUTH2_CLIENT_ID", "GROK_OAUTH2_PRINCIPAL_TYPE", "GROK_OAUTH2_PRINCIPAL_ID", "GROK_AUTH_PROVIDER_COMMAND", "GROK_LOCAL_AUTH", "GROK_CLI_CHAT_PROXY_BASE_URL", "GROK_MODELS_BASE_URL", "GROK_CONFIG", "GROK_CONFIG_PATH"].some(k => text(env[k]))) return unavailable("unsupported");
  for (const file of ["config.toml", "managed_config.toml", "requirements.toml"]) {
    let config = ""; try { config = await readFile(path.join(instance.homeDirectory, file), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (/^\s*(?:\[\[?\s*)?["']?(?:auth|grok_com_config|endpoints)["']?\s*[.\]=]/m.test(config)) return unavailable("unsupported");
  }
  const credentials = text(env.GROK_AUTH) ? object(JSON.parse(env.GROK_AUTH!)) : await jsonFile(path.join(instance.homeDirectory, "auth.json"));
  const credential = object(credentials["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"] ?? credentials["https://accounts.x.ai/sign-in"]);
  const token = text(credential.key); if (!token || credential.auth_mode === "api_key") return unavailable("unsupported");
  assertRevision(instance);
  const response = await requestJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { headers: { authorization: `Bearer ${token}` } }, signal);
  const latest = text(env.GROK_AUTH) ? credentials : await jsonFile(path.join(instance.homeDirectory, "auth.json"));
  const selected = object(latest["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"] ?? latest["https://accounts.x.ai/sign-in"]);
  if (selected.key !== credential.key || selected.email !== credential.email) throw new Error("Account changed.");
  assertRevision(instance);
  const email = text(credential.email); const limits = grokLimitsFromResponse(response, new Date().toISOString());
  return withFingerprint(email ? { ...limits, account: { email } } : limits, "grok", email);
}
async function codexProbe(instance: StoredProviderInstance, signal?: AbortSignal): Promise<ServerProviderUsageLimits> {
  if (hasExplicitProxy(instance)) return unavailable("unsupported");
  const context = providerContext(instance); const client = await CodexRpc.open(context, timeout(signal, 20_000));
  try { const account = object((await client.request("account/read", {}, 10_000)).account); if (account.type !== "chatgpt") return unavailable("unsupported");
    const response = await client.request("account/rateLimits/read", {}, 10_000); if (!response.rateLimits && !object(response.rateLimitsByLimitId).codex) throw new Error("Missing limits");
    const latest = object((await client.request("account/read", {}, 10_000)).account);
    if (JSON.stringify(account) !== JSON.stringify(latest) || (text(account.accountId) && text(response.accountId) && text(account.accountId) !== text(response.accountId))) throw new Error("Account changed.");
    assertRevision(instance);
    const accountId = text(response.accountId) ?? text(account.accountId);
    const email = text(account.email);
    const snapshot = object(object(response.rateLimitsByLimitId).codex ?? response.rateLimits);
    const plan = text(account.planType) ?? text(snapshot.planType);
    const limits = codexLimitsFromResponse(response, new Date().toISOString());
    return withFingerprint(accountId || email || plan ? { ...limits, account: { ...(accountId ? { id: accountId } : {}), ...(email ? { email } : {}), ...(plan ? { plan } : {}) } } : limits, "codex", accountId);
  } finally { client.close(); }
}
async function claudeVersion(instance: StoredProviderInstance, signal?: AbortSignal): Promise<string> {
  const context = providerContext(instance); const result = await runProviderCommand(String(context.config.binaryPath || "claude"), ["--version"], { cwd: context.cwd, env: context.env, signal, timeoutMs: 10_000 });
  const version = result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0]; if (!version || result.code !== 0) throw new Error("Claude version unavailable."); return version;
}
async function claudeIdentity(instance: StoredProviderInstance) {
  const credential = object((await jsonFile(path.join(instance.homeDirectory, ".credentials.json"))).claudeAiOauth);
  const config = object((await jsonFile(path.join(instance.homeDirectory, ".claude.json"))).oauthAccount);
  return { token: text(credential.accessToken), organization: text(config.organizationUuid) };
}
const claudeHeaders = (token: string, version: string) => ({ authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "user-agent": `claude-cli/${version} (external, cli)` });
function claudeExternal(env: NodeJS.ProcessEnv): boolean { return ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_CUSTOM_HEADERS"].some(k => text(env[k])); }
async function claudeProbe(instance: StoredProviderInstance, signal?: AbortSignal): Promise<ServerProviderUsageLimits> {
  const context = providerContext(instance); const settings = await jsonFile(path.join(instance.homeDirectory, "settings.json"));
  const settingsEnv = Object.fromEntries(Object.entries(object(settings.env)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  if (hasExplicitProxy(instance) || claudeExternal(context.env) || claudeExternal(settingsEnv)) return unavailable("unsupported");
  const initialIdentity = await claudeIdentity(instance);
  const abort = new AbortController(); const combined = timeout(signal, 25_000); const release = Promise.withResolvers<void>(); const stop = () => { abort.abort(); release.resolve(); }; combined.addEventListener("abort", stop, { once: true }); if (combined.aborted) stop(); let q: Query | undefined;
  try {
    const options = await claudeQueryOptions(context, abort, true);
    // oxlint-disable-next-line require-yield -- Control-only SDK stream stays open without sending a user prompt or starting inference.
    q = query({ prompt: (async function* (): AsyncGenerator<SDKUserMessage> { await release.promise; })(), options });
    const init = await q.initializationResult(); const account = object(init.account);
    if (account.apiProvider && account.apiProvider !== "firstParty" || account.apiKeySource && account.apiKeySource !== "none" || !account.subscriptionType) return unavailable("unsupported");
    const result = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    let limits = claudeLimitsFromResponse(object(result), new Date().toISOString());
    const identity = await claudeIdentity(instance);
    if (!limits.unavailable && identity.token && process.platform !== "darwin") {
      try { const version = await claudeVersion(instance, combined); const body = await requestJson("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1", { headers: claudeHeaders(identity.token, version) }, combined); const resetCredits = claudeCreditsFromResponse(body.cedar_ember, Date.now()); if (resetCredits) limits = { ...limits, resetCredits }; } catch { /* Credits are optional; preserve actual windows. */ }
    }
    const latestIdentity = await claudeIdentity(instance); if (latestIdentity.token !== identity.token || latestIdentity.organization !== identity.organization || initialIdentity.token !== identity.token || initialIdentity.organization !== identity.organization) throw new Error("Account changed.");
    assertRevision(instance);
    const email = text(account.email); const plan = text(account.subscriptionType); const workspaceId = identity.organization;
    if (email || plan || workspaceId) limits = { ...limits, account: { ...(email ? { email } : {}), ...(plan ? { plan } : {}), ...(workspaceId ? { workspaceId } : {}) } };
    return withFingerprint(limits, "claude", workspaceId);
  } finally { combined.removeEventListener("abort", stop); stop(); q?.close(); }
}
export async function probeCoreUsageLimits(instance: StoredProviderInstance, signal?: AbortSignal): Promise<ServerProviderUsageLimits> {
  try { if (signal?.aborted) throw new Error("Cancelled"); assertRevision(instance); if (instance.driver === "codex") return await codexProbe(instance, signal); if (instance.driver === "claude") return await claudeProbe(instance, signal); if (instance.driver === "grok") return await grokProbe(instance, signal); return unavailable("unsupported"); }
  catch { return unavailable("probeFailed", "Provider could not read usage limits."); }
}

// Unconfirmed outcomes retain the request key for an explicit subsequent attempt.
const resetKeys = new Map<string, { requestId: string; grantId?: string }>();
const resetRunning = new Set<string>();
export async function consumeCoreResetCredit(instance: StoredProviderInstance, signal?: AbortSignal): Promise<ProviderConsumeResetCreditResult> {
  if (instance.driver !== "codex" && instance.driver !== "claude") throw new Error("This provider does not support reset credits.");
  const context = providerContext(instance); assertRevision(instance); const home = await realpath(instance.homeDirectory).catch(() => instance.homeDirectory);
  const key = `${instance.driver}:${home}`; if (resetRunning.has(key)) throw new Error("A reset is already in progress for this account."); resetRunning.add(key);
  try {
    if (instance.driver === "codex") {
      if (hasExplicitProxy(instance)) throw new Error("Codex reset is unavailable with a proxy.");
      const client = await CodexRpc.open(context, timeout(signal, 20_000));
      try {
        const account = object((await client.request("account/read", {}, 10_000)).account); if (account.type !== "chatgpt") throw new Error("Codex reset requires a ChatGPT account.");
        const limits = await client.request("account/rateLimits/read", {}, 10_000); const accountKey = `${key}:${text(limits.accountId) ?? text(account.accountId) ?? "unknown"}`;
        const latest = object((await client.request("account/read", {}, 10_000)).account);
        if (JSON.stringify(account) !== JSON.stringify(latest) || (text(account.accountId) && text(limits.accountId) && text(account.accountId) !== text(limits.accountId))) throw new Error("Account changed.");
        assertRevision(instance); const requestId = resetKeys.get(accountKey)?.requestId ?? randomUUID(); resetKeys.set(accountKey, { requestId });
        const response = await client.request("account/rateLimitResetCredit/consume", { idempotencyKey: requestId }, 20_000);
        if (!["reset", "nothingToReset", "noCredit", "alreadyRedeemed"].includes(String(response.outcome))) throw new Error("Codex could not confirm the reset.");
        resetKeys.delete(accountKey); return { outcome: response.outcome as ProviderConsumeResetCreditResult["outcome"] };
      } finally { client.close(); }
    }
    const settings = await jsonFile(path.join(instance.homeDirectory, "settings.json"));
    const settingsEnv = Object.fromEntries(Object.entries(object(settings.env)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    if (hasExplicitProxy(instance) || claudeExternal(context.env) || claudeExternal(settingsEnv) || process.platform === "darwin") throw new Error("Claude reset is unavailable for this authentication method.");
    const identity = await claudeIdentity(instance); if (!identity.token || !identity.organization) throw new Error("Claude account credentials are unavailable.");
    const version = await claudeVersion(instance, signal); const accountKey = `${key}:${fingerprint("claude", identity.organization)}`;
    const pending = resetKeys.get(accountKey);
    let grant = pending?.grantId;
    if (!grant) {
      const usage = await requestJson("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1", { headers: claudeHeaders(identity.token, version) }, signal);
      grant = claudeCreditsFromResponse(usage.cedar_ember, Date.now())?.nextCreditId;
    }
    const latest = await claudeIdentity(instance); assertRevision(instance); if (latest.token !== identity.token || latest.organization !== identity.organization) throw new Error("Claude account changed during the reset.");
    if (!grant) return { outcome: "noCredit" };
    const requestId = pending?.requestId ?? randomUUID(); resetKeys.set(accountKey, { requestId, grantId: grant });
    const result = await requestJson(`https://api.anthropic.com/api/organizations/${encodeURIComponent(identity.organization)}/reset_rate_limits`, { method: "POST", headers: { ...claudeHeaders(identity.token, version), "content-type": "application/json" }, body: JSON.stringify({ program: "cedar_ember", grant_id: grant, request_id: requestId }) }, signal);
    const outcomes: Record<string, ProviderConsumeResetCreditResult["outcome"]> = { reset: "reset", not_limited: "nothingToReset", already_used: "alreadyRedeemed", ineligible: "noCredit" };
    const outcome = typeof result.result === "string" ? outcomes[result.result] : undefined; if (!outcome) throw new Error("Claude could not confirm the reset."); resetKeys.delete(accountKey); return { outcome };
  } catch { throw new Error("Provider could not confirm the reset. Check the account before trying again."); }
  finally { resetRunning.delete(key); }
}
