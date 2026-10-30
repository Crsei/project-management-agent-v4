import { z } from 'zod';
import { DomainError, type Entity } from '../../../../packages/domain/src/core.ts';
import { setProjectDependenciesSchema, updateTaskDurationSchema } from '../../../../packages/application/src/dashboard-planning.ts';
import { WorkspaceError } from '../../../../packages/pm-core/index.ts';
import type { FileRecord } from '../../../../packages/pm-schema/index.ts';
import { coreRecordToEntity, coreVersion, type CoreCommandContext } from './core-adapter.ts';

export function isDashboardPlanningCoreCommand(commandType: string): boolean {
  return commandType === 'SetProjectDependencies' || commandType === 'UpdateTaskDuration';
}

function authorizedRecord(context: CoreCommandContext, id: string | undefined, kind: 'project' | 'work_item'): FileRecord {
  if (!id) throw new DomainError('target_required', 'A target entity is required', 400);
  let record: FileRecord;
  try { record = context.workspace.get(id); }
  catch (error) {
    if (error instanceof WorkspaceError) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
    throw error;
  }
  if (!context.scope.allows(record) || record.entity.entity !== kind)
    throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
  const projectId = kind === 'project' ? record.id : record.entity.project;
  if (!projectId || !context.scope.allowsProject(projectId)) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
  context.affectProject?.(projectId);
  return record;
}

/** Called inside the shared core receipt/journal boundary; writes still CAS the exact file revision. */
export async function executeDashboardPlanningCoreCommand(context: CoreCommandContext, _idempotencyKey?: string): Promise<Entity> {
  if (!context.scope.membership.capabilities.includes('domain.read') || !context.scope.membership.capabilities.includes('planning.edit'))
    throw new DomainError('permission_denied', 'Capabilities domain.read and planning.edit are required', 403);
  const { command, workspace } = context;
  const projectCommand = command.commandType === 'SetProjectDependencies';
  if (!projectCommand && command.commandType !== 'UpdateTaskDuration') throw new DomainError('unknown_command', 'Unknown planning command', 400);
  const record = authorizedRecord(context, command.targetId, projectCommand ? 'project' : 'work_item');
  const projectId = projectCommand ? record.id : record.entity.project!;
  if (command.projectId && command.projectId !== projectId) throw new DomainError('project_mismatch', 'The command scope does not match its target', 409);
  if (record.entity.archived) throw new DomainError('object_archived', 'Restore the object before editing planning metadata', 409);
  let changes: Record<string, unknown>;
  try {
    if (projectCommand) {
      const payload = setProjectDependenciesSchema.parse(command.payload);
      for (const id of new Set([...(record.entity.depends_on ?? []), ...payload.dependsOn])) authorizedRecord(context, id, 'project');
      if (payload.dependsOn.includes(record.id)) throw new DomainError('self_dependency', 'A project cannot depend on itself', 409);
      changes = { depends_on: payload.dependsOn };
    } else changes = { estimated_duration_days: updateTaskDurationSchema.parse(command.payload).estimatedDurationDays };
  } catch (error) {
    if (error instanceof z.ZodError) throw new DomainError('validation_failed', 'Invalid planning payload', 400, error.flatten());
    throw error;
  }
  if (command.expectedVersions?.[record.id] !== coreVersion(record.revision))
    throw new DomainError('version_conflict', 'Aggregate version changed or expected version is missing', 409, { id: record.id, currentVersion: coreVersion(record.revision) });
  try {
    return coreRecordToEntity(context.scope.workspaceId, await workspace.patch(record.id, changes, record.revision, context.mutationGuard));
  } catch (error) {
    // Whole-workspace relation diagnostics can mention an inaccessible intermediate project.
    if (projectCommand && error instanceof WorkspaceError && error.diagnostics.some(item => item.field === 'depends_on'))
      throw new DomainError('invalid_project_dependencies', 'Project dependencies must be valid same-workspace project references without self, duplicate, or cyclic edges', 422);
    throw error;
  }
}
