import { z } from "zod"
import {
  WorkspaceCapabilitiesSchema, WorkspaceErrorSchema, WorkspaceIdSchema,
  WorkspaceSchemaVersionSchema, WorkspaceVersionSchema,
} from "./primitives.ts"
import {
  WorkspaceDraftSchema, WorkspaceMessageSchema, WorkspaceProjectSchema,
  WorkspaceResourceReferenceSchema, WorkspaceResourceSchema, WorkspaceSchema, WorkspaceSessionSchema,
  WorkspaceSettingsSchema, WorkspaceSkillSchema, WorkspaceTerminalSchema,
} from "./entities.ts"
import { WorkspaceOperationReceiptSchema } from "./operations.ts"
import { WorkspaceCursorSchema, WorkspaceSnapshotSchema } from "./events.ts"
import { ImportCandidateSchema } from "./commands.ts"

export const WorkspaceHealthSchema = z.strictObject({
  schemaVersion: WorkspaceSchemaVersionSchema,
  status: z.enum(["ready", "degraded", "unavailable"]),
  storage: z.enum(["ready", "read-only", "unavailable"]),
  adapter: z.enum(["ready", "starting", "unavailable"]),
  authentication: z.enum(["authenticated", "required", "unavailable"]),
  version: WorkspaceIdSchema.nullable(),
}).superRefine((health, context) => {
  if (health.status === "ready" && (health.storage !== "ready" || health.adapter !== "ready" || health.authentication !== "authenticated")) {
    context.addIssue({ code: "custom", path: ["status"], message: "Ready requires writable storage, a ready adapter, and runtime authentication." })
  }
})
export type WorkspaceHealth = z.infer<typeof WorkspaceHealthSchema>
export const WorkspaceErrorResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, error: WorkspaceErrorSchema })
export const WorkspaceCapabilitiesResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, capabilities: WorkspaceCapabilitiesSchema })
export const WorkspaceProjectsResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, projects: z.array(WorkspaceProjectSchema), workspaces: z.array(WorkspaceSchema) })
export const WorkspaceSessionsQuerySchema = z.strictObject({ workspaceId: WorkspaceIdSchema, cursor: WorkspaceIdSchema.optional(), limit: z.number().int().min(1).max(200).optional(), archived: z.boolean().optional() })
export const WorkspaceSessionsResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, sessions: z.array(WorkspaceSessionSchema), nextCursor: WorkspaceIdSchema.nullable() })
export const WorkspaceSnapshotResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, snapshot: WorkspaceSnapshotSchema })
export const WorkspaceHistoryQuerySchema = z.strictObject({ sessionId: WorkspaceIdSchema, before: WorkspaceIdSchema.optional(), limit: z.number().int().min(1).max(200).optional() })
export const WorkspaceHistoryResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, sessionId: WorkspaceIdSchema, messages: z.array(WorkspaceMessageSchema), nextCursor: WorkspaceIdSchema.nullable(), watermark: WorkspaceCursorSchema }).superRefine((page, context) => {
  if (page.messages.some((message) => message.sessionId !== page.sessionId) || new Set(page.messages.map((message) => message.messageId)).size !== page.messages.length) {
    context.addIssue({ code: "custom", path: ["messages"], message: "History page must have unique messages belonging to its session." })
  }
})
export const WorkspaceOperationResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, receipt: WorkspaceOperationReceiptSchema })
export const WorkspaceDraftResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, draft: WorkspaceDraftSchema.nullable() })
export const WorkspaceDraftConflictResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, error: WorkspaceErrorSchema, current: WorkspaceDraftSchema })
export const WorkspaceResourceQuerySchema = z.strictObject({ workspaceId: WorkspaceIdSchema, sessionId: WorkspaceIdSchema.optional(), relativePath: z.string().optional(), cursor: WorkspaceIdSchema.optional(), limit: z.number().int().min(1).max(200).optional() })
export const WorkspaceResourcesResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, resources: z.array(WorkspaceResourceSchema), nextCursor: WorkspaceIdSchema.nullable() })
export const WorkspaceFileContentResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, reference: WorkspaceResourceReferenceSchema, text: z.string(), encoding: z.literal("utf-8"), truncated: z.boolean(), fullSizeBytes: WorkspaceVersionSchema })
export const WorkspaceUploadResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, receipt: WorkspaceOperationReceiptSchema, reference: WorkspaceResourceReferenceSchema })
export const WorkspaceImportCandidatesResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, candidates: z.array(ImportCandidateSchema) })
export const WorkspaceEventsQuerySchema = z.strictObject({ sessionId: WorkspaceIdSchema, cursor: WorkspaceCursorSchema.optional() })
export const WorkspaceResyncResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, reason: z.enum(["cursor-expired", "slow-consumer", "epoch-changed"]), snapshot: WorkspaceSnapshotSchema })
export type WorkspaceErrorResponse = z.infer<typeof WorkspaceErrorResponseSchema>
export type WorkspaceCapabilitiesResponse = z.infer<typeof WorkspaceCapabilitiesResponseSchema>
export type WorkspaceProjectsResponse = z.infer<typeof WorkspaceProjectsResponseSchema>
export type WorkspaceSessionsQuery = z.infer<typeof WorkspaceSessionsQuerySchema>
export type WorkspaceSessionsResponse = z.infer<typeof WorkspaceSessionsResponseSchema>
export type WorkspaceSnapshotResponse = z.infer<typeof WorkspaceSnapshotResponseSchema>
export type WorkspaceHistoryQuery = z.infer<typeof WorkspaceHistoryQuerySchema>
export type WorkspaceHistoryResponse = z.infer<typeof WorkspaceHistoryResponseSchema>
export type WorkspaceOperationResponse = z.infer<typeof WorkspaceOperationResponseSchema>
export type WorkspaceDraftResponse = z.infer<typeof WorkspaceDraftResponseSchema>
export type WorkspaceDraftConflictResponse = z.infer<typeof WorkspaceDraftConflictResponseSchema>
export type WorkspaceResourceQuery = z.infer<typeof WorkspaceResourceQuerySchema>
export type WorkspaceResourcesResponse = z.infer<typeof WorkspaceResourcesResponseSchema>
export type WorkspaceFileContentResponse = z.infer<typeof WorkspaceFileContentResponseSchema>
export type WorkspaceUploadResponse = z.infer<typeof WorkspaceUploadResponseSchema>
export type WorkspaceImportCandidatesResponse = z.infer<typeof WorkspaceImportCandidatesResponseSchema>
export type WorkspaceEventsQuery = z.infer<typeof WorkspaceEventsQuerySchema>
export type WorkspaceResyncResponse = z.infer<typeof WorkspaceResyncResponseSchema>
export const WorkspaceSettingsResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, sessionId: WorkspaceIdSchema, settings: WorkspaceSettingsSchema })
export const WorkspaceSkillsResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, skills: z.array(WorkspaceSkillSchema) })
export const WorkspaceTerminalResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, receipt: WorkspaceOperationReceiptSchema, terminal: WorkspaceTerminalSchema })
export type WorkspaceSettingsResponse = z.infer<typeof WorkspaceSettingsResponseSchema>
export type WorkspaceSkillsResponse = z.infer<typeof WorkspaceSkillsResponseSchema>
export type WorkspaceTerminalResponse = z.infer<typeof WorkspaceTerminalResponseSchema>
export const WorkspaceSkillReadResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, skill: WorkspaceSkillSchema.extend({ content: z.string() }) })
export type WorkspaceSkillReadResponse = z.infer<typeof WorkspaceSkillReadResponseSchema>
export const WorkspaceTerminalsResponseSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, terminals: z.array(WorkspaceTerminalSchema) })
export type WorkspaceTerminalsResponse = z.infer<typeof WorkspaceTerminalsResponseSchema>
