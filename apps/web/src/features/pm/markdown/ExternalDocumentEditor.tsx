import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useBlocker } from 'react-router-dom';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { ArrowLeft, FilePlus2, LoaderCircle, RefreshCw, Save } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RadixSelect } from '@/components/ui/radix-select';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import type { DocumentSource, DocumentSourceMutation } from '../../../../../../packages/contracts/src/document-sources';
import { useCoreSession, type CoreSession } from './session';
import { MarkdownUrlImage, MarkdownUrlLink } from './preview-url-components';
import { documentSourceAccessLost, documentSourceError, DocumentSourceRequestError, mutateDocumentSource, readAuthorizedDocumentSourceContent, readDocumentSourceMutation, readDocumentSources } from './document-sources-api';
import { createExternalDocumentStore, externalDocumentKey, validExternalMarkdownPath, type ExternalDocumentStore, type ExternalManagementIntent, type ExternalTarget } from './external-document-state';
import { ChangeHistoryPanel } from './change-history';
import { useLocation } from 'react-router';
import './external-document-editor.css';

const stores = new Map<string, { namespace: string; host: string; actor: string; store: ExternalDocumentStore }>();
const activeActors = new Map<string, string>();
function externalStore(session: CoreSession) {
  const host = session.queryKey[1], actor = `${session.queryKey[2]}:${session.queryKey[6]}`;
  activeActors.set(host, actor);
  const existing = stores.get(session.scope);
  if (existing) return existing.store;
  for (const [scope, value] of stores) if (value.host === host && value.actor !== actor || value.namespace === session.namespace && scope !== session.scope) { value.store.clearSource(); stores.delete(scope); }
  const workspaceId = session.queryKey[3];
  const store: ExternalDocumentStore = createExternalDocumentStore({ storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }, storageKey: session.storageKey('external-document-operations'), current: () => activeActors.get(host) === actor && stores.get(session.scope)?.store === store, mutate: (sourceId, input) => mutateDocumentSource(workspaceId, sourceId, input), reconcile: (sourceId, id) => readDocumentSourceMutation(workspaceId, sourceId, id) });
  stores.set(session.scope, { namespace: session.namespace, host, actor, store });
  // The handler outlives the document route: a deliberately kept in-memory draft
  // must still protect a later reload elsewhere in this same scoped PM session.
  const protect = (event: BeforeUnloadEvent) => {
    if (activeActors.get(host) !== actor || stores.get(session.scope)?.store !== store) { store.clearSource(); window.removeEventListener('beforeunload', protect); return; }
    if (store.protected()) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', protect);
  return store;
}
export function useExternalDocumentSession() {
  const session = useCoreSession();
  const store = useMemo(() => externalStore(session), [session.scope]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, snapshot };
}
export function useExternalDocumentLeaveProtection(store: ExternalDocumentStore, en: boolean) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => store.protected() && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm(en ? 'External document drafts remain only in this browser session; reloading or closing it loses unsaved text. Pending operation IDs are retained for reconciliation, not replay. Leave this page and keep the in-memory drafts?' : '外部文档草稿仅保留在当前浏览器会话，刷新或关闭会丢失未保存正文。未决操作只保留编号以核对，不会重发。确定离开并保留内存草稿吗？')) blocker.proceed();
    else blocker.reset();
  }, [blocker, en]);
}
const sourceExtensions = [markdown(), EditorView.lineWrapping, EditorView.theme({ '&': { background: 'var(--background)', color: 'var(--foreground)', fontSize: '13px' }, '.cm-content': { minHeight: '280px', padding: '16px 0' }, '.cm-scroller': { fontFamily: 'var(--font-mono, monospace)', lineHeight: '1.7' }, '.cm-gutters': { background: 'var(--surface)', color: 'var(--muted-foreground)', borderRight: '1px solid var(--border)' }, '&.cm-focused': { outline: '2px solid var(--ring)', outlineOffset: '-2px' } })];
const externalMarkdownComponents = { a: MarkdownUrlLink, img: MarkdownUrlImage };
export function ExternalMarkdownPreview({ value, en }: { value: string; en: boolean }) {
  const prefix = `external-md-${useId().replace(/[^a-zA-Z0-9]/g, '')}-`;
  return <article className="markdown-preview document-source-markdown" data-testid="external-document-preview"><ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} skipHtml remarkRehypeOptions={{ clobberPrefix: prefix }} components={externalMarkdownComponents} urlTransform={url => /^(?:https?:|mailto:)/i.test(url) ? url : ''}>{value}</ReactMarkdown>{!value && <p className="document-source-hint">{en ? 'This Markdown file is empty.' : '此 Markdown 文件正文为空。'}</p>}</article>;
}

