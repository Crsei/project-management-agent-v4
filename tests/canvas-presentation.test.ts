import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { emptyRoadmap } from '../packages/contracts/src/product-roadmap.ts';
import * as contract from '../packages/contracts/src/product-canvas.ts';
import type { CanvasRun } from '../packages/contracts/src/product-canvas.ts';
import * as presentation from '../apps/web/src/features/pm/product-roadmap/canvas-presentation.ts';

const plan = emptyRoadmap();
plan.nodes = ['登录','客户','工单'].map((title,i)=>({id:String(i),title,outcome:'需求',acceptance:'验收',nonGoals:'',stage:'MVP',dependsOn:[],x:i*300,y:0}));
function run(status: CanvasRun['status'] = 'paused', message = '节点需要处理：工作目录身份发生变化，拒绝执行。'): CanvasRun {
  return { id:'run',input:{} as CanvasRun['input'],version:1,plan,status,message,createdAt:'2026-11-08T00:00:00Z',updatedAt:'2026-11-08T00:00:00Z',nodes:plan.nodes.map((n,i)=>({nodeId:n.id,childId:`child${i}`,phase:i<2?'verified':'running'})) };
}
test('environment incident exposes a next step without pretending to repair or finish',()=>{
  const value = run(), view = presentation.canvasProgress(value);
  assert.equal(view.title,'构建环境需要恢复');assert.equal(view.verified,2);assert.equal(view.total,3);assert.equal(view.feature,'工单');assert.equal(view.resumeBlocked,true);
  assert.match(view.description,/维护人员/);assert.doesNotMatch(view.description,/worktree|inode|Session|已恢复/);
  assert.equal(presentation.canvasNodeLabel(value.nodes[0]!,value),'检查通过');
  assert.equal(presentation.canvasNodeLabel(value.nodes[2]!,value),'等待环境恢复');
  assert.equal(value.status,'paused'); // No mutation of durable/domain state.
});
test('pending, running, paused, completed and unknown states do not claim product acceptance',()=>{
  const r = run('running');assert.equal(presentation.canvasProgress(r).resumeBlocked,false);
  assert.equal(presentation.canvasNodeLabel({...r.nodes[2]!,phase:'pending'},r),'尚未开始');
  assert.equal(presentation.canvasNodeLabel(r.nodes[2]!,r),'正在构建');
  const manual = presentation.canvasProgress(run('paused','已暂停后续派发；在途命令不保证取消。'));
  assert.match(manual.description,/操作可能仍在/);assert.equal(manual.resumeBlocked,false);
  assert.match(presentation.canvasProgress(run('completed')).description,/不代表产品已验收或上线/);
  for (const message of ['GitHub 操作未确认','结果未知','原请求待核对']) assert.equal(presentation.canvasIssue(message).kind,'unknown');
  assert.equal(presentation.canvasIssue('缺少项目权限').kind,'access');
  assert.equal(presentation.canvasIssue('some unfamiliar private/path/error').kind,'attention');
});
test('all three explicit choices required, commit and upload remain separately authorized',()=>{
  for(let i=0;i<8;i++) {
    const result=presentation.canvasConsent({build:!!(i&1),commit:!!(i&2),upload:!!(i&4)});
    if(i!==7) assert.equal(result,null);
    else assert.deepEqual(result,{execute:true,worktreeWrite:true,createTasks:true,taskStatus:true,commit:true,push:true,draftPr:true});
  }
});

