import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it, type TestContext } from 'node:test';
import type { CommandReceipt, Entity } from '../packages/domain/src/core.ts';
import type { Membership } from '../packages/application/src/access.ts';
import type { ProjectExtras } from '../packages/domain/src/project-extras.ts';
import type { TeamWorkload } from '../packages/domain/src/team-workload.ts';
import type { WorkspaceCreationResult } from '../packages/contracts/src/workspace-creation.ts';
import type { LocalProjectAttempt } from '../packages/contracts/src/local-projects.ts';
import type { AccountSecurity, AccountSecurityAction } from '../packages/contracts/src/account-security.ts';
import type { PmToolCallRecord } from '../packages/agent-contracts/src/pm-tools.ts';
import { createDashboardFixture } from './dashboard-fixture.ts';
import { createLocalProjectFixture } from './local-project-fixture.ts';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../packages/pm-cli/index.ts', import.meta.url));
async function cli(t: TestContext, f: { origin: string; workspaceId: string; ownerCookie: string }) {
  const root = await mkdtemp(path.join('/tmp', 'pm-administration-cli-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', PM_API_URL: f.origin, PM_WORKSPACE_ID: f.workspaceId, PM_SESSION_TOKEN: f.ownerCookie.slice(f.ownerCookie.indexOf('=') + 1), PM_CLI_SESSION_DIR: path.join(root, 'sessions'), PM_CLI_OPERATION_DIR: path.join(root, 'operations') };
  const input = async (body: unknown) => {
    const filename = path.join(root, `${randomUUID()}.json`);
    await writeFile(filename, JSON.stringify(body), { mode: 0o600 });
    return filename;
  };
  const run = (...args: string[]) => execute(process.execPath, [entry, ...args], { env, signal: t.signal, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const command = async <T = unknown>(prefix: string, action: string, body: unknown, commandId = randomUUID()) => JSON.parse((await run(prefix, action, '--file', await input(body), '--command-id', commandId)).stdout) as CommandReceipt & { result: T };
  const call = async (name: string, args: unknown, projectId: string | null = null) => {
    const operation = { name, arguments: args, target: { workspaceId: f.workspaceId, projectId }, operationId: randomUUID() };
    const filename = await input(operation);
    const result = JSON.parse((await run('plugin', 'call', '--file', filename)).stdout) as PmToolCallRecord;
    return { result, filename, operation };
  };
  return { env, input, run, command, call };
}
async function rejected(operation: Promise<unknown>, secrets: string[] = []) {
  await assert.rejects(operation, (error: unknown) => {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    for (const secret of secrets) assert.equal(result.stderr?.includes(secret), false);
    return true;
  });
}
async function droppingProxy(t: TestContext, origin: string, match: string) {
  const calls: { method: string; url: string }[] = [];
  let dropped = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const method = request.method ?? 'GET', url = request.url ?? '/';
    calls.push({ method, url });
    const upstream = await fetch(origin + url, { method, headers: { ...(request.headers.authorization ? { Authorization: request.headers.authorization } : {}), ...(request.headers['content-type'] ? { 'Content-Type': request.headers['content-type'] } : {}), ...(request.headers['idempotency-key'] ? { 'Idempotency-Key': String(request.headers['idempotency-key']) } : {}) }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: t.signal });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (!dropped && method === 'POST' && url === match && upstream.ok) { dropped = true; response.destroy(); return; }
    response.writeHead(upstream.status, { 'Content-Type': 'application/json' }); response.end(bytes);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  t.after(async () => { const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed; });
  return { origin: `http://127.0.0.1:${address.port}`, calls };
}

// Explicit real PostgreSQL/API/CLI suite: no mock business services and no skipped acceptance.
// Parent runs once after family registry/result/app integration has landed.
describe('administration CLI and native PM-tool behavior', { timeout: 600_000, concurrency: 1 }, () => {
  it('retains the original actor-bound workspace on a lost response and never substitutes another create', async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const c = await cli(t, f);
    const proxy = await droppingProxy(t, f.origin, '/api/v1/workspaces');
    c.env.PM_API_URL = proxy.origin;
    const id = randomUUID(), filename = await c.input({ name: 'Original CLI workspace', expectedActorId: f.owner.id, includeSample: false });
    await rejected(c.run('workspace', 'create', '--file', filename, '--request-id', id));
    const original = JSON.parse((await c.run('workspace', 'creation-status', id)).stdout) as WorkspaceCreationResult;
    assert.equal(original.status, 'ready');
    const recovered = JSON.parse((await c.run('workspace', 'creation-recover', id, '--expected-actor', f.owner.id)).stdout) as WorkspaceCreationResult;
    assert.ok(original.status === 'ready' && recovered.status === 'ready');
    assert.equal(recovered.workspaceId, original.workspaceId);
    assert.equal(proxy.calls.filter(call => call.method === 'POST' && call.url === '/api/v1/workspaces').length, 1);
    const before = JSON.parse((await c.run('workspace', 'list')).stdout) as { items: { id: string }[] };
    await rejected(c.run('workspace', 'create', '--file', await c.input({ name: 'Wrong actor must not exist', expectedActorId: randomUUID(), includeSample: false }), '--request-id', randomUUID()));
    const after = JSON.parse((await c.run('workspace', 'list')).stdout) as { items: { id: string }[] };
    assert.deepEqual(after.items.map(item => item.id).sort(), before.items.map(item => item.id).sort());
    const identity = JSON.parse((await c.run('workspace', 'identity')).stdout) as { version: number; icon: string; color: string };
    await c.command('workspace', 'update', { targetId: f.workspaceId, expectedVersions: { [f.workspaceId]: identity.version }, payload: { name: 'CLI identity saved', icon: identity.icon, color: identity.color } });
    assert.equal(JSON.parse((await c.run('workspace', 'identity')).stdout).name, 'CLI identity saved');
  });

  it('uses native membership CAS and workload, never grants access through a team, and reauthorizes saved tool results', async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const c = await cli(t, f);
    const first = await f.command<Entity>('CreateProject', { name: 'Member scope', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const hidden = await f.command<Entity>('CreateProject', { name: 'No team grant', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const member = await f.member('Scoped CLI member');
    const granted = await c.command<Membership>('members', 'role', { targetId: member.user.id, payload: { userId: member.user.id, role: 'guest', projectIds: [first.id] } });
    const team = await c.command<{ id: string; version: number }>('teams', 'create', { payload: { name: 'Organization only', memberIds: [member.user.id], maintainerIds: [member.user.id], identifier: null, description: '', focus: null, responseTargetHours: null } });
    await c.command('teams', 'projects', { targetId: hidden.id, projectId: hidden.id, expectedVersions: { [hidden.id]: hidden.version, [team.result.id]: team.result.version }, payload: { teamIds: [team.result.id] } });
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/entities/${hidden.id}`, { cookie: member.cookie })).status, 404, 'Organization links never confer project permission');
    await c.command('capacity', 'set', { payload: { userId: member.user.id, capacityPoints: 2 } });
    const task = await f.request(`/api/v1/workspaces/${f.workspaceId}/core/entities`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { entity: 'work_item', title: 'Native estimate', project: first.id, assignee: member.user.id, 'x-pm-estimate': 3 } });
    assert.equal(task.status, 200, JSON.stringify(task.body));
    const workload = JSON.parse((await c.run('workload', 'get')).stdout) as TeamWorkload;
    const load = workload.members.find(item => item.userId === member.user.id)!;
    assert.equal(load.knownOpenPoints, 3); assert.equal(load.capacityPoints, 2); assert.equal(load.overloaded, true);
    assert.ok(load.capacity);
    const adjusted = await c.call('pm_set_member_capacity', { workspaceId: f.workspaceId, targetId: load.capacity.id, expectedVersions: { [load.capacity.id]: load.capacity.version }, payload: { userId: member.user.id, capacityPoints: 5 } });
    assert.equal(adjusted.result.status, 'succeeded', JSON.stringify(adjusted.result));
    const currentLoad = JSON.parse((await c.run('workload', 'get')).stdout) as TeamWorkload;
    assert.equal(currentLoad.members.find(item => item.userId === member.user.id)?.overloaded, false);
    const originalTeam = await c.call('pm_create_team', { workspaceId: f.workspaceId, expectedVersions: {}, payload: { name: 'Original tool organization', memberIds: [member.user.id], maintainerIds: [], identifier: null, description: '', focus: null, responseTargetHours: null } });
    assert.equal(originalTeam.result.status, 'succeeded', JSON.stringify(originalTeam.result));
    assert.ok(originalTeam.result.result?.kind === 'administration_command');
    const originalTeamId = originalTeam.result.result.items[0]!.id;
    await f.pool.query(`UPDATE pm_agent_tool_operations SET status='unknown',result=NULL,finished_at=NULL WHERE operation_id=$1`, [originalTeam.operation.operationId]);
    const recoveredTeam = JSON.parse((await c.run('plugin', 'result', '--file', originalTeam.filename)).stdout) as PmToolCallRecord;
    assert.equal(recoveredTeam.status, 'succeeded', JSON.stringify(recoveredTeam));
    assert.ok(recoveredTeam.result?.kind === 'administration_command');
    assert.equal(recoveredTeam.result.items[0]!.id, originalTeamId);
    assert.equal((await f.pool.query(`SELECT 1 FROM dashboard_records WHERE workspace_id=$1 AND kind='project_team' AND data->>'name'='Original tool organization'`, [f.workspaceId])).rowCount, 1);
    assert.equal((await f.pool.query('SELECT 1 FROM command_receipts WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3', [f.workspaceId, f.owner.id, originalTeam.operation.operationId])).rowCount, 1);
    const manager = await f.member('Access-only organization manager');
    await f.command('SetWorkspaceMember', { userId: manager.user.id, capabilities: ['access.manage'], projectIds: null });
    const ownerToken = c.env.PM_SESSION_TOKEN;
    c.env.PM_SESSION_TOKEN = manager.cookie.slice(manager.cookie.indexOf('=') + 1);
    try {
      const organization = await c.call('pm_read_teams', { workspaceId: f.workspaceId, after: null, limit: 50 });
      assert.equal(organization.result.status, 'succeeded', JSON.stringify(organization.result));
      assert.ok(organization.result.result?.kind === 'administration_teams');
      assert.ok(organization.result.result.items.some(item => item.id === originalTeamId));
    } finally { c.env.PM_SESSION_TOKEN = ownerToken; }
    const saved = await c.call('pm_read_members', { workspaceId: f.workspaceId, after: null, limit: 50 }, first.id);
    assert.equal(saved.result.status, 'succeeded', JSON.stringify(saved.result));
    const scopedEnv = { ...c.env, PM_SESSION_TOKEN: member.cookie.slice(member.cookie.indexOf('=') + 1) };
    const ownRead = { name: 'pm_read_members', arguments: { workspaceId: f.workspaceId, after: null, limit: 50 }, target: { workspaceId: f.workspaceId, projectId: first.id }, operationId: randomUUID() };
    const ownFile = await c.input(ownRead);
    const own = await execute(process.execPath, [entry, 'plugin', 'call', '--file', ownFile], { env: scopedEnv, signal: t.signal, timeout: 30_000 });
    const ownResult = JSON.parse(own.stdout) as PmToolCallRecord;
    assert.equal(ownResult.status, 'succeeded');
    assert.ok(ownResult.result?.kind === 'administration_members');
    assert.ok(ownResult.result.items.some(item => item.userId === member.user.id));
    await c.command('members', 'revoke', { targetId: member.user.id, expectedVersions: { [member.user.id]: granted.result.version }, payload: { userId: member.user.id } });
    // Result retrieval reports revoked visibility, not a transport exception or a changed business outcome.
    const redacted = JSON.parse((await execute(process.execPath, [entry, 'plugin', 'result', '--file', ownFile], { env: scopedEnv, signal: t.signal, timeout: 30_000 })).stdout) as Record<string, unknown>;
    assert.equal(redacted.operationId, ownRead.operationId);
    assert.equal(redacted.visibility, 'redacted');
    for (const field of ['name', 'status', 'result', 'error', 'arguments', 'workspaceId', 'target', 'actorId']) assert.equal(Object.hasOwn(redacted, field), false, `Revoked result must omit ${field}`);
    const deniedResult = await f.request(`/api/v1/workspaces/${f.workspaceId}/agent-tools/result`, { method: 'POST', cookie: member.cookie, body: { ...ownRead, executionRoot: 'external' } });
    assert.equal(deniedResult.status, 404, 'The native saved-result route rechecks current membership');
    const evidence = (await f.pool.query<{ status: string; result: unknown }>('SELECT status,result FROM pm_agent_tool_operations WHERE operation_id=$1', [ownRead.operationId])).rows[0];
    assert.equal(evidence?.status, 'succeeded', 'Delivery denial must not rewrite the original business outcome');
    assert.deepEqual(evidence?.result, ownResult.result);
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/entities/${first.id}`, { cookie: member.cookie })).status, 404);
    await rejected(c.command('members', 'role', { targetId: member.user.id, expectedVersions: { [member.user.id]: granted.result.version }, payload: { userId: member.user.id, role: 'guest', projectIds: [first.id] } }));
  });

  it('persists personal favorites/scope and recovers only the original project copy after a dropped response', async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const c = await cli(t, f);
    const source = await f.command<Entity>('CreateProject', { name: 'CLI copy source', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const other = await f.command<Entity>('CreateProject', { name: 'Second ordering target', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    await c.command('project', 'favorite', { targetId: source.id, projectId: source.id, expectedVersions: { [source.id]: source.version }, payload: { favorite: true } });
    await c.command('project', 'order', { payload: { projectIds: [other.id, source.id] } });
    const scopeId = randomUUID();
    await c.command('project', 'scope', { targetId: source.id, projectId: source.id, expectedVersions: { [source.id]: source.version }, payload: { items: [{ id: scopeId, text: 'Human scope checkpoint', completed: false }] } });
    const extras = JSON.parse((await c.run('project', 'extras')).stdout) as ProjectExtras;
    assert.equal(extras.projects.find(item => item.projectId === source.id)?.favorite?.data.favorite, true);
    assert.equal(extras.projects.find(item => item.projectId === source.id)?.scope?.data.items[0]?.id, scopeId);
    assert.deepEqual(extras.sidebarOrder?.data.projectIds.slice(0, 2), [other.id, source.id]);
    const second = await f.member('Independent favorites');
    await f.command('SetWorkspaceMember', { userId: second.user.id, capabilities: ['domain.read'], projectIds: null });
    const secondExtras = await f.request<ProjectExtras>(`/api/v1/workspaces/${f.workspaceId}/projects/extras`, { cookie: second.cookie });
    assert.equal(secondExtras.body.projects.find(item => item.projectId === source.id)?.favorite, null);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6QWQAAAAASUVORK5CYII=';
    const staged = await f.command<{ upload: Entity }>('StageUpload', { contentBase64: png, fileName: 'cover.png', mediaType: 'image/png' }, { extra: { projectId: source.id } });
    const artifact = await f.command<{ artifactVersion: Entity }>('RegisterArtifact', { title: 'Immutable raster cover', kind: 'image', uploadId: staged.upload.id }, { extra: { projectId: source.id, expectedVersions: { [staged.upload.id]: staged.upload.version } } });
    await c.command('project', 'cover', { targetId: source.id, projectId: source.id, expectedVersions: { [source.id]: source.version }, payload: { artifactVersionId: artifact.artifactVersion.id } });
    const covered = JSON.parse((await c.run('project', 'extras')).stdout) as ProjectExtras;
    assert.equal(covered.projects.find(item => item.projectId === source.id)?.cover?.data.artifactVersionId, artifact.artifactVersion.id);
    await rejected(c.command('project', 'cover', { targetId: other.id, projectId: other.id, expectedVersions: { [other.id]: other.version }, payload: { artifactVersionId: artifact.artifactVersion.id } }));
    const proxy = await droppingProxy(t, f.origin, `/api/v1/workspaces/${f.workspaceId}/commands`);
    c.env.PM_API_URL = proxy.origin;
    const id = randomUUID(), copyFile = await c.input({ targetId: source.id, projectId: source.id, expectedVersions: { [source.id]: source.version }, payload: { name: 'Original copy result', includeTasks: true } });
    await rejected(c.run('project', 'copy', '--file', copyFile, '--command-id', id, '--expected-actor', f.owner.id));
    const receipt = JSON.parse((await c.run('project', 'copy-status', id)).stdout) as CommandReceipt & { result: { id: string } };
    assert.equal(receipt.status, 'committed'); assert.notEqual(receipt.result.id, source.id);
    assert.equal(proxy.calls.filter(call => call.method === 'POST' && call.url.endsWith('/commands')).length, 1);
    const visible = await f.request<{ items: Entity[] }>(`/api/v1/workspaces/${f.workspaceId}/entities?kind=project`);
    assert.equal(visible.body.items.filter(item => item.data.name === 'Original copy result').length, 1);
    await rejected(c.run('project', 'copy-recover', id, '--expected-actor', randomUUID()));
    assert.equal(proxy.calls.filter(call => call.method === 'POST' && call.url.endsWith('/recover')).length, 0, 'Changed actor never sends a recovery write');
  });

  it('changes passwords privately, actually revokes old sessions and exposes only safe action receipts', async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const c = await cli(t, f);
    const oldPassword = 'isolated-dashboard-test-password', newPassword = `isolated-new-${randomUUID()}`;
    const login = await f.request('/api/v1/auth/login', { method: 'POST', cookie: '', body: { email: f.owner.email, password: oldPassword } });
    const oldCookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const security = JSON.parse((await c.run('account', 'security')).stdout) as AccountSecurity;
    const actionId = randomUUID();
    const filename = await c.input({ actionId, expectedCredentialVersion: security.credentialVersion, currentPassword: oldPassword, newPassword });
    const changed = await c.run('account', 'password', '--private-file', filename);
    for (const secret of [oldPassword, newPassword]) assert.equal(changed.stdout.includes(secret), false);
    const action = JSON.parse(changed.stdout) as AccountSecurityAction;
    assert.equal(action.status, 'committed');
    assert.equal((await f.request('/api/v1/auth/me', { cookie: oldCookie })).status, 401);
    assert.equal((await f.request('/api/v1/auth/me')).status, 200, 'The current CLI session is retained by the native password policy');
    const current = JSON.parse((await c.run('account', 'action', actionId)).stdout) as { action: AccountSecurityAction };
    assert.equal(current.action.actionId, actionId);
    const nextLogin = await f.request('/api/v1/auth/login', { method: 'POST', cookie: '', body: { email: f.owner.email, password: newPassword } });
    const nextCookie = nextLogin.headers.get('set-cookie')!.split(';')[0]!;
    const updated = JSON.parse((await c.run('account', 'security')).stdout) as AccountSecurity;
    await c.run('account', 'sessions-revoke', '--file', await c.input({ actionId: randomUUID(), expectedCredentialVersion: updated.credentialVersion, sessionId: 'others' }));
    assert.equal((await f.request('/api/v1/auth/me', { cookie: nextCookie })).status, 401);
    await chmod(filename, 0o644);
    await rejected(c.run('account', 'password', '--private-file', filename), [oldPassword, newPassword]);
    await rejected(c.run('account', 'password', '--new-password', newPassword), [newPassword]);
  });

  it('preflights server directories, retains the original local initialization and rejects unsafe paths/changed actors', async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const c = await cli(t, f);
    const directory = { mode: 'new', parentPath: f.parents[0], folderName: 'cli-owned-project' };
    const preview = await c.run('directories', 'preview', '--file', await c.input({ directory }));
    assert.equal(JSON.parse(preview.stdout).preservesExistingFiles, true);
    const id = randomUUID(), filename = await c.input({ input: { entity: 'project', title: 'Original local CLI project' }, directory });
    const proxy = await droppingProxy(t, f.origin, `/api/v1/workspaces/${f.workspaceId}/local-projects/initializations`);
    c.env.PM_API_URL = proxy.origin;
    await rejected(c.run('directories', 'initialize', '--file', filename, '--request-id', id, '--expected-actor', f.owner.id));
    const attempt = JSON.parse((await c.run('directories', 'initialization-status', id)).stdout) as LocalProjectAttempt;
    assert.equal(attempt.status, 'ready'); assert.ok(attempt.status === 'ready');
    const recovered = JSON.parse((await c.run('directories', 'initialization-recover', id, '--expected-actor', f.owner.id)).stdout) as LocalProjectAttempt;
    assert.ok(recovered.status === 'ready'); assert.equal(recovered.record.id, attempt.record.id);
    assert.equal(proxy.calls.filter(call => call.method === 'POST' && call.url.endsWith('/initializations')).length, 1);
    const location = JSON.parse((await c.run('directories', 'location', attempt.record.id)).stdout) as { storageId: string; path: string };
    assert.ok(location.storageId); assert.equal(location.path, path.join(f.parents[0], 'cli-owned-project'));
    await rejected(c.run('directories', 'initialize', '--file', filename, '--request-id', randomUUID(), '--expected-actor', randomUUID()));
    assert.equal(proxy.calls.filter(call => call.method === 'POST' && call.url.endsWith('/initializations')).length, 1);
    await symlink('/etc', path.join(f.parents[0], 'outside-link'));
    await rejected(c.run('directories', 'preview', '--file', await c.input({ directory: { mode: 'existing', path: path.join(f.parents[0], 'outside-link') } })));
    await rejected(c.run('directories', 'probe', '--file', await c.input({ path: '/etc' })));
  });
});
