import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { Workspace, WorkspaceError, type WorkspaceMutationGuard } from '../../../../packages/pm-core/index.ts';
import { inspectFrontmatter, patchMarkdown, titleLineIndex } from '../../../../packages/pm-markdown/index.ts';
import { MAX_WORK_ITEM_ESTIMATE_POINTS, ProtocolError, workflowFor, type FileRecord, type UnsupportedFile, type WorkflowDefinition } from '../../../../packages/pm-schema/index.ts';
import { DomainError, type Actor, type Command, type CommandReceipt, type Entity } from '../../../../packages/domain/src/core.ts';
import { authorizeCoreScope, type CoreScope } from './core-routes.ts';
import { dashboardPlanningCommands } from '../../../../packages/application/src/dashboard-planning.ts';
import { dashboardSprintsCommands } from '../../../../packages/application/src/dashboard-sprints.ts';
import { executeDashboardPlanningCoreCommand, isDashboardPlanningCoreCommand } from './dashboard-planning-core-adapter.ts';
import { executeDashboardSprintsCoreCommand, isDashboardSprintsCoreCommand } from './dashboard-sprints-core.ts';
import { projectAuditChanges } from '../../../../packages/domain/src/project-audit.ts';
import type { ProjectAuditWrite } from '../../../../packages/application/src/project-audit.ts';
import { assertCoreTaskMutation, requireTaskAssignee } from '../../../../packages/application/src/core-task-creation.ts';
import { planningCommands } from '../../../../packages/application/src/planning.ts';
import type { SqlExecutor } from '../../../../packages/application/src/ports.ts';
import { lockWorkspace } from '../../../../packages/infrastructure/src/database.ts';
import { captureCoreFacts, recoverPreparedCoreCreations } from './core-facts.ts';
import { CoreCommandJournal } from './core-journal.ts';
import { requestHash } from '../../../../packages/application/src/core-bridge.ts';
import type { CapturedServiceFact } from '../../../../packages/application/src/service-facts.ts';
import { initializeLocalProject, requireLocalManagement, resolveLocalDirectory, resolveLocalRecoveryDirectory, assertLocalProjectWritable, assertLocalProjectTargetAvailable, type LocalProjectConfiguration } from '../../../../packages/application/src/local-projects.ts';
import { localDirectorySchema } from '../../../../packages/contracts/src/local-projects.ts';
import type { ProjectMount } from '../../../../packages/pm-core/project-locations.ts';
import { assertCoreDeletionSafe } from '../../../../packages/application/src/core-deletion.ts';

export const CORE_ENTITY_KINDS = ['project', 'work_item', 'milestone'] as const;
export type CoreEntityKind = typeof CORE_ENTITY_KINDS[number];

/** The Markdown core owns these entity kinds; every other PM kind keeps its own storage. */
export function isCoreEntityKind(kind: string): kind is CoreEntityKind {
  return kind === 'project' || kind === 'work_item' || kind === 'milestone';
}

function assertCalendarDate(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DomainError('validation_failed', 'Invalid schedule date', 400);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new DomainError('validation_failed', 'Invalid schedule date', 400);
  return value;
}

