import { bigint, bigserial, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ProjectAuditChange, ProjectAuditEntry } from '../../domain/src/project-audit.ts';
export { artifactCopyOrigins } from './artifact-files-schema.ts';
export * from './notification-schema.ts';
export { accountRecoveryTokens, accountRecoveryMailQueue, accountRecoveryRequests, accountPasswordResetActions } from './account-recovery-schema.ts';
export { blobStorageBinding, blobStorageOperations, projectBlobStores, projectBlobObjectRoutes, blobStoreAliases, localProjectStorageOperations } from './blob-storage-schema.ts';
export * from './webhook-schema.ts';
export { localProjectSettings, localProjectOperations } from './local-projects-schema.ts';
export { agentFileAreas, agentStorageSettings } from './agent-file-areas-schema.ts';
export { documentSources } from './document-sources-schema.ts';

export const users = pgTable('users', {
  id: uuid('id').primaryKey(), email: text('email').notNull().unique(), name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  timeZone: text('time_zone').notNull().default('UTC'), profileVersion: integer('profile_version').notNull().default(1),
  profileUpdatedAt: timestamp('profile_updated_at', { withTimezone: true }).notNull().defaultNow(),
  jobTitle: text('job_title'), phone: text('phone'), avatarDataUrl: text('avatar_data_url'),
  credentialVersion: integer('credential_version').notNull().default(1),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  recoveryEmail: text('recovery_email').unique(),
  recoveryEmailVerifiedAt: timestamp('recovery_email_verified_at', { withTimezone: true }),
  recoveryEmailVersion: integer('recovery_email_version').notNull().default(1),
});
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(), name: text('name').notNull(), ownerId: uuid('owner_id').notNull().references(() => users.id),
  icon: text('icon').notNull().default('building'), color: text('color').notNull().default('#2F2E2A'),
  identityVersion: integer('identity_version').notNull().default(1),
  identityUpdatedAt: timestamp('identity_updated_at', { withTimezone: true }).notNull().defaultNow(),
  streamCursor: bigint('stream_cursor', { mode: 'bigint' }).notNull().default(0n),
  serviceFactHead: bigint('service_fact_head', { mode: 'bigint' }).notNull().default(0n),
  notificationHead: bigint('notification_head', { mode: 'bigint' }).notNull().default(0n),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const memberships = pgTable('memberships', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id), userId: uuid('user_id').notNull().references(() => users.id),
  capabilities: text('capabilities').array().notNull(), projectIds: text('project_ids').array(),
  version: integer('version').notNull().default(1), revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), check('membership_version_positive', sql`${t.version} > 0`)]);
export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(), userId: uuid('user_id').notNull().references(() => users.id),
  id: uuid('id').notNull().defaultRandom().unique('sessions_id_unique'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expiry_idx').on(t.expiresAt)]);
export const entities = pgTable('entities', {
  id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id), projectId: text('project_id'),
  kind: text('kind').notNull(), version: integer('version').notNull().default(1), data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
}, (t) => [unique('entities_workspace_id_unique').on(t.workspaceId, t.id),
  index('entities_scope_kind_idx').on(t.workspaceId, t.kind, t.projectId, t.id), check('entity_version_positive', sql`${t.version} > 0`),
  check('entity_data_object', sql`jsonb_typeof(${t.data}) = 'object'`)]);
export const dashboardRecords = pgTable('dashboard_records', {
  id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id), projectId: text('project_id'),
  kind: text('kind').notNull(), ownerId: uuid('owner_id').references(() => users.id), version: integer('version').notNull().default(1),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
}, (t) => [unique('dashboard_records_workspace_id_unique').on(t.workspaceId, t.id),
  index('dashboard_records_scope_kind_idx').on(t.workspaceId, t.kind, t.projectId, t.ownerId, t.id),
  check('dashboard_record_version_positive', sql`${t.version} > 0`), check('dashboard_record_data_object', sql`jsonb_typeof(${t.data}) = 'object'`)]);
export const projectAudit = pgTable('project_audit', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  projectId: text('project_id').notNull(), source: text('source').$type<ProjectAuditEntry['source']>().notNull(),
  commandId: text('command_id').notNull(), action: text('action').notNull(), actorId: uuid('actor_id').notNull().references(() => users.id),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  targetId: text('target_id').notNull(), targetKind: text('target_kind').notNull(), beforeVersion: text('before_version'), afterVersion: text('after_version'),
  changes: jsonb('changes').$type<ProjectAuditChange[]>().notNull(), audienceActorId: uuid('audience_actor_id').references(() => users.id),
  dedupeKey: text('dedupe_key').notNull(),
}, (t) => [unique('project_audit_command_fact_unique').on(t.workspaceId, t.actorId, t.commandId, t.source, t.dedupeKey),
  index('project_audit_project_page_idx').on(t.workspaceId, t.projectId, t.id.desc()),
  check('project_audit_private_actor', sql`${t.audienceActorId} IS NULL OR ${t.audienceActorId} = ${t.actorId}`),
  check('project_audit_changes_check', sql`pm_project_audit_safe_changes(${t.changes})`)]);
