import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChangeDiff } from '@/components/change-diff';
import { usePmService, usePrivateQuery } from '../service/pm-service';
import { pmKeys } from '../service/pm-data';
import type { ChangeHistoryTarget, ChangeSnapshot, TaskAttentionPage } from '../../../../../../packages/contracts/src/change-history';
import './change-history.css';

function useHistoryKey(workspaceId: string | undefined) {
  const { actor, coreEvents } = usePmService();
  const queryClient = useQueryClient();
  const actorId = actor?.id;
  useEffect(() => {
    if (!actorId || !workspaceId) return;
    const prefix = [...pmKeys.workspace(window.location.origin, actorId, workspaceId), 'change-history'];
    let timer: number | undefined;
    const invalidate = () => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void queryClient.invalidateQueries({ queryKey: prefix, predicate: query => query.queryKey[5] === 'list' || query.queryKey[5] === 'attention' });
      }, 75);
    };
    coreEvents?.addEventListener('ready', invalidate);
    coreEvents?.addEventListener('change', invalidate);
    window.addEventListener('external-documents-changed', invalidate);
    // Native filesystem observations reach the SQL importer after the file event.
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible') invalidate(); }, 30_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      coreEvents?.removeEventListener('ready', invalidate);
      coreEvents?.removeEventListener('change', invalidate);
      window.removeEventListener('external-documents-changed', invalidate);
    };
  }, [actorId, workspaceId, coreEvents, queryClient]);
  return [...pmKeys.workspace(window.location.origin, actorId ?? 'anonymous', workspaceId ?? 'none'), 'change-history'] as const;
}

/** One authorized batch per 500 IDs; no per-card history requests. */
export function useChangeAttention(workspaceId: string | undefined, taskIds: string[]) {
  const service = usePmService();
  const key = useHistoryKey(workspaceId);
  const ids = [...new Set(taskIds)].sort();
  return usePrivateQuery([...key, 'attention', ids], 'domain.read', undefined, async (client, ws, signal): Promise<TaskAttentionPage> => {
    const items: TaskAttentionPage['items'] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const page = await client.changeHistory.attention(ws, { taskIds: ids.slice(i, i + 500) }, signal);
      items.push(...page.items);
      if (page.nextTaskId) throw new Error('Incomplete attention result');
    }
    return { items, nextTaskId: null };
  }, !!workspaceId && workspaceId === service.workspace?.id && ids.length > 0);
}

function SnapshotComparison({ before, after, en, name, exact }: { before: ChangeSnapshot | null; after: ChangeSnapshot | null; en: boolean; name: string; exact: boolean }) {
  const [rawSource, setRawSource] = useState(false);
  const rawOnly = before?.body === null || after?.body === null;
  const metadataUnavailable = before?.metadata === null || after?.metadata === null;
  const contentField = rawSource || rawOnly ? 'raw' : 'body';
  const fields = metadataUnavailable ? [] : [...new Set([...Object.keys(before?.metadata ?? {}), ...Object.keys(after?.metadata ?? {})])].filter(field => JSON.stringify(before?.metadata?.[field]) !== JSON.stringify(after?.metadata?.[field]));
  if (!before && !after) return <p>{en ? 'No captured content at these endpoints.' : '这些端点没有已采集的内容。'}</p>;
  return <div>
    {(rawOnly || metadataUnavailable) && <p role="status">{en ? 'An endpoint could not be parsed. Comparing retained source bytes without inferring field changes.' : '某个端点无法解析；仅比较保留的原始文本，不推断字段变更。'}</p>}
    {fields.length > 0 && <div className="change-history-fields"><h4>{en ? 'Field changes' : '字段变更'}</h4><dl>{fields.map(field => <div key={field}><dt>{field}</dt><dd><span>{en ? 'Before' : '之前'}: {JSON.stringify(before?.metadata?.[field]) ?? (en ? 'not present' : '不存在')}</span><span>{en ? 'After' : '之后'}: {JSON.stringify(after?.metadata?.[field]) ?? (en ? 'not present' : '不存在')}</span></dd></div>)}</dl></div>}
    {!rawOnly && (before?.raw !== before?.body || after?.raw !== after?.body) && <label><input type="checkbox" checked={rawSource} onChange={event => setRawSource(event.target.checked)} /> {en ? 'Compare full Markdown source, including frontmatter' : '比较完整 Markdown 源码（包括元数据区）'}</label>}
    {(!before || !after) && !exact ? <><p role="status">{en ? 'One endpoint is unavailable; a complete difference cannot be reconstructed.' : '一个端点不可用，无法还原完整差异。'}</p>{(before || after) && <details><summary>{before ? (en ? 'Available before content' : '可用的之前内容') : (en ? 'Available after content' : '可用的之后内容')}</summary><pre className="change-history-snapshot">{(before || after)![contentField]}</pre></details>}</> : <>{(!before || !after) && <p>{before ? (en ? 'Content deleted' : '内容已删除') : (en ? 'Content created' : '内容已创建')}</p>}<ChangeDiff key={`${name}:${before?.revision}:${after?.revision}`} before={before?.[contentField] ?? ''} after={after?.[contentField] ?? ''} name={name} en={en} /></>}
  </div>;
}

