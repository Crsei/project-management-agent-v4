import { z } from 'zod';
export const automationGitPathSchema = z.string().min(1).max(240).refine(value => !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part !== '.git' && /^[A-Za-z0-9._-]+$/.test(part)), 'Expected a safe relative directory');
export const automationGitConfigSchema = z.strictObject({
  projectId: z.string().regex(/^PRJ-\d+$/), enabled: z.boolean(),
  repository: z.string().min(1).max(1000).refine(value => { try { const url = new URL(value); return ['https:', 'file:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } }, 'Use HTTPS or file URL without embedded credentials, query or fragment'),
  branch: z.string().min(1).max(200).refine(value => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes('..') && value.split('/').every(part => !!part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')), 'Invalid Git branch'),
  path: automationGitPathSchema, authorName: z.string().trim().min(1).max(100).refine(value => !/[\r\n<>]/.test(value)), authorEmail: z.email().max(200),
  intervalSeconds: z.union([z.literal(0), z.number().int().min(60).max(86400)]), encryptionEnabled: z.boolean(),
});
export const automationGitSaveSchema = z.strictObject({ requestId: z.uuid().toLowerCase(), expectedRevision: z.number().int().min(0), config: automationGitConfigSchema, token: z.string().min(1).max(10000).nullable().optional(), encryptionKey: z.string().min(16).max(1000).nullable().optional() });
export const automationGitRunSchema = z.strictObject({ requestId: z.uuid().toLowerCase(), projectId: z.string().regex(/^PRJ-\d+$/), expectedRevision: z.number().int().positive() });
export const automationGitCheckSchema = automationGitSaveSchema.omit({ requestId: true, expectedRevision: true });
export type AutomationGitConfig = z.infer<typeof automationGitConfigSchema>;
export type AutomationGitSave = z.infer<typeof automationGitSaveSchema>;
export type AutomationGitOperation = { id: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'outcome_unknown'; commit: string | null; startedAt: string | null; finishedAt: string | null; error: string | null };
export type AutomationGitStatus = { revision: number; config: AutomationGitConfig | null; tokenSet: boolean; encryptionKeySet: boolean; capability: { available: boolean; reason: string | null; secretsAvailable: boolean }; lastCommit: string | null; lastSyncedAt: string | null; dirtyCount: number; operation: AutomationGitOperation | null };
export type AutomationGitReceipt = { requestId: string; status: 'completed' | 'rejected'; result: AutomationGitStatus | AutomationGitOperation | { savedRevision: number } | null; error: { code: string; message: string } | null };
export type AutomationGitCheck = { readable: boolean; remoteCommit: string | null; pushPermissionVerified: false; encryptionKeyVerified: false };