export const commandReceipts = pgTable('command_receipts', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id), actorId: uuid('actor_id').notNull().references(() => users.id), commandId: uuid('command_id').notNull(),
  commandType: text('command_type').notNull(), requestHash: text('request_hash').notNull(), projectId: text('project_id'),
  scopeProjectIds: text('scope_project_ids').array().notNull().default(sql`'{}'::text[]`), workspaceScope: integer('workspace_scope').notNull().default(0),
  actorScope: integer('actor_scope').notNull().default(0),
  receipt: jsonb('receipt').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.actorId, t.commandId] })]);
export const outbox = pgTable('outbox', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), eventId: uuid('event_id').notNull().unique(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  projectId: text('project_id'), aggregateId: uuid('aggregate_id').notNull(), aggregateKind: text('aggregate_kind').notNull(), aggregateVersion: integer('aggregate_version').notNull(),
  aggregateSequence: bigint('aggregate_sequence', { mode: 'bigint' }).notNull(), eventType: text('event_type').notNull(), payload: jsonb('payload').notNull(),
  actorId: uuid('actor_id').notNull().references(() => users.id), commandId: uuid('command_id').notNull(),
  audienceActorId: uuid('audience_actor_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), publishedAt: timestamp('published_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0), lastError: text('last_error'),
}, (t) => [unique('outbox_aggregate_sequence_unique').on(t.workspaceId, t.aggregateId, t.aggregateSequence), index('outbox_unpublished_idx').on(t.workspaceId, t.id).where(sql`${t.publishedAt} IS NULL`)]);
export const events = pgTable('events', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id), cursor: bigint('cursor', { mode: 'bigint' }).notNull(), eventId: uuid('event_id').notNull().unique(),
  envelope: jsonb('envelope').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  audienceActorId: uuid('audience_actor_id').references(() => users.id),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.cursor] }), unique('events_workspace_event_unique').on(t.workspaceId, t.eventId), index('events_retention_idx').on(t.createdAt), index('events_actor_scope_idx').on(t.workspaceId, t.audienceActorId, t.cursor)]);
export const serviceHeartbeats = pgTable('service_heartbeats', {
  id: text('id').primaryKey(), role: text('role').notNull(), heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
  details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
});

export const accountSecurityActions = pgTable('account_security_actions', {
  userId: uuid('user_id').notNull().references(() => users.id), actionId: uuid('action_id').notNull(),
  kind: text('kind').notNull(), status: text('status').notNull(), credentialVersion: integer('credential_version').notNull(),
  revokedCount: integer('revoked_count').notNull().default(0), errorCode: text('error_code'), httpStatus: integer('http_status').notNull(),
  recoveryEmailVersion: integer('recovery_email_version').notNull().default(1),
  challengeId: uuid('challenge_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (t) => [primaryKey({ columns: [t.userId, t.actionId] })]);
export const accountAuthLimits = pgTable('account_auth_limits', {
  key: text('key').primaryKey(), attempts: integer('attempts').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [index('account_auth_limits_expiry_idx').on(t.expiresAt)]);
export const taskComments = pgTable('task_comments', {
  id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  projectId: text('project_id').notNull(), taskId: text('task_id').notNull(), authorId: uuid('author_id').notNull().references(() => users.id),
  version: integer('version').notNull().default(1), content: text('content').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (t) => [
  unique('task_comments_workspace_id_id_key').on(t.workspaceId, t.id),
  index('task_comments_task_page_idx').on(t.workspaceId, t.projectId, t.taskId, t.id),
]);
export const taskCommentRevisions = pgTable('task_comment_revisions', {
  workspaceId: uuid('workspace_id').notNull(), commentId: uuid('comment_id').notNull(), version: integer('version').notNull(),
  action: text('action').notNull(), content: text('content').notNull(), actorId: uuid('actor_id').notNull().references(() => users.id),
  commandId: uuid('command_id').notNull(), occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.commentId, t.version] }),
  unique('task_comment_revisions_workspace_id_actor_id_command_id_key').on(t.workspaceId, t.actorId, t.commandId),
  foreignKey({ columns: [t.workspaceId, t.commentId], foreignColumns: [taskComments.workspaceId, taskComments.id] }),
]);
