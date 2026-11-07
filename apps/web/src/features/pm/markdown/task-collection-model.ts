import { statusCategory, workflowFor, type FileRecord, type ProtocolConfiguration, type WorkflowDefinition } from '../../../../../../packages/pm-schema/index.ts';

export const taskScopes = ['all', 'mine', 'important'] as const;
export type TaskScope = typeof taskScopes[number];
export type TaskScopeCounts = Record<TaskScope, number | null>;
export interface TaskGroup { id: string; files: FileRecord[]; due?: string; label?: string; category?: WorkflowDefinition['states'][number]['category'] }
export interface TaskCollection { files: FileRecord[]; open: FileRecord[]; completed: FileRecord[]; canceled: FileRecord[]; groups: TaskGroup[] }
export function taskScope(value: string | null): TaskScope { return taskScopes.find(scope => scope === value) || 'all'; }

/** All-day dates are calendar values, never midnight instants in the browser zone. */
export function personalDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function calendarDay(date: string, offset: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

/** Input must already be authorized and filtered. Personal IDs never enter ViewConfig. */
export function collectTasks(files: FileRecord[], scope: TaskScope, today: string | null, watched: ReadonlySet<string> | null, configuration: ProtocolConfiguration, actorId: string | null = null): TaskCollection {
  const tasks = files.filter(file => file.entity.entity === 'work_item');
  let included: FileRecord[];
  let mineToday: string | null = null;
  if (scope === 'mine') {
    const date = today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? new Date(`${today}T00:00:00Z`) : null;
    const ready = actorId?.trim() && date && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === today;
    if (ready) mineToday = today;
    included = ready ? tasks.filter(file => file.entity.assignee === actorId && statusCategory(file.entity, configuration) !== 'canceled') : [];
  }
  else if (scope === 'important') included = watched ? tasks.filter(file => watched.has(file.id)) : [];
  else included = tasks;
  const result: TaskCollection = { files: included, open: [], completed: [], canceled: [], groups: [] };
  for (const file of included) {
    const category = statusCategory(file.entity, configuration);
    if (category === 'completed') result.completed.push(file);
    else if (category === 'canceled') result.canceled.push(file);
    else result.open.push(file);
  }
  if (scope === 'mine') result.groups = [
    { id: 'overdue', files: result.open.filter(file => !!file.entity.due && file.entity.due < mineToday!) },
    { id: 'today', ...(mineToday ? { due: mineToday } : {}), files: result.open.filter(file => file.entity.due === mineToday) },
    { id: 'upcoming', files: result.open.filter(file => !file.entity.due || file.entity.due > mineToday!) },
    { id: 'completed', category: 'completed', files: result.completed },
  ];
  else {
    const states = workflowFor('work_item', configuration)?.states ?? [];
    const groups: TaskGroup[] = [];
    for (const state of states) {
      const files = included.filter(file => file.entity.status === state.id);
      if (files.length) groups.push({ id: state.id, label: state.label, category: state.category, files });
    }
    // A state outside the configured workflow still needs its own heading instead of disappearing.
    const configured = new Set(states.map(state => state.id));
    const outside = included.map(file => file.entity.status).filter((id): id is string => !!id && !configured.has(id));
    for (const stateId of new Set(outside)) {
      const files = included.filter(file => file.entity.status === stateId);
      if (files.length) groups.push({ id: `status:${stateId}`, label: stateId, files });
    }
    result.groups = groups;
  }
  return result;
}

/** Apply personal attention after all authorized scope and saved-view filtering. */
export function filterTaskCollectionAttention(collection: TaskCollection, pendingIds: ReadonlySet<string>): TaskCollection {
  const pending = (files: FileRecord[]) => files.filter(file => pendingIds.has(file.id));
  return {
    files: pending(collection.files),
    open: pending(collection.open),
    completed: pending(collection.completed),
    canceled: pending(collection.canceled),
    groups: collection.groups.map(group => ({ ...group, files: pending(group.files) })),
  };
}

/** A pending-only board must include completed items without changing the normal display preference. */
export function taskBoardFiles(collection: TaskCollection, showCompleted: boolean, pendingOnly: boolean): FileRecord[] {
  return showCompleted || pendingOnly ? collection.files : [...collection.open, ...collection.canceled];
}

/** Only local paths within the workspace or project root may be used after create/back. */
export function safeWorkspaceReturn(value: string | null | undefined, root: string, fallback = `${root}/issues`): string {
  if (!value || /[\\\u0000-\u001f]/.test(value)) return fallback;
  try {
    const base = 'https://workspace.invalid';
    const url = new URL(value, base);
    const local = value === root || value.startsWith(`${root}/`) || value.startsWith(`${root}?`) || value.startsWith(`${root}#`);
    if (url.origin !== base || !local || (url.pathname !== root && !url.pathname.startsWith(`${root}/`))) return fallback;
    const path = url.pathname.replace(/\/+$/, '');
    if (path === `${root}/issues/new` || path.startsWith(`${root}/entities/`)) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return fallback; }
}
