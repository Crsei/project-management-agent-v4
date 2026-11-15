import { z } from 'zod';
import type { Capability } from '../../domain/src/core.ts';
import { changeHistoryTargetSchema, changeSequenceSchema } from '../../contracts/src/change-history.ts';

const id = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).max(80);
const uuid = z.uuid().toLowerCase();
const version = z.number().int().positive();
const cursor = z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(value => BigInt(value) <= 9223372036854775807n);
const comment = { projectId: id, taskId: id, commentId: uuid, version };
const contentPage = { offset: z.number().int().min(0).max(4000000), limit: z.number().int().min(1).max(12000) };
const notification = { eventId: uuid, projectId: id.nullable(), cursor: cursor.refine(value => value !== '0'), version };

export const CollaborationToolInputSchemas = {
  pm_edit_comment: z.strictObject({ ...comment, content: z.string().trim().min(1).max(16000) }),
  pm_delete_comment: z.strictObject(comment),
  pm_restore_comment: z.strictObject(comment),
  pm_read_comment_history: z.strictObject({ projectId: id, taskId: id, commentId: uuid, after: version.nullable(), limit: z.number().int().min(1).max(10) }),
  pm_read_change_history: z.strictObject({ target: changeHistoryTargetSchema, includeRelated: z.boolean(), cursor: changeSequenceSchema.nullable(), head: changeSequenceSchema.nullable(), limit: z.number().int().min(1).max(100) }),
  pm_read_change_detail: z.strictObject({ changeId: uuid, ...contentPage }),
  pm_compare_changes: z.strictObject({ target: changeHistoryTargetSchema, fromMode: z.enum(['reviewed', 'baseline', 'change']), fromChangeId: uuid.nullable(), toChangeId: uuid.nullable(), through: changeSequenceSchema.nullable(), ...contentPage }).refine(value => value.fromMode === 'change' ? value.fromChangeId !== null : value.fromChangeId === null, 'fromChangeId is required only for fromMode change'),
  pm_read_review_state: z.strictObject({ projectId: id.nullable(), taskIds: z.array(id).min(1).max(100).nullable(), afterTaskId: id.nullable() }),
  pm_acknowledge_changes: z.strictObject({ target: changeHistoryTargetSchema, through: changeSequenceSchema, observationToken: uuid }),
  pm_read_notifications: z.strictObject({ origin: z.enum(['routed', 'legacy_activity']), after: cursor.nullable(), through: cursor.nullable() }),
  pm_set_notification_read: z.strictObject({ ...notification, read: z.boolean() }),
  pm_set_notification_archived: z.strictObject({ ...notification, archived: z.boolean() }),
  pm_read_project_audit: z.strictObject({ projectId: id, cursor: z.string().min(1).max(2048).nullable(), limit: z.number().int().min(1).max(100), commandId: z.string().regex(/^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/).nullable(), operationId: uuid.nullable() }),
  pm_read_changes: z.strictObject({ projectId: id.nullable(), after: cursor }),
} as const;
export type CollaborationToolName = keyof typeof CollaborationToolInputSchemas;
export type CollaborationToolInput<Name extends CollaborationToolName> = z.infer<typeof CollaborationToolInputSchemas[Name]>;
type Metadata = { description: string; write: boolean; capabilities: Capability[]; scope: 'project' | 'workspace' | 'workspace-admin' };
const read = (description: string, scope: Metadata['scope'] = 'project'): Metadata => ({ description, write: false, capabilities: ['domain.read'], scope });
const commentWrite = (description: string): Metadata => ({ description, write: true, capabilities: ['domain.read', 'intent.propose'], scope: 'project' });
export const CollaborationToolMetadata = {
  pm_edit_comment: commentWrite('Edit your own task comment at its exact version. The original author and immutable revisions remain unchanged.'),
  pm_delete_comment: commentWrite('Soft-delete your own task comment at its exact version; retain immutable history.'),
  pm_restore_comment: commentWrite('Restore your own soft-deleted task comment at its exact version; retain immutable history.'),
  pm_read_comment_history: read('Read a bounded ascending page of immutable comment revisions, including deleted content, under current task/project authorization.'),
  pm_read_change_history: read('Read a fixed-head bounded entity or external-document history page and exact observation token, optionally including currently authorized related sources. Reading never acknowledges.'),
  pm_read_change_detail: read('Read an exact authorized change and a bounded page of both original raw snapshots. Continue offsets independently using nextOffset; revisions never change.'),
  pm_compare_changes: read('Compare exact authorized retained endpoints with bounded raw-source pages. fromMode reviewed starts at your acknowledged endpoint; baseline starts before retained history; change requires fromChangeId. Reading never acknowledges.'),
  pm_read_review_state: read('Read current personal pending-review counts for authorized tasks and related sources; reading never resets a watermark.'),
  pm_acknowledge_changes: { ...read('Acknowledge only the exact through watermark and observation token already issued to this actor and source scope. Newer changes remain pending. No durable operation receipt exists: ambiguous outcomes must not be replayed.'), write: true },
  pm_read_notifications: read('Read one bounded page of the current actor’s actual deliveries. Preserve head as through for subsequent pages. Reading does not mark read or archive.', 'workspace'),
  pm_set_notification_read: { ...read('Set only your own exact notification read state at its version. Supply its original delivery cursor and projectId; no bulk or implicit acknowledgement.', 'workspace'), write: true },
  pm_set_notification_archived: { ...read('Set only your own exact notification archived state at its version. Supply its original delivery cursor and projectId; archiving does not change read state.', 'workspace'), write: true },
  pm_read_project_audit: { ...read('Read a stable bounded page of current authorized project business audit/activity. Opaque cursors bind actor, project and exact command/operation filters.'), capabilities: ['domain.read', 'audit.read'] },
  pm_read_changes: read('Read one bounded page of currently authorized invalidation events, not unrestricted audit payloads or an infinite stream. Advance cursor even across hidden events; expired cursors require an authorized snapshot reload.', 'workspace'),
} satisfies Record<CollaborationToolName, Metadata>;
