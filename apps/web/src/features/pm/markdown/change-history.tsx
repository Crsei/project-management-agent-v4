import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChangeDiff } from '@/components/change-diff';
import { usePmService, usePrivateQuery } from '../service/pm-service';
import { pmKeys } from '../service/pm-data';
import type { ChangeHistoryTarget, ChangeSnapshot, TaskAttentionPage } from '../../../../../../packages/contracts/src/change-history';
import { MarkdownDiff } from './markdown-diff';
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

const fieldLabels: Record<string, [string, string]> = {
  title: ['Title', '标题'], status: ['Status', '状态'], priority: ['Priority', '优先级'],
  assignee: ['Assignee', '负责人'], project: ['Project', '项目'], due: ['Due date', '截止日期'],
  tags: ['Tags', '标签'], labels: ['Labels', '标签'], archived: ['Archived', '已归档'],
  entity: ['Entity type', '对象类型'], id: ['ID', '标识'], requirement: ['Requirement', '需求'],
  related_to: ['Related items', '关联对象'], blocked_by: ['Blocked by', '前置依赖'],
  parent: ['Parent', '父项'], milestone: ['Milestone', '里程碑'], body: ['Body', '正文'],
};
function fieldLabel(field: string, en: boolean) { return fieldLabels[field]?.[en ? 0 : 1] ?? field; }
function fieldValue(value: unknown, en: boolean): string {
  if (value === undefined) return en ? 'Not present' : '不存在';
  if (value === null) return en ? 'Null' : '空值（null）';
  if (typeof value === 'boolean') return value ? (en ? 'Yes' : '是') : (en ? 'No' : '否');
  if (typeof value === 'string') return value || (en ? 'Empty text' : '空文本');
  if (Array.isArray(value) && value.every(item => item === null || typeof item !== 'object')) return value.length ? value.map(item => fieldValue(item, en)).join(' · ') : (en ? 'Empty list' : '空列表');
  return JSON.stringify(value, null, 2) ?? String(value);
}
function historyTime(value: string, en: boolean) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(en ? 'en' : 'zh-CN');
}
function navigateReviewTabs(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (current < 0 || !tabs.length) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.click();
  tabs[next]?.focus();
}
function SnapshotComparison({ before, after, en, name, exact }: { before: ChangeSnapshot | null; after: ChangeSnapshot | null; en: boolean; name: string; exact: boolean }) {
  const [tab, setTab] = useState<'body' | 'source' | 'fields'>('body');
  const id = useId();
  const rawOnly = before?.body === null || after?.body === null;
  const metadataUnavailable = before?.metadata === null || after?.metadata === null;
  const missing = (!before || !after) && !exact;
  const fields = metadataUnavailable || missing ? [] : [...new Set([...Object.keys(before?.metadata ?? {}), ...Object.keys(after?.metadata ?? {})])].filter(field => JSON.stringify(before?.metadata?.[field]) !== JSON.stringify(after?.metadata?.[field]));
  const tabs = [{ id: 'body' as const, label: en ? 'Read mode' : '阅读视图' }, { id: 'source' as const, label: en ? 'Source' : '源码' }, { id: 'fields' as const, label: `${en ? 'Fields' : '字段'}${fields.length ? ` · ${fields.length}` : ''}` }];
  if (!before && !after) return <p className="change-history-empty">{en ? 'No captured content at these endpoints.' : '这些端点没有已采集的内容。'}</p>;
  return <div className="change-history-comparison">
    <div className="change-history-tabs" role="tablist" aria-label={en ? 'Comparison view' : '差异视图'} onKeyDown={navigateReviewTabs}>{tabs.map(item => <button key={item.id} type="button" id={`${id}-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`${id}-panel`} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} tabIndex={0} className="change-history-tab-content">
      {missing ? <><p className="change-history-gap" role="status">{en ? 'One endpoint is unavailable. No complete body or field difference can be reconstructed; missing content is not empty content.' : '一个端点不可用，无法还原完整正文或字段差异；缺失内容不等于空内容。'}</p><details><summary>{before ? (en ? 'Available before source' : '可用的之前源码') : (en ? 'Available after source' : '可用的之后源码')}</summary><pre className="change-history-snapshot">{(before || after)!.raw}</pre></details></> : <>
        {(!before || !after) && <p className="change-history-notice">{before ? (en ? 'Recorded deletion' : '已记录的删除') : (en ? 'Recorded creation' : '已记录的创建')}</p>}
        {tab === 'fields' ? metadataUnavailable ? <p className="change-history-gap">{en ? 'An endpoint has no parsed metadata. Field changes are unknown; inspect Source for the retained bytes.' : '某个端点没有可解析的元数据，字段变更未知；请在源码视图查看保留的原文。'}</p> : fields.length ? <div className="change-history-fields"><div className="change-history-field-head"><span>{en ? 'Field' : '字段'}</span><span>{en ? 'Before' : '之前'}</span><span>{en ? 'After' : '之后'}</span></div><dl>{fields.map(field => <div key={field}><dt title={field}>{fieldLabel(field, en)}{fieldLabel(field, en) !== field && <code>{field}</code>}</dt><dd><span className="change-history-mobile-label">{en ? 'Before' : '之前'}</span><pre>{fieldValue(before?.metadata?.[field], en)}</pre></dd><dd><span className="change-history-mobile-label">{en ? 'After' : '之后'}</span><pre>{fieldValue(after?.metadata?.[field], en)}</pre></dd></div>)}</dl><p className="change-history-notice">{en ? 'Identifiers and custom values are shown as captured; no current names or labels are substituted.' : '标识和自定义值按采集原值显示，不替换为当前的名称或标签。'}</p></div> : <p className="change-history-empty">{en ? 'No field changes between these endpoints.' : '这两个端点之间没有字段变更。'}</p> : tab === 'source' || rawOnly ? <>
          <p className={rawOnly ? 'change-history-gap' : 'change-history-notice'}>{rawOnly ? (en ? 'An endpoint body could not be parsed. Showing the retained full source, not an invented rendered difference.' : '某个端点的正文无法解析，现展示保留的完整源码，不推断阅读视图差异。') : (en ? 'Full captured Markdown, including frontmatter and formatting.' : '完整采集的 Markdown，包含元数据区与格式。')}</p>
          <ChangeDiff before={before?.raw ?? ''} after={after?.raw ?? ''} name={name} en={en} />
        </> : <>{before?.body === after?.body && <p className="change-history-notice">{fields.length ? (en ? 'The body is unchanged. See Fields for metadata changes.' : '正文未改变，请在字段视图查看元数据变更。') : before?.raw !== after?.raw ? (en ? 'The parsed body is unchanged. Source retains formatting or metadata syntax changes.' : '解析后的正文未改变；源码视图保留格式或元数据语法差异。') : (en ? 'The body is unchanged between these endpoints.' : '这两个端点之间的正文未改变。')}</p>}<MarkdownDiff before={before?.body ?? ''} after={after?.body ?? ''} name={name} en={en} /></>}
      </>}
    </div>
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
  const id = useId();
  useEffect(() => { setSelected(initialChangeId ?? null); setMode('single'); }, [initialChangeId]);
  const enabled = workspaceId === service.workspace?.id;
  const list = usePrivateQuery([...key, 'list', target, viewGeneration, cursor ?? null, pinnedHead ?? null], 'domain.read', undefined,
    (client, ws, signal) => client.changeHistory.list(ws, { target, includeRelated: target.kind === 'core', limit: 50, ...(cursor ? { cursor } : {}), ...(pinnedHead ? { head: pinnedHead } : {}) }, signal), enabled);
  useEffect(() => {
    if (!list.data || list.isFetching || pinnedHead !== undefined) return;
    setPinnedHead(list.data.head);
    if (!selected) setSelected(list.data.items[0]?.changeId ?? null);
  }, [list.data, list.isFetching, pinnedHead, selected]);
  const detail = usePrivateQuery([...key, 'detail', selected], 'domain.read', undefined,
    (client, ws, signal) => client.changeHistory.detail(ws, selected!, signal), enabled && mode === 'single' && !!selected);
  const comparison = usePrivateQuery([...key, 'compare', target, list.data?.head ?? null], 'domain.read', undefined,
    (client, ws, signal) => client.changeHistory.compare(ws, { target, through: list.data!.head }, signal), enabled && mode === 'cumulative' && !!list.data && !cursor);
  const refresh = () => { setCursor(undefined); setPinnedHead(undefined); setSelected(null); setAckError(''); setViewGeneration(value => value + 1); void queryClient.invalidateQueries({ queryKey: key }); };
  async function acknowledge() {
    const page = list.data;
    if (!page || list.error || list.isFetching || !service.actor || service.workspace?.id !== workspaceId || acking) return;
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
  const comparedName = result && 'change' in result ? (result.change.target.kind === 'core' ? result.change.target.entityId : result.change.target.path) : name;
  const selectedChange = result && 'change' in result ? result.change : undefined;
  const modes = [{ id: 'single' as const, label: en ? 'Single change' : '单次变更' }, { id: 'cumulative' as const, label: en ? 'Since last viewed' : '自上次已阅以来' }];
  return <section className="change-history" aria-label={en ? 'Change history review' : '变更记录审阅'}>
    <header className="change-history-header"><div><h3>{en ? 'Change history' : '变更记录'}</h3><span className="change-history-readonly">{en ? 'Read only · saved snapshots' : '只读 · 已保存快照'}</span></div><button type="button" onClick={onClose}>{en ? 'Back to content' : '返回正文'}</button></header>
    {list.isPending && <p role="status">{en ? 'Loading history…' : '正在加载变更记录…'}</p>}
    {list.error && <div role="alert">{en ? 'History is unavailable.' : '变更记录不可用。'} <button type="button" onClick={() => void list.refetch()}>{en ? 'Retry' : '重试'}</button></div>}
    {list.data && !list.error && enabled && <>
      <div className="change-history-summary">
        <span>{en ? 'Pending' : '待阅'} <strong>{list.data.pendingCount}</strong></span>
        <details><summary>{en ? 'Capture & watermark' : '采集与水位'} · <code>{list.data.head}</code></summary>
          <p>{en ? 'History is available since capture began; earlier history is not implied.' : '显示开始采集后的历史，不代表更早历史完整。'}</p>
          <p>{en ? 'Displayed watermark' : '当前显示水位'}: <code>{list.data.head}</code> · {en ? 'Last viewed through' : '上次已阅至'}: <code>{list.data.reviewedThrough}</code></p>
          <p>{en ? 'Personal change-read acknowledgement is separate from inbox read status and task acceptance. Related requirements and documents are listed separately; cumulative comparison covers this item only.' : '个人变更已阅标记与通知已读、任务验收互不等同。关联需求和文档单独列出，累计差异仅比较当前对象。'}</p>
        </details>
        <button type="button" disabled={list.isFetching || acking} onClick={refresh}>{en ? 'Refresh history' : '刷新历史'}</button>
      </div>
      {list.data.completeness !== 'complete_since_capture' && <p className="change-history-gap" role="status">{list.data.completeness === 'observer_gap' ? (en ? 'Observation has gaps; intermediate edits and authors are unknown.' : '观测存在间断，中间版本及作者未知。') : (en ? 'Earlier history is unavailable before the baseline.' : '基线之前的历史不可用。')}</p>}
      <div className="change-history-tabs" role="tablist" aria-label={en ? 'Comparison range' : '比较范围'} onKeyDown={navigateReviewTabs}>{modes.map(item => <button type="button" key={item.id} id={`${id}-${item.id}`} role="tab" aria-selected={mode === item.id} aria-controls={`${id}-review`} tabIndex={mode === item.id ? 0 : -1} onClick={() => { setPinnedHead(list.data!.head); if (item.id === 'cumulative') setCursor(undefined); setMode(item.id); }}>{item.label}</button>)}</div>
      <div className={`change-history-workspace ${mode === 'cumulative' ? 'is-cumulative' : ''}`}>
        {mode === 'single' && <nav className="change-history-versions" aria-label={en ? 'Saved changes' : '已保存的变更'}>
          <h4>{en ? 'Versions' : '版本记录'}</h4>
          {!list.data.items.length && <p className="change-history-empty">{en ? 'No recorded changes in this page.' : '此页没有已记录的变更。'}</p>}
          <ol className="change-history-list">{list.data.items.map(item => <li key={item.changeId}><button type="button" aria-pressed={selected === item.changeId} onClick={() => setSelected(item.changeId)}>
            <strong>{item.relation === 'related_requirement' ? (en ? 'Related requirement' : '关联需求') : item.relation === 'related_document' ? (en ? 'Related document' : '关联文档') : (en ? 'This item' : '当前对象')} · {item.target.kind === 'core' ? item.target.entityId : item.target.path}</strong>
            <span><time dateTime={item.occurredAt || item.observedAt}>{historyTime(item.occurredAt || item.observedAt, en)}</time>{!item.occurredAt && (en ? ' · observed' : ' · 观测时间')}</span>
            <span>{item.changeKinds.join(' · ')}{item.changedFields.length > 0 && ` · ${item.changedFields.map(field => fieldLabel(field, en)).join(' · ')}`}</span>
            {item.completeness !== 'exact' && <span className="change-history-version-gap">{item.completeness === 'observed_endpoints' ? (en ? 'Observed endpoints only' : '仅观测端点') : (en ? 'Earlier content unavailable' : '之前内容不可用')}</span>}
          </button></li>)}</ol>
          <div className="change-history-actions">{list.data.nextCursor && <button type="button" disabled={list.isFetching} onClick={() => { setPinnedHead(list.data!.head); setCursor(list.data!.nextCursor!); }}>{en ? 'Older changes' : '更早变更'}</button>}{cursor && <button type="button" disabled={list.isFetching} onClick={() => setCursor(undefined)}>{en ? 'First page' : '返回首页'}</button>}</div>
        </nav>}
        <div className="change-history-review" id={`${id}-review`} role="tabpanel" aria-labelledby={`${id}-${mode}`}>
          <div className="change-history-review-heading"><h4>{comparedName}</h4><p>{mode === 'cumulative' ? (en ? 'This item only · last viewed endpoint → displayed watermark' : '仅当前对象 · 上次已阅端点 → 显示水位') : (en ? 'One saved change · before → after' : '单次已保存变更 · 之前 → 之后')}</p></div>
          {loading && <p role="status">{en ? 'Loading comparison…' : '正在加载差异…'}</p>}
          {error && <div role="alert">{en ? 'Comparison unavailable.' : '差异不可用。'} <button type="button" onClick={() => void (mode === 'single' ? detail.refetch() : comparison.refetch())}>{en ? 'Retry' : '重试'}</button></div>}
          {!selected && mode === 'single' && <p className="change-history-empty">{en ? 'Choose a recorded version to review.' : '选择已记录的版本进行审阅。'}</p>}
          {result && !error && <>
            {completeness !== 'exact' && <p className="change-history-gap" role="status">{completeness === 'observed_endpoints' ? (en ? 'Only observed endpoints are known; intermediate changes and authors may be unknown.' : '仅记录观测到的端点，中间变更及作者可能未知。') : (en ? 'Earlier content is unavailable. This is not a complete historical difference.' : '之前的内容不可用，这不是完整历史差异。')}</p>}
            <details className="change-history-endpoints"><summary>{en ? 'Snapshot details' : '快照详情'}</summary>
              <dl><div><dt>{en ? 'Before revision' : '之前版本'}</dt><dd><code>{result.before?.revision ?? (en ? 'No captured snapshot' : '无已采集快照')}</code></dd></div><div><dt>{en ? 'After revision' : '之后版本'}</dt><dd><code>{result.after?.revision ?? (en ? 'No captured snapshot' : '无已采集快照')}</code></dd></div>
                {selectedChange && <><div><dt>{en ? 'Source' : '来源'}</dt><dd>{selectedChange.origin === 'manual' ? (en ? 'Manual' : '人工') : selectedChange.origin === 'automation' ? (en ? 'Automation' : '自动化') : selectedChange.origin === 'agent' ? 'Agent' : (en ? 'Filesystem observation' : '文件系统观测')}</dd></div><div><dt>{en ? 'Actor ID' : '操作者标识'}</dt><dd>{selectedChange.actorId ?? (en ? 'Unknown' : '未知')}</dd></div><div><dt>{selectedChange.occurredAt ? (en ? 'Occurred' : '发生时间') : (en ? 'Observed' : '观测时间')}</dt><dd>{historyTime(selectedChange.occurredAt || selectedChange.observedAt, en)}</dd></div><div><dt>{en ? 'Change ID' : '变更标识'}</dt><dd><code>{selectedChange.changeId}</code></dd></div></>}
                {'toChangeId' in result && <div><dt>{en ? 'Comparison endpoints' : '比较端点'}</dt><dd><code>{result.fromChangeId ?? (en ? 'Unavailable' : '不可用')} → {result.toChangeId ?? (en ? 'Unavailable' : '不可用')}</code></dd></div>}
              </dl>
            </details>
            <SnapshotComparison key={`${mode}:${selected ?? ''}:${result.before?.revision}:${result.after?.revision}`} before={result.before} after={result.after} name={comparedName} en={en} exact={completeness === 'exact'} />
          </>}
        </div>
      </div>
      <footer className="change-history-ack">
        <p>{en ? 'Marks this item and listed related sources viewed through watermark' : '确认当前对象及列出的关联来源已阅至水位'} <code>{list.data.head}</code>{en ? ', including older pages. Later changes stay pending. Browsing does not mark anything viewed.' : '（包括更早页面）。之后的新变更仍待阅，浏览不会自动标记已阅。'}</p>
        <button type="button" disabled={acking || list.isFetching || list.data.pendingCount === 0 || !!ackError} onClick={() => void acknowledge()}>{acking ? (en ? 'Saving…' : '保存中…') : (en ? 'Mark these changes viewed' : '已阅这些变更')}</button>
        {ackError && <p role="alert">{en ? 'Could not confirm viewed changes. Refresh before retrying:' : '无法确认已阅变更，请刷新核对后重试：'} {ackError}</p>}
      </footer>
    </>}
  </section>;
}
