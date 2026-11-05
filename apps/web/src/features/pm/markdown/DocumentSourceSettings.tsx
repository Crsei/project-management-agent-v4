import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, Folder, LoaderCircle, Plus, RefreshCw, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RadixSelect } from '@/components/ui/radix-select';
import { documentSourceConfigurationResponseSchema, type DocumentSource, type DocumentSourceAssociationScope, type DocumentSourceConfigurationResponse } from '../../../../../../packages/contracts/src/document-sources';
import type { LocalProjectDirectoryListing } from '../../../../../../packages/contracts/src/local-projects';
import { documentSourceError, documentSourceRequest, DocumentSourceRequestError, documentSourcesBase, readDocumentSources } from './document-sources-api';

export type DocumentSourceSettingsProps = {
  workspaceId: string;
  sources: DocumentSource[];
  scopes: DocumentSourceAssociationScope[];
  selectedProjectId: string | null;
  fixedProject: boolean;
  loading: boolean;
  error: string;
  en: boolean;
  onClose: () => void;
  onReload: () => void;
  onSaved: () => void;
};

type ScopeSnapshot = { scope: DocumentSourceAssociationScope; sources: DocumentSource[] };
type SelectedFolder = { path: string | null; name: string; status: DocumentSource['status']; reason?: string };
type SaveAttempt = { expectedRevision: number; paths: string[] };
const projectKey = (projectId: string | null) => projectId ?? '';
const folderPath = (path: string) => path.replace(/\/+$/, '') || '/';
const isWithin = (path: string, root: string) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
const selectedFolders = (sources: DocumentSource[]): SelectedFolder[] => sources.map(source => ({ path: source.path, name: source.name, status: source.status, ...(source.reason ? { reason: source.reason } : {}) }));
const samePaths = (left: (string | null)[], right: (string | null)[]) => left.length === right.length && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const snapshotFor = (projectId: string | null, catalog: { scopes: DocumentSourceAssociationScope[]; sources: DocumentSource[] }): ScopeSnapshot | undefined => {
  const scope = catalog.scopes.find(item => item.projectId === projectId);
  return scope ? { scope, sources: catalog.sources.filter(source => source.projectId === projectId) } : undefined;
};
const confirmsAttempt = (snapshot: ScopeSnapshot | undefined, attempt: SaveAttempt) => !!snapshot?.scope.canManage && snapshot.scope.revision === attempt.expectedRevision + 1 && samePaths(snapshot.sources.map(source => source.path), attempt.paths);

