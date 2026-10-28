import { z } from "zod"
import {
  WorkspaceCapabilitiesSchema, WorkspaceIdSchema,
  WorkspaceSchemaVersionSchema, WorkspaceTimestampSchema, WorkspaceVersionSchema,
} from "./primitives.ts"
import type { WorkspaceError } from "./primitives.ts"
import {
  WorkspaceApprovalSchema, WorkspaceMessagePartSchema, WorkspaceMessageSchema,
  WorkspaceQuestionSchema, WorkspaceResourceSchema, WorkspaceRunSchema, WorkspaceSessionSchema,
} from "./entities.ts"
import { WorkspaceOperationReceiptSchema, transitionOperation } from "./operations.ts"

export const WorkspaceCursorSchema = z.strictObject({
  streamId: WorkspaceIdSchema, seq: WorkspaceVersionSchema, epoch: WorkspaceVersionSchema,
  schemaVersion: WorkspaceSchemaVersionSchema,
})
export type WorkspaceCursor = z.infer<typeof WorkspaceCursorSchema>
export const WorkspaceSnapshotSchema = z.strictObject({
  schemaVersion: WorkspaceSchemaVersionSchema,
  watermark: WorkspaceCursorSchema,
  session: WorkspaceSessionSchema,
  messages: z.array(WorkspaceMessageSchema),
  runs: z.array(WorkspaceRunSchema),
  operations: z.array(WorkspaceOperationReceiptSchema),
  approvals: z.array(WorkspaceApprovalSchema),
  questions: z.array(WorkspaceQuestionSchema),
  resources: z.array(WorkspaceResourceSchema),
  capabilities: WorkspaceCapabilitiesSchema,
}).superRefine((snapshot, context) => {
  const sessionId = snapshot.session.sessionId
  const scopedCollections = [snapshot.messages, snapshot.runs, snapshot.approvals, snapshot.questions, snapshot.resources]
  for (const collection of scopedCollections) {
    if (collection.some((entity) => entity.sessionId !== sessionId)) {
      context.addIssue({ code: "custom", message: "Snapshot entities must belong to its session." })
    }
  }
  if (snapshot.resources.some((resource) => resource.workspaceId !== snapshot.session.workspaceId)) {
    context.addIssue({ code: "custom", path: ["resources"], message: "Snapshot resources must belong to its workspace." })
  }
  if (snapshot.operations.some((operation) => operation.target.workspaceId !== snapshot.session.workspaceId || ("sessionId" in operation.target && operation.target.sessionId !== sessionId))) {
    context.addIssue({ code: "custom", path: ["operations"], message: "Snapshot operations must belong to its scope." })
  }
  const identifiers = [
    snapshot.messages.map((value) => value.messageId), snapshot.runs.map((value) => value.runId),
    snapshot.operations.map((value) => value.operationId), snapshot.approvals.map((value) => value.approvalId),
    snapshot.questions.map((value) => value.questionId), snapshot.resources.map((value) => value.resourceId),
  ]
  if (identifiers.some((ids) => new Set(ids).size !== ids.length)) {
    context.addIssue({ code: "custom", message: "Snapshot entity IDs must be unique within each collection." })
  }
})
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>
const eventFields = {
  ...WorkspaceCursorSchema.shape,
  seq: WorkspaceVersionSchema.refine((seq) => seq > 0),
  workspaceId: WorkspaceIdSchema, sessionId: WorkspaceIdSchema, at: WorkspaceTimestampSchema,
}
export const WorkspaceEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...eventFields, type: z.literal("session-upsert"), session: WorkspaceSessionSchema }),
  z.strictObject({ ...eventFields, type: z.literal("message-upsert"), message: WorkspaceMessageSchema }),
  z.strictObject({ ...eventFields, type: z.literal("part-upsert"), messageId: WorkspaceIdSchema, part: WorkspaceMessagePartSchema }),
  z.strictObject({ ...eventFields, type: z.literal("part-delta"), messageId: WorkspaceIdSchema, partId: WorkspaceIdSchema, expectedVersion: WorkspaceVersionSchema, version: WorkspaceVersionSchema, textDelta: z.string() }),
  z.strictObject({ ...eventFields, type: z.literal("run-upsert"), run: WorkspaceRunSchema }),
  z.strictObject({ ...eventFields, type: z.literal("operation-upsert"), operation: WorkspaceOperationReceiptSchema }),
  z.strictObject({ ...eventFields, type: z.literal("approval-upsert"), approval: WorkspaceApprovalSchema }),
  z.strictObject({ ...eventFields, type: z.literal("question-upsert"), question: WorkspaceQuestionSchema }),
  z.strictObject({ ...eventFields, type: z.literal("resource-upsert"), resource: WorkspaceResourceSchema }),
  z.strictObject({ ...eventFields, type: z.literal("capabilities-upsert"), capabilities: WorkspaceCapabilitiesSchema }),
  z.strictObject({ ...eventFields, type: z.literal("resync-required"), reason: z.enum(["cursor-expired", "slow-consumer", "epoch-changed"]) }),
]).superRefine((event, context) => {
  if (event.type === "part-delta" && event.version !== event.expectedVersion + 1) {
    context.addIssue({ code: "custom", path: ["version"], message: "A delta advances exactly one part version." })
  }
  const scoped = event.type === "session-upsert" ? event.session
    : event.type === "message-upsert" ? event.message : event.type === "run-upsert" ? event.run
      : event.type === "approval-upsert" ? event.approval : event.type === "question-upsert" ? event.question
        : event.type === "resource-upsert" ? event.resource : null
  if (scoped && scoped.sessionId !== event.sessionId) {
    context.addIssue({ code: "custom", path: ["sessionId"], message: "Event and payload session must match." })
  }
  if ((event.type === "session-upsert" && event.session.workspaceId !== event.workspaceId)
    || (event.type === "resource-upsert" && event.resource.workspaceId !== event.workspaceId)
    || (event.type === "operation-upsert" && (event.operation.target.workspaceId !== event.workspaceId || ("sessionId" in event.operation.target && event.operation.target.sessionId !== event.sessionId)))) {
    context.addIssue({ code: "custom", path: ["workspaceId"], message: "Event and payload scopes must match." })
  }
})
export type WorkspaceEvent = z.infer<typeof WorkspaceEventSchema>
export const ServerEventRecordSchema = z.strictObject({ ownerId: WorkspaceIdSchema, event: WorkspaceEventSchema })
export const ServerSnapshotRecordSchema = z.strictObject({ ownerId: WorkspaceIdSchema, snapshot: WorkspaceSnapshotSchema })
export type ServerEventRecord = z.infer<typeof ServerEventRecordSchema>
export type ServerSnapshotRecord = z.infer<typeof ServerSnapshotRecordSchema>

