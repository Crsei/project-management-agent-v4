import type { CommandPayloadMap, Entity } from '../../../../../../packages/contracts/src/client.ts';
import type { FileRecord, WorkspaceSnapshot } from '../../../../../../packages/pm-schema/index.ts';
import { createReferenceResolver, referenceEntries } from '../../../../../../packages/pm-schema/relations.ts';
import { titleLineIndex } from '../../../../../../packages/pm-markdown/index.ts';

export const PROJECT_ICONS = ['folder', 'briefcase', 'layers', 'rocket', 'globe', 'target', 'code', 'palette'] as const;
export const PROJECT_COLORS = ['#2F2E2A', '#5A67D8', '#3B82C4', '#23918A', '#C54B78', '#C48A1E'] as const;
export function projectArchived(project: Pick<Entity, 'data'>): boolean { return project.data.archived === true || !!project.data.archivedAt; }
export function stableProjectPath(workspaceId: string, projectId: string): string { return `/pm/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`; }
export function projectSourceVersion(revision: string): number { const value = Number.parseInt(revision.slice(0, 8), 16) & 0x7fffffff; return value > 0 ? value : 1; }
/** Keep checklists, embedded views and all Markdown after the authoritative H1. */
export function projectDescription(source: FileRecord): string {
  const line = titleLineIndex(source.raw);
  if (line === undefined) throw new Error('The authoritative project title is unavailable.');
  return source.raw.split(/\r?\n/).slice(line + 1).join('\n').replace(/^\n/, '').replace(/\n$/, '');
}
export type ProjectSettingsValues = { name: string; description: string; ownerId: string; dueDate: string; icon: string; color: string };
export function projectSettingsValues(source: FileRecord): ProjectSettingsValues {
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  return { name: source.entity.title, description: projectDescription(source), ownerId: text(source.entity.owner), dueDate: text(source.entity.due), icon: text(source.entity['x-pm-icon']), color: text(source.entity['x-pm-color']) };
}
/** Omitted presentation/body fields preserve source bytes and legacy metadata. */
export function projectSettingsUpdate(source: FileRecord, values: ProjectSettingsValues): CommandPayloadMap['UpdateProject'] {
  const original = projectSettingsValues(source);
  const criteria = source.entity['x-pm-completion-criteria'];
  return {
    name: values.name.trim(), goal: typeof source.entity.goal === 'string' ? source.entity.goal : '', ownerId: values.ownerId || null,
    completionCriteria: Array.isArray(criteria) ? criteria.filter((value): value is string => typeof value === 'string') : [],
    ...(values.description !== original.description ? { description: values.description } : {}),
    ...(values.dueDate !== original.dueDate ? { dueDate: values.dueDate || null } : {}),
    ...(values.icon !== original.icon ? { icon: values.icon || null } : {}),
    ...(values.color !== original.color ? { color: values.color || null } : {}),
  };
}
/** This is only an authorized-source preflight; the server also checks private SQL references. */
export function projectDeletionBlockers(snapshot: WorkspaceSnapshot, id: string): string[] {
  const blockers = new Set<string>();
  const project = snapshot.files.find(file => file.id === id && file.entity.entity === 'project');
  if (!project?.entity.archived) blockers.add('Archive the project before permanent deletion.');
  if (snapshot.unsupportedFiles.length || snapshot.configurationErrors.some(issue => issue.severity === 'error') || snapshot.errors.some(issue => issue.severity === 'error')) blockers.add('Source safety cannot be verified while workspace sources or configuration are unreadable.');
  const resolver = createReferenceResolver(snapshot.files);
  for (const file of snapshot.files) {
    if (file.stale || file.error || file.diagnostics?.some(issue => issue.severity === 'error')) blockers.add('Source safety cannot be verified while a source is stale or invalid.');
    if (file.id === id) continue;
    if (referenceEntries(file.entity, snapshot.configuration).some(reference => reference.targetId === id) || file.entity.links.some(target => resolver.resolve(target).file?.id === id) || file.entity.views.some(view => view.order?.includes(id))) blockers.add(`${file.id} references this project.`);
  }
  for (const view of snapshot.views) if (view.order?.includes(id)) blockers.add(`Saved view ${view.name} references this project.`);
  return [...blockers];
}
