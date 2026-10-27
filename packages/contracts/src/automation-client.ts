import type { AutomationCapabilities, AutomationConfig, AutomationPage, AutomationPreview, AutomationReceipt, AutomationRule, AutomationRun } from './automation.ts';

export class AutomationApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = 'AutomationApiError'; this.status = status; this.code = code; }
}
type Options = { signal?: AbortSignal };
/** Cookie-authenticated same-origin client. Writes are never retried. Recover the original receipt after uncertain transport. */
export class AutomationClient {
  private readonly base: string;
  constructor(workspaceId: string) { this.base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/automations`; }
  private async send<T>(method: string, path: string, body?: unknown, options?: Options): Promise<T> {
    const response = await fetch(this.base + path, {
      method, credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    let value: unknown;
    try { value = await response.json(); }
    catch {
      throw new AutomationApiError(response.status, 'invalid_response', `Automation response was not JSON (${response.status}); reconcile the original receipt before another write`);
    }
    if (!response.ok) {
      let code = 'request_failed', message = `Automation request failed (${response.status})`;
      if (value && typeof value === 'object' && 'error' in value && value.error && typeof value.error === 'object') {
        if ('code' in value.error && typeof value.error.code === 'string') code = value.error.code;
        if ('message' in value.error && typeof value.error.message === 'string') message = value.error.message;
      }
      throw new AutomationApiError(response.status, code, message);
    }
    return value as T;
  }
  capabilities(options?: Options) { return this.send<AutomationCapabilities>('GET', '/capabilities', undefined, options); }
  rules(cursor?: string, options?: Options) { return this.send<AutomationPage<AutomationRule>>('GET', '/rules' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''), undefined, options); }
  create(requestId: string, config: AutomationConfig) { return this.send<AutomationRule>('POST', '/rules', { requestId, config }); }
  update(id: string, requestId: string, expectedRevision: number, config: AutomationConfig) { return this.send<AutomationRule>('PUT', `/rules/${encodeURIComponent(id)}`, { requestId, expectedRevision, config }); }
  setStatus(id: string, requestId: string, expectedRevision: number, status: 'enabled' | 'paused') { return this.send<AutomationRule>('POST', `/rules/${encodeURIComponent(id)}/status`, { requestId, expectedRevision, status }); }
  remove(id: string, requestId: string, expectedRevision: number) { return this.send<{ deleted: true }>('DELETE', `/rules/${encodeURIComponent(id)}`, { requestId, expectedRevision }); }
  test(config: AutomationConfig, options?: Options) { return this.send<AutomationPreview>('POST', '/test', { config }, options); }
  run(id: string, requestId: string, expectedRevision: number) { return this.send<AutomationRun>('POST', `/rules/${encodeURIComponent(id)}/run`, { requestId, expectedRevision }); }
  runs(ruleId?: string, cursor?: string, options?: Options) {
    const query = new URLSearchParams(); if (ruleId) query.set('ruleId', ruleId); if (cursor) query.set('cursor', cursor);
    return this.send<AutomationPage<AutomationRun>>('GET', '/runs' + (query.size ? `?${query}` : ''), undefined, options);
  }
  detail(id: string, options?: Options) { return this.send<AutomationRun>('GET', `/runs/${encodeURIComponent(id)}`, undefined, options); }
  receipt(requestId: string, options?: Options) { return this.send<AutomationReceipt>('GET', `/receipts/${encodeURIComponent(requestId)}`, undefined, options); }
}
