import type { AgentCapabilityBindings, CapabilityManifest } from "@agent-workspace/contracts/collaboration";
import { pmToolApprovalAuthoritySchema, type PmToolApprovalAuthority } from "@agent-workspace/contracts/pm-tools";
import type { StoredPmToolCall } from "../pm-tools.ts";
import { agentChatToolDefinitions } from "../../../../../packages/application/src/agent-chat-tools.ts";
import { pmToolRequestHash } from "../../../../../packages/infrastructure/src/pm-tool-service-auth.ts";
import { getChatGeneration } from "../durable/chat-runtime.ts";
import { assertThreadWritable, ThreadConflictError } from "../durable/threads.ts";
import { DurableError } from "../durable/errors.ts";
import { assertDefinitionLaunchable, getAgentVersion } from "./definitions.ts";
import { assertCollaborationApprovalNotCancelled, getCollaborationGenerationContext, readCollaborationRun } from "./runs.ts";
import { assertRunCapabilitiesCurrent, capabilityFingerprint, defaultCapabilityBindings, resolveRunCapabilityFacts } from "./capabilities.ts";
import { pmFetch, storedTarget } from "../pm-tool-transport.ts";

export type PmApprovalCapabilityGuard = {
  toolSchemaFingerprint: string;
  pmAuthority: PmToolApprovalAuthority;
  manifest: CapabilityManifest | null;
  bindings: AgentCapabilityBindings | null;
};
function toolSchemaFingerprint(name: string): string {
  const definition = agentChatToolDefinitions.find(item => item.function.name === name);
  return capabilityFingerprint([name, definition?.function.parameters ?? null]);
}
async function currentPmApprovalAuthority(value: StoredPmToolCall, headers?: Headers): Promise<PmToolApprovalAuthority> {
  const target = storedTarget(value);
  if (!value.record.actorId || value.requestHash !== pmToolRequestHash(value.request, value.record.actorId))
    throw new DurableError(409, "approval_request_changed", "The original action, parameters or target no longer match the accepted request.");
  const authority = pmToolApprovalAuthoritySchema.parse(await pmFetch(target.workspaceId, "/approval-authority", headers, value.request));
  if (authority.actorId !== value.record.actorId || authority.requestHash !== value.requestHash ||
      authority.target.workspaceId !== target.workspaceId || authority.target.projectId !== target.projectId)
    throw new DurableError(409, "approval_request_changed", "PM returned authority for a different actor or original request.");
  return authority;
}
export async function capturePmApprovalCapabilities(value: StoredPmToolCall, headers?: Headers): Promise<PmApprovalCapabilityGuard> {
  const pmAuthority = await currentPmApprovalAuthority(value, headers);
  const generation = getChatGeneration(value.record.generationId);
  const context = getCollaborationGenerationContext(value.record.generationId);
  const agent = context ? getAgentVersion(context.agentId, context.agentVersion) : null;
  if (context && !agent) throw new DurableError(409, "approval_capability_unavailable", "The original Agent version is unavailable; no approval was admitted.");
  const bindings = agent?.config.capabilityBindings ?? defaultCapabilityBindings();
  const target = value.request.target;
  const manifest = generation && target ? await resolveRunCapabilityFacts({
    providerInstanceId: generation.providerInstanceId, capabilityBindings: bindings, workspaceId: target.workspaceId,
    ...(target.projectId ? { projectId: target.projectId } : {}), ...(headers ? { headers } : {}),
  }) : null;
  return { toolSchemaFingerprint: toolSchemaFingerprint(value.record.name), pmAuthority, manifest, bindings: manifest ? bindings : null };
}
export function pmApprovalDecisionFingerprint(value: StoredPmToolCall): string {
  const guard = value.approvalCapabilities;
  return capabilityFingerprint({ request: value.request, actorId: value.record.actorId ?? null, targetCeiling: value.targetCeiling ?? null, delegation: value.delegation ?? null,
    guard: guard ? { toolSchemaFingerprint: guard.toolSchemaFingerprint, pmAuthority: guard.pmAuthority ?? null, capabilityFingerprint: guard.manifest?.fingerprint ?? null, bindings: guard.bindings } : null });
}
function assertApprovalThreadWritable(value: StoredPmToolCall): void {
  if (value.request.linkage?.executionRoot === "external") return;
  try { assertThreadWritable(value.record.threadId); }
  catch (error) {
    if (!(error instanceof ThreadConflictError)) throw error;
    throw new DurableError(409, error.code, error.message);
  }
}
/** Explicit persisted cancellation fences new admission only, never original outcome reconciliation. */
export function assertPmApprovalNotCancelled(value: StoredPmToolCall): void {
  const runId = value.request.linkage?.collaboration?.runId ?? getCollaborationGenerationContext(value.record.generationId)?.runId;
  if (!runId) return;
  const original = readCollaborationRun(runId);
  if (!original) throw new DurableError(409, "approval_run_unavailable", "The original Run identity is unavailable; no new PM operation may be admitted.");
  assertCollaborationApprovalNotCancelled({ runId, rootRunId: original.rootRunId });
}
/** Called before the original owner's atomic pending -> running claim, not by a new approval authority. */
export async function assertPmApprovalCapabilitiesCurrent(value: StoredPmToolCall, headers?: Headers): Promise<void> {
  assertApprovalThreadWritable(value);
  assertPmApprovalNotCancelled(value);
  const guard = value.approvalCapabilities;
  if (!guard?.pmAuthority) throw new DurableError(409, "approval_capability_unverified", "This historical approval has no exact native authority snapshot. Reject it and issue a new explicit operation; do not approve stale authority.");
  if (!value.record.actorId || value.requestHash !== pmToolRequestHash(value.request, value.record.actorId))
    throw new DurableError(409, "approval_request_changed", "The original action, parameters or target no longer match the accepted request.");
  if (guard.toolSchemaFingerprint !== toolSchemaFingerprint(value.request.name))
    throw new DurableError(409, "approval_capability_changed", "The original PM tool schema changed; this approval is no longer valid.");
  if (guard.pmAuthority.fingerprint !== (await currentPmApprovalAuthority(value, headers)).fingerprint)
    throw new DurableError(409, "approval_capability_changed", "The original PM operation's effective capabilities, entity or workflow meaning changed; this approval is no longer valid.");
  const context = getCollaborationGenerationContext(value.record.generationId);
  if (context) assertDefinitionLaunchable({ kind: "agent", agentId: context.agentId, agentVersion: context.agentVersion }, context.target.workspaceId, context.target.projectId);
  if (guard.manifest && guard.bindings && value.request.target) {
    await assertRunCapabilitiesCurrent(guard.manifest, {
      providerInstanceId: guard.manifest.providerInstanceId, capabilityBindings: guard.bindings,
      workspaceId: value.request.target.workspaceId, ...(value.request.target.projectId ? { projectId: value.request.target.projectId } : {}),
      ...(headers ? { headers } : {}),
    });
  }
  assertApprovalThreadWritable(value);
  assertPmApprovalNotCancelled(value);
  if (context) assertDefinitionLaunchable({ kind: "agent", agentId: context.agentId, agentVersion: context.agentVersion }, context.target.workspaceId, context.target.projectId);
}