type IntentConversion = { intentId: string; acceptedRevision: number; taskId: string };
const conversionFile = (root: string) => path.join(root, '.pm', 'state', 'pm-intent-conversions.ndjson');
function conversionOf(root: string, intentId: string, acceptedRevision: number): IntentConversion | undefined {
  const file = conversionFile(root);
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as IntentConversion;
      if (entry.intentId === intentId && entry.acceptedRevision === acceptedRevision) return entry;
    } catch { /* Ignore a torn trailing line; a new conversion is still guarded by the file scan. */ }
  }
  return undefined;
}
function recordConversion(root: string, entry: IntentConversion): void {
  mkdirSync(path.dirname(conversionFile(root)), { recursive: true });
  appendFileSync(conversionFile(root), JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
}

const coreCommands: Readonly<Record<string, true>> = {
  CreateProject: true, DuplicateProject: true, UpdateProject: true, ActivateProject: true, CompleteProject: true, CancelProject: true, ReopenProject: true,
  CreateWorkItem: true, CreateWorkItemFromIntent: true, UpdateWorkItemContent: true, UpdateWorkItemMetadata: true,
  SetWorkItemBlockers: true, AddDependency: true, RemoveDependency: true, ReadyWorkItem: true, StartWorkItem: true,
  CompleteWorkItem: true, ReopenWorkItem: true, CancelWorkItem: true,
  CreateMilestone: true, UpdateMilestone: true, AssignMilestone: true, UnassignMilestone: true, AchieveMilestone: true,
  CancelMilestone: true, ReopenMilestone: true, ArchiveObject: true, RestoreArchivedObject: true, DeleteObject: true,
};

/** True when this command must execute against the Markdown core instead of PM aggregates. */
export function isCoreCommand(commandType: string): boolean {
  return Object.hasOwn(coreCommands, commandType) || isDashboardPlanningCoreCommand(commandType) || isDashboardSprintsCoreCommand(commandType);
}

/** Structural view of CoreScope so mapping and command logic stay testable without HTTP. */
export type CoreEntityScope = {
  readonly workspaceId: string;
  readonly unrestricted: boolean;
  readonly membership: { readonly capabilities: readonly string[] };
  allows(record: FileRecord | UnsupportedFile): boolean;
  allowsProject(project: unknown): boolean;
  entity(record: FileRecord | UnsupportedFile): FileRecord | UnsupportedFile;
};

/** Everything a core command needs; the route supplies the authenticated scope and database pool. */
export type CoreCommandContext = {
  workspace: Workspace;
  scope: CoreScope;
  principal: Actor;
  command: Command;
  pool: Pool;
  sql?: SqlExecutor;
  mutationGuard?: WorkspaceMutationGuard;
  checkAuthorization?(sql: SqlExecutor): Promise<void>;
  localProjects?: LocalProjectConfiguration;
  recoveringLocalProject?: boolean;
  bindLocalProject?(sql: SqlExecutor, mount: ProjectMount): Promise<void>;
  affectProject?(projectId: string): void;
  captureAudit?(entries: readonly ProjectAuditWrite[]): void;
  captureFacts?(facts: readonly CapturedServiceFact[]): void;
};

const pmStatusByCore: Record<CoreEntityKind, Readonly<Record<string, string>>> = {
  project: { planned: 'planning', active: 'active', on_hold: 'active', completed: 'completed', canceled: 'cancelled' },
  work_item: { todo: 'draft', in_progress: 'in_progress', done: 'done', canceled: 'cancelled' },
  milestone: { planned: 'planned', active: 'active', completed: 'achieved', canceled: 'cancelled' },
};
const coreStatusByPm: Record<CoreEntityKind, Readonly<Record<string, string>>> = {
  project: { planning: 'planned', active: 'active', completed: 'completed', cancelled: 'canceled' },
  work_item: { draft: 'todo', ready: 'todo', in_progress: 'in_progress', in_review: 'in_progress', done: 'done', cancelled: 'canceled' },
  milestone: { planned: 'planned', active: 'active', achieved: 'completed', cancelled: 'canceled' },
};

/** Unknown custom workflow states pass through unchanged in both directions. */
export function toPmStatus(kind: CoreEntityKind, status: string): string {
  return pmStatusByCore[kind][status] ?? status;
}
export function toCoreStatus(kind: CoreEntityKind, status: string): string {
  return coreStatusByPm[kind][status] ?? status;
}
/** PM uses `normal` where the Markdown core uses `medium`; unknown priorities pass through. */
export function toPmPriority(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value === 'medium' ? 'normal' : value;
}
export function toCorePriority(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value === 'normal' ? 'medium' : value;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function archivedAtOf(entity: FileRecord['entity']): string | null {
  if (entity.archived !== true) return null;
  const value = entity['x-pm-archived-at'];
  return typeof value === 'string' && value ? value : null;
}
/** Missing source timestamps are unknown, not the time this file was observed. */
function timestampOf(entity: FileRecord['entity'], key: string): string | null {
  const value = entity[key];
  return typeof value === 'string' && value ? value : null;
}
function workItemBody(description: string, criteria: { text: string }[]): string {
  const checklist = criteria.filter(item => item.text.trim()).map(item => `- [ ] ${item.text.replace(/\r?\n/g, ' ')}`).join('\n');
  return [description.trim() ? description : '', checklist].filter(Boolean).join('\n\n');
}
/** PM description is the source body without the authoritative H1 and without the
 * exact checklist lines the parser indexed. Code fences, nested prose, comments and
 * untouched lines are never removed by a regex. */
function bodyLayout(record: FileRecord) {
  const lines = record.raw.split(/\r?\n/);
  const { body, bodyLineOffset } = inspectFrontmatter(record.raw);
  const titleLine = titleLineIndex(record.raw);
  const bodyLines = body.split(/\r?\n/);
  return {
    lines,
    bodyLines,
    prefixLines: lines.slice(0, bodyLineOffset),
    titleIndex: titleLine === undefined ? 0 : titleLine - bodyLineOffset,
    checklistIndexes: new Set(record.entity.checklist.map(item => item.line - 1 - bodyLineOffset)),
  };
}

function descriptionOf(record: FileRecord): string {
  const { bodyLines, titleIndex, checklistIndexes } = bodyLayout(record);
  return bodyLines.filter((_, index) => index !== titleIndex && (record.entity.entity !== 'work_item' || !checklistIndexes.has(index))).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
}

function checklistTexts(entity: FileRecord['entity']): string[] {
  return entity.checklist.map(item => item.text);
}

/** Replace checklist text in place, preserving checkbox state, bullet style and indentation. */
function rewriteChecklist(lines: string[], checklist: FileRecord['entity']['checklist'], criteria: { text: string }[]): string[] {
  const next = [...lines];
  const removed = new Set<number>();
  checklist.forEach((item, index) => {
    const lineIndex = item.line - 1;
    if (index >= criteria.length) { removed.add(lineIndex); return; }
    const line = next[lineIndex] ?? '';
    const match = /^(\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s*)(.*)$/.exec(line);
    if (match) next[lineIndex] = `${match[1]}${criteria[index]!.text.replace(/\r?\n/g, ' ').trim()}`;
  });
  const kept = next.filter((_, index) => !removed.has(index));
  const additions = criteria.slice(checklist.length).map(item => `- [ ] ${item.text.replace(/\r?\n/g, ' ').trim()}`);
  if (!additions.length) return kept;
  const lastChecklist = checklist.length ? Math.min(checklist[checklist.length - 1]!.line - 1, kept.length) : -1;
  if (lastChecklist >= 0) kept.splice(lastChecklist + 1, 0, ...additions);
  else kept.push('', ...additions);
  return kept;
}

function rewriteChecklistSequential(lines: string[], criteria: { text: string }[]): string[] {
  const output: string[] = [];
  let inFence = false;
  let index = 0;
  let lastChecklist = -1;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; output.push(line); continue; }
    if (!inFence && /^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]/.test(line)) {
      if (index >= criteria.length) continue;
      output.push(line.replace(/(\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s*).*$/, `$1${criteria[index]!.text.replace(/\r?\n/g, ' ').trim()}`));
      lastChecklist = output.length - 1;
      index++;
      continue;
    }
    output.push(line);
  }
  const additions = criteria.slice(index).map(item => `- [ ] ${item.text.replace(/\r?\n/g, ' ').trim()}`);
  if (!additions.length) return output;
  if (lastChecklist >= 0) output.splice(lastChecklist + 1, 0, ...additions);
  else output.push('', ...additions);
  return output;
}

export function updateWorkItemRaw(record: FileRecord, title: string, description: string, criteria: { text: string }[]): string {
  const run = record.raw.includes('\r\n') ? '\r\n' : '\n';
  const { lines, bodyLines, prefixLines, titleIndex, checklistIndexes } = bodyLayout(record);
  if (titleLineIndex(record.raw) === undefined) throw new DomainError('validation_failed', 'Missing title: add a nonempty first-level Markdown heading', 422);
  const descriptionUnchanged = description === descriptionOf(record);
  const criteriaUnchanged = JSON.stringify(checklistTexts(record.entity)) === JSON.stringify(criteria.map(item => item.text.trim()));
  if (descriptionUnchanged && criteriaUnchanged) {
    if (title === record.entity.title) return record.raw;
    const updated = [...lines];
    updated[titleLineIndex(record.raw)!] = `# ${title}`;
    return updated.join(run);
  }
  if (descriptionUnchanged) {
    const updated = [...lines];
    updated[titleLineIndex(record.raw)!] = `# ${title}`;
    return rewriteChecklist(updated, record.entity.checklist, criteria).join(run);
  }
  const newDescription = description.split(/\r?\n/);
  const rebuiltBody: string[] = [];
  let descriptionIndex = 0;
  bodyLines.forEach((line, index) => {
    if (index < titleIndex) { rebuiltBody.push(line); return; }
    if (index === titleIndex) { rebuiltBody.push(`# ${title}`); return; }
    if (index === titleIndex + 1 && line.trim() === '') { rebuiltBody.push(''); return; }
    if (checklistIndexes.has(index)) { rebuiltBody.push(line); return; }
    if (descriptionIndex < newDescription.length) rebuiltBody.push(newDescription[descriptionIndex++]!);
  });
  while (descriptionIndex < newDescription.length) rebuiltBody.push(newDescription[descriptionIndex++]!);
  const updatedBody = rewriteChecklistSequential(rebuiltBody, criteria);
  return [...prefixLines, ...updatedBody].join(run);
}
export function replaceBody(raw: string, body: string): string {
  const lineBreak = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const titleLine = titleLineIndex(raw);
  if (titleLine === undefined || titleLine < 0 || titleLine >= lines.length) throw new DomainError('validation_failed', 'Missing title: add a nonempty first-level Markdown heading', 422);
  const kept = lines.slice(0, titleLine + 1);
  return [...kept, '', ...(body ? body.split(/\r?\n/) : [])].join(lineBreak).replace(/\s+$/, '') + lineBreak;
}
function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('validation_failed', `${field} must be a nonempty string`, 400, { field });
  return value;
}
function criteriaOf(value: unknown): { id: string; text: string }[] {
  if (!Array.isArray(value)) return [];
  const result: { id: string; text: string }[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !('text' in item)) continue;
    if (typeof item.text !== 'string' || !item.text.trim()) continue;
    const id = 'id' in item && typeof item.id === 'string' && item.id ? item.id : `criterion-${index + 1}`;
    result.push({ id, text: item.text });
  }
  return result;
}

