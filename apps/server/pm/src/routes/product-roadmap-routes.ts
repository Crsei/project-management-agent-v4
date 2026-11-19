import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { roadmapActionSchema } from '../../../../packages/contracts/src/product-roadmap.ts';
import type { Actor } from '../../../../packages/domain/src/core.ts';
import type { CoreWorkspacePool } from './core-routes.ts';
import { createProductRoadmapService } from './product-roadmap-service.ts';

type Options = { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; coreWorkspaces: CoreWorkspacePool | undefined };
export function registerProductRoadmapRoutes(app: FastifyInstance, options: Options) {
  const path = '/api/v1/workspaces/:workspaceId/projects/:projectId/product-roadmap';
  const service = createProductRoadmapService(options);
  async function context(request: FastifyRequest) {
    const { workspaceId, projectId } = z.strictObject({ workspaceId: z.uuid(), projectId: z.string().min(1).max(100) }).parse(request.params);
    return { workspaceId, projectId, actor: await options.actor(request) };
  }
  app.get(path, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const c = await context(request);
    return service.read(c.actor, c.workspaceId, c.projectId);
  });
  app.post(path, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const input = roadmapActionSchema.parse(request.body);
    return service.act(await context(request), input);
  });
  app.post(path + '/inspect', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const input = roadmapActionSchema.parse(request.body), c = await context(request);
    const roadmap = await service.recover(c, input);
    return { status: roadmap ? 'confirmed' : 'unknown', roadmap };
  });
}
