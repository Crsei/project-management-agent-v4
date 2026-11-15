import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('0058 upgrades an actual pre-origin isolated PM schema without changing historical comments or command identities', { skip: !databaseUrl, timeout: 180_000 }, async () => {
  assert.ok(databaseUrl, 'An explicit isolated TEST_DATABASE_URL is required');
  const schema = `test_comment_origin_upgrade_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(databaseUrl);
  let created = false;
  const scoped = new URL(databaseUrl); scoped.searchParams.set('options', `-c search_path=${schema},public`);
  const pool = createPool(scoped.toString());
  try {
    await bootstrap.query(`CREATE SCHEMA ${schema}`); created = true;
    const folder = new URL('../packages/infrastructure/migrations/', import.meta.url);
    const migrations = (await readdir(folder)).filter(name => /^\d+_[\w-]+\.sql$/.test(name) && name < '0058_task_comment_agent_origin.sql').sort();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
      for (const name of migrations) {
        const sql = await readFile(new URL(name, folder), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [name, createHash('sha256').update(sql).digest('hex')]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    const author = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Historical author', password: 'isolated-migration-fixture-password' });
    const workspace = await createWorkspace(pool, author.id, 'Historical PM schema');
    const commentId = randomUUID(), commandId = randomUUID(), content = 'Existing authoritative human discussion, preserved verbatim.';
    const seed = await pool.connect();
    try {
      await seed.query('BEGIN');
      await seed.query('INSERT INTO task_comments(id,workspace_id,project_id,task_id,author_id,content) VALUES($1,$2,$3,$4,$5,$6)', [commentId, workspace.id, 'PRJ-001', 'TASK-001', author.id, content]);
      await seed.query("INSERT INTO task_comment_revisions(workspace_id,comment_id,version,action,content,actor_id,command_id) VALUES($1,$2,1,'created',$3,$4,$5)", [workspace.id, commentId, content, author.id, commandId]);
      await seed.query('COMMIT');
    } catch (error) { await seed.query('ROLLBACK'); throw error; }
    finally { seed.release(); }
    const before = (await pool.query('SELECT * FROM task_comments WHERE id=$1', [commentId])).rows[0];
    const history = (await pool.query('SELECT * FROM task_comment_revisions WHERE comment_id=$1', [commentId])).rows[0];
    await migrate(pool);
    const upgraded = (await pool.query('SELECT * FROM task_comments WHERE id=$1', [commentId])).rows[0];
    const upgradedHistory = (await pool.query('SELECT * FROM task_comment_revisions WHERE comment_id=$1', [commentId])).rows[0];
    assert.deepEqual(upgraded, { ...before, agent_origin: null });
    assert.deepEqual(upgradedHistory, { ...history, agent_origin: null });
    assert.equal(upgraded.author_id, author.id); assert.equal(upgraded.content, content); assert.equal(upgraded.version, 1);
    assert.equal(upgradedHistory.command_id, commandId);
    await migrate(pool);
    assert.deepEqual((await pool.query('SELECT * FROM task_comments WHERE id=$1', [commentId])).rows[0], upgraded, 'Re-running numbered migration discovery must be a no-op');
    await assert.rejects(pool.query('DELETE FROM task_comments WHERE id=$1', [commentId]), /cannot be erased/);
    await assert.rejects(pool.query("UPDATE task_comment_revisions SET content='replace' WHERE comment_id=$1", [commentId]), /cannot be erased/);
  } finally {
    await pool.end();
    try { if (created) await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await bootstrap.end(); }
  }
});
