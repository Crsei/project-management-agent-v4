import { z } from "zod"
import {
  EngineIdentitySchema, EngineRequestIdSchema, WorkspaceActionSchema, WorkspaceDigestSchema,
  WorkspaceErrorSchema, WorkspaceIdSchema, WorkspaceTimestampSchema, WorkspaceVersionSchema,
} from "./primitives.ts"
import type { WorkspaceAction, WorkspaceError } from "./primitives.ts"
import { WorkspaceCommandSchema, WorkspaceOperationTargetSchema } from "./commands.ts"

export const OperationStatusSchema = z.enum(["pending", "confirmed", "failed", "unknown"])
export const ConfirmationKindSchema = z.enum(["host-committed", "engine-accepted", "run-ended"])
export const DispatchStatusSchema = z.enum(["prepared", "dispatched", "source-accepted"])
export type OperationStatus = z.infer<typeof OperationStatusSchema>
export type ConfirmationKind = z.infer<typeof ConfirmationKindSchema>
export type DispatchStatus = z.infer<typeof DispatchStatusSchema>
const HOST_COMMITTED_ACTIONS: Partial<Record<WorkspaceAction, true>> = {
  rename: true, archive: true, "save-draft": true, "upload-attachment": true, "delete-attachment": true,
  "create-worktree": true, "remove-worktree": true, "create-terminal": true, "terminate-terminal": true,
  "create-skill": true, "update-skill": true, "abandon-operation": true, "review-feedback": true,
}
const FINAL_EVIDENCE_BY_STATUS: Record<OperationStatus, readonly string[]> = {
  pending: ["prepared", "dispatched", "source-prepared", "not-dispatched"],
  confirmed: ["host-committed", "source-accepted", "run-ended"],
  failed: ["host-rejected", "source-rejected"],
  unknown: ["outcome-unknown"],
}
export const EngineOperationLinkSchema = z.strictObject({
  source: EngineIdentitySchema.extend({ threadId: WorkspaceIdSchema.nullable() }),
  requestId: EngineRequestIdSchema.nullable(),
  clientUserMessageId: WorkspaceIdSchema.nullable(),
  turnId: WorkspaceIdSchema.nullable(),
  itemId: WorkspaceIdSchema.nullable(),
})
export type EngineOperationLink = z.infer<typeof EngineOperationLinkSchema>
export const WorkspaceOperationResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session"), sessionId: WorkspaceIdSchema }),
  z.strictObject({ kind: z.literal("run"), sessionId: WorkspaceIdSchema, runId: WorkspaceIdSchema, turnId: WorkspaceIdSchema }),
  z.strictObject({ kind: z.literal("draft"), draftId: WorkspaceIdSchema, draftVersion: WorkspaceVersionSchema }),
  z.strictObject({ kind: z.literal("resource"), resourceId: WorkspaceIdSchema, version: WorkspaceVersionSchema }),
  z.strictObject({ kind: z.literal("terminal"), terminalId: WorkspaceIdSchema, generation: WorkspaceVersionSchema }),
  z.strictObject({ kind: z.literal("workspace"), workspaceId: WorkspaceIdSchema, version: WorkspaceVersionSchema }),
  z.strictObject({ kind: z.literal("settings"), sessionId: WorkspaceIdSchema, version: WorkspaceVersionSchema }),
  z.strictObject({ kind: z.literal("approval"), approvalId: WorkspaceIdSchema }),
  z.strictObject({ kind: z.literal("question"), questionId: WorkspaceIdSchema }),
  z.strictObject({ kind: z.literal("skill"), skillId: WorkspaceIdSchema, version: WorkspaceVersionSchema }),
  z.strictObject({ kind: z.literal("abandoned"), operationId: WorkspaceIdSchema }),
  z.strictObject({ kind: z.literal("none") }),
])
export type WorkspaceOperationResult = z.infer<typeof WorkspaceOperationResultSchema>
const evidenceFields = { evidenceId: WorkspaceIdSchema, at: WorkspaceTimestampSchema }
export const OperationEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...evidenceFields, kind: z.literal("prepared") }),
  z.strictObject({ ...evidenceFields, kind: z.literal("dispatched"), link: EngineOperationLinkSchema }),
  z.strictObject({ ...evidenceFields, kind: z.literal("source-prepared"), link: EngineOperationLinkSchema }),
  z.strictObject({ ...evidenceFields, kind: z.literal("source-accepted"), link: EngineOperationLinkSchema, result: WorkspaceOperationResultSchema }),
  z.strictObject({ ...evidenceFields, kind: z.literal("host-committed"), result: WorkspaceOperationResultSchema }),
  z.strictObject({ ...evidenceFields, kind: z.literal("run-ended"), link: EngineOperationLinkSchema, runStatus: z.enum(["completed", "failed", "interrupted"]), result: WorkspaceOperationResultSchema }),
  z.strictObject({ ...evidenceFields, kind: z.literal("source-rejected"), link: EngineOperationLinkSchema, error: WorkspaceErrorSchema }),
  z.strictObject({ ...evidenceFields, kind: z.literal("host-rejected"), error: WorkspaceErrorSchema }),
  z.strictObject({ ...evidenceFields, kind: z.literal("outcome-unknown"), error: WorkspaceErrorSchema }),
  z.strictObject({ ...evidenceFields, kind: z.literal("not-dispatched"), preparedVersion: WorkspaceVersionSchema }),
])
export type OperationEvidence = z.infer<typeof OperationEvidenceSchema>
export const WorkspaceOperationReceiptSchema = z.strictObject({
  operationId: WorkspaceIdSchema,
  action: WorkspaceActionSchema,
  target: WorkspaceOperationTargetSchema,
  version: WorkspaceVersionSchema,
  status: OperationStatusSchema,
  confirmationKind: ConfirmationKindSchema.nullable(),
  dispatchStatus: DispatchStatusSchema,
  engineLink: EngineOperationLinkSchema.nullable(),
  draftId: WorkspaceIdSchema.nullable(),
  draftVersion: WorkspaceVersionSchema.nullable(),
  result: WorkspaceOperationResultSchema.nullable(),
  error: WorkspaceErrorSchema.nullable(),
  evidence: z.array(OperationEvidenceSchema).min(1),
  createdAt: WorkspaceTimestampSchema,
  updatedAt: WorkspaceTimestampSchema,
}).superRefine((receipt, context) => {
  const latest = receipt.evidence.at(-1)
  if (!latest || !FINAL_EVIDENCE_BY_STATUS[receipt.status].includes(latest.kind)) {
    context.addIssue({ code: "custom", path: ["status"], message: "Receipt status must match its latest durable evidence." })
  }
  if (receipt.confirmationKind === "host-committed" && !HOST_COMMITTED_ACTIONS[receipt.action]) {
    context.addIssue({ code: "custom", path: ["confirmationKind"], message: "Host registration cannot confirm an engine command." })
  }
  if (receipt.dispatchStatus === "source-accepted" && receipt.status !== "confirmed") {
    context.addIssue({ code: "custom", path: ["status"], message: "Source acceptance remains confirmed; run failures are separate." })
  }
  if ((receipt.status === "confirmed") !== (receipt.confirmationKind !== null)) {
    context.addIssue({ code: "custom", path: ["confirmationKind"], message: "Only confirmed receipts have a confirmation grade." })
  }
  if (receipt.status === "confirmed" && receipt.result === null) {
    context.addIssue({ code: "custom", path: ["result"], message: "Confirmed receipts require an evidenced result." })
  }
  if ((receipt.status === "failed" || receipt.status === "unknown") && receipt.error === null) {
    context.addIssue({ code: "custom", path: ["error"], message: "Failed or unknown receipts require an error." })
  }
  if (receipt.status === "unknown" && receipt.error?.retryable) {
    context.addIssue({ code: "custom", path: ["error", "retryable"], message: "Unknown effects cannot be automatically replayed." })
  }
  if ((receipt.dispatchStatus === "prepared") !== (receipt.engineLink === null)) {
    context.addIssue({ code: "custom", path: ["engineLink"], message: "Prepared operations have no source dispatch; dispatched operations require correlation." })
  }
  if (receipt.evidence[0]?.kind !== "prepared") {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Every operation begins with durable preparation." })
  }
  if (receipt.dispatchStatus !== "prepared" && !receipt.evidence.some((evidence) => evidence.kind === "dispatched")) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Source evidence cannot replace pre-dispatch ledger evidence." })
  }
  let preparationSeen = false
  for (const evidence of receipt.evidence) if (evidence.kind === "source-prepared") {
    if (preparationSeen || receipt.action !== "create" || evidence.link.requestId === null || evidence.link.source.threadId === null) context.addIssue({ code: "custom", path: ["evidence"], message: "Only one source-backed creation preparation is allowed." })
    preparationSeen = true
  }
  if ((receipt.draftId === null) !== (receipt.draftVersion === null) || ((receipt.action === "send" || receipt.action === "steer") && receipt.draftId === null)) {
    context.addIssue({ code: "custom", path: ["draftId"], message: "Draft identity and submitted version must be recorded together." })
  }
  if (receipt.status !== "confirmed" && receipt.result !== null) {
    context.addIssue({ code: "custom", path: ["result"], message: "Unconfirmed receipts cannot carry a successful result." })
  }
  if (receipt.status === "confirmed" && receipt.error !== null) {
    context.addIssue({ code: "custom", path: ["error"], message: "Receipt acceptance and run outcome errors are distinct." })
  }
  const proofKind = receipt.confirmationKind === "engine-accepted" ? "source-accepted" : receipt.confirmationKind
  if (proofKind && !receipt.evidence.some((evidence) => evidence.kind === proofKind)) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Confirmation requires the corresponding durable evidence." })
  }
  if (receipt.dispatchStatus === "source-accepted" && !receipt.evidence.some((evidence) => evidence.kind === "source-accepted" || evidence.kind === "run-ended")) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Source acceptance requires source evidence." })
  }
  const proof = receipt.evidence.findLast((evidence) => evidence.kind === proofKind)
  if (proof && "result" in proof && JSON.stringify(proof.result) !== JSON.stringify(receipt.result)) {
    context.addIssue({ code: "custom", path: ["result"], message: "Receipt result must match its confirmation evidence." })
  }
  if (proof && "link" in proof && (!receipt.engineLink || !sameSource(receipt.engineLink, proof.link))) {
    context.addIssue({ code: "custom", path: ["engineLink"], message: "Receipt source must match its confirmation evidence." })
  }
  if (new Set(receipt.evidence.map((evidence) => evidence.evidenceId)).size !== receipt.evidence.length) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Evidence IDs must be unique." })
  }
})
export type WorkspaceOperationReceipt = z.infer<typeof WorkspaceOperationReceiptSchema>
export const ServerOperationRecordSchema = z.strictObject({
  ownerId: WorkspaceIdSchema,
  payloadDigest: WorkspaceDigestSchema,
  command: WorkspaceCommandSchema,
  receipt: WorkspaceOperationReceiptSchema,
}).superRefine((record, context) => {
  if (record.command.operationId !== record.receipt.operationId || record.command.action !== record.receipt.action || JSON.stringify(record.command.target) !== JSON.stringify(record.receipt.target)) {
    context.addIssue({ code: "custom", path: ["receipt"], message: "Ledger receipt must refer to the stored command." })
  }
  const draftVersion = "draftVersion" in record.command ? record.command.draftVersion : null
  const draftId = "draftId" in record.command ? record.command.draftId : null
  if (record.receipt.draftVersion !== draftVersion || record.receipt.draftId !== draftId) {
    context.addIssue({ code: "custom", path: ["receipt", "draftVersion"], message: "Submitted draft version is immutable." })
  }
})
export type ServerOperationRecord = z.infer<typeof ServerOperationRecordSchema>