export function DocumentSourceSettings(props: DocumentSourceSettingsProps) {
  const { en } = props;
  const [chosenProjectId, setProjectId] = useState(props.selectedProjectId);
  const projectId = props.fixedProject ? props.selectedProjectId : chosenProjectId;
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  // A failed permission/catalog reread must not erase this dialog's choices or CAS baseline.
  const initialSnapshots = useRef(new Map<string, ScopeSnapshot>());
  for (const scope of props.scopes) {
    const key = `${props.workspaceId}:${projectKey(scope.projectId)}`;
    if (!initialSnapshots.current.has(key)) initialSnapshots.current.set(key, { scope, sources: props.sources.filter(source => source.projectId === scope.projectId) });
  }
  const current = useMemo(() => snapshotFor(projectId, { scopes: props.scopes, sources: props.sources }), [projectId, props.scopes, props.sources]);
  const initial = initialSnapshots.current.get(`${props.workspaceId}:${projectKey(projectId)}`);
  const discard = () => !dirty || window.confirm(en ? 'Discard the unsaved folder selections? No further save will be sent.' : '目录选择尚未保存，确定放弃吗？不会继续发送保存请求。');
  const close = () => { if (!busy && discard()) props.onClose(); };
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="document-source-dialog" initialFocus={closeButton}>
      <DialogHeader>
        <DialogTitle>{en ? 'Document source settings' : '文档来源设置'}</DialogTitle>
        <DialogDescription>{en ? 'Link existing folders on the PM server to the current workspace or a project. Empty folders are allowed. No folders are uploaded or created.' : '为当前工作区或项目关联 PM 服务端已有的文件夹，空文件夹也可以选择。不会上传或新建文件夹。'}</DialogDescription>
      </DialogHeader>
      <label className="document-source-field">{en ? 'Project' : '项目'}
        <RadixSelect value={projectKey(projectId)} disabled={props.fixedProject || busy || props.loading || !!props.error} onChange={event => {
          if (busy || !discard()) return;
          setDirty(false);
          setProjectId(event.target.value || null);
        }}>
          {!current && <option value={projectKey(projectId)}>{en ? 'Project currently unavailable' : '当前项目不可访问'}</option>}
          {props.scopes.map(scope => <option value={projectKey(scope.projectId)} key={projectKey(scope.projectId)}>{scope.projectId ? `${scope.name} · ${scope.projectId}` : en ? 'Workspace shared documents' : '工作区公共文档'}</option>)}
        </RadixSelect>
      </label>
      {props.fixedProject && <p className="document-source-hint">{props.selectedProjectId ? en ? 'Fixed to the current project. Other project and workspace associations will not change.' : '已固定为当前项目，不会修改其他项目或工作区公共文档的关联。' : en ? 'Fixed to workspace shared documents. Project associations will not change.' : '已固定为工作区公共文档，不会修改任何项目的关联。'}</p>}
      {props.loading && <p role="status" className="document-source-hint">{en ? 'Reading current source permissions…' : '正在读取当前来源权限…'}</p>}
      {props.error && <div className="document-source-error" role="alert">{props.error}<Button type="button" variant="outline" size="sm" disabled={busy || props.loading} onClick={props.onReload}>{en ? 'Read sources again' : '重新读取来源'}</Button></div>}
      {initial ? <SourceSettingsForm key={`${props.workspaceId}:${projectKey(projectId)}`} workspaceId={props.workspaceId} initial={initial} current={current} disabled={props.loading || !!props.error} en={en} onBusy={setBusy} onDirty={setDirty} onSaved={props.onSaved} onCancel={close} closeButton={closeButton} />
        : <><p role="status" className="document-source-hint">{en ? 'No accessible project selection. Check access and read sources again.' : '暂无可访问的项目选项，请核对权限后重新读取来源。'}</p><DialogFooter><Button ref={closeButton} type="button" variant="outline" onClick={close}>{en ? 'Cancel' : '取消'}</Button></DialogFooter></>}
    </DialogContent>
  </Dialog>;
}

