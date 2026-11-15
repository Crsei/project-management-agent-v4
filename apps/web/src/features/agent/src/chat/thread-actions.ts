import type { ThreadActionCapabilities } from "@agent-workspace/contracts/chat";
import { workspaceClient } from "../network";

export function getThreadActionCapabilities(threadId: string): Promise<ThreadActionCapabilities> {
  return workspaceClient.json(`/api/chat/threads/${encodeURIComponent(threadId)}/actions`);
}
export function implementPlan(generationId: string, itemId: string, idempotencyKey: string): Promise<{ threadId: string; generationId: string }> {
  return workspaceClient.json(`/api/chat/generations/${encodeURIComponent(generationId)}/plans/${encodeURIComponent(itemId)}/implement`, {
    method: "POST", body: JSON.stringify({ idempotencyKey }),
  });
}
export function resolveSubagent(generationId: string, itemId: string): Promise<{ threadId: string | null; reason?: string }> {
  return workspaceClient.json(`/api/chat/generations/${encodeURIComponent(generationId)}/subagents/${encodeURIComponent(itemId)}/session`);
}
export function forkGeneration(generationId: string, idempotencyKey: string): Promise<{ threadId: string }> {
  return workspaceClient.json(`/api/chat/generations/${encodeURIComponent(generationId)}/native-fork`, {
    method: "POST", body: JSON.stringify({ idempotencyKey }),
  });
}
/** Caller must display the exact conversation-only effects and obtain confirmation before calling. */
export async function rewindThreadConversation(threadId: string, input: {
  messageId: string; expectedHeadId: string | null; revision: number; confirmed: boolean; idempotencyKey: string;
}): Promise<{ headId: string; effects: "conversation-only" }> {
  const result = await workspaceClient.json<{ headId: string; effects: "conversation-only" }>(`/api/chat/threads/${encodeURIComponent(threadId)}/rewind`, {
    method: "POST", body: JSON.stringify(input),
  });
  window.dispatchEvent(new CustomEvent("agent-thread-action", { detail: { threadId, reload: true } }));
  return result;
}
