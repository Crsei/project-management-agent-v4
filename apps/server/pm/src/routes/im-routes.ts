import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { DomainError, type Actor } from '../../../../../packages/domain/src/core.ts';
import { imBindingParamsSchema, imBindingUpdateSchema, imEmptySchema, imParamsSchema, type ImConnectivity } from '../../../../../packages/contracts/src/im-gateway.ts';
import type { ImGatewayConfig } from '../../../../../packages/infrastructure/src/im-gateway-config.ts';
import { createImLinkCode, listImBindings, revokeImBinding, setImNotification } from '../../../../../packages/application/src/im-gateway.ts';

export function registerImRoutes(app: FastifyInstance, options: {
  database: () => Pool;
  actor: (request: FastifyRequest) => Promise<Actor>;
  config: ImGatewayConfig | undefined;
  status: () => ImConnectivity;
}): void {
  void app.register(async routes => {
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer');
    });
    const base = '/api/v1/workspaces/:workspaceId/im';
    routes.get(base, async request => {
      const { workspaceId } = imParamsSchema.parse(request.params);
      imEmptySchema.parse(request.query);
      imEmptySchema.parse(request.body ?? {});
      const principal = await options.actor(request);
      return {
        configuration: options.config ? 'configured' as const : 'disabled' as const,
        connectivity: options.status(),
        bindings: await listImBindings(options.database(), principal, workspaceId),
      };
    });
    routes.post(base + '/link-codes', async request => {
      const { workspaceId } = imParamsSchema.parse(request.params);
      imEmptySchema.parse(request.query);
      const principal = await options.actor(request);
      imEmptySchema.parse(request.body ?? {});
      if (!options.config) throw new DomainError('im_not_configured', 'IM gateway is not configured', 503);
      return createImLinkCode(options.database(), principal, workspaceId, options.config.linkTtlSeconds);
    });
    routes.patch(base + '/bindings/:bindingId', async request => {
      const { workspaceId, bindingId } = imBindingParamsSchema.parse(request.params);
      imEmptySchema.parse(request.query);
      const input = imBindingUpdateSchema.parse(request.body);
      return setImNotification(options.database(), await options.actor(request), workspaceId, bindingId, input.notifyEnabled);
    });
    routes.post(base + '/bindings/:bindingId/revoke', async request => {
      const { workspaceId, bindingId } = imBindingParamsSchema.parse(request.params);
      imEmptySchema.parse(request.query);
      imEmptySchema.parse(request.body);
      return revokeImBinding(options.database(), await options.actor(request), workspaceId, bindingId);
    });
  });
}
