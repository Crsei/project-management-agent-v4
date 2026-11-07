import { useEffect, useRef, useState } from 'react';
import { designPrompt, readDesignCandidate, type DesignCandidate } from './design-candidate';
import { Link } from 'react-router';
import type { ProviderInstance, ProvidersResponse } from '@agent-workspace/contracts/provider';
import type { RemoteSettings } from '@agent-workspace/contracts/chat';
import { workspaceClient } from '@agent/src/network';
import type { RoadmapPlan } from '../../../../../../packages/contracts/src/product-roadmap';
import { applyCandidate, planningPrompt, planningRecordSchema, readCandidate, type PlanningCandidate, type PlanningHistory, type PlanningRecord } from './agent-planning';

async function read<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await workspaceClient.fetch(workspaceClient.url(path), { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`Agent 请求失败 (${response.status})，请检查登录、Provider 和项目文件区域。`, { cause: response.status });
  return response.json() as Promise<T>;
}
type Thread = { remoteId: string; revision: number; settings: RemoteSettings };
export function AgentRoadmapPlanner({ plan, revision, storageKey, workspaceId, projectId, disabled, onApply, onDesignCandidate }: {
  plan: RoadmapPlan; revision: string; storageKey: string; workspaceId: string; projectId: string; disabled: boolean; onApply: (next: RoadmapPlan) => void; onDesignCandidate?: (candidate: DesignCandidate) => void;
}) {
  const key = `${storageKey}:${onDesignCandidate ? "design-candidate" : "agent-candidate"}`;
  const [providers, setProviders] = useState<ProviderInstance[]>([]), [provider, setProvider] = useState(''), [model, setModel] = useState('');
  const [instruction, setInstruction] = useState(''), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [record, setRecord] = useState<PlanningRecord | null>(null), [candidate, setCandidate] = useState<PlanningCandidate | null>(null);
  const [busy, setBusy] = useState(false), [watch, setWatch] = useState(false), [reviewed, setReviewed] = useState(false), [storageBroken, setStorageBroken] = useState(false);
  const alive = useRef(true), flight = useRef(false);
  const selected = providers.find(p => p.instanceId === provider);
  const ready = selected?.enabled && selected.configured && selected.nativeSessionReady && selected.models.some(m => m.id === model && !m.disabledReason);
  const changed = !!record && (record.revision !== revision || JSON.stringify(record.snapshot) !== JSON.stringify(plan));
  useEffect(() => {
    alive.current = true;
    try { const raw = localStorage.getItem(key); if (raw) { setRecord(planningRecordSchema.parse(JSON.parse(raw))); setStatus('已恢复生成记录。请核对原结果，不会重新发送请求。'); } }
    catch { setStorageBroken(true); setError('生成记录无法读取；请保留本机数据并到 Agent Chat 核对，不会自动启动新生成。'); }
    return () => { alive.current = false; };
  }, [key]);
  async function loadProviders() {
    setError('');
    try { const value = await read<ProvidersResponse>('/api/providers'); if (alive.current) setProviders(value.providers); }
    catch (e) { if (alive.current) setError(String(e)); }
  }
  async function check() {
    if (!record || flight.current) return;
    try {
      // Recheck PM authorization before reading any recovered Chat output.
      const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/product-roadmap`, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('项目当前不可访问，请重新登录或核对权限。');
      const h = await read<PlanningHistory>(`/api/chat/threads/${record.threadId}/history`);
      if (!alive.current) return;
      if (onDesignCandidate) {
        const design = readDesignCandidate(h);
        if (design) { if (changed) throw new Error('生成期间画布已变化，请保留草稿，重新生成。'); onDesignCandidate(design); setWatch(false); setStatus('设计已生成，请在下方预览。尚未保存或采用。'); return; }
        setStatus('正在生成设计，请稍后核对原结果。'); return;
      }
      const result = readCandidate(h);
      setCandidate(result); setError('');
      if (result) { setWatch(false); setStatus('候选已生成，尚未修改草稿。请审阅后明确应用。'); }
      else if (!h.latestGeneration) { setWatch(false); setStatus('未发现已接受的生成。请到原会话核对，不会重放请求。'); }
      else setStatus('Agent 正在生成路线候选，可继续查看页面；离开不会取消后台生成。');
    } catch (e) { if (alive.current) { setCandidate(null); setWatch(false); setError(String(e)); } }
  }
  useEffect(() => {
    if (!watch || !record || busy) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => { await check(); if (!stopped) timer = setTimeout(() => void tick(), 3000); };
    void tick(); return () => { stopped = true; clearTimeout(timer); };
  }, [watch, record, busy]);
  async function start() {
    if (disabled || !ready || record || storageBroken || flight.current) return;
    flight.current = true; setBusy(true); setError(''); setReviewed(false);
    const next: PlanningRecord = { threadId: crypto.randomUUID(), messageId: crypto.randomUUID(), snapshot: structuredClone(plan), revision, provider, model };
    try {
      // Persist before any network write; an unknown response is recovered only by reads.
      localStorage.setItem(key, JSON.stringify(next)); setRecord(next);
      const created = await read<{ thread: Thread }>('/api/chat/threads', 'POST', { id: next.threadId, scope: { workspaceId, projectId } });
      if (!alive.current) return;
      const updated = await read<{ thread: Thread }>(`/api/chat/threads/${next.threadId}`, 'PUT', { revision: created.thread.revision, title: onDesignCandidate ? '产品设计 · 设计候选' : '产品规划 · 路线候选', settings: { ...created.thread.settings, providerInstanceId: provider, model, modelOptions: [], systemPrompt: onDesignCandidate ? '只读产品体验设计。仅输出指定 JSON 候选，不写文件、不执行命令、不调用业务写工具。' : '只读产品规划。仅输出候选，不写文件、不执行命令、不调用业务写工具。', interactionMode: 'plan' } });
      if (!alive.current) return;
      const response = await workspaceClient.fetch(workspaceClient.url('/api/chat'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: next.threadId, idempotencyKey: next.messageId, messages: [{ id: next.messageId, role: 'user', parts: [{ type: 'text', text: (onDesignCandidate ? designPrompt : planningPrompt)(next.snapshot, instruction) }] }], config: { threadSettingsRevision: updated.thread.revision }, trigger: 'submit-message' }), signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`启动失败 (${response.status})；请核对原会话，不会自动重试。`);
      // Chat worker owns persistence. Detach the SSE subscriber, not the generation.
      await response.body?.cancel();
      if (alive.current) { setWatch(true); setStatus('已提交，只生成候选，不创建任务或开发代码。'); }
    } catch (e) { if (alive.current) { setError(`${String(e)} 原结果可能未知，请核对原结果。`); setWatch(false); } }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  }
  async function stop() {
    if (!record || busy) return;
    setBusy(true); setError('');
    try { await read(`/api/chat/threads/${record.threadId}/cancel`, 'POST', { messageId: record.messageId }); if (alive.current) { setWatch(true); setStatus('已请求停止，仍需核对最终结果。'); } }
    catch (e) { if (alive.current) setError(String(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  function apply() {
    if (disabled || !record || !candidate || !reviewed) return;
    try { const next = applyCandidate(candidate, record, plan, revision, () => crypto.randomUUID()); onApply(next); setReviewed(false); setStatus('已应用到本机草稿。请在画布调整并保存，确认后才能发布；不会启动构建。'); }
    catch (e) { setError(String(e)); }
  }
  async function clear() {
    if (!record || busy || flight.current) return;
    setBusy(true);
    try {
      // Persist a cancellation tombstone for this message before allowing a new request.
      await read(`/api/chat/threads/${record.threadId}/cancel`, 'POST', { messageId: record.messageId });
      const h = await read<PlanningHistory>(`/api/chat/threads/${record.threadId}/history`).catch(e => { if (e instanceof Error && e.cause === 404) return null; throw e; });
      if (h?.activeGenerationId || (h?.latestGeneration && ['queued', 'running'].includes(h.latestGeneration.status))) throw new Error('原生成尚未确认结束，请先核对或停止；不能启动重复生成。');
      localStorage.removeItem(key); if (alive.current) { setRecord(null); setCandidate(null); setReviewed(false); setWatch(false); setStatus('已保留原 Chat 历史，可以显式发起下一次生成。'); }
    } catch (e) { if (alive.current) setError(String(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <section className="roadmap-card roadmap-agent" aria-label={onDesignCandidate ? "Agent 生成设计候选" : "Agent 生成路线候选"}>
    <h2>{onDesignCandidate ? "让 Agent 生成界面设计" : "让 Agent 规划产品路线"}</h2><p>{onDesignCandidate ? "描述想要的布局、氛围和交互。生成 HTML/CSS 设计草稿，可在原会话继续讨论后核对最新结果；不会直接开发产品或生成真实图片。" : "根据 PRD 和现有草稿生成可审阅候选。先跑通最小闭环，再逐步扩展同一个 App。"}</p>
    {!record && <><div className="roadmap-actions"><button disabled={busy} onClick={() => void loadProviders()}>读取已有 Provider</button>
      <label>Provider<select value={provider} disabled={busy} onChange={e => { setProvider(e.target.value); setModel(''); }}><option value="">请选择</option>{providers.map(p => <option key={p.instanceId} value={p.instanceId} disabled={!p.enabled || !p.configured || !p.nativeSessionReady}>{p.label}{!p.nativeSessionReady ? ' · 未就绪' : ''}</option>)}</select></label>
      <label>模型<select value={model} disabled={busy || !selected} onChange={e => setModel(e.target.value)}><option value="">请选择</option>{selected?.models.map(m => <option key={m.id} value={m.id} disabled={!!m.disabledReason}>{m.label}</option>)}</select></label></div>
      <label>补充要求（可选）<textarea rows={2} maxLength={4000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder={onDesignCandidate ? "例如：浅色、简洁；左侧导航，右侧列表与详情；统一空态和错误提示" : "例如：先做能演示的版本，暂时不做登录"} /></label>
      <p className="roadmap-muted">点击后会将当前 PRD、草稿和补充要求发送给所选 Provider，并保留 Agent Chat 历史。仅规划，不授予代码写入、任务创建或发布权限。</p>
      <button className="primary" disabled={disabled || busy || storageBroken || !ready || !plan.brief.idea.trim()} onClick={() => void start()}>{onDesignCandidate ? "生成设计草稿" : "生成路线候选"}</button></>}
    {record && <div className="roadmap-actions"><button disabled={busy} onClick={() => { setWatch(true); void check(); }}>核对原结果</button><button disabled={busy || !!candidate} onClick={() => void stop()}>停止生成</button><Link to={`/agent/workspace?${new URLSearchParams({ workspace: workspaceId, project: projectId, thread: record.threadId })}`}>查看原会话</Link><button disabled={busy} onClick={() => void clear()}>停止并结束本次生成</button></div>}
    {status && <p role="status">{status}</p>}{error && <p role="alert" className="roadmap-error">{error}</p>}
    {candidate && <div aria-label="候选审阅"><h3>为什么这样拆</h3><p className="roadmap-agent-prose">{candidate.summary}</p>
      {candidate.questions.length > 0 && <><h3>请先补充这些决定</h3><ul>{candidate.questions.map((q, i) => <li key={i}>{q}</li>)}</ul><p>请回到「明确产品」补充需求，然后重新生成。</p></>}
      <details><summary>对照当前草稿（不会自动覆盖）</summary>{plan.nodes.map(n => <article key={n.id}><strong>{n.stage} · {n.title}</strong><p>{n.outcome}</p><p className="roadmap-agent-prose">{n.acceptance}</p></article>)}</details><p>当前草稿 {plan.nodes.length} 项 → 候选 {candidate.nodes.length} 项。应用会替换草稿节点；PRD、已发布版本和真实任务不会改变。</p>
      {candidate.nodes.map(n => <details key={n.key}><summary>{n.stage} · {n.title}</summary><p>{n.outcome}</p><strong>验收标准</strong><p className="roadmap-agent-prose">{n.acceptance}</p><p>不做：{n.nonGoals || '未说明'}</p><p>前置：{n.dependsOn.map(k => candidate.nodes.find(p => p.key === k)?.title ?? k).join('、') || '无'}</p></details>)}
      {changed && <p role="alert">生成后需求或草稿已变化，不能覆盖；请重新生成。</p>}
      <label className="roadmap-check"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />我已核对候选与当前草稿，确认用候选替换草稿节点</label>
      <button className="primary" disabled={disabled || changed || !reviewed || !!candidate.questions.length} onClick={apply}>应用到画布草稿</button>
    </div>}
  </section>;
}
