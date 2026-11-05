import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FilePlus2, FileText, Folder, LoaderCircle, LocateFixed, LockKeyhole, RefreshCw, Search, X } from 'lucide-react';
import { entityDefinitions, entityKinds, type EntityKind, type FileRecord } from '@pm-schema';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import type { DocumentSource } from '../../../../../../packages/contracts/src/document-sources';
import { useCoreSession } from './session';
import { useDocumentSourceCatalog, useDocumentSourceFiles, type DocumentSourceRead } from './DocumentSources';
import { buildDocumentRows, type ExternalDocumentRow } from './document-collection-model';
import { documentTargetKey, type DocumentTarget } from './document-workbench-state';
import { useExternalDocumentSession } from './ExternalDocumentEditor';
import type { ExternalManagementIntent } from './external-document-state';
import { DocumentSourceSettings } from './DocumentSourceSettings';
import './document-file-tree.css';

export interface DocumentFileTreeProps {
  files: readonly FileRecord[];
  active: DocumentTarget | null;
  en: boolean;
  onOpen: (target: DocumentTarget) => void;
  onNavigateEntity?: (file: FileRecord) => void;
  nativeStatus?: 'loading' | 'ready' | 'error';
  nativeError?: string;
  onExternalSourcesChange?: (sources: readonly DocumentSource[] | null) => void;
  onManageExternal: (intent: ExternalManagementIntent) => void;
  onSourceSettingsOpen?: () => void;
}

type Directory = { directories: Map<string, Directory>; files: ExternalDocumentRow[] };
const kindLabels: Record<EntityKind, string> = { project: '项目', work_item: '工作项', document: '文档', cycle: '迭代', milestone: '里程碑', module: '模块', requirement: '需求', release: '发布', goal: '目标' };

