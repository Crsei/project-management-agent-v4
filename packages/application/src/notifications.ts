import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError,type Actor } from '../../domain/src/core.ts';
import type { NotificationInboxItem,NotificationInboxOptions,NotificationInboxPage,NotificationState } from '../../domain/src/notifications.ts';
import type { NotificationCorePort,ReadonlyCoreSnapshot } from '../../pm-core/readonly.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { requireDashboardReadSelf } from './dashboard-read.ts';
import type { Membership } from './access.ts';
import type { CommandContext,CommandRegistry,SqlExecutor } from './ports.ts';
import { emitNotificationInvalidation,notificationTaskVisible } from './notification-routing.ts';
const cursor=z.string().regex(/^\d{1,19}$/).refine(value=>BigInt(value)<=9223372036854775807n);
export const notificationInboxQuery=z.strictObject({origin:z.enum(['routed','legacy_activity']).optional(),after:cursor.optional(),through:cursor.optional()});
type Row={fact_id:string;delivery_cursor:string;origin:'routed'|'legacy_activity';reason_set:NotificationInboxItem['reasons'];state_version:number;read_at:Date|null;archived_at:Date|null;project_id:string|null;entity_id:string;entity_kind:string;after_revision:string|null;change_kinds:string[];occurred_at:Date|null;observed_at:Date|null;recorded_at:Date;task_id:string|null;comment_id:string|null;audience_actor_id:string|null;legacy_event_type:string|null;legacy_quarantined:boolean;completion:boolean;changed_fields:string[];trusted_origin:'manual'|'agent'|'automation';source_kind:string;history_id:string|null};
const select=`SELECT r.fact_id,r.delivery_cursor::text,r.origin,r.reason_set,r.state_version,r.read_at,r.archived_at,f.project_id,f.entity_id,f.entity_kind,f.after_revision,f.change_kinds,f.occurred_at,f.observed_at,f.recorded_at,i.task_id,i.comment_id,i.audience_actor_id,i.legacy_event_type,i.legacy_quarantined,i.completion,i.changed_fields,i.trusted_origin,f.source_kind,h.change_id AS history_id
 FROM notification_recipients r JOIN service_fact_events f USING(workspace_id,fact_id) JOIN notification_fact_inputs i USING(workspace_id,fact_id) LEFT JOIN change_history_entries h ON h.workspace_id=f.workspace_id AND h.change_id=f.fact_id`;
