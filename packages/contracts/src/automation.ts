import { z } from 'zod';

export const automationConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4000),
  projectId: z.string().regex(/^PRJ-\d+$/),
  trigger: z.strictObject({
    kind: z.enum(['manual', 'daily']),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().min(1).max(100).refine(value => {
      if (/^[+-]/.test(value)) return false;
      try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
    }, 'Expected an IANA time zone'),
  }),
  condition: z.enum(['all_open', 'overdue', 'blocked']),
  action: z.literal('report'),
  dailyLimit: z.number().int().min(1).max(100),
  cooldownMinutes: z.number().int().min(0).max(10080),
});
export type AutomationConfig = z.infer<typeof automationConfigSchema>;
const timestamp = z.iso.datetime();
export const automationRuleSchema = z.strictObject({
  id: z.uuid(), revision: z.number().int().positive(), config: automationConfigSchema,
  status: z.enum(['draft', 'enabled', 'paused']), createdAt: timestamp, updatedAt: timestamp,
  lastRunAt: timestamp.nullable(), nextDueAt: timestamp.nullable(),
});
export type AutomationRule = z.infer<typeof automationRuleSchema>;
export const automationEvidenceSchema = z.strictObject({
  id: z.string(), projectId: z.string(), title: z.string(), status: z.string(), revision: z.string(), due: z.string().nullable(),
});
export type AutomationEvidence = z.infer<typeof automationEvidenceSchema>;
export const automationRunSchema = z.strictObject({
  id: z.uuid(), ruleId: z.uuid(), ruleName: z.string(), ruleRevision: z.number().int().positive(), config: automationConfigSchema,
  trigger: z.enum(['manual', 'scheduled']), status: z.enum(['completed', 'skipped', 'failed']),
  startedAt: timestamp, finishedAt: timestamp, summary: z.string(), reason: z.string().nullable(), evidence: z.array(automationEvidenceSchema),
});
export type AutomationRun = z.infer<typeof automationRunSchema>;
export const automationPreviewSchema = z.strictObject({ observedAt: timestamp, summary: z.string(), evidence: z.array(automationEvidenceSchema) });
export type AutomationPreview = z.infer<typeof automationPreviewSchema>;
export const automationCapabilitiesSchema = z.strictObject({
  canWrite: z.boolean(),
  scheduler: z.strictObject({ authority: z.literal('worker'), ready: z.boolean(), reason: z.string().nullable() }),
  actions: z.array(z.strictObject({ id: z.string(), available: z.boolean(), reason: z.string().nullable() })),
});
export type AutomationCapabilities = z.infer<typeof automationCapabilitiesSchema>;
export type AutomationPage<T> = { items: T[]; nextCursor: string | null };
export const automationPageSchema = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });
export const automationRequestIdSchema = z.uuid().toLowerCase();
export const automationCreateSchema = z.strictObject({ requestId: automationRequestIdSchema, config: automationConfigSchema });
export const automationRevisionSchema = z.strictObject({ requestId: automationRequestIdSchema, expectedRevision: z.number().int().positive() });
export const automationUpdateSchema = automationRevisionSchema.extend({ config: automationConfigSchema });
export const automationStatusSchema = automationRevisionSchema.extend({ status: z.enum(['enabled', 'paused']) });
export const automationTestSchema = z.strictObject({ config: automationConfigSchema });
export type AutomationRejectedResult = { error: { code: string; message: string }; httpStatus: number };
export type AutomationReceipt = { requestId: string; result: unknown };
