import { statusCategory, type FileRecord, type WorkspaceSnapshot } from '../../../../../../packages/pm-schema/index.ts';
import { calendarDay } from '../markdown/task-collection-model.ts';

export type HomeTaskTab = 'todo' | 'overdue' | 'completed';
export interface HomeProjectProgress {
  file: FileRecord;
  total: number;
  completed: number;
  percent: number | null;
}
export interface HomeDeadlineGroup { id: 'today' | 'tomorrow' | 'week'; files: FileRecord[] }
export interface WorkspaceHomeModel {
  projects: FileRecord[];
  activeProjects: HomeProjectProgress[];
  tasks: FileRecord[];
  open: FileRecord[];
  completed: FileRecord[];
  overdue: FileRecord[] | null;
  mine: Record<HomeTaskTab, FileRecord[] | null>;
  deadlines: HomeDeadlineGroup[] | null;
  excludedSources: number;
}

const byDue = (a: FileRecord, b: FileRecord) => (a.entity.due || '9999-12-31').localeCompare(b.entity.due || '9999-12-31') || a.id.localeCompare(b.id, undefined, { numeric: true });
const readable = (file: FileRecord) => !file.stale && !file.error && !file.diagnostics?.some(issue => issue.severity === 'error');

/** Saved, authorized Markdown only. Percentages never determine a lifecycle state. */
export function workspaceHomeModel(snapshot: WorkspaceSnapshot, actorId: string, projectIds: readonly string[] | null, today: string | null): WorkspaceHomeModel | null {
  if (snapshot.configurationErrors.some(issue => issue.severity === 'error')) return null;
  const configuration = snapshot.configuration;
  const authorized = projectIds === null ? null : new Set(projectIds);
  const inScope = (file: FileRecord) => authorized === null || authorized.has(file.entity.entity === 'project' ? file.id : file.entity.project || '');
  const sources = snapshot.files.filter(file => ['project', 'work_item'].includes(file.entity.entity) && inScope(file));
  const projects = sources.filter(file => file.entity.entity === 'project' && !file.entity.archived && readable(file) && statusCategory(file.entity, configuration));
  const projectById = new Map(projects.map(file => [file.id, file]));
  // An archived or unreadable parent is not a current workspace work surface.
  // A terminal project does not rewrite its children's own workflow categories.
  const tasks = sources.filter(file => file.entity.entity === 'work_item' && !file.entity.archived && readable(file) && projectById.has(file.entity.project || '') && statusCategory(file.entity, configuration));
  const open: FileRecord[] = [], completed: FileRecord[] = [];
  const progress = new Map<string, { total: number; completed: number }>();
  for (const file of tasks) {
    const category = statusCategory(file.entity, configuration);
    if (category === 'canceled') continue;
    const current = progress.get(file.entity.project!) || { total: 0, completed: 0 };
    current.total += 1;
    if (category === 'completed') { completed.push(file); current.completed += 1; }
    else open.push(file);
    progress.set(file.entity.project!, current);
  }
  open.sort(byDue);
  // There is no trustworthy completion timestamp in FileRecord; ID order is explicit.
  completed.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const overdue = today ? open.filter(file => !!file.entity.due && file.entity.due < today) : null;
  const mine = {
    todo: today ? open.filter(file => file.entity.assignee === actorId && (!file.entity.due || file.entity.due >= today)) : null,
    overdue: overdue?.filter(file => file.entity.assignee === actorId) ?? null,
    completed: completed.filter(file => file.entity.assignee === actorId),
  };
  const tomorrow = today && calendarDay(today, 1), last = today && calendarDay(today, 7);
  const deadlines: HomeDeadlineGroup[] | null = today && tomorrow && last ? [
    { id: 'today', files: open.filter(file => file.entity.due === today) },
    { id: 'tomorrow', files: open.filter(file => file.entity.due === tomorrow) },
    { id: 'week', files: open.filter(file => !!file.entity.due && file.entity.due > tomorrow && file.entity.due <= last) },
  ] : null;
  const activeProjects = projects.filter(file => !['completed', 'canceled'].includes(statusCategory(file.entity, configuration)!)).sort(byDue).map(file => {
    const counts = progress.get(file.id) || { total: 0, completed: 0 };
    return { file, ...counts, percent: counts.total ? Math.round(counts.completed / counts.total * 100) : null };
  });
  const excludedSources = sources.filter(file => !file.entity.archived && (!readable(file) || !statusCategory(file.entity, configuration))).length + snapshot.unsupportedFiles.length;
  return { projects, activeProjects, tasks, open, completed, overdue, mine, deadlines, excludedSources };
}
