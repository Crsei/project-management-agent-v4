import { randomUUID } from 'node:crypto';
import * as https from 'node:https';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { StudioExecutionRequest } from '../../../../../../packages/contracts/src/automation-studio.ts';
import { createAutomationProviderJsonClient } from '../../../../../../packages/infrastructure/src/automation-integrations-runtime.ts';
import { resolveWebhookAddresses } from '../../../../../../packages/infrastructure/src/webhook-transport.ts';
import { NativeTemplateUnknownOutcome, type NativeTemplateContext } from './ports.ts';
import { admitNativeOperation, finishNativeOperation, nativeDefinitionScope, nativeHash } from './state.ts';

export function validatePublicFeedUrl(input: string): URL {
  const url = new URL(input);
  if (input.length > 4000 || url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || url.hash || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || /[\u0000-\u0020\\]/.test(input)) throw new Error('Feeds require a public HTTPS URL without credentials, custom ports or fragments.');
  return url;
}
/** ElementTree's source byte-decoding semantics, including XML-declared legacy encodings. */
export function decodeNativeFeed(bytes: Buffer, contentType: string): string {
  const bom = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8' : null;
  const inferred = bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0 ? 'utf-16le' : bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f ? 'utf-16be' : null;
  const declaration = bytes.subarray(0, 512).toString('latin1').match(/^\s*<\?xml\b[^>]*\bencoding\s*=\s*['"]([A-Za-z0-9._-]+)['"]/i)?.[1];
  const charset = contentType.match(/\bcharset\s*=\s*["']?([A-Za-z0-9._-]+)/i)?.[1];
  const encoding = bom ?? inferred ?? declaration ?? charset ?? 'utf-8';
  if (/^(?:iso-8859-1|latin-?1)$/i.test(encoding)) return bytes.toString('latin1');
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error(`Public feed declares an unsupported or invalid character encoding: ${encoding}.`); }
}
/** DNS is checked once, then the socket is pinned: no DNS-rebinding window, proxy or redirects. */
export async function fetchNativePublicFeed(input: string, signal?: AbortSignal): Promise<{ text: string; contentType: string }> {
  const url = validatePublicFeedUrl(input);
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
  const addresses = await resolveWebhookAddresses(url.hostname, deadline);
  deadline.throwIfAborted();
  const pinned = addresses[0]!;
  const { promise, resolve, reject } = Promise.withResolvers<{ text: string; contentType: string }>();
    let settled = false;
    const finish = (error?: Error, value?: { text: string; contentType: string }) => {
      if (settled) return;
      settled = true;
      deadline.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    const request = https.request(url, {
      method: 'GET', agent: false, servername: url.hostname, rejectUnauthorized: true,
      family: pinned.family,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      maxHeaderSize: 16_384,
      headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain;q=0.8', 'accept-encoding': 'identity', 'user-agent': 'PM-Native-Automations/1', connection: 'close' },
    }, response => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.destroy(); finish(new Error(`Public feed refused (HTTP ${response.statusCode ?? 0}); redirects and compressed bodies are not followed.`)); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { response.destroy(); finish(new Error('Public feed exceeds 4 MiB.')); }
        else chunks.push(chunk);
      });
      response.once('error', () => finish(new Error('Public feed response was interrupted.')));
      response.once('aborted', () => finish(new Error('Public feed response was interrupted.')));
      response.once('end', () => {
        try {
          const contentType = String(response.headers['content-type'] ?? '');
          finish(undefined, { text: decodeNativeFeed(Buffer.concat(chunks, size), contentType), contentType });
        } catch (error) { finish(error instanceof Error ? error : new Error('Public feed character decoding failed.')); }
      });
    });
    const abort = () => { request.destroy(); finish(new Error('Public feed deadline or cancellation reached.')); };
    deadline.addEventListener('abort', abort, { once: true });
    request.once('socket', socket => {
      const tls = socket as TLSSocket;
      tls.once('secureConnect', () => {
        if (!tls.authorized || tls.remoteAddress !== pinned.address && tls.remoteAddress !== `::ffff:${pinned.address}`) {
          request.destroy(); finish(new Error('Public feed TLS peer did not match its approved public address.'));
        }
      });
    });
    request.once('error', () => finish(new Error('Public feed HTTPS request failed.')));
    if (deadline.aborted) abort(); else request.end();
  return promise;
}

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
  assertProviderOrigin(provider: 'github' | 'gitlab', url: string): Promise<void>;
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
    assertProviderOrigin: (provider, url) => client.assertProviderOrigin(provider, url),
  };
}
