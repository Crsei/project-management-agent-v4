import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor, Command, CommandReceipt } from '../../../packages/domain/src/core.ts';
import { DomainError } from '../../../packages/domain/src/core.ts';
import type { TaskCommentsOptions, TaskCommentsPage } from '../../../packages/domain/src/task-comments.ts';
import type { AgentChatContextSource, AgentChatToolEntity, AgentChatToolComment, AgentChatToolRelation, AgentChatToolReceipt, AgentChatToolResult } from '../../../packages/contracts/src/agent-chat.ts';
import { AGENT_CHAT_TOOL_REGISTRY, agentChatToolDefinitions, parseAgentChatToolInput, assertAgentToolNotAborted, assertAgentToolRecord, assertAgentToolProject, assertAgentToolOrdinaryMutation, agentToolProjectId, type AgentChatToolContext, type AgentChatToolName, type AgentChatToolInput } from '../../../packages/application/src/agent-chat-tools.ts';
import { requestHash } from '../../../packages/application/src/kernel.ts';
import { assertTaskCreationProject } from '../../../packages/application/src/core-task-creation.ts';
import type { WorkspaceMutationGuard, Workspace } from '../../../packages/pm-core/index.ts';
import { WorkspaceError } from '../../../packages/pm-core/index.ts';
import type { FileRecord } from '../../../packages/pm-schema/index.ts';
import { statusCategory, workflowFor } from '../../../packages/pm-schema/index.ts';
import { relationFields } from '../../../packages/pm-schema/relations.ts';
import { inspectFrontmatter, patchMarkdown, titleLineIndex } from '../../../packages/pm-markdown/index.ts';
import { CoreWorkspacePool, authorizeCoreScope, executeAuditedCoreMutation, recoverAuditedCoreMutation, nativeCommandId } from './core-routes.ts';
import { coreVersion, replaceBody, updateWorkItemRaw } from './core-adapter.ts';

