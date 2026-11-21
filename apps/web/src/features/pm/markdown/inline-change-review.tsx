import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChangeDiff } from '@/components/change-diff';
import { MarkdownDiff } from './markdown-diff';
import { HumanIdentity } from '../service/human-identity';
import type { ChangeComparison, ChangeHistoryTarget, ChangeSnapshot, ChangeSummary } from '../../../../../../packages/contracts/src/change-history';
import { useInlineChangeReview } from './inline-change-review-state';
import './inline-change-review.css';

const editorSelector = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"], .cm-editor, .monaco-editor, [data-inline-change-review-original]';

function visibleRegion(region: HTMLElement): boolean {
  if (!region.isConnected || region.ownerDocument.visibilityState !== 'visible' || region.closest('[hidden], [inert], [aria-hidden="true"]') || !region.getClientRects().length) return false;
  const view = region.ownerDocument.defaultView;
  if (!view) return false;
  for (let element: HTMLElement | null = region; element; element = element.parentElement) {
    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
  }
  return true;
}

function AvailableSnapshot({ snapshot, before, en }: { snapshot: ChangeSnapshot; before: boolean; en: boolean }) {
  return <div className="inline-change-review-endpoint">
    <p>{before ? (en ? 'Available before source' : '可用的之前源码') : (en ? 'Available after source' : '可用的之后源码')}</p>
    <pre>{snapshot.raw}</pre>
  </div>;
}

const emptyMetadata: Record<string, unknown> = {};

const originLabels: Record<ChangeSummary['origin'], { en: string; zh: string }> = {
  observation: { en: 'Filesystem observation', zh: '文件系统观测' },
  automation: { en: 'Automation', zh: '自动化' },
  agent: { en: 'Agent', zh: 'Agent' },
  manual: { en: 'Manual', zh: '人工' },
};

function ChangeAuthors({ items, en }: { items: ChangeSummary[]; en: boolean }) {
  const authors = useMemo(() => {
    const groups = new Map<string, { actorId: string | null; projectId: string | null; origin: ChangeSummary['origin'] }>();
    for (const item of items) {
      const key = item.actorId ? `actor:${item.actorId}` : `origin:${item.origin}`;
      if (!groups.has(key)) groups.set(key, { actorId: item.actorId, projectId: item.projectId, origin: item.origin });
    }
    return [...groups.values()];
  }, [items]);
  if (!authors.length) return null;
  return <div className="inline-change-review-authors" aria-label={en ? 'Saved change authors' : '已保存变更的修改者'}
    title={en ? 'Authors across this pending comparison. Filesystem observations have no verified account.' : '本次待阅差异涉及的修改者；文件系统观测没有可验证的账号。'}>
    <span className="inline-change-review-authors-label">{en ? 'Changed by' : '本次修改者'}</span>
    <span className="inline-change-review-authors-list">
      {authors.map(author => author.actorId
        ? <HumanIdentity key={`actor:${author.actorId}`} userId={author.actorId} projectId={author.projectId ?? undefined} size={20} />
        : <span key={`origin:${author.origin}`} className="inline-change-review-unknown-author" title={originLabels[author.origin][en ? 'en' : 'zh']}><span aria-hidden="true">?</span>{originLabels[author.origin][en ? 'en' : 'zh']}</span>)}
    </span>
  </div>;
}

