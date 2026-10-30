import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { DocumentSource, DocumentSourceFiles } from '../packages/contracts/src/document-sources.ts';
import { createWorkspace } from '../packages/infrastructure/src/auth.ts';
import type { FileRecord } from '../packages/pm-schema/index.ts';
import { createLocalProjectFixture, localProjectCaseTimeout } from './local-project-fixture.ts';
import { assertDocumentBytesUnchanged, assertDocumentSourceFailure, assertPrivateDocumentResponse, collectDocumentFiles, createDocumentProject, documentSourcesPath, readDocumentSources, readSourceContent, saveDocumentSource, seedDocumentTree } from './document-sources-fixture.ts';

// A missing/unreachable real database is a failure, never a skipped acceptance case.
describe('directory document sources: real PostgreSQL, HTTP, native PM and disk', { concurrency: 1 }, () => {
  it('previews without mutation, persists revision CAS and unlinking across API restarts, and leaves native documents and Agent cwd independent', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const a = await createDocumentProject(f, 'Native PM project A', 'native-a');
    const b = await createDocumentProject(f, 'Native PM project B', 'native-b');
    const native = await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/entities`, {
      method: 'POST', headers: { 'Idempotency-Key': randomUUID() },
      body: { entity: 'document', project: a.record.id, title: 'Original editable PM document', body: '# Native document\nOriginal authority and revision.\n' },
    });
    assert.equal(native.status, 200, JSON.stringify(native.body));
    const beforeAgent = await f.request('/api/v1/agent-contexts');
    assert.equal(beforeAgent.status, 200);
    const rootA = join(f.parents[1], 'workspace-markdown'), rootB = join(f.parents[1], 'alternate-markdown');
    await mkdir(rootA); await mkdir(rootB);
    const original = Buffer.from('# User-owned source\r\nDo not normalize these bytes.\r\n');
    await writeFile(join(rootA, 'existing.md'), original);
    const initial = await readDocumentSources(f);
    assert.deepEqual(initial.map(source => source.projectId).sort(), [null, a.record.id, b.record.id].sort());
    for (const source of initial) {
      assert.equal(source.revision, 0); assert.equal(source.status, 'unconfigured');
      assert.equal(source.path, null); assert.equal(source.canManage, true);
      assert.ok(source.name);
    }
    const preview = await f.request<{ path: string; readable: true }>(`${documentSourcesPath(f)}/preview`, { method: 'POST', body: { projectId: null, path: rootA } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assertPrivateDocumentResponse(preview);
    assert.equal(preview.body.path, rootA); assert.equal(preview.body.readable, true);
    assert.deepEqual(await readDocumentSources(f), initial, 'Preflight never saves a source or consumes a revision');
    const missingPath = join(f.parents[1], 'must-not-be-created');
    const missing = await f.request(`${documentSourcesPath(f)}/preview`, { method: 'POST', body: { projectId: null, path: missingPath } });
    assertDocumentSourceFailure(missing, [400, 403, 404, 409]);
    await assert.rejects(lstat(missingPath), { code: 'ENOENT' });
    const first = await saveDocumentSource(f, 'workspace', rootA, 0);
    assert.equal(first.projectId, null);
    assert.equal((await readSourceContent(f, 'workspace', 'existing.md')).content, original.toString());
    const projectRoot = join(f.parents[1], 'project-markdown'); await mkdir(projectRoot);
    await writeFile(join(projectRoot, 'project.md'), '# Project source\nIndependent from workspace source.\n');
    const projectPreview = await f.request<{ path: string; readable: true }>(`${documentSourcesPath(f)}/preview`, { method: 'POST', body: { projectId: a.record.id, path: projectRoot } });
    assert.equal(projectPreview.status, 200); assert.equal(projectPreview.body.readable, true);
    assert.equal((await readDocumentSources(f)).find(source => source.projectId === a.record.id)?.revision, 0);
    const projectSource = await saveDocumentSource(f, a.record.id, projectRoot, 0);
    assert.equal(projectSource.projectId, a.record.id);
    assert.equal((await readSourceContent(f, a.record.id, 'project.md')).content, '# Project source\nIndependent from workspace source.\n');
    const raced = await Promise.all([rootA, rootB].map(path => f.request<{ source: DocumentSource }>(documentSourcesPath(f, 'workspace'), { method: 'PUT', body: { path, expectedRevision: 1 } })));
    assert.deepEqual(raced.map(response => response.status).sort(), [200, 409]);
    const winner = raced.find(response => response.status === 200)!;
    const loser = raced.find(response => response.status === 409)!;
    assert.equal(winner.body.source.revision, 2);
    assertDocumentSourceFailure(loser, [409], 'document_source_revision_conflict');
    assert.equal(loser.body.error.details?.currentRevision, 2);
    assert.deepEqual((await readDocumentSources(f)).find(source => source.projectId === null), winner.body.source, 'A lost CAS does not overwrite the winner');

    // Deliberately discard a real successful PUT body. A consumer must recover by
    // reading current configuration, not retrying an operation with a stale CAS.
    const unobserved = await fetch(`${f.origin}${documentSourcesPath(f, 'workspace')}`, {
      method: 'PUT', headers: { cookie: f.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: rootA, expectedRevision: 2 }), signal: f.signal,
    });
    assert.equal(unobserved.status, 200);
    await unobserved.body?.cancel();
    const reconciled = (await readDocumentSources(f)).find(source => source.projectId === null)!;
    assert.equal(reconciled.path, rootA); assert.equal(reconciled.revision, 3);
    await f.restartApi();
    assert.deepEqual((await readDocumentSources(f)).find(source => source.projectId === null), reconciled);
    assert.deepEqual((await readDocumentSources(f)).find(source => source.projectId === a.record.id), projectSource);
    assert.equal((await readSourceContent(f, 'workspace', 'existing.md')).sourceRevision, 3);
    const cleared = await saveDocumentSource(f, 'workspace', null, 3);
    const clearedProject = await saveDocumentSource(f, a.record.id, null, 1);
    await f.restartApi();
    assert.deepEqual((await readDocumentSources(f)).find(source => source.projectId === null), cleared);
    assert.deepEqual((await readDocumentSources(f)).find(source => source.projectId === a.record.id), clearedProject);
    assert.equal(await readFile(join(projectRoot, 'project.md'), 'utf8'), '# Project source\nIndependent from workspace source.\n');
    const stale = await f.request(documentSourcesPath(f, 'workspace'), { method: 'PUT', body: { path: rootB, expectedRevision: 3 } });
    assertDocumentSourceFailure(stale, [409], 'document_source_revision_conflict');
    assert.equal(stale.body.error.details?.currentRevision, 4, 'Unlinking retains the monotonic revision');
    assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f, 'workspace')}/content?path=existing.md`), [409]);
    assert.deepEqual(await readFile(join(rootA, 'existing.md')), original, 'Unlinking only deletes the mapping, never user files');
    assert.deepEqual((await f.request('/api/v1/agent-contexts')).body, beforeAgent.body, 'Document settings never change the Agent execution location');
    const unchangedNative = await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${native.body.id}`);
    assert.equal(unchangedNative.status, 200);
    assert.equal(unchangedNative.body.raw, native.body.raw); assert.equal(unchangedNative.body.revision, native.body.revision);
    const edited = await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/entities/${native.body.id}`, { method: 'PATCH', body: { revision: native.body.revision, changes: { title: 'Native editing still works' } } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.notEqual(edited.body.revision, native.body.revision);
    assert.equal(edited.body.entity.title, 'Native editing still works');
    const bodyEdited = await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${native.body.id}`, {
      method: 'PUT', body: { revision: edited.body.revision, raw: edited.body.raw.replace('Original authority and revision.', 'Native body remains editable after configuring external sources.') },
    });
    assert.equal(bodyEdited.status, 200, JSON.stringify(bodyEdited.body));
    assert.notEqual(bodyEdited.body.revision, edited.body.revision);
    assert.ok(bodyEdited.body.raw.includes('Native body remains editable after configuring external sources.'));
  });

  it('exhausts recursive Markdown pagination, preserves all source bytes, refreshes disk changes and invalidates cursors on disk or configuration changes', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const root = join(f.parents[1], 'full-tree');
    const original = await seedDocumentTree(root);
    const expectedPaths = [...original.keys()].filter(path => /\.md$/i.test(path)).sort();
    const nativeBefore = await f.request<{ files: FileRecord[] }>(`/api/v1/workspaces/${f.workspaceId}/core/workspace`);
    assert.equal(nativeBefore.status, 200);
    const saved = await saveDocumentSource(f, 'workspace', root, 0);
    const all = await collectDocumentFiles(f, 'workspace');
    assert.ok(all.pages > 1, 'The real default page must be exceeded');
    assert.equal(all.sourceRevision, saved.revision);
    assert.equal(all.scanComplete, true); assert.deepEqual(all.issues, []);
    assert.deepEqual(all.entries.map(entry => entry.path).sort(), expectedPaths);
    const smaller = await collectDocumentFiles(f, 'workspace', { limit: 31 });
    assert.deepEqual(smaller.entries.map(entry => entry.path).sort(), expectedPaths);
    assert.ok(smaller.pages > all.pages);
    for (const path of ['根目录.md', '同名.md', '层级 一/同名.md', '层级 一/更 深/同名.md', '空 格.MD', '无 frontmatter.md', '特殊字符 # ?.md']) {
      const content = await readSourceContent(f, 'workspace', path);
      assert.equal(content.content, original.get(path)!.toString());
      assert.equal(content.sourceRevision, saved.revision);
    }
    assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f, 'workspace')}/content?path=not-markdown.txt`), [400, 403, 404]);
    await assertDocumentBytesUnchanged(root, original);
    const nativeAfter = await f.request<{ files: FileRecord[] }>(`/api/v1/workspaces/${f.workspaceId}/core/workspace`);
    assert.equal(nativeAfter.status, 200);
    assert.deepEqual(nativeAfter.body.files, nativeBefore.body.files, 'Listing and reading plain Markdown must not import it into native PM entities');
    const firstPage = await f.request<DocumentSourceFiles>(`${documentSourcesPath(f, 'workspace')}/files?limit=2`);
    assert.equal(firstPage.status, 200); assert.ok(firstPage.body.nextCursor);
    await writeFile(join(root, '新增 文档.MD'), '# Freshly added\nOnly present after the initial scan.\n');
    const staleDiskCursor = await f.request(`${documentSourcesPath(f, 'workspace')}/files?${new URLSearchParams({ limit: '2', cursor: firstPage.body.nextCursor! })}`);
    assertDocumentSourceFailure(staleDiskCursor, [409], 'document_source_cursor_invalid');
    const changed = '# 修改后的正文\nLonger content with an actual disk update.\n';
    await writeFile(join(root, '根目录.md'), changed);
    await rm(join(root, '同名.md'));
    const refreshed = await collectDocumentFiles(f, 'workspace');
    assert.equal(refreshed.scanComplete, true); assert.deepEqual(refreshed.issues, []);
    assert.deepEqual(refreshed.entries.map(entry => entry.path).sort(), expectedPaths.filter(path => path !== '同名.md').concat('新增 文档.MD').sort());
    assert.equal((await readSourceContent(f, 'workspace', '根目录.md')).content, changed);
    assert.equal((await readSourceContent(f, 'workspace', '新增 文档.MD')).content, '# Freshly added\nOnly present after the initial scan.\n');
    assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f, 'workspace')}/content?${new URLSearchParams({ path: '同名.md' })}`), [404], 'document_source_file_not_found');
    const unchanged = new Map(original); unchanged.delete('根目录.md'); unchanged.delete('同名.md');
    await assertDocumentBytesUnchanged(root, unchanged);
    const beforeSwitch = await f.request<DocumentSourceFiles>(`${documentSourcesPath(f, 'workspace')}/files?limit=2`);
    assert.equal(beforeSwitch.status, 200); assert.ok(beforeSwitch.body.nextCursor);
    const other = join(f.parents[1], 'replacement-source'); await mkdir(other);
    await writeFile(join(other, 'only-here.md'), '# Different configured source\n');
    await saveDocumentSource(f, 'workspace', other, 1);
    assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f, 'workspace')}/files?${new URLSearchParams({ limit: '2', cursor: beforeSwitch.body.nextCursor! })}`), [409], 'document_source_cursor_invalid');
    assert.deepEqual((await collectDocumentFiles(f, 'workspace')).entries.map(entry => entry.path), ['only-here.md']);
    assert.equal((await readSourceContent(f, 'workspace', 'only-here.md')).sourceRevision, 2);
    assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f, 'workspace')}/content?${new URLSearchParams({ path: '根目录.md' })}`), [404]);
  });

  it('enforces anonymous, workspace, project-only, management, revocation and cross-workspace authorization on every operation without disclosing host paths', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const a = await createDocumentProject(f, 'Allowed project', 'acl-a');
    const b = await createDocumentProject(f, 'Restricted project', 'acl-b');
    const scopes = ['workspace', a.record.id, b.record.id];
    const roots = [join(f.parents[1], 'workspace-source'), join(f.parents[1], 'project-a-source'), join(f.parents[1], 'project-b-source')];
    for (const [index, scope] of scopes.entries()) {
      await mkdir(roots[index]!); await writeFile(join(roots[index]!, 'same.md'), `Private body for ${scope}\n`);
      await saveDocumentSource(f, scope, roots[index]!, 0);
    }
    const reader = await f.member('Workspace document reader'), scoped = await f.member('Project-only document reader');
    const outsider = await f.member('No membership'), manager = await f.member('Read-only path manager'), blindManager = await f.member('Manager without document read capability');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: null });
    const scopedMembership = await f.command<{ version: number }>('SetWorkspaceMember', { userId: scoped.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [a.record.id] });
    await f.command('SetWorkspaceMember', { userId: manager.user.id, capabilities: ['domain.read', 'access.manage'], projectIds: null });
    await f.command('SetWorkspaceMember', { userId: blindManager.user.id, capabilities: ['planning.edit', 'access.manage'], projectIds: null });
    const visible = await readDocumentSources(f, reader.cookie);
    assert.deepEqual(visible.map(source => source.projectId).sort(), [null, a.record.id, b.record.id].sort());
    for (const source of visible) {
      assert.equal(source.path, null); assert.equal(source.canManage, false); assert.equal(source.status, 'available');
    }
    assert.equal(JSON.stringify(visible).includes(f.root), false);
    for (const scope of scopes) {
      assert.equal((await readSourceContent(f, scope, 'same.md', reader.cookie)).content, `Private body for ${scope}\n`);
      assert.deepEqual((await collectDocumentFiles(f, scope, { cookie: reader.cookie })).entries.map(entry => entry.path), ['same.md']);
    }
    const restricted = await readDocumentSources(f, scoped.cookie);
    assert.deepEqual(restricted.map(source => source.projectId), [a.record.id], 'A project member cannot discover the workspace or another project source');
    assert.equal(restricted[0]!.path, null); assert.equal(restricted[0]!.canManage, false);
    assert.equal((await readSourceContent(f, a.record.id, 'same.md', scoped.cookie)).content, `Private body for ${a.record.id}\n`);
    const managementOnly = await readDocumentSources(f, manager.cookie);
    assert.ok(managementOnly.every(source => source.path !== null && source.canManage === false));
    assertDocumentSourceFailure(await f.request(documentSourcesPath(f), { cookie: blindManager.cookie }), [403]);
    assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f, 'workspace')}/files`, { cookie: blindManager.cookie }), [403]);
    assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f, 'workspace')}/content?path=same.md`, { cookie: blindManager.cookie }), [403]);
    for (const cookie of [reader.cookie, scoped.cookie, manager.cookie, blindManager.cookie, outsider.cookie]) {
      assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f)}/preview`, { method: 'POST', cookie, body: { projectId: null, path: roots[0] } }), [403, 404]);
      assertDocumentSourceFailure(await f.request(documentSourcesPath(f, 'workspace'), { method: 'PUT', cookie, body: { path: roots[0], expectedRevision: 1 } }), [403, 404]);
    }
    for (const scope of ['workspace', b.record.id]) {
      for (const suffix of ['/files', '/content?path=same.md']) {
        const denied = await f.request(`${documentSourcesPath(f, scope)}${suffix}`, { cookie: scoped.cookie });
        assertDocumentSourceFailure(denied, [403, 404]);
        assert.equal(JSON.stringify(denied.body).includes(f.root), false);
        assert.equal(JSON.stringify(denied.body).includes(`Private body for ${scope}`), false);
      }
    }
    for (const cookie of ['', outsider.cookie]) {
      for (const path of [documentSourcesPath(f), `${documentSourcesPath(f, 'workspace')}/files`, `${documentSourcesPath(f, a.record.id)}/content?path=same.md`]) {
        assertDocumentSourceFailure(await f.request(path, { cookie }), cookie ? [403, 404] : [401]);
      }
    }
    for (const headers of [{ origin: 'https://hostile.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      assertDocumentSourceFailure(await f.request(documentSourcesPath(f, 'workspace'), { method: 'PUT', headers, body: { path: roots[0], expectedRevision: 1 } }), [403]);
    }
    const foreign = await createWorkspace(f.pool, outsider.user.id, 'Foreign workspace');
    for (const suffix of ['', '/workspace/files', '/workspace/content?path=same.md']) {
      assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f, undefined, foreign.id)}${suffix}`), [403, 404]);
    }
    assertDocumentSourceFailure(await f.request(documentSourcesPath(f, a.record.id, foreign.id), { method: 'PUT', cookie: outsider.cookie, body: { path: roots[1], expectedRevision: 0 } }), [403, 404]);
    assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f, a.record.id, foreign.id)}/content?path=same.md`, { cookie: outsider.cookie }), [403, 404]);
    await f.command('RevokeWorkspaceMember', { userId: scoped.user.id }, { expectedVersions: { [scoped.user.id]: scopedMembership.version } });
    for (const path of [documentSourcesPath(f), `${documentSourcesPath(f, a.record.id)}/files`, `${documentSourcesPath(f, a.record.id)}/content?path=same.md`]) {
      assertDocumentSourceFailure(await f.request(path, { cookie: scoped.cookie }), [403, 404]);
    }
    assert.equal((await readSourceContent(f, b.record.id, 'same.md')).content, `Private body for ${b.record.id}\n`, 'Revocation of one member does not corrupt the configuration');
    for (const scope of scopes) assert.equal((await readDocumentSources(f)).find(source => (source.projectId ?? 'workspace') === scope)?.revision, 1, 'Denied writes do not advance revisions');
  });
});
