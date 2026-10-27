import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace,type WorkspaceMutationCapture } from '../packages/pm-core/index.ts';
import { coreFactSummary,coreChangeKinds,readServiceFactObservations } from '../packages/pm-core/service-facts.ts';
import { CoreCommandJournal } from '../apps/api/src/core-journal.ts';
import { CoreWorkspacePool } from '../apps/api/src/core-routes.ts';
import type { CapturedServiceFact } from '../packages/application/src/service-facts.ts';
async function fixture() {
 const parent=await mkdtemp(join(tmpdir(),'pm-proven-facts-')),workspaceId=randomUUID(),root=join(parent,workspaceId);
 await mkdir(join(root,'projects'),{recursive:true});await writeFile(join(root,'projects/PRJ-001.md'),'---\nschema: pm/v1\nid: PRJ-001\nentity: project\n---\n# Project\n');
 const workspace=new Workspace(root);await workspace.init();return {parent,workspaceId,root,workspace};
}
function interruptedCapture(root:string,operationId:string,actorId:string):WorkspaceMutationCapture {
 const journal=new CoreCommandJournal(root);
 return {async prepare(before,after){
  assert.ok(after);const previous=before?coreFactSummary(before):null,next=coreFactSummary(after);assert.ok(next);
  const captured:CapturedServiceFact={fact:{factId:randomUUID(),schemaVersion:1,sourceKind:'command',sourceKey:JSON.stringify([actorId,operationId,after.id,0]),projectId:'PRJ-001',entityKind:'work_item',entityId:after.id,
   beforeRevision:before?.revision??null,afterRevision:after.revision,changeKinds:coreChangeKinds(previous,next),occurredAt:null,observedAt:null,safetyClass:'project_fact'},
   input:{actorId,taskId:after.id,originalProjectId:'PRJ-001',commentId:null,commentVersion:null,watchCandidates:[],newMentionIds:[]}};
  journal.fact('fact_prepared',operationId,'a'.repeat(64),actorId,captured,{before:previous,after:next});
 },committed(){throw new Error('injected interruption before completion fsync');}};
}
test('exact durable creation proof recovers original fact before startup scan without duplicate observation',async t=>{
 const f=await fixture(),operation=randomUUID(),actor=randomUUID(),pool=new CoreWorkspacePool(f.parent);
 t.after(async()=>{await f.workspace.close();await pool.close();await rm(f.parent,{recursive:true,force:true});});
 await assert.rejects(f.workspace.captureMutations(interruptedCapture(f.root,operation,actor),()=>f.workspace.createEntity({entity:'work_item',project:'PRJ-001',title:'Recovered creation'},operation)));
 await f.workspace.close();const workspace=await pool.get(f.workspaceId);assert.equal(workspace.items({entity:'work_item'}).length,1);
 const entries=new CoreCommandJournal(f.root).entries(),completed=entries.filter(entry=>entry.kind==='fact_completed');assert.equal(completed.length,1);
 const saved=completed[0];assert.ok(saved?.kind==='fact_completed');
 assert.equal(saved.captured.fact.occurredAt,null);assert.ok(saved.captured.fact.observedAt);
 assert.equal(readServiceFactObservations(f.root).observations.length,0);
});
test('prepared ordinary update is not promoted merely because current bytes equal its candidate',async t=>{
 const f=await fixture(),operation=randomUUID(),actor=randomUUID(),pool=new CoreWorkspacePool(f.parent);
 t.after(async()=>{await f.workspace.close();await pool.close();await rm(f.parent,{recursive:true,force:true});});
 const original=await f.workspace.createEntity({entity:'work_item',project:'PRJ-001',title:'Before update'});
 const baseline=readServiceFactObservations(f.root).observations.length;
 await assert.rejects(f.workspace.captureMutations(interruptedCapture(f.root,operation,actor),()=>f.workspace.patch(original.id,{title:'Saved but unproven attribution'},original.revision)));
 await f.workspace.close();await pool.get(f.workspaceId);
 assert.equal(new CoreCommandJournal(f.root).entries().filter(entry=>entry.kind==='fact_completed').length,0);
 const observed=readServiceFactObservations(f.root);assert.equal(observed.observations.length,baseline+1);assert.deepEqual(observed.observations.at(-1)?.changeKinds,['metadata_changed']);
});
