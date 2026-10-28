import { z } from "zod"
import {
  EngineReferenceSchema, WorkspaceDigestSchema, WorkspaceIdSchema,
  WorkspaceSchemaVersionSchema, WorkspaceVersionSchema,
} from "./primitives.ts"
import { WorkspaceResourceReferenceSchema, WorkspaceContextReferenceSchema } from "./entities.ts"
import { WorkspaceReviewFeedbackSchema } from "./resource-api.ts"


export const WorkspaceInputSchema = z.strictObject({
  text: z.string(),
  attachments: z.array(WorkspaceResourceReferenceSchema),
  context: z.array(WorkspaceContextReferenceSchema),
}).superRefine((input, context) => {
  if (!input.text.trim() && input.attachments.length === 0 && input.context.length === 0) {
    context.addIssue({ code: "custom", message: "A send or steer requires text or an explicit context reference." })
  }
})
export type WorkspaceInput = z.infer<typeof WorkspaceInputSchema>

export const WorkspaceTargetSchema = z.strictObject({ workspaceId: WorkspaceIdSchema })
export const SessionTargetSchema = WorkspaceTargetSchema.extend({ sessionId: WorkspaceIdSchema })
export const DraftTargetSchema = WorkspaceTargetSchema.extend({ draftId: WorkspaceIdSchema, sessionId: WorkspaceIdSchema.nullable() })
export const ApprovalTargetSchema = SessionTargetSchema.extend({ runId: WorkspaceIdSchema, approvalId: WorkspaceIdSchema })
export const QuestionTargetSchema = SessionTargetSchema.extend({ runId: WorkspaceIdSchema, questionId: WorkspaceIdSchema })
export const ResourceTargetSchema = WorkspaceTargetSchema.extend({ resourceId: WorkspaceIdSchema })
export const TerminalTargetSchema = WorkspaceTargetSchema.extend({ terminalId: WorkspaceIdSchema })
export const SkillTargetSchema = WorkspaceTargetSchema.extend({ skillId: WorkspaceIdSchema })
export const OperationTargetSchema = WorkspaceTargetSchema.extend({ operationId: WorkspaceIdSchema })
export const WorkspaceOperationTargetSchema = z.union([
  ApprovalTargetSchema, QuestionTargetSchema, DraftTargetSchema, SessionTargetSchema,
  ResourceTargetSchema, TerminalTargetSchema, SkillTargetSchema, OperationTargetSchema, WorkspaceTargetSchema,
])
export type WorkspaceOperationTarget = z.infer<typeof WorkspaceOperationTargetSchema>