export type { AgentChatToolContext, AgentChatToolName } from '../../../packages/application/src/agent-chat-tools.ts';
export type AgentChatToolsOptions = {
  database: () => Pool;
  coreWorkspaces: CoreWorkspacePool;
  executeCommand: (actor: Actor, workspaceId: string, command: Command, checkAuthorization?: AgentChatToolContext['checkAuthorization']) => Promise<CommandReceipt>;
  readCommandReceipt: (actor: Actor, workspaceId: string, command: Command) => Promise<CommandReceipt | null>;
  readComments: (actor: Actor, workspaceId: string, taskId: string, options: TaskCommentsOptions) => Promise<TaskCommentsPage>;
  localProjects: { enabled: boolean; defaultParent: string | null };
};
export type AgentChatToolAvailability = {
  name: AgentChatToolName; description: string; write: boolean;
  capabilities: typeof AGENT_CHAT_TOOL_REGISTRY[number]['capabilities'];
  available: boolean; denyReason: string | null;
};
export type AgentChatTools = {
  definitions: typeof agentChatToolDefinitions;
  registry: AgentChatToolAvailability[];
  availableToolNames: AgentChatToolName[];
  execute(name: string, input: unknown, context: AgentChatToolContext): Promise<AgentChatToolResult>;
  recover(name: string, input: unknown, context: AgentChatToolContext): Promise<AgentChatToolResult | null>;
};
type NativeIdentity = { action: string; input: Record<string, unknown>; targetId?: string };
type NativeRequest = NativeIdentity & { before?: FileRecord; mutate: (key: string | undefined, guard: WorkspaceMutationGuard, prepared: (record: FileRecord) => void) => Promise<FileRecord> };
const entityKinds: Readonly<Record<string, true>> = { project: true, work_item: true, document: true };
const toolName = (value: string): AgentChatToolName => {
  if (!AGENT_CHAT_TOOL_REGISTRY.some(tool => tool.name === value)) throw new DomainError('agent_tool_not_available', 'This tool is not registered', 403);
  return value as AgentChatToolName;
};
const resultKind = (record: FileRecord): 'project' | 'task' | 'document' => record.entity.entity === 'work_item' ? 'task' : record.entity.entity === 'project' ? 'project' : 'document';
function ensureReadable(record: FileRecord): FileRecord {
  if (record.stale || record.error || record.diagnostics?.some(issue => issue.severity === 'error')) throw new DomainError('agent_context_unavailable', 'The authoritative source is stale or invalid; repair it in the native PM interface', 409);
  return record;
}
function entityItem(record: FileRecord, includeFields = true): AgentChatToolEntity {
  return { id: record.id, entity: record.entity.entity as AgentChatToolEntity['entity'], projectId: record.entity.entity === 'project' ? null : agentToolProjectId(record.entity) ?? null,
    title: record.entity.title.slice(0, 300), revision: record.revision, version: coreVersion(record.revision), status: record.entity.status ?? null,
    ...(includeFields ? { fields: { goal: typeof record.entity.goal === 'string' ? record.entity.goal.slice(0, 4000) : null,
      assigneeId: typeof record.entity.assignee === 'string' ? record.entity.assignee : null,
      priority: record.entity.priority ?? null, startDate: record.entity.entity === 'work_item' ? record.entity['x-pm-start'] ?? null : record.entity.start ?? null,
      dueDate: record.entity.due ?? null, labels: record.entity.labels.slice(0, 30).map(label => label.slice(0, 80)) } } : {}) };
}
function source(context: AgentChatToolContext, record: FileRecord, truncated = false): AgentChatContextSource {
  return { kind: entityKinds[record.entity.entity] ? resultKind(record) : 'relation', workspaceId: context.workspaceId,
    projectId: agentToolProjectId(record.entity) ?? null, entityId: record.id, title: record.entity.title.slice(0, 160), revision: record.revision,
    truncated: truncated || record.entity.title.length > 300 || typeof record.entity.goal === 'string' && record.entity.goal.length > 4000 || record.entity.labels.length > 30 || record.entity.labels.some(label => label.length > 80) };
}
function entityResult(context: AgentChatToolContext, record: FileRecord, receipt?: AgentChatToolReceipt): AgentChatToolResult {
  const provenance = source(context, record);
  return { kind: resultKind(record), items: [entityItem(record)], nextCursor: null, truncated: provenance.truncated, sources: [provenance], ...(receipt ? { receipt } : {}) };
}
function commandFailure(receipt: CommandReceipt): void {
  if (receipt.status !== 'committed') throw new DomainError(receipt.error?.code ?? 'agent_tool_rejected', receipt.error?.message ?? 'The native command was rejected', receipt.httpStatus);
}
function commandReceipt(context: AgentChatToolContext, receipt: CommandReceipt, action: string, targetId: string | null, revision: string | null): AgentChatToolReceipt {
  return { kind: 'command', operationId: context.operationId, commandId: receipt.commandId, action, targetId, revision };
}
function nativeReceipt(context: AgentChatToolContext, request: Pick<NativeRequest, 'action' | 'targetId'>, record: FileRecord, originalRevision = record.revision): AgentChatToolReceipt {
  return { kind: 'core', operationId: context.operationId, commandId: nativeCommandId(context.workspaceId, context.actor.id, request.action, request.targetId, context.operationId), action: request.action, targetId: record.id, revision: originalRevision };
}

function nativeIdentity(name: AgentChatToolName, input: unknown): NativeIdentity {
  if (name === 'pm_create_task') {
    const args = parseAgentChatToolInput(name, input);
    const value: Record<string, unknown> = { entity: 'work_item', project: args.projectId, title: args.title, body: args.description };
    if (args.assigneeId) value.assignee = args.assigneeId;
    if (args.priority) value.priority = args.priority;
    if (args.startDate) value['x-pm-start'] = args.startDate;
    if (args.dueDate) value.due = args.dueDate;
    if (args.labels) value.labels = args.labels;
    return { action: 'CreateCoreEntity', input: value };
  }
  if (name === 'pm_create_document') {
    const args = parseAgentChatToolInput(name, input);
    return { action: 'CreateCoreEntity', input: { entity: 'document', project: args.projectId, title: args.title, body: args.body } };
  }
  if (name === 'pm_save_document') {
    const args = parseAgentChatToolInput(name, input);
    return { action: 'UpdateCoreSource', targetId: args.id, input: { revision: args.revision, body: args.body } };
  }
  if (name === 'pm_update_project' || name === 'pm_update_task') {
    const args = parseAgentChatToolInput(name, input);
    return { action: 'UpdateCoreSource', targetId: args.id, input: { ...args } };
  }
  if (name === 'pm_add_relation' || name === 'pm_remove_relation') {
    const args = parseAgentChatToolInput(name, input);
    return { action: 'UpdateCoreProperties', targetId: args.sourceId, input: { ...args } };
  }
  throw new DomainError('agent_tool_not_available', 'This tool is not a native mutation', 403);
}

