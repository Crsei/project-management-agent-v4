import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor } from '../../../../packages/domain/src/core.ts';
import { getOnboarding, updateOnboarding } from '../../../../packages/application/src/onboarding.ts';

export function registerOnboardingRoutes(app: FastifyInstance, options: { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor> }): void {
  app.get('/api/v1/auth/onboarding', async (request, reply) => {
    z.strictObject({}).parse(request.query);
    reply.header('Cache-Control', 'private, no-store');
    return getOnboarding(options.database(), await options.actor(request));
  });
  app.patch('/api/v1/auth/onboarding', { bodyLimit: 4096 }, async (request, reply) => {
    z.strictObject({}).parse(request.query);
    reply.header('Cache-Control', 'private, no-store');
    return updateOnboarding(options.database(), await options.actor(request), request.body);
  });
}