/** Derive the optimistic PM version from the authoritative SHA-256 revision. */
export function coreVersion(revision: string): number {
  const value = Number.parseInt(revision.slice(0, 8), 16) & 0x7fffffff;
  return value > 0 ? value : 1;
}

/** Map one authoritative Markdown file to the PM aggregate shape the browser consumes. */
export function coreRecordToEntity(workspaceId: string, record: FileRecord): Entity {
  const source = record.entity;
  if (!isCoreEntityKind(source.entity)) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
  const status = typeof source.status === 'string' ? source.status : '';
  const common = {
    labStatus: status || null,
    blocked_by: asStringArray(source.blocked_by),
    related_to: asStringArray(source.related_to),
    labels: asStringArray(source.labels),
    archived: source.archived === true,
  };
  let data: Record<string, unknown>;
  if (source.entity === 'project') {
    data = {
      name: source.title,
      title: source.title,
      description: descriptionOf(record),
      icon: typeof source['x-pm-icon'] === 'string' ? source['x-pm-icon'] : null,
      color: typeof source['x-pm-color'] === 'string' ? source['x-pm-color'] : null,
      goal: typeof source.goal === 'string' ? source.goal : '',
      ownerId: typeof source.owner === 'string' ? source.owner : null,
      status: toPmStatus('project', status),
      completionCriteria: asStringArray(source['x-pm-completion-criteria']),
      startDate: typeof source.start === 'string' ? source.start : null,
      dueDate: typeof source.due === 'string' ? source.due : null,
      archivedAt: archivedAtOf(source),
      ...common,
    };
  } else if (source.entity === 'work_item') {
    data = {
      title: source.title,
      description: descriptionOf(record),
      contentRevision: coreVersion(record.revision),
      status: toPmStatus('work_item', status),
      priority: toPmPriority(source.priority),
      assigneeId: typeof source.assignee === 'string' ? source.assignee : null,
      estimatePoints: typeof source['x-pm-estimate'] === 'number' && Number.isFinite(source['x-pm-estimate']) && source['x-pm-estimate'] >= 0 && source['x-pm-estimate'] <= MAX_WORK_ITEM_ESTIMATE_POINTS ? source['x-pm-estimate'] : null,
      startDate: typeof source['x-pm-start'] === 'string' ? source['x-pm-start'] : null,
      dueDate: typeof source.due === 'string' ? source.due : null,
      milestoneId: typeof source.milestone === 'string' ? source.milestone : null,
      kind: source.kind ?? 'task',
      parentId: source.parent ?? null,
      location: source['x-pm-location'] ?? null,
      prerequisiteIds: asStringArray(source.blocked_by),
      acceptanceCriteria: source.checklist.map((item, index) => ({ id: `${source.id}-AC-${index + 1}`, text: item.text })),
      originIntentRef: source['x-pm-intent-ref'] ?? null,
      archivedAt: archivedAtOf(source),
      ...common,
    };
  } else {
    data = {
      name: source.title,
      status: toPmStatus('milestone', status),
      ownerId: typeof source.owner === 'string' ? source.owner : null,
      targetDate: typeof source.due === 'string' ? source.due : null,
      archivedAt: archivedAtOf(source),
      ...common,
    };
  }
  return {
    id: record.id,
    workspaceId,
    projectId: source.entity === 'project' ? null : typeof source.project === 'string' ? source.project : null,
    kind: source.entity,
    version: coreVersion(record.revision),
    data,
    createdAt: timestampOf(source, 'x-pm-created-at'),
    updatedAt: timestampOf(source, 'x-pm-updated-at'),
    createdBy: typeof source['x-pm-created-by'] === 'string' ? source['x-pm-created-by'] : '',
  };
}

export type CoreListOptions = {
  kind?: string;
  project?: string;
  projectId?: string;
  status?: string;
  priority?: string;
  q?: string;
  archived?: 'exclude' | 'include' | 'only';
  limit?: number;
  after?: string;
};

export async function listCoreEntities(workspace: Workspace, scope: CoreEntityScope, options: CoreListOptions = {}): Promise<{ items: Entity[]; nextCursor: string | null; cursor: string }> {
  if (options.kind !== undefined && !isCoreEntityKind(options.kind)) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
  const kinds: CoreEntityKind[] = options.kind !== undefined && isCoreEntityKind(options.kind) ? [options.kind] : [...CORE_ENTITY_KINDS];
  const project = options.project ?? options.projectId;
  const priority = options.priority ? toCorePriority(options.priority) : null;
  const records: FileRecord[] = kinds.flatMap(kind => workspace.items({
    entity: kind,
    ...(project ? { project } : {}),
    ...(options.status ? { status: toCoreStatus(kind, options.status) } : {}),
    ...(priority ? { priority } : {}),
    ...(options.q ? { q: options.q } : {}),
    ...(options.archived ? { archived: options.archived } : {}),
  }));
  const items = records.filter(record => scope.allows(record)).map(record => coreRecordToEntity(scope.workspaceId, record)).sort((left, right) => left.id.localeCompare(right.id));
  const start = options.after ? items.findIndex(item => item.id > options.after!) : 0;
  const limit = typeof options.limit === 'number' ? Math.max(0, options.limit) : items.length;
  const page = start < 0 ? [] : items.slice(start, start + limit);
  const nextCursor = start >= 0 && start + limit < items.length ? page.at(-1)?.id ?? null : null;
  return { items: page, nextCursor, cursor: String(workspace.snapshot().files.filter(record => scope.allows(record)).length) };
}

export function readCoreEntity(workspace: Workspace, scope: CoreEntityScope, id: string): Entity {
  const record = workspace.get(id);
  if (!isCoreEntityKind(record.entity.entity)) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
  scope.entity(record);
  return coreRecordToEntity(scope.workspaceId, record);
}

