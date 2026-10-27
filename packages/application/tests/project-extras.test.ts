import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { isProjectCoverMediaType, isProjectCoverRaster, moveProjectSidebarOrderIds, projectSidebarOrderIds } from '../../domain/src/project-extras.ts';
import { LocalBlobStore } from '../../infrastructure/src/blobs.ts';
import { projectExtrasCommands } from '../src/project-extras.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64');

test('cover eligibility rejects SVG, external links, MIME spoofing, truncated bytes and mismatched raster formats', () => {
  for (const value of ['image/svg+xml', 'text/html', 'application/octet-stream', 'https://example.test/image.png', 'image/png; charset=utf-8', null]) assert.equal(isProjectCoverMediaType(value), false);
  assert.equal(isProjectCoverMediaType('image/png'), true);
  assert.equal(isProjectCoverRaster(png, 'image/png'), true);
  assert.equal(isProjectCoverRaster(png, 'image/jpeg'), false);
  for (const body of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<html><img src=x onerror=alert(1)></html>', 'https://example.test/a.png', '']) {
    for (const mediaType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const) assert.equal(isProjectCoverRaster(Buffer.from(body), mediaType), false);
  }
  for (const length of [0, 8, 24, png.length - 1]) assert.equal(isProjectCoverRaster(png.subarray(0, length), 'image/png'), false);
});

test('project annotations have strict non-spoofable payloads and stable unique scope identities', () => {
  const commands = projectExtrasCommands(new LocalBlobStore('/unused-project-extras-schema'));
  const favorite = commands.SetProjectFavorite!.payload;
  assert.equal(favorite.safeParse({ favorite: true }).success, true);
  assert.equal(favorite.safeParse({ favorite: false, actorId: randomUUID() }).success, false);
  assert.equal(favorite.safeParse({ favorite: 'true' }).success, false);
  const cover = commands.SetProjectCover!.payload;
  assert.equal(cover.safeParse({ artifactVersionId: randomUUID() }).success, true);
  assert.equal(cover.safeParse({ artifactVersionId: null }).success, true);
  for (const payload of [{ url: 'https://example.test/x.png' }, { artifactVersionId: '<svg />' }, { artifactVersionId: null, mediaType: 'image/png' }]) assert.equal(cover.safeParse(payload).success, false);
  const scope = commands.SetProjectScope!.payload;
  const item = { id: randomUUID(), text: 'A persisted annotation', completed: false };
  assert.equal(scope.safeParse({ items: [item, { ...item, id: randomUUID() }] }).success, true);
  assert.equal(scope.safeParse({ items: [item, item] }).success, false);
  assert.equal(scope.safeParse({ items: [{ ...item, text: ' ' }] }).success, false);
  assert.equal(scope.safeParse({ items: [{ ...item, id: 'row-1' }] }).success, false);
  assert.equal(scope.safeParse({ items: [{ ...item, text: 'x'.repeat(2001) }] }).success, false);
  assert.equal(scope.safeParse({ items: [{ ...item, completed: 'yes' }] }).success, false);
  assert.equal(scope.safeParse({ items: [item], status: 'completed' }).success, false);
});

test('sidebar order keeps authorized neighbors and appends new IDs deterministically without mutating saved history', () => {
  const saved = ['PRJ-003', 'PRJ-001', 'PRJ-003', 'PRJ-REVOKED', 'PRJ-DELETED', 'PRJ-ARCHIVED'];
  const visible = ['PRJ-004', 'PRJ-001', 'PRJ-002', 'PRJ-003'];
  assert.deepEqual(projectSidebarOrderIds(saved, visible), ['PRJ-003', 'PRJ-001', 'PRJ-002', 'PRJ-004']);
  assert.deepEqual(projectSidebarOrderIds(saved, [...visible].reverse()), ['PRJ-003', 'PRJ-001', 'PRJ-002', 'PRJ-004']);
  assert.deepEqual(projectSidebarOrderIds(saved, []), []);
  assert.deepEqual(projectSidebarOrderIds([], visible), ['PRJ-001', 'PRJ-002', 'PRJ-003', 'PRJ-004']);
  assert.equal(saved.length, 6, 'Read normalization must not silently rewrite stored history or CAS version');
});

test('sidebar moves use the complete order, exchange only neighbors and no-op at boundaries', () => {
  const full = ['PRJ-003', 'PRJ-001', 'PRJ-002'];
  assert.deepEqual(moveProjectSidebarOrderIds(full, 'PRJ-001', 'up'), ['PRJ-001', 'PRJ-003', 'PRJ-002']);
  assert.deepEqual(moveProjectSidebarOrderIds(full, 'PRJ-001', 'down'), ['PRJ-003', 'PRJ-002', 'PRJ-001']);
  assert.equal(moveProjectSidebarOrderIds(full, 'PRJ-003', 'up'), null);
  assert.equal(moveProjectSidebarOrderIds(full, 'PRJ-002', 'down'), null);
  assert.equal(moveProjectSidebarOrderIds(full, 'PRJ-HIDDEN', 'down'), null);
  assert.equal(moveProjectSidebarOrderIds([], 'PRJ-001', 'up'), null);
  assert.equal(moveProjectSidebarOrderIds(['PRJ-001'], 'PRJ-001', 'down'), null);
  assert.deepEqual(full, ['PRJ-003', 'PRJ-001', 'PRJ-002']);
});

test('sidebar payload accepts only unique native IDs and never a caller-selected actor or workspace', () => {
  const schema = projectExtrasCommands(new LocalBlobStore('/unused-project-sidebar-order-schema')).SetProjectSidebarOrder!.payload;
  assert.equal(schema.safeParse({ projectIds: [] }).success, true);
  assert.equal(schema.safeParse({ projectIds: ['PRJ-001', 'PRJ-002'] }).success, true);
  for (const payload of [
    { projectIds: ['PRJ-001', 'PRJ-001'] },
    { projectIds: [randomUUID()] },
    { projectIds: ['../PRJ-001'] },
    { projectIds: ['prj-001'] },
    { projectIds: ['PRJ-001'], ownerId: randomUUID() },
    { projectIds: ['PRJ-001'], actorId: randomUUID() },
    { projectIds: ['PRJ-001'], workspaceId: randomUUID() },
    { projectIds: ['PRJ-001'], favorite: true },
  ]) assert.equal(schema.safeParse(payload).success, false);
});
