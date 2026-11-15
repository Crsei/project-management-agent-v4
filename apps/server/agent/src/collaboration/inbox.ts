import { collaborationInboxItemSchema, type CollaborationInboxItem, type CollaborationRun } from "@agent-workspace/contracts/collaboration";
import { listThreads } from "../durable/threads.ts";
import { listChatGenerations } from "../durable/chat-runtime.ts";
import { getNativeOutput, isNativeInteractionRespondable } from "../durable/native-output.ts";
import { authorizePmTarget } from "../durable/pm-context.ts";
import { createPmVisibilityProjector } from "../pm-visibility.ts";
import { listPendingPmApprovals } from "../pm-tools.ts";
import { getCollaborationGenerationContext, listCollaborationRunsForInbox } from "./runs.ts";
import { capabilityFingerprint } from "./capabilities.ts";

export type CollaborationInboxQuery = { workspaceId: string; projectId?: string | undefined; taskId?: string | undefined; runId?: string | undefined };
function matchesRun(run: CollaborationRun, query: CollaborationInboxQuery): boolean {
  return run.target.workspaceId === query.workspaceId && (!query.projectId || run.target.projectId === query.projectId) &&
    (!query.taskId || run.target.taskId === query.taskId) && (!query.runId || run.id === query.runId);
}
async function visibleRun(run: CollaborationRun, headers: Headers): Promise<boolean> {
  try {
    await authorizePmTarget({ workspaceId: run.target.workspaceId, projectId: run.target.projectId }, headers);
    for (const source of run.taskBrief?.sources ?? []) await authorizePmTarget({ workspaceId: source.workspaceId, projectId: source.projectId }, headers);
    return true;
  } catch { return false; }
}

/** Aggregation has no write/claim/approve method; every decision remains with its original owner. */
export async function listCollaborationInbox(query: CollaborationInboxQuery, headers: Headers): Promise<CollaborationInboxItem[]> {
  await authorizePmTarget({ workspaceId: query.workspaceId, projectId: query.projectId ?? null }, headers);
  const items: CollaborationInboxItem[] = [];
  const runs = listCollaborationRunsForInbox();
  const visibleRuns = new Map<string, CollaborationRun>();
  for (const run of runs) if (matchesRun(run, query) && await visibleRun(run, headers)) visibleRuns.set(run.id, run);
  for (const thread of listThreads()) {
    const generations = listChatGenerations(thread.remoteId).filter(generation => generation.status === "running");
    if (!generations.some(generation => getNativeOutput(generation.id)?.items.some(item => item.status === "waiting" && item.request?.kind === "user_input" && isNativeInteractionRespondable(generation.id, item.request.id)))) continue;
    const projector = await createPmVisibilityProjector(thread.remoteId, headers);
    for (const generation of generations) {
      const context = getCollaborationGenerationContext(generation.id);
      if (context && !visibleRuns.has(context.runId) || query.runId && context?.runId !== query.runId) continue;
      if (!context) {
        const targets = [...(generation.pmOperations ?? []).map(operation => operation.target), ...projector.provenance.targets];
        if (targets.length && !targets.some(target => target.workspaceId === query.workspaceId && (!query.projectId || target.projectId === query.projectId))) continue;
        if (query.taskId || query.projectId && !targets.length) continue;
      }
      const snapshot = getNativeOutput(generation.id);
      if (!snapshot) continue;
      for (const item of projector.nativeSnapshot(snapshot).items) {
        const request = item.request;
        if (item.status !== "waiting" || request?.kind !== "user_input" || !request.respondable || !isNativeInteractionRespondable(generation.id, request.id)) continue;
        items.push(collaborationInboxItemSchema.parse({
          id: `native:${capabilityFingerprint([generation.id, request.id])}`, kind: "native_input", runId: context?.runId ?? null,
          createdAt: generation.createdAt, respondable: true, unavailableReason: null,
          href: `/agent/workspace?${new URLSearchParams({ thread: thread.remoteId })}`,
          threadId: thread.remoteId, generationId: generation.id, requestId: request.id, request,
        }));
      }
    }
  }
  for (const pending of await listPendingPmApprovals({ workspaceId: query.workspaceId, ...(query.projectId ? { projectId: query.projectId } : {}), headers })) {
    const context = getCollaborationGenerationContext(pending.call.generationId);
    if (context && !visibleRuns.has(context.runId) || query.runId && context?.runId !== query.runId) continue;
    if (query.taskId && (!context || context.target.taskId !== query.taskId)) continue;
    items.push(collaborationInboxItemSchema.parse({
      id: `pm:${pending.call.operationId}`, kind: "pm_approval", runId: context?.runId ?? null,
      createdAt: pending.call.createdAt, respondable: pending.respondable, unavailableReason: pending.unavailableReason,
      href: pending.call.threadId ? `/agent/workspace?${new URLSearchParams({ thread: pending.call.threadId })}` : `/agent/runs?${new URLSearchParams({ workspaceId: query.workspaceId, ...(context ? { runId: context.runId } : {}) })}`,
      operationId: pending.call.operationId, call: pending.call, capabilityFingerprint: pending.capabilityFingerprint, decisionFingerprint: pending.decisionFingerprint,
    }));
  }
  for (const run of visibleRuns.values()) {
    if (!run.wait || !["queued", "running", "waiting"].includes(run.status) || ["native_input", "pm_approval"].includes(run.wait.kind)) continue;
    items.push(collaborationInboxItemSchema.parse({
      id: `wait:${capabilityFingerprint([run.id, run.wait.kind])}`, kind: "resource_wait", runId: run.id, createdAt: run.wait.since,
      respondable: false, unavailableReason: "This is an execution-owned resource wait, not an approval. Inspect or stop the exact Run through its original controls.",
      href: `/agent/runs?${new URLSearchParams({ workspaceId: run.target.workspaceId, runId: run.id })}`, wait: run.wait,
    }));
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
