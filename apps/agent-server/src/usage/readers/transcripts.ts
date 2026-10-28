// Adapted from t3code usageTranscriptReader and provider usage readers.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { opendir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UsageSource } from "@agent-workspace/contracts/usage";
import { expandProviderPath, type StoredProviderInstance } from "../../providers/instances.ts";
import type { UsageReadContext, UsageRecord, UsageScan } from "../types.ts";
import { readTranscriptFile } from "./transcript-stream.ts";
import type { TranscriptProvider } from "./transcript-parsers.ts";

const MAX_DIRECTORIES = 20_000;
const MAX_FILES = 20_000;
const MAX_SOURCE_RECORDS = 250_000;
interface Root { provider: TranscriptProvider; path: string; instances: StoredProviderInstance[] }
function configuredRoot(instance: StoredProviderInstance): Root | null {
  const provider = instance.driver;
  if (provider !== "codex" && provider !== "claude" && provider !== "grok" && provider !== "pi") return null;
  // Shadow Codex homes share sessions with their explicitly configured home.
  const home = provider === "codex" && typeof instance.config.homePath === "string" && instance.config.homePath.trim()
    ? expandProviderPath(instance.config.homePath.trim()) : instance.homeDirectory;
  const sessionDir = provider === "pi" ? instance.env.PI_CODING_AGENT_SESSION_DIR?.trim() : undefined;
  const root = provider === "claude" ? path.join(home, "projects") : provider === "pi"
    ? sessionDir ? expandProviderPath(sessionDir) : path.join(home, ".pi", "agent", "sessions") : path.join(home, "sessions");
  return { provider, path: path.resolve(root), instances: [instance] };
}
function source(root: Root, volumeId: string): UsageSource {
  return { fingerprint: { hostId: os.hostname(), provider: root.provider, resolvedHomePath: root.path, volumeId }, status: "ok", scannedFiles: 0, skippedFiles: 0, malformedRecords: 0, distinctSessions: 0, message: null, instanceIds: root.instances.map((i) => i.instanceId), label: root.instances[0]?.label };
}
/** Scan only the roots attached to the supplied instances, including disabled instances. */
export async function scanTranscriptUsage(context: UsageReadContext): Promise<UsageScan[]> {
  const roots = new Map<string, Root>();
  for (const instance of context.instances) {
    context.signal?.throwIfAborted();
    const candidate = configuredRoot(instance); if (!candidate) continue;
    let resolved = candidate.path;
    try { resolved = await realpath(resolved); } catch { /* Missing sources still get a source status. */ }
    candidate.path = resolved;
    let identity = `${candidate.provider}:${resolved}`;
    try { const info = await stat(resolved); identity = `${candidate.provider}:${info.dev}:${info.ino}`; } catch { /* Missing roots dedupe by path. */ }
    const existing = roots.get(identity);
    if (existing) existing.instances.push(instance); else roots.set(identity, candidate);
  }
  const scans: UsageScan[] = [];
  const seenFiles = new Set<string>();
  const seenRecords = new Set<string>();
  for (const root of roots.values()) {
    context.signal?.throwIfAborted();
    let rootStat;
    try { rootStat = await stat(root.path); if (!rootStat.isDirectory()) throw Object.assign(new Error("Not a directory"), { code: "ENOTDIR" }); }
    catch (error) {
      const result = source(root, ""); const code = (error as NodeJS.ErrnoException).code;
      result.status = code === "ENOENT" || code === "ENOTDIR" ? "missing" : "failed";
      result.message = result.status === "missing" ? "Transcript directory does not exist." : "Cannot access transcript directory.";
      scans.push({ source: result, records: [] }); continue;
    }
    const result = source(root, `${rootStat.dev}:${rootStat.ino}`); const records: UsageRecord[] = [];
    const sessions = new Set<string>(); let failed = 0, bounded = false, directories = 0, files = 0;
    const queue = [root.path];
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
          if (!entry.isFile() || (root.provider === "grok" ? entry.name !== "updates.jsonl" : !entry.name.endsWith(".jsonl"))) continue;
          if (++files > MAX_FILES) { bounded = true; break; }
          try {
            const info = await stat(file); const identity = `${root.provider}:${info.dev}:${info.ino}`;
            if (seenFiles.has(identity)) { result.skippedFiles++; continue; }
            seenFiles.add(identity);
            const parsed = await readTranscriptFile(file, root.provider, context.signal);
            result.malformedRecords += parsed.malformed; if (parsed.oversized || parsed.limited) { failed += parsed.oversized + (parsed.limited ? 1 : 0); }
            if (!parsed.records.length) result.skippedFiles++; else result.scannedFiles++;
            const occurrences = new Map<string, number>();
            for (const item of parsed.records) {
              let key = item.dedupeKey;
              if (root.provider === "codex" && item.sessionId) {
                const event = JSON.stringify([item.provider, item.sessionId, item.timestampMs, item.model, item.totals]);
                const occurrence = (occurrences.get(event) ?? 0) + 1; occurrences.set(event, occurrence); key = `${event}:${occurrence}`;
              }
              if (item.timestampMs < context.sinceMs || item.timestampMs >= context.untilMs) continue;
              const scopedKey = key === null ? null : `${root.provider}:${key}`;
              if (scopedKey !== null) { if (seenRecords.has(scopedKey)) continue; seenRecords.add(scopedKey); }
              if (records.length >= MAX_SOURCE_RECORDS) { bounded = true; break; }
              records.push({ ...item, dedupeKey: key, instanceId: root.instances[0]!.instanceId });
              if (item.sessionId) sessions.add(item.sessionId);
            }
            if (bounded) break;
          } catch { context.signal?.throwIfAborted(); failed++; result.skippedFiles++; }
        }
      } catch { context.signal?.throwIfAborted(); failed++; }
    }
    result.distinctSessions = sessions.size;
    if (failed || bounded || result.malformedRecords) {
      result.status = "partial";
      result.message = `Transcript scan incomplete: ${result.malformedRecords} malformed or incomplete records, ${failed} unreadable or oversized files${bounded ? "; scan limit reached" : ""}.`;
    }
    scans.push({ source: result, records });
  }
  return scans;
}
