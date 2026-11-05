import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { AutomationDefinitionResolver, AutomationDefinitionScope, ResolvedAutomationMcpDefinition } from '../../application/src/automation-integrations-definitions.ts';
import { automationMcpDefinitionRefSchema } from '../../contracts/src/automation-integrations.ts';
import { automationServiceHeaders } from './automation-execution-client.ts';

const definition = automationMcpDefinitionRefSchema.extend({ configFingerprint: z.string().regex(/^[a-f0-9]{64}$/), transport: z.literal('streamable-http') });
const resolved = definition.extend({ endpoint: z.string(), headers: z.record(z.string(), z.string()).optional() });
export type AutomationDefinitionMigrationTarget = AutomationDefinitionResolver & {
  beginMaintenance(migrationId: string): Promise<{ migrationId: string }>;
  endMaintenance(migrationId: string): Promise<{ migrationId: string }>;
  ensureProjectContext(scope: AutomationDefinitionScope, migrationId?: string): Promise<{ contextId: string }>;
  importDefinition(input: { scope: AutomationDefinitionScope; serverId: string; name: string; endpoint: string; headers?: Record<string, string>; migrationId?: string }): Promise<ResolvedAutomationMcpDefinition>;
};
/** Dedicated authenticated PM→Agent service channel, never a browser secret-reading endpoint. No retry. */
export function createAutomationDefinitionClient(options: { baseUrl?: string; secret?: string; fetch?: typeof fetch } = {}): AutomationDefinitionMigrationTarget {
  async function call(command: string, input: unknown): Promise<unknown> {
    const origin = options.baseUrl ?? process.env.PM_AUTOMATION_AGENT_URL;
    if (!origin) throw new DomainError('integration_definition_service_unavailable', 'Configure PM_AUTOMATION_AGENT_URL for the private Agent service transport', 503);
    const base = new URL(origin);
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || !['https:', 'http:'].includes(base.protocol) || base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new DomainError('integration_definition_service_unavailable', 'Configure a clean HTTPS or loopback Agent service origin', 503);
    const url = new URL(`/internal/extensions/definitions/${command}`, base); const body = JSON.stringify(input);
    let response: Response;
    try { response = await (options.fetch ?? fetch)(url, { method: 'POST', headers: automationServiceHeaders('POST', url.pathname, body, options.secret), body, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new DomainError('integration_definition_service_unavailable', 'Managed MCP definition result is not confirmed; no operation was retried', 503); }
    const reader = response.body?.getReader(); if (!reader) throw new DomainError('integration_definition_service_unavailable', 'Managed definition response is missing', 503);
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new DomainError('integration_definition_service_unavailable', 'Managed definition response exceeds its limit', 503); } chunks.push(part.value); }
    if (!response.ok) throw new DomainError(response.status === 404 ? 'integration_definition_missing' : response.status === 409 ? 'integration_definition_conflict' : 'integration_definition_service_unavailable', 'Managed definition is unavailable or not authorized in this exact project scope', response.status === 404 ? 409 : response.status >= 500 ? 503 : 409);
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown; } catch { throw new DomainError('integration_definition_service_unavailable', 'Managed definition response is invalid', 503); }
  }
  return {
    resolve: async input => { const result = resolved.parse(await call('resolve', input)); return { ...result, headers: result.headers ?? {} }; },
    list: async scope => z.strictObject({ contextId: z.string(), definitions: z.array(definition.extend({ name: z.string() })) }).parse(await call('list', { scope })),
    beginMaintenance: async migrationId => z.strictObject({ migrationId: z.literal(migrationId) }).parse(await call('begin-maintenance', { migrationId })),
    endMaintenance: async migrationId => z.strictObject({ migrationId: z.literal(migrationId) }).parse(await call('end-maintenance', { migrationId })),
    ensureProjectContext: async (scope, migrationId) => z.strictObject({ contextId: z.string() }).parse(await call('ensure-context', { scope, ...(migrationId ? { migrationId } : {}) })),
    importDefinition: async input => { const result = resolved.parse(await call('import', input)); return { ...result, headers: result.headers ?? {} }; },
  };
}
