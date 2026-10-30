import type { Pool } from 'pg';
import { readServiceFactObservations, type CoreFactObservation } from '../../../../packages/pm-core/service-facts.ts';
import { lockWorkspace } from '../../../../packages/infrastructure/src/database.ts';
import { appendProjectAudit } from '../../../../packages/application/src/project-audit.ts';
import { DomainError } from '../../../../packages/domain/src/core.ts';
import { insertServiceFact,freezeTaskWatchCandidates,type CapturedServiceFact,type NotificationFactInput } from '../../../../packages/application/src/service-facts.ts';
import { CoreCommandJournal } from './core-journal.ts';
import type { CoreWorkspacePool } from './core-routes.ts';
import type { SqlExecutor } from '../../../../packages/application/src/ports.ts';
import { recoverPreparedCoreCreations } from './core-facts.ts';

async function observationCapture(sql:SqlExecutor,workspaceId:string,observation:CoreFactObservation):Promise<CapturedServiceFact> {
 const target=observation.after??observation.before!;
 const sourceKey=String(observation.sequence);
 const previous=await sql.query<{actor_id:string|null;task_id:string|null;original_project_id:string|null;comment_id:string|null;comment_version:number|null;watch_candidates:NotificationFactInput['watchCandidates'];new_mention_ids:string[]}>(`SELECT i.* FROM notification_fact_inputs i JOIN service_fact_events f USING(workspace_id,fact_id)
 WHERE f.workspace_id=$1 AND f.source_kind='core_observation' AND f.source_key=$2`,[workspaceId,sourceKey]);
 const existing=previous.rows[0];
 const safe=!!observation.after && !!target.projectId && (!observation.before||observation.before.projectId===target.projectId);
 return {fact:{factId:observation.factId,schemaVersion:1,sourceKind:'core_observation',sourceKey,projectId:target.projectId,entityKind:target.kind,entityId:target.id,
 beforeRevision:observation.before?.revision??null,afterRevision:observation.after?.revision??null,changeKinds:observation.changeKinds,
 occurredAt:null,observedAt:observation.observedAt,safetyClass:safe?'project_fact':'restricted_internal'},
 input:target.kind==='work_item'&&safe&&observation.changeKinds.length>0?existing?{actorId:existing.actor_id,taskId:existing.task_id,originalProjectId:existing.original_project_id,commentId:existing.comment_id,commentVersion:existing.comment_version,watchCandidates:existing.watch_candidates,newMentionIds:existing.new_mention_ids}:
 {actorId:null,taskId:target.id,originalProjectId:target.projectId,commentId:null,commentVersion:null,watchCandidates:target.projectId?await freezeTaskWatchCandidates(sql,workspaceId,target.id,target.projectId):[],newMentionIds:[]}:null};
}
/** API-only recovery; independent of GET requests and independent of the notification Worker. */
export class CoreFactImporter {
 private after='';
 private readonly database:Pool;
 private readonly workspaces:CoreWorkspacePool;
 constructor(database:Pool,workspaces:CoreWorkspacePool) {this.database=database;this.workspaces=workspaces;}
 async runBatch(limit=100):Promise<{workspaces:number;imported:number}> {
  const rows=await this.database.query<{id:string}>('SELECT id::text FROM workspaces WHERE id::text>$1 ORDER BY id LIMIT 4',[this.after]);
  if(!rows.rows.length) {this.after='';return {workspaces:0,imported:0};}
  let imported=0;
  for(const {id} of rows.rows) {
   this.after=id;
   try {imported+=await this.importWorkspace(id,limit);}
   catch(error) {
    const code=error instanceof DomainError?error.code:'core_fact_import_unavailable';
    await this.database.query(`INSERT INTO service_fact_import_checkpoints(workspace_id,status,last_error_code) VALUES($1,'error',$2)
     ON CONFLICT(workspace_id) DO UPDATE SET status='error',last_error_code=$2`,[id,code]).catch(()=>undefined);
   }
  }
  return {workspaces:rows.rows.length,imported};
 }
 async importWorkspace(workspaceId:string,limit=100):Promise<number> {
  const root=this.workspaces.rootFor(workspaceId),journal=new CoreCommandJournal(root);
  const client=await this.database.connect();
  let count=0;
  try {
   await client.query('BEGIN');await lockWorkspace(client,workspaceId);
   // Prepared disk proof is not a crash while its live writer still owns this lock.
   const entries=recoverPreparedCoreCreations(root,journal);
   await client.query('INSERT INTO service_fact_import_checkpoints(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[workspaceId]);
   const checkpoint=await client.query<{journal_offset:string;observation_sequence:string}>('SELECT journal_offset::text,observation_sequence::text FROM service_fact_import_checkpoints WHERE workspace_id=$1',[workspaceId]);
   const offset=Number(checkpoint.rows[0]!.journal_offset),end=Math.min(entries.length,offset+limit);
   if(offset>entries.length) throw new DomainError('fact_checkpoint_ahead','SQL and core journal require a consistent restore checkpoint',409);
   for(const entry of entries.slice(offset,end)) {
    if(entry.kind==='fact_completed') {await insertServiceFact(client,workspaceId,entry.captured);count++;}
    if(entry.kind==='completed'||entry.kind==='http_completed') {
     await appendProjectAudit(client,workspaceId,{id:entry.actorId,email:'',name:''},entry.audit??[]);
     for(const fact of entry.facts??[]) await insertServiceFact(client,workspaceId,fact);
     if(entry.kind==='completed') {
      const commandType=entries.find(value=>value.kind==='pending'&&value.commandId===entry.commandId&&value.actorId===entry.actorId);
      if(commandType?.kind==='pending') {
       const prior=await client.query<{request_hash:string;receipt:unknown}>('SELECT request_hash,receipt FROM command_receipts WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3',[workspaceId,entry.actorId,entry.commandId]);
       if(prior.rows[0]&&(prior.rows[0].request_hash!==entry.hash||JSON.stringify(prior.rows[0].receipt)!==JSON.stringify(entry.receipt))) {
        // JSONB key order is not identity; compare structurally in PostgreSQL.
        const same=await client.query('SELECT 1 FROM command_receipts WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3 AND request_hash=$4 AND receipt=$5::jsonb',[workspaceId,entry.actorId,entry.commandId,entry.hash,JSON.stringify(entry.receipt)]);
        if(!same.rows.length) throw new DomainError('command_receipt_conflict',undefined,409);
       }
       if(!prior.rows.length) await client.query(`INSERT INTO command_receipts(workspace_id,actor_id,command_id,command_type,request_hash,scope_project_ids,workspace_scope,receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[workspaceId,entry.actorId,entry.commandId,commandType.commandType,entry.hash,entry.scopeProjectIds??[],commandType.commandType==='CreateProject'||!entry.scopeProjectIds?.length?1:0,JSON.stringify(entry.receipt)]);
      }
     }
    }
   }
   await client.query("UPDATE service_fact_import_checkpoints SET journal_offset=$2,imported_count=imported_count+$3,status='pending',last_error_code=NULL WHERE workspace_id=$1",[workspaceId,end,count]);
   await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  // Open the sole API Workspace only after confirmed facts have recovered. Ordinary scans remain observation-only.
  await this.workspaces.get(workspaceId);
  const observations=readServiceFactObservations(root);
  const journalLength=journal.entries().length;
  const sql=await this.database.connect();
  try {
   await sql.query('BEGIN');await lockWorkspace(sql,workspaceId);
   const checkpoint=await sql.query<{observation_sequence:string}>('SELECT observation_sequence::text FROM service_fact_import_checkpoints WHERE workspace_id=$1',[workspaceId]);
   if(Number(checkpoint.rows[0]!.observation_sequence)>observations.sequence) throw new DomainError('fact_checkpoint_ahead','SQL and core observation ledger require a consistent restore checkpoint',409);
   const pending=observations.observations.filter(value=>value.sequence>Number(checkpoint.rows[0]!.observation_sequence)).slice(0,limit);
   for(const observation of pending) {await insertServiceFact(sql,workspaceId,await observationCapture(sql,workspaceId,observation));count++;}
   await sql.query(`UPDATE service_fact_import_checkpoints SET observation_sequence=$2::bigint,observed_at=$3,imported_count=imported_count+$7,status=CASE WHEN $4::text IS NOT NULL THEN 'error' WHEN journal_offset<$5::bigint OR $2::bigint<$6::bigint THEN 'pending' ELSE 'current' END,last_error_code=$4 WHERE workspace_id=$1`,
    [workspaceId,pending.at(-1)?.sequence??checkpoint.rows[0]!.observation_sequence,observations.lastObservedAt,observations.gap,journalLength,observations.sequence,pending.length]);
   await sql.query('COMMIT');
  }catch(error){await sql.query('ROLLBACK');throw error;}finally{sql.release();}
  return count;
 }
}
