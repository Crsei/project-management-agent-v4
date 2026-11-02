import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import type { NotificationCorePort } from '../../../../packages/pm-core/readonly.ts';
import { automationEventSaveSchema, automationIntegrationMutationSchema, automationIntegrationSaveSchema, automationIntegrationRuntimeSchema } from '../../../../packages/contracts/src/automation-integrations.ts';
import { createAutomationIntegrationsService } from '../../../../packages/application/src/automation-integrations.ts';
import { createAutomationEventsService } from '../../../../packages/application/src/automation-events.ts';
import { createAutomationIntegrationRuntimeService } from '../../../../packages/application/src/automation-integrations-runtime.ts';
import { verifyAutomationServiceBearer } from '../../../../packages/infrastructure/src/automation-execution-client.ts';
import { createAutomationPrivateStore } from '../../../../packages/infrastructure/src/automation-integrations.ts';

const workspaceParams = z.strictObject({ workspaceId: z.uuid().toLowerCase() });
const resourceParams = workspaceParams.extend({ id: z.uuid().toLowerCase() });
const projectQuery = z.strictObject({ projectId: z.string().regex(/^PRJ-\d+$/).optional() });
export function registerAutomationEventsRoutes(app: FastifyInstance, options: { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; core: NotificationCorePort; publicOrigin?: string }): void {
  const privateStore = createAutomationPrivateStore();
  const integrations = createAutomationIntegrationsService({ ...options, privateStore });
  const events = createAutomationEventsService({ ...options, privateStore });
  const runtime = createAutomationIntegrationRuntimeService({ ...options, privateStore });
  void app.register(async routes => {
    routes.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer'); });
    const base = '/api/v1/workspaces/:workspaceId/automations';
    routes.get(base + '/integrations', async request => { const { workspaceId } = workspaceParams.parse(request.params); const { projectId } = projectQuery.parse(request.query); return integrations.list(await options.actor(request), workspaceId, projectId); });
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
