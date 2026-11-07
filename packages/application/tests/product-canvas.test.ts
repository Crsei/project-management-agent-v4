import { renderTaskContext, buildTaskContext } from '../src/task-context.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ProductCanvasService, type CanvasPorts } from '../src/product-canvas.ts';
import { canvasOrder, type CanvasStart, type CanvasRun } from '../../contracts/src/product-canvas.ts';
import { emptyRoadmap, type RoadmapRead } from '../../contracts/src/product-roadmap.ts';
import { workflowTemplates, type WorkflowRun } from '../../contracts/src/task-workflow.ts';
import { productHandoffReportSchema, agentHandoffReportSchema } from '../../contracts/src/task-context.ts';

function payload(run: CanvasRun) {
  const text = renderTaskContext(run, run.nodes.at(-1)!, 'a'.repeat(40));
  return JSON.parse(text.slice(text.indexOf('{'), text.indexOf('\n\n结束时')));
}

test('product report is bounded, accepts no-op/removal snapshots and reads legacy reports', () => {
  assert.deepEqual(productHandoffReportSchema.parse({changes:[],capabilities:[]}),{changes:[],capabilities:[]});
  for (const report of [{changes:[' '],capabilities:[]},{changes:['x'.repeat(301)],capabilities:[]},{changes:Array(13).fill('x'),capabilities:[]},{changes:[],capabilities:Array(33).fill('x')},{changes:[],capabilities:['x'.repeat(241)]},{changes:[],capabilities:[],execute:true},{changes:['new']}]) assert.equal(productHandoffReportSchema.safeParse(report).success,false);
  assert.ok(agentHandoffReportSchema.safeParse({interfaces:[],decisions:[],usage:'legacy',risks:[]}).success);
});

test('two product increments replace capabilities at their own revision, not append old changes',async()=>{
  const f=fixture();
  // Deliberately oppose lexical ID order and execution order.
  const ids=new Map(canvasOrder(f.plan).map((id,i)=>[id,`${['ffffffff','eeeeeeee','dddddddd'][i]}-1111-4111-8111-111111111111`]));
  for(const n of f.plan.nodes){n.id=ids.get(n.id)!;n.dependsOn=n.dependsOn.map(id=>ids.get(id)!);}
  const original=f.ports.verifyChild;
  f.ports.verifyChild=async(...args)=>{const proof=await original(...args);return {...proof,handoff:{...proof.handoff,head:proof.handoff.taskId==='TASK-1'?'a'.repeat(40):'b'.repeat(40),report:proof.handoff.taskId==='TASK-1'?{changes:['新增分类筛选'],capabilities:['提交反馈','分类筛选']}:{changes:['分类筛选改为标签筛选'],capabilities:['提交反馈','标签筛选']}}};};
  await f.service.start(f.input);const run=await f.drive();assert.equal(run.status,'completed');
  const p=payload(run);assert.deepEqual(p.product.capabilities.items,['提交反馈','标签筛选']);assert.equal(p.product.capabilities.head,'b'.repeat(40));assert.equal(p.product.capabilities.source,'agent-report');
  assert.notEqual(run.nodes[0]!.childId,run.nodes[1]!.childId);assert.equal(run.nodes.at(-1)!.context!.included.length,2);
  assert.deepEqual(p.predecessors[0].changes,['新增分类筛选']);assert.equal(p.predecessors[1].changes,undefined);
  assert.ok(f.project.tasks[f.input.releaseId]!.every(t=>t.status==='todo'));
  // Ordering an input index differently must not change which revision is current.
  run.nodes.at(-1)!.context!.included.reverse();assert.deepEqual(payload(run).product.capabilities,p.product.capabilities);
  run.nodes[1]!.handoff!.report={changes:['移除所有功能'],capabilities:[]};assert.deepEqual(payload(run).product.capabilities.items,[]);
});

test('missing or legacy latest snapshot never revives older capabilities or turns requirements into facts',async()=>{
  const f=fixture();await f.service.start(f.input);const run=await f.drive();run.nodes[0]!.handoff!.report={changes:['old'],capabilities:['removed']};
  for(const report of [undefined,{interfaces:['old API'],decisions:[],usage:'legacy',risks:[]}]) {
    run.nodes[1]!.handoff!.report=report;
    const p=payload(run);assert.equal(p.product.capabilities.items,null);assert.equal(p.product.capabilities.source,'unavailable');
  }
});

