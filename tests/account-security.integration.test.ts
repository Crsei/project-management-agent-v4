/// <reference lib="es2024.promise" />
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import type { AccountSecurity, AccountSecurityAction, AccountSecurityActionLookup } from '../packages/contracts/src/account-security.ts';
import { ProjectManagementClient } from '../packages/contracts/src/client.ts';
import { createDashboardFixture, dashboardDatabaseUrl } from './dashboard-fixture.ts';
import type { DashboardFixture } from './dashboard-fixture.ts';

const initialPassword = 'isolated-dashboard-test-password';
const newPassword = 'isolated-security-new-password';
async function signIn(f: DashboardFixture, password = initialPassword) {
  const response = await f.request('/api/v1/auth/login', { method: 'POST', cookie: '', body: { email: f.owner.email, password } });
  return { ...response, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
async function waitForBlocked(pool: Pool, blocker: number, prefix: string, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await pool.query<{ count: string }>(`WITH RECURSIVE blocked(pid) AS (
      SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))
      UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
    ) SELECT count(*)::text AS count FROM pg_stat_activity a JOIN blocked b USING(pid)
      WHERE a.wait_event_type='Lock' AND a.query LIKE $2`, [blocker, `${prefix}%`]);
    if (Number(result.rows[0]!.count) >= count) return;
    await delay(10);
  }
  assert.fail('The real authentication transaction did not reach the expected user-row lock');
}

describe('account security: real PostgreSQL and HTTP', { skip: !dashboardDatabaseUrl }, () => {
  it('changes only the verified owner password, retains this session, revokes another and exposes no secrets', async t => {
    const f = await createDashboardFixture(); t.after(() => f.close());
    const other = await signIn(f); assert.equal(other.status, 200);
    const before = await f.request<AccountSecurity>('/api/v1/auth/security');
    assert.equal(before.status, 200); assert.equal(before.headers.get('cache-control'), 'no-store');
    assert.equal(before.body.sessions.length, 2);
    assert.equal(before.body.sessions.filter(session => session.current).length, 1);
    for (const session of before.body.sessions) {
      assert.deepEqual(Object.keys(session).sort(), ['id', 'current', 'createdAt', 'expiresAt', 'device', 'ipAddress', 'location', 'lastActiveAt'].sort());
      assert.equal(session.device, null); assert.equal(session.ipAddress, null); assert.equal(session.location, null); assert.equal(session.lastActiveAt, null);
    }
    const actionId = randomUUID();
    const changed = await f.request<AccountSecurityAction>('/api/v1/auth/security/password', { method: 'POST', body: { actionId, expectedCredentialVersion: before.body.credentialVersion, currentPassword: initialPassword, newPassword } });
    assert.equal(changed.status, 200); assert.equal(changed.body.status, 'committed'); assert.equal(changed.body.revokedCount, 1); assert.equal(changed.body.credentialVersion, 2);
    assert.equal((await f.request('/api/v1/auth/me')).status, 200);
    assert.equal((await f.request('/api/v1/auth/me', { cookie: other.cookie })).status, 401);
    assert.equal((await signIn(f)).status, 401);
    const fresh = await signIn(f, newPassword); assert.equal(fresh.status, 200);
    const original = await f.request<AccountSecurityActionLookup>(`/api/v1/auth/security/actions/${actionId}`, { cookie: fresh.cookie });
    assert.deepEqual(original.body.action, changed.body);
    const stored = await f.pool.query('SELECT * FROM account_security_actions WHERE user_id=$1', [f.owner.id]);
    const safe = JSON.stringify(stored.rows);
    assert.ok(!safe.includes(initialPassword) && !safe.includes(newPassword));
    assert.ok(!safe.includes('password_hash') && !safe.includes('token_hash') && !safe.includes('request_hash'));
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM outbox')).rows[0].count, 0);
  });

  it('cannot list, revoke, or recover another user session/action and protects the current session', async t => {
    const f = await createDashboardFixture(); t.after(() => f.close());
    const foreign = await f.member('Separate security account');
    const other = await signIn(f); assert.equal(other.status, 200);
    const own = (await f.request<AccountSecurity>('/api/v1/auth/security')).body;
    const foreignState = (await f.request<AccountSecurity>('/api/v1/auth/security', { cookie: foreign.cookie })).body;
    assert.equal(foreignState.sessions.length, 1);
    assert.ok(!own.sessions.some(session => session.id === foreignState.sessions[0]!.id));
    assert.equal((await f.request(`/api/v1/auth/security?userId=${foreign.user.id}`)).status, 400);
    assert.equal((await f.request('/api/v1/auth/security/sessions/revoke', { method: 'POST', body: { actionId: randomUUID(), expectedCredentialVersion: 1, sessionId: 'others', userId: foreign.user.id } })).status, 400);
    for (const sessionId of [foreignState.sessions[0]!.id, randomUUID()]) {
      const response = await f.request<AccountSecurityAction>('/api/v1/auth/security/sessions/revoke', { method: 'POST', body: { actionId: randomUUID(), expectedCredentialVersion: 1, sessionId } });
      assert.equal(response.status, 404); assert.equal(response.body.errorCode, 'not_found_or_forbidden');
    }
    assert.equal((await f.request('/api/v1/auth/me', { cookie: foreign.cookie })).status, 200);
    const protectedCurrent = await f.request<AccountSecurityAction>('/api/v1/auth/security/sessions/revoke', { method: 'POST', body: { actionId: randomUUID(), expectedCredentialVersion: 1, sessionId: own.sessions.find(session => session.current)!.id } });
    assert.equal(protectedCurrent.status, 400); assert.equal(protectedCurrent.body.errorCode, 'current_session_protected');
    const actionId = randomUUID();
    const revoked = await f.request<AccountSecurityAction>('/api/v1/auth/security/sessions/revoke', { method: 'POST', body: { actionId, expectedCredentialVersion: 1, sessionId: 'others' } });
    assert.equal(revoked.body.revokedCount, 1);
    assert.equal((await f.request('/api/v1/auth/me', { cookie: other.cookie })).status, 401);
    assert.equal((await f.request<AccountSecurityActionLookup>(`/api/v1/auth/security/actions/${actionId}`, { cookie: foreign.cookie })).body.action, null);
    const recoveredForeign = await f.request<AccountSecurityActionLookup>(`/api/v1/auth/security/actions/${actionId}/recover`, { method: 'POST', cookie: foreign.cookie, body: { kind: 'revoke_sessions' } });
    assert.equal(recoveredForeign.body.action!.status, 'cancelled');
    assert.equal((await f.request<AccountSecurityActionLookup>(`/api/v1/auth/security/actions/${actionId}`)).body.action!.status, 'committed');
  });

  it('persists failed-password throttling and never changes credentials on rejection', async t => {
    const f = await createDashboardFixture(); t.after(() => f.close());
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await f.request<AccountSecurityAction>('/api/v1/auth/security/password', { method: 'POST', body: { actionId: randomUUID(), expectedCredentialVersion: 1, currentPassword: 'incorrect', newPassword } });
      assert.equal(response.status, 403); assert.equal(response.body.errorCode, 'current_password_invalid');
    }
    const limited = await f.request('/api/v1/auth/security/password', { method: 'POST', body: { actionId: randomUUID(), expectedCredentialVersion: 1, currentPassword: initialPassword, newPassword } });
    assert.equal(limited.status, 429);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM account_security_actions')).rows[0].count, 5);
    assert.equal((await signIn(f)).status, 200);
    assert.equal((await signIn(f, newPassword)).status, 401);
    assert.equal((await f.request<AccountSecurity>('/api/v1/auth/security')).body.credentialVersion, 1);
    await f.pool.query("INSERT INTO account_auth_limits(key,attempts,expires_at) VALUES(repeat('f',64),1,clock_timestamp()-interval '1 second')");
    await signIn(f);
    assert.equal((await f.pool.query("SELECT count(*)::int AS count FROM account_auth_limits WHERE key=repeat('f',64)")).rows[0].count, 0);
  });

  it('serializes password CAS so concurrent changes cannot overwrite one another', async t => {
    const f = await createDashboardFixture(); t.after(() => f.close());
    const responses = await Promise.all(['isolated-security-choice-one', 'isolated-security-choice-two'].map(password => f.request<AccountSecurityAction>('/api/v1/auth/security/password', { method: 'POST', body: { actionId: randomUUID(), expectedCredentialVersion: 1, currentPassword: initialPassword, newPassword: password } })));
    assert.equal(responses.filter(response => response.body.status === 'committed').length, 1);
    assert.equal(responses.filter(response => response.body.errorCode === 'credential_version_conflict').length, 1);
    assert.equal((await f.request<AccountSecurity>('/api/v1/auth/security')).body.credentialVersion, 2);
  });

  it('recovers a lost committed result, fences an absent original and refuses any password replay', async t => {
    const f = await createDashboardFixture(); t.after(() => f.close());
    const actionId = randomUUID();
    const droppingClient = new ProjectManagementClient({ baseUrl: f.origin,
      auth: { type: 'cookie', credentials: 'include', cookie: () => f.ownerCookie },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        assert.equal(response.status, 200);
        await response.arrayBuffer();
        throw new TypeError('Injected transport loss after the real service committed');
      },
    });
    await assert.rejects(droppingClient.changeOwnPassword({ actionId, expectedCredentialVersion: 1, currentPassword: initialPassword, newPassword }), /Injected transport loss/);
    const recovered = await f.request<AccountSecurityActionLookup>(`/api/v1/auth/security/actions/${actionId}/recover`, { method: 'POST', body: { kind: 'password_change' } });
    assert.equal(recovered.body.action!.status, 'committed');
    const delayedId = randomUUID();
    assert.equal((await f.request<AccountSecurityActionLookup>(`/api/v1/auth/security/actions/${delayedId}`)).body.action, null);
    const fence = await f.request<AccountSecurityActionLookup>(`/api/v1/auth/security/actions/${delayedId}/recover`, { method: 'POST', body: { kind: 'password_change' } });
    assert.equal(fence.body.action!.status, 'cancelled');
    const delayed = await f.request<{ error: { code: string } }>('/api/v1/auth/security/password', { method: 'POST', body: { actionId: delayedId, expectedCredentialVersion: 2, currentPassword: newPassword, newPassword: 'isolated-security-delayed-password' } });
    assert.equal(delayed.status, 409); assert.equal(delayed.body.error.code, 'security_action_already_recorded');
    assert.equal((await f.request<AccountSecurity>('/api/v1/auth/security')).body.credentialVersion, 2);
    const replay = await f.request('/api/v1/auth/security/password', { method: 'POST', body: { actionId, expectedCredentialVersion: 2, currentPassword: newPassword, newPassword: 'isolated-security-replayed-password' } });
    assert.equal(replay.status, 409);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM account_security_actions')).rows[0].count, 2);
  });

  it('rejects an already verified old-password login queued behind a committing password change', async t => {
    const f = await createDashboardFixture(); t.after(() => f.close());
    const blocker = await f.pool.connect();
    let locked = true;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.owner.id]);
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const changing = f.request<AccountSecurityAction>('/api/v1/auth/security/password', { method: 'POST', body: { actionId: randomUUID(), expectedCredentialVersion: 1, currentPassword: initialPassword, newPassword } });
      await waitForBlocked(f.pool, pid, 'SELECT id,credential_version,password_hash,password_changed_at,disabled_at FROM users WHERE id=$1 FOR UPDATE');
      const signingIn = signIn(f);
      await waitForBlocked(f.pool, pid, 'SELECT id,email,name,password_hash,credential_version,disabled_at FROM users WHERE id=$1 FOR UPDATE');
      await blocker.query('COMMIT'); locked = false;
      assert.equal((await changing).body.status, 'committed');
      assert.equal((await signingIn).status, 401);
      assert.equal((await f.request<AccountSecurity>('/api/v1/auth/security')).body.sessions.length, 1);
      assert.equal((await signIn(f, newPassword)).status, 200);
    } finally { if (locked) await blocker.query('ROLLBACK'); blocker.release(); }
  });

  it('rechecks a revoked token after a lock wait instead of trusting pre-lock authentication', async t => {
    const f = await createDashboardFixture(); t.after(() => f.close());
    const other = await signIn(f); assert.equal(other.status, 200);
    const blocker = await f.pool.connect();
    let locked = true;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.owner.id]);
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const revoking = f.request<AccountSecurityAction>('/api/v1/auth/security/sessions/revoke', { method: 'POST', body: { actionId: randomUUID(), expectedCredentialVersion: 1, sessionId: 'others' } });
      const lockQuery = 'SELECT id,credential_version,password_hash,password_changed_at,disabled_at FROM users WHERE id=$1 FOR UPDATE';
      await waitForBlocked(f.pool, pid, lockQuery);
      const changing = f.request('/api/v1/auth/security/password', { method: 'POST', cookie: other.cookie, body: { actionId: randomUUID(), expectedCredentialVersion: 1, currentPassword: initialPassword, newPassword } });
      await waitForBlocked(f.pool, pid, lockQuery, 2);
      await blocker.query('COMMIT'); locked = false;
      assert.equal((await revoking).body.status, 'committed');
      assert.equal((await changing).status, 401);
      assert.equal((await f.request<AccountSecurity>('/api/v1/auth/security')).body.credentialVersion, 1);
    } finally { if (locked) await blocker.query('ROLLBACK'); blocker.release(); }
  });

  it('closes an already-open revoked core stream before forwarding a new authoritative change', async t => {
    const f = await createDashboardFixture(); t.after(() => f.close());
    const other = await signIn(f); assert.equal(other.status, 200);
    const streams = await Promise.all([other.cookie, f.ownerCookie].map(async cookie => {
      const controller = new AbortController();
      const ready = Promise.withResolvers<void>(), change = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
      const state = { changes: 0 };
      const response = await fetch(`${f.origin}/api/v1/workspaces/${f.workspaceId}/core/events`, { headers: { cookie }, signal: controller.signal });
      assert.equal(response.status, 200);
      const reading = (async () => {
        let buffer = '';
        const reader = response.body!.getReader();
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            buffer += new TextDecoder().decode(chunk.value);
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
              const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const kind = /^event: (.+)$/m.exec(block)?.[1];
              if (kind === 'ready') ready.resolve();
              else if (kind && kind !== 'heartbeat') { state.changes++; change.resolve(); }
            }
          }
        } catch (error) { if (!controller.signal.aborted) throw error; }
        finally { closed.resolve(); }
      })();
      return { controller, state, ready: ready.promise, changed: change.promise, closed: closed.promise, reading };
    }));
    try {
      await Promise.race([Promise.all(streams.map(stream => stream.ready)), delay(5000).then(() => assert.fail('Core streams did not become ready'))]);
      const revoked = await f.request<AccountSecurityAction>('/api/v1/auth/security/sessions/revoke', { method: 'POST', body: { actionId: randomUUID(), expectedCredentialVersion: 1, sessionId: 'others' } });
      assert.equal(revoked.body.status, 'committed');
      await f.command('CreateProject', { name: 'Post-revocation core event', goal: 'Verify live authorization', ownerId: f.owner.id, completionCriteria: [] });
      await Promise.race([Promise.all([streams[0]!.closed, streams[1]!.changed]), delay(5000).then(() => assert.fail('Revoked stream must close while the retained stream receives the real event'))]);
      assert.equal(streams[0]!.state.changes, 0);
      assert.ok(streams[1]!.state.changes > 0);
      assert.equal((await f.request('/api/v1/auth/me', { cookie: other.cookie })).status, 401);
    } finally {
      for (const stream of streams) stream.controller.abort();
      await Promise.all(streams.map(stream => stream.reading));
    }
  });
});
