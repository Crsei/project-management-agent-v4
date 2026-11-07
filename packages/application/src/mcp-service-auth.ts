import { DomainError, type Actor } from '../../domain/src/core.ts';
import { introspectMcpGrant, verifyMcpServiceBearer, type McpInvocationIdentity, type McpServiceIdentity } from '../../infrastructure/src/mcp-service-auth.ts';
import { pmToolTargetSchema } from '../../agent-contracts/src/pm-tools.ts';
import { pmReferenceResolveRequestSchema } from '../../agent-contracts/src/pm-references.ts';
import { AGENT_CHAT_TOOL_REGISTRY } from './agent-chat-tools.ts';
import { assertProjectScope, getMembership } from './access.ts';
import type { SqlExecutor } from './ports.ts';

type Request = { method: string; url: string; body: unknown; headers?: { authorization?: string | undefined } };
export function mcpRequestIdentity(request: Pick<Request, 'headers'>): McpServiceIdentity | null {
  const value = request.headers?.authorization ?? '';
  if (!value.startsWith('Bearer pm-mcp-service-v1.')) return null;
  const identity = verifyMcpServiceBearer(value.slice(7));
  if (!identity) throw new DomainError('unauthenticated', 'MCP delegation is invalid or expired', 401);
  return identity;
}
export function assertMcpEndpoint(identity: McpInvocationIdentity, request: Request): void {
  const url = new URL(request.url, 'http://pm.invalid'), scope = identity.scope;
  const base = `/api/v1/workspaces/${scope.workspaceId}/agent-tools`;
  const body = request.body as { workspaceId?: unknown; projectId?: unknown; target?: unknown; name?: unknown; threadId?: unknown; operationId?: unknown; generationId?: unknown; messageId?: unknown } | null;
  let allowed = false;
  if (request.method === 'GET' && !url.search && url.pathname === '/api/v1/agent-contexts') allowed = true;
  else if (request.method === 'GET' && !url.search && url.pathname === '/api/v1/agent-tools') allowed = true;
  else if (request.method === 'POST' && !url.search && url.pathname === '/api/v1/agent-contexts/authorize') allowed = body?.workspaceId === scope.workspaceId && body.projectId === scope.projectId;
  else if (request.method === 'POST' && !url.search && url.pathname === '/api/v1/agent-contexts/resolve') allowed = identity.access === 'full' && body?.workspaceId === scope.workspaceId && body.projectId === scope.projectId;
  else if (request.method === 'GET' && !url.search && url.pathname === base) allowed = true;
  else if (request.method === 'GET' && url.pathname === `${base}/core-files`) allowed = url.searchParams.getAll('projectId').length === 1 && [...url.searchParams.keys()].every(key => key === 'projectId') && !!url.searchParams.get('projectId') && (scope.projectId === null || url.searchParams.get('projectId') === scope.projectId);
  else if (request.method === 'POST' && !url.search && url.pathname === `/api/v1/workspaces/${scope.workspaceId}/agent-references/resolve`) {
    const references = pmReferenceResolveRequestSchema.safeParse(request.body);
    allowed = references.success && references.data.references.every(reference => reference.workspaceId === scope.workspaceId && (scope.projectId === null || reference.projectId === null || reference.projectId === scope.projectId));
  }
  else if (request.method === 'POST' && !url.search && (url.pathname === `${base}/call` || url.pathname === `${base}/result`)) {
    const tool = AGENT_CHAT_TOOL_REGISTRY.find(item => item.name === body?.name), selected = pmToolTargetSchema.safeParse(body?.target);
    const selectedAllowed = selected.success && selected.data.workspaceId === scope.workspaceId
      && (scope.projectId === null || selected.data.projectId === scope.projectId);
    allowed = !!tool && (!tool.write || identity.access === 'full') && selectedAllowed && typeof body?.threadId === 'string' && identity.threadIds.includes(body.threadId) && typeof body.operationId === 'string' && typeof body.generationId === 'string' && typeof body.messageId === 'string';
  }
  if (!allowed) throw new DomainError('mcp_scope_forbidden', 'MCP delegation cannot authorize this endpoint, action, thread or target', 403);
}
/** No nested transaction: callers may pass their mutation-lock SqlExecutor for final authorization. */
export async function authorizeMcpService(sql: SqlExecutor, identity: McpServiceIdentity, request: Request): Promise<Actor> {
  let current: McpInvocationIdentity;
  try { current = await introspectMcpGrant(identity); } catch { throw new DomainError('mcp_grant_revoked', 'MCP grant is not currently authorized', 403); }
  assertMcpEndpoint(current, request);
  const actor = (await sql.query<Actor>('SELECT id,email,name FROM users WHERE id=$1 AND disabled_at IS NULL', [identity.actorId])).rows[0];
  if (!actor) throw new DomainError('unauthenticated', 'MCP actor is no longer active', 401);
  const member = await getMembership(sql, actor, identity.scope.workspaceId);
  assertProjectScope(member, identity.scope.projectId);
  if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
  const tool = AGENT_CHAT_TOOL_REGISTRY.find(item => item.name === (request.body as { name?: unknown } | null)?.name);
  if (tool && !tool.capabilities.every(capability => member.capabilities.includes(capability))) throw new DomainError('permission_denied', 'Current actor lacks required tool capabilities', 403);
  return actor;
}
export async function recheckMcpRequest(sql: SqlExecutor, request: Request): Promise<void> {
  const identity = mcpRequestIdentity(request); if (identity) await authorizeMcpService(sql, identity, request);
}
