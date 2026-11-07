import type { ExecutionSelection, ExecutionEnvironment } from "@agent-workspace/contracts/chat";
import { resolveAgentWorkspaceExecution } from "../agent-workspaces.ts";

/** Server-resolved directory authority. PM business targets and credentials are request-local, never directory owners. */
export type AgentExecutionSnapshot = {
  path: string;
  environment: ExecutionEnvironment;
  /** Only a verified server-owned delivery receipt may supply this grant. */
  worktreeWriteConfirmed?: boolean;
};

/** Display names and the freeze bit are not directory identity. Missing evidence is never compatible. */
export function sameExecutionIdentity(a: ExecutionEnvironment | undefined, b: ExecutionEnvironment | undefined): boolean {
  return Boolean(a && b && a.version === b.version && a.hostId === b.hostId &&
    a.agentWorkspaceId === b.agentWorkspaceId && a.agentWorkspaceRevision === b.agentWorkspaceRevision &&
    a.sourcePath === b.sourcePath && a.executionPath === b.executionPath &&
    Boolean(a.worktree) === Boolean(b.worktree) && a.worktree?.deliveryId === b.worktree?.deliveryId && a.worktree?.branch === b.worktree?.branch);
}

export async function resolveAgentExecution(selection: ExecutionSelection, sessionId?: string, signal?: AbortSignal): Promise<AgentExecutionSnapshot> {
  signal?.throwIfAborted();
  const snapshot = await resolveAgentWorkspaceExecution(selection, sessionId);
  signal?.throwIfAborted();
  return snapshot;
}

export function agentExecutionIdentity(snapshot: AgentExecutionSnapshot): string {
  const environment = snapshot.environment;
  return `当前 Agent 执行目录身份（不授予额外权限）：${JSON.stringify({
    agentWorkspaceId: environment.agentWorkspaceId,
    agentWorkspaceName: environment.agentWorkspaceName,
    agentWorkspaceRevision: environment.agentWorkspaceRevision,
    worktree: environment.worktree,
  })}`;
}
