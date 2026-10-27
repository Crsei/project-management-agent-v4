import type { FileRecord } from '../../pm-schema/index.ts';

export type PlanningUnavailableCode = 'project_unavailable' | 'no_tasks' | 'invalid_source' | 'missing_duration' | 'invalid_duration' | 'dependency_unavailable' | 'dependency_cycle' | 'duration_overflow';
export interface PlanningUnavailableReason { code: PlanningUnavailableCode; taskId?: string; message: string }
export interface CriticalPathTask {
  id: string; title: string; projectId: string; estimatedDurationDays: number;
  earlyStart: number; earlyFinish: number; lateStart: number; lateFinish: number;
  totalFloat: number; freeFloat: number; critical: boolean;
}
export type CriticalPathAnalysis = {
  status: 'available'; durationDays: number; tasks: CriticalPathTask[]; criticalPaths: string[][];
  model: 'continuous_calendar_days_finish_to_start_zero_lag';
} | { status: 'unavailable'; reasons: PlanningUnavailableReason[] };
export interface PlanningProject {
  id: string; title: string; version: number; dependsOn: string[]; hasUnavailableDependencies: boolean;
  editable: boolean; criticalPath: CriticalPathAnalysis;
}
export interface PlanningTask { id: string; projectId: string; title: string; version: number; estimatedDurationDays: number | null; editable: boolean }
export interface PlanningMilestone { id: string; projectId: string; title: string; version: number; targetDate: string | null; editable: boolean }
export interface PlanningDashboard {
  projects: PlanningProject[]; tasks: PlanningTask[]; milestones: PlanningMilestone[];
}

function invalid(file: FileRecord): boolean {
  return !!file.stale || !!file.error || !!file.diagnostics?.some(item => item.severity === 'error');
}

/** Analyze the complete project's task DAG, including visible transitive cross-project blockers.
 * Dates and workflow status are not duration estimates or scheduling constraints. No lifecycle writes occur.
 * Unavailable references never expose the identity of an inaccessible dependency.
 */
