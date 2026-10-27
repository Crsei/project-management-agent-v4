import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import { sprintRecordVersion, type SprintsDashboard, type SprintSummary } from '../../domain/src/dashboard-sprints.ts';
import { statusCategory, type FileRecord } from '../../pm-schema/index.ts';
import type { SprintHistoryCycle } from '../../pm-core/sprint-history.ts';
import type { CommandRegistry } from './ports.ts';
import type { DashboardReadContext } from './dashboard-read.ts';

const identifier = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
const date = z.iso.date().nullable().optional();
const target = z.strictObject({ sprintId: identifier });
export const dashboardSprintsPayloadSchemas = {
  CreateSprint: z.strictObject({ projectId: identifier, title: z.string().trim().min(1).max(300), startDate: date, dueDate: date }),
  UpdateSprint: z.strictObject({ sprintId: identifier, title: z.string().trim().min(1).max(300).optional(), startDate: date, dueDate: date }).refine(value => value.title !== undefined || value.startDate !== undefined || value.dueDate !== undefined, 'At least one sprint field is required'),
  StartSprint: target, CompleteSprint: target, CancelSprint: target, ReopenSprint: target, ArchiveSprint: target, RestoreSprint: target,
  SetTaskSprint: z.strictObject({ workItemId: identifier, sprintId: identifier.nullable() }),
};

// Native commands are dispatched inside the core journal/CAS boundary, never to SQL aggregates.
export const dashboardSprintsCommands: CommandRegistry = Object.fromEntries(Object.entries(dashboardSprintsPayloadSchemas).map(([name, payload]) => [name, {
  payload,
  async handler() { throw new DomainError('core_command_required', 'Sprint commands require the authoritative Markdown core', 503); },
}]));

function counts(cycle: SprintHistoryCycle) {
  const tasks = cycle.tasks.filter(task => !task.archived);
  const completed = tasks.filter(task => task.category === 'completed').length;
  return { taskIds: tasks.map(task => task.id), total: tasks.length, completed, remaining: tasks.length - completed };
}

/** The core port scope-checks historical and current project ownership together.
 * Deleted authorized members keep their original observations; hidden moved objects do not. */
export async function readSprintsDashboard(ctx: DashboardReadContext): Promise<SprintsDashboard> {
  if (!ctx.membership.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
  const records = await ctx.core.records();
  const allowedProject = (projectId: string | null) => ctx.membership.projectIds === null || projectId !== null && ctx.membership.projectIds.includes(projectId);
  const visible = records.filter(file => allowedProject(file.entity.entity === 'project' ? file.id : file.entity.project ?? null));
  const cycles = visible.filter(file => file.entity.entity === 'cycle');
  const taskRecords = visible.filter(file => file.entity.entity === 'work_item');
  const configuration = ctx.core.configuration();
  const history = await ctx.core.sprintHistory();
  const readonly = (record: FileRecord) => !!record.stale || !!record.diagnostics?.some(issue => issue.severity === 'error');
  const sprints: SprintSummary[] = cycles.map(file => {
    const memberTasks = taskRecords.filter(task => task.entity.cycle === file.id && !task.entity.archived && !readonly(task));
    const completed = memberTasks.filter(task => statusCategory(task.entity, configuration) === 'completed').length;
    return {
      id: file.id, projectId: file.entity.project ?? null, title: file.entity.title, status: file.entity.status ?? null,
      category: statusCategory(file.entity, configuration) ?? null,
      startDate: file.entity.start ?? null, dueDate: file.entity.due ?? null, archived: file.entity.archived === true,
      version: sprintRecordVersion(file.revision), revision: file.revision, readOnly: readonly(file),
      taskIds: memberTasks.map(task => task.id), total: memberTasks.length, completed, remaining: memberTasks.length - completed,
    };
  });
  return {
    sprints,
    tasks: taskRecords.map(file => ({ id: file.id, projectId: file.entity.project ?? null, title: file.entity.title, status: file.entity.status ?? null, sprintId: file.entity.cycle ?? null, archived: file.entity.archived === true, version: sprintRecordVersion(file.revision), readOnly: readonly(file) })),
    currentSprintIds: sprints.filter(sprint => sprint.category === 'started' && !sprint.archived && !sprint.readOnly).map(sprint => sprint.id),
    history: {
      status: history.status, error: history.status === 'error' ? 'Sprint history is unavailable or incomplete. Repair the durable sprint-history state before trusting trends.' : null, semantics: history.semantics,
      observations: history.observations.map(observation => ({
        sequence: observation.sequence, observedAt: observation.observedAt, previousObservedAt: observation.previousObservedAt,
        source: observation.source, reason: observation.reason, gap: observation.gap, complete: observation.complete,
        sprints: observation.cycles.filter(cycle => allowedProject(cycle.projectId)).map(cycle => ({
          id: cycle.id, projectId: cycle.projectId, title: cycle.title, status: cycle.status, startDate: cycle.startDate, dueDate: cycle.dueDate, archived: cycle.archived, ...counts(cycle),
        })),
      })).filter(observation => observation.sprints.length > 0 || !observation.complete),
    },
  };
}
