import type { AgentChatScope, Entity, Workspace } from '../../../../../../packages/contracts/src/client.ts';

export type AgentTaskSelectionState = {
  tasks: Entity[];
  selected: Entity | null;
  blocked: boolean;
  pending: boolean;
  error: Error | null;
};

export type AgentTaskSelectionInput = {
  taskId: string | null;
  scope: AgentChatScope | null;
  workspace: Workspace | null;
  tasks: readonly Entity[] | undefined;
  projects: readonly Entity[] | undefined;
  pending: boolean;
  error: Error | null;
};

/** Intersect authoritative active records, native membership, and the conversation's explicit project set. */
export function resolveAgentTaskSelection({ taskId, scope, workspace, tasks, projects, pending, error }: AgentTaskSelectionInput): AgentTaskSelectionState {
  let choices: Entity[] = [];
  if (!pending && !error && workspace?.capabilities.includes('domain.read') && scope && tasks && projects) {
    // Workspace scopes also contain a frozen project set. An empty set is not permission to widen it.
    const scopedIds = new Set(scope.projectIds);
    const nativeIds = workspace.projectIds === null ? null : new Set(workspace.projectIds);
    const projectIds = new Set(projects
      .filter(project => project.kind === 'project' && project.workspaceId === workspace.id && project.data.archived !== true && !project.data.archivedAt && scopedIds.has(project.id) && (nativeIds === null || nativeIds.has(project.id)))
      .map(project => project.id));
    choices = tasks.filter(task => task.kind === 'work_item' && task.workspaceId === workspace.id && task.data.archived !== true && !task.data.archivedAt && task.projectId !== null && projectIds.has(task.projectId));
  }
  const selected = taskId === null ? null : choices.find(task => task.id === taskId) ?? null;
  return { tasks: choices, selected, blocked: taskId !== null && selected === null, pending, error };
}

/** Persist only a visible per-message target hint; selected entity contents are never copied into chat. */
export function agentTaskMessage(content: string, task: Entity | null): string {
  if (task === null) return content;
  const target = JSON.stringify({ taskId: task.id, projectId: task.projectId });
  return `${content}\n\n[Task context: ${target}]`;
}
