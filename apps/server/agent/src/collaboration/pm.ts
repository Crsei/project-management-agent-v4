import { z } from 'zod';
import { pmToolCallRecordSchema, type PmToolCallRecord, type PmToolRequest } from '@agent-workspace/contracts/pm-tools';
import { pmCollaborationSourceSchema, pmCommentAgentOriginSchema } from '../../../../../packages/agent-contracts/src/pm-tool-linkage.ts';
import { taskBriefSchema, type TaskBrief, type TaskBriefStage } from '@agent-workspace/contracts/task-brief';
import { taskCommentsPageSchema, type TaskCommentsPage } from '../../../../../packages/domain/src/task-comments.ts';
import { createPmToolLinkageBearer, pmToolRequestHash } from '../../../../../packages/infrastructure/src/pm-tool-service-auth.ts';
import { authorizePmTarget } from '../durable/pm-context.ts';
import { DurableError } from '../durable/errors.ts';
import { getChatGeneration } from '../durable/chat-runtime.ts';
import { pmFetch } from '../pm-tool-transport.ts';
import { requestDeliveryPm } from '../task-delivery/authority.ts';
import { getCollaborationGenerationContext } from './runs.ts';

export type CollaborationPmTarget = z.infer<typeof pmCollaborationSourceSchema.shape.target>;
const targetSchema = pmCollaborationSourceSchema.shape.target;
const coreFileSchema = z.object({
  id: z.string(), revision: z.string(), stale: z.boolean().optional(), error: z.unknown().optional(),
  diagnostics: z.array(z.object({ severity: z.string() })).optional(),
  entity: z.object({ entity: z.string(), project: z.string().optional(), archived: z.boolean().optional() }),
});

/** A current PM read identity and exact task version, never an Agent definition grant. */
export async function authorizeCollaborationTarget(targetInput: CollaborationPmTarget, headers: Headers, expectedActorId?: string): Promise<{ actorId: string }> {
  const target = targetSchema.parse(targetInput);
  const authority = await authorizePmTarget({ workspaceId: target.workspaceId, projectId: target.projectId }, headers);
  if (expectedActorId && authority.actorId !== expectedActorId)
    throw new DurableError(403, 'collaboration_actor_changed', 'The current PM actor differs from the original execution actor.');
  for (const [id, kind] of [[target.projectId, 'project'], [target.taskId, 'work_item']] as const) {
    const file = coreFileSchema.parse(await requestDeliveryPm(`/api/v1/workspaces/${encodeURIComponent(target.workspaceId)}/core/files/${encodeURIComponent(id)}`, headers));
    if (file.id !== id || file.entity.entity !== kind || kind === 'work_item' && file.entity.project !== target.projectId)
      throw new DurableError(409, 'collaboration_target_changed', 'The task no longer belongs to the original PM target.');
    if (file.stale || file.error || file.diagnostics?.some(issue => issue.severity === 'error') || file.entity.archived)
      throw new DurableError(409, 'collaboration_target_unavailable', 'The authoritative task or project is archived, stale or invalid.');
    if (kind === 'work_item' && file.revision !== target.taskRevision)
      throw new DurableError(409, 'task_revision_changed', 'The task brief changed. Explicitly re-plan against the current revision before starting new work.');
  }
  const current = await authorizePmTarget({ workspaceId: target.workspaceId, projectId: target.projectId }, headers);
  if (current.actorId !== authority.actorId)
    throw new DurableError(403, 'collaboration_actor_changed', 'PM identity changed while reading the execution target.');
  return { actorId: current.actorId };
}

