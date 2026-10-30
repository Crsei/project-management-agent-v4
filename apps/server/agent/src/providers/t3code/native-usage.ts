// PM host boundary for the original provider-core usage contract.
// Native formats, discovery and scan services remain owned by the source drivers.
import { createHash } from "node:crypto";
import path from "node:path";
import type { ServerSettings, UsageReadError } from "@t3tools/contracts";
import type { ProviderUsageInstance, ProviderUsageReader, ProviderUsageScan, TranscriptUsageFormat, UsageRecord, UsageSpeed } from "@t3tools/provider-core/server/usage";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { providerDataDirectory } from "../instances.ts";
import type { ProviderDriverContext } from "../driver-adapter.ts";

/** Cache isolation is stricter than source identity; no secret values are persisted. */
export function pmUsageBinding(context: ProviderDriverContext): string {
  return createHash("sha256").update(JSON.stringify([
    providerDataDirectory(), context.instanceId, context.driver, context.revision,
    path.resolve(context.homeDirectory), path.resolve(context.cwd), path.resolve(context.stateDirectory),
    Object.entries(context.env).sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(context.config).sort(([a], [b]) => a.localeCompare(b)),
  ])).digest("hex");
}
type ScanInput = {
  readonly settings: ServerSettings;
  readonly windowStartMs: number;
  readonly retentionCutoffMs: number;
  readonly awaitRefresh: boolean;
};
export type PmNativeUsageReader = {
  readonly kind: "transcripts";
  readonly provider: UsageRecord["provider"];
  readonly format: TranscriptUsageFormat<unknown>;
  readonly directories: Effect.Effect<ReadonlyArray<{ readonly dir: string; readonly fileName?: string }>>;
  readonly resolveServiceTiers?: (records: readonly UsageRecord[]) => Effect.Effect<ReadonlyMap<UsageRecord, UsageSpeed>>;
} | {
  readonly kind: "scan";
  readonly provider: UsageRecord["provider"];
  readonly scan: (input: ScanInput) => Effect.Effect<readonly ProviderUsageScan[], UsageReadError>;
};

/** Called once while building the existing retained family, with its already-built services. */
export function makePmNativeUsageReader<Config, R>(
  reader: ProviderUsageReader<Config, R> | undefined,
  instance: ProviderUsageInstance<Config>,
  services: Context.Context<R>,
): PmNativeUsageReader | undefined {
  if (!reader) return undefined;
  if (reader.kind === "scan") return {
    kind: "scan", provider: reader.provider,
    scan: input => reader.scan({ ...input, instances: [instance] }).pipe(Effect.provideContext(services)),
  };
  return {
    kind: "transcripts", provider: reader.provider, format: reader.format,
    directories: reader.directories(instance).pipe(Effect.provideContext(services)),
    ...(reader.resolveServiceTiers ? { resolveServiceTiers: (records: readonly UsageRecord[]) => reader.resolveServiceTiers!(records).pipe(Effect.provideContext(services)) } : {}),
  };
}