function state(row:Row):NotificationState{return {eventId:row.fact_id,version:row.state_version,readAt:row.read_at?.toISOString()??null,archivedAt:row.archived_at?.toISOString()??null};}
async function visible(sql:SqlExecutor,workspaceId:string,row:Row,actorId:string,member:Membership,snapshot:ReadonlyCoreSnapshot|null):Promise<boolean> {
 if(row.audience_actor_id!==null&&row.audience_actor_id!==actorId) return false;
 if(member.projectIds!==null && (row.project_id?!member.projectIds.includes(row.project_id):row.audience_actor_id!==actorId)) return false;
 if(row.origin==='legacy_activity') return !row.legacy_quarantined;
 if(!snapshot||!row.task_id||!row.project_id||!notificationTaskVisible(snapshot,row.task_id,row.project_id)) return false;
 if(row.comment_id) {
  const result=await sql.query('SELECT 1 FROM task_comments WHERE workspace_id=$1 AND id=$2 AND task_id=$3 AND project_id=$4',[workspaceId,row.comment_id,row.task_id,row.project_id]);
  if(!result.rows.length) return false;
 }
 return true;
}
function item(row:Row):NotificationInboxItem {
 return {cursor:row.delivery_cursor,event:{eventId:row.fact_id,eventType:row.legacy_event_type??(row.entity_kind==='task_comment'?'TaskCommentChanged':row.completion?'WorkItemCompleted':`WorkItem:${row.change_kinds.join('+')}`),projectId:row.project_id,entityId:row.entity_id,entityKind:row.entity_kind,revision:row.after_revision,
 occurredAt:row.occurred_at?.toISOString()??null,observedAt:row.observed_at?.toISOString()??null,recordedAt:row.recorded_at.toISOString(),...(row.source_kind==='legacy_activity'?{}:{changedFields:row.changed_fields,completion:row.completion,origin:row.source_kind==='core_observation'?'observation' as const:row.trusted_origin})},origin:row.origin,
 target:row.origin==='routed'&&row.task_id?{taskId:row.task_id,...(row.comment_id?{commentId:row.comment_id}:{}),...(row.history_id?{changeId:row.history_id}:{})}:null,reasons:row.reason_set,state:state(row)};
}
/** Scans only this actor's actual deliveries. Hidden positions still advance a fixed snapshot. */
export async function readNotificationInbox(pool:Pool,actor:Actor,workspaceId:string,core:NotificationCorePort,options:NotificationInboxOptions={}):Promise<NotificationInboxPage> {
 const parsed=notificationInboxQuery.safeParse(options);if(!parsed.success) throw new DomainError('invalid_cursor');
 const origin=options.origin??'routed';
 const snapshot=origin==='routed'?await core.read(workspaceId):null;
 const sql=await pool.connect();
 try {
  await sql.query('BEGIN');await lockWorkspace(sql,workspaceId);
  const member=await requireDashboardReadSelf({sql,actor,workspaceId});
  if(snapshot && (await core.read(workspaceId)).fingerprint!==snapshot.fingerprint) throw new DomainError('core_source_changed','Read the current authoritative snapshot again',503);
  const bounds=await sql.query<{head:string;activated_at:Date;status:string|null;pending:boolean;failed:boolean}>(`SELECT w.notification_head::text AS head,a.activated_at,c.status,
  EXISTS(SELECT 1 FROM notification_route_jobs j WHERE j.workspace_id=w.id AND j.state<>'completed') AS pending,
  EXISTS(SELECT 1 FROM notification_route_jobs j WHERE j.workspace_id=w.id AND j.state='failed') AS failed FROM workspaces w JOIN notification_activations a ON a.workspace_id=w.id LEFT JOIN service_fact_import_checkpoints c ON c.workspace_id=w.id WHERE w.id=$1`,[workspaceId]);
  const bound=bounds.rows[0];if(!bound) throw new DomainError('notification_not_activated','Notification migration/activation is not complete',503);
  const head=options.through??bound.head,after=options.after??'0';
  if(BigInt(head)>BigInt(bound.head)||BigInt(after)>BigInt(head)) throw new DomainError('invalid_cursor',undefined,409);
  const result=await sql.query<Row>(`${select} WHERE r.workspace_id=$1 AND r.recipient_id=$2 AND r.origin=$3 AND r.delivery_cursor>$4::bigint AND r.delivery_cursor<=$5::bigint ORDER BY r.delivery_cursor LIMIT 200`,[workspaceId,actor.id,origin,after,head]);
  const items:NotificationInboxItem[]=[];
  for(const row of result.rows) if(await visible(sql,workspaceId,row,actor.id,member,snapshot)) items.push(item(row));
  await sql.query('COMMIT');
  return {items,cursor:result.rows.at(-1)?.delivery_cursor??head,head,membershipVersion:member.version,sourceCoverage:'selected_saved_facts',historyBoundary:{activatedAt:bound.activated_at.toISOString(),legacyImplicitUnreadNotImported:true},
   processing:{status:bound.status==='error'||bound.failed?'error':bound.pending||bound.status!=='current'?'pending':'current',asOf:new Date().toISOString()}};
 }catch(error){await sql.query('ROLLBACK');throw error;}finally{sql.release();}
}
async function changeState(ctx:CommandContext,dimension:'read'|'archived',enabled:boolean):Promise<NotificationState> {
 await ctx.requireSelf();await ctx.sql.query("SELECT set_config('pm.audit_private','true',true)");
 if(ctx.command.projectId||!ctx.command.targetId||!z.uuid().safeParse(ctx.command.targetId).success) throw new DomainError('not_found_or_forbidden',undefined,404);
 const eventId=ctx.command.targetId.toLowerCase();
 const member=await requireDashboardReadSelf(ctx);
 const result=await ctx.sql.query<Row>(`${select} WHERE r.workspace_id=$1 AND r.recipient_id=$2 AND r.fact_id=$3`,[ctx.workspaceId,ctx.actor.id,eventId]);
 const row=result.rows[0];
 let snapshot:ReadonlyCoreSnapshot|null=null;
 if(row?.origin==='routed') {
  if(!ctx.core) throw new DomainError('core_required',undefined,503);
  await ctx.core.refresh?.();
  const files=await ctx.core.records();
  if(files.some(file=>file.stale||file.error||file.diagnostics?.some(issue=>issue.severity==='error'))) throw new DomainError('core_source_unavailable',undefined,503);
  snapshot={files,fingerprint:''};
 }
 if(!row||!await visible(ctx.sql,ctx.workspaceId,row,ctx.actor.id,member,snapshot)) throw new DomainError('not_found_or_forbidden',undefined,404);
 if(row.project_id) await ctx.require('domain.read',row.project_id);
 if(ctx.command.expectedVersions?.[eventId]!==row.state_version) throw new DomainError('version_conflict','Notification state changed or expected version is missing',409,{id:eventId,currentVersion:row.state_version});
 if((dimension==='read'?row.read_at!==null:row.archived_at!==null)===enabled) return state(row);
 const updated=await ctx.sql.query<Row>(`UPDATE notification_recipients SET state_version=state_version+1,
 read_at=CASE WHEN $4 THEN CASE WHEN $5 THEN clock_timestamp() END ELSE read_at END,
 archived_at=CASE WHEN NOT $4 THEN CASE WHEN $5 THEN clock_timestamp() END ELSE archived_at END
 WHERE workspace_id=$1 AND recipient_id=$2 AND fact_id=$3 AND state_version=$6 RETURNING fact_id,state_version,read_at,archived_at`,[ctx.workspaceId,ctx.actor.id,eventId,dimension==='read',enabled,row.state_version]);
 if(!updated.rows[0]) throw new DomainError('version_conflict',undefined,409);
 const value=state(updated.rows[0]);await emitNotificationInvalidation(ctx.sql,ctx.workspaceId,ctx.actor.id,ctx.command.commandId,value.version);return value;
}
export const notificationCommands:CommandRegistry={
 SetNotificationRead:{payload:z.strictObject({read:z.boolean()}),handler:ctx=>changeState(ctx,'read',ctx.command.payload.read as boolean)},
 SetNotificationArchived:{payload:z.strictObject({archived:z.boolean()}),handler:ctx=>changeState(ctx,'archived',ctx.command.payload.archived as boolean)},
};
/** Receipt recovery must not disclose an object that is no longer currently readable. */
export async function assertNotificationReceiptReadable(sql:SqlExecutor,actor:Actor,workspaceId:string,eventId:string,core:NotificationCorePort):Promise<void> {
  const member=await requireDashboardReadSelf({sql,actor,workspaceId});
  const result=await sql.query<Row>(`${select} WHERE r.workspace_id=$1 AND r.recipient_id=$2 AND r.fact_id=$3`,[workspaceId,actor.id,eventId]);
  const row=result.rows[0],snapshot=row?.origin==='routed'?await core.read(workspaceId):null;
  if(!row||!await visible(sql,workspaceId,row,actor.id,member,snapshot)) throw new DomainError('not_found_or_forbidden',undefined,404);
}