const requireWeb=createRequire(new URL('../apps/web/package.json',import.meta.url));
const react=requireWeb('react');const {renderToStaticMarkup}=requireWeb('react-dom/server');
type Component = (props:unknown)=>unknown;
function compile(file:string, resolve:(name:string)=>unknown) {
  const js=ts.transpileModule(readFileSync(new URL(`../apps/web/src/features/pm/product-roadmap/${file}.tsx`,import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports:Record<string,Component>={};new Function('require','exports',js)(resolve,exports);return exports;
}
const status=compile('CanvasBuildStatus',n=>n==='./canvas-presentation'?presentation:requireWeb(n));
test('real status TSX renders function progress, not raw diagnostics or implementation IDs',()=>{
  const html=renderToStaticMarkup(status.CanvasBuildStatus!({run:run()}));
  assert.match(html,/2 \/ 3 个功能检查通过/);assert.match(html,/工单/);assert.match(html,/value="2"/);
  assert.doesNotMatch(html,/工作目录身份发生变化|拒绝执行|节点已验证|worktree/);
});
test('unknown error retains exact diagnostic only in closed details',()=>{
  const message='private/path/error inode=42';const html=renderToStaticMarkup(status.CanvasOperationNotice!({message}));
  assert.ok(html.indexOf(message)>html.indexOf('<summary>诊断详情</summary>'));
  assert.match(html,/请先刷新进度/);assert.doesNotMatch(html,/<details[^>]*\bopen/);
});

type Element={type?:string;props?:{children?:unknown;onClick?:()=>unknown;disabled?:boolean;onChange?:(event:{target:{checked:boolean}})=>void}};
function elements(value:unknown):Element[] {
  if(!value||typeof value!=='object')return [];
  if(Array.isArray(value))return value.flatMap(elements);
  const e=value as Element;return [e,...elements(e.props?.children)];
}
function panel(values:Record<number,unknown>={}) {
  let cursor=0;const calls:unknown[]=[];
  const hooks={...react,useEffect:()=>{},useRef:(v:unknown)=>({current:v}),useState:(initial:unknown)=>{const i=cursor++;return [i in values?values[i]:initial,(v:unknown)=>{values[i]=v;}];}};
  const components=compile('CanvasRunPanel',name=>{
    if(name==='react')return hooks;
    if(name==='./canvas-presentation')return presentation;
    if(name==='./CanvasBuildStatus')return status;
    if(name.endsWith('/product-canvas'))return contract;
    if(name==='@agent/src/network')return {workspaceClient:{json:(...args:unknown[])=>{calls.push(args);return Promise.reject(new Error('Unexpected network write'));}}};
    if(name==='@agent/src/pm/execution-workspace')return {ExecutionSelectionField:()=>react.createElement('label',null,'Agent 目录')};
    if(name==='@/components/ui/dialog')return Object.fromEntries(['Dialog','DialogContent','DialogDescription','DialogTitle'].map(k=>[k,({children}: {children:unknown})=>react.createElement('div',null,children)]));
    return requireWeb(name);
  });
  const tree=components.CanvasRunPanel!({workspaceId:'w',projectId:'p',storageKey:'k',disabled:false,issues:[],prepare:()=>{calls.push('prepare');throw new Error('Unexpected preparation');},onRun:()=>{}});
  const button=(label:string)=>elements(tree).find(e=>e.type==='button'&&e.props?.children===label)!;
  return {tree,button,calls,values};
}
test('blocked run has no enabled generic resume and maintenance confirmation starts unchecked',async()=>{
  const p=panel({3:run()});assert.equal(p.button('等待环境恢复').props?.disabled,true);
  assert.equal(p.button('重新核对并继续').props?.disabled,true);
  await p.button('等待环境恢复').props?.onClick?.();
  await p.button('重新核对并继续').props?.onClick?.();assert.deepEqual(p.calls,[]);
  const html=renderToStaticMarkup(p.tree);assert.match(html,/当前不支持一键修复/);assert.doesNotMatch(html,/checked=""/);
});
test('start dialog does not preselect consent or a costly model, and advanced settings are closed',async()=>{
  const p=panel({0:true,4:{repository:'owner/repo',baseBranch:'main'},5:true});
  const html=renderToStaticMarkup(p.tree);
  assert.match(html,/owner\/repo/);assert.match(html,/消耗该服务额度/);assert.match(html,/不会自动合并/);
  assert.doesNotMatch(html,/checked=""|<details[^>]*\bopen/);
  assert.equal(p.button('确认并开始构建').props?.disabled,true);
  await p.button('确认并开始构建').props?.onClick?.();assert.deepEqual(p.calls,[]);
  assert.ok(html.indexOf('起始代码分支')>html.indexOf('<summary>高级构建设置与执行范围</summary>'));
});

function renderWithState(file:string, values:unknown[], props:unknown, extra:(name:string)=>unknown=()=>undefined) {
  let i=0;
  const component=compile(file,name=>{
    if(name==='react')return {...react,useState:()=>[values[i++],()=>{}],useEffect:()=>{},useRef:()=>({current:null})};
    if(name==='@agent/src/network')return {workspaceClient:{}};
    const value=extra(name);return value===undefined?requireWeb(name):value;
  });
  return renderToStaticMarkup(Object.values(component)[0]!(props)) as string;
}
test('product preview hides technical records but not its isolation and data warnings',()=>{
  const state={status:'stopped',available:true,head:'a'.repeat(40),url:null,expiresAt:null,message:'TECHNICAL_BACKEND_REASON'};
  const html=renderWithState('../workflows/AppPreviewPanel',[state,'TECHNICAL_ERROR',false,true],{delivery:{id:'d',head:state.head},disabled:false,productView:true});
  const primary=html.slice(0,html.indexOf('<details'));
  assert.match(primary,/启动产品预览/);assert.match(primary,/账号凭据/);assert.match(primary,/不能访问外网/);assert.match(primary,/30 分钟/);assert.match(primary,/真实敏感数据/);
  assert.doesNotMatch(primary,/TECHNICAL|app\/server|Agent Chat|aaaaaaa/);
  assert.match(html,/TECHNICAL_BACKEND_REASON/);assert.match(html,/TECHNICAL_ERROR/);assert.doesNotMatch(html,/<details[^>]*\bopen/);
});
test('product delivery view gates preview on real eligibility and collapses PR/CI details',()=>{
  const item={taskId:'TASK-001',title:'客户管理',deliveryId:'d',head:'a'.repeat(40),pr:'https://github.com/owner/repo/pull/1',tested:true,ci:true,included:false,observedAt:null,issue:'TECHNICAL_ISSUE'};
  const html=renderWithState('ProjectDeliveryEvidence',[{eligible:false,reason:'TECHNICAL_REASON',candidate:null,items:[item]},'',false],{scope:{workspaceId:'w',projectId:'p',releaseId:'r'},disabled:false},name=>name.endsWith('.css')?{}:name.endsWith('/AppPreviewPanel')?{AppPreviewPanel:()=>react.createElement('div',null,'PREVIEW_SENTINEL')}:undefined);
  const primary=html.slice(0,html.indexOf('<details'));
  assert.match(primary,/尚未具备预览条件/);assert.match(primary,/客户管理/);assert.doesNotMatch(primary,/TECHNICAL|TASK-001|查看 PR|CI|PREVIEW_SENTINEL/);
  assert.match(html,/TECHNICAL_REASON/);assert.match(html,/TECHNICAL_ISSUE/);assert.doesNotMatch(html,/<details[^>]*\bopen/);
});
test('verified individual function is not presented as an integrated preview',()=>{
  const item={taskId:'TASK-001',title:'登录',deliveryId:'d',head:'a'.repeat(40),pr:null,tested:true,ci:true,included:false,observedAt:null,issue:null};
  const html=renderWithState('ProjectDeliveryEvidence',[{eligible:false,reason:'pending integration',candidate:null,items:[item]},'',false],{scope:{workspaceId:'w',projectId:'p',releaseId:'r'},disabled:false},name=>name.endsWith('.css')?{}:name.endsWith('/AppPreviewPanel')?{AppPreviewPanel:()=>react.createElement('div',null,'PREVIEW_SENTINEL')}:undefined);
  assert.match(html,/功能检查通过 · 待整体核对/);assert.doesNotMatch(html,/PREVIEW_SENTINEL/);
});
test('unknown preview response never claims that no process was started',()=>{
  const html=renderWithState('../workflows/AppPreviewPanel',[null,'timeout',false,false],{delivery:{id:'d',head:'a'.repeat(40)},disabled:false,productView:true});
  assert.match(html,/预览状态待核对/);assert.match(html,/预览结果尚未确认/);
  assert.doesNotMatch(html,/尚未启动|预览正在运行/);
});