/** Never dispatch a prefix of a task, or silently omit extracted requirements or relationships. */
export async function readCollaborationTaskBrief(targetInput: CollaborationPmTarget, headers: Headers, stage: TaskBriefStage = 'development'): Promise<{ actorId: string; brief: TaskBrief }> {
  const target = targetSchema.parse(targetInput), authority = await authorizeCollaborationTarget(target, headers);
  const query = new URLSearchParams({ revision: target.taskRevision, stage, bodyOffset: '0', bodyLimit: '48000' });
  const brief = taskBriefSchema.parse(await requestDeliveryPm(`/api/v1/workspaces/${encodeURIComponent(target.workspaceId)}/projects/${encodeURIComponent(target.projectId)}/tasks/${encodeURIComponent(target.taskId)}/brief?${query}`, headers));
  if (brief.task.workspaceId !== target.workspaceId || brief.task.projectId !== target.projectId || brief.task.taskId !== target.taskId || brief.task.revision !== target.taskRevision || brief.stage !== stage)
    throw new DurableError(503, 'collaboration_brief_mismatch', 'PM returned a brief for a different execution target or revision.');
  if (!brief.dispatchable || brief.truncation.truncated || brief.truncation.body || brief.truncation.statements || brief.truncation.relations || brief.task.bodyOffset !== 0 || brief.task.nextBodyOffset !== null || brief.task.body.length !== brief.task.bodyLength)
    throw new DurableError(409, 'task_brief_incomplete', 'The complete task brief exceeds the current execution context or contains omitted requirements. Narrow the task explicitly; it will not be silently truncated.');
  await authorizeCollaborationTarget(target, headers, authority.actorId);
  return { actorId: authority.actorId, brief };
}

/** Same live PM comments as the Issue, including human authors and tombstones. No Chat transcript projection. */
export async function readCollaborationDiscussion(targetInput: CollaborationPmTarget, headers: Headers, options: { after?: string; limit?: number } = {}): Promise<TaskCommentsPage> {
  const target = targetSchema.parse(targetInput);
  const pageOptions = z.strictObject({ after: z.uuid().optional(), limit: z.number().int().min(1).max(100).default(30) }).parse(options);
  await authorizePmTarget({ workspaceId: target.workspaceId, projectId: target.projectId }, headers);
  const query = new URLSearchParams({ projectId: target.projectId, limit: String(pageOptions.limit), ...(pageOptions.after ? { after: pageOptions.after } : {}) });
  const page = taskCommentsPageSchema.parse(await requestDeliveryPm(`/api/v1/workspaces/${encodeURIComponent(target.workspaceId)}/tasks/${encodeURIComponent(target.taskId)}/comments?${query}`, headers));
  if (page.taskId !== target.taskId || page.projectId !== target.projectId || page.items.some(item => item.workspaceId !== target.workspaceId || item.projectId !== target.projectId || item.taskId !== target.taskId))
    throw new DurableError(503, 'collaboration_discussion_mismatch', 'PM returned a discussion outside the requested target.');
  await authorizePmTarget({ workspaceId: target.workspaceId, projectId: target.projectId }, headers);
  return page;
}

const publicationSchema = pmCollaborationSourceSchema.extend({
  operationId: z.uuid().toLowerCase(), actorId: z.uuid(), threadId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200), generationId: z.string().min(1).max(200),
  content: z.string().trim().min(1).max(8000),
  delegationId: pmCollaborationSourceSchema.shape.delegationId.optional(),
}).strict();
export type CollaborationCommentPublication = z.input<typeof publicationSchema>;

