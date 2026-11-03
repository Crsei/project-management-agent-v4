import { documentSourceContentSchema, documentSourceFilesSchema, documentSourceMutationReceiptSchema, documentSourcesSchema, type DocumentSource, type DocumentSourceFiles, type DocumentSourceMutation } from '../../../../../../packages/contracts/src/document-sources.ts';

export class DocumentSourceRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message || code || `HTTP ${status}`);
    this.name = 'DocumentSourceRequestError';
    this.status = status;
    this.code = code;
  }
}

/** Missing files/receipts do not prove that source authorization was revoked. */
export function documentSourceAccessLost(error: unknown): boolean {
  return error instanceof DocumentSourceRequestError && ([401, 403].includes(error.status) || error.status === 404 && !['document_source_file_not_found', 'document_source_operation_not_found'].includes(error.code) || ['document_source_changed', 'document_source_revision_conflict'].includes(error.code));
}

/** Directory documents never share the native entity/draft cache or browser storage. */
export async function documentSourceRequest<T>(url: string, signal: AbortSignal, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method, signal, credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as { error?: string | { code?: string; message?: string }; message?: string } | null;
  if (!response.ok) {
    const error = data?.error;
    const nested = error && typeof error === 'object' ? error : undefined;
    throw new DocumentSourceRequestError(response.status, nested?.code || (typeof error === 'string' ? error : ''), nested?.message || data?.message);
  }
  if (data === null) throw new DocumentSourceRequestError(502, 'invalid_response');
  return data as T;
}

