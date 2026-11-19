import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DashboardReadContext } from '../../../../packages/application/src/dashboard-read.ts';
import { lookupPeopleAccount, peopleAccountQuerySchema, peopleCandidateQuerySchema, readPeopleCandidates, readProjectPeople } from '../../../../packages/application/src/people.ts';

/** The host supplies the existing workspace-locked applicationRead transaction. */
export function registerPeopleRoutes(app: FastifyInstance, options: {
  read: <T>(request: FastifyRequest, workspaceId: string, reader: (context: DashboardReadContext) => Promise<T>) => Promise<T>;
}): void {
  const workspaceParams = z.strictObject({ workspaceId: z.uuid().toLowerCase() });
  app.get('/api/v1/workspaces/:workspaceId/people/candidates', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { workspaceId } = workspaceParams.parse(request.params);
    const query = peopleCandidateQuerySchema.parse(request.query);
    return options.read(request, workspaceId, ctx => readPeopleCandidates(ctx, {
      purpose: query.purpose, limit: query.limit,
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.after === undefined ? {} : { after: query.after }),
    }));
  });
  app.get('/api/v1/workspaces/:workspaceId/people/account', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { workspaceId } = workspaceParams.parse(request.params);
    const { email } = peopleAccountQuerySchema.parse(request.query);
    return options.read(request, workspaceId, ctx => lookupPeopleAccount(ctx, email));
  });
  app.get('/api/v1/workspaces/:workspaceId/people/projects/:projectId', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    z.strictObject({}).parse(request.query);
    const { workspaceId, projectId } = workspaceParams.extend({ projectId: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/) }).parse(request.params);
    return options.read(request, workspaceId, ctx => readProjectPeople(ctx, projectId));
  });
}
