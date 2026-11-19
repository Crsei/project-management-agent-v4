import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor, Capability, Command, CommandReceipt } from '../../../../packages/domain/src/core.ts';
import { DomainError } from '../../../../packages/domain/src/core.ts';
import { taskCommentAgentOriginSchema, type TaskCommentsOptions, type TaskCommentsPage } from '../../../../packages/domain/src/task-comments.ts';
import type { AgentChatContextSource, AgentChatToolEntity, AgentChatToolComment, AgentChatToolRelation, AgentChatToolReceipt, AgentChatToolResult } from '../../../../packages/agent-contracts/src/pm-tool-result.ts';
import { agentChatToolResultSchema, agentChatToolFieldValueSchema } from '../../../../packages/agent-contracts/src/pm-tool-result.ts';
import { pmCoreMigrationSummarySchema } from '../../../../packages/agent-contracts/src/pm-tool-core.ts';
import type { PmToolApprovalAuthorityFacts } from '../../../../packages/agent-contracts/src/pm-tools.ts';
import { AGENT_CHAT_TOOL_REGISTRY, agentChatToolDefinitions, parseAgentChatToolInput, assertAgentToolNotAborted, assertAgentToolRecord, assertAgentToolProject, assertAgentToolOrdinaryMutation, assertAgentToolLifecycleMutation, agentToolProjectId, type AgentChatToolContext, type AgentChatToolName, type AgentChatToolInput } from '../../../../packages/application/src/agent-chat-tools.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import { getMembership } from '../../../../packages/application/src/access.ts';
import { assertTaskCreationProject } from '../../../../packages/application/src/core-task-creation.ts';
import type { WorkspaceMutationGuard, Workspace } from '../../../../packages/pm-core/index.ts';
import { WorkspaceError } from '../../../../packages/pm-core/index.ts';
import type { FileRecord, ProtocolConfiguration } from '../../../../packages/pm-schema/index.ts';
import { entityKinds as nativeEntityKinds, fieldRegistry, statusCategory, viewConfigOf, workflowFor } from '../../../../packages/pm-schema/index.ts';
import { relationFields } from '../../../../packages/pm-schema/relations.ts';
import { inspectFrontmatter, patchMarkdown, titleLineIndex } from '../../../../packages/pm-markdown/index.ts';
import { CoreWorkspacePool, authorizeCoreScope, executeAuditedCoreMutation, recoverAuditedCoreMutation, nativeCommandId } from './core-routes.ts';
import { coreVersion, replaceBody, updateWorkItemRaw } from './core-adapter.ts';
import { CoreCommandJournal } from './core-journal.ts';
import { lockWorkspace } from '../../../../packages/infrastructure/src/database.ts';
import type { MigrationPlan, MigrationResult } from '../../../../packages/pm-core/migrations.ts';
import { readTaskBrief, searchTaskKnowledge, TaskBriefReadRejection } from '../../../../packages/application/src/task-brief.ts';
import { taskBriefReadContext } from './task-brief-routes.ts';
import { documentsFilesRecoveryIdentitySchema } from './agent-tool-documents-files.ts';
import { automationToolRecoveryIdentitySchema } from './agent-tool-automation.ts';
import { integrationsToolRecoveryIdentitySchema } from '../../../../packages/agent-contracts/src/pm-tool-integrations.ts';
import { isCoreAgentChatTool } from '../../../../packages/application/src/agent-chat-tools.ts';

/** No argument text: retained original native identity used only for status inspection. */
export const agentToolRecoveryIdentitySchema = z.union([
  z.strictObject({
    kind: z.enum(['command', 'core']), commandId: z.string().min(1).max(200),
    hash: z.string().regex(/^[a-f0-9]{64}$/), action: z.string().min(1).max(100),
  }),
  documentsFilesRecoveryIdentitySchema,
  automationToolRecoveryIdentitySchema,
  integrationsToolRecoveryIdentitySchema,
]);
export type AgentToolRecoveryIdentity = z.infer<typeof agentToolRecoveryIdentitySchema>;
export type AgentToolOutcomeProof = { status: 'succeeded' | 'failed' | 'unknown'; evidence: 'command_receipt' | 'native_journal' | 'application_receipt' | 'unresolved' };
/** Only application-owned evidence, never an arbitrary HTTP class, proves a read rejection. */
export class AgentToolAuthoritativeReadRejection extends DomainError {}
/** The native permission check rejected this original request before any mutation service was dispatched. */
export class AgentToolPreDispatchRejection extends DomainError {}
export type AgentChatToolFamily = {
  names: readonly AgentChatToolName[];
  execute(name: AgentChatToolName, input: unknown, context: AgentChatToolContext): Promise<AgentChatToolResult>;
  recover(name: AgentChatToolName, input: unknown, context: AgentChatToolContext): Promise<AgentChatToolResult | null>;
  recoveryIdentity(name: AgentChatToolName, input: unknown, context: AgentChatToolContext): AgentToolRecoveryIdentity | null;
  inspectOutcome?(identity: AgentToolRecoveryIdentity, actorId: string, workspaceId: string): Promise<AgentToolOutcomeProof>;
  authorizeResult?(name: AgentChatToolName, input: unknown, result: AgentChatToolResult, context: AgentChatToolContext): Promise<void>;
};

