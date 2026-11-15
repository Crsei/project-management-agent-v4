import type { LocalProjectTransport } from './local-project-client.ts';
import type { CommandReceipt } from '../../domain/src/core.ts';
import type { MemberHandover, MemberImpact } from '../../domain/src/member-lifecycle.ts';
export type { MemberDuty, MemberDutyKind, MemberHandover, MemberImpact, HandoverItem } from '../../domain/src/member-lifecycle.ts';

export function createMemberLifecycleClient(send: LocalProjectTransport) {
  const base = (workspaceId: string) => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/people`;
  return {
    impact: (workspaceId: string, userId: string, signal?: AbortSignal) => send<MemberImpact>('GET', `${base(workspaceId)}/members/${encodeURIComponent(userId)}/impact`, undefined, undefined, signal),
    list: (workspaceId: string, userId: string, signal?: AbortSignal) => send<{ items: MemberHandover[] }>('GET', `${base(workspaceId)}/members/${encodeURIComponent(userId)}/handovers`, undefined, undefined, signal),
    operation: (workspaceId: string, operationId: string, signal?: AbortSignal) => send<MemberHandover>('GET', `${base(workspaceId)}/handovers/${encodeURIComponent(operationId)}`, undefined, undefined, signal),
    continue: (workspaceId: string, operationId: string, expectedVersion: number) => send<MemberHandover>('POST', `${base(workspaceId)}/handovers/${encodeURIComponent(operationId)}/continue`, { expectedVersion }),
    reconcile: (workspaceId: string, operationId: string) => send<MemberHandover>('POST', `${base(workspaceId)}/handovers/${encodeURIComponent(operationId)}/reconcile`, {}),
    departureReceipt: (workspaceId: string, userId: string, commandId: string, signal?: AbortSignal) => send<CommandReceipt>('GET', `${base(workspaceId)}/members/${encodeURIComponent(userId)}/departure-receipts/${encodeURIComponent(commandId)}`, undefined, undefined, signal),
  };
}
