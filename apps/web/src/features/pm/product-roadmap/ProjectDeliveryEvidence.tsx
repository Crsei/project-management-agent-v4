import { useEffect, useRef, useState } from 'react';
import { workspaceClient } from '@agent/src/network';
import type { RoadmapDeliveryRead, RoadmapDeliveryScope } from '../../../../../../packages/contracts/src/product-roadmap';
import { AppPreviewPanel } from '../workflows/AppPreviewPanel';
import '../workflows/task-workflows.css';
export function ProjectDeliveryEvidence({ scope, disabled }: { scope: RoadmapDeliveryScope; disabled: boolean }) {
  const [value, setValue] = useState<RoadmapDeliveryRead | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const query = new URLSearchParams(scope).toString();
  async function load(refresh: boolean) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setValue(null);
    try { const result = await workspaceClient.json<RoadmapDeliveryRead>(`/api/project-roadmap-deliveries?${query}${refresh ? '&refresh=1' : ''}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) }); if (!controller.signal.aborted) setValue(result); }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '集成证据读取失败'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  useEffect(() => { void load(false); return () => request.current?.abort(); }, [query]);
  return <section className="roadmap-card" aria-label="产品预览与验收"><div className="roadmap-card-heading"><div><h2>体验你的产品</h2><p>先检查所有功能是否具备一起预览的条件，再由你亲自体验。</p></div><button disabled={busy} onClick={() => void load(true)}>{busy ? '正在检查…' : '刷新产品检查'}</button></div>
    {error && <><p role="alert" className="roadmap-error">产品检查暂不可读取。请刷新核对；本次仅查询，未发起启动或重试。</p><details className="canvas-technical"><summary>诊断详情</summary><p>{error}</p></details></>}
    {value && <><p role="status" className={value.eligible ? 'roadmap-notice' : 'roadmap-warning'}>{value.eligible ? '功能已通过整体版本检查。下方会继续核对预览环境；实际体验仍需你验收。' : '完整产品尚未具备预览条件。请先完成画布构建，再核对所有功能是否已包含在同一版本。'}</p>
      <div className="roadmap-deliveries">{value.items.map((item,index)=><article key={`${item.taskId}:${index}`}><strong>{item.title}</strong><span>{!item.issue && item.tested && (item.verified ?? item.ci) ? item.included ? '版本检查通过' : '功能检查通过 · 待整体核对' : '等待构建或核对'}</span></article>)}</div>
      {value.eligible && value.candidate && <AppPreviewPanel productView key={value.candidate.id} delivery={value.candidate} disabled={disabled} endpoint={`/api/project-app-previews/${value.candidate.id}?${query}`} />}
      <details className="canvas-technical"><summary>查看技术检查记录</summary><p>{value.reason}</p><div className="roadmap-deliveries">{value.items.map((item, index) => <article key={`${item.taskId}:${index}`}><div><strong>{item.taskId || '未创建'} · {item.title}</strong><p>测试 {item.tested ? '通过记录' : '待验证'} · {item.verification === 'local' ? `本机隔离验证 ${item.verified ? '通过' : '未通过'}` : `CI ${item.ci ? '同版本通过' : '未确认'}`} · 集成 {item.included ? '已包含提交' : '未确认'}{item.head ? ` · ${item.head.slice(0, 8)}` : ''}</p>{item.issue && <p>{item.issue}</p>}{item.observedAt && <p>验证观察时间：{new Date(item.observedAt).toLocaleString()}</p>}</div>{item.pr && <a href={item.pr} target="_blank" rel="noreferrer">查看 PR ↗</a>}</article>)}</div><p>服务端仍校验前置代码、测试、GitHub 与集成版本；多前置功能需要先由维护人员集成，不自动合并。</p></details>
    </>}
    <p className="roadmap-muted">检查通过不等于产品验收通过，也不会自动上线或完成项目。</p>
  </section>;
}
