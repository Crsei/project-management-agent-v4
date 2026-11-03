import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DocumentSource, DocumentSourceAssociationScope, DocumentSourceContent, DocumentSourceEntry, DocumentSourceFiles, DocumentSourceIssue, DocumentSourceMutation, DocumentSourceMutationReceipt } from '../packages/contracts/src/document-sources.ts';
import type { LocalProjectAttempt } from '../packages/contracts/src/local-projects.ts';
import type { LocalProjectFixture, LocalProjectResponse } from './local-project-fixture.ts';

export type DocumentSourceFailure = { error: { code: string; details?: Record<string, unknown> } };
export type DocumentSourceCatalog = { sources: DocumentSource[]; scopes: DocumentSourceAssociationScope[] };
export type DocumentSourceConfiguration = { sources: DocumentSource[]; scope: DocumentSourceAssociationScope };
export function documentSourcesPath(f: LocalProjectFixture, sourceId?: string, workspaceId = f.workspaceId): string {
  return `/api/v1/workspaces/${workspaceId}/document-sources${sourceId ? `/${encodeURIComponent(sourceId)}` : ''}`;
}
export function documentSourceConfigurationPath(f: LocalProjectFixture, workspaceId = f.workspaceId): string {
  return `${documentSourcesPath(f, undefined, workspaceId)}/configuration`;
}
export function documentSourceOperationsPath(f: LocalProjectFixture, sourceId: string, operationId?: string): string {
  return `${documentSourcesPath(f, sourceId)}/operations${operationId ? `/${encodeURIComponent(operationId)}` : ''}`;
}
export async function mutateDocumentSource(f: LocalProjectFixture, sourceId: string, input: DocumentSourceMutation, cookie?: string): Promise<DocumentSourceMutationReceipt> {
  const response = await f.request<DocumentSourceMutationReceipt>(documentSourceOperationsPath(f, sourceId), { method: 'POST', body: input, ...(cookie === undefined ? {} : { cookie }) });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assertPrivateDocumentResponse(response);
  assert.equal(response.body.operationId, input.operationId);
  assert.equal(response.body.action, input.action);
  assert.equal(response.body.path, input.path);
  assert.equal(response.body.status, 'succeeded', JSON.stringify(response.body));
  if (input.action === 'delete') {
    assert.equal(response.body.content, undefined);
  } else {
    assert.ok(response.body.content, 'Successful file writes return their authoritative resulting content');
    assert.equal(response.body.content.path, input.action === 'move' ? input.targetPath : input.path);
    assert.equal(response.body.content.sourceRevision, input.action === 'move' ? input.targetSourceRevision : input.sourceRevision);
    assert.ok(response.body.content.revision);
    assert.equal(response.body.content.size, Buffer.byteLength(response.body.content.content));
    if (input.action !== 'move') assert.equal(response.body.content.content, input.content);
  }
  return response.body;
}
export async function readDocumentSourceMutation(f: LocalProjectFixture, sourceId: string, operationId: string, cookie?: string): Promise<DocumentSourceMutationReceipt> {
  const response = await f.request<DocumentSourceMutationReceipt>(documentSourceOperationsPath(f, sourceId, operationId), cookie === undefined ? {} : { cookie });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assertPrivateDocumentResponse(response);
  assert.equal(response.body.operationId, operationId);
  return response.body;
}
export function assertPrivateDocumentResponse(response: LocalProjectResponse<unknown>): void {
  const cache = response.headers.get('cache-control') ?? '';
  assert.match(cache, /\bprivate\b/i, 'Document source responses must not enter a shared cache');
  assert.match(cache, /\bno-store\b/i, 'Source bodies and host paths must not be stored in caches');
}
export function assertDocumentSourceFailure(response: LocalProjectResponse<unknown>, statuses: readonly number[], code?: string): asserts response is LocalProjectResponse<DocumentSourceFailure> {
  assert.ok(statuses.includes(response.status), `Expected ${statuses.join('/')} but received ${response.status}`);
  assert.ok(response.body && typeof response.body === 'object' && 'error' in response.body, 'Rejected requests return an explicit error');
  const error = (response.body as DocumentSourceFailure).error;
  assert.equal(typeof error?.code, 'string');
  if (code) assert.equal(error.code, code);
}
export async function createDocumentProject(f: LocalProjectFixture, title: string, folderName: string): Promise<Extract<LocalProjectAttempt, { status: 'ready' }>> {
  const response = await f.request<LocalProjectAttempt>(`/api/v1/workspaces/${f.workspaceId}/local-projects/initializations`, {
    method: 'POST', headers: { 'Idempotency-Key': randomUUID() },
    body: { input: { entity: 'project', title, body: 'Native PM project authority remains independent of external Markdown.' }, directory: { mode: 'new', parentPath: f.parents[0], folderName } },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  if (response.body.status !== 'ready') throw new Error('The isolated native project did not initialize');
  return response.body;
}
export async function readDocumentSourceCatalog(f: LocalProjectFixture, cookie?: string, workspaceId = f.workspaceId): Promise<DocumentSourceCatalog> {
  const response = await f.request<DocumentSourceCatalog>(documentSourcesPath(f, undefined, workspaceId), cookie === undefined ? {} : { cookie });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assertPrivateDocumentResponse(response);
  assert.ok(Array.isArray(response.body.sources));
  assert.ok(Array.isArray(response.body.scopes));
  assert.equal(new Set(response.body.sources.map(source => source.sourceId)).size, response.body.sources.length);
  return response.body;
}
export async function readDocumentSources(f: LocalProjectFixture, cookie?: string, workspaceId = f.workspaceId): Promise<DocumentSource[]> {
  return (await readDocumentSourceCatalog(f, cookie, workspaceId)).sources;
}
export async function configureDocumentSources(f: LocalProjectFixture, projectId: string | null, paths: string[], expectedRevision: number, options: { cookie?: string; workspaceId?: string } = {}): Promise<DocumentSourceConfiguration> {
  const response = await f.request<DocumentSourceConfiguration>(documentSourceConfigurationPath(f, options.workspaceId), {
    method: 'PUT', body: { projectId, paths, expectedRevision }, ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assertPrivateDocumentResponse(response);
  assert.equal(response.body.scope.projectId, projectId);
  assert.equal(response.body.scope.revision, expectedRevision + 1);
  assert.deepEqual(response.body.sources.map(source => source.path).sort(), [...paths].sort());
  for (const source of response.body.sources) {
    assert.equal(source.projectId, projectId);
    assert.equal(source.status, 'available');
    assert.match(source.sourceId, /^[A-Za-z0-9_-]+$/);
    assert.ok(source.revision > 0);
  }
  return response.body;
}
export async function configureDocumentSource(f: LocalProjectFixture, projectId: string | null, path: string, expectedRevision: number): Promise<DocumentSource> {
  const configured = await configureDocumentSources(f, projectId, [path], expectedRevision);
  assert.equal(configured.sources.length, 1);
  return configured.sources[0]!;
}
export async function readSourceContent(f: LocalProjectFixture, sourceId: string, path: string, cookie?: string): Promise<DocumentSourceContent> {
  const response = await f.request<DocumentSourceContent>(`${documentSourcesPath(f, sourceId)}/content?${new URLSearchParams({ path })}`, cookie === undefined ? {} : { cookie });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assertPrivateDocumentResponse(response);
  assert.equal(response.body.path, path);
  assert.equal(response.body.size, Buffer.byteLength(response.body.content));
  assert.ok(Number.isFinite(Date.parse(response.body.modifiedAt)), 'Content has an actual modification timestamp');
  assert.equal(typeof response.body.revision, 'string');
  assert.ok(response.body.revision.length > 0, 'Content carries an opaque file revision distinct from the source configuration');
  assert.equal(typeof response.body.canWrite, 'boolean');
  return response.body;
}
export async function collectDocumentFiles(f: LocalProjectFixture, sourceId: string, options: { cookie?: string; limit?: number } = {}): Promise<{ entries: DocumentSourceEntry[]; issues: DocumentSourceIssue[]; scanComplete: boolean; pages: number; sourceRevision: number }> {
  const entries: DocumentSourceEntry[] = [], issues: DocumentSourceIssue[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null, scanComplete = true, pages = 0, sourceRevision: number | undefined;
  do {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (cursor !== null) query.set('cursor', cursor);
    const response = await f.request<DocumentSourceFiles>(`${documentSourcesPath(f, sourceId)}/files?${query}`, options.cookie === undefined ? {} : { cookie: options.cookie });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assertPrivateDocumentResponse(response);
    assert.ok(Array.isArray(response.body.entries));
    assert.ok(Array.isArray(response.body.issues));
    assert.equal(typeof response.body.scanComplete, 'boolean');
    sourceRevision ??= response.body.sourceRevision;
    assert.equal(response.body.sourceRevision, sourceRevision, 'A traversal must not mix configurations');
    for (const entry of response.body.entries) {
      assert.ok(entry.path && !entry.path.startsWith('/') && !entry.path.includes('\\'));
      assert.equal(entry.name, entry.path.split('/').at(-1));
      assert.equal(typeof entry.fileKey, 'string');
      assert.ok(entry.fileKey.length >= 32, 'Canonical file identity is opaque, not a filename');
      assert.equal(entry.fileKey.includes(f.root), false);
      assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0);
      assert.ok(Number.isFinite(Date.parse(entry.modifiedAt)));
      assert.equal('content' in entry, false, 'Listing is not an eager body read');
      entries.push(entry);
    }
    issues.push(...response.body.issues);
    scanComplete &&= response.body.scanComplete;
    cursor = response.body.nextCursor;
    assert.ok(cursor === null || typeof cursor === 'string');
    if (cursor !== null) {
      assert.equal(cursors.has(cursor), false, 'Pagination must advance rather than loop');
      cursors.add(cursor);
    }
    pages++;
    assert.ok(pages <= 1000, 'A bounded fixture must have a finite traversal');
  } while (cursor !== null);
  assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length, 'A file appears once across pages');
  return { entries, issues, scanComplete, pages, sourceRevision: sourceRevision! };
}

/** Ordinary, readable files only: unsafe entries belong in a separate security fixture. */
export async function seedDocumentTree(root: string, bulkCount = 215): Promise<Map<string, Buffer>> {
  const bytes = new Map<string, Buffer>([
    ['根目录.md', Buffer.from('# 根目录\r\n\r\n没有 frontmatter，也不应转换为 PM 实体。\r\n')],
    ['同名.md', Buffer.from('Root duplicate basename.\n')],
    ['层级 一/同名.md', Buffer.from('# 第一层\n不同的完整相对路径。\n')],
    ['层级 一/更 深/同名.md', Buffer.from('# 第二层\nActual nested Markdown.\n')],
    ['空 格.MD', Buffer.from('# Uppercase Markdown extension\n')],
    ['无 frontmatter.md', Buffer.from('Plain Markdown without metadata or an ID.\n')],
    ['特殊字符 # ?.md', Buffer.from('# Query-safe path\n路径中的 # 和 ? 不是 URL 参数。\n')],
    ['not-markdown.txt', Buffer.from('Never enumerate or read this as a Markdown document.\n')],
    ['not-markdown.markdown', Buffer.from('Only the md extension is in scope.\n')],
    ['original.bin', Buffer.from([0, 255, 13, 10, 0, 42])],
  ]);
  for (let index = 0; index < bulkCount; index++) bytes.set(`分页/条目 ${String(index).padStart(3, '0')}.md`, Buffer.from(`# Page entry ${index}\nNo PM frontmatter.\n`));
  for (const [path, content] of bytes) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return bytes;
}
export async function assertDocumentBytesUnchanged(root: string, expected: ReadonlyMap<string, Buffer>): Promise<void> {
  for (const [path, bytes] of expected) assert.deepEqual(await readFile(join(root, path)), bytes, `External source bytes changed: ${path}`);
}
