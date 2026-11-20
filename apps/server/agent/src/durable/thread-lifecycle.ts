import { createHash } from "node:crypto";
import { getDatabase, readRecord, transaction, writeRecord } from "./store.ts";
import { getThread, ThreadConflictError, deleteThread } from "./threads.ts";
import { inspectThreadRetention } from "./thread-retention.ts";
import type { ChatGenerationLifecycle } from "@agent-workspace/contracts/chat";
import type { ChatGeneration } from "./chat-runtime.ts";
import { assertNoChatWorktree } from "../chat-worktrees.ts";

const OPERATIONS = "chat:lifecycle-operations";
export type DeleteThreadInput = { lifecycleRevision: number; confirm: true; expectedGenerationId: string | null; stopActive: boolean };
export type ThreadLifecycleOperation = {
  operationId: string; threadId: string; fingerprint: string; state: "stopping" | "blocked" | "committed";
  lifecycleRevision: number; expectedGenerationId: string | null; createdAt: string; updatedAt: string;
  closingClaimed: boolean;
  reasons: string[]; retainedGenerationIds?: string[]; deleted?: true;
};
const operationKey = (threadId: string, operationId: string) => JSON.stringify([threadId, operationId]);
const liveDeletes = new Set<string>();

/** Select one original generation without reading PM calls, history or content authority. */
export function readChatGenerationLifecycle(threadId: string, generationId: string): ChatGenerationLifecycle {
  if (!getThread(threadId)) throw new ThreadConflictError("Session is unavailable.", "not_found");
  const generation = readRecord<ChatGeneration>("chat:generations", generationId);
  if (!generation || generation.id !== generationId || generation.threadId !== threadId)
    throw new ThreadConflictError("The original generation is not in this Session.", "not_found");
  return {
    id: generation.id,
    threadId: generation.threadId,
    messageId: generation.messageId,
    ...(generation.inputMessageId === undefined ? {} : { inputMessageId: generation.inputMessageId }),
    status: generation.status,
    createdAt: generation.createdAt,
    ...(generation.endedAt === undefined ? {} : { endedAt: generation.endedAt }),
  };
}
export function readThreadLifecycleOperation(threadId: string, operationId: string): ThreadLifecycleOperation | null {
  const operation = readRecord<ThreadLifecycleOperation>(OPERATIONS, operationKey(threadId, operationId));
  if (!operation) return null;
  return operation.state === "stopping" && !liveDeletes.has(operationKey(threadId, operationId))
    ? { ...operation, state: "blocked", reasons: ["deletion_interrupted_explicit_reconcile_required"] } : operation;
}
/** Stop/cancel happens only after this synchronous closing claim, never inside SQLite. */
export function beginThreadDeletion(threadId: string, operationId: string, input: DeleteThreadInput, activeGenerationId: string | null): ThreadLifecycleOperation {
  if (!operationId || operationId.length > 256) throw new ThreadConflictError("Deletion requires the original Idempotency-Key.", "operation_id_required");
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return transaction(() => {
    const key = operationKey(threadId, operationId), prior = readRecord<ThreadLifecycleOperation>(OPERATIONS, key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new ThreadConflictError("Deletion key belongs to a different request.", "idempotency_conflict");
      if (prior.state === "committed") return prior;
      assertNoChatWorktree(threadId);
      if (liveDeletes.has(key)) throw new ThreadConflictError("The original deletion is still stopping; query its receipt instead of dispatching again.", "deletion_in_progress");
      const thread = getThread(threadId);
      if (!thread || thread.deletionOperationId !== operationId) return prior;
      if (activeGenerationId !== null && activeGenerationId !== input.expectedGenerationId)
        throw new ThreadConflictError("Active generation changed; the old delete request cannot cancel a new generation.", "stale_generation");
      const resumed = { ...prior, state: "stopping" as const, reasons: [], updatedAt: new Date().toISOString() };
      writeRecord(OPERATIONS, key, resumed); liveDeletes.add(key); return resumed;
    }
    const thread = getThread(threadId);
    if (!thread) throw new ThreadConflictError("Session is unavailable; only the original deletion receipt can be queried.", "not_found");
    assertNoChatWorktree(threadId);
    if (thread.deletionState || (thread.lifecycleRevision ?? 0) !== input.lifecycleRevision)
      throw new ThreadConflictError("Session lifecycle changed; reload before deletion.", "lifecycle_conflict");
    if (activeGenerationId !== input.expectedGenerationId || activeGenerationId !== null && !input.stopActive)
      throw new ThreadConflictError("Confirm the exact active generation and explicitly permit stopping it.", "stale_generation");
    const retention = inspectThreadRetention(getDatabase(), threadId, true);
    const now = new Date().toISOString(), lifecycleRevision = (thread.lifecycleRevision ?? 0) + (retention.blockers.length ? 0 : 1);
    const operation: ThreadLifecycleOperation = { operationId, threadId, fingerprint, state: retention.blockers.length ? "blocked" : "stopping", lifecycleRevision,
      expectedGenerationId: input.expectedGenerationId, createdAt: now, updatedAt: now, reasons: retention.blockers, closingClaimed: !retention.blockers.length };
    if (retention.blockers.length) { writeRecord(OPERATIONS, key, operation); return operation; }
    writeRecord("chat:threads", threadId, { ...thread, lifecycleRevision, deletionState: "closing", deletionOperationId: operationId });
    writeRecord(OPERATIONS, key, operation); liveDeletes.add(key); return operation;
  });
}
export function blockThreadDeletion(threadId: string, operationId: string, reason: string): ThreadLifecycleOperation {
  return transaction(() => {
    const key = operationKey(threadId, operationId), operation = readRecord<ThreadLifecycleOperation>(OPERATIONS, key);
    if (!operation) throw new ThreadConflictError("Deletion operation is missing.", "lifecycle_conflict");
    if (operation.state === "committed") return operation;
    const blocked = { ...operation, state: "blocked" as const, reasons: [reason], updatedAt: new Date().toISOString() };
    writeRecord(OPERATIONS, key, blocked); liveDeletes.delete(key); return blocked;
  });
}
export function commitThreadDeletion(threadId: string, operationId: string): ThreadLifecycleOperation {
  return transaction(() => {
    const key = operationKey(threadId, operationId), operation = readRecord<ThreadLifecycleOperation>(OPERATIONS, key);
    if (!operation) throw new ThreadConflictError("Deletion operation is missing.", "lifecycle_conflict");
    if (operation.state === "committed") return operation;
    const thread = getThread(threadId);
    if (!thread || thread.deletionOperationId !== operationId || thread.deletionState !== "closing" || (thread.lifecycleRevision ?? 0) !== operation.lifecycleRevision)
      throw new ThreadConflictError("Deletion lifecycle ownership changed.", "lifecycle_conflict");
    assertNoChatWorktree(threadId);
    const retention = inspectThreadRetention(getDatabase(), threadId);
    if (retention.blockers.length) throw new ThreadConflictError(`Deletion is not safe: ${retention.blockers.join(", ")}`, "deletion_blocked");
    deleteThread(threadId, operationId);
    const committed: ThreadLifecycleOperation = { ...operation, state: "committed", deleted: true,
      lifecycleRevision: operation.lifecycleRevision + 1, reasons: [], retainedGenerationIds: retention.retainedGenerationIds, updatedAt: new Date().toISOString() };
    writeRecord(OPERATIONS, key, committed); liveDeletes.delete(key); return committed;
  });
}
