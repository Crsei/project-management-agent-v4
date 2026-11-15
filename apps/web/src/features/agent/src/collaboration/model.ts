import type { CollaborationRun, RunDefinition, RunResultReference } from "@agent-workspace/contracts/collaboration";

/** Queued work may have no generation; running stops still carry the exact observed generation. */
export function runCancellationTarget(run: Pick<CollaborationRun, "status" | "cancellation" | "revision" | "generationId">) {
  return ["queued", "running", "waiting"].includes(run.status) && !run.cancellation ? { revision: run.revision, generationId: run.generationId } : null;
}
export function issueWorkThreadHref(target: Pick<CollaborationRun["target"], "workspaceId" | "projectId" | "taskId">) {
  return `/pm/${encodeURIComponent(target.workspaceId)}/projects/${encodeURIComponent(target.projectId)}/entities/${encodeURIComponent(target.taskId)}#task-discussion-${encodeURIComponent(target.taskId)}`;
}
export function definitionAssignedToProject(definition: { state: string; config: { allowedProjectIds: string[] } }, projectId: string) {
  return definition.state === "active" && !!projectId && definition.config.allowedProjectIds.includes(projectId);
}
export function runMatchesFilters(run: CollaborationRun, filters: { query: string; status: string; definitionId: string }) {
  const definitionId = run.definition.kind === "agent" ? run.definition.agentId : run.definition.teamId;
  if (filters.status && run.status !== filters.status || filters.definitionId && definitionId !== filters.definitionId) return false;
  const query = filters.query.trim().toLocaleLowerCase();
  return !query || `${run.id} ${run.goal} ${run.target.taskId} ${run.agentVersions.map(version => version.config.name).join(" ")} ${run.teamVersion?.config.name ?? ""}`.toLocaleLowerCase().includes(query);
}
export function frozenRunDefinition(kind: "agent" | "team", id: string, version: number): RunDefinition {
  return kind === "agent" ? { kind, agentId: id, agentVersion: version } : { kind, teamId: id, teamVersion: version };
}

/** Only a retained, verified directory snapshot can advertise an original Session terminal. */
export function runTerminalWorkspaceId(run: Pick<CollaborationRun, "threadId" | "directoryIdentity" | "executionSelection" | "executionEnvironment">): string | null {
  const { directoryIdentity, executionEnvironment, executionSelection } = run;
  if (!run.threadId || !directoryIdentity?.path || !directoryIdentity.device || !directoryIdentity.inode ||
      !executionSelection.agentWorkspaceId || !executionSelection.agentWorkspaceRevision ||
      !executionEnvironment || executionEnvironment.agentWorkspaceId !== executionSelection.agentWorkspaceId ||
      executionEnvironment.agentWorkspaceRevision !== executionSelection.agentWorkspaceRevision ||
      executionEnvironment.executionPath !== directoryIdentity.path) return null;
  return executionSelection.agentWorkspaceId;
}

export type RunOutputReference = Pick<RunResultReference, "generationId" | "threadId">;
/** The current root generation stays first even when sequential child results were appended later. */
export function runOutputReferences(run: Pick<CollaborationRun, "generationId" | "threadId" | "resultRefs">): ReadonlyArray<RunOutputReference> {
  if (!run.generationId || !run.threadId) return run.resultRefs;
  const current = { generationId: run.generationId, threadId: run.threadId };
  return [current, ...run.resultRefs.filter(result => result.generationId !== current.generationId)];
}
/** A missing explicit selection must not silently display a different execution's output. */
export function selectedRunOutputReference(references: ReadonlyArray<RunOutputReference>, generationId: string): RunOutputReference | undefined {
  return generationId ? references.find(reference => reference.generationId === generationId) : references[0];
}
