import { createHash } from "node:crypto";
import { z } from "zod";
import { delegationInputSchema, type DelegationInput } from "@agent-workspace/contracts/collaboration";
import { DurableError } from "../durable/errors.ts";
import { getChatGeneration } from "../durable/chat-runtime.ts";
import { getStoredInstance } from "../providers/instances.ts";
import { assertThreadWritable } from "../durable/threads.ts";
import { getAgentVersion } from "./definitions.ts";
import { collaborationHostToolSupport } from "./capabilities.ts";
import { assertCollaborationGenerationExecution, getCollaborationGenerationContext, invokeCollaborationTool } from "./runs.ts";

export const collaborationToolInputSchema = delegationInputSchema;
export type CollaborationToolName = "delegate_task" | "ask_agent";
export type CollaborationTransportCall = {
  generationId: string; transportId: string; requestId: string | number | null;
  name: CollaborationToolName; arguments: unknown; headers?: Headers;
};
export function isCollaborationTool(name: string): name is CollaborationToolName { return name === "delegate_task" || name === "ask_agent"; }
export function collaborationOriginalCallId(input: Pick<CollaborationTransportCall, "generationId" | "transportId" | "requestId">): string {
  return createHash("sha256").update(JSON.stringify([input.generationId, input.transportId, input.requestId])).digest("hex");
}
const descriptions: Record<CollaborationToolName, string> = {
  delegate_task: "Accept a real child execution by explicit immutable Agent version. The server inherits the parent's PM target, directory, identity and shared limits. Returns actual accepted delegation/child Run IDs, not completion. The child result is delivered asynchronously to this parent; never claim the task is complete from acceptance.",
  ask_agent: "Ask an explicitly versioned Agent through a tracked asynchronous child execution. Returns actual accepted delegation/child Run IDs, not a synchronous answer. The result is delivered to the original parent when available; selection does not grant additional PM or directory authority.",
};
async function enabledTools(generationId: string, headers?: Headers): Promise<CollaborationToolName[]> {
  const context = getCollaborationGenerationContext(generationId);
  if (!context) return [];
  await assertCollaborationGenerationExecution(generationId, headers);
  const generation = getChatGeneration(generationId);
  const instance = generation ? getStoredInstance(generation.providerInstanceId) : null;
  if (!instance || !collaborationHostToolSupport(instance.driver).supported) return [];
  const agent = getAgentVersion(context.agentId, context.agentVersion);
  assertThreadWritable(context.threadId);
  if (!agent) throw new DurableError(409, "agent_version_not_found", "The frozen Agent version is unavailable.");
  return agent.config.capabilityBindings.hostTools;
}
export async function listCollaborationGenerationTools(generationId: string, headers?: Headers) {
  return (await enabledTools(generationId, headers)).map(name => ({
    name, description: descriptions[name], write: true, inputSchema: z.toJSONSchema(delegationInputSchema, { io: "input" }),
  }));
}
export async function callCollaborationGenerationTool(input: CollaborationTransportCall): Promise<unknown> {
  const context = getCollaborationGenerationContext(input.generationId);
  if (!context) throw new DurableError(403, "collaboration_context_required", "Collaboration tools require a real server-bound parent Run.");
  const generation = getChatGeneration(input.generationId);
  const instance = generation ? getStoredInstance(generation.providerInstanceId) : null;
  const support = collaborationHostToolSupport(instance?.driver ?? "unknown");
  if (!support.supported) throw new DurableError(412, "collaboration_tools_unsupported", support.reason ?? "Collaboration tools are unsupported.");
  if (!(await enabledTools(input.generationId, input.headers)).includes(input.name)) throw new DurableError(403, "collaboration_tool_not_bound", "This collaboration tool was not selected in the immutable Agent version.");
  const argumentsValue: DelegationInput = delegationInputSchema.parse(input.arguments);
  const receipt = await invokeCollaborationTool({
    generationId: input.generationId, callId: collaborationOriginalCallId(input), tool: input.name, arguments: argumentsValue,
    ...(input.headers ? { headers: input.headers } : {}),
  });
  // Acceptance is transport success, never a fabricated success status for the asynchronous child.
  return { kind: "collaboration_delegation", accepted: true, ...receipt };
}
