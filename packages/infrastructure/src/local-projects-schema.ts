import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users, workspaces } from './schema.ts';

export const localProjectSettings = pgTable('local_project_settings', {
  workspaceId: uuid('workspace_id').primaryKey().references(() => workspaces.id),
  defaultParent: text('default_parent').notNull(),
  updatedBy: uuid('updated_by').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [check('local_project_settings_default_parent_check', sql`length(${table.defaultParent}) BETWEEN 1 AND 4096`)]);

/** 0030 additionally enforces immutable request/reserved identity with a SQL trigger. This is recovery input, not project content authority. */
export const localProjectOperations = pgTable('local_project_operations', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  requestKey: text('request_key').notNull(),
  operation: text('operation').$type<'initialize' | 'migrate' | 'relocate'>().notNull(),
  transport: text('transport').$type<'native' | 'command'>().notNull(),
  requestHash: text('request_hash').notNull(),
  request: jsonb('request').$type<Record<string, unknown>>().notNull(),
  projectId: text('project_id'),
  status: text('status').$type<'pending' | 'ready' | 'rejected'>().notNull().default('pending'),
  errorCode: text('error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [
  primaryKey({ columns: [table.workspaceId, table.actorId, table.requestKey] }),
  check('local_project_operations_request_key_check', sql`length(${table.requestKey}) BETWEEN 1 AND 512`),
  check('local_project_operations_operation_check', sql`${table.operation} IN ('initialize','migrate','relocate')`),
  check('local_project_operations_transport_check', sql`${table.transport} IN ('native','command')`),
  check('local_project_operations_request_hash_check', sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`),
  check('local_project_operations_request_check', sql`jsonb_typeof(${table.request})='object'`),
  check('local_project_operations_status_check', sql`${table.status} IN ('pending','ready','rejected')`),
  check('local_project_operations_check', sql`${table.operation}='initialize' OR ${table.projectId} IS NOT NULL`),
]);