export function ExternalOperationNotices({ en, onOpen, onManage }: { en: boolean; onOpen?: (target: ExternalTarget) => void; onManage?: (intent: ExternalManagementIntent) => void }) {
  const { store, snapshot } = useExternalDocumentSession();
  const dirty = Object.values(snapshot.drafts).filter(draft => draft.value !== draft.base.content);
  return <div className="external-document-notices">
    {(dirty.length > 0 || Object.values(snapshot.forms).some(form => !!form.path || !!form.content)) && <div className="document-source-warning" role="status"><p>{en ? 'Unsaved external drafts are kept in memory only. Switching tabs preserves them; reload or closing this browser loses unsaved text. Save explicitly before reloading.' : '外部未保存草稿仅存于内存。切换标签会保留；刷新或关闭浏览器会丢失未保存正文，请先显式保存。'}</p>{onOpen && dirty.map(draft => <button type="button" className="text-button" key={externalDocumentKey(draft.target)} onClick={() => onOpen(draft.target)}>{en ? 'Reopen draft' : '重开草稿'} · {draft.target.path}</button>)}{onManage && Object.entries(snapshot.forms).filter(([, form]) => form.intent && (!!form.path || !!form.content)).map(([key, form]) => <button type="button" className="text-button" key={key} onClick={() => { if (form.intent) onManage(form.intent); }}>{en ? 'Recover operation form' : '恢复文件操作表单'} · {form.path}</button>)}</div>}
    {snapshot.notice && <p className="document-source-warning" role="status">{snapshot.notice === 'journal_unavailable' ? en ? 'Operation recovery storage is unavailable. No new write was sent. Restore browser storage before saving.' : '操作恢复存储不可用，本次没有发送新的写入。请恢复浏览器存储后保存。' : snapshot.notice === 'access_cleared' ? en ? 'A source changed or access was revoked. Its cached plaintext and drafts were cleared for security; pending operation identities remain.' : '来源变更或权限已撤销，为安全起见已清除其缓存正文和草稿，未决操作编号仍保留。' : snapshot.notice === 'succeeded_unreadable' ? en ? 'The original operation succeeded, but current source boundaries no longer authorize its content. Cached plaintext was cleared; the operation will not be repeated.' : '原操作已成功，但当前来源边界已不允许读取其正文。已清除缓存正文，不会重复操作。' : snapshot.notice === 'succeeded' ? en ? 'The operation was confirmed successful. The authorized file list has been refreshed.' : '操作已确认成功，已刷新授权文件列表。' : en ? 'The original operation was authoritatively not applied. Your draft is retained; review it before an explicit new attempt.' : '已权威确认原操作未生效，草稿仍保留。请核对后再显式发起新操作。'}</p>}
    {snapshot.operations.map(operation => <div key={operation.operationId} className="document-source-warning" role="alert"><strong>{operation.action} · {operation.sourceId}</strong><code>{operation.operationId}</code><p>{operation.phase === 'pending' ? en ? 'Waiting for this operation or its authoritative receipt…' : '正在等待此操作或其权威收据…' : en ? 'Result unknown. Writes to affected sources are blocked. Query the original operation; do not repeat the mutation.' : '结果未知，已暂停受影响来源的写入。请查询原操作，不要重复提交。'}</p>{operation.error != null && <p>{documentSourceError(operation.error, en)}</p>}<button type="button" className="secondary-button" disabled={operation.phase === 'pending'} onClick={() => void store.reconcile(operation.operationId)}><RefreshCw size={14} />{en ? 'Check original operation' : '核对原操作'}</button></div>)}
  </div>;
}

