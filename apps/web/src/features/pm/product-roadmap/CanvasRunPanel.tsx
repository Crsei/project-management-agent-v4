import { useEffect, useRef, useState } from 'react';
import type { ProviderInstance, ProvidersResponse } from '@agent-workspace/contracts/provider';
import { workspaceClient } from '@agent/src/network';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { canvasStartSchema, type CanvasRun, type CanvasStart } from '../../../../../../packages/contracts/src/product-canvas';
export function CanvasRunPanel({ workspaceId, projectId, storageKey, disabled, issues, prepare, onRun }: {
  workspaceId: string; projectId: string; storageKey: string; disabled: boolean; issues: string[];
  prepare: () => Promise<{ releaseId: string; revision: string }>;
  onRun: (run: CanvasRun | null) => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [run, setRun] = useState<CanvasRun | null>(null), [setup, setSetup] = useState<{ repository: string; baseBranch: string } | null>(null);
  const [ready, setReady] = useState(false), [providers, setProviders] = useState<ProviderInstance[]>([]), [provider, setProvider] = useState(''), [model, setModel] = useState('');
  const [consent, setConsent] = useState({ execute: false, worktreeWrite: false, commit: false, push: false, draftPr: false, taskStatus: false, createTasks: false });
  const [unknown, setUnknown] = useState(false); const alive = useRef(true), flight = useRef(false);
  const key = storageKey + ':canvas-start';
  const url = '/api/product-canvases?' + new URLSearchParams({ workspaceId, projectId });
  const selected = providers.find(p => p.instanceId === provider);
  function adopt(value: CanvasRun | null) { setRun(value); onRun(value); }
  function pendingRequest() { const raw = localStorage.getItem(key); if (!raw) return null; try { return { id: String(JSON.parse(raw).id), input: canvasStartSchema.parse(JSON.parse(raw)) }; } catch { return { id: raw, input: null }; } }
  async function load() {
    try {
      const c = await workspaceClient.json<{ runs: CanvasRun[]; setup: typeof setup; ready: boolean }>(url);
      if (!alive.current) return;
      setSetup(c.setup); setReady(c.ready);
      const pendingId = pendingRequest()?.id, found = pendingId ? c.runs.find(r => r.id === pendingId) : c.runs.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).at(-1);
      if (found) { adopt(found); localStorage.removeItem(key); setUnknown(false); }
      else if (pendingId) setUnknown(true);
      setError(''); return found ?? null;
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '画布执行器不可用'); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [url]);
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => { try { const r = await workspaceClient.json<CanvasRun>(`/api/product-canvases/runs/${run.id}`); if (!stopped) adopt(r); } catch { if (!stopped) setError('运行进度读取失败；后台可能仍在运行，请核对，勿重复启动。'); } finally { if (!stopped) timer = setTimeout(() => void tick(), 3500); } };
    void tick(); return () => { stopped = true; clearTimeout(timer); };
  }, [run?.id, run?.status]);
  async function configure() {
    setOpen(true); setConsent({execute:false,worktreeWrite:false,commit:false,push:false,draftPr:false,taskStatus:false,createTasks:false}); setError(''); await load();
    try { const p = await workspaceClient.json<ProvidersResponse>('/api/providers'); if (alive.current) setProviders(p.providers); } catch { if (alive.current) setError('Provider 不可用，请核对配置。'); }
  }
  async function start() {
    if (issues.length || flight.current || !setup || !ready || unknown || run || disabled || !Object.values(consent).every(Boolean) || !selected?.nativeSessionReady || !model) return;
    flight.current = true; setBusy(true); setError('');
    try {
      const published = await prepare();
      const input: CanvasStart = { id: crypto.randomUUID(), workspaceId, projectId, ...published, ...setup, providerInstanceId: provider, model, consent: { execute: true, worktreeWrite: true, commit: true, push: true, draftPr: true, taskStatus: true, createTasks: true } };
      localStorage.setItem(key, JSON.stringify(input)); setUnknown(true);
      const result = await workspaceClient.json<CanvasRun>('/api/product-canvases/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(60000) });
      if (alive.current) { adopt(result); localStorage.removeItem(key); setUnknown(false); setOpen(false); }
    } catch (e) { if (alive.current) setError(`${e instanceof Error ? e.message : '启动失败'}。请核对已保存的画布版本与原运行，不自动重试。`); }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  }
  async function reconcileStart() {
    if (flight.current) return;
    const original = pendingRequest()?.input;
    if (!original || original.workspaceId !== workspaceId || original.projectId !== projectId) { setError('原启动参数不可恢复；请核对服务端记录，不创建新的启动。'); return; }
    flight.current = true; setBusy(true);
    try {
      const found = await load(); if (found === undefined) throw new Error('权威记录读取失败，不能继续原启动。'); if (found) return;
      // Explicit user action only. Replay the exact durable identity, never a fresh run.
      const result = await workspaceClient.json<CanvasRun>('/api/product-canvases/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(original), signal: AbortSignal.timeout(60000) });
      if (alive.current) { adopt(result); localStorage.removeItem(key); setUnknown(false); setOpen(false); }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '原启动仍待核对'); }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  }
  async function control(action: 'pause' | 'resume') {
    if (!run || busy) return; setBusy(true); setError('');
    try { const r = await workspaceClient.json<CanvasRun>(`/api/product-canvases/runs/${run.id}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, version: run.version, confirm: true }) }); if (alive.current) adopt(r); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '控制结果待核对'); }
    finally { if (alive.current) setBusy(false); }
  }
  return <><div className="canvas-run-controls">
    {!run ? <button className="primary" disabled={disabled || busy || unknown} onClick={() => void configure()}>运行画布</button> : run.status === 'running' ? <button disabled={busy} onClick={() => void control('pause')}>暂停画布</button> : run.status === 'paused' ? <button className="primary" disabled={busy || disabled} onClick={() => void control('resume')}>继续画布</button> : <span>交付已验证 · 待产品验收</span>}
    {unknown && <button disabled={busy || disabled} onClick={() => void reconcileStart()}>核对并继续原启动</button>}
    {(unknown || error) && <button disabled={busy} onClick={() => void load()}>核对运行</button>}
    </div>{error && <p role="alert" className="roadmap-error">{error}</p>}{unknown && <p role="alert">原启动结果未确认，不重复启动；请核对运行。</p>}
    <Dialog open={open} onOpenChange={v => { if (!busy) setOpen(v); }}><DialogContent className="canvas-dialog"><DialogTitle>运行整个产品画布</DialogTitle><DialogDescription>确认后保存并冻结当前画布，自动建立节点任务，按依赖顺序开发、测试和交付。每个节点继承前一已验证分支，默认串行，不做自动合并或公网部署。</DialogDescription>
      {issues.length > 0 && <section role="alert"><strong>运行前请先完善画布</strong><ul>{issues.map(issue=><li key={issue}>{issue}</li>)}</ul></section>}
      <p>仓库：{setup?.repository ?? '尚未配置或不可访问'} · 执行器：{ready ? '已启动' : '未就绪'}</p>
      <label>首个节点基线<input value={setup?.baseBranch ?? ''} onChange={e => setSetup(s => s && { ...s, baseBranch: e.target.value })} disabled={busy} /></label>
      <label>Provider<select value={provider} disabled={busy} onChange={e => { setProvider(e.target.value); setModel(''); }}><option value="">选择已有 Provider</option>{providers.map(p => <option key={p.instanceId} value={p.instanceId} disabled={!p.enabled || !p.configured || !p.nativeSessionReady || p.driver !== 'codex'}>{p.label}</option>)}</select></label>
      <label>模型<select value={model} disabled={busy} onChange={e => setModel(e.target.value)}><option value="">选择模型</option>{selected?.models.map(m => <option key={m.id} value={m.id} disabled={!!m.disabledReason}>{m.label}</option>)}</select></label>
      <p>仅授权本次冻结画布及绑定仓库。测试命令为 npm test，必需 CI 为 test；不适用时不要启动。节点进入开发中、CI通过后待审核，不自动完成业务任务。</p>
      {([['createTasks','确认需求与验收，保存发布此画布并建立节点任务'],['execute','允许现有 Agent 执行本画布的任务'],['worktreeWrite','允许仅在各任务绑定 worktree 中写代码与测试'],['commit','允许提交已验证代码'],['push','允许推送到上述仓库'],['draftPr','允许创建 Draft PR'],['taskStatus','允许进入开发中及 CI 通过后进入待审核']] as const).map(([k,label]) => <label className="roadmap-check" key={k}><input type="checkbox" checked={consent[k]} disabled={busy} onChange={e => setConsent(v => ({ ...v, [k]: e.target.checked }))} />{label}</label>)}
      {error && <p role="alert">{error}</p>}<button className="primary" disabled={!!issues.length || disabled || busy || unknown || !!run || !ready || !setup?.baseBranch || !selected?.nativeSessionReady || !model || !Object.values(consent).every(Boolean)} onClick={() => void start()}>{busy ? '正在核对并启动…' : '确认并运行整个画布'}</button>
    </DialogContent></Dialog></>;
}
