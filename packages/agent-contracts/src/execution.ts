import { z } from "zod";

const identifier = z.string().trim().min(1).max(128);
const revision = z.number().int().positive();

export const agentWorkspaceSchema = z.strictObject({
  id: identifier,
  name: z.string().trim().min(1).max(200),
  path: z.string().min(1),
  revision,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  status: z.enum(["available", "unavailable"]),
  reason: z.string().optional(),
});
export type AgentWorkspace = z.infer<typeof agentWorkspaceSchema>;

export const executionSelectionSchema = z.strictObject({
  version: z.literal(2),
  agentWorkspaceId: identifier.nullable(),
  agentWorkspaceRevision: revision.nullable(),
}).superRefine((value, context) => {
  if ((value.agentWorkspaceId === null) !== (value.agentWorkspaceRevision === null)) {
    context.addIssue({ code: "custom", message: "Select an Agent workspace revision or explicit chat-only execution." });
  }
});
export type ExecutionSelection = z.infer<typeof executionSelectionSchema>;
export const chatOnlyExecutionSelection = (): ExecutionSelection => ({
  version: 2,
  agentWorkspaceId: null,
  agentWorkspaceRevision: null,
});

export const executionEnvironmentSchema = z.strictObject({
  version: z.literal(2),
  hostId: z.literal("local"),
  agentWorkspaceId: identifier.nullable(),
  agentWorkspaceName: z.string().nullable(),
  agentWorkspaceRevision: revision.nullable(),
  sourcePath: z.string().min(1).nullable(),
  executionPath: z.string().min(1).nullable(),
  worktree: z.strictObject({ deliveryId: z.string().nullable(), branch: z.string().nullable() }).nullable(),
  frozen: z.boolean(),
}).superRefine((value, context) => {
  const valid = value.agentWorkspaceId === null
    ? value.agentWorkspaceName === null && value.agentWorkspaceRevision === null && value.sourcePath === null && value.executionPath === null && value.worktree === null
    : value.agentWorkspaceName !== null && value.agentWorkspaceRevision !== null && value.sourcePath !== null && value.executionPath !== null;
  if (!valid) context.addIssue({ code: "custom", message: "Execution environment must describe one Agent directory or private chat-only execution." });
});
export type ExecutionEnvironment = z.infer<typeof executionEnvironmentSchema>;
