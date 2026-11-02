import { randomUUID } from 'node:crypto';
import type { FileRecord, ProtocolConfiguration } from '../../../../packages/pm-schema/index.ts';
import { Workspace, type WorkspaceMutationCapture } from '../../../../packages/pm-core/index.ts';
import { coreFactSummary,coreChangeKinds,type CoreFactSummary,type ServiceFactObservations } from '../../../../packages/pm-core/service-facts.ts';
import { freezeTaskWatchCandidates,type CapturedServiceFact } from '../../../../packages/application/src/service-facts.ts';
import { validateNewMentions } from '../../../../packages/application/src/notification-mentions.ts';
import type { SqlExecutor } from '../../../../packages/application/src/ports.ts';
import { CoreCommandJournal } from './core-journal.ts';
import { capturePmAutomationEvents } from '../../../../packages/application/src/automation-pm-signals.ts';
/** Runs within the file serial queue and the caller's workspace authorization transaction. */
export function captureCoreFacts(options:{sql:SqlExecutor;workspaceId:string;root:string;sourceKind:'command'|'core_http';operationId:string;requestHash:string;actorId:string;facts:CapturedServiceFact[];reusePrepared?:boolean;configuration?:ProtocolConfiguration}):WorkspaceMutationCapture {
 let ordinal=0;
 const pending=new Map<string,{captured:CapturedServiceFact;boundary:{before:CoreFactSummary|null;after:CoreFactSummary|null}}>();
 const journal=new CoreCommandJournal(options.root);
 const reusable=options.reusePrepared?journal.entries().filter(entry=>entry.kind==='fact_prepared'&&entry.commandId===options.operationId&&entry.actorId===options.actorId&&entry.hash===options.requestHash):[];
 return {
  async prepare(before:FileRecord|undefined,after:FileRecord|undefined) {
   const boundary={before:before?coreFactSummary(before):null,after:after?coreFactSummary(after):null};
   const previous=before?coreFactSummary(before):null,next=after?coreFactSummary(after):null,target=next??previous;
   pending.delete(target?.id??'');
   if(!target || before?.revision===after?.revision) return;
   const reused=reusable.find(entry=>entry.kind==='fact_prepared'&&entry.captured.fact.entityId===target.id&&entry.captured.fact.beforeRevision===(previous?.revision??null)&&entry.captured.fact.afterRevision===(next?.revision??null));
   if(reused?.kind==='fact_prepared'){pending.set(target.id,{captured:reused.captured,boundary});ordinal++;return;}
   const projectId=target.projectId;
   const scoped=!!projectId && (!previous||!next||previous.projectId===next.projectId) && !before?.stale && !after?.stale && !!after;
   const changeKinds=coreChangeKinds(previous,next),route=target.kind==='work_item'&&scoped&&changeKinds.length>0;
   const mentions=after?.entity.entity==='work_item' && projectId ? await validateNewMentions(options.sql,options.workspaceId,projectId,before?.entity.body??'',after.entity.body):[];
   const watch=route&&projectId?await freezeTaskWatchCandidates(options.sql,options.workspaceId,target.id,projectId):[];
   const prepared:CapturedServiceFact={fact:{factId:randomUUID(),schemaVersion:1,sourceKind:options.sourceKind,sourceKey:JSON.stringify([options.actorId,options.operationId,target.id,ordinal++]),projectId,
    entityKind:target.kind,entityId:target.id,beforeRevision:previous?.revision??null,afterRevision:next?.revision??null,changeKinds,
    occurredAt:null,observedAt:null,safetyClass:scoped?'project_fact':'restricted_internal'},
    input:route?{actorId:options.actorId,taskId:target.id,originalProjectId:projectId,commentId:null,commentVersion:null,watchCandidates:watch,newMentionIds:mentions}:null};
   prepared.pmSignals=capturePmAutomationEvents({eventId:prepared.fact.factId,actorId:options.actorId,workspaceId:options.workspaceId,before,after,configuration:options.configuration});
   journal.fact('fact_prepared',options.operationId,options.requestHash,options.actorId,prepared,boundary);
   pending.set(target.id,{captured:prepared,boundary});
  },
  committed(before,after) {
   const id=after?.id??before?.id,entry=id?pending.get(id):undefined;
   if(!entry) return;
   const prepared=entry.captured,time=new Date().toISOString();
   prepared.fact.occurredAt=time;prepared.fact.observedAt=time;
   journal.fact('fact_completed',options.operationId,options.requestHash,options.actorId,prepared,entry.boundary);
   options.facts.push(prepared);pending.delete(id!);
   return prepared.fact.factId;
  },
 };
}

/** Exact creation proof only; runs again after protocol recovery and before the first observation scan. */
export function recoverPreparedCoreCreations(root:string,journal:CoreCommandJournal,history?:ServiceFactObservations) {
 let entries=journal.entries();
 const completed=new Set<string>();
 const copies=new Set(entries.filter(entry=>entry.kind==='pending'&&entry.commandType==='DuplicateProject').map(entry=>JSON.stringify([entry.actorId,entry.commandId])));
 for(const entry of entries) if(entry.kind==='fact_completed') completed.add(entry.captured.fact.factId);
 for(const entry of entries) if(entry.kind==='fact_prepared'&&!completed.has(entry.captured.fact.factId)&&entry.captured.fact.beforeRevision===null&&entry.captured.fact.afterRevision) {
  const key=entry.captured.fact.sourceKind==='core_http'?`native:${entry.commandId}`:copies.has(JSON.stringify([entry.actorId,entry.commandId]))?`duplicate:${entry.actorId}:${entry.commandId}`:entry.commandId;
  const proof=Workspace.inspectCreation(root,key,entry.captured.fact.entityId);
  if(!proof.pending&&proof.request?.id===entry.captured.fact.entityId&&proof.request.revision===entry.captured.fact.afterRevision) {
   const captured={...entry.captured,fact:{...entry.captured.fact,occurredAt:null,observedAt:new Date().toISOString()}};
   journal.fact('fact_completed',entry.commandId,entry.hash,entry.actorId,captured,entry.boundary);
   completed.add(entry.captured.fact.factId);
  }
 }
 entries=journal.entries();
 if(history) for(const entry of entries) if(entry.kind==='fact_completed'&&entry.boundary) history.acceptCommitted(entry.captured.fact.factId,entry.boundary.before,entry.boundary.after);
 return entries;
}
