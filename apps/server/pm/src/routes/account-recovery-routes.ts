import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { beginRecoveryEmail, confirmRecoveryEmail, cancelRecoveryEmail, unbindRecoveryEmail, requestPasswordRecovery, lookupRecoveryRequest, inspectPasswordRecovery, completePasswordRecovery, lookupPasswordResetAction, limitRecoveryBearer } from '../../../../packages/application/src/account-recovery.ts';
import { consumeAuthRateLimit } from '../../../../packages/infrastructure/src/auth.ts';
import { recoveryTokenSchema, recoveryActionInputSchema, completePasswordRecoverySchema, confirmRecoveryEmailSchema, recoveryRequestIdSchema } from '../../../../packages/contracts/src/account-recovery-schemas.ts';
import type { AccountRecoveryMailConfig } from '../../../../packages/infrastructure/src/account-recovery-mail.ts';

export type AccountRecoveryRouteOptions = { database: () => Pool; token: (request: FastifyRequest) => string; mailConfig?: AccountRecoveryMailConfig };
export function registerAccountRecoveryRoutes(app: FastifyInstance, options: AccountRecoveryRouteOptions): void {
  void app.register(async routes => {
    routes.addHook('onRequest',async (request,reply) => {
      reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer');
      z.strictObject({}).parse(request.query);
    });
    routes.post('/api/v1/auth/security/recovery-email',{bodyLimit:4096},async (request,reply) => {
      const result = await beginRecoveryEmail(options.database(),options.token(request),request.body,options.mailConfig);
      return reply.code(result.httpStatus).send(result);
    });
    routes.post('/api/v1/auth/security/recovery-email/confirm',{bodyLimit:4096},async (request,reply) => {
      const p = confirmRecoveryEmailSchema.parse(request.body);
      await limitRecoveryBearer(options.database(),request.ip,'confirm',p.token);
      const result = await confirmRecoveryEmail(options.database(),options.token(request),p);
      return reply.code(result.httpStatus).send(result);
    });
    routes.post('/api/v1/auth/security/recovery-email/cancel',{bodyLimit:4096},async (request,reply) => {
      const result = await cancelRecoveryEmail(options.database(),options.token(request),request.body);
      return reply.code(result.httpStatus).send(result);
    });
    routes.post('/api/v1/auth/security/recovery-email/unbind',{bodyLimit:4096},async (request,reply) => {
      const result = await unbindRecoveryEmail(options.database(),options.token(request),request.body);
      return reply.code(result.httpStatus).send(result);
    });
    routes.post('/api/v1/auth/password-recovery/requests',{bodyLimit:1024},async (request,reply) => reply.code(202).send(await requestPasswordRecovery(options.database(),request.body,request.ip,options.mailConfig)));
    for (const recover of [false,true]) {
      const suffix = recover ? 'recover' : 'lookup';
      routes.post(`/api/v1/auth/password-recovery/requests/${suffix}`,{bodyLimit:1024},async request => {
        const p = recoveryRequestIdSchema.parse(request.body);
        await consumeAuthRateLimit(options.database(),`recovery-request-${suffix}:${request.ip}`,30,60);
        return lookupRecoveryRequest(options.database(),p,recover);
      });
      routes.post(`/api/v1/auth/password-recovery/actions/${suffix}`,{bodyLimit:1024},async request => {
        const p = recoveryActionInputSchema.parse(request.body);
        await limitRecoveryBearer(options.database(),request.ip,`action-${suffix}`,p.token);
        return lookupPasswordResetAction(options.database(),p,recover);
      });
    }
    routes.post('/api/v1/auth/password-recovery/inspect',{bodyLimit:1024},async request => {
      const p = recoveryTokenSchema.parse(request.body);
      await limitRecoveryBearer(options.database(),request.ip,'inspect',p.token);
      return inspectPasswordRecovery(options.database(),p);
    });
    routes.post('/api/v1/auth/password-recovery/complete',{bodyLimit:4096},async (request,reply) => {
      const p = completePasswordRecoverySchema.parse(request.body);
      await limitRecoveryBearer(options.database(),request.ip,'complete',p.token);
      const result = await completePasswordRecovery(options.database(),p);
      return reply.code(result.status === 'rejected' ? 409 : 200).send(result);
    });
  });
}
