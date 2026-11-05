import type { z } from 'zod';
import type { Actor } from '../../domain/src/core.ts';
import { DomainError } from '../../domain/src/core.ts';
import { automationIntegrationProviders, automationIntegrationSupportsMcp, automationIntegrationSupportsNativeApi, type AutomationIntegrationConnection, type AutomationIntegrationConfig, type AutomationIntegrationList, type AutomationIntegrationReceipt, type AutomationIntegrationOperation, type AutomationMcpDefinitionList, type automationIntegrationSaveSchema } from '../../contracts/src/automation-integrations.ts';
import { createAutomationPrivateStore, automationMcpAdapter, validateAutomationPrivateHeaders, type AutomationMcpAdapter, type AutomationPrivateStore } from '../../infrastructure/src/automation-integrations.ts';
import { validateAutomationNativeApi, probeAutomationNativeApi, type AutomationNativeProviderAdapter } from '../../infrastructure/src/automation-integrations-native.ts';
import { authorizeAutomationIntegration, mutateAutomationIntegration, readAutomationIntegration, readAutomationIntegrationReceipt, type AutomationIntegrationContext } from './automation-integrations-store.ts';
import type { SqlExecutor } from './ports.ts';
import { requireCapability } from './access.ts';
import { assertAutomationMcpDefinitionBindable, resolveAutomationMcpDefinition, type AutomationDefinitionResolver, type ResolvedAutomationMcpDefinition } from './automation-integrations-definitions.ts';

