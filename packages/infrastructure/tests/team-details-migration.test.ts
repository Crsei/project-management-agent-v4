import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createUser, createWorkspace } from '../src/auth.ts';
import { createPool } from '../src/database.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe('team details migration preserves unknown facts and real historical record times', { skip: !databaseUrl }, () => {
  const namespace = `test_team_details_${randomUUID().replaceAll('-', '')}`;
  let bootstrap: Pool | undefined;
  let pool: Pool | undefined;
  let workspaceId: string;
  let userId: string;
  const activeId = randomUUID();
  const archivedId = randomUUID();
  const historicalTime = new Date('2020-01-01T00:00:00.000Z');
  before(async () => {
    bootstrap = createPool(databaseUrl!);
    await bootstrap.query(`CREATE SCHEMA ${namespace}`);
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set('options', `-c search_path=${namespace},public`);
    pool = createPool(scopedUrl.toString());
    const folder = new URL('../migrations/', import.meta.url);
    const files = (await readdir(folder)).filter(file => /^\d+_[\w-]+\.sql$/.test(file) && file < '0018_team_details.sql').sort();
    for (const file of files) await pool.query(await readFile(new URL(file, folder), 'utf8'));
    const owner = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Legacy team owner', password: 'isolated-team-migration-test' });
    userId = owner.id;
    workspaceId = (await createWorkspace(pool, userId, 'Legacy team workspace')).id;
    for (const [id, archivedAt] of [[activeId, null], [archivedId, '2020-01-01T00:00:00.000Z']] as const) {
      await pool.query(`INSERT INTO dashboard_records(id,workspace_id,kind,version,data,created_at,updated_at,created_by)
        VALUES($1,$2,'project_team',7,$3::jsonb,$4,$4,$5)`,
      [id, workspaceId, JSON.stringify({ name: 'Legacy team', memberIds: [userId], archivedAt }), historicalTime, userId]);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(new URL('0018_team_details.sql', folder), 'utf8'));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });
  after(async () => {
    try { await pool?.end(); }
    finally {
      try { await bootstrap?.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); }
      finally { await bootstrap?.end(); }
    }
  });

  it('backfills empty/unknown facts for active and archived records without fabricating activity or changing CAS versions', async () => {
    const result = await pool!.query('SELECT id,version,data,created_at,updated_at FROM dashboard_records WHERE kind=$1 ORDER BY id', ['project_team']);
    assert.equal(result.rows.length, 2);
    for (const row of result.rows) {
      assert.equal(row.version, 7);
      assert.equal(row.created_at.toISOString(), historicalTime.toISOString());
      assert.equal(row.updated_at.toISOString(), historicalTime.toISOString());
      assert.deepEqual(row.data, { name: 'Legacy team', memberIds: [userId], archivedAt: row.id === archivedId ? historicalTime.toISOString() : null,
        identifier: null, description: '', focus: null, responseTargetHours: null, maintainerIds: [] });
    }
  });

  it('reenables historical/archived guards and rejects out-of-roster or inactive maintainers in SQL', async () => {
    await assert.rejects(pool!.query('UPDATE dashboard_records SET data=data WHERE id=$1', [activeId]), { constraint: 'dashboard_identity_version' });
    await assert.rejects(pool!.query('UPDATE dashboard_records SET version=version+1 WHERE id=$1', [archivedId]), { constraint: 'project_team_archived' });
    await assert.rejects(pool!.query(`UPDATE dashboard_records SET version=version+1,data=jsonb_set(data,'{maintainerIds}',$2::jsonb) WHERE id=$1`,
      [activeId, JSON.stringify([randomUUID()])]), { constraint: 'project_team_maintainer_member' });
    await pool!.query(`UPDATE dashboard_records SET version=version+1,data=jsonb_set(data,'{maintainerIds}',$2::jsonb) WHERE id=$1`, [activeId, JSON.stringify([userId])]);
    const target = await createUser(pool!, { email: `${randomUUID()}@example.test`, name: 'Revoked maintainer', password: 'isolated-team-migration-test' });
    await pool!.query('INSERT INTO memberships(workspace_id,user_id,capabilities) VALUES($1,$2,$3)', [workspaceId, target.id, ['domain.read']]);
    await pool!.query(`UPDATE dashboard_records SET version=version+1,data=jsonb_set(data,'{memberIds}',$2::jsonb) WHERE id=$1`, [activeId, JSON.stringify([userId, target.id])]);
    await pool!.query('UPDATE memberships SET revoked_at=now(),version=version+1 WHERE workspace_id=$1 AND user_id=$2', [workspaceId, target.id]);
    await assert.rejects(pool!.query(`UPDATE dashboard_records SET version=version+1,data=jsonb_set(data,'{maintainerIds}',$2::jsonb) WHERE id=$1`,
      [activeId, JSON.stringify([target.id])]), { constraint: 'project_team_maintainer_active' });
  });
});