function authorize(scope: CoreEntityScope, capability: string): void {
  if (!scope.membership.capabilities.includes(capability)) throw new DomainError('permission_denied', `Capability ${capability} is required`, 403);
}
function scopedCoreRecord(workspace: Workspace, scope: CoreEntityScope, id: string | undefined, expected?: CoreEntityKind): FileRecord {
  if (!id) throw new DomainError('validation_failed', 'A target entity is required', 400);
  const record = workspace.get(id);
  if (!isCoreEntityKind(record.entity.entity)) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
  if (expected && record.entity.entity !== expected) throw new DomainError('validation_failed', `Expected ${expected}`, 400);
  scope.entity(record);
  return record;
}
async function patchScoped(context: CoreCommandContext, expected: CoreEntityKind, capability: string, changes: Record<string, unknown>): Promise<Entity> {
  const { workspace, scope, command, mutationGuard } = context;
  authorize(scope, capability);
  const record = scopedCoreRecord(workspace, scope, command.targetId, expected);
  return coreRecordToEntity(scope.workspaceId, await workspace.patch(record.id, changes, record.revision, mutationGuard));
}
async function transitionTask(context: CoreCommandContext, categories: WorkflowDefinition['states'][number]['category'][], capability: string): Promise<Entity> {
  authorize(context.scope, capability);
  const record = scopedCoreRecord(context.workspace, context.scope, context.command.targetId, 'work_item');
  const workflow = workflowFor('work_item', context.workspace.configuration().config);
  for (const category of categories) {
    const targets = workflow?.states.filter(state => state.category === category &&
      (state.id === record.entity.status || workflow.transitions.some(transition => transition.from === record.entity.status && transition.to === state.id))) ?? [];
    if (!targets.length) continue;
    const current = targets.find(state => state.id === record.entity.status);
    if (current) return patchScoped(context, 'work_item', capability, { status: current.id });
    // A category can contain several lanes (for example work and review).
    // Only an explicit configured preference may disambiguate allowed targets.
    const target = targets.length === 1 ? targets[0] : targets.find(state => state.id === workflow?.default_targets?.[category]);
    if (!target) throw new DomainError('invalid_transition', 'The configured task workflow has ambiguous destinations for this action', 409);
    return patchScoped(context, 'work_item', capability, { status: target.id });
  }
  throw new DomainError('invalid_transition', 'The configured task workflow has no allowed destination for this action', 409);
}
async function createWorkItem(context: CoreCommandContext, payload: Record<string, unknown>, key: string, intentRef?: Record<string, unknown>): Promise<Entity> {
  const { workspace, scope, principal, command, mutationGuard } = context;
  authorize(scope, 'planning.edit');
  authorize(scope, 'domain.read');
  if (command.targetId) throw new DomainError('invalid_scope', 'Task creation cannot target an existing object', 409);
  const projectId = typeof command.projectId === 'string' ? command.projectId : '';
  if (!projectId) throw new DomainError('project_required', 'A project is required', 409);
  if (!scope.allowsProject(projectId)) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
  const criteria = criteriaOf(payload.acceptanceCriteria);
  const input: Record<string, unknown> = {
    entity: 'work_item',
    title: requiredText(payload.title, 'title'),
    body: workItemBody(typeof payload.description === 'string' ? payload.description : '', criteria),
    project: projectId,
    'x-pm-created-by': principal.id,
    'x-pm-command-id': key,
  };
  if (typeof payload.assigneeId === 'string' && payload.assigneeId) input.assignee = payload.assigneeId.toLowerCase();
  if (typeof payload.priority === 'string' && payload.priority) input.priority = toCorePriority(payload.priority);
  if (payload.startDate !== undefined && payload.startDate !== null) input['x-pm-start'] = payload.startDate;
  if (payload.dueDate !== undefined && payload.dueDate !== null) input.due = payload.dueDate;
  if (payload.labels !== undefined) input.labels = payload.labels;
  if (payload.kind !== undefined) input.kind = payload.kind;
  if (payload.parentId !== undefined && payload.parentId !== null) input.parent = payload.parentId;
  if (payload.estimatePoints !== undefined && payload.estimatePoints !== null) input['x-pm-estimate'] = payload.estimatePoints;
  if (payload.location !== undefined && payload.location !== null) input['x-pm-location'] = payload.location;
  if (intentRef) input['x-pm-intent-ref'] = intentRef;
  return coreRecordToEntity(scope.workspaceId, await workspace.createEntity(input, key, mutationGuard));
}
async function createMilestone(workspace: Workspace, scope: CoreEntityScope, principal: Actor, command: Command, payload: Record<string, unknown>, key: string): Promise<Entity> {
  authorize(scope, 'planning.edit');
  const projectId = typeof command.projectId === 'string' ? command.projectId : '';
  if (!projectId) throw new DomainError('project_required', 'A project is required', 409);
  if (!scope.allowsProject(projectId)) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
  if (workspace.get(projectId).entity.entity !== 'project') throw new DomainError('project_required', 'A project is required', 409);
  const input: Record<string, unknown> = {
    entity: 'milestone',
    title: requiredText(payload.name ?? payload.title, 'name'),
    body: workItemBody('', asStringArray(payload.criteria).map(text => ({ text }))),
    project: projectId,
    'x-pm-created-by': principal.id,
    'x-pm-command-id': key,
  };
  if (typeof payload.targetDate === 'string' && payload.targetDate) input.due = payload.targetDate;
  return coreRecordToEntity(scope.workspaceId, await workspace.createEntity(input, key));
}

async function verifyAcceptedIntent(context: CoreCommandContext, intentId: string, decisionId: string, acceptedRevision: number, projectId: string): Promise<void> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(intentId) || !uuid.test(decisionId)) throw new DomainError('accepted_intent_required', 'An accepted intent and decision are required', 409);
  const ids = [intentId.toLowerCase(), decisionId.toLowerCase()];
  const result = await (context.sql ?? context.pool).query<{ id: string; kind: string; project_id: string | null; data: Record<string, unknown> }>(
    'SELECT id,kind,project_id,data FROM entities WHERE workspace_id=$1 AND id=ANY($2::uuid[])',
    [context.scope.workspaceId.toLowerCase(), ids],
  );
  const intent = result.rows.find(row => row.id === ids[0]);
  const decision = result.rows.find(row => row.id === ids[1]);
  const subject = decision?.data.subjectRef;
  const subjectMatches = subject !== null && typeof subject === 'object' && !Array.isArray(subject)
    && 'id' in subject && 'kind' in subject && subject.id === intent?.id && subject.kind === 'intent';
  const accepted = !!intent && intent.kind === 'intent' && !!decision && decision.kind === 'decision'
    && intent.data.status === 'accepted' && intent.data.revision === acceptedRevision && intent.data.acceptedDecisionId === decision.id
    && decision.data.decisionType === 'accept_intent' && decision.data.acceptedRevision === acceptedRevision && subjectMatches
    && (intent.project_id === null || intent.project_id === projectId);
  if (!accepted) throw new DomainError('accepted_intent_required', 'An accepted intent and decision are required', 409);
}