type ConnectionRow = { id: string; workspace_id: string; actor_id: string; project_id: string; revision: number; config: AutomationIntegrationConfig; native_private_config: string; mcp_config_fingerprint: string | null; has_credentials: boolean; status: AutomationIntegrationConnection['status']; verification: AutomationIntegrationConnection['verification']; last_checked_at: Date | null; last_error: string | null; created_at: Date; updated_at: Date };
export type AutomationIntegrationsOptions = AutomationIntegrationContext & { privateStore?: AutomationPrivateStore; adapter?: AutomationMcpAdapter; nativeAdapter?: AutomationNativeProviderAdapter; definitionResolver?: AutomationDefinitionResolver };
export interface AutomationIntegrationsService {
  list(actor: Actor, workspaceId: string, projectId?: string): Promise<AutomationIntegrationList>;
  definitions(actor: Actor, workspaceId: string, projectId: string): Promise<AutomationMcpDefinitionList>;
  save(actor: Actor, workspaceId: string, id: string, input: z.infer<typeof automationIntegrationSaveSchema>): Promise<AutomationIntegrationConnection>;
  verify(actor: Actor, workspaceId: string, id: string, input: { requestId: string; expectedRevision: number }): Promise<AutomationIntegrationConnection>;
  revoke(actor: Actor, workspaceId: string, id: string, input: { requestId: string; expectedRevision: number }): Promise<AutomationIntegrationConnection>;
  receipt(actor: Actor, workspaceId: string, requestId: string): Promise<AutomationIntegrationReceipt>;
  operation(actor: Actor, workspaceId: string, id: string): Promise<AutomationIntegrationOperation>;
}
function connectionDto(row: ConnectionRow): AutomationIntegrationConnection { return { ...row.config, id: row.id, revision: row.revision, status: row.status, verification: row.verification, hasCredentials: row.has_credentials, mcpConfigFingerprint: row.mcp_config_fingerprint, lastCheckedAt: row.last_checked_at?.toISOString() ?? null, lastError: row.last_error, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }; }
export async function readScopedAutomationConnection(sql: SqlExecutor, options: AutomationIntegrationContext, actor: Actor, workspaceId: string, id: string, write = false): Promise<ConnectionRow> {
  const row = (await sql.query<ConnectionRow>('SELECT * FROM automation_integration_connections WHERE id=$1 AND workspace_id=$2 AND actor_id=$3', [id, workspaceId, actor.id])).rows[0];
  if (!row) throw new DomainError('not_found_or_forbidden', 'Integration connection is not accessible', 404);
  await authorizeAutomationIntegration(sql, options, actor, workspaceId, row.project_id, write, write);
  return row;
}
export function createAutomationIntegrationsService(options: AutomationIntegrationsOptions): AutomationIntegrationsService {
  const store = options.privateStore ?? createAutomationPrivateStore(); const adapter = options.adapter ?? automationMcpAdapter;
  return {
    async list(actor: Actor, workspaceId: string, projectId?: string): Promise<AutomationIntegrationList> {
      return readAutomationIntegration(options, actor, workspaceId, async sql => {
        if (projectId) await authorizeAutomationIntegration(sql, options, actor, workspaceId, projectId);
        const rows = await sql.query<ConnectionRow>('SELECT * FROM automation_integration_connections WHERE workspace_id=$1 AND actor_id=$2 AND ($3::text IS NULL OR project_id=$3) ORDER BY created_at,id', [workspaceId, actor.id, projectId ?? null]);
        const connections: AutomationIntegrationConnection[] = [];
        const definitions = new Map<string, AutomationMcpDefinitionList | null>();
        for (const row of rows.rows) {
          try {
            await authorizeAutomationIntegration(sql, options, actor, workspaceId, row.project_id);
            if (automationIntegrationSupportsMcp(row.config) && row.status !== 'revoked') {
              if (!definitions.has(row.project_id)) {
                try { definitions.set(row.project_id, await options.definitionResolver!.list({ actorId: actor.id, workspaceId, projectId: row.project_id })); }
                catch { definitions.set(row.project_id, null); }
              }
              const current = definitions.get(row.project_id)?.definitions.find(item => item.contextId === row.config.mcpDefinition!.contextId && item.serverId === row.config.mcpDefinition!.serverId);
              if (!current || current.configFingerprint !== row.mcp_config_fingerprint) {
                connections.push(connectionDto({ ...row, status: 'configured', verification: { ...row.verification, mcp: false }, last_error: current ? 'integration_definition_changed' : 'integration_definition_missing_or_unavailable' }));
                continue;
              }
            }
            connections.push(connectionDto(row));
          } catch (error) { if (!(error instanceof DomainError) || ![403, 404].includes(error.status)) throw error; }
        }
        return { providers: automationIntegrationProviders, connections, privateStorageAvailable: store.available };
      });
    },
    definitions: (actor, workspaceId, projectId) => readAutomationIntegration(options, actor, workspaceId, async sql => {
      await authorizeAutomationIntegration(sql, options, actor, workspaceId, projectId);
      if (!options.definitionResolver) throw new DomainError('integration_definition_service_unavailable', 'Managed MCP definition service is not configured', 503);
      return options.definitionResolver.list({ actorId: actor.id, workspaceId, projectId });
    }),
    async save(actor: Actor, workspaceId: string, id: string, input: z.infer<typeof automationIntegrationSaveSchema>): Promise<AutomationIntegrationConnection> {
      return mutateAutomationIntegration(options, actor, workspaceId, { ...input, id, kind: 'connection-save' }, [input.config.projectId], async sql => {
        await authorizeAutomationIntegration(sql, options, actor, workspaceId, input.config.projectId, true);
        if (input.config.writeTools.length || input.config.nativeApi?.allowWrites || input.config.nativeApi?.allowOwnerLoadSearch) await requireCapability(sql, actor, workspaceId, 'access.manage', input.config.projectId);
        const existing = (await sql.query<ConnectionRow>('SELECT * FROM automation_integration_connections WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 FOR UPDATE', [id, workspaceId, actor.id])).rows[0];
        if ((existing?.revision ?? 0) !== input.expectedRevision) throw new DomainError('version_conflict', 'Integration connection changed; reload before saving', 409);
        if (existing) { await authorizeAutomationIntegration(sql, options, actor, workspaceId, existing.project_id, true); if (existing.project_id !== input.config.projectId) throw new DomainError('scope_mismatch', 'A connection cannot be moved between projects'); }
        const config = input.config;
        const identity = `${workspaceId}:${actor.id}:${id}:connection`;
        validateAutomationNativeApi(config);
        if (config.mcpDefinition) {
          const scope = { actorId: actor.id, workspaceId, projectId: config.projectId };
          await assertAutomationMcpDefinitionBindable(sql, scope, config.mcpDefinition);
          await resolveAutomationMcpDefinition(options.definitionResolver, scope, config.mcpDefinition);
        }
        if (!config.nativeApi && Object.keys(input.nativePrivateHeaders ?? {}).length) throw new DomainError('validation_failed', 'MCP credentials must be edited in the unified definition manager, not in a project binding');
        const headers = config.nativeApi ? input.nativePrivateHeaders === undefined && existing?.native_private_config ? store.open<Record<string, string>>(existing.native_private_config, identity) : validateAutomationPrivateHeaders(input.nativePrivateHeaders ?? {}) : {};
        const sealed = config.nativeApi ? store.seal(headers, identity) : '';
        const row = (await sql.query<ConnectionRow>(`INSERT INTO automation_integration_connections(id,workspace_id,actor_id,project_id,config,native_private_config,has_credentials) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
          ON CONFLICT(id) DO UPDATE SET config=excluded.config,native_private_config=excluded.native_private_config,has_credentials=excluded.has_credentials,mcp_config_fingerprint=NULL,status='configured',verification='{"mcp":false,"nativeApi":false}'::jsonb,last_checked_at=NULL,last_error=NULL,revision=automation_integration_connections.revision+1,updated_at=clock_timestamp()
          WHERE automation_integration_connections.workspace_id=$2 AND automation_integration_connections.actor_id=$3 AND automation_integration_connections.revision=$8 RETURNING *`, [id, workspaceId, actor.id, config.projectId, JSON.stringify(config), sealed, Object.keys(headers).length > 0, input.expectedRevision])).rows[0];
        if (!row) throw new DomainError('version_conflict', 'Integration connection identity is not available', 409);
        return connectionDto(row);
      });
    },
    async verify(actor: Actor, workspaceId: string, id: string, input: { requestId: string; expectedRevision: number }): Promise<AutomationIntegrationConnection> {
      const prepared = await readAutomationIntegration(options, actor, workspaceId, async sql => {
        const prior = await readAutomationIntegrationReceipt(sql, options, actor, workspaceId, input.requestId);
        if (prior) return { prior };
        const row = await readScopedAutomationConnection(sql, options, actor, workspaceId, id, true);
        if (row.revision !== input.expectedRevision || row.status === 'revoked') throw new DomainError('version_conflict', 'Connection changed or was revoked; reload before verifying', 409);
        if (row.config.mcpDefinition) await assertAutomationMcpDefinitionBindable(sql, { actorId: actor.id, workspaceId, projectId: row.project_id }, row.config.mcpDefinition);
        return { row, nativeHeaders: row.native_private_config ? store.open<Record<string, string>>(row.native_private_config, `${workspaceId}:${actor.id}:${id}:connection`) : {} };
      });
      let errorCode: string | null = null;
      const verification = { mcp: false, nativeApi: false };
      let definition: ResolvedAutomationMcpDefinition | undefined;
      if ('row' in prepared && prepared.row) {
        if (!automationIntegrationSupportsMcp(prepared.row.config) && !automationIntegrationSupportsNativeApi(prepared.row.config)) errorCode = 'integration_mechanism_unavailable';
        if (automationIntegrationSupportsMcp(prepared.row.config)) {
          try {
            definition = await resolveAutomationMcpDefinition(options.definitionResolver, { actorId: actor.id, workspaceId, projectId: prepared.row.project_id }, prepared.row.config.mcpDefinition!);
            const tools = await adapter.list(definition); const names = new Set(tools.map(tool => tool.name));
            if ([...prepared.row.config.readTools, ...prepared.row.config.writeTools].some(name => !names.has(name))) throw new DomainError('integration_tool_unavailable', 'One or more configured tool names are not advertised by this endpoint', 409);
            if (tools.some(tool => prepared.row!.config.readTools.includes(tool.name) && tool.annotations?.readOnlyHint === false)) throw new DomainError('integration_tool_policy_mismatch', 'A configured read tool explicitly advertises write behavior; move it to the write allowlist', 409);
            verification.mcp = true;
          } catch (error) { errorCode = error instanceof DomainError ? error.code : 'integration_transport_failed'; }
        }
        if (automationIntegrationSupportsNativeApi(prepared.row.config)) {
          try { await probeAutomationNativeApi(prepared.row.config, prepared.nativeHeaders!, options.nativeAdapter); verification.nativeApi = true; }
          catch (error) { errorCode ??= error instanceof DomainError ? error.code : 'integration_transport_failed'; }
        }
      }
      const projectIds = 'row' in prepared && prepared.row ? [prepared.row.project_id] : [];
      return mutateAutomationIntegration(options, actor, workspaceId, { ...input, id, kind: 'connection-verify' }, projectIds, async sql => {
        const row = await readScopedAutomationConnection(sql, options, actor, workspaceId, id, true);
        if (row.revision !== input.expectedRevision || row.status === 'revoked') throw new DomainError('version_conflict', 'Connection changed during verification', 409);
        if (row.config.mcpDefinition) await assertAutomationMcpDefinitionBindable(sql, { actorId: actor.id, workspaceId, projectId: row.project_id }, row.config.mcpDefinition);
        if (verification.mcp && definition) await resolveAutomationMcpDefinition(options.definitionResolver, { actorId: actor.id, workspaceId, projectId: row.project_id }, row.config.mcpDefinition!, definition.configFingerprint);
        const updated = (await sql.query<ConnectionRow>('UPDATE automation_integration_connections SET status=$2,last_error=$3,verification=$4::jsonb,mcp_config_fingerprint=$5,last_checked_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [id, errorCode ? 'error' : 'verified', errorCode, JSON.stringify(verification), verification.mcp ? definition!.configFingerprint : null])).rows[0]!;
        return connectionDto(updated);
      });
    },
    async revoke(actor: Actor, workspaceId: string, id: string, input: { requestId: string; expectedRevision: number }): Promise<AutomationIntegrationConnection> {
      const projects: string[] = [];
      return mutateAutomationIntegration(options, actor, workspaceId, { ...input, id, kind: 'connection-revoke' }, projects, async sql => {
        const row = await readScopedAutomationConnection(sql, options, actor, workspaceId, id); projects.push(row.project_id);
        await authorizeAutomationIntegration(sql, options, actor, workspaceId, row.project_id, true, false);
        if (row.revision !== input.expectedRevision) throw new DomainError('version_conflict', 'Connection changed; reload before revoking', 409);
        const updated = (await sql.query<ConnectionRow>(`UPDATE automation_integration_connections SET status='revoked',native_private_config='',has_credentials=false,mcp_config_fingerprint=NULL,verification='{"mcp":false,"nativeApi":false}'::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [id])).rows[0]!;
        return connectionDto(updated);
      });
    },
    receipt: (actor: Actor, workspaceId: string, requestId: string) => readAutomationIntegration(options, actor, workspaceId, async sql => { const receipt = await readAutomationIntegrationReceipt(sql, options, actor, workspaceId, requestId); if (!receipt) throw new DomainError('not_found_or_forbidden', 'Integration receipt is not accessible', 404); return receipt; }),
    operation: (actor: Actor, workspaceId: string, id: string) => readAutomationIntegration(options, actor, workspaceId, async sql => {
      const row = (await sql.query<{ id: string; execution_id: string; connection_id: string; connection_revision: number; project_id: string; status: AutomationIntegrationOperation['status']; result: unknown; created_at: Date; finished_at: Date | null }>('SELECT * FROM automation_integration_operations WHERE id=$1 AND workspace_id=$2 AND actor_id=$3', [id, workspaceId, actor.id])).rows[0];
      if (!row) throw new DomainError('not_found_or_forbidden', 'Integration operation is not accessible', 404);
      await authorizeAutomationIntegration(sql, options, actor, workspaceId, row.project_id);
      return { id: row.id, executionId: row.execution_id, connectionId: row.connection_id, connectionRevision: row.connection_revision, status: row.status, result: row.result, createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null };
    }),
  };
}