test('product context freezes experience and does not invent a preview or copy full technical reports',async()=>{
  const f=fixture();f.plan.brief.sharedContract='安静、紧凑；统一导航和空状态';await f.service.start(f.input);const run=await f.drive();
  const p=payload(run);assert.equal(p.product.sharedContract,f.plan.brief.sharedContract);assert.equal(p.product.preview.status,'unavailable');assert.equal(p.product.preview.url,undefined);
  for(const source of p.predecessors) {assert.equal(source.evidence,undefined);assert.equal(source.requirement,undefined);assert.ok(source.reference.head);}
});

test('large product deltas reduce to full reference indexes without dropping the latest capability snapshot',async()=>{
  const f=fixture();await f.service.start(f.input);const run=await f.drive();
  const template=structuredClone(run.nodes[0]!), definition=structuredClone(run.plan.nodes[0]!);
  run.nodes=[];run.plan.nodes=[];
  for(let i=0;i<24;i++){
    const nodeId=randomUUID(),childId=randomUUID(),taskId=`TASK-${i+1}`;
    run.plan.nodes.push({...definition,id:nodeId,dependsOn:i===23?run.nodes.map(n=>n.nodeId):[]});
    run.nodes.push({...structuredClone(template),nodeId,childId,taskId,phase:i===23?'ready':'verified',handoff:{...template.handoff!,deliveryId:childId,taskId,report:{changes:Array(12).fill('x'.repeat(300)),capabilities:['current only']}}});
  }
  const last=run.nodes.at(-1)!;last.context=buildTaskContext(run,last,'codex/base');
  const p=payload(run);assert.equal(p.detailsOmittedForBudget,true);assert.equal(p.predecessors.length,23);
  assert.deepEqual(p.product.capabilities.items,['current only']);assert.ok(p.predecessors.every((v:{reference?:unknown})=>v.reference));
  assert.ok(renderTaskContext(run,last,'a'.repeat(40)).length<64000);
  run.plan.brief.journey='x'.repeat(65000);last.context=buildTaskContext(run,last,'codex/base');
  assert.throws(()=>renderTaskContext(run,last,'a'.repeat(40)),/超过预算/);
});
function fixture() {
  const plan = emptyRoadmap(); for (const k of Object.keys(plan.brief) as (keyof typeof plan.brief)[]) plan.brief[k] = k;
  const a=randomUUID(), b=randomUUID(), c=randomUUID();
  plan.nodes = [c,a,b].map((id,i)=>({id,title:`task-${id}`,outcome:'outcome',acceptance:'acceptance',nonGoals:'other',stage:'MVP',dependsOn:id===a?[]:[a],x:i*300,y:0}));
  const input: CanvasStart = {id:randomUUID(),workspaceId:randomUUID(),projectId:'PRJ-001',releaseId:randomUUID(),revision:'r1',repository:'owner/repo',baseBranch:'main',providerInstanceId:'codex',model:'chosen',consent:{execute:true,worktreeWrite:true,commit:true,push:true,draftPr:true,taskStatus:true,createTasks:true}};
  const project: RoadmapRead = {projectId:input.projectId,title:'Product',revision:'r1',archived:false,store:{schema:'pm/product-roadmap/v1',draft:plan,releases:[{id:input.releaseId,plan,publishedAt:new Date().toISOString(),publishedBy:'u'}]},tasks:{[input.releaseId]:[]}};
  const runs = new Map<string,CanvasRun>(), children = new Map<string,WorkflowRun>(), calls: string[]=[];
  let allowed=true, integrated=true, proof=true;
  const ports: CanvasPorts = {
    read:id=>structuredClone(runs.get(id)??null),list:()=>structuredClone([...runs.values()]),save:r=>{assert.equal(r.version,(runs.get(r.id)?.version??0)+1);runs.set(r.id,structuredClone(r));},
    project:async()=>{if(!allowed)throw new Error('access denied');return structuredClone(project);},preflight:async()=>{},
    materialize:async(s,releaseId,nodeId)=>{calls.push(`create:${nodeId}`);const node=plan.nodes.find(n=>n.id===nodeId)!;project.tasks[releaseId]!.push({nodeId,taskId:`TASK-${project.tasks[releaseId]!.length+1}`,title:node.title,status:'todo',revision:'t1',archived:false,drifted:false});},
    child:async id=>structuredClone(children.get(id)??null), existing:async(s,taskId)=>structuredClone([...children.values()].find(c=>c.input.taskId===taskId)??null),
    startChild:async(r,n,taskRevision,baseBranch)=>{calls.push(`start:${baseBranch}`);const def=workflowTemplates.find(d=>d.id==='builtin-canvas-deliver')!;const now=new Date().toISOString();const child:WorkflowRun={id:n.childId,version:1,projectRoot:'/repo',graph:def.draft,status:'running',current:'start',nodes:{},createdAt:now,updatedAt:now,input:{...input,taskId:n.taskId!,taskRevision,baseBranch,id:n.childId,definitionId:def.id,definitionVersion:1,consent:{execute:true,worktreeWrite:true,commit:true,push:true,draftPr:true,taskStatus:true}}};children.set(child.id,child);return structuredClone(child);},
    controlChild:async(id,action)=>{calls.push(`control:${action}`);children.get(id)!.status=action==='pause'?'paused':'running';},
    verifyChild:async id=>{calls.push('verify');if(!proof)throw new Error('CI changed');const taskId=children.get(id)!.input.taskId,branch=`codex/${taskId}`;return {branch,handoff:{schema:'pm/task-handoff/v1' as const,deliveryId:id,taskId,head:'a'.repeat(40),branch,pr:'https://github.com/owner/repo/pull/1',testCommand:'npm test',testDigest:'digest',ci:['test'],checkedAt:new Date().toISOString(),files:['src/app.js'],filesTruncated:false}};},
    integration:async()=>integrated,
  };
  const service=new ProductCanvasService(ports);
  const tick=()=>service.tick(input.id), read=()=>runs.get(input.id)!;
  const drive=async()=>{for(let i=0;i<24;i++){for(const c of children.values())c.status='completed';const r=await tick();if(r.status!=='running')return r;}throw new Error('did not finish');};
  return {service,ports,input,project,runs,children,calls,plan,tick,read,drive,set:{deny:()=>{allowed=false;},integration:(v:boolean)=>{integrated=v;},proof:(v:boolean)=>{proof=v;}}};
}
test('canvas orders a DAG deterministically; cycles, missing and duplicate IDs fail',()=>{
  const f=fixture(), ids=canvasOrder(f.plan);assert.equal(ids[0],f.plan.nodes[1]!.id);assert.equal(ids.length,3);
  const p=structuredClone(f.plan);p.nodes[1]!.dependsOn=[p.nodes[0]!.id];assert.throws(()=>canvasOrder(p));p.nodes[1]!.dependsOn=[randomUUID()];assert.throws(()=>canvasOrder(p));p.nodes=[p.nodes[0]!,p.nodes[0]!];assert.throws(()=>canvasOrder(p));
});
test('start requires every separate consent, current project revision and write access',async()=>{
  const f=fixture();await assert.rejects(f.service.start({...f.input,consent:{...f.input.consent,push:false as unknown as true}}));await assert.rejects(f.service.start({...f.input,revision:'stale'}));f.set.deny();await assert.rejects(f.service.start(f.input));assert.equal(f.runs.size,0);
});
test('identical request is idempotent; altered input and a second project run are rejected',async()=>{
  const f=fixture(), r=await f.service.start(f.input);assert.deepEqual(await f.service.start(f.input),r);await assert.rejects(f.service.start({...f.input,model:'other'}));await assert.rejects(f.service.start({...f.input,id:randomUUID()}));assert.equal(f.runs.size,1);
});
test('concurrent dispatch uses a shared project lock before persistence',async()=>{
  const f=fixture();let release!:()=>void;f.ports.preflight=()=>new Promise<void>(resolve=>{release=resolve;});const started=f.service.start(f.input);await new Promise(resolve=>setImmediate(resolve));await assert.rejects(f.service.start({...f.input,id:randomUUID()}));release();await started;assert.equal(f.runs.size,1);
});
test('whole graph creates each task once, serially inherits prior branch, and stops at product review',async()=>{
  const f=fixture();await f.service.start(f.input);const r=await f.drive();assert.equal(r.status,'completed');assert.equal(r.nodes.filter(n=>n.phase==='verified').length,3);assert.deepEqual(f.calls.filter(c=>c.startsWith('start:')),['start:main','start:codex/TASK-1','start:codex/TASK-2']);assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,3);assert.ok(f.project.tasks[f.input.releaseId]!.every(t=>t.status==='todo'));await f.tick();assert.equal(f.calls.filter(c=>c.startsWith('start:')).length,3);
});
test('lost materialization reply reconciles authoritative mapping without repeating creation',async()=>{
  const f=fixture(), original=f.ports.materialize;f.ports.materialize=async(...args)=>{await original(...args);throw new Error('lost reply');};await f.service.start(f.input);await f.tick();assert.equal(f.read().status,'paused');assert.equal(f.read().nodes[0]!.phase,'creating');await f.service.control(f.input.id,'resume',f.read().version);await f.tick();assert.equal(f.read().nodes[0]!.phase,'ready');assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,1);
});
test('unknown creation with no authoritative mapping never repeats side effects',async()=>{
  const f=fixture();f.ports.materialize=async()=>{f.calls.push('unknown');throw new Error('unknown');};await f.service.start(f.input);await f.tick();await f.service.control(f.input.id,'resume',f.read().version);await f.tick();assert.equal(f.read().status,'paused');assert.deepEqual(f.calls,['unknown']);
});
test('lost child-start reply resumes the original durable child identity only',async()=>{
  const f=fixture(), original=f.ports.startChild;f.ports.startChild=async(...args)=>{await original(...args);throw new Error('lost reply');};await f.service.start(f.input);await f.tick();await f.tick();assert.equal(f.read().nodes[0]!.phase,'starting');await f.service.control(f.input.id,'resume',f.read().version);await f.tick();assert.equal(f.read().nodes[0]!.phase,'running');assert.equal(f.children.size,1);assert.equal(f.calls.filter(c=>c.startsWith('start:')).length,1);
});
test('unknown child with no durable record is not started twice',async()=>{
  const f=fixture();f.ports.startChild=async()=>{f.calls.push('unknown-start');throw new Error('unknown');};await f.service.start(f.input);await f.tick();await f.tick();await f.service.control(f.input.id,'resume',f.read().version);await f.tick();assert.equal(f.read().status,'paused');assert.equal(f.calls.filter(c=>c==='unknown-start').length,1);
});
test('pause is persisted before child pause; resume does not re-create or re-start it',async()=>{
  const f=fixture();await f.service.start(f.input);await f.tick();await f.tick();await assert.rejects(f.service.control(f.input.id,'pause',1));await f.service.control(f.input.id,'pause',f.read().version);assert.equal(f.read().status,'paused');assert.equal([...f.children.values()][0]!.status,'paused');const count=f.calls.length;await f.tick();assert.equal(f.calls.length,count);await f.service.control(f.input.id,'resume',f.read().version);assert.equal([...f.children.values()][0]!.status,'running');assert.equal(f.children.size,1);
});
test('adopted task workflow is observed, never owned or silently resumed',async()=>{
  const f=fixture();await f.service.start(f.input);await f.tick();const n=f.read().nodes[0]!;const c=await f.ports.startChild(f.read(),n,'t1','main');f.children.get(c.id)!.status='paused';f.calls.length=0;await f.tick();assert.equal(f.read().nodes[0]!.owned,false);await f.tick();await assert.rejects(f.service.control(f.input.id,'resume',f.read().version));assert.equal(f.calls.length,0);
});
test('failed node blocks downstream task creation and is not retried automatically',async()=>{
  const f=fixture();await f.service.start(f.input);await f.tick();await f.tick();[...f.children.values()][0]!.status='failed';await f.tick();assert.equal(f.read().status,'paused');await assert.rejects(f.service.control(f.input.id,'resume',f.read().version));assert.equal(f.project.tasks[f.input.releaseId]!.length,1);
});
test('requirement drift, archived project and revoked access pause before any new side effect',async()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.project.archived=true;},(f:ReturnType<typeof fixture>)=>{f.set.deny();},(f:ReturnType<typeof fixture>)=>{f.project.tasks[f.input.releaseId]![0]!.drifted=true;}]){const f=fixture();await f.service.start(f.input);await f.tick();mutate(f);await f.tick();assert.equal(f.read().status,'paused');assert.equal(f.children.size,0);}
});
test('completed node must have current proof; completed graph must contain integrated evidence',async()=>{
  const f=fixture();await f.service.start(f.input);await f.tick();await f.tick();[...f.children.values()][0]!.status='completed';f.set.proof(false);await f.tick();assert.equal(f.read().status,'paused');assert.equal(f.read().nodes[0]!.phase,'running');
  const g=fixture();await g.service.start(g.input);g.set.integration(false);const r=await g.drive();assert.equal(r.status,'paused');assert.ok(r.nodes.every(n=>n.phase==='verified'));g.set.integration(true);await g.service.control(g.input.id,'resume',g.read().version);assert.equal((await g.tick()).status,'completed');
});
test('frozen snapshot is not changed by later draft edits; published snapshot tampering blocks',async()=>{
  const f=fixture();await f.service.start(f.input);f.project.store.draft=structuredClone(f.plan);f.project.store.draft.nodes[0]!.title='draft change';await f.tick();assert.equal(f.read().status,'running');f.project.store.releases[0]!.plan.nodes[0]!.title='illegal mutation';await f.tick();assert.equal(f.read().status,'paused');
});
test('lost start reply pauses an owned child and one explicit resume rebinds that same child',async()=>{
  const f=fixture(), original=f.ports.startChild;f.ports.startChild=async(...args)=>{await original(...args);throw new Error('reply lost');};await f.service.start(f.input);await f.tick();await f.tick();assert.equal([...f.children.values()][0]!.status,'paused');await f.service.control(f.input.id,'resume',f.read().version);assert.equal([...f.children.values()][0]!.status,'running');await f.tick();assert.equal(f.read().nodes[0]!.phase,'running');assert.equal(f.children.size,1);
});
test('child pause failure never rolls back the durable parent pause',async()=>{
  const f=fixture();await f.service.start(f.input);await f.tick();await f.tick();f.ports.controlChild=async()=>{throw new Error('offline');};await assert.rejects(f.service.control(f.input.id,'pause',f.read().version));assert.equal(f.read().status,'paused');assert.equal(f.project.tasks[f.input.releaseId]!.length,1);await f.tick();assert.equal(f.project.tasks[f.input.releaseId]!.length,1);
});


