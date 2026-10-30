import type * as Effect from "effect/Effect";
import type { ProviderAdapterV2SessionRuntime, ProviderAdapterV2EnsureThreadInput, ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";

/** Only the original operation that owns this runtime can provide native evidence. */
export interface PiSessionEvidence {
  readonly probe: Effect.Effect<{ readonly protocol: string; readonly cwd: string; readonly homeDirectory: string }, unknown>;
  readonly readLegacy: (input: { readonly nativeSessionId: string; readonly turnId?: string; readonly messageId?: string; readonly ensure: ProviderAdapterV2EnsureThreadInput }) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, unknown>;
  readonly adoptBuffered?: (input: { readonly request: ProviderContinuationRequest; readonly turn: Omit<ProviderAdapterV2TurnInput, "message">; readonly isCurrent: Effect.Effect<boolean, unknown> }) => Effect.Effect<boolean, unknown>;
}
const sessions = new WeakMap<ProviderAdapterV2SessionRuntime, PiSessionEvidence>();
export function bindPiSessionEvidence(runtime: ProviderAdapterV2SessionRuntime, evidence: PiSessionEvidence): () => void {
  sessions.set(runtime, evidence);
  return () => { if (sessions.get(runtime) === evidence) sessions.delete(runtime); };
}
export function readPiSessionEvidence(runtime: ProviderAdapterV2SessionRuntime): PiSessionEvidence | undefined {
  return sessions.get(runtime);
}
