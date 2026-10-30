import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import { getMembership, type Membership } from '../../../../packages/application/src/access.ts';
import {
  AGENT_CHAT_TOOL_REGISTRY, assertAgentToolRecord, agentToolProjectId, parseAgentChatToolInput,
  type AgentChatToolName, type AgentChatToolScope,
} from '../../../../packages/application/src/agent-chat-tools.ts';
import { pmChangeSetSchema, type PmChangeField, type PmChangeKind, type PmChangeSet } from '../../../../packages/agent-contracts/src/pm-changes.ts';
import { validateTransition, workflowFor, type FileRecord, type ProtocolConfiguration } from '../../../../packages/pm-schema/index.ts';
import { relationFields } from '../../../../packages/pm-schema/relations.ts';
import { inspectFrontmatter } from '../../../../packages/pm-markdown/index.ts';
import { WorkspaceError, type Workspace } from '../../../../packages/pm-core/index.ts';
import { CoreScope, type CoreWorkspacePool } from './core-routes.ts';

const projectIdPattern = /^[A-Z][A-Z0-9]*-\d+$/;
const previewScopeSchema = z.strictObject({
  kind: z.enum(['projects', 'workspace']),
  projectIds: z.array(z.string().regex(projectIdPattern)).max(1000),
});
const previewRequestSchema = z.strictObject({
  name: z.string().min(1).max(100),
  arguments: z.unknown(),
  scope: previewScopeSchema,
}).refine(value => value.arguments !== undefined, 'Arguments are required');
type PreviewRequest = z.infer<typeof previewRequestSchema>;

const fieldLabels: Readonly<Record<string, string>> = {
  title: 'Title', description: 'Description', body: 'Body', goal: 'Goal', assigneeId: 'Assignee',
  priority: 'Priority', startDate: 'Start date', dueDate: 'Due date', labels: 'Labels',
  status: 'Status', archived: 'Archived', content: 'Comment', deletion: 'Permanent deletion',
  sourceRevision: 'Source revision', targetRevision: 'Target revision',
};

/** Bound the amount of source text a preview echoes back; documents never leak unrelated content. */
const PREVIEW_TEXT_LIMIT = 4000;
function clip(value: string): string { return value.length > PREVIEW_TEXT_LIMIT ? `${value.slice(0, PREVIEW_TEXT_LIMIT)}…` : value; }
function textOf(value: unknown): string | null { return typeof value === 'string' && value.length ? clip(value) : null; }
function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}
function listText(values: readonly string[]): string | null { return values.length ? values.join(', ') : null; }
function changeField(field: string, before: string | null, after: string | null): PmChangeField {
  return {
    field,
    label: fieldLabels[field] ?? field.replaceAll('_', ' ').replace(/(^|\s)\S/g, letter => letter.toUpperCase()),
    before,
    after,
  };
}
function changeSet(input: {
  kind: PmChangeKind; targetId: string | null; targetTitle: string | null; projectId: string | null;
  summary: string; fields?: PmChangeField[];
}): PmChangeSet {
  return pmChangeSetSchema.parse({
    id: randomUUID(), kind: input.kind, state: 'proposed',
    targetId: input.targetId, targetTitle: input.targetTitle, projectId: input.projectId,
    summary: input.summary,
    ...(input.fields && input.fields.length ? { fields: input.fields } : {}),
    createdAt: new Date().toISOString(),
  });
}

function readRecord(workspace: Workspace, scope: AgentChatToolScope, id: string, expected?: 'project' | 'work_item' | 'document'): FileRecord {
  let record: FileRecord;
  try { record = workspace.get(id); }
  catch (error) {
    if (error instanceof WorkspaceError && error.status === 404) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
    throw error;
  }
  if (record.stale || record.error || record.diagnostics?.some(issue => issue.severity === 'error'))
    throw new DomainError('agent_context_unavailable', 'The authoritative source is stale or invalid; repair it in the native PM interface', 409);
  if (expected && record.entity.entity !== expected) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible as this tool target', 404);
  assertAgentToolRecord(scope, record);
  return record;
}

function projectOf(record: FileRecord, scope: AgentChatToolScope): string {
  const projectId = agentToolProjectId(record.entity);
  assertAgentToolRecord(scope, record);
  if (!projectId) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
  return projectId;
}

