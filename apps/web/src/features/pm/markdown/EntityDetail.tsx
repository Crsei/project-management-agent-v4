import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation, useParams } from 'react-router';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { ArrowLeft, ArrowUpRight, AlertTriangle, Code2, FileText, Link, LoaderCircle, MoreHorizontal, Save, X } from 'lucide-react';
import type { FileRecord } from '@pm-schema';
import type { GraphQuery } from '@pm-schema/graph';
import { KnowledgeGraph, type ContextMenuAction } from '@pm-views';
import type { WorkspaceController } from './controller';
import { useDetailState, type DetailTab } from './session';
import { Diagnostics } from './Diagnostics';
import { Preview } from './Preview';
import { Properties } from './Properties';
import { TaskCompletionAction, TaskDetailSurface } from './TaskDetailSurface';
import { TaskDetailWatch } from './TaskDetailRelated';
import { DocumentContentEditor } from './DocumentContentEditor';
import { applyBodyChanges, bodyEditorText, type BodyChange } from './document-body';
import { PersonalMentionPicker } from '../service/PersonalMentionPicker';
import { EntityAgentPanelAction } from '../agent/agent-entry';
import { getDocumentEditorPosition, retainDocumentEditorPosition } from './document-workbench-state';
import { documentSaveRecovery } from './document-save-model';
import { CollectionActionMenu, CollectionContextMenu, renderCollectionContextMenu } from './CollectionContextMenu';

const HIDDEN_DETAIL_TABS: Readonly<Partial<Record<DetailTab, true>>> = { properties: true, relations: true, business: true, context: true };

