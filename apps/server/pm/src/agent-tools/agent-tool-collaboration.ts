import type { Pool } from 'pg';
import { DomainError, type Actor, type Command, type CommandReceipt } from '../../../../../packages/domain/src/core.ts';
import type { DashboardReadContext } from '../../../../../packages/application/src/dashboard-read.ts';
import type { NotificationCorePort } from '../../../../../packages/pm-core/readonly.ts';
import type { ChangeSnapshot } from '../../../../../packages/contracts/src/change-history.ts';
import { notificationStateSchema } from '../../../../../packages/contracts/src/notifications.ts';
import { CollaborationToolInputSchemas, type CollaborationToolName, type CollaborationToolInput } from '../../../../../packages/application/src/agent-tool-collaboration.ts';
import { CollaborationToolResultSchema, collaborationCommentMutationSchema, type CollaborationToolResult } from '../../../../../packages/agent-contracts/src/pm-tool-collaboration.ts';
import type { AgentChatToolReceipt } from '../../../../../packages/agent-contracts/src/pm-tool-shared.ts';
import { assertAgentToolNotAborted, type AgentChatToolContext } from '../../../../../packages/application/src/agent-chat-tools.ts';
import { readTaskCommentHistory } from '../../../../../packages/application/src/task-comments.ts';
import { readProjectAudit } from '../../../../../packages/application/src/project-audit.ts';
import { readChanges } from '../../../../../packages/application/src/changes.ts';
import { readNotificationInbox } from '../../../../../packages/application/src/notifications.ts';
import { requestHash } from '../../../../../packages/application/src/kernel.ts';
import { lockWorkspace } from '../../../../../packages/infrastructure/src/database.ts';
import { readChangeHistory, readChangeDetail, compareChangeHistory, acknowledgeChangeHistory, readTaskAttention, authorizeChangeHistoryObservation, authorizeChangeHistoryEntries, type ChangeHistoryContext } from '../../../../../packages/application/src/change-history.ts';
import type { ExternalDocumentHistoryAddress } from '../../../../../packages/application/src/external-document-history.ts';
import { authorizeExternalDocumentHistory, resolveAuthorizedExternalDocumentHistoryAddress, type DocumentSourceContext } from '../../../../../packages/application/src/document-sources.ts';
import type { AgentChatToolFamily } from './agent-chat-tools.ts';

export type CollaborationToolFamilyOptions = {
  database: () => Pool;
  core: NotificationCorePort;
  sources: Omit<DocumentSourceContext, 'sql' | 'actor'>;
  applicationRead: <T>(actor: Actor, workspaceId: string, operation: (context: DashboardReadContext) => Promise<T>) => Promise<T>;
  executeCommand: (actor: Actor, workspaceId: string, command: Command, checkAuthorization?: AgentChatToolContext['checkAuthorization']) => Promise<CommandReceipt>;
  /** Exact original hash and current visibility, including notificationCore, must be checked by this native receipt reader. */
  readCommandReceipt: (actor: Actor, workspaceId: string, command: Command) => Promise<CommandReceipt | null>;
};
const names = Object.keys(CollaborationToolInputSchemas) as CollaborationToolName[];
const ownName = (name: string): CollaborationToolName => {
  if (!Object.hasOwn(CollaborationToolInputSchemas, name)) throw new DomainError('agent_tool_not_available', 'Unknown collaboration tool', 403);
  return name as CollaborationToolName;
};
const parse = <Name extends CollaborationToolName>(name: Name, input: unknown): CollaborationToolInput<Name> => CollaborationToolInputSchemas[name].parse(input) as CollaborationToolInput<Name>;
function allows(context: AgentChatToolContext, projectId: string | null): boolean {
  return context.scope.kind === 'workspace' || projectId !== null && context.scope.projectIds.includes(projectId);
}
function requireProject(context: AgentChatToolContext, projectId: string | null): void {
  if (!allows(context, projectId)) throw new DomainError('not_found_or_forbidden', 'Source is outside the currently authorized tool scope', 404);
}
function excerpt(snapshot: ChangeSnapshot | null, offset: number, limit: number) {
  if (!snapshot) return null;
  const start = Math.min(offset, snapshot.raw.length), end = Math.min(start + limit, snapshot.raw.length);
  return { revision: snapshot.revision, raw: snapshot.raw.slice(start, end), offset: start, nextOffset: end < snapshot.raw.length ? end : null, totalLength: snapshot.raw.length };
}
function result(value: CollaborationToolResult['result'], nextCursor: string | null = null, truncated = false, receipt?: AgentChatToolReceipt): CollaborationToolResult {
  return CollaborationToolResultSchema.parse({ kind: 'collaboration', result: value, nextCursor, truncated, sources: [], ...(receipt ? { receipt } : {}) });
}
function command(name: CollaborationToolName, input: unknown, context: AgentChatToolContext): Command | null {
  if (name === 'pm_edit_comment' || name === 'pm_delete_comment' || name === 'pm_restore_comment') {
    const args = parse(name, input);
    return { commandId: context.operationId, commandType: name === 'pm_edit_comment' ? 'UpdateTaskComment' : name === 'pm_delete_comment' ? 'DeleteTaskComment' : 'RestoreTaskComment',
      projectId: args.projectId, targetId: args.taskId, expectedVersions: { [args.commentId]: args.version },
      payload: { commentId: args.commentId, ...(name === 'pm_edit_comment' ? { content: parse('pm_edit_comment', input).content } : {}) } };
  }
  if (name === 'pm_set_notification_read') {
    const args = parse(name, input);
    return { commandId: context.operationId, commandType: 'SetNotificationRead', targetId: args.eventId, expectedVersions: { [args.eventId]: args.version }, payload: { read: args.read } };
  }
  if (name === 'pm_set_notification_archived') {
    const args = parse(name, input);
    return { commandId: context.operationId, commandType: 'SetNotificationArchived', targetId: args.eventId, expectedVersions: { [args.eventId]: args.version }, payload: { archived: args.archived } };
  }
  return null;
}

