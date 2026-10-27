import type { ThreadMessageLike } from "@assistant-ui/react"
import type { AgentChatMessage } from "@contracts"

function messageStatus(message: AgentChatMessage): ThreadMessageLike["status"] {
  if (message.role !== "assistant") return undefined
  if (message.status === "streaming") return { type: "running" }
  if (message.status === "complete") return { type: "complete", reason: "stop" }
  if (message.status === "cancelled") return { type: "incomplete", reason: "cancelled" }
  if (message.status === "error") return { type: "incomplete", reason: "error" }
  return { type: "incomplete", reason: "other" }
}

/**
 * The server stores final text and tool calls without interleaved positions.
 * Present actions before the final answer; keep the original message in
 * metadata for typed tool/result rendering.
 */
export function convertAgentMessage(message: AgentChatMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    createdAt: new Date(message.createdAt),
    content: [
      ...(message.toolCalls ?? []).map(call => ({
        type: "tool-call" as const,
        toolCallId: call.id,
        toolName: call.name,
        result: call.result ?? (call.error ? { error: call.error } : undefined),
        isError: call.status === "failed",
      })),
      ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
    ],
    status: messageStatus(message),
    metadata: { custom: { agentMessage: message } },
  }
}