type FormProps = {
  workspaceId: string;
  initial: ScopeSnapshot;
  current: ScopeSnapshot | undefined;
  disabled: boolean;
  en: boolean;
  onBusy: (busy: boolean) => void;
  onDirty: (dirty: boolean) => void;
  onSaved: () => void;
  onCancel: () => void;
  closeButton: React.RefObject<HTMLButtonElement | null>;
};
function SourceSettingsForm({ workspaceId, initial, current, disabled, en, onBusy, onDirty, onSaved, onCancel, closeButton }: FormProps) {
  const [folders, setFolders] = useState(() => selectedFolders(initial.sources));
  const [baseline, setBaseline] = useState(() => initial.sources.map(source => source.path));
  const [revision, setRevision] = useState(initial.scope.revision);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [latest, setLatest] = useState<ScopeSnapshot>();
  const request = useRef<AbortController | null>(null);
  const pendingAttempt = useRef<SaveAttempt | null>(null);
  const canManage = !!current?.scope.canManage && !disabled;
  const pathsKnown = folders.every(folder => folder.path !== null);
  const dirty = !samePaths(folders.map(folder => folder.path), baseline);
  useEffect(() => { onBusy(busy || pickerOpen); }, [busy, pickerOpen, onBusy]);
  useEffect(() => { onDirty(dirty || needsReload); }, [dirty, needsReload, onDirty]);
  useEffect(() => () => { request.current?.abort(); onBusy(false); onDirty(false); }, [onBusy, onDirty]);
  useEffect(() => {
    if (!current || disabled || dirty || busy || pickerOpen || needsReload || current.scope.revision < revision) return;
    setRevision(current.scope.revision);
    setFolders(selectedFolders(current.sources));
    setBaseline(current.sources.map(source => source.path));
  }, [current, disabled, dirty, busy, pickerOpen, needsReload, revision]);
  const begin = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(''); setMessage('');
    return controller;
  };
  const finish = (controller: AbortController) => { if (!controller.signal.aborted) setBusy(false); };
  const saved = (result: DocumentSourceConfigurationResponse) => {
    setFolders(selectedFolders(result.sources));
    setBaseline(result.sources.map(source => source.path));
    setRevision(result.scope.revision);
    setNeedsReload(false); setLatest(undefined); pendingAttempt.current = null;
    onSaved();
  };
  const readLatest = async () => {
    if (busy || disabled) return;
    const controller = begin();
    try {
      const catalog = await readDocumentSources(workspaceId, controller.signal);
      if (controller.signal.aborted) return;
      const snapshot = snapshotFor(initial.scope.projectId, catalog);
      if (!snapshot?.scope.canManage || snapshot.sources.some(source => source.path === null)) throw new Error(en ? 'This project is no longer manageable. Your selections are retained.' : '此项目已不可管理，目录选择仍予以保留。');
      if (pendingAttempt.current && confirmsAttempt(snapshot, pendingAttempt.current)) { saved(snapshot); return; }
      setLatest(snapshot);
      setRevision(snapshot.scope.revision);
      setBaseline(snapshot.sources.map(source => source.path));
      setNeedsReload(false); pendingAttempt.current = null;
      setMessage(en ? 'Latest revision read; your selections are unchanged. Compare the saved folders below before confirming a new update.' : '已读取最新版本，未修改你的目录选择。请核对下方已保存的目录，再确认新的更新。');
    } catch (cause) { if (!controller.signal.aborted) setError(documentSourceError(cause, en)); }
    finally { finish(controller); }
  };
  const save = async () => {
    if (busy || !canManage || needsReload || !pathsKnown || !dirty || pickerOpen) return;
    const attempt: SaveAttempt = { expectedRevision: revision, paths: folders.flatMap(folder => folder.path === null ? [] : [folder.path]) };
    const controller = begin();
    try {
      const result = documentSourceConfigurationResponseSchema.parse(await documentSourceRequest<unknown>(`${documentSourcesBase(workspaceId)}/configuration`, controller.signal, 'PUT', { projectId: initial.scope.projectId, ...attempt }));
      if (controller.signal.aborted) return;
      if (result.scope.projectId !== initial.scope.projectId || result.sources.some(source => source.projectId !== initial.scope.projectId) || !confirmsAttempt(result, attempt)) throw new DocumentSourceRequestError(502, 'invalid_response');
      saved(result);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const conflict = cause instanceof DocumentSourceRequestError && cause.status === 409 && cause.code === 'document_source_revision_conflict';
      const unknown = !(cause instanceof DocumentSourceRequestError) || cause.status >= 500 || cause.status === 408;
      if (conflict) {
        setNeedsReload(true);
        setError(documentSourceError(cause, en));
      } else if (unknown) {
        // A lost PUT response is never retried. GET must confirm the entire set and CAS revision.
        pendingAttempt.current = attempt;
        setNeedsReload(true);
        try {
          const catalog = await readDocumentSources(workspaceId, controller.signal);
          if (controller.signal.aborted) return;
          const snapshot = snapshotFor(initial.scope.projectId, catalog);
          setLatest(snapshot);
          if (snapshot && confirmsAttempt(snapshot, attempt)) { saved(snapshot); return; }
          setError(en ? 'The save result is unknown. GET did not confirm this exact folder set and revision. Your selections are retained; read and compare the latest revision before any new save.' : '保存结果未知。已先 GET 核对，但未确认本次完整目录列表和版本。选择已保留；再次保存前必须读取最新版本并核对。');
        } catch (readError) {
          if (!controller.signal.aborted) setError(`${en ? 'The save result is unknown; no retry was sent. Reading configuration also failed: ' : '保存结果未知，未重发；读取配置也失败：'}${documentSourceError(readError, en)}`);
        }
      } else setError(documentSourceError(cause, en));
    } finally { finish(controller); }
  };
  const addFolder = (path: string) => {
    const canonical = folderPath(path);
    if (folders.some(folder => folder.path !== null && (isWithin(canonical, folderPath(folder.path)) || isWithin(folderPath(folder.path), canonical)))) {
      setError(en ? 'This folder overlaps a folder already selected for this project. Remove that selection first.' : '此文件夹与当前项目已选文件夹相同或互为父子目录，请先移除冲突的选择。');
      return;
    }
    setFolders(previous => [...previous, { path: canonical, name: canonical.split('/').pop() || canonical, status: 'available' }]);
    setPickerOpen(false); setError(''); setMessage('');
  };
  return <form className="document-source-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="document-source-selection-heading"><h3>{en ? 'Linked folders' : '已选文件夹'}</h3><span className="document-source-hint">{folders.length} · revision {revision}</span></div>
    {folders.length ? <ul className="document-source-selected-folders">{folders.map((folder, index) => <li key={folder.path ?? `hidden:${index}`}>
      <Folder size={17} aria-hidden="true" /><div><strong>{folder.name}</strong><code>{folder.path ?? (en ? 'Path not disclosed' : '路径不予披露')}</code>{folder.status === 'unavailable' && <span className="document-source-error">{en ? 'Folder currently unavailable' : '文件夹当前不可用'}{folder.reason ? ` · ${folder.reason}` : ''}</span>}</div>
      <Button type="button" variant="ghost" size="sm" disabled={busy || !canManage || needsReload} aria-label={en ? `Remove association: ${folder.path ?? folder.name}` : `移除关联：${folder.path ?? folder.name}`} onClick={() => { setFolders(previous => previous.filter((_, item) => item !== index)); setMessage(''); setError(''); }}><Unlink size={15} />{en ? 'Remove' : '移除'}</Button>
    </li>)}</ul> : <p className="document-source-empty">{en ? 'No linked folders. Add one or more existing server folders.' : '尚未关联文件夹，可添加一个或多个服务端已有文件夹。'}</p>}
    <div className="document-source-actions"><Button type="button" variant="outline" disabled={busy || !canManage || needsReload || !pathsKnown} onClick={() => setPickerOpen(true)}><Plus size={15} />{en ? 'Add folder' : '添加文件夹'}</Button></div>
    <p className="document-source-hint">{en ? 'Selections take effect together only after Confirm. Removing a link never deletes files. Shared folders can be linked to other projects or workspaces; editing or deleting a physical file affects every reference.' : '点击“确认”后才会一次性保存全部选择；移除关联不会删除文件。同一文件夹可关联其他项目或工作区，编辑或删除实际文件会影响所有引用。'}</p>
    {latest && <div className="document-source-latest"><p>{en ? 'Currently saved folders' : '当前已保存的文件夹'} · revision {latest.scope.revision}</p>{latest.sources.length ? <ul>{latest.sources.map(source => <li key={source.sourceId}><code>{source.path ?? source.name}</code></li>)}</ul> : <p>{en ? 'No linked folders' : '未关联文件夹'}</p>}</div>}
    {(!canManage || !pathsKnown) && <p role="status" className="document-source-hint">{disabled ? en ? 'Current permissions have not been confirmed. Saving is disabled; selections are retained.' : '尚未确认当前权限，不能保存；目录选择保留。' : en ? 'This identity cannot manage the complete folder list. Selections are retained.' : '当前身份无权管理完整目录列表；目录选择保留。'}</p>}
    {message && <p role="status" className="document-source-hint">{message}</p>}
    {error && <p role="alert" className="document-source-error">{error}</p>}
    {needsReload && <Button type="button" variant="outline" disabled={busy || disabled} onClick={() => void readLatest()}><RefreshCw size={15} />{en ? 'Read latest revision (keep selections)' : '读取最新版本（保留选择）'}</Button>}
    <DialogFooter className="document-source-actions"><Button ref={closeButton} type="button" variant="outline" disabled={busy} onClick={onCancel}>{en ? 'Cancel' : '取消'}</Button><Button type="submit" disabled={busy || !canManage || needsReload || !pathsKnown || !dirty || pickerOpen}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{busy ? en ? 'Saving…' : '正在保存…' : en ? 'Confirm' : '确认'}</Button></DialogFooter>
    {pickerOpen && <ServerFolderPicker workspaceId={workspaceId} projectId={initial.scope.projectId} paths={folders.flatMap(folder => folder.path === null ? [] : [folder.path])} disabled={!canManage} en={en} onClose={() => setPickerOpen(false)} onAdd={addFolder} />}
  </form>;
}

