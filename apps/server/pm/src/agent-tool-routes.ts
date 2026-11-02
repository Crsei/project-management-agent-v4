import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import { getMembership } from '../../../../packages/application/src/access.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import { agentChatToolDefinitions } from '../../../../packages/application/src/agent-chat-tools.ts';
import type { SqlExecutor } from '../../../../packages/application/src/ports.ts';
import { agentChatToolResultSchema } from '../../../../packages/agent-contracts/src/pm-tool-result.ts';
import { verifyAutomationServiceBearer } from '../../../../packages/infrastructure/src/automation-execution-client.ts';
import { withPmAutomationOrigin } from '../../../../packages/application/src/automation-pm-signals.ts';
import { WorkspaceError } from '../../../../packages/pm-core/index.ts';
import { CoreScope, type CoreWorkspacePool } from './core-routes.ts';
import type { AgentChatTools, AgentChatToolContext } from './agent-chat-tools.ts';

const correlation = z.string().min(1).max(200);
const agentChatScopeSchema = z.strictObject({ kind: z.enum(['projects', 'workspace']), projectIds: z.array(z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/)).max(1000) });
const requestSchema = z.strictObject({
  operationId: z.uuid().toLowerCase(), name: z.string().min(1).max(100), arguments: z.unknown(),
  scope: agentChatScopeSchema, threadId: correlation, messageId: correlation, generationId: correlation,
}).refine(value => value.arguments !== undefined, 'Arguments are required');
type ToolRequest = z.infer<typeof requestSchema>;
type OperationRow = {
  operation_id: string; workspace_id: string; actor_id: string; request_hash: string; name: string;
  thread_id: string; message_id: string; generation_id: string; status: 'running' | 'succeeded' | 'failed' | 'unknown';
  result: unknown; error: { code: string; message: string } | null; created_at: Date; finished_at: Date | null;
};

