import { createHash, randomBytes } from 'node:crypto';
import { deleteRecord, listRecords, readRecord, transaction, writeRecord } from '../durable/store.ts';
import { getThread } from '../durable/threads.ts';
import type { McpInvocationIdentity, McpServiceIdentity } from '../../../../../packages/infrastructure/src/mcp-service-auth.ts';
import { trustedMcpOrigin } from '../../../../../packages/infrastructure/src/mcp-service-auth.ts';

// McpOAuth PendingCode + EnvironmentAuth MCP sessions adapted to existing Agent SQLite records.
export const MCP_GRANTS = 'mcp:grants', MCP_CODES = 'mcp:codes', MCP_TOKENS = 'mcp:tokens', MCP_CONSENTS = 'mcp:consents';
export type Grant = McpInvocationIdentity & { clientHash: string; clientName: string; audience: string; createdAt: string; expiresAt: string; revokedAt: string | null };
export type ExpiringRecord = { key: string; expiresAt: number };
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const opaque = (): string => randomBytes(32).toString('base64url');
export class McpAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function deny(message = 'MCP grant is expired, revoked, or unavailable.'): never { throw new McpAuthError('invalid_token', message, 401); }
export function grantIdentity(grant: Grant): McpInvocationIdentity { return { grantId: grant.grantId, actorId: grant.actorId, scope: { ...grant.scope }, access: grant.access, threadIds: [...grant.threadIds], version: grant.version }; }
/** Storage-only: introspection must never call PM or await while inside a SQLite transaction. */
export function currentGrant(identity: Pick<McpServiceIdentity, 'grantId' | 'actorId' | 'scope' | 'access' | 'version'>): Grant {
  const grant = readRecord<Grant>(MCP_GRANTS, identity.grantId);
  if (!grant || grant.revokedAt || Date.parse(grant.expiresAt) <= Date.now() || grant.actorId !== identity.actorId || grant.version !== identity.version || grant.access !== identity.access || grant.scope.workspaceId !== identity.scope.workspaceId || grant.scope.projectId !== identity.scope.projectId) deny();
  if (grant.audience !== `${trustedMcpOrigin(process.env.MCP_PUBLIC_ORIGIN ?? '').origin}/mcp`) deny('MCP resource audience changed.');
  return grant;
}
export function boundedRecord<T extends ExpiringRecord>(namespace: string, record: T, limit = 2048): void {
  for (const item of listRecords<ExpiringRecord>(namespace)) if (item.expiresAt <= Date.now()) deleteRecord(namespace, item.key);
  if (listRecords<ExpiringRecord>(namespace).length >= limit) throw new McpAuthError('temporarily_unavailable', 'OAuth storage is at capacity; retry later.', 503);
  writeRecord(namespace, record.key, record);
}
export function putGrant(grant: Grant): void {
  for (const item of listRecords<Grant>(MCP_GRANTS)) if (Date.parse(item.expiresAt) <= Date.now()) deleteRecord(MCP_GRANTS, item.grantId);
  const grants = listRecords<Grant>(MCP_GRANTS);
  if (grants.length >= 4096 || grants.filter(item => item.actorId === grant.actorId && !item.revokedAt).length >= 100) throw new McpAuthError('temporarily_unavailable', 'Revoke an existing client before approving another.', 503);
  writeRecord(MCP_GRANTS, grant.grantId, grant);
}
export function assertStoredThread(identity: McpInvocationIdentity, threadId: string): void {
  const grant = currentGrant(identity), thread = getThread(threadId);
  if (!grant.threadIds.includes(threadId) || !thread || thread.deleted || !thread.scope || thread.scope.workspaceId !== grant.scope.workspaceId || thread.scope.projectId !== grant.scope.projectId) throw new McpAuthError('insufficient_scope', 'Thread is not explicitly granted in this scope.', 403);
}
export function grantMcpThread(identity: McpInvocationIdentity, threadId: string): void {
  transaction(() => {
    const grant = currentGrant(identity), thread = getThread(threadId);
    if (grant.access !== 'full' || !thread || thread.deleted || !thread.scope || thread.scope.workspaceId !== grant.scope.workspaceId || thread.scope.projectId !== grant.scope.projectId) throw new McpAuthError('insufficient_scope', 'Cannot grant this thread.', 403);
    if (grant.threadIds.includes(threadId)) return;
    if (grant.threadIds.length >= 1000) throw new McpAuthError('invalid_request', 'Thread grant limit reached.');
    writeRecord(MCP_GRANTS, grant.grantId, { ...grant, threadIds: [...grant.threadIds, threadId] });
  });
}
