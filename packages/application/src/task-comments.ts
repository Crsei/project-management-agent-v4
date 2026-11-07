import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import { assertProjectWritable, assertRule } from '../../domain/src/planning.ts';
import { taskCommentContentSchema, taskCommentIdSchema, type TaskComment, type TaskCommentHistoryOptions, type TaskCommentHistoryPage, type TaskCommentsOptions, type TaskCommentsPage } from '../../domain/src/task-comments.ts';
import { requireCapability } from './access.ts';
import type { DashboardReadContext } from './dashboard-read.ts';
import { appendProjectAudit } from './project-audit.ts';
import type { CommandContext, CommandRegistry, CoreAccess, SqlExecutor } from './ports.ts';
import { validateNewMentions } from './notification-mentions.ts';
import { freezeTaskWatchCandidates, insertServiceFact } from './service-facts.ts';

type CommentRow = { id: string; workspace_id: string; project_id: string; task_id: string; author_id: string; version: number; content: string; deleted_at: Date | null; created_at: Date; updated_at: Date };
type RevisionRow = { comment_id: string; version: number; action: 'created' | 'edited' | 'deleted' | 'restored'; content: string; actor_id: string; command_id: string; occurred_at: Date };
const uuid = z.uuid().toLowerCase();
const commentRef = { commentId: uuid };
export const taskCommentsOptionsSchema = z.strictObject({ projectId: taskCommentIdSchema, after: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
export const taskCommentHistoryOptionsSchema = z.strictObject({ projectId: taskCommentIdSchema, after: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
function fromRow(row: CommentRow): TaskComment {
  return { id: row.id, workspaceId: row.workspace_id, projectId: row.project_id, taskId: row.task_id, authorId: row.author_id, version: row.version,
    content: row.deleted_at ? null : row.content, deletedAt: row.deleted_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

/** Pinned project history never silently migrates to a new audience after a core move. */
async function assertBinding(sql: SqlExecutor, workspaceId: string, taskId: string, projectId: string): Promise<void> {
  const mismatch = await sql.query('SELECT 1 FROM task_comments WHERE workspace_id=$1 AND task_id=$2 AND project_id<>$3 LIMIT 1', [workspaceId, taskId, projectId]);
  if (mismatch.rows.length) throw new DomainError('task_comment_project_changed', 'Task comments retain their original project. Moving their history to a new project requires an explicit retention and access decision.', 409);
}
async function currentTask(core: Pick<CoreAccess, 'get'>, taskId: string, projectId: string) {
  taskCommentIdSchema.parse(taskId);
  const task = await core.get(taskId, 'work_item');
  if (task.projectId !== projectId) throw new DomainError('not_found_or_forbidden', 'Task is not in the requested project', 404);
  await core.get(projectId, 'project');
  return task;
}
async function writeTask(ctx: CommandContext): Promise<string> {
  assertRule(ctx.command.targetId && ctx.command.projectId, 'task_project_required');
  assertRule(ctx.core, 'core_required');
  await ctx.require('domain.read', ctx.command.projectId);
  await ctx.require('intent.propose', ctx.command.projectId);
  const task = await currentTask(ctx.core, ctx.command.targetId, ctx.command.projectId);
  const project = await ctx.get(ctx.command.projectId, 'project');
  assertProjectWritable(project);
  assertRule(project.data.archived !== true && !project.data.archivedAt && task.data.archived !== true && !task.data.archivedAt, 'object_archived');
  const records = await ctx.core.records();
  for (const id of [task.id, project.id]) {
    const file = records.find(record => record.id === id);
    assertRule(file && !file.stale && !file.error && !file.diagnostics?.some(issue => issue.severity === 'error'), 'core_task_read_only', 'The authoritative task and project must be valid');
  }
  await assertBinding(ctx.sql, ctx.workspaceId, task.id, project.id);
  return project.id;
}
async function existing(ctx: CommandContext, projectId: string): Promise<CommentRow> {
  const result = await ctx.sql.query<CommentRow>('SELECT * FROM task_comments WHERE workspace_id=$1 AND project_id=$2 AND task_id=$3 AND id=$4', [ctx.workspaceId, projectId, ctx.command.targetId, ctx.command.payload.commentId]);
  const row = result.rows[0];
  if (!row) throw new DomainError('not_found_or_forbidden', 'Comment is not accessible', 404);
  if (row.author_id !== ctx.actor.id) throw new DomainError('permission_denied', 'Only the comment author can edit, delete or restore it', 403);
  if (ctx.command.expectedVersions?.[row.id] !== row.version) throw new DomainError('version_conflict', 'Comment version changed or expected version is missing', 409, { id: row.id, currentVersion: row.version });
  return row;
}
async function recordChange(ctx: CommandContext, row: CommentRow, action: RevisionRow['action'], newMentionIds: string[] = []) {
  await ctx.sql.query(`INSERT INTO task_comment_revisions(workspace_id,comment_id,version,action,content,actor_id,command_id,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [ctx.workspaceId, row.id, row.version, action, row.content, ctx.actor.id, ctx.command.commandId, row.updated_at]);
  await appendProjectAudit(ctx.sql, ctx.workspaceId, ctx.actor, [{ projectId: row.project_id, source: 'command', commandId: ctx.command.commandId, action: ctx.command.commandType,
    actorId: ctx.actor.id, occurredAt: row.updated_at.toISOString(), targetId: row.id, targetKind: 'task_comment', beforeVersion: row.version === 1 ? null : String(row.version - 1), afterVersion: String(row.version), changes: [], audienceActorId: null }]);
  // Bodies stay in permission-checked comments/revisions, never SSE or command receipts.
  await ctx.sql.query(`INSERT INTO outbox(event_id,workspace_id,project_id,aggregate_id,aggregate_kind,aggregate_version,aggregate_sequence,event_type,payload,actor_id,command_id)
    SELECT $1,$2,$3,$4,'task_comment',$5,coalesce(max(aggregate_sequence),0)+1,$6,$7::jsonb,$8,$9 FROM outbox WHERE workspace_id=$2 AND aggregate_id=$4`,
  [randomUUID(), ctx.workspaceId, row.project_id, row.id, row.version, `TaskComment${action[0]!.toUpperCase()}${action.slice(1)}`, JSON.stringify({ taskId: row.task_id, commentId: row.id }), ctx.actor.id, ctx.command.commandId]);
  await insertServiceFact(ctx.sql, ctx.workspaceId, {
    fact: { factId: randomUUID(), schemaVersion: 1, sourceKind: 'command', sourceKey: JSON.stringify([ctx.actor.id, ctx.command.commandId, row.id, row.version]),
      projectId: row.project_id, entityKind: 'task_comment', entityId: row.id, beforeRevision: row.version === 1 ? null : String(row.version - 1), afterRevision: String(row.version),
      changeKinds: [action === 'created' ? 'created' : action === 'edited' ? 'content_changed' : 'lifecycle_changed'], occurredAt: row.updated_at.toISOString(), observedAt: null, safetyClass: 'restricted_internal' },
    input: { actorId: ctx.actor.id, taskId: row.task_id, originalProjectId: row.project_id, commentId: row.id, commentVersion: row.version,
      watchCandidates: await freezeTaskWatchCandidates(ctx.sql, ctx.workspaceId, row.task_id, row.project_id), newMentionIds,
      ...(ctx.trustedSource ? { trustedOrigin: ctx.trustedSource.kind, requesterId: ctx.trustedSource.requesterId ?? null } : {}) },
  });
  return { id: row.id, taskId: row.task_id, projectId: row.project_id, version: row.version, action };
}
async function mutate(ctx: CommandContext, action: 'edited' | 'deleted' | 'restored') {
  const projectId = await writeTask(ctx);
  const previous = await existing(ctx, projectId);
  assertRule(action === 'restored' ? previous.deleted_at !== null : previous.deleted_at === null, action === 'restored' ? 'comment_not_deleted' : 'comment_deleted');
  const newMentionIds = action === 'edited' ? await validateNewMentions(ctx.sql, ctx.workspaceId, projectId, previous.content, ctx.command.payload.content as string) : [];
  const result = await ctx.sql.query<CommentRow>(`UPDATE task_comments SET content=$1,deleted_at=${action === 'deleted' ? 'clock_timestamp()' : 'NULL'},version=version+1,updated_at=clock_timestamp()
    WHERE workspace_id=$2 AND id=$3 AND version=$4 RETURNING *`, [action === 'edited' ? ctx.command.payload.content : previous.content, ctx.workspaceId, previous.id, previous.version]);
  if (!result.rows[0]) throw new DomainError('version_conflict', 'Comment version changed', 409);
  return recordChange(ctx, result.rows[0], action, newMentionIds);
}
export const taskCommentsCommands: CommandRegistry = {
  CreateTaskComment: { payload: z.strictObject({ content: taskCommentContentSchema }), async handler(ctx) {
    const projectId = await writeTask(ctx);
    const newMentionIds = await validateNewMentions(ctx.sql, ctx.workspaceId, projectId, '', ctx.command.payload.content as string);
    const result = await ctx.sql.query<CommentRow>('INSERT INTO task_comments(id,workspace_id,project_id,task_id,author_id,content) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [randomUUID(), ctx.workspaceId, projectId, ctx.command.targetId, ctx.actor.id, ctx.command.payload.content]);
    return recordChange(ctx, result.rows[0]!, 'created', newMentionIds);
  } },
  UpdateTaskComment: { payload: z.strictObject({ ...commentRef, content: taskCommentContentSchema }), handler: ctx => mutate(ctx, 'edited') },
  DeleteTaskComment: { payload: z.strictObject(commentRef), handler: ctx => mutate(ctx, 'deleted') },
  RestoreTaskComment: { payload: z.strictObject(commentRef), handler: ctx => mutate(ctx, 'restored') },
};

async function authorizeRead(ctx: DashboardReadContext, taskId: string, projectId: string) {
  await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'domain.read', projectId);
  await currentTask(ctx.core, taskId, projectId);
  await assertBinding(ctx.sql, ctx.workspaceId, taskId, projectId);
}
export async function readTaskComments(ctx: DashboardReadContext, taskId: string, options: TaskCommentsOptions): Promise<TaskCommentsPage> {
  const parsed = taskCommentsOptionsSchema.parse(options);
  await authorizeRead(ctx, taskId, parsed.projectId);
  const result = await ctx.sql.query<CommentRow>(`SELECT * FROM task_comments WHERE workspace_id=$1 AND project_id=$2 AND task_id=$3
    AND ($4::uuid IS NULL OR id>$4::uuid) ORDER BY id LIMIT $5`, [ctx.workspaceId, parsed.projectId, taskId, parsed.after ?? null, parsed.limit + 1]);
  const items = result.rows.slice(0, parsed.limit).map(fromRow);
  return { taskId, projectId: parsed.projectId, items, nextCursor: result.rows.length > parsed.limit ? items.at(-1)!.id : null };
}
export async function readTaskCommentHistory(ctx: DashboardReadContext, taskId: string, commentId: string, options: TaskCommentHistoryOptions): Promise<TaskCommentHistoryPage> {
  const parsed = taskCommentHistoryOptionsSchema.parse(options);
  uuid.parse(commentId);
  await authorizeRead(ctx, taskId, parsed.projectId);
  const comment = await ctx.sql.query('SELECT 1 FROM task_comments WHERE workspace_id=$1 AND project_id=$2 AND task_id=$3 AND id=$4', [ctx.workspaceId, parsed.projectId, taskId, commentId]);
  if (!comment.rows.length) throw new DomainError('not_found_or_forbidden', 'Comment is not accessible', 404);
  const result = await ctx.sql.query<RevisionRow>(`SELECT * FROM task_comment_revisions WHERE workspace_id=$1 AND comment_id=$2 AND version>$3 ORDER BY version LIMIT $4`, [ctx.workspaceId, commentId, parsed.after ?? 0, parsed.limit + 1]);
  const items = result.rows.slice(0, parsed.limit).map(row => ({ commentId: row.comment_id, version: row.version, action: row.action, content: row.content, actorId: row.actor_id, commandId: row.command_id, occurredAt: row.occurred_at.toISOString() }));
  return { taskId, projectId: parsed.projectId, commentId, items, nextCursor: result.rows.length > parsed.limit ? items.at(-1)!.version : null };
}
