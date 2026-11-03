import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// Adapted from automation-execution-client's server-only secret transport; distinct audience/domain.
export const mcpIdentitySchema = z.strictObject({ grantId: z.uuid(), actorId: z.uuid(), scope: z.strictObject({ workspaceId: z.uuid(), projectId: z.string().regex(/^PRJ-\d+$/).nullable() }), access: z.enum(['read-only', 'full']), threadIds: z.array(z.string().min(1).max(256)).max(1000), version: z.number().int().positive() });
export type McpInvocationIdentity = z.infer<typeof mcpIdentitySchema>;
const delegationSchema = mcpIdentitySchema.omit({ threadIds: true }).extend({ audience: z.literal('pm-mcp-service-v1'), issuedAt: z.number().int(), expiresAt: z.number().int() });
export type McpServiceIdentity = z.infer<typeof delegationSchema>;
const prefix = 'pm-mcp-service-v1.';
export function mcpMac(domain: string, value: string): string {
  const secret = process.env.PM_AUTOMATION_SERVICE_SECRET ?? '';
  if (Buffer.byteLength(secret) < 32) throw new Error('Configure PM_AUTOMATION_SERVICE_SECRET with at least 32 bytes on PM and Agent.');
  return createHmac('sha256', secret).update(`pm-mcp-service-v1\n${domain}\n${value}`).digest('base64url');
}
export function mcpEqual(a: string, b: string): boolean { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
export function createMcpServiceBearer(identity: McpInvocationIdentity): string {
  const { threadIds: _threads, ...grant } = mcpIdentitySchema.parse(identity);
  const now = Date.now(), payload = Buffer.from(JSON.stringify({ ...grant, audience: 'pm-mcp-service-v1', issuedAt: now, expiresAt: now + 60_000 })).toString('base64url');
  return `${prefix}${payload}.${mcpMac('delegate', payload)}`;
}
/** recoverExpired is exclusively for Agent's internal request-local refresh; PM never enables it. */
export function verifyMcpServiceBearer(token: string, recoverExpired = false): McpServiceIdentity | null {
  try {
    if (!token.startsWith(prefix) || token.length > 4096) return null;
    const [payload, signature, extra] = token.slice(prefix.length).split('.');
    if (!payload || !signature || extra !== undefined || !mcpEqual(signature, mcpMac('delegate', payload))) return null;
    const value = delegationSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))), now = Date.now();
    return value.issuedAt <= now + 5_000 && value.expiresAt - value.issuedAt === 60_000 && (recoverExpired || value.expiresAt > now) ? value : null;
  } catch { return null; }
}
export function mcpServiceHeaders(method: string, pathname: string, body: string): Headers {
  const timestamp = String(Date.now());
  return new Headers({ 'content-type': 'application/json', 'x-pm-mcp-timestamp': timestamp, 'x-pm-mcp-signature': mcpMac('introspection', `${timestamp}\n${method}\n${pathname}\n${createHash('sha256').update(body).digest('hex')}`) });
}
export function verifyMcpServiceRequest(method: string, pathname: string, body: string, headers: Headers): boolean {
  try {
    const timestamp = headers.get('x-pm-mcp-timestamp') ?? '';
    return /^\d{13}$/.test(timestamp) && Math.abs(Date.now() - Number(timestamp)) <= 30_000 && mcpEqual(headers.get('x-pm-mcp-signature') ?? '', mcpMac('introspection', `${timestamp}\n${method}\n${pathname}\n${createHash('sha256').update(body).digest('hex')}`));
  } catch { return false; }
}
export function trustedMcpOrigin(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('MCP requires a clean HTTPS origin (HTTP only on loopback).');
  return url;
}
export class McpBodyLimitError extends Error {}
export async function readBoundedMcpBody(response: Response | Request, maximum = 65_536): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error('MCP body deadline exceeded.')), 10_000);
  const consume = async () => {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > maximum) throw new McpBodyLimitError('MCP request or response exceeds its limit.');
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  };
  try { return await Promise.race([consume(), deadline]); }
  finally { clearTimeout(timer); void reader.cancel().catch(() => undefined); }
}
export async function introspectMcpGrant(identity: McpServiceIdentity): Promise<McpInvocationIdentity> {
  const endpoint = new URL('/internal/mcp/introspect', trustedMcpOrigin(process.env.PM_MCP_AGENT_URL ?? process.env.PM_AUTOMATION_AGENT_URL ?? ''));
  const body = JSON.stringify(identity);
  const response = await fetch(endpoint, { method: 'POST', body, headers: mcpServiceHeaders('POST', endpoint.pathname, body), signal: AbortSignal.timeout(5_000), redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new Error('MCP grant is not currently authorized.'); }
  const current = mcpIdentitySchema.parse(JSON.parse(await readBoundedMcpBody(response)));
  if (current.grantId !== identity.grantId || current.actorId !== identity.actorId || current.version !== identity.version || current.access !== identity.access || current.scope.workspaceId !== identity.scope.workspaceId || current.scope.projectId !== identity.scope.projectId) throw new Error('MCP grant identity changed.');
  return current;
}
