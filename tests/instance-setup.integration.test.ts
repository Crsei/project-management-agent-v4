import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildApp } from '../apps/server/pm/src/app.ts';
import { CAPABILITIES } from '../packages/domain/src/core.ts';
import { ProjectManagementClient } from '../packages/contracts/src/client.ts';
import type { SetupRequest, SetupResponse } from '../packages/contracts/src/instance-setup.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { getInstanceSetupStatus, prepareInstanceSetup } from '../packages/infrastructure/src/instance-setup.ts';
import { readCurrentCore } from '../packages/pm-core/readonly.ts';
import { FileRepository } from '../packages/pm-core/repository.ts';
import { acquireMailFixtureDatabase, createMailFixtureDatabase, mailTestDatabaseUrl, type MailFixtureDatabase } from './mail-fixture-database.ts';
import { closeMailApp, MailFixtureScope, mailFixtureCaseTimeout, mailFixtureCleanupTimeout, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';

const password = 'isolated-instance-setup-password';
const state = (initialized: boolean, setupAllowed: boolean) => ({ initialized, setupAllowed, registrationMode: 'invite_only' });
const token = () => randomBytes(32).toString('base64url');
const input = (setupToken: string, email = `${randomUUID()}@example.test`): SetupRequest => ({ setupToken, email, password, name: 'First owner', workspaceName: 'First workspace' });

async function fixture(database: MailFixtureDatabase, signal: AbortSignal) {
  const scope = new MailFixtureScope(signal);
  return scope.initialize(async () => {
    const { pool, databaseUrl } = await acquireMailFixtureDatabase(scope, database);
    const root = await scope.acquire(() => mkdtemp(join(tmpdir(), 'pm-instance-setup-')), owned => rm(owned, { recursive: true, force: true }));
    async function startApp() {
      const app = scope.own(buildApp({ databaseUrl, coreWorkspaceRoot: root, signal: scope.signal, cookieSecure: true }), closeMailApp);
      const origin = await scope.step(() => app.listen({ host: '127.0.0.1', port: 0 }));
      return { app, origin };
    }
    const { app, origin } = await startApp();
    async function request<T = any>(path: string, body?: unknown, headers: Record<string, string> = {}, base = origin) {
      const response = await fetch(`${base}${path}`, { signal: scope.signal, method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, body: await response.json() as T };
    }
    async function counts() {
      return (await pool.query(`SELECT (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM workspaces) AS workspaces,(SELECT count(*)::int FROM memberships) AS memberships`)).rows[0];
    }
    return { pool, app, origin, root, startApp, request, counts, close: scope.close };
  });
}

// Reuses the real migrated, empty, privately owned schema; no production tables,
// deployment credentials or running service are involved in these cases.
describe('first-use setup: real PostgreSQL and HTTP', { skip: !mailTestDatabaseUrl, concurrency: false }, () => {
  let database: MailFixtureDatabase;
  before(async t => { database = await createMailFixtureDatabase({ signal: t.signal }); }, { timeout: mailSchemaInitTimeout });
  after(() => database?.close(), { timeout: mailFixtureCleanupTimeout });

  it('requires deployment preparation, stores only a digest, and resumes only the same pending token', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const candidate = token();
    const initial = await f.request('/api/v1/setup/status');
    assert.equal(initial.status, 200); assert.deepEqual(initial.body, state(false, false));
    assert.equal(initial.headers.get('cache-control'), 'no-store'); assert.equal(initial.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await f.request('/api/v1/setup', input(candidate))).status, 403);
    assert.deepEqual(await f.counts(), { users: 0, workspaces: 0, memberships: 0 });
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM instance_setup')).rows[0].n, 0);
    assert.deepEqual(await prepareInstanceSetup(f.pool, candidate), state(false, true));
    const prepared = (await f.pool.query('SELECT * FROM instance_setup')).rows;
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].token_hash, createHash('sha256').update(candidate).digest('hex'));
    assert.ok(!JSON.stringify(prepared).includes(candidate));
    assert.deepEqual(await prepareInstanceSetup(f.pool, candidate), state(false, true));
    await assert.rejects(prepareInstanceSetup(f.pool, token()), { code: 'setup_token_conflict', status: 409 });
    assert.deepEqual((await f.pool.query('SELECT * FROM instance_setup')).rows, prepared);
    await assert.rejects(prepareInstanceSetup(f.pool, 'weak'));
    await assert.rejects(f.pool.query('INSERT INTO instance_setup(singleton,token_hash) VALUES(false,$1)', ['a'.repeat(64)]), { code: '23514' });
    await assert.rejects(f.pool.query('INSERT INTO instance_setup(singleton,token_hash) VALUES(true,$1)', ['b'.repeat(64)]), { code: '23505' });
  });

  it('creates one explicit authorized owner and an ordinary secure Cookie session without exposing secrets', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const candidate = token(), body = input(candidate, 'Initial.Owner@example.test');
    await prepareInstanceSetup(f.pool, candidate);
    const response = await f.request<SetupResponse>('/api/v1/setup', body);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body).sort(), ['actor', 'expiresAt', 'workspaceId']);
    assert.equal(response.body.actor.email, body.email.toLowerCase());
    assert.equal(response.body.actor.name, body.name);
    assert.ok(!JSON.stringify(response.body).includes(candidate)); assert.ok(!JSON.stringify(response.body).includes(password));
    const setCookie = response.headers.get('set-cookie')!;
    for (const expected of ['pm_v4_session=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Expires=']) assert.ok(setCookie.includes(expected));
    const cookie = setCookie.split(';')[0]!;
    const current = await f.request('/api/v1/auth/me', undefined, { cookie });
    assert.equal(current.status, 200); assert.deepEqual(current.body.actor, response.body.actor);
    const workspaces = await f.request('/api/v1/workspaces', undefined, { cookie });
    assert.equal(workspaces.status, 200); assert.equal(workspaces.body.items.length, 1);
    assert.equal(workspaces.body.items[0].id, response.body.workspaceId);
    const core = await f.request(`/api/v1/workspaces/${response.body.workspaceId}/core/workspace`, undefined, { cookie });
    assert.equal(core.status, 200); assert.equal(core.body.files.length, 27);
    assert.equal(core.body.files.filter((file: { entity: { entity: string } }) => file.entity.entity === 'work_item').length, 8);
    const membership = (await f.pool.query('SELECT * FROM memberships')).rows[0];
    assert.equal(membership.user_id, response.body.actor.id); assert.equal(membership.workspace_id, response.body.workspaceId);
    assert.deepEqual([...membership.capabilities].sort(), [...CAPABILITIES].sort()); assert.equal(membership.project_ids, null);
    const setup = (await f.pool.query('SELECT * FROM instance_setup')).rows[0];
    assert.equal(setup.token_hash, null); assert.ok(setup.completed_at);
    assert.deepEqual((await f.request('/api/v1/setup/status')).body, state(true, false));
    assert.equal((await f.request('/api/v1/setup', body)).status, 409);
    assert.deepEqual(await prepareInstanceSetup(f.pool, token()), state(true, false));
    const stored = (await f.pool.query('SELECT password_hash FROM users')).rows[0].password_hash;
    assert.ok(stored.startsWith('scrypt$')); assert.ok(!stored.includes(password));
    assert.equal((await f.request('/api/v1/auth/login', { email: body.email, password })).status, 200);
    // Owner_id does not grant authority: the ordinary membership check is still required.
    await f.pool.query('UPDATE memberships SET revoked_at=clock_timestamp()');
    assert.deepEqual((await f.request('/api/v1/workspaces', undefined, { cookie })).body.items, []);
    assert.equal((await f.request(`/api/v1/workspaces/${response.body.workspaceId}/members`, undefined, { cookie })).status, 404);
  });

  it('rejects wrong tokens, short passwords, extra fields and secret-bearing queries before any identity write', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const candidate = token(); await prepareInstanceSetup(f.pool, candidate);
    const wrong = await f.request('/api/v1/setup', input(token()));
    assert.equal(wrong.status, 403); assert.equal(wrong.body.error.code, 'setup_token_invalid');
    for (const body of [{ ...input(candidate), password: 'short' }, { ...input(candidate), setupToken: 'bad' }, { ...input(candidate), owner: true }]) assert.equal((await f.request('/api/v1/setup', body)).status, 400);
    assert.equal((await f.request(`/api/v1/setup?setupToken=${candidate}`, input(candidate))).status, 400);
    assert.equal((await f.request(`/api/v1/setup/status?setupToken=${candidate}`)).status, 400);
    const blocked = await f.request('/api/v1/setup', input(candidate), { origin: 'https://evil.example' });
    assert.equal(blocked.status, 403);
    assert.equal((await f.request('/api/v1/setup', input(candidate), { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.deepEqual(await f.counts(), { users: 0, workspaces: 0, memberships: 0 });
    assert.deepEqual(await getInstanceSetupStatus(f.pool), state(false, true));
  });

  it('allows exactly one claim across concurrent independent HTTP app instances', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const candidate = token(); await Promise.all([prepareInstanceSetup(f.pool, candidate), prepareInstanceSetup(f.pool, candidate)]);
    const second = await f.startApp();
    const bodies = [input(candidate), input(candidate)];
    const results = await Promise.all(bodies.map((body, index) => f.request('/api/v1/setup', body, {}, index ? second.origin : f.origin)));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const winner = results.findIndex(result => result.status === 200);
    assert.equal(results[winner]!.body.actor.email, bodies[winner]!.email);
    assert.deepEqual(await f.counts(), { users: 1, workspaces: 1, memberships: 1 });
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM instance_setup')).rows[0].n, 1);
    assert.equal((await f.request('/api/v1/auth/login', { email: bodies[1 - winner]!.email, password })).status, 401);
  });

  it('closes setup for an old user without a workspace and never modifies its password', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const user = await createUser(f.pool, { email: 'legacy-only@example.test', name: 'Legacy', password });
    const before = (await f.pool.query('SELECT * FROM users')).rows;
    assert.deepEqual((await f.request('/api/v1/setup/status')).body, state(true, false));
    assert.deepEqual(await prepareInstanceSetup(f.pool, token()), state(true, false));
    assert.equal((await f.request('/api/v1/setup', input(token()))).status, 409);
    assert.deepEqual((await f.pool.query('SELECT * FROM users')).rows, before);
    assert.deepEqual(await f.counts(), { users: 1, workspaces: 0, memberships: 0 });
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM instance_setup')).rows[0].n, 0);
    assert.equal((await f.request('/api/v1/auth/login', { email: user.email, password })).status, 200);
  });

  it('preserves old workspace/member IDs and credentials even when a pending token predates them', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const candidate = token(); await prepareInstanceSetup(f.pool, candidate);
    const user = await createUser(f.pool, { email: 'legacy-workspace@example.test', name: 'Legacy owner', password });
    const workspace = await createWorkspace(f.pool, user.id, 'Existing workspace');
    const before = await Promise.all(['users', 'workspaces', 'memberships', 'instance_setup'].map(table => f.pool.query(`SELECT * FROM ${table}`)));
    assert.deepEqual(await prepareInstanceSetup(f.pool, candidate), state(true, false));
    assert.equal((await f.request('/api/v1/setup', input(candidate))).status, 409);
    const after = await Promise.all(['users', 'workspaces', 'memberships', 'instance_setup'].map(table => f.pool.query(`SELECT * FROM ${table}`)));
    assert.deepEqual(after.map(result => result.rows), before.map(result => result.rows));
    assert.equal(after[1]!.rows[0].id, workspace.id);
    assert.equal((await f.request('/api/v1/auth/login', { email: user.email, password })).status, 200);
  });

  it('treats a workspace-only inconsistent legacy database as occupied rather than claimable', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    // Only this owned fixture schema is deliberately made inconsistent. Restore
    // the real FK before releasing it to the next test case.
    await f.pool.query('ALTER TABLE workspaces DROP CONSTRAINT workspaces_owner_id_fkey');
    try {
      await f.pool.query('INSERT INTO workspaces(id,name,owner_id) VALUES($1,$2,$3)', [randomUUID(), 'Orphaned legacy workspace', randomUUID()]);
      assert.deepEqual((await f.request('/api/v1/setup/status')).body, state(true, false));
      assert.deepEqual(await prepareInstanceSetup(f.pool, token()), state(true, false));
      assert.equal((await f.request('/api/v1/setup', input(token()))).status, 409);
      assert.deepEqual(await f.counts(), { users: 0, workspaces: 1, memberships: 0 });
    } finally {
      await f.pool.query('DELETE FROM workspaces');
      await f.pool.query('ALTER TABLE workspaces ADD CONSTRAINT workspaces_owner_id_fkey FOREIGN KEY(owner_id) REFERENCES users(id)');
    }
  });

  it('rolls back every identity and completion write if membership creation fails', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const candidate = token(); await prepareInstanceSetup(f.pool, candidate);
    await f.pool.query("CREATE FUNCTION fail_setup_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected membership failure'; END $$");
    await f.pool.query('CREATE TRIGGER fail_setup_member BEFORE INSERT ON memberships FOR EACH ROW EXECUTE FUNCTION fail_setup_member()');
    try {
      assert.equal((await f.request('/api/v1/setup', input(candidate))).status, 503);
      assert.deepEqual(await f.counts(), { users: 0, workspaces: 0, memberships: 0 });
      assert.deepEqual(await getInstanceSetupStatus(f.pool), state(false, true));
      assert.equal((await f.pool.query('SELECT token_hash FROM instance_setup')).rows[0].token_hash, createHash('sha256').update(candidate).digest('hex'));
    } finally {
      await f.pool.query('DROP TRIGGER fail_setup_member ON memberships'); await f.pool.query('DROP FUNCTION fail_setup_member()');
    }
    assert.equal((await f.request('/api/v1/setup', input(candidate))).status, 200);
  });

  it('keeps committed identities closed after session creation fails and recovers through normal password login', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const candidate = token(), body = input(candidate); await prepareInstanceSetup(f.pool, candidate);
    await f.pool.query("CREATE FUNCTION fail_setup_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected session failure'; END $$");
    await f.pool.query('CREATE TRIGGER fail_setup_session BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION fail_setup_session()');
    try {
      const failed = await f.request('/api/v1/setup', body);
      assert.equal(failed.status, 503); assert.equal(failed.headers.has('set-cookie'), false);
      assert.deepEqual(await f.counts(), { users: 1, workspaces: 1, memberships: 1 });
      assert.deepEqual((await f.request('/api/v1/setup/status')).body, state(true, false));
      assert.equal((await f.request('/api/v1/setup', body)).status, 409);
    } finally {
      await f.pool.query('DROP TRIGGER fail_setup_session ON sessions'); await f.pool.query('DROP FUNCTION fail_setup_session()');
    }
    assert.equal((await f.request('/api/v1/auth/login', { email: body.email, password })).status, 200);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 1);
  });

  it('retains interrupted Nova content, rejects an external edit and resumes original initialization through ordinary login', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const candidate = token(), body = input(candidate); await prepareInstanceSetup(f.pool, candidate);
    await f.pool.query("CREATE FUNCTION fail_nova_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected sample completion failure'; END $$");
    await f.pool.query("CREATE TRIGGER fail_nova_completion BEFORE UPDATE ON workspace_sample_initializations FOR EACH ROW WHEN (NEW.status='ready') EXECUTE FUNCTION fail_nova_completion()");
    let workspaceId = '';
    let original: { id: string; raw: string }[] = [];
    let pendingFile: { path: string; raw: string } | undefined;
    try {
      const failed = await f.request('/api/v1/setup', body);
      assert.equal(failed.status, 503); assert.equal(failed.headers.has('set-cookie'), false);
      assert.deepEqual(await f.counts(), { users: 1, workspaces: 1, memberships: 1 });
      assert.deepEqual((await f.request('/api/v1/setup/status')).body, state(true, false));
      workspaceId = (await f.pool.query('SELECT workspace_id FROM workspace_sample_initializations')).rows[0].workspace_id;
      const pendingSources = readCurrentCore(join(f.root, workspaceId)).files;
      original = pendingSources.map(file => ({ id: file.id, raw: file.raw })).sort((a, b) => a.id.localeCompare(b.id));
      const task = pendingSources.find(file => file.entity.entity === 'work_item');
      assert.ok(task);
      pendingFile = { path: join(f.root, workspaceId, task.path), raw: task.raw };
      assert.equal(original.length, 27);
      assert.equal((await f.request('/api/v1/setup', body)).status, 409);
    } finally {
      await f.pool.query('DROP TRIGGER fail_nova_completion ON workspace_sample_initializations');
      await f.pool.query('DROP FUNCTION fail_nova_completion()');
    }
    assert.ok(pendingFile);
    const external = `${pendingFile.raw}\nAn actual external edit while initialization is pending.\n`;
    await writeFile(pendingFile.path, external);
    const loggedIn = await f.request('/api/v1/auth/login', { email: body.email, password });
    assert.equal(loggedIn.status, 200);
    const cookie = loggedIn.headers.get('set-cookie')!.split(';')[0]!;
    const conflicted = await f.request('/api/v1/workspaces', undefined, { cookie });
    assert.equal(conflicted.status, 200);
    assert.deepEqual(conflicted.body.items, []);
    assert.deepEqual(conflicted.body.pendingInitializations, [{ workspaceId, name: body.workspaceName, key: null }]);
    assert.equal(await readFile(pendingFile.path, 'utf8'), external, 'Recovery must not overwrite an externally changed pending object');
    assert.equal((await f.pool.query('SELECT status FROM workspace_sample_initializations')).rows[0].status, 'pending');
    // Only this owned fixture restores the original intended bytes. The product
    // rejects the conflict above and never performs this external edit rollback.
    await writeFile(pendingFile.path, pendingFile.raw);
    assert.equal((await f.request('/api/v1/workspaces', undefined, { cookie })).status, 200);
    const recovered = readCurrentCore(join(f.root, workspaceId)).files.map(file => ({ id: file.id, raw: file.raw })).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(recovered, original);
    assert.equal((await f.pool.query('SELECT status FROM workspace_sample_initializations')).rows[0].status, 'ready');
    assert.deepEqual(await f.counts(), { users: 1, workspaces: 1, memberships: 1 });
  });

  it('recovers the original workspace key after interruption before first state, but rejects a replaced claimed root', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const user = await createUser(f.pool, { email: 'prestate-owner@example.test', name: 'Owner', password });
    const login = await f.request('/api/v1/auth/login', { email: user.email, password });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const key = randomUUID(), name = 'Original interrupted workspace';
    const write = FileRepository.prototype.write;
    let interruptions = 0;
    const fault = t.mock.method(FileRepository.prototype, 'write', function (this: FileRepository, relative: string, raw: string, revision?: string) {
      if (this.root.startsWith(`${f.root}${sep}`) && relative === '.pm/state/state.json') {
        interruptions++;
        throw new Error('Injected interruption before first state persistence');
      }
      return write.call(this, relative, raw, revision);
    });
    try {
      const failed = await f.request('/api/v1/workspaces', { name, expectedActorId: user.id }, { cookie, 'Idempotency-Key': key });
      assert.equal(failed.status, 503);
      assert.equal(failed.body.error.code, 'workspace_initialization_pending');
    } finally { fault.mock.restore(); }
    assert.equal(interruptions, 1);
    const row = (await f.pool.query('SELECT * FROM workspace_sample_initializations')).rows[0];
    assert.equal(row.core_initialization_phase, 'prestate');
    assert.equal(row.status, 'pending'); assert.equal(row.project_id, null);
    const root = join(f.root, row.workspace_id), originalRoot = `${root}-owned`;
    await assert.rejects(readFile(join(root, '.pm/state/state.json')), { code: 'ENOENT' });
    assert.deepEqual((await f.request(`/api/v1/workspace-creations/${key}`, undefined, { cookie })).body, { status: 'pending', key, workspaceId: row.workspace_id });
    assert.equal((await f.request(`/api/v1/workspaces/${row.workspace_id}/core/workspace`, undefined, { cookie })).status, 503);
    assert.deepEqual((await f.request('/api/v1/setup/status')).body, state(true, false));
    await rename(root, originalRoot);
    await mkdir(root);
    try {
      assert.equal((await f.request(`/api/v1/workspace-creations/${key}/recover`, { expectedActorId: user.id }, { cookie })).status, 503);
      assert.deepEqual(await readdir(root), [], 'Recovery must not initialize or remove the replacement empty root');
      assert.deepEqual((await f.pool.query('SELECT core_root_identity FROM workspace_sample_initializations')).rows[0].core_root_identity, row.core_root_identity);
    } finally { await rm(root, { recursive: true }); await rename(originalRoot, root); }
    const recovered = await f.request(`/api/v1/workspace-creations/${key}/recover`, { expectedActorId: user.id }, { cookie });
    assert.equal(recovered.status, 200); assert.equal(recovered.body.status, 'ready');
    assert.equal(recovered.body.workspaceId, row.workspace_id);
    const snapshot = await f.request(`/api/v1/workspaces/${row.workspace_id}/core/workspace`, undefined, { cookie });
    assert.equal(snapshot.status, 200); assert.equal(snapshot.body.files.length, 27);
    assert.equal(new Set(snapshot.body.files.map((file: { id: string }) => file.id)).size, 27);
    assert.deepEqual((await f.request('/api/v1/workspaces', { name, expectedActorId: user.id }, { cookie, 'Idempotency-Key': key })).body, recovered.body);
    assert.deepEqual((await f.pool.query('SELECT status,core_initialization_phase FROM workspace_sample_initializations')).rows, [{ status: 'ready', core_initialization_phase: 'established' }]);
    assert.deepEqual(await f.counts(), { users: 1, workspaces: 1, memberships: 1 });
  });

  it('never adopts an empty unproven root after the ownership transaction fails', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const candidate = token(); await prepareInstanceSetup(f.pool, candidate);
    await f.pool.query("CREATE FUNCTION fail_nova_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected ownership persistence failure'; END $$");
    await f.pool.query("CREATE TRIGGER fail_nova_claim BEFORE UPDATE ON workspace_sample_initializations FOR EACH ROW WHEN (NEW.core_initialization_phase='prestate') EXECUTE FUNCTION fail_nova_claim()");
    try {
      assert.equal((await f.request('/api/v1/setup', input(candidate, 'unproven-owner@example.test'))).status, 503);
    } finally {
      await f.pool.query('DROP TRIGGER fail_nova_claim ON workspace_sample_initializations');
      await f.pool.query('DROP FUNCTION fail_nova_claim()');
    }
    const row = (await f.pool.query('SELECT * FROM workspace_sample_initializations')).rows[0];
    assert.equal(row.core_initialization_phase, 'unclaimed'); assert.equal(row.core_root_identity, null);
    const root = join(f.root, row.workspace_id);
    assert.deepEqual(await readdir(root), []);
    const loggedIn = await f.request('/api/v1/auth/login', { email: 'unproven-owner@example.test', password });
    const cookie = loggedIn.headers.get('set-cookie')!.split(';')[0]!;
    const listing = await f.request('/api/v1/workspaces', undefined, { cookie });
    assert.equal(listing.status, 200); assert.deepEqual(listing.body.items, []);
    assert.deepEqual(listing.body.pendingInitializations, [{ workspaceId: row.workspace_id, name: 'First workspace', key: null }]);
    assert.deepEqual(await readdir(root), [], 'An unproven root must neither be adopted nor deleted');
    await rename(root, `${root}-unproven-owned`);
    await mkdir(root); // A different, unrelated empty directory now occupies the same name.
    assert.deepEqual((await f.request('/api/v1/workspaces', undefined, { cookie })).body, listing.body);
    assert.deepEqual(await readdir(root), [], 'An unrelated empty root must not be initialized or replaced');
    assert.equal((await f.pool.query('SELECT status FROM workspace_sample_initializations')).rows[0].status, 'pending');
    assert.deepEqual((await f.request('/api/v1/setup/status')).body, state(true, false));
  });

  it('never recreates established sample authority when state disappears before SQL completion', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const candidate = token(); await prepareInstanceSetup(f.pool, candidate);
    await f.pool.query("CREATE FUNCTION fail_nova_ready() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected ready persistence failure'; END $$");
    await f.pool.query("CREATE TRIGGER fail_nova_ready BEFORE UPDATE ON workspace_sample_initializations FOR EACH ROW WHEN (NEW.status='ready') EXECUTE FUNCTION fail_nova_ready()");
    try {
      assert.equal((await f.request('/api/v1/setup', input(candidate, 'established-owner@example.test'))).status, 503);
    } finally {
      await f.pool.query('DROP TRIGGER fail_nova_ready ON workspace_sample_initializations');
      await f.pool.query('DROP FUNCTION fail_nova_ready()');
    }
    const row = (await f.pool.query('SELECT * FROM workspace_sample_initializations')).rows[0];
    assert.equal(row.core_initialization_phase, 'established'); assert.equal(row.status, 'pending');
    const root = join(f.root, row.workspace_id);
    const before = readCurrentCore(root).files.map(file => ({ id: file.id, raw: file.raw }));
    assert.equal(before.length, 27);
    await rm(join(root, '.pm/state/state.json'));
    const loggedIn = await f.request('/api/v1/auth/login', { email: 'established-owner@example.test', password });
    const cookie = loggedIn.headers.get('set-cookie')!.split(';')[0]!;
    const listing = await f.request('/api/v1/workspaces', undefined, { cookie });
    assert.equal(listing.status, 200); assert.deepEqual(listing.body.items, []);
    await assert.rejects(readFile(join(root, '.pm/state/state.json')), { code: 'ENOENT' });
    assert.deepEqual(readCurrentCore(root).files.map(file => ({ id: file.id, raw: file.raw })), before);
    assert.deepEqual((await f.pool.query('SELECT status,core_initialization_phase FROM workspace_sample_initializations')).rows, [{ status: 'pending', core_initialization_phase: 'established' }]);
  });

  it('reconciles a lost committed HTTP response without resubmitting or creating another account', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const candidate = token(), body = input(candidate); await prepareInstanceSetup(f.pool, candidate);
    let writes = 0;
    const losing = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'none' }, fetch: async (url, init) => {
      writes++; const response = await fetch(url, init); assert.equal(response.status, 200); await response.arrayBuffer(); throw new TypeError('Injected setup response loss after commit');
    } });
    await assert.rejects(losing.setup(body), /Injected setup response loss/);
    assert.equal(writes, 1);
    const client = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'none' } });
    assert.deepEqual(await client.setupStatus(), state(true, false));
    assert.equal((await f.request('/api/v1/auth/login', { email: body.email, password })).status, 200);
    assert.deepEqual(await f.counts(), { users: 1, workspaces: 1, memberships: 1 });
  });

  it('does not reopen a completed singleton even if all account/workspace data is later removed', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    await f.pool.query('INSERT INTO instance_setup(singleton,token_hash,completed_at) VALUES(true,NULL,clock_timestamp())');
    assert.deepEqual((await f.request('/api/v1/setup/status')).body, state(true, false));
    assert.deepEqual(await prepareInstanceSetup(f.pool, token()), state(true, false));
    assert.equal((await f.request('/api/v1/setup', input(token()))).status, 409);
    assert.deepEqual(await f.counts(), { users: 0, workspaces: 0, memberships: 0 });
  });

  it('returns infrastructure errors, never empty-instance status, for unavailable setup schema', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    await f.pool.query('ALTER TABLE instance_setup RENAME TO instance_setup_unavailable');
    try {
      assert.equal((await f.request('/api/v1/setup/status')).status, 503);
      assert.equal((await f.request('/api/v1/setup', input(token()))).status, 503);
      await assert.rejects(getInstanceSetupStatus(f.pool), { code: '42P01' });
      await assert.rejects(prepareInstanceSetup(f.pool, token()), { code: '42P01' });
      assert.deepEqual(await f.counts(), { users: 0, workspaces: 0, memberships: 0 });
    } finally { await f.pool.query('ALTER TABLE instance_setup_unavailable RENAME TO instance_setup'); }
  });

  it('persists per-source throttling across HTTP app restarts without storing raw bearer keys', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const candidate = token(); await prepareInstanceSetup(f.pool, candidate);
    for (let index = 0; index < 10; index++) assert.equal((await f.request('/api/v1/setup', input(token()))).status, 403);
    const second = await f.startApp();
    const response = await f.request('/api/v1/setup', input(candidate), {}, second.origin);
    assert.equal(response.status, 429); assert.equal(response.body.error.code, 'rate_limited');
    const limits = (await f.pool.query('SELECT * FROM account_auth_limits')).rows;
    assert.ok(limits.every(row => /^[a-f0-9]{64}$/.test(row.key)));
    assert.ok(!JSON.stringify(limits).includes(candidate));
    assert.deepEqual(await f.counts(), { users: 0, workspaces: 0, memberships: 0 });
  });
});
