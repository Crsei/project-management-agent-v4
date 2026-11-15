import { z } from 'zod';
import { DomainError, type Actor, type Capability } from '../../domain/src/core.ts';
import type { Entity, FileRecord } from '../../pm-schema/index.ts';
import { pmToolTargetSchema, type PmToolLinkage } from '../../agent-contracts/src/pm-tools.ts';
import { taskBriefStageSchema } from '../../agent-contracts/src/task-brief.ts';
import { pmCoreEntityKindSchema, pmCoreConfigurationSchema, pmCoreViewSchema } from '../../agent-contracts/src/pm-tool-core.ts';
import { agentChatToolFieldValueSchema } from '../../agent-contracts/src/pm-tool-shared.ts';
import type { SqlExecutor } from './ports.ts';
import { CollaborationToolInputSchemas, CollaborationToolMetadata } from './agent-tool-collaboration.ts';
import { AdministrationToolInputSchemas, AdministrationToolMetadata } from './agent-tool-administration.ts';
import { DocumentsFilesToolInputSchemas, DocumentsFilesToolMetadata } from './agent-tool-documents-files.ts';
import { DashboardToolInputSchemas, DashboardToolMetadata } from './agent-tool-dashboard.ts';
import { PlanningRecordsToolInputSchemas, PlanningRecordsToolMetadata } from './agent-tool-planning-records.ts';
import { AutomationToolInputSchemas, AutomationToolMetadata } from './agent-tool-automation.ts';
import { IntegrationsToolInputSchemas, IntegrationsToolMetadata } from './agent-tool-integrations.ts';

const familyToolMetadata = {
  ...CollaborationToolMetadata, ...AdministrationToolMetadata, ...DocumentsFilesToolMetadata,
  ...DashboardToolMetadata, ...PlanningRecordsToolMetadata, ...AutomationToolMetadata,
  ...IntegrationsToolMetadata,
};

