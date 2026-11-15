import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ApiError, ProjectManagementClient } from '../packages/contracts/src/client.ts';
import { createUser } from '../packages/infrastructure/src/auth.ts';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createLocalProjectFixture, localProjectCaseTimeout } from './local-project-fixture.ts';

test('onboarding is account-bound, concurrent, persistent and checks current workspace access', { timeout: localProjectCaseTimeout }, async t => {
  const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
  const other = await f.member('Other onboarding account');
  let cookie = f.ownerCookie;
  const client = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => cookie } });
  const initial = await client.getOnboarding({ signal: f.signal });
  assert.deepEqual(initial, { actorId: f.owner.id, revision: 0, workspaceId: null, profile: 'pending', ai: 'pending', completedAt: null, checklistDismissed: false });
  const request = { expectedActorId: f.owner.id, expectedRevision: 0 };
  await assert.rejects(client.updateOnboarding({ ...request, action: 'finish' }), (e: unknown) => e instanceof ApiError && e.code === 'onboarding_workspace_unavailable');
  cookie = other.cookie;
  await assert.rejects(client.updateOnboarding({ ...request, action: 'skip-profile' }), (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === 'session_changed');
  await assert.rejects(client.updateOnboarding({ expectedActorId: other.user.id, expectedRevision: 0, action: 'select-workspace', workspaceId: f.workspaceId }), (e: unknown) => e instanceof ApiError && e.code === 'onboarding_workspace_unavailable');
  cookie = f.ownerCookie;
  const selection = await client.updateOnboarding({ ...request, action: 'select-workspace', workspaceId: f.workspaceId });
  assert.equal(selection.workspaceId, f.workspaceId);
  await assert.rejects(client.updateOnboarding({ expectedActorId: f.owner.id, expectedRevision: selection.revision, action: 'finish' }), (e: unknown) => e instanceof ApiError && e.code === 'onboarding_incomplete');
  const races = await Promise.allSettled([
    client.updateOnboarding({ expectedActorId: f.owner.id, expectedRevision: selection.revision, action: 'skip-profile' }),
    client.updateOnboarding({ expectedActorId: f.owner.id, expectedRevision: selection.revision, action: 'review-profile' }),
  ]);
  assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = races.find(r => r.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected' && rejected.reason instanceof ApiError && rejected.reason.code === 'onboarding_conflict');
  let state = await client.getOnboarding();
  state = await client.updateOnboarding({ expectedActorId: f.owner.id, expectedRevision: state.revision, action: 'skip-profile' });
  state = await client.updateOnboarding({ expectedActorId: f.owner.id, expectedRevision: state.revision, action: 'skip-ai' });
  state = await client.updateOnboarding({ expectedActorId: f.owner.id, expectedRevision: state.revision, action: 'finish' });
  assert.equal(state.profile, 'skipped'); assert.equal(state.ai, 'skipped'); assert.ok(state.completedAt);
  const completedAt = state.completedAt;
  state = await client.updateOnboarding({ expectedActorId: f.owner.id, expectedRevision: state.revision, action: 'dismiss-checklist' });
  assert.equal(state.checklistDismissed, true); assert.equal(state.completedAt, completedAt);
  await f.pool.query('UPDATE memberships SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner.id]);
  state = await client.updateOnboarding({ expectedActorId: f.owner.id, expectedRevision: state.revision, action: 'review-ai' });
  assert.equal(state.ai, 'reviewed'); assert.equal(state.completedAt, completedAt);
  state = await client.getOnboarding();
  assert.equal(state.workspaceId, null); assert.equal(state.completedAt, completedAt);
  await assert.rejects(client.updateOnboarding({ expectedActorId: f.owner.id, expectedRevision: state.revision, action: 'finish' }), (e: unknown) => e instanceof ApiError && e.code === 'onboarding_workspace_unavailable');
  await assert.rejects(client.updateOnboarding({ expectedActorId: f.owner.id, expectedRevision: state.revision, action: 'select-workspace', workspaceId: f.workspaceId }), (e: unknown) => e instanceof ApiError && e.code === 'onboarding_workspace_unavailable');
});

test('0059 preserves existing accounts as complete while new accounts use pending defaults', { skip: !process.env.TEST_DATABASE_URL, timeout: 180_000 }, async () => {
  const url = process.env.TEST_DATABASE_URL!;
  const schema = `test_onboarding_upgrade_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(url); let created = false;
  const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema},public`);
  const pool = createPool(scoped.toString());
  try {
    await bootstrap.query(`CREATE SCHEMA ${schema}`); created = true;
    const folder = new URL('../packages/infrastructure/migrations/', import.meta.url);
    const migrations = (await readdir(folder)).filter(name => /^\d+_[\w-]+\.sql$/.test(name) && name < '0059_user_onboarding.sql').sort();
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
      for (const name of migrations) {
        const sql = await readFile(new URL(name, folder), 'utf8');
        await connection.query(sql);
        await connection.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [name, createHash('sha256').update(sql).digest('hex')]);
      }
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    const old = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Existing', password: 'isolated-migration-fixture-password' });
    await migrate(pool);
    const fresh = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'New', password: 'isolated-migration-fixture-password' });
    const rows = await pool.query('SELECT id,onboarding_revision,onboarding_workspace_id,onboarding_profile,onboarding_ai,onboarding_completed_at,onboarding_checklist_dismissed FROM users WHERE id=ANY($1::uuid[])', [[old.id, fresh.id]]);
    const existing = rows.rows.find(row => row.id === old.id), pending = rows.rows.find(row => row.id === fresh.id);
    assert.ok(existing.onboarding_completed_at); assert.equal(existing.onboarding_checklist_dismissed, true);
    assert.deepEqual(pending, { id: fresh.id, onboarding_revision: 0, onboarding_workspace_id: null, onboarding_profile: 'pending', onboarding_ai: 'pending', onboarding_completed_at: null, onboarding_checklist_dismissed: false });
  } finally { await pool.end(); try { if (created) await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await bootstrap.end(); } }
});