export function documentSourcesBase(workspaceId: string) {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/document-sources`;
}
export async function readDocumentSources(workspaceId: string, signal: AbortSignal) {
  return documentSourcesSchema.parse(await documentSourceRequest<unknown>(documentSourcesBase(workspaceId), signal));
}
export async function readDocumentSourceFiles(workspaceId: string, source: DocumentSource, signal: AbortSignal, cursor?: string) {
  const query = new URLSearchParams({ limit: '200' });
  if (cursor) query.set('cursor', cursor);
  return documentSourceFilesSchema.parse(await documentSourceRequest<unknown>(`${documentSourcesBase(workspaceId)}/${encodeURIComponent(source.sourceId)}/files?${query}`, signal));
}
export async function readDocumentSourceContent(workspaceId: string, source: DocumentSource, path: string, signal: AbortSignal) {
  return documentSourceContentSchema.parse(await documentSourceRequest<unknown>(`${documentSourcesBase(workspaceId)}/${encodeURIComponent(source.sourceId)}/content?${new URLSearchParams({ path })}`, signal));
}

/** Mutations are sent exactly once. Recovery only queries the original ID. */
export async function mutateDocumentSource(workspaceId: string, sourceId: string, input: DocumentSourceMutation) {
  return documentSourceMutationReceiptSchema.parse(await documentSourceRequest<unknown>(`${documentSourcesBase(workspaceId)}/${encodeURIComponent(sourceId)}/operations`, new AbortController().signal, 'POST', input));
}
export async function readDocumentSourceMutation(workspaceId: string, sourceId: string, operationId: string) {
  return documentSourceMutationReceiptSchema.parse(await documentSourceRequest<unknown>(`${documentSourcesBase(workspaceId)}/${encodeURIComponent(sourceId)}/operations/${encodeURIComponent(operationId)}`, new AbortController().signal));
}

/** A tab's remembered path never substitutes for current source authorization. */
export async function readAuthorizedDocumentSourceContent(workspaceId: string, target: { sourceId: string; revision: number; path: string }, signal: AbortSignal) {
  const catalog = await readDocumentSources(workspaceId, signal);
  signal.throwIfAborted();
  const source = catalog.sources.find(item => item.sourceId === target.sourceId);
  if (!source) throw new DocumentSourceRequestError(404, 'not_found_or_forbidden');
  if (source.revision !== target.revision) throw new DocumentSourceRequestError(409, 'document_source_changed');
  if (source.status !== 'available') throw new DocumentSourceRequestError(409, 'document_source_unavailable');
  const content = await readDocumentSourceContent(workspaceId, source, target.path, signal);
  signal.throwIfAborted();
  if (content.path !== target.path || content.sourceRevision !== target.revision) throw new DocumentSourceRequestError(409, 'document_source_changed');
  return { source, content };
}

/** Exhaust every cursor; partial scans stay partial even after the final page. */
export async function readAllDocumentSourceFiles(workspaceId: string, source: DocumentSource, signal: AbortSignal, onPage?: (page: DocumentSourceFiles) => void): Promise<DocumentSourceFiles> {
  const entries = new Map<string, DocumentSourceFiles['entries'][number]>();
  const issues = new Map<string, DocumentSourceFiles['issues'][number]>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let scanComplete = true;
  do {
    const page = await readDocumentSourceFiles(workspaceId, source, signal, cursor);
    signal.throwIfAborted();
    if (page.sourceRevision !== source.revision || page.nextCursor !== null && (!page.nextCursor || cursors.has(page.nextCursor))) throw new DocumentSourceRequestError(409, 'document_source_cursor_invalid');
    if (page.nextCursor) cursors.add(page.nextCursor);
    for (const entry of page.entries) entries.set(entry.fileKey, entry);
    for (const issue of page.issues) issues.set(JSON.stringify([issue.path, issue.code]), issue);
    scanComplete = scanComplete && page.scanComplete;
    const result: DocumentSourceFiles = { entries: [...entries.values()], issues: [...issues.values()], scanComplete, nextCursor: page.nextCursor, sourceRevision: source.revision };
    onPage?.(result);
    if (page.nextCursor === null) return result;
    cursor = page.nextCursor;
  } while (true);
}

const sourceErrors: Record<string, [string, string]> = {
  document_source_revision_conflict: ['来源配置已被其他操作修改，请读取最新版本后核对；输入已保留。', 'The source configuration changed. Read the latest revision before saving; your input is retained.'],
  document_source_file_revision_conflict: ['文件已被其他操作修改。草稿仍保留，请刷新核对并显式采用最新版本后再保存。', 'The file changed elsewhere. Your draft is retained. Refresh, review and explicitly adopt the current revision before saving.'],
  document_source_collision: ['目标路径已存在，不会覆盖。请保留输入并选择另一个相对路径。', 'The destination already exists and will not be overwritten. Your input is retained; choose another relative path.'],
  document_source_destination_draft_conflict: ['目标路径仍有未保存的内存草稿。请先恢复并保存或明确放弃该草稿，再移动文件；不会覆盖本地草稿。', 'The destination still has an unsaved in-memory draft. Recover and save or explicitly discard it before moving; your local draft will not be overwritten.'],
  document_source_operation_not_found: ['原操作尚无法核实，这不证明操作未生效。请保留原操作编号并再次查询，不要重复提交。', 'The original operation cannot yet be verified. This is not proof that nothing happened. Keep its ID and query again; do not resubmit.'],
  document_source_operation_id_conflict: ['此操作编号已用于不同输入，不能重发或替换。请查询原操作结果。', 'This operation ID already belongs to different input. Do not resend or replace it; query the original result.'],
  document_source_cursor_invalid: ['目录或配置在分页期间发生变化，请刷新后从头读取，不能混合旧分页。', 'The directory or configuration changed during pagination. Refresh to restart without mixing snapshots.'],
  document_source_changed: ['来源配置已改变，旧正文已清除。请刷新文件树并从当前来源重新打开文档。', 'The source configuration changed and previous content was cleared. Refresh the file tree and reopen the document from the current source.'],
  document_source_overlap: ['同一关联范围内的目录不可重复或互相包含；其他范围可关联同一目录。', 'Directories in the same association scope must not overlap; other scopes may share the same directory.'],
  document_source_path_forbidden: ['路径不安全、不在允许的目录边界内，或不是可读的普通 Markdown 文件；不会绕过隔离或改用其他目录。', 'The path is unsafe, outside allowed directory boundaries, or not a readable ordinary Markdown file. No isolation boundary or fallback directory is bypassed.'],
  document_source_unavailable: ['来源目录丢失、身份发生变化或不可读，当前读取未完成；不会重建或回退到其他目录。', 'The source directory is missing, replaced or unreadable. The read did not complete; the directory will not be recreated or replaced with a fallback.'],
  document_source_file_not_found: ['此 Markdown 文件已不存在。请刷新目录；未保存的本地草稿会单独保留，不会伪装成磁盘文件。', 'This Markdown file no longer exists. Refresh the directory; any unsaved local draft is retained separately, not presented as a disk file.'],
  document_source_encoding_invalid: ['此文件不是有效的 UTF-8 Markdown，未展示正文。', 'This file is not valid UTF-8 Markdown. Its content has not been shown.'],
  invalid_response: ['服务端响应无法确认，请重新读取。', 'The server response could not be confirmed. Read again.'],
};
export function documentSourceError(error: unknown, en: boolean): string {
  if (error instanceof DocumentSourceRequestError) {
    if (sourceErrors[error.code]) return sourceErrors[error.code][en ? 1 : 0];
    if (error.status === 401 || error.status === 403) return en ? 'Access is no longer available. Sign in and check permission for this scope.' : '当前身份已无法访问，请核对登录状态及此范围的权限。';
    if (error.status === 404) return en ? 'The file, directory or authorized scope is no longer available. No previous content is retained.' : '文件、目录或获授权范围已不存在或不可访问，不会保留旧正文。';
    if (error.status === 413) return en ? 'This file exceeds the server reading limit. Its content has not been truncated or shown.' : '此文件超出服务端正文读取上限；未截断或展示正文。';
  }
  return error instanceof Error ? error.message : String(error);
}
