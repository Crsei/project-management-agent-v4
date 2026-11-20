import type { ChatGenerationView } from "@agent-workspace/contracts/chat";
import { workspaceClient } from "../network";

export type ThreadCompactionAvailability = { available: boolean; expiresAt?: string };

/** Server owns the idle-compaction policy; this only asks whether an explicit turn is allowed. */
export async function readThreadCompaction(threadId: string): Promise<ThreadCompactionAvailability> {
  const value = await workspaceClient.json<unknown>(`/api/chat/threads/${encodeURIComponent(threadId)}/compaction`);
  if (!value || typeof value !== "object") throw new Error("compaction_state_invalid");
  const record = value as Record<string, unknown>;
  return {
    available: record.available === true,
    ...(typeof record.expiresAt === "string" ? { expiresAt: record.expiresAt } : {}),
  };
}

/** Runs one visible native compaction turn and waits for the server's completion receipt. */
export async function compactThread(threadId: string): Promise<ChatGenerationView> {
  const value = await workspaceClient.json<{ generation?: ChatGenerationView }>(`/api/chat/threads/${encodeURIComponent(threadId)}/compact`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!value?.generation) throw new Error("compaction_receipt_missing");
  return value.generation;
}
