import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { DomainError } from '../../domain/src/core.ts';
import type { NotificationCorePort,ReadonlyCoreSnapshot } from '../../pm-core/readonly.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import type { SqlExecutor } from './ports.ts';
import type { NotificationFactInput } from './service-facts.ts';

type Job={workspace_id:string;fact_id:string;lease_epoch:string;candidate_after:string;actor_id:string|null;task_id:string;original_project_id:string;comment_id:string|null;watch_candidates:NotificationFactInput['watchCandidates'];new_mention_ids:string[];completion:boolean;assignee_id:string|null;requester_id:string|null;trusted_origin:'manual'|'agent'|'automation'};
export function notificationTaskVisible(snapshot:ReadonlyCoreSnapshot,taskId:string,projectId:string):boolean {
 const task=snapshot.files.find(file=>file.id===taskId),project=snapshot.files.find(file=>file.id===projectId);
 return !!task && task.entity.entity==='work_item'&&task.entity.project===projectId&&!!project&&project.entity.entity==='project';
}
export async function emitNotificationInvalidation(sql:SqlExecutor,workspaceId:string,actorId:string,commandId:string,version=1):Promise<void> {
 await sql.query(`INSERT INTO outbox(event_id,workspace_id,project_id,aggregate_id,aggregate_kind,aggregate_version,aggregate_sequence,event_type,payload,actor_id,command_id,audience_actor_id)
 SELECT $1,$2,NULL,$3,'notification_state',$4,coalesce(max(aggregate_sequence),0)+1,'NotificationInboxChanged','{}'::jsonb,$3,$5,$3 FROM outbox WHERE workspace_id=$2 AND aggregate_id=$3`,[randomUUID(),workspaceId,actorId,version,commandId]);
}
/** One durable lease per fact. Pure SQL effects commit together; no external delivery unknown state. */
export async function routeNotificationBatch(pool:Pool,core:NotificationCorePort,owner:string,options:{jobLimit?:number;candidateLimit?:number;leaseMs?:number}={}):Promise<{jobs:number;delivered:number}> {
 const limit=Math.min(100,Math.max(1,options.candidateLimit??100)),leaseMs=Math.max(1000,options.leaseMs??30_000);
 const due=await pool.query<{workspace_id:string;fact_id:string}>(`SELECT workspace_id,fact_id FROM notification_route_jobs WHERE
 (state='pending' AND next_attempt_at<=clock_timestamp()) OR (state='running' AND lease_until<clock_timestamp()) ORDER BY next_attempt_at,workspace_id,fact_id LIMIT $1`,[Math.min(20,Math.max(1,options.jobLimit??4))]);
 let jobs=0,delivered=0;
 for(const candidate of due.rows) {
  const claim=await pool.connect();let job:Job|undefined;
  try {
   await claim.query('BEGIN');await lockWorkspace(claim,candidate.workspace_id);
   const result=await claim.query<Job>(`WITH claimed AS (UPDATE notification_route_jobs SET state='running',lease_owner=$3,lease_until=clock_timestamp()+($4::integer*interval '1 millisecond'),lease_epoch=lease_epoch+1
    WHERE workspace_id=$1 AND fact_id=$2 AND ((state='pending' AND next_attempt_at<=clock_timestamp()) OR (state='running' AND lease_until<clock_timestamp())) RETURNING *)
    SELECT c.workspace_id,c.fact_id,c.lease_epoch::text,c.candidate_after,i.actor_id,i.task_id,i.original_project_id,i.comment_id,i.watch_candidates,i.new_mention_ids,i.completion,i.assignee_id,i.requester_id,i.trusted_origin FROM claimed c JOIN notification_fact_inputs i USING(workspace_id,fact_id)`,[candidate.workspace_id,candidate.fact_id,owner,leaseMs]);
   job=result.rows[0];await claim.query('COMMIT');
  }catch(error){await claim.query('ROLLBACK');throw error;}finally{claim.release();}
  if(!job) continue;
  jobs++;
  try {
   const snapshot=await core.read(job.workspace_id);
   const ids=[...new Set([...job.watch_candidates.map(value=>value.ownerId),...job.new_mention_ids,...(job.completion&&job.assignee_id?[job.assignee_id]:[]),...(job.completion&&job.requester_id?[job.requester_id]:[])])].filter(id=>id>job!.candidate_after).sort();
   const page=ids.slice(0,limit);
   const sql=await pool.connect();
   try {
    await sql.query('BEGIN');await lockWorkspace(sql,job.workspace_id);
    const active=await sql.query('SELECT 1 FROM notification_route_jobs WHERE workspace_id=$1 AND fact_id=$2 AND state=\'running\' AND lease_owner=$3 AND lease_epoch=$4 AND lease_until>clock_timestamp()',[job.workspace_id,job.fact_id,owner,job.lease_epoch]);
    if(!active.rows.length) {await sql.query('ROLLBACK');continue;}
    const current=await core.read(job.workspace_id);
    if(snapshot.fingerprint!==current.fingerprint) throw new Error('core_source_changed');
    let valid=notificationTaskVisible(current,job.task_id,job.original_project_id);
    if(valid&&job.comment_id) {
     const comment=await sql.query('SELECT 1 FROM task_comments WHERE workspace_id=$1 AND id=$2 AND task_id=$3 AND project_id=$4',[job.workspace_id,job.comment_id,job.task_id,job.original_project_id]);
     valid=comment.rows.length>0;
    }
    let completed=0,skipped=0,inserted=0;
    for(const id of page) {
     if(!valid||id===job.actor_id&&job.trusted_origin==='manual') {skipped++;continue;}
     const member=await sql.query(`SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL
      AND 'domain.read'=ANY(m.capabilities) AND (m.project_ids IS NULL OR $3=ANY(m.project_ids))`,[job.workspace_id,id,job.original_project_id]);
     if(!member.rows.length) {skipped++;continue;}
     const reasons:string[]=[];
     const watches=job.watch_candidates.filter(value=>value.ownerId===id);
     for(const watch of watches) {
      const activeWatch=await sql.query(`SELECT 1 FROM dashboard_records WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND version=$4 AND project_id=$5 AND kind='task_watch' AND data->>'taskId'=$6 AND data->>'watching'='true'`,[job.workspace_id,watch.watchRecordId,id,watch.watchVersion,job.original_project_id,job.task_id]);
      if(activeWatch.rows.length) {reasons.push('watch');break;}
     }
     if(job.new_mention_ids.includes(id)) reasons.push('mention');
     const currentTask=current.files.find(file=>file.id===job!.task_id);
     if(job.completion&&job.assignee_id===id&&currentTask?.entity.assignee===id)reasons.push('assignee');
     if(job.completion&&job.requester_id===id&&job.trusted_origin!=='manual')reasons.push('requester');
     if(reasons.length&&job.completion)reasons.push('completion');
     if(!reasons.length) {skipped++;continue;}
     const prior=await sql.query('SELECT 1 FROM notification_recipients WHERE workspace_id=$1 AND fact_id=$2 AND recipient_id=$3',[job.workspace_id,job.fact_id,id]);
     if(!prior.rows.length) {
      const head=await sql.query<{head:string}>('UPDATE workspaces SET notification_head=notification_head+1 WHERE id=$1 RETURNING notification_head::text AS head',[job.workspace_id]);
      await sql.query(`INSERT INTO notification_recipients(workspace_id,fact_id,recipient_id,reason_set,origin,delivery_cursor) VALUES($1,$2,$3,$4,'routed',$5)`,[job.workspace_id,job.fact_id,id,reasons,head.rows[0]!.head]);
      await emitNotificationInvalidation(sql,job.workspace_id,id,job.fact_id);inserted++;
     }
     completed++;
    }
    const done=ids.length<=limit;
    const changed=await sql.query(`UPDATE notification_route_jobs SET state=$5,candidate_after=$6,lease_owner=NULL,lease_until=NULL,completed_count=completed_count+$7,skipped_count=skipped_count+$8,
     next_attempt_at=clock_timestamp(),last_error_code=NULL,completed_at=CASE WHEN $5='completed' THEN clock_timestamp() ELSE NULL END
     WHERE workspace_id=$1 AND fact_id=$2 AND lease_owner=$3 AND lease_epoch=$4`,[job.workspace_id,job.fact_id,owner,job.lease_epoch,done?'completed':'pending',page.at(-1)??job.candidate_after,completed,skipped]);
    if(changed.rowCount!==1) throw new Error('notification_lease_lost');
    await sql.query('COMMIT');
    delivered+=inserted;
   }catch(error){await sql.query('ROLLBACK');throw error;}finally{sql.release();}
  }catch(error) {
   const sql=await pool.connect();
   try {
    await sql.query('BEGIN');await lockWorkspace(sql,job.workspace_id);
    await sql.query(`UPDATE notification_route_jobs SET attempts=attempts+1,state=CASE WHEN attempts+1>=10 THEN 'failed' ELSE 'pending' END,
     lease_owner=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+(least(300,power(2,least(attempts,8))) * interval '1 second'),last_error_code=$5
     WHERE workspace_id=$1 AND fact_id=$2 AND lease_owner=$3 AND lease_epoch=$4`,[job.workspace_id,job.fact_id,owner,job.lease_epoch,error instanceof DomainError?error.code:'notification_source_or_storage_unavailable']);
    await sql.query('COMMIT');
   }catch(failure){await sql.query('ROLLBACK');throw failure;}finally{sql.release();}
  }
 }
 return {jobs,delivered};
}
export async function retryNotificationFact(pool:Pool,workspaceId:string,factId:string,operatorUid:number):Promise<void> {
 if(!Number.isSafeInteger(operatorUid)||operatorUid<0) throw new DomainError('operator_identity_unavailable');
 const sql=await pool.connect();try {await sql.query('BEGIN');await lockWorkspace(sql,workspaceId);
  const result=await sql.query<{lease_epoch:string}>("UPDATE notification_route_jobs SET state='pending',attempts=0,next_attempt_at=clock_timestamp(),last_error_code=NULL,lease_owner=NULL,lease_until=NULL,lease_epoch=lease_epoch+1 WHERE workspace_id=$1 AND fact_id=$2 AND state='failed' RETURNING lease_epoch::text",[workspaceId,factId]);
  if(!result.rows[0]) throw new DomainError('notification_job_not_failed',undefined,409);
  await sql.query('INSERT INTO notification_route_retries(retry_id,workspace_id,fact_id,operator_uid,lease_epoch) VALUES($1,$2,$3,$4,$5)',[randomUUID(),workspaceId,factId,operatorUid,result.rows[0].lease_epoch]);
  await sql.query('COMMIT');
 }catch(error){await sql.query('ROLLBACK');throw error;}finally{sql.release();}
}

