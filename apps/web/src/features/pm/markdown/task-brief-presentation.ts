import type { TaskBriefSourceRef } from '@agent-workspace/contracts/task-brief';

export type GuidanceReadFailure = 'access' | 'conflict' | 'unavailable';

export function guidanceReadFailure(error: unknown): GuidanceReadFailure | null {
  if (!error) return null;
  const status = typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (status === 401 || status === 403 || status === 404) return 'access';
  if (status === 409 || status === 412) return 'conflict';
  return 'unavailable';
}

/** Permission and revision failures never leave an old sensitive/current-looking body on screen. */
export function guidanceSnapshot<T>(data: T | undefined, error: unknown, online: boolean, needsRevalidation = false) {
  const failure = guidanceReadFailure(error);
  return {
    data: failure === 'access' || failure === 'conflict' ? undefined : data,
    stale: !!data && failure !== 'access' && failure !== 'conflict' && (failure === 'unavailable' || !online || needsRevalidation),
    failure,
  };
}

/** The task project is the default; other projects enter the request only through explicit selection. */
export function knowledgeProjectScope(taskProjectId: string, selected: readonly string[], authorized: readonly string[]): string[] {
  const permitted = new Set(authorized);
  return [...new Set([taskProjectId, ...selected.filter(id => permitted.has(id))])];
}

export function guidanceSourceMatches(source: TaskBriefSourceRef, file: { id: string; revision: string; entity: { entity: string; project?: string | null } }): boolean {
  return source.entityId === file.id && source.revision === file.revision && source.kind === file.entity.entity
    && source.projectId === (file.entity.entity === 'project' ? file.id : file.entity.project);
}

export function guidanceSourceOffset(source: TaskBriefSourceRef, bodyLength: number): number {
  return source.location.type === 'body' ? Math.min(source.location.offset, bodyLength) : 0;
}