export type { AgentChatToolContext, AgentChatToolName } from '../../../../packages/application/src/agent-chat-tools.ts';
export type AgentChatToolsOptions = {
  database: () => Pool;
  coreWorkspaces: CoreWorkspacePool;
  executeCommand: (actor: Actor, workspaceId: string, command: Command, checkAuthorization?: AgentChatToolContext['checkAuthorization']) => Promise<CommandReceipt>;
  readCommandReceipt: (actor: Actor, workspaceId: string, command: Command) => Promise<CommandReceipt | null>;
  readComments: (actor: Actor, workspaceId: string, taskId: string, options: TaskCommentsOptions) => Promise<TaskCommentsPage>;
  localProjects: { enabled: boolean; defaultParent: string | null };
  families?: readonly AgentChatToolFamily[];
};
export type AgentChatToolAvailability = {
  name: AgentChatToolName; description: string; write: boolean;
  capabilities: typeof AGENT_CHAT_TOOL_REGISTRY[number]['capabilities'];
  scope: typeof AGENT_CHAT_TOOL_REGISTRY[number]['scope'];
  available: boolean; denyReason: string | null;
};
export type AgentChatTools = {
  definitions: typeof agentChatToolDefinitions;
  registry: AgentChatToolAvailability[];
  availableToolNames: AgentChatToolName[];
  execute(name: string, input: unknown, context: AgentChatToolContext): Promise<AgentChatToolResult>;
  recover(name: string, input: unknown, context: AgentChatToolContext): Promise<AgentChatToolResult | null>;
  recoveryIdentity(name: string, input: unknown, context: AgentChatToolContext): AgentToolRecoveryIdentity | null;
  inspectOutcome(identity: AgentToolRecoveryIdentity, actorId: string, workspaceId: string): Promise<AgentToolOutcomeProof>;
  authorizeResult(name: string, input: unknown, result: AgentChatToolResult, context: AgentChatToolContext): Promise<void>;
  approvalAuthority(name: string, input: unknown, context: AgentChatToolContext): Promise<PmToolApprovalAuthorityFacts>;
};
type NativeIdentity = { action: string; input: Record<string, unknown>; targetId?: string };
type NativeMutation = FileRecord | { id: string; deleted: true };
type NativeRequest = NativeIdentity & { before?: FileRecord; mutate: (key: string | undefined, guard: WorkspaceMutationGuard, prepared: (record: FileRecord) => void) => Promise<NativeMutation> };
const lifecycleToolNames = ['pm_archive_task', 'pm_restore_task', 'pm_delete_task', 'pm_transition_task', 'pm_archive_entity', 'pm_restore_entity', 'pm_delete_entity', 'pm_transition_entity'] as const;
const administrationTools: readonly AgentChatToolName[] = ['pm_list_views', 'pm_read_view', 'pm_query_view', 'pm_save_view', 'pm_read_configuration', 'pm_save_configuration', 'pm_list_migrations', 'pm_read_migration', 'pm_preview_migration', 'pm_apply_migration', 'pm_restore_migration'];
type LifecycleToolName = typeof lifecycleToolNames[number];
const isLifecycleTool = (name: AgentChatToolName): name is LifecycleToolName => (lifecycleToolNames as readonly string[]).includes(name);
const toolName = (value: string): AgentChatToolName => {
  if (!AGENT_CHAT_TOOL_REGISTRY.some(tool => tool.name === value)) throw new DomainError('agent_tool_not_available', 'This tool is not registered', 403);
  return value as AgentChatToolName;
};
const resultKind = (record: FileRecord): Exclude<FileRecord['entity']['entity'], 'work_item'> | 'task' => record.entity.entity === 'work_item' ? 'task' : record.entity.entity;
function ensureReadable(record: FileRecord): FileRecord {
  if (record.stale || record.error || record.diagnostics?.some(issue => issue.severity === 'error')) throw new DomainError('agent_context_unavailable', 'The authoritative source is stale or invalid; repair it in the native PM interface', 409);
  return record;
}
function entityItem(record: FileRecord, includeFields = true): AgentChatToolEntity {
  return { id: record.id, entity: record.entity.entity, projectId: record.entity.entity === 'project' ? null : agentToolProjectId(record.entity) ?? null,
    title: record.entity.title.slice(0, 300), revision: record.revision, version: coreVersion(record.revision), status: record.entity.status ?? null, archived: record.entity.archived ?? false,
    ...(includeFields ? { fields: { goal: typeof record.entity.goal === 'string' ? record.entity.goal.slice(0, 4000) : null,
      assigneeId: typeof record.entity.assignee === 'string' ? record.entity.assignee : null,
      priority: record.entity.priority ?? null, startDate: record.entity.entity === 'work_item' ? record.entity['x-pm-start'] ?? null : record.entity.start ?? null,
      dueDate: record.entity.due ?? null, labels: record.entity.labels.slice(0, 30).map(label => label.slice(0, 80)) },
      properties: Object.entries(record.entity).flatMap(([field, value]) => {
        if (!fieldRegistry.some(definition => definition.name === field && definition.editable) && !field.startsWith('x-')) return [];
        const parsed = agentChatToolFieldValueSchema.safeParse(value);
        return parsed.success ? [{ field, value: parsed.data }] : [];
      }).slice(0, 200) } : {}) };
}
function validateFields(kind: FileRecord['entity']['entity'], changes: AgentChatToolInput<'pm_update_entity'>['fields'], workspace: Workspace, read: (id: string) => FileRecord): void {
  const configuration = workspace.configuration().config;
  for (const { field, value } of changes) {
    const native = fieldRegistry.find(definition => definition.name === field);
    const custom = configuration.custom_fields.find(definition => definition.name === field);
    if (['schema', 'id', 'entity', 'project', 'status', 'archived', 'body'].includes(field) || (!native && !custom) || native && (!native.editable || !native.entities.includes(kind)) || custom && !custom.entities.includes(kind))
      throw new DomainError('agent_tool_protected_action', 'Only applicable ordinary native or configured fields may be changed', 403);
    const relation = relationFields(configuration).find(definition => definition.name === field && definition.entities.includes(kind));
    if (relation) for (const id of Array.isArray(value) ? value : typeof value === 'string' ? [value] : []) read(id);
  }
}
function source(context: AgentChatToolContext, record: FileRecord, truncated = false): AgentChatContextSource {
  return { kind: record.entity.entity === 'work_item' ? 'task' : record.entity.entity, workspaceId: context.workspaceId,
    projectId: agentToolProjectId(record.entity) ?? null, entityId: record.id, title: record.entity.title.slice(0, 160), revision: record.revision,
    truncated: truncated || record.entity.title.length > 300 || typeof record.entity.goal === 'string' && record.entity.goal.length > 4000 || record.entity.labels.length > 30 || record.entity.labels.some(label => label.length > 80) };
}

/** Top-level brief metadata has no positional link to the locator-bearing inner sources. Preserve its first full-value occurrence. */
export function deduplicateBriefContextSources(sources: readonly AgentChatContextSource[]): AgentChatContextSource[] {
  const seen = new Set<string>(), distinct: AgentChatContextSource[] = [];
  for (const item of sources) {
    const key = JSON.stringify(item, Object.keys(item).sort());
    if (seen.has(key)) continue;
    seen.add(key); distinct.push(item);
  }
  return distinct;
}
function entityResult(context: AgentChatToolContext, record: FileRecord, receipt?: AgentChatToolReceipt): AgentChatToolResult {
  const provenance = source(context, record);
  return { kind: resultKind(record), items: [entityItem(record)], nextCursor: null, truncated: provenance.truncated, sources: [provenance], ...(receipt ? { receipt } : {}) };
}
function commandFailure(receipt: CommandReceipt): void {
  if (receipt.status !== 'committed') throw new DomainError(receipt.error?.code ?? 'agent_tool_rejected', receipt.error?.message ?? 'The native command was rejected', receipt.httpStatus);
}
function commandReceipt(context: AgentChatToolContext, receipt: CommandReceipt, action: string, targetId: string | null, revision: string | null): AgentChatToolReceipt {
  return { kind: 'command', operationId: context.operationId, commandId: receipt.commandId, action, targetId, revision,
    ...(context.linkage ? { linkage: context.linkage } : {}) };
}
function nativeReceipt(context: AgentChatToolContext, request: Pick<NativeRequest, 'action' | 'targetId'>, record: FileRecord, originalRevision = record.revision): AgentChatToolReceipt {
  return { kind: 'core', operationId: context.operationId, commandId: nativeCommandId(context.workspaceId, context.actor.id, request.action, request.targetId, context.operationId), action: request.action, targetId: record.id, revision: originalRevision,
    ...(context.linkage ? { linkage: context.linkage } : {}) };
}
function lifecycleResult(context: AgentChatToolContext, receipt: AgentChatToolReceipt, record?: FileRecord): AgentChatToolResult {
  if (!record) return { kind: 'lifecycle', items: [], nextCursor: null, truncated: false, sources: [], receipt };
  const provenance = source(context, record);
  return { kind: 'lifecycle', items: [entityItem(record)], nextCursor: null, truncated: provenance.truncated, sources: [provenance], receipt };
}
/** Category-based capability, matching the native core: complete, cancel/reopen, otherwise ordinary planning edit. */
function lifecycleCapability(name: LifecycleToolName, input: unknown, configuration: ProtocolConfiguration, before?: FileRecord): Capability {
  if (name !== 'pm_transition_task' && name !== 'pm_transition_entity') return 'planning.lifecycle';
  const args = parseAgentChatToolInput(name, input);
  const kind = before?.entity.entity ?? 'work_item';
  const target = workflowFor(kind, configuration)?.states.find(state => state.id === args.status)?.category;
  const current = before ? statusCategory(before.entity, configuration) : undefined;
  if (kind !== 'work_item') return target === 'completed' || target === 'canceled' || current === 'completed' || current === 'canceled' ? 'planning.lifecycle' : 'planning.edit';
  if (target === 'completed') return 'workitem.complete';
  if (target === 'canceled' || current === 'completed' || current === 'canceled') return 'workitem.cancel_reopen';
  return 'planning.edit';
}
function lifecycleExpectation(name: LifecycleToolName, input: unknown): { archived?: boolean; status?: string } {
  if (name === 'pm_archive_task' || name === 'pm_archive_entity') return { archived: true };
  if (name === 'pm_restore_task' || name === 'pm_restore_entity') return { archived: false };
  if (name === 'pm_transition_task' || name === 'pm_transition_entity') return { status: parseAgentChatToolInput(name, input).status };
  return {};
}