export function DocumentFileTree({ files, active, en, onOpen, onNavigateEntity, nativeStatus = 'ready', nativeError, onExternalSourcesChange, onManageExternal, onSourceSettingsOpen }: DocumentFileTreeProps) {
  const session = useCoreSession();
  // This is the workspace explorer, not the collection route's fixed project scope.
  const catalog = useDocumentSourceCatalog(true, undefined, en);
  const { store } = useExternalDocumentSession();
  const readKey = `${catalog.key}:${catalog.request}`;
  const currentReads = useDocumentSourceFiles(catalog.workspaceId, catalog.sources, catalog.status === 'ready', readKey, en);
  const [search, setSearch] = useState('');
  const [locateMissing, setLocateMissing] = useState(false);
  const [settingsSource, setSettingsSource] = useState<DocumentSource | null>(null);
  const [menuNative, setMenuNative] = useState<FileRecord | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const sourceListener = useRef(onExternalSourcesChange);
  sourceListener.current = onExternalSourcesChange;
  useEffect(() => {
    sourceListener.current?.(catalog.status === 'ready' ? catalog.sources : null);
    if (catalog.status === 'ready') store.authorize(catalog.sources);
  }, [catalog.key, catalog.request, catalog.status, catalog.sources, store]);
  const query = search.trim().toLocaleLowerCase();
  const groups = useMemo(() => {
    const titles = new Map(files.filter(file => file.entity.entity === 'project').map(file => [file.id, file.entity.title]));
    const result = new Map<string, { label: string; kinds: Map<EntityKind, FileRecord[]> }>();
    if (nativeStatus !== 'ready') return result;
    for (const file of files) {
      const project = file.entity.entity === 'project' ? file.id : file.entity.project || 'workspace';
      const label = project === 'workspace' ? en ? 'Workspace' : '工作区' : `${titles.get(project) || (en ? 'Project' : '项目')} · ${project}`;
      const kind = file.entity.entity;
      if (query && ![file.entity.title, file.path, file.id, label, en ? entityDefinitions[kind].label : kindLabels[kind]].some(value => value.toLocaleLowerCase().includes(query))) continue;
      let group = result.get(project);
      if (!group) { group = { label, kinds: new Map() }; result.set(project, group); }
      const kindFiles = group.kinds.get(kind) || [];
      kindFiles.push(file);
      group.kinds.set(kind, kindFiles);
    }
    for (const group of result.values()) for (const kindFiles of group.kinds.values()) kindFiles.sort((a, b) => a.entity.title.localeCompare(b.entity.title) || a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
    return new Map([...result].sort(([left, a], [right, b]) => left === 'workspace' ? -1 : right === 'workspace' ? 1 : a.label.localeCompare(b.label)));
  }, [files, nativeStatus, query, en]);
  const activeKey = active ? documentTargetKey(active) : '';
  const reveal = useCallback((focus: boolean) => {
    const selected = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button[data-document-target]') || []).find(button => button.dataset.documentTarget === activeKey);
    if (!selected) { if (focus) setLocateMissing(true); return; }
    let ancestor = selected.parentElement;
    while (ancestor && ancestor !== root.current) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus) selected.focus({ preventScroll: true });
    setLocateMissing(false);
  }, [activeKey]);
  useEffect(() => { if (activeKey) reveal(false); }, [activeKey, groups, currentReads, reveal]);
  useEffect(() => { setSearch(''); setLocateMissing(false); }, [session.scope]);
  const locate = () => {
    if (search) { setSearch(''); requestAnimationFrame(() => reveal(true)); }
    else reveal(true);
  };
  const configured = catalog.sources;
  const allExternalLoaded = catalog.status === 'ready' && configured.every(source => source.status === 'available' && currentReads[source.sourceId]?.status === 'ready' && currentReads[source.sourceId]?.page?.scanComplete && !currentReads[source.sourceId]?.page?.issues.length);
  const visibleNativeCount = [...groups.values()].reduce((total, group) => total + [...group.kinds.values()].reduce((count, kindFiles) => count + kindFiles.length, 0), 0);
  const externalRows = useMemo(() => buildDocumentRows([], catalog.sources.flatMap(source => {
    const page = currentReads[source.sourceId]?.page;
    return page && page.sourceRevision === source.revision ? [{ source, entries: page.entries }] : [];
  }), new Map(catalog.scopes.flatMap(scope => scope.projectId ? [[scope.projectId, scope.name] as const] : [])), en).filter((row): row is ExternalDocumentRow => row.source === 'external'), [catalog.sources, catalog.scopes, currentReads, en]);
  return <div ref={root} className="document-file-tree">
    <header className="document-file-tree-heading"><div><Folder size={16} /><h2>{en ? 'Workspace files' : '工作区文件'}</h2></div><button type="button" className="document-file-tree-icon" disabled={!active} aria-label={en ? 'Locate active document' : '定位当前文档'} title={en ? 'Locate active document' : '定位当前文档'} onClick={locate}><LocateFixed size={16} /></button><button type="button" className="document-file-tree-icon" onClick={catalog.reload} disabled={catalog.status === 'pending'} aria-label={en ? 'Refresh external sources' : '刷新外部来源'} title={en ? 'Refresh external sources' : '刷新外部来源'}><RefreshCw size={15} className={catalog.status === 'pending' ? 'spin' : undefined} /></button></header>
    <label className="document-file-tree-search"><Search size={15} /><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={en ? 'Search name, ID or path' : '搜索名称、ID 或路径'} aria-label={en ? 'Search authorized files' : '搜索有权访问的文件'} />{search && <button type="button" className="document-file-tree-icon" onClick={() => setSearch('')} aria-label={en ? 'Clear file search' : '清除文件搜索'}><X size={14} /></button>}</label>
    {query && <p className="document-file-tree-notice" role="status">{allExternalLoaded && nativeStatus === 'ready' ? en ? 'Searching all loaded authorized files.' : '正在搜索全部已加载的授权文件。' : en ? 'Search covers files loaded so far; loading, failed or incomplete sources may contain more matches.' : '搜索仅覆盖目前已加载文件；加载中、失败或不完整的来源可能还有匹配项。'}</p>}
    {locateMissing && <p className="document-file-tree-notice" role="status">{en ? 'The active file is not in the currently loaded authorized results. A source may still be loading, changed, or unavailable.' : '当前已加载的授权结果中没有此文件；来源可能仍在加载、已变更或不可用。'}</p>}
    <div className="document-file-tree-scroll">
      <details open className="document-file-tree-section"><summary><FileText size={15} /><strong>{en ? 'PM documents' : 'PM文档'}</strong><span>{nativeStatus === 'ready' ? files.length : '…'}</span></summary>
        {nativeStatus === 'loading' ? <p className="document-file-tree-state" role="status"><LoaderCircle size={14} className="spin" />{en ? 'Loading authorized PM files…' : '正在加载授权 PM 文件…'}</p>
          : nativeStatus === 'error' ? <p className="document-file-tree-state document-file-tree-error" role="alert">{nativeError || (en ? 'PM documents could not be read. This is not an empty workspace.' : 'PM文档读取失败，不代表工作区为空。')}</p>
            : <><ul>{[...groups].map(([scope, group]) => <li key={scope}><details open><summary><Folder size={14} /><span><Highlight value={group.label} query={query} /></span></summary><ul>{entityKinds.filter(kind => group.kinds.has(kind)).map(kind => <li key={kind}><details open><summary><span><Highlight value={en ? entityDefinitions[kind].label : kindLabels[kind]} query={query} /></span><small>{group.kinds.get(kind)!.length}</small></summary><ul>{group.kinds.get(kind)!.map(file => {
              const target: DocumentTarget = { kind: 'native', id: file.id };
              const key = documentTargetKey(target);
              const captured = menuNative?.id === file.id ? menuNative : file;
              return <li key={file.id}><ContextMenu onOpenChange={open => { if (open) setMenuNative(file); }}><ContextMenuTrigger asChild><button type="button" className="document-file-tree-file" data-document-target={key} aria-current={key === activeKey ? 'true' : undefined} disabled={kind !== 'document' && !onNavigateEntity} title={`${file.entity.title} · ${file.id} · ${file.path}`} onClick={() => kind === 'document' ? onOpen(target) : onNavigateEntity?.(file)}><FileText size={14} /><span><strong><Highlight value={file.entity.title} query={query} /></strong><small><Highlight value={file.id} query={query} />{file.entity.archived ? en ? ' · Archived' : ' · 已归档' : ''}</small></span></button></ContextMenuTrigger><ContextMenuContent aria-label={captured.entity.title}><ContextMenuItem disabled={captured.entity.entity !== 'document' && !onNavigateEntity} onSelect={() => captured.entity.entity === 'document' ? onOpen({ kind: 'native', id: captured.id }) : onNavigateEntity?.(captured)}>{en ? 'Open' : '打开'}</ContextMenuItem></ContextMenuContent></ContextMenu></li>;
            })}</ul></details></li>)}</ul></details></li>)}</ul>{!visibleNativeCount && <p className="document-file-tree-state" role="status">{query ? en ? 'No matching PM documents.' : '没有匹配的PM文档。' : en ? 'No authorized PM documents.' : '没有有权访问的PM文档。'}</p>}</>}
      </details>
      <details open className="document-file-tree-section"><summary><FileText size={15} /><strong>{en ? 'External documents' : '外部文档'}</strong></summary>
        {catalog.status === 'pending' ? <p className="document-file-tree-state" role="status"><LoaderCircle size={14} className="spin" />{en ? 'Checking all authorized sources…' : '正在核对全部授权来源…'}</p>
          : catalog.status === 'error' ? <div className="document-file-tree-state document-file-tree-error" role="alert"><p>{en ? 'Source catalog failed; the file collection is not known to be empty.' : '来源目录读取失败，不能判断文件集合为空。'} {catalog.error}</p><button type="button" onClick={catalog.reload}>{en ? 'Retry sources' : '重试来源'}</button></div>
            : !configured.length ? <p className="document-file-tree-state" role="status">{en ? 'No external directory is configured in your authorized scopes. Configure one in document source settings.' : '有权访问的范围尚未配置外部目录，可在文档来源设置中配置。'}</p>
              : <ul>{configured.map(source => <ExternalSourceBranch key={`${readKey}:${source.sourceId}:${source.revision}`} source={source} rows={externalRows.filter(row => row.sourceId === source.sourceId)} read={currentReads[source.sourceId]} scopeName={catalog.scopes.find(scope => scope.projectId === source.projectId)?.name || source.projectId || (en ? 'Workspace common documents' : '工作区公共文档')} query={query} activeKey={activeKey} en={en} onOpen={onOpen} onRefresh={catalog.reload} onManage={onManageExternal} onSettings={source => { setSettingsSource(source); onSourceSettingsOpen?.(); catalog.reload(); }} />)}</ul>}
      </details>
    </div>
    <p className="document-file-tree-boundary">{en ? 'Authorized PM files and configured Markdown sources only. Not a disk browser.' : '仅显示授权 PM 文件及已配置 Markdown 来源，不浏览任意磁盘目录。'}</p>
    {settingsSource && <DocumentSourceSettings key={settingsSource.projectId || 'workspace'} workspaceId={catalog.workspaceId} sources={catalog.sources} scopes={catalog.scopes} selectedProjectId={settingsSource.projectId} fixedProject loading={catalog.status === 'pending'} error={catalog.error} en={en} onClose={() => setSettingsSource(null)} onReload={catalog.reload} onSaved={() => { setSettingsSource(null); catalog.reload(); window.dispatchEvent(new Event('external-documents-changed')); }} />}
  </div>;
}

