// Adapted from t3code OpenCode, Antigravity and Muse usage readers.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { createReadStream, type Stats } from "node:fs";
import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldNow } from "node:timers/promises";
import type { UsageProviderKind, UsageSource } from "@agent-workspace/contracts/usage";
import type { StoredProviderInstance } from "../../providers/instances.ts";
import { providerEnvironment } from "../../providers/instances.ts";
import { createMuseHost } from "../../providers/drivers/muse-sdk.ts";
import type { UsageReadContext, UsageRecord, UsageScan } from "../types.ts";
import { tokenCount, totalTokens } from "../types.ts";
import { readAntigravityDatabase, type Candidate } from "./antigravity-database.ts";

type State = { source: UsageSource; records: UsageRecord[]; found: boolean; errors: number };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const configuredPath = (value: string, home: string) => path.resolve(value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value);

function parseOpenCode(raw: unknown, fallback: { id?: string; sessionId?: string; timestamp?: number }): UsageRecord | null {
  const message = object(raw); if (message.role !== undefined && message.role !== "assistant") return null;
  const usage = object(message.tokens), cache = object(usage.cache), modelRef = object(message.model);
  const model = string(modelRef.id) || string(modelRef.modelID) || string(message.modelID);
  const timestamp = object(message.time).created ?? fallback.timestamp;
  if (!model || typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  const reasoningTokens = tokenCount(usage.reasoning);
  const totals = { uncachedInputTokens: tokenCount(usage.input), cachedInputTokens: tokenCount(cache.read), cacheCreationTokens: tokenCount(cache.write), outputTokens: Math.min(Number.MAX_SAFE_INTEGER, tokenCount(usage.output) + reasoningTokens), reasoningTokens };
  if (!totalTokens(totals)) return null;
  const id = fallback.id || string(message.id); const cost = message.cost;
  return { provider: "opencode", timestampMs: timestamp, model, sessionId: fallback.sessionId || string(message.sessionID), totals, reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null, speed: "standard", dedupeKey: id ? `opencode:${id}` : null };
}
function parseMuse(raw: unknown): UsageRecord | null {
  const entry = object(raw), stream = object(entry.stream), payload = object(entry.payload), event = object(payload.event), usage = object(event.usage);
  if (entry.schema_version !== 1 || entry.record_type !== "event" || entry.payload_type !== "runtime.session" || (entry.payload_schema_version !== 1 && entry.payload_schema_version !== 3) || !string(entry.id) || stream.kind !== "session" || !string(stream.id) || (event.kind !== "model_completed" && event.kind !== "automated_review_completed") || !Number.isSafeInteger(entry.recorded_at) || Number(entry.recorded_at) < 0) return null;
  const model = string(event.model) || string(object(event.model).model_id); if (!model) return null;
  const input = tokenCount(usage.input_tokens), cached = Math.min(input, tokenCount(usage.cache_read_tokens ?? usage.cached_input_tokens ?? usage.cached_tokens)), write = Math.min(input - cached, tokenCount(usage.cache_write_tokens)), output = tokenCount(usage.output_tokens);
  const totals = { uncachedInputTokens: input - cached - write, cachedInputTokens: cached, cacheCreationTokens: write, outputTokens: output, reasoningTokens: Math.min(output, tokenCount(usage.reasoning_tokens)) };
  if (!totalTokens(totals)) return null;
  const cost = usage.cost_usd ?? event.cost_usd;
  return { provider: "muse", timestampMs: Math.trunc(Number(entry.recorded_at) / 1000), model, sessionId: string(stream.id), totals, reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null, speed: "standard", dedupeKey: JSON.stringify(["muse", string(payload.source_run_record_id) || string(entry.id)]) };
}

async function walk(root: string, visit: (file: string, info: Stats) => Promise<void>, state: State, signal?: AbortSignal): Promise<void> {
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink()) { state.source.skippedFiles++; state.errors++; return; }
  } catch (error) { if (!missing(error)) state.errors++; return; }
  const directories = [root];
  while (directories.length) {
    signal?.throwIfAborted(); const directory = directories.pop()!;
    try {
      const entries = await opendir(directory);
      for await (const entry of entries) {
        signal?.throwIfAborted(); if (entry.isSymbolicLink()) { state.source.skippedFiles++; continue; }
        const file = path.join(directory, entry.name);
        try {
          const info = await lstat(file); if (info.isSymbolicLink()) { state.source.skippedFiles++; continue; }
          if (info.isDirectory()) directories.push(file); else if (info.isFile()) await visit(file, info);
        } catch (error) { if (!missing(error)) state.errors++; }
      }
    } catch (error) { if (!missing(error)) { signal?.throwIfAborted(); state.errors++; } }
  }
}
function append(state: State, record: UsageRecord | null, context: UsageReadContext, instanceId: string): void {
  if (record && record.timestampMs >= context.sinceMs && record.timestampMs < context.untilMs) state.records.push({ ...record, instanceId });
}
async function readOpenCode(root: string, state: State, context: UsageReadContext, instanceId: string, visited: Set<string>): Promise<void> {
  try {
    const entries = await opendir(root); const dbs: string[] = [];
    for await (const entry of entries) if (entry.isFile() && /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(entry.name)) dbs.push(path.join(root, entry.name));
    dbs.sort((a, b) => path.basename(a) === "opencode.db" ? -1 : path.basename(b) === "opencode.db" ? 1 : a.localeCompare(b));
    for (const file of dbs) {
      context.signal?.throwIfAborted(); state.found = true;
      try {
        const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) { state.source.skippedFiles++; continue; }
        const identity = `${info.dev}:${info.ino}`; if (visited.has(identity)) continue; visited.add(identity);
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          db.exec("PRAGMA busy_timeout = 100; PRAGMA query_only = ON");
          const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
          if (!tables.has("message") && !tables.has("session_message")) throw new Error("Unrecognized OpenCode database");
          for (const table of ["message", "session_message"]) {
            if (!tables.has(table)) continue;
            const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
            const timestamp = columns.has("time_created") ? "time_created" : "NULL";
            const stmt = db.prepare(`SELECT rowid AS row_id, id, session_id, data, ${timestamp} AS created${table === "session_message" ? ", type" : ""} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 64`);
            let after = -Number.MAX_SAFE_INTEGER;
            while (true) {
              context.signal?.throwIfAborted(); const rows = stmt.all(after); if (!rows.length) break;
              for (const row of rows) {
                if (table === "session_message" && row.type !== "assistant") continue;
                try { append(state, parseOpenCode(JSON.parse(string(row.data)), { id: string(row.id), sessionId: string(row.session_id), ...(typeof row.created === "number" ? { timestamp: row.created } : {}) }), context, instanceId); } catch { state.source.malformedRecords++; }
              }
              after = Number(rows[rows.length - 1]!.row_id);
              await yieldNow();
            }
          }
          state.source.scannedFiles++;
        } finally { db.close(); }
      } catch { context.signal?.throwIfAborted(); state.errors++; }
    }
  } catch (error) { if (!missing(error)) { context.signal?.throwIfAborted(); state.errors++; } }
  try {
    if ((await lstat(path.join(root, "storage"))).isSymbolicLink()) { state.source.skippedFiles++; state.errors++; return; }
  } catch (error) { if (!missing(error)) state.errors++; return; }
  await walk(path.join(root, "storage", "message"), async (file, info) => {
    if (!file.endsWith(".json")) return; state.found = true;
    const identity = `${info.dev}:${info.ino}`; if (visited.has(identity)) return; visited.add(identity);
    if (info.size > 8 * 1024 * 1024) { state.source.skippedFiles++; state.errors++; return; }
    try { const raw = JSON.parse(await readFile(file, "utf8")); state.source.scannedFiles++; append(state, parseOpenCode(raw, { id: path.basename(file, ".json") }), context, instanceId); }
    catch (error) { if (error instanceof SyntaxError) state.source.malformedRecords++; else state.errors++; }
  }, state, context.signal);
}
async function readMuse(root: string, state: State, context: UsageReadContext, instanceId: string, visited: Set<string>): Promise<void> {
  await walk(path.join(root, "sessions"), async (file, info) => {
    if (path.basename(file) !== "session.jsonl") return; state.found = true;
    const identity = `${info.dev}:${info.ino}`; if (visited.has(identity)) return; visited.add(identity);
    try {
      const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024, signal: context.signal }); let pending = "", oversized = false;
      const line = (value: string) => {
        if (!value.trim()) return;
        try { const parsed: unknown = JSON.parse(value); const event = object(object(object(parsed).payload).event); if (event.kind === "model_completed" || event.kind === "automated_review_completed") { const record = parseMuse(parsed); if (record) append(state, record, context, instanceId); else state.source.malformedRecords++; } }
        catch { state.source.malformedRecords++; }
      };
      for await (const chunk of stream) {
        context.signal?.throwIfAborted(); const input = String(chunk); let start = 0, end: number;
        while ((end = input.indexOf("\n", start)) !== -1) { const part = input.slice(start, end); if (!oversized && pending.length + part.length <= 1024 * 1024) line(pending + part); else state.source.malformedRecords++; pending = ""; oversized = false; start = end + 1; }
        const remainder = input.slice(start); if (!oversized && pending.length + remainder.length <= 1024 * 1024) pending += remainder; else { pending = ""; oversized = true; }
      }
      if (oversized) state.source.malformedRecords++; else if (pending) line(pending);
      state.source.scannedFiles++;
    } catch { context.signal?.throwIfAborted(); state.errors++; }
  }, state, context.signal);
}
async function museHome(instance: StoredProviderInstance, signal?: AbortSignal): Promise<string> {
  if (instance.env.MUSE_HOME?.trim()) return configuredPath(instance.env.MUSE_HOME.trim(), instance.homeDirectory);
  const host = await createMuseHost({ instanceId: instance.instanceId, driver: instance.driver, revision: instance.revision, config: instance.config, homeDirectory: instance.homeDirectory, cwd: instance.homeDirectory, env: providerEnvironment(instance) }, { signal, readOnly: true, startupTimeoutMs: 5_000 });
  try {
    const home = host.initializeResult.museHome;
    if (typeof home !== "string" || !path.isAbsolute(home)) throw new Error("Muse did not report its history home");
    const resolved = await realpath(home), allowed = await realpath(instance.homeDirectory);
    if (resolved !== allowed && !resolved.startsWith(`${allowed}${path.sep}`)) throw new Error("Muse reported a history home outside its dedicated home");
    return resolved;
  } finally { await host.close(); }
}
async function roots(instance: StoredProviderInstance, signal?: AbortSignal): Promise<string[]> {
  const home = instance.homeDirectory;
  if (instance.driver === "opencode") {
    const configured = instance.env.OPENCODE_DATA_DIR?.split(",").map(value => value.trim()).filter(Boolean);
    return configured?.length ? configured.map(value => configuredPath(value, home)) : [path.join(home, ".local", "share", "opencode")];
  }
  if (instance.driver === "antigravity") {
    const configured = instance.env.ANTIGRAVITY_DATA_DIR?.split(",").map(value => value.trim()).filter(Boolean).map(value => configuredPath(value, home)) ?? [];
    return [...configured, path.join(home, "antigravity-acp"), ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map(name => path.join(home, ".gemini", name)), path.join(home, ".config", "antigravity")];
  }
  return [await museHome(instance, signal)];
}

