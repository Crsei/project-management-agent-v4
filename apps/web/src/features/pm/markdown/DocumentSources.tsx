import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, FileText, Folder, LoaderCircle, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import type { DocumentSource, DocumentSourceContent, DocumentSourceEntry, DocumentSourceFiles } from '../../../../../../packages/contracts/src/document-sources';
import { useCoreSession } from './session';
import { MarkdownUrlImage, MarkdownUrlLink } from './preview-url-components';
import { DocumentSourceSettings } from './DocumentSourceSettings';
import { documentSourceError, DocumentSourceRequestError, documentSourceScope, readDocumentSourceContent, readDocumentSourceFiles, readDocumentSources } from './document-sources-api';
import './document-sources.css';
import './preview.css';

type Selection = { scope: string; revision: number; path: string };
type Props = {
  active: boolean;
  settingsOpen: boolean;
  en: boolean;
  onSettingsClose: () => void;
  onConfigured: () => void;
};

/** Mounted inside the identity/workspace-scoped CoreSessionProvider. All external
 * data is component-local and is destroyed on session/scope changes, not cached
 * in the PM entity controller, drafts, query cache, or browser storage. */
export function DocumentSources({ active, settingsOpen, en, onSettingsClose, onConfigured }: Props) {
  const session = useCoreSession();
  const workspaceId = session.queryKey[3];
  const [sources, setSources] = useState<DocumentSource[]>([]);
  const [selectedScope, setSelectedScope] = useState('workspace');
  const [selection, setSelection] = useState<Selection>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const catalogRequest = useRef<AbortController | null>(null);
  const reload = useCallback(() => {
    // Hide plaintext synchronously, before a new permission/configuration read.
    catalogRequest.current?.abort();
    setLoading(true);
    setGeneration(value => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    catalogRequest.current = controller;
    setLoading(true); setError('');
    void readDocumentSources(workspaceId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setSources(result.sources);
      setSelectedScope(previous => result.sources.some(source => documentSourceScope(source) === previous) ? previous : result.sources[0] ? documentSourceScope(result.sources[0]) : 'workspace');
    }).catch(cause => {
      if (controller.signal.aborted) return;
      setSources([]);
      setError(documentSourceError(cause, en));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, session.scope, generation, en]);
  useEffect(() => {
    // CoreSession remounts on membership/identity changes. Recheck on focus,
    // without introducing a filesystem watcher or background scan interval.
    const onFocus = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);
  useEffect(() => { if (settingsOpen) reload(); }, [settingsOpen, reload]);
  const source = sources.find(item => documentSourceScope(item) === selectedScope);
  const selectedPath = selection?.scope === selectedScope && selection.revision === source?.revision ? selection.path : '';
  return <>
    {active && <section className="document-sources" aria-label={en ? 'External directory documents' : '外部目录文档'}>
      <div className="document-sources-toolbar">
        <div><h2><Folder size={16} />{en ? 'External directory · Read only' : '外部目录 · 只读'}</h2><p>{en ? 'Ordinary Markdown files, separate from native PM documents.' : '普通 Markdown 文件，与原生 PM 文档独立。'}</p></div>
        <label className="document-source-scope"><span>{en ? 'Source scope' : '来源范围'}</span><select aria-label={en ? 'Document source scope' : '文档来源范围'} value={selectedScope} disabled={loading || !!error} onChange={event => { setSelection(undefined); setSelectedScope(event.target.value); }}>
          {!source && <option value={selectedScope}>{en ? 'No accessible scope' : '暂无可访问范围'}</option>}
          {sources.map(item => <option value={documentSourceScope(item)} key={documentSourceScope(item)}>{item.projectId ? en ? 'Project' : '项目' : en ? 'Workspace' : '工作区'} · {item.name}{item.projectId ? ` · ${item.projectId}` : ''}</option>)}
        </select></label>
        <button type="button" className="secondary-button" disabled={loading} onClick={reload}><RefreshCw size={14} className={loading ? 'spin' : undefined} />{loading ? en ? 'Refreshing…' : '正在刷新…' : en ? 'Refresh source' : '刷新来源'}</button>
      </div>
      {loading ? <p className="document-source-state" role="status"><LoaderCircle size={17} className="spin" />{en ? 'Reading current source and permissions…' : '正在读取当前来源及权限…'}</p>
        : error ? <div className="document-source-state document-source-error" role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={reload}>{en ? 'Read sources again' : '重新读取来源'}</button></div>
          : !source ? <p className="document-source-state" role="status">{en ? 'There is no accessible source scope. No example directory or document is substituted.' : '当前没有可访问的来源范围，不会替换成示例目录或文档。'}</p>
            : source.status === 'unconfigured' ? <p className="document-source-state" role="status">{en ? 'No directory is linked to this scope. Use Document source settings at the top right; native PM documents are unchanged.' : '此范围尚未关联目录，请使用右上角“文档来源设置”；原生 PM 文档不受影响。'}</p>
              : source.status === 'unavailable' ? <div className="document-source-state document-source-error" role="alert"><p>{en ? 'The configured directory is unavailable. It will not be recreated or replaced with another directory.' : '已配置目录不可用；不会重建或回退到其他目录。'}</p>{source.reason && <code>{source.reason}</code>}</div>
                : <SourceFiles key={`${session.scope}:${selectedScope}:${source.revision}:${generation}`} workspaceId={workspaceId} source={source} selectedPath={selectedPath} en={en} onSelect={path => setSelection(path ? { scope: selectedScope, revision: source.revision, path } : undefined)} onRefresh={reload} />}
    </section>}
    {settingsOpen && <DocumentSourceSettings workspaceId={workspaceId} sources={sources} selectedScope={selectedScope} loading={loading} error={error} en={en} onClose={onSettingsClose} onReload={reload} onSaved={saved => {
      setSelectedScope(documentSourceScope(saved));
      setSelection(undefined);
      onSettingsClose();
      onConfigured();
      reload();
    }} />}
  </>;
}

type DirectoryTree = { directories: Map<string, DirectoryTree>; files: DocumentSourceEntry[] };
function SourceFiles({ workspaceId, source, selectedPath, en, onSelect, onRefresh }: {
  workspaceId: string;
  source: DocumentSource;
  selectedPath: string;
  en: boolean;
  onSelect: (path: string) => void;
  onRefresh: () => void;
}) {
  const [page, setPage] = useState<DocumentSourceFiles>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const cursors = useRef(new Set<string>());
  const fileList = useRef<HTMLDivElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const scopeLabel = `${source.name} · ${source.projectId || (en ? 'Workspace' : '工作区')}`;
  const readPage = async (cursor?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError('');
    try {
      const next = await readDocumentSourceFiles(workspaceId, source, controller.signal, cursor);
      if (controller.signal.aborted) return;
      if (next.sourceRevision !== source.revision || next.nextCursor !== null && (next.nextCursor === cursor || cursors.current.has(next.nextCursor))) throw new DocumentSourceRequestError(409, 'document_source_cursor_invalid');
      if (next.nextCursor) cursors.current.add(next.nextCursor);
      setPage(previous => cursor && previous ? {
        ...next,
        entries: [...new Map([...previous.entries, ...next.entries].map(entry => [entry.path, entry])).values()],
        issues: [...new Map([...previous.issues, ...next.issues].map(issue => [`${issue.path}:${issue.code}`, issue])).values()],
        scanComplete: previous.scanComplete && next.scanComplete,
      } : next);
    } catch (cause) {
      if (controller.signal.aborted) return;
      // An unsuccessful page is not a snapshot, and may indicate revoked access.
      setPage(undefined);
      setError(documentSourceError(cause, en));
    } finally { if (!controller.signal.aborted) setLoading(false); }
  };
  useEffect(() => {
    void readPage();
    return () => request.current?.abort();
  }, [workspaceId, source.projectId, source.revision]);
  const tree = useMemo(() => {
    const root: DirectoryTree = { directories: new Map(), files: [] };
    for (const entry of page?.entries || []) {
      const segments = entry.path.split('/');
      segments.pop();
      let directory = root;
      for (const name of segments) {
        let child = directory.directories.get(name);
        if (!child) { child = { directories: new Map(), files: [] }; directory.directories.set(name, child); }
        directory = child;
      }
      directory.files.push(entry);
    }
    return root;
  }, [page?.entries]);
  const backToFiles = () => {
    const previousPath = selectedPath;
    onSelect('');
    requestAnimationFrame(() => {
      const button = Array.from(fileList.current?.querySelectorAll<HTMLButtonElement>('button[data-source-path]') || []).find(item => item.dataset.sourcePath === previousPath);
      (button || listHeading.current)?.focus();
    });
  };
  const denyReading = useCallback((cause: unknown) => {
    request.current?.abort();
    setPage(undefined);
    setLoading(false);
    setError(documentSourceError(cause, en));
  }, [en]);
  return <div className={`document-source-browser${selectedPath && !error ? ' has-selection' : ''}`}>
    <div ref={fileList} className="document-source-files" aria-busy={loading}>
      <div className="document-source-list-heading"><h3 ref={listHeading} tabIndex={-1}>{scopeLabel}</h3><p>{en ? 'External source · ' : '外部来源 · '}{page?.entries.length ?? 0} {en ? 'files loaded' : '个文件已加载'} · revision {source.revision}</p></div>
      {loading && <p className="document-source-state" role="status"><LoaderCircle size={16} className="spin" />{page ? en ? 'Loading the next page…' : '正在加载下一页…' : en ? 'Scanning Markdown files…' : '正在扫描 Markdown 文件…'}</p>}
      {error && <div className="document-source-state document-source-error" role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={onRefresh}>{en ? 'Refresh from the beginning' : '刷新并从头读取'}</button></div>}
      {page && <>
        {!page.scanComplete && <p className="document-source-warning" role="alert">{en ? 'The scan is incomplete. Files may have been excluded or scanning limited. This is not a complete or empty directory snapshot.' : '扫描不完整：部分文件可能被排除或扫描受到限制，不能视为完整目录或空目录。'}</p>}
        {!!page.issues.length && <details className="document-source-issues"><summary>{page.issues.length} {en ? 'scan issue(s) / excluded paths' : '条扫描问题 / 排除路径'}</summary><ul>{page.issues.map(issue => <li key={`${issue.path}:${issue.code}`}><code>{issue.path || '.'}</code><span>{issue.code}</span></li>)}</ul></details>}
        {!!page.entries.length && <ul className="document-source-tree" aria-label={en ? 'Markdown directory hierarchy' : 'Markdown 目录层级'}><DirectoryBranch tree={tree} selectedPath={selectedPath} scopeLabel={scopeLabel} en={en} onSelect={onSelect} /></ul>}
        {!page.entries.length && !page.nextCursor && page.scanComplete && !page.issues.length && <p className="document-source-state" role="status">{en ? 'No ordinary Markdown files were found in this directory or its subdirectories.' : '此目录及其子目录中没有普通 Markdown 文件。'}</p>}
        {page.nextCursor ? <div className="document-source-pagination"><p>{en ? 'More results remain. Continue to see all files.' : '尚有后续结果，请继续加载以查看全部文件。'}</p><button type="button" className="secondary-button" disabled={loading} onClick={() => void readPage(page.nextCursor!)}>{loading ? en ? 'Loading…' : '正在加载…' : en ? 'Load more Markdown files' : '继续加载 Markdown 文件'}</button></div>
          : <p className="document-source-scan-summary" role="status">{page.scanComplete && !page.issues.length ? en ? 'All scan results loaded.' : '扫描结果已全部加载。' : en ? 'No further page; the scan has exclusions or is incomplete. Review the issues above.' : '无后续分页，但扫描有排除项或尚不完整，请核对上方问题。'}</p>}
      </>}
    </div>
    {!error && <div className="document-source-reader">
      {selectedPath ? <SourceContent key={`${source.revision}:${selectedPath}`} workspaceId={workspaceId} source={source} path={selectedPath} en={en} scopeLabel={scopeLabel} onBack={backToFiles} onRefresh={onRefresh} onDenied={denyReading} />
        : <p className="document-source-state">{en ? 'Choose a file to read. Filename and relative path identify it within this source; no PM ID or frontmatter is required.' : '选择文件阅读。文件名和相对路径区分此来源内的文件，无需 PM ID 或 frontmatter。'}</p>}
    </div>}
  </div>;
}

function DirectoryBranch({ tree, selectedPath, scopeLabel, en, onSelect }: {
  tree: DirectoryTree; selectedPath: string; scopeLabel: string; en: boolean; onSelect: (path: string) => void;
}) {
  return <>
    {[...tree.directories].map(([name, directory]) => <li className="document-source-directory" key={`directory:${name}`}><details open><summary><Folder size={14} /><span>{name}</span></summary><ul><DirectoryBranch tree={directory} selectedPath={selectedPath} scopeLabel={scopeLabel} en={en} onSelect={onSelect} /></ul></details></li>)}
    {tree.files.map(entry => <li key={`file:${entry.path}`}><button type="button" data-source-path={entry.path} aria-current={entry.path === selectedPath ? 'true' : undefined} aria-label={`${entry.name} · ${entry.path} · ${scopeLabel}`} title={entry.path} onClick={() => onSelect(entry.path)}><FileText size={15} /><span><strong>{entry.name}</strong><code>{entry.path}</code><small>{formatSize(entry.size)} · {formatModified(entry.modifiedAt, en)}</small></span></button></li>)}
  </>;
}

// The existing passive URL components enforce safe protocols. An external
// document adds a stricter boundary: no relative URL, entity/attachment embed,
// raw HTML or script can request another workspace or host-relative resource.
const externalMarkdownComponents: Components = { a: MarkdownUrlLink, img: MarkdownUrlImage };
function SourceContent({ workspaceId, source, path, en, scopeLabel, onBack, onRefresh, onDenied }: {
  workspaceId: string; source: DocumentSource; path: string; en: boolean; scopeLabel: string; onBack: () => void; onRefresh: () => void; onDenied: (cause: unknown) => void;
}) {
  const [content, setContent] = useState<DocumentSourceContent>();
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const prefix = `external-md-${useId().replace(/[^a-zA-Z0-9]/g, '')}-`;
  useEffect(() => {
    const controller = new AbortController();
    setContent(undefined); setError('');
    heading.current?.focus({ preventScroll: true });
    void readDocumentSourceContent(workspaceId, source, path, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.path !== path || result.sourceRevision !== source.revision) throw new DocumentSourceRequestError(409, 'document_source_cursor_invalid');
      setContent(result);
    }).catch(cause => {
      if (controller.signal.aborted) return;
      setContent(undefined);
      if (cause instanceof DocumentSourceRequestError && (cause.status === 401 || cause.status === 403)) onDenied(cause);
      else setError(documentSourceError(cause, en));
    });
    return () => controller.abort();
  }, [workspaceId, source.projectId, source.revision, path, en, onDenied]);
  return <>
    <header className="document-source-content-heading"><button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={14} />{en ? 'Back to files' : '返回目录'}</button><div><h3 ref={heading} tabIndex={-1}>{path.split('/').at(-1)}</h3><p>{scopeLabel} · {en ? 'External · Read only' : '外部 · 只读'}</p><code>{path}</code>{content && <p>{formatSize(content.size)} · {formatModified(content.modifiedAt, en)}</p>}</div></header>
    {error ? <div className="document-source-state document-source-error" role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={onRefresh}>{en ? 'Refresh source and file' : '刷新来源及文件'}</button></div>
      : content ? <><p className="document-source-resource-notice">{en ? 'Read-only Markdown. Raw HTML and relative resources are disabled; PM embeds are not resolved.' : '只读 Markdown：禁用原始 HTML 与相对资源，不解析 PM 实体嵌入。'}</p><article className="markdown-preview document-source-markdown" data-testid="external-document-preview"><ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} skipHtml remarkRehypeOptions={{ clobberPrefix: prefix }} components={externalMarkdownComponents} urlTransform={url => /^(?:https?:|mailto:)/i.test(url) ? url : ''}>{content.content}</ReactMarkdown>{!content.content && <p className="document-source-hint">{en ? 'This Markdown file is empty.' : '此 Markdown 文件正文为空。'}</p>}</article></>
        : <p className="document-source-state" role="status"><LoaderCircle size={16} className="spin" />{en ? 'Reading the file from the backend…' : '正在从后端读取文件正文…'}</p>}
  </>;
}

function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
function formatModified(value: string, en: boolean) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(en ? 'en-US' : 'zh-CN');
}
