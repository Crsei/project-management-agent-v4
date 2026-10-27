export type SprintSummary = {
  id: string; projectId: string | null; title: string; status: string | null; category: string | null;
  startDate: string | null; dueDate: string | null; archived: boolean; version: number; revision: string;
  readOnly: boolean; taskIds: string[]; total: number; completed: number; remaining: number;
};
export type SprintTask = {
  id: string; projectId: string | null; title: string; status: string | null; sprintId: string | null;
  archived: boolean; version: number; readOnly: boolean;
};
export type SprintProgressPoint = {
  id: string; projectId: string | null; title: string; status: string | null; startDate: string | null; dueDate: string | null;
  archived: boolean; taskIds: string[]; total: number; completed: number; remaining: number;
};
export type SprintDashboardObservation = {
  sequence: number; observedAt: string; previousObservedAt: string | null; source: 'startup' | 'external' | 'core_command' | 'scan';
  reason: string; gap: 'initial' | 'restart' | 'invalid_scan' | null; complete: boolean; sprints: SprintProgressPoint[];
};
export type SprintsDashboard = {
  sprints: SprintSummary[]; tasks: SprintTask[]; currentSprintIds: string[];
  history: { status: 'ok' | 'error'; error: string | null; semantics: 'observed_snapshots'; observations: SprintDashboardObservation[] };
};

/** The same revision-derived CAS token used by all Markdown-backed PM commands. */
export function sprintRecordVersion(revision: string): number {
  const value = Number.parseInt(revision.slice(0, 8), 16) & 0x7fffffff;
  return value > 0 ? value : 1;
}
