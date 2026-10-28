import { z } from "zod"
import {
  EngineReferenceSchema, EngineRequestIdSchema, JsonValueSchema, SourceReferenceSchema,
  WorkspaceDigestSchema, WorkspaceErrorSchema, WorkspaceIdSchema,
  WorkspaceTimestampSchema, WorkspaceVersionSchema,
} from "./primitives.ts"

export const WorkspaceProjectSchema = z.strictObject({
  projectId: WorkspaceIdSchema,
  title: z.string().min(1),
  version: WorkspaceVersionSchema,
  workspaceIds: z.array(WorkspaceIdSchema),
})
export type WorkspaceProject = z.infer<typeof WorkspaceProjectSchema>
export const WorkspaceSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  projectId: WorkspaceIdSchema,
  title: z.string().min(1),
  version: WorkspaceVersionSchema,
  repositoryId: WorkspaceIdSchema.nullable(),
  worktreeId: WorkspaceIdSchema.nullable(),
  branch: z.string().nullable(),
  baseRevision: WorkspaceIdSchema.nullable(),
  policyVersion: WorkspaceVersionSchema,
})
export type Workspace = z.infer<typeof WorkspaceSchema>
export const WorkspaceSessionSchema = z.strictObject({
  sessionId: WorkspaceIdSchema,
  workspaceId: WorkspaceIdSchema,
  source: EngineReferenceSchema,
  title: z.string().min(1),
  archived: z.boolean(),
  version: WorkspaceVersionSchema,
  createdAt: WorkspaceTimestampSchema,
  updatedAt: WorkspaceTimestampSchema,
})
export type WorkspaceSession = z.infer<typeof WorkspaceSessionSchema>

export const RunStatusSchema = z.enum(["queued", "running", "waiting", "completed", "failed", "interrupted", "unknown"])
export type RunStatus = z.infer<typeof RunStatusSchema>
export const WorkspaceUsageSchema = z.strictObject({
  inputTokens: WorkspaceVersionSchema,
  outputTokens: WorkspaceVersionSchema,
  cachedInputTokens: WorkspaceVersionSchema,
})
export const WorkspaceRunSchema = z.strictObject({
  runId: WorkspaceIdSchema,
  sessionId: WorkspaceIdSchema,
  source: EngineReferenceSchema,
  turnId: WorkspaceIdSchema.nullable(),
  status: RunStatusSchema,
  startedAt: WorkspaceTimestampSchema.nullable(),
  endedAt: WorkspaceTimestampSchema.nullable(),
  error: WorkspaceErrorSchema.nullable(),
  usage: WorkspaceUsageSchema.nullable(),
}).superRefine((run, context) => {
  const ended = ["completed", "failed", "interrupted"].includes(run.status)
  if (!ended && run.endedAt !== null) {
    context.addIssue({ code: "custom", path: ["endedAt"], message: "A non-terminal run cannot have an end time." })
  }
  if (run.status === "failed" && run.error === null) {
    context.addIssue({ code: "custom", path: ["error"], message: "Failed runs require a sanitized error." })
  }
})
export type WorkspaceRun = z.infer<typeof WorkspaceRunSchema>
export type WorkspaceUsage = z.infer<typeof WorkspaceUsageSchema>

export const WorkspaceToolSchema = z.strictObject({
  toolId: WorkspaceIdSchema,
  itemId: WorkspaceIdSchema,
  kind: z.enum(["command-execution", "file-change", "mcp", "unsupported"]),
  status: z.enum(["pending", "running", "completed", "failed", "interrupted", "unknown"]),
  title: z.string(),
  input: JsonValueSchema,
  output: z.string().nullable(),
  error: WorkspaceErrorSchema.nullable(),
  source: SourceReferenceSchema,
}).superRefine((tool, context) => {
  if (tool.source.itemId !== tool.itemId) {
    context.addIssue({ code: "custom", path: ["itemId"], message: "Tool and source item must match." })
  }
  if (tool.kind === "unsupported" && tool.status === "completed") {
    context.addIssue({ code: "custom", path: ["status"], message: "Unsupported source items cannot imply success." })
  }
})
export type WorkspaceTool = z.infer<typeof WorkspaceToolSchema>

