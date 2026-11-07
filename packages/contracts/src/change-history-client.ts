import type { LocalProjectTransport } from './local-project-client.ts';
import type { ChangeHistoryQuery, ChangeHistoryPage, ChangeDetail, ChangeCompareInput, ChangeComparison, ChangeAcknowledgeInput, ChangeAcknowledgement, TaskAttentionQuery, TaskAttentionPage } from './change-history.ts';
/** Reuses authenticated PM transport; writes are never automatically retried. */
export function createChangeHistoryClient(send: LocalProjectTransport) {
  const base = (workspaceId: string) => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/change-history`;
  return {
    list: (workspaceId: string, input: ChangeHistoryQuery, signal?: AbortSignal) => send<ChangeHistoryPage>('POST', `${base(workspaceId)}/query`, input, undefined, signal),
    detail: (workspaceId: string, changeId: string, signal?: AbortSignal) => send<ChangeDetail>('GET', `${base(workspaceId)}/${encodeURIComponent(changeId)}`, undefined, undefined, signal),
    compare: (workspaceId: string, input: ChangeCompareInput, signal?: AbortSignal) => send<ChangeComparison>('POST', `${base(workspaceId)}/compare`, input, undefined, signal),
    acknowledge: (workspaceId: string, input: ChangeAcknowledgeInput, signal?: AbortSignal) => send<ChangeAcknowledgement>('POST', `${base(workspaceId)}/acknowledge`, input, undefined, signal),
    attention: (workspaceId: string, input: TaskAttentionQuery, signal?: AbortSignal) => send<TaskAttentionPage>('POST', `${base(workspaceId)}/attention`, input, undefined, signal),
  };
}
