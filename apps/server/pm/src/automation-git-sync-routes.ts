import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor } from '../../../../packages/domain/src/core.ts';
import type { NotificationCorePort } from '../../../../packages/pm-core/readonly.ts';
import { createAutomationGitSyncService } from '../../../../packages/application/src/automation-git-sync.ts';
import { createAutomationTransferService, type AutomationTransferStudio } from '../../../../packages/application/src/automation-transfer.ts';
import { automationGitCheckSchema, automationGitRunSchema, automationGitSaveSchema } from '../../../../packages/contracts/src/automation-git-sync.ts';
import { automationBundleUploadSchema, automationTransferImportSchema, automationTransferPreviewSchema } from '../../../../packages/contracts/src/automation-transfer.ts';

export function registerAutomationGitSyncRoutes(app: FastifyInstance, options: { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; core: NotificationCorePort; studio: AutomationTransferStudio }): void {
  const git = createAutomationGitSyncService(options), transfer = createAutomationTransferService(options);
  const base = '/api/v1/workspaces/:workspaceId/automations', empty = z.strictObject({});
  const paramsSchema = z.strictObject({ workspaceId: z.uuid().toLowerCase(), id: z.uuid().toLowerCase().optional(), requestId: z.uuid().toLowerCase().optional() });
  async function context(request: FastifyRequest) { return { ...paramsSchema.parse(request.params), actor: await options.actor(request) }; }
  app.addHook('onSend', async (request, reply) => { if (request.routeOptions.url?.startsWith(base + '/git-sync') || request.routeOptions.url?.startsWith(base + '/transfer')) reply.header('Cache-Control', 'no-store'); });
  app.get(base + '/git-sync', async request => { const query = z.strictObject({ projectId: z.string().regex(/^PRJ-\d+$/) }).parse(request.query), c = await context(request); return git.status(c.actor, c.workspaceId, query.projectId); });
  app.put(base + '/git-sync', async request => { empty.parse(request.query); const input = automationGitSaveSchema.parse(request.body), c = await context(request); return git.save(c.actor, c.workspaceId, input); });
  app.post(base + '/git-sync/check', async request => { empty.parse(request.query); const input = automationGitCheckSchema.parse(request.body), c = await context(request); return git.check(c.actor, c.workspaceId, input); });
  app.post(base + '/git-sync/sync', async request => { empty.parse(request.query); const input = automationGitRunSchema.parse(request.body), c = await context(request); return git.sync(c.actor, c.workspaceId, input); });
  app.post(base + '/git-sync/reconcile', async request => { empty.parse(request.query); const input = automationGitRunSchema.parse(request.body), c = await context(request); return git.reconcile(c.actor, c.workspaceId, input); });
  app.get(base + '/git-sync/receipts/:requestId', async request => { empty.parse(request.query); const c = await context(request); return git.receipt(c.actor, c.workspaceId, c.requestId!); });
  app.post(base + '/transfer/preview', { bodyLimit: 4 * 1024 * 1024 }, async request => { empty.parse(request.query); const input = automationTransferPreviewSchema.parse(request.body), c = await context(request); return transfer.preview(c.actor, c.workspaceId, input); });
  app.post(base + '/transfer/imports', { bodyLimit: 4 * 1024 * 1024 }, async request => { empty.parse(request.query); const input = automationTransferImportSchema.parse(request.body), c = await context(request); return transfer.import(c.actor, c.workspaceId, input); });
  app.get(base + '/transfer/imports/:requestId', async request => { empty.parse(request.query); const c = await context(request); return transfer.receipt(c.actor, c.workspaceId, c.requestId!); });
  app.get(base + '/transfer/definitions/:id', async request => { const query = z.strictObject({ format: z.enum(['source', 'bundle']).default('bundle') }).parse(request.query), c = await context(request); return transfer.export(c.actor, c.workspaceId, c.id!, query.format); });
  app.post(base + '/transfer/bundles', { bodyLimit: 4 * 1024 * 1024 }, async request => { empty.parse(request.query); const input = automationBundleUploadSchema.parse(request.body), c = await context(request); return transfer.uploadBundle(c.actor, c.workspaceId, input); });
  app.get(base + '/transfer/bundles/receipts/:requestId', async request => { empty.parse(request.query); const c = await context(request); return transfer.uploadBundleReceipt(c.actor, c.workspaceId, c.requestId!); });
}
