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
  return <section className="roadmap-card" aria-label="项目集成与 App 验收"><div className="roadmap-card-heading"><div><h2>项目集成与 App 验收</h2><p>核对提交包含关系，而不是把任务状态拼成“已完成”。</p></div><button disabled={busy} onClick={() => void load(true)}>{busy ? '正在核对…' : '核对 GitHub 与集成版本'}</button></div>
    {error && <p role="alert" className="roadmap-error">{error} · 未启动预览，也不会自动重试外部操作。</p>}
    {value && <><p role="status" className={value.eligible ? 'roadmap-notice' : 'roadmap-warning'}>{value.reason}</p><div className="roadmap-deliveries">{value.items.map((item, index) => <article key={`${item.taskId}:${index}`}><div><strong>{item.taskId || '未创建'} · {item.title}</strong><p>测试 {item.tested ? '通过记录' : '待验证'} · CI {item.ci ? '同版本通过' : '未确认'} · 集成 {item.included ? '已包含提交' : '未确认'}{item.head ? ` · ${item.head.slice(0, 8)}` : ''}</p>{item.issue && <p>{item.issue}</p>}{item.observedAt && <p>CI 观察时间：{new Date(item.observedAt).toLocaleString()}</p>}</div>{item.pr && <a href={item.pr} target="_blank" rel="noreferrer">查看 PR ↗</a>}</article>)}</div>
      {value.eligible && value.candidate && <AppPreviewPanel key={value.candidate.id} delivery={value.candidate} disabled={disabled} endpoint={`/api/project-app-previews/${value.candidate.id}?${query}`} />}
    </>}
    <p className="roadmap-muted">线性任务默认建议以前置任务的已推送分支继续开发；服务端会校验基线确实包含前置提交。多前置任务需要先人工集成。预览启动时重新核验最新 GitHub 证据，仍不替代跨任务业务验收，也不自动合并或完成项目。</p>
  </section>;
}
