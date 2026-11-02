import type { z } from 'zod';
import type { Actor } from '../../domain/src/core.ts';
import { DomainError } from '../../domain/src/core.ts';
import { automationIntegrationProviders, automationIntegrationSupportsMcp, automationIntegrationSupportsNativeApi, type AutomationIntegrationConnection, type AutomationIntegrationConfig, type AutomationIntegrationList, type AutomationIntegrationReceipt, type AutomationIntegrationOperation, type automationIntegrationSaveSchema } from '../../contracts/src/automation-integrations.ts';
import { createAutomationPrivateStore, automationMcpAdapter, validateAutomationMcpEndpoint, validateAutomationPrivateHeaders, type AutomationMcpAdapter, type AutomationPrivateStore } from '../../infrastructure/src/automation-integrations.ts';
import { validateAutomationNativeApi, probeAutomationNativeApi, type AutomationNativeProviderAdapter } from '../../infrastructure/src/automation-integrations-native.ts';
import { authorizeAutomationIntegration, mutateAutomationIntegration, readAutomationIntegration, readAutomationIntegrationReceipt, type AutomationIntegrationContext } from './automation-integrations-store.ts';
import type { SqlExecutor } from './ports.ts';
import { requireCapability } from './access.ts';

type ConnectionRow = { id: string; workspace_id: string; actor_id: string; project_id: string; revision: number; config: AutomationIntegrationConfig; private_config: string; has_credentials: boolean; status: AutomationIntegrationConnection['status']; verification: AutomationIntegrationConnection['verification']; last_checked_at: Date | null; last_error: string | null; created_at: Date; updated_at: Date };
export type AutomationIntegrationsOptions = AutomationIntegrationContext & { privateStore?: AutomationPrivateStore; adapter?: AutomationMcpAdapter; nativeAdapter?: AutomationNativeProviderAdapter };
export interface AutomationIntegrationsService {
  list(actor: Actor, workspaceId: string, projectId?: string): Promise<AutomationIntegrationList>;
  save(actor: Actor, workspaceId: string, id: string, input: z.infer<typeof automationIntegrationSaveSchema>): Promise<AutomationIntegrationConnection>;
  verify(actor: Actor, workspaceId: string, id: string, input: { requestId: string; expectedRevision: number }): Promise<AutomationIntegrationConnection>;
  revoke(actor: Actor, workspaceId: string, id: string, input: { requestId: string; expectedRevision: number }): Promise<AutomationIntegrationConnection>;
  receipt(actor: Actor, workspaceId: string, requestId: string): Promise<AutomationIntegrationReceipt>;
  operation(actor: Actor, workspaceId: string, id: string): Promise<AutomationIntegrationOperation>;
}
function connectionDto(row: ConnectionRow): AutomationIntegrationConnection { return { ...row.config, id: row.id, revision: row.revision, status: row.status, verification: row.verification, hasCredentials: row.has_credentials, lastCheckedAt: row.last_checked_at?.toISOString() ?? null, lastError: row.last_error, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }; }
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
        for (const row of rows.rows) { try { await authorizeAutomationIntegration(sql, options, actor, workspaceId, row.project_id); connections.push(connectionDto(row)); } catch (error) { if (!(error instanceof DomainError) || ![403, 404].includes(error.status)) throw error; } }
        return { providers: automationIntegrationProviders, connections, privateStorageAvailable: store.available };
      });
    },
    async save(actor: Actor, workspaceId: string, id: string, input: z.infer<typeof automationIntegrationSaveSchema>): Promise<AutomationIntegrationConnection> {
      return mutateAutomationIntegration(options, actor, workspaceId, { ...input, id, kind: 'connection-save' }, [input.config.projectId], async sql => {
        await authorizeAutomationIntegration(sql, options, actor, workspaceId, input.config.projectId, true);
        if (input.config.writeTools.length || input.config.nativeApi?.allowWrites || input.config.nativeApi?.allowOwnerLoadSearch) await requireCapability(sql, actor, workspaceId, 'access.manage', input.config.projectId);
        const existing = (await sql.query<ConnectionRow>('SELECT * FROM automation_integration_connections WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 FOR UPDATE', [id, workspaceId, actor.id])).rows[0];
        if ((existing?.revision ?? 0) !== input.expectedRevision) throw new DomainError('version_conflict', 'Integration connection changed; reload before saving', 409);
        if (existing) { await authorizeAutomationIntegration(sql, options, actor, workspaceId, existing.project_id, true); if (existing.project_id !== input.config.projectId) throw new DomainError('scope_mismatch', 'A connection cannot be moved between projects'); }
        const config = { ...input.config, endpoint: validateAutomationMcpEndpoint(input.config.endpoint) };
        const identity = `${workspaceId}:${actor.id}:${id}:connection`;
        validateAutomationNativeApi(config);
        const headers = input.privateHeaders === undefined && existing?.private_config ? store.open<Record<string, string>>(existing.private_config, identity) : validateAutomationPrivateHeaders(input.privateHeaders ?? {});
        const sealed = store.seal(headers, identity);
        const row = (await sql.query<ConnectionRow>(`INSERT INTO automation_integration_connections(id,workspace_id,actor_id,project_id,config,private_config,has_credentials) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
          ON CONFLICT(id) DO UPDATE SET config=excluded.config,private_config=excluded.private_config,has_credentials=excluded.has_credentials,status='configured',verification='{"mcp":false,"nativeApi":false}'::jsonb,last_checked_at=NULL,last_error=NULL,revision=automation_integration_connections.revision+1,updated_at=clock_timestamp()
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
        return { row, target: { endpoint: row.config.endpoint, headers: store.open<Record<string, string>>(row.private_config, `${workspaceId}:${actor.id}:${id}:connection`) } };
      });
      let errorCode: string | null = null;
      const verification = { mcp: false, nativeApi: false };
      if ('row' in prepared && prepared.row) {
        if (!automationIntegrationSupportsMcp(prepared.row.config) && !automationIntegrationSupportsNativeApi(prepared.row.config)) errorCode = 'integration_mechanism_unavailable';
        if (automationIntegrationSupportsMcp(prepared.row.config)) {
          try {
            const tools = await adapter.list(prepared.target!); const names = new Set(tools.map(tool => tool.name));
            if ([...prepared.row.config.readTools, ...prepared.row.config.writeTools].some(name => !names.has(name))) throw new DomainError('integration_tool_unavailable', 'One or more configured tool names are not advertised by this endpoint', 409);
            if (tools.some(tool => prepared.row!.config.readTools.includes(tool.name) && tool.annotations?.readOnlyHint === false)) throw new DomainError('integration_tool_policy_mismatch', 'A configured read tool explicitly advertises write behavior; move it to the write allowlist', 409);
            verification.mcp = true;
          } catch (error) { errorCode = error instanceof DomainError ? error.code : 'integration_transport_failed'; }
        }
        if (automationIntegrationSupportsNativeApi(prepared.row.config)) {
          try { await probeAutomationNativeApi(prepared.row.config, prepared.target!.headers, options.nativeAdapter); verification.nativeApi = true; }
          catch (error) { errorCode ??= error instanceof DomainError ? error.code : 'integration_transport_failed'; }
        }
      }
      const projectIds = 'row' in prepared && prepared.row ? [prepared.row.project_id] : [];
      return mutateAutomationIntegration(options, actor, workspaceId, { ...input, id, kind: 'connection-verify' }, projectIds, async sql => {
        const row = await readScopedAutomationConnection(sql, options, actor, workspaceId, id, true);
        if (row.revision !== input.expectedRevision || row.status === 'revoked') throw new DomainError('version_conflict', 'Connection changed during verification', 409);
        const updated = (await sql.query<ConnectionRow>('UPDATE automation_integration_connections SET status=$2,last_error=$3,verification=$4::jsonb,last_checked_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [id, errorCode ? 'error' : 'verified', errorCode, JSON.stringify(verification)])).rows[0]!;
        return connectionDto(updated);
      });
    },
    async revoke(actor: Actor, workspaceId: string, id: string, input: { requestId: string; expectedRevision: number }): Promise<AutomationIntegrationConnection> {
      const projects: string[] = [];
      return mutateAutomationIntegration(options, actor, workspaceId, { ...input, id, kind: 'connection-revoke' }, projects, async sql => {
        const row = await readScopedAutomationConnection(sql, options, actor, workspaceId, id); projects.push(row.project_id);
        await authorizeAutomationIntegration(sql, options, actor, workspaceId, row.project_id, true, false);
        if (row.revision !== input.expectedRevision) throw new DomainError('version_conflict', 'Connection changed; reload before revoking', 409);
        const updated = (await sql.query<ConnectionRow>(`UPDATE automation_integration_connections SET status='revoked',private_config='',has_credentials=false,verification='{"mcp":false,"nativeApi":false}'::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [id])).rows[0]!;
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
