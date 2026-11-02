import { AppPreviewPanel } from './AppPreviewPanel';
import { useEffect, useRef, useState } from 'react';
import { WorkspaceClientError } from '@agent-workspace/client-runtime';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { ProviderInstance, ProvidersResponse } from '@agent-workspace/contracts/provider';
import { workspaceClient } from '@agent/src/network';
import type { DeliveryScope, TaskCodeDelivery } from '../../../../../../packages/contracts/src/task-code-delivery';
import { workflowProblems, workflowTaskRevision, type WorkflowDefinition, type WorkflowGraph, type WorkflowRun, type WorkflowStart } from '../../../../../../packages/contracts/src/task-workflow';
import { usePmAgentPanel } from '../agent/agent-panel-context';
import { WorkflowCanvas } from './WorkflowCanvas';
import './task-workflows.css';
import { DeliveryOverview } from './DeliveryOverview';
import { providerReadinessHint, deliveryTaskStatusLabel, workflowNodeMessage } from './workflow-presentation';

type Catalog = { definitions: WorkflowDefinition[]; runs: WorkflowRun[]; repository: string | null; defaultBase?: string | null; hasManualDelivery: boolean };
type Props = DeliveryScope & { revision: string; taskStatus: string; disabled: boolean };
const statusLabels: Record<WorkflowRun['status'], string> = { running: '正在执行', waiting: '等待结果', paused: '已暂停 / 待核对', completed: '成果待审查', failed: '需要人工处理' };
const read = <T,>(url: string, signal?: AbortSignal, timeoutMs = 20000) => workspaceClient.json<T>(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
export function TaskWorkflowPanel({ workspaceId, projectId, taskId, revision, taskStatus, disabled }: Props) {
  const [expanded, setExpanded] = useState(true), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null), [error, setError] = useState('');
  const [providers, setProviders] = useState<ProviderInstance[]>([]), [providerError, setProviderError] = useState(''), [providersLoading, setProvidersLoading] = useState(false);
  const [selected, setSelected] = useState('builtin-deliver'), [provider, setProvider] = useState(''), [model, setModel] = useState(''), [base, setBase] = useState('');
  const [run, setRun] = useState<WorkflowRun | null>(null), [delivery, setDelivery] = useState<TaskCodeDelivery | null>(null);
  const [editor, setEditor] = useState<{ definition: WorkflowDefinition; graph: WorkflowGraph; dirty: boolean; unknown: boolean } | null>(null);
  const [showRun, setShowRun] = useState(false), [confirmStart, setConfirmStart] = useState(false);
  const [consent, setConsent] = useState({ execute: false, worktreeWrite: false, commit: false, push: false, draftPr: false, taskStatus: false });
  const [uncertain, setUncertain] = useState<WorkflowStart | null>(null);
  const startId = useRef(crypto.randomUUID()), alive = useRef(true);
  const catalogRequest = useRef<AbortController | null>(null), providerRequest = useRef<AbortController | null>(null);
  const panel = usePmAgentPanel();
  const scope = { workspaceId, projectId, taskId };
  const catalogUrl = `/api/task-workflows?${new URLSearchParams(scope)}`;
  const definition = catalog?.definitions.find(d => d.id === selected);
  const published = definition?.versions.at(-1);
  const graph = published?.graph;
  const providerValue = providers.find(p => p.instanceId === provider);
  useEffect(() => { alive.current = true; return () => { alive.current = false; catalogRequest.current?.abort(); providerRequest.current?.abort(); }; }, []);
  const load = async () => {
    catalogRequest.current?.abort(); const request = new AbortController(); catalogRequest.current = request;
    setLoading(true); setError('');
    try { const value = await read<Catalog>(catalogUrl, request.signal); if (alive.current && !request.signal.aborted) { setCatalog(value); setBase(previous => previous || value.defaultBase || ''); setRun(value.runs[0] ?? null); if (value.runs.length) setUncertain(null); } }
    catch (e) { if (alive.current && !request.signal.aborted) setError(e instanceof Error ? e.message : '读取失败'); }
    finally { if (alive.current && !request.signal.aborted) setLoading(false); }
  };
  const loadProviders = async () => {
    providerRequest.current?.abort(); const request = new AbortController(); providerRequest.current = request;
    setProvidersLoading(true); setProviderError('');
    try { const value = await read<ProvidersResponse>('/api/providers', request.signal, 45000); if (alive.current && !request.signal.aborted) setProviders(value.providers); }
    catch { if (alive.current && !request.signal.aborted) setProviderError('Provider 读取超时或失败；不影响编辑画布。请刷新 Provider。'); }
    finally { if (alive.current && !request.signal.aborted) setProvidersLoading(false); }
  };
  useEffect(() => { if (expanded) { void load(); void loadProviders(); } }, [expanded]);
  useEffect(() => {
    if (!run || !expanded) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      try {
        const value = await read<WorkflowRun>(`/api/task-workflows/runs/${run.id}`);
        if (stopped) return; setRun(value); setError('');
        const result = await read<{ delivery: TaskCodeDelivery }>(`/api/task-deliveries/${run.id}`).catch(() => null);
        if (!stopped && result) setDelivery(result.delivery);
      } catch { if (!stopped) setError('进度读取失败，显示上次记录；后台结果未知，请勿重复启动。'); }
      finally { if (!stopped) timer = setTimeout(() => void update(), 4000); }
    };
    void update(); return () => { stopped = true; clearTimeout(timer); };
  }, [run?.id, expanded]);
  useEffect(() => {
    if (!editor?.dirty) return;
    const prevent = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [editor?.dirty]);
  const edit = (copy: boolean) => {
    if (!definition) return;
    const duplicate = copy || definition.id.startsWith('builtin-');
    const value = duplicate ? { ...structuredClone(definition), id: crypto.randomUUID(), workspaceId, projectId, revision: 0, versions: [] } : structuredClone(definition);
    setEditor({ definition: value, graph: { ...value.draft, name: duplicate ? `${value.draft.name} · 副本` : value.draft.name }, dirty: duplicate, unknown: false });
  };
  const save = async (publish: boolean) => {
    if (!editor || busy) return;
    const snapshot = editor; setBusy(true); setError('');
    try {
      const value = await workspaceClient.json<WorkflowDefinition>('/api/task-workflows/definitions', { method: 'POST', body: JSON.stringify({ ...scope, id: snapshot.definition.id, expectedRevision: snapshot.definition.revision, graph: snapshot.graph, publish }) });
      if (!alive.current) return;
      setEditor({ definition: value, graph: value.draft, dirty: false, unknown: false }); setSelected(value.id); await load();
    } catch (e) { if (alive.current) { setError(e instanceof Error ? e.message : '保存结果未知，请重新读取。'); setEditor(v => v && { ...v, unknown: !(e instanceof WorkspaceClientError && e.kind === 'http' && e.status === 400) }); } }
    finally { if (alive.current) setBusy(false); }
  };
  const start = async (frozen?: WorkflowStart) => {
    if (busy || (!frozen && (!published || !definition || !catalog))) return;
    const input: WorkflowStart = frozen ?? { ...scope, id: startId.current, taskRevision: revision, definitionId: definition!.id, definitionVersion: published!.version, baseBranch: base.trim(), repository: catalog!.repository!, providerInstanceId: provider, model, consent: { ...consent, execute: true } };
    setBusy(true); setError(''); setUncertain(input);
    try {
      const value = await workspaceClient.json<WorkflowRun>('/api/task-workflows/runs', { method: 'POST', body: JSON.stringify(input) });
      if (alive.current) { setRun(value); setUncertain(null); setConfirmStart(false); }
    } catch (e) { if (alive.current) {
        const rejected = e instanceof WorkspaceClientError && e.kind === 'http' && [400, 401, 403, 412].includes(e.status);
        if (rejected) setUncertain(null);
        setError(`${e instanceof Error ? e.message : '启动结果未知'}${rejected ? '' : '；请先刷新核对。原启动参数已保留。'}`);
      } }
    finally { if (alive.current) setBusy(false); }
  };
  const control = async (action: 'pause' | 'resume' | 'approve' | 'confirm-transition') => {
    if (!run || busy) return;
    setBusy(true); setError('');
    try {
      const value = await workspaceClient.json<WorkflowRun>(`/api/task-workflows/runs/${run.id}/control`, { method: 'POST', body: JSON.stringify({ action, version: run.version, confirm: true }) });
      if (alive.current) setRun(value);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '操作未确认，请刷新。'); }
    finally { if (alive.current) setBusy(false); }
  };
  const refreshFeedback = async () => {
    if (!run || busy) return;
    setBusy(true); setError('');
    try {
      const value = await workspaceClient.json<TaskCodeDelivery>(`/api/task-deliveries/${run.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'refresh' }) });
      if (alive.current) setDelivery(value);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '核对失败，保留上次证据。'); }
    finally { if (alive.current) setBusy(false); }
  };
  const needWrite = graph?.nodes.some(n => n.kind === 'agent' && n.config.mode === 'develop');
  const need = (kind: string) => graph?.nodes.some(n => n.kind === kind);
  const needStatus = graph?.nodes.some(n => n.config.taskTransition);
  const consentReady = consent.execute && (!needWrite || consent.worktreeWrite) && (!need('commit') || consent.commit) && (!need('push') || consent.push) && (!need('pr') || consent.draftPr) && (!needStatus || consent.taskStatus);
  return <details id={`task-workflow-${taskId}`} className="task-workflow" open={expanded} onToggle={e => setExpanded(e.currentTarget.open)}><summary><span>交付工作台</span><small>任务工作流 · 可审查的代码成果</small></summary>{expanded && <div className="workflow-content">
    <DeliveryOverview catalogKnown={!!catalog} graph={graph} run={run} delivery={delivery} taskStatus={taskStatus} repository={catalog?.repository} />
    {delivery?.pr && <AppPreviewPanel key={delivery.id} delivery={delivery} disabled={disabled} />}
    <p className="delivery-boundary">独立目录执行 · 授权后发布 · 不自动合并、部署或完成任务</p>
    {error && <p role="alert">{error}</p>}{disabled && <p role="alert">请先保存任务，并确认项目编辑权限。</p>}
    <div className="workflow-toolbar"><button type="button" disabled={loading || busy} onClick={() => void load()}>{loading ? '正在读取工作流…' : '刷新工作流 / 核对启动'}</button></div>
    {!catalog && !loading && <p>尚未加载。项目需绑定可访问的 GitHub 仓库；失败时不会回退示例数据。</p>}
    {catalog && <>
      <label>交付方式 · 工作流模板<select disabled={busy || !!uncertain} value={selected} onChange={e => setSelected(e.target.value)}>{catalog.definitions.map(d => <option key={d.id} value={d.id}>{d.draft.name} · {d.versions.length ? `v${d.versions.at(-1)!.version}` : '未发布'}</option>)}</select></label>
      <div className="workflow-toolbar"><button type="button" onClick={() => edit(false)} disabled={!definition || disabled || busy}>打开节点画布</button><button type="button" onClick={() => edit(true)} disabled={!definition || disabled || busy}>复制为项目工作流</button></div>
      {!run && catalog.hasManualDelivery && <p>此任务已有手动代码交付，请继续使用下方原入口。新工作流请在新任务启动；仍可编辑项目模板。</p>}
      {!run && !catalog.hasManualDelivery && <>
        <small>仓库：{catalog.repository ?? '未就绪：请先绑定具有 GitHub origin 的项目 Git 仓库'}。模板发布不等于授权执行。</small>
        <label>远端基准分支<input placeholder="填写实际分支，例如 main" value={base} disabled={!!uncertain || busy} onChange={e => setBase(e.target.value)} /></label>
        <label>运行 Provider<select value={provider} disabled={!!uncertain || busy} onChange={e => { setProvider(e.target.value); setModel(''); }}><option value="">选择已有 Provider</option>{providers.map(p => <option key={p.instanceId} value={p.instanceId} disabled={!p.enabled || !p.nativeSessionReady || !p.configured || (!!needWrite && p.driver !== 'codex')}>{p.label}{!p.nativeSessionReady ? ' · 未就绪' : ''}</option>)}</select></label>
        <label>运行模型<select value={model} disabled={!providerValue || !!uncertain || busy} onChange={e => setModel(e.target.value)}><option value="">选择模型</option>{providerValue?.models.map(m => <option key={m.id} value={m.id} disabled={!!m.disabledReason}>{m.label}</option>)}</select></label>
        <small>{providersLoading ? '正在检查 Provider，画布可先编辑。' : providerError}</small><button type="button" onClick={() => void loadProviders()} disabled={providersLoading}>刷新 Provider</button>
        {!providersLoading && providers.filter(p => !p.nativeSessionReady).map(p => <small key={p.instanceId}>{p.label} 未就绪：{providerReadinessHint(p.message)}</small>)}
        <div className="delivery-preflight" aria-label="启动前检查"><span data-ready={!!published}>流程{published ? '已发布' : '待发布'}</span><span data-ready={!!catalog.repository}>仓库{catalog.repository ? '已绑定' : '未就绪'}</span><span data-ready={!!providerValue?.nativeSessionReady}>Agent{providerValue?.nativeSessionReady ? '已就绪' : '待选择或修复'}</span><span data-ready={!disabled}>{disabled ? '请先保存任务' : '任务已保存'}</span></div>
        {providerError && <a href="/agent/settings/providers">前往 Agent 设置排查</a>}
        <button type="button" className="workflow-primary" disabled={disabled || busy || !!uncertain || !published || !catalog.repository || !base.trim() || !providerValue?.nativeSessionReady || !model} onClick={() => { setConsent({ execute: false, worktreeWrite: false, commit: false, push: false, draftPr: false, taskStatus: false }); setConfirmStart(true); }}>启动交付</button>
        {uncertain && <button type="button" disabled={busy || loading} onClick={async () => { const found = await read<Catalog>(catalogUrl).catch(() => null); if (!found) { setError('核对失败，不重发。'); return; } if (found.runs.length) { setRun(found.runs[0]!); setUncertain(null); } else void start(uncertain); }}>核对后重发原启动请求（相同 ID / 参数）</button>}
      </>}
    </>}
    {run && <section className="workflow-run" aria-label="工作流执行进度"><header><strong>{run.graph.name}</strong><span className="workflow-status">任务：{deliveryTaskStatusLabel(taskStatus)}</span><span className={`workflow-status ${run.status}`}>{statusLabels[run.status]}</span></header><p>{run.message ?? `当前节点：${run.graph.nodes.find(n => n.id === run.current)?.label}`}</p>
      <details className="workflow-node-records"><summary>{run.graph.nodes.length} 个节点的执行记录</summary><ol>{run.graph.nodes.map(n => <li key={n.id} data-state={run.nodes[n.id]?.state ?? 'pending'}><span>{run.current === n.id && !['completed', 'failed'].includes(run.status) ? '●' : run.nodes[n.id]?.state === 'succeeded' ? '✓' : run.nodes[n.id]?.state === 'failed' ? '!' : '○'}</span>{n.label}<small>{workflowNodeMessage(run, n.id)}</small></li>)}</ol></details>
      <div className="workflow-toolbar"><button type="button" onClick={() => setShowRun(true)}>查看运行画布</button>{!['completed', 'failed', 'paused'].includes(run.status) && <button type="button" disabled={busy || disabled} onClick={() => void control('pause')}>暂停后续步骤</button>}{run.status === 'paused' && <button type="button" disabled={busy || disabled || (workflowTaskRevision(run) !== revision && run.transitions?.[run.current]?.state !== 'requested')} onClick={() => void control('resume')}>核对并恢复原运行</button>}{run.graph.nodes.find(n => n.id === run.current)?.kind === 'approval' && run.nodes[run.current]?.state === 'waiting' && <button type="button" disabled={busy || disabled} onClick={() => void control('approve')}>确认继续（不是业务审核）</button>}</div>
      {Object.entries(run.transitions ?? {}).map(([id, change]) => <p key={id}>任务状态联动 · {run.graph.nodes.find(n => n.id === id)?.label}：{change.message ?? change.state}</p>)}
      {run.transitions?.[run.current]?.state === 'awaiting' && run.transitions[run.current]?.mode === 'confirm' && <button type="button" className="workflow-primary" disabled={busy || disabled || workflowTaskRevision(run) !== revision} onClick={() => void control('confirm-transition')}>确认任务{run.transitions[run.current]?.phase === 'start' ? '进入进行中' : '进入待审核'}（非验收通过）</button>}
      {delivery?.generationId && <button type="button" onClick={() => { panel.openPanel({ workspaceId, projectId, taskId, title: delivery.title }); panel.setThreadId(delivery.threadId); }}>查看 Agent 开发过程</button>}
      {delivery?.pr && <a href={delivery.pr.url} target="_blank" rel="noreferrer">查看交付成果 · Draft PR #{delivery.pr.number}</a>}
      {delivery?.pr && <button type="button" disabled={busy || disabled} onClick={() => void refreshFeedback()}>核对 CI / 评审结果</button>}
      {delivery?.feedback && <p>GitHub：{delivery.feedback.checks.map(c => `${c.name}: ${c.conclusion ?? c.status}`).join('；') || '未发现 CI，不代表通过'} · {delivery.feedback.reviews.length ? `${delivery.feedback.reviews.length} 条评审` : '暂无人工评审'}<br />证据快照：{delivery.feedback.observedAt}（不是持续更新的审批结论）</p>}
      <details><summary>技术详情</summary><pre>{JSON.stringify({ workflowId: run.input.definitionId, version: run.input.definitionVersion, taskRevision: run.input.taskRevision, acceptedTaskRevision: workflowTaskRevision(run), stateTransitions: run.transitions, repository: run.input.repository, branch: delivery?.git?.branch, head: delivery?.head, runId: run.id, updatedAt: run.updatedAt }, null, 2)}</pre></details>
    </section>}
    <small>关闭页面不停止后台执行。服务重启或认证失效后需重新登录并恢复。会话与持久化仍暂沿用 Agent Chat 基础存储，统一设计尚未收口。</small>
    <Dialog open={!!editor} onOpenChange={open => { if (!open && !busy && (!editor?.dirty || window.confirm('放弃尚未保存的工作流草稿？'))) setEditor(null); }}><DialogContent className="workflow-dialog"><DialogTitle>工作流节点画布</DialogTitle><DialogDescription>拖动节点、连接端口，或使用右侧表单编辑。保存草稿不启动执行；发布版本不改变正在运行的任务。</DialogDescription>
      {editor && <><div className="workflow-toolbar"><label>工作流名称<input value={editor.graph.name} maxLength={100} disabled={busy || editor.unknown} onChange={e => setEditor({ ...editor, graph: { ...editor.graph, name: e.target.value }, dirty: true })} /></label><span>{editor.definition.revision ? `草稿 revision ${editor.definition.revision}` : '未保存副本'} · {editor.dirty ? '未保存' : '已保存'} · {editor.definition.versions.length ? `已发布 v${editor.definition.versions.at(-1)!.version}` : '未发布'}</span><button type="button" disabled={disabled || busy || editor.unknown} onClick={() => void save(false)}>保存草稿</button><button type="button" className="workflow-primary" disabled={disabled || busy || editor.unknown || workflowProblems(editor.graph).length > 0 || !editor.graph.name.trim()} onClick={() => void save(true)}>校验并发布版本</button></div>
        {error && <p role="alert">{error}</p>}{editor.unknown && <p role="alert">保存失败或结果未知。请关闭画布、刷新工作流后重新打开，避免覆盖并行修改。</p>}
        <WorkflowCanvas graph={editor.graph} onChange={busy || editor.unknown ? undefined : value => setEditor({ ...editor, graph: value, dirty: true })} />
      </>}
    </DialogContent></Dialog>
    <Dialog open={showRun} onOpenChange={setShowRun}><DialogContent className="workflow-dialog"><DialogTitle>工作流执行画布</DialogTitle><DialogDescription>固定的工作流版本；点击节点查看真实执行记录。未选中的分支不计为成功。</DialogDescription>{run && <WorkflowCanvas graph={run.graph} run={run} />}</DialogContent></Dialog>
    <Dialog open={confirmStart} onOpenChange={open => { if (!busy) setConfirmStart(open); }}><DialogContent className="workflow-start-dialog"><DialogTitle>确认本次工作流授权</DialogTitle><DialogDescription>授权仅覆盖下面固定任务与流程。不合并、不部署、不自动完成任务；越界权限请求仍拒绝。</DialogDescription><div className="workflow-content"><p>{taskId} · {graph?.name} v{published?.version}<br />仓库：{catalog?.repository}<br />基准：{base}<br />Provider：{providerValue?.label} / {model}</p><p>测试命令：{graph?.nodes.filter(n => n.kind === 'test').map(n => n.config.command).join('；') || '无'}</p>
      <p>必需 CI：{graph?.nodes.find(n => n.kind === 'ci')?.config.requiredChecks?.join('、') ?? (need('ci') ? '旧模板未配置，建议在画布中指定' : '本流程不发布 PR')}</p>
      {graph?.nodes.filter(n => n.config.taskTransition).map(n => <p key={n.id}>{n.label}：{n.config.taskTransition?.phase === 'start' ? '派发前：待办 → 进行中' : 'CI 通过后：进行中 → 待审核'} · {n.config.taskTransition?.mode === 'auto' ? '自动申请' : '人工确认后申请'}</p>)}
      {(['execute', ...(needWrite ? ['worktreeWrite'] : []), ...(need('commit') ? ['commit'] : []), ...(need('push') ? ['push'] : []), ...(need('pr') ? ['draftPr'] : []), ...(needStatus ? ['taskStatus'] : [])] as (keyof typeof consent)[]).map(key => <label className="workflow-consent" key={key}><input type="checkbox" checked={consent[key]} disabled={busy || !!uncertain} onChange={e => setConsent({ ...consent, [key]: e.target.checked })} />{{ execute: '允许执行当前图、创建独立目录并运行上述验证命令', worktreeWrite: '允许 Codex 仅在此任务 worktree 内开发与测试', commit: '允许系统自动提交当前任务的已验证代码', push: `允许自动推送到 ${catalog?.repository} 的独立任务分支`, draftPr: '允许在上述仓库自动创建 Draft PR', taskStatus: '允许按上述节点配置申请任务状态流转，不自动完成或取消任务' }[key]}</label>)}
      {error && <p role="alert">{error}</p>}<button type="button" className="workflow-primary" disabled={!consentReady || busy || !!uncertain || disabled} onClick={() => void start()}>{busy ? '正在提交原启动请求…' : '确认并开始'}</button>
    </div></DialogContent></Dialog>
  </div>}</details>;
}
