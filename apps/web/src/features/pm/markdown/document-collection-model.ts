import type { DocumentKind, FileRecord } from '@pm-schema';
import { documentKindLabels } from '../../../../../../packages/pm-views/document-kind.ts';
import type { DocumentSource, DocumentSourceEntry } from '../../../../../../packages/contracts/src/document-sources';

export type DocumentSourceFilter = 'all' | 'native' | 'external';
export type DocumentTypeFilter = 'all' | DocumentKind | 'work_item' | 'external';
export type DocumentSort = 'updated' | 'title';

type DocumentRowBase = {
  key: string;
  title: string;
  type: DocumentTypeFilter;
  typeLabel: string;
  projectId: string | null;
  projectLabel: string;
  updatedAt: number | null;
  searchText: string;
};
export type NativeDocumentRow = DocumentRowBase & { source: 'native'; file: FileRecord };
export type ExternalDocumentRow = DocumentRowBase & {
  source: 'external';
  entry: DocumentSourceEntry;
  sourceId: string;
  sourceName: string;
  revision: number;
  canWrite: boolean;
  associations: { sourceId: string; sourceName: string; revision: number; projectId: string | null; label: string; canWrite: boolean; entry: DocumentSourceEntry }[];
};
export type DocumentRow = NativeDocumentRow | ExternalDocumentRow;

export type ExternalSourceEntries = { source: DocumentSource; entries: readonly DocumentSourceEntry[] };
export function buildDocumentRows(nativeFiles: readonly FileRecord[], externalSources: readonly ExternalSourceEntries[], projectNames: ReadonlyMap<string, string>, en: boolean): DocumentRow[] {
  const nativeRows = nativeFiles.filter(file => file.entity.entity === 'document' || file.entity.entity === 'work_item').map((file): NativeDocumentRow => {
    const kind = file.entity.entity === 'work_item' ? 'work_item' : (file.entity.document_kind ?? 'note') as DocumentKind;
    const projectId = file.entity.project ?? null;
    const projectLabel = projectId ? projectNames.get(projectId) ?? projectId : en ? 'No project' : '未关联项目';
    const rawUpdated = (file.entity as Record<string, unknown>)['x-pm-updated-at'];
    const updatedAt = typeof rawUpdated === 'string' && !Number.isNaN(Date.parse(rawUpdated)) ? Date.parse(rawUpdated) : null;
    return {
      key: `native:${file.id}`,
      source: 'native',
      file,
      title: file.entity.title,
      type: kind,
      typeLabel: kind === 'work_item' ? (en ? 'Task' : '任务') : documentKindLabels[kind]?.[en ? 'en' : 'zh'] ?? kind,
      projectId,
      projectLabel,
      updatedAt,
      searchText: `${file.entity.title} ${file.id} ${projectLabel}`.toLocaleLowerCase(),
    };
  });
  const sharedFiles = new Map<string, ExternalDocumentRow['associations']>();
  for (const { source, entries } of externalSources) {
    if (source.status !== 'available') continue;
    const label = source.projectId ? projectNames.get(source.projectId) ?? source.projectId : en ? 'Workspace common documents' : '工作区公共文档';
    for (const entry of entries) {
      const associations = sharedFiles.get(entry.fileKey) || [];
      if (!associations.some(item => item.sourceId === source.sourceId)) associations.push({ sourceId: source.sourceId, sourceName: source.name, revision: source.revision, projectId: source.projectId, label, canWrite: source.canWrite, entry });
      sharedFiles.set(entry.fileKey, associations);
    }
  }
  const externalRows = [...sharedFiles].map(([fileKey, associations]): ExternalDocumentRow => {
    const primary = associations.find(item => item.canWrite) || associations[0];
    const projectLabel = [...new Set(associations.map(item => item.label))].join(' · ');
    return {
      key: `external:${fileKey}`,
      source: 'external',
      entry: primary.entry,
      sourceId: primary.sourceId,
      sourceName: primary.sourceName,
      revision: primary.revision,
      canWrite: primary.canWrite,
      associations,
      title: primary.entry.name,
      type: 'external',
      typeLabel: en ? 'External documents' : '外部文档',
      projectId: primary.projectId,
      projectLabel,
      updatedAt: Number.isNaN(Date.parse(primary.entry.modifiedAt)) ? null : Date.parse(primary.entry.modifiedAt),
      searchText: `${associations.map(item => `${item.sourceName} ${item.entry.name} ${item.entry.path}`).join(' ')} ${projectLabel}`.toLocaleLowerCase(),
    };
  });
  return [...nativeRows, ...externalRows];
}

export function filterDocumentRows(rows: DocumentRow[], filters: { source: DocumentSourceFilter; type: DocumentTypeFilter; projectId: string; search: string }): DocumentRow[] {
  const needle = filters.search.trim().toLocaleLowerCase();
  return rows.flatMap<DocumentRow>(row => {
    if ((filters.source !== 'all' && row.source !== filters.source) || (filters.type !== 'all' && row.type !== filters.type) || needle && !row.searchText.includes(needle)) return [];
    if (!filters.projectId) return [row];
    if (row.source === 'native') return row.projectId === filters.projectId ? [row] : [];
    const associations = row.associations.filter(item => item.projectId === filters.projectId);
    const primary = associations.find(item => item.canWrite) || associations[0];
    // A project-filtered action uses that project's authorized alias, not a writable
    // alias in a different project that happens to refer to the same physical file.
    return primary ? [{ ...row, sourceId: primary.sourceId, sourceName: primary.sourceName, revision: primary.revision, entry: primary.entry, canWrite: primary.canWrite, projectId: primary.projectId }] : [];
  });
}

export function sortDocumentRows(rows: DocumentRow[], sort: DocumentSort): DocumentRow[] {
  return [...rows].sort((left, right) => {
    if (left.source !== right.source) return left.source === 'native' ? -1 : 1;
    if (sort === 'title') return left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: 'base' }) || left.key.localeCompare(right.key);
    if (left.updatedAt !== null && right.updatedAt !== null && left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
    if (left.updatedAt === null && right.updatedAt !== null) return 1;
    if (left.updatedAt !== null && right.updatedAt === null) return -1;
    return left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: 'base' }) || left.key.localeCompare(right.key);
  });
}
