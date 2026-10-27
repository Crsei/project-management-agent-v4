import { z } from 'zod';
import { entityKinds, type FileRecord } from '../../pm-schema/index.ts';
import type { QueryExpression } from '../../pm-schema/query.ts';

const diagnosticSchema = z.object({
  code: z.string(), severity: z.enum(['error', 'warning']), path: z.string(), message: z.string(),
  entityId: z.string().optional(), field: z.string().optional(), targetId: z.string().optional(), line: z.number().optional(),
});

const queryScalarSchema = z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(8192)]);
const queryValueSchema = z.union([queryScalarSchema, z.array(queryScalarSchema).max(256)]);
const queryExpressionWireSchema: z.ZodType<QueryExpression> = z.lazy(() => z.union([
  z.object({ all: z.array(queryExpressionWireSchema).max(256) }).strict(),
  z.object({ any: z.array(queryExpressionWireSchema).max(256) }).strict(),
  z.object({ not: queryExpressionWireSchema }).strict(),
  z.object({ field: z.string().min(1).max(128), op: z.literal('exists'), value: z.boolean().optional() }).strict(),
  z.object({ field: z.string().min(1).max(128), op: z.enum(['eq', 'ne', 'in', 'not_in', 'contains', 'gt', 'gte', 'lt', 'lte']), value: queryValueSchema }).strict(),
]));
/** Canonical parsed view output, deliberately separate from transform-bearing input parsers. */
export const coreCreationViewSchema = z.object({
  entity: z.enum(entityKinds).optional(), project: z.string().optional(), layout: z.enum(['kanban', 'table', 'tree', 'graph']),
  group_by: z.string().optional(), filter: z.record(z.string(), queryValueSchema).optional(), sort: z.string().optional(),
  where: queryExpressionWireSchema.optional(),
  order_by: z.array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }).strict()).max(32).optional(),
  order: z.array(z.string()).max(10000).optional(), columns: z.array(z.string()).max(128).optional(),
}).strict();

/** Wire shape only: configured workflow and custom-field validation belongs to the core. */
export const coreCreationFileRecordSchema = z.object({
  id: z.string(), path: z.string(), raw: z.string(), revision: z.string(),
  entity: z.object({
    schema: z.literal('pm/v1'), id: z.string(), entity: z.enum(entityKinds), title: z.string(),
    kind: z.enum(['epic', 'task', 'bug', 'subtask']).optional(), project: z.string().optional(), parent: z.string().optional(),
    status: z.string().optional(), priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    assignee: z.string().optional(), owner: z.string().optional(), goal: z.string().optional(),
    start: z.string().optional(), due: z.string().optional(), estimated_duration_days: z.number().optional(),
    depends_on: z.array(z.string()).optional(), cycle: z.string().optional(), milestone: z.string().optional(),
    module: z.string().optional(), requirement: z.string().optional(), release: z.string().optional(), goals: z.array(z.string()).optional(),
    target: z.number().optional(), unit: z.string().optional(), version: z.string().optional(),
    document_kind: z.enum(['note', 'design', 'decision', 'specification']).optional(), archived: z.boolean().optional(),
    blocked_by: z.array(z.string()), related_to: z.array(z.string()), labels: z.array(z.string()),
    body: z.string(), links: z.array(z.string()), checklist: z.array(z.object({ text: z.string(), checked: z.boolean(), line: z.number() })),
    views: z.array(coreCreationViewSchema),
  }).passthrough(),
  stale: z.boolean().optional(), error: z.string().optional(), diagnostics: z.array(diagnosticSchema).optional(),
}) as z.ZodType<FileRecord>;

/** Native creation facts, not PM command receipts. not_found never proves that sending a new request is safe. */
export const coreCreationAttemptSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_found') }).strict(),
  z.object({ status: z.literal('pending'), reason: z.enum(['write_unconfirmed', 'audit_pending']) }).strict(),
  z.object({ status: z.literal('rejected') }).strict(),
  z.object({
    status: z.literal('committed'), entityId: z.string(), revision: z.string(),
    current: z.discriminatedUnion('status', [
      z.object({ status: z.literal('present'), record: coreCreationFileRecordSchema }).strict(),
      z.object({ status: z.literal('deleted') }).strict(),
      z.object({ status: z.literal('missing') }).strict(),
      z.object({ status: z.literal('unavailable') }).strict(),
    ]),
  }).strict(),
]);
export type CoreCreationAttempt = z.infer<typeof coreCreationAttemptSchema>;