function ExternalSourceBranch({ source, rows, read, scopeName, query, activeKey, en, onOpen, onRefresh, onManage, onSettings }: { source: DocumentSource; rows: ExternalDocumentRow[]; read?: DocumentSourceRead; scopeName: string; query: string; activeKey: string; en: boolean; onOpen: (target: DocumentTarget) => void; onRefresh: () => void; onManage: (intent: ExternalManagementIntent) => void; onSettings: (source: DocumentSource) => void }) {
  const sourceId = source.sourceId;
  const scopeLabel = `${source.name} · ${scopeName}`;
  const matching = useMemo(() => !query || scopeLabel.toLocaleLowerCase().includes(query) ? rows : rows.filter(row => row.searchText.includes(query)), [rows, query, scopeLabel]);
  const tree = useMemo(() => {
    const directory: Directory = { directories: new Map(), files: [] };
    for (const row of matching) {
      const segments = row.entry.path.split('/');
      segments.pop();
      let parent = directory;
      for (const name of segments) {
        let child = parent.directories.get(name);
        if (!child) { child = { directories: new Map(), files: [] }; parent.directories.set(name, child); }
        parent = child;
      }
      parent.files.push(row);
    }
    return directory;
  }, [matching]);
  const page = read?.page;
  const loading = source.status === 'available' && (!read || read.status === 'loading');
  const completedMessage = !page?.scanComplete || page.issues.length
    ? en ? 'All available pages loaded; the scan remains incomplete. Missing matches cannot be ruled out.' : '可用分页已全部加载，但扫描仍不完整，不能排除缺少匹配文件。'
    : !rows.length && page.entries.length
      ? en ? 'Shared files are listed once under another authorized source.' : '共享文件已在其他授权来源下去重显示。'
      : matching.length
        ? en ? 'All pages loaded.' : '已加载全部分页。'
        : query ? en ? 'No matching Markdown files; all pages loaded.' : '没有匹配的 Markdown 文件，已加载全部分页。'
          : en ? 'No Markdown files; all pages loaded.' : '没有 Markdown 文件，已加载全部分页。';
  return <li><details open className="document-file-tree-source"><ContextMenu><ContextMenuTrigger asChild><summary><Folder size={14} /><span><Highlight value={scopeLabel} query={query} /></span><small>{rows.length}</small></summary></ContextMenuTrigger><ContextMenuContent aria-label={scopeLabel}>
    <ContextMenuItem disabled={!source.canWrite || source.status !== 'available'} title={!source.canWrite ? en ? 'This source is read only' : '此来源为只读' : source.status !== 'available' ? en ? 'The source directory is unavailable' : '来源目录不可用' : undefined} onSelect={() => onManage({ action: 'create', sourceId })}>{en ? 'Create Markdown file…' : '新建 Markdown 文件…'}</ContextMenuItem>
    <ContextMenuSeparator /><ContextMenuItem onSelect={() => onSettings(source)}>{en ? 'Document source settings…' : '文档来源设置…'}</ContextMenuItem>
  </ContextMenuContent></ContextMenu>
    <p className="document-file-tree-source-kind">{source.canWrite ? en ? 'External · Editable' : '外部 · 可编辑' : en ? 'External · Read only' : '外部 · 只读'}</p>
    {source.canWrite && source.status === 'available' && <button type="button" className="secondary-button external-tree-create" onClick={() => onManage({ action: 'create', sourceId })}><FilePlus2 size={14} />{en ? 'New file' : '新建文件'}</button>}
    {source.status === 'unavailable' ? <p className="document-file-tree-state document-file-tree-error" role="alert">{en ? 'Configured directory unavailable; no fallback directory is used.' : '已配置目录不可用，不会使用替代目录。'} {source.reason}</p>
      : read?.status === 'error' ? <div className="document-file-tree-state document-file-tree-error" role="alert"><p>{read.error}</p><button type="button" onClick={onRefresh}>{en ? 'Refresh from beginning' : '刷新并从头读取'}</button></div>
        : <>
          {loading && <p className="document-file-tree-state" role="status"><LoaderCircle size={14} className="spin" />{en ? `Loading all pages… ${rows.length} unique files so far.` : `正在加载全部分页…目前 ${rows.length} 个去重文件。`}</p>}
          {page && (!page.scanComplete || !!page.issues.length) && <p className="document-file-tree-state document-file-tree-warning" role="alert"><AlertTriangle size={14} />{en ? 'Scan has exclusions or limits; these results are incomplete.' : '扫描存在排除项或限制，当前结果不完整。'}</p>}
          {!!page?.issues.length && <details className="document-file-tree-issues"><summary>{page.issues.length} {en ? 'scan issues / exclusions' : '条扫描问题 / 排除项'}</summary><ul>{page.issues.map(issue => <li key={JSON.stringify([issue.path, issue.code])}><code>{issue.path || '.'}</code><span>{issue.code}</span></li>)}</ul></details>}
          {!!matching.length && <ul><ExternalDirectory tree={tree} query={query} activeKey={activeKey} onOpen={onOpen} en={en} onManage={onManage} /></ul>}
          {read?.status === 'ready' && <p className="document-file-tree-state" role="status">{completedMessage}</p>}
        </>}
  </details></li>;
}

