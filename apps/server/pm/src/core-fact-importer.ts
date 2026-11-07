import type { Pool } from 'pg';
import { readServiceFactObservations, type CoreFactObservation, type CoreFactSummary } from '../../../../packages/pm-core/service-facts.ts';
import { lockWorkspace } from '../../../../packages/infrastructure/src/database.ts';
import { appendProjectAudit } from '../../../../packages/application/src/project-audit.ts';
import { DomainError } from '../../../../packages/domain/src/core.ts';
import { insertServiceFact,freezeTaskWatchCandidates,type CapturedServiceFact } from '../../../../packages/application/src/service-facts.ts';
import { CoreCommandJournal } from './core-journal.ts';
import type { CoreWorkspacePool } from './core-routes.ts';
import type { SqlExecutor } from '../../../../packages/application/src/ports.ts';
import { recoverPreparedCoreCreations } from './core-facts.ts';
import { insertPmAutomationObservationSignals } from '../../../../packages/application/src/automation-pm-signals.ts';
import { changedSnapshotFields, insertChangeHistory, type HistorySnapshotReader } from '../../../../packages/application/src/change-history.ts';
import { randomUUID } from 'node:crypto';
import { readCoreSnapshot } from '../../../../packages/pm-core/change-snapshots.ts';
import type { ChangeSnapshot } from '../../../../packages/contracts/src/change-history.ts';