async function dispatch(context: CoreCommandContext, idempotencyKey?: string): Promise<unknown> {
  const { workspace, scope, principal, command, mutationGuard } = context;
  const payload = command.payload ?? {};
  const key = idempotencyKey ?? command.commandId;
  if (isDashboardPlanningCoreCommand(command.commandType)) return executeDashboardPlanningCoreCommand(context, key);
  if (isDashboardSprintsCoreCommand(command.commandType)) return executeDashboardSprintsCoreCommand(context, key);
  switch (command.commandType) {
    case 'CreateProject': {
      authorize(scope, 'planning.edit');
      if (!scope.unrestricted) throw new DomainError('permission_denied', 'Workspace-wide configuration requires workspace scope', 403);
      if (command.projectId || command.targetId) throw new DomainError('invalid_scope', 'Project creation cannot target an existing scope', 409);
      const input: Record<string, unknown> = { entity: 'project', title: requiredText(payload.name, 'name'), 'x-pm-created-by': principal.id };
      if (typeof payload.goal === 'string' && payload.goal.trim()) input.goal = payload.goal;
      if (typeof payload.ownerId === 'string' && payload.ownerId) input.owner = payload.ownerId;
      if (typeof payload.description === 'string') input.body = payload.description;
      if (typeof payload.startDate === 'string') input.start = payload.startDate;
      if (typeof payload.dueDate === 'string') input.due = payload.dueDate;
      if (Array.isArray(payload.completionCriteria)) input['x-pm-completion-criteria'] = payload.completionCriteria;
      if (context.localProjects?.enabled) {
        await requireLocalManagement(context.sql ?? context.pool, principal, scope.workspaceId, true);
        const parsedDirectory = localDirectorySchema.safeParse(payload.localDirectory);
        if (!parsedDirectory.success) throw new DomainError('local_project_directory_required', 'Choose a trusted local project directory before creating a project', 400);
        const directory = parsedDirectory.data;
        if (!context.sql) throw new DomainError('local_project_binding_missing', 'Local initialization requires the authorization transaction', 503);
        const targetRoot = directory.mode === 'existing' ? path.resolve(directory.path) : path.resolve(directory.parentPath, directory.folderName);
        await assertLocalProjectTargetAvailable(context.sql, workspace.root, targetRoot, key);
        const record = await initializeLocalProject(workspace, context.localProjects, scope.workspaceId, input, key, directory, mutationGuard, undefined, context.recoveringLocalProject);
        const mount = workspace.projectLocation(record.id);
        if (!mount || !context.bindLocalProject || !context.sql) throw new DomainError('local_project_binding_missing', 'Project attachment binding is unavailable', 503);
        await context.bindLocalProject(context.sql, mount);
        return coreRecordToEntity(scope.workspaceId, record);
      }
      if (payload.localDirectory !== undefined) throw new DomainError('local_projects_disabled', 'Local project directories are not configured on this deployment', 409);
      return coreRecordToEntity(scope.workspaceId, await workspace.createEntity(input, key, mutationGuard));
    }
    case 'DuplicateProject': {
      authorize(scope, 'planning.edit');
      if (!scope.unrestricted) throw new DomainError('permission_denied', 'Creating an independent project requires workspace-wide planning access', 403);
      const source = scopedCoreRecord(workspace, scope, command.targetId ?? command.projectId, 'project');
      if (command.projectId && command.projectId !== source.id) throw new DomainError('project_mismatch', 'The copy scope must be the source project', 409);
      const copyKey = `duplicate:${principal.id}:${key}`;
      const reservation = workspace.projectCopyReservation(copyKey);
      const input = { name: requiredText(payload.name, 'name').trim(), includeTasks: payload.includeTasks === true };
      let directory;
      if (context.localProjects?.enabled) {
        await requireLocalManagement(context.sql ?? context.pool, principal, scope.workspaceId, true);
        const parsed = localDirectorySchema.safeParse(payload.localDirectory);
        if (!parsed.success) throw new DomainError('local_project_directory_required', 'Choose and preflight a trusted destination directory', 400);
        const selected = reservation ? resolveLocalRecoveryDirectory(context.localProjects, parsed.data) : resolveLocalDirectory(context.localProjects, parsed.data);
        if (!context.sql || !context.bindLocalProject) throw new DomainError('local_project_binding_missing', 'Copy requires the project binding transaction', 503);
        await assertLocalProjectTargetAvailable(context.sql, workspace.root, selected.root, copyKey);
        directory = { workspaceId: scope.workspaceId, ...selected };
      } else if (payload.localDirectory !== undefined) throw new DomainError('local_projects_disabled', 'Local project directories are not configured', 409);
      const journal = new CoreCommandJournal(workspace.root);
      const hash = requestHash(command as unknown as Record<string, unknown>);
      const result = await workspace.duplicateProject(source.id, reservation?.sourceRevision ?? source.revision, input, copyKey, directory, mutationGuard, records => {
        const saved = journal.find(command.commandId, principal.id, hash);
        if (saved?.kind === 'pending' && saved.copyAudit) return;
        const metadata = { source: 'command' as const, commandId: command.commandId, action: command.commandType, actorId: principal.id, occurredAt: new Date().toISOString() };
        journal.prepareCopy(command, hash, principal.id, records.flatMap(record => coreProjectAuditWrites(undefined, record, metadata)));
      });
      if (directory) await context.bindLocalProject!(context.sql!, workspace.projectLocation(result.id)!);
      context.affectProject?.(result.id);
      return result;
    }
    case 'UpdateProject': {
      authorize(scope, 'planning.edit');
      const record = scopedCoreRecord(workspace, scope, command.targetId, 'project');
      const changes: Record<string, unknown> = {};
      if ('name' in payload) changes.title = requiredText(payload.name, 'name');
      if ('goal' in payload) changes.goal = typeof payload.goal === 'string' && payload.goal.trim() ? payload.goal : null;
      if ('ownerId' in payload) changes.owner = typeof payload.ownerId === 'string' && payload.ownerId ? payload.ownerId : null;
      if ('completionCriteria' in payload) changes['x-pm-completion-criteria'] = payload.completionCriteria;
      if ('dueDate' in payload) changes.due = payload.dueDate;
      if ('icon' in payload) changes['x-pm-icon'] = payload.icon;
      if ('color' in payload) changes['x-pm-color'] = payload.color;
      const raw = Object.keys(changes).length ? patchMarkdown(record.raw, changes, workspace.configuration().config) : record.raw;
      const updated = typeof payload.description === 'string' ? replaceBody(raw, payload.description) : raw;
      if (updated === record.raw) return coreRecordToEntity(scope.workspaceId, record);
      return coreRecordToEntity(scope.workspaceId, await workspace.save(record.id, updated, record.revision, mutationGuard));
    }
    case 'ActivateProject': return patchScoped(context, 'project', 'planning.lifecycle', { status: 'active' });
    case 'CompleteProject': return patchScoped(context, 'project', 'planning.lifecycle', { status: 'completed' });
    case 'CancelProject': return patchScoped(context, 'project', 'planning.lifecycle', { status: 'canceled' });
    case 'ReopenProject': return patchScoped(context, 'project', 'planning.lifecycle', { status: 'active' });
    case 'CreateWorkItem': return createWorkItem(context, payload, key);
    case 'CreateWorkItemFromIntent': {
      const acceptedRevision = payload.acceptedRevision;
      if (typeof acceptedRevision !== 'number' || !Number.isInteger(acceptedRevision) || acceptedRevision < 1) throw new DomainError('validation_failed', 'acceptedRevision must be a positive integer', 400);
      const intentId = requiredText(payload.intentId, 'intentId').toLowerCase();
      const decisionId = requiredText(payload.decisionId, 'decisionId').toLowerCase();
      const previous = Workspace.inspectCreation(workspace.root, key).request;
      if (previous) {
        scope.entity(workspace.get(previous.id));
        return createWorkItem(context, payload, key, { intentId, acceptedRevision, decisionId });
      }
      await verifyAcceptedIntent(context, intentId, decisionId, acceptedRevision, typeof command.projectId === 'string' ? command.projectId : '');
      if (conversionOf(workspace.root, intentId, acceptedRevision)) throw new DomainError('intent_already_converted', 'This accepted intent revision has already been converted', 409);
      const converted = workspace.snapshot().files.some(file => {
        if (file.entity.entity !== 'work_item') return false;
        const reference = file.entity['x-pm-intent-ref'];
        return !!reference && typeof reference === 'object' && 'intentId' in reference && typeof reference.intentId === 'string' && reference.intentId.toLowerCase() === intentId
          && 'acceptedRevision' in reference && reference.acceptedRevision === acceptedRevision;
      });
      if (converted) throw new DomainError('intent_already_converted', 'This accepted intent revision has already been converted', 409);
      const created = await createWorkItem(context, payload, key, { intentId, acceptedRevision, decisionId });
      recordConversion(workspace.root, { intentId, acceptedRevision, taskId: created.id });
      return created;
    }
    case 'UpdateWorkItemContent': {
      authorize(scope, 'planning.edit');
      const record = scopedCoreRecord(workspace, scope, command.targetId, 'work_item');
      const title = requiredText(payload.title, 'title');
      const description = typeof payload.description === 'string' ? payload.description : '';
      const raw = updateWorkItemRaw(record, title, description, criteriaOf(payload.acceptanceCriteria));
      if (raw === record.raw) return coreRecordToEntity(scope.workspaceId, record);
      return coreRecordToEntity(scope.workspaceId, await workspace.save(record.id, raw, record.revision, mutationGuard));
    }
    case 'UpdateWorkItemMetadata': {
      authorize(scope, 'planning.edit');
      const record = scopedCoreRecord(workspace, scope, command.targetId, 'work_item');
      const changes: Record<string, unknown> = {};
      if ('assigneeId' in payload) changes.assignee = typeof payload.assigneeId === 'string' && payload.assigneeId ? payload.assigneeId : null;
      if ('priority' in payload) changes.priority = toCorePriority(typeof payload.priority === 'string' ? payload.priority : null);
      const nextStart = 'startDate' in payload ? assertCalendarDate(payload.startDate) : (typeof record.entity['x-pm-start'] === 'string' ? record.entity['x-pm-start'] : null);
      const nextDue = 'dueDate' in payload ? assertCalendarDate(payload.dueDate) : (typeof record.entity.due === 'string' ? record.entity.due : null);
      if (nextStart && nextDue && nextStart > nextDue) throw new DomainError('invalid_schedule_range', 'start must not be later than due', 409);
      if ('startDate' in payload) changes['x-pm-start'] = nextStart;
      if ('dueDate' in payload) changes.due = nextDue;
      if (!Object.keys(changes).length) throw new DomainError('validation_failed', 'At least one metadata field is required', 400);
      return coreRecordToEntity(scope.workspaceId, await workspace.patch(record.id, changes, record.revision, mutationGuard));
    }
    case 'SetWorkItemBlockers': {
      const reasons = asStringArray(payload.manualBlockReasons);
      return patchScoped(context, 'work_item', 'planning.edit', {
        'x-pm-manual-block-reasons': reasons,
      });
    }
    case 'AddDependency': {
      authorize(scope, 'planning.edit');
      const record = scopedCoreRecord(workspace, scope, command.targetId, 'work_item');
      const prerequisiteId = requiredText(payload.prerequisiteId, 'prerequisiteId');
      if (record.entity.blocked_by.includes(prerequisiteId)) throw new DomainError('duplicate_dependency', 'The dependency already exists', 409);
      scopedCoreRecord(workspace, scope, prerequisiteId, 'work_item');
      return coreRecordToEntity(scope.workspaceId, await workspace.patch(record.id, { blocked_by: [...record.entity.blocked_by, prerequisiteId] }, record.revision, mutationGuard));
    }
    case 'RemoveDependency': {
      authorize(scope, 'planning.edit');
      const record = scopedCoreRecord(workspace, scope, command.targetId, 'work_item');
      const prerequisiteId = requiredText(payload.prerequisiteId, 'prerequisiteId');
      if (!record.entity.blocked_by.includes(prerequisiteId)) throw new DomainError('dependency_not_found', 'The dependency does not exist', 409);
      return coreRecordToEntity(scope.workspaceId, await workspace.patch(record.id, { blocked_by: record.entity.blocked_by.filter(value => value !== prerequisiteId) }, record.revision, mutationGuard));
    }
    case 'ReadyWorkItem': return transitionTask(context, ['started'], 'planning.edit');
    case 'StartWorkItem': return transitionTask(context, ['started'], 'planning.edit');
    case 'CompleteWorkItem': return transitionTask(context, ['completed'], 'workitem.complete');
    case 'ReopenWorkItem': return transitionTask(context, ['started', 'unstarted', 'backlog'], 'workitem.cancel_reopen');
    case 'CancelWorkItem': return transitionTask(context, ['canceled'], 'workitem.cancel_reopen');
    case 'CreateMilestone': return createMilestone(workspace, scope, principal, command, payload, key);
    case 'UpdateMilestone': {
      authorize(scope, 'planning.edit');
      const record = scopedCoreRecord(workspace, scope, command.targetId, 'milestone');
      const changes: Record<string, unknown> = {};
      if ('name' in payload) changes.title = requiredText(payload.name, 'name');
      if ('targetDate' in payload) changes.due = assertCalendarDate(payload.targetDate);
      if (Array.isArray(payload.criteria)) {
        const titled = Object.keys(changes).length ? patchMarkdown(record.raw, changes, workspace.configuration().config) : record.raw;
        const raw = replaceBody(titled, workItemBody('', asStringArray(payload.criteria).map(text => ({ text }))));
        return coreRecordToEntity(scope.workspaceId, await workspace.save(record.id, raw, record.revision));
      }
      if (!Object.keys(changes).length) return coreRecordToEntity(scope.workspaceId, record);
      return coreRecordToEntity(scope.workspaceId, await workspace.patch(record.id, changes, record.revision));
    }
    case 'AssignMilestone': {
      authorize(scope, 'planning.edit');
      const record = scopedCoreRecord(workspace, scope, command.targetId, 'work_item');
      const milestoneId = requiredText(payload.milestoneId, 'milestoneId');
      const milestone = scopedCoreRecord(workspace, scope, milestoneId, 'milestone');
      if (milestone.entity.project !== record.entity.project) throw new DomainError('project_mismatch', 'Milestone belongs to another project', 409);
      if (record.entity.milestone === milestoneId) throw new DomainError('milestone_already_assigned', 'The milestone is already assigned', 409);
      return coreRecordToEntity(scope.workspaceId, await workspace.patch(record.id, { milestone: milestoneId }, record.revision, mutationGuard));
    }
    case 'UnassignMilestone': {
      authorize(scope, 'planning.edit');
      const record = scopedCoreRecord(workspace, scope, command.targetId, 'work_item');
      const milestoneId = requiredText(payload.milestoneId, 'milestoneId');
      if (record.entity.milestone !== milestoneId) throw new DomainError('milestone_mismatch', 'The work item is not assigned to this milestone', 409);
      return coreRecordToEntity(scope.workspaceId, await workspace.patch(record.id, { milestone: null }, record.revision, mutationGuard));
    }
    case 'AchieveMilestone': return patchScoped(context, 'milestone', 'planning.lifecycle', { status: 'completed' });
    case 'CancelMilestone': return patchScoped(context, 'milestone', 'planning.lifecycle', { status: 'canceled' });
    case 'ReopenMilestone': return patchScoped(context, 'milestone', 'planning.lifecycle', { status: 'planned' });
    case 'ArchiveObject': {
      const kind = payload.kind;
      if (kind !== 'project' && kind !== 'work_item') throw new DomainError('validation_failed', 'kind must be project or work_item', 400);
      return patchScoped(context, kind, 'planning.lifecycle', { archived: true, 'x-pm-archived-at': new Date().toISOString() });
    }
    case 'RestoreArchivedObject': {
      const kind = payload.kind;
      if (kind !== 'project' && kind !== 'work_item') throw new DomainError('validation_failed', 'kind must be project or work_item', 400);
      return patchScoped(context, kind, 'planning.lifecycle', { archived: false, 'x-pm-archived-at': null });
    }
    case 'DeleteObject': {
      authorize(scope, 'planning.lifecycle');
      const kind = typeof payload.kind === 'string' && isCoreEntityKind(payload.kind) ? payload.kind : undefined;
      const record = scopedCoreRecord(workspace, scope, command.targetId, kind);
      await assertCoreDeletionSafe(context.sql ?? context.pool, scope.workspaceId, record);
      return workspace.delete(record.id, record.revision);
    }
    default:
      throw new DomainError('unknown_command', `Command ${command.commandType} is not owned by the Markdown core`, 400);
  }
}

