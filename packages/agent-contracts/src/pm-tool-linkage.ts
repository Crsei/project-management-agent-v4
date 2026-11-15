import { z } from "zod";

/** Finite PM wire projection; this package builds independently of PM domain/server. */
export const pmCollaborationSourceSchema = z.strictObject({
  runId: z.string().trim().min(1).max(128), agentId: z.string().trim().min(1).max(128),
  agentVersion: z.number().int().positive(), delegationId: z.string().trim().min(1).max(128).nullable(),
  target: z.strictObject({
    workspaceId: z.uuid(), projectId: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).max(80), taskId: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).max(80),
    taskRevision: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
export const pmCommentAgentOriginSchema = pmCollaborationSourceSchema.extend({
  operationId: z.uuid(), threadId: z.string().min(1).max(200), generationId: z.string().min(1).max(200),
}).strict();
export type PmCollaborationSource = z.infer<typeof pmCollaborationSourceSchema>;

/** Server-attested correlation, never a permission or an idempotency key. */
export const pmToolLinkageSchema = z.strictObject({
  traceId: z.uuid(), invocationId: z.uuid(),
  executionRoot: z.enum(["generation", "external"]),
  inputMessageId: z.string().min(1).max(200).optional(),
  executionGrantId: z.uuid().optional(),
  clientKind: z.enum(["chat", "mcp", "cli", "plugin", "automation", "api"]),
  policy: z.literal("full"), enforcement: z.literal("audit-only"),
  collaboration: pmCollaborationSourceSchema.optional(),
});
export type PmToolLinkage = z.infer<typeof pmToolLinkageSchema>;