function observationSnapshot(summary:CoreFactSummary|null,readSnapshot:HistorySnapshotReader):ChangeSnapshot|null {
 if(!summary?.snapshotKey)return null;
 const snapshot=readSnapshot(summary.snapshotKey),metadata=snapshot.metadata;
 if(!metadata)throw new DomainError('history_snapshot_scope_mismatch',undefined,409);
 const project=metadata.entity==='project'?metadata.id:metadata.project??null;
 if(snapshot.revision!==summary.revision||metadata.id!==summary.id||metadata.entity!==summary.kind||project!==summary.projectId)throw new DomainError('history_snapshot_scope_mismatch',undefined,409);
 return snapshot;
}
async function observationCapture(sql:SqlExecutor,workspaceId:string,observation:CoreFactObservation,readSnapshot:HistorySnapshotReader):Promise<CapturedServiceFact> {
 const target=observation.after??observation.before!,before=observationSnapshot(observation.before,readSnapshot),after=observationSnapshot(observation.after,readSnapshot);
 const safe=!!observation.after&&!!target.projectId&&(!observation.before||observation.before.projectId===target.projectId);
 const changedFields=observation.before&&!before?[]:changedSnapshotFields(before,after);
 const assignee=after?.metadata?.assignee;
 return {fact:{factId:observation.factId,schemaVersion:1,sourceKind:'core_observation',sourceKey:String(observation.sequence),projectId:target.projectId,entityKind:target.kind,entityId:target.id,
 beforeRevision:observation.before?.revision??null,afterRevision:observation.after?.revision??null,changeKinds:observation.changeKinds,occurredAt:null,observedAt:observation.observedAt,safetyClass:safe?'project_fact':'restricted_internal'},
 input:target.kind==='work_item'&&safe&&observation.changeKinds.length>0?{actorId:null,taskId:target.id,originalProjectId:target.projectId,commentId:null,commentVersion:null,watchCandidates:target.projectId?await freezeTaskWatchCandidates(sql,workspaceId,target.id,target.projectId):[],newMentionIds:[],
 completion:!!observation.before&&observation.before.statusCategory!==undefined&&observation.before.statusCategory!=='completed'&&observation.after?.statusCategory==='completed',
 assigneeId:typeof assignee==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assignee)?assignee:null,changedFields}:null,
 ...((before||after)?{history:{target:{kind:'core' as const,entityId:target.id},entityKind:target.kind,projectId:target.projectId,beforeKey:observation.before?.snapshotKey??null,afterKey:observation.after?.snapshotKey??null,completeness:observation.before&&!before?'missing_before' as const:'observed_endpoints' as const,origin:'observation' as const,actorId:null,changedFields}}:{})};
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
    if(entry.kind==='fact_completed') {await insertServiceFact(client,workspaceId,entry.captured,key=>readCoreSnapshot(root,key));count++;}
    if(entry.kind==='completed'||entry.kind==='http_completed') {
     await appendProjectAudit(client,workspaceId,{id:entry.actorId,email:'',name:''},entry.audit??[]);
     for(const fact of entry.facts??[]) await insertServiceFact(client,workspaceId,fact,key=>readCoreSnapshot(root,key));
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
  const workspace=await this.workspaces.get(workspaceId);
  const sql=await this.database.connect();
  try {
   await sql.query('BEGIN');await lockWorkspace(sql,workspaceId);
   const completed=journal.entries().flatMap(entry=>entry.kind==='fact_completed'?[entry]:[]);
   for(const entry of completed)if(entry.boundary)workspace.acceptCommittedFact(entry.captured.fact.factId,entry.boundary.before,entry.boundary.after);
   workspace.retireMutationProofs(new Set(completed.map(entry=>entry.captured.fact.factId)));
   await workspace.rescan('fact-recovery');
   const observations=readServiceFactObservations(root),journalLength=journal.entries().length;
   const checkpoint=await sql.query<{observation_sequence:string}>('SELECT observation_sequence::text FROM service_fact_import_checkpoints WHERE workspace_id=$1',[workspaceId]);
   if(Number(checkpoint.rows[0]!.observation_sequence)>observations.sequence) throw new DomainError('fact_checkpoint_ahead','SQL and core observation ledger require a consistent restore checkpoint',409);
   const pending=observations.observations.filter(value=>value.sequence>Number(checkpoint.rows[0]!.observation_sequence)).slice(0,limit);
   for(const observation of pending) {
    const prior=await sql.query<{fact_id:string;before_revision:string|null;after_revision:string|null}>(`SELECT fact_id,before_revision,after_revision FROM service_fact_events WHERE workspace_id=$1 AND source_kind='core_observation' AND source_key=$2`,[workspaceId,String(observation.sequence)]);
    if(prior.rows[0]) {
     if(prior.rows[0].fact_id!==observation.factId||prior.rows[0].before_revision!==(observation.before?.revision??null)||prior.rows[0].after_revision!==(observation.after?.revision??null))throw new DomainError('fact_idempotency_conflict',undefined,409);
    } else {
     const snapshots=new Map<string,ChangeSnapshot>();
     const readSnapshot:HistorySnapshotReader=key=>{let value=snapshots.get(key);if(!value){value=readCoreSnapshot(root,key);snapshots.set(key,value);}return value;};
     await insertServiceFact(sql,workspaceId,await observationCapture(sql,workspaceId,observation,readSnapshot),readSnapshot);
    }
    await insertPmAutomationObservationSignals(sql,workspaceId,observation);
    count++;
   }
   const known=await sql.query<{stream_key:string}>('SELECT stream_key FROM change_history_streams WHERE workspace_id=$1',[workspaceId]);
   const knownKeys=new Set(known.rows.map(row=>row.stream_key));
   const successfulTargets=new Set(journal.entries().flatMap(entry=>entry.kind==='fact_completed'&&entry.captured.history?[entry.captured.fact.entityId]:(entry.kind==='completed'||entry.kind==='http_completed')?(entry.facts??[]).filter(fact=>fact.history).map(fact=>fact.fact.entityId):[]));
   const pendingIds=new Set(observations.observations.filter(value=>value.sequence>Number(checkpoint.rows[0]!.observation_sequence)).map(value=>(value.after??value.before)!.id));
   for(const baseline of observations.baseline.filter(value=>value.snapshotKey&&!pendingIds.has(value.id)&&!successfulTargets.has(value.id)&&!knownKeys.has(`core:${value.id}`)).slice(0,limit)) {
    await insertChangeHistory(sql,workspaceId,{changeId:randomUUID(),sourceKey:`baseline:${baseline.id}:${baseline.revision}`,target:{kind:'core',entityId:baseline.id},entityKind:baseline.kind,projectId:baseline.projectId,before:null,after:observationSnapshot(baseline,key=>readCoreSnapshot(root,key)),completeness:'baseline',origin:'observation',actorId:null,changedFields:[],changeKinds:[],observedAt:observations.lastObservedAt??new Date().toISOString(),occurredAt:null});
   }
   await sql.query(`UPDATE service_fact_import_checkpoints SET observation_sequence=$2::bigint,observed_at=$3,imported_count=imported_count+$7,status=CASE WHEN $4::text IS NOT NULL THEN 'error' WHEN journal_offset<$5::bigint OR $2::bigint<$6::bigint THEN 'pending' ELSE 'current' END,last_error_code=$4 WHERE workspace_id=$1`,
    [workspaceId,pending.at(-1)?.sequence??checkpoint.rows[0]!.observation_sequence,observations.lastObservedAt,observations.gap,journalLength,observations.sequence,pending.length]);
   await sql.query('COMMIT');
  }catch(error){await sql.query('ROLLBACK');throw error;}finally{sql.release();}
  return count;
 }
}
