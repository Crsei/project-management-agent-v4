import { useEffect, useRef, useState } from 'react';
import { workspaceClient } from '@agent/src/network';
import type { TaskCodeDelivery } from '../../../../../../packages/contracts/src/task-code-delivery';
import type { AppPreviewState } from '../../../../../../packages/contracts/src/task-app-preview';

export function AppPreviewPanel({ delivery, disabled, endpoint, productView = false }: { delivery: Pick<TaskCodeDelivery, 'id' | 'head'>; disabled: boolean; endpoint?: string; productView?: boolean }) {
  const [state, setState] = useState<AppPreviewState | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  const acting = useRef(false);
  const request = useRef<AbortController | null>(null);
  const url = endpoint ?? `/api/task-deliveries/${delivery.id}/preview`;
  async function load() {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    try { const result = await workspaceClient.json<AppPreviewState>(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) }); if (!controller.signal.aborted) { setState(result); setError(''); if (result.status === 'running') setConfirm(false); } }
    catch { if (!controller.signal.aborted) { setState(null); setError('预览状态暂不可读取；未启动或重试任何进程。'); } }
  }
  useEffect(() => { setState(null); setConfirm(false); void load(); const timer = setInterval(() => { if (!acting.current && document.visibilityState === 'visible') void load(); }, 15000); return () => { clearInterval(timer); request.current?.abort(); }; }, [url]);
  async function act(action: 'start' | 'stop') {
    acting.current = true; setBusy(true); setError(''); request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    try {
      const result = await workspaceClient.json<AppPreviewState>(url, { method: 'POST', body: JSON.stringify({ action, confirm: true, ...(action === 'start' ? { head: delivery.head } : {}) }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(endpoint ? 60000 : 20000)]) });
      if (!controller.signal.aborted) { setState(result); setConfirm(false); }
    } catch (e) { if (!controller.signal.aborted) { setState(null); setError(e instanceof Error ? `${e.message} 请先刷新核对，不要盲目重试。` : '结果未确认，请刷新核对。'); } }
    finally { acting.current = false; setBusy(false); }
  }
  return <section className="app-preview-panel" aria-label="App 成品预览">
    <div><strong>{productView ? '产品体验' : 'App 成品预览'}</strong><small>{productView ? '在本机临时打开，亲自检查使用效果' : '已提交代码 → 隔离运行 → 实际操作验收'}</small></div>
    <p role="status">{busy ? confirm ? '正在准备预览并检查可用性…' : '正在停止预览…' : productView ? !state ? '预览状态待核对；不会自动重复启动。' : state.status === 'running' ? '预览正在运行。' : state.status === 'starting' ? '预览正在准备中，请稍后刷新。' : state.status === 'failed' ? '预览未能启动，请刷新核对或联系维护人员。' : state.available ? '可以启动本机预览。' : '当前版本暂不支持预览，请查看诊断详情或联系维护人员。' : state?.message ?? '预览状态待核对；不会自动运行生成的代码。'}</p>
    {state?.head && <small>{!productView && `预览版本 ${state.head.slice(0, 8)} · `}{state.expiresAt ? `自动停止 ${new Date(state.expiresAt).toLocaleTimeString()}` : ''}</small>}
    {error && <p role="alert">{productView ? '预览结果尚未确认，请刷新核对，不要重复启动。' : error}</p>}
    <div className="workflow-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { void load(); }}>刷新预览状态</button>
      {state?.status === 'running' && state.url ? <><a className="primary-button" href={state.url} target="_blank" rel="noreferrer">{productView ? '打开产品体验' : '打开 App'}</a><button type="button" className="secondary-button" disabled={disabled || busy} onClick={() => { void act('stop'); }}>停止预览</button></> : <button type="button" className="secondary-button" disabled={disabled || busy || confirm || !state?.available || state.status === 'starting'} onClick={() => setConfirm(true)}>{productView ? '启动产品预览' : '启动隔离预览'}</button>}
    </div>
    {confirm && <div className="app-preview-confirm" role="group" aria-label="预览运行确认">
      <p>{productView ? '即将在本机运行已检查的产品代码，只保存独立的演示数据，不读取项目管理数据或账号凭据，也不能访问外网。30 分钟后自动停止，演示数据保留。本机其他用户也可能访问，请勿输入真实敏感数据。' : '运行当前已提交的 app/server.mjs；隔离进程只能读应用代码与系统运行库、写自己的演示数据，不挂载 PM 数据或凭据，不可访问外网。仅本机访问，30 分钟后停止，数据保留。本地其他用户可能访问预览，请勿输入真实敏感数据。'}</p>
      <button type="button" className="primary-button" disabled={busy || disabled} onClick={() => { void act('start'); }}>{busy ? '正在启动…' : '确认启动预览'}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirm(false)}>取消</button>
    </div>}
    {productView ? <><small>预览不代表产品已验收或上线。请实际检查功能、权限及数据保存效果。</small><details className="canvas-technical"><summary>预览诊断与支持范围</summary><p>{state?.message}</p>{state?.head && <p>预览版本：{state.head}</p>}{error && <p>{error}</p>}<p>当前仅支持预设的无依赖 Node App，入口 app/server.mjs；仍使用原隔离运行与权限检查。会话持久化暂沿用 Agent Chat，统一设计尚未收口。</p></details></> : <small>预览与 CI 不替代人工验收，不自动部署、合并或完成任务。当前仅支持预设的无依赖 Node App；会话持久化仍暂沿用 Agent Chat。</small>}
  </section>;
}