export function createCollaborationToolFamily(options: CollaborationToolFamilyOptions): AgentChatToolFamily {
  async function history<T>(context: AgentChatToolContext, operation: (value: ChangeHistoryContext) => Promise<T>): Promise<T> {
    const sql = await options.database().connect();
    try {
      await sql.query('BEGIN');
      await lockWorkspace(sql, context.workspaceId);
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('local-project-directories',724631))");
      await context.checkAuthorization?.(sql);
      const snapshot = await options.core.read(context.workspaceId);
      const sources = { ...options.sources, sql, actor: context.actor, checkProject: (projectId: string | null) => requireProject(context, projectId), ...(context.checkAuthorization ? { checkAuthorization: context.checkAuthorization } : {}) };
      const authorize = (address: ExternalDocumentHistoryAddress) => { requireProject(context, address.projectId); return address; };
      const value: ChangeHistoryContext = { sql, actor: context.actor, workspaceId: context.workspaceId,
        ...(context.scope.kind === 'projects' ? { authorizedProjectIds: context.scope.projectIds } : {}),
        snapshot: { ...snapshot, files: snapshot.files.filter(file => allows(context, file.entity.entity === 'project' ? file.id : file.entity.project ?? null)) },
        authorizeExternal: async target => authorize(await authorizeExternalDocumentHistory(sources, { workspaceId: context.workspaceId, sourceId: target.sourceId, path: target.path })),
        resolveExternal: async address => authorize(await resolveAuthorizedExternalDocumentHistoryAddress(sources, context.workspaceId, address)),
      };
      const answer = await operation(value);
      await context.checkAuthorization?.(sql);
      if ((await options.core.read(context.workspaceId)).fingerprint !== snapshot.fingerprint) throw new DomainError('core_source_changed', 'Read current authoritative sources again', 409);
      await sql.query('COMMIT');
      return answer;
    } catch (error) { await sql.query('ROLLBACK'); throw error; }
    finally { sql.release(); }
  }
  async function notificationAccess(context: AgentChatToolContext, args: CollaborationToolInput<'pm_set_notification_read'> | CollaborationToolInput<'pm_set_notification_archived'>) {
    requireProject(context, args.projectId);
    const after = (BigInt(args.cursor) - 1n).toString();
    for (const origin of ['routed', 'legacy_activity'] as const) {
      const page = await readNotificationInbox(options.database(), context.actor, context.workspaceId, options.core, { after, through: args.cursor, origin });
      const item = page.items.find(item => item.event.eventId === args.eventId && item.cursor === args.cursor);
      if (item) {
        if (item.event.projectId !== args.projectId) throw new DomainError('not_found_or_forbidden', 'Notification scope does not match', 404);
        requireProject(context, item.event.projectId);
        return;
      }
    }
    throw new DomainError('not_found_or_forbidden', 'Notification is not currently accessible', 404);
  }
  async function mutationAccess(name: CollaborationToolName, input: unknown, context: AgentChatToolContext) {
    if (name === 'pm_edit_comment' || name === 'pm_delete_comment' || name === 'pm_restore_comment') {
      const args = parse(name, input);
      requireProject(context, args.projectId);
      await options.applicationRead(context.actor, context.workspaceId, ctx => readTaskCommentHistory(ctx, args.taskId, args.commentId, { projectId: args.projectId, limit: 1 }));
    } else if (name === 'pm_set_notification_read' || name === 'pm_set_notification_archived') await notificationAccess(context, parse(name, input));
  }
  async function mutationResult(name: CollaborationToolName, input: unknown, context: AgentChatToolContext, native: CommandReceipt, recovering: boolean): Promise<CollaborationToolResult> {
    if (native.commandId !== context.operationId) throw new DomainError('agent_tool_receipt_mismatch', 'The original command receipt does not match', 409);
    if (native.status !== 'committed') {
      if (recovering) {
        if (/unknown|pending|recovered/i.test(native.error?.code ?? '')) throw new DomainError('agent_tool_outcome_unknown', 'The original outcome remains unknown', 409);
        throw new DomainError('agent_tool_recovered_rejection', 'The original native command was rejected; it was not replayed', 409);
      }
      throw new DomainError(native.error?.code ?? 'agent_tool_rejected', native.error?.message ?? 'The native command was rejected', native.httpStatus);
    }
    await mutationAccess(name, input, context);
    const original = command(name, input, context)!;
    if (name === 'pm_edit_comment' || name === 'pm_delete_comment' || name === 'pm_restore_comment') {
      const mutation = collaborationCommentMutationSchema.parse(native.result), args = parse(name, input);
      const expectedAction = name === 'pm_edit_comment' ? 'edited' : name === 'pm_delete_comment' ? 'deleted' : 'restored';
      if (mutation.id !== args.commentId || mutation.taskId !== args.taskId || mutation.projectId !== args.projectId || mutation.version !== args.version + 1 || mutation.action !== expectedAction) throw new DomainError('agent_tool_receipt_mismatch', 'Original comment result does not match the request', 409);
      return result({ type: 'comment_mutation', mutation }, null, false, { kind: 'command', operationId: context.operationId, commandId: native.commandId, action: original.commandType, targetId: mutation.id, revision: String(mutation.version), ...(context.linkage ? { linkage: context.linkage } : {}) });
    }
    const state = notificationStateSchema.parse(native.result);
    if (state.eventId !== original.targetId) throw new DomainError('agent_tool_receipt_mismatch', 'Original notification result does not match the request', 409);
    return result({ type: 'notification_state', state }, null, false, { kind: 'command', operationId: context.operationId, commandId: native.commandId, action: original.commandType, targetId: state.eventId, revision: String(state.version), ...(context.linkage ? { linkage: context.linkage } : {}) });
  }
  return {
    names,
    async execute(nameValue, input, context) {
      const name = ownName(nameValue);
      assertAgentToolNotAborted(context);
      const native = command(name, input, context);
      if (native) {
        await mutationAccess(name, input, context);
        assertAgentToolNotAborted(context);
        return mutationResult(name, input, context, await options.executeCommand(context.actor, context.workspaceId, native, context.checkAuthorization), false);
      }
      switch (name) {
        case 'pm_read_comment_history': {
          const args = parse(name, input); requireProject(context, args.projectId);
          const page = await options.applicationRead(context.actor, context.workspaceId, ctx => readTaskCommentHistory(ctx, args.taskId, args.commentId, { projectId: args.projectId, limit: args.limit, ...(args.after === null ? {} : { after: args.after }) }));
          return result({ type: 'comment_history', page }, page.nextCursor === null ? null : String(page.nextCursor), page.nextCursor !== null);
        }
        case 'pm_read_change_history': {
          const args = parse(name, input);
          const page = await history(context, ctx => readChangeHistory(ctx, { target: args.target, includeRelated: args.includeRelated, limit: args.limit, ...(args.cursor === null ? {} : { cursor: args.cursor }), ...(args.head === null ? {} : { head: args.head }) }));
          return result({ type: 'history', page }, page.nextCursor, page.nextCursor !== null);
        }
        case 'pm_read_change_detail': {
          const args = parse(name, input), detail = await history(context, ctx => readChangeDetail(ctx, args.changeId));
          const before = excerpt(detail.before, args.offset, args.limit), after = excerpt(detail.after, args.offset, args.limit);
          return result({ type: 'change_detail', change: detail.change, before, after }, null, before?.nextOffset != null || after?.nextOffset != null);
        }
        case 'pm_compare_changes': {
          const args = parse(name, input), comparison = await history(context, ctx => compareChangeHistory(ctx, { target: args.target, ...(args.fromMode === 'reviewed' ? {} : { fromChangeId: args.fromChangeId }), ...(args.toChangeId === null ? {} : { toChangeId: args.toChangeId }), ...(args.through === null ? {} : { through: args.through }) }));
          const before = excerpt(comparison.before, args.offset, args.limit), after = excerpt(comparison.after, args.offset, args.limit);
          return result({ type: 'comparison', ...comparison, before, after }, null, before?.nextOffset != null || after?.nextOffset != null);
        }
        case 'pm_read_review_state': {
          const args = parse(name, input); if (args.projectId) requireProject(context, args.projectId);
          const page = await history(context, ctx => readTaskAttention(ctx, { ...(args.projectId === null ? {} : { projectId: args.projectId }), ...(args.taskIds === null ? {} : { taskIds: args.taskIds }), ...(args.afterTaskId === null ? {} : { afterTaskId: args.afterTaskId }) }));
          return result({ type: 'review_state', page }, page.nextTaskId, page.nextTaskId !== null);
        }
        case 'pm_acknowledge_changes': {
          const args = parse(name, input), acknowledgement = await history(context, ctx => acknowledgeChangeHistory(ctx, args));
          return result({ type: 'acknowledgement', acknowledgement });
        }
        case 'pm_read_notifications': {
          const args = parse(name, input), page = await readNotificationInbox(options.database(), context.actor, context.workspaceId, options.core, { origin: args.origin, ...(args.after === null ? {} : { after: args.after }), ...(args.through === null ? {} : { through: args.through }) });
          const filtered = { ...page, items: page.items.filter(item => allows(context, item.event.projectId)) };
          return result({ type: 'notifications', page: filtered }, page.cursor === page.head ? null : page.cursor, page.cursor !== page.head);
        }
        case 'pm_read_project_audit': {
          const args = parse(name, input); requireProject(context, args.projectId);
          const page = await options.applicationRead(context.actor, context.workspaceId, ctx => readProjectAudit(ctx, args.projectId, { limit: args.limit, ...(args.cursor === null ? {} : { cursor: args.cursor }), ...(args.commandId === null ? {} : { commandId: args.commandId }), ...(args.operationId === null ? {} : { operationId: args.operationId }) }));
          return CollaborationToolResultSchema.parse({ kind: 'collaboration', result: { type: 'audit', page }, nextCursor: page.nextCursor, truncated: page.nextCursor !== null, sources: [] });
        }
        case 'pm_read_changes': {
          const args = parse(name, input); if (args.projectId) requireProject(context, args.projectId);
          const page = await readChanges(options.database(), context.actor, context.workspaceId, args.after, args.projectId ?? undefined);
          const filtered = { ...page, events: page.events.filter(item => allows(context, item.event.projectId)) };
          return result({ type: 'changes', page: filtered }, page.cursor === page.head ? null : page.cursor, page.cursor !== page.head);
        }
        default: throw new DomainError('agent_tool_not_available', 'Unknown collaboration operation', 403);
      }
    },
    async authorizeResult(nameValue, input, stored, context) {
      const name = ownName(nameValue), value = CollaborationToolResultSchema.parse(stored).result;
      parse(name, input);
      await context.checkAuthorization?.(options.database());
      if (command(name, input, context)) {
        await mutationAccess(name, input, context);
        if ((name === 'pm_edit_comment' || name === 'pm_delete_comment' || name === 'pm_restore_comment') ? value.type !== 'comment_mutation' : value.type !== 'notification_state') throw new DomainError('agent_tool_result_unavailable', 'Stored result does not match this operation', 409);
        return;
      }
      switch (name) {
        case 'pm_read_comment_history': {
          if (value.type !== 'comment_history') break;
          const args = parse(name, input); requireProject(context, args.projectId);
          await options.applicationRead(context.actor, context.workspaceId, ctx => readTaskCommentHistory(ctx, args.taskId, args.commentId, { projectId: args.projectId, limit: 1 }));
          return;
        }
        case 'pm_read_change_history': {
          if (value.type !== 'history') break;
          const args = parse(name, input);
          await history(context, ctx => authorizeChangeHistoryEntries(ctx, args.target, args.includeRelated, value.page.items));
          return;
        }
        case 'pm_read_change_detail': {
          if (value.type !== 'change_detail') break;
          const args = parse(name, input);
          await history(context, ctx => readChangeDetail(ctx, args.changeId));
          return;
        }
        case 'pm_compare_changes': {
          if (value.type !== 'comparison') break;
          const args = parse(name, input);
          await history(context, ctx => compareChangeHistory(ctx, { target: args.target, fromChangeId: value.fromChangeId, ...(value.toChangeId === null ? {} : { toChangeId: value.toChangeId }), through: value.head }));
          return;
        }
        case 'pm_read_review_state': {
          if (value.type !== 'review_state') break;
          const args = parse(name, input); if (args.projectId) requireProject(context, args.projectId);
          const current = await history(context, ctx => readTaskAttention(ctx, { taskIds: value.page.items.map(item => item.taskId) }));
          const visible = new Set(current.items.map(item => item.taskId));
          if (value.page.items.some(item => !visible.has(item.taskId))) throw new DomainError('not_found_or_forbidden', 'A retained review source is no longer visible', 404);
          return;
        }
        case 'pm_acknowledge_changes': {
          if (value.type !== 'acknowledgement') break;
          await history(context, ctx => authorizeChangeHistoryObservation(ctx, parse(name, input)));
          return;
        }
        case 'pm_read_notifications': {
          if (value.type !== 'notifications') break;
          const args = parse(name, input);
          const current = await readNotificationInbox(options.database(), context.actor, context.workspaceId, options.core, { origin: args.origin, ...(args.after === null ? {} : { after: args.after }), through: value.page.head });
          const visible = new Set(current.items.filter(item => allows(context, item.event.projectId)).map(item => `${item.cursor}:${item.event.eventId}`));
          if (value.page.items.some(item => !visible.has(`${item.cursor}:${item.event.eventId}`))) throw new DomainError('not_found_or_forbidden', 'A retained notification is no longer visible', 404);
          return;
        }
        case 'pm_read_project_audit': {
          if (value.type !== 'audit') break;
          const args = parse(name, input); requireProject(context, args.projectId);
          await options.applicationRead(context.actor, context.workspaceId, ctx => readProjectAudit(ctx, args.projectId, { limit: 1 }));
          return;
        }
        case 'pm_read_changes': {
          if (value.type !== 'changes') break;
          const args = parse(name, input); if (args.projectId) requireProject(context, args.projectId);
          const current = await readChanges(options.database(), context.actor, context.workspaceId, args.after, args.projectId ?? undefined);
          const visible = new Set(current.events.filter(item => allows(context, item.event.projectId)).map(item => `${item.cursor}:${item.event.eventId}`));
          if (value.page.events.some(item => !visible.has(`${item.cursor}:${item.event.eventId}`))) throw new DomainError('not_found_or_forbidden', 'A retained invalidation is no longer visible', 404);
          return;
        }
      }
      throw new DomainError('agent_tool_result_unavailable', 'Stored result does not match this operation', 409);
    },
    async recover(nameValue, input, context) {
      const name = ownName(nameValue), native = command(name, input, context);
      if (!native) return null;
      await mutationAccess(name, input, context);
      const receipt = await options.readCommandReceipt(context.actor, context.workspaceId, native);
      if (!receipt || receipt.status === 'rejected' && /unknown|pending|recovered/i.test(receipt.error?.code ?? '')) return null;
      return mutationResult(name, input, context, receipt, true);
    },
    recoveryIdentity(nameValue, input, context) {
      const name = ownName(nameValue); parse(name, input);
      const native = command(name, input, context);
      return native ? { kind: 'command', commandId: native.commandId, action: native.commandType, hash: requestHash(native as unknown as Record<string, unknown>) } : null;
    },
  };
}
