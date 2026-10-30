import { useEffect, useRef, useState } from 'react';
import { Check, Folder, LoaderCircle, RefreshCw, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { documentSourcePreviewSchema, documentSourceResponseSchema, type DocumentSource } from '../../../../../../packages/contracts/src/document-sources';
import { agentCatalogSchema } from '../../../../../../packages/contracts/src/agent-file-areas';
import { documentSourceError, documentSourceRequest, DocumentSourceRequestError, documentSourceScope, documentSourcesBase, readDocumentSources } from './document-sources-api';

type SettingsProps = {
  workspaceId: string;
  sources: DocumentSource[];
  selectedScope: string;
  loading: boolean;
  error: string;
  en: boolean;
  onClose: () => void;
  onReload: () => void;
  onSaved: (source: DocumentSource) => void;
};

export function DocumentSourceSettings(props: SettingsProps) {
  const { en } = props;
  const [scope, setScope] = useState(props.selectedScope);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Keep only this open dialog's initial baseline. A failed/revoked catalog must
  // disable saving without discarding the user's typed path or CAS revision.
  const initialSources = useRef(new Map(props.sources.map(source => [documentSourceScope(source), source])));
  for (const source of props.sources) if (!initialSources.current.has(documentSourceScope(source))) initialSources.current.set(documentSourceScope(source), source);
  const initial = initialSources.current.get(scope);
  const current = props.sources.find(source => documentSourceScope(source) === scope);
  const close = () => {
    if (busy || (dirty && !window.confirm(en ? 'Discard the unsaved directory input?' : '目录输入尚未保存，确定放弃吗？'))) return;
    props.onClose();
  };
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="document-source-dialog" initialFocus={closeButton}>
      <DialogHeader>
        <DialogTitle>{en ? 'Document source settings' : '文档来源设置'}</DialogTitle>
        <DialogDescription>{en ? 'Associate an existing directory on the PM server. This is separate from Agent execution directories; no directory or file is created, moved or changed.' : '关联 PM 后端机器上已有的目录，不是浏览器电脑目录。此配置独立于 Agent 执行目录，不创建、移动或修改目录和文件。'}</DialogDescription>
      </DialogHeader>
      <label className="document-source-field">{en ? 'Source scope' : '来源范围'}
        <select value={scope} disabled={busy || props.loading || !!props.error} onChange={event => {
          if (busy || (dirty && !window.confirm(en ? 'Discard the unsaved directory input?' : '目录输入尚未保存，确定放弃吗？'))) return;
          setDirty(false);
          setScope(event.target.value);
        }}>
          {!current && <option value={scope}>{en ? 'Scope unavailable' : '范围当前不可访问'}</option>}
          {props.sources.map(source => <option value={documentSourceScope(source)} key={documentSourceScope(source)}>{source.projectId ? en ? 'Project' : '项目' : en ? 'Workspace' : '工作区'} · {source.name}{source.projectId ? ` · ${source.projectId}` : ''}</option>)}
        </select>
      </label>
      {props.loading && <p role="status">{en ? 'Reading current source permissions…' : '正在读取当前来源权限…'}</p>}
      {props.error && <div className="document-source-error" role="alert">{props.error}<Button type="button" variant="outline" size="sm" disabled={busy || props.loading} onClick={props.onReload}>{en ? 'Read sources again' : '重新读取来源'}</Button></div>}
      {initial ? <SourceSettingsForm key={scope} workspaceId={props.workspaceId} initial={initial} current={current} disabled={props.loading || !!props.error} en={en} onBusy={setBusy} onDirty={setDirty} onSaved={props.onSaved} />
        : <p role="status">{en ? 'No accessible source scope. Read sources again after checking access.' : '暂无可访问的来源范围，请核对权限后重新读取。'}</p>}
      <DialogFooter><Button ref={closeButton} type="button" variant="outline" disabled={busy} onClick={close}>{en ? 'Close' : '关闭'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

type FormProps = {
  workspaceId: string;
  initial: DocumentSource;
  current?: DocumentSource;
  disabled: boolean;
  en: boolean;
  onBusy: (busy: boolean) => void;
  onDirty: (dirty: boolean) => void;
  onSaved: (source: DocumentSource) => void;
};
function SourceSettingsForm({ workspaceId, initial, current, disabled, en, onBusy, onDirty, onSaved }: FormProps) {
  const [path, setPath] = useState(initial.path || '');
  const [revision, setRevision] = useState(initial.revision);
  const [baselinePath, setBaselinePath] = useState(initial.path || '');
  const [preview, setPreview] = useState<{ input: string; path: string }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [latest, setLatest] = useState<DocumentSource>();
  const request = useRef<AbortController | null>(null);
  const canManage = !!current?.canManage && !disabled;
  const dirty = path !== baselinePath;
  const sourceScope = documentSourceScope(initial);
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => { request.current?.abort(); onBusy(false); onDirty(false); }, [onBusy, onDirty]);
  useEffect(() => {
    if (!current || dirty || busy || needsReload) return;
    setRevision(current.revision);
    setPath(current.path || '');
    setBaselinePath(current.path || '');
    setPreview(undefined);
  }, [current?.revision, current?.path]);
  const begin = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(''); setMessage('');
    return controller;
  };
  const finish = (controller: AbortController) => { if (!controller.signal.aborted) setBusy(false); };
  const preflight = async () => {
    if (busy || !canManage || !path.trim() || needsReload) return;
    const controller = begin();
    setPreview(undefined);
    try {
      const result = documentSourcePreviewSchema.parse(await documentSourceRequest<unknown>(`${documentSourcesBase(workspaceId)}/preview`, controller.signal, 'POST', { projectId: initial.projectId, path }));
      if (controller.signal.aborted) return;
      if (result.readable !== true || !result.path) throw new DocumentSourceRequestError(502, 'invalid_response');
      setPreview({ input: path, path: result.path });
      setMessage(en ? 'The existing directory is readable. Preflight does not save or create it.' : '现有目录预检可读；预检不会保存配置或创建目录。');
    } catch (cause) { if (!controller.signal.aborted) setError(documentSourceError(cause, en)); }
    finally { finish(controller); }
  };
  const useAgentPath = async () => {
    if (busy || !canManage || needsReload) return;
    const controller = begin();
    setPreview(undefined);
    try {
      const catalog = agentCatalogSchema.parse(await documentSourceRequest<unknown>('/api/v1/agent-contexts', controller.signal));
      if (controller.signal.aborted) return;
      const workspace = catalog.workspaces.find(item => item.id === workspaceId);
      const area = initial.projectId ? workspace?.projects.find(item => item.id === initial.projectId)?.fileArea : workspace?.fileArea;
      if (!area?.path || area.status !== 'available') throw new Error(en ? 'This scope has no accessible, existing Agent file-area path. Enter a backend directory instead.' : '此范围没有可访问且可用的已有 Agent 文件区域路径，请输入后端目录。');
      setPath(area.path);
      setMessage(en ? 'Copied this scope’s existing Agent path into the input only. Preflight and save are still required; the Agent directory will not change.' : '仅将此范围已有的 Agent 路径填入输入框，仍需预检及保存；不会修改 Agent 目录。');
    } catch (cause) { if (!controller.signal.aborted) setError(documentSourceError(cause, en)); }
    finally { finish(controller); }
  };
  const readLatest = async () => {
    if (busy) return;
    const controller = begin();
    setPreview(undefined);
    try {
      const result = await readDocumentSources(workspaceId, controller.signal);
      if (controller.signal.aborted) return;
      const source = result.sources.find(item => documentSourceScope(item) === sourceScope);
      if (!source?.canManage) throw new Error(en ? 'This scope is no longer manageable. Your input is retained.' : '此范围已不可管理，输入仍予以保留。');
      setLatest(source);
      setRevision(source.revision);
      setNeedsReload(false);
      setMessage(en ? 'Latest revision read; your input was not changed. Compare the current path below, then preflight again before saving.' : '已读取最新版本，未修改你的输入。请核对下方当前配置，并重新预检后再保存。');
    } catch (cause) { if (!controller.signal.aborted) setError(documentSourceError(cause, en)); }
    finally { finish(controller); }
  };
  const save = async (unlink: boolean) => {
    if (busy || !canManage || needsReload || (!unlink && (!preview || preview.input !== path))) return;
    if (unlink && !window.confirm(en ? 'Disconnect this source? Its files and configuration revision will be preserved.' : '解除此文档来源关联？源文件和配置 revision 都会保留。')) return;
    const desiredPath = unlink ? null : preview!.path;
    const controller = begin();
    try {
      const result = documentSourceResponseSchema.parse(await documentSourceRequest<unknown>(`${documentSourcesBase(workspaceId)}/${encodeURIComponent(sourceScope)}`, controller.signal, 'PUT', { path: desiredPath, expectedRevision: revision }));
      if (controller.signal.aborted) return;
      if (!result.source || documentSourceScope(result.source) !== sourceScope || result.source.revision !== revision + 1 || result.source.path !== desiredPath) throw new DocumentSourceRequestError(502, 'invalid_response');
      onSaved(result.source);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const conflict = cause instanceof DocumentSourceRequestError && cause.status === 409 && cause.code === 'document_source_revision_conflict';
      const unknown = !(cause instanceof DocumentSourceRequestError) || cause.status >= 500 || cause.status === 408;
      setPreview(undefined);
      if (conflict) {
        setNeedsReload(true);
        setError(documentSourceError(cause, en));
      } else if (unknown) {
        // A PUT may have committed even if its response was lost. Never replay it.
        setNeedsReload(true);
        try {
          const result = await readDocumentSources(workspaceId, controller.signal);
          if (controller.signal.aborted) return;
          const actual = result.sources.find(item => documentSourceScope(item) === sourceScope);
          setLatest(actual);
          if (actual?.canManage && actual.revision === revision + 1 && actual.path === desiredPath) { onSaved(actual); return; }
          setError(en ? 'The save result is unknown. GET did not confirm this exact update. Your input is retained; read the latest revision and compare before any new save.' : '保存结果未知。已先 GET 核对，但未确认本次完整更新。输入已保留；必须读取最新版本并核对，才可再次保存。');
        } catch (readError) {
          if (!controller.signal.aborted) setError(`${en ? 'The save result is unknown; no retry was sent. Reading configuration also failed: ' : '保存结果未知，未重发；读取配置也失败：'}${documentSourceError(readError, en)}`);
        }
      } else setError(documentSourceError(cause, en));
    } finally { finish(controller); }
  };
  return <form className="document-source-form" onSubmit={event => { event.preventDefault(); void save(false); }}>
    <p className="document-source-hint">{initial.name} · {initial.projectId || (en ? 'Workspace scope' : '工作区范围')} · revision {revision}</p>
    <label className="document-source-field">{en ? 'Existing directory on the backend' : '后端已有目录的绝对路径'}
      <Input value={path} disabled={busy || !canManage} autoComplete="off" spellCheck={false} placeholder={en ? 'Enter an allowed existing server directory' : '输入服务端允许的已有目录'} onChange={event => { setPath(event.target.value); setPreview(undefined); setMessage(''); }} />
    </label>
    <p className="document-source-hint">{en ? 'All ordinary .md files are discovered recursively, with no PM metadata required. Reading stays read-only; no upload, edit or deletion is offered.' : '递归发现全部普通 .md 文件，无需 PM 元数据。这里只读，不提供上传、编辑或删除。'}</p>
    <p className="document-source-hint">{en ? 'Agent and project directories may be reused. Only configured document sources must be distinct and must not contain one another; identical filenames at different paths remain separate documents.' : '可以复用 Agent 或项目目录。仅已配置的文档来源之间不能相同或互为父子目录；不同路径下的同名文件仍是不同文档。'}</p>
    <div className="document-source-actions">
      <Button type="button" variant="outline" size="sm" disabled={busy || !canManage || needsReload} onClick={() => void useAgentPath()}><Folder size={15} />{en ? 'Use this scope’s Agent path' : '选用此范围 Agent 路径'}</Button>
      <Button type="button" variant="outline" size="sm" disabled={busy || !canManage || needsReload || !path.trim()} onClick={() => void preflight()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{en ? 'Preflight directory' : '预检目录'}</Button>
    </div>
    {preview && <p className="document-source-hint">{en ? 'Verified path: ' : '已预检路径：'}<code>{preview.path}</code></p>}
    {latest && <div className="document-source-latest"><p>{en ? 'Current saved configuration' : '当前已保存配置'} · revision {latest.revision}</p><code>{latest.path ?? (latest.status === 'unconfigured' ? en ? 'Disconnected' : '未关联' : en ? 'Path not disclosed' : '路径不予披露')}</code></div>}
    {!canManage && <p role="status" className="document-source-hint">{disabled ? en ? 'Waiting for current permissions. Saving is disabled.' : '尚未确认当前权限，不能保存。' : en ? 'This identity cannot manage this source. Typed input is retained.' : '当前身份无权管理此来源；已输入内容保留。'}</p>}
    {message && <p role="status" className="document-source-hint">{message}</p>}
    {error && <p role="alert" className="document-source-error">{error}</p>}
    {needsReload && <Button type="button" variant="outline" disabled={busy || disabled} onClick={() => void readLatest()}><RefreshCw size={15} />{en ? 'Read latest revision (keep input)' : '读取最新版本（保留输入）'}</Button>}
    <div className="document-source-actions">
      <Button type="button" variant="outline" disabled={busy || !canManage || needsReload || current?.status === 'unconfigured'} onClick={() => void save(true)}><Unlink size={15} />{en ? 'Disconnect source' : '解除关联'}</Button>
      <Button type="submit" disabled={busy || !canManage || needsReload || !preview || preview.input !== path}>{busy ? en ? 'Working…' : '正在处理…' : en ? 'Save source' : '保存来源'}</Button>
    </div>
  </form>;
}
