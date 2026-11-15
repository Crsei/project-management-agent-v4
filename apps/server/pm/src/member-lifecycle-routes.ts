import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor } from '../../../../packages/domain/src/core.ts';
import { continueMemberHandover, listMemberHandovers, readDepartureReceipt, readMemberHandover, readMemberImpact, reconcileMemberHandover, type HandoverExecutor, type LifecycleReadContext } from '../../../../packages/application/src/member-lifecycle.ts';

export function registerMemberLifecycleRoutes(app: FastifyInstance, options: HandoverExecutor & {
  database(): Pool;
  actor(request: FastifyRequest): Promise<Actor>;
  read<T>(actor: Actor, workspaceId: string, operation: (ctx: LifecycleReadContext) => Promise<T>): Promise<T>;
}): void {
  const memberParams = z.strictObject({ workspaceId: z.uuid().toLowerCase(), userId: z.uuid().toLowerCase() });
  const operationParams = z.strictObject({ workspaceId: z.uuid().toLowerCase(), operationId: z.uuid().toLowerCase() });
  const base = '/api/v1/workspaces/:workspaceId/people';
  app.get(`${base}/members/:userId/impact`, async (request, reply) => {
    const { workspaceId, userId } = memberParams.parse(request.params); z.strictObject({}).parse(request.query);
    reply.header('Cache-Control', 'no-store');
    return options.read(await options.actor(request), workspaceId, ctx => readMemberImpact(ctx, userId));
  });
  app.get(`${base}/members/:userId/handovers`, async (request, reply) => {
    const { workspaceId, userId } = memberParams.parse(request.params); z.strictObject({}).parse(request.query);
    reply.header('Cache-Control', 'no-store');
    return listMemberHandovers(options.database(), await options.actor(request), workspaceId, userId);
  });
  app.get(`${base}/members/:userId/departure-receipts/:commandId`, async (request, reply) => {
    const { workspaceId, userId, commandId } = memberParams.extend({ commandId: z.uuid().toLowerCase() }).parse(request.params);
    z.strictObject({}).parse(request.query); reply.header('Cache-Control', 'no-store');
    return readDepartureReceipt(options.database(), await options.actor(request), workspaceId, userId, commandId);
  });
  app.get(`${base}/handovers/:operationId`, async (request, reply) => {
    const { workspaceId, operationId } = operationParams.parse(request.params); z.strictObject({}).parse(request.query);
    reply.header('Cache-Control', 'no-store');
    return readMemberHandover(options.database(), await options.actor(request), workspaceId, operationId);
  });
  app.post(`${base}/handovers/:operationId/continue`, async (request, reply) => {
    const { workspaceId, operationId } = operationParams.parse(request.params); z.strictObject({}).parse(request.query);
    const { expectedVersion } = z.strictObject({ expectedVersion: z.number().int().positive() }).parse(request.body);
    reply.header('Cache-Control', 'no-store');
    return continueMemberHandover(options.database(), await options.actor(request), workspaceId, operationId, expectedVersion, options);
  });
  app.post(`${base}/handovers/:operationId/reconcile`, async (request, reply) => {
    const { workspaceId, operationId } = operationParams.parse(request.params); z.strictObject({}).parse(request.query); z.strictObject({}).parse(request.body);
    reply.header('Cache-Control', 'no-store');
    return reconcileMemberHandover(options.database(), await options.actor(request), workspaceId, operationId, options);
  });
}