function SavedComparison({ comparison, name, en, items, onReady }: { comparison: ChangeComparison; name: string; en: boolean; items: ChangeSummary[]; onReady: () => void }) {
  const { before, after, completeness } = comparison;
  const missing = !before && !after || completeness !== 'exact' && (!before || !after);
  const beforeBody = before?.body ?? '';
  const afterBody = after?.body ?? '';
  const beforeRaw = before?.raw ?? '';
  const afterRaw = after?.raw ?? '';
  const beforeMetadata = before?.metadata ?? emptyMetadata;
  const afterMetadata = after?.metadata ?? emptyMetadata;
  const bodyUnavailable = before?.body === null || after?.body === null;
  const metadataUnavailable = before?.metadata === null || after?.metadata === null;
  const parsedUnchanged = !missing && !bodyUnavailable && !metadataUnavailable && beforeBody === afterBody
    && JSON.stringify(beforeMetadata) === JSON.stringify(afterMetadata);
  const needsSource = !missing && !bodyUnavailable && (metadataUnavailable || parsedUnchanged && beforeRaw !== afterRaw);
  const [ready, setReady] = useState({ body: false, source: false });
  const bodyReady = useCallback(() => setReady(value => value.body ? value : { ...value, body: true }), []);
  const sourceReady = useCallback(() => setReady(value => value.source ? value : { ...value, source: true }), []);
  useLayoutEffect(() => {
    if (missing || ready.body && (!needsSource || ready.source)) onReady();
  }, [missing, needsSource, ready, onReady]);
  return <>
    {completeness !== 'exact' && <p className="inline-change-review-notice" role="status">{completeness === 'observed_endpoints'
      ? (en ? 'Only observed endpoints are known; intermediate edits and authors may be unknown.' : '仅记录观测端点，中间变更及作者可能未知。')
      : (en ? 'Earlier history is unavailable or has gaps. Available snapshots are not a complete edit history.' : '更早历史不可用或存在间断；可用快照不代表完整编辑历史。')}</p>}
    <ChangeAuthors items={items} en={en} />
    {missing ? <>
      <p className="inline-change-review-notice" role="status">{en ? 'A comparison endpoint was not captured. Missing content is not empty content, so no added or deleted lines are inferred.' : '一个比较端点未被采集。缺失内容不等于空内容，因此不推断新增或删除行。'}</p>
      {before && <AvailableSnapshot snapshot={before} before en={en} />}
      {after && <AvailableSnapshot snapshot={after} before={false} en={en} />}
      {!before && !after && <p>{en ? 'No captured source is available at either endpoint.' : '两个端点都没有可用的已采集源码。'}</p>}
    </> : <>
      {(!before || !after) && <p className="inline-change-review-notice" role="status">{before
        ? (en ? 'Recorded deletion · the after endpoint is known to be empty.' : '已记录的删除 · 已确认之后端点为空。')
        : (en ? 'Recorded creation · the before endpoint is known to be empty.' : '已记录的创建 · 已确认之前端点为空。')}</p>}
      {bodyUnavailable ? <>
        <p className="inline-change-review-notice" role="status">{en ? 'An endpoint body could not be parsed. The complete saved source is shown instead; no body difference is invented.' : '某个端点的正文无法解析。现展示完整已保存源码，不推断正文差异。'}</p>
        <ChangeDiff before={beforeRaw} after={afterRaw} name={name} en={en} presentation="inline" onReady={bodyReady} />
      </> : <MarkdownDiff before={beforeBody} after={afterBody} name={name} en={en} presentation="inline" onReady={bodyReady} />}
      {metadataUnavailable && <>
        <p className="inline-change-review-notice" role="status">{en ? 'Parsed metadata is unavailable at an endpoint. The retained full source is the fallback.' : '某个端点没有可解析的元数据；保留的完整源码是回退。'}</p>
        {!bodyUnavailable && <ChangeDiff before={beforeRaw} after={afterRaw} name={name} en={en} presentation="inline" onReady={sourceReady} />}
      </>}
      {parsedUnchanged && beforeRaw !== afterRaw && <>
        <p className="inline-change-review-notice">{en ? 'The parsed body is unchanged. Saved source formatting changed:' : '解析后的正文未改变，已保存源码的格式发生变化：'}</p>
        <ChangeDiff before={beforeRaw} after={afterRaw} name={name} en={en} presentation="inline" onReady={sourceReady} />
      </>}
    </>}
  </>;
}

