// Usage-only persistence boundary for original TranscriptUsageFormat state codecs.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { usageProviderKindSchema, usageTokenTotalsSchema } from "@agent-workspace/contracts/usage";
import { providerDataDirectory } from "../../providers/instances.ts";
import type { UsageRecord } from "../types.ts";

export const TRANSCRIPT_CACHE_FILE = "usage-transcript-cache-v1.json";
const VERSION = 2;
const RETENTION_MS = 92 * 86400_000;
const MAX_CACHE_BYTES = 96 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_RECORDS = 200_000;
const MAX_STRING = 8192;
export interface TranscriptSourceIdentity { path: string; volumeId: string; binding: string }
export interface TranscriptCacheEntry {
  provider: UsageRecord["provider"];
  dev: number; ino: number; size: number; mtime: number; ctime: number;
  offset: number; guard: string; headGuard: string;
  /** Encoded by the original format's codec, never a hand-maintained native reducer schema. */
  state: unknown; stateMalformed: number; records: UsageRecord[];
  malformed: number; oversized: number;
  source: TranscriptSourceIdentity;
}
type Obj = Record<string, unknown>;
const object = (value: unknown): Obj | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_STRING;
/** Only normalized usage metadata may cross this persistence boundary. */
function usageOnly(record: UsageRecord): UsageRecord {
  return { provider: record.provider, timestampMs: record.timestampMs, model: record.model, sessionId: record.sessionId,
    totals: { ...record.totals }, reportedCostUsd: record.reportedCostUsd, speed: record.speed, dedupeKey: record.dedupeKey,
    ...(record.rateModel === undefined ? {} : { rateModel: record.rateModel }),
    ...(record.nativeTurnId === undefined ? {} : { nativeTurnId: record.nativeTurnId }),
    ...(record.unrecognizedServiceTier === true ? { unrecognizedServiceTier: true as const } : {}),
    ...(record.unresolvedServiceTierTurnId === undefined ? {} : { unresolvedServiceTierTurnId: record.unresolvedServiceTierTurnId }) };
}
function decodeRecord(value: unknown, provider: UsageRecord["provider"]): UsageRecord | null {
  const raw = object(value); if (!raw || raw.provider !== provider || !finite(raw.timestampMs) || !text(raw.model) || !raw.model || !text(raw.sessionId)
    || !(raw.speed === "standard" || raw.speed === "fast" || raw.speed === "ultrafast") || !(raw.dedupeKey === null || text(raw.dedupeKey))
    || !(raw.reportedCostUsd === null || finite(raw.reportedCostUsd) && raw.reportedCostUsd >= 0)) return null;
  const totals = usageTokenTotalsSchema.safeParse(raw.totals);
  if (!totals.success || totals.data.reasoningTokens > totals.data.outputTokens) return null;
  for (const key of ["rateModel", "nativeTurnId", "unresolvedServiceTierTurnId"] as const) if (raw[key] !== undefined && !text(raw[key])) return null;
  if (raw.unrecognizedServiceTier !== undefined && raw.unrecognizedServiceTier !== true) return null;
  return { provider, timestampMs: raw.timestampMs, model: raw.model, sessionId: raw.sessionId, totals: totals.data,
    speed: raw.speed, dedupeKey: raw.dedupeKey, reportedCostUsd: raw.reportedCostUsd,
    ...(typeof raw.rateModel === "string" ? { rateModel: raw.rateModel } : {}),
    ...(typeof raw.nativeTurnId === "string" ? { nativeTurnId: raw.nativeTurnId } : {}),
    ...(typeof raw.unresolvedServiceTierTurnId === "string" ? { unresolvedServiceTierTurnId: raw.unresolvedServiceTierTurnId } : {}),
    ...(raw.unrecognizedServiceTier === true ? { unrecognizedServiceTier: true as const } : {}) };
}
function decodeEntry(value: unknown): { file: string; entry: TranscriptCacheEntry } | null {
  const raw = object(value), source = object(raw?.source), provider = usageProviderKindSchema.safeParse(raw?.provider);
  if (!raw || !provider.success || !text(raw.file) || !path.isAbsolute(raw.file) || !source || !text(source.path) || !path.isAbsolute(source.path)
    || !text(source.volumeId) || !source.volumeId || typeof source.binding !== "string" || !/^[a-f0-9]{64}$/.test(source.binding)) return null;
  const relative = path.relative(source.path, raw.file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  if (!["dev", "ino", "size", "offset", "malformed", "stateMalformed", "oversized"].every(key => count(raw[key])) || !finite(raw.mtime) || !finite(raw.ctime)
    || Number(raw.offset) > Number(raw.size) || typeof raw.guard !== "string" || !/^[a-f0-9]{64}$/.test(raw.guard)
    || typeof raw.headGuard !== "string" || !/^[a-f0-9]{64}$/.test(raw.headGuard) || !Array.isArray(raw.records) || raw.records.length > MAX_RECORDS) return null;
  const records: UsageRecord[] = [];
  for (const row of raw.records) { const record = decodeRecord(row, provider.data); if (!record) return null; records.push(record); }
  return { file: raw.file, entry: { provider: provider.data, dev: Number(raw.dev), ino: Number(raw.ino), size: Number(raw.size), mtime: raw.mtime, ctime: raw.ctime,
    offset: Number(raw.offset), guard: raw.guard, headGuard: raw.headGuard, state: raw.state, stateMalformed: Number(raw.stateMalformed), records,
    malformed: Number(raw.malformed), oversized: Number(raw.oversized), source: { path: source.path, volumeId: source.volumeId, binding: source.binding } } };
}

/** One private root owns bounded metadata, in-flight sharing and an atomic write queue. */
export class TranscriptCache {
  private entries = new Map<string, { file: string; entry: TranscriptCacheEntry; bytes: number }>();
  private loaded?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private dirty = false;
  private lostBeforeMs: number | undefined;
  private active = 0;
  private queued: (() => void)[] = [];
  private pending = new Map<string, Promise<unknown>>();
  private now: () => number;
  private maxFiles: number;
  private maxRecords: number;
  private concurrency: number;
  readonly file: string;
  constructor(file: string, options: { now?: () => number; maxFiles?: number; maxRecords?: number; concurrency?: number } = {}) {
    this.file = file; this.now = options.now ?? Date.now; this.maxFiles = options.maxFiles ?? MAX_FILES;
    this.maxRecords = options.maxRecords ?? MAX_RECORDS; this.concurrency = options.concurrency ?? 4;
  }
  private key(file: string, provider: UsageRecord["provider"], binding: string): string { return JSON.stringify([provider, binding, path.resolve(file)]); }
  load(): Promise<void> { return this.loaded ??= this.read(); }
  hasLostCoverage(sinceMs: number): boolean { return this.lostBeforeMs !== undefined && sinceMs < this.lostBeforeMs; }
  private loseCoverage(): void { this.lostBeforeMs = this.now(); this.dirty = true; }
  private async read(): Promise<void> {
    try {
      const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > MAX_CACHE_BYTES) { this.loseCoverage(); return; }
        if ((info.mode & 0o777) !== 0o600) this.dirty = true;
        const root = object(JSON.parse(await handle.readFile("utf8")));
        // Legacy reducers had no instance/revision binding. Never reuse their removed-file records for a new account.
        if (!root || root.version !== VERSION || !Array.isArray(root.files) || root.files.length > MAX_FILES) { this.loseCoverage(); return; }
        if (root.lostBeforeMs !== undefined) { if (finite(root.lostBeforeMs)) this.lostBeforeMs = root.lostBeforeMs; else this.loseCoverage(); }
        for (const row of root.files) { const decoded = decodeEntry(row); if (decoded) this.set(decoded.file, decoded.entry); else this.loseCoverage(); }
        this.prune();
      } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.loseCoverage(); }
  }
  get(file: string, provider: UsageRecord["provider"], binding: string): TranscriptCacheEntry | undefined { return this.entries.get(this.key(file, provider, binding))?.entry; }
  set(file: string, entry: TranscriptCacheEntry): void {
    const key = this.key(file, entry.provider, entry.source.binding);
    const safe = { ...entry, records: entry.records.map(usageOnly) };
    this.entries.delete(key); this.entries.set(key, { file, entry: safe, bytes: Buffer.byteLength(JSON.stringify(safe)) }); this.dirty = true; this.prune();
  }
  prune(): void {
    let records = 0, bytes = 0;
    for (const [key, item] of this.entries) {
      if (item.entry.mtime < this.now() - RETENTION_MS) { this.entries.delete(key); this.dirty = true; }
      else { records += item.entry.records.length; bytes += item.bytes; }
    }
    while (this.entries.size > this.maxFiles || records > this.maxRecords || bytes > MAX_CACHE_BYTES) {
      const first = this.entries.entries().next().value; if (!first) break;
      records -= first[1].entry.records.length; bytes -= first[1].bytes; this.entries.delete(first[0]); this.dirty = true;
    }
  }
  forgetSource(provider: UsageRecord["provider"], source: TranscriptSourceIdentity): void {
    for (const [key, { entry }] of this.entries) if (entry.provider === provider && entry.source.path === source.path && entry.source.volumeId === source.volumeId && entry.source.binding === source.binding) {
      this.entries.delete(key); this.dirty = true;
    }
  }
  retained(provider: UsageRecord["provider"], source: TranscriptSourceIdentity): { file: string; entry: TranscriptCacheEntry }[] {
    this.prune();
    return [...this.entries.values()].filter(({ entry }) => entry.provider === provider && entry.source.path === source.path && entry.source.volumeId === source.volumeId && entry.source.binding === source.binding);
  }
  /** Shared work never inherits one waiter's cancellation. */
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const old = this.pending.get(key); if (old) return old as Promise<T>;
    const promise = this.schedule(work); this.pending.set(key, promise);
    void promise.finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); }).catch(() => {});
    return promise;
  }
  private async schedule<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) { const { promise, resolve } = Promise.withResolvers<void>(); this.queued.push(resolve); await promise; }
    else this.active++;
    try { await this.load(); return await work(); }
    finally { const next = this.queued.shift(); if (next) next(); else this.active--; }
  }
  flush(): Promise<void> {
    const next = this.writes.then(async () => {
      await this.load(); this.prune(); if (!this.dirty) return;
      this.dirty = false;
      const files = [...this.entries.values()].map(({ file, entry }) => ({ file, ...entry }));
      const bytes = JSON.stringify({ version: VERSION, files, ...(this.lostBeforeMs === undefined ? {} : { lostBeforeMs: this.lostBeforeMs }) });
      if (Buffer.byteLength(bytes) > MAX_CACHE_BYTES) { this.dirty = true; throw new Error("Derived usage cache exceeds its size bound."); }
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.file);
      } finally { await unlink(temporary).catch(() => {}); }
    });
    this.writes = next.catch(() => { this.dirty = true; });
    return next;
  }
}
let current: TranscriptCache | undefined;
export function getTranscriptCache(): TranscriptCache {
  const file = path.join(providerDataDirectory(), TRANSCRIPT_CACHE_FILE);
  if (current?.file !== file) current = new TranscriptCache(file);
  return current;
}
export async function flushTranscriptCache(): Promise<void> { await getTranscriptCache().flush(); }
