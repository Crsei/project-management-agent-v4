import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import { automationIntegrationConfigSchema, type AutomationIntegrationConfig, type AutomationIntegrationVerification } from '../../contracts/src/automation-integrations.ts';
import { assertAutomationMcpDefinitionBindable, type AutomationDefinitionScope } from '../../application/src/automation-integrations-definitions.ts';
import type { AutomationDefinitionMigrationTarget } from './automation-integrations-definitions.ts';
import { AUTOMATION_INTEGRATION_MAINTENANCE_LOCK, validateAutomationMcpEndpoint, validateAutomationPrivateHeaders, type AutomationPrivateStore } from './automation-integrations.ts';

export type AutomationMcpMigrationSource = { connection_id: string; workspace_id: string; actor_id: string; project_id: string; source_revision: number; source_config: Omit<AutomationIntegrationConfig, 'mcpDefinition'> & { endpoint: string }; sealed_headers: string; source_status: string; source_verification: AutomationIntegrationVerification; source_last_error: string | null };
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.strictObject({ actorId: z.uuid(), workspaceId: z.uuid(), projectId: z.string().regex(/^PRJ-\d+$/) });
export const automationMcpMigrationPlanSchema = z.strictObject({
  format: z.literal('pm-managed-mcp-migration'), version: z.literal(1),
  sqlDumpSha256: digestSchema, agentManifestSha256: digestSchema,
  entries: z.array(z.strictObject({ connectionId: z.uuid(), scope: scopeSchema, sourceRevision: z.number().int().positive(), sourceDigest: digestSchema, contextId: z.string(), serverId: z.string(), targetPath: z.string(), provider: z.string(), readTools: z.array(z.string()), writeTools: z.array(z.string()), credentialReference: z.string(), nativeApiDualChannel: z.boolean(), sameNameConflict: z.boolean() })),
});
export type AutomationMcpMigrationPlan = z.infer<typeof automationMcpMigrationPlanSchema>;
type Mapping = { connection_id: string; source_digest: string; context_id: string; server_id: string; phase: 'prepared' | 'imported' | 'cutover'; config_fingerprint: string | null; target_revision: number | null };
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const scopeFor = (row: AutomationMcpMigrationSource): AutomationDefinitionScope => ({ actorId: row.actor_id, workspaceId: row.workspace_id, projectId: row.project_id });
export function automationMcpProjectContextId(scope: AutomationDefinitionScope): string { return 'pm-' + createHash('sha256').update(`${scope.actorId}\0${scope.workspaceId}\0${scope.projectId}`).digest('hex').slice(0, 32); }
export function automationMcpDefinitionFingerprint(endpoint: string, headers: Record<string, string>): string { return digest({ transport: 'streamable-http', endpoint, headers }); }
export function automationMcpMigrationSourceDigest(row: AutomationMcpMigrationSource): string { return digest({ id: row.connection_id, scope: scopeFor(row), revision: row.source_revision, config: row.source_config, sealedHeaders: row.sealed_headers, status: row.source_status, verification: row.source_verification, lastError: row.source_last_error }); }
export function automationMcpMigrationPlanDigest(plan: AutomationMcpMigrationPlan): string { return digest(automationMcpMigrationPlanSchema.parse(plan)); }
/** Pure metadata projection: no decrypt, Agent contact, definition import, connectivity check or native export. */
export function planAutomationMcpMigration(rows: AutomationMcpMigrationSource[], snapshots: { sqlDumpSha256: string; agentManifestSha256: string }): AutomationMcpMigrationPlan {
  const names = new Map<string, number>();
  for (const row of rows) { const key = `${automationMcpProjectContextId(scopeFor(row))}\0${row.source_config.label}`; names.set(key, (names.get(key) ?? 0) + 1); }
  return automationMcpMigrationPlanSchema.parse({ format: 'pm-managed-mcp-migration', version: 1, ...snapshots, entries: [...rows].sort((a, b) => a.connection_id.localeCompare(b.connection_id)).map(row => {
    const scope = scopeFor(row); const contextId = automationMcpProjectContextId(scope);
    return { connectionId: row.connection_id, scope, sourceRevision: row.source_revision, sourceDigest: automationMcpMigrationSourceDigest(row), contextId, serverId: `pm-${row.connection_id}`, targetPath: `cc-switch/${contextId}`, provider: row.source_config.provider, readTools: row.source_config.readTools, writeTools: row.source_config.writeTools, credentialReference: `${row.workspace_id}:${row.actor_id}:${row.connection_id}:connection`, nativeApiDualChannel: row.source_config.nativeApi !== undefined, sameNameConflict: (names.get(`${contextId}\0${row.source_config.label}`) ?? 0) > 1 };
  }) });
}
export async function readAutomationMcpMigrationSources(sql: PoolClient): Promise<AutomationMcpMigrationSource[]> { return (await sql.query<AutomationMcpMigrationSource>('SELECT * FROM automation_integration_migration_sources ORDER BY connection_id')).rows; }
export async function withAutomationMcpMigrationLock<T>(pool: Pool, stopped: boolean, operation: (sql: PoolClient) => Promise<T>): Promise<T> {
  if (!stopped) throw new DomainError('integration_migration_requires_maintenance', '--stopped must attest scheduler, Worker and other writers are stopped; this command never controls services');
  const sql = await pool.connect(); let locked = false;
  try {
    locked = (await sql.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1,hashtext(current_schema() || ':' || $2::text)) AS locked", [...AUTOMATION_INTEGRATION_MAINTENANCE_LOCK])).rows[0]?.locked === true;
    if (!locked) throw new DomainError('integration_migration_busy', 'Integration configuration or execution is active; maintenance lock was not acquired', 409);
    const active = await sql.query("SELECT 1 FROM automation_studio_executions WHERE finished_at IS NULL UNION ALL SELECT 1 FROM automation_integration_grants WHERE revoked_at IS NULL AND expires_at>clock_timestamp() LIMIT 1");
    if (active.rowCount) throw new DomainError('integration_migration_active_execution', 'Finish or reconcile active automation executions and generation grants before migration', 409);
    return await operation(sql);
  } finally { try { if (locked) await sql.query("SELECT pg_advisory_unlock($1,hashtext(current_schema() || ':' || $2::text))", [...AUTOMATION_INTEGRATION_MAINTENANCE_LOCK]); } finally { sql.release(); } }
}
function assertMapping(mapping: Mapping, entry: AutomationMcpMigrationPlan['entries'][number]): void {
  if (mapping.source_digest !== entry.sourceDigest || mapping.context_id !== entry.contextId || mapping.server_id !== entry.serverId) throw new DomainError('integration_migration_conflict', 'Stable migration mapping differs; reconcile the original snapshot, never overwrite it', 409);
}
async function targetDefinition(target: AutomationDefinitionMigrationTarget, entry: AutomationMcpMigrationPlan['entries'][number]) {
  try { return await target.resolve({ scope: entry.scope, contextId: entry.contextId, serverId: entry.serverId }); }
  catch (error) { if (error instanceof DomainError && error.code === 'integration_definition_missing') return null; throw error; }
}
/** Caller owns the exclusive maintenance lock. Each cross-store step is durable and reconciled before the next write. */
export async function applyAutomationMcpMigration(sql: PoolClient, input: { plan: AutomationMcpMigrationPlan; expectedPlanDigest: string; target: AutomationDefinitionMigrationTarget; privateStore: AutomationPrivateStore; reconcileOnly?: boolean }): Promise<{ imported: number; cutover: number }> {
  const plan = automationMcpMigrationPlanSchema.parse(input.plan);
  if (automationMcpMigrationPlanDigest(plan) !== input.expectedPlanDigest) throw new DomainError('integration_migration_plan_changed', 'Explicit reviewed migration plan digest differs', 409);
  const sources = new Map((await readAutomationMcpMigrationSources(sql)).map(row => [row.connection_id, row]));
  const plannedIds = new Set(plan.entries.map(entry => entry.connectionId));
  if (plannedIds.size !== plan.entries.length || [...sources.keys()].some(id => !plannedIds.has(id))) throw new DomainError('integration_migration_plan_changed', 'Source inventory differs from the reviewed migration plan', 409);
  let imported = 0; let cutover = 0;
  for (const entry of plan.entries) {
    const source = sources.get(entry.connectionId);
    const existing = (await sql.query<Mapping>('SELECT * FROM automation_integration_definition_migrations WHERE connection_id=$1', [entry.connectionId])).rows[0];
    if (existing) assertMapping(existing, entry);
    await assertAutomationMcpDefinitionBindable(sql, entry.scope, { contextId: entry.contextId, serverId: entry.serverId });
    if (!source) {
      if (existing?.phase !== 'cutover' || !existing.config_fingerprint) throw new DomainError('integration_migration_source_changed', 'Unmigrated original scoped source is missing', 409);
      const definition = await targetDefinition(input.target, entry);
      const current = (await sql.query<{ revision: number; config: AutomationIntegrationConfig; verification: AutomationIntegrationVerification; mcp_config_fingerprint: string | null }>('SELECT revision,config,verification,mcp_config_fingerprint FROM automation_integration_connections WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND project_id=$4', [entry.connectionId, entry.scope.workspaceId, entry.scope.actorId, entry.scope.projectId])).rows[0];
      if (!definition || definition.configFingerprint !== existing.config_fingerprint || !current || current.config.mcpDefinition?.contextId !== entry.contextId || current.config.mcpDefinition.serverId !== entry.serverId || current.revision !== existing.target_revision || current.mcp_config_fingerprint !== (current.verification.mcp ? existing.config_fingerprint : null)) throw new DomainError('integration_migration_conflict', 'Finalized migration no longer matches its recorded definition and connection revision', 409);
      cutover++; continue;
    }
    if (automationMcpMigrationSourceDigest(source) !== entry.sourceDigest || source.source_revision !== entry.sourceRevision || stable(scopeFor(source)) !== stable(entry.scope) || entry.contextId !== automationMcpProjectContextId(entry.scope) || entry.serverId !== `pm-${entry.connectionId}`) throw new DomainError('integration_migration_source_changed', 'Original scoped source bytes or mapping changed', 409);
    if (input.reconcileOnly && !existing) continue;
    const { endpoint: _endpoint, ...policy } = source.source_config;
    if (existing?.phase !== 'cutover') {
      const current = (await sql.query<{ revision: number; config: AutomationIntegrationConfig; status: string; native_private_config: string }>('SELECT revision,config,status,native_private_config FROM automation_integration_connections WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND project_id=$4', [entry.connectionId, entry.scope.workspaceId, entry.scope.actorId, entry.scope.projectId])).rows[0];
      if (!current || current.revision !== source.source_revision || current.status === 'revoked' || stable(current.config) !== stable(policy) || (policy.nativeApi && current.native_private_config !== source.sealed_headers)) throw new DomainError('integration_migration_conflict', 'Project connection or native API secret changed since its captured snapshot; nothing was imported', 409);
    }
    const endpoint = validateAutomationMcpEndpoint(source.source_config.endpoint);
    const originalHeaders = input.privateStore.open<Record<string, string>>(source.sealed_headers, entry.credentialReference);
    const headers = validateAutomationPrivateHeaders(originalHeaders);
    const fingerprint = automationMcpDefinitionFingerprint(endpoint, headers);
    const sameBytes = endpoint === source.source_config.endpoint && stable(headers) === stable(originalHeaders);
    if (existing?.config_fingerprint && existing.config_fingerprint !== fingerprint) throw new DomainError('integration_migration_conflict', 'Original approved configuration fingerprint differs', 409);
    if (!existing) await sql.query("INSERT INTO automation_integration_definition_migrations(connection_id,source_digest,context_id,server_id,phase,config_fingerprint) VALUES($1,$2,$3,$4,'prepared',$5)", [entry.connectionId, entry.sourceDigest, entry.contextId, entry.serverId, fingerprint]);
    let definition = await targetDefinition(input.target, entry);
    if (!definition && !input.reconcileOnly) {
      const context = await input.target.ensureProjectContext(entry.scope, input.expectedPlanDigest);
      if (context.contextId !== entry.contextId) throw new DomainError('integration_migration_conflict', 'Host context identity differs from the stable project mapping', 409);
      definition = await input.target.importDefinition({ scope: entry.scope, serverId: entry.serverId, name: source.source_config.label, endpoint, headers, migrationId: input.expectedPlanDigest });
      imported++;
    }
    if (!definition) continue;
    if (definition.contextId !== entry.contextId || definition.serverId !== entry.serverId || definition.configFingerprint !== fingerprint || definition.endpoint !== endpoint || stable(validateAutomationPrivateHeaders(definition.headers)) !== stable(headers)) throw new DomainError('integration_migration_conflict', 'Existing managed definition is not byte-equivalent to the original scoped configuration; it was not overwritten', 409);
    if (existing?.phase === 'cutover') {
      const current = (await sql.query<{ revision: number; config: AutomationIntegrationConfig; mcp_config_fingerprint: string | null }>('SELECT revision,config,mcp_config_fingerprint FROM automation_integration_connections WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND project_id=$4', [entry.connectionId, entry.scope.workspaceId, entry.scope.actorId, entry.scope.projectId])).rows[0];
      if (!current || current.config.mcpDefinition?.contextId !== entry.contextId || current.config.mcpDefinition.serverId !== entry.serverId || current.revision !== existing.target_revision || current.mcp_config_fingerprint !== (source.source_verification.mcp && sameBytes ? fingerprint : null)) throw new DomainError('integration_migration_conflict', 'Cutover connection changed after its recorded migration; do not replay old approval', 409);
      cutover++; continue;
    }
    await sql.query("UPDATE automation_integration_definition_migrations SET phase='imported',config_fingerprint=$2,updated_at=clock_timestamp() WHERE connection_id=$1", [entry.connectionId, fingerprint]);
    if (input.reconcileOnly) continue;
    const config = automationIntegrationConfigSchema.parse({ ...policy, mcpDefinition: { contextId: entry.contextId, serverId: entry.serverId } });
    const verification = { ...source.source_verification, mcp: sameBytes && source.source_verification.mcp };
    await sql.query('BEGIN');
    try {
      const current = (await sql.query<{ revision: number; config: AutomationIntegrationConfig; status: string; native_private_config: string }>('SELECT revision,config,status,native_private_config FROM automation_integration_connections WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND project_id=$4 FOR UPDATE', [entry.connectionId, entry.scope.workspaceId, entry.scope.actorId, entry.scope.projectId])).rows[0];
      if (!current || current.revision !== source.source_revision || current.status === 'revoked' || stable(current.config) !== stable(policy) || (policy.nativeApi && current.native_private_config !== source.sealed_headers)) throw new DomainError('integration_migration_conflict', 'Project connection or native API secret changed since its captured snapshot', 409);
      const revision = source.source_revision + (sameBytes ? 0 : 1);
      await sql.query('UPDATE automation_integration_connections SET config=$2::jsonb,mcp_config_fingerprint=$3,verification=$4::jsonb,status=$5,last_error=$6,revision=$7,updated_at=clock_timestamp() WHERE id=$1', [entry.connectionId, JSON.stringify(config), verification.mcp ? fingerprint : null, JSON.stringify(verification), sameBytes ? source.source_status : 'configured', sameBytes ? source.source_last_error : 'integration_definition_reverification_required', revision]);
      await sql.query("UPDATE automation_integration_definition_migrations SET phase='cutover',target_revision=$2,updated_at=clock_timestamp() WHERE connection_id=$1", [entry.connectionId, revision]);
      await sql.query('COMMIT'); cutover++;
    } catch (error) { await sql.query('ROLLBACK'); throw error; }
  }
  return { imported, cutover };
}
/** Explicit finalization removes quarantined MCP endpoint/secret copies, never historical receipts or execution snapshots. */
export async function finalizeAutomationMcpMigration(sql: PoolClient, plan: AutomationMcpMigrationPlan, expectedPlanDigest: string): Promise<void> {
  if (automationMcpMigrationPlanDigest(plan) !== expectedPlanDigest) throw new DomainError('integration_migration_plan_changed', 'Reviewed plan digest differs', 409);
  const pending = await sql.query("SELECT 1 FROM automation_integration_migration_sources s LEFT JOIN automation_integration_definition_migrations m USING(connection_id) WHERE m.phase IS DISTINCT FROM 'cutover' LIMIT 1");
  if (pending.rowCount) throw new DomainError('integration_migration_incomplete', 'Every source must have reconciled cutover before deleting migration-only material', 409);
  await sql.query('DELETE FROM automation_integration_migration_sources WHERE connection_id=ANY($1::uuid[])', [plan.entries.map(entry => entry.connectionId)]);
}