function sameSource(a: EngineOperationLink, b: EngineOperationLink, advancingPreparation = false): boolean {
  return a.source.adapter === b.source.adapter && a.source.engineIdentity === b.source.engineIdentity
    && (a.source.threadId === null || b.source.threadId === null || a.source.threadId === b.source.threadId) && a.source.epoch === b.source.epoch
    && (a.turnId === null || b.turnId === null || a.turnId === b.turnId)
    && (advancingPreparation || a.requestId === null || b.requestId === null || a.requestId === b.requestId)
    && (a.clientUserMessageId === null || b.clientUserMessageId === null || a.clientUserMessageId === b.clientUserMessageId)
    && (a.itemId === null || b.itemId === null || a.itemId === b.itemId)
}
export type OperationTransitionResult = { ok: true; receipt: WorkspaceOperationReceipt } | { ok: false; error: WorkspaceError }

// Evidence is produced by trusted Host/Adapter code after durable writes, never by a client command.
export function transitionOperation(receipt: WorkspaceOperationReceipt, evidence: OperationEvidence): OperationTransitionResult {
  const reject = (message: string): OperationTransitionResult => ({ ok: false, error: { code: "operation-conflict", message, retryable: false, operationId: receipt.operationId } })
  const duplicate = receipt.evidence.find((existing) => existing.evidenceId === evidence.evidenceId)
  if (duplicate) {
    const normalized = OperationEvidenceSchema.safeParse(evidence)
    return normalized.success && JSON.stringify(duplicate) === JSON.stringify(normalized.data)
      ? { ok: true, receipt } : reject("Evidence ID has conflicting content.")
  }
  const advancingPreparation = evidence.kind === "dispatched" && receipt.action === "create" && receipt.evidence.at(-1)?.kind === "source-prepared" && receipt.engineLink !== null && receipt.engineLink.source.threadId !== null && evidence.link.source.threadId === receipt.engineLink.source.threadId && evidence.link.requestId !== null && evidence.link.requestId !== receipt.engineLink.requestId
  if ("link" in evidence && receipt.engineLink && !sameSource(receipt.engineLink, evidence.link, advancingPreparation)) return reject("Source correlation or epoch does not match the operation.")
  if (receipt.status === "unknown" && "link" in evidence && receipt.engineLink) {
    const previous = receipt.engineLink
    const linked = evidence.link
    const matched = (previous.requestId !== null && previous.requestId === linked.requestId)
      || (previous.clientUserMessageId !== null && previous.clientUserMessageId === linked.clientUserMessageId)
      || (previous.turnId !== null && previous.turnId === linked.turnId)
      || (previous.itemId !== null && previous.itemId === linked.itemId)
    if (!matched) return reject("Unknown outcome needs a unique source correlation, not merely the same thread.")
  }
  if (receipt.status === "failed") return reject("A failed operation cannot be redispatched or confirmed.")
  if (receipt.status === "confirmed" && evidence.kind === "source-accepted"
    && (receipt.confirmationKind === "engine-accepted" || receipt.confirmationKind === "run-ended")
    && JSON.stringify(receipt.result) === JSON.stringify(evidence.result)) {
    return { ok: true, receipt: WorkspaceOperationReceiptSchema.parse({ ...receipt, version: receipt.version + 1, updatedAt: evidence.at, evidence: [...receipt.evidence, evidence] }) }
  }
  if (receipt.status === "confirmed" && evidence.kind !== "run-ended") return reject("A confirmed operation cannot lose its confirmation.")
  const next: WorkspaceOperationReceipt = { ...receipt, version: receipt.version + 1, updatedAt: evidence.at, evidence: [...receipt.evidence, evidence] }
  switch (evidence.kind) {
    case "prepared": return reject("Preparation is recorded once, before dispatch.")
    case "dispatched":
      if (receipt.status !== "pending" || receipt.dispatchStatus === "source-accepted") return reject("Only a pending operation may record pre-send dispatch correlation.")
      if (receipt.dispatchStatus === "dispatched" && (!receipt.engineLink || !sameSource(receipt.engineLink, evidence.link, advancingPreparation)
        || (receipt.engineLink.source.threadId !== null && receipt.engineLink.source.threadId !== evidence.link.source.threadId)
        || (receipt.engineLink.requestId !== null && receipt.engineLink.requestId !== evidence.link.requestId && !advancingPreparation)
        || (receipt.engineLink.clientUserMessageId !== null && receipt.engineLink.clientUserMessageId !== evidence.link.clientUserMessageId)
        || (receipt.engineLink.turnId !== null && receipt.engineLink.turnId !== evidence.link.turnId)
        || (receipt.engineLink.itemId !== null && receipt.engineLink.itemId !== evidence.link.itemId))) return reject("Dispatch refinement cannot erase or change known source correlation.")
      next.dispatchStatus = "dispatched"
      next.engineLink = evidence.link
      break
    case "source-prepared":
      if (receipt.action !== "create" || receipt.status !== "pending" || receipt.dispatchStatus !== "dispatched" || evidence.link.requestId === null || evidence.link.source.threadId === null || receipt.evidence.some(proof => proof.kind === "source-prepared")) return reject("Creation preparation requires one acknowledged source request before the final dispatch.")
      next.engineLink = evidence.link
      break
    case "source-accepted":
      if (receipt.dispatchStatus === "prepared") return reject("Acceptance cannot precede recorded dispatch.")
      if (receipt.action === "create" && receipt.evidence.some(proof => proof.kind === "source-prepared" && proof.link.requestId === receipt.engineLink?.requestId)) return reject("Creation preparation is not final creation acceptance.")
      next.dispatchStatus = "source-accepted"
      next.engineLink = evidence.link
      next.status = "confirmed"
      next.confirmationKind = "engine-accepted"
      next.result = evidence.result
      next.error = null
      break
    case "host-committed":
      if (receipt.status !== "pending" || !HOST_COMMITTED_ACTIONS[receipt.action]
        || (receipt.dispatchStatus !== "prepared" && !(receipt.dispatchStatus === "dispatched" && receipt.engineLink?.source.adapter === "agent-host"))) return reject("Host commit cannot substitute for an engine command or possible engine dispatch.")
      next.status = "confirmed"
      next.confirmationKind = "host-committed"
      next.result = evidence.result
      next.error = null
      break
    case "run-ended":
      if (receipt.dispatchStatus === "prepared" || (receipt.status === "confirmed" && receipt.confirmationKind !== "engine-accepted")) return reject("Run end requires an engine-dispatched operation.")
      next.dispatchStatus = "source-accepted"
      next.engineLink = evidence.link
      next.status = "confirmed"
      next.confirmationKind = "run-ended"
      next.result = evidence.result
      next.error = null
      break
    case "source-rejected":
      if (receipt.dispatchStatus === "prepared") return reject("Source rejection requires recorded dispatch.")
      next.engineLink = evidence.link
      next.status = "failed"
      next.error = evidence.error
      break
    case "host-rejected":
      if (receipt.status !== "pending" || receipt.dispatchStatus !== "prepared") return reject("Host failure cannot prove an engine outcome.")
      next.status = "failed"
      next.error = evidence.error
      break
    case "outcome-unknown":
      if (evidence.error.retryable) return reject("Unknown operations cannot be marked retryable.")
      next.status = "unknown"
      next.confirmationKind = null
      next.result = null
      next.error = evidence.error
      break
    case "not-dispatched":
      if (receipt.status !== "unknown" || receipt.dispatchStatus !== "prepared" || evidence.preparedVersion !== receipt.version) return reject("Redispatch needs exact durable proof of non-dispatch.")
      next.status = "pending"
      next.error = null
      break
  }
  return { ok: true, receipt: next }
}

