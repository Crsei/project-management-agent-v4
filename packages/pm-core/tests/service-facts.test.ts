import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,rm,readdir,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace,type WorkspaceMutationCapture } from '../index.ts';
import { readCurrentCore } from '../readonly.ts';
import { readServiceFactObservations } from '../service-facts.ts';
const project='---\nschema: pm/v1\nid: PRJ-001\nentity: project\n---\n# Project\n';
const task='---\nschema: pm/v1\nid: TASK-001\nentity: work_item\nproject: PRJ-001\nstatus: todo\n---\n# Task\n\nOriginal content\n';
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'pm-fact-files-'));await mkdir(join(root,'projects'));await mkdir(join(root,'work-items'));
 await writeFile(join(root,'projects/PRJ-001.md'),project);await writeFile(join(root,'work-items/TASK-001.md'),task);
 return root;
}
test('first valid scan creates only a durable baseline; external observations persist once and invalid sources retain a gap',async t=>{
 const root=await fixture(),workspace=new Workspace(root);t.after(async()=>{await workspace.close();await rm(root,{recursive:true,force:true});});await workspace.init();
 assert.equal(readServiceFactObservations(root).observations.length,0);await workspace.rescan('duplicate-watcher');assert.equal(readServiceFactObservations(root).observations.length,0);
 await writeFile(join(root,'work-items/TASK-001.md'),task.replace('Original content','Observed content'));await workspace.rescan('external-test');await workspace.rescan('repeat');
 const observed=readServiceFactObservations(root);assert.equal(observed.observations.length,1);assert.deepEqual(observed.observations[0]?.changeKinds,['content_changed']);
 assert.equal(JSON.stringify(observed).includes('Observed content'),false);assert.equal(JSON.stringify(observed).includes('# Task'),false);
 await writeFile(join(root,'work-items/TASK-001.md'),'invalid source');await workspace.rescan('invalid');assert.equal(readServiceFactObservations(root).gap,'invalid_or_unavailable_source');assert.equal(readServiceFactObservations(root).observations.length,1);
 await writeFile(join(root,'work-items/TASK-001.md'),task.replace('Original content','Repaired content'));await workspace.rescan('repair');assert.equal(readServiceFactObservations(root).observations.length,2);assert.equal(readServiceFactObservations(root).gap,null);
});
test('actual per-object capture completes within the serial file queue and does not double-observe a controlled save',async t=>{
 const root=await fixture(),workspace=new Workspace(root);t.after(async()=>{await workspace.close();await rm(root,{recursive:true,force:true});});await workspace.init();
 const order:string[]=[],factId=randomUUID();
 const capture:WorkspaceMutationCapture={async prepare(before,after){assert.equal(before?.id,'TASK-001');assert.equal(after?.entity.priority,'high');order.push('prepared');},committed(before,after){assert.notEqual(before?.revision,after?.revision);order.push('committed');return factId;}};
 const before=workspace.get('TASK-001');const saved=await workspace.captureMutations(capture,()=>workspace.patch(before.id,{priority:'high'},before.revision));order.push('returned');
 assert.deepEqual(order,['prepared','committed','returned']);assert.equal(workspace.get(before.id).revision,saved.revision);assert.equal(readServiceFactObservations(root).observations.length,0);assert.ok(readServiceFactObservations(root).acceptedFactIds.includes(factId));
});
test('read-only current validation never initializes state/cache/watcher and fails closed for duplicate IDs or broken source',async t=>{
 const root=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
 assert.equal(readCurrentCore(root).files.length,2);assert.equal((await readdir(root)).includes('.pm'),false);
 await writeFile(join(root,'work-items/duplicate.md'),task);assert.throws(()=>readCurrentCore(root));await rm(join(root,'work-items/duplicate.md'));
 await writeFile(join(root,'work-items/TASK-001.md'),'broken');assert.throws(()=>readCurrentCore(root));assert.equal((await readdir(root)).includes('.pm'),false);
});
test('pure formatting changes have no semantic notification category while title remains metadata, not content',async t=>{
 const root=await fixture(),workspace=new Workspace(root);t.after(async()=>{await workspace.close();await rm(root,{recursive:true,force:true});});await workspace.init();
 await writeFile(join(root,'work-items/TASK-001.md'),task.replace('Original content\n','Original content\n\n\n'));await workspace.rescan('format');assert.deepEqual(readServiceFactObservations(root).observations[0]?.changeKinds,[]);
 const raw=await readFile(join(root,'work-items/TASK-001.md'),'utf8');await writeFile(join(root,'work-items/TASK-001.md'),raw.replace('# Task','# Renamed task'));await workspace.rescan('title');assert.deepEqual(readServiceFactObservations(root).observations.at(-1)?.changeKinds,['metadata_changed']);
});
