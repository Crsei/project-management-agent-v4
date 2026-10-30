import type * as Effect from "effect/Effect";
import type { ProviderAdapterV2SessionRuntime, ProviderAdapterV2EnsureThreadInput, ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";

/** Only the original operation that owns this runtime can provide native evidence. */
export interface CursorSessionEvidence {
  readonly probe: Effect.Effect<{ readonly protocol: string; readonly cwd: string; readonly homeDirectory: string }, unknown>;
  readonly readLegacy: (input: { readonly nativeSessionId: string; readonly turnId?: string; readonly messageId?: string; readonly ensure: ProviderAdapterV2EnsureThreadInput }) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, unknown>;
  readonly adoptBuffered?: (input: { readonly request: ProviderContinuationRequest; readonly turn: Omit<ProviderAdapterV2TurnInput, "message">; readonly isCurrent: Effect.Effect<boolean, unknown> }) => Effect.Effect<boolean, unknown>;
}
const sessions = new WeakMap<ProviderAdapterV2SessionRuntime, CursorSessionEvidence>();
export function bindCursorSessionEvidence(runtime: ProviderAdapterV2SessionRuntime, evidence: CursorSessionEvidence): () => void {
  sessions.set(runtime, evidence);
  return () => { if (sessions.get(runtime) === evidence) sessions.delete(runtime); };
}
export function readCursorSessionEvidence(runtime: ProviderAdapterV2SessionRuntime): CursorSessionEvidence | undefined {
  return sessions.get(runtime);
}
