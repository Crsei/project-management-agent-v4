import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as https from 'node:https';
import { DomainError } from '../../domain/src/core.ts';
import { normalizeWebhookUrl } from './webhook-config.ts';
import { resolveWebhookAddresses } from './webhook-transport.ts';
import type { SqlExecutor } from '../../application/src/ports.ts';

/** Namespace/salt identify this deployment schema's offline lock; normal work holds its shared transaction peer. */
export const AUTOMATION_INTEGRATION_MAINTENANCE_LOCK = [20971, 7] as const;
export async function assertAutomationIntegrationsAvailable(sql: SqlExecutor): Promise<void> {
  const row = (await sql.query<{ available: boolean }>("SELECT pg_try_advisory_xact_lock_shared($1,hashtext(current_schema() || ':' || $2::text)) AS available", [...AUTOMATION_INTEGRATION_MAINTENANCE_LOCK])).rows[0];
  if (!row?.available) throw new DomainError('integration_maintenance_active', 'Managed integration migration is active; no integration configuration, grant or execution was started', 409);
}

export type AutomationPrivateStore = { available: boolean; seal(value: unknown, identity: string): string; open<T>(value: string, identity: string): T };
/** Explicit deployment key only. No file, global Provider config or source credentials are consulted. */
export function createAutomationPrivateStore(encoded = process.env.PM_AUTOMATION_INTEGRATIONS_KEY): AutomationPrivateStore {
  const key = encoded && /^[A-Za-z0-9+/]{43}=$/.test(encoded) ? Buffer.from(encoded, 'base64') : null;
  const requireKey = () => { if (!key || key.length !== 32) throw new DomainError('automation_private_storage_unavailable', 'Configure PM_AUTOMATION_INTEGRATIONS_KEY as a private 32-byte base64 deployment key; retain it with encrypted database backups', 503); return key; };
  return {
    available: key?.length === 32,
    seal(value, identity) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', requireKey(), iv); cipher.setAAD(Buffer.from(identity)); const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return [iv, cipher.getAuthTag(), encrypted].map(bytes => bytes.toString('base64')).join('.'); },
    open<T>(value: string, identity: string): T { try { const [iv, tag, body] = value.split('.').map(part => Buffer.from(part, 'base64')); if (!iv || iv.length !== 12 || !tag || tag.length !== 16 || !body) throw new Error('invalid'); const decipher = createDecipheriv('aes-256-gcm', requireKey(), iv); decipher.setAAD(Buffer.from(identity)); decipher.setAuthTag(tag); return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')) as T; } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('automation_private_storage_unavailable', 'Private connection configuration cannot be decrypted with the current deployment key', 503); } },
  };
}
export function validateAutomationPrivateHeaders(headers: Record<string, string>): Record<string, string> {
  if (Object.keys(headers).length > 20) throw new DomainError('validation_failed', 'At most twenty private headers are supported');
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(lower) || /^(?:host|connection|content-length|content-type|accept|transfer-encoding|cookie|set-cookie|proxy-.*|mcp-.*)$/.test(lower) || /[\r\n\u0000]/.test(value) || value.length > 8192 || Object.hasOwn(result, lower)) throw new DomainError('validation_failed', 'Private header names or values are not safe');
    result[lower] = value;
  }
  return result;
}
export function validateAutomationMcpEndpoint(endpoint: string): string {
  try { return normalizeWebhookUrl(endpoint).href; } catch { throw new DomainError('validation_failed', 'MCP endpoint must be a public HTTPS URL on port 443 without credentials, query, fragment or ambiguous path'); }
}
export type AutomationMcpTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> };
export type AutomationMcpTarget = { endpoint: string; headers: Record<string, string> };
export interface AutomationMcpAdapter { list(target: AutomationMcpTarget): Promise<AutomationMcpTool[]>; call(target: AutomationMcpTarget, name: string, args: Record<string, unknown>): Promise<unknown> }
type RpcResponse = { result?: unknown; error?: unknown };
/** Bounded one-shot Streamable HTTP transport. DNS is pinned; no proxy, redirect or automatic retry. */
async function post(target: AutomationMcpTarget, message: unknown, sessionId?: string): Promise<{ value: RpcResponse | null; sessionId: string | undefined }> {
  const url = new URL(validateAutomationMcpEndpoint(target.endpoint));
  const addresses = await resolveWebhookAddresses(url.hostname);
  const pinned = addresses[0]!;
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > 1048576) throw new DomainError('integration_input_too_large', 'Integration input exceeds one MiB');
  const { promise, resolve, reject } = Promise.withResolvers<{ value: RpcResponse | null; sessionId: string | undefined }>();
  const fail = (code = 'integration_transport_failed') => new DomainError(code, 'The configured MCP endpoint did not return a trusted response; no automatic retry was attempted', 502);
  const requestId = message && typeof message === 'object' && 'id' in message ? message.id : undefined;
  const request = https.request(url, { method: 'POST', agent: false, family: pinned.family, maxHeaderSize: 16384, lookup: (_host, _options, done) => done(null, pinned.address, pinned.family), servername: url.hostname, timeout: 15000,
    headers: { ...validateAutomationPrivateHeaders(target.headers), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'accept-encoding': 'identity', 'content-length': body.length, 'mcp-protocol-version': '2025-03-26', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) } }, response => {
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); reject(fail(response.statusCode === 401 || response.statusCode === 403 ? 'integration_authentication_failed' : 'integration_http_failed')); return; }
    const session = response.headers['mcp-session-id'];
    if (session !== undefined && (typeof session !== 'string' || session.length > 1024 || /[\r\n]/.test(session))) { response.destroy(); reject(fail()); return; }
    const streaming = String(response.headers['content-type']).includes('text/event-stream');
    const chunks: Buffer[] = []; let size = 0; let streamText = ''; let completed = false;
    const accept = (value: unknown) => {
      if (value && typeof value === 'object' && 'id' in value && value.id === requestId) {
        completed = true; resolve({ value: value as RpcResponse, sessionId: session }); response.destroy();
      }
    };
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 2097152) { response.destroy(); reject(fail('integration_response_too_large')); return; }
      if (!streaming) { chunks.push(Buffer.from(chunk)); return; }
      streamText += chunk;
      try {
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(streamText))) {
          const block = streamText.slice(0, boundary.index); streamText = streamText.slice(boundary.index + boundary[0].length);
          const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) accept(JSON.parse(data) as unknown);
          if (completed) return;
        }
      } catch { response.destroy(); reject(fail('integration_invalid_rpc')); }
    });
    response.once('error', () => { if (!completed) reject(fail()); }); response.once('aborted', () => { if (!completed) reject(fail()); });
    response.once('end', () => {
      if (completed) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        if (requestId === undefined && !text.trim()) { resolve({ value: null, sessionId: session }); return; }
        if (streaming) throw fail('integration_invalid_rpc');
        accept(JSON.parse(text) as unknown);
        if (!completed) throw fail('integration_invalid_rpc');
      } catch { reject(fail('integration_invalid_rpc')); }
    });
  });
  request.once('timeout', () => request.destroy(fail('integration_timeout'))); request.once('error', () => reject(fail())); request.end(body);
  const deadline = setTimeout(() => request.destroy(fail('integration_timeout')), 20000); request.once('close', () => clearTimeout(deadline));
  return promise;
}
function rpcResult(response: { value: RpcResponse | null }): unknown {
  if (!response.value || response.value.error !== undefined || !Object.hasOwn(response.value, 'result')) throw new DomainError('integration_rpc_failed', 'MCP operation was rejected; remote error details are withheld to protect private configuration', 502);
  return response.value.result;
}
async function session(target: AutomationMcpTarget) {
  const initialized = await post(target, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pm-automation-scoped', version: '1' } } });
  const result = rpcResult(initialized);
  if (!result || typeof result !== 'object' || !('capabilities' in result)) throw new DomainError('integration_invalid_rpc', 'MCP initialization did not advertise capabilities', 502);
  await post(target, { jsonrpc: '2.0', method: 'notifications/initialized' }, initialized.sessionId);
  return initialized.sessionId;
}
export const automationMcpAdapter: AutomationMcpAdapter = {
  async list(target) {
    const sessionId = await session(target); const tools: AutomationMcpTool[] = []; let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = rpcResult(await post(target, { jsonrpc: '2.0', id: page + 2, method: 'tools/list', params: cursor ? { cursor } : {} }, sessionId));
      if (!result || typeof result !== 'object' || !('tools' in result) || !Array.isArray(result.tools)) throw new DomainError('integration_invalid_rpc', 'MCP tools/list returned an invalid catalog', 502);
      for (const value of result.tools) {
        if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,200}$/.test(value.name) || !value.inputSchema || typeof value.inputSchema !== 'object') throw new DomainError('integration_invalid_rpc', 'MCP tool schema is invalid', 502);
        tools.push({ name: value.name, inputSchema: value.inputSchema as Record<string, unknown>, ...(typeof value.description === 'string' ? { description: value.description.slice(0, 8000) } : {}), ...(value.annotations && typeof value.annotations === 'object' ? { annotations: value.annotations as Record<string, unknown> } : {}) });
      }
      if (tools.length > 1000) throw new DomainError('integration_catalog_too_large', 'MCP tool catalog exceeds one thousand tools', 502);
      cursor = 'nextCursor' in result && typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
      if (!cursor) return tools;
    }
    throw new DomainError('integration_catalog_too_large', 'MCP tool catalog pagination exceeds twenty pages', 502);
  },
  async call(target, name, args) { const sessionId = await session(target); return rpcResult(await post(target, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, sessionId)); },
};