function previewCreate(name: 'pm_create_project' | 'pm_create_task' | 'pm_create_document', args: unknown, workspace: Workspace, scope: AgentChatToolScope): PmChangeSet {
  if (name === 'pm_create_project') {
    const input = parseAgentChatToolInput(name, args);
    if (scope.kind !== 'workspace') throw new DomainError('agent_tool_workspace_scope_required', 'Project creation requires an explicit workspace grant and native workspace permission', 403);
    return changeSet({ kind: 'create', targetId: null, targetTitle: input.title, projectId: null, summary: `Create project ${input.title}`,
      fields: [changeField('title', null, input.title), changeField('description', null, clip(input.description)), changeField('goal', null, textOf(input.goal))] });
  }
  if (name === 'pm_create_task') {
    const input = parseAgentChatToolInput(name, args);
    const project = readRecord(workspace, scope, input.projectId, 'project');
    const fields = [changeField('title', null, input.title), changeField('description', null, clip(input.description))];
    if (input.assigneeId !== null) fields.push(changeField('assigneeId', null, textOf(input.assigneeId)));
    if (input.priority !== null) fields.push(changeField('priority', null, input.priority));
    if (input.startDate !== null) fields.push(changeField('startDate', null, textOf(input.startDate)));
    if (input.dueDate !== null) fields.push(changeField('dueDate', null, textOf(input.dueDate)));
    if (input.labels !== null) fields.push(changeField('labels', null, listText(input.labels)));
    return changeSet({ kind: 'create', targetId: null, targetTitle: input.title, projectId: project.id, summary: `Create task ${input.title} in ${project.id}`, fields });
  }
  const input = parseAgentChatToolInput(name, args);
  const project = readRecord(workspace, scope, input.projectId, 'project');
  return changeSet({ kind: 'create', targetId: null, targetTitle: input.title, projectId: project.id, summary: `Create document ${input.title}`,
    fields: [changeField('title', null, input.title), changeField('body', null, clip(input.body))] });
}

function previewUpdate(name: 'pm_update_project' | 'pm_update_task' | 'pm_save_document', args: unknown, workspace: Workspace, scope: AgentChatToolScope): PmChangeSet {
  if (name === 'pm_update_project') {
    const input = parseAgentChatToolInput(name, args);
    const record = readRecord(workspace, scope, input.id, 'project');
    const entity = record.entity, fields: PmChangeField[] = [];
    if (input.title !== null) fields.push(changeField('title', textOf(entity.title), input.title));
    if (input.goal !== null) fields.push(changeField('goal', textOf(entity.goal), textOf(input.goal)));
    if (input.description !== null) fields.push(changeField('description', textOf(entity.body), textOf(input.description)));
    if (input.startDate !== null) fields.push(changeField('startDate', textOf(entity.start), textOf(input.startDate)));
    if (input.dueDate !== null) fields.push(changeField('dueDate', textOf(entity.due), textOf(input.dueDate)));
    fields.push(changeField('revision', record.revision, null));
    return changeSet({ kind: 'update', targetId: record.id, targetTitle: entity.title, projectId: projectOf(record, scope), summary: `Update project ${record.id}`, fields });
  }
  if (name === 'pm_update_task') {
    const input = parseAgentChatToolInput(name, args);
    const record = readRecord(workspace, scope, input.id, 'work_item');
    const entity = record.entity, fields: PmChangeField[] = [];
    if (input.title !== null) fields.push(changeField('title', textOf(entity.title), input.title));
    if (input.description !== null) fields.push(changeField('description', textOf(entity.body), textOf(input.description)));
    if (input.assigneeId !== null) fields.push(changeField('assigneeId', textOf(entity.assignee), textOf(input.assigneeId)));
    if (input.priority !== null) fields.push(changeField('priority', textOf(entity.priority), input.priority));
    if (input.startDate !== null) fields.push(changeField('startDate', textOf(entity['x-pm-start']), textOf(input.startDate)));
    if (input.dueDate !== null) fields.push(changeField('dueDate', textOf(entity.due), textOf(input.dueDate)));
    if (input.labels !== null) fields.push(changeField('labels', listText(listOf(entity.labels)), listText(input.labels)));
    fields.push(changeField('revision', record.revision, null));
    return changeSet({ kind: 'update', targetId: record.id, targetTitle: entity.title, projectId: projectOf(record, scope), summary: `Update task ${record.id}`, fields });
  }
  const input = parseAgentChatToolInput(name, args);
  const record = readRecord(workspace, scope, input.id, 'document');
  return changeSet({ kind: 'update', targetId: record.id, targetTitle: record.entity.title, projectId: projectOf(record, scope), summary: `Save document ${record.id}`,
    fields: [changeField('body', clip(inspectFrontmatter(record.raw).body), clip(input.body)), changeField('revision', record.revision, null)] });
}

