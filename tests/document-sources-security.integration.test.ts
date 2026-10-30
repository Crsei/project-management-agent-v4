import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, link, lstat, mkdir, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { DocumentSourceFiles } from '../packages/contracts/src/document-sources.ts';
import { createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createLocalProjectFixture, localProjectCaseTimeout } from './local-project-fixture.ts';
import { assertDocumentSourceFailure, collectDocumentFiles, createDocumentProject, documentSourcesPath, readDocumentSources, readSourceContent, saveDocumentSource } from './document-sources-fixture.ts';

const execute = promisify(execFile);
const contentPath = (base: string, path: string) => `${base}/content?${new URLSearchParams({ path })}`;

describe('directory document sources: filesystem identities and isolation', { concurrency: 1 }, () => {
  it('rejects traversal, absolute paths, leaf/intermediate symlinks, hardlinks, special files and oversized bodies without modifying or following them', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const root = join(f.parents[1], 'safe-source'), outside = join(f.parents[1], 'outside-source');
    await mkdir(root); await mkdir(outside);
    const outsideBytes = Buffer.from('SECRET_OUTSIDE_SOURCE: never return this body.\n');
    await writeFile(join(outside, 'secret.md'), outsideBytes);
    await writeFile(join(root, 'regular.md'), '# Ordinary source\n');
    const rootLink = join(f.parents[1], 'root-link'); await symlink(root, rootLink, 'dir');
    const intermediate = join(f.parents[1], 'intermediate-link'); await symlink(f.parents[1], intermediate, 'dir');
    const forbiddenRoots = [rootLink, join(intermediate, 'safe-source'), f.root, f.coreRoot, f.blobRoot, '/etc'];
    for (const path of forbiddenRoots) {
      const preview = await f.request(`${documentSourcesPath(f)}/preview`, { method: 'POST', body: { projectId: null, path } });
      assertDocumentSourceFailure(preview, [400, 403, 409]);
      const save = await f.request(documentSourcesPath(f, 'workspace'), { method: 'PUT', body: { path, expectedRevision: 0 } });
      assertDocumentSourceFailure(save, [400, 403, 409]);
    }
    assert.equal((await readDocumentSources(f)).find(source => source.projectId === null)?.revision, 0);
    await saveDocumentSource(f, 'workspace', root, 0);
    const base = documentSourcesPath(f, 'workspace');
    for (const path of ['../outside-source/secret.md', '../../outside-source/secret.md', join(outside, 'secret.md'), '/etc/passwd', 'nested/../../outside-source/secret.md', 'nested/../regular.md', '..\\outside-source\\secret.md', 'C:\\outside-source\\secret.md']) {
      const rejected = await f.request(contentPath(base, path));
      assertDocumentSourceFailure(rejected, [403], 'document_source_path_forbidden');
      assert.equal(JSON.stringify(rejected.body).includes('SECRET_OUTSIDE_SOURCE'), false);
    }
    await symlink(join(outside, 'secret.md'), join(root, 'leaf-link.md'), 'file');
    await symlink(join(root, 'regular.md'), join(root, 'internal-link.md'), 'file');
    await symlink(outside, join(root, 'linked-directory'), 'dir');
    await link(join(outside, 'secret.md'), join(root, 'hard-link.md'));
    await execute('mkfifo', [join(root, 'special-pipe.md')], { timeout: 5_000 });
    await mkdir(join(root, 'directory.md'));
    const huge = join(root, 'oversized.md'); await writeFile(huge, ''); await truncate(huge, 4 * 1024 * 1024 + 1);
    for (const path of ['leaf-link.md', 'internal-link.md', 'linked-directory/secret.md', 'hard-link.md', 'special-pipe.md', 'directory.md']) {
      const rejected = await f.request(contentPath(base, path), { signal: AbortSignal.timeout(3_000) });
      assertDocumentSourceFailure(rejected, [403, 404, 409]);
      assert.equal(JSON.stringify(rejected.body).includes('SECRET_OUTSIDE_SOURCE'), false);
    }
    assertDocumentSourceFailure(await f.request(contentPath(base, 'oversized.md')), [413], 'document_source_file_too_large');
    const scanned = await collectDocumentFiles(f, 'workspace');
    assert.equal(scanned.scanComplete, false, 'Excluded unsafe filesystem entries cannot produce a supposedly complete scan');
    assert.ok(scanned.issues.length > 0);
    for (const path of ['leaf-link.md', 'internal-link.md', 'linked-directory', 'hard-link.md', 'special-pipe.md']) {
      assert.equal(scanned.entries.some(entry => entry.path === path || entry.path.startsWith(`${path}/`)), false, `Unsafe entry was enumerated: ${path}`);
      assert.ok(scanned.issues.some(issue => issue.path === path && typeof issue.code === 'string' && issue.code.length > 0), `An excluded entry needs a visible scan issue: ${path}`);
    }
    assert.ok(scanned.entries.some(entry => entry.path === 'regular.md'));
    assert.ok(scanned.entries.some(entry => entry.path === 'oversized.md') || scanned.issues.some(issue => issue.path === 'oversized.md'), 'Large files are either listed or explicitly reported, never silently omitted');
    assert.equal((await readSourceContent(f, 'workspace', 'regular.md')).content, '# Ordinary source\n');
    assert.deepEqual(await readFile(join(outside, 'secret.md')), outsideBytes);
    assert.equal((await lstat(join(root, 'special-pipe.md'))).isFIFO(), true);
    assert.equal((await lstat(huge)).size, 4 * 1024 * 1024 + 1, 'Oversized sources are neither truncated nor rewritten');
  });

  it('rechecks directory/leaf identities and missing roots after save and restart rather than following replacements or recreating paths', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const root = join(f.parents[1], 'identity-source'); await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'read.md'), '# Original identity\n');
    await saveDocumentSource(f, 'workspace', root, 0);
    const base = documentSourcesPath(f, 'workspace');
    assert.equal((await readSourceContent(f, 'workspace', 'nested/read.md')).content, '# Original identity\n');
    const other = join(f.parents[1], 'other-private'); await mkdir(other);
    await writeFile(join(other, 'read.md'), '# Replacement must not be followed\n');
    await rename(join(root, 'nested'), join(root, 'nested-original'));
    await symlink(other, join(root, 'nested'), 'dir');
    assertDocumentSourceFailure(await f.request(contentPath(base, 'nested/read.md')), [403], 'document_source_path_forbidden');
    const partial = await collectDocumentFiles(f, 'workspace');
    assert.equal(partial.scanComplete, false); assert.ok(partial.issues.some(issue => issue.path === 'nested'));
    await rm(join(root, 'nested'));
    await rename(join(root, 'nested-original'), join(root, 'nested'));
    await rm(join(root, 'nested', 'read.md'));
    await symlink(join(other, 'read.md'), join(root, 'nested', 'read.md'), 'file');
    assertDocumentSourceFailure(await f.request(contentPath(base, 'nested/read.md')), [403], 'document_source_path_forbidden');
    await rename(root, `${root}-original`);
    const unavailable = (await readDocumentSources(f)).find(source => source.projectId === null)!;
    assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.revision, 1);
    assertDocumentSourceFailure(await f.request(`${base}/files`), [409], 'document_source_unavailable');
    assertDocumentSourceFailure(await f.request(contentPath(base, 'nested/read.md')), [409], 'document_source_unavailable');
    await assert.rejects(lstat(root), { code: 'ENOENT' });
    await f.restartApi();
    assertDocumentSourceFailure(await f.request(`${base}/files`), [409], 'document_source_unavailable');
    await assert.rejects(lstat(root), { code: 'ENOENT' });
    await mkdir(root); await writeFile(join(root, 'replacement.md'), '# A different directory at the original path\n');
    const replaced = (await readDocumentSources(f)).find(source => source.projectId === null)!;
    assert.equal(replaced.status, 'unavailable'); assert.equal(replaced.revision, 1);
    const denied = await f.request(contentPath(base, 'replacement.md'));
    assertDocumentSourceFailure(denied, [409], 'document_source_unavailable');
    assert.equal(denied.body.error.details?.reason, 'directory_identity_changed');
    assertDocumentSourceFailure(await f.request(`${base}/files`), [409], 'document_source_unavailable');
    await saveDocumentSource(f, 'workspace', null, 1);
    assert.equal(await readFile(join(root, 'replacement.md'), 'utf8'), '# A different directory at the original path\n');
  });

  it('reports unreadable nested directories/files explicitly and refuses unreadable roots, including privileged execution', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const root = join(f.parents[1], 'permission-source'), hidden = join(root, 'no-access');
    await mkdir(hidden, { recursive: true });
    await writeFile(join(root, 'visible.md'), '# Visible\n');
    await writeFile(join(root, 'no-read.md'), '# Not readable\n');
    await writeFile(join(hidden, 'secret.md'), '# Hidden by permissions\n');
    await saveDocumentSource(f, 'workspace', root, 0);
    const base = documentSourcesPath(f, 'workspace');
    try {
      await chmod(hidden, 0); await chmod(join(root, 'no-read.md'), 0);
      const scan = await collectDocumentFiles(f, 'workspace');
      assert.equal(scan.scanComplete, false);
      assert.ok(scan.issues.some(issue => issue.path === 'no-access'));
      assert.ok(scan.issues.some(issue => issue.path === 'no-read.md'));
      assert.equal(scan.entries.some(entry => entry.path.startsWith('no-access/')), false);
      assertDocumentSourceFailure(await f.request(contentPath(base, 'no-access/secret.md')), [403, 409]);
      assertDocumentSourceFailure(await f.request(contentPath(base, 'no-read.md')), [403, 409]);
      assert.equal((await readSourceContent(f, 'workspace', 'visible.md')).content, '# Visible\n');
      await chmod(root, 0);
      assert.equal((await readDocumentSources(f)).find(source => source.projectId === null)?.status, 'unavailable');
      assertDocumentSourceFailure(await f.request(`${base}/files`), [403, 409]);
      assertDocumentSourceFailure(await f.request(contentPath(base, 'visible.md')), [403, 409]);
      assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f)}/preview`, { method: 'POST', body: { projectId: null, path: root } }), [403, 409]);
    } finally {
      await chmod(root, 0o700); await chmod(hidden, 0o700); await chmod(join(root, 'no-read.md'), 0o600);
    }
    const restored = await collectDocumentFiles(f, 'workspace');
    assert.equal(restored.scanComplete, true); assert.deepEqual(restored.issues, []);
    assert.deepEqual(restored.entries.map(entry => entry.path).sort(), ['no-access/secret.md', 'no-read.md', 'visible.md']);
  });

  it('accepts Agent and native project nesting without importing native PM files or duplicating Markdown paths', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const a = await createDocumentProject(f, 'Project sharing the workspace Agent parent', 'native-a');
    const agent = await f.request(`/api/v1/workspaces/${f.workspaceId}/agent-file-area`, {
      method: 'PUT', body: { directory: { mode: 'existing', path: f.parents[0] }, expectedRevision: 0 },
    });
    assert.equal(agent.status, 200);
    await writeFile(join(f.parents[0], 'shared.md'), '# Workspace shared file\n');
    await writeFile(join(a.location.path!, 'same.md'), '# Project A file\n');
    const preview = await f.request(`${documentSourcesPath(f)}/preview`, { method: 'POST', body: { projectId: null, path: f.parents[0] } });
    assert.equal(preview.status, 200);
    await saveDocumentSource(f, 'workspace', f.parents[0], 0);
    assert.deepEqual((await collectDocumentFiles(f, 'workspace', { limit: 1 })).entries.map(entry => entry.path), ['native-a/same.md', 'shared.md']);
    assert.equal((await readSourceContent(f, 'workspace', 'native-a/same.md')).content, '# Project A file\n');
    const b = await createDocumentProject(f, 'Project registered after source configuration', 'native-b');
    await writeFile(join(b.location.path!, 'same.md'), '# Project B file\n');
    assert.equal((await readDocumentSources(f)).find(source => source.projectId === null)?.status, 'available');
    const refreshed = await collectDocumentFiles(f, 'workspace', { limit: 1 });
    assert.deepEqual(refreshed.entries.map(entry => entry.path), ['native-a/same.md', 'native-b/same.md', 'shared.md']);
    assert.equal(refreshed.entries.some(entry => entry.path.includes('/.pm/')), false);
    await saveDocumentSource(f, 'workspace', null, 1);
    await saveDocumentSource(f, a.record.id, a.location.path!, 0);
    assert.deepEqual((await collectDocumentFiles(f, a.record.id)).entries.map(entry => entry.path), ['same.md']);
    assert.equal((await readSourceContent(f, a.record.id, 'same.md')).content, '# Project A file\n');
    assert.deepEqual((await f.pool.query("SELECT path,revision FROM agent_file_areas WHERE workspace_id=$1 AND project_key=''", [f.workspaceId])).rows, [{ path: f.parents[0], revision: 1 }]);
  });

  it('rejects only equal or nested configured source roots, permits siblings, and serializes overlapping saves', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const a = await createDocumentProject(f, 'Distinct source project', 'native-source');
    const parent = join(f.parents[1], 'sources'), child = join(parent, 'child'), sibling = join(f.parents[1], 'sources-sibling');
    await mkdir(child, { recursive: true }); await mkdir(sibling);
    await writeFile(join(child, 'same.md'), '# Nested file\n');
    await writeFile(join(sibling, 'same.md'), '# Separate file with the same name\n');
    const raced = await Promise.all([
      f.request(documentSourcesPath(f, 'workspace'), { method: 'PUT', body: { path: parent, expectedRevision: 0 } }),
      f.request(documentSourcesPath(f, a.record.id), { method: 'PUT', body: { path: child, expectedRevision: 0 } }),
    ]);
    assert.deepEqual(raced.map(response => response.status).sort(), [200, 409]);
    assertDocumentSourceFailure(raced.find(response => response.status === 409)!, [409], 'document_source_overlap');
    const configured = (await readDocumentSources(f)).find(source => source.status === 'available')!;
    await saveDocumentSource(f, configured.projectId ?? 'workspace', null, configured.revision);
    const workspaceRevision = (await readDocumentSources(f)).find(source => source.projectId === null)!.revision;
    const projectRevision = (await readDocumentSources(f)).find(source => source.projectId === a.record.id)!.revision;
    await saveDocumentSource(f, 'workspace', child, workspaceRevision);
    for (const candidate of [child, parent]) {
      const preview = await f.request(`${documentSourcesPath(f)}/preview`, { method: 'POST', body: { projectId: a.record.id, path: candidate } });
      assertDocumentSourceFailure(preview, [409], 'document_source_overlap');
      const save = await f.request(documentSourcesPath(f, a.record.id), { method: 'PUT', body: { path: candidate, expectedRevision: projectRevision } });
      assertDocumentSourceFailure(save, [409], 'document_source_overlap');
    }
    await saveDocumentSource(f, a.record.id, sibling, projectRevision);
    assert.deepEqual((await collectDocumentFiles(f, 'workspace')).entries.map(entry => entry.path), ['same.md']);
    assert.deepEqual((await collectDocumentFiles(f, a.record.id)).entries.map(entry => entry.path), ['same.md']);
    assert.equal((await readSourceContent(f, a.record.id, 'same.md')).content, '# Separate file with the same name\n');
    const anotherWorkspace = await createWorkspace(f.pool, f.owner.id, 'Other source workspace');
    const foreignOverlap = await f.request(documentSourcesPath(f, 'workspace', anotherWorkspace.id), { method: 'PUT', body: { path: child, expectedRevision: 0 } });
    assertDocumentSourceFailure(foreignOverlap, [409], 'document_source_overlap');
    await saveDocumentSource(f, 'workspace', null, workspaceRevision + 1);
    await saveDocumentSource(f, a.record.id, parent, projectRevision + 1);
    const nested = await f.request(documentSourcesPath(f, 'workspace'), { method: 'PUT', body: { path: child, expectedRevision: workspaceRevision + 2 } });
    assertDocumentSourceFailure(nested, [409], 'document_source_overlap');
  });

  it('filters unauthorized project subtrees without rejecting the parent source or leaking names, and invalidates visible pagination after a membership change', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const a = await createDocumentProject(f, 'Readable project', 'allowed');
    const b = await createDocumentProject(f, 'Restricted project', 'hidden-project');
    await writeFile(join(a.location.path!, 'same.md'), '# Allowed body\n');
    await writeFile(join(b.location.path!, 'secret.md'), '# PRIVATE_PROJECT_BODY\n');
    await writeFile(join(f.parents[0], 'shared.md'), '# Shared source body\n');
    await saveDocumentSource(f, a.record.id, f.parents[0], 0);
    const reader = await f.member('Only project A');
    const membership = await f.command<{ version: number }>('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [a.record.id, b.record.id] });
    const first = await f.request<DocumentSourceFiles>(`${documentSourcesPath(f, a.record.id)}/files?limit=1`, { cookie: reader.cookie });
    assert.equal(first.status, 200); assert.ok(first.body.nextCursor);
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [a.record.id] }, { expectedVersions: { [reader.user.id]: membership.version } });
    const stale = await f.request(`${documentSourcesPath(f, a.record.id)}/files?${new URLSearchParams({ limit: '1', cursor: first.body.nextCursor! })}`, { cookie: reader.cookie });
    assertDocumentSourceFailure(stale, [409], 'document_source_cursor_invalid');
    const visible = await collectDocumentFiles(f, a.record.id, { cookie: reader.cookie, limit: 1 });
    assert.deepEqual(visible.entries.map(entry => entry.path), ['allowed/same.md', 'shared.md']);
    assert.equal(visible.scanComplete, false);
    assert.ok(visible.issues.some(issue => issue.code === 'scope_excluded' && issue.path === ''));
    assert.equal(JSON.stringify(visible).includes('hidden-project'), false);
    assert.equal((await readSourceContent(f, a.record.id, 'allowed/same.md', reader.cookie)).content, '# Allowed body\n');
    const denied = await f.request(contentPath(documentSourcesPath(f, a.record.id), 'hidden-project/secret.md'), { cookie: reader.cookie });
    assertDocumentSourceFailure(denied, [404], 'not_found_or_forbidden');
    assert.equal(JSON.stringify(denied.body).includes('PRIVATE_PROJECT_BODY'), false);
    assert.equal((await readSourceContent(f, a.record.id, 'hidden-project/secret.md')).content, '# PRIVATE_PROJECT_BODY\n');
    await saveDocumentSource(f, a.record.id, null, 1);
    const other = await createWorkspace(f.pool, f.owner.id, 'Foreign workspace source');
    const saved = await f.request(documentSourcesPath(f, 'workspace', other.id), { method: 'PUT', body: { path: f.parents[0], expectedRevision: 0 } });
    assert.equal(saved.status, 200);
    const foreignFiles = await f.request<DocumentSourceFiles>(`${documentSourcesPath(f, 'workspace', other.id)}/files`);
    assert.equal(foreignFiles.status, 200);
    assert.deepEqual(foreignFiles.body.entries.map(entry => entry.path), ['shared.md']);
    assert.equal(JSON.stringify(foreignFiles.body).includes('hidden-project'), false);
    assertDocumentSourceFailure(await f.request(contentPath(documentSourcesPath(f, 'workspace', other.id), 'allowed/same.md')), [404]);
    assert.equal(await readFile(join(b.location.path!, 'secret.md'), 'utf8'), '# PRIVATE_PROJECT_BODY\n');
  });
});