test('isolated task context freezes shared contract, direct inputs and accumulated code references',async()=>{
  const f=fixture();await f.service.start(f.input);const run=await f.drive();assert.equal(run.status,'completed');
  assert.ok(run.nodes.every(n=>n.context&&n.handoff));
  const last=run.nodes.at(-1)!;assert.equal(last.context!.inputs.length,1);assert.equal(last.context!.included.length,2);
  const text=renderTaskContext(run,last,'a'.repeat(40));assert.match(text,/独立 Session/);assert.match(text,/累计代码基线/);assert.match(text,/不是已实现功能声明/);assert.doesNotMatch(text,/npm test/);assert.ok(text.length<64000);
  const changed=structuredClone(run);changed.plan.brief.sharedContract='changed';assert.throws(()=>renderTaskContext(changed,changed.nodes.at(-1)!,'a'.repeat(40)),/版本已变化/);
  const refChanged=structuredClone(run);refChanged.nodes.at(-1)!.context!.inputs[0]!.head='c'.repeat(40);assert.throws(()=>renderTaskContext(refChanged,refChanged.nodes.at(-1)!,'a'.repeat(40)),/成果引用不一致/);
  const tampered=structuredClone(run);tampered.nodes[0]!.handoff!.head='b'.repeat(40);assert.throws(()=>renderTaskContext(tampered,tampered.nodes.at(-1)!,'a'.repeat(40)),/代码版本/);
});
test('missing receipts cannot be presented as delivered prerequisite context',async()=>{
  const f=fixture();await f.service.start(f.input);await f.tick();const r=f.read(),node=r.nodes[1]!;assert.throws(()=>buildTaskContext(r,node,'main'),/前置任务/);
});
test('context stays bounded and explicitly indicates excerpts instead of copying whole prior histories',async()=>{
  const f=fixture();await f.service.start(f.input);const r=await f.drive();for(const n of r.plan.nodes){n.outcome='x'.repeat(6000);n.acceptance='y'.repeat(6000);}for(const n of r.nodes){n.handoff!.files=Array.from({length:100},(_,i)=>`${i}/`+'f'.repeat(900));n.handoff!.ci=Array.from({length:100},(_,i)=>`check-${i}`);}
  const text=renderTaskContext(r,r.nodes.at(-1)!,'a'.repeat(40));assert.ok(text.length<65000);assert.doesNotMatch(text,/filesTruncated/);assert.doesNotMatch(text,/check-99/);assert.match(text,/reference/);
});

test('all isolated nodes inherit one frozen design version; changing its reference invalidates context',async()=>{
  const f=fixture();f.plan.design={versionId:randomUUID(),sha256:'a'.repeat(64),title:'Feedback design',notes:'统一布局与反馈'};
  await f.service.start(f.input);const run=await f.drive();assert.deepEqual(payload(run).product.design,f.plan.design);
  assert.equal(new Set(run.nodes.map(n=>n.context?.sharedVersion)).size,1);
  run.plan.design!.versionId=randomUUID();assert.throws(()=>payload(run),/版本已变化/);
});
