import { z } from 'zod';
import { agentChatToolResultFields } from './pm-tool-shared.ts';
import { pmCommentAgentOriginSchema } from './pm-tool-linkage.ts';

// Agent contracts build independently of PM's server/domain packages. These are
// finite wire projections of their native pages, not a second business model.
const id = z.string().min(1).max(128);
const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const sequence = z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(value => BigInt(value) <= 9223372036854775807n);
const target = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('core'), entityId: id }),
  z.strictObject({ kind: z.literal('external'), sourceId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/), path: z.string().min(1).max(4096) }),
]);
const summary = z.strictObject({
  changeId: uuid, sequence, target, entityKind: z.string(), projectId: z.string().nullable(),
  changeKinds: z.array(z.string()), changedFields: z.array(z.string()), origin: z.enum(['manual', 'agent', 'automation', 'observation']), actorId: uuid.nullable(),
  occurredAt: z.string().nullable(), observedAt: z.string(), beforeRevision: z.string().nullable(), afterRevision: z.string().nullable(),
  completeness: z.enum(['exact', 'observed_endpoints', 'baseline', 'missing_before']), relation: z.enum(['self', 'related_requirement', 'related_document']),
});
const history = z.strictObject({ items: z.array(summary).max(100), head: sequence, nextCursor: sequence.nullable(), reviewedThrough: sequence, pendingCount: z.number().int().nonnegative(), observationToken: uuid, completeness: z.enum(['complete_since_capture', 'baseline_gap', 'observer_gap']) });
const acknowledgement = z.strictObject({ reviewedThrough: sequence, head: sequence, pendingCount: z.number().int().nonnegative() });
const attention = z.strictObject({ items: z.array(z.strictObject({ taskId: z.string(), head: sequence, reviewedThrough: sequence, pendingCount: z.number().int().nonnegative(), ownPendingCount: z.number().int().nonnegative(), relatedPendingCount: z.number().int().nonnegative() })).max(500), nextTaskId: z.string().nullable() });
const commentHistory = z.strictObject({ taskId: id, projectId: id, commentId: uuid, items: z.array(z.strictObject({ commentId: uuid, version: z.number().int().positive(), action: z.enum(['created', 'edited', 'deleted', 'restored']), content: z.string().max(16000), actorId: uuid, commandId: uuid, occurredAt: timestamp, origin: pmCommentAgentOriginSchema.nullable().optional() })).max(10), nextCursor: z.number().int().positive().nullable() });
const notificationState = z.strictObject({ eventId: uuid, version: z.number().int().positive(), readAt: timestamp.nullable(), archivedAt: timestamp.nullable() });
const notification = z.strictObject({
  cursor: sequence, event: z.strictObject({ eventId: uuid, eventType: z.string(), projectId: z.string().nullable(), entityId: z.string(), entityKind: z.string(), revision: z.string().nullable(), occurredAt: timestamp.nullable(), observedAt: timestamp.nullable(), recordedAt: timestamp, changedFields: z.array(z.string()).optional(), completion: z.boolean().optional(), origin: z.enum(['manual', 'agent', 'automation', 'observation']).optional() }),
  origin: z.enum(['routed', 'legacy_activity']), target: z.strictObject({ taskId: z.string(), commentId: uuid.optional(), changeId: uuid.optional() }).nullable(), reasons: z.array(z.enum(['watch', 'mention', 'legacy_activity_state', 'assignee', 'requester', 'completion'])), state: notificationState,
});
const inbox = z.strictObject({ items: z.array(notification).max(200), cursor: sequence, head: sequence, membershipVersion: z.number().int().positive(), sourceCoverage: z.literal('selected_saved_facts'), historyBoundary: z.strictObject({ activatedAt: timestamp, legacyImplicitUnreadNotImported: z.boolean() }), processing: z.strictObject({ status: z.enum(['current', 'pending', 'error']), asOf: timestamp }) });
const auditValue = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const auditField = z.enum(['name', 'title', 'status', 'priority', 'archived', 'archivedAt', 'ownerId', 'assigneeId', 'startDate', 'dueDate', 'targetDate', 'due', 'start', 'end', 'owner', 'assignee', 'x-pm-start', 'favorite', 'artifactVersionId', 'mediaType', 'currency', 'budgetMinor', 'amountMinor', 'remainingEstimateMinor', 'actualMinor', 'forecastMinor', 'asOfDate', 'spentOn', 'confidence', 'completed', 'itemCount', 'completedCount', 'memberCount', 'teamCount', 'hiddenAt', 'hiddenBy']);
const audit = z.strictObject({ projectId: z.string().min(1).max(80), entries: z.array(z.strictObject({
  id: z.string().regex(/^[1-9]\d*$/), projectId: z.string().min(1).max(80), source: z.enum(['command', 'core_http']), commandId: z.string().min(1).max(128), action: z.string().min(1).max(100), actorId: uuid, occurredAt: timestamp, targetId: z.string().min(1).max(80), targetKind: z.string().min(1).max(80), beforeVersion: z.string().min(1).max(128).nullable(), afterVersion: z.string().min(1).max(128).nullable(), changes: z.array(z.strictObject({ field: auditField, before: auditValue, after: auditValue })).max(40), private: z.boolean(),
  correlation: z.strictObject({ operationId: uuid, traceId: uuid, invocationId: uuid, executionRoot: z.enum(['generation', 'external']), executionGrantId: uuid.optional(), delegationId: uuid.optional(), clientKind: z.enum(['chat', 'mcp', 'cli', 'plugin', 'automation', 'api']), policy: z.literal('full'), enforcement: z.literal('audit-only') }).optional(),
})).max(100), nextCursor: z.string().max(2048).nullable() });

