import { z } from 'zod';
export type { NotificationState,NotificationReason,NotificationOrigin,NotificationInboxItem,NotificationInboxOptions,NotificationInboxPage } from '../../domain/src/notifications.ts';
const cursor=z.string().regex(/^\d{1,19}$/);
const timestamp=z.iso.datetime({offset:true});
export const notificationStateSchema=z.strictObject({eventId:z.uuid(),version:z.number().int().positive(),readAt:timestamp.nullable(),archivedAt:timestamp.nullable()});
export const notificationInboxItemSchema=z.strictObject({cursor,event:z.strictObject({eventId:z.uuid(),eventType:z.string(),projectId:z.string().nullable(),entityId:z.string(),entityKind:z.string(),revision:z.string().nullable(),occurredAt:timestamp.nullable(),observedAt:timestamp.nullable(),recordedAt:timestamp,changedFields:z.array(z.string()).optional(),completion:z.boolean().optional(),origin:z.enum(['manual','agent','automation','observation']).optional()}),origin:z.enum(['routed','legacy_activity']),
 target:z.strictObject({taskId:z.string(),commentId:z.uuid().optional(),changeId:z.uuid().optional()}).nullable(),reasons:z.array(z.enum(['watch','mention','legacy_activity_state','assignee','requester','completion'])),state:notificationStateSchema});
export const notificationInboxPageSchema=z.strictObject({items:z.array(notificationInboxItemSchema).max(200),cursor,head:cursor,membershipVersion:z.number().int().positive(),sourceCoverage:z.literal('selected_saved_facts'),historyBoundary:z.strictObject({activatedAt:timestamp,legacyImplicitUnreadNotImported:z.boolean()}),processing:z.strictObject({status:z.enum(['current','pending','error']),asOf:timestamp})});
export const mentionCandidatesPageSchema=z.strictObject({items:z.array(z.strictObject({userId:z.uuid(),name:z.string()})).max(50),nextCursor:z.uuid().nullable()});
export type MentionCandidatesPage=z.infer<typeof mentionCandidatesPageSchema>;