export async function scanDatabaseUsage(context: UsageReadContext): Promise<UsageScan[]> {
  const scans: State[] = [], rootsSeen = new Map<string, State>(), visited = new Set<string>(); const anti: Array<Candidate & { state: State; parent: number; owner: number }> = [], identities = new Map<string, number>();
  const find = (index: number): number => { while (anti[index]!.parent !== index) { anti[index]!.parent = anti[anti[index]!.parent]!.parent; index = anti[index]!.parent; } return index; };
  const addCandidate = (candidate: Candidate, state: State) => {
    const index = anti.length; anti.push({ ...candidate, state, parent: index, owner: index });
    for (const key of candidate.keys) {
      const existing = identities.get(key);
      if (existing !== undefined) {
        const a = find(index), b = find(existing);
        if (a !== b) {
          const target = anti[a]!, other = anti[b]!, first = target.owner < other.owner ? target : other;
          const best = other.quality > target.quality || (other.quality === target.quality && other.record.timestampMs < target.record.timestampMs) ? other : target;
          const x = target.record.totals, y = other.record.totals;
          target.record = { ...first.record, model: first.record.model === "antigravity-unknown" ? (first === target ? other.record.model : target.record.model) : first.record.model, timestampMs: best.record.timestampMs, totals: { uncachedInputTokens: Math.max(x.uncachedInputTokens, y.uncachedInputTokens), cachedInputTokens: Math.max(x.cachedInputTokens, y.cachedInputTokens), cacheCreationTokens: Math.max(x.cacheCreationTokens, y.cacheCreationTokens), outputTokens: Math.max(x.outputTokens, y.outputTokens), reasoningTokens: Math.max(x.reasoningTokens, y.reasoningTokens) } };
          target.quality = best.quality; target.owner = first.owner; target.state = first.state; other.parent = a;
        }
      }
      identities.set(key, index);
    }
  };
  for (const instance of context.instances) {
    context.signal?.throwIfAborted(); if (instance.driver !== "opencode" && instance.driver !== "antigravity" && instance.driver !== "muse") continue;
    let dirs: string[]; let resolutionFailed = false;
    try { dirs = await roots(instance, context.signal); } catch { context.signal?.throwIfAborted(); dirs = [instance.homeDirectory]; resolutionFailed = true; }
    for (let root of dirs) {
      context.signal?.throwIfAborted();
      if (instance.driver === "antigravity") { const nested = path.join(root, "conversations"); if (await lstat(nested).then(info => info.isDirectory() && !info.isSymbolicLink(), () => false)) root = nested; }
      const resolved = await realpath(root).catch(() => path.resolve(root)); const info = await stat(resolved).catch(() => null); const volume = info ? `${info.dev}:${info.ino}` : resolved;
      const rootKey = `${instance.driver}:${volume}`; const previous = rootsSeen.get(rootKey);
      if (previous) { if (!previous.source.instanceIds?.includes(instance.instanceId)) previous.source.instanceIds?.push(instance.instanceId); continue; }
      const provider = instance.driver as UsageProviderKind;
      const state: State = { source: { fingerprint: { hostId: "local", provider, resolvedHomePath: resolved, volumeId: volume }, status: "missing", scannedFiles: 0, skippedFiles: 0, malformedRecords: 0, distinctSessions: 0, message: null, instanceIds: [instance.instanceId], label: instance.label }, records: [], found: false, errors: resolutionFailed ? 1 : 0 };
      rootsSeen.set(rootKey, state); scans.push(state);
      if (resolutionFailed) continue;
      if (provider === "opencode") await readOpenCode(resolved, state, context, instance.instanceId, visited);
      else if (provider === "muse") await readMuse(resolved, state, context, instance.instanceId, visited);
      else await walk(resolved, async (file, entry) => {
        if (!file.endsWith(".db")) return; state.found = true;
        const identity = `${entry.dev}:${entry.ino}`; if (visited.has(identity)) return; visited.add(identity);
        try {
          const result = await readAntigravityDatabase(file, path.basename(file, ".db"), entry.mtimeMs, context.signal); state.source.scannedFiles++; state.source.malformedRecords += result.malformed;
          for (const candidate of result.candidates) addCandidate({ ...candidate, record: { ...candidate.record, instanceId: instance.instanceId } }, state);
        } catch { context.signal?.throwIfAborted(); state.errors++; }
      }, state, context.signal);
    }
  }
  for (let index = 0; index < anti.length; index++) if (find(index) === index) { const item = anti[index]!; append(item.state, item.record, context, item.record.instanceId!); }
  const seen = new Set<string>();
  return scans.map(state => {
    state.records = state.records.filter(record => { if (!record.dedupeKey) return true; if (seen.has(record.dedupeKey)) return false; seen.add(record.dedupeKey); return true; });
    state.source.distinctSessions = new Set(state.records.map(record => record.sessionId).filter(Boolean)).size;
    state.source.status = state.errors || state.source.malformedRecords ? (state.found || state.source.scannedFiles ? "partial" : "failed") : state.found ? "ok" : "missing";
    state.source.message = state.source.status === "missing" ? "No native usage history found in the configured location." : state.source.status === "partial" || state.source.status === "failed" ? "Some native usage history could not be read or decoded." : null;
    return { source: state.source, records: state.records };
  });
}
