import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildApp } from '../apps/server/pm/src/app.ts';
import { CAPABILITIES } from '../packages/domain/src/core.ts';
import { ProjectManagementClient } from '../packages/contracts/src/client.ts';
import type { SetupRequest, SetupResponse } from '../packages/contracts/src/instance-setup.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { getInstanceSetupStatus, prepareInstanceSetup } from '../packages/infrastructure/src/instance-setup.ts';
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
    return { pool, app, origin, startApp, request, counts, close: scope.close };
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
