import { ProductDesignPanel } from './ProductDesignPanel';
import { CanvasNodeContext } from './CanvasNodeContext';
import { useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useParams } from 'react-router';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { usePmService } from '../service/pm-service';
import { ServiceGuard } from '../service/pm-ui';
import { emptyRoadmap, roadmapPlanSchema, roadmapProblems, type ProductBrief, type RoadmapAction, type RoadmapNode, type RoadmapPlan, type RoadmapRead } from '../../../../../../packages/contracts/src/product-roadmap';
import type { CanvasRun } from '../../../../../../packages/contracts/src/product-canvas';
import { feedbackScenario, layoutRoadmap, addIntegrationTask } from './model';
import { RoadmapCanvas } from './RoadmapCanvas';
import { AgentRoadmapPlanner } from './AgentRoadmapPlanner';
import { CanvasRunPanel } from './CanvasRunPanel';
import { CanvasFeatureEditor } from './CanvasFeatureEditor';
import { ProjectDeliveryEvidence } from './ProjectDeliveryEvidence';
import './product-roadmap.css';
const fields: [keyof ProductBrief, string][] = [['idea','想做什么产品'],['audience','给谁使用'],['problem','解决什么问题'],['journey','PRD / 核心需求与用户流程'],['success','第一版如何验收'],['nonGoals','本期不做什么'],['sharedContract','技术与运行约束'],['assumptions','假设与待确认问题']];
async function request(url: string, action?: RoadmapAction): Promise<RoadmapRead> {
  const response = await fetch(url, { method: action ? 'POST' : 'GET', credentials: 'same-origin', headers: action ? { 'Content-Type': 'application/json' } : {}, ...(action ? { body: JSON.stringify(action) } : {}), signal: AbortSignal.timeout(20000) });
  const value = await response.json(); if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : value.error?.message || `请求失败 (${response.status})`); return value;
}
export function ProductRoadmapPage() {
  const { projectId } = useParams(), s = usePmService();
  return <ServiceGuard>{s.actor && s.workspace && projectId && <CanvasWorkbench key={`${s.actor.id}:${s.actorEpoch}:${s.workspace.id}:${s.workspace.version}:${projectId}`} workspaceId={s.workspace.id} projectId={projectId} actorId={s.actor.id} canEdit={s.workspace.capabilities.includes('planning.edit') && (s.workspace.projectIds === null || s.workspace.projectIds.includes(projectId))} />}</ServiceGuard>;
}
function CanvasWorkbench({ workspaceId, projectId, actorId, canEdit }: { workspaceId: string; projectId: string; actorId: string; canEdit: boolean }) {
  const url = `/api/v1/workspaces/${workspaceId}/projects/${projectId}/product-roadmap`, key = `pm-product-roadmap:${window.location.origin}:${actorId}:${workspaceId}:${projectId}`;
  const [data,setData] = useState<RoadmapRead | null>(null), [plan,setPlan] = useState<RoadmapPlan>(emptyRoadmap), [revision,setRevision] = useState('');
  const [dirty,setDirty] = useState(false), [busy,setBusy] = useState(false), [pending,setPending] = useState<RoadmapAction | null>(null), [error,setError] = useState('');
  const [panel,setPanel] = useState<'prd'|'experience'|'generate'|'preview'|null>(null), [selected,setSelected] = useState<string|null>(null), [run,setRun] = useState<CanvasRun|null>(null), [confirm,setConfirm] = useState('');
  const alive = useRef(true), flight = useRef(false), initialized = useRef(false);
  const conflicts = !!data && revision !== data.revision, locked = !!run;
  const editable = canEdit && !!data && !data.archived && !busy && !pending && !conflicts && !locked;
  const viewPlan = run?.plan ?? plan, selectedNode = viewPlan.nodes.find(n => n.id === selected);
  const runNode = run?.nodes.find(n => n.nodeId === selected);
  const release = data?.store.releases.find(r => r.id === run?.input.releaseId) ?? data?.store.releases.at(-1);
  const tasks = release ? data?.tasks[release.id] ?? [] : [];
  const blocker = useBlocker(({ currentLocation,nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  function restore(v: RoadmapRead) { setData(v); setRevision(v.revision); setPlan(v.store.draft); setDirty(false); setPending(null); localStorage.removeItem(key); }
  async function load(discard = false) {
    if (flight.current) return; flight.current = true; setBusy(true); setError('');
    try {
      const v = await request(url); if (!alive.current) return; setData(v);
      if (discard) restore(v);
      else if (!initialized.current) {
        const raw = localStorage.getItem(key);
        if (raw) { const saved = JSON.parse(raw), parsed = roadmapPlanSchema.parse(saved.plan); if (typeof saved.revision !== 'string') throw new Error('无法恢复本机版本'); setPlan(parsed); setRevision(saved.revision); setDirty(true); setPending(saved.pending ?? null); }
        else { setPlan(v.store.draft); setRevision(v.revision); }
        initialized.current = true;
      }
    } catch(e) { if (alive.current) { setError(String(e)); setData(null); } }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!dirty && !pending) return; const warn = (e: BeforeUnloadEvent) => e.preventDefault(); window.addEventListener('beforeunload',warn); return () => window.removeEventListener('beforeunload',warn); },[dirty,pending]);
  function change(next: RoadmapPlan) { if (!editable) return; setPlan(next); setDirty(true); try { localStorage.setItem(key,JSON.stringify({plan:next,revision,pending:null})); } catch { setError('本机草稿保存失败，请保留需求内容，不要关闭页面。'); } }
  function nodeChange(changes: Partial<RoadmapNode>) { if (selected) change({...plan,nodes:plan.nodes.map(n => n.id === selected ? {...n,...changes} : n)}); }
  async function write(action: RoadmapAction) {
    if (flight.current || !data || !canEdit || pending || data.archived) throw new Error('请先核对当前计划与原写入。');
    flight.current = true; setBusy(true); setError('');
    try { localStorage.setItem(key,JSON.stringify({plan,revision,pending:action})); setPending(action); const v = await request(url,action); if (!alive.current) throw new Error('页面已关闭，请重新核对结果。'); restore(v); return v; }
    catch(e) { if (alive.current) setError(`${String(e)}。结果未确认，请刷新核对，不要重复提交。`); throw e; }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  }
  async function prepare() {
    if (!editable || conflicts) throw new Error('当前草稿不可运行，请先解决冲突或原请求。');
    const problems = roadmapProblems(plan); if (problems.length) throw new Error(problems.join('\n'));
    let v = data!;
    if (dirty) v = await write({action:'save',commandId:crypto.randomUUID(),revision,plan});
    let frozen = v.store.releases.find(r => JSON.stringify(r.plan) === JSON.stringify(plan));
    if (!frozen) { const id = crypto.randomUUID(); v = await write({action:'publish',commandId:crypto.randomUUID(),revision:v.revision,releaseId:id,confirm:true}); frozen = v.store.releases.find(r => r.id === id); }
    if (!frozen) throw new Error('未确认画布版本。');
    return {releaseId:frozen.id,revision:v.revision};
  }
  const problems = roadmapProblems(plan);
  return <main className="product-roadmap product-canvas-workbench" aria-label="产品画布">
    <header className="canvas-main-header"><div><h1>产品画布</h1><p>{run ? '按依赖逐步构建同一个产品' : '描述产品功能，连接前置关系，逐步构建同一个产品。'}</p></div><div className="roadmap-actions"><button onClick={() => setPanel('prd')}>编辑 PRD</button><button onClick={() => setPanel('experience')}>产品设计</button><button disabled={!editable} onClick={() => setPanel('generate')}>从 PRD 生成画布</button><CanvasRunPanel workspaceId={workspaceId} projectId={projectId} storageKey={key} disabled={!canEdit || !data || !!data.archived || busy || !!pending || conflicts} issues={run ? [] : problems} prepare={prepare} onRun={setRun} /><button disabled={!release} onClick={() => setPanel('preview')}>查看产品</button></div></header>
    <div className="canvas-commandbar"><span>{run ? '运行版本已冻结' : !data ? '正在读取画布' : dirty ? '有未保存修改' : '画布已保存'} · {viewPlan.nodes.length} 个功能</span><div className="roadmap-actions"><button disabled={!editable || !dirty} onClick={() => void write({action:'save',commandId:crypto.randomUUID(),revision,plan}).catch(() => {})}>保存画布</button><button disabled={!editable} onClick={() => change(layoutRoadmap(plan))}>整理布局</button><button disabled={!editable || plan.nodes.length >= 24} onClick={() => {const id=crypto.randomUUID();change({...plan,nodes:[...plan.nodes,{id,title:'',outcome:'',acceptance:'',nonGoals:'',stage:'第一阶段',dependsOn:[],x:30,y:plan.nodes.length*190}]});setSelected(id);}}>添加功能</button><button disabled={!editable || !plan.nodes.length || plan.nodes.length>=24} onClick={()=>{try{const id=crypto.randomUUID();change(addIntegrationTask(plan,id));setSelected(id);}catch(e){setError(String(e));}}}>检查整体体验</button></div></div>
    {run && <p role="status" className="canvas-run-status">{run.nodes.filter(n=>n.phase==='verified').length}/{run.nodes.length} 节点已验证 · {run.message}</p>}
    {error && <p role="alert" className="roadmap-error">{error}</p>}
    {(conflicts || pending) && <p role="alert" className="roadmap-warning">当前版本冲突或原写入结果未确认。先核对服务端，再明确载入；不会自动重试。</p>}
    {!run && problems.length > 0 && plan.nodes.length > 0 && <details className="canvas-validation"><summary>运行前需补齐 {problems.length} 项</summary><ul>{problems.map(p=><li key={p}>{p}</li>)}</ul></details>}
    <RoadmapCanvas plan={viewPlan} selected={selected} onSelect={setSelected} {...(editable ? {onMove:(id:string,x:number,y:number)=>change({...plan,nodes:plan.nodes.map(n=>n.id===id?{...n,x,y}:n)})} : {})} tasks={run ? tasks : undefined} statuses={run ? Object.fromEntries(run.nodes.map(n=>[n.nodeId,n.phase==='verified'?'交付已验证':n.phase==='running'?run.status==='paused'?'需要处理':'正在构建':n.phase==='pending'?'等待前置':'准备中'])) : undefined} />
    {!plan.nodes.length && !run && <div className="canvas-empty-actions"><button className="primary" onClick={()=>setPanel('prd')}>写下产品需求</button><button disabled={!editable} onClick={()=>setConfirm('scenario')}>使用示例 PRD</button></div>}
    <details className="canvas-technical"><summary>版本与技术详情</summary><button disabled={busy} onClick={()=>void load()}>刷新核对</button><button disabled={busy || !data} onClick={()=>setConfirm('reload')}>载入服务端版本</button><p>后台保存版本、建立任务、分支、测试及 Draft PR。不会自动合并、部署或标记业务完成。</p>{run && <p>运行：{run.id} · 发布版本：{run.input.releaseId}</p>}</details>
    <Dialog open={panel!==null} onOpenChange={v=>{if(!v)setPanel(null);}}><DialogContent className="canvas-dialog canvas-wide-dialog"><DialogTitle>{panel==='prd'?'产品 PRD':panel==='experience'?'产品设计':panel==='generate'?'从 PRD 生成画布':'产品预览与验收'}</DialogTitle><DialogDescription>{panel==='prd'?'描述目标、核心需求和验收；不需要先懂任务拆解。':panel==='experience'?'上传设计资料或通过对话生成，预览后采用；所有节点共享同一版本。':panel==='generate'?'使用现有 Agent，结果先进入草稿，不自动运行。':'核对同一集成版本，再打开产品体验。'}</DialogDescription>
      {panel==='prd' && <><div className="roadmap-fields">{fields.map(([k,label])=><label key={k}>{label}<textarea rows={k==='journey'?8:3} maxLength={6000} value={viewPlan.brief[k]} disabled={!editable} onChange={e=>change({...plan,brief:{...plan.brief,[k]:e.target.value}})} /></label>)}</div><div className="roadmap-actions"><button disabled={!editable} onClick={()=>setConfirm('scenario')}>使用示例 PRD</button><button className="primary" disabled={!editable || !plan.brief.idea.trim()} onClick={()=>setPanel('generate')}>生成任务画布 →</button></div></>}
      {panel==='experience' && <><ProductDesignPanel plan={viewPlan} revision={revision} storageKey={key} workspaceId={workspaceId} projectId={projectId} disabled={!editable} onChange={change}/><button onClick={()=>setPanel(null)}>返回画布</button></>}
      {panel==='generate' && <AgentRoadmapPlanner plan={plan} revision={revision} storageKey={key} workspaceId={workspaceId} projectId={projectId} disabled={!editable} onApply={next=>{change(next);setSelected(null);setPanel(null);}} />}
      {panel==='preview' && release && <ProjectDeliveryEvidence scope={{workspaceId,projectId,releaseId:release.id}} disabled={!canEdit || !!data?.archived} />}
    </DialogContent></Dialog>
    <Dialog open={!!selectedNode} onOpenChange={v=>{if(!v)setSelected(null);}}><DialogContent className="canvas-dialog canvas-task-drawer"><DialogTitle>{selectedNode?.title || '新功能'}</DialogTitle><DialogDescription>{run ? '本次运行采用的功能设计。' : '描述用户能做什么，以及你期待的使用效果。'}</DialogDescription>
      {selectedNode && <CanvasFeatureEditor key={selectedNode.id} node={selectedNode} plan={viewPlan} editable={editable} onChange={nodeChange} />}
      {selectedNode && <CanvasNodeContext plan={viewPlan} node={selectedNode} run={run} />}
      {runNode && tasks.some(t=>t.nodeId===selected && t.drifted) && <p role="alert" className="roadmap-warning">关联任务的需求已变更，这里显示的是本次运行版本。请先核对，不会按旧需求继续。</p>}
      <div className="canvas-feature-footer">
        {!run && <button className="canvas-feature-remove" disabled={!editable} onClick={()=>setConfirm('delete')}>移除功能</button>}
        {runNode?.taskId && <Link to={`/pm/${workspaceId}/projects/${projectId}/entities/${runNode.taskId}`}>查看关联任务</Link>}
        <button className="primary" onClick={()=>setSelected(null)}>{editable?'返回画布':'关闭'}</button>
      </div>
    </DialogContent></Dialog>
    <Dialog open={!!confirm} onOpenChange={v=>{if(!v)setConfirm('');}}><DialogContent><DialogTitle>确认更改</DialogTitle><DialogDescription>{confirm==='reload'?'载入会丢弃本机未保存修改。请先核对服务端结果。':confirm==='delete'?'移除草稿节点及其依赖线，不删除真实任务。':'用示例需求替换当前草稿？现有未保存修改将被替换。'}</DialogDescription><button onClick={()=>{if(confirm==='reload')void load(true);else if(confirm==='scenario'){change(feedbackScenario(()=>crypto.randomUUID()));setPanel(null);}else if(confirm==='delete'){change({...plan,nodes:plan.nodes.filter(n=>n.id!==selected).map(n=>({...n,dependsOn:n.dependsOn.filter(id=>id!==selected)}))});setSelected(null);}setConfirm('');}}>确认更改</button></DialogContent></Dialog>
    {blocker.state==='blocked' && <section role="alertdialog"><p>当前有未保存草稿，离开前请确认。</p><button onClick={()=>blocker.reset()}>继续编辑</button><button onClick={()=>blocker.proceed()}>保留本机草稿并离开</button></section>}
    <footer className="roadmap-footnote">会话与持久化仍沿用 Agent Chat，统一设计尚未收口。</footer>
  </main>;
}
