import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import type { NotificationCorePort } from '../../../../packages/pm-core/readonly.ts';
import { automationEventSaveSchema, automationIntegrationMutationSchema, automationIntegrationSaveSchema, automationIntegrationRuntimeSchema } from '../../../../packages/contracts/src/automation-integrations.ts';
import { createAutomationIntegrationsService, type AutomationIntegrationsOptions } from '../../../../packages/application/src/automation-integrations.ts';
import { createAutomationEventsService } from '../../../../packages/application/src/automation-events.ts';
import { createAutomationIntegrationRuntimeService } from '../../../../packages/application/src/automation-integrations-runtime.ts';
import { verifyAutomationServiceBearer, verifyAutomationServiceRequest } from '../../../../packages/infrastructure/src/automation-execution-client.ts';
import { createAutomationPrivateStore, assertAutomationIntegrationsAvailable } from '../../../../packages/infrastructure/src/automation-integrations.ts';
import { createAutomationDefinitionClient } from '../../../../packages/infrastructure/src/automation-integrations-definitions.ts';
import { authorizeAutomationIntegration } from '../../../../packages/application/src/automation-integrations-store.ts';
import { lockWorkspace } from '../../../../packages/infrastructure/src/database.ts';

const workspaceParams = z.strictObject({ workspaceId: z.uuid().toLowerCase() });
const resourceParams = workspaceParams.extend({ id: z.uuid().toLowerCase() });
const projectQuery = z.strictObject({ projectId: z.string().regex(/^PRJ-\d+$/).optional() });
export function registerAutomationEventsRoutes(app: FastifyInstance, options: { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; core: NotificationCorePort; publicOrigin?: string; definitionResolver?: AutomationIntegrationsOptions['definitionResolver'] }): void {
  const privateStore = createAutomationPrivateStore();
  const definitionResolver = options.definitionResolver ?? createAutomationDefinitionClient();
  const integrations = createAutomationIntegrationsService({ ...options, privateStore, definitionResolver });
  const events = createAutomationEventsService({ ...options, privateStore });
  const runtime = createAutomationIntegrationRuntimeService({ ...options, privateStore, definitionResolver });
  void app.register(async routes => {
    routes.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer'); });
    const base = '/api/v1/workspaces/:workspaceId/automations';
    routes.get(base + '/integrations', async request => { const { workspaceId } = workspaceParams.parse(request.params); const { projectId } = projectQuery.parse(request.query); return integrations.list(await options.actor(request), workspaceId, projectId); });
    routes.get(base + '/integrations/definitions', async request => { const { workspaceId } = workspaceParams.parse(request.params); const { projectId } = z.strictObject({ projectId: z.string().regex(/^PRJ-\d+$/) }).parse(request.query); return integrations.definitions(await options.actor(request), workspaceId, projectId); });
    routes.put(base + '/integrations/:id', async request => { const { workspaceId, id } = resourceParams.parse(request.params); return integrations.save(await options.actor(request), workspaceId, id, automationIntegrationSaveSchema.parse(request.body)); });
    routes.post(base + '/integrations/:id/verify', async request => { const { workspaceId, id } = resourceParams.parse(request.params); return integrations.verify(await options.actor(request), workspaceId, id, automationIntegrationMutationSchema.parse(request.body)); });
    routes.post(base + '/integrations/:id/revoke', async request => { const { workspaceId, id } = resourceParams.parse(request.params); return integrations.revoke(await options.actor(request), workspaceId, id, automationIntegrationMutationSchema.parse(request.body)); });
    routes.get(base + '/event-endpoints', async request => { const { workspaceId } = workspaceParams.parse(request.params); const { projectId } = projectQuery.parse(request.query); return events.list(await options.actor(request), workspaceId, projectId); });
    routes.put(base + '/event-endpoints/:id', async request => { const { workspaceId, id } = resourceParams.parse(request.params); return events.save(await options.actor(request), workspaceId, id, automationEventSaveSchema.parse(request.body)); });
    routes.post(base + '/event-endpoints/:id/revoke', async request => { const { workspaceId, id } = resourceParams.parse(request.params); return events.revoke(await options.actor(request), workspaceId, id, automationIntegrationMutationSchema.parse(request.body)); });
    routes.get(base + '/event-endpoints/:id/events', async request => { const { workspaceId, id } = resourceParams.parse(request.params); const { cursor } = z.strictObject({ cursor: z.uuid().optional() }).parse(request.query); return events.events(await options.actor(request), workspaceId, id, cursor); });
    routes.get(base + '/integration-receipts/:id', async request => { const { workspaceId, id } = resourceParams.parse(request.params); z.strictObject({}).parse(request.query); return integrations.receipt(await options.actor(request), workspaceId, id); });
    routes.get(base + '/integrations/operations/:id', async request => { const { workspaceId, id } = resourceParams.parse(request.params); z.strictObject({}).parse(request.query); return integrations.operation(await options.actor(request), workspaceId, id); });
    routes.post(base + '/integrations/runtime', async request => {
      const { workspaceId } = workspaceParams.parse(request.params);
      const authorization = request.headers.authorization ?? '';
      const identity = authorization.startsWith('Bearer ') ? verifyAutomationServiceBearer(authorization.slice(7), 'automation-integrations') : null;
      if (!identity || identity.workspaceId !== workspaceId) throw new DomainError('unauthenticated', 'A current generation-restricted automation integration bearer is required', 401);
      return runtime.handle(identity, automationIntegrationRuntimeSchema.parse(request.body));
    });
  });
  // Only the owned Agent service can call these policy callbacks. Authenticate exact raw bytes.
  void app.register(async routes => {
    routes.removeAllContentTypeParsers();
    routes.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 32768 }, (_request, body, done) => done(null, body));
    const scopeSchema = z.strictObject({ actorId: z.uuid(), workspaceId: z.uuid(), projectId: z.string().regex(/^PRJ-\d+$/) });
    const refSchema = z.strictObject({ scope: scopeSchema, contextId: z.string().min(1).max(100), serverId: z.string().min(1).max(300) });
    async function signed(request: FastifyRequest): Promise<unknown> {
      const headers = new Headers();
      for (const key of ['x-pm-automation-timestamp', 'x-pm-automation-signature']) { const value = request.headers[key]; if (typeof value === 'string') headers.set(key, value); }
      if (typeof request.body !== 'string' || request.headers.origin || !verifyAutomationServiceRequest('POST', new URL(request.url, 'http://pm.invalid').pathname, request.body, headers)) throw new DomainError('unauthenticated', 'A current private Agent service signature is required', 401);
      try { return JSON.parse(request.body) as unknown; } catch { throw new DomainError('validation_failed', 'Service body must be JSON'); }
    }
    routes.post('/internal/extensions/authorize', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { scope, write, maintenance } = z.strictObject({ scope: scopeSchema, write: z.boolean().optional(), maintenance: z.boolean().optional() }).parse(await signed(request));
      const sql = await options.database().connect();
      try {
        // Do not reacquire the workspace advisory lock: PM may be waiting on this resolver.
        await sql.query('BEGIN READ ONLY');
        if (write === true && maintenance !== true) await assertAutomationIntegrationsAvailable(sql);
        await authorizeAutomationIntegration(sql, options, { id: scope.actorId, email: '', name: '' }, scope.workspaceId, scope.projectId, write === true);
        await sql.query('COMMIT'); return { authorized: true };
      } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
    });
    routes.post('/internal/extensions/references', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { scope, contextId, serverId, reserveDelete } = refSchema.extend({ reserveDelete: z.literal(true).optional() }).parse(await signed(request));
      const sql = await options.database().connect();
      try {
        await sql.query(reserveDelete ? 'BEGIN' : 'BEGIN READ ONLY');
        if (reserveDelete) { await assertAutomationIntegrationsAvailable(sql); await lockWorkspace(sql, scope.workspaceId); }
        await authorizeAutomationIntegration(sql, options, { id: scope.actorId, email: '', name: '' }, scope.workspaceId, scope.projectId, reserveDelete === true);
        const rows = await sql.query<{ id: string; label: string; project_id: string }>(`SELECT id,config->>'label' AS label,project_id FROM automation_integration_connections WHERE workspace_id=$1 AND actor_id=$2 AND project_id=$3 AND status<>'revoked' AND config->'mcpDefinition'->>'contextId'=$4 AND config->'mcpDefinition'->>'serverId'=$5 ORDER BY id`, [scope.workspaceId, scope.actorId, scope.projectId, contextId, serverId]);
        if (reserveDelete && !rows.rowCount) await sql.query('INSERT INTO automation_integration_definition_deletions(workspace_id,actor_id,project_id,context_id,server_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [scope.workspaceId, scope.actorId, scope.projectId, contextId, serverId]);
        await sql.query('COMMIT'); return { references: rows.rows.map(row => ({ id: row.id, label: row.label, projectId: row.project_id })) };
      } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
    });
    routes.post('/internal/extensions/invalidate', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { scope, contextId, serverId, configFingerprint } = z.strictObject({ scope: scopeSchema, contextId: z.string().min(1).max(100), serverId: z.string().min(1).max(300).optional(), configFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(await signed(request));
      const sql = await options.database().connect();
      try {
        await sql.query('BEGIN'); await assertAutomationIntegrationsAvailable(sql); await lockWorkspace(sql, scope.workspaceId);
        await authorizeAutomationIntegration(sql, options, { id: scope.actorId, email: '', name: '' }, scope.workspaceId, scope.projectId, true);
        const result = await sql.query(`UPDATE automation_integration_connections SET verification=jsonb_set(verification,'{mcp}','false'),mcp_config_fingerprint=NULL,status='configured',last_error='integration_definition_changed',revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND actor_id=$2 AND project_id=$3 AND status<>'revoked' AND config->'mcpDefinition'->>'contextId'=$4 AND ($5::text IS NULL OR config->'mcpDefinition'->>'serverId'=$5) AND (verification->>'mcp'='true' OR mcp_config_fingerprint IS NOT NULL) AND ($6::text IS NULL OR mcp_config_fingerprint IS DISTINCT FROM $6)`, [scope.workspaceId, scope.actorId, scope.projectId, contextId, serverId ?? null, configFingerprint ?? null]);
        if (serverId && configFingerprint) await sql.query('DELETE FROM automation_integration_definition_deletions WHERE workspace_id=$1 AND actor_id=$2 AND project_id=$3 AND context_id=$4 AND server_id=$5', [scope.workspaceId, scope.actorId, scope.projectId, contextId, serverId]);
        await sql.query('COMMIT'); return { invalidated: result.rowCount ?? 0 };
      } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
    });
  });
  // Raw-body parsing is encapsulated here; PM's ordinary JSON routes retain their existing parser.
  void app.register(async routes => {
    routes.removeAllContentTypeParsers();
    routes.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1048576 }, (_request, body, done) => done(null, body));
    routes.post('/api/v1/automation-webhooks/:endpointId', { bodyLimit: 1048576 }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      const { endpointId } = z.strictObject({ endpointId: z.uuid().toLowerCase() }).parse(request.params);
      z.strictObject({}).parse(request.query);
      if (!Buffer.isBuffer(request.body)) throw new DomainError('event_payload_invalid', 'Webhook must contain a raw JSON object body');
      const receipt = await events.receive(endpointId, request.body, request.headers);
      return reply.code('challenge' in receipt ? 200 : 202).send(receipt);
    });
  });
}
