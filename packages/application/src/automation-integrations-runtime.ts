import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import type { StudioConfig } from '../../contracts/src/automation-studio.ts';
import { isPmAutomationTemplateId, pmAutomationArgumentsSchema } from '../../contracts/src/automation-pm.ts';
import { automationProviderRequestSchema, automationIntegrationSupportsMcp, automationIntegrationSupportsNativeApi, type AutomationIntegrationRuntimeInput, type AutomationProviderRequest } from '../../contracts/src/automation-integrations.ts';
import type { AutomationServiceIdentity } from '../../infrastructure/src/automation-execution-client.ts';
import { createAutomationPrivateStore, automationMcpAdapter, assertAutomationIntegrationsAvailable, type AutomationMcpTool } from '../../infrastructure/src/automation-integrations.ts';
import { automationNativeProviderAdapter, automationNativeRequestUrl, automationNativeRequestIsWrite } from '../../infrastructure/src/automation-integrations-native.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { authorizeAutomationIntegration } from './automation-integrations-store.ts';
import { readScopedAutomationConnection, type AutomationIntegrationsOptions } from './automation-integrations.ts';
import { requireCapability } from './access.ts';
import { requestHash } from './kernel.ts';
import { resolveAutomationMcpDefinition } from './automation-integrations-definitions.ts';

