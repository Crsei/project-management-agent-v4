import { AutomationApiError } from './automation-client.ts';
import type { AutomationBundleUpload, AutomationTransferInput, AutomationTransferPreview, AutomationTransferReceipt, AutomationTransferExport } from './automation-transfer.ts';
export class AutomationTransferClient {
  private readonly base: string;
  constructor(workspaceId: string) { this.base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/transfer`; }
  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.base + path, { method, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const value = await response.json().catch(() => { throw new AutomationApiError(response.status, 'invalid_response', 'Invalid response; reconcile the original request before another import'); });
    if (!response.ok) {
      const error = value && typeof value === 'object' && 'error' in value ? value.error : null;
      throw new AutomationApiError(response.status, error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'transfer_failed', error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'Automation transfer failed');
    }
    return value as T;
  }
  preview(input: AutomationTransferInput) { return this.send<AutomationTransferPreview>('POST', '/preview', input); }
  import(input: AutomationTransferInput & { requestId: string }) { return this.send<AutomationTransferReceipt>('POST', '/imports', input); }
  receipt(requestId: string) { return this.send<AutomationTransferReceipt>('GET', `/imports/${encodeURIComponent(requestId)}`); }
  export(definitionId: string, format: 'source' | 'bundle' = 'bundle') { return this.send<AutomationTransferExport>('GET', `/definitions/${encodeURIComponent(definitionId)}?format=${format}`); }
  uploadBundle(input: { requestId: string; projectId: string; filename: string; archiveBase64: string }) { return this.send<AutomationBundleUpload>('POST', '/bundles', input); }
  uploadBundleReceipt(requestId: string) { return this.send<AutomationBundleUpload>('GET', `/bundles/receipts/${encodeURIComponent(requestId)}`); }
}
