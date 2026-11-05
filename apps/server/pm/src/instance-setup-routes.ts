import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { completeInstanceSetup } from '../../../../packages/application/src/instance-setup.ts';
import { getInstanceSetupStatus } from '../../../../packages/infrastructure/src/instance-setup.ts';

export function registerInstanceSetupRoutes(app: FastifyInstance, options: { database: () => Pool; cookieOptions: CookieSerializeOptions }): void {
  void app.register(async routes => {
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      z.strictObject({}).parse(request.query);
    });
    routes.get('/api/v1/setup/status', async () => getInstanceSetupStatus(options.database()));
    routes.post('/api/v1/setup', { bodyLimit: 4096 }, async (request, reply) => {
      const session = await completeInstanceSetup(options.database(), request.body, { sourceIp: request.ip });
      reply.setCookie('pm_v4_session', session.token, { ...options.cookieOptions, expires: new Date(session.expiresAt) });
      return { actor: session.actor, workspaceId: session.workspaceId, expiresAt: session.expiresAt };
    });
  });
}
