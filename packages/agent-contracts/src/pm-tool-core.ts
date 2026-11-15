import { z } from 'zod';
import { agentChatToolFieldValueSchema, agentChatToolResultFields } from './pm-tool-shared.ts';

export const pmCoreEntityKindSchema = z.enum(['project', 'work_item', 'document', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goal']);
const identifier = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).max(80);
const name = z.string().trim().min(1).max(128);
const category = z.enum(['backlog', 'unstarted', 'started', 'completed', 'canceled']);
const workflow = z.strictObject({ initial: name, states: z.array(z.strictObject({ id: name, label: z.string().min(1).max(300), category })).min(1).max(100), transitions: z.array(z.strictObject({ from: name, to: name })).max(10000), default_targets: z.partialRecord(category, name).optional() });
export const pmCoreConfigurationSchema = z.strictObject({
  schema: z.literal('pm/config/v1'), workflows: z.strictObject({ project: workflow.optional(), work_item: workflow.optional(), cycle: workflow.optional(), milestone: workflow.optional(), module: workflow.optional(), requirement: workflow.optional(), release: workflow.optional(), goal: workflow.optional() }),
  custom_fields: z.array(z.strictObject({ name: z.string().regex(/^x-.+$/).max(128), label: z.string().min(1).max(300), type: z.enum(['text', 'number', 'boolean', 'date', 'select', 'multi_select', 'reference']), entities: z.array(pmCoreEntityKindSchema).min(1).max(9), required: z.boolean().optional(), default: agentChatToolFieldValueSchema.optional(), options: z.array(z.string().min(1).max(4000)).max(1000).optional(), target: pmCoreEntityKindSchema.optional(), min: z.number().finite().optional(), max: z.number().finite().optional() })).max(200),
});
const scalar = z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null()]);
const queryValue = z.union([scalar, z.array(scalar).max(256)]);
type Expression = { all: Expression[] } | { any: Expression[] } | { not: Expression } | { field: string; op: 'eq' | 'ne' | 'in' | 'not_in' | 'contains' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte'; value?: z.infer<typeof queryValue> | undefined };
const expression: z.ZodType<Expression> = z.lazy(() => z.union([
  z.strictObject({ all: z.array(expression).max(256) }), z.strictObject({ any: z.array(expression).max(256) }), z.strictObject({ not: expression }),
  z.strictObject({ field: name, op: z.enum(['eq', 'ne', 'in', 'not_in', 'contains', 'exists', 'gt', 'gte', 'lt', 'lte']), value: queryValue.optional() }),
]));
export const pmCoreViewSchema = z.strictObject({ entity: pmCoreEntityKindSchema.optional(), project: identifier.optional(), layout: z.enum(['kanban', 'table', 'tree', 'graph']), group_by: name.optional(), filter: z.record(name, queryValue).optional(), sort: name.optional(), where: expression.optional(), order_by: z.array(z.strictObject({ field: name, direction: z.enum(['asc', 'desc']) })).max(100).optional(), order: z.array(identifier).max(1000).optional(), columns: z.array(name).max(200).optional() });
export const pmCoreSavedViewSchema = pmCoreViewSchema.extend({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/), name: z.string().trim().min(1).max(300), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const pmCoreDiagnosticSchema = z.strictObject({ code: z.string(), severity: z.enum(['error', 'warning']), path: z.string(), message: z.string(), entityId: z.string().optional(), field: z.string().optional(), targetId: z.string().optional(), line: z.number().int().positive().optional() });
export const pmCoreMigrationSummarySchema = z.strictObject({ id: z.string(), revision: z.string(), kind: z.enum(['normalize-v1', 'transform']), createdAt: z.string(), status: z.enum(['preview', 'applying', 'applied', 'restoring', 'restored']), files: z.number().int().nonnegative(), diagnostics: z.array(pmCoreDiagnosticSchema).max(1000) });
export const pmCoreMigrationFileSchema = z.strictObject({ path: z.string(), beforeRevision: z.string(), afterRevision: z.string() });
export const coreToolResultSchema = z.union([
  z.strictObject({ kind: z.literal('views'), items: z.array(pmCoreSavedViewSchema).max(20), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('configuration'), items: z.array(z.never()), configuration: pmCoreConfigurationSchema, revision: z.string(), diagnostics: z.array(pmCoreDiagnosticSchema).max(1000), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('migrations'), items: z.array(pmCoreMigrationSummarySchema).max(20), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('migration'), items: z.array(pmCoreMigrationFileSchema).max(20), migration: z.strictObject({ id: z.string(), revision: z.string(), kind: z.enum(['normalize-v1', 'transform']).nullable(), status: z.enum(['preview', 'applying', 'applied', 'restoring', 'restored']), totalFiles: z.number().int().nonnegative(), diagnostics: z.array(pmCoreDiagnosticSchema).max(1000) }), ...agentChatToolResultFields }),
]);
