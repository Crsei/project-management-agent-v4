import { z } from 'zod';
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const legacyAgentHandoffReportSchema = z.strictObject({interfaces:z.array(z.string().max(600)).max(16),decisions:z.array(z.string().max(600)).max(12),usage:z.string().max(3000),risks:z.array(z.string().max(600)).max(12)});
// Product delta plus an internal replacement snapshot; neither is acceptance evidence.
export const productHandoffReportSchema = z.strictObject({
  changes: z.array(z.string().trim().min(1).max(300)).max(12),
  capabilities: z.array(z.string().trim().min(1).max(240)).max(32),
});
export const agentHandoffReportSchema = z.union([productHandoffReportSchema, legacyAgentHandoffReportSchema]);
export type ProductHandoffReport = z.infer<typeof productHandoffReportSchema>;
export const canvasHandoffSchema = z.strictObject({
  schema:z.literal('pm/task-handoff/v1'), deliveryId:z.uuid(), taskId:z.string().regex(/^TASK-\d+$/),
  head:sha, branch:z.string().min(1).max(200), pr:z.string().max(512).regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/), testCommand:z.string().max(2000), testDigest:z.string().max(256),
  ci:z.array(z.string().max(200)).min(1).max(100), checkedAt:z.iso.datetime(),
  files:z.array(z.string().max(1000)).max(100), filesTruncated:z.boolean(), report:agentHandoffReportSchema.optional(),
});
const input = z.strictObject({nodeId:z.uuid(),deliveryId:z.uuid(),head:sha});
export const canvasTaskContextSchema = z.strictObject({
  schema:z.literal('pm/task-context/v1'), releaseId:z.uuid(), nodeId:z.uuid(), sharedVersion:z.string().regex(/^[a-f0-9]{64}$/),
  baseBranch:z.string().min(1).max(200), inputs:z.array(input).max(24), included:z.array(input).max(24), createdAt:z.iso.datetime(),
});
export type CanvasHandoff = z.infer<typeof canvasHandoffSchema>;
export type CanvasTaskContext = z.infer<typeof canvasTaskContextSchema>;

/** Missing/legacy reports never become a fabricated product summary. */
export function productReport(handoff: CanvasHandoff | undefined): ProductHandoffReport | undefined {
  const parsed = productHandoffReportSchema.safeParse(handoff?.report);
  return parsed.success ? parsed.data : undefined;
}
