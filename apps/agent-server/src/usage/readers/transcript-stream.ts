// Adapted from t3code usageTranscriptReader and usageScanCache.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { UsageRecord } from "../types.ts";
import { initialState, parseTranscriptRecord, type TranscriptProvider, type TranscriptState } from "./transcript-parsers.ts";
import { TranscriptProjector } from "./transcript-projector.ts";

const MAX_LINE = 8 * 1024 * 1024;
const MAX_SCAN_BYTES = 256 * 1024 * 1024;
const MAX_FILE_RECORDS = 100_000;
const MAX_CACHED_FILES = 256;
const MAX_CACHED_RECORDS = 200_000;
const GUARD = 64;
interface Entry { provider: TranscriptProvider; dev: number; ino: number; size: number; mtime: number; ctime: number; offset: number; guard: string; state: TranscriptState; records: UsageRecord[]; malformed: number; oversized: number }
export interface TranscriptFileResult { records: UsageRecord[]; malformed: number; oversized: number; limited: boolean }
const cache = new Map<string, Entry>();
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
async function guardAt(handle: FileHandle, offset: number): Promise<string> {
  const buffer = Buffer.alloc(Math.min(GUARD, offset));
  if (buffer.length) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset - buffer.length); if (bytesRead !== buffer.length) throw new Error("Transcript changed while reading"); }
  return hash(buffer);
}
function cacheEntry(key: string, entry: Entry): void {
  cache.delete(key); cache.set(key, entry);
  let count = 0; for (const value of cache.values()) count += value.records.length;
  while (cache.size > MAX_CACHED_FILES || count > MAX_CACHED_RECORDS) { const oldest = cache.keys().next().value as string | undefined; if (oldest === undefined) break; count -= cache.get(oldest)!.records.length; cache.delete(oldest); }
}
/** Returns complete JSONL records plus a provisional valid tail. The tail is replayed on growth. */
export async function readTranscriptFile(file: string, provider: TranscriptProvider, signal?: AbortSignal): Promise<TranscriptFileResult> {
  signal?.throwIfAborted();
  const handle = await open(file, "r");
  try {
    const before = await handle.stat();
    const key = `${provider}:${file}`; const old = cache.get(key);
    if (old && old.dev === before.dev && old.ino === before.ino && old.size === before.size && old.mtime === before.mtimeMs && old.ctime === before.ctimeMs) {
      // A non-newline tail is not cached; replay it even on unchanged files.
      if (old.offset === before.size) return { records: old.records, malformed: old.malformed + old.state.malformed, oversized: old.oversized, limited: false };
    }
    const unchanged = old && old.size === before.size && old.mtime === before.mtimeMs && old.ctime === before.ctimeMs;
    const canResume = old && old.dev === before.dev && old.ino === before.ino && (before.size > old.size || unchanged) && old.offset <= before.size && old.guard === await guardAt(handle, old.offset);
    const state = canResume ? structuredClone(old.state) : initialState();
    const records = canResume ? old.records.slice() : [];
    let malformed = canResume ? old.malformed : 0, oversized = canResume ? old.oversized : 0;
    const start = canResume ? old.offset : 0;
    let position = start, committed = start, pending: Buffer[] = [], pendingSize = 0, dropping = false, limited = false, partialTail = false;
    let projector: TranscriptProjector | undefined;
    const markers = provider === "codex" ? ['"token_count"', '"turn_context"', '"thread_settings_applied"', '"session_meta"'] : provider === "grok" ? ['"turn_completed"'] : provider === "pi" ? ['"usage"', '"session"'] : ['"usage"'];
    const consume = (bytes: Buffer, target: TranscriptState, output: UsageRecord[], tail: boolean) => {
      const line = bytes.toString("utf8").trim(); if (!line) return;
      // Parsing only candidate records avoids materialising ordinary conversation content.
      if (!markers.some((marker) => line.includes(marker))) return;
      try { const parsed: unknown = JSON.parse(line); output.push(...parseTranscriptRecord(provider, parsed, target)); } catch { if (tail) partialTail = true; else malformed++; }
    };
    const finishProjected = (target: TranscriptState, output: UsageRecord[], tail: boolean) => {
      try { output.push(...parseTranscriptRecord(provider, projector!.finish(), target)); } catch { if (tail) partialTail = true; else malformed++; }
    };
    if (before.size > start) for await (const chunk of handle.createReadStream({ start, end: Math.min(before.size - 1, start + MAX_SCAN_BYTES - 1), autoClose: false, highWaterMark: 64 * 1024 })) {
      signal?.throwIfAborted(); const bytes = chunk as Buffer; let begin = 0;
      while (begin < bytes.length) {
        const newline = bytes.indexOf(10, begin), end = newline < 0 ? bytes.length : newline; const part = bytes.subarray(begin, end);
        if (!dropping) {
          try {
            if (!projector && pendingSize + part.length > MAX_LINE) {
              projector = new TranscriptProjector(provider);
              for (const saved of pending) projector.write(saved);
              pending = []; pendingSize = 0;
            }
            if (projector) projector.write(part);
            else if (part.length) { pending.push(part); pendingSize += part.length; }
          } catch { pending = []; pendingSize = 0; projector = undefined; dropping = true; }
        }
        if (newline < 0) break;
        if (dropping) oversized++; else if (projector) finishProjected(state, records, false); else if (pendingSize) consume(pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingSize), state, records, false);
        pending = []; pendingSize = 0; projector = undefined; dropping = false; begin = newline + 1; committed = position + begin;
        if (records.length >= MAX_FILE_RECORDS) { limited = true; break; }
      }
      position += bytes.length;
      if (limited) break;
    }
    if (position < before.size) limited = true;
    const tailRecords: UsageRecord[] = [];
    if (!limited && !dropping) {
      if (projector) finishProjected(structuredClone(state), tailRecords, true);
      else if (pendingSize) consume(pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingSize), structuredClone(state), tailRecords, true);
    }
    if (!limited && dropping) oversized++;
    const after = await stat(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Transcript changed while reading");
    // Incomplete/oversized tails are retried when the file grows. Do not cache a limited scan.
    if (!limited) cacheEntry(key, { provider, dev: before.dev, ino: before.ino, size: before.size, mtime: before.mtimeMs, ctime: before.ctimeMs, offset: committed, guard: await guardAt(handle, committed), state, records, malformed, oversized: dropping ? oversized - 1 : oversized });
    return { records: [...records, ...tailRecords], malformed: malformed + state.malformed + (partialTail ? 1 : 0), oversized, limited };
  } finally { await handle.close(); }
}