function previewRelation(name: 'pm_add_relation' | 'pm_remove_relation', args: unknown, workspace: Workspace, scope: AgentChatToolScope, configuration: ProtocolConfiguration): PmChangeSet {
  const input = parseAgentChatToolInput(name, args);
  const source = readRecord(workspace, scope, input.sourceId), target = readRecord(workspace, scope, input.targetId);
  const definition = relationFields(configuration).find(field => field.name === input.relation && field.entities.includes(source.entity.entity));
  if (!definition) throw new DomainError('agent_tool_invalid_relation', 'This relation is not defined for the source entity', 400);
  const values = listOf(source.entity[input.relation]);
  if (!definition.multiple && name === 'pm_add_relation' && values.length && !values.includes(target.id))
    throw new DomainError('agent_tool_relation_exists', 'Remove the existing single-target relation explicitly before replacing it', 409);
  const next = name === 'pm_add_relation' ? [...new Set([...values, target.id])] : values.filter(value => value !== target.id);
  const before = definition.multiple ? listText(values) : values[0] ?? null;
  const after = definition.multiple ? listText(next) : next[0] ?? null;
  return changeSet({
    kind: 'relation', targetId: source.id, targetTitle: source.entity.title, projectId: projectOf(source, scope),
    summary: `${name === 'pm_add_relation' ? 'Add' : 'Remove'} ${input.relation} relation ${source.id} → ${target.id}`,
    fields: [changeField(input.relation, before, after),
      changeField('sourceRevision', source.revision, null), changeField('targetRevision', target.revision, null)],
  });
}

function previewLifecycle(name: 'pm_archive_task' | 'pm_restore_task' | 'pm_delete_task' | 'pm_transition_task', args: unknown, workspace: Workspace, scope: AgentChatToolScope, configuration: ProtocolConfiguration): PmChangeSet {
  if (name === 'pm_transition_task') {
    const input = parseAgentChatToolInput(name, args);
    const record = readRecord(workspace, scope, input.id, 'work_item');
    const workflow = workflowFor('work_item', configuration);
    if (!workflow?.states.some(state => state.id === input.status))
      throw new DomainError('agent_tool_transition_not_allowed', 'The target state is not configured for work items', 422);
    const diagnostics = validateTransition(record.entity, { ...record.entity, status: input.status }, configuration);
    if (diagnostics.length) throw new DomainError('agent_tool_transition_not_allowed', diagnostics[0]!.message, 422);
    return changeSet({ kind: 'status', targetId: record.id, targetTitle: record.entity.title, projectId: projectOf(record, scope),
      summary: `Transition task ${record.id} to ${input.status}`,
      fields: [changeField('status', textOf(record.entity.status), input.status)] });
  }
  const input = parseAgentChatToolInput(name, args);
  const record = readRecord(workspace, scope, input.id, 'work_item');
  const projectId = projectOf(record, scope);
  if (name === 'pm_delete_task') {
    if (record.entity.archived !== true) throw new DomainError('DELETE_REQUIRES_ARCHIVE', 'Archive the task before permanent deletion', 422);
    return changeSet({ kind: 'delete', targetId: record.id, targetTitle: record.entity.title, projectId,
      summary: `Permanently delete archived task ${record.id}`,
      fields: [changeField('archived', record.entity.archived === true ? 'true' : 'false', null), changeField('deletion', 'false', 'true')] });
  }
  const archived = name === 'pm_archive_task';
  return changeSet({ kind: 'archive', targetId: record.id, targetTitle: record.entity.title, projectId,
    summary: `${archived ? 'Archive' : 'Restore'} task ${record.id}`,
    fields: [changeField('archived', record.entity.archived === true ? 'true' : 'false', archived ? 'true' : 'false')] });
}

