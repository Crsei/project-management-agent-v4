import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor } from '../../../../packages/domain/src/core.ts';
import type { WebhookConfig } from '../../../../packages/infrastructure/src/webhook-config.ts';
import { webhookParamsSchema, webhookPageQuerySchema } from '../../../../packages/contracts/src/webhook-schemas.ts';
import { readWebhooks, readWebhookDeliveries, readWebhookDelivery } from '../../../../packages/application/src/webhooks.ts';

export function registerWebhookRoutes(app: FastifyInstance, options: { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; config?: WebhookConfig }): void {
  void app.register(async routes => {
    routes.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer'); });
    routes.get('/api/v1/workspaces/:workspaceId/webhooks', async request => {
      const { workspaceId } = webhookParamsSchema.parse(request.params); z.strictObject({}).parse(request.query);
      return readWebhooks(options.database(), await options.actor(request), workspaceId, options.config);
    });
    routes.get('/api/v1/workspaces/:workspaceId/webhooks/:endpointId/deliveries', async request => {
      const { workspaceId, endpointId } = webhookParamsSchema.parse(request.params); const query = webhookPageQuerySchema.parse(request.query);
      return readWebhookDeliveries(options.database(), await options.actor(request), workspaceId, endpointId!, query);
    });
    routes.get('/api/v1/workspaces/:workspaceId/webhook-deliveries/:deliveryId', async request => {
      const { workspaceId, deliveryId } = webhookParamsSchema.parse(request.params); z.strictObject({}).parse(request.query);
      return readWebhookDelivery(options.database(), await options.actor(request), workspaceId, deliveryId!);
    });
  });
}
