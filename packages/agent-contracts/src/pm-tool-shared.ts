import { z } from 'zod';
import { pmToolLinkageSchema, pmCommentAgentOriginSchema } from './pm-tool-linkage.ts';

const identifier = z.string().min(1).max(200);
const timestamp = z.iso.datetime({ offset: true });
export const agentChatContextSourceSchema = z.strictObject({
  kind: z.enum(['project', 'task', 'document', 'comment', 'relation', 'workflow', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goal']), workspaceId: z.uuid(), projectId: z.string().nullable(),
  entityId: identifier, title: z.string(), revision: z.string(), truncated: z.boolean(),
});
export type AgentChatContextSource = z.infer<typeof agentChatContextSourceSchema>;
export const agentChatToolFieldValueSchema = z.union([z.string().max(24000), z.number().finite(), z.boolean(), z.array(z.string().max(4000)).max(1000), z.null()]);
export const agentChatToolEntitySchema = z.strictObject({
  id: identifier, projectId: z.string().nullable(), entity: z.enum(['project', 'work_item', 'document', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goal']), title: z.string(),
  revision: z.string(), version: z.number().int().nonnegative(), status: z.string().nullable(), archived: z.boolean().optional(), body: z.string().optional(),
  bodyOffset: z.number().int().nonnegative().optional(), nextBodyOffset: z.number().int().nonnegative().nullable().optional(),
  fields: z.strictObject({
    goal: z.string().nullable().optional(), assigneeId: z.string().nullable().optional(), priority: z.string().nullable().optional(),
    startDate: z.string().nullable().optional(), dueDate: z.string().nullable().optional(), labels: z.array(z.string()).optional(),
  }).optional(),
  properties: z.array(z.strictObject({ field: z.string().min(1).max(128), value: agentChatToolFieldValueSchema })).max(200).optional(),
});
export type AgentChatToolEntity = z.infer<typeof agentChatToolEntitySchema>;
export const agentChatToolCommentSchema = z.strictObject({
  id: identifier, taskId: identifier, projectId: identifier, content: z.string().nullable(), version: z.number().int().positive(), deletedAt: timestamp.nullable(),
  authorId: z.uuid().optional(), origin: pmCommentAgentOriginSchema.nullable().optional(),
});
export type AgentChatToolComment = z.infer<typeof agentChatToolCommentSchema>;
export const agentChatToolRelationSchema = z.strictObject({ sourceId: identifier, targetId: identifier, relation: identifier, sourceRevision: z.string(), targetRevision: z.string() });
export type AgentChatToolRelation = z.infer<typeof agentChatToolRelationSchema>;
const workflowCategory = z.enum(['backlog', 'unstarted', 'started', 'completed', 'canceled']);
const workflowState = z.string().min(1).refine(value => value.trim().length > 0, 'Expected nonempty text');
export const agentChatToolWorkflowSchema = z.strictObject({
  workspaceId: z.uuid(), projectId: identifier, entity: z.literal('work_item'), initial: workflowState,
  states: z.array(z.strictObject({ id: workflowState, label: z.string(), category: workflowCategory })).min(1),
  transitions: z.array(z.strictObject({ from: workflowState, to: workflowState })),
  defaultTargets: z.partialRecord(workflowCategory, workflowState).nullable(),
  configuration: z.strictObject({ schema: z.literal('pm/config/v1'), revision: z.string().min(1), source: z.enum(['workspace', 'builtin']), workflowRevision: z.string().regex(/^[a-f0-9]{64}$/) }),
});
export type AgentChatToolWorkflow = z.infer<typeof agentChatToolWorkflowSchema>;
export const agentChatToolReceiptSchema = z.strictObject({
  kind: z.enum(['command', 'core', 'application']), operationId: identifier, commandId: identifier, action: identifier, targetId: z.string().nullable(), revision: z.string().nullable(),
  linkage: pmToolLinkageSchema.optional(),
});
export type AgentChatToolReceipt = z.infer<typeof agentChatToolReceiptSchema>;
export const agentChatToolResultFields = { nextCursor: z.string().nullable(), truncated: z.boolean(), sources: z.array(agentChatContextSourceSchema), receipt: agentChatToolReceiptSchema.optional() };