function previewComment(args: unknown, workspace: Workspace, scope: AgentChatToolScope): PmChangeSet {
  const input = parseAgentChatToolInput('pm_create_comment', args);
  const task = readRecord(workspace, scope, input.taskId, 'work_item');
  const projectId = projectOf(task, scope);
  if (input.projectId !== projectId) throw new DomainError('not_found_or_forbidden', 'Task is not in the requested comment project', 404);
  return changeSet({ kind: 'comment', targetId: task.id, targetTitle: task.entity.title, projectId, summary: `Comment on ${task.id}`,
    fields: [changeField('content', null, clip(input.content))] });
}

/** Builds a proposed change set from current sources. It never dispatches a command or writes a file. */
function preview(name: AgentChatToolName, args: unknown, workspace: Workspace, scope: AgentChatToolScope): PmChangeSet {
  const configuration = workspace.configuration().config;
  switch (name) {
    case 'pm_create_project': case 'pm_create_task': case 'pm_create_document':
      return previewCreate(name, args, workspace, scope);
    case 'pm_update_project': case 'pm_update_task': case 'pm_save_document':
      return previewUpdate(name, args, workspace, scope);
    case 'pm_add_relation': case 'pm_remove_relation':
      return previewRelation(name, args, workspace, scope, configuration);
    case 'pm_create_comment':
      return previewComment(args, workspace, scope);
    case 'pm_archive_task': case 'pm_restore_task': case 'pm_delete_task': case 'pm_transition_task':
      return previewLifecycle(name, args, workspace, scope, configuration);
    default:
      throw new DomainError('preview_not_supported', 'This read-only tool has no change to preview', 400);
  }
}

function resolveScope(member: Membership, workspaceId: string, workspace: Workspace, input: PreviewRequest['scope']): AgentChatToolScope {
  if (input.kind === 'workspace' && member.projectIds !== null) throw new DomainError('not_found_or_forbidden', 'Workspace scope requires workspace-wide native permission', 404);
  if (input.kind === 'workspace' && input.projectIds.length) throw new DomainError('agent_scope_invalid', 'Workspace scope does not accept a project list', 400);
  const coreScope = new CoreScope(member, workspaceId);
  const authorized = workspace.items({ entity: 'project', archived: 'exclude' })
    .filter(record => coreScope.allows(record) && !record.stale && !record.error).map(record => record.id);
  const selected = input.kind === 'workspace' ? authorized : [...new Set(input.projectIds)];
  if (input.kind === 'workspace' && authorized.length > 1000) throw new DomainError('agent_scope_too_large', 'Choose a smaller explicit project scope', 400);
  if (input.kind === 'projects' && !selected.length) throw new DomainError('agent_scope_required', 'Select at least one authorized project', 400);
  if (selected.some(id => !authorized.includes(id))) throw new DomainError('not_found_or_forbidden', 'One or more selected projects are unavailable', 404);
  return { kind: input.kind, projectIds: selected };
}

/**
 * Read-only change preview for Agent Chat. Every request re-authenticates, re-reads the Markdown core and
 * returns a proposed `PmChangeSet`; no command, receipt, journal entry or file write is produced.
 */
export function registerAgentPreviewRoutes(app: FastifyInstance, options: {
  database: () => Pool;
  actor: (request: FastifyRequest) => Promise<Actor>;
  coreWorkspaces: CoreWorkspacePool | undefined;
}): void {
  app.post('/api/v1/workspaces/:workspaceId/agent-tools/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { workspaceId } = z.object({ workspaceId: z.uuid().toLowerCase() }).parse(request.params);
    const input = previewRequestSchema.parse(request.body);
    const actor = await options.actor(request);
    const member = await getMembership(options.database(), actor, workspaceId);
    if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
    const tool = AGENT_CHAT_TOOL_REGISTRY.find(item => item.name === input.name);
    if (!tool) throw new DomainError('agent_tool_not_available', 'This tool is not registered', 403);
    if (!options.coreWorkspaces) throw new DomainError('backend_not_initialized', 'The Markdown core is unavailable', 503);
    const workspace = await options.coreWorkspaces.get(workspaceId);
    const scope = resolveScope(member, workspaceId, workspace, input.scope);
    parseAgentChatToolInput(tool.name, input.arguments);
    if (!tool.write) throw new DomainError('preview_not_supported', 'This read-only tool has no change to preview', 400);
    return preview(tool.name, input.arguments, workspace, scope);
  });
}
