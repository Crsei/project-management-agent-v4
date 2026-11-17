import { useEffect, useRef, useState } from 'react';
import type { ProviderInstance, ProvidersResponse } from '@agent-workspace/contracts/provider';
import { workspaceClient } from '@agent/src/network';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { canvasStartSchema, type CanvasRun, type CanvasStart } from '../../../../../../packages/contracts/src/product-canvas';
import { canvasConsent, canvasProgress, type BuildConsent } from './canvas-presentation';
import { CanvasOperationNotice } from './CanvasBuildStatus';
export function CanvasRunPanel({ workspaceId, projectId, storageKey, disabled, issues, prepare, onRun }: {
  workspaceId: string; projectId: string; storageKey: string; disabled: boolean; issues: string[];
  prepare: () => Promise<{ releaseId: string; revision: string }>;
  onRun: (run: CanvasRun | null) => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [run, setRun] = useState<CanvasRun | null>(null), [setup, setSetup] = useState<{ repository: string; baseBranch: string } | null>(null);
  const [ready, setReady] = useState(false), [providers, setProviders] = useState<ProviderInstance[]>([]), [provider, setProvider] = useState(''), [model, setModel] = useState('');
  const [consent, setConsent] = useState<BuildConsent>({ build: false, commit: false, upload: false });
  const [verification, setVerification] = useState<'local' | 'github'>('local');
  const [repairOpen, setRepairOpen] = useState(false), [repairConfirmed, setRepairConfirmed] = useState(false);
  const [localSwitch, setLocalSwitch] = useState(false), [localConfirmed, setLocalConfirmed] = useState(false);
  const [unknown, setUnknown] = useState(false); const alive = useRef(true), flight = useRef(false);
  const [recovery, setRecovery] = useState(false), [maintenanceConfirmed, setMaintenanceConfirmed] = useState(false);
  const key = storageKey + ':canvas-start';
  const url = '/api/product-canvases?' + new URLSearchParams({ workspaceId, projectId });
  const selected = providers.find(p => p.instanceId === provider);
  const selectionReady = selected?.enabled && selected.configured && selected.nativeSessionReady && selected.driver === 'codex' && selected.models.some(m => m.id === model && !m.disabledReason);
  const resumeBlocked = !!run && canvasProgress(run).resumeBlocked;
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
    setOpen(true); setConsent({build:false,commit:false,upload:false}); setError(''); await load();
    try { const p = await workspaceClient.json<ProvidersResponse>('/api/providers'); if (alive.current) setProviders(p.providers); } catch { if (alive.current) setError('Provider 不可用，请核对配置。'); }
  }
  async function start() {
    const permission = canvasConsent(consent);
    if (issues.length || flight.current || !setup?.baseBranch || !ready || unknown || run || disabled || !permission || !selectionReady) return;
    flight.current = true; setBusy(true); setError('');
    try {
      const published = await prepare();
      const input: CanvasStart = { id: crypto.randomUUID(), workspaceId, projectId, ...published, ...setup, providerInstanceId: provider, model, ...(verification === 'local' ? { verification: 'local' as const } : {}), consent: permission };
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
  async function control(action: 'pause' | 'resume' | 'use-local' | 'retry-test', afterMaintenance = false) {
    if (!run || busy || disabled || (action === 'resume' && resumeBlocked && !(afterMaintenance && maintenanceConfirmed))) return; setBusy(true); setError('');
    try { const r = await workspaceClient.json<CanvasRun>(`/api/product-canvases/runs/${run.id}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, version: run.version, confirm: true }) }); if (alive.current) { adopt(r); setRecovery(false); setMaintenanceConfirmed(false); setLocalSwitch(false); setLocalConfirmed(false); setRepairOpen(false); setRepairConfirmed(false); } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '控制结果待核对'); }
    finally { if (alive.current) setBusy(false); }
  }
  return <><div className="canvas-run-controls">
    {!run ? <button className="primary" disabled={disabled || busy || unknown} onClick={() => void configure()}>开始构建</button> : run.status === 'running' ? <button disabled={busy || disabled} onClick={() => void control('pause')}>暂停构建</button> : run.status === 'paused' ? <button className="primary" disabled={busy || disabled || resumeBlocked} onClick={() => void control('resume')}>{resumeBlocked ? '等待环境恢复' : '核对并继续构建'}</button> : <span>等待产品验收</span>}
    {unknown && <button disabled={busy || disabled} onClick={() => void reconcileStart()}>核对并继续原启动</button>}
    {(run?.status === 'paused' || unknown || error) && <button disabled={busy} onClick={() => void load()}>刷新进度</button>}
    {run?.status === 'paused' && <button disabled={busy || disabled} onClick={() => { setRepairConfirmed(false); setRepairOpen(true); }}>验证修复结果</button>}
    {run?.status === 'paused' && !run.localVerification?.ready && run.input.verification !== 'local' && <button disabled={busy || disabled} onClick={() => { setLocalConfirmed(false); setLocalSwitch(true); }}>改用本机验证</button>}
    {resumeBlocked && <button disabled={busy} onClick={() => { setMaintenanceConfirmed(false); setRecovery(true); }}>恢复说明</button>}
    </div>{error && !open && <CanvasOperationNotice message={error} />}{unknown && !open && <p role="alert">正在等待启动结果确认，请先刷新进度；不会重复创建构建。</p>}
    <Dialog open={open} onOpenChange={v => { if (!busy) setOpen(v); }}><DialogContent className="canvas-dialog"><DialogTitle>开始构建产品</DialogTitle><DialogDescription>确认本次需求后，系统会逐个实现和检查功能，保留可追溯的成果版本。构建通过后由你体验验收，不会自动上线。</DialogDescription>
      {issues.length > 0 && <section role="alert"><strong>构建前请先完善画布</strong><ul>{issues.map(issue=><li key={issue}>{issue}</li>)}</ul></section>}
      <p>成果上传位置：<strong>{setup?.repository ?? '尚未配置或不可访问，请联系维护人员'}</strong></p>
      {!ready && <p role="alert">构建服务尚未就绪，请联系维护人员检查后再开始。</p>}
      <label>AI 服务<select value={provider} disabled={busy} onChange={e => { setProvider(e.target.value); setModel(''); }}><option value="">选择已配置的服务</option>{providers.map(p => <option key={p.instanceId} value={p.instanceId} disabled={!p.enabled || !p.configured || !p.nativeSessionReady || p.driver !== 'codex'}>{p.label}</option>)}</select></label>
      <label>模型<select value={model} disabled={busy} onChange={e => setModel(e.target.value)}><option value="">选择模型</option>{selected?.models.map(m => <option key={m.id} value={m.id} disabled={!!m.disabledReason}>{m.label}</option>)}</select></label>
      <p className="roadmap-muted">需求和代码会发送给所选 AI 服务，并消耗该服务额度。当前仅支持已配置的 Node 应用项目。</p>
      <fieldset className="canvas-build-consent"><legend>仅授权本次画布与上述成果位置</legend>
      {([['build','确认需求与验收要求；允许 AI 在独立空间编写代码和测试、创建功能任务，并更新为开发中或待审核'],['commit','允许将通过检查的代码保存为版本提交'],['upload','允许将代码版本上传到上述 GitHub 仓库，并创建草稿评审请求']] as const).map(([k,label]) => <label className="roadmap-check" key={k}><input type="checkbox" checked={consent[k]} disabled={busy} onChange={e => setConsent(v => ({ ...v, [k]: e.target.checked }))} />{label}</label>)}
      <p className="roadmap-muted">不会自动合并代码、公开部署或标记业务任务完成。</p></fieldset>
      <details className="canvas-technical"><summary>高级构建设置与执行范围</summary>
        <label>起始代码分支<input value={setup?.baseBranch ?? ''} onChange={e => setSetup(s => s && { ...s, baseBranch: e.target.value })} disabled={busy} /></label>
        <p>使用当前画布的不可变发布版本；按依赖串行构建，每个任务绑定独立 Session / worktree，并继承前一已核验分支。保存版本对应 Git commit；上传与草稿评审对应 push / Draft PR。</p>
        <label>验证方式<select value={verification} disabled={busy} onChange={e => setVerification(e.target.value as typeof verification)}><option value="local">本机隔离验证（不使用 GitHub 云端计算）</option><option value="github">GitHub 云端检查（使用账户计算额度）</option></select></label><p>测试命令为 npm test。本机方式支持无外部依赖的 Node 24 项目；云端方式要求名为 test 的检查。未配置代码分支时不能启动。</p>
      </details>
      {error && <CanvasOperationNotice message={error} />}<button className="primary" disabled={!!issues.length || disabled || busy || unknown || !!run || !ready || !setup?.baseBranch || !selectionReady || !canvasConsent(consent)} onClick={() => void start()}>{busy ? '正在核对并启动…' : '确认并开始构建'}</button>
    </DialogContent></Dialog>
    <Dialog open={repairOpen} onOpenChange={v => { if (!busy) setRepairOpen(v); }}><DialogContent className="canvas-dialog"><DialogTitle>验证修复结果</DialogTitle><DialogDescription>仅在维护人员已修复失败内容后使用。保留原失败记录，重新执行完整验证，不跳过检查，也不会重复开发或上传。</DialogDescription><label className="roadmap-check"><input type="checkbox" checked={repairConfirmed} disabled={busy} onChange={e => setRepairConfirmed(e.target.checked)} />确认验证修复后的内容</label>{error && <CanvasOperationNotice message={error} />}<button disabled={!repairConfirmed || busy || disabled} onClick={() => void control('retry-test')}>登记修复结果</button></DialogContent></Dialog>
    <Dialog open={localSwitch} onOpenChange={v => { if (!busy) setLocalSwitch(v); }}><DialogContent className="canvas-dialog"><DialogTitle>改用本机隔离验证</DialogTitle><DialogDescription>保留原需求、代码、任务和云端检查记录。后续在本机独立沙箱运行测试，不使用 GitHub 云端计算；测试失败仍会阻止继续。</DialogDescription><p>只支持停在云端检查的原画布节点；不会重放开发、提交或上传。切换后仍需核对并继续构建。</p><label className="roadmap-check"><input type="checkbox" checked={localConfirmed} onChange={e => setLocalConfirmed(e.target.checked)} disabled={busy} />确认将本次画布的后续验证改为本机隔离执行</label>{error && <CanvasOperationNotice message={error} />}<button disabled={!localConfirmed || busy || disabled} onClick={() => void control('use-local')}>确认切换验证方式</button></DialogContent></Dialog>
    <Dialog open={recovery} onOpenChange={v => { if (!busy) setRecovery(v); }}><DialogContent className="canvas-dialog"><DialogTitle>恢复构建环境</DialogTitle><DialogDescription>当前不支持一键修复。请由维护人员核对原构建空间及未保存的改动，完成安全恢复；不要删除或重新创建画布。</DialogDescription>
      <p>此前检查通过的功能仍计入进度。环境恢复后，可继续原构建；系统仍会重新校验，不会跳过保护。</p>
      <details className="canvas-technical"><summary>供维护人员查看的诊断信息</summary><p>{run?.message}</p><p>运行编号：{run?.id}</p><p>需要核验原 worktree 路径、目录身份、分支、仓库和未提交文件；此入口不修改这些绑定，也不执行修复。</p></details>
      <label className="roadmap-check"><input type="checkbox" checked={maintenanceConfirmed} disabled={busy || disabled} onChange={e => setMaintenanceConfirmed(e.target.checked)} />维护人员已完成环境核对与恢复，我要继续原构建</label>
      {error && <CanvasOperationNotice message={error} />}<button className="primary" disabled={busy || disabled || !maintenanceConfirmed} onClick={() => void control('resume', true)}>重新核对并继续</button>
    </DialogContent></Dialog></>;
}