export function ChangeHistoryPanel({ workspaceId, target, en, initialChangeId, onClose }: { workspaceId: string; target: ChangeHistoryTarget; en: boolean; initialChangeId?: string | undefined; onClose: () => void }) {
  const service = usePmService();
  const queryClient = useQueryClient();
  const key = useHistoryKey(workspaceId);
  const [selected, setSelected] = useState<string | null>(initialChangeId ?? null);
  const [mode, setMode] = useState<'single' | 'cumulative'>('single');
  const [cursor, setCursor] = useState<string | undefined>();
  const [pinnedHead, setPinnedHead] = useState<string | undefined>();
  const [viewGeneration, setViewGeneration] = useState(0);
  const [ackError, setAckError] = useState('');
  const [acking, setAcking] = useState(false);
  useEffect(() => { setSelected(initialChangeId ?? null); setMode('single'); }, [initialChangeId]);
  const enabled = workspaceId === service.workspace?.id;
  const list = usePrivateQuery([...key, 'list', target, viewGeneration, cursor ?? null, pinnedHead ?? null], 'domain.read', undefined,
    (client, ws, signal) => client.changeHistory.list(ws, { target, includeRelated: target.kind === 'core', limit: 50, ...(cursor ? { cursor } : {}), ...(pinnedHead ? { head: pinnedHead } : {}) }, signal), enabled);
  useEffect(() => {
    if (!list.data?.items.length || list.isFetching || pinnedHead !== undefined) return;
    setPinnedHead(list.data.head);
    if (!selected) setSelected(list.data.items[0]?.changeId ?? null);
  }, [list.data, list.isFetching, pinnedHead, selected]);
  const detail = usePrivateQuery([...key, 'detail', selected], 'domain.read', undefined,
    (client, ws, signal) => client.changeHistory.detail(ws, selected!, signal), enabled && mode === 'single' && !!selected);
  const comparison = usePrivateQuery([...key, 'compare', target, list.data?.head ?? null], 'domain.read', undefined,
    (client, ws, signal) => client.changeHistory.compare(ws, { target, through: list.data!.head }, signal), enabled && mode === 'cumulative' && !!list.data && !cursor);
  const refresh = () => { setCursor(undefined); setPinnedHead(undefined); setSelected(null); setViewGeneration(value => value + 1); void queryClient.invalidateQueries({ queryKey: key }); };
  async function acknowledge() {
    const page = list.data;
    if (!page || !service.actor || !service.workspace || acking) return;
    setAcking(true); setAckError('');
    try {
      await service.client.changeHistory.acknowledge(workspaceId, { target, through: page.head, observationToken: page.observationToken });
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (error) { setAckError(error instanceof Error ? error.message : String(error)); }
    finally { setAcking(false); }
  }
  const result = mode === 'single' ? detail.data : comparison.data;
  const completeness = result && ('change' in result ? result.change.completeness : result.completeness);
  const error = mode === 'single' ? detail.error : comparison.error;
  const loading = mode === 'single' ? !!selected && detail.isPending : comparison.isPending;
  const name = target.kind === 'core' ? target.entityId : target.path;
  return <section className="change-history" aria-label={en ? 'Change history' : '变更记录'}>
    <header><h3>{en ? 'Change history' : '变更记录'}</h3><button type="button" onClick={onClose}>{en ? 'Close' : '关闭'}</button></header>
    <p>{en ? 'This personal change-read acknowledgement is separate from inbox read status and task acceptance. Related requirements and documents are listed separately; cumulative comparison covers this item.' : '这是个人变更已阅标记，与通知已读和任务验收互不等同。关联需求和文档单独列出；累计差异仅比较当前对象。'}</p>
    {list.isPending && <p role="status">{en ? 'Loading history…' : '正在加载变更记录…'}</p>}
    {list.error && <div role="alert">{en ? 'History is unavailable.' : '变更记录不可用。'} <button type="button" onClick={() => void list.refetch()}>{en ? 'Retry' : '重试'}</button></div>}
    {list.data && !list.error && <>
      <p role="status">{list.data.completeness === 'complete_since_capture' ? (en ? 'History is available since capture began; earlier history is not implied.' : '显示开始采集后的历史，不代表更早历史完整。') : list.data.completeness === 'observer_gap' ? (en ? 'Observation has gaps; intermediate edits and authors are unknown.' : '观测存在间断，中间版本及作者未知。') : (en ? 'Earlier history is unavailable before the baseline.' : '基线之前的历史不可用。')}</p>
      <p>{en ? 'Displayed watermark' : '当前显示水位'}: <code>{list.data.head}</code> · {en ? 'Pending' : '待阅'}: {list.data.pendingCount}</p>
      <p>{en ? 'Marking viewed covers this item and listed related sources through the displayed watermark, including older pages. Later changes remain pending; refresh to review a newer watermark.' : '已阅将覆盖当前对象及列出的关联来源至显示水位（包括更早页面）。之后的新变更仍待阅；点击刷新才能查看新的水位。'}</p>
      <div className="change-history-actions"><button type="button" disabled={acking || list.data.pendingCount === 0} onClick={() => void acknowledge()}>{acking ? (en ? 'Saving…' : '保存中…') : (en ? 'Mark these changes viewed' : '已阅这些变更')}</button><button type="button" onClick={refresh}>{en ? 'Refresh' : '刷新'}</button><button type="button" aria-pressed={mode === 'cumulative'} onClick={() => { setPinnedHead(list.data!.head); setCursor(undefined); setMode('cumulative'); }}>{en ? 'This item since last viewed' : '当前对象自上次已阅以来'}</button></div>
      {ackError && <p role="alert">{en ? 'Could not confirm viewed changes. Refresh before retrying:' : '无法确认已阅变更，请刷新核对后重试：'} {ackError}</p>}
      {!list.data.items.length && <p>{en ? 'No recorded changes in this page.' : '此页没有已记录的变更。'}</p>}
      <ol className="change-history-list">{list.data.items.map(item => <li key={item.changeId}><button type="button" aria-pressed={mode === 'single' && selected === item.changeId} onClick={() => { setMode('single'); setSelected(item.changeId); }}><strong>{item.relation === 'related_requirement' ? (en ? 'Related requirement' : '关联需求') : item.relation === 'related_document' ? (en ? 'Related document' : '关联文档') : (en ? 'This item' : '当前对象')} · {item.target.kind === 'core' ? item.target.entityId : item.target.path}</strong><span>{item.changeKinds.join(', ')} · {item.changedFields.join(', ') || (en ? 'No field details' : '无字段详情')}</span><span>{en ? 'Source' : '来源'}: {item.origin} · {en ? 'Actor' : '操作者'}: {item.actorId || (en ? 'unknown' : '未知')} · {item.occurredAt ? (en ? 'Occurred' : '发生时间') : (en ? 'Observed' : '观测时间')}: {item.occurredAt || item.observedAt}</span><span>{en ? 'Revision' : '版本'}: {item.beforeRevision || '—'} → {item.afterRevision || '—'} · {item.completeness}</span></button></li>)}</ol>
      {list.data.nextCursor && <button type="button" onClick={() => { setPinnedHead(list.data!.head); setCursor(list.data!.nextCursor!); }}>{en ? 'Older changes' : '更早变更'}</button>}{cursor && <button type="button" onClick={() => { setCursor(undefined); setPinnedHead(undefined); }}>{en ? 'Newest changes' : '最新变更'}</button>}
    </>}
    {loading && <p role="status">{en ? 'Loading comparison…' : '正在加载差异…'}</p>}
    {error && <div role="alert">{en ? 'Comparison unavailable.' : '差异不可用。'} <button type="button" onClick={() => void (mode === 'single' ? detail.refetch() : comparison.refetch())}>{en ? 'Retry' : '重试'}</button></div>}
    {mode === 'cumulative' && comparison.data && !comparison.error && <p>{en ? 'Comparison endpoint' : '比较端点'}: {comparison.data.toChangeId ?? (en ? 'unavailable' : '不可用')} · {en ? 'sequence' : '序号'} {comparison.data.head}</p>}
    {result && !error && !list.error && enabled && <><p>{completeness === 'observed_endpoints' ? (en ? 'Only observed endpoints are known; intermediate changes and authors may be unknown.' : '仅记录观测到的端点，中间变更及作者可能未知。') : completeness === 'baseline' || completeness === 'missing_before' ? (en ? 'Earlier content is unavailable.' : '之前的内容不可用。') : (en ? 'Recorded endpoints' : '已记录的端点')}</p><SnapshotComparison before={result.before} after={result.after} name={'change' in result ? (result.change.target.kind === 'core' ? result.change.target.entityId : result.change.target.path) : name} en={en} exact={completeness === 'exact'} /></>}
  </section>;
}