function ServerFolderPicker({ workspaceId, projectId, paths, disabled, en, onClose, onAdd }: {
  workspaceId: string; projectId: string | null; paths: string[]; disabled: boolean; en: boolean; onClose: () => void; onAdd: (path: string) => void;
}) {
  const [listing, setListing] = useState<LocalProjectDirectoryListing>();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const relation = (path: string) => {
    const canonical = folderPath(path);
    if (paths.some(selected => isWithin(canonical, folderPath(selected)))) return 'covered';
    if (paths.some(selected => isWithin(folderPath(selected), canonical))) return 'ancestor';
    return null;
  };
  const browse = useCallback(async (path?: string) => {
    if (disabled) { setBusy(false); return; }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError('');
    const query = new URLSearchParams();
    if (path) query.set('path', path);
    if (projectId !== null) query.set('projectId', projectId);
    try {
      const result = await documentSourceRequest<LocalProjectDirectoryListing>(`${documentSourcesBase(workspaceId)}/directories${query.size ? `?${query}` : ''}`, controller.signal);
      if (controller.signal.aborted) return;
      setListing(result); setInput(result.path ?? '');
    } catch (cause) { if (!controller.signal.aborted) setError(documentSourceError(cause, en)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }, [workspaceId, projectId, disabled, en]);
  useEffect(() => { void browse(); return () => request.current?.abort(); }, [browse]);
  const currentRelation = listing?.path ? relation(listing.path) : null;
  const coveredText = en ? 'Already selected, or inside a selected folder' : '已选择，或已包含在所选文件夹中';
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="document-source-dialog document-source-folder-dialog" initialFocus={cancelButton}>
      <DialogHeader><DialogTitle>{en ? 'Add an existing folder' : '添加已有文件夹'}</DialogTitle><DialogDescription>{en ? 'Browse only the server directories authorized for this project. Choose the current folder, including an empty folder.' : '仅浏览当前项目获准访问的服务端目录，可选择当前文件夹，包括空文件夹。'}</DialogDescription></DialogHeader>
      <div className="document-source-folder-location"><label className="document-source-field">{en ? 'Server directory' : '服务端目录'}<Input value={input} disabled={busy || disabled} autoComplete="off" spellCheck={false} placeholder={en ? 'Optional existing absolute path' : '可输入已有目录的绝对路径'} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void browse(input.trim() || undefined); } }} /></label><Button type="button" variant="outline" disabled={busy || disabled} onClick={() => void browse(input.trim() || undefined)}>{en ? 'Browse' : '浏览'}</Button></div>
      <div className="document-source-folder-navigation"><Button type="button" variant="outline" size="sm" disabled={busy || disabled} onClick={() => void browse()}>{en ? 'Allowed roots' : '允许的根目录'}</Button><Button type="button" variant="outline" size="sm" disabled={busy || disabled || !listing?.parentPath} onClick={() => void browse(listing?.parentPath ?? undefined)}><ArrowUp size={15} />{en ? 'Parent folder' : '上一级'}</Button></div>
      {listing && <div className="document-source-folder-browser" aria-label={en ? 'Server directory browser' : '服务端目录浏览器'} aria-busy={busy}>
        <code className="document-source-folder-current">{listing.path ?? (en ? 'Allowed server roots' : '服务端允许的根目录')}</code>
        <ul>{(listing.path ? listing.directories : listing.roots.map(path => ({ name: path, path }))).map(directory => {
          const covered = relation(directory.path) === 'covered';
          return <li key={directory.path}><button type="button" disabled={busy || disabled || covered} title={covered ? coveredText : directory.path} onClick={() => void browse(directory.path)}><Folder size={17} aria-hidden="true" /><span>{directory.name}{covered && <small>{coveredText}</small>}</span></button></li>;
        })}</ul>
        {listing.path && !listing.directories.length && <p className="document-source-hint">{en ? 'No browsable subfolders. This folder can still be added.' : '没有可浏览的子文件夹，仍可添加当前文件夹。'}</p>}
        {!listing.path && !listing.roots.length && <p className="document-source-hint">{en ? 'No authorized server directories are available.' : '暂无可访问的服务端目录。'}</p>}
      </div>}
      {busy && <p role="status" className="document-source-hint">{en ? 'Reading server folders…' : '正在读取服务端文件夹…'}</p>}
      {currentRelation && <p role="status" className="document-source-hint">{currentRelation === 'covered' ? coveredText : en ? 'This folder contains an already selected folder. Remove that selection before adding its parent.' : '此文件夹包含已选文件夹，请先移除已有选择，不能直接添加其父目录。'}</p>}
      {disabled && <p role="status" className="document-source-hint">{en ? 'Current permissions are unavailable; browsing and selection are disabled.' : '当前权限不可用，已停用浏览与选择。'}</p>}
      {listing?.path && input.trim() !== listing.path && <p className="document-source-hint">{en ? 'Browse the entered path before choosing a folder.' : '请先浏览输入的路径，再选择文件夹。'}</p>}
      {error && <p role="alert" className="document-source-error">{error}</p>}
      <DialogFooter className="document-source-actions"><Button ref={cancelButton} type="button" variant="outline" onClick={onClose}>{en ? 'Cancel' : '取消'}</Button><Button type="button" disabled={busy || disabled || !!error || !listing?.path || input.trim() !== listing.path || !!currentRelation} onClick={() => { if (listing?.path) onAdd(listing.path); }}><Plus size={15} />{en ? 'Add this folder' : '添加当前文件夹'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
