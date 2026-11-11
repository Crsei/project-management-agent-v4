import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { deleteRecord, listRecords, readRecord, transaction, writeRecord } from '../durable/store.ts';
import { getThread } from '../durable/threads.ts';
import type { McpInvocationIdentity, McpServiceIdentity } from '../../../../../packages/infrastructure/src/mcp-service-auth.ts';
import { trustedMcpOrigin } from '../../../../../packages/infrastructure/src/mcp-service-auth.ts';
import type { PmToolCallRecord, PmToolInvocation, PmToolTarget } from '@agent-workspace/contracts/pm-tools';

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

/** Durable external execution identity, never a Chat Session or an additional ACL. */
export const MCP_EXECUTION_ROOTS = 'mcp:execution-roots';
export type McpExecutionRoot = {
  executionRoot: 'external'; executionId: string; traceId: string; operationId: string;
  actorId: string; grantId: string; grantVersion: number; clientHash: string;
  scope: PmToolTarget; access: McpInvocationIdentity['access']; target?: PmToolTarget;
  fingerprint: string; policy: 'full'; enforcement: 'audit-only'; createdAt: string;
};
/** JSON object key order is not operation identity; array order and every value are. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new McpAuthError('invalid_request', 'Operation arguments must contain JSON values.');
  return encoded;
}
function assertExecutionRootGrant(root: McpExecutionRoot, grant: Grant): void {
  if (root.actorId !== grant.actorId || root.grantId !== grant.grantId || root.grantVersion !== grant.version ||
      root.clientHash !== grant.clientHash || root.access !== grant.access ||
      root.scope.workspaceId !== grant.scope.workspaceId || root.scope.projectId !== grant.scope.projectId)
    throw new McpAuthError('insufficient_scope', 'Original operation is unavailable to this delegation.', 403);
}
/** Storage-only after live identity checks; a root never grants authority to execute or read. */
export function readMcpExecutionRoot(identity: McpInvocationIdentity, operationId: string): McpExecutionRoot {
  const grant = currentGrant(identity), root = readRecord<McpExecutionRoot>(MCP_EXECUTION_ROOTS, operationId);
  if (!root) throw new McpAuthError('not_found', 'Original operation is unavailable to this delegation.', 404);
  assertExecutionRootGrant(root, grant);
  return root;
}
/** Reserve once before dispatch; a surviving root is sufficient to forbid blind redispatch. */
export function reserveMcpExecutionRoot(identity: McpInvocationIdentity, input: PmToolInvocation): { root: McpExecutionRoot; created: boolean } {
  const fingerprint = digest(canonicalJson(input));
  return transaction(() => {
    const grant = currentGrant(identity);
    if (input.target && (input.target.workspaceId !== grant.scope.workspaceId ||
        grant.scope.projectId !== null && input.target.projectId !== grant.scope.projectId))
      throw new McpAuthError('insufficient_scope', 'PM target exceeds the originating authorization ceiling.', 403);
    const existing = readRecord<McpExecutionRoot>(MCP_EXECUTION_ROOTS, input.operationId);
    if (existing) {
      assertExecutionRootGrant(existing, grant);
      if (existing.fingerprint !== fingerprint)
        throw new McpAuthError('invalid_request', 'operationId already belongs to another request.', 409);
      return { root: existing, created: false };
    }
    const root: McpExecutionRoot = {
      executionRoot: 'external', executionId: randomUUID(), traceId: randomUUID(), operationId: input.operationId,
      actorId: grant.actorId, grantId: grant.grantId, grantVersion: grant.version, clientHash: grant.clientHash,
      scope: { ...grant.scope }, access: grant.access, ...(input.target ? { target: { ...input.target } } : {}),
      fingerprint, policy: 'full', enforcement: 'audit-only', createdAt: new Date().toISOString(),
    };
    writeRecord(MCP_EXECUTION_ROOTS, input.operationId, root);
    return { root, created: true };
  });
}
/** Explicit Session consent never expands a grant's PM or directory ceiling. */
export function assertMcpThreadEligible(identity: Pick<McpInvocationIdentity, 'scope' | 'actorId'>, threadId: string): void {
  const thread = getThread(threadId);
  if (!thread || thread.deleted || thread.executionSelection?.agentWorkspaceId !== null || thread.executionSelection.agentWorkspaceRevision !== null)
    throw new McpAuthError('insufficient_scope', 'Only a chat-only Session may be delegated.', 403);
  const assertTarget = (target: PmToolTarget) => {
    if (target.workspaceId !== identity.scope.workspaceId || identity.scope.projectId !== null && target.projectId !== identity.scope.projectId)
      throw new McpAuthError('insufficient_scope', 'Session PM history exceeds the explicit delegation ceiling.', 403);
  };
  for (const generation of listRecords<{ threadId: string; pmOperations?: { actorId: string; target: PmToolTarget }[]; pmReferences?: PmToolTarget[] }>('chat:generations')) {
    if (generation.threadId !== threadId) continue;
    for (const operation of generation.pmOperations ?? []) {
      if (operation.actorId !== identity.actorId) throw new McpAuthError('insufficient_scope', 'Session PM history belongs to another actor.', 403);
      assertTarget(operation.target);
    }
    for (const reference of generation.pmReferences ?? []) assertTarget(reference);
  }
  for (const { record } of listRecords<{ record: PmToolCallRecord }>('pm-tool-calls')) {
    if (record.threadId !== threadId) continue;
    if (record.actorId && record.actorId !== identity.actorId) throw new McpAuthError('insufficient_scope', 'Session PM history belongs to another actor.', 403);
    if (record.name === 'pm_list_workspaces') {
      if (record.result?.kind === 'workspaces') for (const workspace of record.result.items) {
        if (workspace.id !== identity.scope.workspaceId) throw new McpAuthError('insufficient_scope', 'Workspace discovery history exceeds the delegation ceiling.', 403);
        for (const project of workspace.projects) assertTarget({ workspaceId: workspace.id, projectId: project.id });
      }
    } else if (record.target) assertTarget(record.target);
    else throw new McpAuthError('insufficient_scope', 'Historical PM operation target cannot be verified.', 403);
  }
}

export function assertStoredThread(identity: McpInvocationIdentity, threadId: string): void {
  const grant = currentGrant(identity), thread = getThread(threadId);
  if (!grant.threadIds.includes(threadId) || !thread || thread.deleted)
    throw new McpAuthError('insufficient_scope', 'Thread is not explicitly granted as a chat-only Session.', 403);
  assertMcpThreadEligible(grant, threadId);
}
export function grantMcpThread(identity: McpInvocationIdentity, threadId: string): void {
  transaction(() => {
    const grant = currentGrant(identity), thread = getThread(threadId);
    if (grant.access !== 'full' || !thread || thread.deleted)
      throw new McpAuthError('insufficient_scope', 'Cannot grant an unavailable Session.', 403);
    assertMcpThreadEligible(grant, threadId);
    if (grant.threadIds.includes(threadId)) return;
    if (grant.threadIds.length >= 1000) throw new McpAuthError('invalid_request', 'Thread grant limit reached.');
    writeRecord(MCP_GRANTS, grant.grantId, { ...grant, threadIds: [...grant.threadIds, threadId] });
  });
}