export interface EntityDetailProps {
  controller: WorkspaceController;
  en: boolean;
  fullPage?: boolean;
  onClose: () => void;
  onExpand?: () => void;
  renderBusiness: (file: FileRecord) => ReactNode;
}
export function EntityDetail({ controller: c, en, fullPage = false, onClose, onExpand, renderBusiness }: EntityDetailProps) {
  const [detail, setDetail] = useDetailState();
  const location = useLocation();
  const extensions = useMemo(() => [markdown()], []);
  const graphQuery = useMemo<GraphQuery>(() => ({ centerId: c.selected?.id, depth: 1, archived: c.selected?.entity.archived ? 'include' : 'exclude' }), [c.selected?.id, c.selected?.entity.archived]);
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const [copyState, setCopyState] = useState<{ id: string; status: 'copied' | 'failed' } | null>(null);
  const [discardVersion, setDiscardVersion] = useState(0);
  const [taskSection, setTaskSection] = useState<{ id: string; section: 'delivery' | 'advanced' } | null>(null);
  const task = c.selected?.entity.entity === 'work_item' && !c.unsupported;
  const isDocument = c.selected?.entity.entity === 'document' && !c.unsupported;
  const lifecycleRef = useRef({ save: c.saveDocument, session: c.session, id: c.selectedId, isDocument });
  if (lifecycleRef.current.session.scope !== c.session.scope || lifecycleRef.current.id !== c.selectedId) lifecycleRef.current = { save: c.saveDocument, session: c.session, id: c.selectedId, isDocument };
  const documentLifecycle = lifecycleRef.current;
  documentLifecycle.save = c.saveDocument;
  documentLifecycle.isDocument = isDocument;
  const contentPane = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => { if (documentLifecycle.isDocument) void documentLifecycle.save(documentLifecycle.id, true); }, [documentLifecycle]);
  useLayoutEffect(() => {
    const position = getDocumentEditorPosition(c.session, c.selectedId, 'detail');
    if (isDocument && contentPane.current && position) contentPane.current.scrollTop = position.scrollTop;
  }, [c.session, c.selectedId, isDocument]);
  useLayoutEffect(() => {
    if (c.documentWorkbench && isDocument && detail.entityId !== c.selectedId) setDetail({ tab: 'content', entityId: c.selectedId });
  }, [c.documentWorkbench, c.selectedId, isDocument, detail.entityId, setDetail]);
  useEffect(() => {
    if (isDocument && location.hash || task && location.hash.startsWith('#comment-')) setDetail({ tab: 'content' });
  }, [isDocument, task, c.selectedId, location.hash, setDetail]);
  // Capture the original identity. Navigation cleanup flushes it even before the debounce expires.
  useEffect(() => {
    if (!isDocument || !c.draft || c.draftInvalid || c.draftParseError || c.busy || c.error || !c.canEditSourceDraft) return;
    const timer = window.setTimeout(() => { void documentLifecycle.save(documentLifecycle.id, true); }, 800);
    return () => window.clearTimeout(timer);
  }, [documentLifecycle, isDocument, c.raw, c.draft, c.draftInvalid, c.draftParseError, c.busy, c.error, c.canEditSourceDraft, c.source?.revision]);
  const sourceReadonly = !c.canEditSourceDraft;
  const documentRecovery = documentSaveRecovery(c.draft);
  // Other secondary object sections remain hidden; the graph is a shared read-only navigation surface.
  // Document source stays reachable only through draft-repair actions; source remains available for tasks and other entity kinds.
  const hiddenTab = !!HIDDEN_DETAIL_TABS[detail.tab];
  const tab: DetailTab = c.unsupported ? 'source' : (c.documentWorkbench && isDocument && detail.entityId !== c.selectedId) || hiddenTab ? 'content' : detail.tab;
  const tabs: { id: DetailTab; label: string }[] = [
    { id: 'content', label: en ? 'Content' : '内容' },
    ...(isDocument && tab !== 'source' ? [] : [{ id: 'source' as const, label: en ? 'Source' : '源码' }]),
    ...(!c.unsupported ? [{ id: 'graph' as const, label: en ? 'Graph' : '关系图' }] : []),
  ];
  useLayoutEffect(() => {
    if (!taskSection || taskSection.id !== c.selectedId || tab !== 'content') return;
    const viewport = contentPane.current;
    const target = viewport?.querySelector<HTMLElement>(taskSection.section === 'delivery' ? '.task-workflow' : '.task-advanced-properties');
    if (viewport && target) {
      if (target instanceof HTMLDetailsElement) target.open = true;
      viewport.scrollTo({ top: viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 16 });
      target.querySelector('summary')?.focus({ preventScroll: true });
    }
    setTaskSection(null);
  }, [taskSection, c.selectedId, tab]);
  function openTaskSection(section: 'delivery' | 'advanced') {
    setDetail({ tab: 'content' });
    setTaskSection({ id: c.selectedId, section });
  }
  const editTaskSource = () => setDetail({ tab: 'source' });
  async function copyTaskLink() {
    try {
      const url = new URL(`/pm/${encodeURIComponent(workspaceSlug || '')}${c.projectId ? `/projects/${encodeURIComponent(c.projectId)}` : ''}/entities/${encodeURIComponent(c.selectedId)}`, window.location.origin);
      await navigator.clipboard.writeText(url.href);
      setCopyState({ id: c.selectedId, status: 'copied' });
    } catch { setCopyState({ id: c.selectedId, status: 'failed' }); }
  }
  const openTaskPage = () => { if (onExpand) onExpand(); else c.viewProps.onOpenPage?.(c.selectedId); };
  const taskActions: ContextMenuAction[] = [
    { id: 'copy-link', label: en ? 'Copy task link' : '复制任务链接', onSelect: () => { void copyTaskLink(); } },
    { id: 'open-page', label: en ? 'Open full page · same draft' : '全页打开 · 保留草稿', disabled: fullPage || !onExpand && !c.viewProps.onOpenPage, reason: fullPage ? (en ? 'Already on the full task page' : '当前已是任务完整页面') : undefined, onSelect: openTaskPage },
    { id: 'markdown', label: en ? 'Open Markdown · shared draft' : '打开 Markdown · 共享草稿', separatorBefore: true, onSelect: editTaskSource },
    { id: 'delivery', label: en ? 'Open delivery workspace' : '进入交付工作台', disabled: !c.selected?.entity.project, reason: !c.selected?.entity.project ? (en ? 'A saved source project is required' : '需要已保存的所属项目') : undefined, onSelect: () => openTaskSection('delivery') },
    { id: 'advanced', label: en ? 'Advanced properties & lifecycle' : '高级属性与生命周期', onSelect: () => openTaskSection('advanced') },
  ];
  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    if (c.unsupported || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, tabs.findIndex(item => item.id === tab));
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[index]!.id;
    setDetail({ tab: next });
    document.getElementById(`entity-tab-${next}`)?.focus();
  }
  const sourceEditor = c.unsupported ? <textarea data-testid="unsupported-source" className="unsupported-source" aria-label={en ? 'Read-only Markdown source' : '只读 Markdown 源码'} value={c.unsupported.raw} readOnly spellCheck={false} /> : <div data-testid="source-editor" className="source-editor">{task && c.entity?.project && <PersonalMentionPicker taskId={c.selectedId} projectId={c.entity.project} disabled={sourceReadonly} onInsert={token => {
    const raw = c.session.drafts.getSnapshot()[c.selectedId]?.raw ?? c.selected?.raw ?? '';
    c.updateDraft(`${raw}${raw.endsWith('\n') ? '' : '\n'}${token}\n`);
  }} />}<CodeMirror key={`${c.selectedId}:${discardVersion}`} value={bodyEditorText(c.raw)} height="100%" extensions={extensions} onCreateEditor={editor => {
    if (!isDocument) return;
    const position = getDocumentEditorPosition(c.session, c.selectedId, 'source');
    if (position) {
      editor.dispatch({ selection: { anchor: Math.min(position.anchor, editor.state.doc.length), head: Math.min(position.head, editor.state.doc.length) } });
      requestAnimationFrame(() => { if (editor.dom.isConnected) { editor.scrollDOM.scrollTop = position.scrollTop; editor.scrollDOM.scrollLeft = position.scrollLeft; } });
    }
    const retain = () => {
      const range = editor.state.selection.main;
      retainDocumentEditorPosition(c.session, c.selectedId, 'source', { anchor: range.anchor, head: range.head, scrollTop: editor.scrollDOM.scrollTop, scrollLeft: editor.scrollDOM.scrollLeft });
    };
    editor.scrollDOM.addEventListener('scroll', retain, { passive: true });
  }} onUpdate={update => {
    if (!isDocument || !update.selectionSet) return;
    const range = update.state.selection.main;
    retainDocumentEditorPosition(c.session, c.selectedId, 'source', { anchor: range.anchor, head: range.head, scrollTop: update.view.scrollDOM.scrollTop, scrollLeft: update.view.scrollDOM.scrollLeft });
  }} onChange={(_value, change) => {
    const current = c.session.drafts.getSnapshot()[c.selectedId]?.raw ?? c.selected?.raw ?? '';
    const changes: BodyChange[] = [];
    change.changes.iterChanges((from, to, _from, _to, insert) => changes.push({ from, to, insert: insert.toString() }));
    c.updateDraft(applyBodyChanges(current, changes));
  }} editable={!sourceReadonly} readOnly={sourceReadonly} basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, highlightSelectionMatches: true }} aria-label={en ? 'Markdown source' : 'Markdown 源码'} /></div>;
  const taskSurface = task && <TaskDetailSurface key={`${c.selectedId}:${discardVersion}`} controller={c} en={en} onEditSource={editTaskSource} onOpenDelivery={() => openTaskSection('delivery')} />;
  const agentProjectId = c.selected?.entity.entity === 'project' ? c.selected.id : c.selected?.entity.project;
  const agentTaskId = c.selected?.entity.entity === 'work_item' ? c.selected.id : undefined;
  const agentAction = c.selected && !c.unsupported ? <EntityAgentPanelAction entityId={c.selected.id} projectId={agentProjectId} taskId={agentTaskId} title={c.entity?.title ?? c.selected.entity.title} hasDraft={!!c.draft} /> : null;
  return <section className={`entity-detail ${fullPage ? 'entity-detail-full' : ''} ${task ? 'task-entity-detail' : ''} ${task && tab === 'source' ? 'is-source-split' : ''}`} aria-label={task ? (en ? 'Task detail' : '任务详情') : (en ? 'Entity detail' : '对象详情')} data-testid="entity-detail">
    {task ? <CollectionContextMenu actions={taskActions} trigger={<header tabIndex={0} className="task-detail-toolbar" aria-label={en ? 'Task header actions' : '任务标题操作'}>
      {fullPage && <button type="button" className="icon-button" aria-label={en ? 'Back to collection' : '返回集合'} onClick={onClose}><ArrowLeft size={16} /></button>}
      <div className="task-toolbar-identity">{c.entity?.project && <><button type="button" className="task-project-link" title={c.projects.find(file => file.id === c.entity?.project)?.entity.title || c.entity.project} onClick={() => c.wikiLink(c.entity!.project!)}>{c.projects.find(file => file.id === c.entity?.project)?.entity.title || c.entity.project}</button><span aria-hidden="true">/</span></>}<span className="mono">{c.selectedId}</span></div>
      <TaskCompletionAction controller={c} en={en} />
      <TaskDetailWatch controller={c} en={en} />
      {agentAction}
      <button type="button" className="icon-button" aria-label={en ? 'Copy task link' : '复制任务链接'} title={en ? 'Copy task link' : '复制任务链接'} onClick={() => { void copyTaskLink(); }}><Link size={15} /></button>
      <CollectionActionMenu actions={taskActions} trigger={<button type="button" className="icon-button" aria-label={en ? 'More task actions' : '更多任务操作'}><MoreHorizontal size={16} /></button>} />
      {!fullPage && onExpand && <button type="button" className="icon-button" aria-label={en ? 'Expand entity' : '展开对象'} title={en ? 'Open full page · same draft' : '全页打开 · 保留草稿'} data-testid="expand-entity" onClick={openTaskPage}><ArrowUpRight size={16} /></button>}
      <button type="button" className="icon-button" aria-label={fullPage ? (en ? 'Close task and return' : '关闭任务并返回') : (en ? 'Close inspector' : '关闭详情')} onClick={onClose}><X size={16} /></button>
    </header>} /> : <div className="detail-heading">
      {fullPage && <button className="icon-button" aria-label={en ? 'Back to collection' : '返回集合'} onClick={onClose}><ArrowLeft size={18} /></button>}
      <div className="detail-identity"><div className="detail-identity-meta"><FileText size={13} /><span className="mono">{c.selected?.id || c.unsupported?.id || c.selectedId}</span>{c.entity?.archived && <span className="draft-pill">{en ? 'Archived' : '已归档'}</span>}{c.draft && <span className="draft-pill">{en ? 'Draft' : '草稿'}</span>}</div><h2>{c.entity?.title || c.source?.path.split('/').pop() || (en ? 'Entity unavailable' : '对象不可用')}</h2></div>
      {isDocument && tab === 'source' && <button type="button" className="secondary-button" data-testid="return-document-content" onClick={() => setDetail({ tab: 'content' })}><FileText size={15} />{en ? 'Editable content' : '可编辑内容'}</button>}
      {agentAction}
      {!fullPage && onExpand && c.selected && <button className="icon-button" aria-label={en ? 'Expand entity' : '展开对象'} title={en ? 'Open full page · same draft' : '全页打开 · 保留草稿'} data-testid="expand-entity" onClick={onExpand}><ArrowUpRight size={18} /></button>}
      {!fullPage && <button className="icon-button" aria-label={en ? 'Close inspector' : '关闭详情'} onClick={onClose}><X size={18} /></button>}
    </div>}
    {task && copyState?.id === c.selectedId && <p className="task-copy-status" role={copyState.status === 'failed' ? 'alert' : 'status'}>{copyState.status === 'copied' ? (en ? 'Task link copied.' : '已复制任务链接。') : (en ? 'Clipboard is unavailable. Open the full page and copy its URL.' : '剪贴板不可用，请打开全页后复制地址。')}</p>}
    {!c.source ? <div className="empty-state" role="status">{en ? 'This entity is not available in the current workspace. It may have been deleted or access may have changed.' : '当前工作区中无法访问此对象。对象可能已删除，或访问权限已更改。'}</div> : <>
      {task ? <div className="task-detail-modes">
        <div className="detail-tabs" role="tablist" aria-label={en ? 'Task sections' : '任务分区'} onKeyDown={navigateTabs}>{tabs.map(item => <button type="button" key={item.id} id={`entity-tab-${item.id}`} role="tab" tabIndex={tab === item.id ? 0 : -1} aria-selected={tab === item.id} aria-controls="entity-tab-panel" className={tab === item.id ? 'active' : ''} data-testid={item.id === 'source' ? 'source-tab' : item.id === 'content' ? 'preview-tab' : `${item.id}-tab`} onClick={() => setDetail({ tab: item.id })}>{item.id === 'source' && <Code2 size={13} />}{item.id === 'content' ? (en ? 'Task' : '任务') : item.id === 'source' ? (en ? 'Source / live' : '源码 / 实时视图') : item.label}</button>)}</div>
      </div> : tabs.length > 1 && <div className="detail-tabs" role="tablist" aria-label={en ? 'Entity sections' : '对象分区'} onKeyDown={navigateTabs}>{tabs.map(item => <button type="button" key={item.id} id={`entity-tab-${item.id}`} role="tab" tabIndex={tab === item.id ? 0 : -1} aria-selected={tab === item.id} aria-controls="entity-tab-panel" disabled={!!c.unsupported && item.id !== 'source'} className={tab === item.id ? 'active' : ''} data-testid={item.id === 'source' ? 'source-tab' : item.id === 'content' ? 'preview-tab' : `${item.id}-tab`} onClick={() => setDetail({ tab: item.id })}>{item.label}</button>)}</div>}
      <div className="detail-save-state"><span className="mono" title={c.source.path}>{isDocument ? 'Markdown' : c.source.path}</span><span role="status">{c.unsupported || sourceReadonly ? (en ? 'Read only' : '只读') : c.draftDiagnostics.some(issue => issue.severity === 'error') ? (en ? 'Invalid draft / input' : '草稿或输入无效') : c.draft ? (en ? 'Unsaved changes' : '未保存的更改') : (en ? 'Saved' : '已保存')}</span></div>
      {c.selected?.stale && !c.unsupported && <div className="inline-error">{c.selected.entity.entity === 'project' ? (en ? 'The project source is unavailable or needs repair. Check its registered storage and diagnostics; restore a missing mount or explicitly rebind the original directory rather than creating an empty replacement.' : '项目源码不可用或需要修复。请先核对登记存储与诊断；缺盘时恢复原挂载或显式找回原目录，不要创建空替代目录。') : (en ? 'Disk source needs repair. Edit source and save to restore sync; properties are locked.' : '磁盘源码需要修复。请编辑源码并保存以恢复同步；属性暂时锁定。')} {c.selected.error}<button className="text-button" onClick={() => setDetail({ tab: 'source' })}>{en ? 'Inspect source' : '检查源码'}</button></div>}
      {c.unsupported && <div className="inline-error">{en ? 'Read-only source' : '只读源码'} · {c.unsupported.schema || (en ? 'Unrecognized metadata' : '无法识别的元数据')}. {en ? 'This protocol cannot be edited or deleted here. Any previous local draft is retained.' : '当前不允许修改或删除此协议源码。之前的本地草稿仍予以保留。'}</div>}
      {task && c.draftParseError && <div className="inline-error" role="alert">{en ? 'The current Markdown draft is invalid. Task fields and description show the last saved valid document, not the invalid draft. Repair the source before saving.' : '当前 Markdown 草稿无效。任务字段与描述显示最后保存的有效文档，并非当前无效草稿；请修复源码后再保存。'} <button type="button" onClick={() => setDetail({ tab: 'source' })}>{en ? 'Repair source' : '修复源码'}</button></div>}
      {isDocument && c.draftParseError && <div className="inline-error" role="alert">{en ? 'This draft is invalid and cannot be saved. Its raw Markdown is retained; repair the body or Markdown source. Preview shows this draft, not a saved replacement.' : '当前草稿无效，暂不能保存。Markdown 原文已保留，请修复正文或 Markdown 源码；预览显示当前草稿，不会用已保存版本替换。'} <button type="button" onClick={() => setDetail({ tab: 'source' })}>{en ? 'Repair source' : '修复源码'}</button></div>}
      {isDocument && documentRecovery && c.session.documentWrites.getSnapshot()[c.selectedId]?.phase !== 'saving' && <div className="inline-error" role="alert"><span>{documentRecovery.message}</span><button type="button" className="text-button" onClick={() => void c.reconcileDocument(c.selectedId)}>{en ? 'Read authoritative source' : '读取权威源核对'}</button>{documentRecovery.phase === 'observed' && <button type="button" className="text-button" onClick={() => c.adoptDocumentRevision(c.selectedId)}>{en ? 'Adopt observed revision; keep edits' : '采用已核对版本并保留修改'}</button>}</div>}
      <Diagnostics diagnostics={c.unsupported?.diagnostics || c.selected?.diagnostics || []} />
      {c.ahead && <div className="conflict-banner"><AlertTriangle size={14} /><span>{en ? 'Disk changed. Your draft is safe.' : '磁盘内容已更改，草稿已保留。'}</span><button onClick={() => { c.setRebaseReviewed(false); c.setConflict({ id: c.selectedId, current: c.selected!, local: c.raw }); }}>{en ? 'Compare versions' : '比较版本'}</button></div>}
      <Diagnostics diagnostics={c.draftDiagnostics} />
      <div ref={contentPane} onScroll={event => { if (isDocument) retainDocumentEditorPosition(c.session, c.selectedId, 'detail', { anchor: 0, head: 0, scrollTop: event.currentTarget.scrollTop, scrollLeft: event.currentTarget.scrollLeft }); }} className={`detail-content detail-content-${tab}`} id="entity-tab-panel" role={tabs.length > 1 ? 'tabpanel' : 'region'} aria-label={tabs.length === 1 ? tabs[0].label : undefined} aria-labelledby={tabs.length > 1 ? `entity-tab-${tab}` : undefined}>
        {isDocument && (!c.documentWorkbench || tab === 'content') && <div hidden={tab !== 'content'} className="document-editing-panel"><DocumentContentEditor key={`${c.selectedId}:${discardVersion}`} controller={c} en={en} onSource={() => setDetail({ tab: 'source' })} /></div>}
        {isDocument && (!c.documentWorkbench || tab === 'source') && <div hidden={tab !== 'source'} className="document-source-panel">{sourceEditor}</div>}
        {tab === 'source' && !isDocument && (task ? <div className="task-source-live"><section className="task-source-pane" aria-label={en ? 'Shared Markdown source' : '共享 Markdown 源码'}><div className="task-source-pane-heading"><Code2 size={13} /><span>{en ? 'Markdown source · shared draft' : 'Markdown 源码 · 共享草稿'}</span><button type="button" className="text-button" onClick={() => setDetail({ tab: 'content' })}>{en ? 'Task view' : '任务视图'}</button></div>{sourceEditor}</section><section className="task-live-pane" aria-label={en ? 'Live task preview' : '实时任务预览'}><div className="task-source-pane-heading"><span>{en ? 'Live task · unsaved until Save' : '实时任务 · 显式保存后生效'}</span></div>{taskSurface}</section></div> : sourceEditor)}
        {tab === 'content' && !isDocument && (task ? taskSurface : c.entity && <Preview raw={c.raw} body={c.entity.body} viewProps={{ ...c.viewProps, files: c.projected, allFiles: c.projected }} disabled={!c.selected || !c.canEdit(c.selectedId)} onToggle={line => void c.toggleChecklist(line)} onLink={c.wikiLink} />)}
        {(['properties', 'relations', 'context'] as string[]).includes(tab) && c.selected && c.entity && <Properties key={`${c.selected.id}:${tab}`} file={c.selected} entity={c.entity} files={c.files} configuration={c.configuration} disabled={task ? !c.canEditTaskDraft : isDocument ? sourceReadonly || c.draftParseError || !!c.selected.stale || !!c.entity.archived : !c.canEdit(c.selectedId)} lifecycleDisabled={!c.canManageLifecycle(c.selectedId) || (task || isDocument) && c.draftInvalid} dirty={!!c.draft} draftMode={task || isDocument} excludeFields={isDocument ? ['assignee'] : undefined} section={tab as 'properties' | 'relations' | 'context'} en={en} onPatch={changes => { if (task) c.patchTaskDraft(changes); else if (isDocument) c.patchDocumentDraft(changes); else void c.patch(c.selectedId, changes); }} onLink={c.wikiLink} onLifecycle={action => { if (action === 'delete') { c.setDeleteTarget(c.selected!); c.setDeleteConfirmation(''); c.setError(''); c.setRequestDiagnostics([]); } else void c.lifecycle(c.selected!, action); }} onContext={() => void c.loadContext()} />}
        {tab === 'graph' && c.selected && <KnowledgeGraph files={c.files} configuration={c.configuration} source={c.graphSource} query={graphQuery} refreshKey={c.graphRefreshKey} selectedId={c.selected.id} draftIds={c.draftIds} onSelect={c.select} en={en} embedded={!fullPage} renderContextMenu={renderCollectionContextMenu} />}
        {tab === 'business' && c.selected && <>{(c.draft || c.configurationInvalid || c.selected.stale || c.draftInvalid) && <div className="property-hint">{en ? 'Resolve the source draft or diagnostics before changing business state.' : '请先处理源码草稿或诊断，再修改业务状态。'}</div>}<fieldset disabled={!!c.draft || c.draftInvalid || sourceReadonly || !!c.selected.stale}>{renderBusiness(c.selected)}</fieldset></>}
      </div>
      <div className="detail-actions">{!isDocument && <span className="mono">{c.source.revision.slice(0, 7)}</span>}<div>{(c.draft || task && c.draftDiagnostics.some(issue => issue.severity === 'error')) && !c.unsupported && <button className="text-button" onClick={() => { if (window.confirm(en ? 'Discard your unsaved draft and input, and load the latest disk version?' : '放弃未保存的草稿与输入，并加载最新磁盘版本？')) { c.removeDraft(c.selectedId); setDiscardVersion(version => version + 1); } }}>{en ? 'Discard' : '放弃'}</button>}<button className="save-button" data-testid="save-file" disabled={!c.selected || !!c.unsupported || !c.draft || c.draftInvalid || sourceReadonly} onClick={() => void c.save()}>{c.busy === c.selectedId ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{c.unsupported || sourceReadonly ? (en ? 'Read only' : '只读') : c.draftDiagnostics.some(issue => issue.severity === 'error') ? (en ? 'Fix draft to save' : '修复草稿后保存') : c.draft ? (en ? 'Save changes' : '保存更改') : (en ? 'Saved' : '已保存')}<kbd>⌘ S</kbd></button></div></div>
    </>}
  </section>;
}
