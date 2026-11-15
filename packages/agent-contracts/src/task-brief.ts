import { z } from 'zod';

export const taskBriefStageSchema = z.enum(['analysis', 'development', 'review', 'recovery']);
export type TaskBriefStage = z.infer<typeof taskBriefStageSchema>;
export const taskBriefRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const taskBriefEntityIdSchema = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).max(80);
export const taskBriefSourceRefSchema = z.strictObject({
  workspaceId: z.uuid(), projectId: taskBriefEntityIdSchema, entityId: taskBriefEntityIdSchema,
  kind: z.enum(['project', 'work_item', 'document', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goal']),
  revision: taskBriefRevisionSchema, title: z.string(),
  location: z.union([
    z.strictObject({ type: z.literal('body'), offset: z.number().int().nonnegative(), length: z.number().int().nonnegative() }),
    z.strictObject({ type: z.literal('field'), path: z.string() }),
  ]),
});
export type TaskBriefSourceRef = z.infer<typeof taskBriefSourceRefSchema>;
export const taskBriefStatementSchema = z.strictObject({ text: z.string(), sourceRefs: z.array(taskBriefSourceRefSchema).min(1) });
export type TaskBriefStatement = z.infer<typeof taskBriefStatementSchema>;
export const taskBriefQuerySchema = z.strictObject({
  revision: taskBriefRevisionSchema, stage: taskBriefStageSchema,
  bodyOffset: z.number().int().min(0).max(4000000).optional(), bodyLimit: z.number().int().min(1).max(48000).optional(),
});
export type TaskBriefQuery = z.infer<typeof taskBriefQuerySchema>;
export const taskBriefSchema = z.strictObject({
  schemaVersion: z.literal(1), stage: taskBriefStageSchema, generatedAt: z.iso.datetime(),
  task: z.strictObject({ workspaceId: z.uuid(), projectId: taskBriefEntityIdSchema, taskId: taskBriefEntityIdSchema,
    revision: taskBriefRevisionSchema, title: z.string(), body: z.string(), bodyOffset: z.number().int().nonnegative(),
    bodyLength: z.number().int().nonnegative(), nextBodyOffset: z.number().int().nonnegative().nullable() }),
  goals: z.array(taskBriefStatementSchema), acceptanceCriteria: z.array(taskBriefStatementSchema),
  constraints: z.array(taskBriefStatementSchema), nonGoals: z.array(taskBriefStatementSchema),
  relations: z.array(z.strictObject({ relation: z.string(), direction: z.enum(['outgoing', 'incoming']), source: taskBriefSourceRefSchema, target: taskBriefSourceRefSchema })),
  guidance: z.array(z.string()), sources: z.array(taskBriefSourceRefSchema),
  gaps: z.array(z.strictObject({ code: z.enum(['goal_not_explicit', 'acceptance_not_explicit', 'constraints_not_explicit', 'authorized_scope_only', 'extraction_incomplete']), message: z.string() })),
  truncation: z.strictObject({ truncated: z.boolean(), body: z.boolean(), statements: z.boolean(), relations: z.boolean(), message: z.string().nullable() }),
  dispatchable: z.boolean(),
  authorityNotice: z.string(),
});
export type TaskBrief = z.infer<typeof taskBriefSchema>;
export const taskKnowledgeQuerySchema = z.strictObject({
  revision: taskBriefRevisionSchema, query: z.string().trim().min(1).max(500),
  projectIds: z.array(taskBriefEntityIdSchema).min(1).max(20).optional(),
  limit: z.number().int().min(1).max(20).optional(), cursor: z.string().min(1).max(2048).optional(),
});
export type TaskKnowledgeQuery = z.infer<typeof taskKnowledgeQuerySchema>;
export const taskKnowledgeCandidateSchema = z.strictObject({
  source: taskBriefSourceRefSchema, excerpt: z.string(), matchedTerms: z.array(z.string()),
  validity: z.literal('needs_review'), applicability: z.literal('needs_review'), reason: z.string(),
  validitySignals: z.array(taskBriefStatementSchema),
  truncation: z.strictObject({ truncated: z.boolean(), nextBodyOffset: z.number().int().nonnegative().nullable() }),
});
export type TaskKnowledgeCandidate = z.infer<typeof taskKnowledgeCandidateSchema>;
export const taskKnowledgePageSchema = z.strictObject({
  schemaVersion: z.literal(1), generatedAt: z.iso.datetime(), taskRevision: taskBriefRevisionSchema,
  query: z.string(), projectIds: z.array(taskBriefEntityIdSchema), items: z.array(taskKnowledgeCandidateSchema),
  nextCursor: z.string().nullable(), method: z.literal('deterministic_lexical'), authorityNotice: z.string(),
});
export type TaskKnowledgePage = z.infer<typeof taskKnowledgePageSchema>;
