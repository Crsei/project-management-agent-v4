import { z } from 'zod';
import { documentSourceIdSchema } from './document-sources.ts';

export const changeSequenceSchema = z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(value => {
  const last = value.charCodeAt(value.length - 1);
  return last >= 48 && last <= 57 && (value.length < 19 || value.length === 19 && value <= '9223372036854775807');
});
export const changeHistoryTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('core'), entityId: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal('external'), sourceId: documentSourceIdSchema, path: z.string().min(1).max(4096) }),
]);
export type ChangeHistoryTarget = z.infer<typeof changeHistoryTargetSchema>;
export const changeSnapshotSchema = z.strictObject({ revision: z.string(), body: z.string().nullable(), raw: z.string(), metadata: z.record(z.string(), z.unknown()).nullable() });
export type ChangeSnapshot = z.infer<typeof changeSnapshotSchema>;
export const changeSummarySchema = z.strictObject({
  changeId: z.uuid(), sequence: changeSequenceSchema, target: changeHistoryTargetSchema, entityKind: z.string(), projectId: z.string().nullable(),
  changeKinds: z.array(z.string()), changedFields: z.array(z.string()), origin: z.enum(['manual', 'agent', 'automation', 'observation']), actorId: z.uuid().nullable(),
  occurredAt: z.string().nullable(), observedAt: z.string(), beforeRevision: z.string().nullable(), afterRevision: z.string().nullable(),
  completeness: z.enum(['exact', 'observed_endpoints', 'baseline', 'missing_before']), relation: z.enum(['self', 'related_requirement', 'related_document']),
});
export type ChangeSummary = z.infer<typeof changeSummarySchema>;
export const changeHistoryQuerySchema = z.strictObject({ target: changeHistoryTargetSchema, includeRelated: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: changeSequenceSchema.optional(), head: changeSequenceSchema.optional() });
export type ChangeHistoryQuery = z.infer<typeof changeHistoryQuerySchema>;
export const changeHistoryPageSchema = z.strictObject({ items: z.array(changeSummarySchema).max(100), head: changeSequenceSchema, nextCursor: changeSequenceSchema.nullable(), reviewedThrough: changeSequenceSchema, pendingCount: z.number().int().nonnegative(), observationToken: z.uuid(), completeness: z.enum(['complete_since_capture', 'baseline_gap', 'observer_gap']) });
export type ChangeHistoryPage = z.infer<typeof changeHistoryPageSchema>;
export const changeDetailSchema = z.strictObject({ change: changeSummarySchema, before: changeSnapshotSchema.nullable(), after: changeSnapshotSchema.nullable() });
export type ChangeDetail = z.infer<typeof changeDetailSchema>;
export const changeCompareInputSchema = z.strictObject({ target: changeHistoryTargetSchema, fromChangeId: z.uuid().nullable().optional(), toChangeId: z.uuid().optional(), through: changeSequenceSchema.optional() });
export type ChangeCompareInput = z.infer<typeof changeCompareInputSchema>;
export const changeComparisonSchema = z.strictObject({ target: changeHistoryTargetSchema, before: changeSnapshotSchema.nullable(), after: changeSnapshotSchema.nullable(), fromChangeId: z.uuid().nullable(), toChangeId: z.uuid().nullable(), head: changeSequenceSchema, completeness: z.enum(['exact', 'observed_endpoints', 'baseline', 'missing_before']) });
export type ChangeComparison = z.infer<typeof changeComparisonSchema>;
export const changeAcknowledgeInputSchema = z.strictObject({ target: changeHistoryTargetSchema, through: changeSequenceSchema, observationToken: z.uuid() });
export type ChangeAcknowledgeInput = z.infer<typeof changeAcknowledgeInputSchema>;
export const changeAcknowledgementSchema = z.strictObject({ reviewedThrough: changeSequenceSchema, head: changeSequenceSchema, pendingCount: z.number().int().nonnegative() });
export type ChangeAcknowledgement = z.infer<typeof changeAcknowledgementSchema>;
export const taskAttentionQuerySchema = z.strictObject({ taskIds: z.array(z.string().min(1).max(128)).max(500).optional(), projectId: z.string().min(1).max(128).optional(), afterTaskId: z.string().min(1).max(128).optional() });
export type TaskAttentionQuery = z.infer<typeof taskAttentionQuerySchema>;
export const taskAttentionSummarySchema = z.strictObject({ taskId: z.string(), head: changeSequenceSchema, reviewedThrough: changeSequenceSchema, pendingCount: z.number().int().nonnegative(), ownPendingCount: z.number().int().nonnegative(), relatedPendingCount: z.number().int().nonnegative() });
export type TaskAttentionSummary = z.infer<typeof taskAttentionSummarySchema>;
export const taskAttentionPageSchema = z.strictObject({ items: z.array(taskAttentionSummarySchema).max(500), nextTaskId: z.string().nullable() });
export type TaskAttentionPage = z.infer<typeof taskAttentionPageSchema>;