const id = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).max(80);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const title = z.string().trim().min(1).max(300).refine(value => !/[\r\n]/.test(value), 'Titles must be one line');
const body = z.string().max(24000);
const nullableText = z.string().max(500).nullable();
const date = z.union([z.iso.date(), z.literal('')]).nullable();
const assignee = z.union([z.uuid().toLowerCase(), z.literal('')]).nullable();
const priority = z.enum(['low', 'medium', 'high', 'urgent']).nullable();
const labels = z.array(z.string().trim().min(1).max(80)).max(30).nullable();
const relation = z.enum(['parent', 'blocked_by', 'depends_on', 'related_to', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goals']);
const workflowState = z.string().min(1).refine(value => value.trim().length > 0, 'Expected nonempty text');
const page = { after: id.nullable(), limit: z.number().int().min(1).max(20) };
const fieldChange = z.strictObject({ field: z.string().trim().min(1).max(128), value: agentChatToolFieldValueSchema });
const fieldChanges = z.array(fieldChange).max(200).refine(values => new Set(values.map(value => value.field)).size === values.length, 'Field names must be unique');
const viewId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const migrationId = z.string().regex(/^mig-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);

/** Null means unchanged on update; empty text clears an optional text/date/assignee field. */
export const agentChatToolInputSchemas = {
  pm_query: z.strictObject({ entity: pmCoreEntityKindSchema.nullable(), projectId: id.nullable(), query: z.string().max(500).nullable(), ...page }),
  pm_read: z.strictObject({ id, bodyOffset: z.number().int().min(0).max(4000000), bodyLimit: z.number().int().min(1).max(12000) }),
  pm_read_workflow: z.strictObject({ projectId: id }),
  pm_task_brief: z.strictObject({ projectId: id, taskId: id, revision, stage: taskBriefStageSchema, bodyOffset: z.number().int().min(0).max(4000000).nullable(), bodyLimit: z.number().int().min(1).max(48000).nullable() }),
  pm_search_knowledge: z.strictObject({ projectId: id, taskId: id, revision, query: z.string().trim().min(1).max(500), projectIds: z.array(id).min(1).max(20).nullable(), limit: z.number().int().min(1).max(20), cursor: z.string().min(1).max(2048).nullable() }),
  pm_create_project: z.strictObject({ title, description: body, goal: z.string().max(4000).nullable() }),
  pm_update_project: z.strictObject({ id, revision, title: title.nullable(), goal: z.string().max(4000).nullable(), description: body.nullable(), startDate: date, dueDate: date }).refine(input => [input.title, input.goal, input.description, input.startDate, input.dueDate].some(value => value !== null), 'Provide at least one ordinary field'),
  pm_create_task: z.strictObject({ projectId: id, title, description: body, assigneeId: assignee, priority, startDate: date, dueDate: date, labels }),
  pm_update_task: z.strictObject({ id, revision, title: title.nullable(), description: body.nullable(), assigneeId: assignee, priority, startDate: date, dueDate: date, labels }).refine(input => [input.title, input.description, input.assigneeId, input.priority, input.startDate, input.dueDate, input.labels].some(value => value !== null), 'Provide at least one ordinary field'),
  pm_create_document: z.strictObject({ projectId: id, title, body }),
  pm_save_document: z.strictObject({ id, revision, body }),
  pm_read_comments: z.strictObject({ taskId: id, after: z.uuid().toLowerCase().nullable(), limit: z.number().int().min(1).max(10) }),
  pm_create_comment: z.strictObject({ projectId: id, taskId: id, content: z.string().trim().min(1).max(8000) }),
  pm_read_relations: z.strictObject({ id, after: nullableText, limit: z.number().int().min(1).max(20) }),
  pm_add_relation: z.strictObject({ sourceId: id, targetId: id, relation, revision, targetRevision: revision }),
  pm_remove_relation: z.strictObject({ sourceId: id, targetId: id, relation, revision, targetRevision: revision }),
  pm_archive_task: z.strictObject({ id, revision }),
  pm_restore_task: z.strictObject({ id, revision }),
  pm_delete_task: z.strictObject({ id, revision }),
  pm_transition_task: z.strictObject({ id, revision, status: workflowState }),
  pm_create_entity: z.strictObject({ entity: z.enum(['work_item', 'document', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goal']), projectId: id, title, body, fields: fieldChanges }),
  pm_update_entity: z.strictObject({ id, revision, fields: fieldChanges.refine(values => values.length > 0, 'Provide at least one ordinary field') }),
  pm_save_entity_body: z.strictObject({ id, revision, body: z.string().max(4000000) }),
  pm_save_entity_source: z.strictObject({ id, revision, raw: z.string().max(4000000) }),
  pm_archive_entity: z.strictObject({ id, revision }),
  pm_restore_entity: z.strictObject({ id, revision }),
  pm_delete_entity: z.strictObject({ id, revision }),
  pm_transition_entity: z.strictObject({ id, revision, status: workflowState }),
  pm_list_views: z.strictObject({ after: viewId.nullable(), limit: z.number().int().min(1).max(20) }),
  pm_read_view: z.strictObject({ id: viewId }),
  pm_query_view: z.strictObject({ view: pmCoreViewSchema, archived: z.enum(['exclude', 'include', 'only']), after: z.string().regex(/^[a-f0-9]{64}:\d+$/).max(100).nullable(), limit: z.number().int().min(1).max(20) }),
  pm_save_view: z.strictObject({ id: viewId, name: title, view: pmCoreViewSchema, revision: revision.nullable() }),
  pm_read_configuration: z.strictObject({}),
  pm_save_configuration: z.strictObject({ config: pmCoreConfigurationSchema, revision: z.union([revision, z.literal('absent')]) }),
  pm_list_migrations: z.strictObject({ after: migrationId.nullable(), limit: z.number().int().min(1).max(20) }),
  pm_preview_migration: z.strictObject({ kind: z.enum(['normalize-v1', 'transform']), config: pmCoreConfigurationSchema.nullable(), changes: z.array(z.strictObject({ id, set: fieldChanges, rename: z.array(z.strictObject({ from: z.string().min(1).max(128), to: z.string().min(1).max(128) })).max(200), unset: z.array(z.string().min(1).max(128)).max(200) })).max(1000) }),
  pm_read_migration: z.strictObject({ id: migrationId, after: z.string().max(1000).nullable(), limit: z.number().int().min(1).max(20) }),
  pm_apply_migration: z.strictObject({ id: migrationId, revision, after: z.string().max(1000).nullable(), limit: z.number().int().min(1).max(20) }),
  pm_restore_migration: z.strictObject({ id: migrationId, revision, after: z.string().max(1000).nullable(), limit: z.number().int().min(1).max(20) }),
  ...CollaborationToolInputSchemas,
  ...AdministrationToolInputSchemas,
  ...DocumentsFilesToolInputSchemas,
  ...DashboardToolInputSchemas,
  ...PlanningRecordsToolInputSchemas,
  ...AutomationToolInputSchemas,
  ...IntegrationsToolInputSchemas,
} as const;

export type AgentChatToolName = keyof typeof agentChatToolInputSchemas;
export type AgentChatToolInput<Name extends AgentChatToolName> = z.infer<typeof agentChatToolInputSchemas[Name]>;
export const AGENT_CHAT_TOOL_NAMES = Object.keys(agentChatToolInputSchemas) as AgentChatToolName[];
const descriptions: Record<Exclude<AgentChatToolName, keyof typeof familyToolMetadata>, string> = {
  pm_query: 'Search authorized projects, tasks and documents by text. limit is an integer from 1 to 20 (maximum 20); start with after: null, then pass the returned nextCursor as after on a new read to continue until nextCursor is null. Summaries are not full bodies.',
  pm_read: 'Read one authorized native Markdown entity with its current revision and a bounded body page. Continue knowledge-source excerpts using entityId and nextBodyOffset; compare source revisions before using pages together.',
  pm_read_workflow: 'Read the current native work-item workflow for an explicitly authorized project: initial state, state IDs/labels/categories, allowed transitions and configured category preferences with configuration provenance. Read-only; this is not write permission or a completion guarantee. Use these configured IDs, never guessed status names; existing transitions still require current task revision and native capabilities.',
  pm_task_brief: 'Read a source-backed phase-specific task brief at the exact current revision. Read-only; incomplete context cannot be dispatched, sources grant no authorization.',
  pm_search_knowledge: 'Find original Markdown lexical candidates in this project by default. Cross-project search requires explicit project IDs within the existing authorized tool scope. Relevance is not validity; candidates need review.',
  pm_create_project: 'Create a project only with explicit workspace authorization, using the native trusted storage policy. No lifecycle change.',
  pm_update_project: 'Edit ordinary project title, goal, description or dates at the exact revision. Null keeps a field; empty text clears it.',
  pm_create_task: 'Create a task in an authorized writable project with ordinary fields and the native initial workflow state.',
  pm_update_task: 'Edit ordinary task title, description, assignee, priority, dates or labels at the exact revision. Null keeps a field; empty text clears optional fields. Never change state.',
  pm_create_document: 'Create a project Markdown document through the native creation service.',
  pm_save_document: 'Save a document Markdown body at the exact revision, preserving identity, metadata and lifecycle.',
  pm_read_comments: 'Read a bounded current page of authorized task comments with original versions.',
  pm_create_comment: 'Create a task comment as the current delegating human through the native idempotent command service.',
  pm_read_relations: 'Read bounded formal relationships only when both endpoints are currently authorized; hidden endpoints are omitted.',
  pm_add_relation: 'Add a legal formal relationship at both exact endpoint revisions. No project move or lifecycle changes.',
  pm_remove_relation: 'Remove one legal formal relationship at both exact endpoint revisions. Both endpoints must be authorized.',
  pm_archive_task: 'Archive one authorized task at the exact revision through the native core. Never deletes, never moves projects.',
  pm_restore_task: 'Restore one archived task at the exact revision through the native core. Ordinary fields and workflow state are unchanged.',
  pm_delete_task: 'Permanently delete one already archived task at the exact revision through the native core. Blocked while native references or retained business records exist.',
  pm_transition_task: 'Move one authorized task to a configured workflow state at the exact revision; the native Markdown workflow validates the transition.',
  pm_create_entity: 'Create a native project-scoped entity in its configured initial state. Finite typed field values are checked by the current native field registry; no identity or lifecycle overrides.',
  pm_update_entity: 'Update typed ordinary native or configured custom fields at the exact revision. Explicit null removes a nullable field; an empty array clears an array according to native rules. No status/archive/project moves.',
  pm_save_entity_body: 'Replace any native entity Markdown body at the exact revision, preserving its frontmatter, identity, title and lifecycle.',
  pm_save_entity_source: 'Save any native Markdown source at the exact revision through native validation; identity, scope and lifecycle stay protected.',
  pm_archive_entity: 'Archive an authorized native entity at its exact revision without changing status.',
  pm_restore_entity: 'Restore an archived native entity at its exact revision without changing status.',
  pm_delete_entity: 'Permanently delete an already archived native entity at its exact revision, subject to native inbound-reference and retained-record guards.',
  pm_transition_entity: 'Transition a native non-document entity to an explicitly configured workflow state. Category-specific native capabilities apply; not every entity is a task.',
  pm_list_views: 'Discover a bounded page of currently authorized saved view definitions with their native revisions.',
  pm_read_view: 'Read an authorized saved view definition and current revision. No view deletion exists.',
  pm_query_view: 'Query authorized native entities using an existing finite typed view expression; pages are bounded and authorized.',
  pm_save_view: 'Save a native view using current revision, or null only for a new view. Requires existing workspace-wide planning permission.',
  pm_read_configuration: 'Read native workspace protocol configuration with current native read permission; restricted members receive no diagnostic paths. This grants no write permission.',
  pm_save_configuration: 'Save native workspace protocol configuration with exact CAS; use absent only for first creation. Requires existing workspace-wide planning permission.',
  pm_list_migrations: 'List a bounded page of original native migration summaries under current workspace-wide lifecycle permission.',
  pm_preview_migration: 'Prepare a native normalize-v1 or transform migration preview. Persists its recovery plan, but never changes business sources. Requires workspace-wide lifecycle permission.',
  pm_read_migration: 'Read a bounded page of a verified original migration plan by ID without applying or regenerating it.',
  pm_apply_migration: 'Apply the exact original native migration ID and revision under workspace-wide lifecycle permission. Unknown outcomes are inspected, never redispatched.',
  pm_restore_migration: 'Restore exact original migration bytes under workspace-wide lifecycle permission. Unknown outcomes are inspected, never redispatched.',
};
export function isCoreAgentChatTool(name: string): boolean {
  return Object.hasOwn(descriptions, name);
}
const readOnlyTools: readonly AgentChatToolName[] = ['pm_query', 'pm_read', 'pm_read_workflow', 'pm_task_brief', 'pm_search_knowledge', 'pm_read_comments', 'pm_read_relations', 'pm_list_views', 'pm_read_view', 'pm_query_view', 'pm_read_configuration', 'pm_list_migrations', 'pm_read_migration'];
const lifecycleTools: readonly AgentChatToolName[] = ['pm_archive_task', 'pm_restore_task', 'pm_delete_task', 'pm_archive_entity', 'pm_restore_entity', 'pm_delete_entity', 'pm_list_migrations', 'pm_read_migration', 'pm_preview_migration', 'pm_apply_migration', 'pm_restore_migration'];
const capabilitiesFor = (name: AgentChatToolName): Capability[] => {
  if (name === 'pm_create_comment') return ['domain.read', 'intent.propose'];
  if (name === 'pm_transition_task' || name === 'pm_transition_entity') return ['domain.read'];
  if (lifecycleTools.includes(name)) return ['domain.read', 'planning.lifecycle'];
  if (readOnlyTools.includes(name)) return ['domain.read'];
  // Lifecycle-only capabilities (workitem.complete / workitem.cancel_reopen) are checked against the exact target state at call time.
  return ['domain.read', 'planning.edit'];
};
export type AgentChatToolScopeRequirement = 'project' | 'workspace' | 'workspace-admin';
const workspaceAdminTools: readonly AgentChatToolName[] = ['pm_save_view', 'pm_save_configuration', 'pm_list_migrations', 'pm_read_migration', 'pm_preview_migration', 'pm_apply_migration', 'pm_restore_migration'];
export const AGENT_CHAT_TOOL_REGISTRY = AGENT_CHAT_TOOL_NAMES.map(name => {
  if (Object.hasOwn(familyToolMetadata, name)) return { name, ...familyToolMetadata[name as keyof typeof familyToolMetadata] };
  return {
    name, description: descriptions[name as keyof typeof descriptions], write: !readOnlyTools.includes(name),
    capabilities: capabilitiesFor(name),
    scope: (workspaceAdminTools.includes(name) ? 'workspace-admin' : 'project') as AgentChatToolScopeRequirement,
  };
});
export const agentChatToolDefinitions = AGENT_CHAT_TOOL_REGISTRY.map(tool => ({ type: 'function' as const, function: {
  name: tool.name, description: tool.description, strict: true,
  parameters: z.toJSONSchema(z.strictObject({ target: pmToolTargetSchema, arguments: agentChatToolInputSchemas[tool.name] }), { unrepresentable: 'any' }),
} }));

export type AgentChatToolScope = { kind: 'workspace' | 'projects'; projectIds: readonly string[] };
export type AgentChatToolContext = {
  actor: Actor;
  workspaceId: string;
  threadId: string;
  messageId: string;
  operationId: string;
  scope: AgentChatToolScope;
  /** Trusted execution evidence; full/audit-only, never an additional authorization gate. */
  linkage?: PmToolLinkage;
  signal?: AbortSignal;
  /** Recheck the current PM actor and project scope inside the native mutation lock. */
  checkAuthorization?: (sql: SqlExecutor) => Promise<void>;
  /** Untrusted restrictive precondition; native mutation authorization still requires every current capability. */
  expectedApprovalAuthority?: string;
};
export function parseAgentChatToolInput<Name extends AgentChatToolName>(name: Name, input: unknown): AgentChatToolInput<Name> {
  const schema = agentChatToolInputSchemas[name];
  if (!schema) throw new DomainError('agent_tool_not_available', 'This tool is not registered', 403);
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    // Only registered field names and schema-owned constraints may enter an error.
    // Zod's default errors can echo unknown keys or supplied values.
    const fields = new Set(Object.keys(schema.shape));
    const details = parsed.error.issues.slice(0, 5).map(issue => {
      const field = typeof issue.path[0] === 'string' && fields.has(issue.path[0]) ? issue.path[0] : 'arguments';
      let requirement: string;
      if (issue.code === 'too_big') requirement = `must be at most ${issue.maximum}${issue.origin === 'string' ? ' characters' : issue.origin === 'array' ? ' items' : ''}`;
      else if (issue.code === 'too_small') requirement = `must be at least ${issue.minimum}${issue.origin === 'string' ? ' characters' : issue.origin === 'array' ? ' items' : ''}`;
      else if (issue.code === 'invalid_type') requirement = `must be ${issue.expected === 'int' ? 'an integer' : `a valid ${issue.expected}`}`;
      else if (issue.code === 'unrecognized_keys') requirement = 'contains unsupported fields; use only the registered schema';
      else if (issue.code === 'custom') requirement = issue.message;
      else requirement = 'must match the registered format or allowed values';
      return `${field}: ${requirement}`;
    });
    const pagination = name === 'pm_query' ? ' Use limit 1–20; start with after: null, then use nextCursor as after in a new read.' : '';
    throw new DomainError('agent_tool_invalid_input', `Invalid ${name} arguments. ${details.join(';')}.${pagination}`, 400);
  }
  return parsed.data as AgentChatToolInput<Name>;
}
export function assertAgentToolNotAborted(context: Pick<AgentChatToolContext, 'signal'>): void {
  if (context.signal?.aborted) throw new DomainError('agent_tool_cancelled', 'Tool dispatch was cancelled before a new operation was committed', 409);
}
export function agentToolProjectId(entity: Pick<Entity, 'entity' | 'id' | 'project'>): string | undefined {
  return entity.entity === 'project' ? entity.id : typeof entity.project === 'string' ? entity.project : undefined;
}
export function assertAgentToolProject(scope: AgentChatToolScope, projectId: string | undefined): void {
  if (!projectId || !scope.projectIds.includes(projectId)) throw new DomainError('not_found_or_forbidden', 'Entity is outside the explicitly authorized project set', 404);
}
export function assertAgentToolRecord(scope: AgentChatToolScope, record: FileRecord): void {
  assertAgentToolProject(scope, agentToolProjectId(record.entity));
}
export function assertAgentToolOrdinaryMutation(before: FileRecord | undefined, after: Entity): void {
  if (before && (before.entity.status !== after.status || before.entity.archived !== after.archived || before.entity.project !== after.project)) {
    throw new DomainError('agent_tool_protected_action', 'Lifecycle, archive and cross-project moves are not Agent tools', 403);
  }
}
/** Lifecycle tools change one field of an existing native entity, never its identity or project. */
export function assertAgentToolLifecycleMutation(before: FileRecord | undefined, after: Entity, expected: { archived?: boolean; status?: string }): void {
  if (!before || before.entity.entity !== after.entity || before.id !== after.id) {
    throw new DomainError('agent_tool_protected_action', 'Lifecycle tools operate only on the same existing native entity', 403);
  }
  if (before.entity.project !== after.project || agentToolProjectId(before.entity) !== agentToolProjectId(after)) {
    throw new DomainError('agent_tool_protected_action', 'Lifecycle tools cannot move an entity between projects', 403);
  }
  const archiveRequested = expected.archived !== undefined, transitionRequested = expected.status !== undefined;
  if (!archiveRequested && !transitionRequested) throw new DomainError('agent_tool_protected_action', 'A lifecycle tool must name the lifecycle change', 403);
  if (archiveRequested && after.archived !== expected.archived) {
    throw new DomainError('agent_tool_protected_action', 'Archive state may change only as explicitly requested', 403);
  }
  if (transitionRequested && after.status !== expected.status) {
    throw new DomainError('agent_tool_protected_action', 'Workflow state may change only as explicitly requested', 403);
  }
  if (transitionRequested && after.archived !== before.entity.archived) {
    throw new DomainError('agent_tool_protected_action', 'A workflow transition cannot change the archive state', 403);
  }
  if (archiveRequested && after.status !== before.entity.status) {
    throw new DomainError('agent_tool_protected_action', 'An archive change cannot change the workflow state', 403);
  }
}
