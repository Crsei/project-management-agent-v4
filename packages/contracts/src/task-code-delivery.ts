import { z } from 'zod';
import { executionSelectionSchema, type ExecutionSelection } from '../../agent-contracts/src/execution.ts';
import { taskBriefStageSchema, type TaskBriefStage } from '../../agent-contracts/src/task-brief.ts';

export const deliveryScopeSchema = z.strictObject({ workspaceId: z.uuid(), projectId: z.string().regex(/^PRJ-\d+$/), taskId: z.string().regex(/^TASK-\d+$/) });
export type DeliveryScope = z.infer<typeof deliveryScopeSchema>;
export const prepareDeliverySchema = deliveryScopeSchema.extend({ id: z.uuid(), taskRevision: z.string().min(1).max(256), baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/), executionSelection: executionSelectionSchema.refine(value => value.agentWorkspaceId !== null, 'Select an explicit Agent folder') });
export const deliveryActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('new-session'), executionSelection: executionSelectionSchema.refine(value => value.agentWorkspaceId !== null, 'Select an explicit Agent folder'), confirm: z.literal(true) }),
  z.strictObject({ action: z.literal('develop'), providerInstanceId: z.string().min(1).max(256), model: z.string().min(1).max(256), allowWorktreeWrite: z.literal(true).optional(), purpose: taskBriefStageSchema.optional(), instruction: z.string().max(8000).optional() }),
  z.strictObject({ action: z.literal('test'), command: z.string().trim().min(1).max(2000), confirm: z.literal(true) }),
  z.strictObject({ action: z.literal('verify-local'), head: z.string().regex(/^[a-f0-9]{40,64}$/), confirm: z.literal(true) }),
  z.strictObject({ action: z.literal('commit'), fingerprint: z.string().min(1), confirm: z.literal(true) }),
  z.strictObject({ action: z.literal('push'), head: z.string().regex(/^[a-f0-9]{40,64}$/), confirm: z.literal(true) }),
  z.strictObject({ action: z.literal('draft-pr'), head: z.string().regex(/^[a-f0-9]{40,64}$/), confirm: z.literal(true) }),
  z.strictObject({ action: z.literal('refresh') }),
]);
export type DeliveryAction = z.infer<typeof deliveryActionSchema>;
export type DeliveryStep = 'preparing' | 'ready' | 'developing' | 'developed' | 'tested' | 'committed' | 'pushed' | 'pr';
export type DeliveryOperation = 'prepare' | 'develop' | 'test' | 'verify-local' | 'commit' | 'push' | 'draft-pr';
export type LocalVerification = { executor: 'linux-bwrap-node24-v1'; head: string; fingerprint: string; command: 'npm test'; passed: boolean; exitCode: number | null; outputDigest: string; at: string; counts: { tests: number; pass: number; fail: number; cancelled: number; skipped: number; todo: number } | null };
export function localVerificationPassed(v: Pick<TaskCodeDelivery, 'head' | 'localVerification'>): boolean {
  const p = v.localVerification, c = p?.counts;
  return !!p && p.executor === 'linux-bwrap-node24-v1' && p.command === 'npm test' && p.head === v.head && p.passed && p.exitCode === 0 && !!c && c.tests > 0 && c.pass === c.tests && c.fail === 0 && c.cancelled === 0 && c.skipped === 0 && c.todo === 0;
}
export type DeliveryGit = { root: string; directory: string; directoryIdentity: string; commonDirectory: string; remote: string; owner: string; repo: string; baseBranch: string; baseSha: string; branch: string };
export type DeliveryTree = { head: string; fingerprint: string; files: string[]; diff: string };
export type DeliveryFeedback = { head: string; state: 'open' | 'closed' | 'merged'; draft: boolean; observedAt: string; taskRevision?: string; fingerprint?: string; checks: { name: string; status: string; conclusion: string | null }[]; reviews: { id: number; author: string; state: string; commit: string; body: string }[] };
export type TaskCodeDelivery = DeliveryScope & {
  id: string; baseBranch: string; taskRevision: string; title: string; description: string; createdAt: string; updatedAt: string;
  step: DeliveryStep; version: number; threadId: string; git?: DeliveryGit;
  worktreeWriteConfirmed?: boolean; developmentPurpose?: TaskBriefStage; developmentInstruction?: string;
  executionSelection?: ExecutionSelection; previousThreadIds?: string[];
  generationId?: string; generationStatus?: string; generationKey?: string;
  test?: { command: string; fingerprint: string; taskRevision?: string; head?: string; passed: boolean; exitCode: number | null; outputDigest: string; at: string };
  localVerification?: LocalVerification;
  head?: string; pr?: { number: number; url: string }; feedback?: DeliveryFeedback;
  pending?: { action: DeliveryOperation; at: string; head?: string; fingerprint?: string };
  error?: string;
};
