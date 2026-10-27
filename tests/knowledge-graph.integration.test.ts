import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { createMarkdown } from '../packages/pm-markdown/index.ts';
import { parseConfiguration, type FileRecord } from '../packages/pm-schema/index.ts';
import type { GraphData } from '../packages/pm-schema/graph.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';

async function seed(fixture: DashboardFixture) {
  assert.equal((await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/core/health`)).status, 200);
  const configuration = parseConfiguration({ schema: 'pm/config/v1', workflows: {}, custom_fields: [
    { name: 'x-secret', label: 'Private reference', type: 'reference', entities: ['document'], target: 'work_item' },
  ] });
  const definitions = [
    { id: 'PRJ-1', entity: 'project', title: 'Visible project' },
    { id: 'PRJ-2', entity: 'project', title: 'Hidden project' },
    { id: 'DOC-1', entity: 'document', project: 'PRJ-1', title: 'Source', body: '[[Shared]] [[DOC-3]] [[Missing]] [[TASK-2]]' },
    { id: 'DOC-2', entity: 'document', project: 'PRJ-1', title: 'Shared' },
    { id: 'DOC-3', entity: 'document', project: 'PRJ-2', title: 'Shared', 'x-secret': 'TASK-2', body: '[[PRIVATE-DIAGNOSTIC]]' },
    { id: 'TASK-1', entity: 'work_item', project: 'PRJ-1', title: 'Visible task', blocked_by: ['TASK-2'] },
    { id: 'TASK-2', entity: 'work_item', project: 'PRJ-2', title: 'PRIVATE-TARGET' },
    { id: 'DOC-4', entity: 'document', project: 'PRJ-1', title: 'Archived note', archived: true, related_to: ['DOC-2'] },
  ];
  const root = join(fixture.coreRoot, fixture.workspaceId);
  await mkdir(join(root, 'entities'), { recursive: true });
  await mkdir(join(root, '.pm'), { recursive: true });
  await writeFile(join(root, '.pm', 'config.yaml'), stringify(configuration));
  const files: FileRecord[] = [];
  for (const definition of definitions) {
    const raw = createMarkdown(definition, configuration);
    const relative = join('entities', `${definition.id}.md`);
    await writeFile(join(root, relative), raw);
  }
  // Reads must refresh the already-open projection, without waiting for the filesystem watcher.
  for (const definition of definitions) {
    const response = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${definition.id}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    files.push(response.body);
  }
  return { files, configuration, root };
}

describe('knowledge graph real authenticated HTTP and Markdown privacy', { skip: !dashboardDatabaseUrl }, () => {
  test('full-workspace ambiguity is preserved before project scope trims every hidden edge, diagnostic and relation kind', async t => {
    const fixture = await createDashboardFixture(); t.after(() => fixture.close());
    const { files, root } = await seed(fixture);
    const member = await fixture.member('Restricted knowledge reader');
    const grant = await fixture.command<{ version: number }>('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read'], projectIds: ['PRJ-1'] });
    const endpoint = `/api/v1/workspaces/${fixture.workspaceId}/core/graph`;
    const full = await fixture.request<GraphData>(endpoint, { method: 'POST', body: {} });
    assert.equal(full.status, 200, JSON.stringify(full.body));
    assert.ok(full.body.availableRelations.includes('x-secret'));
    assert.ok(full.body.unresolved.some(issue => issue.source === 'DOC-1' && issue.target === 'Shared' && issue.reason === 'ambiguous'));
    const beforeBusiness = await fixture.pool.query('SELECT (SELECT count(*)::text FROM command_receipts) AS receipts, (SELECT count(*)::text FROM project_audit) AS audits, (SELECT count(*)::text FROM outbox) AS events');
    const scoped = await fixture.request<GraphData>(endpoint, { method: 'POST', cookie: member.cookie, body: {} });
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    assert.deepEqual(scoped.body.nodes.map(node => node.id), ['DOC-1', 'DOC-2', 'PRJ-1', 'TASK-1']);
    assert.deepEqual(scoped.body.links.map(({ source, target, kind }) => ({ source, target, kind })), [
      { source: 'DOC-1', target: 'PRJ-1', kind: 'project' },
      { source: 'DOC-2', target: 'PRJ-1', kind: 'project' },
      { source: 'TASK-1', target: 'PRJ-1', kind: 'project' },
    ]);
    assert.deepEqual(scoped.body.availableRelations, ['project']);
    assert.deepEqual(scoped.body.unresolved, []);
    const serialized = JSON.stringify(scoped.body);
    for (const secret of ['PRJ-2', 'DOC-3', 'TASK-2', 'PRIVATE-', 'x-secret', 'blocked_by', 'Missing', 'ambiguous', 'total', 'hiddenCount']) assert.equal(serialized.includes(secret), false, secret);
    const local = await fixture.request<GraphData>(endpoint, { method: 'POST', cookie: member.cookie, body: { centerId: 'DOC-1', depth: 3, relations: ['link'] } });
    assert.equal(local.status, 200);
    assert.deepEqual(local.body.nodes.map(node => node.id), ['DOC-1'], 'hidden same-title nodes cannot create a visible false-positive link');
    assert.deepEqual(local.body.links, []);
    const restrictedKinds = await fixture.request<GraphData>(endpoint, { method: 'POST', cookie: member.cookie, body: { relations: ['x-secret', 'blocked_by'] } });
    assert.deepEqual(restrictedKinds.body.links, []);
    assert.deepEqual(restrictedKinds.body.availableRelations, ['project']);
    const invisible = await fixture.request<{ error: string; diagnostics: unknown[] }>(endpoint, { method: 'POST', cookie: member.cookie, body: { centerId: 'DOC-3' } });
    const nonexistent = await fixture.request<{ error: string; diagnostics: unknown[] }>(endpoint, { method: 'POST', cookie: member.cookie, body: { centerId: 'DOC-999' } });
    assert.equal(invisible.status, 404); assert.equal(nonexistent.status, 404);
    assert.deepEqual(invisible.body, nonexistent.body);
    assert.equal(JSON.stringify(invisible.body).includes('DOC-3'), false);
    const excluded = await fixture.request<GraphData>(endpoint, { method: 'POST', cookie: member.cookie, body: { centerId: 'DOC-1', search: 'does not match' } });
    assert.equal(excluded.status, 200);
    assert.deepEqual(excluded.body, { nodes: [], links: [], unresolved: [], availableRelations: [] });
    const afterBusiness = await fixture.pool.query('SELECT (SELECT count(*)::text FROM command_receipts) AS receipts, (SELECT count(*)::text FROM project_audit) AS audits, (SELECT count(*)::text FROM outbox) AS events');
    assert.deepEqual(afterBusiness.rows, beforeBusiness.rows, 'graph POSTs create no receipts, audit records or business events');
    for (const file of files) assert.equal(await readFile(join(root, file.path), 'utf8'), file.raw, 'graph queries never modify authoritative Markdown');
    const changed = await fixture.command<{ version: number }>('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read'], projectIds: [] }, { extra: { expectedVersions: { [member.user.id]: grant.version } } });
    const reduced = await fixture.request<GraphData>(endpoint, { method: 'POST', cookie: member.cookie, body: { archived: 'include' } });
    assert.equal(reduced.status, 200);
    assert.deepEqual(reduced.body, { nodes: [], links: [], unresolved: [], availableRelations: [] });
    await fixture.command('RevokeWorkspaceMember', { userId: member.user.id }, { extra: { expectedVersions: { [member.user.id]: changed.version } } });
    assert.equal((await fixture.request(endpoint, { method: 'POST', cookie: member.cookie, body: {} })).status, 404);
  });

  test('strict query validation, authentication, common filters and saved-source updates use the real route', async t => {
    const fixture = await createDashboardFixture(); t.after(() => fixture.close());
    const { root } = await seed(fixture);
    const endpoint = `/api/v1/workspaces/${fixture.workspaceId}/core/graph`;
    assert.equal((await fixture.request(endpoint, { method: 'POST', cookie: '', body: {} })).status, 401);
    const outsider = await fixture.member('Not a member');
    assert.equal((await fixture.request(endpoint, { method: 'POST', cookie: outsider.cookie, body: {} })).status, 404);
    await fixture.command('SetWorkspaceMember', { userId: outsider.user.id, capabilities: [], projectIds: null });
    assert.equal((await fixture.request(endpoint, { method: 'POST', cookie: outsider.cookie, body: {} })).status, 403);
    for (const body of [[], null, { unknown: true }, { depth: 0 }, { depth: 4 }, { depth: 1.5 }, { depth: '2' },
      { centerId: 'bad' }, { centerId: 42 }, { relations: 'link' }, { relations: [1] }, { relations: [''] },
      { archived: 'all' }, { search: 42 }, { search: 'x'.repeat(501) }, { view: [] }, { view: { layout: 'graph', unknown: true } }]) {
      const response = await fixture.request(endpoint, { method: 'POST', body });
      assert.equal(response.status, 400, JSON.stringify({ body, response: response.body }));
    }
    assert.equal((await fixture.request(endpoint, { method: 'POST', body: {}, headers: { 'content-type': 'text/plain' } })).status, 400);
    const semantic = await fixture.request(endpoint, { method: 'POST', body: { view: { layout: 'graph', filter: { unknown: 'value' } } } });
    assert.equal(semantic.status, 422);
    const documents = await fixture.request<GraphData>(endpoint, {
      method: 'POST', body: { view: { layout: 'graph', entity: 'document', project: 'PRJ-1' }, archived: 'include', search: 'Shared' },
    });
    assert.equal(documents.status, 200);
    assert.deepEqual(documents.body.nodes.map(node => node.id), ['DOC-2']);
    assert.deepEqual(documents.body.links, []);
    const sourcePath = `/api/v1/workspaces/${fixture.workspaceId}/core/files/DOC-1`;
    const initial = await fixture.request<FileRecord>(sourcePath);
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    const externalRaw = `${initial.body.raw}\nAn external disk edit must not be overwritten by a stale source save.\n`;
    await writeFile(join(root, initial.body.path), externalRaw);
    const external = await fixture.request<FileRecord>(sourcePath);
    assert.equal(external.status, 200, JSON.stringify(external.body));
    assert.equal(external.body.raw, externalRaw);
    assert.notEqual(external.body.revision, initial.body.revision);
    const stale = await fixture.request(sourcePath, { method: 'PUT', body: { raw: initial.body.raw, revision: initial.body.revision } });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(await readFile(join(root, initial.body.path), 'utf8'), externalRaw);
    const saved = await fixture.request<FileRecord>(sourcePath, { method: 'PUT', body: { raw: `${external.body.raw}\n[[DOC-2#Section|Saved link]]\n`, revision: external.body.revision } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const converged = await fixture.request<GraphData>(endpoint, { method: 'POST', body: { centerId: 'DOC-1', relations: ['link'] } });
    assert.equal(converged.status, 200);
    assert.ok(converged.body.links.some(link => link.source === 'DOC-1' && link.target === 'DOC-2' && link.kind === 'link'));
    const unchanged = await fixture.request<FileRecord>(sourcePath);
    assert.equal(unchanged.body.revision, saved.body.revision);
    assert.equal(unchanged.body.raw, saved.body.raw);
  });

  test('idle graph subscriptions survive the HTTP timeout, deliver saved changes and close with the API', { timeout: 45_000 }, async t => {
    const fixture = await createDashboardFixture();
    const controller = new AbortController();
    t.after(async () => { controller.abort(); await fixture.close(); });
    await seed(fixture);
    const base = `/api/v1/workspaces/${fixture.workspaceId}/core`;
    const response = await fetch(`${fixture.origin}${base}/events`, { headers: { cookie: fixture.ownerCookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function nextEvent(type: string) {
      for (;;) {
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const message = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (message.startsWith(`event: ${type}\n`)) return;
        }
        const chunk = await reader.read();
        assert.equal(chunk.done, false, `stream ended before ${type}`);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
    await nextEvent('ready');
    // The real heartbeat arrives after the server's ordinary HTTP idle deadline.
    await nextEvent('heartbeat');
    const initial = await fixture.request<FileRecord>(`${base}/files/DOC-1`);
    const saved = await fixture.request<FileRecord>(`${base}/files/DOC-1`, {
      method: 'PUT', body: { raw: `${initial.body.raw}\n[[DOC-2]]\n`, revision: initial.body.revision },
    });
    assert.equal(saved.status, 200);
    await nextEvent('change');
    const graph = await fixture.request<GraphData>(`${base}/graph`, { method: 'POST', body: { centerId: 'DOC-1', relations: ['link'] } });
    assert.equal(graph.status, 200);
    assert.ok(graph.body.links.some(link => link.source === 'DOC-1' && link.target === 'DOC-2'));
    await fixture.app.close();
    assert.equal((await reader.read()).done, true, 'server shutdown ends the subscription');
  });
});
