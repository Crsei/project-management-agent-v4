import type { AutomationMcpDefinitionList, AutomationMcpDefinitionRef } from '../../contracts/src/automation-integrations.ts';
import { DomainError } from '../../domain/src/core.ts';
import { validateAutomationMcpEndpoint, validateAutomationPrivateHeaders, type AutomationMcpTarget } from '../../infrastructure/src/automation-integrations.ts';
import type { SqlExecutor } from './ports.ts';

export type AutomationDefinitionScope = { actorId: string; workspaceId: string; projectId: string };
export type ResolvedAutomationMcpDefinition = AutomationMcpDefinitionRef & AutomationMcpTarget & { configFingerprint: string; transport: 'streamable-http' };
/** Private, authorized service port. The result must never be serialized to a browser or Provider. */
export interface AutomationDefinitionResolver {
  resolve(input: { scope: AutomationDefinitionScope } & AutomationMcpDefinitionRef): Promise<ResolvedAutomationMcpDefinition>;
  list(scope: AutomationDefinitionScope): Promise<AutomationMcpDefinitionList>;
}
/** The caller holds the workspace authorization lock, or the stronger offline maintenance exclusion. */
export async function assertAutomationMcpDefinitionBindable(sql: SqlExecutor, scope: AutomationDefinitionScope, ref: AutomationMcpDefinitionRef): Promise<void> {
  const deleting = await sql.query('SELECT 1 FROM automation_integration_definition_deletions WHERE workspace_id=$1 AND actor_id=$2 AND project_id=$3 AND context_id=$4 AND server_id=$5', [scope.workspaceId, scope.actorId, scope.projectId, ref.contextId, ref.serverId]);
  if (deleting.rowCount) throw new DomainError('integration_definition_deleting', 'This definition has a pending or completed deletion reservation; explicitly reconcile or recreate it in the unified manager before binding', 409);
}
export async function resolveAutomationMcpDefinition(resolver: AutomationDefinitionResolver | undefined, scope: AutomationDefinitionScope, ref: AutomationMcpDefinitionRef, approvedFingerprint?: string | null): Promise<ResolvedAutomationMcpDefinition> {
  if (!resolver) throw new DomainError('integration_definition_service_unavailable', 'Managed MCP definition service is not configured', 503);
  const definition = await resolver.resolve({ scope, ...ref });
  if (definition.contextId !== ref.contextId || definition.serverId !== ref.serverId || definition.transport !== 'streamable-http' || !definition.configFingerprint) throw new DomainError('integration_definition_invalid', 'The scoped definition does not identify a supported managed MCP server', 409);
  if (approvedFingerprint !== undefined && (!approvedFingerprint || definition.configFingerprint !== approvedFingerprint)) throw new DomainError('integration_definition_changed', 'Managed MCP configuration changed; explicitly verify and approve a new connection revision before execution', 409);
  return { ...definition, endpoint: validateAutomationMcpEndpoint(definition.endpoint), headers: validateAutomationPrivateHeaders(definition.headers ?? {}) };
}
