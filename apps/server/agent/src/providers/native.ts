import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import { providerContext, type StoredProviderInstance } from "./instances.ts";
import type { PmExecutionIdentity, PmProviderExecutionService } from "./t3code/contract.ts";
import type { ProviderDriverContext } from "./driver-adapter.ts";
import { pmExecutionError } from "./t3code/continuation.ts";

let executionService: PmProviderExecutionService | undefined;
/** Parent lifecycle owns the one service; release cannot clear a replacement application instance. */
export function bindPmProviderExecutionService(service: PmProviderExecutionService): () => void {
  if (executionService && executionService !== service) throw new Error("Provider execution service is already bound.");
  executionService = service;
  return () => { if (executionService === service) executionService = undefined; };
}

/** Metadata-only fork through the original AdapterV2. Never sends a prompt or invokes a local RPC parser. */
export async function forkNativeSession(
  instance: StoredProviderInstance,
  source: NativeSessionRef,
  boundary: { turnId?: string; messageId?: string } | undefined,
  cwd: string,
  signal?: AbortSignal,
  execution?: PmExecutionIdentity,
  authorizeExecution?: ProviderDriverContext["authorizeExecution"],
): Promise<NativeSessionRef> {
  if (signal?.aborted) throw pmExecutionError(499, "aborted", "Request cancelled.", signal.reason === "server-shutdown" ? "interrupted" : "cancelled");
  if (source.driver !== instance.driver || source.providerInstanceId !== instance.instanceId || source.instanceRevision !== instance.revision
    || (source.cwd !== undefined && source.cwd !== cwd))
    throw pmExecutionError(409, "session_mismatch", "Native source belongs to another instance, revision or working directory.");
  if (boundary && ((instance.driver === "codex" && !boundary.turnId) || (instance.driver === "claude" && !boundary.messageId)))
    throw pmExecutionError(409, "unsupported_fork", instance.driver === "claude" ? "Claude exact fork requires a native assistant message UUID." : "Codex exact fork requires a native completed turn ID.");
  if (!executionService) throw pmExecutionError(412, "provider_not_configured", "Provider execution lifecycle has not been assembled.");
  return executionService.fork({ ...providerContext(instance, cwd),
    ...(execution === undefined ? {} : { execution }),
    ...(authorizeExecution === undefined ? {} : { authorizeExecution }) }, source, boundary, signal);
}
