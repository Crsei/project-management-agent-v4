import { z } from 'zod';
import { DomainError, type Actor, type Capability } from '../../domain/src/core.ts';
import type { Entity, FileRecord } from '../../pm-schema/index.ts';
import type { SqlExecutor } from './ports.ts';

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
const workflowState = z.string().trim().min(1).max(120);
const page = { after: id.nullable(), limit: z.number().int().min(1).max(20) };

/** Null means unchanged on update; empty text clears an optional text/date/assignee field. */
export const agentChatToolInputSchemas = {
  pm_query: z.strictObject({ entity: z.enum(['project', 'work_item', 'document']).nullable(), projectId: id.nullable(), query: z.string().max(500).nullable(), ...page }),
  pm_read: z.strictObject({ id, bodyOffset: z.number().int().min(0).max(4000000), bodyLimit: z.number().int().min(1).max(12000) }),
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
} as const;

export type AgentChatToolName = keyof typeof agentChatToolInputSchemas;
export type AgentChatToolInput<Name extends AgentChatToolName> = z.infer<typeof agentChatToolInputSchemas[Name]>;
export const AGENT_CHAT_TOOL_NAMES = Object.keys(agentChatToolInputSchemas) as AgentChatToolName[];
const descriptions: Record<AgentChatToolName, string> = {
  pm_query: 'Search authorized projects, tasks and documents by text; stable ID pagination. Summaries are not full bodies.',
  pm_read: 'Read one authorized project, task or document with its current revision and a bounded Markdown body page.',
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
};
const readOnlyTools: readonly AgentChatToolName[] = ['pm_query', 'pm_read', 'pm_read_comments', 'pm_read_relations'];
const lifecycleTools: readonly AgentChatToolName[] = ['pm_archive_task', 'pm_restore_task', 'pm_delete_task'];
const capabilitiesFor = (name: AgentChatToolName): Capability[] => {
  if (name === 'pm_create_comment') return ['domain.read', 'intent.propose'];
  if (lifecycleTools.includes(name)) return ['domain.read', 'planning.lifecycle'];
  if (readOnlyTools.includes(name)) return ['domain.read'];
  // Lifecycle-only capabilities (workitem.complete / workitem.cancel_reopen) are checked against the exact target state at call time.
  return ['domain.read', 'planning.edit'];
};
export const AGENT_CHAT_TOOL_REGISTRY = AGENT_CHAT_TOOL_NAMES.map(name => ({
  name, description: descriptions[name], write: !readOnlyTools.includes(name),
  capabilities: capabilitiesFor(name),
}));
export const agentChatToolDefinitions = AGENT_CHAT_TOOL_REGISTRY.map(tool => ({ type: 'function' as const, function: {
  name: tool.name, description: tool.description, strict: true,
  parameters: z.toJSONSchema(agentChatToolInputSchemas[tool.name], { unrepresentable: 'any' }),
} }));

export type AgentChatToolScope = { kind: 'workspace' | 'projects'; projectIds: readonly string[] };
export type AgentChatToolContext = {
  actor: Actor;
  workspaceId: string;
  threadId: string;
  messageId: string;
  operationId: string;
  scope: AgentChatToolScope;
  signal?: AbortSignal;
  /** Recheck the current PM actor and project scope inside the native mutation lock. */
  checkAuthorization?: (sql: SqlExecutor) => Promise<void>;
};
export function parseAgentChatToolInput<Name extends AgentChatToolName>(name: Name, input: unknown): AgentChatToolInput<Name> {
  const schema = agentChatToolInputSchemas[name];
  if (!schema) throw new DomainError('agent_tool_not_available', 'This tool is not registered', 403);
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new DomainError('agent_tool_invalid_input', 'Tool arguments do not match the registered schema', 400);
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
/** Lifecycle tools change exactly one lifecycle field of an existing work item and never move it between projects. */
export function assertAgentToolLifecycleMutation(before: FileRecord | undefined, after: Entity, expected: { archived?: boolean; status?: string }): void {
  if (!before || before.entity.entity !== 'work_item' || after.entity !== 'work_item') {
    throw new DomainError('agent_tool_protected_action', 'Lifecycle tools operate only on existing work items', 403);
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