export function ExternalDocumentEditor({ target, en, onBack, onDenied, refreshKey = 0, onManage }: { target: ExternalTarget; en: boolean; onBack?: () => void; onDenied?: (cause: unknown) => void; refreshKey?: number | string; onManage?: (intent: ExternalManagementIntent) => void }) {
  const session = useCoreSession();
  const { store, snapshot } = useExternalDocumentSession();
  const key = externalDocumentKey(target);
  const [generation, setGeneration] = useState(0);
  const readKey = `${session.scope}:${key}:${refreshKey}:${generation}`;
  const [read, setRead] = useState<{ key: string; ready: boolean; error: string; missing?: boolean }>({ key: '', ready: false, error: '' });
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const historyRequested = params.get('panel') === 'changes';
  const changeId = params.get('changeId') || undefined;
  const [historyOpen, setHistoryOpen] = useState(historyRequested);
  useEffect(() => { setHistoryOpen(historyRequested); }, [historyRequested, changeId, key]);
  const denied = useRef(onDenied); denied.current = onDenied;
  const heading = useRef<HTMLHeadingElement>(null);
  const [menuRevision, setMenuRevision] = useState<string | null>(null);
  const draft = snapshot.drafts[key];
  const extensions = useMemo(() => [...sourceExtensions, EditorView.contentAttributes.of({ 'aria-label': en ? 'External document source' : '外部文档源码' })], [en]);
  const reload = useCallback(() => setGeneration(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setRead({ key: readKey, ready: false, error: '' });
    void readAuthorizedDocumentSourceContent(session.queryKey[3], target, controller.signal).then(({ source, content }) => {
      if (controller.signal.aborted || !session.isCurrent()) return;
      store.receive(target, source, content); setRead({ key: readKey, ready: true, error: '' });
    }).catch(cause => {
      if (controller.signal.aborted) return;
      if (documentSourceAccessLost(cause)) { store.clearSource(target.sourceId); denied.current?.(cause); }
      setRead({ key: readKey, ready: false, error: documentSourceError(cause, en), missing: cause instanceof DocumentSourceRequestError && cause.code === 'document_source_file_not_found' });
    });
    return () => controller.abort();
  }, [readKey, session, store, target.sourceId, target.revision, target.path, en]);
  useEffect(() => {
    const focus = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [reload]);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [key]);
  const ready = read.key === readKey && read.ready && !!draft;
  const dirty = !!draft && draft.value !== draft.base.content;
  const pending = store.blocks(target.sourceId);
  const writable = ready && draft.source.canWrite && draft.base.canWrite;
  const save = async (expectedRevision = draft?.base.revision) => {
    if (!writable || !dirty || pending || draft.observed) return;
    if (expectedRevision !== draft.base.revision) { setError(en ? 'The file revision changed. Reopen the menu before saving.' : '文件版本已改变，请重新打开菜单后保存。'); return; }
    setError('');
    try {
      await store.submit(target.sourceId, { operationId: crypto.randomUUID(), sourceRevision: target.revision, action: 'save', path: target.path, expectedRevision: draft.base.revision, content: draft.value });
      window.dispatchEvent(new Event('external-documents-changed'));
    } catch (cause) {
      setError(documentSourceError(cause, en));
      if (documentSourceAccessLost(cause)) { reload(); window.dispatchEvent(new Event('external-documents-changed')); }
    }
  };
  const managementReason = !writable ? en ? 'This file is read only or unavailable' : '此文件为只读或不可用' : pending ? en ? 'Reconcile the pending operation first' : '请先核对未决操作' : dirty ? en ? 'Save or explicitly discard the draft first' : '请先保存或明确放弃草稿' : draft?.observed ? en ? 'Compare the changed disk version first' : '请先对照已改变的磁盘版本' : undefined;
  const managementActions = (['rename', 'move', 'delete'] as const).map(action => ({
    action,
    label: action === 'rename' ? en ? 'Rename' : '重命名' : action === 'move' ? en ? 'Move' : '移动' : en ? 'Delete file' : '删除文件',
    select: () => { if (!managementReason) onManage?.({ action, target }); },
  }));
  return <section className="external-document-content" aria-label={en ? 'External document' : '外部文档'} aria-busy={read.key !== readKey || !read.ready && !read.error} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); } }}>
    <header className="document-source-content-heading">
      {onBack && <button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={14} />{en ? 'Back to files' : '返回目录'}</button>}
      <ContextMenu onOpenChange={open => { if (open) setMenuRevision(draft?.base.revision ?? null); }}><ContextMenuTrigger asChild><div tabIndex={0}><h3 ref={heading} tabIndex={-1}>{ready ? target.path.split('/').at(-1) : en ? 'External document' : '外部文档'}</h3><p>{ready && `${draft.source.name} · `}{en ? 'External documents' : '外部文档'}{ready && !writable ? en ? ' · Read only' : ' · 只读' : ''}{dirty && ready ? en ? ' · Unsaved' : ' · 未保存' : ''}</p>{ready && <code>{target.path}</code>}</div></ContextMenuTrigger><ContextMenuContent aria-label={en ? 'External document actions' : '外部文档操作'}>
        <ContextMenuItem disabled={!writable || !dirty || pending || !!draft?.observed} title={pending ? en ? 'Reconcile the pending operation first' : '请先核对未决操作' : draft?.observed ? en ? 'Compare the disk revision first' : '请先对照磁盘版本' : undefined} onSelect={() => void save(menuRevision ?? undefined)}>{en ? 'Save' : '保存'}</ContextMenuItem>
        <ContextMenuItem disabled={!ready} onSelect={() => setPreview(value => !value)}>{preview ? en ? 'Edit Markdown' : '编辑 Markdown' : en ? 'Preview' : '预览'}</ContextMenuItem>
        <ContextMenuItem onSelect={reload}>{en ? 'Reload file from disk' : '从磁盘重新读取'}</ContextMenuItem>
        {onManage && <><ContextMenuSeparator />{managementActions.map(action => <ContextMenuItem key={action.action} disabled={!!managementReason} title={managementReason} onSelect={action.select}>{action.label}</ContextMenuItem>)}</>}
      </ContextMenuContent></ContextMenu>
      <button type="button" className="secondary-button" onClick={reload}><RefreshCw size={14} />{en ? 'Refresh file' : '刷新文件'}</button>
      {ready && <button type="button" className="secondary-button" aria-pressed={preview} onClick={() => setPreview(value => !value)}>{preview ? en ? 'Edit Markdown' : '编辑 Markdown' : en ? 'Preview' : '预览'}</button>}
      {writable && <button type="button" className="primary-button" disabled={!dirty || pending || !!draft.observed} onClick={() => void save()}><Save size={14} />{en ? 'Save' : '保存'}</button>}
      {ready && <button type="button" className="secondary-button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}>{en ? 'Changes' : '变更记录'}</button>}
    </header>
    {/* Keep the observed watermark across focus revalidation; hide stale content and discard it on an authorization error. */}
    {historyOpen && !read.error && <div hidden={!ready}><ChangeHistoryPanel key={key} workspaceId={session.queryKey[3]} target={{ kind: 'external', sourceId: target.sourceId, path: target.path }} en={en} initialChangeId={changeId} onClose={() => setHistoryOpen(false)} /></div>}
    {ready && <p className="document-source-resource-notice">{en ? 'Editing, moving or deleting this physical file affects every folder association that refers to it.' : '编辑、移动或删除此真实文件，会影响所有引用它的文件夹关联。'}</p>}
    {ready && onManage && <div className="external-document-actions"><button type="button" className="secondary-button" disabled={!writable || pending} onClick={() => onManage({ action: 'create', sourceId: target.sourceId })}><FilePlus2 size={14} />{en ? 'New file' : '新建文件'}</button>{managementActions.map(action => <button type="button" className="secondary-button" key={action.action} disabled={!!managementReason} title={managementReason} onClick={action.select}>{action.label}</button>)}{dirty && <button type="button" className="text-button" disabled={pending} onClick={() => { if (window.confirm(en ? 'Discard this unsaved external document draft and read the current file?' : '确定放弃此未保存的外部文档草稿并读取当前文件吗？')) { store.discard(target); reload(); } }}>{en ? 'Discard draft' : '放弃草稿'}</button>}</div>}
    {(error || read.key === readKey && read.error) && <div className="document-source-state document-source-error" role="alert"><p>{error || read.error}</p><button type="button" className="secondary-button" onClick={reload}>{en ? 'Recheck source and file' : '重新核对来源及文件'}</button></div>}
    {read.key === readKey && read.missing && draft && dirty && <div className="document-source-warning">
      <p>{en ? 'The disk file is missing, but this authorized source’s unsaved draft is retained below. Recover it through an explicit new-file operation; a reappearing file will never be overwritten.' : '磁盘文件已不存在，此授权来源内的未保存草稿仍保留在下方。可显式新建文件恢复；如果文件重新出现，绝不会覆盖。'}</p>
      <CodeMirror value={draft.value} extensions={extensions} readOnly editable={false} />
      {onManage && <button type="button" className="secondary-button" disabled={pending} onClick={() => {
        const previous = snapshot.forms.create;
        if (previous && (previous.path || previous.content) && (previous.path !== target.path || previous.content !== draft.value) && !window.confirm(en ? 'Replace the unsaved new-file form with this recovered draft?' : '确定以此恢复草稿替换尚未提交的新建文件表单吗？')) return;
        const intent: ExternalManagementIntent = { action: 'create', sourceId: target.sourceId };
        store.form('create', { sourceId: target.sourceId, path: target.path, content: draft.value, intent });
        onManage(intent);
      }}>{en ? 'Recover draft as new file' : '将草稿恢复为新文件'}</button>}
      <button type="button" className="text-button" disabled={pending} onClick={() => { if (window.confirm(en ? 'Permanently discard this in-memory draft?' : '确定永久放弃此内存草稿吗？')) store.discard(target); }}>{en ? 'Discard draft' : '放弃草稿'}</button>
    </div>}
    {!ready ? read.key !== readKey || !read.error ? <p className="document-source-state" role="status"><LoaderCircle size={16} className="spin" />{en ? 'Rechecking access and reading the file. Any draft is retained, not replaced.' : '正在核对权限并读取文件；已有草稿仍保留，不会被覆盖。'}</p> : null
      : <><p className="document-source-resource-notice">{en ? 'Plain Markdown is preserved without PM IDs or frontmatter. Preview disables raw HTML, relative resources and PM embeds. Save explicitly with Ctrl/⌘+S.' : '保留普通 Markdown，不插入 PM ID 或 frontmatter。预览禁用原始 HTML、相对资源及 PM 嵌入。按 Ctrl/⌘+S 显式保存。'}</p>{draft.observed && <div className="document-source-warning" role="alert"><p>{en ? 'The disk version changed. Your draft is unchanged and saving is blocked. Compare the latest content below, then explicitly adopt its revision while retaining your text.' : '磁盘版本已改变，草稿未变且暂停保存。请对照下方最新内容，再显式采用其版本并保留本地正文。'}</p><details><summary>{en ? 'Latest disk content' : '最新磁盘正文'}</summary><pre className="external-document-comparison">{draft.observed.content}</pre></details><button type="button" className="secondary-button" disabled={pending || !writable} onClick={() => { if (window.confirm(en ? 'Use this observed revision as the save baseline, keeping your draft? A later Save will replace that version with your text.' : '确定采用已核对版本为保存基线并保留草稿？之后点击保存会以草稿正文替换该版本。')) store.adopt(target); }}>{en ? 'Adopt revision; keep my text' : '采用版本并保留我的正文'}</button></div>}{preview || !writable ? <ExternalMarkdownPreview value={draft.value} en={en} /> : <CodeMirror value={draft.value} extensions={extensions} editable={!pending} readOnly={pending} onChange={value => store.edit(target, value)} aria-label={en ? 'External document source' : '外部文档源码'} basicSetup={{ foldGutter: true, highlightActiveLine: false, highlightActiveLineGutter: false }} />}</>}
  </section>;
}

