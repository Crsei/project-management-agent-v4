import { AutomationApiError } from './automation-client.ts';
import type { StudioActionKind, StudioCapabilities, StudioConfig, StudioDefinition, StudioDefinitionFilters, StudioExecution, StudioExecutionEvent, StudioPage, StudioReceipt, StudioValidation } from './automation-studio.ts';
import {
  pmAutomationCandidateEditSchema, pmAutomationCandidatePreviewSchema, pmAutomationApplyRequestSchema,
  pmAutomationPreviewRequestSchema, pmAutomationResultSchema, pmAutomationReviewReceiptSchema, pmAutomationReviewRequestSchema,
  pmAutomationSnapshotSchema, pmAutomationEventSchema, pmAutomationVisitRequestSchema, type PmAutomationCandidate,
} from './automation-pm.ts';
export { AutomationApiError as StudioApiError } from './automation-client.ts';
type Options = { signal?: AbortSignal };
/** Writes are never retried. Reconcile an uncertain write with its original receipt. */
export class StudioClient {
  private readonly base: string;
  constructor(workspaceId: string) { this.base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/automations`; }
  private async send<T>(method: string, path: string, body?: unknown, options?: Options): Promise<T> {
    const response = await fetch(this.base + path, { method, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ...(options?.signal ? { signal: options.signal } : {}) });
    let value: unknown;
    try { value = await response.json(); } catch { throw new AutomationApiError(response.status, 'invalid_response', 'Non-JSON response; reconcile the original receipt before another write'); }
    if (!response.ok) {
      const error = value && typeof value === 'object' && 'error' in value ? value.error : null;
      throw new AutomationApiError(response.status, error && typeof error === 'object' && 'code' in error ? String(error.code) : 'request_failed', error && typeof error === 'object' && 'message' in error ? String(error.message) : `Automation request failed (${response.status})`);
    }
    return value as T;
  }
  capabilities(projectId: string, options?: Options & { actionKind?: StudioActionKind }) { const query = new URLSearchParams({ projectId }); if (options?.actionKind) query.set('actionKind', options.actionKind); return this.send<StudioCapabilities>('GET', '/studio-capabilities?' + query, undefined, options); }
  definitions(cursor?: string, options?: Options & StudioDefinitionFilters) { const query = new URLSearchParams(); if (cursor) query.set('cursor', cursor); if (options?.projectId) query.set('projectId', options.projectId); if (options?.quickAccess !== undefined) query.set('quickAccess', String(options.quickAccess)); return this.send<StudioPage<StudioDefinition>>('GET', '/definitions' + (query.size ? '?' + query : ''), undefined, options); }
  definition(id: string, options?: Options) { return this.send<StudioDefinition>('GET', '/definitions/' + encodeURIComponent(id), undefined, options); }
  create(requestId: string, config: StudioConfig) { return this.send<StudioDefinition>('POST', '/definitions', { requestId, config }); }
  update(id: string, requestId: string, expectedRevision: number, config: StudioConfig) { return this.send<StudioDefinition>('PUT', '/definitions/' + encodeURIComponent(id), { requestId, expectedRevision, config }); }
  setStatus(id: string, requestId: string, expectedRevision: number, status: 'enabled' | 'paused') { return this.send<StudioDefinition>('POST', `/definitions/${encodeURIComponent(id)}/status`, { requestId, expectedRevision, status }); }
  remove(id: string, requestId: string, expectedRevision: number) { return this.send<{ deleted: true }>('DELETE', '/definitions/' + encodeURIComponent(id), { requestId, expectedRevision }); }
  validate(config: StudioConfig, options?: Options) { return this.send<StudioValidation>('POST', '/definitions/validate', { config }, options); }
  run(id: string, requestId: string, expectedRevision: number, payload?: Record<string, unknown>) { return this.send<StudioExecution>('POST', `/definitions/${encodeURIComponent(id)}/run`, { requestId, expectedRevision, ...(payload ? { payload } : {}) }); }
  dispatchTest(id: string, requestId: string, expectedRevision: number, payload?: Record<string, unknown>) { return this.send<StudioExecution>('POST', `/definitions/${encodeURIComponent(id)}/test`, { requestId, expectedRevision, ...(payload ? { payload } : {}) }); }
  executions(definitionId?: string, cursor?: string, options?: Options) { const q = new URLSearchParams(); if (definitionId) q.set('definitionId', definitionId); if (cursor) q.set('cursor', cursor); return this.send<StudioPage<StudioExecution>>('GET', '/executions' + (q.size ? '?' + q : ''), undefined, options); }
  execution(id: string, options?: Options) { return this.send<StudioExecution>('GET', '/executions/' + encodeURIComponent(id), undefined, options); }
  logs(id: string, cursor?: string, options?: Options) { return this.send<StudioPage<StudioExecutionEvent>>('GET', `/executions/${encodeURIComponent(id)}/logs` + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), undefined, options); }
  query(id: string) { return this.send<StudioExecution>('POST', `/executions/${encodeURIComponent(id)}/query`, {}); }
  cancel(id: string, requestId: string) { return this.send<StudioExecution>('POST', `/executions/${encodeURIComponent(id)}/cancel`, { requestId }); }
  receipt(requestId: string, options?: Options) { return this.send<StudioReceipt>('GET', '/studio-receipts/' + encodeURIComponent(requestId), undefined, options); }
  async pmSnapshot(executionId: string, options?: Options) { return pmAutomationSnapshotSchema.parse(await this.send<unknown>('GET', `/pm/executions/${encodeURIComponent(executionId)}/snapshot`, undefined, options)); }
  async pmResult(executionId: string, options?: Options) { return pmAutomationResultSchema.parse(await this.send<unknown>('GET', `/pm/executions/${encodeURIComponent(executionId)}/result`, undefined, options)); }
  async pmEditCandidate(executionId: string, candidateId: string, requestId: string, expectedRevision: number, candidate: PmAutomationCandidate) {
    const body = pmAutomationCandidateEditSchema.parse({ requestId, expectedRevision, candidate });
    return pmAutomationReviewReceiptSchema.parse(await this.send<unknown>('PATCH', `/pm/executions/${encodeURIComponent(executionId)}/candidates/${encodeURIComponent(candidateId)}`, body));
  }
  async pmPreviewCandidate(executionId: string, candidateId: string, requestId: string, expectedRevision: number, selectedItemIds?: string[]) {
    const body = pmAutomationPreviewRequestSchema.parse({ requestId, expectedRevision, ...(selectedItemIds ? { selectedItemIds } : {}) });
    return pmAutomationCandidatePreviewSchema.parse(await this.send<unknown>('POST', `/pm/executions/${encodeURIComponent(executionId)}/candidates/${encodeURIComponent(candidateId)}/preview`, body));
  }
  async pmApplyCandidate(executionId: string, candidateId: string, requestId: string, expectedRevision: number, previewToken: string, selectedItemIds?: string[]) {
    const body = pmAutomationApplyRequestSchema.parse({ requestId, expectedRevision, previewToken, ...(selectedItemIds ? { selectedItemIds } : {}) });
    return pmAutomationReviewReceiptSchema.parse(await this.send<unknown>('POST', `/pm/executions/${encodeURIComponent(executionId)}/candidates/${encodeURIComponent(candidateId)}/apply`, body));
  }
  async pmIgnoreCandidate(executionId: string, candidateId: string, requestId: string, expectedRevision: number) {
    const body = pmAutomationReviewRequestSchema.parse({ requestId, expectedRevision });
    return pmAutomationReviewReceiptSchema.parse(await this.send<unknown>('POST', `/pm/executions/${encodeURIComponent(executionId)}/candidates/${encodeURIComponent(candidateId)}/ignore`, body));
  }
  async pmReceipt(requestId: string, options?: Options) { return pmAutomationReviewReceiptSchema.parse(await this.send<unknown>('GET', '/pm/receipts/' + encodeURIComponent(requestId), undefined, options)); }
  async pmVisit(requestId: string, projectId: string, options?: Options) {
    const body = pmAutomationVisitRequestSchema.parse({ requestId, projectId });
    return pmAutomationEventSchema.parse(await this.send<unknown>('POST', '/pm/visits', body, options));
  }
}