function rejectionFor(command: Command, error: unknown): CommandReceipt | null {
  if (error instanceof DomainError) {
    return { commandId: command.commandId, status: 'rejected', httpStatus: error.status, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } };
  }
  if (error instanceof WorkspaceError) {
    if (error.diagnostics.some(item => ['TRANSACTION_FAILED', 'PERSISTENT_STATE_INVALID', 'FILE_UNWRITABLE', 'PROJECT_COPY_PENDING'].includes(item.code))) return null;
    const diagnostic = error.diagnostics.find(item => item.severity === 'error') ?? error.diagnostics[0];
    return { commandId: command.commandId, status: 'rejected', httpStatus: error.status, error: {
      code: diagnostic?.code ?? (error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'REVISION_CONFLICT' : 'VALIDATION_ERROR'),
      message: error.message,
      details: { diagnostics: error.diagnostics, ...(error.current ? { current: { id: error.current.id, revision: error.current.revision } } : {}) },
    } };
  }
  if (error instanceof ProtocolError) {
    return { commandId: command.commandId, status: 'rejected', httpStatus: 422, error: { code: error.diagnostics[0]?.code ?? 'VALIDATION_ERROR', message: error.message, details: { diagnostics: error.diagnostics } } };
  }
  return null;
}

/** Snapshot only the file actually mutated; never attribute watcher/index activity. */
export function coreProjectAuditWrites(before: FileRecord | undefined, after: FileRecord | undefined, metadata: {
  source: 'command' | 'core_http'; commandId: string; action: string; actorId: string; occurredAt: string;
}): ProjectAuditWrite[] {
  if (!before && !after || before && after && before.revision === after.revision) return [];
  const target = after ?? before!;
  const projectIds = new Set<string>();
  for (const record of [before, after]) {
    if (!record) continue;
    const projectId = record.entity.entity === 'project' ? record.id : record.entity.project;
    if (typeof projectId === 'string') projectIds.add(projectId);
  }
  const changes = before?.stale || after?.stale ? [] : projectAuditChanges(before?.entity ?? {}, after?.entity ?? {});
  return [...projectIds].map(projectId => ({ ...metadata, projectId, targetId: target.id, targetKind: target.entity.entity,
    beforeVersion: before?.revision ?? null, afterVersion: after?.revision ?? null, changes, audienceActorId: null }));
}

