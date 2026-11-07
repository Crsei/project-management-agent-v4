import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { SqlExecutor } from './ports.ts';
import { pmAutomationEventSchema } from '../../contracts/src/automation-pm.ts';
import { insertPmAutomationSignal } from './automation-pm-signals.ts';
import { capturedChangeSchema, insertChangeHistory, type HistorySnapshotReader } from './change-history.ts';

export const serviceFactSchema = z.strictObject({
 factId: z.uuid(), schemaVersion: z.literal(1), sourceKind: z.enum(['command','core_http','core_observation','legacy_activity']),
 sourceKey: z.string().min(1), projectId: z.string().nullable(), entityKind: z.string(), entityId: z.string(),
 beforeRevision: z.string().nullable(), afterRevision: z.string().nullable(),
 changeKinds: z.array(z.enum(['created','metadata_changed','content_changed','lifecycle_changed'])),
 occurredAt: z.iso.datetime().nullable(), observedAt: z.iso.datetime().nullable(), safetyClass: z.enum(['project_fact','restricted_internal']),
});
export type ServiceFactWrite = z.infer<typeof serviceFactSchema>;
export type ServiceFact = ServiceFactWrite & { workspaceId: string; factSequence: string; sourceDigest: string; recordedAt: string };
export const notificationInputSchema = z.strictObject({
 actorId: z.uuid().nullable(), taskId: z.string().nullable(), originalProjectId: z.string().nullable(),
 commentId: z.uuid().nullable().default(null), commentVersion: z.number().int().positive().nullable().default(null),
 watchCandidates: z.array(z.strictObject({ ownerId: z.uuid(), watchRecordId: z.uuid(), watchVersion: z.number().int().positive() })),
 newMentionIds: z.array(z.uuid()).max(50),
 completion: z.boolean().optional(), assigneeId: z.uuid().nullable().optional(), requesterId: z.uuid().nullable().optional(),
 trustedOrigin: z.enum(['manual','agent','automation']).optional(), changedFields: z.array(z.string()).optional(),
});
export type NotificationFactInput = z.infer<typeof notificationInputSchema>;
export const capturedServiceFactSchema = z.strictObject({ fact: serviceFactSchema, input: notificationInputSchema.nullable(), pmSignals: z.array(pmAutomationEventSchema).max(4).optional(), history: capturedChangeSchema.optional() });
export type CapturedServiceFact = z.infer<typeof capturedServiceFactSchema>;
export function factDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** Caller holds the workspace transaction lock. Frozen input participates in conflict detection. */
export async function insertServiceFact(sql: SqlExecutor, workspaceId: string, captured: CapturedServiceFact, readSnapshot?: HistorySnapshotReader): Promise<string> {
 const parsed = capturedServiceFactSchema.parse(captured), { fact, input } = parsed;
 const digest = factDigest(parsed);
 const prior = await sql.query<{ fact_id: string; source_digest: string }>('SELECT fact_id,source_digest FROM service_fact_events WHERE workspace_id=$1 AND source_kind=$2 AND source_key=$3', [workspaceId,fact.sourceKind,fact.sourceKey]);
 if (prior.rows[0]) {
  if (prior.rows[0].fact_id !== fact.factId || prior.rows[0].source_digest !== digest) throw new DomainError('fact_idempotency_conflict','A source identity has conflicting durable facts',409);
  return prior.rows[0].fact_id;
 }
 await sql.query(`INSERT INTO notification_activations(workspace_id,activation_fact_sequence,legacy_stream_cursor,migration_manifest)
 SELECT id,service_fact_head,stream_cursor,'{"legacyImplicitUnreadNotImported":true,"statesImported":0}'::jsonb FROM workspaces WHERE id=$1 ON CONFLICT DO NOTHING`,[workspaceId]);
 const head = await sql.query<{ sequence: string }>('UPDATE workspaces SET service_fact_head=service_fact_head+1 WHERE id=$1 RETURNING service_fact_head::text AS sequence',[workspaceId]);
 if (!head.rows[0]) throw new DomainError('not_found_or_forbidden',undefined,404);
 await sql.query(`INSERT INTO service_fact_events(fact_id,workspace_id,fact_sequence,schema_version,source_kind,source_key,source_digest,project_id,entity_kind,entity_id,before_revision,after_revision,change_kinds,occurred_at,observed_at,safety_class)
 VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[fact.factId,workspaceId,head.rows[0].sequence,fact.sourceKind,fact.sourceKey,digest,fact.projectId,fact.entityKind,fact.entityId,fact.beforeRevision,fact.afterRevision,fact.changeKinds,fact.occurredAt,fact.observedAt,fact.safetyClass]);
 if(parsed.history) {
  const {beforeKey,afterKey,...history}=parsed.history;
  if(!readSnapshot)throw new DomainError('history_snapshots_unavailable','The protected snapshot reader is required',503);
  const before=beforeKey?readSnapshot(beforeKey):null,after=afterKey?readSnapshot(afterKey):null;
  if(history.target.kind!=='core'||history.target.entityId!==fact.entityId||history.entityKind!==fact.entityKind||history.projectId!==fact.projectId||(before&&before.revision!==fact.beforeRevision)||(after&&after.revision!==fact.afterRevision))throw new DomainError('history_fact_scope_mismatch',undefined,409);
  await insertChangeHistory(sql,workspaceId,{...history,before,after,changeId:fact.factId,sourceKey:`fact:${fact.factId}`,changeKinds:fact.changeKinds,observedAt:fact.observedAt??new Date().toISOString(),occurredAt:fact.occurredAt});
 }
 if (input) {
  await sql.query(`INSERT INTO notification_fact_inputs(workspace_id,fact_id,actor_id,task_id,original_project_id,comment_id,comment_version,watch_candidates,new_mention_ids,completion,assignee_id,requester_id,trusted_origin,changed_fields)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)`,[workspaceId,fact.factId,input.actorId,input.taskId,input.originalProjectId,input.commentId,input.commentVersion,JSON.stringify(input.watchCandidates),input.newMentionIds,input.completion??false,input.assigneeId??null,input.requesterId??null,input.trustedOrigin??'manual',input.changedFields??[]]);
  if(input.taskId && input.originalProjectId && fact.changeKinds.length && fact.sourceKind!=='legacy_activity') await sql.query(`INSERT INTO notification_route_jobs(workspace_id,fact_id)
   SELECT $1,$2 FROM notification_activations WHERE workspace_id=$1 AND activation_fact_sequence<$3::bigint`,[workspaceId,fact.factId,head.rows[0].sequence]);
 }
 for (const event of parsed.pmSignals ?? []) {
  if (event.workspaceId !== workspaceId || event.projectId !== fact.projectId || event.sourceRef.id !== fact.entityId)
   throw new DomainError('automation_signal_scope_mismatch', 'Captured signal does not belong to its committed fact', 403);
  await insertPmAutomationSignal(sql, event);
 }
 return fact.factId;
}
export async function freezeTaskWatchCandidates(sql: SqlExecutor,workspaceId:string,taskId:string,projectId:string):Promise<NotificationFactInput['watchCandidates']> {
 const rows=await sql.query<{owner_id:string;id:string;version:number}>(`SELECT d.owner_id,d.id,d.version FROM dashboard_records d JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.owner_id JOIN users u ON u.id=m.user_id
 WHERE d.workspace_id=$1 AND d.project_id=$3 AND d.kind='task_watch' AND d.data->>'taskId'=$2 AND d.data->>'watching'='true'
 AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND 'domain.read'=ANY(m.capabilities) AND (m.project_ids IS NULL OR $3=ANY(m.project_ids)) ORDER BY d.owner_id,d.id`,[workspaceId,taskId,projectId]);
 return rows.rows.map(row=>({ownerId:row.owner_id,watchRecordId:row.id,watchVersion:row.version}));
}