const commandFields = { schemaVersion: WorkspaceSchemaVersionSchema, operationId: WorkspaceIdSchema }
export const CreateCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("create"), target: WorkspaceTargetSchema,
  expectedWorkspaceVersion: WorkspaceVersionSchema, title: z.string().min(1).max(256),
})
export const SendCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("send"), target: SessionTargetSchema,
  expectedTurnId: z.null(), draftId: WorkspaceIdSchema, draftVersion: WorkspaceVersionSchema,
  input: WorkspaceInputSchema,
})
export const SteerCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("steer"), target: SessionTargetSchema,
  expectedTurnId: WorkspaceIdSchema, draftId: WorkspaceIdSchema, draftVersion: WorkspaceVersionSchema,
  input: WorkspaceInputSchema,
})
export const InterruptCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("interrupt"), target: SessionTargetSchema, expectedTurnId: WorkspaceIdSchema,
})
export const RenameCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("rename"), target: SessionTargetSchema,
  expectedVersion: WorkspaceVersionSchema, title: z.string().min(1).max(256),
})
export const ArchiveCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("archive"), target: SessionTargetSchema,
  expectedVersion: WorkspaceVersionSchema, archived: z.boolean(),
})
export const ApprovalCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("approval"), target: ApprovalTargetSchema,
  expectedTurnId: WorkspaceIdSchema, expectedEpoch: WorkspaceVersionSchema,
  expectedVersion: WorkspaceVersionSchema, optionId: WorkspaceIdSchema,
})
export const QuestionAnswerSchema = z.strictObject({
  promptId: WorkspaceIdSchema, optionIds: z.array(WorkspaceIdSchema), text: z.string().nullable(),
})
export const QuestionResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answers"), answers: z.array(QuestionAnswerSchema) }),
  z.strictObject({ kind: z.literal("cancel") }),
])
export const AnswerCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("answer"), target: QuestionTargetSchema,
  expectedTurnId: WorkspaceIdSchema, expectedEpoch: WorkspaceVersionSchema,
  expectedVersion: WorkspaceVersionSchema, response: QuestionResponseSchema,
})
export const ImportCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("import"), target: WorkspaceTargetSchema,
  expectedWorkspaceVersion: WorkspaceVersionSchema, importCandidateId: WorkspaceIdSchema,
})
export const SaveDraftCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("save-draft"), target: DraftTargetSchema,
  expectedVersion: WorkspaceVersionSchema, text: z.string(), attachments: z.array(WorkspaceResourceReferenceSchema), context: z.array(WorkspaceContextReferenceSchema),
})
export const UploadAttachmentCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("upload-attachment"), target: DraftTargetSchema,
  expectedDraftVersion: WorkspaceVersionSchema, uploadToken: WorkspaceIdSchema, name: z.string().min(1).max(256),
  mediaType: z.string().min(1).max(256), sizeBytes: WorkspaceVersionSchema, contentHash: WorkspaceDigestSchema,
})
export const DeleteAttachmentCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("delete-attachment"), target: ResourceTargetSchema, expectedVersion: WorkspaceVersionSchema,
})
export const UpdateSettingsCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("update-settings"), target: SessionTargetSchema,
  expectedVersion: WorkspaceVersionSchema, modelId: WorkspaceIdSchema,
  reasoningLevel: WorkspaceIdSchema.nullable(), permissionProfileId: WorkspaceIdSchema,
  skillIds: z.array(WorkspaceIdSchema), toolConnectionIds: z.array(WorkspaceIdSchema), appliesTo: z.literal("next-turn"),
})
export const CreateWorktreeCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("create-worktree"), target: WorkspaceTargetSchema,
  expectedWorkspaceVersion: WorkspaceVersionSchema, branch: z.string().min(1).max(256), baseRevision: WorkspaceIdSchema,
})
export const RemoveWorktreeCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("remove-worktree"), target: WorkspaceTargetSchema,
  expectedWorkspaceVersion: WorkspaceVersionSchema, worktreeId: WorkspaceIdSchema,
})
export const CreateTerminalCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("create-terminal"), target: WorkspaceTargetSchema,
  expectedWorkspaceVersion: WorkspaceVersionSchema, columns: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000),
})
export const TerminateTerminalCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("terminate-terminal"), target: TerminalTargetSchema, expectedGeneration: WorkspaceVersionSchema,
})
export const CreateSkillCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("create-skill"), target: WorkspaceTargetSchema,
  expectedWorkspaceVersion: WorkspaceVersionSchema, name: z.string().min(1).max(256), content: z.string().min(1),
})
export const UpdateSkillCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("update-skill"), target: SkillTargetSchema,
  expectedVersion: WorkspaceVersionSchema, expectedContentHash: WorkspaceDigestSchema, content: z.string().min(1),
})
export const AbandonOperationCommandSchema = z.strictObject({
  ...commandFields, action: z.literal("abandon-operation"), target: OperationTargetSchema,
  expectedVersion: WorkspaceVersionSchema, acknowledgeUnknownEffects: z.literal(true),
})
export const ReviewFeedbackCommandSchema = z.strictObject({ ...commandFields, action: z.literal("review-feedback"), target: SessionTargetSchema, feedback: WorkspaceReviewFeedbackSchema })
export const WorkspaceCommandSchema = z.discriminatedUnion("action", [
  CreateCommandSchema, SendCommandSchema, SteerCommandSchema, InterruptCommandSchema,
  RenameCommandSchema, ArchiveCommandSchema, ApprovalCommandSchema, AnswerCommandSchema,
  ImportCommandSchema, SaveDraftCommandSchema, UploadAttachmentCommandSchema, DeleteAttachmentCommandSchema,
  UpdateSettingsCommandSchema, CreateWorktreeCommandSchema, RemoveWorktreeCommandSchema,
  CreateTerminalCommandSchema, TerminateTerminalCommandSchema, CreateSkillCommandSchema,
  UpdateSkillCommandSchema, AbandonOperationCommandSchema, ReviewFeedbackCommandSchema,
])
export type WorkspaceCommand = z.infer<typeof WorkspaceCommandSchema>
export type SendCommand = z.infer<typeof SendCommandSchema>
export type SteerCommand = z.infer<typeof SteerCommandSchema>
export type ApprovalCommand = z.infer<typeof ApprovalCommandSchema>
export type AnswerCommand = z.infer<typeof AnswerCommandSchema>
export type QuestionResponse = z.infer<typeof QuestionResponseSchema>

// No operationId: terminal bytes/resize are generation-bound channel frames, not replayable commands.
export const TerminalClientFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("input"), terminalId: WorkspaceIdSchema, generation: WorkspaceVersionSchema, data: z.string().max(65536) }),
  z.strictObject({ type: z.literal("resize"), terminalId: WorkspaceIdSchema, generation: WorkspaceVersionSchema, columns: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }),
])
export const TerminalServerFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("output"), terminalId: WorkspaceIdSchema, generation: WorkspaceVersionSchema, seq: WorkspaceVersionSchema, data: z.string() }),
  z.strictObject({ type: z.literal("exit"), terminalId: WorkspaceIdSchema, generation: WorkspaceVersionSchema, seq: WorkspaceVersionSchema, exitCode: z.number().int().nullable() }),
  z.strictObject({ type: z.literal("resync-required"), terminalId: WorkspaceIdSchema, generation: WorkspaceVersionSchema, seq: WorkspaceVersionSchema }),
])
export type TerminalClientFrame = z.infer<typeof TerminalClientFrameSchema>
export type TerminalServerFrame = z.infer<typeof TerminalServerFrameSchema>
export const ImportCandidateSchema = z.strictObject({
  importCandidateId: WorkspaceIdSchema, source: EngineReferenceSchema, title: z.string(),
  workspaceId: WorkspaceIdSchema, expiresAt: z.iso.datetime(),
})
export type ImportCandidate = z.infer<typeof ImportCandidateSchema>
