import { createMcpServiceBearer, mcpIdentitySchema, readBoundedMcpBody, trustedMcpOrigin, verifyMcpServiceBearer, type McpInvocationIdentity } from '../../../../../packages/infrastructure/src/mcp-service-auth.ts';
import { readRecord } from '../durable/store.ts';
import { assertStoredThread, currentGrant, deny, digest, grantIdentity, MCP_TOKENS, McpAuthError } from './grants.ts';
import type { Grant } from './grants.ts';
export type { McpInvocationIdentity } from '../../../../../packages/infrastructure/src/mcp-service-auth.ts';
export { grantMcpThread } from './grants.ts';
export type McpCatalog = { workspaces: { id: string; name: string; projects: { id: string; name: string }[]; workspaceAllowed?: boolean }[] };
export const mcpPublicOrigin = (): string => trustedMcpOrigin(process.env.MCP_PUBLIC_ORIGIN ?? '').origin;
export async function pmRequest(path: string, headers: Headers): Promise<unknown> {
  const endpoint = new URL(path, trustedMcpOrigin(process.env.PM_API_URL?.trim() || 'http://127.0.0.1:4194'));
  const response = await fetch(endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(5_000) });
  if (!response.ok) { await response.body?.cancel(); throw new McpAuthError('access_denied', 'Current PM identity or scope is not authorized.', response.status === 401 ? 401 : 403); }
  return JSON.parse(await readBoundedMcpBody(response, 2 * 1024 * 1024));
}
/** Consent only accepts PM's real browser session. Shared Agent cookies and OAuth bearers confer no authority. */
export async function pmBrowser(request: Request): Promise<{ actorId: string; headers: Headers; sessionHash: string }> {
  const cookie = request.headers.get('cookie') ?? '';
  const sessions = cookie.split(';').map(value => value.trim()).filter(value => value.startsWith('pm_v4_session='));
  if (sessions.length !== 1 || sessions[0]!.length > 4096 || sessions[0] === 'pm_v4_session=') throw new McpAuthError('login_required', 'Sign in to PM to manage MCP clients.', 401);
  const headers = new Headers({ cookie: sessions[0]! });
  const value = await pmRequest('/api/v1/auth/me', headers) as { actor?: { id?: string } };
  if (!value.actor?.id) throw new McpAuthError('login_required', 'Current PM identity is required.', 401);
  return { actorId: value.actor.id, headers, sessionHash: digest(sessions[0]!) };
}
export function mcpIdentityFromHeaders(headers: Headers): McpInvocationIdentity | null {
  const authorization = headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer pm-mcp-service-v1.')) return null;
  const signed = verifyMcpServiceBearer(authorization.slice(7), true);
  if (!signed) deny('Invalid internal MCP delegation.');
  return grantIdentity(currentGrant(signed));
}
export async function mcpIdentityHeaders(identity: McpInvocationIdentity): Promise<Headers> {
  const grant = currentGrant(mcpIdentitySchema.parse(identity));
  return new Headers({ authorization: `Bearer ${createMcpServiceBearer(grantIdentity(grant))}` });
}
export async function assertMcpIdentity(identity: McpInvocationIdentity): Promise<void> {
  currentGrant(identity);
  // PM authenticates signed delegation, introspects storage, then checks live actor and membership.
  const catalog = await pmRequest('/api/v1/agent-contexts', await mcpIdentityHeaders(identity)) as McpCatalog;
  const workspace = catalog.workspaces.find(item => item.id === identity.scope.workspaceId);
  if (!workspace || (identity.scope.projectId === null ? workspace.workspaceAllowed !== true : !workspace.projects.some(project => project.id === identity.scope.projectId))) deny('The granted PM target is no longer available.');
  currentGrant(identity);
}
export async function authenticateMcpRequest(request: Request): Promise<McpInvocationIdentity> {
  if (new URL(request.url).pathname !== '/mcp') deny('MCP bearer is valid only at /mcp.');
  const authorization = request.headers.get('authorization') ?? '';
  if (!/^Bearer pm-mcp-access-v1\.[A-Za-z0-9_-]{43}$/.test(authorization)) deny();
  const token = readRecord<{ key: string; grantId: string; expiresAt: number; audience: string }>(MCP_TOKENS, digest(authorization.slice(7)));
  if (!token || token.expiresAt <= Date.now() || token.audience !== `${mcpPublicOrigin()}/mcp`) deny();
  const grant = readRecord<Grant>('mcp:grants', token.grantId);
  if (!grant || grant.audience !== token.audience) deny();
  const identity = grantIdentity(currentGrant(grant));
  await assertMcpIdentity(identity);
  return identity;
}
export async function assertMcpThread(identity: McpInvocationIdentity, threadId: string): Promise<void> {
  assertStoredThread(identity, threadId); await assertMcpIdentity(identity); assertStoredThread(identity, threadId);
}