function creationCommand(name: 'pm_create_project' | 'pm_create_comment', input: unknown, context: AgentChatToolContext, localProjects: AgentChatToolsOptions['localProjects'], projectId?: string): Command {
  if (name === 'pm_create_project') {
    const args = parseAgentChatToolInput(name, input);
    return { commandId: context.operationId, commandType: 'CreateProject', payload: { name: args.title, description: args.description, goal: args.goal ?? '', ownerId: null, completionCriteria: [],
      ...(localProjects.enabled ? { localDirectory: { mode: 'new', parentPath: localProjects.defaultParent!, folderName: `agent-${context.operationId}` } } : {}) } };
  }
  const args = parseAgentChatToolInput(name, input);
  return { commandId: context.operationId, commandType: 'CreateTaskComment', projectId: projectId!, targetId: args.taskId, payload: { content: args.content } };
}

/** There is no HTTP impersonation or business SQL here: every write uses the existing native service. */
export function createAgentChatTools(options: AgentChatToolsOptions): AgentChatTools {
  const registry = AGENT_CHAT_TOOL_REGISTRY.map(tool => ({ ...tool,
    available: tool.name !== 'pm_create_project' || !options.localProjects.enabled || !!options.localProjects.defaultParent,
    denyReason: tool.name === 'pm_create_project' && options.localProjects.enabled && !options.localProjects.defaultParent ? 'local_project_directory_required' : null,
  }));
  const availableToolNames = registry.filter(tool => tool.available).map(tool => tool.name);
  const definitions = agentChatToolDefinitions.filter(definition => availableToolNames.includes(definition.function.name));

  async function environment(context: AgentChatToolContext, dispatch = true) {
    if (dispatch) assertAgentToolNotAborted(context);
    if (!z.uuid().safeParse(context.operationId).success) throw new DomainError('agent_tool_invalid_operation', 'A trusted UUID operation identity is required', 400);
    const scope = await authorizeCoreScope(options.database(), context.actor, context.workspaceId, 'domain.read');
    const workspace = await options.coreWorkspaces.get(context.workspaceId);
    const read = (id: string, expected?: string): FileRecord => {
      const record = ensureReadable(workspace.get(id));
      scope.entity(record);
      assertAgentToolRecord(context.scope, record);
      if (expected && record.entity.entity !== expected) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible as this tool target', 404);
      return record;
    };
    return { scope, workspace, read };
  }

  function guardFor(context: AgentChatToolContext, workspace: Workspace): WorkspaceMutationGuard {
    return (before, after) => {
      assertAgentToolNotAborted(context);
      if (before) assertAgentToolRecord(context.scope, before);
      assertAgentToolProject(context.scope, agentToolProjectId(after));
      assertAgentToolOrdinaryMutation(before, after);
      if (!before && ['completed', 'canceled'].includes(statusCategory(after, workspace.configuration().config) ?? '')) throw new DomainError('agent_tool_protected_action', 'The configured initial state is terminal and cannot be created by this tool', 403);
      if (after.entity !== 'project') {
        const project = ensureReadable(workspace.get(String(after.project)));
        assertAgentToolRecord(context.scope, project);
        assertTaskCreationProject(project, workspace.configuration().config);
      }
    };
  }

  function nativeRequest(name: AgentChatToolName, input: unknown, workspace: Workspace, read: (id: string, expected?: string) => FileRecord): NativeRequest {
    const identity = nativeIdentity(name, input);
    if (name === 'pm_create_task') {
      const args = parseAgentChatToolInput(name, input);
      read(args.projectId, 'project');
      return { ...identity, mutate: (key, guard, prepared) => workspace.createEntity(identity.input, key, guard, prepared) };
    }
    if (name === 'pm_create_document') {
      const args = parseAgentChatToolInput(name, input);
      read(args.projectId, 'project');
      return { ...identity, mutate: (key, guard, prepared) => workspace.createEntity(identity.input, key, guard, prepared) };
    }
    if (name === 'pm_save_document') {
      const args = parseAgentChatToolInput(name, input), before = read(args.id, 'document');
      const previousBody = inspectFrontmatter(before.raw).body;
      const candidate = before.raw.slice(0, before.raw.length - previousBody.length) + args.body;
      const raw = titleLineIndex(candidate) === undefined ? replaceBody(before.raw, args.body) : candidate;
      return { ...identity, before,
        mutate: (_key, guard) => workspace.save(args.id, raw, args.revision, guard) };
    }
    if (name === 'pm_update_project' || name === 'pm_update_task') {
      const args = parseAgentChatToolInput(name, input), before = read(args.id, name === 'pm_update_project' ? 'project' : 'work_item');
      const changes: Record<string, unknown> = {};
      if (args.title !== null) changes.title = args.title;
      if (args.startDate !== null) changes[name === 'pm_update_project' ? 'start' : 'x-pm-start'] = args.startDate || null;
      if (args.dueDate !== null) changes.due = args.dueDate || null;
      let raw = before.raw;
      if (name === 'pm_update_project') {
        const project = args as AgentChatToolInput<'pm_update_project'>;
        if (project.goal !== null) changes.goal = project.goal || null;
        if (project.description !== null) raw = replaceBody(raw, project.description);
      } else {
        const task = args as AgentChatToolInput<'pm_update_task'>;
        if (task.assigneeId !== null) changes.assignee = task.assigneeId || null;
        if (task.priority !== null) changes.priority = task.priority;
        if (task.labels !== null) changes.labels = task.labels;
        if (task.description !== null) {
          raw = updateWorkItemRaw(before, task.title ?? before.entity.title, task.description, before.entity.checklist.map(item => ({ text: item.text })));
          delete changes.title;
        }
      }
      if (Object.keys(changes).length) raw = patchMarkdown(raw, changes, workspace.configuration().config);
      return { ...identity, before,
        mutate: (_key, guard) => workspace.save(args.id, raw, args.revision, guard) };
    }
    if (name === 'pm_add_relation' || name === 'pm_remove_relation') {
      const args = parseAgentChatToolInput(name, input), before = read(args.sourceId), target = read(args.targetId);
      const definition = relationFields(workspace.configuration().config).find(field => field.name === args.relation && field.entities.includes(before.entity.entity));
      if (!definition) throw new DomainError('agent_tool_invalid_relation', 'This relation is not defined for the source entity', 400);
      const prior = before.entity[args.relation];
      const values = Array.isArray(prior) ? prior.filter((value): value is string => typeof value === 'string') : typeof prior === 'string' ? [prior] : [];
      if (!definition.multiple && name === 'pm_add_relation' && values.length && !values.includes(args.targetId)) throw new DomainError('agent_tool_relation_exists', 'Remove the existing single-target relation explicitly before replacing it', 409);
      const next = name === 'pm_add_relation' ? [...new Set([...values, args.targetId])] : values.filter(value => value !== args.targetId);
      const changes = { [args.relation]: definition.multiple ? next : next[0] ?? null };
      return { ...identity, before,
        mutate: (_key, guard) => workspace.patch(before.id, changes, args.revision, async (previous, after) => {
          const currentTarget = read(target.id);
          if (currentTarget.revision !== args.targetRevision) throw new DomainError('version_conflict', 'The related endpoint revision changed', 409);
          // Check both the named endpoint and every prior/new value affected by the list rewrite.
          for (const endpoint of new Set([...values, ...next])) read(endpoint);
          await guard(previous, after);
        }) };
    }
    throw new DomainError('agent_tool_not_available', 'This tool does not use the native mutation service', 403);
  }

  async function execute(nameValue: string, input: unknown, context: AgentChatToolContext): Promise<AgentChatToolResult> {
    const name = toolName(nameValue);
    parseAgentChatToolInput(name, input);
    const { scope, workspace, read } = await environment(context);
    if (!availableToolNames.includes(name)) throw new DomainError('local_project_directory_required', 'The native local storage policy requires a trusted default project directory', 409);
    if (name === 'pm_query') {
      const args = parseAgentChatToolInput(name, input);
      if (args.projectId) read(args.projectId, 'project');
      const kinds = args.entity ? [args.entity] : ['project', 'work_item', 'document'] as const;
      const records = kinds.flatMap(entity => workspace.items({ entity, ...(args.query ? { q: args.query } : {}) }))
        .filter(record => entityKinds[record.entity.entity] && (!args.projectId || agentToolProjectId(record.entity) === args.projectId) && scope.allows(record) && context.scope.projectIds.includes(agentToolProjectId(record.entity) ?? ''))
        .sort((left, right) => left.id.localeCompare(right.id));
      const eligible = records.filter(record => !args.after || record.id.localeCompare(args.after) > 0);
      const items = eligible.slice(0, args.limit).map(ensureReadable);
      return { kind: 'query', items: items.map(record => entityItem(record, false)), sources: items.map(record => source(context, record)), nextCursor: eligible.length > items.length ? items.at(-1)?.id ?? null : null, truncated: eligible.length > items.length };
    }
    if (name === 'pm_read') {
      const args = parseAgentChatToolInput(name, input), record = read(args.id);
      if (!entityKinds[record.entity.entity]) throw new DomainError('not_found_or_forbidden', 'This read tool supports projects, tasks and documents', 404);
      const text = record.entity.body, body = text.slice(args.bodyOffset, args.bodyOffset + args.bodyLimit), nextBodyOffset = args.bodyOffset + body.length < text.length ? args.bodyOffset + body.length : null;
      const provenance = source(context, record, nextBodyOffset !== null || args.bodyOffset > 0);
      return { kind: resultKind(record), items: [{ ...entityItem(record), body, bodyOffset: args.bodyOffset, nextBodyOffset }], sources: [provenance], nextCursor: null, truncated: provenance.truncated };
    }
    if (name === 'pm_read_comments') {
      const args = parseAgentChatToolInput(name, input), task = read(args.taskId, 'work_item'), projectId = agentToolProjectId(task.entity)!;
      const page = await options.readComments(context.actor, context.workspaceId, task.id, { projectId, limit: args.limit, ...(args.after ? { after: args.after } : {}) });
      if (page.taskId !== task.id || page.projectId !== projectId || page.items.some(comment => comment.taskId !== task.id || comment.projectId !== projectId || comment.workspaceId !== context.workspaceId || (comment.content?.length ?? 0) > 16000)) throw new DomainError('agent_context_unavailable', 'The native comment page is outside the expected scope or content bounds', 503);
      let size = 0;
      const comments = page.items;
      const items: AgentChatToolComment[] = [];
      for (const comment of comments) {
        const length = comment.content?.length ?? 0;
        if (items.length && size + length > 16000) break;
        items.push({ id: comment.id, taskId: comment.taskId, projectId: comment.projectId, content: comment.content, version: comment.version, deletedAt: comment.deletedAt });
        size += length;
      }
      const nextCursor = items.length < comments.length ? items.at(-1)?.id ?? args.after : page.nextCursor;
      return { kind: 'comment', items, nextCursor, truncated: nextCursor !== null, sources: items.map(comment => ({ kind: 'comment', workspaceId: context.workspaceId, projectId, entityId: comment.id, title: 'Task comment', revision: String(comment.version), truncated: false })) };
    }
    if (name === 'pm_read_relations') {
      const args = parseAgentChatToolInput(name, input);
      const center = read(args.id);
      const graph = workspace.graph({ centerId: center.id, depth: 1, archived: 'include' }, record => scope.allows(record) && context.scope.projectIds.includes(agentToolProjectId(record.entity) ?? ''));
      const edges = graph.links.filter(link => link.source === center.id || link.target === center.id).filter(link => link.kind !== 'link')
        .filter(link => !args.after || link.id > args.after).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const selected = edges.slice(0, args.limit);
      const records = new Map<string, FileRecord>();
      const items: AgentChatToolRelation[] = selected.map(link => {
        const from = read(link.source), to = read(link.target); records.set(from.id, from); records.set(to.id, to);
        return { sourceId: from.id, targetId: to.id, relation: link.kind, sourceRevision: from.revision, targetRevision: to.revision };
      });
      return { kind: 'relation', items, nextCursor: edges.length > items.length ? selected.at(-1)!.id : null, truncated: edges.length > items.length, sources: [...records.values()].map(record => source(context, record)) };
    }
    if (name === 'pm_create_project') {
      parseAgentChatToolInput(name, input);
      if (context.scope.kind !== 'workspace' || !scope.unrestricted) throw new DomainError('agent_tool_workspace_scope_required', 'Project creation requires an explicit workspace grant and native workspace permission', 403);
      const workflow = workflowFor('project', workspace.configuration().config);
      if (workflow?.states.some(state => state.id === workflow.initial && ['completed', 'canceled'].includes(state.category))) throw new DomainError('agent_tool_protected_action', 'The configured initial project state is terminal', 403);
      assertAgentToolNotAborted(context);
      await context.checkAuthorization?.(options.database());
      const command = creationCommand(name, input, context, options.localProjects);
      const receipt = await options.executeCommand(context.actor, context.workspaceId, command, context.checkAuthorization);
      commandFailure(receipt);
      const result = receipt.result as { id?: unknown } | undefined;
      if (typeof result?.id !== 'string') throw new DomainError('command_outcome_unknown', 'The native creation receipt has no target identity', 503);
      const record = ensureReadable(workspace.get(result.id));
      scope.entity(record);
      return entityResult(context, record, commandReceipt(context, receipt, command.commandType, record.id, record.revision));
    }
    if (name === 'pm_create_comment') {
      const args = parseAgentChatToolInput(name, input), task = read(args.taskId, 'work_item'), projectId = agentToolProjectId(task.entity)!;
      if (args.projectId !== projectId) throw new DomainError('not_found_or_forbidden', 'Task is not in the requested comment project', 404);
      assertAgentToolNotAborted(context);
      await context.checkAuthorization?.(options.database());
      const receipt = await options.executeCommand(context.actor, context.workspaceId, creationCommand(name, input, context, options.localProjects, projectId), context.checkAuthorization);
      commandFailure(receipt);
      return commentResult(context, args, receipt, projectId);
    }
    const request = nativeRequest(name, input, workspace, read);
    assertAgentToolNotAborted(context);
    const record = await executeAuditedCoreMutation({ database: options.database, principal: context.actor, workspace, scope, action: request.action, input: request.input,
      key: context.operationId, mutate: request.mutate, guard: guardFor(context, workspace),
      ...(context.checkAuthorization ? { checkAuthorization: context.checkAuthorization } : {}),
      ...(request.targetId ? { targetId: request.targetId } : {}), ...(request.before ? { before: request.before } : {}) });
    if (!('entity' in record)) throw new DomainError('core_write_outcome_unknown', 'The native write did not return a source record', 503);
    assertAgentToolRecord(context.scope, record);
    const receipt = nativeReceipt(context, request, record);
    if (name === 'pm_add_relation' || name === 'pm_remove_relation') {
      const args = parseAgentChatToolInput(name, input), target = read(args.targetId);
      return { kind: 'relation', items: [{ sourceId: record.id, targetId: target.id, relation: args.relation, sourceRevision: record.revision, targetRevision: target.revision }], nextCursor: null, truncated: false, sources: [source(context, record), source(context, target)], receipt };
    }
    return entityResult(context, record, receipt);
  }

  function commentResult(context: AgentChatToolContext, args: AgentChatToolInput<'pm_create_comment'>, receipt: CommandReceipt, projectId: string): AgentChatToolResult {
    const result = receipt.result as { id?: unknown; taskId?: unknown; projectId?: unknown; version?: unknown } | undefined;
    if (typeof result?.id !== 'string' || result.taskId !== args.taskId || result.projectId !== projectId || typeof result.version !== 'number') throw new DomainError('command_outcome_unknown', 'The comment receipt has no confirmed target/version', 503);
    return { kind: 'comment', items: [{ id: result.id, taskId: args.taskId, projectId, content: args.content, version: result.version, deletedAt: null }], nextCursor: null, truncated: false,
      sources: [{ kind: 'comment', workspaceId: context.workspaceId, projectId, entityId: result.id, title: 'Task comment', revision: String(result.version), truncated: false }],
      receipt: commandReceipt(context, receipt, 'CreateTaskComment', result.id, String(result.version)) };
  }

  /** Inspect the original receipt/key only. Pending writes are never guessed successful or blindly replayed. */
  async function recover(nameValue: string, input: unknown, context: AgentChatToolContext): Promise<AgentChatToolResult | null> {
    const name = toolName(nameValue);
    parseAgentChatToolInput(name, input);
    const { workspace, scope, read } = await environment(context, false);
    if (name === 'pm_create_project' || name === 'pm_create_comment') {
      const args = name === 'pm_create_comment' ? parseAgentChatToolInput(name, input) : null;
      if (args) assertAgentToolProject(context.scope, args.projectId);
      const command = creationCommand(name, input, context, options.localProjects, args?.projectId);
      const receipt = await options.readCommandReceipt(context.actor, context.workspaceId, command);
      if (!receipt) return null;
      if (receipt.status === 'rejected') {
        if (receipt.error?.code.toLowerCase().includes('unknown')) return null;
        throw new DomainError('agent_tool_recovered_rejection', receipt.error?.message ?? 'The original native command was rejected; it was not replayed', 409);
      }
      commandFailure(receipt);
      if (name === 'pm_create_comment') {
        return commentResult(context, parseAgentChatToolInput(name, input), receipt, args!.projectId);
      }
      if (context.scope.kind !== 'workspace' || !scope.unrestricted) throw new DomainError('not_found_or_forbidden', 'Project creation receipt is outside the current scope', 404);
      const result = receipt.result as { id?: unknown } | undefined;
      if (typeof result?.id !== 'string') return null;
      const reference = commandReceipt(context, receipt, 'CreateProject', result.id, null);
      try {
        const record = ensureReadable(workspace.get(result.id)); scope.entity(record);
        return entityResult(context, record, reference);
      } catch (error) {
        if (!(error instanceof DomainError && ['not_found_or_forbidden', 'agent_context_unavailable'].includes(error.code)) && !(error instanceof WorkspaceError && error.status === 404)) throw error;
        return { kind: 'project', items: [], nextCursor: null, truncated: false, sources: [], receipt: reference };
      }
    }
    if (!AGENT_CHAT_TOOL_REGISTRY.find(tool => tool.name === name)?.write) return null;
    const request = nativeIdentity(name, input);
    const commandId = nativeCommandId(context.workspaceId, context.actor.id, request.action, request.targetId, context.operationId);
    const hash = requestHash({ action: request.action, targetId: request.targetId, input: request.input });
    const saved = await recoverAuditedCoreMutation({
      database: options.database, pool: options.coreWorkspaces, principal: context.actor, workspaceId: context.workspaceId, commandId, hash,
      checkProject: projectId => assertAgentToolProject(context.scope, projectId),
    });
    if (!saved || saved.kind === 'http_pending') return null;
    if (saved.kind === 'http_rejected') throw new DomainError('agent_tool_recovered_rejection', 'The original native write was rejected; it was not replayed', 409);
    const receipt: AgentChatToolReceipt = { kind: 'core', operationId: context.operationId, commandId, action: request.action, targetId: saved.targetId, revision: saved.revision };
    let record: FileRecord;
    try { record = read(saved.targetId); }
    catch (error) {
      if (!(error instanceof DomainError && ['not_found_or_forbidden', 'agent_context_unavailable'].includes(error.code)) && !(error instanceof WorkspaceError && error.status === 404)) throw error;
      if (name === 'pm_add_relation' || name === 'pm_remove_relation') return { kind: 'relation', items: [], nextCursor: null, truncated: false, sources: [], receipt };
      const kind = name === 'pm_create_task' || name === 'pm_update_task' ? 'task' : name === 'pm_update_project' ? 'project' : 'document';
      return { kind, items: [], nextCursor: null, truncated: false, sources: [], receipt };
    }
    if (name === 'pm_add_relation' || name === 'pm_remove_relation') {
      const args = parseAgentChatToolInput(name, input);
      let target: FileRecord;
      try { target = read(args.targetId); }
      catch (error) {
        if (!(error instanceof DomainError && ['not_found_or_forbidden', 'agent_context_unavailable'].includes(error.code)) && !(error instanceof WorkspaceError && error.status === 404)) throw error;
        return { kind: 'relation', items: [], nextCursor: null, truncated: false, sources: [], receipt };
      }
      return { kind: 'relation', items: [{ sourceId: record.id, targetId: target.id, relation: args.relation, sourceRevision: record.revision, targetRevision: target.revision }], nextCursor: null, truncated: false, sources: [source(context, record), source(context, target)], receipt };
    }
    return entityResult(context, record, receipt);
  }
  return { definitions, registry, availableToolNames, execute, recover };
}
