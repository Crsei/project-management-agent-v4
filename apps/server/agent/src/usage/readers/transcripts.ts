// Filesystem/persistence adapter for original provider-owned TranscriptUsageFormat readers.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";
import * as Schema from "effect/Schema";
import type { StoredProviderInstance } from "../../providers/instances.ts";
import type { UsageReadContext, UsageRecord, UsageScan } from "../types.ts";
import { readTranscriptFile } from "./transcript-stream.ts";
import { getTranscriptCache, type TranscriptCache } from "./transcript-cache.ts";

const MAX_DIRECTORIES = 20_000;
const MAX_FILES = 20_000;
const MAX_SOURCE_RECORDS = 250_000;
export interface OriginalTranscriptSource {
  instance: StoredProviderInstance;
  provider: UsageRecord["provider"];
  format: TranscriptUsageFormat<unknown>;
  dir: string;
  fileName?: string;
  binding: string;
}

/** Directory selection and all native parsing/state belong exclusively to the source reader. */
export async function scanOriginalTranscripts(context: UsageReadContext, input: OriginalTranscriptSource, cache: TranscriptCache = getTranscriptCache()): Promise<UsageScan> {
  await cache.load();
  const { instance, provider, format } = input;
  let root = path.resolve(input.dir);
  try { root = await realpath(root); } catch { /* Missing sources retain their selected identity. */ }
  const result: UsageScan["source"] = {
    fingerprint: { hostId: os.hostname(), provider, resolvedHomePath: root, volumeId: "" }, status: "ok",
    scannedFiles: 0, skippedFiles: 0, malformedRecords: 0, distinctSessions: 0, message: null,
    instanceIds: [instance.instanceId], label: instance.label,
  };
  let rootStat;
  try { rootStat = await stat(root); if (!rootStat.isDirectory()) throw Object.assign(new Error("Not a directory"), { code: "ENOTDIR" }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    result.status = code === "ENOENT" || code === "ENOTDIR" ? "missing" : "failed";
    result.message = result.status === "missing" ? "Transcript directory does not exist." : "Cannot access transcript directory.";
    return { source: result, records: [] };
  }
  result.fingerprint.volumeId = `${rootStat.dev}:${rootStat.ino}`;
  const records: UsageRecord[] = [], sessions = new Set<string>(), seenFiles = new Set<string>(), seenRecords = new Set<string>();
  let failed = 0, bounded = false, directories = 0, files = 0;
  const queue = [root], candidates: string[] = [], livePaths = new Set<string>();
  while (queue.length && !bounded) {
    context.signal?.throwIfAborted();
    if (++directories > MAX_DIRECTORIES) { bounded = true; break; }
    const directory = queue.pop()!;
    try {
      const entries = await opendir(directory);
      for await (const entry of entries) {
        context.signal?.throwIfAborted();
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (queue.length + directories >= MAX_DIRECTORIES) { bounded = true; break; } queue.push(file); continue; }
        if (!entry.isFile() || (input.fileName ? entry.name !== input.fileName : !entry.name.endsWith(".jsonl"))) continue;
        if (++files > MAX_FILES) { bounded = true; break; }
        candidates.push(file); livePaths.add(file);
      }
    } catch { context.signal?.throwIfAborted(); failed++; }
  }
  candidates.sort();
  const sourceIdentity = { path: root, volumeId: result.fingerprint.volumeId, binding: input.binding };
  const append = (items: readonly UsageRecord[]) => {
    const occurrences = new Map<string, number>();
    for (const item of items) {
      let key = item.dedupeKey;
      if (format.sharedSessionsAcrossFiles && item.sessionId) {
        const event = JSON.stringify([item.provider, item.sessionId, item.timestampMs, item.model, item.totals]);
        const occurrence = (occurrences.get(event) ?? 0) + 1; occurrences.set(event, occurrence); key = `${event}:${occurrence}`;
      }
      if (item.timestampMs < context.sinceMs || item.timestampMs >= context.untilMs) continue;
      if (key !== null) { if (seenRecords.has(key)) continue; seenRecords.add(key); }
      if (records.length >= MAX_SOURCE_RECORDS) { bounded = true; break; }
      records.push({ ...item, dedupeKey: key, instanceId: instance.instanceId });
      if (item.sessionId) sessions.add(item.sessionId);
    }
  };
  for (let index = 0; index < candidates.length && records.length < MAX_SOURCE_RECORDS; index += 4) {
    context.signal?.throwIfAborted();
    const batch = await Promise.all(candidates.slice(index, index + 4).map(async file => {
      try {
        const info = await stat(file), identity = `${info.dev}:${info.ino}`;
        if (seenFiles.has(identity)) return null;
        seenFiles.add(identity);
        return await readTranscriptFile(file, provider, format, context.signal, { cache, source: sourceIdentity });
      } catch { context.signal?.throwIfAborted(); return undefined; }
    }));
    for (const parsed of batch) {
      if (!parsed) { result.skippedFiles++; if (parsed === undefined) failed++; continue; }
      result.malformedRecords += parsed.malformed; failed += parsed.oversized + (parsed.limited ? 1 : 0);
      if (!parsed.records.length) result.skippedFiles++; else result.scannedFiles++;
      append(parsed.records);
    }
    if (records.length >= MAX_SOURCE_RECORDS && index + 4 < candidates.length) bounded = true;
  }
  let retained = 0;
  if (!bounded) for (const { file, entry } of cache.retained(provider, sourceIdentity)) {
    context.signal?.throwIfAborted();
    if (livePaths.has(file)) continue;
    try { await lstat(file); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue; }
    try { if (format.state) Schema.decodeUnknownSync(format.state.schema)(entry.state); }
    catch { failed++; continue; }
    const identity = `${entry.dev}:${entry.ino}`;
    if (seenFiles.has(identity)) continue;
    seenFiles.add(identity); append(entry.records); retained++;
    result.malformedRecords += entry.malformed + entry.stateMalformed; failed += entry.oversized;
    if (entry.records.length) result.scannedFiles++;
    if (records.length >= MAX_SOURCE_RECORDS) break;
  }
  if (retained) { failed++; result.message = `${retained} removed transcript files contribute retained usage metadata.`; }
  let changedRoot = false;
  try { const after = await stat(root); changedRoot = after.dev !== rootStat.dev || after.ino !== rootStat.ino; }
  catch { changedRoot = true; }
  if (changedRoot) {
    cache.forgetSource(provider, sourceIdentity); records.length = 0; sessions.clear(); failed++;
    result.message = "Transcript source identity changed while scanning; mixed-source usage was withheld.";
  }
  result.distinctSessions = sessions.size;
  const cacheLoss = cache.hasLostCoverage(context.sinceMs);
  if (cacheLoss) result.message = [result.message, "Retained usage cache was unavailable, legacy or corrupt; native files were reread, but removed historical files cannot be reconstructed."].filter(Boolean).join(" ");
  if (failed || bounded || result.malformedRecords || cacheLoss) {
    result.status = "partial";
    result.message = [result.message, `Transcript scan incomplete: ${result.malformedRecords} malformed or incomplete records, ${failed} unreadable, removed or oversized files${bounded ? "; scan limit reached" : ""}.`].filter(Boolean).join(" ");
  }
  return { source: result, records };
}
