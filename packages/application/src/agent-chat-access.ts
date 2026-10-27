import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { DomainError, type Actor, type Capability } from '../../domain/src/core.ts';
import { agentChatAccessInputSchema, type AgentChatAccess, type AgentChatScope } from '../../contracts/src/agent-chat.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { getMembership } from './access.ts';
import { AGENT_CHAT_TOOLS_VERSION } from './agent-chat-tools.ts';
import type { SqlExecutor } from './ports.ts';

export const AGENT_CHAT_LIMITS = { maxToolCalls: 20, maxRounds: 12, maxOutputChars: 80000 } as const;
type Tool = { name: string; description: string; write: boolean; capabilities: Capability[]; available: boolean; denyReason: string | null };
type AccessRow = {
  access_revision: number; access_grant_id: string | null; access_enabled: boolean; access_scope: AgentChatScope;
  access_expires_at: Date | null; access_revoked_at: Date | null; access_tools_version: number; tool_support_verified: boolean;
  tool_support_provider: string | null;
};
export function createAgentChatAccessService(options: {
  database: () => Pool;
  projects: (actor: Actor, workspaceId: string, sql: SqlExecutor) => Promise<string[]>;
  tools: readonly Tool[];
  providerIdentity: string | null;
}) {
  async function membership(sql: SqlExecutor, actor: Actor, workspaceId: string) {
    const member = await getMembership(sql, actor, workspaceId);
    if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
    return member;
  }
  async function row(sql: SqlExecutor, actor: Actor, workspaceId: string, threadId: string, lock = false) {
    const result = await sql.query<AccessRow>(`SELECT access_revision,access_grant_id,access_enabled,access_scope,access_expires_at,access_revoked_at,access_tools_version,tool_support_verified,tool_support_provider FROM agent_chat_threads WHERE id=$1 AND workspace_id=$2 AND actor_id=$3${lock ? ' FOR UPDATE' : ''}`, [threadId, workspaceId, actor.id]);
    if (!result.rows[0]) throw new DomainError('not_found_or_forbidden', 'Conversation is not accessible', 404);
    return result.rows[0];
  }
  async function read(actor: Actor, workspaceId: string, threadId: string, sql: SqlExecutor = options.database()): Promise<AgentChatAccess> {
    const member = await membership(sql, actor, workspaceId);
    const current = await row(sql, actor, workspaceId, threadId);
    const projectIds = current.access_scope.projectIds.filter(id => member.projectIds === null || member.projectIds.includes(id));
    const enabled = current.access_enabled && current.access_grant_id !== null && current.access_expires_at !== null && current.access_expires_at.getTime() > Date.now() && current.access_revoked_at === null && current.access_tools_version === AGENT_CHAT_TOOLS_VERSION;
    return {
      workspaceId, threadId, revision: current.access_revision, grantId: current.access_grant_id,
      mode: 'full_access', approvalPolicy: 'auto_approve', enabled,
      scope: { kind: current.access_scope.kind, projectIds }, expiresAt: current.access_expires_at?.toISOString() ?? null,
      revokedAt: current.access_revoked_at?.toISOString() ?? null, toolsVersion: current.access_tools_version,
      toolSupport: current.tool_support_verified && current.tool_support_provider === options.providerIdentity ? 'verified' : 'unverified', limits: AGENT_CHAT_LIMITS,
      tools: options.tools.map(tool => {
        let denyReason = tool.denyReason;
        if (!tool.available) denyReason ??= 'tool_unavailable';
        else if (!enabled) denyReason = current.access_enabled ? 'authorization_expired_or_changed' : 'authorization_disabled';
        else if (!tool.capabilities.every(capability => member.capabilities.includes(capability))) denyReason = 'permission_denied';
        else if (tool.name === 'pm_create_project' && (current.access_scope.kind !== 'workspace' || member.projectIds !== null)) denyReason = 'workspace_scope_required';
        else if (tool.name !== 'pm_create_project' && projectIds.length === 0) denyReason = 'no_authorized_project';
        return { name: tool.name, description: tool.description, write: tool.write, available: tool.available, allowed: denyReason === null, denyReason };
      }),
    };
  }
  async function set(actor: Actor, workspaceId: string, threadId: string, input: unknown): Promise<AgentChatAccess> {
    const parsed = agentChatAccessInputSchema.parse(input);
    const client = await options.database().connect();
    try {
      await client.query('BEGIN');
      await lockWorkspace(client, workspaceId);
      const member = await membership(client, actor, workspaceId);
      const current = await row(client, actor, workspaceId, threadId, true);
      if (current.access_revision !== parsed.expectedRevision) throw new DomainError('version_conflict', 'Chat authorization changed; reload it before deciding again', 409);
      let scope: AgentChatScope | undefined;
      if (parsed.scope) {
        if (parsed.scope.kind === 'workspace' && member.projectIds !== null) throw new DomainError('not_found_or_forbidden', 'Workspace-wide scope requires workspace-wide native permission', 404);
        const authorized = await options.projects(actor, workspaceId, client);
        if (authorized.length > 1000) throw new DomainError('agent_scope_too_large', 'Choose a smaller explicit project scope', 400);
        if (parsed.scope.kind === 'workspace' && parsed.scope.projectIds.length > 0) throw new DomainError('agent_scope_invalid', 'Workspace scope freezes the current authorized projects; do not submit a project list', 400);
        const selected = parsed.scope.kind === 'workspace' ? authorized : [...new Set(parsed.scope.projectIds)];
        if (parsed.scope.kind === 'projects' && selected.length === 0) throw new DomainError('agent_scope_required', 'Select at least one authorized project', 400);
        if (selected.some(id => !authorized.includes(id))) throw new DomainError('not_found_or_forbidden', 'One or more selected projects are unavailable', 404);
        scope = { kind: parsed.scope.kind, projectIds: selected };
      }
      if (parsed.enabled) {
        await client.query(`UPDATE agent_chat_threads SET access_revision=access_revision+1,access_grant_id=$4,access_enabled=true,access_scope=$5::jsonb,access_expires_at=clock_timestamp()+interval '60 minutes',access_revoked_at=NULL,access_tools_version=$6,updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2 AND actor_id=$3`,
          [threadId, workspaceId, actor.id, randomUUID(), JSON.stringify(scope), AGENT_CHAT_TOOLS_VERSION]);
      } else {
        // A context-only save is not a grant: retain grant identity/expiry and
        // leave every tool disabled, including when replacing an old grant.
        await client.query('UPDATE agent_chat_threads SET access_revision=access_revision+1,access_enabled=false,access_scope=coalesce($4::jsonb,access_scope),access_revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2 AND actor_id=$3', [threadId, workspaceId, actor.id, scope ? JSON.stringify(scope) : null]);
      }
      const result = await read(actor, workspaceId, threadId, client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async function assertCurrent(actor: Actor, workspaceId: string, threadId: string, expected: Pick<AgentChatAccess, 'grantId' | 'revision'>, toolName?: string, sql: SqlExecutor = options.database()) {
    const access = await read(actor, workspaceId, threadId, sql);
    if (!access.enabled || access.grantId !== expected.grantId || access.revision !== expected.revision) throw new DomainError('agent_authorization_changed', 'Chat authorization was stopped, expired or replaced; no new tool action was dispatched', 403);
    if (toolName && !access.tools.some(tool => tool.name === toolName && tool.allowed)) throw new DomainError('agent_tool_not_allowed', 'This tool is not currently allowed in the authorized scope', 403);
    return access;
  }
  return { read, set, assertCurrent };
}
export type AgentChatAccessService = ReturnType<typeof createAgentChatAccessService>;
