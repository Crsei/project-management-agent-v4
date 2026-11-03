import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentKind, FileRecord } from '@pm-schema';
import type { DocumentSource, DocumentSourceEntry } from '../../../../../../packages/contracts/src/document-sources';
import { buildDocumentRows, filterDocumentRows, sortDocumentRows } from './document-collection-model.ts';

function native(id: string, title: string, kind: DocumentKind, project: string | undefined, updated?: string): FileRecord {
  return {
    id,
    path: `docs/${id}.md`,
    raw: '',
    revision: 'revision',
    entity: {
      schema: 'pm/v1', id, entity: 'document', title, project, document_kind: kind, body: '',
      blocked_by: [], related_to: [], labels: [], links: [], checklist: [], views: [],
      ...(updated ? { 'x-pm-updated-at': updated } : {}),
    } as FileRecord['entity'],
  };
}
const source: DocumentSource = { sourceId: 'folder-a', projectId: 'PRJ-001', name: 'Nova', path: null, revision: 2, status: 'available', canManage: true, canWrite: true };
const entries: DocumentSourceEntry[] = [
  { fileKey: 'file-guide', path: 'notes/guide.md', name: 'guide.md', size: 10, modifiedAt: '2026-11-02T10:00:00.000Z' },
  { fileKey: 'file-readme', path: 'README.md', name: 'README.md', size: 20, modifiedAt: '2026-10-01T10:00:00.000Z' },
];
const projects = new Map([['PRJ-001', 'Nova 客户门户']]);
const nativeFiles = [
  native('DOC-001', '旧文档', 'note', 'PRJ-001', '2026-11-01T10:00:00.000Z'),
  native('DOC-002', '设计文档', 'design', 'PRJ-001'),
];

test('includes all task Markdown alongside documents without including other PM entities', () => {
  const tasks = ['task', 'bug', 'story', 'epic', 'subtask'].map((type, index) => ({
    ...native(`TASK-00${index + 1}`, `Task ${type}`, 'note', index === 1 ? 'PRJ-002' : 'PRJ-001'),
    path: `work-items/TASK-00${index + 1}.md`,
    entity: { ...nativeFiles[0].entity, id: `TASK-00${index + 1}`, entity: 'work_item', type, project: index === 1 ? 'PRJ-002' : 'PRJ-001', archived: index === 4 },
  } as FileRecord));
  const project = { ...nativeFiles[0], id: 'PRJ-001', entity: { ...nativeFiles[0].entity, entity: 'project' } } as FileRecord;
  const rows = buildDocumentRows([...nativeFiles, ...tasks, project], [{ source, entries }], projects, false);
  const filters = { source: 'native' as const, type: 'work_item' as const, projectId: '', search: '' };
  assert.deepEqual(filterDocumentRows(rows, filters).map(row => row.key), tasks.map(task => `native:${task.id}`));
  assert.deepEqual(filterDocumentRows(rows, { ...filters, projectId: 'PRJ-002' }).map(row => row.key), ['native:TASK-002']);
  assert.deepEqual(filterDocumentRows(rows, { ...filters, search: 'task-001' }).map(row => row.key), ['native:TASK-001']);
  assert.deepEqual(filterDocumentRows(rows, { ...filters, source: 'external' }), []);
  assert.deepEqual(filterDocumentRows(rows, { ...filters, type: 'design' }).map(row => row.key), ['native:DOC-002']);
  assert.equal(rows.some(row => row.key === 'native:PRJ-001'), false);
});

test('filters across source, type, project and search', () => {
  const rows = buildDocumentRows(nativeFiles, [{ source, entries }], projects, false);
  assert.deepEqual(filterDocumentRows(rows, { source: 'external', type: 'all', projectId: '', search: '' }).map(row => row.title), ['guide.md', 'README.md']);
  assert.deepEqual(filterDocumentRows(rows, { source: 'all', type: 'design', projectId: '', search: '' }).map(row => row.title), ['设计文档']);
  assert.deepEqual(filterDocumentRows(rows, { source: 'all', type: 'all', projectId: 'PRJ-001', search: '' }).length, 4);
  assert.deepEqual(filterDocumentRows(rows, { source: 'all', type: 'all', projectId: '', search: 'notes/' }).map(row => row.title), ['guide.md']);
  assert.deepEqual(filterDocumentRows(rows, { source: 'all', type: 'all', projectId: '', search: '旧' }).map(row => row.title), ['旧文档']);
});

