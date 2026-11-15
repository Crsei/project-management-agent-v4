import type { Command, CommandReceipt } from './core.ts';

export type MemberDutyKind = 'work_item' | 'project' | 'milestone' | 'team';
export type MemberDuty = {
  id: string; kind: MemberDutyKind; title: string; projectId: string | null;
  version: number; parentId: string | null; transferable: boolean;
};
export type MemberImpact = {
  userId: string; membershipVersion: number; revokedAt: string | null;
  duties: MemberDuty[]; scopeComplete: boolean; blockers: string[];
  canHandover: boolean; canRevoke: boolean; canLeave: boolean;
  evidence: { source: 'pm_review' | 'automation_execution'; id: string; projectId: string; status: string }[];
  executionCoverage: 'partial' | 'unavailable';
};
export type HandoverItem = {
  duty: MemberDuty; command: Command; state: 'pending' | 'unknown' | 'committed' | 'rejected';
  receipt: CommandReceipt | null;
};
export type MemberHandover = {
  id: string; userId: string; recipientId: string; actorId: string; version: number;
  items: HandoverItem[]; status: 'pending' | 'partial' | 'unknown' | 'completed';
};
export function handoverStatus(items: readonly HandoverItem[]): MemberHandover['status'] {
  if (items.some(item => item.state === 'unknown')) return 'unknown';
  if (items.every(item => item.state === 'committed')) return 'completed';
  if (items.some(item => item.state === 'committed' || item.state === 'rejected')) return 'partial';
  return 'pending';
}
