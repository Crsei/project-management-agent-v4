import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { ChangeHistoryTarget, ChangeSnapshot, ChangeSummary } from '../../contracts/src/change-history.ts';
import type { ExternalDocumentHistoryAddress } from './document-source-history.ts';
import { users, workspaces } from './schema.ts';

export const changeHistoryStreams = pgTable('change_history_streams', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id), streamKey: text('stream_key').notNull(),
  target: jsonb('target').$type<ChangeHistoryTarget>().notNull(), address: jsonb('address').$type<ExternalDocumentHistoryAddress>(),
}, table => [primaryKey({ columns: [table.workspaceId, table.streamKey] })]);
export const changeHistoryAliases = pgTable('change_history_aliases', {
  workspaceId: uuid('workspace_id').notNull(), aliasKey: text('alias_key').notNull(), streamKey: text('stream_key').notNull(), address: jsonb('address').$type<ExternalDocumentHistoryAddress>(),
}, table => [primaryKey({ columns: [table.workspaceId, table.aliasKey] }), foreignKey({ columns: [table.workspaceId, table.streamKey], foreignColumns: [changeHistoryStreams.workspaceId, changeHistoryStreams.streamKey] })]);
/** Private immutable content; never exported through audit/outbox or notification projections. */
export const changeHistoryEntries = pgTable('change_history_entries', {
  workspaceId: uuid('workspace_id').notNull(), changeId: uuid('change_id').notNull(), sequence: bigint('sequence', { mode: 'bigint' }).notNull(), streamKey: text('stream_key').notNull(),
  sourceKey: text('source_key').notNull(), sourceDigest: text('source_digest').notNull(), target: jsonb('target').$type<ChangeHistoryTarget>().notNull(), entityKind: text('entity_kind').notNull(), projectId: text('project_id'),
  changeKinds: text('change_kinds').array().notNull(), changedFields: text('changed_fields').array().notNull(), origin: text('origin').$type<ChangeSummary['origin']>().notNull(), actorId: uuid('actor_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }), observedAt: timestamp('observed_at', { withTimezone: true }).notNull(), completeness: text('completeness').$type<ChangeSummary['completeness']>().notNull(),
  beforeSnapshot: jsonb('before_snapshot').$type<ChangeSnapshot>(), afterSnapshot: jsonb('after_snapshot').$type<ChangeSnapshot>(), beforeAddress: jsonb('before_address').$type<ExternalDocumentHistoryAddress>(), afterAddress: jsonb('after_address').$type<ExternalDocumentHistoryAddress>(),
  beforeRevision: text('before_revision'), afterRevision: text('after_revision'), beforeProject: text('before_project'),
}, table => [primaryKey({ columns: [table.workspaceId, table.changeId] }), unique('change_history_entries_workspace_id_sequence_key').on(table.workspaceId, table.sequence), unique('change_history_entries_workspace_id_source_key_key').on(table.workspaceId, table.sourceKey),
  foreignKey({ columns: [table.workspaceId, table.streamKey], foreignColumns: [changeHistoryStreams.workspaceId, changeHistoryStreams.streamKey] }), index('change_history_target_page').on(table.workspaceId, table.streamKey, table.sequence),
  check('change_history_sequence_positive', sql`${table.sequence}>0`), check('change_history_origin', sql`${table.origin} IN ('manual','agent','automation','observation')`), check('change_history_completeness', sql`${table.completeness} IN ('exact','observed_endpoints','baseline','missing_before')`),
]);
export const changeHistoryCursors = pgTable('change_history_cursors', {
  workspaceId: uuid('workspace_id').notNull(), actorId: uuid('actor_id').notNull().references(() => users.id), targetKey: text('target_key').notNull(), reviewedThrough: bigint('reviewed_through', { mode: 'bigint' }).notNull().default(0n),
}, table => [primaryKey({ columns: [table.workspaceId, table.actorId, table.targetKey] }), check('change_history_reviewed_nonnegative', sql`${table.reviewedThrough}>=0`)]);
export const changeHistoryObservations = pgTable('change_history_observations', {
  token: uuid('token').primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id), actorId: uuid('actor_id').notNull().references(() => users.id), targetKey: text('target_key').notNull(),
  throughSequence: bigint('through_sequence', { mode: 'bigint' }).notNull(), includesRelated: boolean('includes_related').notNull(), scopeDigest: text('scope_digest').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [index('change_history_observations_owner').on(table.workspaceId, table.actorId, table.targetKey), check('change_history_observed_nonnegative', sql`${table.throughSequence}>=0`)]);
