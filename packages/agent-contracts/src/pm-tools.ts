import { z } from "zod";
import { pmChangeSetSchema } from "./pm-changes.ts";
import { agentChatToolResultSchema } from "./pm-tool-result.ts";

/** A PM business authority target, never an Agent directory or Session owner. */
export const pmToolTargetSchema = z.strictObject({
  workspaceId: z.uuid().toLowerCase(),
  projectId: z.string().regex(/^PRJ-\d+$/).nullable(),
});
export type PmToolTarget = z.infer<typeof pmToolTargetSchema>;

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
});
export type PmToolCallRecord = z.infer<typeof pmToolCallRecordSchema>;