export function analyzeCriticalPath(projectId: string, files: readonly FileRecord[]): CriticalPathAnalysis {
  const index = new Map<string, FileRecord>();
  const duplicates = new Set<string>();
  for (const file of files) {
    if (index.has(file.id)) duplicates.add(file.id);
    index.set(file.id, file);
  }
  const project = index.get(projectId);
  if (!project || project.entity.entity !== 'project' || invalid(project) || duplicates.has(projectId))
    return { status: 'unavailable', reasons: [{ code: 'project_unavailable', message: 'The project source is unavailable or invalid.' }] };
  const roots = files.filter(file => file.entity.entity === 'work_item' && file.entity.project === projectId);
  if (!roots.length) return { status: 'unavailable', reasons: [{ code: 'no_tasks', message: 'No task inputs are available for this project.' }] };
  const reasons: PlanningUnavailableReason[] = [];
  const nodes = new Map<string, FileRecord>();
  const pending = [...roots];
  while (pending.length) {
    const file = pending.pop()!;
    if (nodes.has(file.id)) continue;
    nodes.set(file.id, file);
    const unavailableProject = !file.entity.project || !index.has(file.entity.project)
      || index.get(file.entity.project)!.entity.entity !== 'project' || invalid(index.get(file.entity.project)!) || duplicates.has(file.entity.project);
    if (invalid(file) || duplicates.has(file.id) || unavailableProject)
      reasons.push({ code: 'invalid_source', taskId: file.id, message: 'The task or its project source is unavailable or invalid.' });
    const duration = file.entity.estimated_duration_days;
    if (duration === undefined) reasons.push({ code: 'missing_duration', taskId: file.id, message: 'An explicit estimated duration in calendar days is required.' });
    else if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)
      reasons.push({ code: 'invalid_duration', taskId: file.id, message: 'Estimated duration must be a finite nonnegative number of calendar days.' });
    for (const id of file.entity.blocked_by) {
      const dependency = index.get(id);
      if (!dependency || dependency.entity.entity !== 'work_item' || duplicates.has(id)) {
        reasons.push({ code: 'dependency_unavailable', taskId: file.id, message: 'A prerequisite is missing, deleted, invalid, or not visible in the current scope.' });
      } else pending.push(dependency);
    }
  }
  if (reasons.length) return { status: 'unavailable', reasons };
  const successors = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const [id, file] of nodes) {
    const dependencies = new Set(file.entity.blocked_by);
    remaining.set(id, dependencies.size);
    for (const prerequisite of dependencies) {
      const values = successors.get(prerequisite) ?? [];
      values.push(id);
      successors.set(prerequisite, values);
    }
  }
  const ready = [...nodes.keys()].filter(id => remaining.get(id) === 0).sort();
  const order: string[] = [];
  const starts = new Map<string, number>();
  const finishes = new Map<string, number>();
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const id = ready[cursor]!;
    const file = nodes.get(id)!;
    let start = 0;
    for (const dependency of file.entity.blocked_by) start = Math.max(start, finishes.get(dependency)!);
    const finish = start + file.entity.estimated_duration_days!;
    if (!Number.isFinite(finish)) return { status: 'unavailable', reasons: [{ code: 'duration_overflow', message: 'The duration sum exceeds the supported finite numeric range.' }] };
    starts.set(id, start);
    finishes.set(id, finish);
    order.push(id);
    for (const next of successors.get(id) ?? []) {
      const count = remaining.get(next)! - 1;
      remaining.set(next, count);
      if (count === 0) ready.push(next);
    }
  }
  if (order.length !== nodes.size) return { status: 'unavailable', reasons: [{ code: 'dependency_cycle', message: 'Task prerequisites contain a directed cycle.' }] };
  let durationDays = 0;
  for (const finish of finishes.values()) durationDays = Math.max(durationDays, finish);
  const lateStarts = new Map<string, number>();
  const lateFinishes = new Map<string, number>();
  for (let cursor = order.length - 1; cursor >= 0; cursor--) {
    const id = order[cursor]!;
    const next = successors.get(id) ?? [];
    let finish = durationDays;
    for (const successor of next) finish = Math.min(finish, lateStarts.get(successor)!);
    lateFinishes.set(id, finish);
    lateStarts.set(id, finish - nodes.get(id)!.entity.estimated_duration_days!);
  }
  const tolerance = Number.EPSILON * Math.max(1, durationDays) * Math.max(1, nodes.size) * 4;
  const normalizedFloat = (value: number) => Math.abs(value) <= tolerance ? 0 : value;
  const tasks = order.map((id): CriticalPathTask => {
    const entity = nodes.get(id)!.entity;
    let nextStart = durationDays;
    for (const successor of successors.get(id) ?? []) nextStart = Math.min(nextStart, starts.get(successor)!);
    const totalFloat = normalizedFloat(lateStarts.get(id)! - starts.get(id)!);
    return { id, title: entity.title, projectId: entity.project!, estimatedDurationDays: entity.estimated_duration_days!,
      earlyStart: starts.get(id)!, earlyFinish: finishes.get(id)!, lateStart: lateStarts.get(id)!, lateFinish: lateFinishes.get(id)!,
      totalFloat, freeFloat: normalizedFloat(nextStart - finishes.get(id)!), critical: totalFloat === 0 };
  });
  const critical = new Set(tasks.filter(task => task.critical).map(task => task.id));
  const criticalPaths: string[][] = [];
  const paths = order.filter(id => nodes.get(id)!.entity.blocked_by.length === 0 && critical.has(id)).map(id => [id]);
  while (paths.length) {
    const ids = paths.pop()!;
    const last = ids.at(-1)!;
    const next = (successors.get(last) ?? []).filter(id => critical.has(id) && normalizedFloat(starts.get(id)! - finishes.get(last)!) === 0);
    if (!next.length && normalizedFloat(finishes.get(last)! - durationDays) === 0) criticalPaths.push(ids);
    for (let cursor = next.length - 1; cursor >= 0; cursor--) paths.push([...ids, next[cursor]!]);
  }
  criticalPaths.sort((left, right) => left.join('\0').localeCompare(right.join('\0')));
  return { status: 'available', model: 'continuous_calendar_days_finish_to_start_zero_lag', durationDays, tasks, criticalPaths };
}