export const ApprovalStatusSchema = z.enum(["pending", "submitted", "confirmed", "expired", "unknown"])
export const ApprovalOptionSchema = z.strictObject({
  optionId: WorkspaceIdSchema,
  label: z.string().min(1),
  decision: z.enum(["approve", "decline", "cancel"]),
  scope: z.enum(["once", "session", "persistent"]),
})
export const WorkspaceApprovalSchema = z.strictObject({
  approvalId: WorkspaceIdSchema,
  sessionId: WorkspaceIdSchema,
  runId: WorkspaceIdSchema,
  itemId: WorkspaceIdSchema,
  requestId: EngineRequestIdSchema,
  source: EngineReferenceSchema,
  turnId: WorkspaceIdSchema,
  version: WorkspaceVersionSchema,
  status: ApprovalStatusSchema,
  options: z.array(ApprovalOptionSchema).min(1),
  title: z.string(),
  description: z.string(),
}).superRefine((approval, context) => {
  if (new Set(approval.options.map((option) => option.optionId)).size !== approval.options.length) {
    context.addIssue({ code: "custom", path: ["options"], message: "Advertised option IDs must be unique." })
  }
})
export type WorkspaceApproval = z.infer<typeof WorkspaceApprovalSchema>
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>

export const QuestionPromptSchema = z.strictObject({
  promptId: WorkspaceIdSchema,
  prompt: z.string().min(1),
  options: z.array(z.strictObject({ optionId: WorkspaceIdSchema, label: z.string().min(1) })),
  allowText: z.boolean(),
  multiple: z.boolean(),
  required: z.boolean(),
}).superRefine((prompt, context) => {
  if (new Set(prompt.options.map((option) => option.optionId)).size !== prompt.options.length) {
    context.addIssue({ code: "custom", path: ["options"], message: "Advertised answer IDs must be unique." })
  }
})
export const WorkspaceQuestionSchema = z.strictObject({
  questionId: WorkspaceIdSchema,
  sessionId: WorkspaceIdSchema,
  runId: WorkspaceIdSchema,
  itemId: WorkspaceIdSchema,
  requestId: EngineRequestIdSchema,
  source: EngineReferenceSchema,
  turnId: WorkspaceIdSchema,
  version: WorkspaceVersionSchema,
  status: ApprovalStatusSchema,
  prompts: z.array(QuestionPromptSchema).min(1),
  allowCancel: z.boolean(),
}).superRefine((question, context) => {
  if (new Set(question.prompts.map((prompt) => prompt.promptId)).size !== question.prompts.length) {
    context.addIssue({ code: "custom", path: ["prompts"], message: "Prompt IDs must be unique." })
  }
})
export type WorkspaceQuestion = z.infer<typeof WorkspaceQuestionSchema>

