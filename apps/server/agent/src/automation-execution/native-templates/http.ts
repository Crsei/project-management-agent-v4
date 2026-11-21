import { randomUUID } from 'node:crypto';
import type { StudioExecutionRequest } from '../../../../../../packages/contracts/src/automation-studio.ts';
import { createAutomationProviderJsonClient } from '../../../../../../packages/infrastructure/src/automation-integrations-runtime.ts';
import { NativeTemplateUnknownOutcome, type NativeTemplateContext } from './ports.ts';
import { admitNativeOperation, finishNativeOperation, nativeDefinitionScope, nativeHash } from './state.ts';

function safePath(provider: 'github' | 'gitlab', apiPath: string, method: string): void {
  if (!apiPath.startsWith('/') || apiPath.startsWith('//') || apiPath.length > 8000 || /[\u0000-\u0020\\#]/.test(apiPath)) throw new Error('Connector requests require a bounded relative API path.');
  const parsed = new URL(apiPath, 'https://connector.invalid');
  const identityOrLoadRead = provider === 'github' && method === 'GET' && (apiPath === '/user' || parsed.pathname === '/search/issues');
  if (parsed.origin !== 'https://connector.invalid' || provider === 'github' && parsed.pathname !== '/graphql' && !parsed.pathname.startsWith('/repos/') && !identityOrLoadRead || provider === 'gitlab' && !parsed.pathname.startsWith('/projects/')) throw new Error('Native requests must target their scoped repository API.');
  if (parsed.pathname.split('/').some(part => { const decoded = decodeURIComponent(part); return decoded === '.' || decoded === '..' || decoded.includes('\\'); })) throw new Error('Connector paths cannot escape the approved API.');
}
export interface NativeTemplateHttp {
  requestJson: NativeTemplateContext['requestJson'];
  close(): Promise<void>;
}
export function createNativeTemplateHttp(request: StudioExecutionRequest, authorize: () => Promise<void>, signal: AbortSignal): NativeTemplateHttp {
  const client = createAutomationProviderJsonClient(request);
  const scope = nativeDefinitionScope(request);
  return {
    async requestJson<T>(provider: 'github' | 'gitlab', apiPath: string, options: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; operationKey?: string } = {}): Promise<T> {
      signal.throwIfAborted();
      const method = options.method ?? 'GET';
      safePath(provider, apiPath, method);
      await authorize();
      signal.throwIfAborted();
      const graphQuery = provider === 'github' && apiPath === '/graphql' && method === 'POST' && options.body && typeof options.body === 'object' && 'query' in options.body && typeof options.body.query === 'string' && /^\s*(?:query\b|\{)/.test(options.body.query) && !/\bmutation\b/.test(options.body.query);
      const mutating = method !== 'GET' && !graphQuery;
      if (options.body !== undefined && (!options.body || typeof options.body !== 'object' || Array.isArray(options.body))) throw new Error('Connector JSON bodies must be objects.');
      if (mutating && !options.operationKey) throw new Error('Every upstream write requires a stable native operation key.');
      const key = `${provider}:${options.operationKey ?? randomUUID()}`;
      const admitted = mutating ? admitNativeOperation(request, key, nativeHash([provider, method, apiPath, options.body ?? null])) : null;
      if (admitted && !admitted.fresh) {
        const operation = admitted.operation;
        if (operation.phase === 'completed') return operation.value as T;
        if (operation.phase === 'failed') throw Object.assign(new Error(operation.error ?? 'The original upstream operation failed.'), { status: operation.status, code: operation.code });
        throw new NativeTemplateUnknownOutcome('The original upstream operation is pending or unknown; it will not be automatically retried.');
      }
      try {
        const value = await client.requestJson(provider, apiPath, { method, ...(options.body === undefined ? {} : { body: options.body as Record<string, unknown> }), operationKey: mutating ? nativeHash([scope, key]) : `read:${randomUUID()}` });
        if (admitted) finishNativeOperation(admitted.operation, { phase: 'completed', value });
        return value as T;
      } catch (error) {
        const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        // A post-send revocation can also return 4xx. Only explicit pre-send policy
        // denials or the confirmed upstream response prove rejection, not HTTP status alone.
        const knownRejection = status !== undefined && status >= 400 && status < 500 && ['provider_request_rejected', 'integration_external_write_forbidden', 'integration_repository_forbidden', 'integration_graphql_forbidden', 'integration_owner_load_search_forbidden'].includes(code ?? '');
        if (admitted) finishNativeOperation(admitted.operation, { phase: knownRejection ? 'failed' : 'unknown', error: `Scoped ${provider} ${method} was not confirmed${status ? ` (HTTP ${status})` : ''}.`, status, code });
        if (admitted && !knownRejection) throw new NativeTemplateUnknownOutcome(`Scoped ${provider} write has an unknown outcome; reconcile its original operation identity.`);
        throw error;
      }
    },
    close: () => client.close(),
  };
}
