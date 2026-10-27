import { dashboardSprintsPayloadSchemas } from '../../../packages/application/src/dashboard-sprints.ts';
import { DomainError } from '../../../packages/domain/src/core.ts';
import { sprintRecordVersion, type SprintSummary } from '../../../packages/domain/src/dashboard-sprints.ts';
import { statusCategory, workflowFor, type FileRecord } from '../../../packages/pm-schema/index.ts';
import type { CoreCommandContext } from './core-adapter.ts';

export function isDashboardSprintsCoreCommand(commandType: string): commandType is keyof typeof dashboardSprintsPayloadSchemas {
  return Object.hasOwn(dashboardSprintsPayloadSchemas, commandType);
}

function recordFor(context: CoreCommandContext, id: string, kind: 'cycle' | 'work_item' | 'project'): FileRecord {
  const record = context.workspace.get(id);
  context.scope.entity(record);
  if (record.entity.entity !== kind) throw new DomainError('validation_failed', `Expected ${kind}`, 400);
  if (context.command.projectId && context.command.projectId !== (kind === 'project' ? id : record.entity.project)) throw new DomainError('project_mismatch', 'Command project does not match the native object', 409);
  const projectId = kind === 'project' ? id : record.entity.project;
  if (projectId) context.affectProject?.(projectId);
  return record;
}

function writableProject(context: CoreCommandContext, record: FileRecord): void {
  const id = record.entity.entity === 'project' ? record.id : record.entity.project;
  if (!id) {
    if (!context.scope.unrestricted) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
    return;
  }
  const project = recordFor(context, id, 'project');
  if (project.entity.archived) throw new DomainError('project_archived', 'Project is archived', 409);
}

function checkTarget(context: CoreCommandContext, id: string, kind: 'cycle' | 'work_item'): FileRecord {
  if (context.command.targetId !== id) throw new DomainError('invalid_scope', 'The payload and command target must identify the same object', 409);
  const record = recordFor(context, id, kind);
  const currentVersion = sprintRecordVersion(record.revision);
  if (context.command.expectedVersions?.[id] !== currentVersion) throw new DomainError('version_conflict', 'Aggregate version changed or expected version is missing', 409, { id, currentVersion });
  writableProject(context, record);
  return record;
}

function summary(context: CoreCommandContext, record: FileRecord): SprintSummary {
  const configuration = context.workspace.configuration().config;
  const tasks = context.workspace.items({ entity: 'work_item', archived: 'exclude' }).filter(task => task.entity.cycle === record.id && context.scope.allows(task) && !task.stale);
  const completed = tasks.filter(task => statusCategory(task.entity, configuration) === 'completed').length;
  return {
    id: record.id, projectId: record.entity.project ?? null, title: record.entity.title, status: record.entity.status ?? null,
    category: statusCategory(record.entity, configuration) ?? null, startDate: record.entity.start ?? null, dueDate: record.entity.due ?? null,
    archived: record.entity.archived === true, version: sprintRecordVersion(record.revision), revision: record.revision,
    readOnly: !!record.stale, taskIds: tasks.map(task => task.id), total: tasks.length, completed, remaining: tasks.length - completed,
  };
}

