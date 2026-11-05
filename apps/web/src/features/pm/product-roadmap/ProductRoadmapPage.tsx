import { ProjectDeliveryEvidence } from './ProjectDeliveryEvidence';
import { useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useParams } from 'react-router';
import { usePmService } from '../service/pm-service';
import { usePmAgentPanel } from '../agent/agent-panel-context';
import { ServiceGuard } from '../service/pm-ui';
import { emptyRoadmap, productBriefMarkdown, roadmapPlanSchema, roadmapProblems, type ProductBrief, type RoadmapAction, type RoadmapNode, type RoadmapPlan, type RoadmapRead } from '../../../../../../packages/contracts/src/product-roadmap';
import { feedbackScenario, layoutRoadmap, suggestRoadmap } from './model';
import { RoadmapCanvas } from './RoadmapCanvas';
import './product-roadmap.css';
import { RadixSelect } from "@/components/ui/radix-select"

const questions: { key: keyof ProductBrief; title: string; hint: string }[] = [
  { key: 'idea', title: '你想做什么产品？', hint: '用一句话说明，不必先写完整 PRD。' },
  { key: 'audience', title: '首先服务谁？', hint: '选择一个首要用户，不要写“所有人”。' },
  { key: 'problem', title: '他现在遇到什么问题？', hint: '描述当前做法及其困难，而不只是功能名称。' },
  { key: 'journey', title: '他会按什么流程使用？', hint: '每行一个可观察的用户动作，建议4～6步。生成器会按这些步骤给出任务草稿。' },
  { key: 'success', title: '怎样证明第一版有用？', hint: '写出可以现场演示和核对的结果，不凭空设置收益数据。' },
  { key: 'nonGoals', title: '这次明确不做什么？', hint: '例如支付、多租户、真实客户数据、生产部署。' },
  { key: 'sharedContract', title: '多个任务要共同遵守什么？', hint: '同一仓库、数据ID、接口、界面规范与集成基线。可请 Agent 协助补充。' },
  { key: 'assumptions', title: '哪些还只是你的假设？', hint: '保留待验证的问题，不把 AI 建议当成用户事实。' },
];
async function request(url: string, action?: RoadmapAction, signal?: AbortSignal): Promise<RoadmapRead> {
  const response = await fetch(url, { method: action ? 'POST' : 'GET', credentials: 'same-origin', headers: action ? { 'Content-Type': 'application/json' } : {}, ...(action ? { body: JSON.stringify(action) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : value.error?.message || `读取失败 (${response.status})`);
  return value as RoadmapRead;
}
export function ProductRoadmapPage() {
  const { projectId } = useParams(), service = usePmService();
  return <ServiceGuard>{service.actor && service.workspace && projectId && <RoadmapWorkbench key={`${service.actor.id}:${service.actorEpoch}:${service.workspace.id}:${service.workspace.version}:${projectId}`} workspaceId={service.workspace.id} projectId={projectId} actorId={service.actor.id} canEdit={service.workspace.capabilities.includes('planning.edit') && (service.workspace.projectIds === null || service.workspace.projectIds.includes(projectId))} />}</ServiceGuard>;
}
function RoadmapWorkbench({ workspaceId, projectId, actorId, canEdit }: { workspaceId: string; projectId: string; actorId: string; canEdit: boolean }) {
  const url = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/product-roadmap`, base = `/pm/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`;
  const key = `pm-product-roadmap:${window.location.origin}:${actorId}:${workspaceId}:${projectId}`;
  const [data, setData] = useState<RoadmapRead | null>(null), [plan, setPlan] = useState<RoadmapPlan>(emptyRoadmap), [revision, setRevision] = useState('');
  const [tab, setTab] = useState<'brief' | 'roadmap' | 'delivery'>('brief'), [step, setStep] = useState(0), [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState<RoadmapAction | null>(null), [confirm, setConfirm] = useState(''), [releaseId, setReleaseId] = useState(''), [reviewed, setReviewed] = useState(false), [importText, setImportText] = useState('');
  const [importPlan, setImportPlan] = useState<RoadmapPlan | null>(null);
  const [removeCandidate, setRemoveCandidate] = useState<string | null>(null);
  const [nodeFocus, setNodeFocus] = useState<{ id: string; section: 'detail' | 'outcome' | 'dependencies' | 'published' | 'confirmation' } | null>(null);
  const nodeDetails = useRef<HTMLElement>(null), outcomeInput = useRef<HTMLTextAreaElement>(null), dependencies = useRef<HTMLFieldSetElement>(null), publishedDetails = useRef<HTMLElement>(null), confirmation = useRef<HTMLElement>(null);
  const initialized = useRef(false), alive = useRef(true), flight = useRef(false), panel = usePmAgentPanel();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  const conflicts = !!data && revision !== data.revision;
  const editable = canEdit && !!data && !data.archived && !busy && !pending && !conflicts;
  const release = data?.store.releases.find(r => r.id === releaseId) ?? data?.store.releases.at(-1);
  const releaseTasks = release ? data?.tasks[release.id] ?? [] : [];
  const problems = roadmapProblems(plan), selectedNode = plan.nodes.find(n => n.id === selected);
  useEffect(() => {
    if (!nodeFocus || selected !== nodeFocus.id) return;
    const target = nodeFocus.section === 'published' ? publishedDetails.current : nodeFocus.section === 'confirmation' ? confirmation.current : nodeFocus.section === 'outcome' ? outcomeInput.current : nodeFocus.section === 'dependencies' ? dependencies.current : nodeDetails.current;
    if (!target) return;
    target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); setNodeFocus(null);
  }, [nodeFocus, selected, tab]);
  const restore = (value: RoadmapRead) => {
    setData(value); setRevision(value.revision); setPlan(value.store.draft); setDirty(false); setPending(null); setReviewed(false);
    localStorage.removeItem(key); setSelected(value.store.draft.nodes[0]?.id ?? null);
  };
  async function load(discard = false) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true); setError('');
    try {
      const value = await request(url); if (!alive.current) return;
      setData(value);
      if (discard) { restore(value); setNotice('已读取服务端内容。不会重放任何写入。'); }
      else if (!initialized.current) {
        initialized.current = true;
        const raw = localStorage.getItem(key);
        if (raw) {
          const saved = JSON.parse(raw), parsed = roadmapPlanSchema.safeParse(saved.plan);
          if (!parsed.success || typeof saved.revision !== 'string') throw new Error('本机草稿无法解析；请先保留原数据，再明确载入服务端版本。');
          setPlan(parsed.data); setRevision(saved.revision); setDirty(true); setPending(saved.pending ?? null); setSelected(parsed.data.nodes[0]?.id ?? null);
          setNotice(saved.pending ? '上次写入结果未确认。先比较服务端版本与任务列表，核对后再载入服务端内容；不会自动重试。' : '已恢复本机草稿。');
        } else { setPlan(value.store.draft); setRevision(value.revision); setSelected(value.store.draft.nodes[0]?.id ?? null); }
      }
    } catch (e) { if (alive.current) { setError(e instanceof Error ? e.message : '读取失败'); setData(null); } }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!dirty && !pending) return; const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty, pending]);
  function change(next: RoadmapPlan) {
    if (!editable) return;
    setPlan(next); setDirty(true); setReviewed(false);
    try { localStorage.setItem(key, JSON.stringify({ plan: next, revision, pending: null })); }
    catch { setError('本机草稿保存失败，请复制 PRD 保留内容；不要关闭页面。'); }
  }
  function nodeChange(id: string, changes: Partial<RoadmapNode>) { change({ ...plan, nodes: plan.nodes.map(n => n.id === id ? { ...n, ...changes } : n) }); }
  function revealNode(id: string, section: NonNullable<typeof nodeFocus>['section']) {
    setSelected(id); setNodeFocus({ id, section });
  }
  function addCandidate() {
    if (!editable || plan.nodes.length >= 24) return;
    const id = crypto.randomUUID();
    change({ ...plan, nodes: [...plan.nodes, { id, title: '', outcome: '', acceptance: '', nonGoals: '', stage: 'M1 · 最小闭环', dependsOn: [], x: 30, y: plan.nodes.length * 190 }] });
    revealNode(id, 'outcome');
  }
  function layoutCandidates() { change(layoutRoadmap(plan)); }
  function requestRemoveCandidate(id: string) {
    if (!editable || !plan.nodes.some(node => node.id === id)) return;
    setRemoveCandidate(id); setConfirm('delete'); revealNode(id, 'confirmation');
  }
  function taskUrl(id: string) { return `${base}/entities/${encodeURIComponent(id)}?returnTo=${encodeURIComponent(`${base}/roadmap`)}`; }
  async function act(action: RoadmapAction) {
    if (flight.current || !data || !canEdit || pending || data.archived || (action.action === 'materialize' && (dirty || conflicts))) return;
    flight.current = true; setBusy(true); setError(''); setNotice(''); setConfirm('');
    try {
      localStorage.setItem(key, JSON.stringify({ plan, revision, pending: action })); setPending(action);
      const value = await request(url, action); if (!alive.current) return;
      restore(value); setNotice(action.action === 'save' ? '草稿已保存到项目。' : action.action === 'publish' ? '已发布不可变计划版本。尚未创建任务或执行代码。' : '真实任务已创建，需求、验收与前置关系已写入；尚未启动开发。');
      if (action.action !== 'save') setTab('delivery');
    } catch (e) { if (alive.current) setError(`${e instanceof Error ? e.message : '请求失败'}。请刷新核对服务端计划与真实任务，不要重复提交。`); }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  }
  async function coach() {
    try { await navigator.clipboard.writeText(`请作为产品教练审阅这份草稿，区分事实与假设，指出缺口，优先给出3个问题；不要创建任务或执行代码。\n\n${productBriefMarkdown(plan.brief)}\n\nRoadmap草稿：\n${JSON.stringify(plan, null, 2)}`); panel.openPanel({ workspaceId, projectId, title: '产品规划 · 需求与 Roadmap 评审', hasDraft: dirty }); setNotice('评审材料已复制。请粘贴到现有 Agent Chat，选择 Provider 后发送；不会自动发送或修改计划。'); }
    catch { setError('无法复制，请从右侧 PRD 手动复制；未向 Agent 发送内容。'); }
  }
  return <main className="product-roadmap" aria-label="产品规划工作台">
    <header className="roadmap-header"><div><h1>产品规划</h1><p>明确需求、规划路线，并把计划连接到真实任务与验收。</p></div><button onClick={() => void coach()} disabled={!data || busy}>请 Agent 帮我审阅 ↗</button></header>
    <nav className="roadmap-tabs" aria-label="产品规划步骤">{([['brief', '01', '明确产品'], ['roadmap', '02', '规划路线'], ['delivery', '03', '交付与验收']] as const).map(([id, number, label]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}><span>{number}</span>{label}</button>)}</nav>
    <div className="roadmap-toolbar"><span>{busy ? '正在核对 / 保存…' : dirty ? '本机草稿 · 尚未保存到项目' : data ? '项目内容已读取' : '尚未读取项目'}{data?.archived ? ' · 项目已归档' : ''}</span><button disabled={busy} onClick={() => void load()}>刷新核对</button><button disabled={busy || !data} onClick={() => setConfirm('reload')}>载入服务端版本</button><button className="primary" disabled={!editable || !dirty} onClick={() => void act({ action: 'save', commandId: crypto.randomUUID(), revision, plan })}>保存草稿</button></div>
    {notice && <p role="status" className="roadmap-notice">{notice}</p>}{error && <p role="alert" className="roadmap-error">{error}</p>}
    {pending && !busy && <div className="roadmap-warning">原写入结果需要核对，编辑与再次提交已暂停。{data && <span>服务端：{data.store.releases.length} 个发布版本、{Object.values(data.tasks).flat().length} 个已关联任务。请先查看交付页，或复制当前草稿再载入服务端版本。</span>}</div>}
    {conflicts && <p role="alert" className="roadmap-warning">项目版本已变化。请保留当前 PRD 后载入服务端版本；不会覆盖他人修改。</p>}
    {confirm && <section className="roadmap-confirm" role="region" aria-label="确认规划操作" ref={confirmation} tabIndex={-1}><p>{confirm === 'publish' ? '发布将冻结这版 PRD 与 Roadmap，后续修改留在新草稿中。不会自动创建任务、运行 Agent、提交、推送或合并。' : confirm === 'reload' ? '确认已经核对服务端结果？载入会丢弃本机未保存草稿和待核对标记，不重放写入。' : confirm === 'delete' ? '移除此候选任务以及草稿中指向它的依赖线？不删除任何真实任务。' : '替换当前草稿中的需求或候选任务？已发布版本与真实任务不会被修改。'}</p><button className="primary" disabled={busy || confirm === 'delete' && !editable} onClick={() => {
      if (confirm === 'publish') void act({ action: 'publish', commandId: crypto.randomUUID(), revision, releaseId: crypto.randomUUID(), confirm: true });
      else if (confirm === 'reload') void load(true);
      else if (confirm === 'import' && importPlan) { change(importPlan); setSelected(importPlan.nodes[0]?.id ?? null); setImportText(''); setImportPlan(null); }
      else if (confirm === 'delete' && removeCandidate && editable) { change({ ...plan, nodes: plan.nodes.filter(n => n.id !== removeCandidate).map(n => ({ ...n, dependsOn: n.dependsOn.filter(id => id !== removeCandidate) })) }); setSelected(current => current === removeCandidate ? null : current); }
      else if (confirm === 'scenario') { const next = feedbackScenario(() => crypto.randomUUID()); change(next); setSelected(next.nodes[0]?.id ?? null); }
      else if (confirm === 'suggest') { const next = suggestRoadmap(plan.brief, () => crypto.randomUUID()); change(next); setSelected(next.nodes[0]?.id ?? null); setTab('roadmap'); }
      setConfirm(''); setRemoveCandidate(null);
    }}>确认{confirm === 'publish' ? '发布计划' : confirm === 'reload' ? '载入' : '替换 / 移除'}</button><button onClick={() => { setConfirm(''); setRemoveCandidate(null); }}>取消</button></section>}
    {tab === 'brief' && <div className="roadmap-brief-grid"><section className="roadmap-card"><div className="roadmap-card-heading"><h2>从一个问题开始</h2><span>{step + 1} / {questions.length}</span></div><div className="roadmap-question-index">{questions.map((q, i) => <button key={q.key} aria-label={q.title} aria-current={step === i ? 'step' : undefined} onClick={() => setStep(i)}>{plan.brief[q.key].trim() ? '✓' : i + 1}</button>)}</div><label className="roadmap-question"><strong>{questions[step]!.title}</strong><span>{questions[step]!.hint}</span><textarea maxLength={6000} rows={7} disabled={!editable} value={plan.brief[questions[step]!.key]} onChange={e => change({ ...plan, brief: { ...plan.brief, [questions[step]!.key]: e.target.value } })} /></label><div className="roadmap-actions"><button disabled={step === 0} onClick={() => setStep(step - 1)}>上一个问题</button><button className="primary" onClick={() => step < questions.length - 1 ? setStep(step + 1) : setTab('roadmap')}>{step < questions.length - 1 ? '下一个问题 →' : '去规划路线 →'}</button></div><hr /><button disabled={!editable} onClick={() => setConfirm('scenario')}>载入「客户反馈与需求决策」场景</button><p className="roadmap-muted">预置的是可修改需求，不是预写成品。场景假设仍需你确认。</p></section><section className="roadmap-card"><h2>你的轻量 PRD</h2><p className="roadmap-muted">内容随回答生成 · 空缺不会由系统冒充事实</p><div className="roadmap-prd">{questions.map(q => <section key={q.key}><h3>{q.title}</h3><p>{plan.brief[q.key] || '尚未提供'}</p></section>)}</div></section></div>}
    {tab === 'roadmap' && <><div className="roadmap-actions"><button disabled={!editable || !plan.brief.journey.trim()} onClick={() => setConfirm('suggest')}>按核心流程生成候选</button><button disabled={!editable || plan.nodes.length >= 24} onClick={addCandidate}>添加任务</button><button disabled={!editable} onClick={layoutCandidates}>自动布局</button><span className="roadmap-muted">规则辅助草稿，非模型执行结果。箭头：前置成果 → 后续任务。</span></div><RoadmapCanvas plan={plan} selected={selected} onSelect={setSelected} onInspect={id => revealNode(id, 'detail')} {...(editable ? { onMove: (id: string, x: number, y: number) => nodeChange(id, { x, y }), onEdit: (id: string, section: 'outcome' | 'dependencies') => revealNode(id, section), onRemove: requestRemoveCandidate, onAdd: addCandidate, onLayout: layoutCandidates } : {})} />
      <div className="roadmap-editor-grid"><section className="roadmap-card" ref={nodeDetails} tabIndex={-1} aria-label={editable ? '编辑任务成果' : '任务成果详情'}><h2>{selectedNode ? editable ? '编辑任务成果' : '任务成果详情' : '选择一个任务节点'}</h2>{selectedNode && <><div className="roadmap-fields">{([['title', '任务名称'], ['stage', '阶段 / 里程碑分组'], ['outcome', '交付什么可用成果'], ['acceptance', '如何操作与验收'], ['nonGoals', '本任务不做什么']] as const).map(([field, label]) => <label key={field}>{label}{field === 'title' || field === 'stage' ? <input maxLength={field === 'title' ? 160 : 80} disabled={!editable} value={selectedNode[field]} onChange={e => nodeChange(selectedNode.id, { [field]: e.target.value })} /> : <textarea ref={field === 'outcome' ? outcomeInput : undefined} maxLength={6000} rows={3} disabled={!editable} value={selectedNode[field]} onChange={e => nodeChange(selectedNode.id, { [field]: e.target.value })} />}</label>)}</div><fieldset disabled={!editable} ref={dependencies} tabIndex={-1}><legend>依赖哪些前置成果？</legend>{plan.nodes.filter(n => n.id !== selectedNode.id).map(n => <label className="roadmap-check" key={n.id}><input type="checkbox" checked={selectedNode.dependsOn.includes(n.id)} onChange={e => nodeChange(selectedNode.id, { dependsOn: e.target.checked ? [...selectedNode.dependsOn, n.id] : selectedNode.dependsOn.filter(id => id !== n.id) })} />{n.title || '未命名'}</label>)}</fieldset><div className="roadmap-actions">{(['x', 'y'] as const).map(axis => <label key={axis}>{axis.toUpperCase()}<input className="roadmap-coordinate" type="number" min="0" max="6000" disabled={!editable} value={selectedNode[axis]} onChange={e => nodeChange(selectedNode.id, { [axis]: Math.min(6000, Math.max(0, Math.round(Number(e.target.value)))) })} /></label>)}<button disabled={!editable} onClick={() => requestRemoveCandidate(selectedNode.id)}>移除候选</button></div></>}</section><section className="roadmap-card"><h2>发布前检查</h2>{problems.length ? <ul className="roadmap-warning">{problems.map(p => <li key={p}>{p}</li>)}</ul> : <p>需求字段与依赖图检查通过。仍需人工确认业务范围及验收标准。</p>}<p>阶段只是分组，不会创建或完成业务里程碑。发布后逐项创建真实任务；新版本不会改写旧任务，也不自动去重或复用已有任务。</p><label className="roadmap-check"><input type="checkbox" checked={reviewed} disabled={!editable || dirty} onChange={e => setReviewed(e.target.checked)} />我已核对范围、假设、依赖及验收标准</label><button className="primary" disabled={!editable || dirty || !reviewed || !!problems.length} onClick={() => setConfirm('publish')}>发布计划版本</button>{dirty && <p className="roadmap-muted">先保存草稿，再确认发布。</p>}<details><summary>导入 Agent 建议（只改草稿）</summary><p>使用当前计划相同的 JSON 结构；不会直接创建任务。</p><textarea aria-label="Agent 建议 JSON" rows={4} value={importText} onChange={e => setImportText(e.target.value)} /><button disabled={!editable} onClick={() => { try { const next = roadmapPlanSchema.parse(JSON.parse(importText)); setImportPlan(next); setConfirm('import'); } catch { setError('建议格式不正确；未修改草稿。'); } }}>校验并导入建议</button></details></section></div></>}
    {tab === 'delivery' && <><section className="roadmap-card"><div className="roadmap-card-heading"><div><h2>一个计划，多个真实任务</h2><p className="roadmap-muted">先创建前置任务，再创建依赖任务；任务内部复用原有 Agent 工作流与独立授权。</p></div><RadixSelect aria-label="计划发布版本" value={release?.id ?? ''} onChange={e => setReleaseId(e.target.value)}><option value="">选择版本</option>{data?.store.releases.map((r, i) => <option key={r.id} value={r.id}>版本 {i + 1} · {new Date(r.publishedAt).toLocaleString()}</option>)}</RadixSelect></div>{release ? <><RoadmapCanvas key={release.id} plan={release.plan} selected={selected} onSelect={setSelected} onInspect={id => revealNode(id, 'published')} tasks={releaseTasks} taskHref={task => taskUrl(task.taskId)} />{release.plan.nodes.filter(n => n.id === selected).map(n => <section className="roadmap-node-detail" aria-label="发布节点详情" key={n.id} ref={publishedDetails} tabIndex={-1}><h3>{n.title}</h3><p>{n.outcome}</p><strong>验收标准</strong><p>{n.acceptance}</p></section>)}{dirty && <p className="roadmap-warning">请先保存当前草稿，再创建已发布计划中的任务；不会丢弃未保存内容。</p>}<div className="roadmap-deliveries">{release.plan.nodes.map(n => { const matches = releaseTasks.filter(t => t.nodeId === n.id), task = matches.length === 1 ? matches[0] : undefined; const prerequisites = n.dependsOn.every(id => releaseTasks.filter(t => t.nodeId === id && !t.archived && !t.drifted).length === 1); return <article key={n.id}><div><strong>{n.title}</strong><p>{n.stage} · {task ? `${task.taskId} / ${task.status}` : '尚未创建真实任务'}{task?.drifted ? ' · 需求与发布快照不一致，请先核对' : ''}{task?.archived ? ' · 已归档' : ''}{matches.length > 1 ? ' · 重复关联，需人工处理' : ''}</p></div>{task ? <Link to={taskUrl(task.taskId)}>查看任务与交付 →</Link> : <button disabled={!data || !canEdit || busy || dirty || conflicts || !!pending || data.archived || !prerequisites || !!matches.length} onClick={() => void act({ action: 'materialize', releaseId: release.id, nodeId: n.id, confirm: true })}>{prerequisites ? '创建真实任务' : '先创建并核对前置任务'}</button>}</article>; })}</div></> : <p>还没有发布版本。先完成需求与路线图检查，再发布计划。</p>}</section>{release && <ProjectDeliveryEvidence key={release.id + ':' + releaseTasks.length} scope={{ workspaceId, projectId, releaseId: release.id }} disabled={!canEdit || !!data?.archived} />}</>}
    {blocker.state === 'blocked' && <section className="roadmap-confirm" role="alertdialog" aria-label="保留规划草稿"><p>有未保存草稿。离开后仍会尝试从本机恢复，但尚未保存到项目。</p><button onClick={() => blocker.reset()}>继续编辑</button><button onClick={() => blocker.proceed()}>保留本机草稿并离开</button></section>}
    <footer className="roadmap-footnote">产品规划保存到项目 Markdown；未保存编辑暂存于当前账号的本机草稿。Agent 会话与持久化仍沿用现有方式，尚未统一设计。</footer>
  </main>;
}
