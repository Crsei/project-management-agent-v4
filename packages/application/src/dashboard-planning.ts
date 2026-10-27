import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import { analyzeCriticalPath, type PlanningDashboard } from '../../domain/src/dashboard-planning.ts';
import type { FileRecord } from '../../pm-schema/index.ts';
import type { CommandRegistry } from './ports.ts';
import { requireDashboardReadSelf, type DashboardReadContext } from './dashboard-read.ts';

const identifier = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Expected a valid calendar date');
export const setProjectDependenciesSchema = z.strictObject({
  dependsOn: z.array(identifier).refine(values => new Set(values).size === values.length, 'Duplicate project dependency'),
});
export const updateTaskDurationSchema = z.strictObject({ estimatedDurationDays: z.number().finite().nonnegative().nullable() });
/** Omission preserves metadata; null clears only the date. No implicit body/criteria replacement. */
export const updateMilestoneSchema = z.strictObject({
  name: z.string().trim().min(1).max(300).optional(),
  targetDate: date.nullable().optional(),
  criteria: z.array(z.string().trim().min(1).max(16000)).max(100).optional(),
}).refine(value => Object.keys(value).length > 0, 'At least one milestone field is required');

async function nativeOnly(): Promise<never> {
  throw new DomainError('core_command_required', 'Planning changes must execute against the authoritative Markdown core', 409);
}
export const dashboardPlanningCommands: CommandRegistry = {
  SetProjectDependencies: { payload: setProjectDependenciesSchema, handler: nativeOnly },
  UpdateTaskDuration: { payload: updateTaskDurationSchema, handler: nativeOnly },
  UpdateMilestone: { payload: updateMilestoneSchema, handler: nativeOnly },
};

function invalid(file: FileRecord): boolean {
  return !!file.stale || !!file.error || !!file.diagnostics?.some(item => item.severity === 'error');
}

export async function readPlanningDashboard(ctx: DashboardReadContext): Promise<PlanningDashboard> {
  const membership = await requireDashboardReadSelf(ctx);
  const inScope = (file: FileRecord) => membership.projectIds === null
    || membership.projectIds.includes(file.entity.entity === 'project' ? file.id : file.entity.project ?? '');
  const records = (await ctx.core.records()).filter(inScope);
  const projects = records.filter(file => file.entity.entity === 'project');
  const projectIds = new Set(projects.filter(file => !invalid(file)).map(file => file.id));
  const entities = await Promise.all(records.filter(file => ['project', 'work_item', 'milestone'].includes(file.entity.entity)).map(async file => {
    // get() uses the same scoped authoritative mapping and supplies its public CAS version.
    const entity = await ctx.core.get(file.id);
    return [file.id, entity] as const;
  }));
  const byId = new Map(entities);
  const editable = (file: FileRecord) => membership.capabilities.includes('planning.edit') && !invalid(file) && file.entity.archived !== true;
  return {
    projects: projects.map(file => {
      const dependencies = file.entity.depends_on ?? [];
      return { id: file.id, title: file.entity.title, version: byId.get(file.id)!.version,
        dependsOn: dependencies.filter(id => projectIds.has(id)), hasUnavailableDependencies: dependencies.some(id => !projectIds.has(id)),
        editable: editable(file), criticalPath: analyzeCriticalPath(file.id, records) };
    }),
    tasks: records.filter(file => file.entity.entity === 'work_item' && !!file.entity.project && projectIds.has(file.entity.project)).map(file => ({
      id: file.id, projectId: file.entity.project!, title: file.entity.title, version: byId.get(file.id)!.version,
      estimatedDurationDays: file.entity.estimated_duration_days ?? null, editable: editable(file),
    })),
    milestones: records.filter(file => file.entity.entity === 'milestone' && !!file.entity.project && projectIds.has(file.entity.project)).map(file => ({
      id: file.id, projectId: file.entity.project!, title: file.entity.title, version: byId.get(file.id)!.version,
      targetDate: file.entity.due ?? null, editable: editable(file),
    })),
  };
}
