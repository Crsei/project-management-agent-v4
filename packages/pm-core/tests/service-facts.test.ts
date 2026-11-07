import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,rm,readdir,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace,type WorkspaceMutationCapture } from '../index.ts';
import { readCurrentCore } from '../readonly.ts';
import { readServiceFactObservations } from '../service-facts.ts';
import { readCoreSnapshot, retainCoreSnapshot } from '../change-snapshots.ts';
import { FileRepository } from '../repository.ts';
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
test('large retained snapshots stay outside the observation ledger and unchanged scans do not rewrite it',async t=>{
 const root=await fixture(),workspace=new Workspace(root);t.after(async()=>{await workspace.close();await rm(root,{recursive:true,force:true});});await workspace.init();
 const body='Large immutable endpoint '.repeat(90_000);
 const document=await workspace.createEntity({entity:'document',project:'PRJ-001',title:'Large retained document',body});
 const before=readServiceFactObservations(root).baseline.find(value=>value.id===document.id);assert.ok(before?.snapshotKey);
 assert.equal(readCoreSnapshot(root,before.snapshotKey).raw,document.raw);
 const file=join(root,'.pm/state/service-observations.json'),savedLedger=await readFile(file,'utf8');
 assert.ok(savedLedger.length<20_000);assert.equal(savedLedger.includes('Large immutable endpoint'),false);
 await workspace.rescan('unchanged-large-source');await workspace.rescan('unchanged-again');
 assert.equal(await readFile(file,'utf8'),savedLedger);
 await workspace.save(document.id,document.raw.replace('Large immutable endpoint','Changed immutable endpoint'),document.revision);
 const observed=readServiceFactObservations(root),change=observed.observations.find(value=>value.before?.id===document.id);assert.ok(change?.before?.snapshotKey);assert.ok(change.after?.snapshotKey);
 assert.equal(readCoreSnapshot(root,change.before.snapshotKey).raw,document.raw);
 assert.ok((await readFile(file,'utf8')).length<30_000);
 await rm(join(root,'.pm/state/change-snapshots',`${change.before.snapshotKey}-0.txt`));
 assert.throws(()=>readCoreSnapshot(root,change.before!.snapshotKey!),/ENOENT/,'retained history is never reconstructed from the current document');
});

for (const invalidStatus of ['status: unknown-state', 'status: [unterminated'])
 test(`raw repair retains the actual invalid endpoint without stale parsed fields: ${invalidStatus}`,async t=>{
  const root=await fixture(),workspace=new Workspace(root);t.after(async()=>{await workspace.close();await rm(root,{recursive:true,force:true});});await workspace.init();
  const invalid=task.replace('status: todo',invalidStatus).replace('Original content','Externally edited invalid content');
  await writeFile(join(root,'work-items/TASK-001.md'),invalid);await workspace.rescan('invalid-external-edit');
  const stale=workspace.get('TASK-001');assert.equal(stale.stale,true);
  let beforeKey:string|undefined;
  await workspace.captureMutations({
   prepare(before){assert.ok(before);beforeKey=retainCoreSnapshot(new FileRepository(root),before);},
   committed(){return randomUUID();},
  },()=>workspace.save(stale.id,task.replace('Original content','Repaired content'),stale.revision));
  assert.ok(beforeKey);
  const before=readCoreSnapshot(root,beforeKey);
  assert.equal(before.raw,invalid);assert.equal(before.revision,stale.revision);
  assert.equal(before.body,null);assert.equal(before.metadata,null);
  assert.match(workspace.get(stale.id).entity.body,/Repaired content/);
 });
