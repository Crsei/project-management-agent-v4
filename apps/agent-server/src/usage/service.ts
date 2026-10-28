// Usage aggregation adapted from t3code. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { USAGE_CONTRACT_VERSION, type UsageSummary, type UsageSummaryInput } from "@agent-workspace/contracts/usage";
import { listStoredInstances } from "../providers/instances.ts";
import { scanTranscriptUsage } from "./readers/transcripts.ts";
import { scanDatabaseUsage } from "./readers/databases.ts";
import { scanCursorUsage } from "./readers/cursor.ts";
import { scanLedgerUsage } from "./ledger.ts";
import { aggregateUsage } from "./aggregation.ts";
import { createOverrideRateTable, getUsagePricing } from "./pricing.ts";
import { getUsageSettings } from "./settings.ts";
import type { UsageScan } from "./types.ts";

export class UsageInputError extends Error {
  readonly status = 400;
  readonly code = "invalid_request";
}
export async function readUsageSummary(input: UsageSummaryInput): Promise<UsageSummary> {
  const start = performance.now();
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }); }
  catch { throw new UsageInputError("Invalid IANA time zone."); }
  const day = (value: string) => {
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new UsageInputError("Invalid calendar day.");
    return ms;
  };
  const first = day(input.sinceDay), last = day(input.untilDay);
  if (first > last) throw new UsageInputError("Invalid usage date range.");
  let sinceMs = first - 36 * 3600_000;
  let untilMs = last + 60 * 3600_000;
  if (input.resolution === "hour") {
    if (!input.sinceTime || !input.untilTime) throw new UsageInputError("Hourly usage requires exact time bounds.");
    sinceMs = Date.parse(input.sinceTime); untilMs = Date.parse(input.untilTime);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs >= untilMs) throw new UsageInputError("Invalid hourly usage range.");
  }
  const settings = getUsageSettings();
  const selected = input.instanceIds ? new Set(input.instanceIds) : null;
  const instances = listStoredInstances().filter((instance) => !selected || selected.has(instance.instanceId));
  const context = { instances, sinceMs, untilMs, awaitRefresh: input.awaitRefresh === true, settings };
  const [transcripts, databases, cursor, rate] = await Promise.all([
    scanTranscriptUsage(context), scanDatabaseUsage(context), scanCursorUsage(context), getUsagePricing(input.awaitRefresh),
  ]);
  const native = [...transcripts, ...databases, ...cursor].map((scan) =>
    scan.records.some((record) => record.unresolvedServiceTierTurnId)
      ? { ...scan, source: { ...scan.source, message: [scan.source.message, "Some turns have an unreported service tier; speed premiums cannot be verified."].filter(Boolean).join(" ") } }
      : scan);
  const ledger = scanLedgerUsage(context, native);
  const represented = new Set([...native, ...ledger].flatMap((scan) => scan.source.instanceIds ?? []));
  const unavailable: UsageScan[] = instances.filter((instance) => !represented.has(instance.instanceId)).map((instance) => ({
    source: { fingerprint: { hostId: "local", provider: instance.driver, resolvedHomePath: instance.homeDirectory, volumeId: instance.instanceId },
      status: "missing", scannedFiles: 0, skippedFiles: 0, malformedRecords: 0, distinctSessions: 0,
      message: "No native history or canonical usage telemetry is available for this instance.",
      instanceIds: [instance.instanceId], label: instance.label }, records: [],
  }));
  const { buckets, sources } = aggregateUsage([...native, ...ledger, ...unavailable], input, {
    table: rate.table, overrides: createOverrideRateTable(settings.usagePriceOverrides), aliases: settings.usageModelAliases,
  });
  return { contractVersion: USAGE_CONTRACT_VERSION, readAt: new Date().toISOString(), timeZone: input.timeZone,
    sinceDay: input.sinceDay, untilDay: input.untilDay, buckets, sources, pricing: rate.pricing,
    scanDurationMs: Math.max(0, Math.round(performance.now() - start)) };
}
