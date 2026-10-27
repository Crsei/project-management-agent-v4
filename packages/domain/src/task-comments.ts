import { z } from 'zod';

export const taskCommentIdSchema = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
export const taskCommentContentSchema = z.string().trim().min(1).max(16000);
export const taskCommentSchema = z.strictObject({
  id: z.uuid(), workspaceId: z.uuid(), projectId: taskCommentIdSchema, taskId: taskCommentIdSchema,
  authorId: z.uuid(), version: z.number().int().positive(), content: z.string().nullable(),
  deletedAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export const taskCommentRevisionSchema = z.strictObject({
  commentId: z.uuid(), version: z.number().int().positive(), action: z.enum(['created', 'edited', 'deleted', 'restored']),
  content: z.string(), actorId: z.uuid(), commandId: z.uuid(), occurredAt: z.iso.datetime(),
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