/**
 * Execute one PM planning command against the authoritative Markdown workspace.
 * Creates are idempotent by command ID; updates read the current revision and
 * write once, so a concurrent change produces a rejected receipt instead of a
 * retry. Known validation/conflict errors become rejected receipts; uncertain
 * file/state failures retain the pending journal boundary and throw.
 */
export async function executeCoreCommand(context: CoreCommandContext, idempotencyKey?: string): Promise<CommandReceipt> {
  let before: FileRecord | undefined;
  let result: unknown;
  let dispatched = false;
  const copyKey = `duplicate:${context.principal.id}:${idempotencyKey ?? context.command.commandId}`;
  try {
    const taskPayload = context.localProjects?.enabled && context.command.commandType === 'CreateProject' || ['DuplicateProject', 'UpdateProject', 'CreateWorkItem', 'CreateWorkItemFromIntent', 'UpdateWorkItemMetadata', 'UpdateWorkItemContent'].includes(context.command.commandType);
    const definition = (taskPayload ? planningCommands[context.command.commandType] : undefined) ?? dashboardPlanningCommands[context.command.commandType] ?? dashboardSprintsCommands[context.command.commandType];
    if (definition) {
      const parsed = definition.payload.safeParse(context.command.payload);
      if (!parsed.success) throw new DomainError('validation_failed', 'Invalid command payload', 400, parsed.error.flatten());
      context.command.payload = parsed.data as Record<string, unknown>;
    }
    const isCreate = /^Create/.test(context.command.commandType);
    if (context.command.commandType === 'DuplicateProject' && !context.command.targetId && context.command.projectId) context.command.targetId = context.command.projectId;
    const recoveringCopy = context.command.commandType === 'DuplicateProject' && !!context.workspace.projectCopyReservation(copyKey);
    const validateTarget = (current: FileRecord, scope: CoreScope): void => {
      scope.entity(current);
      const expected = context.command.expectedVersions?.[current.id];
      const projectId = current.entity.entity === 'project' ? current.id : current.entity.project;
      if (context.command.projectId && context.command.projectId !== projectId)
        throw new DomainError('project_mismatch', 'The command scope does not match its target', 409);
      if (!recoveringCopy && (expected === undefined || expected !== coreVersion(current.revision))) throw new DomainError('version_conflict', 'Aggregate version changed or expected version is missing', 409, { id: current.id, currentVersion: coreVersion(current.revision) });
      if (typeof projectId === 'string') context.affectProject?.(projectId);
      before = current;
    };
    const sql = await context.pool.connect();
    try {
      await sql.query('BEGIN');
      await lockWorkspace(sql, context.scope.workspaceId);
      const scope = await authorizeCoreScope(sql, context.principal, context.scope.workspaceId, 'domain.read');
      await context.checkAuthorization?.(sql);
      const targetProject = context.command.projectId ?? (context.command.targetId ? (() => { const record = context.workspace.get(context.command.targetId!); return record.entity.entity === 'project' ? record.id : typeof record.entity.project === 'string' ? record.entity.project : undefined; })() : undefined);
      await assertLocalProjectWritable(sql, scope.workspaceId, targetProject);
      if (scope.membership.version !== context.scope.membership.version)
        throw new DomainError('permission_denied', 'Membership changed; refresh authorization before writing', 403);
      if (!isCreate && context.command.targetId) validateTarget(context.workspace.get(context.command.targetId), scope);
      const guarded: CoreCommandContext = {
        ...context, scope, sql,
        mutationGuard: async (current, after, batch) => {
          if (current) scope.entity(current);
          if (!isCreate && current && current.id === context.command.targetId) validateTarget(current, scope);
          if ((context.localProjects?.enabled || context.command.commandType === 'DuplicateProject') && after.entity === 'project' && typeof after.owner === 'string') await requireTaskAssignee(sql, scope.workspaceId, after.id, after.owner);
          await assertCoreTaskMutation({
            get: id => batch?.find(record => record.id === id) ?? context.workspace.get(id),
            configuration: context.workspace.configuration().config,
            requireCapability: capability => authorize(scope, capability),
            allowsProject: projectId => scope.allowsProject(projectId),
            requireAssignee: (projectId, assigneeId) => requireTaskAssignee(sql, scope.workspaceId, projectId, assigneeId),
          }, after, current?.entity);
        },
      };
      const facts: CapturedServiceFact[] = [];
      result = await context.workspace.captureMutations(captureCoreFacts({ sql, workspaceId: scope.workspaceId, root: context.workspace.root,
        sourceKind: 'command', operationId: context.command.commandId, requestHash: requestHash(context.command as unknown as Record<string, unknown>),
        actorId: context.principal.id, facts, reusePrepared: context.command.commandType === 'DuplicateProject' }), () => dispatch(guarded, idempotencyKey));
      if (context.recoveringLocalProject) for (const entry of recoverPreparedCoreCreations(context.workspace.root, new CoreCommandJournal(context.workspace.root))) {
        if (entry.kind === 'fact_completed' && entry.commandId === context.command.commandId && entry.actorId === context.principal.id && !facts.some(fact => fact.fact.factId === entry.captured.fact.factId)) facts.push(entry.captured);
      }
      context.captureFacts?.(facts);
      dispatched = true;
      if (context.captureAudit) {
        const metadata = { source: 'command' as const, commandId: context.command.commandId, action: context.command.commandType,
          actorId: context.principal.id, occurredAt: new Date().toISOString() };
        if (context.command.commandType === 'DuplicateProject') {
          const saved = new CoreCommandJournal(context.workspace.root).find(context.command.commandId, context.principal.id);
          if (saved?.kind !== 'pending' || !saved.copyAudit) throw new DomainError('copy_audit_unavailable', 'Original copy audit snapshot requires recovery', 503);
          context.captureAudit(saved.copyAudit);
        } else {
          const targetId = result && typeof result === 'object' && 'id' in result && typeof result.id === 'string' ? result.id : context.command.targetId;
          const deleted = result && typeof result === 'object' && 'deleted' in result && result.deleted === true;
          const after = targetId && !deleted ? context.workspace.get(targetId) : undefined;
          context.captureAudit(coreProjectAuditWrites(before, after, metadata));
        }
      }
      await sql.query('COMMIT');
    } catch (error) {
      await sql.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { sql.release(); }
  } catch (error) {
    // Once dispatch succeeds, audit or SQL failure cannot turn its file write into a rejection.
    if (dispatched) throw error;
    if (context.command.commandType === 'DuplicateProject' && context.workspace.projectCopyReservation(copyKey)
      && error instanceof DomainError && ['permission_denied', 'not_found_or_forbidden', 'unauthenticated'].includes(error.code)) throw error;
    if (context.command.commandType === 'DuplicateProject' && (context.workspace.projectCopyReservation(copyKey) || error instanceof WorkspaceError && error.diagnostics.some(diagnostic => diagnostic.code === 'PROJECT_COPY_PENDING')))
      throw new DomainError('command_outcome_unknown', 'The original project copy requires explicit recovery; do not submit a new command', 503);
    if (context.localProjects?.enabled && context.command.commandType === 'CreateProject' && (context.workspace.projectLocations().some(location => location.initialization.key === (idempotencyKey ?? context.command.commandId)) || error instanceof WorkspaceError && error.diagnostics.some(diagnostic => diagnostic.code === 'PROJECT_INITIALIZATION_PENDING')))
      throw new DomainError('command_outcome_unknown', 'The original local initialization requires explicit recovery', 503);
    const receipt = rejectionFor(context.command, error);
    if (receipt) return receipt;
    throw error;
  }
  return { commandId: context.command.commandId, status: 'committed', httpStatus: 200, result };
}