/** Operator metadata only: no body, title, candidate identity, or audience list. */
export async function readNotificationOperations(pool:Pool,workspaceId:string) {
 const capture=await pool.query('SELECT status,observed_at,imported_count::text,journal_offset::text,observation_sequence::text,last_error_code FROM service_fact_import_checkpoints WHERE workspace_id=$1',[workspaceId]);
 const counts=await pool.query(`SELECT count(*) FILTER(WHERE j.state IN ('pending','running'))::int AS pending,count(*) FILTER(WHERE j.state='failed')::int AS failed,
 min(f.recorded_at) FILTER(WHERE j.state<>'completed') AS oldest_unrouted_at FROM notification_route_jobs j JOIN service_fact_events f USING(workspace_id,fact_id) WHERE j.workspace_id=$1`,[workspaceId]);
 const failed=await pool.query(`SELECT j.fact_id,f.source_kind,j.state,j.attempts,j.last_error_code,j.next_attempt_at,j.lease_epoch::text FROM notification_route_jobs j JOIN service_fact_events f USING(workspace_id,fact_id) WHERE j.workspace_id=$1 AND j.state='failed' ORDER BY f.fact_sequence LIMIT 100`,[workspaceId]);
 return {capture:capture.rows[0]??{status:'unobserved'},counts:counts.rows[0],failed:failed.rows};
}

/** Only for an explicitly isolated restore target, within its restore transaction. Never the source DB. */
export async function fenceRestoredNotifications(sql:SqlExecutor):Promise<void> {
 const workspaces=await sql.query<{workspace_id:string}>('SELECT DISTINCT workspace_id FROM notification_route_jobs ORDER BY workspace_id');
 for(const {workspace_id} of workspaces.rows) {
  await lockWorkspace(sql,workspace_id);
  await sql.query(`UPDATE notification_route_jobs SET state='pending',lease_owner=NULL,lease_until=NULL,lease_epoch=lease_epoch+1,
   next_attempt_at=clock_timestamp() WHERE workspace_id=$1 AND state IN ('pending','running')`,[workspace_id]);
 }
 await sql.query("UPDATE service_fact_import_checkpoints SET status='pending',last_error_code=NULL");
}
