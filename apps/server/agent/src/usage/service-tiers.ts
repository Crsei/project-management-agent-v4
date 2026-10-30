// Historical tier matching adapted from t3code CodexUsageHistory.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { NativeSessionRef, ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import type { UsageSpeed } from "@agent-workspace/contracts/usage";
import { getDatabase, readRecord, writeRecord } from "../durable/store.ts";
import type { UsageRecord, UsageScan } from "./types.ts";

const LAUNCHES = "usage:launches";
interface CodexUsageLaunch {
  generationId: string;
  instanceId: string;
  instanceRevision: number;
  model: string;
  /** Null means inherited/unreported, not standard. Native configuration can select fast. */
  serviceTier: string | null;
  startedAt: string;
  previousTurnIds: string[];
  session?: NativeSessionRef;
}

/** Capture the actual frozen options sent to the native run, never later thread preferences. */
export function recordUsageLaunch(input: {
  generationId: string;
  instanceId: string;
  instanceRevision: number;
  provider: string;
  model: string;
  modelOptions?: readonly ProviderOptionSelection[];
  previousTurnIds?: string[];
}): void {
  if (input.provider !== "codex" || readRecord<CodexUsageLaunch>(LAUNCHES, input.generationId)) return;
  const tiers = input.modelOptions?.filter((option) => option.id === "serviceTier") ?? [];
  writeRecord<CodexUsageLaunch>(LAUNCHES, input.generationId, {
    generationId: input.generationId, instanceId: input.instanceId,
    instanceRevision: input.instanceRevision, model: input.model,
    serviceTier: tiers.length === 1 && typeof tiers[0]!.value === "string" ? tiers[0]!.value : null,
    startedAt: new Date().toISOString(), previousTurnIds: input.previousTurnIds ?? [],
  });
}

/** Native callbacks bind the launch even when that run publishes no canonical token telemetry. */
export function recordUsageLaunchSession(generationId: string, session: NativeSessionRef): void {
  const launch = readRecord<CodexUsageLaunch>(LAUNCHES, generationId);
  if (!launch || session.driver !== "codex" || session.providerInstanceId !== launch.instanceId ||
      session.instanceRevision !== launch.instanceRevision || (session.modelId && session.modelId !== launch.model)) return;
  if (session.turnId && launch.previousTurnIds.includes(session.turnId)) return;
  if (launch.session?.sessionId === session.sessionId && launch.session.turnId === session.turnId &&
      launch.session.modelId === session.modelId) return;
  if (launch.session?.turnId) {
    if (!session.turnId) return;
    if (launch.session.turnId !== session.turnId || launch.session.sessionId !== session.sessionId) {
      if (launch.serviceTier !== null) writeRecord(LAUNCHES, generationId, { ...launch, serviceTier: null });
      return;
    }
  }
  writeRecord(LAUNCHES, generationId, { ...launch, session: {
    providerInstanceId: session.providerInstanceId, driver: session.driver, sessionId: session.sessionId,
    instanceRevision: session.instanceRevision, ...(session.turnId ? { turnId: session.turnId } : {}),
    ...(session.modelId ? { modelId: session.modelId } : {}),
  } });
}

interface HistoricalLaunch {
  generationId: string;
  instanceId: string;
  model: string;
  sessionId: string;
  turnId: string;
  serviceTier: string | null;
}

