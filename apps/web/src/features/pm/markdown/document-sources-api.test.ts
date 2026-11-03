import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentSource, DocumentSourceContent, DocumentSourceFiles } from '../../../../../../packages/contracts/src/document-sources';
import { DocumentSourceRequestError, readAllDocumentSourceFiles, readAuthorizedDocumentSourceContent } from './document-sources-api.ts';

const source: DocumentSource = { sourceId: 'folder-a', projectId: 'PRJ-001', name: 'Authorized project', path: null, revision: 4, status: 'available', canManage: false, canWrite: false };
const target = { sourceId: 'folder-a', revision: 4, path: 'nested/same.md' };
const content: DocumentSourceContent = { path: target.path, content: '# Authorized body', size: 17, modifiedAt: '2026-11-02T00:00:00.000Z', sourceRevision: 4, revision: 'content-revision-1', canWrite: false };
const page = (names: string[], nextCursor: string | null, rest: Partial<DocumentSourceFiles> = {}): DocumentSourceFiles => ({ entries: names.map(path => ({ fileKey: `key:${path}`, path, name: path.split('/').at(-1)!, size: 1, modifiedAt: content.modifiedAt })), nextCursor, scanComplete: true, issues: [], sourceRevision: source.revision, ...rest });
const revisionError = (cause: unknown) => cause instanceof DocumentSourceRequestError && cause.status === 409;

test('external content rechecks the exact authorized sourceId and source revision before reading plaintext', async t => {
  for (const sources of [[], [{ ...source, sourceId: 'folder-b' }], [{ ...source, revision: 5 }], [{ ...source, status: 'unavailable' }]]) {
    const requests: string[] = [];
    const mock = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
      requests.push(String(url));
      assert.equal(options?.cache, 'no-store');
      assert.equal(options?.credentials, 'same-origin');
      return Response.json({ sources, scopes: [] });
    });
    await assert.rejects(readAuthorizedDocumentSourceContent('workspace', target, new AbortController().signal), cause => cause instanceof DocumentSourceRequestError);
    assert.equal(requests.length, 1, 'Unavailable source or stale revision must not issue a body request');
    mock.mock.restore();
  }
});

test('external content rejects a source changed between authorization and the content response', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(++requests === 1 ? { sources: [source], scopes: [] } : { ...content, sourceRevision: 5 }));
  await assert.rejects(readAuthorizedDocumentSourceContent('workspace', target, new AbortController().signal), revisionError);
  assert.equal(requests, 2);
});

test('external content never accepts the body of a different path', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(++requests === 1 ? { sources: [source], scopes: [] } : { ...content, path: 'other/same.md' }));
  await assert.rejects(readAuthorizedDocumentSourceContent('workspace', target, new AbortController().signal), revisionError);
});

test('a late body response is discarded after target-switch or focus-refresh abort', async t => {
  const { promise: started, resolve: bodyStarted } = Promise.withResolvers<void>();
  const { promise: pendingBody, resolve: resolveBody } = Promise.withResolvers<Response>();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++requests === 1) return Response.json({ sources: [source], scopes: [] });
    bodyStarted();
    // Simulate a response that wins the fetch abort race.
    return pendingBody;
  });
  const controller = new AbortController();
  const pending = readAuthorizedDocumentSourceContent('workspace', target, controller.signal);
  await started;
  controller.abort();
  resolveBody(Response.json(content));
  await assert.rejects(pending, cause => cause instanceof DOMException && cause.name === 'AbortError');
});

test('complete source pagination merges paths and preserves any scan exclusions across all pages', async t => {
  const responses = [page(['a/same.md'], 'cursor-a', { scanComplete: false, issues: [{ path: 'private', code: 'excluded' }] }), page(['b/same.md', 'a/same.md'], 'cursor-b'), page(['last.md'], null, { issues: [{ path: 'private', code: 'excluded' }] })];
  const cursors: (string | null)[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const query = new URL(String(url), 'https://pm.invalid').searchParams;
    cursors.push(query.get('cursor'));
    return Response.json(responses.shift());
  });
  const updates: DocumentSourceFiles[] = [];
  const result = await readAllDocumentSourceFiles('workspace', source, new AbortController().signal, partial => updates.push(partial));
  assert.deepEqual(cursors, [null, 'cursor-a', 'cursor-b']);
  assert.deepEqual(result.entries.map(entry => entry.path), ['a/same.md', 'b/same.md', 'last.md']);
  assert.equal(result.scanComplete, false, 'Exhausting cursors cannot turn an incomplete scan into a complete directory');
  assert.deepEqual(result.issues, [{ path: 'private', code: 'excluded' }]);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(updates.map(update => update.entries.length), [1, 2, 3]);
});

test('pagination refuses cursor cycles or changed revisions rather than mixing snapshots', async t => {
  for (const responses of [[page(['first.md'], 'repeat'), page(['second.md'], 'repeat')], [page(['first.md'], 'next'), page(['second.md'], null, { sourceRevision: 5 })]]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(responses.shift()));
    await assert.rejects(readAllDocumentSourceFiles('workspace', source, new AbortController().signal), revisionError);
    mock.mock.restore();
  }
});

test('failed continuation is a failure, never an apparently complete empty or partial snapshot', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1 ? Response.json(page(['first.md'], 'next')) : Response.json({ error: 'not_found_or_forbidden' }, { status: 403 }));
  await assert.rejects(readAllDocumentSourceFiles('workspace', source, new AbortController().signal), cause => cause instanceof DocumentSourceRequestError && cause.status === 403);
  assert.equal(requests, 2);
});

test('a late aborted page cannot publish entries or request another cursor', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => { controller.abort(); return Response.json(page(['stale.md'], 'next')); });
  const updates: DocumentSourceFiles[] = [];
  await assert.rejects(readAllDocumentSourceFiles('workspace', source, controller.signal, partial => updates.push(partial)), cause => cause instanceof DOMException && cause.name === 'AbortError');
  assert.deepEqual(updates, []);
});

test('each fresh traversal starts with empty cursor history even when the server reuses cursor values', async t => {
  const responses = [page(['first.md'], 'same-cursor'), page(['last.md'], null), page(['fresh.md'], 'same-cursor'), page(['final.md'], null)];
  const cursors: (string | null)[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const target = new URL(String(url), 'https://pm.invalid');
    assert.equal(target.pathname, '/api/v1/workspaces/workspace/document-sources/folder-a/files');
    cursors.push(target.searchParams.get('cursor'));
    return Response.json(responses.shift());
  });
  await readAllDocumentSourceFiles('workspace', source, new AbortController().signal);
  const latest = await readAllDocumentSourceFiles('workspace', source, new AbortController().signal);
  assert.deepEqual(cursors, [null, 'same-cursor', null, 'same-cursor']);
  assert.deepEqual(latest.entries.map(entry => entry.path), ['fresh.md', 'final.md']);
});

test('source authorization uses opaque IDs independently from project association values', async t => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requests.push(String(url));
    return Response.json(requests.length === 1 ? { sources: [{ ...source, projectId: null }], scopes: [] } : content);
  });
  const result = await readAuthorizedDocumentSourceContent('workspace', target, new AbortController().signal);
  assert.equal(result.source.sourceId, target.sourceId);
  assert.match(requests[1]!, /document-sources\/folder-a\/content/);
  assert.ok(!requests[1]!.includes('PRJ-001'));
});
