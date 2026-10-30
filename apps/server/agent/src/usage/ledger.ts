// Native turn ledger: actual provider reports only, never prompt contents or credentials.
// Adapted from t3code usage semantics. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { NativeSessionRef, ProviderDriver } from "@agent-workspace/contracts/provider";
import type { NativeUsageUpdate, ThreadUsageSnapshot } from "@agent-workspace/contracts/usage";
import { listRecords, readRecord, writeRecord } from "../durable/store.ts";
import type { UsageReadContext, UsageRecord, UsageScan } from "./types.ts";

const LEDGER = "usage:turns";
const THREADS = "usage:threads";
interface Entry {
  generationId: string;
  threadId: string;
  instanceId: string;
  provider: ProviderDriver;
  model: string;
  createdAt: string;
  updatedAt: string;
  session?: NativeSessionRef;
  turn?: NonNullable<NativeUsageUpdate["turn"]>;
  reportedTurn?: NativeUsageUpdate["reportedTurn"];
  context?: NativeUsageUpdate["context"];
}
export function recordNativeUsage(input: { generationId: string; threadId: string; instanceId: string; provider: ProviderDriver; model: string; session?: NativeSessionRef; update: NativeUsageUpdate }): ThreadUsageSnapshot {
  const previous = readRecord<Entry>(LEDGER, input.generationId);
  const entry: Entry = {
    generationId: input.generationId, threadId: input.threadId, instanceId: input.instanceId,
    provider: input.provider, model: input.update.turn?.model ?? previous?.model ?? input.model,
    createdAt: previous?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), session: input.session ?? previous?.session,
    turn: input.update.reportedTurn ? input.update.turn : input.update.turn ?? previous?.turn,
    reportedTurn: input.update.turn ? input.update.reportedTurn : input.update.reportedTurn ?? previous?.reportedTurn,
    context: input.update.context ?? previous?.context,
  };
  writeRecord(LEDGER, entry.generationId, entry);
  const previousThread = readRecord<ThreadUsageSnapshot>(THREADS, input.threadId);
  const previousEntry = previousThread?.generationId ? readRecord<Entry>(LEDGER, previousThread.generationId) : null;
  const sameSession = previousThread?.providerInstanceId === input.instanceId && previousThread.model === entry.model && (previousThread.generationId === input.generationId || (previousEntry?.session?.sessionId !== undefined && previousEntry.session.sessionId === entry.session?.sessionId));
  const snapshot: ThreadUsageSnapshot = {
    threadId: input.threadId, generationId: input.generationId, providerInstanceId: input.instanceId,
    model: entry.model, updatedAt: entry.updatedAt,
    ...(entry.turn ? { totals: entry.turn.totals, ...(entry.turn.costUsd !== undefined ? { costUsd: entry.turn.costUsd } : {}) } : {}),
    ...(entry.reportedTurn ? { reportedTurn: entry.reportedTurn } : {}),
    ...(entry.context ? { context: entry.context } : sameSession && previousThread?.context ? { context: previousThread.context } : {}),
  };
  writeRecord(THREADS, input.threadId, snapshot);
  return snapshot;
}
export function updateUsageSession(generationId: string, session: NativeSessionRef): void {
  const entry = readRecord<Entry>(LEDGER, generationId);
  if (entry) writeRecord(LEDGER, generationId, { ...entry, session });
}
/** Starting a new turn invalidates prior totals; context is retained only for the same native session. */
export function beginThreadUsage(input: { threadId: string; generationId: string; instanceId: string; model: string; session?: NativeSessionRef }): void {
  const previous = readRecord<ThreadUsageSnapshot>(THREADS, input.threadId);
  const previousEntry = previous?.generationId ? readRecord<Entry>(LEDGER, previous.generationId) : null;
  const sameSession = previous?.providerInstanceId === input.instanceId && previous.model === input.model &&
    input.session?.sessionId !== undefined && previousEntry?.session?.sessionId === input.session.sessionId;
  writeRecord<ThreadUsageSnapshot>(THREADS, input.threadId, { threadId: input.threadId, generationId: input.generationId,
    providerInstanceId: input.instanceId, model: input.model, updatedAt: new Date().toISOString(),
    ...(sameSession && previous?.context ? { context: previous.context } : {}) });
}
export function getThreadUsage(threadId: string): ThreadUsageSnapshot {
  return readRecord<ThreadUsageSnapshot>(THREADS, threadId) ?? { threadId };
}
/** Prefer native history for matching turns. If a native record has no turn identity, its whole
 * session takes precedence: adding ledger turns would risk double counting partial history. */
