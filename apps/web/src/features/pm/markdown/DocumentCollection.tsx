import { useMemo } from 'react';
import { ArrowUpRight, FolderInput, Pencil, Trash2 } from 'lucide-react';
import type { FileRecord } from '@pm-schema';
import type { DocumentSource, DocumentSourceAssociationScope } from '../../../../../../packages/contracts/src/document-sources';
import type { DocumentSort, DocumentSourceFilter, DocumentTypeFilter } from './document-collection-model';
import { buildDocumentRows, filterDocumentRows, sortDocumentRows } from './document-collection-model';
import { useDocumentSourceFiles } from './DocumentSources';
import type { ExternalManagementIntent, ExternalTarget } from './external-document-state';


type Props = {
  files: FileRecord[];
  projects: FileRecord[];
  workspaceId: string;
  sources: readonly DocumentSource[];
  scopes: readonly DocumentSourceAssociationScope[];
  sourceRequest: string;
  filters: { source: DocumentSourceFilter; type: DocumentTypeFilter; sort: DocumentSort; projectId: string; search: string };
  en: boolean;
  onOpenNative: (file: FileRecord) => void;
  onOpenExternal: (target: ExternalTarget) => void;
  onManageExternal: (intent: ExternalManagementIntent) => void;
  onReloadSources: () => void;
};

export function DocumentCollection({ files, projects, workspaceId, sources, scopes, sourceRequest, filters, en, onOpenNative, onOpenExternal, onManageExternal, onReloadSources }: Props) {
  const reads = useDocumentSourceFiles(workspaceId, sources, true, sourceRequest, en);
  const projectNames = useMemo(() => new Map([...projects.map(project => [project.id, project.entity.title] as const), ...scopes.filter(scope => scope.projectId !== null).map(scope => [scope.projectId!, scope.name] as const)]), [projects, scopes]);
  const rows = useMemo(() => buildDocumentRows(files, sources.flatMap(source => {
    const page = reads[source.sourceId]?.page;
    return page && page.sourceRevision === source.revision ? [{ source, entries: page.entries }] : [];
  }), projectNames, en), [files, reads, sources, projectNames, en]);
  const visible = useMemo(() => sortDocumentRows(filterDocumentRows(rows, filters), filters.sort), [rows, filters]);
  const rowActions = [
    { action: 'rename' as const, label: en ? 'Rename' : '重命名', Icon: Pencil },
    { action: 'move' as const, label: en ? 'Move' : '移动', Icon: FolderInput },
    { action: 'delete' as const, label: en ? 'Delete' : '删除', Icon: Trash2 },
  ];
  const showActions = sources.some(source => source.canWrite && source.status === 'available');
  const loading = sources.some(source => source.status === 'available' && (!reads[source.sourceId] || reads[source.sourceId]?.status === 'loading'));

  return <div className="document-collection" data-testid="document-collection">
    {sources.map(source => {
      const read = reads[source.sourceId];
      const label = `${source.name} · ${source.projectId ? projectNames.get(source.projectId) || source.projectId : en ? 'Workspace common documents' : '工作区公共文档'}`;
      return source.status === 'unavailable' || read?.status === 'error'
        ? <div key={source.sourceId} className="inline-error" role="alert"><p><strong>{label}</strong> · {en ? 'This source could not be read; it is not known to be empty. Other documents remain available.' : '此来源读取失败，不能视为空目录；其他文档仍可访问。'} {read?.error || source.reason}</p><button type="button" className="secondary-button" onClick={onReloadSources}>{en ? 'Read external documents again' : '重新读取外部文档'}</button></div>
        : null;
    })}
    {visible.length > 0 ? <div className="pm-view document-collection-table">
      <div className="table-scroll">
        <table className="work-table">
          <thead><tr><th>{en ? 'Document' : '文档名称'}</th><th>{en ? 'Type' : '类型'}</th><th>{en ? 'Project' : '项目'}</th>{showActions && <th aria-label={en ? 'Actions' : '操作'} />}</tr></thead>
          <tbody>{visible.map(row => {
            const updated = row.updatedAt === null ? (en ? 'Update time unavailable' : '更新时间不可用') : new Date(row.updatedAt).toLocaleString(en ? 'en-US' : 'zh-CN');
            const secondary = row.source === 'native' ? row.file.id : `${row.sourceName} · ${row.entry.path.includes('/') ? row.entry.path.slice(0, row.entry.path.lastIndexOf('/')) : '.'}`;
            const title = row.source === 'external' ? `${row.sourceName} · ${row.sourceId} · ${row.entry.path} · ${updated}` : updated;
            return <tr key={row.key} className={row.source === 'native' ? '' : undefined}>
              <td><button type="button" className="table-title" title={title} aria-label={`${row.title} · ${row.typeLabel} · ${row.projectLabel}`} onClick={() => row.source === 'native' ? onOpenNative(row.file) : onOpenExternal({ kind: 'external', sourceId: row.sourceId, revision: row.revision, path: row.entry.path })}><strong>{row.title}</strong>{secondary && <span className="mono">{secondary}</span>}</button></td>
              <td><span className="muted">{row.typeLabel}</span></td>
              <td><span className="muted" title={row.projectLabel}>{row.projectLabel}</span></td>
              {showActions && <td><div className="document-source-row-actions">
                <button type="button" className="icon-button" title={en ? 'Open' : '打开'} aria-label={`${en ? 'Open' : '打开'} ${row.title}`} onClick={() => row.source === 'native' ? onOpenNative(row.file) : onOpenExternal({ kind: 'external', sourceId: row.sourceId, revision: row.revision, path: row.entry.path })}><ArrowUpRight size={14} aria-hidden="true" /></button>
                {row.source === 'external' && row.canWrite && rowActions.map(({ action, label, Icon }) => <button type="button" className="icon-button" key={action} title={`${label} ${row.title}`} aria-label={`${label} ${row.title}`} onClick={() => onManageExternal({ action, target: { kind: 'external', sourceId: row.sourceId, revision: row.revision, path: row.entry.path } })}><Icon size={14} aria-hidden="true" /></button>)}
              </div></td>}
            </tr>;
          })}</tbody>
        </table>
      </div>
    </div> : <div className="empty-state" role="status">{loading ? (en ? 'Reading documents…' : '正在读取文档…') : (en ? 'No documents match these filters.' : '没有匹配这些筛选条件的文档。')}</div>}
    {loading && visible.length > 0 && <p className="document-source-state" role="status">{en ? 'Reading all pages of authorized external documents…' : '正在读取授权外部文档的全部分页…'}</p>}
  </div>;
}