/** No HTTP body can create this request: the actual persisted Run and Chat generation must agree. */
function publicationRequest(input: CollaborationCommentPublication): { input: z.infer<typeof publicationSchema>; request: PmToolRequest } {
  const value = publicationSchema.parse(input), context = getCollaborationGenerationContext(value.generationId), generation = getChatGeneration(value.generationId);
  if (!context || !generation || context.runId !== value.runId || context.agentId !== value.agentId || context.agentVersion !== value.agentVersion ||
    (context.delegationId ?? null) !== (value.delegationId ?? null) || context.threadId !== value.threadId || context.actorId !== value.actorId ||
    generation.threadId !== value.threadId || generation.messageId !== value.messageId || generation.inputMessageId !== context.inputMessageId ||
    JSON.stringify(targetSchema.parse(context.target)) !== JSON.stringify(value.target))
    throw new DurableError(409, 'collaboration_origin_unverified', 'The comment origin does not match the actual server-owned Run and generation.');
  const collaboration = pmCollaborationSourceSchema.parse({ runId: context.runId, agentId: context.agentId, agentVersion: context.agentVersion,
    delegationId: context.delegationId ?? null, target: context.target });
  const request: PmToolRequest = {
    operationId: value.operationId, name: 'pm_create_comment', arguments: { projectId: value.target.projectId, taskId: value.target.taskId, content: value.content },
    target: { workspaceId: value.target.workspaceId, projectId: value.target.projectId }, threadId: value.threadId, messageId: value.messageId, generationId: value.generationId,
    linkage: { traceId: z.uuid().parse(generation.traceId), invocationId: value.operationId, executionRoot: 'generation',
      ...(generation.inputMessageId ? { inputMessageId: generation.inputMessageId } : {}), ...(generation.executionGrantId ? { executionGrantId: generation.executionGrantId } : {}),
      clientKind: 'chat', policy: 'full', enforcement: 'audit-only', collaboration },
  };
  return { input: value, request };
}

async function originalComment(input: CollaborationCommentPublication, headers: Headers, reconcile: boolean): Promise<PmToolCallRecord> {
  const original = publicationRequest(input), value = original.input, request = original.request;
  if (reconcile) {
    const authority = await authorizePmTarget(request.target, headers);
    if (authority.actorId !== value.actorId) throw new DurableError(403, 'collaboration_actor_changed', 'Only the original PM actor can reconcile this comment operation.');
  } else await authorizeCollaborationTarget(value.target, headers, value.actorId);
  const signed = new Headers(headers);
  signed.set('x-pm-tool-linkage', createPmToolLinkageBearer(value.actorId, pmToolRequestHash(request, value.actorId), request.linkage!));
  // /result only queries the original operation/command receipt. Unknown is not a retry or a new key.
  const result = pmToolCallRecordSchema.parse(await pmFetch(value.target.workspaceId, reconcile ? '/result' : '/call', signed, request));
  if (result.operationId !== value.operationId || result.actorId !== value.actorId || result.name !== request.name || result.threadId !== value.threadId ||
    result.messageId !== value.messageId || result.generationId !== value.generationId || result.workspaceId !== value.target.workspaceId ||
    result.target?.workspaceId !== value.target.workspaceId || result.target.projectId !== value.target.projectId)
    throw new DurableError(503, 'collaboration_comment_receipt_mismatch', 'PM returned a receipt for another original operation.');
  if (result.status === 'succeeded') {
    const comment = result.result?.kind === 'comment' && result.result.items.length === 1 ? result.result.items[0] : null;
    const expectedOrigin = pmCommentAgentOriginSchema.parse({ ...request.linkage!.collaboration, operationId: value.operationId, threadId: value.threadId, generationId: value.generationId });
    if (!comment || comment.taskId !== value.target.taskId || comment.projectId !== value.target.projectId || comment.authorId !== value.actorId ||
      JSON.stringify(comment.origin) !== JSON.stringify(expectedOrigin) || result.result?.receipt?.commandId !== value.operationId || result.result.receipt.operationId !== value.operationId ||
      result.result.receipt.action !== 'CreateTaskComment' || result.result.receipt.targetId !== comment.id)
      throw new DurableError(503, 'collaboration_comment_receipt_mismatch', 'The original PM comment has no matching trusted origin and human author. Reconcile this operation; do not publish a replacement.');
  }
  return result;
}

export async function publishCollaborationComment(input: CollaborationCommentPublication, headers: Headers): Promise<PmToolCallRecord> {
  return originalComment(input, headers, false);
}

export async function reconcileCollaborationComment(input: CollaborationCommentPublication, headers: Headers): Promise<PmToolCallRecord> {
  return originalComment(input, headers, true);
}
