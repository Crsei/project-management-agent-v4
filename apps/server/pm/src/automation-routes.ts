import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor } from '../../../../packages/domain/src/core.ts';
import type { NotificationCorePort } from '../../../../packages/pm-core/readonly.ts';
import { createAutomationService, automationCursorSchema } from '../../../../packages/application/src/automation.ts';
import { automationCreateSchema, automationRevisionSchema, automationStatusSchema, automationTestSchema, automationUpdateSchema } from '../../../../packages/contracts/src/automation.ts';

export function registerAutomationRoutes(app: FastifyInstance, options: { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; core: NotificationCorePort }): void {
  const service = createAutomationService(options);
  const paramsSchema = z.strictObject({ workspaceId: z.uuid().toLowerCase(), id: z.uuid().toLowerCase().optional(), requestId: z.uuid().toLowerCase().optional() });
  const base = '/api/v1/workspaces/:workspaceId/automations';
  async function context(request: FastifyRequest) {
    const params = paramsSchema.parse(request.params);
    return { ...params, actor: await options.actor(request) };
  }
  app.addHook('onSend', async (request, reply) => { if (request.routeOptions.url?.startsWith(base)) reply.header('Cache-Control', 'no-store'); });
  app.get(base + '/capabilities', async request => {
    z.strictObject({}).parse(request.query); const c = await context(request); return service.capabilities(c.actor, c.workspaceId);
  });
  app.get(base + '/rules', async request => {
    const query = z.strictObject({ cursor: automationCursorSchema.optional() }).parse(request.query);
    const c = await context(request); return service.rules(c.actor, c.workspaceId, query.cursor);
  });
  app.post(base + '/rules', async request => {
    z.strictObject({}).parse(request.query); const input = automationCreateSchema.parse(request.body);
    const c = await context(request); return service.create(c.actor, c.workspaceId, input);
  });
  app.put(base + '/rules/:id', async request => {
    z.strictObject({}).parse(request.query); const input = automationUpdateSchema.parse(request.body);
    const c = await context(request); return service.update(c.actor, c.workspaceId, c.id!, input);
  });
  app.post(base + '/rules/:id/status', async request => {
    z.strictObject({}).parse(request.query); const input = automationStatusSchema.parse(request.body);
    const c = await context(request); return service.setStatus(c.actor, c.workspaceId, c.id!, input);
  });
  app.delete(base + '/rules/:id', async request => {
    z.strictObject({}).parse(request.query); const input = automationRevisionSchema.parse(request.body);
    const c = await context(request); return service.remove(c.actor, c.workspaceId, c.id!, input);
  });
  app.post(base + '/rules/:id/run', async request => {
    z.strictObject({}).parse(request.query); const input = automationRevisionSchema.parse(request.body);
    const c = await context(request); return service.run(c.actor, c.workspaceId, c.id!, input);
  });
  app.post(base + '/test', async request => {
    z.strictObject({}).parse(request.query); const input = automationTestSchema.parse(request.body);
    const c = await context(request); return service.test(c.actor, c.workspaceId, input.config);
  });
  app.get(base + '/runs', async request => {
    const query = z.strictObject({ cursor: automationCursorSchema.optional(), ruleId: z.uuid().toLowerCase().optional() }).parse(request.query);
    const c = await context(request); return service.runs(c.actor, c.workspaceId, query.ruleId, query.cursor);
  });
  app.get(base + '/runs/:id', async request => {
    z.strictObject({}).parse(request.query); const c = await context(request); return service.detail(c.actor, c.workspaceId, c.id!);
  });
  app.get(base + '/receipts/:requestId', async request => {
    z.strictObject({}).parse(request.query); const c = await context(request); return service.receipt(c.actor, c.workspaceId, c.requestId!);
  });
}
