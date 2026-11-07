import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor } from '../../../../packages/domain/src/core.ts';
import type { NotificationCorePort } from '../../../../packages/pm-core/readonly.ts';
import { createAutomationStudioService, type AutomationStudioService } from '../../../../packages/application/src/automation-studio.ts';
import { studioActionKindSchema, studioCancelSchema, studioConfigSchema, studioCreateSchema, studioDispatchSchema, studioRevisionSchema, studioStatusSchema, studioUpdateSchema, type StudioExecutionPort } from '../../../../packages/contracts/src/automation-studio.ts';

export function registerAutomationStudioRoutes(app: FastifyInstance, options: { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; core: NotificationCorePort; runtime: StudioExecutionPort; studio?: AutomationStudioService }): AutomationStudioService {
  const service = options.studio ?? createAutomationStudioService(options);
  const uuid = z.uuid().toLowerCase(), empty = z.strictObject({});
  const base = '/api/v1/workspaces/:workspaceId/automations';
  async function context(request: FastifyRequest) { const scope = z.strictObject({ workspaceId: uuid, id: uuid.optional(), requestId: uuid.optional() }).parse(request.params); return { ...scope, actor: await options.actor(request) }; }
  app.addHook('onSend', async (request, reply) => { if (request.routeOptions.url?.startsWith(base)) reply.header('Cache-Control', 'no-store'); });
  app.get(base + '/studio-capabilities', async request => { const query = z.strictObject({ projectId: z.string().regex(/^PRJ-\d+$/), actionKind: studioActionKindSchema.optional() }).parse(request.query); const c = await context(request); return service.capabilities(c.actor, c.workspaceId, query.projectId, query.actionKind); });
  app.get(base + '/definitions', async request => { const q = z.strictObject({ cursor: uuid.optional(), projectId: z.string().regex(/^PRJ-\d+$/).optional(), quickAccess: z.enum(['true', 'false']).transform(value => value === 'true').optional() }).parse(request.query); const c = await context(request); return service.definitions(c.actor, c.workspaceId, q.cursor, { ...(q.projectId === undefined ? {} : { projectId: q.projectId }), ...(q.quickAccess === undefined ? {} : { quickAccess: q.quickAccess }) }); });
  app.post(base + '/definitions', async request => { empty.parse(request.query); const input = studioCreateSchema.parse(request.body); const c = await context(request); return service.create(c.actor, c.workspaceId, input); });
  app.post(base + '/definitions/validate', async request => { empty.parse(request.query); const input = z.strictObject({ config: studioConfigSchema }).parse(request.body); const c = await context(request); return service.validate(c.actor, c.workspaceId, input.config); });
  app.get(base + '/definitions/:id', async request => { empty.parse(request.query); const c = await context(request); return service.definition(c.actor, c.workspaceId, c.id!); });
  app.put(base + '/definitions/:id', async request => { empty.parse(request.query); const input = studioUpdateSchema.parse(request.body); const c = await context(request); return service.update(c.actor, c.workspaceId, c.id!, input); });
  app.delete(base + '/definitions/:id', async request => { empty.parse(request.query); const input = studioRevisionSchema.parse(request.body); const c = await context(request); return service.remove(c.actor, c.workspaceId, c.id!, input); });
  app.post(base + '/definitions/:id/status', async request => { empty.parse(request.query); const input = studioStatusSchema.parse(request.body); const c = await context(request); return service.setStatus(c.actor, c.workspaceId, c.id!, input); });
  app.post(base + '/definitions/:id/run', async request => { empty.parse(request.query); const input = studioDispatchSchema.parse(request.body); const c = await context(request); return service.run(c.actor, c.workspaceId, c.id!, { ...input, payload: input.payload ?? {} }); });
  app.post(base + '/definitions/:id/test', async request => { empty.parse(request.query); const input = studioDispatchSchema.parse(request.body); const c = await context(request); return service.dispatchTest(c.actor, c.workspaceId, c.id!, { ...input, payload: input.payload ?? {} }); });
  app.get(base + '/executions', async request => { const q = z.strictObject({ cursor: uuid.optional(), definitionId: uuid.optional() }).parse(request.query); const c = await context(request); return service.executions(c.actor, c.workspaceId, q.definitionId, q.cursor); });
  app.get(base + '/executions/:id', async request => { empty.parse(request.query); const c = await context(request); return service.execution(c.actor, c.workspaceId, c.id!); });
  app.get(base + '/executions/:id/logs', async request => { const q = z.strictObject({ cursor: z.string().regex(/^\d{1,16}$/).optional() }).parse(request.query); const c = await context(request); return service.logs(c.actor, c.workspaceId, c.id!, q.cursor); });
  app.post(base + '/executions/:id/query', async request => { empty.parse(request.query); empty.parse(request.body); const c = await context(request); return service.query(c.actor, c.workspaceId, c.id!); });
  app.post(base + '/executions/:id/cancel', async request => { empty.parse(request.query); const input = studioCancelSchema.parse(request.body); const c = await context(request); return service.cancel(c.actor, c.workspaceId, c.id!, input); });
  app.get(base + '/studio-receipts/:requestId', async request => { empty.parse(request.query); const c = await context(request); return service.receipt(c.actor, c.workspaceId, c.requestId!); });
  return service;
}
