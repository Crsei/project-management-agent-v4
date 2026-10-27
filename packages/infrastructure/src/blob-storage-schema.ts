import { bigint, boolean, check, foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { StorageBinding } from './blob-storage-binding.ts';
import { workspaces } from './schema.ts';

export const blobStorageBinding = pgTable('blob_storage_binding', {
  singleton: boolean('singleton').primaryKey().default(true), storeId: uuid('store_id').notNull(),
  provider: text('provider').$type<'local' | 's3'>().notNull(), locatorSha256: text('locator_sha256').notNull(),
  epoch: bigint('epoch', { mode: 'bigint' }).notNull(), state: text('state').$type<'active' | 'migrating'>().notNull(),
  verifiedManifestSha256: text('verified_manifest_sha256'), verifiedAt: timestamp('verified_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  check('blob_storage_binding_singleton_check', sql`${t.singleton}`),
  check('blob_storage_binding_provider_check', sql`${t.provider} IN ('local','s3')`),
  check('blob_storage_binding_locator_sha256_check', sql`${t.locatorSha256} ~ '^[a-f0-9]{64}$'`),
  check('blob_storage_binding_epoch_check', sql`${t.epoch} > 0`),
  check('blob_storage_binding_state_check', sql`${t.state} IN ('active','migrating')`),
  check('blob_storage_binding_verified_manifest_sha256_check', sql`${t.verifiedManifestSha256} ~ '^[a-f0-9]{64}$'`),
  check('blob_storage_binding_check', sql`(${t.verifiedManifestSha256} IS NULL) = (${t.verifiedAt} IS NULL)`),
]);
export const blobStorageOperations = pgTable('blob_storage_operations', {
  operationId: uuid('operation_id').primaryKey(),
  operationKind: text('operation_kind').$type<'bind_new' | 'bind_adopt' | 'migrate' | 'activate' | 'restore_rebind' | 'resume_source'>().notNull(),
  expectedEpoch: bigint('expected_epoch', { mode: 'bigint' }).notNull(), sourceBinding: jsonb('source_binding').$type<StorageBinding | null>(),
  targetBinding: jsonb('target_binding').$type<Record<string, unknown>>().notNull(), manifestSha256: text('manifest_sha256').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  check('blob_storage_operations_operation_kind_check', sql`${t.operationKind} IN ('bind_new','bind_adopt','migrate','activate','restore_rebind','resume_source')`),
  check('blob_storage_operations_expected_epoch_check', sql`${t.expectedEpoch} >= 0`),
  check('blob_storage_operations_manifest_sha256_check', sql`${t.manifestSha256} ~ '^[a-f0-9]{64}$'`),
]);
// SQL migration 0028 owns the immutable-history UPDATE/DELETE trigger.

/** Paths are deliberately absent: the core project registry alone owns physical locations. */
export const projectBlobStores = pgTable('project_blob_stores', {
  storageId: uuid('storage_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  projectId: text('project_id').notNull(),
  state: text('state').$type<'active' | 'migrating'>().notNull().default('active'),
}, table => [
  unique().on(table.workspaceId, table.projectId),
  unique().on(table.storageId, table.workspaceId, table.projectId),
  check('project_blob_stores_state_check', sql`${table.state} IN ('active','migrating')`),
]);
export const projectBlobObjectRoutes = pgTable('project_blob_object_routes', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  projectId: text('project_id').notNull(), objectKey: text('object_key').notNull(),
  storageId: uuid('storage_id').notNull(), sha256: text('sha256').notNull(), size: integer('size').notNull(),
}, table => [
  primaryKey({ columns: [table.workspaceId, table.projectId, table.objectKey] }),
  foreignKey({ columns: [table.storageId, table.workspaceId, table.projectId], foreignColumns: [projectBlobStores.storageId, projectBlobStores.workspaceId, projectBlobStores.projectId] }),
  check('project_blob_object_routes_object_key_check', sql`${table.objectKey} ~ '^sha256-[a-f0-9]{64}-[a-f0-9-]{36}\\.blob$'`),
  check('project_blob_object_routes_sha256_check', sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
  check('project_blob_object_routes_size_check', sql`${table.size} BETWEEN 0 AND 8388608`),
]);
export const blobStoreAliases = pgTable('blob_store_aliases', {
  storageId: uuid('storage_id').primaryKey(), targetStoreId: uuid('target_store_id').notNull(),
}, table => [check('blob_store_aliases_check', sql`${table.storageId} <> ${table.targetStoreId}`)]);
export const localProjectStorageOperations = pgTable('local_project_storage_operations', {
  operationId: uuid('operation_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  projectId: text('project_id').notNull(),
  operationKind: text('operation_kind').$type<'migrate' | 'relocate' | 'rebind' | 'restore'>().notNull(),
  targetRoot: text('target_root').notNull(),
  phase: text('phase').$type<'prepared' | 'core_committed' | 'copied' | 'completed'>().notNull(),
  manifest: jsonb('manifest').notNull(), manifestSha256: text('manifest_sha256').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [
  uniqueIndex('local_project_storage_pending').on(table.workspaceId, table.projectId).where(sql`${table.phase} <> 'completed'`),
  check('local_project_storage_operations_operation_kind_check', sql`${table.operationKind} IN ('migrate','relocate','rebind','restore')`),
  check('local_project_storage_operations_phase_check', sql`${table.phase} IN ('prepared','core_committed','copied','completed')`),
  check('local_project_storage_operations_manifest_sha256_check', sql`${table.manifestSha256} ~ '^[a-f0-9]{64}$'`),
]);
