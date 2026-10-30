// Adapted from t3code usageTranscriptReader and usageScanCache.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";
import * as Schema from "effect/Schema";
import type { UsageRecord } from "../types.ts";
import { TranscriptProjector } from "./transcript-projector.ts";
import { getTranscriptCache, type TranscriptCache, type TranscriptSourceIdentity } from "./transcript-cache.ts";
import path from "node:path";

const MAX_LINE = 8 * 1024 * 1024;
const MAX_SCAN_BYTES = 256 * 1024 * 1024;
const MAX_FILE_RECORDS = 100_000;
const GUARD = 64;
export interface TranscriptFileResult { records: UsageRecord[]; malformed: number; oversized: number; limited: boolean; cacheHit: boolean; resumed: boolean }
interface ReadOptions { cache?: TranscriptCache; source: TranscriptSourceIdentity }
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
async function guardAt(handle: FileHandle, offset: number): Promise<string> {
  const buffer = Buffer.alloc(Math.min(GUARD, offset));
  if (buffer.length) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset - buffer.length); if (bytesRead !== buffer.length) throw new Error("Transcript changed while reading"); }
  return hash(buffer);
}
async function headGuardAt(handle: FileHandle, length: number): Promise<string> {
  const buffer = Buffer.alloc(Math.min(GUARD, length));
  if (buffer.length) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead !== buffer.length) throw new Error("Transcript changed while reading"); }
  return hash(buffer);
}
/** Returns complete JSONL records plus a provisional valid tail. The tail is replayed on growth. */
export async function readTranscriptFile(file: string, provider: UsageRecord["provider"], format: TranscriptUsageFormat<unknown>, signal: AbortSignal | undefined, options: ReadOptions): Promise<TranscriptFileResult> {
  signal?.throwIfAborted();
  const cache = options.cache ?? getTranscriptCache();
  const shared = cache.run(JSON.stringify([provider, path.resolve(file), options.source]), () => readFile(file, provider, format, cache, options.source));
  if (!signal) return shared;
  const { promise, reject } = Promise.withResolvers<never>();
  const abort = () => reject(signal.reason ?? new DOMException("Transcript read cancelled.", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try { return await Promise.race([shared, promise]); }
  finally { signal.removeEventListener("abort", abort); }
}
async function readFile(file: string, provider: UsageRecord["provider"], format: TranscriptUsageFormat<unknown>, cache: TranscriptCache, source: TranscriptSourceIdentity): Promise<TranscriptFileResult> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Transcript is not a regular file.");
    const cached = cache.get(file, provider, source.binding);
    const checkpoint = (() => {
      if (!cached || cached.source.path !== source.path || cached.source.volumeId !== source.volumeId) return undefined;
      try { return { entry: cached, state: format.state ? Schema.decodeUnknownSync(format.state.schema)(cached.state) : undefined }; }
      catch { return undefined; }
    })();
    const reusable = checkpoint && checkpoint.entry.dev === before.dev && checkpoint.entry.ino === before.ino
      && checkpoint.entry.offset <= before.size
      && checkpoint.entry.guard === await guardAt(handle, checkpoint.entry.offset)
      && checkpoint.entry.headGuard === await headGuardAt(handle, checkpoint.entry.offset) ? checkpoint : undefined;
    if (reusable && reusable.entry.size === before.size && reusable.entry.mtime === before.mtimeMs && reusable.entry.ctime === before.ctimeMs && reusable.entry.offset === before.size) {
      const after = await stat(file);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Transcript changed while reading");
      return { records: reusable.entry.records, malformed: reusable.entry.malformed + reusable.entry.stateMalformed, oversized: reusable.entry.oversized, limited: false, cacheHit: true, resumed: false };
    }
    const resume = reusable && (before.size > reusable.entry.size ||
      reusable.entry.size === before.size && reusable.entry.mtime === before.mtimeMs && reusable.entry.ctime === before.ctimeMs) ? reusable : undefined;
    const state = resume ? structuredClone(resume.state) : format.state?.initial();
    const records = resume ? resume.entry.records.slice() : [];
    let malformed = resume ? resume.entry.malformed : 0, oversized = resume ? resume.entry.oversized : 0;
    const start = resume ? resume.entry.offset : 0;
    let position = start, committed = start, pending: Buffer[] = [], pendingSize = 0, dropping = false, limited = false, partialTail = false;
    let projector: TranscriptProjector | undefined;
    const consume = (bytes: Buffer, target: unknown, output: UsageRecord[], tail: boolean) => {
      const line = bytes.toString("utf8").trim(); if (!line) return;
      if (!format.usageMarkers.some((marker) => line.includes(marker))) {
        if (tail) { try { JSON.parse(line); } catch { partialTail = true; } }
        return;
      }
      try {
        const previousMalformed = format.readMalformedRecords?.(target) ?? 0;
        output.push(...format.parseProjected(JSON.parse(line), target));
        if (tail && (format.readMalformedRecords?.(target) ?? 0) > previousMalformed) partialTail = true;
      } catch { if (tail) partialTail = true; else malformed++; }
    };
    const finishProjected = (target: unknown, output: UsageRecord[], tail: boolean) => {
      try {
        const previousMalformed = format.readMalformedRecords?.(target) ?? 0;
        output.push(...format.parseProjected(projector!.finish(), target));
        if (tail && (format.readMalformedRecords?.(target) ?? 0) > previousMalformed) partialTail = true;
      } catch { if (tail) partialTail = true; else malformed++; }
    };
    if (before.size > start) for await (const chunk of handle.createReadStream({ start, end: Math.min(before.size - 1, start + MAX_SCAN_BYTES - 1), autoClose: false, highWaterMark: 64 * 1024 })) {
      const bytes = chunk as Buffer; let begin = 0;
      while (begin < bytes.length) {
        const newline = bytes.indexOf(10, begin), end = newline < 0 ? bytes.length : newline; const part = bytes.subarray(begin, end);
        if (!dropping) {
          try {
            if (!projector && pendingSize + part.length > MAX_LINE) {
              projector = new TranscriptProjector(format.selectFields);
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
    const stateMalformed = format.readMalformedRecords?.(state) ?? 0;
    if (!limited) cache.set(file, { provider, dev: before.dev, ino: before.ino, size: before.size, mtime: before.mtimeMs, ctime: before.ctimeMs, offset: committed, guard: await guardAt(handle, committed), headGuard: await headGuardAt(handle, committed),
      state: format.state ? Schema.encodeSync(format.state.schema)(state) : null, stateMalformed, records, malformed, oversized: dropping ? oversized - 1 : oversized, source });
    return { records: [...records, ...tailRecords], malformed: malformed + stateMalformed + (partialTail ? 1 : 0), oversized, limited, cacheHit: false, resumed: Boolean(resume) };
  } finally { await handle.close(); }
}