export type WorkspaceProjection = {
  snapshot: WorkspaceSnapshot
  syncStatus: "ready" | "resync-required"
  error: WorkspaceError | null
}
export type WorkspaceReduction = {
  state: WorkspaceProjection
  disposition: "applied" | "duplicate" | "old-epoch" | "resync-required" | "invalid"
}

export function reduceWorkspaceEvent(state: WorkspaceProjection, input: unknown): WorkspaceReduction {
  const parsed = WorkspaceEventSchema.safeParse(input)
  if (!parsed.success) return { state: { ...state, syncStatus: "resync-required", error: { code: "invalid-command", message: "Invalid workspace event; refresh the authoritative snapshot.", retryable: false } }, disposition: "invalid" }
  const event = parsed.data
  const current = state.snapshot
  const cursor = current.watermark
  const resync = (message: string): WorkspaceReduction => ({ state: { ...state, syncStatus: "resync-required", error: { code: "event-gap", message, retryable: true } }, disposition: "resync-required" })
  if (event.streamId !== cursor.streamId || event.sessionId !== current.session.sessionId || event.workspaceId !== current.session.workspaceId) return resync("Event does not belong to this snapshot stream.")
  if (event.epoch < cursor.epoch) return { state, disposition: "old-epoch" }
  if (event.epoch > cursor.epoch) return resync("New source epoch requires an authoritative snapshot.")
  if (event.seq <= cursor.seq) return { state, disposition: "duplicate" }
  if (state.syncStatus !== "ready" || event.seq !== cursor.seq + 1) return resync("Event sequence has a gap; preserve data and read the missing range or snapshot.")
  if (event.type === "resync-required") return resync(`Host requires resynchronization: ${event.reason}.`)
  const next: WorkspaceSnapshot = { ...current, watermark: { streamId: event.streamId, seq: event.seq, epoch: event.epoch, schemaVersion: event.schemaVersion } }
  switch (event.type) {
    case "session-upsert":
      if (event.session.version < current.session.version) return resync("Session version moved backwards.")
      next.session = event.session
      break
    case "message-upsert": {
      const index = current.messages.findIndex((message) => message.messageId === event.message.messageId)
      next.messages = index < 0 ? [...current.messages, event.message] : current.messages.map((message, position) => position === index ? event.message : message)
      break
    }
    case "part-upsert":
    case "part-delta": {
      const message = current.messages.find((value) => value.messageId === event.messageId)
      if (!message) return resync("Part references a message missing from the snapshot.")
      const existing = message.parts.find((part) => part.partId === (event.type === "part-upsert" ? event.part.partId : event.partId))
      let parts = message.parts
      if (event.type === "part-delta") {
        if (!existing || (existing.type !== "text" && existing.type !== "reasoning-summary") || existing.version !== event.expectedVersion) return resync("Part delta base version does not match.")
        parts = message.parts.map((part) => part.partId === existing.partId ? { ...existing, version: event.version, text: existing.text + event.textDelta } : part)
      } else {
        if (existing && existing.version > event.part.version) return resync("Part version moved backwards.")
        parts = existing ? message.parts.map((part) => part.partId === event.part.partId ? event.part : part) : [...message.parts, event.part]
      }
      next.messages = current.messages.map((value) => value.messageId === message.messageId ? { ...message, parts } : value)
      break
    }
    case "run-upsert": {
      const existing = current.runs.find((run) => run.runId === event.run.runId)
      if (existing && ["completed", "failed", "interrupted"].includes(existing.status) && event.run.status !== existing.status) return resync("A source-ended run cannot silently change its outcome.")
      next.runs = existing ? current.runs.map((run) => run.runId === event.run.runId ? event.run : run) : [...current.runs, event.run]
      break
    }
    case "operation-upsert": {
      const existing = current.operations.find((operation) => operation.operationId === event.operation.operationId)
      if (existing) {
        if (event.operation.version < existing.version || existing.evidence.some((proof) => !event.operation.evidence.some((incoming) => incoming.evidenceId === proof.evidenceId && JSON.stringify(incoming) === JSON.stringify(proof)))) return resync("Operation evidence regressed; retrieve the ledger snapshot.")
        let projected = existing
        for (const proof of event.operation.evidence) {
          if (projected.evidence.some((previous) => previous.evidenceId === proof.evidenceId)) continue
          const transition = transitionOperation(projected, proof)
          if (!transition.ok) return resync("Operation evidence cannot prove this receipt transition.")
          projected = transition.receipt
        }
        if (JSON.stringify(projected) !== JSON.stringify(event.operation)) return resync("Receipt fields do not match the evidenced transition.")
      }
      next.operations = existing ? current.operations.map((operation) => operation.operationId === event.operation.operationId ? event.operation : operation) : [...current.operations, event.operation]
      break
    }
    case "approval-upsert": {
      const existing = current.approvals.find((approval) => approval.approvalId === event.approval.approvalId)
      if (existing && event.approval.version < existing.version) return resync("Approval version moved backwards.")
      next.approvals = existing ? current.approvals.map((approval) => approval.approvalId === event.approval.approvalId ? event.approval : approval) : [...current.approvals, event.approval]
      break
    }
    case "question-upsert": {
      const existing = current.questions.find((question) => question.questionId === event.question.questionId)
      if (existing && event.question.version < existing.version) return resync("Question version moved backwards.")
      next.questions = existing ? current.questions.map((question) => question.questionId === event.question.questionId ? event.question : question) : [...current.questions, event.question]
      break
    }
    case "resource-upsert": {
      const existing = current.resources.find((resource) => resource.resourceId === event.resource.resourceId)
      if (existing && event.resource.version < existing.version) return resync("Resource version moved backwards.")
      next.resources = existing ? current.resources.map((resource) => resource.resourceId === event.resource.resourceId ? event.resource : resource) : [...current.resources, event.resource]
      break
    }
    case "capabilities-upsert":
      if (event.capabilities.version < current.capabilities.version) return resync("Capabilities version moved backwards.")
      next.capabilities = event.capabilities
      break
  }
  return { state: { snapshot: next, syncStatus: "ready", error: null }, disposition: "applied" }
}

export function replaceWorkspaceSnapshot(state: WorkspaceProjection, input: unknown): WorkspaceReduction {
  const parsed = WorkspaceSnapshotSchema.safeParse(input)
  if (!parsed.success) return { state, disposition: "invalid" }
  const snapshot = parsed.data
  const previous = state.snapshot
  if (snapshot.session.sessionId !== previous.session.sessionId || snapshot.session.workspaceId !== previous.session.workspaceId || snapshot.watermark.streamId !== previous.watermark.streamId) return { state, disposition: "invalid" }
  if (snapshot.watermark.epoch < previous.watermark.epoch || snapshot.watermark.seq < previous.watermark.seq) return { state, disposition: "old-epoch" }
  return { state: { snapshot, syncStatus: "ready", error: null }, disposition: "applied" }
}