function ExternalDirectory({ tree, query, activeKey, onOpen, en, onManage }: { tree: Directory; query: string; activeKey: string; onOpen: (target: DocumentTarget) => void; en: boolean; onManage: (intent: ExternalManagementIntent) => void }) {
  const directories = useMemo(() => [...tree.directories].sort(([left], [right]) => left.localeCompare(right)), [tree]);
  const files = useMemo(() => [...tree.files].sort((left, right) => left.title.localeCompare(right.title) || left.entry.path.localeCompare(right.entry.path)), [tree]);
  const actions = [
    { action: 'rename' as const, label: en ? 'Rename' : '重命名' },
    { action: 'move' as const, label: en ? 'Move' : '移动' },
    { action: 'delete' as const, label: en ? 'Delete' : '删除' },
  ];
  const [menuRow, setMenuRow] = useState<ExternalDocumentRow | null>(null);
  return <>
    {directories.map(([name, directory]) => <li key={`directory:${name}`}><details open><summary><Folder size={13} /><span><Highlight value={name} query={query} /></span></summary><ul><ExternalDirectory tree={directory} query={query} activeKey={activeKey} onOpen={onOpen} en={en} onManage={onManage} /></ul></details></li>)}
    {files.map(row => {
      const target: DocumentTarget = { kind: 'external', sourceId: row.sourceId, revision: row.revision, path: row.entry.path };
      const key = documentTargetKey(target);
      const active = row.associations.some(alias => documentTargetKey({ kind: 'external', sourceId: alias.sourceId, revision: alias.revision, path: alias.entry.path }) === activeKey);
      const captured = menuRow?.key === row.key ? menuRow : row;
      const capturedTarget: DocumentTarget = { kind: 'external', sourceId: captured.sourceId, revision: captured.revision, path: captured.entry.path };
      return <li key={row.key}><ContextMenu onOpenChange={open => { if (open) setMenuRow(row); }}><ContextMenuTrigger asChild><button type="button" className="document-file-tree-file" data-document-target={active ? activeKey : key} aria-current={active ? 'true' : undefined} title={`${row.entry.path} · ${row.projectLabel}`} onClick={() => onOpen(target)}><FileText size={14} /><span><strong><Highlight value={row.title} query={query} /></strong><small><Highlight value={row.projectLabel} query={query} /></small></span>{!row.canWrite && <LockKeyhole size={11} />}</button></ContextMenuTrigger><ContextMenuContent aria-label={captured.entry.path}><ContextMenuItem onSelect={() => onOpen(capturedTarget)}>{en ? 'Open' : '打开'}</ContextMenuItem><ContextMenuSeparator />{actions.map(({ action, label }) => <ContextMenuItem key={action} disabled={!captured.canWrite} title={!captured.canWrite ? en ? 'This source is read only' : '此来源为只读' : undefined} onSelect={() => onManage({ action, target: capturedTarget })}>{label}</ContextMenuItem>)}</ContextMenuContent></ContextMenu>{row.canWrite && <div className="external-tree-actions">{actions.map(({ action, label }) => <button type="button" key={action} aria-label={`${label} ${row.entry.path}`} onClick={() => onManage({ action, target })}>{label}</button>)}</div>}</li>;
    })}
  </>;
}

function Highlight({ value, query }: { value: string; query: string }) {
  if (!query) return <>{value}</>;
  const lower = value.toLocaleLowerCase();
  const parts = [];
  let offset = 0;
  let index = lower.indexOf(query);
  while (index !== -1) {
    if (index > offset) parts.push(<span key={`text:${offset}`}>{value.slice(offset, index)}</span>);
    parts.push(<mark key={`match:${index}`}>{value.slice(index, index + query.length)}</mark>);
    offset = index + query.length;
    index = lower.indexOf(query, offset);
  }
  if (offset < value.length) parts.push(<span key={`text:${offset}`}>{value.slice(offset)}</span>);
  return <>{parts}</>;
}
