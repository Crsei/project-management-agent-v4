import { z } from "zod";
import { pmToolLinkageSchema } from "./pm-tool-linkage.ts";

const identifier = z.string().min(1).max(200);
const timestamp = z.iso.datetime({ offset: true });
export const agentChatContextSourceSchema = z.strictObject({
  kind: z.enum(["project", "task", "document", "comment", "relation"]), workspaceId: z.uuid(), projectId: z.string().nullable(),
  entityId: identifier, title: z.string(), revision: z.string(), truncated: z.boolean(),
});
export type AgentChatContextSource = z.infer<typeof agentChatContextSourceSchema>;
export const agentChatToolEntitySchema = z.strictObject({
  id: identifier, projectId: z.string().nullable(), entity: z.enum(["project", "work_item", "document"]), title: z.string(),
  revision: z.string(), version: z.number().int().nonnegative(), status: z.string().nullable(), body: z.string().optional(),
  bodyOffset: z.number().int().nonnegative().optional(), nextBodyOffset: z.number().int().nonnegative().nullable().optional(),
  fields: z.strictObject({
    goal: z.string().nullable().optional(), assigneeId: z.string().nullable().optional(), priority: z.string().nullable().optional(),
    startDate: z.string().nullable().optional(), dueDate: z.string().nullable().optional(), labels: z.array(z.string()).optional(),
  }).optional(),
});
export type AgentChatToolEntity = z.infer<typeof agentChatToolEntitySchema>;
export const agentChatToolCommentSchema = z.strictObject({
  id: identifier, taskId: identifier, projectId: identifier, content: z.string().nullable(), version: z.number().int().positive(), deletedAt: timestamp.nullable(),
});
export type AgentChatToolComment = z.infer<typeof agentChatToolCommentSchema>;
export const agentChatToolRelationSchema = z.strictObject({ sourceId: identifier, targetId: identifier, relation: identifier, sourceRevision: z.string(), targetRevision: z.string() });
export type AgentChatToolRelation = z.infer<typeof agentChatToolRelationSchema>;
export const agentChatToolReceiptSchema = z.strictObject({
  kind: z.enum(["command", "core"]), operationId: identifier, commandId: identifier, action: identifier, targetId: z.string().nullable(), revision: z.string().nullable(),
  linkage: pmToolLinkageSchema.optional(),
});
export type AgentChatToolReceipt = z.infer<typeof agentChatToolReceiptSchema>;
const resultFields = { nextCursor: z.string().nullable(), truncated: z.boolean(), sources: z.array(agentChatContextSourceSchema), receipt: agentChatToolReceiptSchema.optional() };
export const agentChatToolResultSchema = z.union([
  z.strictObject({ kind: z.enum(["project", "task", "document", "query"]), items: z.array(agentChatToolEntitySchema), ...resultFields }),
  z.strictObject({ kind: z.literal("comment"), items: z.array(agentChatToolCommentSchema), ...resultFields }),
  z.strictObject({ kind: z.literal("relation"), items: z.array(agentChatToolRelationSchema), ...resultFields }),
  // Lifecycle writes may leave no current entity (permanent deletion); the receipt still proves the original outcome.
  z.strictObject({ kind: z.literal("lifecycle"), items: z.array(agentChatToolEntitySchema), ...resultFields }),
  z.strictObject({ kind: z.literal("workspaces"), items: z.array(z.strictObject({
    id: z.uuid(), name: z.string(), workspaceAllowed: z.boolean().optional(),
    projects: z.array(z.strictObject({ id: identifier, name: z.string() })),
  })), ...resultFields }),
]);
export type AgentChatToolResult = z.infer<typeof agentChatToolResultSchema>;
