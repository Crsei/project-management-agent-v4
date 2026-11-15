import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildApp } from '../apps/server/pm/src/app.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { lockInstanceSetup, prepareInstanceSetup } from '../packages/infrastructure/src/instance-setup.ts';
import { acquireMailFixtureDatabase, createMailFixtureDatabase, mailTestDatabaseUrl, type MailFixtureDatabase } from './mail-fixture-database.ts';
import { closeMailApp, MailFixtureScope, mailFixtureCaseTimeout, mailFixtureCleanupTimeout, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';

const password = 'registration-test-password';
type TestResponse = { actor: { id: string; email: string; name: string }; expiresAt: string; error: { code: string }; items: unknown[] };
const input = (email = `${randomUUID()}@example.test`) => ({ email, name: '  New member  ', password });
async function fixture(database: MailFixtureDatabase, signal: AbortSignal) {
  const scope = new MailFixtureScope(signal);
  return scope.initialize(async () => {
    const { pool, databaseUrl } = await acquireMailFixtureDatabase(scope, database);
    const root = await scope.acquire(() => mkdtemp(join(tmpdir(), 'pm-registration-')), owned => rm(owned, { recursive: true, force: true }));
    async function start() {
      const app = scope.own(buildApp({ databaseUrl, coreWorkspaceRoot: root, cookieSecure: true, signal: scope.signal }), closeMailApp);
      const origin = await scope.step(() => app.listen({ host: '127.0.0.1', port: 0 }));
      return { app, origin };
    }
    const { origin } = await start();
    async function post(body: unknown, headers: Record<string, string> = {}, path = '/api/v1/auth/register', base = origin) {
      const response = await fetch(`${base}${path}`, { method: 'POST', signal: scope.signal, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: response.status, headers: response.headers, body: await response.json() as TestResponse };
    }
    async function get(path: string, cookie: string) {
      const response = await fetch(`${origin}${path}`, { signal: scope.signal, headers: { cookie } });
      return { status: response.status, body: await response.json() as TestResponse };
    }
    return { pool, origin, start, post, get, close: scope.close };
  });
}

describe('public registration: isolated PostgreSQL and HTTP', { skip: !mailTestDatabaseUrl, concurrency: false }, () => {
  let database: MailFixtureDatabase;
  before(async t => { database = await createMailFixtureDatabase({ signal: t.signal }); }, { timeout: mailSchemaInitTimeout });
  after(() => database?.close(), { timeout: mailFixtureCleanupTimeout });

  it('preserves bootstrap for empty and prepared instances', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    for (let i = 0; i < 2; i++) {
      const result = await f.post(input());
      assert.equal(result.status, 403); assert.equal(result.body.error.code, 'registration_unavailable');
      assert.equal(result.headers.get('set-cookie'), null);
      if (!i) await prepareInstanceSetup(f.pool, randomBytes(32).toString('base64url'));
    }
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 0);
  });

  it('creates an ordinary cookie session, pending onboarding and no inherited workspace access', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const owner = await createUser(f.pool, { email: 'owner@example.test', name: 'Owner', password });
    await createWorkspace(f.pool, owner.id, 'Existing workspace');
    const body = input('  New.User@Example.test  ');
    const result = await f.post(body);
    assert.equal(result.status, 200); assert.deepEqual(Object.keys(result.body).sort(), ['actor', 'expiresAt']);
    assert.equal(result.body.actor.email, 'new.user@example.test'); assert.equal(result.body.actor.name, 'New member');
    assert.ok(!JSON.stringify(result.body).includes(password));
    const setCookie = result.headers.get('set-cookie')!;
    for (const part of ['pm_v4_session=', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Secure', 'Expires=']) assert.ok(setCookie.includes(part));
    assert.equal(result.headers.get('cache-control'), 'private, no-store'); assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
    const cookie = setCookie.split(';')[0]!;
    assert.deepEqual((await f.get('/api/v1/auth/me', cookie)).body.actor, result.body.actor);
    assert.deepEqual((await f.get('/api/v1/workspaces', cookie)).body.items, []);
    assert.deepEqual((await f.get('/api/v1/auth/onboarding', cookie)).body, { actorId: result.body.actor.id, revision: 0, workspaceId: null, profile: 'pending', ai: 'pending', completedAt: null, checklistDismissed: false });
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM memberships WHERE user_id=$1', [result.body.actor.id])).rows[0].n, 0);
    assert.equal((await f.post({ email: body.email, password }, {}, '/api/v1/auth/login')).status, 200);
  });

  it('rejects duplicate and disabled accounts under concurrent requests without credential changes', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    await createUser(f.pool, { email: 'owner@example.test', name: 'Owner', password });
    const body = input('race@example.test');
    const second = await f.start();
    const results = await Promise.all([f.post(body), f.post({ ...body, email: ' RACE@example.test ' }, {}, '/api/v1/auth/register', second.origin)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(results.find(r => r.status === 409)!.body.error.code, 'account_conflict');
    assert.equal(results.find(r => r.status === 409)!.headers.get('set-cookie'), null);
    const user = (await f.pool.query('SELECT id,password_hash,name FROM users WHERE email=$1', [body.email])).rows[0];
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [user.id])).rows[0].n, 1);
    await f.pool.query('UPDATE users SET disabled_at=now() WHERE id=$1', [user.id]);
    const disabled = await f.post({ ...body, password: 'different-password-value', name: 'Changed' });
    assert.equal(disabled.status, 409); assert.equal(disabled.body.error.code, 'account_conflict');
    assert.deepEqual((await f.pool.query('SELECT id,password_hash,name FROM users WHERE id=$1', [user.id])).rows[0], user);
  });

  it('rolls back the new user when session insertion fails', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    await createUser(f.pool, { email: 'owner@example.test', name: 'Owner', password });
    await f.pool.query("CREATE FUNCTION fail_registration_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected session failure'; END $$");
    await f.pool.query('CREATE TRIGGER fail_registration_session BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION fail_registration_session()');
    const body = input();
    try {
      const result = await f.post(body); assert.equal(result.status, 503); assert.equal(result.headers.get('set-cookie'), null);
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM users WHERE email=$1', [body.email])).rows[0].n, 0);
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 0);
    } finally {
      await f.pool.query('DROP TRIGGER fail_registration_session ON sessions'); await f.pool.query('DROP FUNCTION fail_registration_session()');
    }
    assert.equal((await f.post(body)).status, 200);
  });

  it('rechecks initialization under the setup lock after a concurrent identity removal', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const owner = await createUser(f.pool, { email: 'owner@example.test', name: 'Owner', password });
    const sql = await f.pool.connect();
    try {
      await sql.query('BEGIN');
      await lockInstanceSetup(sql);
      await sql.query('DELETE FROM users WHERE id=$1', [owner.id]);
      const pending = f.post(input());
      await sql.query('COMMIT');
      const result = await pending;
      assert.equal(result.status, 403); assert.equal(result.body.error.code, 'registration_unavailable');
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
    } finally { sql.release(); }
  });

  it('does not treat a current-session database failure as anonymous', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const owner = await createUser(f.pool, { email: 'owner@example.test', name: 'Owner', password });
    const login = await f.post({ email: owner.email, password }, {}, '/api/v1/auth/login');
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    await f.pool.query('ALTER TABLE sessions RENAME TO sessions_unavailable');
    try {
      const result = await f.post(input(), { cookie });
      assert.equal(result.status, 503); assert.equal(result.headers.get('set-cookie'), null);
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
    } finally { await f.pool.query('ALTER TABLE sessions_unavailable RENAME TO sessions'); }
  });

  it('rejects cross-origin, valid current sessions and invalid inputs without switching accounts', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    const owner = await createUser(f.pool, { email: 'owner@example.test', name: 'Owner', password });
    const login = await f.post({ email: owner.email, password }, {}, '/api/v1/auth/login');
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const result = await f.post(input(), { cookie });
    assert.equal(result.status, 409); assert.equal(result.body.error.code, 'already_authenticated'); assert.equal(result.headers.get('set-cookie'), null);
    const bearer = cookie.slice('pm_v4_session='.length);
    assert.equal((await f.post(input(), { authorization: `Bearer ${bearer}` })).body.error.code, 'already_authenticated');
    assert.equal((await f.post(input(), { authorization: 'Bearer malformed', cookie })).body.error.code, 'already_authenticated');
    const cross = await f.post(input(), { origin: 'https://evil.example' });
    assert.equal(cross.status, 403); assert.equal(cross.headers.get('cache-control'), 'private, no-store'); assert.equal(cross.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await f.post(input(), { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await f.post(input(), {}, '/api/v1/auth/register?token=secret')).status, 400);
    assert.equal((await f.post({ ...input(), name: 'x'.repeat(5000) })).status, 413);
    for (const body of [{ ...input(), role: 'admin' }, { ...input(), workspaceId: randomUUID() }, { ...input(), email: 'bad' }, { ...input(), password: 'short' }, { ...input(), name: ' ' }]) assert.equal((await f.post(body)).status, 400);
    assert.equal((await f.post(input(), { cookie: 'pm_v4_session=malformed' })).status, 200);
    assert.equal((await f.get('/api/v1/auth/me', cookie)).body.actor.id, owner.id);
    await f.pool.query("UPDATE sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE user_id=$1", [owner.id]);
    assert.equal((await f.post(input(), { cookie })).status, 200);
  });

  it('keeps source throttles across app instances', { timeout: mailFixtureCaseTimeout }, async t => {
    const f = await fixture(database, t.signal); t.after(() => f.close());
    for (let i = 0; i < 10; i++) assert.equal((await f.post(input())).status, 403);
    const second = await f.start();
    const limited = await f.post(input(), {}, '/api/v1/auth/register', second.origin);
    assert.equal(limited.status, 429); assert.equal(limited.body.error.code, 'rate_limited');
    assert.ok((await f.pool.query('SELECT key FROM account_auth_limits')).rows.every(row => /^[a-f0-9]{64}$/.test(row.key)));
  });
});