export const WorkspaceResourceReferenceSchema = z.strictObject({
  resourceId: WorkspaceIdSchema,
  version: WorkspaceVersionSchema,
  contentHash: WorkspaceDigestSchema,
})
export type WorkspaceResourceReference = z.infer<typeof WorkspaceResourceReferenceSchema>
export const WorkspaceContextReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("resource"), reference: WorkspaceResourceReferenceSchema }),
  z.strictObject({ kind: z.literal("skill"), skillId: WorkspaceIdSchema, version: WorkspaceVersionSchema, contentHash: WorkspaceDigestSchema }),
])
export type WorkspaceContextReference = z.infer<typeof WorkspaceContextReferenceSchema>
const resourceFields = {
  ...WorkspaceResourceReferenceSchema.shape,
  workspaceId: WorkspaceIdSchema,
  sessionId: WorkspaceIdSchema.nullable(),
  source: SourceReferenceSchema.nullable(),
  name: z.string().min(1),
  mediaType: z.string().min(1),
  sizeBytes: WorkspaceVersionSchema,
  availability: z.enum(["available", "unavailable", "expired"]),
  lifecycle: z.enum(["active", "retained", "deleted"]),
}
export const WorkspaceResourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...resourceFields, kind: z.literal("file"), relativePath: z.string().min(1), revision: WorkspaceIdSchema, truncated: z.boolean(), binary: z.boolean() }),
  z.strictObject({
    ...resourceFields, kind: z.literal("diff"), baseRevision: WorkspaceIdSchema, headRevision: WorkspaceIdSchema,
    changes: z.array(z.strictObject({ kind: z.enum(["added", "modified", "deleted", "renamed", "binary"]), path: z.string().min(1), oldPath: z.string().nullable() })),
    origin: z.enum(["engine", "pre-existing", "mixed"]),
  }),
  z.strictObject({ ...resourceFields, kind: z.literal("attachment"), attachmentState: z.enum(["selected", "uploaded", "engine-readable"]), expiresAt: WorkspaceTimestampSchema.nullable() }),
  z.strictObject({ ...resourceFields, kind: z.literal("artifact"), complete: z.boolean(), expiresAt: WorkspaceTimestampSchema.nullable() }),
])
export type WorkspaceResource = z.infer<typeof WorkspaceResourceSchema>
const partFields = { partId: WorkspaceIdSchema, version: WorkspaceVersionSchema, source: SourceReferenceSchema }
export const WorkspaceMessagePartSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...partFields, type: z.literal("text"), text: z.string() }),
  z.strictObject({ ...partFields, type: z.literal("reasoning-summary"), text: z.string() }),
  z.strictObject({ ...partFields, type: z.literal("tool"), tool: WorkspaceToolSchema }),
  z.strictObject({ ...partFields, type: z.literal("approval"), approvalId: WorkspaceIdSchema }),
  z.strictObject({ ...partFields, type: z.literal("question"), questionId: WorkspaceIdSchema }),
  z.strictObject({ ...partFields, type: z.literal("resource"), resource: WorkspaceResourceReferenceSchema }),
  z.strictObject({ ...partFields, type: z.literal("unsupported"), sourceType: WorkspaceIdSchema, summary: z.string() }),
]).superRefine((part, context) => {
  if (part.type === "tool" && (part.source.adapter !== part.tool.source.adapter
    || part.source.engineIdentity !== part.tool.source.engineIdentity || part.source.threadId !== part.tool.source.threadId
    || part.source.epoch !== part.tool.source.epoch || part.source.turnId !== part.tool.source.turnId
    || part.source.itemId !== part.tool.source.itemId || part.source.revision !== part.tool.source.revision)) {
    context.addIssue({ code: "custom", path: ["tool", "source"], message: "Tool part and tool must refer to the exact same source version." })
  }
})
export type WorkspaceMessagePart = z.infer<typeof WorkspaceMessagePartSchema>
export const WorkspaceMessageSchema = z.strictObject({
  messageId: WorkspaceIdSchema,
  sessionId: WorkspaceIdSchema,
  runId: WorkspaceIdSchema.nullable(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  parts: z.array(WorkspaceMessagePartSchema),
  createdAt: WorkspaceTimestampSchema,
}).superRefine((message, context) => {
  if (new Set(message.parts.map((part) => part.partId)).size !== message.parts.length) {
    context.addIssue({ code: "custom", path: ["parts"], message: "Part IDs must be unique within a message." })
  }
})
export type WorkspaceMessage = z.infer<typeof WorkspaceMessageSchema>

export const WorkspaceDraftSchema = z.strictObject({
  draftId: WorkspaceIdSchema,
  sessionId: WorkspaceIdSchema.nullable(),
  workspaceId: WorkspaceIdSchema,
  version: WorkspaceVersionSchema,
  text: z.string(),
  attachments: z.array(WorkspaceResourceReferenceSchema),
  context: z.array(WorkspaceContextReferenceSchema),
  updatedAt: WorkspaceTimestampSchema,
})
export type WorkspaceDraft = z.infer<typeof WorkspaceDraftSchema>
export const WorkspaceSettingsSchema = z.strictObject({
  version: WorkspaceVersionSchema,
  modelId: WorkspaceIdSchema,
  reasoningLevel: WorkspaceIdSchema.nullable(),
  permissionProfileId: WorkspaceIdSchema,
  skillIds: z.array(WorkspaceIdSchema),
  toolConnectionIds: z.array(WorkspaceIdSchema),
  appliesTo: z.literal("next-turn"),
})
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>
export const WorkspaceSkillSchema = z.strictObject({
  skillId: WorkspaceIdSchema, version: WorkspaceVersionSchema, name: z.string().min(1),
  content: z.string(), contentHash: WorkspaceDigestSchema, loaded: z.boolean(),
})
export type WorkspaceSkill = z.infer<typeof WorkspaceSkillSchema>
export const WorkspaceTerminalSchema = z.strictObject({
  terminalId: WorkspaceIdSchema, workspaceId: WorkspaceIdSchema, generation: WorkspaceVersionSchema,
  status: z.enum(["running", "ended", "unknown"]), createdAt: WorkspaceTimestampSchema,
  expiresAt: WorkspaceTimestampSchema.nullable(), exitCode: z.number().int().nullable(),
})
export type WorkspaceTerminal = z.infer<typeof WorkspaceTerminalSchema>

// Server records never authorize a request by trusting fields supplied by the browser.
export const ServerOwnerRecordSchema = z.strictObject({ ownerId: WorkspaceIdSchema, identity: WorkspaceIdSchema, disabled: z.boolean(), createdAt: WorkspaceTimestampSchema })
export const ServerAppSessionRecordSchema = z.strictObject({ appSessionId: WorkspaceIdSchema, ownerId: WorkspaceIdSchema, expiresAt: WorkspaceTimestampSchema, revokedAt: WorkspaceTimestampSchema.nullable() })
export const ServerProjectRecordSchema = WorkspaceProjectSchema.extend({ ownerId: WorkspaceIdSchema })
export const ServerWorkspaceRecordSchema = WorkspaceSchema.extend({ ownerId: WorkspaceIdSchema, authorizedRealpath: z.string().min(1), hostCreatedWorktree: z.boolean() })
export const ServerSessionRecordSchema = WorkspaceSessionSchema.extend({ ownerId: WorkspaceIdSchema })
export const ServerRunRecordSchema = z.strictObject({ ownerId: WorkspaceIdSchema, run: WorkspaceRunSchema, sourceError: JsonValueSchema.nullable() })
export const ServerApprovalRecordSchema = z.strictObject({ ownerId: WorkspaceIdSchema, approval: WorkspaceApprovalSchema })
export const ServerQuestionRecordSchema = z.strictObject({ ownerId: WorkspaceIdSchema, question: WorkspaceQuestionSchema })
export const ServerDraftRecordSchema = WorkspaceDraftSchema.extend({ ownerId: WorkspaceIdSchema })
export const ServerResourceRecordSchema = z.strictObject({ ownerId: WorkspaceIdSchema, resource: WorkspaceResourceSchema, storageKey: WorkspaceIdSchema })
export const ServerTerminalRecordSchema = WorkspaceTerminalSchema.extend({ ownerId: WorkspaceIdSchema, processId: z.number().int().positive().nullable() })
export type ServerOwnerRecord = z.infer<typeof ServerOwnerRecordSchema>
export type ServerAppSessionRecord = z.infer<typeof ServerAppSessionRecordSchema>
export type ServerProjectRecord = z.infer<typeof ServerProjectRecordSchema>
export type ServerWorkspaceRecord = z.infer<typeof ServerWorkspaceRecordSchema>
export type ServerSessionRecord = z.infer<typeof ServerSessionRecordSchema>
export type ServerRunRecord = z.infer<typeof ServerRunRecordSchema>
export type ServerApprovalRecord = z.infer<typeof ServerApprovalRecordSchema>
export type ServerQuestionRecord = z.infer<typeof ServerQuestionRecordSchema>
export type ServerDraftRecord = z.infer<typeof ServerDraftRecordSchema>
export type ServerResourceRecord = z.infer<typeof ServerResourceRecordSchema>
export type ServerTerminalRecord = z.infer<typeof ServerTerminalRecordSchema>