/** Independent of PM's retired chat tables; only original business receipts can reconcile an interrupted write. */
export function registerAgentToolRoutes(app: FastifyInstance, options: {
  database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>;
  coreWorkspaces: CoreWorkspacePool | undefined; tools: AgentChatTools | undefined;
}): void {
  const active = new Set<string>();
  const getTools = () => {
    if (!options.tools || !options.coreWorkspaces) throw new DomainError('backend_not_initialized', 'The Markdown core is unavailable', 503);
    return { tools: options.tools, workspaces: options.coreWorkspaces };
  };
  async function scopeFor(actor: Actor, workspaceId: string, input: ToolRequest['scope'], sql: SqlExecutor, name?: string) {
    const { tools, workspaces } = getTools();
    const member = await getMembership(sql, actor, workspaceId);
    if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
    const definition = name ? tools.registry.find(item => item.name === name) : undefined;
    if (name && !definition) throw new DomainError('agent_tool_not_available', 'This tool is not registered', 403);
    if (definition && !definition.capabilities.every(capability => member.capabilities.includes(capability))) throw new DomainError('agent_tool_not_allowed', 'The current actor lacks a required capability', 403);
    if (input.kind === 'workspace' && member.projectIds !== null) throw new DomainError('not_found_or_forbidden', 'Workspace scope requires workspace-wide native permission', 404);
    if (input.kind === 'workspace' && input.projectIds.length) throw new DomainError('agent_scope_invalid', 'Workspace scope does not accept a project list', 400);
    const coreScope = new CoreScope(member, workspaceId);
    const authorized = (await workspaces.get(workspaceId)).items({ entity: 'project', archived: 'exclude' })
      .filter(record => coreScope.allows(record) && !record.stale && !record.error).map(record => record.id);
    if (authorized.length > 1000 && input.kind === 'workspace') throw new DomainError('agent_scope_too_large', 'Choose a smaller explicit project scope', 400);
    const selected = input.kind === 'workspace' ? authorized : [...new Set(input.projectIds)];
    if (input.kind === 'projects' && !selected.length) throw new DomainError('agent_scope_required', 'Select at least one authorized project', 400);
    if (selected.some(id => !authorized.includes(id))) throw new DomainError('not_found_or_forbidden', 'One or more selected projects are unavailable', 404);
    return { kind: input.kind, projectIds: selected };
  }
  function record(row: OperationRow) {
    return { operationId: row.operation_id, name: row.name, status: row.status,
      result: row.result === null ? null : agentChatToolResultSchema.parse(row.result), error: row.error,
      threadId: row.thread_id, messageId: row.message_id, generationId: row.generation_id,
      workspaceId: row.workspace_id, createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null };
  }
  async function lookup(input: ToolRequest, actor: Actor, workspaceId: string, hash: string): Promise<OperationRow | undefined> {
    const row = (await options.database().query<OperationRow>('SELECT * FROM pm_agent_tool_operations WHERE operation_id=$1', [input.operationId])).rows[0];
    if (row && (row.workspace_id !== workspaceId || row.actor_id !== actor.id || row.request_hash !== hash)) throw new DomainError('agent_tool_identity_conflict', 'Operation ID already represents a different request', 409);
    return row;
  }
  async function finish(row: OperationRow, status: OperationRow['status'], result: unknown, error: OperationRow['error']) {
    const updated = await options.database().query<OperationRow>(`UPDATE pm_agent_tool_operations SET status=$2,result=$3::jsonb,error=$4::jsonb,finished_at=CASE WHEN $2 IN ('succeeded','failed') THEN clock_timestamp() ELSE NULL END WHERE operation_id=$1 AND status IN ('running','unknown') RETURNING *`,
      [row.operation_id, status, result === null ? null : JSON.stringify(result), error === null ? null : JSON.stringify(error)]);
    return updated.rows[0] ?? (await options.database().query<OperationRow>('SELECT * FROM pm_agent_tool_operations WHERE operation_id=$1', [row.operation_id])).rows[0]!;
  }
  function failure(error: unknown, write: boolean): { status: 'failed' | 'unknown'; error: { code: string; message: string } } {
    if (error instanceof DomainError) {
      // A post-commit authorization/read failure may hide a completed native write.
      const unknown = error.status >= 500 || /unknown|recovered/i.test(error.code)
        || (write && ['not_found_or_forbidden', 'permission_denied'].includes(error.code));
      return { status: unknown ? 'unknown' : 'failed', error: { code: error.code, message: error.message } };
    }
    if (error instanceof WorkspaceError && error.status < 500 && !(write && error.status === 404)) return { status: 'failed', error: { code: error.diagnostics[0]?.code ?? 'core_write_rejected', message: error.message } };
    return { status: 'unknown', error: { code: 'agent_tool_outcome_unknown', message: 'The original operation could not be confirmed; reconcile it without redispatching.' } };
  }
  app.get('/api/v1/workspaces/:workspaceId/agent-tools', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { workspaceId } = z.object({ workspaceId: z.uuid().toLowerCase() }).parse(request.params);
    const actor = await options.actor(request), { tools } = getTools();
    const member = await getMembership(options.database(), actor, workspaceId);
    if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
    return { tools: tools.registry.map(tool => ({ ...tool, inputSchema: agentChatToolDefinitions.find(item => item.function.name === tool.name)!.function.parameters })) };
  });
  async function dispatch(request: FastifyRequest, reconcile: boolean) {
    const { workspaceId } = z.object({ workspaceId: z.uuid().toLowerCase() }).parse(request.params);
    const actor = await options.actor(request), input = requestSchema.parse(request.body);
    const credential = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const automation = credential.startsWith('pm-automation-v1.') ? verifyAutomationServiceBearer(credential) : null;
    const originated = <T>(operation: () => Promise<T>): Promise<T> => automation ? withPmAutomationOrigin(automation.executionId, operation) : operation();
    const { tools } = getTools();
    const scope = await scopeFor(actor, workspaceId, input.scope, options.database(), input.name);
    const hash = requestHash({ ...input, workspaceId, actorId: actor.id });
    let row = await lookup(input, actor, workspaceId, hash);
    if (!row && reconcile) throw new DomainError('not_found_or_forbidden', 'Original operation is not accessible', 404);
    if (!row) {
      const inserted = await options.database().query<OperationRow>(`INSERT INTO pm_agent_tool_operations(operation_id,workspace_id,actor_id,request_hash,name,thread_id,message_id,generation_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running') ON CONFLICT(operation_id) DO NOTHING RETURNING *`,
        [input.operationId, workspaceId, actor.id, hash, input.name, input.threadId, input.messageId, input.generationId]);
      row = inserted.rows[0];
      if (!row) row = await lookup(input, actor, workspaceId, hash);
      else {
        active.add(input.operationId);
        const context: AgentChatToolContext = { actor, workspaceId, threadId: input.threadId, messageId: input.messageId, operationId: input.operationId, scope,
          checkAuthorization: async sql => {
            const current = await scopeFor(actor, workspaceId, input.scope, sql, input.name);
            if (scope.projectIds.some(id => !current.projectIds.includes(id))) throw new DomainError('agent_authorization_changed', 'The authorized project scope changed before the operation was committed', 403);
          } };
        try { row = await finish(row, 'succeeded', agentChatToolResultSchema.parse(await originated(() => tools.execute(input.name, input.arguments, context))), null); }
        catch (error) { const outcome = failure(error, tools.registry.find(tool => tool.name === input.name)?.write ?? false); row = await finish(row, outcome.status, null, outcome.error); }
        finally { active.delete(input.operationId); }
        return record(row);
      }
    }
    if (!row) throw new DomainError('agent_tool_outcome_unknown', 'Operation record is unavailable', 503);
    if (row.status === 'running' && active.has(input.operationId)) return record(row);
    if (row.status === 'running' || row.status === 'unknown') {
      const context: AgentChatToolContext = { actor, workspaceId, threadId: input.threadId, messageId: input.messageId, operationId: input.operationId, scope };
      try {
        const recovered = await originated(() => tools.recover(input.name, input.arguments, context));
        if (recovered) row = await finish(row, 'succeeded', agentChatToolResultSchema.parse(recovered), null);
        else row = await finish(row, 'unknown', null, { code: 'agent_tool_outcome_unknown', message: 'The original outcome is not yet confirmed; it was not redispatched.' });
      } catch (error) {
        if (error instanceof DomainError && error.code === 'agent_tool_recovered_rejection') {
          row = await finish(row, 'failed', null, { code: error.code, message: error.message });
        } else {
          row = await finish(row, 'unknown', null, { code: 'agent_tool_outcome_unknown', message: 'The original outcome could not be confirmed; it was not redispatched.' });
        }
      }
    }
    return record(row);
  }
  app.post('/api/v1/workspaces/:workspaceId/agent-tools/call', async (request, reply) => { reply.header('Cache-Control', 'private, no-store'); return dispatch(request, false); });
  app.post('/api/v1/workspaces/:workspaceId/agent-tools/result', async (request, reply) => { reply.header('Cache-Control', 'private, no-store'); return dispatch(request, true); });
}
