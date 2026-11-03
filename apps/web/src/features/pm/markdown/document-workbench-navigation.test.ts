import assert from 'node:assert/strict';
import test from 'node:test';
import { documentWorkbenchLocation, documentWorkbenchReturn, documentWorkbenchUrl } from './document-workbench-navigation.ts';

const root = '/pm/workspace';

test('native and external deep links round trip without losing namespaced identities or anchors', () => {
  const targets = [
    { kind: 'native', id: 'DOC-001' },
    { kind: 'external', sourceId: 'folder-a', revision: 7, path: '设计/notes #1.md' },
  ] as const;
  const back = `${root}/projects/PRJ-001?view=detail2&tab=files`;
  for (const target of targets) {
    const url = new URL(documentWorkbenchUrl(root, target, back, 'Section one'), 'https://workspace.invalid');
    assert.equal(url.pathname, `${root}/documents`);
    assert.equal(url.searchParams.get('returnTo'), back);
    assert.equal(decodeURIComponent(url.hash.slice(1)), 'Section one');
    assert.deepEqual(documentWorkbenchLocation(url.searchParams), { enabled: true, target, invalid: false });
  }
});

test('close-last is an explicit empty workbench rather than an implicit restored editor', () => {
  const url = new URL(documentWorkbenchUrl(root, null), 'https://workspace.invalid');
  assert.deepEqual(documentWorkbenchLocation(url.searchParams), { enabled: true, target: null, invalid: false });
  assert.deepEqual(documentWorkbenchLocation(new URLSearchParams('view=list')), { enabled: false, target: null, invalid: false });
});

test('malformed or ambiguous active targets never select a different document', () => {
  for (const query of [
    'document=',
    'document=DOC-001&externalSourceId=workspace',
    'externalSourceId=workspace&externalPath=one.md',
    'externalSourceId=workspace&externalRevision=-1&externalPath=one.md',
    'externalSourceId=workspace&externalRevision=9007199254740992&externalPath=one.md',
    'externalSourceId=workspace&externalRevision=1&externalPath=',
    'document=DOC-001%00',
  ]) assert.deepEqual(documentWorkbenchLocation(new URLSearchParams(query)), { enabled: true, target: null, invalid: true });
});

test('return context stays inside the same workspace and cannot loop through an active editor', () => {
  const fallback = `${root}/documents`;
  for (const back of [
    'https://elsewhere.invalid/path',
    '//elsewhere.invalid/path',
    '/pm/another/documents',
    `${root}/../another/documents`,
    `${root}\\projects\\PRJ-001`,
    `${root}/entities/DOC-001`,
    `${root}/projects/PRJ-001/entities/DOC-001`,
    documentWorkbenchUrl(root, { kind: 'native', id: 'DOC-001' }),
    `${root}/documents?workbench=1`,
  ]) assert.equal(documentWorkbenchReturn(back, root), fallback);
  for (const back of [`${root}/documents?view=table`, `${root}/projects/PRJ-001/documents?documentCollection=external`, `${root}/projects/PRJ-001?tab=files&view=detail2`, `${root}/issues?view=calendar`]) assert.equal(documentWorkbenchReturn(back, root), back);
});

test('legacy external links migrate at the input boundary and new links emit only sourceId', () => {
  const old = new URLSearchParams('externalScope=PRJ-001&externalRevision=4&externalPath=notes%2Fold.md');
  const location = documentWorkbenchLocation(old);
  assert.deepEqual(location, { enabled: true, invalid: false, target: { kind: 'external', sourceId: 'PRJ-001', revision: 4, path: 'notes/old.md' } });
  const next = new URL(documentWorkbenchUrl(root, location.target), 'https://workspace.invalid');
  assert.equal(next.searchParams.get('externalSourceId'), 'PRJ-001');
  assert.equal(next.searchParams.has('externalScope'), false);
  assert.equal(documentWorkbenchLocation(new URLSearchParams('externalSourceId=one&externalScope=two&externalRevision=1&externalPath=file.md')).invalid, true);
});