function readLaunches(turnIds: ReadonlySet<string>): HistoricalLaunch[] {
  // Project only usage identities/options: never load prompts, outputs, credentials or reference databases.
  const database = getDatabase();
  const turns = JSON.stringify([...turnIds]);
  const captured = database.prepare(`
    SELECT key AS generationId, json_extract(value, '$.instanceId') AS instanceId,
      json_extract(value, '$.model') AS model, json_extract(value, '$.session.sessionId') AS sessionId,
      json_extract(value, '$.session.turnId') AS turnId, json_extract(value, '$.serviceTier') AS serviceTier
    FROM records WHERE namespace = ? AND json_extract(value, '$.session.turnId') IN (SELECT value FROM json_each(?))
  `).all(LAUNCHES, turns) as unknown as HistoricalLaunch[];
  const historical = database.prepare(`
    SELECT key AS generationId, json_extract(value, '$.providerInstanceId') AS instanceId,
      json_extract(value, '$.modelId') AS model, json_extract(value, '$.nativeSession.sessionId') AS sessionId,
      json_extract(value, '$.nativeSession.turnId') AS turnId,
      CASE WHEN json_extract(value, '$.status') = 'completed'
        AND json_extract(value, '$.nativeSession.providerInstanceId') = json_extract(value, '$.providerInstanceId')
        AND json_extract(value, '$.nativeSession.instanceRevision') = json_extract(value, '$.providerInstanceRevision')
        AND (json_extract(value, '$.nativeSession.modelId') IS NULL
          OR json_extract(value, '$.nativeSession.modelId') = json_extract(value, '$.modelId'))
      THEN (SELECT CASE WHEN COUNT(*) = 1 AND json_type(option.value, '$.value') = 'text'
          THEN json_extract(option.value, '$.value') ELSE NULL END
        FROM json_each(records.value, '$.modelOptions') AS option
        WHERE json_extract(option.value, '$.id') = 'serviceTier')
      ELSE NULL END AS serviceTier
    FROM records WHERE namespace = 'chat:generations'
      AND json_extract(value, '$.nativeSession.driver') = 'codex'
      AND json_extract(value, '$.nativeSession.turnId') IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM records AS launch WHERE launch.namespace = ? AND launch.key = records.key)
  `).all(turns, LAUNCHES) as unknown as HistoricalLaunch[];
  return [...captured, ...historical];
}

function speedForTier(tier: string | null): UsageSpeed | null {
  if (tier === "fast" || tier === "priority") return "fast";
  if (tier === "ultrafast") return "ultrafast";
  if (tier === "default" || tier === "standard") return "standard";
  return null;
}

function readUniqueLaunches(turnIds: ReadonlySet<string>): Map<string, HistoricalLaunch | null> {
  const byTurn = new Map<string, HistoricalLaunch | null>();
  for (const launch of readLaunches(turnIds)) {
    byTurn.set(launch.turnId, byTurn.has(launch.turnId) ? null : launch);
  }
  return byTurn;
}

/** The native reader may resolve only exact historical identities owned by its bound instance. */
export function resolveCodexLaunchServiceTiers<T extends {
  readonly sessionId: string;
  readonly nativeTurnId: string;
  readonly model: string;
}>(instanceId: string, requests: readonly T[]): ReadonlyMap<T, UsageSpeed> {
  const resolved = new Map<T, UsageSpeed>();
  if (!requests.length) return resolved;
  const byTurn = readUniqueLaunches(new Set(requests.map(request => request.nativeTurnId)));
  for (const request of requests) {
    const match = byTurn.get(request.nativeTurnId);
    if (!match || match.instanceId !== instanceId || match.sessionId !== request.sessionId || match.model !== request.model) continue;
    const speed = speedForTier(match.serviceTier);
    if (speed !== null) resolved.set(request, speed);
  }
  return resolved;
}

/** Multiple launches for a native turn remain ambiguous, even if their selections happen to agree. */
export function resolveCodexServiceTiers(scans: readonly UsageScan[]): UsageScan[] {
  const pending = scans.flatMap((scan) => scan.records.filter((record) => record.provider === "codex" && record.unresolvedServiceTierTurnId && !record.unrecognizedServiceTier));
  if (!pending.length) return [...scans];
  const byTurn = readUniqueLaunches(new Set(pending.map(record => record.unresolvedServiceTierTurnId!)));
  return scans.map((scan) => {
    let changed = false;
    const records = scan.records.map((record): UsageRecord => {
      if (record.provider !== "codex" || !record.unresolvedServiceTierTurnId || record.unrecognizedServiceTier) return record;
      const match = byTurn.get(record.unresolvedServiceTierTurnId);
      if (!match || match.sessionId !== record.sessionId || match.model !== record.model ||
          (record.nativeTurnId && record.nativeTurnId !== match.turnId) ||
          !(scan.source.instanceIds?.includes(match.instanceId) || record.instanceId === match.instanceId)) return record;
      const speed = speedForTier(match.serviceTier);
      if (speed === null) return record;
      changed = true;
      const { unresolvedServiceTierTurnId: _unresolved, ...resolved } = record;
      return { ...resolved, speed };
    });
    return changed ? { ...scan, records } : scan;
  });
}
