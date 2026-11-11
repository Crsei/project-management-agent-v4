import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import { getMembership } from '../../../../packages/application/src/access.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import { agentChatToolDefinitions } from '../../../../packages/application/src/agent-chat-tools.ts';
import type { SqlExecutor } from '../../../../packages/application/src/ports.ts';
import { agentChatToolResultSchema } from '../../../../packages/agent-contracts/src/pm-tool-result.ts';
import { pmToolLinkageSchema, pmToolRequestSchema, pmToolReconcileRequestSchema, pmToolReconcileResultSchema, type PmToolTarget, type PmToolLinkage, type PmToolRequest } from '../../../../packages/agent-contracts/src/pm-tools.ts';
import { PM_TOOL_RECONCILE_PATH, pmToolRequestHash, verifyPmToolLinkageBearer, verifyPmToolReconcileBearer } from '../../../../packages/infrastructure/src/pm-tool-service-auth.ts';
import { verifyAutomationServiceBearer } from '../../../../packages/infrastructure/src/automation-execution-client.ts';
import { withPmAutomationOrigin } from '../../../../packages/application/src/automation-pm-signals.ts';
import { CoreScope, type CoreWorkspacePool } from './core-routes.ts';
import { agentToolRecoveryIdentitySchema, type AgentChatTools, type AgentChatToolContext, type AgentToolRecoveryIdentity } from './agent-chat-tools.ts';
import { mcpRequestIdentity, recheckMcpRequest } from '../../../../packages/application/src/mcp-service-auth.ts';

