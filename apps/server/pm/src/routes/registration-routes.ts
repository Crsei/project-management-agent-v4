import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { registerAccount } from '../../../../../packages/application/src/registration.ts';
import { DomainError } from '../../../../../packages/domain/src/core.ts';
import { authenticate } from '../../../../../packages/infrastructure/src/auth.ts';

async function rejectAuthenticatedSession(pool: Pool, token: string | undefined): Promise<void> {
  if (!token) return;
  try { await authenticate(pool, token); }
  catch (error) {
    if (error instanceof DomainError && error.code === 'unauthenticated') return;
    throw error;
  }
  throw new DomainError('already_authenticated', 'Sign out before registering another account', 409);
}

export function registerRegistrationRoutes(app: FastifyInstance, options: { database: () => Pool; cookieOptions: CookieSerializeOptions }): void {
  void app.register(async routes => {
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer');
      z.strictObject({}).parse(request.query);
    });
    routes.post('/api/v1/auth/register', { bodyLimit: 4096 }, async (request, reply) => {
      const pool = options.database();
      const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined;
      await rejectAuthenticatedSession(pool, bearer);
      if (request.cookies.pm_v4_session !== bearer) await rejectAuthenticatedSession(pool, request.cookies.pm_v4_session);
      const session = await registerAccount(pool, request.body, request.ip);
      reply.setCookie('pm_v4_session', session.token, { ...options.cookieOptions, expires: new Date(session.expiresAt) });
      return { actor: session.actor, expiresAt: session.expiresAt };
    });
  });
}