export function mayDispatchOperation(receipt: WorkspaceOperationReceipt): boolean {
  return receipt.status === "pending" && receipt.dispatchStatus === "prepared" && receipt.engineLink === null
}
export function operationBlocksConflictingWrites(receipt: WorkspaceOperationReceipt): boolean {
  return receipt.status === "pending" || receipt.status === "unknown"
}
export function operationClearsDraft(receipt: WorkspaceOperationReceipt, draftId: string, draftVersion: number): boolean {
  if (receipt.status !== "confirmed" || (receipt.confirmationKind !== "engine-accepted" && receipt.confirmationKind !== "run-ended")) return false
  if (receipt.action !== "send" && receipt.action !== "steer") return false
  return receipt.draftId === draftId && receipt.draftVersion === draftVersion && receipt.evidence.some((evidence) =>
    (evidence.kind === "source-accepted" || evidence.kind === "run-ended") && evidence.result.kind === "run") && receipt.result?.kind === "run"
}

export type OperationAttemptResolution =
  | { kind: "new" }
  | { kind: "existing"; receipt: WorkspaceOperationReceipt }
  | { kind: "conflict"; error: WorkspaceError }

// Host computes the canonical digest and queries by authenticated owner/operationId under its ledger lock.
// Returning an existing unknown receipt is a query result, never permission to dispatch it again.
export function resolveOperationAttempt(existing: ServerOperationRecord | null, ownerId: string, operationId: string, payloadDigest: string): OperationAttemptResolution {
  if (!existing) return { kind: "new" }
  if (existing.ownerId !== ownerId) return { kind: "conflict", error: { code: "forbidden", message: "Operation is not owned by the authenticated identity.", retryable: false } }
  if (existing.command.operationId !== operationId || existing.payloadDigest !== payloadDigest) return { kind: "conflict", error: { code: "operation-conflict", message: "Operation ID was already used with a different payload.", retryable: false, operationId } }
  return { kind: "existing", receipt: existing.receipt }
}