/** Shared with workflow reads: last-good display configuration is not current mutation authority. */
function workflowAuthority(workspace: Workspace, kind: FileRecord['entity']['entity']) {
  const configuration = workspace.configuration();
  if (configuration.diagnostics.some(issue => issue.severity === 'error'))
    throw new DomainError('agent_context_unavailable', 'The current workflow configuration is invalid; repair it in the native PM interface', 409);
  const definition = workflowFor(kind, configuration.config);
  // Documents deliberately have no workflow; preserve that native meaning rather than inventing one.
  return { definition, configuration, workflowRevision: requestHash({ entity: kind, workflow: definition ?? null }) };
}

function nativeIdentity(name: AgentChatToolName, input: unknown): NativeIdentity {
  if (name === 'pm_create_entity') {
    const args = parseAgentChatToolInput(name, input);
    return { action: 'CreateCoreEntity', input: { entity: args.entity, project: args.projectId, title: args.title, body: args.body, ...Object.fromEntries(args.fields.map(({ field, value }) => [field, value])) } };
  }
  if (name === 'pm_update_entity') {
    const args = parseAgentChatToolInput(name, input);
    return { action: 'UpdateCoreProperties', targetId: args.id, input: { revision: args.revision, changes: Object.fromEntries(args.fields.map(({ field, value }) => [field, value])) } };
  }
  if (name === 'pm_save_entity_body' || name === 'pm_save_entity_source') {
    const args = parseAgentChatToolInput(name, input);
    return { action: 'UpdateCoreSource', targetId: args.id, input: { ...args } };
  }
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
  if (name === 'pm_archive_task' || name === 'pm_restore_task' || name === 'pm_delete_task' || name === 'pm_archive_entity' || name === 'pm_restore_entity' || name === 'pm_delete_entity') {
    const args = parseAgentChatToolInput(name, input);
    return { action: name === 'pm_archive_task' || name === 'pm_archive_entity' ? 'ArchiveCoreEntity' : name === 'pm_restore_task' || name === 'pm_restore_entity' ? 'RestoreCoreEntity' : 'DeleteCoreEntity',
      targetId: args.id, input: { revision: args.revision } };
  }
  if (name === 'pm_transition_task' || name === 'pm_transition_entity') {
    const args = parseAgentChatToolInput(name, input);
    return { action: 'UpdateCoreProperties', targetId: args.id, input: { revision: args.revision, changes: { status: args.status } } };
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
  const families = options.families ?? [];
  const familyByName = new Map<AgentChatToolName, AgentChatToolFamily>();
  for (const family of families) for (const name of family.names) {
    if (isCoreAgentChatTool(name) || !AGENT_CHAT_TOOL_REGISTRY.some(tool => tool.name === name) || familyByName.has(name)) throw new Error('PM tool family names must be centrally registered exactly once without overriding core tools');
    familyByName.set(name, family);
  }
  const registry = AGENT_CHAT_TOOL_REGISTRY.map(tool => {
    const missingFamily = !isCoreAgentChatTool(tool.name) && !familyByName.has(tool.name);
    const missingDirectory = tool.name === 'pm_create_project' && options.localProjects.enabled && !options.localProjects.defaultParent;
    return { ...tool, available: !missingFamily && !missingDirectory,
      denyReason: missingFamily ? 'agent_tool_family_unavailable' : missingDirectory ? 'local_project_directory_required' : null };
  });
  const availableToolNames = registry.filter(tool => tool.available).map(tool => tool.name);
  const definitions = agentChatToolDefinitions.filter(definition => availableToolNames.includes(definition.function.name));

  async function environment(context: AgentChatToolContext, dispatch = true) {
    if (dispatch) assertAgentToolNotAborted(context);
    if (!z.uuid().safeParse(context.operationId).success) throw new DomainError('agent_tool_invalid_operation', 'A trusted UUID operation identity is required', 400);
    const scope = await authorizeCoreScope(options.database(), context.actor, context.workspaceId, 'domain.read');
    const workspace = await options.coreWorkspaces.get(context.workspaceId);
    const read = (id: string, expected?: string): FileRecord => {
      let record: FileRecord;
      try { record = ensureReadable(workspace.get(id)); }
      catch (error) {
        const snapshot = workspace.snapshot();
        if (error instanceof WorkspaceError && error.status === 404 && !snapshot.errors.some(issue => issue.severity === 'error') && !snapshot.configurationErrors.some(issue => issue.severity === 'error') && snapshot.unsupportedFiles.length === 0)
          throw new AgentToolAuthoritativeReadRejection('not_found_or_forbidden', 'The requested entity is not accessible', 404);
        throw error;
      }
      try {
        scope.entity(record);
        assertAgentToolRecord(context.scope, record);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'not_found_or_forbidden')
          throw new AgentToolAuthoritativeReadRejection(error.code, error.message, error.status);
        throw error;
      }
      if (expected && record.entity.entity !== expected) throw new AgentToolAuthoritativeReadRejection('not_found_or_forbidden', 'Entity is not accessible as this tool target', 404);
      return record;
    };
    return { scope, workspace, read };
  }

  function approvalAuthorityFacts(name: AgentChatToolName, input: unknown, context: AgentChatToolContext, workspace: Workspace,
    read: (id: string, expected?: string) => FileRecord, current?: FileRecord): PmToolApprovalAuthorityFacts {
    const definition = registry.find(tool => tool.name === name)!;
    if (!definition.available || !isLifecycleTool(name) && name !== 'pm_apply_migration' && name !== 'pm_restore_migration')
      throw new DomainError('agent_tool_approval_unavailable', 'This tool has no native approval authority query', 403);
    const capabilities: Capability[] = [...definition.capabilities];
    let entity: PmToolApprovalAuthorityFacts['entity'] = null;
    let configuration: PmToolApprovalAuthorityFacts['configuration'] = null;
    let migration: PmToolApprovalAuthorityFacts['migration'] = null;
    if (isLifecycleTool(name)) {
      const args = parseAgentChatToolInput(name, input);
      const before = current ?? read(args.id, name.endsWith('_task') ? 'work_item' : undefined);
      if (before.revision !== args.revision) throw new DomainError('version_conflict', 'The original approval entity revision changed', 409);
      entity = { id: before.id, kind: before.entity.entity, revision: before.revision, status: before.entity.status ?? null, archived: before.entity.archived ?? false };
      if (name === 'pm_transition_task' || name === 'pm_transition_entity') {
        const workflow = workflowAuthority(workspace, before.entity.entity);
        configuration = { schema: workflow.configuration.config.schema, revision: workflow.configuration.revision, workflowRevision: workflow.workflowRevision };
        capabilities.push(lifecycleCapability(name, input, workflow.configuration.config, before));
      } else capabilities.push('planning.lifecycle');
    } else {
      const args = parseAgentChatToolInput(name as 'pm_apply_migration' | 'pm_restore_migration', input);
      migration = { id: args.id, revision: args.revision };
    }
    const facts = { capabilities: [...new Set(capabilities)].sort(), entity, configuration, migration };
    return { ...facts, fingerprint: requestHash({ name, arguments: parseAgentChatToolInput(name, input), actorId: context.actor.id,
      workspaceId: context.workspaceId, scope: { kind: context.scope.kind, projectIds: context.scope.kind === 'projects' ? [...context.scope.projectIds].sort() : [] }, ...facts }) };
  }

  async function approvalAuthority(nameValue: string, input: unknown, context: AgentChatToolContext): Promise<PmToolApprovalAuthorityFacts> {
    const name = toolName(nameValue);
    parseAgentChatToolInput(name, input);
    const { scope, workspace, read } = await environment(context, false);
    const definition = registry.find(tool => tool.name === name)!;
    if (definition.scope === 'workspace-admin' && (context.scope.kind !== 'workspace' || !scope.unrestricted))
      throw new DomainError('agent_tool_workspace_scope_required', 'The native operation requires explicit workspace-wide permission', 403);
    const facts = approvalAuthorityFacts(name, input, context, workspace, read);
    if (facts.capabilities.some(capability => !scope.membership.capabilities.includes(capability as Capability)))
      throw new DomainError('permission_denied', 'A current native lifecycle capability is required', 403);
    return facts;
  }

  function assertApprovalAuthority(name: AgentChatToolName, input: unknown, context: AgentChatToolContext, workspace: Workspace,
    read: (id: string, expected?: string) => FileRecord, before?: FileRecord): void {
    if (context.expectedApprovalAuthority && context.expectedApprovalAuthority !== approvalAuthorityFacts(name, input, context, workspace, read, before).fingerprint)
      throw new AgentToolPreDispatchRejection('agent_tool_approval_authority_changed', 'The original approved native authority or workflow meaning changed; no mutation was authorized', 409);
  }

  function guardFor(context: AgentChatToolContext, workspace: Workspace): WorkspaceMutationGuard {
    return (before, after) => {
      assertAgentToolNotAborted(context);
      if (before) assertAgentToolRecord(context.scope, before);
      assertAgentToolProject(context.scope, agentToolProjectId(after));
      assertAgentToolOrdinaryMutation(before, after);
      const configuration = workspace.configuration().config;
      for (const relation of relationFields(configuration).filter(field => field.entities.includes(after.entity))) {
        const previous = before?.entity[relation.name], next = after[relation.name];
        if (JSON.stringify(previous) === JSON.stringify(next)) continue;
        for (const endpoint of new Set([...(Array.isArray(previous) ? previous : typeof previous === 'string' ? [previous] : []), ...(Array.isArray(next) ? next : typeof next === 'string' ? [next] : [])])) {
          if (typeof endpoint !== 'string') continue;
          const target = ensureReadable(workspace.get(endpoint));
          assertAgentToolRecord(context.scope, target);
        }
      }
      if (!before && after.entity === 'work_item' && ['completed', 'canceled'].includes(statusCategory(after, workspace.configuration().config) ?? '')) throw new DomainError('agent_tool_protected_action', 'The configured initial task state is terminal and cannot be created by this tool', 403);
      if (after.entity !== 'project') {
        const project = ensureReadable(workspace.get(String(after.project)));
        assertAgentToolRecord(context.scope, project);
        if (after.entity === 'work_item') assertTaskCreationProject(project, workspace.configuration().config);
      }
    };
  }

  /** Lifecycle writes keep the same project and scope, and change exactly the requested lifecycle field. */
  function lifecycleGuard(context: AgentChatToolContext, workspace: Workspace, expected: { archived?: boolean; status?: string }, checkAuthority: (before: FileRecord) => void): WorkspaceMutationGuard {
    return async (before, after) => {
      assertAgentToolNotAborted(context);
      if (!before) throw new DomainError('agent_tool_protected_action', 'Lifecycle tools operate only on existing native entities', 403);
      assertAgentToolLifecycleMutation(before, after, expected);
      assertAgentToolRecord(context.scope, before);
      assertAgentToolProject(context.scope, agentToolProjectId(after));
      if (after.entity !== 'project') {
        const project = ensureReadable(workspace.get(String(after.project)));
        assertAgentToolRecord(context.scope, project);
      }
      // Runs inside the native serialized mutation, after its refresh and native capability checks.
      checkAuthority(before);
    };
  }

  function lifecycleRequest(name: LifecycleToolName, input: unknown, workspace: Workspace, before: FileRecord): NativeRequest {
    const identity = nativeIdentity(name, input);
    if (name === 'pm_archive_task' || name === 'pm_archive_entity') {
      const args = parseAgentChatToolInput(name, input);
      return { ...identity, before, mutate: (_key, guard) => workspace.archive(args.id, args.revision, guard) };
    }
    if (name === 'pm_restore_task' || name === 'pm_restore_entity') {
      const args = parseAgentChatToolInput(name, input);
      return { ...identity, before, mutate: (_key, guard) => workspace.restore(args.id, args.revision, guard) };
    }
    if (name === 'pm_delete_task' || name === 'pm_delete_entity') {
      const args = parseAgentChatToolInput(name, input);
      // Archive/reference rejection occurs inside the original native journal boundary.
      return { ...identity, before, mutate: () => workspace.delete(args.id, args.revision) };
    }
    const args = parseAgentChatToolInput(name as 'pm_transition_task' | 'pm_transition_entity', input);
    return { ...identity, before, mutate: (_key, guard) => workspace.patch(args.id, { status: args.status }, args.revision, guard) };
  }

  function nativeRequest(name: AgentChatToolName, input: unknown, workspace: Workspace, read: (id: string, expected?: string) => FileRecord): NativeRequest {
    const identity = nativeIdentity(name, input);
    if (name === 'pm_create_entity') {
      const args = parseAgentChatToolInput(name, input);
      read(args.projectId, 'project');
      return { ...identity, mutate: (key, guard, prepared) => {
        validateFields(args.entity, args.fields, workspace, read);
        return workspace.createEntity(identity.input, key, guard, prepared);
      } };
    }
    if (name === 'pm_update_entity') {
      const args = parseAgentChatToolInput(name, input), before = read(args.id);
      return { ...identity, before, mutate: (_key, guard) => {
        validateFields(before.entity.entity, args.fields, workspace, read);
        return workspace.patch(args.id, identity.input.changes as Record<string, unknown>, args.revision, guard);
      } };
    }
    if (name === 'pm_save_entity_body' || name === 'pm_save_entity_source') {
      const args = parseAgentChatToolInput(name, input), before = read(args.id);
      let raw: string;
      if (name === 'pm_save_entity_source') raw = (args as AgentChatToolInput<'pm_save_entity_source'>).raw;
      else {
        const body = (args as AgentChatToolInput<'pm_save_entity_body'>).body, previous = inspectFrontmatter(before.raw).body;
        const candidate = before.raw.slice(0, before.raw.length - previous.length) + body;
        raw = titleLineIndex(candidate) === undefined ? replaceBody(before.raw, body) : candidate;
      }
      return { ...identity, before, mutate: (_key, guard) => workspace.save(args.id, raw, args.revision, async (previous, next) => {
        if (name === 'pm_save_entity_body' && next.title !== before.entity.title) throw new DomainError('agent_tool_protected_action', 'A body save cannot change the entity title', 403);
        await guard(previous, next);
      }) };
    }
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
    const family = familyByName.get(name);
    if (family) return agentChatToolResultSchema.parse(await family.execute(name, input, context));
    if (name === 'pm_task_brief' || name === 'pm_search_knowledge') {
      assertAgentToolNotAborted(context);
      if (!z.uuid().safeParse(context.operationId).success) throw new DomainError('agent_tool_invalid_operation', 'A trusted UUID operation identity is required', 400);
      const snapshot = await taskBriefReadContext(options, context.actor, context.workspaceId, context.scope.projectIds, name === 'pm_task_brief');
      try {
        if (name === 'pm_task_brief') {
          const args = parseAgentChatToolInput(name, input);
          const brief = readTaskBrief(snapshot, args.projectId, args.taskId, { revision: args.revision, stage: args.stage,
            ...(args.bodyOffset !== null ? { bodyOffset: args.bodyOffset } : {}), ...(args.bodyLimit !== null ? { bodyLimit: args.bodyLimit } : {}) });
          const sources = deduplicateBriefContextSources(brief.sources.map(ref => ({ kind: ref.kind === 'work_item' ? 'task' as const : ref.kind,
            workspaceId: ref.workspaceId, projectId: ref.projectId, entityId: ref.entityId, title: ref.title, revision: ref.revision, truncated: brief.truncation.truncated })));
          return { kind: 'task_brief', items: [], brief, sources, nextCursor: null, truncated: brief.truncation.truncated };
        }
        const args = parseAgentChatToolInput('pm_search_knowledge', input);
        const knowledge = searchTaskKnowledge(snapshot, args.projectId, args.taskId, { revision: args.revision, query: args.query, limit: args.limit,
          ...(args.projectIds !== null ? { projectIds: args.projectIds } : {}), ...(args.cursor !== null ? { cursor: args.cursor } : {}) });
        const sources: AgentChatContextSource[] = knowledge.items.map(item => ({ kind: item.source.kind === 'work_item' ? 'task' : item.source.kind,
          workspaceId: item.source.workspaceId, projectId: item.source.projectId, entityId: item.source.entityId, title: item.source.title, revision: item.source.revision, truncated: item.truncation.truncated }));
        return { kind: 'knowledge', items: [], knowledge, sources, nextCursor: knowledge.nextCursor, truncated: knowledge.nextCursor !== null || knowledge.items.some(item => item.truncation.truncated) };
      } catch (error) {
        // An incomplete scan can omit unreadable sources even without a last-good record.
        if (snapshot.snapshotComplete && error instanceof TaskBriefReadRejection) throw new AgentToolAuthoritativeReadRejection(error.code, error.message, error.status);
        throw error;
      }
    }
    const { scope, workspace, read } = await environment(context);
    if (!availableToolNames.includes(name)) throw new DomainError('local_project_directory_required', 'The native local storage policy requires a trusted default project directory', 409);
    if (administrationTools.includes(name)) {
      const definition = registry.find(tool => tool.name === name)!;
      const authorized = await authorizeCoreScope(options.database(), context.actor, context.workspaceId, definition.capabilities.at(-1)!);
      if (definition.scope === 'workspace-admin' && (context.scope.kind !== 'workspace' || !authorized.unrestricted))
        throw new DomainError('agent_tool_workspace_scope_required', 'The native operation requires explicit workspace-wide permission', 403);
      const fields = { nextCursor: null, truncated: false, sources: [] };
      if (name === 'pm_list_views' || name === 'pm_read_view') {
        const visible = workspace.snapshot().views.filter(view => !view.project || context.scope.projectIds.includes(view.project) && authorized.allowsProject(view.project)).sort((a, b) => a.id.localeCompare(b.id));
        if (name === 'pm_read_view') {
          const args = parseAgentChatToolInput(name, input), view = visible.find(view => view.id === args.id);
          if (!view) throw new AgentToolAuthoritativeReadRejection('not_found_or_forbidden', 'The saved view is not accessible', 404);
          return agentChatToolResultSchema.parse({ kind: 'views', items: [view], ...fields });
        }
        const args = parseAgentChatToolInput(name, input), eligible = visible.filter(view => args.after === null || view.id.localeCompare(args.after) > 0), items = eligible.slice(0, args.limit);
        return agentChatToolResultSchema.parse({ kind: 'views', items, ...fields, nextCursor: eligible.length > items.length ? items.at(-1)!.id : null, truncated: eligible.length > items.length });
      }
      if (name === 'pm_query_view') {
        const args = parseAgentChatToolInput(name, input);
        if (args.view.project) read(args.view.project, 'project');
        const eligible = workspace.query(viewConfigOf(args.view), { archived: args.archived }).filter(record => authorized.allows(record) && context.scope.projectIds.includes(agentToolProjectId(record.entity) ?? ''));
        const snapshot = requestHash({ view: args.view, archived: args.archived, records: eligible.map(record => [record.id, record.revision]) });
        const offset = args.after === null ? 0 : Number(args.after.slice(65));
        if (args.after !== null && (args.after.slice(0, 64) !== snapshot || !Number.isSafeInteger(offset) || offset < 0 || offset > eligible.length))
          throw new DomainError('agent_tool_view_cursor_stale', 'The view inputs or native source revisions changed; start a new query', 409);
        const selected = eligible.slice(offset, offset + args.limit).map(ensureReadable), nextOffset = offset + selected.length;
        return { kind: 'query', items: selected.map(record => entityItem(record, false)), ...fields, sources: selected.map(record => source(context, record)), nextCursor: nextOffset < eligible.length ? `${snapshot}:${nextOffset}` : null, truncated: nextOffset < eligible.length };
      }
      if (name === 'pm_read_configuration') {
        const value = workspace.configuration();
        return agentChatToolResultSchema.parse({ kind: 'configuration', items: [], configuration: value.config, revision: value.revision, diagnostics: authorized.unrestricted ? value.diagnostics : [], ...fields });
      }
      if (name === 'pm_list_migrations') {
        const args = parseAgentChatToolInput(name, input);
        const summaries = z.array(pmCoreMigrationSummarySchema).parse(await workspace.migration('list')).sort((a, b) => a.id.localeCompare(b.id));
        const eligible = summaries.filter(value => args.after === null || value.id.localeCompare(args.after) > 0), items = eligible.slice(0, args.limit);
        return { kind: 'migrations', items, ...fields, nextCursor: eligible.length > items.length ? items.at(-1)!.id : null, truncated: eligible.length > items.length };
      }
      const migrationResult = (plan: MigrationPlan | MigrationResult, after: string | null, limit: number): AgentChatToolResult => {
        const eligible = [...plan.files].sort((a, b) => a.path.localeCompare(b.path)).filter(file => after === null || file.path.localeCompare(after) > 0), selected = eligible.slice(0, limit);
        return agentChatToolResultSchema.parse({ kind: 'migration', items: selected.map(({ path, beforeRevision, afterRevision }) => ({ path, beforeRevision, afterRevision })), migration: { id: plan.id, revision: plan.revision, kind: 'kind' in plan ? plan.kind : null, status: 'status' in plan ? plan.status : 'preview', totalFiles: plan.files.length, diagnostics: 'diagnostics' in plan ? plan.diagnostics : [] }, ...fields, nextCursor: eligible.length > selected.length ? selected.at(-1)!.path : null, truncated: eligible.length > selected.length });
      };
      if (name === 'pm_read_migration') {
        const args = parseAgentChatToolInput(name, input);
        return migrationResult(await workspace.migration('read', { id: args.id }) as MigrationPlan, args.after, args.limit);
      }
      const sql = await options.database().connect();
      try {
        await sql.query('BEGIN'); await lockWorkspace(sql, context.workspaceId);
        const fresh = await authorizeCoreScope(sql, context.actor, context.workspaceId, definition.capabilities.at(-1)!);
        if (!fresh.unrestricted || fresh.membership.version !== authorized.membership.version) throw new DomainError('permission_denied', 'Workspace permission changed before the native write', 403);
        await context.checkAuthorization?.(sql); assertAgentToolNotAborted(context);
        if (context.expectedApprovalAuthority) assertApprovalAuthority(name, input, context, workspace, read);
        let result: AgentChatToolResult;
        if (name === 'pm_save_view') {
          const args = parseAgentChatToolInput(name, input);
          if (args.view.project) read(args.view.project, 'project');
          for (const id of args.view.order ?? []) read(id);
          result = agentChatToolResultSchema.parse({ kind: 'views', items: [await workspace.saveView(args.id, { ...args.view, name: args.name, ...(args.revision !== null ? { revision: args.revision } : {}) })], ...fields });
        } else if (name === 'pm_save_configuration') {
          const args = parseAgentChatToolInput(name, input), value = await workspace.saveConfiguration(args.config, args.revision);
          result = agentChatToolResultSchema.parse({ kind: 'configuration', items: [], configuration: value.config, revision: value.revision, diagnostics: value.diagnostics, ...fields });
        } else if (name === 'pm_preview_migration') {
          const args = parseAgentChatToolInput(name, input);
          const plan = await workspace.migration('preview', { kind: args.kind, ...(args.config ? { config: args.config } : {}), changes: args.changes.map(change => ({ id: change.id, set: Object.fromEntries(change.set.map(({ field, value }) => [field, value])), rename: Object.fromEntries(change.rename.map(({ from, to }) => [from, to])), unset: change.unset })) }) as MigrationPlan;
          result = migrationResult(plan, null, 20);
        } else {
          const args = parseAgentChatToolInput(name as 'pm_apply_migration' | 'pm_restore_migration', input);
          result = migrationResult(await workspace.migration(name === 'pm_apply_migration' ? 'apply' : 'restore', { id: args.id, revision: args.revision }) as MigrationResult, args.after, args.limit);
        }
        await sql.query('COMMIT'); return result;
      } catch (error) { await sql.query('ROLLBACK'); throw error; }
      finally { sql.release(); }
    }
    if (name === 'pm_query') {
      const args = parseAgentChatToolInput(name, input);
      if (args.projectId) read(args.projectId, 'project');
      const kinds = args.entity ? [args.entity] : nativeEntityKinds;
      const records = kinds.flatMap(entity => workspace.items({ entity, ...(args.query ? { q: args.query } : {}) }))
        .filter(record => (!args.projectId || agentToolProjectId(record.entity) === args.projectId) && scope.allows(record) && context.scope.projectIds.includes(agentToolProjectId(record.entity) ?? ''))
        .sort((left, right) => left.id.localeCompare(right.id));
      const eligible = records.filter(record => !args.after || record.id.localeCompare(args.after) > 0);
      const items = eligible.slice(0, args.limit).map(ensureReadable);
      return { kind: 'query', items: items.map(record => entityItem(record, false)), sources: items.map(record => source(context, record)), nextCursor: eligible.length > items.length ? items.at(-1)?.id ?? null : null, truncated: eligible.length > items.length };
    }
    if (name === 'pm_read') {
      const args = parseAgentChatToolInput(name, input), record = read(args.id);
      const text = record.entity.body, body = text.slice(args.bodyOffset, args.bodyOffset + args.bodyLimit), nextBodyOffset = args.bodyOffset + body.length < text.length ? args.bodyOffset + body.length : null;
      const provenance = source(context, record, nextBodyOffset !== null || args.bodyOffset > 0);
      return { kind: resultKind(record), items: [{ ...entityItem(record), body, bodyOffset: args.bodyOffset, nextBodyOffset }], sources: [provenance], nextCursor: null, truncated: provenance.truncated };
    }
    if (name === 'pm_read_workflow') {
      const args = parseAgentChatToolInput(name, input), project = read(args.projectId, 'project');
      const { configuration, definition, workflowRevision } = workflowAuthority(workspace, 'work_item');
      if (!definition) throw new DomainError('agent_context_unavailable', 'The native work-item workflow is unavailable', 409);
      return { kind: 'workflow', items: [], workflow: {
        workspaceId: context.workspaceId, projectId: project.id, entity: 'work_item', initial: definition.initial,
        states: definition.states, transitions: definition.transitions, defaultTargets: definition.default_targets ?? null,
        configuration: { schema: configuration.config.schema, revision: configuration.revision,
          source: configuration.revision === 'absent' ? 'builtin' : 'workspace', workflowRevision },
      }, nextCursor: null, truncated: false, sources: [
        source(context, project),
        { kind: 'workflow', workspaceId: context.workspaceId, projectId: project.id, entityId: 'work_item',
          title: 'Work item workflow', revision: workflowRevision, truncated: false },
      ] };
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
        items.push({ id: comment.id, taskId: comment.taskId, projectId: comment.projectId, content: comment.content, version: comment.version, deletedAt: comment.deletedAt,
          authorId: comment.authorId, origin: comment.origin ?? null });
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
    if (isLifecycleTool(name)) {
      const args = parseAgentChatToolInput(name, input), before = read(args.id, name.endsWith('_task') ? 'work_item' : undefined);
      const capability = lifecycleCapability(name, input, workspace.configuration().config, before);
      const request = lifecycleRequest(name, input, workspace, before);
      // Only this native authorization boundary proves rejection before mutation dispatch.
      try { await authorizeCoreScope(options.database(), context.actor, context.workspaceId, capability); }
      catch (error) {
        if (error instanceof DomainError && error.code === 'permission_denied') {
          const commandId = nativeCommandId(context.workspaceId, context.actor.id, request.action, request.targetId, context.operationId);
          // An older pending native identity is not disproved by this attempt's permission denial.
          if (!new CoreCommandJournal(workspace.root).httpOutcome(commandId, context.actor.id))
            throw new AgentToolPreDispatchRejection(error.code, error.message, error.status);
        }
        throw error;
      }
      assertAgentToolNotAborted(context);
      const result = await executeAuditedCoreMutation({ database: options.database, principal: context.actor, workspace, scope, action: request.action, input: request.input, trustedSource: { kind: 'agent', requesterId: context.actor.id },
        key: context.operationId, mutate: request.mutate, capability,
        guard: lifecycleGuard(context, workspace, lifecycleExpectation(name, input), current => assertApprovalAuthority(name, input, context, workspace, read, current)),
        checkAuthorization: async sql => {
          await context.checkAuthorization?.(sql);
          if (context.expectedApprovalAuthority) assertApprovalAuthority(name, input, context, workspace, read);
        },
        ...(request.targetId ? { targetId: request.targetId } : {}), before });
      if (name === 'pm_delete_task' || name === 'pm_delete_entity') {
        if ('entity' in result) throw new DomainError('core_write_outcome_unknown', 'The native deletion did not return a tombstone', 503);
        return lifecycleResult(context, { kind: 'core', operationId: context.operationId,
          commandId: nativeCommandId(context.workspaceId, context.actor.id, request.action, request.targetId, context.operationId),
          action: request.action, targetId: result.id, revision: null, ...(context.linkage ? { linkage: context.linkage } : {}) });
      }
      if (!('entity' in result)) throw new DomainError('core_write_outcome_unknown', 'The native lifecycle write did not return a source record', 503);
      assertAgentToolRecord(context.scope, result);
      return lifecycleResult(context, nativeReceipt(context, request, result), result);
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
    const record = await executeAuditedCoreMutation({ database: options.database, principal: context.actor, workspace, scope, action: request.action, input: request.input, trustedSource: { kind: 'agent', requesterId: context.actor.id },
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
    const result = receipt.result as { id?: unknown; taskId?: unknown; projectId?: unknown; version?: unknown; authorId?: unknown; origin?: unknown } | undefined;
    if (typeof result?.id !== 'string' || result.taskId !== args.taskId || result.projectId !== projectId || typeof result.version !== 'number') throw new DomainError('command_outcome_unknown', 'The comment receipt has no confirmed target/version', 503);
    const origin = result.origin ? taskCommentAgentOriginSchema.parse(result.origin) : null;
    return { kind: 'comment', items: [{ id: result.id, taskId: args.taskId, projectId, content: args.content, version: result.version, deletedAt: null,
      ...(typeof result.authorId === 'string' ? { authorId: result.authorId } : {}), origin }], nextCursor: null, truncated: false,
      sources: [{ kind: 'comment', workspaceId: context.workspaceId, projectId, entityId: result.id, title: 'Task comment', revision: String(result.version), truncated: false }],
      receipt: commandReceipt(context, receipt, 'CreateTaskComment', result.id, String(result.version)) };
  }

  /** Inspect the original receipt/key only. Pending writes are never guessed successful or blindly replayed. */
  async function recover(nameValue: string, input: unknown, context: AgentChatToolContext): Promise<AgentChatToolResult | null> {
    const name = toolName(nameValue);
    parseAgentChatToolInput(name, input);
    const family = familyByName.get(name);
    if (family) {
      const recovered = await family.recover(name, input, context);
      return recovered === null ? null : agentChatToolResultSchema.parse(recovered);
    }
    if (administrationTools.includes(name)) return null;
    const { scope, read } = await environment(context, false);
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
      // A command receipt proves the original target, not its current contents.
      return { kind: 'project', items: [], nextCursor: null, truncated: false, sources: [], receipt: reference };
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
    const receipt: AgentChatToolReceipt = { kind: 'core', operationId: context.operationId, commandId, action: request.action, targetId: saved.targetId, revision: saved.revision,
      ...(context.linkage ? { linkage: context.linkage } : {}) };
    // The original completed native journal and audit prove deletion; never invent a current entity.
    if (name === 'pm_delete_task' || name === 'pm_delete_entity') return lifecycleResult(context, receipt);
    let record: FileRecord;
    try { record = read(saved.targetId); }
    catch (error) {
      if (!(error instanceof DomainError && ['not_found_or_forbidden', 'agent_context_unavailable'].includes(error.code)) && !(error instanceof WorkspaceError && error.status === 404)) throw error;
      if (isLifecycleTool(name)) return lifecycleResult(context, receipt);
      if (name === 'pm_add_relation' || name === 'pm_remove_relation') return { kind: 'relation', items: [], nextCursor: null, truncated: false, sources: [], receipt };
      const kind = name === 'pm_create_entity' || name === 'pm_update_entity' || name === 'pm_save_entity_body' || name === 'pm_save_entity_source' ? 'query' : name === 'pm_create_task' || name === 'pm_update_task' ? 'task' : name === 'pm_update_project' ? 'project' : 'document';
      return { kind, items: [], nextCursor: null, truncated: false, sources: [], receipt };
    }
    if (record.revision !== saved.revision) {
      if (isLifecycleTool(name)) return lifecycleResult(context, receipt);
      if (name === 'pm_add_relation' || name === 'pm_remove_relation') return { kind: 'relation', items: [], nextCursor: null, truncated: false, sources: [], receipt };
      const kind = resultKind(record);
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
      if (target.revision !== args.targetRevision) return { kind: 'relation', items: [], nextCursor: null, truncated: false, sources: [], receipt };
      return { kind: 'relation', items: [{ sourceId: record.id, targetId: target.id, relation: args.relation, sourceRevision: record.revision, targetRevision: target.revision }], nextCursor: null, truncated: false, sources: [source(context, record), source(context, target)], receipt };
    }
    if (isLifecycleTool(name)) return lifecycleResult(context, receipt, record);
    return entityResult(context, record, receipt);
  }

  function recoveryIdentity(nameValue: string, input: unknown, context: AgentChatToolContext): AgentToolRecoveryIdentity | null {
    const name = toolName(nameValue);
    parseAgentChatToolInput(name, input);
    const family = familyByName.get(name);
    if (family) return family.recoveryIdentity(name, input, context);
    if (administrationTools.includes(name)) return null;
    if (!AGENT_CHAT_TOOL_REGISTRY.find(tool => tool.name === name)?.write) return null;
    if (name === 'pm_create_project' || name === 'pm_create_comment') {
      const projectId = name === 'pm_create_comment' ? parseAgentChatToolInput(name, input).projectId : undefined;
      const command = creationCommand(name, input, context, options.localProjects, projectId);
      return { kind: 'command', commandId: command.commandId, action: command.commandType,
        hash: requestHash(command as unknown as Record<string, unknown>) };
    }
    const identity = nativeIdentity(name, input);
    return { kind: 'core', commandId: nativeCommandId(context.workspaceId, context.actor.id, identity.action, identity.targetId, context.operationId),
      action: identity.action, hash: requestHash({ action: identity.action, targetId: identity.targetId, input: identity.input }) };
  }

  /** Internal status inspection never executes, mutates files, rebuilds a Workspace or returns business data. */
  async function inspectOutcome(input: AgentToolRecoveryIdentity, actorId: string, workspaceId: string): Promise<AgentToolOutcomeProof> {
    const identity = agentToolRecoveryIdentitySchema.parse(input);
    const unresolved: AgentToolOutcomeProof = { status: 'unknown', evidence: 'unresolved' };
    if (identity.kind !== 'command' && identity.kind !== 'core') {
      for (const family of families) {
        const proof = await family.inspectOutcome?.(identity, actorId, workspaceId);
        if (proof && proof.status !== 'unknown') return proof;
      }
      return unresolved;
    }
    if (identity.kind === 'command') {
      const row = (await options.database().query<{ request_hash: string; command_type: string; status: string; code: string | null }>(
        `SELECT request_hash,command_type,receipt->>'status' AS status,receipt#>>'{error,code}' AS code
         FROM command_receipts WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3`,
        [workspaceId, actorId, identity.commandId])).rows[0];
      if (!row || row.request_hash !== identity.hash || row.command_type !== identity.action) return unresolved;
      if (row.status === 'committed') return { status: 'succeeded', evidence: 'command_receipt' };
      if (row.status === 'rejected' && !/unknown|pending|recovered/i.test(row.code ?? ''))
        return { status: 'failed', evidence: 'command_receipt' };
      return unresolved;
    }
    const saved = new CoreCommandJournal(options.coreWorkspaces.rootFor(workspaceId)).httpOutcome(identity.commandId, actorId);
    if (!saved || saved.hash !== identity.hash || saved.kind === 'http_pending') return unresolved;
    if (saved.kind === 'http_rejected') return { status: 'failed', evidence: 'native_journal' };
    if (saved.audit.some(entry => entry.action !== identity.action || entry.commandId !== identity.commandId || entry.actorId !== actorId)) return unresolved;
    const audit = await options.database().query<{ count: number }>(
      'SELECT count(*)::int AS count FROM project_audit WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3',
      [workspaceId, actorId, identity.commandId]);
    // An incomplete file/SQL audit boundary is repaired only by the existing authorized recovery entry.
    if ((audit.rows[0]?.count ?? 0) < saved.audit.length) return unresolved;
    return { status: 'succeeded', evidence: 'native_journal' };
  }
  async function authorizeResult(nameValue: string, input: unknown, result: AgentChatToolResult, context: AgentChatToolContext): Promise<void> {
    const name = toolName(nameValue), definition = registry.find(tool => tool.name === name)!;
    parseAgentChatToolInput(name, input);
    const membership = await getMembership(options.database(), context.actor, context.workspaceId);
    if (!definition.capabilities.every(capability => membership.capabilities.includes(capability)))
      throw new DomainError('permission_denied', 'The original result is no longer authorized', 403);
    if (definition.scope === 'workspace-admin' && (context.scope.kind !== 'workspace' || membership.projectIds !== null))
      throw new DomainError('permission_denied', 'The workspace-wide result is no longer authorized', 403);
    const family = familyByName.get(name);
    if (family) {
      if (!family.authorizeResult) throw new DomainError('agent_tool_result_authorization_unavailable', 'The family cannot currently prove result visibility', 503);
      await family.authorizeResult(name, input, result, context);
      return;
    }
    const { scope, workspace, read } = await environment(context, false);
    if (result.kind === 'comment') {
      const args = name === 'pm_create_comment' ? parseAgentChatToolInput(name, input) : parseAgentChatToolInput('pm_read_comments', input);
      const task = read(args.taskId, 'work_item');
      const projectId = 'projectId' in args ? args.projectId : result.items[0]?.projectId ?? result.sources.find(reference => reference.kind === 'comment')?.projectId ?? agentToolProjectId(task.entity);
      assertAgentToolProject(context.scope, projectId);
      if (!projectId || result.items.some(comment => comment.taskId !== task.id || comment.projectId !== projectId))
        throw new DomainError('not_found_or_forbidden', 'The original comment binding is not accessible', 404);
      // The native read service checks the current task plus its retained SQL project binding.
      // Do not replay creation or infer permission from a historical comment source label.
      await options.readComments(context.actor, context.workspaceId, task.id, { projectId, limit: 1 });
    }
    if (result.kind === 'configuration' && result.diagnostics.length > 0 && !scope.unrestricted)
      throw new DomainError('not_found_or_forbidden', 'Workspace-wide configuration diagnostics are no longer accessible', 404);
    for (const reference of result.sources) {
      if (reference.workspaceId !== context.workspaceId) throw new DomainError('permission_denied', 'Result source is outside the authorized workspace', 403);
      if (reference.projectId) assertAgentToolProject(context.scope, reference.projectId);
      if (!['comment', 'relation', 'workflow'].includes(reference.kind)) read(reference.entityId);
    }
    if (result.kind === 'views') for (const view of result.items) {
      if (view.project) assertAgentToolProject(context.scope, view.project);
      const current = workspace.snapshot().views.find(candidate => candidate.id === view.id);
      if (!current || current.project && (!scope.allowsProject(current.project) || !context.scope.projectIds.includes(current.project)))
        throw new DomainError('not_found_or_forbidden', 'The original saved view is no longer readable', 404);
    }
  }
  return { definitions, registry, availableToolNames, execute, recover, recoveryIdentity, inspectOutcome, authorizeResult, approvalAuthority };
}
