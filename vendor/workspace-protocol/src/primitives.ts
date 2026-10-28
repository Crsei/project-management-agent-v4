import { z } from "zod"

export const WORKSPACE_SCHEMA_VERSION = 1 as const
export const WorkspaceSchemaVersionSchema = z.literal(WORKSPACE_SCHEMA_VERSION)
export const WorkspaceIdSchema = z.string().min(1).max(256)
export const WorkspaceVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const WorkspaceTimestampSchema = z.iso.datetime()
export const WorkspaceDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const EngineRequestIdSchema = z.union([WorkspaceIdSchema, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
export const JsonValueSchema = z.json()
export type JsonValue = z.infer<typeof JsonValueSchema>

export const EngineIdentitySchema = z.strictObject({
  adapter: WorkspaceIdSchema,
  engineIdentity: WorkspaceIdSchema,
  epoch: WorkspaceVersionSchema,
})
export type EngineIdentity = z.infer<typeof EngineIdentitySchema>
export const EngineReferenceSchema = EngineIdentitySchema.extend({
  threadId: WorkspaceIdSchema,
})
export type EngineReference = z.infer<typeof EngineReferenceSchema>

export const SourceReferenceSchema = EngineReferenceSchema.extend({
  turnId: WorkspaceIdSchema.nullable(),
  itemId: WorkspaceIdSchema.nullable(),
  revision: WorkspaceIdSchema,
})
export type SourceReference = z.infer<typeof SourceReferenceSchema>

export const WorkspaceErrorCodeSchema = z.enum([
  "unauthenticated", "forbidden", "invalid-origin", "invalid-command", "not-found",
  "operation-conflict", "version-conflict", "turn-conflict", "busy", "capability-unavailable",
  "storage-unavailable", "runtime-unavailable", "authentication-required", "source-rejected",
  "source-exited", "approval-expired", "approval-option-invalid", "answer-invalid",
  "resource-unavailable", "resource-version-conflict", "path-forbidden", "upload-too-large",
  "unsupported-media", "cursor-expired", "event-gap", "schema-version-unsupported",
  "unknown-outcome", "workspace-locked", "worktree-dirty", "worktree-not-owned", "internal",
])
export type WorkspaceErrorCode = z.infer<typeof WorkspaceErrorCodeSchema>
export const WorkspaceErrorSchema = z.strictObject({
  code: WorkspaceErrorCodeSchema,
  message: z.string().min(1).max(2048),
  retryable: z.boolean(),
  operationId: WorkspaceIdSchema.optional(),
  diagnosticId: WorkspaceIdSchema.optional(),
  currentVersion: WorkspaceVersionSchema.optional(),
}).superRefine((error, context) => {
  if (error.code === "unknown-outcome" && error.retryable) {
    context.addIssue({ code: "custom", path: ["retryable"], message: "Unknown effects must be reconciled, not replayed." })
  }
})
export type WorkspaceError = z.infer<typeof WorkspaceErrorSchema>

export const WorkspaceActionSchema = z.enum([
  "create", "send", "steer", "interrupt", "rename", "archive", "approval", "answer",
  "import", "save-draft", "upload-attachment", "delete-attachment", "update-settings",
  "create-worktree", "remove-worktree", "create-terminal", "terminate-terminal",
  "create-skill", "update-skill", "abandon-operation", "review-feedback",
])
export type WorkspaceAction = z.infer<typeof WorkspaceActionSchema>

export const CapabilityAvailabilitySchema = z.strictObject({
  available: z.boolean(),
  reason: z.string().min(1).max(1024).optional(),
})
export type CapabilityAvailability = z.infer<typeof CapabilityAvailabilitySchema>
export const WorkspaceModelSchema = z.strictObject({
  modelId: WorkspaceIdSchema,
  label: z.string().min(1),
  reasoningLevels: z.array(WorkspaceIdSchema),
})
export const WorkspaceCapabilitiesSchema = z.strictObject({
  schemaVersion: WorkspaceSchemaVersionSchema,
  version: WorkspaceVersionSchema,
  adapter: WorkspaceIdSchema,
  actions: z.partialRecord(WorkspaceActionSchema, CapabilityAvailabilitySchema),
  models: z.array(WorkspaceModelSchema),
  permissionProfiles: z.array(z.strictObject({ profileId: WorkspaceIdSchema, label: z.string().min(1), availability: CapabilityAvailabilitySchema })).optional(),
  toolConnections: z.array(z.strictObject({ connectionId: WorkspaceIdSchema, label: z.string().min(1), availability: CapabilityAvailabilitySchema })).optional(),
  resources: z.strictObject({
    readFiles: CapabilityAvailabilitySchema,
    uploadAttachments: CapabilityAvailabilitySchema,
    downloadArtifacts: CapabilityAvailabilitySchema,
    readDiffs: CapabilityAvailabilitySchema,
    terminals: CapabilityAvailabilitySchema,
  }),
  approval: z.strictObject({ persistentDecisions: z.boolean() }),
  maxConcurrentRuns: z.number().int().positive(),
})
export type WorkspaceCapabilities = z.infer<typeof WorkspaceCapabilitiesSchema>
export type WorkspaceModel = z.infer<typeof WorkspaceModelSchema>

export const ConnectionStatusSchema = z.enum(["connecting", "connected", "disconnected", "unauthenticated", "unavailable"])
export const DataStatusSchema = z.enum(["idle", "loading", "ready", "stale", "failed"])
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>
export type DataStatus = z.infer<typeof DataStatusSchema>