export function ExternalDocumentManagementDialog({ intent, sources, sourcesReady = true, en, onClose }: { intent: ExternalManagementIntent; sources: readonly DocumentSource[]; sourcesReady?: boolean; en: boolean; onClose: () => void }) {
  const session = useCoreSession();
  const { store, snapshot } = useExternalDocumentSession();
  const target = intent.action === 'create' ? undefined : intent.target;
  const formKey = target ? `${intent.action}:${externalDocumentKey(target)}` : 'create';
  const retained = snapshot.forms[formKey];
  const [sourceId, setSourceId] = useState(retained?.sourceId || (intent.action === 'create' ? intent.sourceId : intent.target.sourceId));
  const originalSourceId = intent.action === 'create' ? sourceId : intent.target.sourceId;
  const [path, setPath] = useState(retained?.path ?? (intent.action === 'rename' ? target?.path.split('/').at(-1) || '' : target?.path || ''));
  const [content, setContent] = useState(retained?.content || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!target);
  const [authorized, setAuthorized] = useState(!target);
  const source = sources.find(item => item.sourceId === originalSourceId);
  const destination = sources.find(item => item.sourceId === sourceId);
  const [destinationRevision, setDestinationRevision] = useState(destination?.revision);
  const authorizedSource = sourcesReady && !!source && (!target || source.revision === target.revision) && authorized;
  const extensions = useMemo(() => [...sourceExtensions, EditorView.contentAttributes.of({ 'aria-label': en ? 'New external document content' : '新建外部文档正文' })], [en]);
  const draft = target ? snapshot.drafts[externalDocumentKey(target)] : undefined;
  const [submitting, setSubmitting] = useState(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const busy = submitting || store.blocks(originalSourceId) || store.blocks(sourceId);
  useEffect(() => {
    if (!sourcesReady) return;
    if (!source || target && source.revision !== target.revision) { setPath(''); setContent(''); setAuthorized(false); }
  }, [sourcesReady, source?.revision, target?.revision]);
  useEffect(() => {
    if (!snapshot.completions.some(completion => completion.sourceId === originalSourceId && completion.receipt.status === 'succeeded' && completion.receipt.path === (target?.path || path) && completion.receipt.action === (intent.action === 'rename' ? 'move' : intent.action))) return;
    store.form(formKey);
    onClose();
  }, [snapshot.completions, formKey, originalSourceId, target?.path, path, intent.action, store, onClose]);
  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    void readAuthorizedDocumentSourceContent(session.queryKey[3], target, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      store.receive(target, result.source, result.content); setAuthorized(true); setLoading(false);
    }).catch(cause => {
      if (controller.signal.aborted) return;
      if (documentSourceAccessLost(cause)) store.clearSource(originalSourceId);
      setError(documentSourceError(cause, en)); setLoading(false); setAuthorized(false);
    });
    return () => controller.abort();
  }, [target?.sourceId, target?.revision, target?.path, session.scope]);
  useEffect(() => {
    // Form recovery is in memory only, like file drafts. Closing it explicitly
    // confirms discard; unknown operations retain their frozen input separately.
    if (intent.action !== 'delete' && source && (!target || authorized && source.revision === target.revision)) store.form(formKey, { sourceId, path, content, intent });
  }, [formKey, sourceId, path, content, intent.action, store, source?.revision, authorized]);
  const close = () => {
    if (submitting) return;
    if ((path || content) && intent.action !== 'delete' && !window.confirm(en ? 'Discard this unsaved file-operation form? Existing file drafts and unresolved operation IDs are kept.' : '确定放弃此未提交的文件操作表单？已有文件草稿和未决操作编号仍保留。')) return;
    store.form(formKey); onClose();
  };
  const targetPath = intent.action === 'rename' && target ? [...target.path.split('/').slice(0, -1), path].join('/') : path;
  const dirtyFile = !!draft && draft.value !== draft.base.content;
  const allowed = sourcesReady && !busy && !loading && authorized && !!source?.canWrite && source.status === 'available' && (!target || source.revision === target.revision) && (intent.action === 'create' || !!draft?.base.canWrite && !dirtyFile && !draft.observed) && (intent.action === 'delete' || !!destination?.canWrite && destination.status === 'available' && destination.revision === destinationRevision);
  const submit = async () => {
    if (!allowed) return;
    if (intent.action !== 'delete' && (!validExternalMarkdownPath(targetPath) || intent.action === 'rename' && path.includes('/'))) { setError(en ? 'Use a relative .md path with no empty, dot, parent, backslash or absolute segments. Rename accepts a filename only.' : '请输入相对 .md 路径，不可包含空段、点、上级、反斜杠或绝对路径。重命名只能填写文件名。'); return; }
    if (intent.action === 'delete' && !deleteConfirmed) return;
    if ((intent.action === 'move' || intent.action === 'rename') && target && sourceId === target.sourceId && targetPath === target.path) { setError(en ? 'Choose a different destination.' : '请选择不同的目标路径。'); return; }
    setSubmitting(true); setError('');
    try {
      // Recheck source authorization/configuration before dispatch without replacing the file
      // CAS baseline or silently rebasing a conflicting draft.
      const current = await readDocumentSources(session.queryKey[3], new AbortController().signal);
      store.authorize(current.sources);
      const actual = current.sources.find(item => item.sourceId === originalSourceId);
      const actualDestination = current.sources.find(item => item.sourceId === sourceId);
      if (!actual?.canWrite || actual.status !== 'available' || actual.revision !== (target?.revision ?? destinationRevision) || intent.action !== 'delete' && (!actualDestination?.canWrite || actualDestination.status !== 'available' || actualDestination.revision !== destinationRevision)) throw new DocumentSourceRequestError(409, 'document_source_changed');
      const common = { operationId: crypto.randomUUID(), sourceRevision: actual.revision, path: target?.path || targetPath };
      let input: DocumentSourceMutation;
      if (intent.action === 'create') input = { ...common, action: 'create', content };
      else if (intent.action === 'delete' && draft) input = { ...common, action: 'delete', expectedRevision: draft.base.revision };
      else if (draft && actualDestination) input = { ...common, action: 'move', expectedRevision: draft.base.revision, targetSourceId: sourceId, targetSourceRevision: actualDestination.revision, targetPath };
      else return;
      const receipt = await store.submit(originalSourceId, input);
      if (receipt?.status === 'succeeded') { store.form(formKey); window.dispatchEvent(new Event('external-documents-changed')); onClose(); }
    } catch (cause) { setError(documentSourceError(cause, en)); }
    finally { setSubmitting(false); }
  };
  const title = intent.action === 'create' ? en ? 'New Markdown file' : '新建 Markdown 文件' : intent.action === 'rename' ? en ? 'Rename Markdown file' : '重命名 Markdown 文件' : intent.action === 'move' ? en ? 'Move Markdown file' : '移动 Markdown 文件' : en ? 'Delete Markdown file' : '删除 Markdown 文件';
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="document-source-dialog external-management-dialog"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{intent.action === 'delete' ? en ? 'This permanently deletes the actual external file, not just its tab. It cannot be undone here. Confirm the path before deletion.' : '此操作会永久删除真实的外部文件，而非仅关闭标签页；无法在此撤销。请先确认路径。' : en ? 'Use a path relative to a configured source. Missing parent folders can be created inside that source; existing files are never overwritten. Plain Markdown stays separate from PM document entities.' : '使用已配置来源内的相对路径，可在来源内创建缺少的父文件夹，不覆盖现有文件。普通 Markdown 不转换为PM文档对象。'}</DialogDescription></DialogHeader>
    <form className="document-source-form" onSubmit={event => { event.preventDefault(); void submit(); }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}>
      <p className="document-source-hint">{en ? 'File changes affect all references to the same physical location. Removing a folder association in settings does not delete its files.' : '文件变更会影响同一真实位置的全部引用；在设置中解除文件夹关联不会删除磁盘文件。'}</p>
      {target && authorizedSource && <code>{originalSourceId} · {target.path}</code>}
      {(intent.action === 'create' || intent.action === 'move') && <label className="document-source-field">{en ? 'Destination source' : '目标来源'}<RadixSelect value={sourceId} disabled={busy || !sourcesReady} onChange={event => { setSourceId(event.target.value); setDestinationRevision(sources.find(item => item.sourceId === event.target.value)?.revision); if (intent.action === 'create') setAuthorized(true); }}>{!destination && <option value={sourceId}>{en ? 'Source unavailable' : '来源不可用'}</option>}{sources.filter(item => item.status === 'available' && item.canWrite).map(item => <option key={item.sourceId} value={item.sourceId}>{item.name} · {item.projectId || (en ? 'Workspace common documents' : '工作区公共文档')} · {item.path || item.sourceId}</option>)}</RadixSelect></label>}
      {authorizedSource && intent.action !== 'delete' && <label className="document-source-field">{intent.action === 'rename' ? en ? 'New filename' : '新文件名' : en ? 'Relative Markdown path' : 'Markdown 相对路径'}<input value={path} disabled={busy} autoFocus placeholder={en ? 'notes/new-file.md' : '笔记/新文件.md'} onChange={event => setPath(event.target.value)} /></label>}
      {authorizedSource && intent.action === 'create' && <label className="document-source-field">{en ? 'Initial Markdown' : '初始 Markdown'}<CodeMirror value={content} extensions={extensions} editable={!busy} readOnly={busy} onChange={setContent} aria-label={en ? 'New external document content' : '新建外部文档正文'} /></label>}
      {sourcesReady && destination && destination.revision !== destinationRevision && intent.action !== 'delete' && <div role="alert"><p>{en ? 'Destination configuration changed. Review the selected source before adopting its current configuration.' : '目标来源配置已改变，请核对选中的来源后，再显式采用当前配置。'}</p><button type="button" className="secondary-button" disabled={busy} onClick={() => { if (window.confirm(en ? 'Use the currently selected destination configuration for this file operation?' : '确定使用当前选中的目标来源配置进行此文件操作吗？')) { setDestinationRevision(destination.revision); if (intent.action === 'create') setAuthorized(true); } }}>{en ? 'Use current destination configuration' : '采用当前目标来源配置'}</button></div>}
      {intent.action === 'delete' && <label className="external-delete-confirmation"><input type="checkbox" checked={deleteConfirmed} disabled={busy || !authorized} onChange={event => setDeleteConfirmed(event.target.checked)} />{en ? 'I confirm permanent deletion of this file.' : '我确认永久删除此文件。'}</label>}
      {loading && <p role="status">{en ? 'Checking file revision and permissions…' : '正在核对文件版本及权限…'}</p>}
      {dirtyFile && <p role="alert" className="document-source-error">{en ? 'This file has an unsaved draft. Save it or explicitly discard it in the editor first.' : '此文件有未保存草稿，请先在编辑器中保存或明确放弃。'}</p>}
      {draft?.observed && <p role="alert" className="document-source-error">{en ? 'The disk version changed. Review the conflict in the editor first.' : '磁盘版本已改变，请先在编辑器中核对冲突。'}</p>}
      {error && <p className="document-source-error" role="alert">{error}</p>}
      {busy && <p role="status">{en ? 'An operation is pending or unknown. Use “Check original operation” before another write.' : '操作处理中或结果未知，请先核对原操作，再进行其他写入。'}</p>}
      <DialogFooter><button type="button" className="secondary-button" disabled={submitting} onClick={close}>{en ? 'Cancel' : '取消'}</button><button type="submit" className={intent.action === 'delete' ? 'secondary-button external-delete-button' : 'primary-button'} disabled={!allowed || intent.action === 'delete' && !deleteConfirmed}>{submitting && <LoaderCircle size={14} className="spin" />}{title}</button></DialogFooter>
    </form>
    {snapshot.operations.length > 0 && <ExternalOperationNotices en={en} />}
  </DialogContent></Dialog>;
}