export const collaborationSnapshotSchema = z.strictObject({ revision: z.string(), raw: z.string().max(12000), offset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(), totalLength: z.number().int().nonnegative() });
export const collaborationCommentMutationSchema = z.strictObject({ id: uuid, taskId: z.string(), projectId: z.string(), version: z.number().int().positive(), action: z.enum(['edited', 'deleted', 'restored']), authorId: uuid.optional(), origin: pmCommentAgentOriginSchema.nullable().optional() });
export const collaborationChangesPageSchema = z.strictObject({
  events: z.array(z.strictObject({ cursor: sequence, event: z.strictObject({ eventId: uuid, eventType: z.string(), workspaceId: uuid, projectId: z.string().nullable(), aggregateId: z.string(), aggregateKind: z.string(), aggregateVersion: z.number().int().nonnegative(), occurredAt: timestamp }) })).max(200), cursor: sequence, head: sequence,
});
const snapshots = { before: collaborationSnapshotSchema.nullable(), after: collaborationSnapshotSchema.nullable() };
export const CollaborationToolResultSchema = z.strictObject({
  kind: z.literal('collaboration'),
  result: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('comment_mutation'), mutation: collaborationCommentMutationSchema }),
    z.strictObject({ type: z.literal('comment_history'), page: commentHistory }),
    z.strictObject({ type: z.literal('history'), page: history }),
    z.strictObject({ type: z.literal('change_detail'), change: summary, ...snapshots }),
    z.strictObject({ type: z.literal('comparison'), target, fromChangeId: uuid.nullable(), toChangeId: uuid.nullable(), head: sequence, completeness: z.enum(['exact', 'observed_endpoints', 'baseline', 'missing_before']), ...snapshots }),
    z.strictObject({ type: z.literal('review_state'), page: attention }),
    z.strictObject({ type: z.literal('acknowledgement'), acknowledgement }),
    z.strictObject({ type: z.literal('notifications'), page: inbox }),
    z.strictObject({ type: z.literal('notification_state'), state: notificationState }),
    z.strictObject({ type: z.literal('audit'), page: audit }),
    z.strictObject({ type: z.literal('changes'), page: collaborationChangesPageSchema }),
  ]),
  ...agentChatToolResultFields,
});
export type CollaborationToolResult = z.infer<typeof CollaborationToolResultSchema>;
