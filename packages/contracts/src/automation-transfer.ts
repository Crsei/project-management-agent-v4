import { z } from 'zod';
import { studioConfigSchema, type StudioConfig, type StudioDefinition, type StudioValidation } from './automation-studio.ts';

export const AUTOMATION_TRANSFER_LIMITS = { jsonBytes: 3 * 1024 * 1024, archiveBytes: 2 * 1024 * 1024, expandedBytes: 2 * 1024 * 1024, files: 200 } as const;
export const automationBundleSchema = z.strictObject({ version: z.literal(1), kind: z.literal('pm-automation-bundle'), spec: studioConfigSchema });
const sourceTrigger = z.strictObject({ type: z.enum(['cron', 'schedule', 'event']), schedule: z.string().max(200).optional(), schedule_human: z.string().max(500).optional(), timezone: z.string().max(100).optional(), source: z.string().max(100).optional(), on: z.union([z.string().max(200), z.array(z.string().max(200)).min(1).max(30)]).optional(), filter: z.string().max(4000).optional() });
/** OpenHands v1 prompt interchange. Unknown fields are rejected rather than silently discarded. */
export const sourceAutomationSchema = z.strictObject({ version: z.literal(1), kind: z.literal('automation'), spec: z.strictObject({ name: z.string().trim().min(1).max(160), prompt: z.string().trim().min(1).max(200000), trigger: sourceTrigger, enabled: z.boolean(), repository: z.string().max(300).optional(), branch: z.string().max(300).optional(), plugins: z.array(z.string().max(300)).max(30).optional(), model: z.string().min(1).max(200).nullable().optional(), timeout: z.number().int().min(1).max(86400).nullable().optional(), notification: z.string().max(500).optional(), timezone: z.string().max(100).optional() }) });
export const automationTransferPreviewSchema = z.strictObject({ projectId: z.string().regex(/^PRJ-\d+$/), document: z.unknown(), providerInstanceId: z.string().min(1).max(200).optional(), model: z.string().min(1).max(200).optional() });
export const automationTransferImportSchema = automationTransferPreviewSchema.extend({ requestId: z.uuid().toLowerCase() });
export const automationBundleUploadSchema = z.strictObject({ requestId: z.uuid().toLowerCase(), projectId: z.string().regex(/^PRJ-\d+$/), filename: z.string().min(1).max(200), archiveBase64: z.string().min(1).max(Math.ceil(AUTOMATION_TRANSFER_LIMITS.archiveBytes / 3) * 4) });
export type AutomationBundleFile = { path: string; content: string };
export type AutomationBundleUpload = { bundleId: string; sha256: string; files: AutomationBundleFile[] };
export type AutomationTransferInput = z.infer<typeof automationTransferPreviewSchema>;
export type AutomationTransferPreview = { format: 'source' | 'bundle'; config: StudioConfig; warnings: string[]; validation: StudioValidation };
export type AutomationTransferReceipt = { requestId: string; status: 'pending' | 'completed' | 'rejected'; definition: StudioDefinition | null; error: { code: string; message: string } | null };
export type AutomationTransferExport = { filename: string; document: unknown; limits: typeof AUTOMATION_TRANSFER_LIMITS };
