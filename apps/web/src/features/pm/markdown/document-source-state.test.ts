import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentSource, DocumentSourceAssociationScope } from '../../../../../../packages/contracts/src/document-sources';
import { documentSourceCatalogReducer, documentSourcesForProject, pendingDocumentSources, scopedDocumentSources, type DocumentSourceCatalog } from './document-source-state.ts';

const workspace: DocumentSource = { sourceId: 'public-folder', projectId: null, name: 'Public directory', path: null, revision: 2, status: 'available', canManage: false, canWrite: false };
const project: DocumentSource = { sourceId: 'folder-a', projectId: 'PRJ-001', name: 'Project directory', path: null, revision: 4, status: 'available', canManage: false, canWrite: false };
const scopes: DocumentSourceAssociationScope[] = [
  { projectId: null, name: 'Workspace common documents', revision: 1, canManage: true },
  { projectId: 'PRJ-001', name: 'Authorized project', revision: 3, canManage: false },
  { projectId: 'PRJ-002', name: 'Empty project', revision: 0, canManage: true },
];
function loaded(sources: DocumentSource[], key = 'identity:workspace', request = 1): DocumentSourceCatalog {
  return documentSourceCatalogReducer(pendingDocumentSources(key, request), { type: 'loaded', key, request, sources, scopes });
}

test('workspace aggregates all authorized folders while project routes select all exact associations', () => {
  const second = { ...project, sourceId: 'folder-b', revision: 7 };
  const misleadingId = { ...workspace, sourceId: 'PRJ-001' };
  const catalog = loaded([workspace, project, second, misleadingId]);
  assert.deepEqual(documentSourcesForProject(catalog), [workspace, project, second, misleadingId]);
  assert.deepEqual(documentSourcesForProject(catalog, 'PRJ-001'), [project, second]);
  assert.deepEqual(documentSourcesForProject(catalog, 'PRJ-002'), []);
  assert.deepEqual(documentSourcesForProject(catalog, 'PRJ-999'), []);
});

test('selectable association scopes survive even when no folder is associated', () => {
  const catalog = loaded([]);
  assert.deepEqual(catalog.scopes, scopes);
  assert.deepEqual(catalog.sources, []);
  assert.equal(catalog.scopes.find(scope => scope.projectId === 'PRJ-002')?.revision, 0);
});

test('pending and catalog failure never look like a trustworthy empty or former external snapshot', () => {
  const pending = pendingDocumentSources('identity:PRJ-001', 1);
  assert.equal(pending.status, 'pending');
  assert.deepEqual(documentSourcesForProject(pending, 'PRJ-001'), []);
  const unavailable = loaded([{ ...project, status: 'unavailable', reason: 'directory_missing' }]);
  assert.equal(documentSourcesForProject(unavailable, 'PRJ-001')[0]?.status, 'unavailable');
  const failed = documentSourceCatalogReducer(pending, { type: 'failed', key: pending.key, request: 1, error: 'Permission read failed' });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'Permission read failed');
  assert.deepEqual(failed.sources, []);
  assert.deepEqual(failed.scopes, []);
});

test('route changes hide the previous catalog during render before the next read starts', () => {
  const previous = loaded([workspace, project]);
  const next = scopedDocumentSources(previous, 'identity:PRJ-002');
  assert.equal(next.status, 'pending');
  assert.deepEqual(next.sources, []);
  assert.deepEqual(next.scopes, []);
  assert.deepEqual(documentSourcesForProject(next, 'PRJ-002'), []);
  assert.equal(scopedDocumentSources(previous, previous.key), previous);
});

test('refresh and rapid route changes discard old data and ignore out-of-order success and failure', () => {
  let state = loaded([workspace, project]);
  state = documentSourceCatalogReducer(state, { type: 'read', key: 'identity:PRJ-001', request: 2 });
  assert.deepEqual(state.sources, []);
  assert.deepEqual(state.scopes, []);
  const loading = state;
  assert.equal(documentSourceCatalogReducer(state, { type: 'loaded', key: 'identity:workspace', request: 1, sources: [workspace], scopes }), loading);
  state = documentSourceCatalogReducer(state, { type: 'read', key: 'identity:PRJ-002', request: 3 });
  const latest = state;
  assert.equal(documentSourceCatalogReducer(state, { type: 'loaded', key: 'identity:PRJ-001', request: 2, sources: [project], scopes }), latest);
  assert.equal(documentSourceCatalogReducer(state, { type: 'failed', key: 'identity:PRJ-001', request: 2, error: 'Late failure' }), latest);
  state = documentSourceCatalogReducer(state, { type: 'loaded', key: latest.key, request: 3, sources: [{ ...project, projectId: 'PRJ-002' }], scopes });
  state = documentSourceCatalogReducer(state, { type: 'read', key: latest.key, request: 4 });
  assert.equal(state.status, 'pending');
  assert.deepEqual(state.sources, []);
  assert.equal(documentSourceCatalogReducer(state, { type: 'loaded', key: latest.key, request: 3, sources: [project], scopes }), state);
});

test('unlink removes sources without inventing unconfigured rows or removing selectable projects', () => {
  const old = loaded([project], 'identity:PRJ-001', 1);
  const reading = documentSourceCatalogReducer(old, { type: 'read', key: old.key, request: 2 });
  const nextScopes = scopes.map(scope => scope.projectId === 'PRJ-001' ? { ...scope, revision: scope.revision + 1 } : scope);
  const unlinked = documentSourceCatalogReducer(reading, { type: 'loaded', key: old.key, request: 2, sources: [], scopes: nextScopes });
  assert.deepEqual(documentSourcesForProject(unlinked, 'PRJ-001'), []);
  assert.equal(unlinked.scopes.find(scope => scope.projectId === 'PRJ-001')?.revision, 4);
  assert.equal(documentSourceCatalogReducer(unlinked, { type: 'loaded', key: old.key, request: 1, sources: [project], scopes }), unlinked);
});