test('keeps workspace documents before newer external files, sorting within each source', () => {
  const rows = buildDocumentRows(nativeFiles, [{ source, entries }], projects, false).reverse();
  assert.deepEqual(sortDocumentRows(rows, 'updated').map(row => row.key), [
    'native:DOC-001', 'native:DOC-002', 'external:file-guide', 'external:file-readme',
  ]);
  assert.deepEqual(sortDocumentRows(rows, 'title').map(row => row.key), [
    'native:DOC-001', 'native:DOC-002', 'external:file-guide', 'external:file-readme',
  ]);
  const externalOnly = filterDocumentRows(rows, { source: 'external', type: 'all', projectId: '', search: '' });
  assert.deepEqual(sortDocumentRows(externalOnly, 'updated').map(row => row.key), [
    'external:file-guide', 'external:file-readme',
  ]);
});

test('workspace external rows do not pretend to belong to a project', () => {
  const workspace: DocumentSource = { ...source, projectId: null, name: 'Project Management' };
  const rows = buildDocumentRows(nativeFiles, [{ source: workspace, entries }], projects, false);
  const external = rows.filter(row => row.source === 'external');
  assert.ok(external.every(row => row.projectId === null && row.projectLabel === '工作区公共文档'));
  assert.deepEqual(filterDocumentRows(rows, { source: 'all', type: 'all', projectId: 'PRJ-001', search: '' }).map(row => row.title), ['旧文档', '设计文档']);
});

test('shared physical keys deduplicate aliases and retain every authorized association', () => {
  const publicSource = { ...source, sourceId: 'public-folder', projectId: null, canWrite: false };
  const readOnlyProject = { ...source, sourceId: 'project-read', projectId: 'PRJ-002', canWrite: false };
  const names = new Map<string, string>([...projects, ['PRJ-002', 'Authorized second project']]);
  const rows = buildDocumentRows([], [
    { source: publicSource, entries: [entries[0]] },
    { source: readOnlyProject, entries: [{ ...entries[0], path: 'aliased/guide.md' }] },
    { source, entries: [{ ...entries[0], path: 'writable/guide.md' }] },
  ], names, true);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.source, 'external');
  if (row.source !== 'external') return;
  assert.equal(row.sourceId, source.sourceId);
  assert.equal(row.entry.path, 'writable/guide.md');
  assert.equal(row.canWrite, true);
  assert.deepEqual(row.associations.map(item => item.sourceId), ['public-folder', 'project-read', 'folder-a']);
  assert.match(row.projectLabel, /Workspace common documents/);
  assert.match(row.projectLabel, /Authorized second project/);
  assert.match(row.projectLabel, /Nova 客户门户/);
  const filtered = filterDocumentRows(rows, { source: 'all', type: 'all', projectId: 'PRJ-002', search: '' })[0]!;
  assert.equal(filtered.source, 'external');
  if (filtered.source !== 'external') return;
  assert.equal(filtered.sourceId, 'project-read');
  assert.equal(filtered.entry.path, 'aliased/guide.md');
  assert.equal(filtered.canWrite, false, 'Project-filtered actions never borrow a different project’s writable alias');
  assert.deepEqual(filterDocumentRows(rows, { source: 'all', type: 'all', projectId: 'PRJ-999', search: '' }), []);
});

test('same names, relative paths and content metadata never merge different physical files', () => {
  const rows = buildDocumentRows([], [
    { source, entries: [entries[0]] },
    { source: { ...source, sourceId: 'another-folder' }, entries: [{ ...entries[0], fileKey: 'different-file' }] },
    { source: { ...source, sourceId: 'not-readable', status: 'unavailable' }, entries: [{ ...entries[0], fileKey: 'not-readable-file' }] },
  ], projects, false);
  assert.deepEqual(rows.map(row => row.key), ['external:file-guide', 'external:different-file']);
  assert.ok(rows.every(row => row.source === 'external' && row.associations.length === 1));
});
