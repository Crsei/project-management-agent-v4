import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, FileText, LoaderCircle, Maximize2, Minimize2, PanelLeft, PanelRight, X } from 'lucide-react';
import type { FileRecord } from '@pm-schema';
import { useWorkspaceController } from './controller';
import { DocumentFileTree } from './DocumentFileTree';
import { DocumentContextPanel } from './DocumentContextPanel';
import { DocumentCloseDialog, DocumentTabs } from './DocumentTabs';
import { documentTargetKey, useDocumentWorkbenchLifecycle, useDocumentWorkbenchState, type DocumentTarget } from './document-workbench-state';
import { ExternalDocumentEditor, ExternalDocumentManagementDialog, ExternalOperationNotices, useExternalDocumentLeaveProtection, useExternalDocumentSession } from './ExternalDocumentEditor';
import type { ExternalManagementIntent } from './external-document-state';

import type { DocumentSource } from '../../../../../../packages/contracts/src/document-sources';
import { EntityDetail } from './EntityDetail';
import { Diagnostics } from './Diagnostics';
import { WorkspaceDialogs } from './WorkspaceDialogs';
import './document-workbench.css';

interface DocumentWorkbenchProps {
  target: DocumentTarget | null;
  invalidTarget: boolean;
  en: boolean;
  canWrite: boolean;
  canLifecycle: boolean;
  onTargetChange: (target: DocumentTarget | null, options?: { replace?: boolean; anchor?: string }) => void;
  onExit: () => void;
  onNavigateEntity: (file: FileRecord, anchor?: string) => void;
  onSettings: () => void;
  renderBusiness: (file: FileRecord) => ReactNode;
}

