import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createPool } from '../src/database.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
test('native absolute path upgrade accepts drive roots without loosening identity or relative-path checks', { skip: !databaseUrl }, async t => {
  const namespace = `test_native_paths_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(databaseUrl!);
  await bootstrap.query(`CREATE SCHEMA ${namespace}`);
  const url = new URL(databaseUrl!); url.searchParams.set('options', `-c search_path=${namespace},public`);
  const pool = createPool(url.toString());
  t.after(async () => { await pool.end(); try { await bootstrap.query(`DROP SCHEMA ${namespace} CASCADE`); } finally { await bootstrap.end(); } });
  // Reproduce the exact old CHECK shapes, including 0039's generated name.
  await pool.query(`CREATE TABLE agent_file_areas(path text NOT NULL CHECK(length(path) BETWEEN 1 AND 4096 AND left(path,1)='/'));
    CREATE TABLE agent_storage_settings(default_root text NOT NULL CONSTRAINT agent_storage_settings_root_check CHECK(length(default_root) BETWEEN 1 AND 4096 AND left(default_root,1)='/'));
    CREATE TABLE document_sources(path text, directory_device text, directory_inode text,
      CHECK((path IS NULL AND directory_device IS NULL AND directory_inode IS NULL) OR
        (path IS NOT NULL AND directory_device IS NOT NULL AND directory_inode IS NOT NULL AND length(path) BETWEEN 1 AND 4096 AND left(path,1)='/' AND directory_device ~ '^[0-9]+$' AND directory_inode ~ '^[0-9]+$')))`);
  await pool.query("INSERT INTO document_sources VALUES('/existing/source','11','42')");
  await pool.query(await readFile(new URL('../migrations/0046_native_absolute_paths.sql', import.meta.url), 'utf8'));
  assert.deepEqual((await pool.query("SELECT * FROM document_sources WHERE path='/existing/source'")).rows, [{ path: '/existing/source', directory_device: '11', directory_inode: '42' }]);
  for (const root of ['/Users/owner/source', 'C:\\Users\\owner\\source', 'd:/project', 'C:\\']) {
    await pool.query('INSERT INTO agent_file_areas VALUES($1)', [root]);
    await pool.query('INSERT INTO agent_storage_settings VALUES($1)', [root]);
    await pool.query("INSERT INTO document_sources VALUES($1,'11','42')", [root]);
  }
  for (const root of ['relative/source', 'C:relative', '1:\\source', '\\source', '']) {
    for (const statement of ['INSERT INTO agent_file_areas VALUES($1)', 'INSERT INTO agent_storage_settings VALUES($1)', "INSERT INTO document_sources VALUES($1,'11','42')"])
      await assert.rejects(pool.query(statement, [root]), { code: '23514' });
  }
  await assert.rejects(pool.query("INSERT INTO document_sources VALUES('C:\\source',NULL,'42')"), { code: '23514' });
  await assert.rejects(pool.query("INSERT INTO document_sources VALUES('C:\\source','wrong','42')"), { code: '23514' });
  await pool.query('INSERT INTO document_sources VALUES(NULL,NULL,NULL)');
});
