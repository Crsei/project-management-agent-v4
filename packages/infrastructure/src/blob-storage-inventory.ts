import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { SqlExecutor } from '../../application/src/ports.ts';
import { blobKeyDigest, MAX_BLOB_BYTES, type BlobStore } from './blobs.ts';

export const blobInventoryEntrySchema = z.strictObject({ key: z.string(), storageId: z.uuid().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0).max(MAX_BLOB_BYTES), references: z.number().int().positive() }).superRefine((entry, context) => {
  try { if (blobKeyDigest(entry.key) !== entry.sha256) context.addIssue({ code: 'custom', message: 'Key digest differs' }); }
  catch { context.addIssue({ code: 'custom', message: 'Invalid object key' }); }
});
export type BlobInventoryEntry = z.infer<typeof blobInventoryEntrySchema>;
export function inventorySha256(entries: BlobInventoryEntry[]): string { return createHash('sha256').update(JSON.stringify(entries)).digest('hex'); }

/** Scan every persisted JSON column, not just current versions or unexpired uploads.
 * Receipts/outbox/history can retain references after the corresponding live row is gone.
 * Unknown/malformed objectKey references fail closed rather than silently dropping bytes.
 */
export async function inventoryBlobReferences(sql: SqlExecutor): Promise<BlobInventoryEntry[]> {
  const entries = new Map<string, BlobInventoryEntry>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value === null || typeof value !== 'object') return;
    if ('objectKey' in value) {
      const result = blobInventoryEntrySchema.safeParse({ key: value.objectKey, ...('storageId' in value && value.storageId !== undefined ? { storageId: value.storageId } : {}), sha256: 'sha256' in value ? value.sha256 : undefined, size: 'size' in value ? value.size : undefined, references: 1 });
      if (!result.success) throw new DomainError('blob_inventory_invalid_reference', 'Persistent blob reference lacks valid key/digest/size', 503);
      const entry = result.data;
      if ('contentDigest' in value && value.contentDigest !== entry.sha256) throw new DomainError('blob_inventory_invalid_reference', 'Persistent content digest disagrees', 503);
      const prior = entries.get(entry.key);
      if (prior && (prior.sha256 !== entry.sha256 || prior.size !== entry.size)) throw new DomainError('blob_inventory_invalid_reference', 'Persistent references disagree', 503);
      if (prior) {
        if (prior.storageId && entry.storageId && prior.storageId !== entry.storageId) throw new DomainError('blob_inventory_invalid_reference', 'Object has conflicting immutable storage identities', 503);
        if (!prior.storageId && entry.storageId) prior.storageId = entry.storageId;
        prior.references += 1;
      } else entries.set(entry.key, entry);
    }
    for (const item of Object.values(value)) visit(item);
  }
  const columns = await sql.query<{ table_name: string; column_name: string }>("SELECT c.table_name,c.column_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name WHERE c.table_schema=current_schema() AND t.table_type='BASE TABLE' AND c.data_type IN ('json','jsonb') ORDER BY c.table_name,c.column_name");
  const visible = new Set(columns.rows.map(column => `${column.table_name}.${column.column_name}`));
  if (['entities.data', 'command_receipts.receipt', 'outbox.payload', 'events.envelope', 'dashboard_records.data'].some(column => !visible.has(column))) throw new DomainError('blob_inventory_unknown_schema', 'Maintenance identity cannot inventory every required reference source', 503);
  const scalarKeys = await sql.query<{ table_name: string; column_name: string }>("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND column_name IN ('object_key','blob_key')");
  if (scalarKeys.rows.some(column => column.table_name !== 'project_blob_object_routes' || column.column_name !== 'object_key')) throw new DomainError('blob_inventory_unknown_schema', 'Additional scalar blob references require explicit inventory support', 503);
  for (const column of columns.rows) {
    if (!/^[a-z_][a-z0-9_]*$/.test(column.table_name) || !/^[a-z_][a-z0-9_]*$/.test(column.column_name)) throw new DomainError('blob_inventory_unknown_schema', 'Unsafe schema identifier', 503);
    // Keyset cursor is not universal across these tables. PostgreSQL cursor bounds resident row memory.
    const cursor = `pm_blob_inventory_${column.table_name}_${column.column_name}`;
    await sql.query(`DECLARE "${cursor}" NO SCROLL CURSOR FOR SELECT "${column.column_name}" AS value FROM "${column.table_name}"`);
    try {
      for (;;) {
        const page = await sql.query<{ value: unknown }>(`FETCH FORWARD 200 FROM "${cursor}"`);
        if (!page.rows.length) break;
        for (const row of page.rows) visit(row.value);
      }
    } finally { await sql.query(`CLOSE "${cursor}"`); }
  }
  if (scalarKeys.rows.length) {
    const routes = await sql.query<{ object_key: string; storage_id: string; sha256: string; size: number }>('SELECT object_key,storage_id,sha256,size FROM project_blob_object_routes ORDER BY object_key');
    for (const route of routes.rows) {
      const prior = entries.get(route.object_key);
      visit({ objectKey: route.object_key, ...(!prior ? { storageId: route.storage_id } : {}), sha256: route.sha256, size: route.size });
    }
  }
  return [...entries.values()].sort((a, b) => a.key.localeCompare(b.key, 'en'));
}
export async function verifyInventoryObjects(store: BlobStore, entries: BlobInventoryEntry[]): Promise<void> {
  for (const entry of entries) {
    blobInventoryEntrySchema.parse(entry);
    const bytes = await store.read(entry.key);
    if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new DomainError('blob_integrity_error', 'Inventory object differs from persistent reference', 503);
  }
}