/** Reviews already-saved changes in this body only; the original editor stays mounted. */
export function InlineChangeReview({ workspaceId, target, currentRevision, en, enabled = true, dirty = false, suppressCreationBy = null, children }: {
  workspaceId: string;
  target: ChangeHistoryTarget;
  currentRevision: string;
  en: boolean;
  enabled?: boolean;
  dirty?: boolean;
  suppressCreationBy?: string | null;
  children: ReactNode;
}) {
  const review = useInlineChangeReview({ workspaceId, target, currentRevision, enabled });
  const regionRef = useRef<HTMLElement>(null);
  const renderedSnapshot = useRef<string | null>(null);
  const inFlight = useRef(false);
  const composing = useRef(false);
  const [originalFor, setOriginalFor] = useState<string | null>(null);
  const [renderedFor, setRenderedFor] = useState<string | null>(null);
  const id = useId();
  const scope = JSON.stringify([workspaceId, target, currentRevision]);
  const snapshot = JSON.stringify([scope, review.page?.observationToken, review.page?.head, review.comparison?.fromChangeId, review.comparison?.toChangeId, review.comparison?.before?.revision, review.comparison?.after?.revision]);
  const onComparisonReady = useCallback(() => setRenderedFor(snapshot), [snapshot]);
  const pendingItems = useMemo(() => {
    const page = review.page;
    if (!page) return [];
    const reviewed = BigInt(page.reviewedThrough), head = BigInt(page.head);
    return page.items.filter(item => item.completeness !== 'baseline' && BigInt(item.sequence) > reviewed && BigInt(item.sequence) <= head);
  }, [review.page]);
  // Display-only: the current actor's own creation remains in saved history; only the automatic inline diff is withheld.
  const selfCreation = !!suppressCreationBy && !!review.comparison && !review.comparison.before && pendingItems.length === 1 && pendingItems[0]?.actorId === suppressCreationBy;
  const pending = enabled && !!review.page && review.page.pendingCount > 0 && !selfCreation;
  const comparison = enabled && !review.error ? review.comparison : undefined;
  const showOriginal = originalFor === snapshot;
  const diffVisible = pending && !!comparison && !review.loading && !dirty && !showOriginal;
  const canAccept = diffVisible && renderedFor === snapshot && review.canAccept && !review.loading && !review.refreshing && !review.accepting && !review.error && !dirty;
  const showToolbar = enabled && (pending || review.loading || review.refreshing || !!review.error);
  const name = target.kind === 'core' ? target.entityId : target.path;

  useLayoutEffect(() => {
    renderedSnapshot.current = diffVisible && renderedFor === snapshot ? snapshot : null;
    if (!diffVisible) setRenderedFor(null);
    return () => { renderedSnapshot.current = null; };
  }, [diffVisible, snapshot, renderedFor]);

  function acceptanceAllowed(): boolean {
    const region = regionRef.current;
    return canAccept && !inFlight.current && renderedSnapshot.current === snapshot && !!region && visibleRegion(region);
  }

  async function accept(): Promise<void> {
    if (!acceptanceAllowed()) return;
    inFlight.current = true;
    try {
      await review.accept();
    } finally {
      inFlight.current = false;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.key !== 'Enter' || !event.shiftKey || event.altKey || event.ctrlKey === event.metaKey
      || event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current || !acceptanceAllowed()) return;
    const region = regionRef.current;
    if (!region || !region.contains(region.ownerDocument.activeElement) || !(event.target instanceof Element)
      || !region.contains(event.target) || event.target.closest('[data-inline-change-review]') !== region) return;
    if (event.nativeEvent.composedPath().some(element => element instanceof Element && element.matches(editorSelector))) return;
    event.preventDefault();
    event.stopPropagation();
    void accept();
  }

  return <section ref={regionRef} className="inline-change-review" data-inline-change-review="" aria-label={en ? 'Saved changes in this content' : '当前正文的已保存变更'}
    tabIndex={pending ? 0 : -1} onKeyDown={onKeyDown} onCompositionStartCapture={() => { composing.current = true; }} onCompositionEndCapture={() => { composing.current = false; }}>
    {showToolbar && <div className="inline-change-review-toolbar" aria-busy={review.loading || review.refreshing || review.accepting}>
      <span className="inline-change-review-count" role="status">{review.error ? (en ? 'Saved changes unavailable' : '已保存变更不可用')
        : review.loading ? (en ? 'Loading saved changes…' : '正在加载已保存变更…')
        : review.accepting ? (en ? 'Marking reviewed…' : '正在标记已阅…')
        : review.refreshing ? (en ? 'Refreshing saved changes…' : '正在刷新已保存变更…')
        : en ? `${review.page?.pendingCount ?? 0} saved changes to review` : `${review.page?.pendingCount ?? 0} 条已保存变更待阅`}</span>
      <div className="inline-change-review-actions">
        {pending && comparison && <button type="button" disabled={dirty || review.loading || review.accepting} aria-controls={`${id}-saved`} aria-expanded={diffVisible}
          onClick={() => setOriginalFor(diffVisible ? snapshot : null)}>{diffVisible ? (en ? 'Show original content' : '显示原正文') : (en ? 'Show saved differences' : '显示已保存差异')}</button>}
        <button type="button" disabled={review.loading || review.refreshing || review.accepting} onClick={review.refresh}>{en ? 'Refresh' : '刷新'}</button>
        {pending && <button type="button" className="inline-change-review-accept" disabled={!canAccept} onClick={() => void accept()}
          aria-describedby={`${id}-scope`} aria-keyshortcuts="Control+Shift+Enter Meta+Shift+Enter">{en ? 'Accept all' : '接受全部'}<kbd>Ctrl/⌘ ⇧ ↵</kbd></button>}
      </div>
      {pending && <p id={`${id}-scope`} className="inline-change-review-scope">{en ? 'This item only · marks displayed saved changes reviewed, without saving content.' : '仅当前对象 · 标记显示的已保存变更为已阅，不会保存正文。'}</p>}
      {dirty && pending && <p className="inline-change-review-notice" role="status">{en ? 'Your unsaved draft stays visible and is not compared. Save or discard it explicitly before reviewing saved differences.' : '未保存草稿保持可见，不参与比较。请显式保存或放弃草稿后再审阅已保存差异。'}</p>}
      {showOriginal && pending && !dirty && <p className="inline-change-review-scope">{en ? 'Original content is visible. Show saved differences to accept them; switching views never marks anything reviewed.' : '正在显示原正文。显示已保存差异后才能接受；切换显示不会标记已阅。'}</p>}
      {review.error && <p className="inline-change-review-notice" role="alert">{en ? 'Could not load or acknowledge saved changes. Refresh before trying again; your content is unchanged.' : '无法加载或确认已保存变更。请刷新后重试；正文未被修改。'}</p>}
    </div>}
    {diffVisible && comparison && <div id={`${id}-saved`} className="inline-change-review-diff" aria-label={en ? 'Saved inline differences' : '已保存的行内差异'} tabIndex={0}>
      {review.page?.completeness !== 'complete_since_capture' && comparison.completeness === 'exact' && <p className="inline-change-review-notice" role="status">{review.page?.completeness === 'observer_gap'
        ? (en ? 'Observation has gaps; intermediate versions may be unavailable.' : '观测存在间断，中间版本可能不可用。')
        : (en ? 'History before the captured baseline is unavailable.' : '采集基线之前的历史不可用。')}</p>}
      <SavedComparison key={snapshot} comparison={comparison} name={name} en={en} items={pendingItems} onReady={onComparisonReady} />
    </div>}
    <div className="inline-change-review-original" data-inline-change-review-original="" hidden={diffVisible} inert={diffVisible} aria-hidden={diffVisible || undefined}>{children}</div>
  </section>;
}