export function scanLedgerUsage(context: UsageReadContext, native: UsageScan[]): UsageScan[] {
  const covered = new Map<string, Set<string> | null>();
  for (const scan of native) for (const record of scan.records) {
    const instanceIds = new Set([...(scan.source.instanceIds ?? []), ...(record.instanceId ? [record.instanceId] : [])]);
    for (const instanceId of instanceIds) {
      const key = `${record.provider}\0${instanceId}\0${record.sessionId}`;
      if (!record.nativeTurnId) covered.set(key, null);
      else if (covered.get(key) !== null) {
        const turns = covered.get(key) ?? new Set<string>(); turns.add(record.nativeTurnId); covered.set(key, turns);
      }
    }
  }
  const byInstance = new Map<string, UsageRecord[]>();
  const instances = new Map(context.instances.map((instance) => [instance.instanceId, instance]));
  const latest = new Map<string, Entry>();
  for (const entry of listRecords<Entry>(LEDGER)) {
    if (!entry.turn || !instances.has(entry.instanceId) || instances.get(entry.instanceId)!.driver !== entry.provider) continue;
    const key = entry.session?.turnId
      ? JSON.stringify([entry.provider, entry.instanceId, entry.session.sessionId, entry.session.turnId])
      : entry.generationId;
    const held = latest.get(key);
    if (!held || entry.updatedAt >= held.updatedAt) latest.set(key, entry);
  }
  for (const entry of latest.values()) {
    if (!entry.turn) continue;
    const timestampMs = Date.parse(entry.createdAt ?? entry.updatedAt);
    if (!Number.isFinite(timestampMs) || timestampMs < context.sinceMs || timestampMs >= context.untilMs) continue;
    const sessionId = entry.session?.sessionId ?? `generation:${entry.generationId}`;
    const key = `${entry.provider}\0${entry.instanceId}\0${sessionId}`;
    const turns = covered.get(key);
    if (turns === null || (turns && (!entry.session?.turnId || turns.has(entry.session.turnId)))) continue;
    const records = byInstance.get(entry.instanceId) ?? [];
    records.push({ provider: entry.provider, timestampMs, model: entry.model, sessionId,
      totals: entry.turn.totals, reportedCostUsd: entry.turn.costUsd ?? null, speed: entry.turn.speed ?? "standard",
      dedupeKey: entry.session?.turnId ? `ledger:${JSON.stringify([entry.provider, sessionId, entry.session.turnId])}` : `ledger:${entry.generationId}`,
      instanceId: entry.instanceId, nativeTurnId: entry.session?.turnId,
      ...(entry.provider === "codex" && entry.turn.speed === undefined && entry.session?.turnId
        ? { unresolvedServiceTierTurnId: entry.session.turnId } : {}) });
    byInstance.set(entry.instanceId, records);
  }
  return [...byInstance].map(([instanceId, records]) => {
    const instance = instances.get(instanceId)!;
    return { source: { fingerprint: { hostId: "local", provider: instance.driver, resolvedHomePath: `ledger:${instanceId}`, volumeId: "ledger" }, status: "ok", scannedFiles: 0, skippedFiles: 0, malformedRecords: 0, distinctSessions: new Set(records.map((r) => r.sessionId)).size, message: "Provider-reported turn telemetry (fallback when native history is unavailable).", instanceIds: [instanceId], label: `${instance.label} (live telemetry)` }, records };
  });
}
