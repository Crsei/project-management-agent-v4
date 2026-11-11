import { z } from "zod";
import { pmChangeSetSchema } from "./pm-changes.ts";
import { agentChatToolResultSchema } from "./pm-tool-result.ts";
import { pmToolLinkageSchema } from "./pm-tool-linkage.ts";
export { pmToolLinkageSchema, type PmToolLinkage } from "./pm-tool-linkage.ts";

/** A PM business authority target, never an Agent directory or Session owner. */
export const pmToolTargetSchema = z.strictObject({
  workspaceId: z.uuid().toLowerCase(),
  projectId: z.string().regex(/^PRJ-\d+$/).nullable(),
});
export type PmToolTarget = z.infer<typeof pmToolTargetSchema>;

export const pmToolRequestSchema = z.strictObject({
  operationId: z.uuid().toLowerCase(), name: z.string().min(1).max(100),
  arguments: z.unknown(), target: pmToolTargetSchema,
  threadId: z.string().max(200).default(""), messageId: z.string().max(200).default(""),
  generationId: z.string().max(200).default(""), linkage: pmToolLinkageSchema.optional(),
  executionRoot: z.literal("external").optional(),
}).superRefine((value, context) => {
  if (value.arguments === undefined) context.addIssue({ code: "custom", path: ["arguments"], message: "Arguments are required" });
  const external = value.executionRoot === "external" || value.linkage?.executionRoot === "external";
  if (!external && (!value.threadId || !value.messageId || !value.generationId))
    context.addIssue({ code: "custom", message: "Chat execution requires its original correlation IDs" });
  if (external && (value.threadId || value.messageId || value.generationId))
    context.addIssue({ code: "custom", message: "External execution does not create Chat correlation IDs" });
});
export type PmToolRequest = z.infer<typeof pmToolRequestSchema>;

/** Service-only proof of the original request; contains no business arguments. */
export const pmToolReconcileRequestSchema = z.strictObject({
  operationId: z.uuid().toLowerCase(), actorId: z.uuid().toLowerCase(),
  target: pmToolTargetSchema, requestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PmToolReconcileRequest = z.infer<typeof pmToolReconcileRequestSchema>;
export const pmToolReconcileResultSchema = pmToolReconcileRequestSchema.extend({
  status: z.enum(["succeeded", "failed", "unknown"]),
  evidence: z.enum(["operation", "command_receipt", "native_journal", "unresolved"]),
  commandIds: z.array(z.string().min(1).max(200)).max(100),
  linkage: pmToolLinkageSchema.optional(),
}).strict();
export type PmToolReconcileResult = z.infer<typeof pmToolReconcileResultSchema>;

export const pmToolInvocationSchema = z.strictObject({
  operationId: z.uuid(), name: z.string().min(1).max(100),
  target: pmToolTargetSchema.optional(), arguments: z.unknown(),
}).superRefine((input, context) => {
  if (input.arguments === undefined)
    context.addIssue({ code: "custom", path: ["arguments"], message: "Tool arguments are required." });
  if (input.name !== "pm_list_workspaces" && !input.target)
    context.addIssue({ code: "custom", path: ["target"], message: "An explicit PM workspace/project target is required." });
  if (input.name === "pm_list_workspaces" && input.target)
    context.addIssue({ code: "custom", path: ["target"], message: "Workspace discovery does not accept a target." });
});
export type PmToolInvocation = z.infer<typeof pmToolInvocationSchema>;

export const pmAuthorizedOperationSchema = z.strictObject({
  actorId: z.uuid(), target: pmToolTargetSchema,
});
export type PmAuthorizedOperation = z.infer<typeof pmAuthorizedOperationSchema>;

/** Discovery exposes business labels and IDs only, never code paths or credentials. */
export const pmWorkspaceDiscoverySchema = z.object({
  workspaces: z.array(z.object({
    id: z.uuid(), name: z.string(),
    workspaceAllowed: z.boolean().optional(),
    projects: z.array(z.object({ id: z.string().regex(/^PRJ-\d+$/), name: z.string() })),
  })),
});
export type PmWorkspaceDiscovery = z.infer<typeof pmWorkspaceDiscoverySchema>;

/** PM owns the business result payload; Chat owns its presentation record. */
export const pmToolCallRecordSchema = z.object({
  operationId: z.uuid(), name: z.string().min(1),
  status: z.enum(["pending_approval", "running", "succeeded", "failed", "unknown"]),
  result: agentChatToolResultSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  threadId: z.string(), messageId: z.string(), generationId: z.string(), workspaceId: z.string().nullable(),
  target: pmToolTargetSchema.optional(),
  /** Present on new authoritative PM results; historical receipts may omit it. */
  actorId: z.uuid().optional(),
  createdAt: z.string(), finishedAt: z.string().nullable(),
  /** The validated tool input, when the producer exposes it; older records omit it. */
  arguments: z.unknown().optional(),
  /** Change details supplied by the producer; consumers must never infer missing values. */
  changeSet: pmChangeSetSchema.optional(),
  visibility: z.enum(["visible", "redacted", "unavailable"]).optional(),
  certainty: z.strictObject({
    dispatch: z.enum(["not_sent", "possibly_sent"]),
    evidence: z.enum(["local_rejection", "pm_result", "internal_proof", "unresolved"]),
  }).optional(),
  linkage: pmToolLinkageSchema.optional(),
  /** Original command set; empty on reads, absent on historical unlinked operations. */
  commandIds: z.array(z.string().min(1).max(200)).max(100).optional(),
  /** Safe nonblocking diagnostics; never an approval or an operation permission. */
  notices: z.array(z.strictObject({ code: z.string().min(1).max(100), message: z.string().min(1).max(500) })).max(20).optional(),
});
export type PmToolCallRecord = z.infer<typeof pmToolCallRecordSchema>;

/** A denied projection has no business identity, status, arguments, result or error. */
export const pmToolCallPlaceholderSchema = z.strictObject({
  operationId: z.uuid(), threadId: z.string(), messageId: z.string(), generationId: z.string(),
  visibility: z.enum(["redacted", "unavailable"]),
});
export const pmToolCallProjectionSchema = z.union([
  pmToolCallPlaceholderSchema, pmToolCallRecordSchema.extend({ visibility: z.literal("visible") }),
]);
export type PmToolCallProjection = z.infer<typeof pmToolCallProjectionSchema>;
