import type { ExecutionEnvironment, ExecutionSelection } from '@agent-workspace/contracts/chat';

export function chatOnlyEnvironment(frozen = false): ExecutionEnvironment {
  return { version: 2, hostId: 'local', agentWorkspaceId: null, agentWorkspaceName: null, agentWorkspaceRevision: null, sourcePath: null, executionPath: null, worktree: null, frozen };
}

export const agentWorkspaceSelection: ExecutionSelection = { version: 2, agentWorkspaceId: 'test-agent-workspace', agentWorkspaceRevision: 1 };
export function agentWorkspaceEnvironment(directory: string, frozen = false): ExecutionEnvironment {
  return { version: 2, hostId: 'local', agentWorkspaceId: agentWorkspaceSelection.agentWorkspaceId, agentWorkspaceName: 'Selected directory', agentWorkspaceRevision: 1, sourcePath: directory, executionPath: directory, worktree: null, frozen };
}
