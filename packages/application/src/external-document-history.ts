import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DocumentSourceContent } from '../../contracts/src/document-sources.ts';
import type { DocumentSourceRow } from '../../infrastructure/src/document-sources.ts';
import type { ExternalDocumentHistoryAddress, ExternalDocumentHistoryCapture, ExternalDocumentHistorySnapshot } from '../../infrastructure/src/document-source-history.ts';
import type { SqlExecutor } from './ports.ts';

export type { ExternalDocumentHistoryAddress, ExternalDocumentHistoryCapture, ExternalDocumentHistoryPrepared, ExternalDocumentHistorySnapshot } from '../../infrastructure/src/document-source-history.ts';
export type ExternalDocumentHistorySink = (sql: SqlExecutor, capture: ExternalDocumentHistoryCapture, resolveAddress?: (expected: ExternalDocumentHistoryAddress) => Promise<ExternalDocumentHistoryAddress>) => Promise<void>;

function normalized(location: string): string {
  const resolved = path.resolve(location);
  return process.platform === 'win32' ? resolved.toLowerCase() : process.platform === 'darwin' ? resolved.normalize('NFD').toLowerCase() : resolved;
}
const digest = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Server-only binding evidence: neither directory paths nor inode values leave the adapter. */
export function externalDocumentHistoryAddress(saved: DocumentSourceRow, relative: string): ExternalDocumentHistoryAddress {
  return {
    sourceId: saved.source_id, path: relative, projectId: saved.project_key || null, sourceRevision: saved.revision,
    rootIdentity: digest(saved.workspace_id, normalized(saved.path!), saved.directory_device!, saved.directory_inode!),
    locationKey: digest(saved.workspace_id, normalized(path.join(saved.path!, relative))),
  };
}
export function externalDocumentHistorySnapshot(content: DocumentSourceContent): ExternalDocumentHistorySnapshot {
  return { content: content.content, revision: content.revision };
}