type ToolRequest = PmToolRequest;
type OperationRow = {
  operation_id: string; workspace_id: string; actor_id: string; request_hash: string; name: string;
  thread_id: string; message_id: string; generation_id: string; status: 'running' | 'succeeded' | 'failed' | 'unknown';
  result: unknown; error: { code: string; message: string } | null; created_at: Date; finished_at: Date | null;
  target: PmToolTarget | null; recovery_identity: AgentToolRecoveryIdentity | null;
  linkage: PmToolLinkage | null; delegation_id: string | null; outcome_evidence: 'pm_result' | 'internal_proof' | null;
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
  async function scopeFor(actor: Actor, workspaceId: string, target: PmToolTarget, sql: SqlExecutor, name?: string) {
    if (target.workspaceId !== workspaceId) throw new DomainError('agent_tool_target_mismatch', 'The tool target must match the URL workspace', 400);
    const { tools, workspaces } = getTools();
    const member = await getMembership(sql, actor, workspaceId);
    if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
    const definition = name ? tools.registry.find(item => item.name === name) : undefined;
    if (name && !definition) throw new DomainError('agent_tool_not_available', 'This tool is not registered', 403);
    if (definition && !definition.capabilities.every(capability => member.capabilities.includes(capability))) throw new DomainError('agent_tool_not_allowed', 'The current actor lacks a required capability', 403);
    if (target.projectId === null && member.projectIds !== null) throw new DomainError('not_found_or_forbidden', 'Workspace scope requires workspace-wide native permission', 404);
    const coreScope = new CoreScope(member, workspaceId);
    const authorized = (await workspaces.get(workspaceId)).items({ entity: 'project', archived: 'exclude' })
      .filter(record => coreScope.allows(record) && !record.stale && !record.error).map(record => record.id);
    if (authorized.length > 1000 && target.projectId === null) throw new DomainError('agent_scope_too_large', 'Choose an explicit project target', 400);
    const selected = target.projectId === null ? authorized : [target.projectId];
    if (selected.some(id => !authorized.includes(id))) throw new DomainError('not_found_or_forbidden', 'The selected project is unavailable', 404);
    return { kind: target.projectId === null ? 'workspace' as const : 'projects' as const, projectIds: selected };
  }
  function record(row: OperationRow, target: PmToolTarget) {
    return { operationId: row.operation_id, name: row.name, status: row.status, actorId: row.actor_id,
      result: row.result === null ? null : agentChatToolResultSchema.parse(row.result), error: row.error,
      threadId: row.thread_id, messageId: row.message_id, generationId: row.generation_id,
      target, workspaceId: row.workspace_id, createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null,
      visibility: 'visible' as const, certainty: { dispatch: 'possibly_sent' as const, evidence: row.outcome_evidence ?? 'unresolved' as const },
      commandIds: row.recovery_identity ? [row.recovery_identity.commandId] : [],
      ...(row.linkage ? { linkage: pmToolLinkageSchema.parse(row.linkage) } : {}) };
  }
  async function lookup(input: ToolRequest, actor: Actor, workspaceId: string, hash: string, delegationId: string | null): Promise<OperationRow | undefined> {
    const row = (await options.database().query<OperationRow>('SELECT * FROM pm_agent_tool_operations WHERE operation_id=$1', [input.operationId])).rows[0];
    if (row && (row.workspace_id !== workspaceId || row.actor_id !== actor.id || row.request_hash !== hash || row.delegation_id !== delegationId))
      throw new DomainError('agent_tool_identity_conflict', 'Operation ID already represents a different request or delegation', 409);
    return row;
  }
  async function finish(row: OperationRow, status: OperationRow['status'], result: unknown, error: OperationRow['error'], evidence: OperationRow['outcome_evidence'] = null) {
    const updated = await options.database().query<OperationRow>(`UPDATE pm_agent_tool_operations SET status=$2,result=$3::jsonb,error=$4::jsonb,outcome_evidence=$5,finished_at=CASE WHEN $2 IN ('succeeded','failed') THEN clock_timestamp() ELSE NULL END WHERE operation_id=$1
      AND (status IN ('running','unknown') OR status='failed' AND outcome_evidence IS NULL AND $5='internal_proof') RETURNING *`,
      [row.operation_id, status, result === null ? null : JSON.stringify(result), error === null ? null : JSON.stringify(error), evidence]);
    return updated.rows[0] ?? (await options.database().query<OperationRow>('SELECT * FROM pm_agent_tool_operations WHERE operation_id=$1', [row.operation_id])).rows[0]!;
  }
  const unknownError = { code: 'agent_tool_outcome_unknown', message: 'The original outcome is not confirmed; reconcile it without redispatching.' };
  async function deliver(request: FastifyRequest, actor: Actor, input: ToolRequest, scope: AgentChatToolContext['scope'], row: OperationRow) {
    // Execution fact has already been persisted. A delivery denial must never overwrite it.
    const currentActor = await options.actor(request);
    if (currentActor.id !== actor.id) throw new DomainError('permission_denied', 'The original actor is no longer authorized', 403);
    await recheckMcpRequest(options.database(), request);
    const current = await scopeFor(actor, input.target.workspaceId, input.target, options.database(), input.name);
    if (scope.projectIds.some(id => !current.projectIds.includes(id))) throw new DomainError('permission_denied', 'The original result is no longer readable', 403);
    return record(row, input.target);
  }
  const catalog = (tools: AgentChatTools, request: FastifyRequest) => {
    const delegation = mcpRequestIdentity(request);
    return tools.registry.filter(tool => !delegation || (!tool.write || delegation.access === 'full') && (tool.name !== 'pm_create_project' || delegation.scope.projectId === null))
      .map(tool => ({ ...tool, inputSchema: agentChatToolDefinitions.find(item => item.function.name === tool.name)!.function.parameters }));
  };
  app.get('/api/v1/agent-tools', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const actor = await options.actor(request);
    const { tools } = getTools();
    const delegation = mcpRequestIdentity(request);
    const member = delegation ? await getMembership(options.database(), actor, delegation.scope.workspaceId) : null;
    const visible = catalog(tools, request).filter(tool => !member || tool.capabilities.every(capability => member.capabilities.includes(capability)));
    await recheckMcpRequest(options.database(), request);
    return { tools: visible };
  });
  app.get('/api/v1/workspaces/:workspaceId/agent-tools', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { workspaceId } = z.object({ workspaceId: z.uuid().toLowerCase() }).parse(request.params);
    const actor = await options.actor(request), { tools } = getTools();
    const member = await getMembership(options.database(), actor, workspaceId);
    if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
    const visible = catalog(tools, request).filter(tool => tool.capabilities.every(capability => member.capabilities.includes(capability)));
    await recheckMcpRequest(options.database(), request);
    return { tools: visible };
  });
  async function dispatch(request: FastifyRequest, reconcile: boolean) {
    const { workspaceId } = z.object({ workspaceId: z.uuid().toLowerCase() }).parse(request.params);
    const actor = await options.actor(request), input = pmToolRequestSchema.parse(request.body);
    const credential = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const automation = credential.startsWith('pm-automation-v1.') ? verifyAutomationServiceBearer(credential) : null;
    const originated = <T>(operation: () => Promise<T>): Promise<T> => automation ? withPmAutomationOrigin(automation.executionId, operation) : operation();
    const { tools } = getTools();
    await recheckMcpRequest(options.database(), request);
    const delegationId = mcpRequestIdentity(request)?.grantId ?? null;
    const scope = await scopeFor(actor, workspaceId, input.target, options.database(), input.name);
    const hash = pmToolRequestHash(input, actor.id);
    let row = await lookup(input, actor, workspaceId, hash, delegationId);
    if (!row && reconcile) throw new DomainError('not_found_or_forbidden', 'Original operation is not accessible', 404);
    if (!row) {
      const suppliedProof = request.headers['x-pm-tool-linkage'];
      const trustedLinkage = input.linkage && typeof suppliedProof === 'string'
        && verifyPmToolLinkageBearer(suppliedProof, actor.id, hash, input.linkage) ? input.linkage : null;
      // An unsigned caller can supply a correlation hint, never authoritative trace/actor/source.
      const linkage: PmToolLinkage | null = trustedLinkage ?? (input.executionRoot === 'external' || input.linkage?.executionRoot === 'external'
        ? { traceId: randomUUID(), invocationId: input.operationId, executionRoot: 'external', clientKind: delegationId ? 'mcp' : 'api', policy: 'full', enforcement: 'audit-only' } : null);
      const context: AgentChatToolContext = { actor, workspaceId, threadId: input.threadId, messageId: input.messageId, operationId: input.operationId, scope,
        ...(linkage ? { linkage } : {}),
        checkAuthorization: async sql => {
          await recheckMcpRequest(sql, request);
          const current = await scopeFor(actor, workspaceId, input.target, sql, input.name);
          if (scope.projectIds.some(id => !current.projectIds.includes(id))) throw new DomainError('agent_authorization_changed', 'The authorized project scope changed before commit', 403);
        } };
      const recovery = tools.recoveryIdentity(input.name, input.arguments, context);
      const inserted = await options.database().query<OperationRow>(`INSERT INTO pm_agent_tool_operations(operation_id,workspace_id,actor_id,request_hash,name,thread_id,message_id,generation_id,status,target,recovery_identity,linkage,delegation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9::jsonb,$10::jsonb,$11::jsonb,$12) ON CONFLICT(operation_id) DO NOTHING RETURNING *`,
        [input.operationId, workspaceId, actor.id, hash, input.name, input.threadId, input.messageId, input.generationId, JSON.stringify(input.target),
          recovery ? JSON.stringify(recovery) : null, linkage ? JSON.stringify(linkage) : null, delegationId]);
      row = inserted.rows[0];
      if (!row) row = await lookup(input, actor, workspaceId, hash, delegationId);
      else {
        active.add(input.operationId);
        try {
          const result = agentChatToolResultSchema.parse(await originated(() => tools.execute(input.name, input.arguments, context)));
          row = await finish(row, 'succeeded', result, null, 'pm_result');
        } catch (error) {
          // HTTP/error classes cannot prove a write was rejected. Only original durable evidence may terminate it.
          const proof = recovery ? await tools.inspectOutcome(recovery, actor.id, workspaceId).catch(() => null) : null;
          row = !tools.registry.find(tool => tool.name === input.name)?.write && error instanceof DomainError
            ? await finish(row, 'failed', null, { code: error.code, message: 'The read operation was rejected.' }, 'pm_result')
            : proof && proof.status !== 'unknown'
              ? await finish(row, proof.status, null, proof.status === 'failed' ? { code: 'agent_tool_recovered_rejection', message: 'The original command was rejected.' } : null, 'internal_proof')
              : await finish(row, 'unknown', null, unknownError);
        } finally { active.delete(input.operationId); }
        return deliver(request, actor, input, scope, row);
      }
    }
    if (!row) throw new DomainError('agent_tool_outcome_unknown', 'Operation record is unavailable', 503);
    if (row.status === 'running' && active.has(input.operationId)) return deliver(request, actor, input, scope, row);
    if (row.status === 'failed' && row.outcome_evidence === null) {
      // Historical error classes did not prove the dispatch boundary. Revisit this exact request, never batch-promote it.
      const uncertain = await options.database().query<OperationRow>(
        `UPDATE pm_agent_tool_operations SET status='unknown',error=$2::jsonb,finished_at=NULL
         WHERE operation_id=$1 AND status='failed' AND outcome_evidence IS NULL RETURNING *`,
        [row.operation_id, JSON.stringify(unknownError)]);
      row = uncertain.rows[0] ?? (await options.database().query<OperationRow>('SELECT * FROM pm_agent_tool_operations WHERE operation_id=$1', [row.operation_id])).rows[0] ?? row;
    }
    if (row.status === 'running' || row.status === 'unknown') {
      const context: AgentChatToolContext = { actor, workspaceId, threadId: input.threadId, messageId: input.messageId, operationId: input.operationId, scope,
        ...(row.linkage ? { linkage: row.linkage } : {}) };
      try {
        const recovered = await originated(() => tools.recover(input.name, input.arguments, context));
        row = recovered ? await finish(row, 'succeeded', agentChatToolResultSchema.parse(recovered), null, 'pm_result')
          : await finish(row, 'unknown', null, unknownError);
      } catch (error) {
        row = error instanceof DomainError && error.code === 'agent_tool_recovered_rejection'
          ? await finish(row, 'failed', null, { code: error.code, message: 'The original command was rejected.' }, 'pm_result')
          : await finish(row, 'unknown', null, unknownError);
      }
    }
    if (row.status === 'succeeded' && row.result === null) {
      // Internal proof settles fact, not delivery. Current-authorized reads may restore only the original receipt.
      const context: AgentChatToolContext = { actor, workspaceId, threadId: input.threadId, messageId: input.messageId, operationId: input.operationId, scope,
        ...(row.linkage ? { linkage: row.linkage } : {}) };
      try {
        const recovered = await originated(() => tools.recover(input.name, input.arguments, context));
        if (recovered) {
          const result = agentChatToolResultSchema.parse(recovered);
          const hydrated = await options.database().query<OperationRow>(
            `UPDATE pm_agent_tool_operations SET result=$2::jsonb WHERE operation_id=$1 AND status='succeeded' AND result IS NULL RETURNING *`,
            [row.operation_id, JSON.stringify(result)]);
          row = hydrated.rows[0] ?? (await options.database().query<OperationRow>('SELECT * FROM pm_agent_tool_operations WHERE operation_id=$1', [row.operation_id])).rows[0] ?? row;
        }
      } catch {
        // Source deletion, changed visibility or recovery outage never demote an already proven commit.
      }
    }
    return deliver(request, actor, input, scope, row);
  }
  app.post(PM_TOOL_RECONCILE_PATH, { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    z.strictObject({}).parse(request.query);
    const proof = pmToolReconcileRequestSchema.parse(request.body);
    const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const identity = verifyPmToolReconcileBearer(bearer, request.method, request.url, proof);
    if (!identity) throw new DomainError('unauthenticated', 'A valid operation-status service proof is required', 401);
    const sql = options.database();
    // Atomic durable nonce consumption survives PM restart; the signature cannot be used twice.
    await sql.query('DELETE FROM pm_agent_tool_service_nonces WHERE expires_at < clock_timestamp()');
    const consumed = await sql.query(`INSERT INTO pm_agent_tool_service_nonces(nonce,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING nonce`,
      [identity.nonce, new Date(identity.expiresAt)]);
    if (!consumed.rowCount) throw new DomainError('unauthenticated', 'Service proof was already consumed', 401);
    let row = (await sql.query<OperationRow>('SELECT * FROM pm_agent_tool_operations WHERE operation_id=$1', [proof.operationId])).rows[0];
    if (!row || row.workspace_id !== proof.target.workspaceId || row.actor_id !== proof.actorId || row.request_hash !== proof.requestHash
      || !row.target || requestHash(row.target) !== requestHash(proof.target))
      throw new DomainError('not_found_or_forbidden', 'Original operation proof is not accessible', 404);
    let evidence: 'operation' | 'command_receipt' | 'native_journal' | 'unresolved' = 'unresolved';
    let status: 'succeeded' | 'failed' | 'unknown' = 'unknown';
    if ((row.status === 'succeeded' || row.status === 'failed') && row.outcome_evidence) {
      status = row.status; evidence = 'operation';
    } else if (!(row.status === 'running' && active.has(row.operation_id)) && row.recovery_identity) {
      try {
        const recovered = await getTools().tools.inspectOutcome(agentToolRecoveryIdentitySchema.parse(row.recovery_identity), row.actor_id, row.workspace_id);
        status = recovered.status; evidence = recovered.evidence;
        if (status !== 'unknown') row = await finish(row, status, null, null, 'internal_proof');
        if (row.status === 'succeeded' && row.outcome_evidence) status = 'succeeded';
      } catch { /* Missing/corrupt journals or unavailable storage remain unresolved, never a redispatch. */ }
    }
    return pmToolReconcileResultSchema.parse({ ...proof, status, evidence,
      commandIds: row.recovery_identity ? [row.recovery_identity.commandId] : [],
      ...(row.linkage ? { linkage: row.linkage } : {}) });
  });
  app.post('/api/v1/workspaces/:workspaceId/agent-tools/call', async (request, reply) => { reply.header('Cache-Control', 'private, no-store'); return dispatch(request, false); });
  app.post('/api/v1/workspaces/:workspaceId/agent-tools/result', async (request, reply) => { reply.header('Cache-Control', 'private, no-store'); return dispatch(request, true); });
}
