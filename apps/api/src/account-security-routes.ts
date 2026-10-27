import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { changeOwnPassword, getAccountSecurity, getAccountSecurityAction, recoverAccountSecurityAction, revokeOwnSessions } from '../../../packages/application/src/account-security.ts';
import { accountSecurityActionParamsSchema } from '../../../packages/contracts/src/account-security-schemas.ts';

export type AccountSecurityRouteOptions = { database: () => Pool; token: (request: FastifyRequest) => string };

export function registerAccountSecurityRoutes(app: FastifyInstance, options: AccountSecurityRouteOptions): void {
  // Encapsulation ensures private responses, including validation/auth failures,
  // are never cached. Never log bodies or serialize passwords into command journals.
  void app.register(async routes => {
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      z.strictObject({}).parse(request.query);
    });
    routes.get('/api/v1/auth/security', async request => getAccountSecurity(options.database(), options.token(request)));
    routes.post('/api/v1/auth/security/password', { bodyLimit: 4096 }, async (request, reply) => {
      const result = await changeOwnPassword(options.database(), options.token(request), request.body);
      return reply.code(result.httpStatus).send(result);
    });
    routes.post('/api/v1/auth/security/sessions/revoke', { bodyLimit: 1024 }, async (request, reply) => {
      const result = await revokeOwnSessions(options.database(), options.token(request), request.body);
      return reply.code(result.httpStatus).send(result);
    });
    routes.get('/api/v1/auth/security/actions/:actionId', async request => {
      const { actionId } = accountSecurityActionParamsSchema.parse(request.params);
      return getAccountSecurityAction(options.database(), options.token(request), actionId);
    });
    routes.post('/api/v1/auth/security/actions/:actionId/recover', { bodyLimit: 1024 }, async request => {
      const { actionId } = accountSecurityActionParamsSchema.parse(request.params);
      return recoverAccountSecurityAction(options.database(), options.token(request), actionId, request.body);
    });
  });
}
