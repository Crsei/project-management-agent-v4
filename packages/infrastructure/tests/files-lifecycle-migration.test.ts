import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { describe, it, type TestContext } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/database.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const migrationFolder = new URL('../migrations/', import.meta.url);

async function oldSchema(t: TestContext): Promise<Pool> {
  const namespace = `test_files_upgrade_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(databaseUrl!);
  await bootstrap.query(`CREATE SCHEMA ${namespace}`);
  const url = new URL(databaseUrl!); url.searchParams.set('options', `-c search_path=${namespace},public`);
  const pool = createPool(url.toString());
  t.after(async () => { await pool.end(); try { await bootstrap.query(`DROP SCHEMA ${namespace} CASCADE`); } finally { await bootstrap.end(); } });
  const sql = await pool.connect();
  try {
    await sql.query('BEGIN');
    for (const name of (await readdir(migrationFolder)).filter(name => /^\d+_[\w-]+\.sql$/.test(name) && name < '0025_').sort()) await sql.query(await readFile(new URL(name, migrationFolder), 'utf8'));
    await sql.query('COMMIT');
  } catch (error) { await sql.query('ROLLBACK'); throw error; }
  finally { sql.release(); }
  return pool;
}
async function legacyFile(sql: PoolClient, workspaceId: string, userId: string, title?: string) {
  const artifactId = randomUUID(); const versionId = randomUUID(); const uploadId = randomUUID();
  const digest = createHash('sha256').update('legacy bytes').digest('hex'); const key = `sha256-${digest}-${randomUUID()}.blob`;
  const versionData = { artifactId, uploadId, objectKey: key, sha256: digest, contentDigest: digest, size: 12, mediaType: 'text/plain', fileName: 'legacy-original.txt', sourceRunId: null, producerId: userId };
  const artifactData = { ...(title === undefined ? {} : { title }), kind: 'document', versionRefs: [versionId], latestVersionId: versionId };
  const uploadData = { objectKey: key, sha256: digest, size: 12, fileName: 'legacy-original.txt', mediaType: 'text/plain', ownerId: userId, expiresAt: '2026-10-20T01:00:00.000Z', consumedAt: '2026-10-20T00:30:00.000Z', consumedByArtifactVersionId: versionId };
  for (const [id, kind, data] of [[uploadId, 'upload', uploadData], [artifactId, 'artifact', artifactData], [versionId, 'artifact_version', versionData]] as const) await sql.query('INSERT INTO entities(id,workspace_id,project_id,kind,data,created_by) VALUES($1,$2,\'PRJ-001\',$3,$4,$5)', [id, workspaceId, kind, data, userId]);
  return { artifactId, versionId, uploadId, key, versionData, artifactData };
}
async function seed(pool: Pool) {
  const userId = randomUUID(); const workspaceId = randomUUID(); const sql = await pool.connect();
  try {
    await sql.query('BEGIN');
    await sql.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,\'Legacy owner\',\'fixture-not-a-credential\')', [userId, `${userId}@example.test`]);
    await sql.query('INSERT INTO workspaces(id,name,owner_id) VALUES($1,\'Legacy workspace\',$2)', [workspaceId, userId]);
    await sql.query("INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) VALUES($1,$2,ARRAY['domain.read','delivery.write'],NULL)", [workspaceId, userId]);
    const kept = await legacyFile(sql, workspaceId, userId, 'Existing display title ≠ filename');
    const repaired = await legacyFile(sql, workspaceId, userId);
    await sql.query('COMMIT'); return { kept, repaired, userId, workspaceId };
  } catch (error) { await sql.query('ROLLBACK'); throw error; }
  finally { sql.release(); }
}

describe('Files lifecycle forward upgrade from the actual 0024 schema', { skip: !databaseUrl, timeout: 180_000 }, () => {
  it('keeps effective titles and immutable version bytes/keys, repairs only absent titles and increments mutable artifacts once without invented audit', async t => {
    const pool = await oldSchema(t); const legacy = await seed(pool);
    const before = await pool.query('SELECT * FROM entities WHERE kind=\'artifact_version\' ORDER BY id');
    await pool.query(await readFile(new URL('0025_files_lifecycle.sql', migrationFolder), 'utf8'));
    const rows = await pool.query('SELECT * FROM entities WHERE kind=\'artifact\'');
    const kept = rows.rows.find(row => row.id === legacy.kept.artifactId)!; const repaired = rows.rows.find(row => row.id === legacy.repaired.artifactId)!;
    assert.equal(kept.data.title, 'Existing display title ≠ filename'); assert.equal(repaired.data.title, 'legacy-original.txt');
    for (const row of [kept, repaired]) { assert.equal(row.version, 2); assert.equal(row.data.hiddenAt, null); assert.equal(row.data.hiddenBy, null); assert.equal(row.created_by, legacy.userId); }
    assert.deepEqual((await pool.query('SELECT * FROM entities WHERE kind=\'artifact_version\' ORDER BY id')).rows, before.rows);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM artifact_copy_origins')).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM project_audit')).rows[0].count, 0);
    await assert.rejects(pool.query("UPDATE entities SET data=data || '{\"hiddenAt\":\"2026-10-23T00:00:00.000Z\",\"hiddenBy\":null}',version=version+1 WHERE id=$1", [legacy.kept.artifactId]), /artifact_metadata_valid/);
  });
  it('blocks corrupt cross-artifact latest pointers before backfill rather than hiding the damage with an orphan UI fallback', async t => {
    const pool = await oldSchema(t); const legacy = await seed(pool);
    await pool.query("UPDATE entities SET data=jsonb_set(data,'{latestVersionId}',to_jsonb($2::text)),version=version+1 WHERE id=$1", [legacy.kept.artifactId, legacy.repaired.versionId]);
    const sql = await pool.connect();
    try {
      await sql.query('BEGIN');
      await assert.rejects(sql.query(await readFile(new URL('0025_files_lifecycle.sql', migrationFolder), 'utf8')), /invalid latestVersionId/);
      await sql.query('ROLLBACK');
    } finally { sql.release(); }
    const existing = await pool.query('SELECT data FROM entities WHERE id=$1', [legacy.kept.artifactId]);
    assert.equal('hiddenAt' in existing.rows[0].data, false);
    assert.equal((await pool.query("SELECT to_regclass(quote_ident(current_schema()) || '.artifact_copy_origins') AS relation")).rows[0].relation, null);
  });
});
