import { createHash } from 'node:crypto';
import type { SqlExecutor } from '../../application/src/ports.ts';
import { DomainError } from '../../domain/src/core.ts';

/** Offline business-data fingerprint: binding/history are the only expected maintenance mutations.
 * Full sorted row multisets detect new receipts/facts/permissions even when no blob references changed.
 * Requires an already-open transaction and complete maintenance identity, like inventory.
 */
export async function databaseContentSha256(sql: SqlExecutor): Promise<string> {
  const tables = await sql.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name NOT IN ('blob_storage_binding','blob_storage_operations','blob_store_aliases','local_project_storage_operations') ORDER BY table_name");
  if (!tables.rows.some(table => table.table_name === 'command_receipts') || !tables.rows.some(table => table.table_name === 'entities')) throw new DomainError('blob_inventory_unknown_schema');
  const hash = createHash('sha256');
  for (const table of tables.rows) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table.table_name)) throw new DomainError('blob_inventory_unknown_schema');
    hash.update(JSON.stringify(table.table_name) + '\n');
    await sql.query(`DECLARE pm_storage_data_checkpoint NO SCROLL CURSOR FOR SELECT to_jsonb(pm_row)::text AS value FROM "${table.table_name}" AS pm_row ORDER BY to_jsonb(pm_row)::text COLLATE "C"`);
    try {
      for (;;) {
        const page = await sql.query<{ value: string }>('FETCH FORWARD 100 FROM pm_storage_data_checkpoint');
        if (!page.rows.length) break;
        for (const row of page.rows) hash.update(JSON.stringify(row.value) + '\n');
      }
    } finally { await sql.query('CLOSE pm_storage_data_checkpoint'); }
  }
  return hash.digest('hex');
}
