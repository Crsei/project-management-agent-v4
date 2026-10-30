import type { ChangeNotification, ProjectAuditEntry, ProjectAuditPage, TaskCommentsPage } from '@contracts';
import type { FileRecord } from '@pm-schema';

export type ActivityEntry = {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  category: 'status' | 'comments' | 'projects' | 'other';
  targetId: string;
  targetKind: string;
  targetTitle: string;
  projectId: string | null;
  projectTitle: string | null;
  href: string | null;
  changes?: readonly { field: string; before: string | number | boolean | null; after: string | number | boolean | null }[];
  source: 'audit' | 'changes';
};

export type ActivityCommentTarget = { commentId: string; taskId: string; projectId: string; deleted: boolean };
export type ActivityPerson = { id: string; name: string };

type ActivityScope = { workspaceId: string; projectIds: readonly string[] | null };
type ActivityModelInput = ActivityScope & {
  files: readonly FileRecord[];
  audits: readonly ProjectAuditEntry[];
  auditedProjectIds: readonly string[];
  events: readonly ChangeNotification[];
  commentTargets: readonly ActivityCommentTarget[];
  people: readonly ActivityPerson[];
  canReadAudit: boolean;
  linksAvailable: boolean;
};

const readable = (file: FileRecord) => !file.stale && !file.error && !file.diagnostics?.some(issue => issue.severity === 'error');
const inScope = (scope: ActivityScope, projectId: string) => scope.projectIds === null || scope.projectIds.includes(projectId);

// Each of these Planning events unconditionally persists a lifecycle state.
// Generic metadata/content updates can preserve status and are intentionally absent.
const statusEvents: Readonly<Record<string, string>> = {
  WorkItemReadied: 'work_item', WorkItemStarted: 'work_item', WorkItemCompleted: 'work_item',
  WorkItemCancelled: 'work_item', WorkItemReopened: 'work_item',
  ProjectActivated: 'project', ProjectCompleted: 'project', ProjectCancelled: 'project', ProjectReopened: 'project',
  MilestoneAchieved: 'milestone', MilestoneCancelled: 'milestone', MilestoneReopened: 'milestone',
};

/** Includes archived projects: lifecycle recovery and audit history remain readable. */
export function activityProjects(files: readonly FileRecord[], projectIds: readonly string[] | null): string[] {
  return [...new Set(files.filter(file => file.entity.entity === 'project' && (projectIds === null || projectIds.includes(file.id))).map(file => file.id))].sort();
}

