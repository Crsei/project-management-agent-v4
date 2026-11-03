import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users, workspaces } from './schema.ts';

export const agentFileAreas = pgTable('agent_file_areas', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  projectKey: text('project_key').notNull().default(''),
  path: text('path').notNull(),
  source: text('source').notNull().default('explicit'),
  directoryDevice: text('directory_device').notNull(),
  directoryInode: text('directory_inode').notNull(),
  revision: integer('revision').notNull(),
  updatedBy: uuid('updated_by').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [
  primaryKey({ columns: [table.workspaceId, table.projectKey] }),
  check('agent_file_areas_path_check', sql`length(${table.path}) BETWEEN 1 AND 4096 AND (left(${table.path},1)='/' OR (left(${table.path},1) ~ '^[A-Za-z]$' AND substring(${table.path},2,1)=':' AND substring(${table.path},3,1) IN ('/',chr(92))))`),
  check('agent_file_areas_source_check', sql`${table.source} IN ('explicit','default')`),
  check('agent_file_areas_directory_device_check', sql`${table.directoryDevice} ~ '^[0-9]+$'`),
  check('agent_file_areas_directory_inode_check', sql`${table.directoryInode} ~ '^[0-9]+$'`),
  check('agent_file_areas_revision_check', sql`${table.revision}>0`),
  check('agent_file_areas_project_key_check', sql`${table.projectKey}='' OR ${table.projectKey} ~ '^PRJ-[0-9]+$'`),
]);

export const agentStorageSettings = pgTable('agent_storage_settings', {
  workspaceId: uuid('workspace_id').primaryKey().references(() => workspaces.id),
  defaultRoot: text('default_root').notNull(),
  revision: integer('revision').notNull(),
  updatedBy: uuid('updated_by').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [
  check('agent_storage_settings_root_check', sql`length(${table.defaultRoot}) BETWEEN 1 AND 4096 AND (left(${table.defaultRoot},1)='/' OR (left(${table.defaultRoot},1) ~ '^[A-Za-z]$' AND substring(${table.defaultRoot},2,1)=':' AND substring(${table.defaultRoot},3,1) IN ('/',chr(92))))`),
  check('agent_storage_settings_revision_check', sql`${table.revision}>0`),
]);
