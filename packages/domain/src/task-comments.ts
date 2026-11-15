import { z } from 'zod';

export const taskCommentIdSchema = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
export const taskCommentContentSchema = z.string().trim().min(1).max(16000);

/** Server-attested execution identity, never a comment author or an authorization grant. */
export const agentCollaborationSourceSchema = z.strictObject({
  runId: z.string().trim().min(1).max(128), agentId: z.string().trim().min(1).max(128), agentVersion: z.number().int().positive(),
  delegationId: z.string().trim().min(1).max(128).nullable(),
  target: z.strictObject({
    workspaceId: z.uuid(), projectId: taskCommentIdSchema.max(80), taskId: taskCommentIdSchema.max(80),
    taskRevision: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
export const taskCommentAgentOriginSchema = agentCollaborationSourceSchema.extend({
  operationId: z.uuid(), threadId: z.string().min(1).max(200), generationId: z.string().min(1).max(200),
}).strict();
export type AgentCollaborationSource = z.infer<typeof agentCollaborationSourceSchema>;
export type TaskCommentAgentOrigin = z.infer<typeof taskCommentAgentOriginSchema>;
export const taskCommentSchema = z.strictObject({
  id: z.uuid(), workspaceId: z.uuid(), projectId: taskCommentIdSchema, taskId: taskCommentIdSchema,
  authorId: z.uuid(), version: z.number().int().positive(), content: z.string().nullable(),
  deletedAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  origin: taskCommentAgentOriginSchema.nullable().optional(),
});
export const taskCommentRevisionSchema = z.strictObject({
  commentId: z.uuid(), version: z.number().int().positive(), action: z.enum(['created', 'edited', 'deleted', 'restored']),
  content: z.string(), actorId: z.uuid(), commandId: z.uuid(), occurredAt: z.iso.datetime(),
  origin: taskCommentAgentOriginSchema.nullable().optional(),
});
export const taskCommentsPageSchema = z.strictObject({
  taskId: taskCommentIdSchema, projectId: taskCommentIdSchema, items: z.array(taskCommentSchema), nextCursor: z.uuid().nullable(),
});
export const taskCommentHistoryPageSchema = z.strictObject({
  taskId: taskCommentIdSchema, projectId: taskCommentIdSchema, commentId: z.uuid(),
  items: z.array(taskCommentRevisionSchema), nextCursor: z.number().int().positive().nullable(),
});
export type TaskComment = z.infer<typeof taskCommentSchema>;
export type TaskCommentRevision = z.infer<typeof taskCommentRevisionSchema>;
export type TaskCommentsPage = z.infer<typeof taskCommentsPageSchema>;
export type TaskCommentHistoryPage = z.infer<typeof taskCommentHistoryPageSchema>;
export type TaskCommentsOptions = { projectId: string; after?: string; limit?: number };
export type TaskCommentHistoryOptions = { projectId: string; after?: number; limit?: number };