/** Server cursors pin each project to its initial high-water mark; never tail a live feed. */
export async function readActivityAudits(
  projectIds: readonly string[],
  readPage: (projectId: string, cursor: string | undefined, signal: AbortSignal) => Promise<ProjectAuditPage>,
  signal: AbortSignal,
): Promise<ProjectAuditEntry[]> {
  const entries: ProjectAuditEntry[] = [];
  for (const projectId of projectIds) {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let previousId: bigint | undefined;
    do {
      signal.throwIfAborted();
      const page = await readPage(projectId, cursor, signal);
      signal.throwIfAborted();
      if (page.projectId !== projectId) throw new Error('invalid_response');
      for (const entry of page.entries) {
        if (entry.projectId !== projectId || !/^[1-9]\d*$/.test(entry.id)) throw new Error('invalid_response');
        const id = BigInt(entry.id);
        if (previousId !== undefined && id >= previousId) throw new Error('invalid_response');
        previousId = id;
        entries.push(entry);
      }
      if (page.nextCursor !== null && (!page.nextCursor || !page.entries.length || cursors.has(page.nextCursor))) throw new Error('invalid_response');
      cursor = page.nextCursor ?? undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  return entries;
}

/** Resolve only IDs appearing in this history. Do not cache comment bodies or authors. */
export async function readActivityCommentTargets(
  scope: ActivityScope,
  files: readonly FileRecord[],
  references: readonly { projectId: string; commentId: string }[],
  readPage: (taskId: string, projectId: string, after: string | undefined, signal: AbortSignal) => Promise<TaskCommentsPage | null>,
  signal: AbortSignal,
): Promise<ActivityCommentTarget[]> {
  const wanted = new Map<string, Set<string>>();
  for (const ref of references) {
    if (!inScope(scope, ref.projectId)) continue;
    let ids = wanted.get(ref.projectId);
    if (!ids) { ids = new Set(); wanted.set(ref.projectId, ids); }
    ids.add(ref.commentId);
  }
  const result: ActivityCommentTarget[] = [];
  for (const file of files) {
    const projectId = file.entity.project;
    if (file.entity.entity !== 'work_item' || !projectId || !readable(file)) continue;
    const ids = wanted.get(projectId);
    if (!ids?.size) continue;
    // Requested comment IDs were frozen by the finite history snapshot. Once a
    // task's ordered page passes their maximum, do not chase newly added comments.
    let through = '';
    for (const id of ids) if (id > through) through = id;
    let after: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await readPage(file.id, projectId, after, signal);
      signal.throwIfAborted();
      if (page === null) break;
      if (page.taskId !== file.id || page.projectId !== projectId) throw new Error('invalid_response');
      let previous = after;
      for (const item of page.items) {
        if (item.workspaceId !== scope.workspaceId || item.projectId !== projectId || item.taskId !== file.id || previous !== undefined && item.id <= previous) throw new Error('invalid_response');
        previous = item.id;
        if (ids.delete(item.id)) result.push({ commentId: item.id, taskId: item.taskId, projectId: item.projectId, deleted: item.deletedAt !== null });
      }
      if (page.nextCursor !== null && (!page.items.length || page.nextCursor !== previous || after !== undefined && page.nextCursor <= after)) throw new Error('invalid_response');
      after = page.nextCursor ?? undefined;
      if (previous !== undefined && previous >= through) break;
    } while (after && ids.size);
  }
  return result;
}

/** Metadata never becomes an audit fact, even when a current entity has a known author/status. */
export function workspaceActivityEntries(input: ActivityModelInput): ActivityEntry[] {
  const files = new Map(input.files.filter(file => {
    const projectId = file.entity.entity === 'project' ? file.id : file.entity.project;
    return projectId ? inScope(input, projectId) : input.projectIds === null;
  }).map(file => [file.id, file]));
  const people = new Map(input.people.map(person => [person.id, person.name]));
  const comments = new Map(input.commentTargets.filter(target => inScope(input, target.projectId)).map(target => [`${target.projectId}:${target.commentId}`, target]));
  const audited = new Set(input.canReadAudit ? input.auditedProjectIds : []);
  const root = `/pm/${encodeURIComponent(input.workspaceId)}`;
  function target(id: string, kind: string, projectId: string | null) {
    const comment = kind === 'task_comment' && projectId ? comments.get(`${projectId}:${id}`) : undefined;
    const file = files.get(comment?.taskId ?? id);
    const expectedKind = comment ? 'work_item' : kind;
    const valid = file && file.entity.entity === expectedKind && readable(file) && (expectedKind === 'project' ? projectId === null || file.id === projectId : file.entity.project === projectId);
    const currentProject = valid && expectedKind === 'project' ? file.id : valid ? file.entity.project : projectId;
    const project = currentProject ? files.get(currentProject) : undefined;
    const authorizedProject = project?.entity.entity === 'project' && readable(project);
    let href: string | null = null;
    if (input.linksAvailable && valid && authorizedProject && !comment?.deleted) {
      href = expectedKind === 'project' ? `${root}/projects/${encodeURIComponent(file.id)}`
        : expectedKind === 'work_item' ? `${root}/projects/${encodeURIComponent(currentProject!)}/entities/${encodeURIComponent(file.id)}`
          : `${root}/entities/${encodeURIComponent(file.id)}`;
      if (comment) href += `#comment-${encodeURIComponent(comment.commentId)}`;
    }
    return {
      targetId: comment?.taskId ?? id,
      targetKind: comment ? 'work_item' : kind,
      targetTitle: valid ? file.entity.title : id,
      projectId: input.linksAvailable && authorizedProject ? project.id : null,
      projectTitle: input.linksAvailable && authorizedProject ? project.entity.title : null,
      href,
    };
  }
  const entries = new Map<string, ActivityEntry>();
  if (input.canReadAudit) {
    // A cross-project move writes the same immutable fact into both project histories.
    // Prefer its currently authorized project context without duplicating that write.
    const audits = [...input.audits].sort((a, b) => {
      return Number(b.projectId === files.get(b.targetId)?.entity.project) - Number(a.projectId === files.get(a.targetId)?.entity.project);
    });
    for (const audit of audits) {
      if (!audited.has(audit.projectId) || !inScope(input, audit.projectId)) continue;
      const key = JSON.stringify([audit.source, audit.actorId, audit.commandId, audit.action, audit.targetKind, audit.targetId, audit.beforeVersion, audit.afterVersion]);
      if (entries.has(key)) continue;
      const changes = audit.changes.filter(change => change.before !== change.after);
      const status = audit.beforeVersion !== null && audit.afterVersion !== null && changes.some(change => change.field === 'status' && change.before !== null && change.after !== null);
      entries.set(key, {
        id: `audit:${audit.id}`, occurredAt: audit.occurredAt, actorId: audit.actorId, actorName: people.get(audit.actorId) ?? null,
        action: audit.action, category: audit.targetKind === 'task_comment' ? 'comments' : audit.targetKind === 'project' ? 'projects' : status ? 'status' : 'other',
        ...target(audit.targetId, audit.targetKind, audit.projectId), changes, source: 'audit',
      });
    }
  }
  for (const event of input.events) {
    if (event.workspaceId !== input.workspaceId || event.projectId !== null && !inScope(input, event.projectId)) continue;
    // Change metadata has no command identity. Use one source per project instead of
    // heuristic timestamp matching, which can duplicate writes or merge unrelated ones.
    if (event.projectId !== null && audited.has(event.projectId)) continue;
    const key = `changes:${event.eventId}`;
    if (entries.has(key)) continue;
    entries.set(key, {
      id: key, occurredAt: event.occurredAt, actorId: null, actorName: null, action: event.eventType,
      category: event.aggregateKind === 'task_comment' ? 'comments' : statusEvents[event.eventType] === event.aggregateKind ? 'status' : event.aggregateKind === 'project' ? 'projects' : 'other',
      ...target(event.aggregateId, event.aggregateKind, event.projectId), source: 'changes',
    });
  }
  return [...entries.values()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.id.localeCompare(a.id, 'en', { numeric: true }));
}
