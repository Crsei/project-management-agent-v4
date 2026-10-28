// Adapted from t3code accountUsage.ts and CursorUsageAccounts.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { usageTokenTotalsSchema } from "@agent-workspace/contracts/usage";
import { providerDataDirectory } from "../../providers/instances.ts";
import type { UsageSource } from "@agent-workspace/contracts/usage";
import type { UsageReadContext, UsageRecord, UsageScan } from "../types.ts";
import { tokenCount } from "../types.ts";
import { cursorAccount, cursorCredential, cursorEndpoint, CURSOR_ENDPOINT, hash } from "../cursor-auth.ts";

const TTL_MS = 5 * 60_000;
const URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";
type Cache = { records: UsageRecord[]; fetchedAt: number; attemptedAt?: number; failure?: string; pending?: Promise<void> };
const caches = new Map<string, Map<string, Cache>>();
const loading = new Map<string, Promise<Map<string, Cache>>>();
const writes = new Map<string, Promise<void>>();
const cachedRecord = z.object({
  provider: z.literal("cursor"), timestampMs: z.number().finite(), model: z.string().min(1), rateModel: z.string().optional(),
  sessionId: z.string(), totals: usageTokenTotalsSchema, reportedCostUsd: z.number().finite().nonnegative().nullable(),
  speed: z.literal("standard"), dedupeKey: z.string().nullable(),
});
async function loadCache(file: string): Promise<Map<string, Cache>> {
  const existing = caches.get(file);
  if (existing) return existing;
  let pending = loading.get(file);
  if (!pending) {
    pending = (async () => {
      const entries = new Map<string, Cache>();
      try {
        const parsed = z.array(z.object({ key: z.string().regex(/^[a-f0-9]{64}:\d+:\d+$/), fetchedAt: z.number().finite(), records: z.array(cachedRecord) })).parse(JSON.parse(await readFile(file, "utf8")));
        for (const row of parsed) if (row.fetchedAt > Date.now() - 90 * 86400_000) entries.set(row.key, { records: row.records, fetchedAt: row.fetchedAt });
      } catch { /* A missing or invalid cache is never authoritative. */ }
      caches.set(file, entries); loading.delete(file); return entries;
    })();
    loading.set(file, pending);
  }
  return pending;
}
async function persistCache(file: string, entries: Map<string, Cache>): Promise<void> {
  const previous = writes.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const rows = [...entries].filter(([, value]) => value.fetchedAt > 0).sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, 64)
      .map(([key, value]) => ({ key, fetchedAt: value.fetchedAt, records: value.records }));
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(rows), { mode: 0o600 }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => {}); }
  }).catch(() => {});
  writes.set(file, next); await next;
  if (writes.get(file) === next) writes.delete(file);
}
function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function overlap(previous: string[], current: string[]): number {
  const sequence = [...current, "", ...previous], lengths = Array<number>(sequence.length).fill(0);
  for (let i = 1; i < sequence.length; i++) { let n = lengths[i - 1]!; while (n && sequence[i] !== sequence[n]) n = lengths[n - 1]!; if (sequence[i] === sequence[n]) n++; lengths[i] = n; }
  return lengths.at(-1) ?? 0;
}
function rateModel(model: string): string {
  const base = model.replace(/^cursor-/, "").replace(/(?:-thinking)?(?:-(?:none|minimal|low|medium|high|xhigh|max))?(?:-fast)?$/, "");
  return base.startsWith("grok-") ? `xai/${base}` : base;
}
async function fetchAccount(token: string, userId: string, account: string, since: number, until: number, signal?: AbortSignal): Promise<UsageRecord[]> {
  if (!Number.isFinite(since) || !Number.isFinite(until) || since < 0 || since > until) throw new Error("Invalid date range");
  const pages: unknown[][] = []; let total: number | undefined;
  for (let page = 1; ; page++) {
    if (page > (total === undefined ? 1000 : Math.ceil(total / 1000) * 2 + 1)) throw new Error("Page limit");
    const response = await fetch(URL, { method: "POST", redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]), headers: { Origin: "https://cursor.com", Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`, "content-type": "application/json" }, body: JSON.stringify({ page, pageSize: 1000, startDate: String(since), endDate: String(until) }) });
    if (!response.ok) throw new Error("Account request failed");
    const raw = await response.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid account page");
    const body = object(raw), keys = Object.keys(body);
    if ("error" in body || "message" in body || "code" in body) throw new Error("Account error");
    const count = keys.length === 0 ? 0 : body.totalUsageEventsCount;
    const events = keys.length === 0 || (keys.length === 1 && keys[0] === "totalUsageEventsCount") ? [] : body.usageEventsDisplay;
    if ((count !== undefined && (!Number.isSafeInteger(count) || count < 0 || (total !== undefined && count !== total))) || !Array.isArray(events) || events.length > 1000 || (count === undefined && !Array.isArray(body.usageEventsDisplay))) throw new Error("Invalid account page");
    if (typeof count === "number") total = count;
    pages.push(events);
    if (events.length < 1000) break;
  }
  const rawCount = pages.reduce((sum, page) => sum + page.length, 0);
  if (total !== undefined && rawCount < total) throw new Error("Incomplete account pages");
  let remaining = total === undefined ? 0 : rawCount - total, previous: string[] = [];
  const records: UsageRecord[] = [], occurrences = new Map<string, number>();
  for (const events of pages) {
    const keys = remaining ? events.map((event) => hash(canonical(event))) : [];
    const remove = Math.min(remaining, overlap(previous, keys)); remaining -= remove; previous = keys;
    for (const raw of events.slice(remove)) {
      const event = object(raw);
      if (event.tokenUsage === undefined || event.tokenUsage === null) continue;
      const usage = object(event.tokenUsage);
      for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalCents"]) if (usage[key] !== undefined && (typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || usage[key] < 0)) throw new Error("Invalid totals");
      const timestampMs = typeof event.timestamp === "string" && event.timestamp.trim() ? Number(event.timestamp) : event.timestamp;
      if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs) || typeof event.model !== "string" || !event.model) throw new Error("Invalid event");
      if (timestampMs < since || timestampMs > until) continue;
      const totals = { uncachedInputTokens: tokenCount(usage.inputTokens), cachedInputTokens: tokenCount(usage.cacheReadTokens), cacheCreationTokens: tokenCount(usage.cacheWriteTokens), outputTokens: tokenCount(usage.outputTokens), reasoningTokens: 0 };
      const reportedCostUsd = typeof usage.totalCents === "number" ? usage.totalCents / 100 : null;
      const sessionId = typeof event.conversationId === "string" ? event.conversationId : "";
      const key = hash(JSON.stringify([timestampMs, event.model, sessionId, totals, reportedCostUsd]));
      const occurrence = occurrences.get(key) ?? 0; occurrences.set(key, occurrence + 1);
      records.push({ provider: "cursor", timestampMs, model: event.model, rateModel: rateModel(event.model), sessionId, totals, reportedCostUsd, speed: "standard", dedupeKey: `cursor-account:${account}:${key}:${occurrence}` });
    }
  }
  if (remaining) throw new Error("Inconsistent boundaries");
  return records;
}
export async function scanCursorUsage(context: UsageReadContext): Promise<UsageScan[]> {
  const cacheFile = path.join(providerDataDirectory(), "cursor-usage-cache.json");
  const cache = await loadCache(cacheFile);
  const scans: UsageScan[] = [], byAccount = new Map<string, UsageScan>();
  for (const instance of context.instances.filter((entry) => entry.driver === "cursor")) {
    const makeSource = (status: UsageSource["status"], message: string | null): UsageSource => ({ fingerprint: { hostId: "local", provider: "cursor", resolvedHomePath: instance.homeDirectory, volumeId: instance.instanceId }, status, scannedFiles: 0, skippedFiles: 0, malformedRecords: 0, distinctSessions: 0, message, instanceIds: [instance.instanceId], label: instance.label });
    try {
      if (cursorEndpoint(instance) !== CURSOR_ENDPOINT) { scans.push({ source: makeSource("missing", "Cursor account history requires the default Cursor endpoint."), records: [] }); continue; }
      const credential = await cursorCredential(instance, context.settings.cursorKeychainUsageEnabled);
      if (!credential.token) {
        const source = makeSource("missing", credential.message ?? "Cursor account login not found.");
        if (credential.keychain && !context.settings.cursorKeychainUsageEnabled && cursorEndpoint(instance) === CURSOR_ENDPOINT) source.action = "enableCursorKeychain";
        scans.push({ source, records: [] }); continue;
      }
      const account = cursorAccount(credential.token);
      if (!account) { scans.push({ source: makeSource("failed", "Cursor account credentials are invalid."), records: [] }); continue; }
      const existing = byAccount.get(account.account);
      if (existing && existing.source.status !== "failed") { existing.source.instanceIds!.push(instance.instanceId); continue; }
      const key = `${account.account}:${context.sinceMs}:${context.untilMs}`;
      let entry = cache.get(key);
      if (!entry) { entry = { records: [], fetchedAt: 0 }; cache.set(key, entry); }
      if ((existing || context.awaitRefresh || Date.now() - (entry.attemptedAt ?? entry.fetchedAt) >= TTL_MS || (!entry.fetchedAt && !entry.attemptedAt)) && !entry.pending) {
        const current = entry, token = credential.token;
        current.pending = fetchAccount(token, account.userId, account.account, context.sinceMs, context.untilMs, context.awaitRefresh ? context.signal : undefined).then(async (records) => { current.records = records; current.fetchedAt = Date.now(); current.attemptedAt = current.fetchedAt; current.failure = undefined; await persistCache(cacheFile, cache); }, () => { current.failure = "Cursor account usage could not be read."; current.attemptedAt = Date.now(); }).finally(() => { current.pending = undefined; });
      }
      if (context.awaitRefresh && entry.pending) await entry.pending;
      const source = makeSource(entry.failure ? entry.fetchedAt ? "partial" : "failed" : "ok", entry.failure ?? null);
      source.fingerprint = { hostId: "cursor.com", provider: "cursor", resolvedHomePath: `cursor-account:${account.account}`, volumeId: account.account };
      source.scannedFiles = entry.fetchedAt ? 1 : 0;
      source.distinctSessions = new Set(entry.records.map((record) => record.sessionId).filter(Boolean)).size;
      if (entry.pending) source.refreshing = true;
      const scan = { source, records: entry.records.map((record) => ({ ...record, instanceId: instance.instanceId })) };
      if (existing) { scan.source.instanceIds = [...existing.source.instanceIds!, instance.instanceId]; scans[scans.indexOf(existing)] = scan; }
      else scans.push(scan);
      byAccount.set(account.account, scan);
    } catch { scans.push({ source: makeSource("failed", "Cursor account credentials could not be read."), records: [] }); }
  }
  return scans;
}
