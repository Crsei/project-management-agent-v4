import { documentSourceContentSchema, documentSourceFilesSchema, documentSourcesSchema, type DocumentSource } from '../../../../../../packages/contracts/src/document-sources';

export class DocumentSourceRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message || code || `HTTP ${status}`);
    this.name = 'DocumentSourceRequestError';
  }
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
export function documentSourceScope(source: DocumentSource) { return source.projectId || 'workspace'; }
export async function readDocumentSources(workspaceId: string, signal: AbortSignal) {
  return documentSourcesSchema.parse(await documentSourceRequest<unknown>(documentSourcesBase(workspaceId), signal));
}
export async function readDocumentSourceFiles(workspaceId: string, source: DocumentSource, signal: AbortSignal, cursor?: string) {
  const query = new URLSearchParams({ limit: '200' });
  if (cursor) query.set('cursor', cursor);
  return documentSourceFilesSchema.parse(await documentSourceRequest<unknown>(`${documentSourcesBase(workspaceId)}/${encodeURIComponent(documentSourceScope(source))}/files?${query}`, signal));
}
export async function readDocumentSourceContent(workspaceId: string, source: DocumentSource, path: string, signal: AbortSignal) {
  return documentSourceContentSchema.parse(await documentSourceRequest<unknown>(`${documentSourcesBase(workspaceId)}/${encodeURIComponent(documentSourceScope(source))}/content?${new URLSearchParams({ path })}`, signal));
}

const sourceErrors: Record<string, [string, string]> = {
  document_source_revision_conflict: ['来源配置已被其他操作修改，请读取最新版本后核对；输入已保留。', 'The source configuration changed. Read the latest revision before saving; your input is retained.'],
  document_source_cursor_invalid: ['目录或配置在分页期间发生变化，请刷新后从头读取，不能混合旧分页。', 'The directory or configuration changed during pagination. Refresh to restart without mixing snapshots.'],
  document_source_overlap: ['此目录与另一个已配置的文档来源相同或互为父子目录。为避免重复收录，请选择互不包含的目录，或先解除已有来源。', 'This directory equals, contains, or is contained by another configured document source. Choose non-overlapping directories or disconnect the existing source to avoid duplicate documents.'],
  document_source_path_forbidden: ['路径不安全、不在允许的目录边界内，或不是可读的普通 Markdown 文件；不会绕过隔离或改用其他目录。', 'The path is unsafe, outside allowed directory boundaries, or not a readable ordinary Markdown file. No isolation boundary or fallback directory is bypassed.'],
  document_source_unavailable: ['来源目录丢失、身份发生变化或不可读，当前读取未完成；不会重建或回退到其他目录。', 'The source directory is missing, replaced or unreadable. The read did not complete; the directory will not be recreated or replaced with a fallback.'],
  document_source_unconfigured: ['此范围当前未关联目录，请重新读取来源配置。', 'This scope currently has no linked directory. Read the source configuration again.'],
  document_source_file_not_found: ['此 Markdown 文件已不存在，请刷新目录以查看当前文件。旧正文已清除。', 'This Markdown file no longer exists. Refresh the directory to see current files. Previous content has been cleared.'],
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
