import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { closeStore, writeRecord } from '../durable/store.ts';
import { canvasDevelopmentContext } from './canvas-context.ts';
import { buildTaskContext } from '../../../../../packages/application/src/task-context.ts';
import { emptyRoadmap } from '../../../../../packages/contracts/src/product-roadmap.ts';
import { agentHandoffReportSchema } from '../../../../../packages/contracts/src/task-context.ts';
import type { CanvasRun } from '../../../../../packages/contracts/src/product-canvas.ts';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
test('Agent receives server-owned context only when scope, running owner and actual Git ancestry match',async()=>{
 const temp=mkdtempSync(join(tmpdir(),'canvas-context-')),old=process.env.AGENT_WORKSPACE_DATA_DIR;process.env.AGENT_WORKSPACE_DATA_DIR=join(temp,'store');
 const git=(...args:string[])=>execFileSync('git',args,{cwd:temp,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
 try {
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');writeFileSync(join(temp,'app.txt'),'first');git('add','app.txt');git('commit','-qm','first');const before=git('rev-parse','HEAD');writeFileSync(join(temp,'app.txt'),'second');git('commit','-qam','second');const head=git('rev-parse','HEAD');
  const plan=emptyRoadmap(),first=randomUUID(),second=randomUUID(),releaseId=randomUUID(),now=new Date().toISOString();plan.brief.sharedContract='one data model';plan.nodes=[first,second].map((id,i)=>({id,title:`task-${i}`,stage:'MVP',outcome:'outcome',acceptance:'acceptance',nonGoals:'other',x:0,y:i*200,dependsOn:i?[first]:[]}));
  const input={id:randomUUID(),workspaceId:randomUUID(),projectId:'PRJ-001',releaseId,revision:'r1',repository:'owner/repo',baseBranch:'main',providerInstanceId:'codex',model:'test',consent:{execute:true as const,worktreeWrite:true as const,commit:true as const,push:true as const,draftPr:true as const,taskStatus:true as const,createTasks:true as const}};
  const firstId=randomUUID(),childId=randomUUID();const run:CanvasRun={id:input.id,input,plan,version:1,status:'running',message:'',createdAt:now,updatedAt:now,nodes:[{nodeId:first,childId:firstId,taskId:'TASK-001',phase:'verified',branch:'main',handoff:{schema:'pm/task-handoff/v1',deliveryId:firstId,taskId:'TASK-001',head,branch:'main',pr:'https://github.com/owner/repo/pull/1',testCommand:'npm test',testDigest:'digest',ci:['test'],checkedAt:now,files:['app.txt'],filesTruncated:false}},{nodeId:second,childId,taskId:'TASK-002',phase:'running',owned:true}]};run.nodes[1]!.context=buildTaskContext(run,run.nodes[1]!,'main');writeRecord('product-canvas-runs-v1',run.id,run);
  const delivery:TaskCodeDelivery={id:childId,workspaceId:input.workspaceId,projectId:'PRJ-001',taskId:'TASK-002',taskRevision:'t1',baseBranch:'main',title:'task',description:'',createdAt:now,updatedAt:now,step:'ready',version:1,threadId:`delivery-${childId}`,git:{root:temp,directory:temp,directoryIdentity:'fixture',commonDirectory:join(temp,'.git'),remote:'git@github.com:owner/repo.git',owner:'owner',repo:'repo',branch:'codex/task',baseBranch:'main',baseSha:head}};
  assert.match(await canvasDevelopmentContext(delivery),/one data model/);
  await assert.rejects(canvasDevelopmentContext({...delivery,workspaceId:randomUUID()}),/归属/);
  await assert.rejects(canvasDevelopmentContext({...delivery,git:{...delivery.git!,baseSha:before}}));
  assert.equal(await canvasDevelopmentContext({...delivery,id:randomUUID()}),'');
  run.nodes[1]!.phase='verified';writeRecord('product-canvas-runs-v1',run.id,run);await assert.rejects(canvasDevelopmentContext(delivery),/状态/);run.nodes[1]!.phase='running';
  run.status='paused';writeRecord('product-canvas-runs-v1',run.id,run);await assert.rejects(canvasDevelopmentContext(delivery),/状态/);
  run.status='running';run.plan.design={versionId:randomUUID(),sha256:'a'.repeat(64),title:'Design',notes:'清晰'};run.nodes[1]!.context=buildTaskContext(run,run.nodes[1]!,'main');writeRecord('product-canvas-runs-v1',run.id,run);
  const originalFetch=globalThis.fetch;let forwarded=false;let material='';
  globalThis.fetch=async (_url,options)=>{forwarded=new Headers(options?.headers).get('authorization')==='Bearer fixture';return Response.json({versionId:run.plan.design!.versionId,sha256:'a'.repeat(64),fileName:'design.zip',assets:[{name:'index.html',mediaType:'text/html',base64:Buffer.from('<h1>设计图</h1>').toString('base64')}],unsupported:[]});};
  try {material=await canvasDevelopmentContext(delivery,new Headers({authorization:'Bearer fixture'}));assert.equal(forwarded,true);const directory=material.match(/只读目录 ([^\n]+)/)![1]!;assert.equal(readFileSync(join(directory,'index.html'),'utf8'),'<h1>设计图</h1>');assert.ok(!material.includes('<h1>设计图</h1>'));rmSync(directory,{recursive:true,force:true});
    globalThis.fetch=async()=>Response.json({versionId:run.plan.design!.versionId,sha256:'b'.repeat(64),fileName:'design.zip',assets:[],unsupported:[]});await assert.rejects(canvasDevelopmentContext(delivery),/校验失败/);
  } finally {globalThis.fetch=originalFetch;}
  run.status='running';delete run.nodes[1]!.context;writeRecord('product-canvas-runs-v1',run.id,run);await assert.rejects(canvasDevelopmentContext(delivery));
 }finally{closeStore();if(old===undefined)delete process.env.AGENT_WORKSPACE_DATA_DIR;else process.env.AGENT_WORKSPACE_DATA_DIR=old;rmSync(temp,{recursive:true,force:true});}
});
test('Agent semantic handoff is bounded data, not an execution or completion instruction',()=>{
 const report={interfaces:['GET /feedback'],decisions:['shared IDs'],usage:'npm start',risks:['cross-browser not checked']};assert.deepEqual(agentHandoffReportSchema.parse(report),report);assert.equal(agentHandoffReportSchema.safeParse({...report,execute:'rm -rf'}).success,false);assert.equal(agentHandoffReportSchema.safeParse({...report,usage:'x'.repeat(3001)}).success,false);
});
