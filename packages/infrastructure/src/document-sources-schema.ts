import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users, workspaces } from './schema.ts';

export const documentSourceScopes = pgTable('document_source_scopes', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id), projectKey: text('project_key').notNull().default(''),
  revision: integer('revision').notNull(), updatedBy: uuid('updated_by').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [
  primaryKey({ columns: [table.workspaceId, table.projectKey] }),
  check('document_source_scopes_project_key_check', sql`${table.projectKey}='' OR ${table.projectKey} ~ '^PRJ-[0-9]+$'`),
  check('document_source_scopes_revision_check', sql`${table.revision}>0`),
]);
export const documentSources = pgTable('document_sources', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id), sourceId: text('source_id').notNull(),
  projectKey: text('project_key').notNull().default(''),
  path: text('path'), directoryDevice: text('directory_device'), directoryInode: text('directory_inode'),
  revision: integer('revision').notNull(), updatedBy: uuid('updated_by').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, table => [
  primaryKey({ columns: [table.workspaceId, table.sourceId] }),
  uniqueIndex('document_sources_active_scope_path').on(table.workspaceId, table.projectKey, table.path).where(sql`${table.removedAt} IS NULL`),
  check('document_sources_source_id_check', sql`length(${table.sourceId}) BETWEEN 1 AND 200 AND ${table.sourceId} ~ '^[A-Za-z0-9_-]+$'`),
  check('document_sources_project_key_check', sql`${table.projectKey}='' OR ${table.projectKey} ~ '^PRJ-[0-9]+$'`),
  check('document_sources_revision_check', sql`${table.revision}>0`),
  check('document_sources_active_path_check', sql`${table.removedAt} IS NOT NULL OR ${table.path} IS NOT NULL`),
  check('document_sources_identity_check', sql`(${table.path} IS NULL AND ${table.directoryDevice} IS NULL AND ${table.directoryInode} IS NULL) OR (${table.path} IS NOT NULL AND ${table.directoryDevice} IS NOT NULL AND ${table.directoryInode} IS NOT NULL AND length(${table.path}) BETWEEN 1 AND 4096 AND (left(${table.path},1)='/' OR (left(${table.path},1) ~ '^[A-Za-z]$' AND substring(${table.path},2,1)=':' AND substring(${table.path},3,1) IN ('/',chr(92)))) AND ${table.directoryDevice} ~ '^[0-9]+$' AND ${table.directoryInode} ~ '^[0-9]+$')`),
]);

export const documentSourceOperations = pgTable('document_source_operations', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  actorId: uuid('actor_id').notNull().references(() => users.id), operationId: uuid('operation_id').notNull(),
  sourceId: text('source_id').notNull(), sourceProjectKey: text('source_project_key').notNull(), requestHash: text('request_hash').notNull(),
  request: jsonb('request').$type<Record<string, unknown>>().notNull(),
  status: text('status').$type<'prepared' | 'applying' | 'succeeded' | 'not_applied' | 'unknown'>().notNull().default('prepared'),
  receipt: jsonb('receipt').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [
  primaryKey({ columns: [table.workspaceId, table.actorId, table.operationId] }),
  check('document_source_operations_source_id_check', sql`length(${table.sourceId}) BETWEEN 1 AND 200 AND ${table.sourceId} ~ '^[A-Za-z0-9_-]+$'`),
  check('document_source_operations_project_key_check', sql`${table.sourceProjectKey}='' OR ${table.sourceProjectKey} ~ '^PRJ-[0-9]+$'`),
  check('document_source_operations_request_hash_check', sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`),
  check('document_source_operations_request_check', sql`jsonb_typeof(${table.request})='object'`),
  check('document_source_operations_status_check', sql`${table.status} IN ('prepared','applying','succeeded','not_applied','unknown')`),
  check('document_source_operations_receipt_check', sql`(${table.status} IN ('succeeded','not_applied')) = (${table.receipt} IS NOT NULL)`),
]);