type ExecutionRow = { id: string; actor_id: string; workspace_id: string; project_id: string; request_id: string; definition_id: string; definition_revision: number; config_snapshot: StudioConfig; status: string; dispatched_at: Date | null; finished_at: Date | null };
type OperationRow = { request_hash: string; status: string; result: unknown; connection_id: string; connection_revision: number; project_id: string };
/** Native model tool names stay <=64 ASCII characters even when upstream MCP tool ids contain slashes. */
function scopedToolName(connectionId: string, name: string): string { return `integration_${connectionId.replace(/-/g, '')}__${createHash('sha256').update(name).digest('hex').slice(0, 18)}`; }
/** A connection's broad repository policy cannot widen a PM analysis's frozen PR scope. */
function assertPmProviderRead(config: StudioConfig, call: AutomationProviderRequest, target: URL): void {
  const action = config.action;
  if (action.kind !== 'template' || !isPmAutomationTemplateId(action.templateId)) return;
  const repository = pmAutomationArgumentsSchema.parse(action.arguments).repository;
  if (action.templateId !== 'pm-pr-acceptance-coverage' || !repository?.pullRequestNumber ||
      call.provider !== repository.provider || call.method !== 'GET' || call.body !== undefined) {
    throw new DomainError('integration_pm_analysis_forbidden', 'PM analysis permits only reads of its explicitly selected pull request', 403);
  }
  const prefix = repository.provider === 'github'
    ? `/repos/${repository.repository.split('/').map(encodeURIComponent).join('/')}/pulls/${repository.pullRequestNumber}`
    : `/api/v4/projects/${encodeURIComponent(repository.repository)}/merge_requests/${repository.pullRequestNumber}`;
  const permitted = repository.provider === 'github' ? [prefix, `${prefix}/files`] : [prefix, `${prefix}/changes`, `${prefix}/diffs`];
  const keys = [...target.searchParams.keys()];
  if (!permitted.some(path => path.toLowerCase() === target.pathname.toLowerCase()) ||
      new Set(keys).size !== keys.length || keys.some(key => key !== 'page' && key !== 'per_page') ||
      keys.some(key => !/^[1-9]\d{0,3}$/.test(target.searchParams.get(key) ?? '')) ||
      Number(target.searchParams.get('per_page') ?? '100') > 100) {
    throw new DomainError('integration_pm_analysis_forbidden', 'PM analysis cannot read another repository, PR, resource or unbounded query', 403);
  }
}
export function createAutomationIntegrationRuntimeService(options: AutomationIntegrationsOptions) {
  const store = options.privateStore ?? createAutomationPrivateStore(); const adapter = options.adapter ?? automationMcpAdapter;
  async function scoped<T>(identity: AutomationServiceIdentity, input: AutomationIntegrationRuntimeInput, operation: (sql: PoolClient, row: ExecutionRow, actor: Actor) => Promise<T>): Promise<T> {
    const sql = await options.database().connect();
    try {
      await sql.query('BEGIN'); await assertAutomationIntegrationsAvailable(sql); await lockWorkspace(sql, identity.workspaceId);
      const row = (await sql.query<ExecutionRow>('SELECT * FROM automation_studio_executions WHERE id=$1 AND workspace_id=$2 AND actor_id=$3', [identity.executionId, identity.workspaceId, identity.actorId])).rows[0];
      if (!row || input.executionId !== row.id || identity.generationId !== input.generationId || identity.projectId !== row.project_id || identity.requestId !== row.request_id || identity.definitionId !== row.definition_id || identity.definitionRevision !== row.definition_revision) throw new DomainError('not_found_or_forbidden', 'Automation integration execution scope does not match', 404);
      if (row.finished_at || !row.dispatched_at || !['queued', 'running', 'outcome_unknown'].includes(row.status)) throw new DomainError('automation_execution_inactive', 'Integration grant is not active for this execution', 409);
      const actor: Actor = { id: row.actor_id, email: '', name: '' };
      await authorizeAutomationIntegration(sql, options, actor, row.workspace_id, row.project_id, true);
      if (input.method !== 'grant/open') {
        const grant = await sql.query('SELECT generation_id FROM automation_integration_grants WHERE generation_id=$1 AND execution_id=$2 AND actor_id=$3 AND workspace_id=$4 AND revoked_at IS NULL AND expires_at>clock_timestamp()', [input.generationId, row.id, actor.id, row.workspace_id]);
        if (!grant.rowCount) throw new DomainError('integration_grant_revoked', 'This native generation grant expired or was revoked', 401);
      }
      const result = await operation(sql, row, actor); await sql.query('COMMIT'); return result;
    } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
  }
  async function preparedConnections(sql: PoolClient, row: ExecutionRow, actor: Actor) {
    const connections = [];
    for (const plugin of row.config_snapshot.action.plugins.filter(plugin => plugin.id.startsWith('integration:'))) {
      const id = z.uuid().parse(plugin.id.slice('integration:'.length));
      const connection = await readScopedAutomationConnection(sql, options, actor, row.workspace_id, id, true);
      if (connection.project_id !== row.project_id || connection.status !== 'verified' || String(connection.revision) !== plugin.version) throw new DomainError('integration_connection_changed', 'A frozen integration connection changed, was revoked or was not verified; explicitly update the definition before another run', 409);
      const mechanism = row.config_snapshot.action.kind === 'template' && (connection.config.provider === 'github' || connection.config.provider === 'gitlab') ? 'nativeApi' : 'mcp';
      const supported = mechanism === 'nativeApi' ? automationIntegrationSupportsNativeApi(connection.config) : automationIntegrationSupportsMcp(connection.config);
      if (!supported || connection.verification[mechanism] !== true) throw new DomainError('integration_mechanism_unavailable', `This execution requires an actually verified ${mechanism} connection; the selected mechanism is not available`, 409);
      const target = automationIntegrationSupportsMcp(connection.config) && connection.verification.mcp
        ? await resolveAutomationMcpDefinition(options.definitionResolver, { actorId: actor.id, workspaceId: row.workspace_id, projectId: row.project_id }, connection.config.mcpDefinition!, connection.mcp_config_fingerprint)
        : undefined;
      const nativeHeaders = connection.native_private_config ? store.open<Record<string, string>>(connection.native_private_config, `${row.workspace_id}:${actor.id}:${id}:connection`) : {};
      connections.push({ row: connection, target, nativeHeaders });
    }
    return connections;
  }
  return {
    async handle(identity: AutomationServiceIdentity, input: AutomationIntegrationRuntimeInput): Promise<unknown> {
      if (identity.audience !== 'automation-integrations' || !identity.generationId || identity.generationId !== input.generationId || identity.executionId !== input.executionId) throw new DomainError('unauthenticated', 'A generation-restricted integration bearer is required', 401);
      if (input.method === 'grant/close') {
        await options.database().query('UPDATE automation_integration_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE generation_id=$1 AND execution_id=$2 AND actor_id=$3 AND workspace_id=$4', [input.generationId, identity.executionId, identity.actorId, identity.workspaceId]);
        return { revoked: true };
      }
      if (input.method === 'grant/open') return scoped(identity, input, async (sql, row, actor) => {
        const connections = await preparedConnections(sql, row, actor);
        const grant = await sql.query(`INSERT INTO automation_integration_grants(generation_id,execution_id,workspace_id,actor_id,project_id,expires_at) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(generation_id) DO UPDATE SET generation_id=excluded.generation_id WHERE automation_integration_grants.execution_id=$2 AND automation_integration_grants.actor_id=$4 AND automation_integration_grants.workspace_id=$3 AND automation_integration_grants.revoked_at IS NULL RETURNING generation_id`, [input.generationId, row.id, row.workspace_id, actor.id, row.project_id, new Date(identity.expiresAt)]);
        if (!grant.rowCount) throw new DomainError('integration_grant_revoked', 'A revoked native generation grant cannot be reopened', 409);
        return { opened: true, mcpAvailable: connections.some(connection => automationIntegrationSupportsMcp(connection.row.config) && connection.row.verification.mcp) };
      });
      if (input.method === 'provider/origin') return scoped(identity, input, async (sql, row, actor) => {
        if (row.config_snapshot.action.kind !== 'template') throw new DomainError('integration_native_api_forbidden', 'Native provider API authority belongs only to an authorized native-template host, not prompt/script connector children', 403);
        const { provider } = z.strictObject({ provider: z.enum(['github', 'gitlab']) }).parse(input.params);
        const matching = (await preparedConnections(sql, row, actor)).filter(connection => connection.row.config.provider === provider);
        if (row.config_snapshot.action.kind === 'template' && isPmAutomationTemplateId(row.config_snapshot.action.templateId)) {
          const repository = pmAutomationArgumentsSchema.parse(row.config_snapshot.action.arguments).repository;
          if (row.config_snapshot.action.templateId !== 'pm-pr-acceptance-coverage' || repository?.provider !== provider) throw new DomainError('integration_pm_analysis_forbidden', 'PM analysis has no authority for this provider', 403);
        }
        if (matching.length !== 1 || !matching[0]!.row.config.nativeApi) throw new DomainError('integration_native_api_unconfigured', 'Select exactly one verified provider connection with an approved native API origin', 409);
        return { origin: new URL(matching[0]!.row.config.nativeApi!.baseUrl).origin };
      });
      if (input.method === 'provider/request') {
        const call = automationProviderRequestSchema.parse(input.params);
        const hash = requestHash({ executionId: input.executionId, ...call, operationId: undefined });
        const prepared = await scoped(identity, input, async (sql, row, actor) => {
          if (row.config_snapshot.action.kind !== 'template') throw new DomainError('integration_native_api_forbidden', 'Native provider API authority belongs only to an authorized native-template host, not prompt/script connector children', 403);
          const matching = (await preparedConnections(sql, row, actor)).filter(connection => connection.row.config.provider === call.provider);
          if (matching.length !== 1) throw new DomainError('integration_connection_ambiguous', 'Select exactly one frozen verified connection for this provider', 409);
          const connection = matching[0]!;
          const targetUrl = automationNativeRequestUrl(connection.row.config, call);
          assertPmProviderRead(row.config_snapshot, call, targetUrl);
          if (automationNativeRequestIsWrite(call) || targetUrl.pathname === '/search/issues') await requireCapability(sql, actor, row.workspace_id, 'access.manage', row.project_id);
          if (targetUrl.pathname === '/search/issues') {
            if (row.config_snapshot.action.templateId !== 'github-pr-reviewer') throw new DomainError('integration_owner_load_search_forbidden', 'Owner-wide load counts are restricted to the selected reviewer template', 403);
            const maintainers = row.config_snapshot.action.arguments.maintainers;
            const requested = /review-requested:([a-zA-Z0-9-]+)$/.exec(targetUrl.searchParams.get('q') ?? '')?.[1]?.toLowerCase();
            if (typeof maintainers === 'string' && maintainers.trim() && !maintainers.split(',').map(value => value.trim().toLowerCase()).includes(requested ?? '')) throw new DomainError('integration_owner_load_search_forbidden', 'The requested reviewer is outside the frozen explicit maintainer list', 403);
          }
          const prior = (await sql.query<OperationRow>('SELECT * FROM automation_integration_operations WHERE id=$1', [call.operationId])).rows[0];
          if (prior) {
            if (prior.request_hash !== hash || prior.connection_id !== connection.row.id || prior.connection_revision !== connection.row.revision || prior.project_id !== row.project_id) throw new DomainError('idempotency_conflict', 'Provider operation ID represents a different immutable call', 409);
            return { connection, prior };
          }
          await sql.query("INSERT INTO automation_integration_operations(id,workspace_id,actor_id,project_id,execution_id,connection_id,connection_revision,request_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'dispatching')", [call.operationId, row.workspace_id, actor.id, row.project_id, row.id, connection.row.id, connection.row.revision, hash]);
          return { connection };
        });
        if ('prior' in prepared && prepared.prior) {
          if (prepared.prior.status === 'completed') return prepared.prior.result;
          throw new DomainError('integration_outcome_unknown', 'The original provider request may have reached the provider; it was not redispatched. Reconcile its original operation key.', 409);
        }
        let result;
        try { result = await (options.nativeAdapter ?? automationNativeProviderAdapter)(prepared.connection.row.config, prepared.connection.nativeHeaders, call); }
        catch {
          await options.database().query("UPDATE automation_integration_operations SET status='outcome_unknown',finished_at=clock_timestamp() WHERE id=$1 AND status='dispatching'", [call.operationId]);
          throw new DomainError('integration_outcome_unknown', 'Provider API result is not confirmed; no automatic retry occurred. Reconcile the original operation key before another external mutation.', 502);
        }
        try {
          await options.database().query("UPDATE automation_integration_operations SET status='completed',result=$2::jsonb,finished_at=clock_timestamp() WHERE id=$1 AND status='dispatching'", [call.operationId, JSON.stringify(result)]);
          await scoped(identity, input, async (sql, row, actor) => { await preparedConnections(sql, row, actor); });
        } catch {
          throw new DomainError('integration_outcome_unknown', 'The provider operation was dispatched, but durable result confirmation or current result authorization failed. Its result is withheld; reconcile the original operation UUID without redispatching.', 502);
        }
        return result;
      }
      if (input.method === 'tools/list') {
        const connections = await scoped(identity, input, (sql, row, actor) => {
          if (row.config_snapshot.action.kind === 'template' && isPmAutomationTemplateId(row.config_snapshot.action.templateId)) throw new DomainError('integration_pm_analysis_forbidden', 'PM analysis does not expose connector tools', 403);
          return preparedConnections(sql, row, actor);
        });
        const tools: AutomationMcpTool[] = [];
        for (const connection of connections) {
          if (!automationIntegrationSupportsMcp(connection.row.config) || !connection.row.verification.mcp) continue;
          const remote = await adapter.list(connection.target!);
          for (const tool of remote) {
            const write = connection.row.config.writeTools.includes(tool.name);
            if (!write && !connection.row.config.readTools.includes(tool.name)) continue;
            if (!write && tool.annotations?.readOnlyHint === false) throw new DomainError('integration_tool_policy_mismatch', 'Remote tool now advertises writes outside its approved write allowlist', 409);
            tools.push({ name: scopedToolName(connection.row.id, tool.name), description: `${connection.row.config.label} (${tool.name}): ${tool.description ?? tool.name}${write ? ' [explicitly authorized external write; unknown results are never retried]' : ' [configured read]'}`, inputSchema: { type: 'object', properties: { operationId: { type: 'string', format: 'uuid', description: 'Stable operation UUID. Reuse only to query this exact call; never create another key after an unknown result.' }, arguments: tool.inputSchema }, required: ['operationId', 'arguments'], additionalProperties: false }, annotations: { readOnlyHint: !write } });
          }
        }
        if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new DomainError('integration_tool_identity_conflict', 'Configured remote tool identities collide; no ambiguous native tools were exposed', 409);
        // Revocation or connection changes during remote discovery must not expose a stale tool catalog.
        await scoped(identity, input, async (sql, row, actor) => { await preparedConnections(sql, row, actor); });
        return { tools };
      }
      const call = z.strictObject({ name: z.string().max(300), arguments: z.strictObject({ operationId: z.uuid(), arguments: z.record(z.string(), z.unknown()) }) }).parse(input.params);
      const match = /^integration_([a-f0-9]{32})__([a-f0-9]{18})$/.exec(call.name);
      if (!match) throw new DomainError('integration_tool_unavailable', 'Tool is not a scoped integration tool', 403);
      const compact = match[1]!; const connectionId = `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
      const hash = requestHash({ executionId: input.executionId, connectionId, name: call.name, arguments: call.arguments.arguments });
      const prepared = await scoped(identity, input, async (sql, row, actor) => {
        if (row.config_snapshot.action.kind === 'template' && isPmAutomationTemplateId(row.config_snapshot.action.templateId)) throw new DomainError('integration_pm_analysis_forbidden', 'PM analysis cannot call connector tools', 403);
        const connections = await preparedConnections(sql, row, actor); const connection = connections.find(candidate => candidate.row.id === connectionId);
        if (!connection) throw new DomainError('integration_tool_unavailable', 'Connection was not granted to this immutable execution', 403);
        if (!automationIntegrationSupportsMcp(connection.row.config) || !connection.row.verification.mcp) throw new DomainError('integration_mechanism_unavailable', 'Native API-only connections do not expose MCP tools', 403);
        const matching = [...connection.row.config.readTools, ...connection.row.config.writeTools].filter(name => scopedToolName(connectionId, name) === call.name);
        if (matching.length !== 1) throw new DomainError('integration_tool_unavailable', 'Tool identity does not uniquely identify an explicitly granted tool', 403);
        const name = matching[0]!;
        const write = connection.row.config.writeTools.includes(name);
        if (!write && !connection.row.config.readTools.includes(name)) throw new DomainError('integration_tool_unavailable', 'Tool is not explicitly allowed by this connection', 403);
        if (write) await requireCapability(sql, actor, row.workspace_id, 'access.manage', row.project_id);
        const prior = (await sql.query<OperationRow>('SELECT * FROM automation_integration_operations WHERE id=$1', [call.arguments.operationId])).rows[0];
        if (prior) {
          if (prior.request_hash !== hash || prior.connection_id !== connectionId || prior.connection_revision !== connection.row.revision || prior.project_id !== row.project_id) throw new DomainError('idempotency_conflict', 'Integration operation ID represents a different immutable call', 409);
          return { prior, connection, name };
        }
        await sql.query("INSERT INTO automation_integration_operations(id,workspace_id,actor_id,project_id,execution_id,connection_id,connection_revision,request_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'dispatching')", [call.arguments.operationId, row.workspace_id, actor.id, row.project_id, row.id, connectionId, connection.row.revision, hash]);
        return { connection, name };
      });
      const name = prepared.name;
      if ('prior' in prepared && prepared.prior) {
        if (prepared.prior.status === 'completed') return prepared.prior.result;
        throw new DomainError('integration_outcome_unknown', 'The original integration call may have reached the provider; it was not redispatched. Reconcile using the provider operation and original UUID.', 409);
      }
      let result: unknown;
      try {
        // Metadata drift must not turn a read allowlist entry into an unapproved write.
        const tools = await adapter.list(prepared.connection.target!); const tool = tools.find(candidate => candidate.name === name);
        if (!tool || prepared.connection.row.config.readTools.includes(name) && tool.annotations?.readOnlyHint === false) throw new DomainError('integration_tool_policy_mismatch', 'The current remote tool does not match its explicit approved policy', 409);
        await scoped(identity, input, async (sql, row, actor) => { await preparedConnections(sql, row, actor); });
        result = await adapter.call(prepared.connection.target!, name, call.arguments.arguments);
      } catch {
        await options.database().query("UPDATE automation_integration_operations SET status='outcome_unknown',finished_at=clock_timestamp() WHERE id=$1 AND status='dispatching'", [call.arguments.operationId]);
        throw new DomainError('integration_outcome_unknown', 'The integration result is not confirmed. No automatic retry occurred; reconcile the original operation UUID before any further external write.', 502);
      }
      try {
        await options.database().query("UPDATE automation_integration_operations SET status='completed',result=$2::jsonb,finished_at=clock_timestamp() WHERE id=$1 AND status='dispatching'", [call.arguments.operationId, JSON.stringify(result)]);
        // Never disclose a result after revocation, or misrepresent a post-dispatch denial as an upstream rejection.
        await scoped(identity, input, async (sql, row, actor) => { await preparedConnections(sql, row, actor); });
      } catch {
        throw new DomainError('integration_outcome_unknown', 'The integration operation was dispatched, but durable result confirmation or current result authorization failed. Its result is withheld; reconcile the original operation UUID without redispatching.', 502);
      }
      return result;
    },
  };
}
