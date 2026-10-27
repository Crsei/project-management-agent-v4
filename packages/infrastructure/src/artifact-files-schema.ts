import { check, foreignKey, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { commandReceipts, entities, users, workspaces } from './schema.ts';

/** SQL 0025 owns deferred enforcement and immutable/restore-safe triggers. */
export const artifactCopyOrigins = pgTable('artifact_copy_origins', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  targetArtifactVersionId: uuid('target_artifact_version_id').notNull(),
  targetArtifactId: uuid('target_artifact_id').notNull(), targetProjectId: text('target_project_id').notNull(),
  sourceArtifactId: uuid('source_artifact_id').notNull(), sourceArtifactVersionId: uuid('source_artifact_version_id').notNull(),
  sourceProjectId: text('source_project_id').notNull(), copiedBy: uuid('copied_by').notNull().references(() => users.id),
  commandId: uuid('command_id').notNull(), copiedAt: timestamp('copied_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  primaryKey({ name: 'artifact_copy_origin_primary', columns: [t.workspaceId, t.targetArtifactVersionId] }),
  unique('artifact_copy_origin_command_unique').on(t.workspaceId, t.copiedBy, t.commandId),
  check('artifact_copy_origin_independent', sql`${t.targetArtifactId} <> ${t.sourceArtifactId} AND ${t.targetArtifactVersionId} <> ${t.sourceArtifactVersionId}`),
  foreignKey({ name: 'artifact_copy_origin_target_version', columns: [t.workspaceId, t.targetArtifactVersionId], foreignColumns: [entities.workspaceId, entities.id] }),
  foreignKey({ name: 'artifact_copy_origin_target_artifact', columns: [t.workspaceId, t.targetArtifactId], foreignColumns: [entities.workspaceId, entities.id] }),
  foreignKey({ name: 'artifact_copy_origin_source_version', columns: [t.workspaceId, t.sourceArtifactVersionId], foreignColumns: [entities.workspaceId, entities.id] }),
  foreignKey({ name: 'artifact_copy_origin_source_artifact', columns: [t.workspaceId, t.sourceArtifactId], foreignColumns: [entities.workspaceId, entities.id] }),
  foreignKey({ name: 'artifact_copy_origin_receipt', columns: [t.workspaceId, t.copiedBy, t.commandId], foreignColumns: [commandReceipts.workspaceId, commandReceipts.actorId, commandReceipts.commandId] }),
]);
