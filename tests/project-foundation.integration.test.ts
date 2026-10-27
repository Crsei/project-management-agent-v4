import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ApiError, ProjectManagementClient } from '../packages/contracts/src/client.ts';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { ProjectExtras, ProjectFavorite } from '../packages/domain/src/project-extras.ts';
import type { ProjectDirectory } from '../packages/domain/src/project-directory.ts';
import { createDashboardFixture, dashboardDatabaseUrl } from './dashboard-fixture.ts';

const command = (commandType: string, payload: Record<string, unknown>, extra: Partial<Command> = {}): Command => ({ commandId: randomUUID(), commandType, payload, ...extra });

describe('formal project query authorization and audit pagination', { skip: !dashboardDatabaseUrl, timeout: 240_000 }, () => {
  it('isolates favorite actors and directory discovery, then hides revoked project relations', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const project = await f.command<Entity>('CreateProject', { name: 'Visible project', goal: 'Project query isolation', ownerId: f.owner.id, completionCriteria: [] });
    const other = await f.command<Entity>('CreateProject', { name: 'Hidden project', goal: 'Must remain undiscoverable', ownerId: f.owner.id, completionCriteria: [] });
    const reader = await f.member('Project-only reader');
    const unrelated = await f.member('Unrelated member');
    let membership = await f.command<{ version: number }>('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [project.id] });
    await f.command('SetWorkspaceMember', { userId: unrelated.user.id, capabilities: ['domain.read'], projectIds: [other.id] });
    const favorite = await f.command<ProjectFavorite>('SetProjectFavorite', { favorite: true }, { extra: { targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: project.version } } });
    const api = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => reader.cookie } });
    const extras = await api.getProjectExtras(f.workspaceId);
    assert.deepEqual(extras.projects.map(row => row.projectId), [project.id]);
    assert.equal(extras.projects[0]!.favorite, null, 'Another actor must not discover the owner favorite');
    const own = await f.request<ProjectExtras>(`/api/v1/workspaces/${f.workspaceId}/projects/extras`);
    assert.equal(own.body.projects.find(row => row.projectId === project.id)!.favorite!.id, favorite.id);
    const directory = await api.getProjectDirectory(f.workspaceId);
    assert.equal(directory.management, null);
    assert.deepEqual(directory.projects.map(row => row.projectId), [project.id]);
    const serialized = JSON.stringify(directory);
    for (const secret of [other.id, unrelated.user.id, unrelated.user.name, unrelated.user.email, f.owner.email, 'capabilities', 'projectIds']) assert.equal(serialized.includes(secret), false, `Directory leaked ${secret}`);
    for (const path of ['extras', 'directory']) {
      const invalid = await f.request(`/api/v1/workspaces/${f.workspaceId}/projects/${path}?actorId=${f.owner.id}`, { cookie: reader.cookie });
      assert.equal(invalid.status, 400, 'Queries cannot select another actor');
    }
    const auditPath = `/api/v1/workspaces/${f.workspaceId}/projects/${project.id}/audit`;
    assert.equal((await f.request(auditPath, { cookie: reader.cookie })).status, 403, 'domain.read alone does not grant audit.read');
    membership = await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read', 'audit.read'], projectIds: [] }, { extra: { expectedVersions: { [reader.user.id]: membership.version } } });
    assert.deepEqual((await api.getProjectExtras(f.workspaceId)).projects, []);
    const revokedDirectory: ProjectDirectory = await api.getProjectDirectory(f.workspaceId);
    assert.deepEqual(revokedDirectory, { projects: [], management: null });
    await assert.rejects(api.getProjectAudit(f.workspaceId, project.id), error => error instanceof ApiError && error.status === 404);
    await f.command('RevokeWorkspaceMember', { userId: reader.user.id }, { extra: { expectedVersions: { [reader.user.id]: membership.version } } });
    await assert.rejects(api.getProjectExtras(f.workspaceId), error => error instanceof ApiError && error.status === 404);
    await assert.rejects(api.getProjectDirectory(f.workspaceId), error => error instanceof ApiError && error.status === 404);
  });

  it('paginates a stable project audit snapshot and rejects actor-swapped or invalid cursors', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    let project = await f.command<Entity>('CreateProject', { name: 'Audit baseline', goal: 'Stable authorized audit', ownerId: f.owner.id, completionCriteria: [] });
    const reader = await f.member('Audit reader');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read', 'audit.read'], projectIds: [project.id] });
    for (const name of ['First audited rename', 'Second audited rename']) project = await f.command<Entity>('UpdateProject', { name, goal: 'Stable authorized audit', ownerId: f.owner.id, completionCriteria: [] }, { extra: { targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: project.version } } });
    const ownerApi = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => f.ownerCookie } });
    const readerApi = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => reader.cookie } });
    const first = await readerApi.getProjectAudit(f.workspaceId, project.id, { limit: 1 });
    assert.equal(first.entries.length, 1);
    assert.ok(first.nextCursor, 'History must offer a real continuation beyond the first page');
    await assert.rejects(ownerApi.getProjectAudit(f.workspaceId, project.id, { cursor: first.nextCursor, limit: 1 }), error => error instanceof ApiError && error.status >= 400 && error.status < 500);
    const laterCommand = command('UpdateProject', { name: 'Inserted after audit snapshot', goal: 'Stable authorized audit', ownerId: f.owner.id, completionCriteria: [] }, { targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: project.version } });
    const later = await f.send(laterCommand);
    assert.equal(later.status, 200, JSON.stringify(later.body));
    const entries = [...first.entries];
    const seen = new Set<string>();
    let cursor: string | null = first.nextCursor;
    while (cursor !== null) {
      assert.equal(seen.has(cursor), false, 'Audit pagination must advance');
      seen.add(cursor);
      const page = await readerApi.getProjectAudit(f.workspaceId, project.id, { cursor, limit: 1 });
      assert.equal(page.projectId, project.id);
      entries.push(...page.entries);
      cursor = page.nextCursor;
    }
    assert.ok(entries.length > 1);
    assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
    assert.equal(entries.some(entry => entry.commandId === laterCommand.commandId), false, 'Continuation stays at the initial snapshot head');
    assert.equal((await readerApi.getProjectAudit(f.workspaceId, project.id, { limit: 100 })).entries.some(entry => entry.commandId === laterCommand.commandId), true, 'A refreshed first page sees the committed write');
    const path = `/api/v1/workspaces/${f.workspaceId}/projects/${project.id}/audit`;
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=1&limit=2', 'cursor=', 'actorId=someone', 'cursor=not-a-valid-cursor']) assert.equal((await f.request(`${path}?${query}`, { cookie: reader.cookie })).status, 400, query);
  });

  it('keeps native configuration guards inside SQL rejection and receipt-replay semantics', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const project = await f.command<Entity>('CreateProject', { name: 'Native guarded annotations', goal: 'Native write authority is retained', ownerId: f.owner.id, completionCriteria: [] });
    const accepted = command('SetProjectScope', { items: [] }, { targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: project.version } });
    const committed = await f.send(accepted);
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(committed.body.status, 'committed');
    const scope = committed.body.result as { id: string; version: number };
    const configPath = join(f.coreRoot, f.workspaceId, '.pm', 'config.yaml');
    await writeFile(configPath, 'workflows: [invalid]\\n');
    assert.deepEqual((await f.send(accepted)).body, committed.body, 'Original success still replays without re-executing native guards');
    const payloads: [string, Record<string, unknown>][] = [
      ['SetProjectCover', { artifactVersionId: null }],
      ['SetProjectScope', { items: [] }],
      ['SetProjectTeams', { teamIds: [] }],
    ];
    const rejected: { input: Command; body: unknown }[] = [];
    for (const [type, payload] of payloads) {
      const input = command(type, payload, { targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: project.version, [scope.id]: scope.version } });
      const response = await f.send(input);
      assert.equal(response.status, 422, JSON.stringify(response.body));
      assert.equal(response.body.status, 'rejected');
      assert.equal(response.body.error?.code, 'CONFIGURATION_INVALID');
      const audit = await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM project_audit WHERE command_id=$1', [input.commandId]);
      assert.equal(audit.rows[0]!.count, '0', 'Rejected project writes must not create success audit facts');
      rejected.push({ input, body: response.body });
    }
    await rm(configPath);
    for (const previous of rejected) assert.deepEqual((await f.send(previous.input)).body, previous.body, 'Repair cannot turn an old rejected command into a different result');
    const fresh = await f.send({ ...accepted, commandId: randomUUID(), expectedVersions: { [project.id]: project.version, [scope.id]: scope.version } });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    const current = await f.pool.query<{ version: number }>('SELECT version FROM dashboard_records WHERE id=$1', [scope.id]);
    assert.equal(current.rows[0]!.version, scope.version + 1);
  });
});
