import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as context from '../packages/contracts/src/task-context.ts';
import type { CanvasRun } from '../packages/contracts/src/product-canvas.ts';
import { emptyRoadmap } from '../packages/contracts/src/product-roadmap.ts';

// Render the real TSX without a browser or platform-specific bundler binary.
const requireWeb=createRequire(new URL('../apps/web/package.json',import.meta.url));
const {renderToStaticMarkup}=requireWeb('react-dom/server');
const source=readFileSync(new URL('../apps/web/src/features/pm/product-roadmap/CanvasNodeContext.tsx',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const component: Record<string,(props:unknown)=>unknown>={};
new Function('require','exports',js)((name:string)=>name.endsWith('/task-context')?context:requireWeb(name),component);
const plan=emptyRoadmap();plan.brief.sharedContract='统一导航与安静氛围';plan.nodes=[{id:'node',title:'反馈',outcome:'不能冒充已有功能的需求',acceptance:'验收',nonGoals:'',stage:'MVP',dependsOn:[],x:0,y:0}];
const receipt: context.CanvasHandoff={schema:'pm/task-handoff/v1',deliveryId:'delivery',taskId:'TASK-001',head:'a'.repeat(40),branch:'codex/test',pr:'https://github.com/owner/repo/pull/1',testCommand:'npm test',testDigest:'digest',ci:['check'],checkedAt:'2026-11-05T00:00:00.000Z',files:['src/internal.ts'],filesTruncated:false};
function render(report?: context.CanvasHandoff['report'],phase='verified') {
  const run={nodes:[{nodeId:'node',phase,handoff:{...receipt,report}}]} as CanvasRun;
  return renderToStaticMarkup(component.CanvasNodeContext!({plan,node:plan.nodes[0],run})) as string;
}
test('product changes are visible; technical evidence stays in closed details',()=>{
  const html=render({changes:['新增反馈提交'],capabilities:['提交反馈']});
  assert.ok(html.indexOf('新增反馈提交')<html.indexOf('<details>'));
  assert.ok(html.indexOf('npm test')>html.indexOf('<summary>执行详情</summary>'));
  assert.doesNotMatch(html,/<details[^>]*\bopen/);
  assert.match(html,/本次功能变化/);assert.match(html,/统一导航与安静氛围/);
});
test('legacy, missing and unverified reports never become product capability claims',()=>{
  const legacy=render({interfaces:['INTERNAL_API'],decisions:[],usage:'old',risks:[]});
  assert.match(legacy,/本次运行未提供功能变化说明/);assert.ok(legacy.indexOf('INTERNAL_API')>legacy.indexOf('<summary>执行详情</summary>'));
  assert.match(render(),/本次运行未提供功能变化说明/);
  const pending=render({changes:['UNVERIFIED_FEATURE'],capabilities:['UNVERIFIED_FEATURE']},'running');
  assert.doesNotMatch(pending,/UNVERIFIED_FEATURE/);assert.doesNotMatch(pending,/不能冒充已有功能的需求/);
  assert.match(render({changes:[],capabilities:[]}),/本次没有产品功能变化/);
});

test('drafts render no empty product changes, runtime context or technical warnings',()=>{
  assert.equal(renderToStaticMarkup(component.CanvasNodeContext!({plan,node:plan.nodes[0],run:null})), '');
});

const editorSource=readFileSync(new URL('../apps/web/src/features/pm/product-roadmap/CanvasFeatureEditor.tsx',import.meta.url),'utf8');
const editor: Record<string,(props:unknown)=>unknown>={};
new Function('require','exports',ts.transpileModule(editorSource,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(requireWeb,editor);
test('feature editor exposes three product questions and keeps constraints and dependencies collapsed',()=>{
  const node={...plan.nodes[0]!,nonGoals:'范围保持',stage:'原分组',dependsOn:['other']};
  const design={...plan,nodes:[node,{...node,id:'other',title:'前置功能',dependsOn:[]}]};
  const html=renderToStaticMarkup(editor.CanvasFeatureEditor!({node,plan:design,editable:true,onChange:()=>{}})) as string;
  const primary=html.slice(0,html.indexOf('<details'));
  for(const label of ['功能名称','用户能做什么','预期效果'])assert.ok(primary.includes(label));
  for(const hidden of ['范围保持','原分组','前置功能','执行详情','阶段'])assert.ok(!primary.includes(hidden));
  assert.match(html,/范围保持/);assert.match(html,/原分组/);assert.match(html,/checked=""/);assert.doesNotMatch(html,/<details[^>]*\bopen/);
  assert.match(renderToStaticMarkup(editor.CanvasFeatureEditor!({node,plan:design,editable:false,onChange:()=>{}})),/readOnly=""/);
});

test('editing one product field emits only its patch, preserving hidden node data',()=>{
  type Element = {type?:string;props?:{children?:Element|Element[];onChange?:(event:{target:{value:string}})=>void;value?:string}};
  const updates: unknown[]=[];
  const node={...plan.nodes[0]!,nonGoals:'keep',stage:'keep stage',dependsOn:['keep dependency']};
  const tree=editor.CanvasFeatureEditor!({node,plan,editable:true,onChange:(v:unknown)=>updates.push(v)}) as Element;
  function fields(e:Element):Element[]{if(!e||!e.props)return [];const children=Array.isArray(e.props.children)?e.props.children:[e.props.children];return [e,...children.flatMap(child=>fields(child!))];}
  fields(tree).find(e=>e.type==='input'&&e.props?.value===node.title)!.props!.onChange!({target:{value:'新名称'}});
  assert.deepEqual(updates,[{title:'新名称'}]);assert.equal(node.nonGoals,'keep');assert.deepEqual(node.dependsOn,['keep dependency']);
});

test('functional node shows one inherited design reference without per-node design configuration',()=>{
  const design={...plan,design:{versionId:'12345678-1111-4111-8111-111111111111',sha256:'a'.repeat(64),title:'清晰的反馈工作台',notes:'静谧、统一导航'}};
  const html=renderToStaticMarkup(editor.CanvasFeatureEditor!({node:plan.nodes[0],plan:design,editable:true,onChange:()=>{}}));
  assert.match(html,/自动继承产品设计/);assert.match(html,/清晰的反馈工作台/);assert.match(html,/12345678/);assert.match(html,/无需逐节点配置/);
});