/** One editor, a complete workspace explorer, and URL-selected document tabs. */
export function DocumentWorkbench(props: DocumentWorkbenchProps) {
  const { en, target } = props;
  const state = useDocumentWorkbenchState(target);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [treeOpen, setTreeOpen] = useState(() => !window.matchMedia('(max-width: 767px)').matches);
  const [contextOpen, setContextOpen] = useState(() => window.matchMedia('(min-width: 1200px)').matches);
  const [contextWidth, setContextWidth] = useState(320);
  const [focusMode, setFocusMode] = useState(false);
  const [treeWidth, setTreeWidth] = useState(280);
  const [externalSources, setExternalSources] = useState<readonly DocumentSource[] | null>(null);
  const [sourceGeneration, setSourceGeneration] = useState(0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const treeDialogRef = useRef<HTMLDialogElement>(null);
  const treeOpenerRef = useRef<HTMLButtonElement>(null);
  const treeId = useId();
  const contextId = useId();
  const panelId = useId();
  const latest = useRef({ tabs: state.tabs, target });
  latest.current = { tabs: state.tabs, target };

  const c = useWorkspaceController({ mode: 'entity', documentWorkbench: true, en, entityKind: 'document', selectedId: target?.kind === 'native' ? target.id : '', canWrite: props.canWrite, canLifecycle: props.canLifecycle,
    onSelect: id => { if (id) void open({ kind: 'native', id }); else if (target) void close(target); },
    onNavigateEntity: (file, anchor) => { void navigateEntity(file, anchor); },
  });
  const lifecycle = useDocumentWorkbenchLifecycle(c, en);
  const { store: externalStore, snapshot: external } = useExternalDocumentSession();
  const [management, setManagement] = useState<ExternalManagementIntent | null>(null);
  useExternalDocumentLeaveProtection(externalStore, en);
  const statuses = { ...lifecycle.statuses };
  for (const draft of Object.values(external.drafts)) statuses[documentTargetKey(draft.target)] = { dirty: draft.value !== draft.base.content, saving: external.operations.some(operation => operation.sourceId === draft.target.sourceId && operation.phase === 'pending'), unknown: external.operations.some(operation => operation.sourceId === draft.target.sourceId && operation.phase === 'unknown'), ...(draft.observed ? { error: en ? 'Disk version changed' : '磁盘版本已改变' } : {}) };
  useEffect(() => {
    if (!external.completions.length) return;
    const completions = external.completions;
    externalStore.acknowledge();
    window.dispatchEvent(new Event('external-documents-changed'));
    for (const { sourceId, receipt } of completions) {
      if (receipt.status !== 'succeeded' || receipt.action === 'save') continue;
      const previous = latest.current.tabs.find((tab): tab is Extract<DocumentTarget, { kind: 'external' }> => tab.kind === 'external' && tab.sourceId === sourceId && tab.path === receipt.path);
      if (receipt.action === 'delete' || receipt.action === 'move' && !receipt.content) {
        if (previous) {
          state.retarget(previous, null);
          if (latest.current.target?.kind === 'external' && latest.current.target.sourceId === sourceId && latest.current.target.path === receipt.path) props.onTargetChange(null, { replace: true });
        }
        continue;
      }
      if (!receipt.content) continue;
      const next: DocumentTarget = { kind: 'external', sourceId: receipt.targetSourceId || sourceId, revision: receipt.content.sourceRevision, path: receipt.targetPath || receipt.content.path };
      if (previous && receipt.action === 'move') {
        state.retarget(previous, next);
        if (latest.current.target && documentTargetKey(latest.current.target) === documentTargetKey(previous)) props.onTargetChange(next, { replace: true });
      } else { void open(next); }
    }
  }, [external.completions, externalStore, state.retarget, state.open, props.onTargetChange]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const change = () => { setNarrow(media.matches); setTreeOpen(!media.matches); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const dialog = treeDialogRef.current;
    if (!dialog) return;
    if (narrow && treeOpen && !dialog.open) dialog.showModal();
    if ((!narrow || !treeOpen) && dialog.open) { dialog.close(); treeOpenerRef.current?.focus(); }
  }, [narrow, treeOpen]);
  useEffect(() => {
    const layout = layoutRef.current;
    if (narrow || !layout) return;
    const observer = new ResizeObserver(() => {
      const available = layout.clientWidth;
      setTreeWidth(width => Math.max(200, Math.min(width, 480, available * .48, available - 260)));
    });
    observer.observe(layout);
    return () => observer.disconnect();
  }, [narrow]);

  const authorizedExternalKeys = useMemo(() => new Set(state.tabs.filter((tab): tab is Extract<DocumentTarget, { kind: 'external' }> => tab.kind === 'external').filter(tab => externalSources?.some(source => source.sourceId === tab.sourceId && source.revision === tab.revision && source.status === 'available')).map(documentTargetKey)), [externalSources, state.tabs]);
  const sourcesChanged = useRef((sources: readonly DocumentSource[] | null) => {
    setExternalSources(sources);
    setSourceGeneration(value => value + 1);
  }).current;

  async function open(next: DocumentTarget, anchor?: string) {
    const same = target && documentTargetKey(target) === documentTargetKey(next);
    if (!same && !await lifecycle.beforeTransition()) return;
    state.open(next);
    props.onTargetChange(next, { replace: !!same, anchor });
    if (narrow) setTreeOpen(false);
  }
  async function navigateEntity(file: FileRecord, anchor?: string) {
    if (file.entity.entity === 'document') { await open({ kind: 'native', id: file.id }, anchor); return; }
    if (await lifecycle.beforeTransition()) props.onNavigateEntity(file, anchor);
  }
  async function close(closing: DocumentTarget) {
    if (closing.kind === 'external') {
      const draft = externalStore.getSnapshot().drafts[documentTargetKey(closing)];
      const unresolved = externalStore.blocks(closing.sourceId);
      if ((unresolved || draft && draft.value !== draft.base.content) && !window.confirm(en ? 'Close this tab and keep its draft in this browser session? Reloading loses unsaved text. Unresolved operation IDs remain available for reconciliation.' : '关闭此标签并在浏览器会话中保留草稿？刷新会丢失未保存正文；未决操作编号仍保留以供核对。')) return;
    }
    if (!await lifecycle.requestClose(closing)) return;
    const key = documentTargetKey(closing);
    const { tabs, target: current } = latest.current;
    const index = tabs.findIndex(tab => documentTargetKey(tab) === key);
    const remaining = tabs.filter(tab => documentTargetKey(tab) !== key);
    state.close(key);
    if (current && documentTargetKey(current) === key) props.onTargetChange(remaining[Math.min(Math.max(index, 0), remaining.length - 1)] || null, { replace: true });
  }
  async function exit() {
    if (await lifecycle.beforeTransition()) props.onExit();
  }
  function resize(width: number) {
    const available = layoutRef.current?.clientWidth || 960;
    setTreeWidth(Math.max(200, Math.min(480, available * .48, available - 260, width)));
  }
  function resizeContext(width: number) {
    const available = layoutRef.current?.clientWidth || 1200;
    setContextWidth(Math.max(240, Math.min(520, available * .42, available - 260, width)));
  }
  function outline(slug: string) {
    const hash = `#${encodeURIComponent(slug)}`;
    if (window.location.hash === hash) {
      const match = Array.from(document.querySelectorAll<HTMLElement>('.document-preview-pane .markdown-preview h1, .document-preview-pane .markdown-preview h2, .document-preview-pane .markdown-preview h3, .document-preview-pane .markdown-preview h4, .document-preview-pane .markdown-preview h5, .document-preview-pane .markdown-preview h6')).find(element => element.id.endsWith(`heading-${slug}`));
      match?.scrollIntoView({ block: 'start' });
      return;
    }
    window.location.hash = hash;
  }

  const nativeError = c.accessError || (c.query.isError && !c.query.data ? c.query.error : null);
  const tree = <DocumentFileTree files={c.files} active={target} en={en} nativeStatus={c.accessError || c.query.isError ? 'error' : c.query.isPending ? 'loading' : 'ready'} nativeError={(c.accessError || c.query.error)?.message} onOpen={next => { void open(next); }} onNavigateEntity={file => { void navigateEntity(file); }} onExternalSourcesChange={sourcesChanged} onManageExternal={intent => { if (narrow) { treeDialogRef.current?.close(); setTreeOpen(false); } setManagement(intent); }} onSourceSettingsOpen={() => { if (narrow) { treeDialogRef.current?.close(); setTreeOpen(false); } }} />;
  const treeHeading = <div className="document-workbench-tree-heading"><strong>{en ? 'Workspace files' : '工作区文件'}</strong><button type="button" className="icon-button" aria-label={en ? 'Close file explorer' : '关闭文件浏览器'} onClick={() => setTreeOpen(false)}><X size={16} /></button></div>;

  return <div className="document-workbench" data-document-workbench data-tree-open={!focusMode && treeOpen}>
    <header className="document-workbench-toolbar">
      <button type="button" className="secondary-button" onClick={() => { void exit(); }}><ArrowLeft size={15} /><span>{en ? 'Exit documents' : '退出文档工作台'}</span></button>
      <button ref={treeOpenerRef} type="button" className={`icon-button ${!focusMode && treeOpen ? 'active' : ''}`} aria-label={en ? 'Toggle workspace file explorer' : '切换工作区文件浏览器'} aria-expanded={!focusMode && treeOpen} aria-controls={treeId} onClick={() => { setFocusMode(false); setTreeOpen(value => !value); }}><PanelLeft size={17} /></button>
      {!narrow && target?.kind !== 'external' && <button type="button" className={`icon-button ${!focusMode && contextOpen ? 'active' : ''}`} aria-label={en ? 'Toggle document context' : '切换文档上下文'} aria-expanded={!focusMode && contextOpen} aria-controls={contextId} onClick={() => { setFocusMode(false); setContextOpen(value => !value); }}><PanelRight size={17} /></button>}
      {!narrow && <button type="button" className={`icon-button ${focusMode ? 'active' : ''}`} aria-label={focusMode ? en ? 'Exit focus mode' : '退出聚焦模式' : en ? 'Focus on document' : '聚焦文档'} aria-pressed={focusMode} onClick={() => setFocusMode(value => !value)}>{focusMode ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>}
      <span className="document-workbench-label">{en ? 'Document workbench' : '文档工作台'}</span>
      {c.query.isError && !!c.query.data && !c.accessError && <span className="document-workbench-stale" role="status">{en ? 'Workspace snapshot may be stale' : '工作区快照可能已过期'}</span>}
    </header>
    <div ref={layoutRef} className="document-workbench-layout" style={{ '--document-tree-width': `${treeWidth}px`, '--document-context-width': `${contextWidth}px` } as CSSProperties}>
      {!narrow && !focusMode && <aside id={treeId} hidden={!treeOpen} className="document-workbench-sidebar" aria-label={en ? 'Workspace file explorer' : '工作区文件浏览器'}>{tree}</aside>}
      {!narrow && !focusMode && treeOpen && <div className="document-workbench-resize" role="separator" aria-label={en ? 'Resize workspace file explorer' : '调整工作区文件浏览器宽度'} aria-controls={treeId} aria-orientation="vertical" aria-valuemin={200} aria-valuemax={480} aria-valuenow={Math.round(treeWidth)} tabIndex={0}
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && layoutRef.current) resize(event.clientX - layoutRef.current.getBoundingClientRect().left); }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(treeWidth + (event.key === 'ArrowLeft' ? -16 : 16)); } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); resize(event.key === 'Home' ? 200 : 480); } }} />}
      <main className="document-workbench-main">
        <DocumentTabs tabs={state.tabs} active={target} files={c.files} en={en} statuses={statuses} authorizedExternalKeys={authorizedExternalKeys} panelId={panelId} onActivate={next => { void open(next); }} onClose={next => { void close(next); }} />
        <DocumentCloseDialog lifecycle={lifecycle} en={en} />
        <ExternalOperationNotices en={en} onOpen={next => { void open(next); }} onManage={setManagement} />
        {c.error && <div className="error-banner" role="alert"><AlertTriangle size={15} /><span>{c.error}</span><button type="button" className="icon-button" aria-label={en ? 'Dismiss error' : '关闭错误'} onClick={() => { c.setError(''); c.setRequestDiagnostics([]); }}><X size={14} /></button></div>}
        <Diagnostics diagnostics={c.requestDiagnostics} />
        {(c.session.drafts.persistenceError() || c.session.creationDrafts.persistenceError()) && <p className="inline-error" role="alert">{en ? 'Browser draft recovery is unavailable. Keep this page open until your changes are saved.' : '浏览器草稿恢复存储不可用，请保留本页，直至更改保存完成。'}</p>}
        {c.configurationInvalid && <p className="inline-error" role="alert">{en ? 'Invalid workspace configuration blocks writes; drafts are preserved.' : '工作区配置无效，写入已暂停，草稿仍予以保留。'} <button type="button" onClick={props.onSettings}>{en ? 'Repair configuration' : '修复配置'}</button></p>}
        <section id={panelId} className="document-workbench-content" role={target ? 'tabpanel' : 'region'} tabIndex={0} aria-label={en ? 'Active document' : '当前文档'}>
          {props.invalidTarget ? <div className="document-workbench-empty" role="alert"><AlertTriangle size={28} /><h1>{en ? 'Invalid document link' : '文档链接无效'}</h1><p>{en ? 'Choose a document from the authorized workspace files.' : '请从有权访问的工作区文件中选择文档。'}</p><button type="button" className="secondary-button" onClick={() => props.onTargetChange(null, { replace: true })}>{en ? 'Clear invalid selection' : '清除无效选择'}</button></div>
            : !target ? <div className="document-workbench-empty"><FileText size={32} /><h1>{en ? 'No document open' : '尚未打开文档'}</h1><p>{en ? 'Open a PM document or an authorized external document. External files can be edited and managed when your existing permissions allow.' : '打开PM文档或已授权的外部文档。现有权限允许时，可直接编辑和管理外部文件。'}</p><button type="button" className="secondary-button" onClick={() => setTreeOpen(true)}><PanelLeft size={15} />{en ? 'Browse workspace files' : '浏览工作区文件'}</button></div>
              : target.kind === 'external' ? <ExternalDocumentEditor key={documentTargetKey(target)} target={target} refreshKey={sourceGeneration} en={en} onBack={() => { void close(target); }} onManage={setManagement} />
                : c.query.isPending ? <div className="loading-screen" role="status"><LoaderCircle size={24} className="spin" /><p>{en ? 'Loading document…' : '正在加载文档…'}</p></div>
                  : nativeError ? <div className="loading-screen" role="alert"><AlertTriangle size={28} /><h1>{en ? 'Workspace unavailable' : '工作区不可用'}</h1><p>{nativeError.message}</p><button type="button" className="secondary-button" onClick={() => { void c.refresh(); }}>{en ? 'Retry' : '重试'}</button></div>
                    : !c.selected || c.unsupported || c.selected.entity.entity !== 'document' ? <div className="document-workbench-empty" role="alert"><AlertTriangle size={28} /><h1>{en ? 'Document unavailable' : '文档不可用'}</h1><p>{en ? 'This document is missing or no longer authorized. No other entity is opened in its place.' : '文档不存在或已无权访问，不会替换为其他对象。'}</p><button type="button" className="secondary-button" onClick={() => { void close(target); }}>{en ? 'Close tab' : '关闭标签页'}</button></div>
                      : <EntityDetail controller={c} en={en} fullPage onClose={() => { void close(target); }} renderBusiness={props.renderBusiness} />}
        </section>
      </main>
      {!narrow && !focusMode && contextOpen && target?.kind === 'native' && <>
        <div className="document-workbench-resize document-workbench-context-resize" role="separator" aria-label={en ? 'Resize document context' : '调整文档上下文宽度'} aria-controls={contextId} aria-orientation="vertical" aria-valuemin={240} aria-valuemax={520} aria-valuenow={Math.round(contextWidth)} tabIndex={0}
          onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
          onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && layoutRef.current) resizeContext(layoutRef.current.getBoundingClientRect().right - event.clientX); }}
          onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizeContext(contextWidth + (event.key === 'ArrowLeft' ? 16 : -16)); } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); resizeContext(event.key === 'Home' ? 520 : 240); } }} />
        <aside id={contextId} className="document-workbench-context" aria-label={en ? 'Document context' : '文档上下文'}>
          <DocumentContextPanel controller={c} en={en} onClose={() => setContextOpen(false)} onOutline={outline} onOpenEntity={file => { void navigateEntity(file); }} />
        </aside>
      </>}
    </div>
    {narrow && <dialog ref={treeDialogRef} id={treeId} className="document-workbench-tree-dialog" aria-label={en ? 'Workspace file explorer' : '工作区文件浏览器'} onCancel={event => { event.preventDefault(); setTreeOpen(false); }} onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setTreeOpen(false); } }}>{treeHeading}{tree}</dialog>}
    {management && <ExternalDocumentManagementDialog key={JSON.stringify(management)} intent={management} sources={externalSources || []} sourcesReady={externalSources !== null} en={en} onClose={() => setManagement(null)} />}
    <WorkspaceDialogs controller={c} en={en} helpOpen={false} onCloseHelp={() => {}} onSavedView={() => {}} />
  </div>;
}
