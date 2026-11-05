import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Entity } from '../packages/contracts/src/client.ts';
import { artifactLifecyclePayloads } from '../packages/domain/src/artifact-files.ts';
import { buildFileEntries, entryForFile, fileProjectWritable, filterAndSort } from '../apps/web/src/features/pm/service/project-files/model.ts';

function fileHistory() {
  const base = { workspaceId: randomUUID(), projectId: 'PRJ-001', version: 1, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', createdBy: randomUUID() };
  const artifactId = randomUUID();
  const first: Entity = { ...base, id: randomUUID(), kind: 'artifact_version', data: { artifactId, fileName: 'first.txt', mediaType: 'text/plain', size: 10 } };
  const second: Entity = { ...base, id: randomUUID(), kind: 'artifact_version', createdAt: '2026-10-21T00:00:00.000Z', data: { artifactId, fileName: 'second.txt', mediaType: 'text/plain', size: 20 } };
  const artifact: Entity = { ...base, id: artifactId, kind: 'artifact', updatedAt: '2026-10-23T00:00:00.000Z', data: { title: 'Title pretending to be image.png', kind: 'document', hiddenAt: null, hiddenBy: null, versionRefs: [first.id, second.id], latestVersionId: second.id } };
  return { artifact, first, second };
}

test('artifact title alone controls display/search/sort; original metadata controls classification and upload time', () => {
  const { artifact, first, second } = fileHistory();
  const entries = buildFileEntries([artifact], [first, second]);
  assert.equal(entries.length, 1); const entry = entries[0]!;
  assert.equal(entry.name, artifact.data.title); assert.equal(entry.originalFileName, 'second.txt');
  assert.equal(entry.kind, 'doc'); assert.equal(entry.updatedAt, second.createdAt); assert.equal(entry.size, 20);
  assert.equal(filterAndSort(entries, 'pretending', [], 'name').length, 1);
  assert.equal(filterAndSort(entries, 'second.txt', [], 'name').length, 0);
  assert.equal(entryForFile(entries, first.id)?.versionId, first.id);
  assert.equal(entryForFile(entries, artifact.id)?.versionId, second.id);
});

test('excluded parents cannot resurrect their immutable versions as orphan rows; hidden historical parent retains both exact versions', () => {
  const { artifact, first, second } = fileHistory();
  assert.deepEqual(buildFileEntries([], [first, second]), []);
  const hidden = { ...artifact, data: { ...artifact.data, hiddenAt: '2026-10-22T00:00:00.000Z', hiddenBy: artifact.createdBy } };
  const entries = buildFileEntries([hidden], [first, second]);
  assert.equal(entries[0]!.hidden, true); assert.equal(entries[0]!.artifactId, artifact.id);
  assert.equal(entryForFile(entries, first.id)?.entry.artifact.id, artifact.id);
  assert.deepEqual(entries[0]!.versions.map(version => version.id), [second.id, first.id]);
});

test('long, duplicate and path-like display names are accepted metadata but unknown keys and invalid titles are rejected', () => {
  for (const title of ['中文 / ../ 安全显示名.png', 'same title', '名'.repeat(20_000)]) assert.equal(artifactLifecyclePayloads.RenameArtifact.parse({ title: ` ${title} ` }).title, title);
  for (const title of ['', '   ', '名'.repeat(20_001)]) assert.equal(artifactLifecyclePayloads.RenameArtifact.safeParse({ title }).success, false);
  assert.equal(artifactLifecyclePayloads.RenameArtifact.safeParse({ title: 'valid', fileName: 'change-history.txt' }).success, false);
  assert.equal(artifactLifecyclePayloads.HideArtifact.safeParse({ hiddenBy: randomUUID() }).success, false);
  assert.equal(artifactLifecyclePayloads.CopyArtifactVersion.safeParse({ targetTitle: 'valid', targetKind: 'document', sourceRunId: randomUUID() }).success, false);
});

test('file metadata target availability matches current planning/active and archive semantics', () => {
  const { artifact } = fileHistory();
  for (const status of ['planning', 'active']) assert.equal(fileProjectWritable({ ...artifact, kind: 'project', data: { status, archivedAt: null } }), true);
  for (const status of ['completed', 'cancelled', 'closed', '']) assert.equal(fileProjectWritable({ ...artifact, kind: 'project', data: { status, archivedAt: null } }), false);
  assert.equal(fileProjectWritable({ ...artifact, kind: 'project', data: { status: 'active', archived: true } }), false);
});
