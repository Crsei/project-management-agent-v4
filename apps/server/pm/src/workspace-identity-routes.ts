import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor } from '../../../../packages/domain/src/core.ts';
import { readWorkspaceIdentity } from '../../../../packages/application/src/workspace-identity.ts';

export function registerWorkspaceIdentityRoutes(app: FastifyInstance, options: {
  database: () => Pool;
  actor: (request: FastifyRequest) => Promise<Actor>;
}): void {
  app.get('/api/v1/workspaces/:workspaceId/identity', async (request, reply) => {
    z.strictObject({}).parse(request.query);
    const { workspaceId } = z.strictObject({ workspaceId: z.uuid().toLowerCase() }).parse(request.params);
    reply.header('Cache-Control', 'no-store');
    return readWorkspaceIdentity(options.database(), await options.actor(request), workspaceId);
  });
}
