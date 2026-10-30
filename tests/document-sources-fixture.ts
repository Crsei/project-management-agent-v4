import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DocumentSource, DocumentSourceContent, DocumentSourceEntry, DocumentSourceFiles, DocumentSourceIssue } from '../packages/contracts/src/document-sources.ts';
import type { LocalProjectAttempt } from '../packages/contracts/src/local-projects.ts';
import type { LocalProjectFixture, LocalProjectResponse } from './local-project-fixture.ts';

export type DocumentSourceFailure = { error: { code: string; details?: Record<string, unknown> } };
export function documentSourcesPath(f: LocalProjectFixture, scopeKey?: string, workspaceId = f.workspaceId): string {
  return `/api/v1/workspaces/${workspaceId}/document-sources${scopeKey ? `/${encodeURIComponent(scopeKey)}` : ''}`;
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
export async function readDocumentSources(f: LocalProjectFixture, cookie?: string, workspaceId = f.workspaceId): Promise<DocumentSource[]> {
  const response = await f.request<{ sources: DocumentSource[] }>(documentSourcesPath(f, undefined, workspaceId), cookie === undefined ? {} : { cookie });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assertPrivateDocumentResponse(response);
  assert.ok(Array.isArray(response.body.sources));
  return response.body.sources;
}
export async function saveDocumentSource(f: LocalProjectFixture, scopeKey: string, path: string | null, expectedRevision: number): Promise<DocumentSource> {
  const response = await f.request<{ source: DocumentSource }>(documentSourcesPath(f, scopeKey), { method: 'PUT', body: { path, expectedRevision } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assertPrivateDocumentResponse(response);
  assert.equal(response.body.source.path, path);
  assert.equal(response.body.source.revision, expectedRevision + 1);
  assert.equal(response.body.source.status, path === null ? 'unconfigured' : 'available');
  return response.body.source;
}
export async function readSourceContent(f: LocalProjectFixture, scopeKey: string, path: string, cookie?: string): Promise<DocumentSourceContent> {
  const response = await f.request<DocumentSourceContent>(`${documentSourcesPath(f, scopeKey)}/content?${new URLSearchParams({ path })}`, cookie === undefined ? {} : { cookie });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assertPrivateDocumentResponse(response);
  assert.equal(response.body.path, path);
  assert.equal(response.body.size, Buffer.byteLength(response.body.content));
  assert.ok(Number.isFinite(Date.parse(response.body.modifiedAt)), 'Content has an actual modification timestamp');
  return response.body;
}
export async function collectDocumentFiles(f: LocalProjectFixture, scopeKey: string, options: { cookie?: string; limit?: number } = {}): Promise<{ entries: DocumentSourceEntry[]; issues: DocumentSourceIssue[]; scanComplete: boolean; pages: number; sourceRevision: number }> {
  const entries: DocumentSourceEntry[] = [], issues: DocumentSourceIssue[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null, scanComplete = true, pages = 0, sourceRevision: number | undefined;
  do {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (cursor !== null) query.set('cursor', cursor);
    const response = await f.request<DocumentSourceFiles>(`${documentSourcesPath(f, scopeKey)}/files?${query}`, options.cookie === undefined ? {} : { cookie: options.cookie });
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