/** Native one-file mutations only: no SQL cycle mirror and no pretend atomic task batch. */
export async function executeDashboardSprintsCoreCommand(context: CoreCommandContext, idempotencyKey?: string): Promise<unknown> {
  const { command, workspace, scope } = context;
  if (!isDashboardSprintsCoreCommand(command.commandType)) throw new DomainError('unknown_command', 'Unknown sprint command', 400);
  const parsed = dashboardSprintsPayloadSchemas[command.commandType].safeParse(command.payload ?? {});
  if (!parsed.success) throw new DomainError('validation_failed', 'Invalid sprint payload', 400, parsed.error.flatten());
  const payload: Record<string, unknown> = parsed.data;
  const capability = command.commandType === 'CreateSprint' || command.commandType === 'UpdateSprint' || command.commandType === 'SetTaskSprint' ? 'planning.edit' : 'planning.lifecycle';
  if (!scope.membership.capabilities.includes(capability)) throw new DomainError('permission_denied', `Capability ${capability} is required`, 403);
  await workspace.rescan('refresh');
  if (command.commandType === 'CreateSprint') {
    const projectId = payload.projectId as string;
    if (command.targetId || command.projectId !== projectId) throw new DomainError('invalid_scope', 'Sprint creation requires its exact project scope and no target', 409);
    const project = recordFor(context, projectId, 'project');
    writableProject(context, project);
    const input: Record<string, unknown> = { entity: 'cycle', project: projectId, title: payload.title, 'x-pm-created-by': context.principal.id };
    if (payload.startDate !== undefined && payload.startDate !== null) input.start = payload.startDate;
    if (payload.dueDate !== undefined && payload.dueDate !== null) input.due = payload.dueDate;
    return summary(context, await workspace.createEntity(input, idempotencyKey ?? command.commandId));
  }
  if (command.commandType === 'SetTaskSprint') {
    const task = checkTarget(context, payload.workItemId as string, 'work_item');
    if (task.entity.archived) throw new DomainError('object_archived', 'Task is archived', 409);
    if (typeof task.entity.cycle === 'string') recordFor(context, task.entity.cycle, 'cycle');
    if (typeof payload.sprintId === 'string') {
      const sprint = recordFor(context, payload.sprintId, 'cycle');
      if (sprint.entity.project !== task.entity.project) throw new DomainError('project_mismatch', 'Task and sprint must belong to the same project', 409);
      if (sprint.entity.archived) throw new DomainError('object_archived', 'Sprint is archived', 409);
    }
    const updated = await workspace.patch(task.id, { cycle: payload.sprintId }, task.revision, context.mutationGuard);
    return { id: updated.id, projectId: updated.entity.project ?? null, version: sprintRecordVersion(updated.revision), sprintId: updated.entity.cycle ?? null };
  }
  const sprint = checkTarget(context, payload.sprintId as string, 'cycle');
  if (sprint.entity.archived && command.commandType !== 'RestoreSprint') throw new DomainError('object_archived', 'Restore the sprint before changing it', 409);
  const changes: Record<string, unknown> = {};
  if (command.commandType === 'UpdateSprint') {
    if (payload.title !== undefined) changes.title = payload.title;
    if (payload.startDate !== undefined) changes.start = payload.startDate;
    if (payload.dueDate !== undefined) changes.due = payload.dueDate;
  } else if (command.commandType === 'ArchiveSprint' || command.commandType === 'RestoreSprint') {
    changes.archived = command.commandType === 'ArchiveSprint';
  } else {
    const configuration = workspace.configuration().config;
    const workflow = workflowFor('cycle', configuration);
    const currentCategory = statusCategory(sprint.entity, configuration);
    const desired = command.commandType === 'StartSprint' ? 'started' : command.commandType === 'CompleteSprint' ? 'completed' : command.commandType === 'CancelSprint' ? 'canceled' : 'unstarted';
    const allowedFrom = command.commandType === 'ReopenSprint' ? ['completed', 'canceled'] : command.commandType === 'CompleteSprint' ? ['started'] : command.commandType === 'StartSprint' ? ['unstarted', 'backlog'] : ['unstarted', 'backlog', 'started'];
    if (!currentCategory || !allowedFrom.includes(currentCategory)) throw new DomainError('invalid_transition', 'Sprint lifecycle transition is not allowed from this state', 409);
    const candidates = workflow?.states.filter(state => state.category === desired && workflow.transitions.some(transition => transition.from === sprint.entity.status && transition.to === state.id)) ?? [];
    if (candidates.length !== 1) throw new DomainError('invalid_transition', 'The configured cycle workflow must expose one allowed destination for this lifecycle action', 409);
    changes.status = candidates[0]!.id;
  }
  return summary(context, await workspace.patch(sprint.id, changes, sprint.revision));
}
