import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor } from '../../../packages/domain/src/core.ts';
import type { CoreAccess } from '../../../packages/application/src/ports.ts';
import { readArtifactCopyOrigin } from '../../../packages/application/src/artifact-copy-origins.ts';
import { DomainError } from '../../../packages/domain/src/core.ts';
import { WorkspaceError } from '../../../packages/pm-core/index.ts';

export type ArtifactFilesRouteOptions = {
  database: () => Pool;
  actor: (request: FastifyRequest) => Promise<Actor>;
  coreAccessFor: (actor: Actor, workspaceId: string) => Promise<CoreAccess>;
};
export function registerArtifactFilesRoutes(app: FastifyInstance, options: ArtifactFilesRouteOptions): void {
  void app.register(async routes => {
    routes.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'private,no-store'); });
    routes.get('/api/v1/workspaces/:workspaceId/artifact-versions/:id/copy-origin', async request => {
      const { workspaceId, id } = z.strictObject({ workspaceId: z.uuid().toLowerCase(), id: z.uuid().toLowerCase() }).parse(request.params);
      z.strictObject({}).parse(request.query);
      const actor = await options.actor(request);
      return readArtifactCopyOrigin(options.database(), actor, workspaceId, id, async () => {
        try { return await options.coreAccessFor(actor, workspaceId); }
        catch (error) {
          if (error instanceof WorkspaceError) throw new DomainError('core_source_unavailable', 'Source project is unavailable', 503);
          throw error;
        }
      });
    });
  });
}
