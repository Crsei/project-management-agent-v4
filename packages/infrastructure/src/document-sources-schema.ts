import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users, workspaces } from './schema.ts';

export const documentSources = pgTable('document_sources', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  projectKey: text('project_key').notNull().default(''),
  path: text('path'), directoryDevice: text('directory_device'), directoryInode: text('directory_inode'),
  revision: integer('revision').notNull(), updatedBy: uuid('updated_by').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [
  primaryKey({ columns: [table.workspaceId, table.projectKey] }),
  check('document_sources_project_key_check', sql`${table.projectKey}='' OR ${table.projectKey} ~ '^PRJ-[0-9]+$'`),
  check('document_sources_revision_check', sql`${table.revision}>0`),
  check('document_sources_identity_check', sql`(${table.path} IS NULL AND ${table.directoryDevice} IS NULL AND ${table.directoryInode} IS NULL) OR (${table.path} IS NOT NULL AND ${table.directoryDevice} IS NOT NULL AND ${table.directoryInode} IS NOT NULL AND length(${table.path}) BETWEEN 1 AND 4096 AND left(${table.path},1)='/' AND ${table.directoryDevice} ~ '^[0-9]+$' AND ${table.directoryInode} ~ '^[0-9]+$')`),
]);
