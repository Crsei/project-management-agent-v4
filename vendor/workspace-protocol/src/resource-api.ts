import { z } from "zod"
import { WorkspaceResourceReferenceSchema, WorkspaceResourceSchema } from "./entities.ts"
import { SourceReferenceSchema, WorkspaceDigestSchema, WorkspaceIdSchema, WorkspaceSchemaVersionSchema, WorkspaceTimestampSchema, WorkspaceVersionSchema } from "./primitives.ts"

export const WorkspaceFileQuerySchema = z.strictObject({
  directory: z.string().max(4096).default(""), search: z.string().max(256).default(""),
  limit: z.number().int().min(1).max(500).default(200),
})
export type WorkspaceFileQuery = z.infer<typeof WorkspaceFileQuerySchema>
export const WorkspaceFileEntrySchema = z.strictObject({ relativePath: z.string().min(1), sizeBytes: WorkspaceVersionSchema })
export const WorkspaceFileListSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, workspaceId: WorkspaceIdSchema, files: z.array(WorkspaceFileEntrySchema), truncated: z.boolean() })
export type WorkspaceFileList = z.infer<typeof WorkspaceFileListSchema>
export const WorkspaceFileSelectionSchema = z.strictObject({ relativePath: z.string().min(1).max(4096), expectedHash: WorkspaceDigestSchema.optional() })
export type WorkspaceFileSelection = z.infer<typeof WorkspaceFileSelectionSchema>
export const WorkspaceFileContentSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, resource: WorkspaceResourceSchema.refine(resource => resource.kind === "file", "A file resource is required."), text: z.string(), encoding: z.enum(["utf-8", "binary"]), truncated: z.boolean() })
export type WorkspaceFileContent = z.infer<typeof WorkspaceFileContentSchema>

export const WorkspaceUploadTargetSchema = z.strictObject({ workspaceId: WorkspaceIdSchema, sessionId: WorkspaceIdSchema.nullable(), draftId: WorkspaceIdSchema, expectedDraftVersion: WorkspaceVersionSchema })
export type WorkspaceUploadTarget = z.infer<typeof WorkspaceUploadTargetSchema>
export const WorkspaceUploadMetadataSchema = z.strictObject({
  name: z.string().min(1).max(256).refine(value => !/[\\/\u0000-\u001f\u007f]/.test(value) && value !== "." && value !== "..", "A display filename is required."),
  mediaType: z.enum(["text/plain", "text/markdown", "text/csv", "application/json", "image/png", "image/jpeg"]),
  sizeBytes: WorkspaceVersionSchema, contentHash: WorkspaceDigestSchema,
})
export type WorkspaceUploadMetadata = z.infer<typeof WorkspaceUploadMetadataSchema>
export const WorkspacePreparedUploadSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, uploadToken: WorkspaceIdSchema, expiresAt: WorkspaceTimestampSchema, metadata: WorkspaceUploadMetadataSchema })
export type WorkspacePreparedUpload = z.infer<typeof WorkspacePreparedUploadSchema>

export const WorkspaceDiffSideSchema = z.strictObject({ revision: WorkspaceIdSchema, contentHash: WorkspaceDigestSchema, sizeBytes: WorkspaceVersionSchema, binary: z.boolean(), text: z.string(), truncated: z.boolean() })
export const WorkspaceDiffChangeSchema = z.strictObject({
  kind: z.enum(["added", "modified", "deleted", "renamed", "binary"]), path: z.string().min(1), oldPath: z.string().nullable(),
  origin: z.enum(["engine", "pre-existing", "mixed"]), sourceObserved: z.boolean(), base: WorkspaceDiffSideSchema.nullable(), head: WorkspaceDiffSideSchema.nullable(),
})
export type WorkspaceDiffChange = z.infer<typeof WorkspaceDiffChangeSchema>
export const WorkspaceDiffContentSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, resource: WorkspaceResourceSchema.refine(resource => resource.kind === "diff", "A diff resource is required."), source: SourceReferenceSchema, changes: z.array(WorkspaceDiffChangeSchema) })
export type WorkspaceDiffContent = z.infer<typeof WorkspaceDiffContentSchema>
export const WorkspaceReviewFeedbackSchema = z.strictObject({
  reference: WorkspaceResourceReferenceSchema, path: z.string().min(1).max(4096),
  baseHash: WorkspaceDigestSchema.nullable(), headHash: WorkspaceDigestSchema.nullable(),
  text: z.string().min(1).max(16384),
})
export type WorkspaceReviewFeedback = z.infer<typeof WorkspaceReviewFeedbackSchema>
export const WorkspaceResourceReferenceRequestSchema = z.strictObject({ reference: WorkspaceResourceReferenceSchema })
export const WorkspaceResourceListSchema = z.strictObject({ schemaVersion: WorkspaceSchemaVersionSchema, resources: z.array(WorkspaceResourceSchema) })
export const WorkspaceArtifactDownloadMetadataSchema = z.strictObject({ reference: WorkspaceResourceReferenceSchema, name: z.string().min(1), mediaType: z.string().min(1), sizeBytes: WorkspaceVersionSchema, complete: z.literal(true) })
export type WorkspaceArtifactDownloadMetadata = z.infer<typeof WorkspaceArtifactDownloadMetadataSchema>
