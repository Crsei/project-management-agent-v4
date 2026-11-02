import { AutomationApiError } from './automation-client.ts';
import type { AutomationGitSave, AutomationGitConfig, AutomationGitStatus, AutomationGitOperation, AutomationGitCheck, AutomationGitReceipt } from './automation-git-sync.ts';
export class AutomationGitSyncClient {
  private readonly base: string;
  constructor(workspaceId: string) { this.base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/git-sync`; }
  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.base + path, { method, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const value = await response.json().catch(() => { throw new AutomationApiError(response.status, 'invalid_response', 'Invalid Git response; reconcile the original request before retrying'); });
    if (!response.ok) {
      const error = value && typeof value === 'object' && 'error' in value ? value.error : null;
      throw new AutomationApiError(response.status, error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'git_sync_failed', error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'Git synchronization failed');
    }
    return value as T;
  }
  status(projectId: string) { return this.send<AutomationGitStatus>('GET', `?projectId=${encodeURIComponent(projectId)}`); }
  save(input: AutomationGitSave) { return this.send<AutomationGitStatus>('PUT', '', input); }
  check(input: { config: AutomationGitConfig; token?: string | null; encryptionKey?: string | null }) { return this.send<AutomationGitCheck>('POST', '/check', input); }
  sync(requestId: string, projectId: string, expectedRevision: number) { return this.send<AutomationGitOperation>('POST', '/sync', { requestId, projectId, expectedRevision }); }
  receipt(requestId: string) { return this.send<AutomationGitReceipt>('GET', `/receipts/${encodeURIComponent(requestId)}`); }
  reconcile(requestId: string, projectId: string, expectedRevision: number) { return this.send<AutomationGitOperation>('POST', '/reconcile', { requestId, projectId, expectedRevision }); }
}
