import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '../../../packages/domain/src/core.ts';
import type { Actor } from '../../../packages/domain/src/core.ts';
import { acceptMemberInvitation, getMemberInvitationAcceptance, inspectMemberInvitation } from '../../../packages/application/src/invitation-acceptance.ts';
import { listMemberInvitations } from '../../../packages/application/src/invitations.ts';
import type { InvitationProjectValidator } from '../../../packages/application/src/invitations.ts';
import type { InvitationMailConfig } from '../../../packages/infrastructure/src/invitation-mail.ts';

export type InvitationRouteOptions = {
  database: () => Pool;
  actor: (request: FastifyRequest) => Promise<Actor>;
  mailConfig?: InvitationMailConfig;
  validateProjects?: InvitationProjectValidator;
};

/** Public invitation endpoints authenticate the high-entropy token and existing account password, not membership. */
export function registerInvitationRoutes(app: FastifyInstance, options: InvitationRouteOptions): void {
  const attempts = new Map<string, { count: number; until: number }>();
  async function publicRequest(request: FastifyRequest): Promise<void> {
    z.strictObject({}).parse(request.query);
    const now = Date.now();
    if (attempts.size > 10_000) for (const [ip, state] of attempts) if (state.until <= now) attempts.delete(ip);
    const previous = attempts.get(request.ip);
    const state = previous && previous.until > now ? previous : { count: 0, until: now + 60_000 };
    state.count++;
    attempts.set(request.ip, state);
    if (state.count > 30) throw new DomainError('rate_limited', 'Too many invitation requests; try again later', 429);
  }
  app.get('/api/v1/workspaces/:workspaceId/members/invitations', async (request, reply) => {
    z.strictObject({}).parse(request.query);
    const { workspaceId } = z.strictObject({ workspaceId: z.uuid().toLowerCase() }).parse(request.params);
    reply.header('Cache-Control', 'no-store');
    return listMemberInvitations(options.database(), await options.actor(request), workspaceId, options.mailConfig);
  });
  app.post('/api/v1/invitations/inspect', { bodyLimit: 2048, preHandler: publicRequest }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return inspectMemberInvitation(options.database(), request.body, options);
  });
  app.post('/api/v1/invitations/accept', { bodyLimit: 4096, preHandler: publicRequest }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return acceptMemberInvitation(options.database(), request.body, options);
  });
  app.post('/api/v1/invitations/receipt', { bodyLimit: 4096, preHandler: publicRequest }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return getMemberInvitationAcceptance(options.database(), request.body, options);
  });
}
