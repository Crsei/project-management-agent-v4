import { z } from 'zod';

/** Private chat; only trusted, explicitly authorized tools can change PM facts. */
export type AgentChatMessageRole = 'user' | 'assistant';
export type AgentChatMessageStatus = 'complete' | 'streaming' | 'cancelled' | 'error' | 'interrupted';
export const agentChatReasoningEffortSchema = z.enum(['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type AgentChatReasoningEffort = z.infer<typeof agentChatReasoningEffortSchema>;
export const agentChatReasoningSchema = z.strictObject({
  supported: z.boolean(), efforts: z.array(agentChatReasoningEffortSchema), defaultEffort: z.literal('auto'),
});
export type AgentChatReasoning = z.infer<typeof agentChatReasoningSchema>;
const identifier = z.string().min(1).max(200);
const timestamp = z.iso.datetime({ offset: true });
export const agentChatScopeSchema = z.strictObject({ kind: z.enum(['projects', 'workspace']), projectIds: z.array(z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/)).max(1000) });
export type AgentChatScope = z.infer<typeof agentChatScopeSchema>;
export const agentChatAccessInputSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(true), expectedRevision: z.number().int().nonnegative(), scope: agentChatScopeSchema }),
  z.strictObject({ enabled: z.literal(false), expectedRevision: z.number().int().nonnegative(), scope: agentChatScopeSchema.optional() }),
]);
export type AgentChatAccessInput = z.infer<typeof agentChatAccessInputSchema>;
export const agentChatToolCapabilitySchema = z.strictObject({
  name: identifier, description: z.string(), write: z.boolean(), available: z.boolean(), allowed: z.boolean(), denyReason: z.string().nullable(),
});
export type AgentChatToolCapability = z.infer<typeof agentChatToolCapabilitySchema>;
export const agentChatAccessSchema = z.strictObject({
  workspaceId: z.uuid(), threadId: z.uuid(), revision: z.number().int().nonnegative(), grantId: z.uuid().nullable(),
  mode: z.literal('full_access'), approvalPolicy: z.literal('auto_approve'), enabled: z.boolean(), scope: agentChatScopeSchema,
  expiresAt: timestamp.nullable(), revokedAt: timestamp.nullable(), toolsVersion: z.number().int().positive(),
  toolSupport: z.enum(['unverified', 'verified']), tools: z.array(agentChatToolCapabilitySchema),
  limits: z.strictObject({ maxToolCalls: z.number().int().positive(), maxRounds: z.number().int().positive(), maxOutputChars: z.number().int().positive() }),
});
export type AgentChatAccess = z.infer<typeof agentChatAccessSchema>;
export const agentChatContextSourceSchema = z.strictObject({
  kind: z.enum(['project', 'task', 'document', 'comment', 'relation']), workspaceId: z.uuid(), projectId: z.string().nullable(),
  entityId: identifier, title: z.string(), revision: z.string(), truncated: z.boolean(),
});
export type AgentChatContextSource = z.infer<typeof agentChatContextSourceSchema>;
export const agentChatToolEntitySchema = z.strictObject({
  id: identifier, projectId: z.string().nullable(), entity: z.enum(['project', 'work_item', 'document']), title: z.string(),
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
  kind: z.enum(['command', 'core']), operationId: identifier, commandId: identifier, action: identifier, targetId: z.string().nullable(), revision: z.string().nullable(),
});
export type AgentChatToolReceipt = z.infer<typeof agentChatToolReceiptSchema>;
const resultFields = { nextCursor: z.string().nullable(), truncated: z.boolean(), sources: z.array(agentChatContextSourceSchema), receipt: agentChatToolReceiptSchema.optional() };
export const agentChatToolResultSchema = z.union([
  z.strictObject({ kind: z.enum(['project', 'task', 'document', 'query']), items: z.array(agentChatToolEntitySchema), ...resultFields }),
  z.strictObject({ kind: z.literal('comment'), items: z.array(agentChatToolCommentSchema), ...resultFields }),
  z.strictObject({ kind: z.literal('relation'), items: z.array(agentChatToolRelationSchema), ...resultFields }),
]);
export type AgentChatToolResult = z.infer<typeof agentChatToolResultSchema>;
export const agentChatToolCallSchema = z.strictObject({
  id: identifier, operationId: z.uuid(), name: identifier, arguments: z.record(z.string(), z.unknown()),
  status: z.enum(['running', 'succeeded', 'failed', 'unknown']), startedAt: timestamp, finishedAt: timestamp.nullable(),
  grantId: z.uuid(), onBehalfOf: z.uuid(), approvalPolicy: z.literal('auto_approve'),
  result: agentChatToolResultSchema.nullable(), error: z.strictObject({ code: identifier, message: z.string() }).nullable(),
});
export type AgentChatToolCall = z.infer<typeof agentChatToolCallSchema>;
export const agentChatMessageSchema = z.strictObject({
  id: z.uuid(), threadId: z.uuid(), role: z.enum(['user', 'assistant']), content: z.string(),
  status: z.enum(['complete', 'streaming', 'cancelled', 'error', 'interrupted']), errorCode: z.string().nullable(), model: z.string().nullable(),
  createdAt: timestamp, updatedAt: timestamp,
  // Existing persisted histories and older clients may not include tool metadata.
  toolCalls: z.array(agentChatToolCallSchema).optional(), contextSources: z.array(agentChatContextSourceSchema).optional(),
});
export type AgentChatMessage = z.infer<typeof agentChatMessageSchema>;
export type AgentChatThread = { id: string; title: string; createdAt: string; updatedAt: string; lastMessageAt: string | null; messageCount: number };
export type AgentChatThreadList = { items: AgentChatThread[] };
export type AgentChatThreadDetail = { thread: AgentChatThread; messages: AgentChatMessage[] };
export type AgentChatStatus = { enabled: boolean; provider: 'openai-compatible'; model: string | null; reasoning: AgentChatReasoning };
export type AgentChatStreamEvent =
  | { type: 'user'; message: AgentChatMessage }
  | { type: 'assistant'; message: AgentChatMessage }
  | { type: 'delta'; messageId: string; delta: string }
  | { type: 'capabilities'; messageId: string; access: AgentChatAccess }
  | { type: 'context'; messageId: string; sources: AgentChatContextSource[] }
  | { type: 'tool'; messageId: string; toolCall: AgentChatToolCall }
  | { type: 'done'; message: AgentChatMessage }
  | { type: 'cancelled'; message: AgentChatMessage }
  | { type: 'error'; messageId: string | null; code: string; message: string };
