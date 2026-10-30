// Usage aggregation adapted from t3code. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { USAGE_CONTRACT_VERSION, type UsageSummary, type UsageSummaryInput } from "@agent-workspace/contracts/usage";
import { dataDirectory } from "../paths.ts";
import { listStoredInstances, providerUsageContext } from "../providers/instances.ts";
import { scanNativeUsage } from "./readers/native.ts";
import { flushTranscriptCache } from "./readers/transcript-cache.ts";
import { pmUsageBinding } from "../providers/t3code/native-usage.ts";
import { scanLedgerUsage } from "./ledger.ts";
import { aggregateUsage } from "./aggregation.ts";
import { createOverrideRateTable, getUsagePricing } from "./pricing.ts";
import { getUsageSettings } from "./settings.ts";
import { resolveCodexServiceTiers } from "./service-tiers.ts";
import type { UsageReadContext } from "./types.ts";

export class UsageInputError extends Error {
  readonly status = 400;
  readonly code = "invalid_request";
}

function readWindow(input: UsageSummaryInput): { sinceMs: number; untilMs: number } {
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }); }
  catch { throw new UsageInputError("Invalid IANA time zone."); }
  const day = (value: string) => {
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new UsageInputError("Invalid calendar day.");
    return ms;
  };
  const first = day(input.sinceDay), last = day(input.untilDay);
  if (first > last) throw new UsageInputError("Invalid usage date range.");
  if (input.resolution !== "hour") return { sinceMs: first - 36 * 3600_000, untilMs: last + 60 * 3600_000 };
  if (!input.sinceTime || !input.untilTime) throw new UsageInputError("Hourly usage requires exact time bounds.");
  const sinceMs = Date.parse(input.sinceTime), untilMs = Date.parse(input.untilTime);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs >= untilMs) throw new UsageInputError("Invalid hourly usage range.");
  return { sinceMs, untilMs };
}

interface SummaryDependencies {
  instances: typeof listStoredInstances;
  settings: typeof getUsageSettings;
  native: typeof scanNativeUsage;
  ledger: typeof scanLedgerUsage;
  pricing: typeof getUsagePricing;
  tiers: typeof resolveCodexServiceTiers;
  persist: typeof flushTranscriptCache;
  identity: () => string;
}

/** Only in-flight work is shared. A departing HTTP caller cannot cancel another caller's scan. */
export function createUsageSummaryReader(overrides: Partial<SummaryDependencies> = {}): (input: UsageSummaryInput) => Promise<UsageSummary> {
  const dependencies: SummaryDependencies = {
    instances: listStoredInstances, settings: getUsageSettings, native: scanNativeUsage, ledger: scanLedgerUsage,
    pricing: getUsagePricing, tiers: resolveCodexServiceTiers, persist: flushTranscriptCache,
    identity: dataDirectory, ...overrides,
  };
  const pending = new Map<string, Promise<UsageSummary>>();
  return (request) => {
    const input = { ...request, ...(request.instanceIds ? { instanceIds: [...new Set(request.instanceIds)].sort() } : {}) };
    const window = readWindow(input);
    const settings = dependencies.settings();
    const selected = input.instanceIds ? new Set(input.instanceIds) : null;
    const instances = dependencies.instances().filter((instance) => !selected || selected.has(instance.instanceId));
    const context: UsageReadContext = { instances, ...window, awaitRefresh: input.awaitRefresh === true, settings };
    const identity = dependencies.identity();
    const key = JSON.stringify([
      identity, input.sinceDay, input.untilDay, input.timeZone, input.resolution ?? "day",
      input.sinceTime ?? null, input.untilTime ?? null, input.instanceIds ?? null, context.awaitRefresh,
      instances.map((instance) => {
        let binding: string | null = null;
        try { binding = pmUsageBinding(providerUsageContext(instance)); } catch { /* The source reports its unresolvable binding, without an ambient fallback. */ }
        return [instance.instanceId, instance.revision, instance.driver, instance.homeDirectory, instance.stateDirectory, binding];
      }).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      settings,
    ]);
    const existing = pending.get(key);
    if (existing) return existing;
    const start = performance.now();
    // Enroll before executing any dependency, including a synchronously throwing reader.
    const work = Promise.resolve().then(async (): Promise<UsageSummary> => {
      const [scans, rate] = await Promise.all([
        dependencies.native(context), dependencies.pricing(context.awaitRefresh),
      ]);
      if (dependencies.identity() !== identity) throw Object.assign(new Error("Usage storage changed; refresh the current environment."), { status: 409, code: "usage_configuration_changed" });
      let cacheWarning: string | null = null;
      try { await dependencies.persist(); }
      catch { cacheWarning = "Derived transcript cache could not be saved; native history remains available."; }
      if (dependencies.identity() !== identity) throw Object.assign(new Error("Usage storage changed; refresh the current environment."), { status: 409, code: "usage_configuration_changed" });
      const native = scans.map((scan) => {
        const unresolved = scan.records.some((record) => record.unresolvedServiceTierTurnId);
        const unrecognized = scan.records.some((record) => record.unrecognizedServiceTier);
        const warnings = [scan.source.message,
          unresolved ? "Some turns have an unreported service tier; speed premiums cannot be verified." : null,
          unrecognized ? "Some turns report an unrecognized service tier; automatic cost estimates and speed attribution are unverified." : null,
          cacheWarning].filter(Boolean);
        return warnings.length ? { ...scan, source: { ...scan.source,
          status: scan.source.status === "ok" && (unresolved || unrecognized || cacheWarning) ? "partial" as const : scan.source.status,
          message: warnings.join(" ") } } : scan;
      });
      const ledger = dependencies.tiers(dependencies.ledger(context, native)).map((scan) =>
        scan.records.some((record) => record.unresolvedServiceTierTurnId)
          ? { ...scan, source: { ...scan.source, message: `${scan.source.message ?? ""} Some turns have an unreported service tier; speed premiums cannot be verified.`.trim() } }
          : scan);
      const { buckets, sources } = aggregateUsage([...native, ...ledger], input, {
        table: rate.table, overrides: createOverrideRateTable(settings.usagePriceOverrides), aliases: settings.usageModelAliases,
      });
      return { contractVersion: USAGE_CONTRACT_VERSION, readAt: new Date().toISOString(), timeZone: input.timeZone,
        sinceDay: input.sinceDay, untilDay: input.untilDay, buckets, sources, pricing: rate.pricing,
        scanDurationMs: Math.max(0, Math.round(performance.now() - start)) };
    });
    const shared: Promise<UsageSummary> = work.finally(() => { if (pending.get(key) === shared) pending.delete(key); });
    pending.set(key, shared);
    return shared;
  };
}

const summaryReader = createUsageSummaryReader();
export async function readUsageSummary(input: UsageSummaryInput): Promise<UsageSummary> {
  return summaryReader(input);
}
