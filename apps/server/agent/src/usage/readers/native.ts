// PM aggregation adapter. Native discovery, formats and scan protocols belong to original modules.
import os from "node:os";
import { stat } from "node:fs/promises";
import * as Effect from "effect/Effect";
import { ServerSettings, UsageProviderKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProviderUsageScan, UsageRecord as OriginalUsageRecord } from "@t3tools/provider-core/server/usage";
import { providerUsageContext, type StoredProviderInstance } from "../../providers/instances.ts";
import { getPmProviderApplication } from "../../providers/t3code/application-access.ts";
import { pmUsageBinding } from "../../providers/t3code/native-usage.ts";
import type { UsageReadContext, UsageRecord, UsageScan } from "../types.ts";
import { scanOriginalTranscripts } from "./transcripts.ts";
import { waitForUsageRead } from "../cancellation.ts";

const isOriginalUsageProvider = Schema.is(UsageProviderKind);
function isOriginalUsageRecord(record: UsageRecord): record is UsageRecord & OriginalUsageRecord {
  return isOriginalUsageProvider(record.provider);
}

function unavailable(instance: StoredProviderInstance, status: "missing" | "failed", message: string): UsageScan {
  return { source: { fingerprint: { hostId: os.hostname(), provider: instance.driver, resolvedHomePath: instance.homeDirectory, volumeId: instance.instanceId },
    status, scannedFiles: 0, skippedFiles: 0, malformedRecords: 0, distinctSessions: 0,
    message, instanceIds: [instance.instanceId], label: instance.label }, records: [] };
}
async function projectScan(instance: StoredProviderInstance, native: ProviderUsageScan, context: UsageReadContext): Promise<UsageScan> {
  let volumeId = native.volumeId ?? "";
  if (native.volumeId === undefined) {
    try { const info = await stat(native.dir); volumeId = `${info.dev}:${info.ino}`; } catch { /* Missing sources still have a fingerprint. */ }
  }
  const records = (native.files ?? []).flatMap(file => file.records.filter(record => record.timestampMs >= context.sinceMs && record.timestampMs < context.untilMs)
    .map(record => ({ ...record, instanceId: instance.instanceId })));
  return { source: { fingerprint: { hostId: native.hostId ?? os.hostname(), provider: instance.driver, resolvedHomePath: native.dir, volumeId },
    status: native.files === null && (!native.status || native.status === "ok") ? "missing" : native.status ?? "ok",
    scannedFiles: native.files?.filter(file => file.records.length).length ?? 0,
    skippedFiles: native.files?.filter(file => !file.records.length).length ?? 0,
    malformedRecords: 0, distinctSessions: new Set(records.map(record => record.sessionId).filter(Boolean)).size,
    message: native.message ?? (native.files === null ? "No native usage history is available for this source." : null),
    ...(native.action ? { action: native.action } : {}), ...(native.refreshing ? { refreshing: true as const } : {}),
    instanceIds: [instance.instanceId], label: instance.label }, records };
}

/** No session is opened and no prompt is sent. The application owns every retained reader's lifetime. */
export async function scanNativeUsage(request: UsageReadContext): Promise<UsageScan[]> {
  request.signal?.throwIfAborted();
  const { signal, ...context } = request;
  const settings = Schema.decodeUnknownSync(ServerSettings)({ cursorKeychainUsageEnabled: context.settings.cursorKeychainUsageEnabled });
  const work = Promise.all(context.instances.map(async instance => {
    try {
      return await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const nativeContext = providerUsageContext(instance);
        const lease = yield* getPmProviderApplication().host.acquire(nativeContext, "usage");
        yield* lease.assertCurrent;
        const reader = lease.usage;
        if (!reader) return [unavailable(instance, "missing", "The original provider module does not support native usage history; available turn telemetry is shown separately.")];
        let scans: UsageScan[];
        if (reader.kind === "transcripts") {
          const directories = yield* reader.directories;
          scans = yield* Effect.promise(() => Promise.all(directories.map(directory => scanOriginalTranscripts(context, {
            ...directory, instance, provider: reader.provider, format: reader.format, binding: pmUsageBinding(nativeContext),
          }))));
          if (reader.resolveServiceTiers) for (const scan of scans) {
            const speeds = yield* reader.resolveServiceTiers(scan.records.filter(isOriginalUsageRecord));
            scan.records = scan.records.map(record => {
              if (!isOriginalUsageRecord(record)) return record;
              const speed = speeds.get(record);
              if (speed === undefined || record.unrecognizedServiceTier) return record;
              const { unresolvedServiceTierTurnId: _tier, ...resolved } = record;
              return { ...resolved, speed };
            });
          }
        } else {
          const original = yield* reader.scan({ settings, windowStartMs: context.sinceMs,
            retentionCutoffMs: Date.now() - 92 * 86400_000, awaitRefresh: context.awaitRefresh });
          scans = yield* Effect.promise(() => Promise.all(original.map(scan => projectScan(instance, scan, context))));
        }
        yield* lease.assertCurrent;
        return scans.length ? scans : [unavailable(instance, "missing", "The original usage reader found no available native history source for this instance.")];
      })));
    } catch {
      return [unavailable(instance, "failed", "The original native usage reader could not read this instance's current history; no alternate environment was used.")];
    }
  }));
  return waitForUsageRead(work.then(results => results.flat()), signal);
}
