import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { pmAutomationApplyRequestSchema, pmAutomationCandidateEditSchema, pmAutomationEventSchema, pmAutomationPreviewRequestSchema, pmAutomationPublishSchema, pmAutomationReviewRequestSchema, pmAutomationSnapshotInputSchema, pmAutomationVisitRequestSchema } from '../../../../packages/contracts/src/automation-pm.ts';
import { createPmAutomationService, type PmAutomationMutationPort } from '../../../../packages/application/src/automation-pm.ts';
import { receivePmAutomationSignal, recordPmAutomationVisit } from '../../../../packages/application/src/automation-pm-signals.ts';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import { verifyAutomationServiceRequest } from '../../../../packages/infrastructure/src/automation-execution-client.ts';
import type { NotificationCorePort } from '../../../../packages/pm-core/readonly.ts';

/** Service analysis ingress and human review are deliberately separate authorities. */
export function registerPmAutomationRoutes(app: FastifyInstance, options: { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; core: NotificationCorePort; mutations?: PmAutomationMutationPort }): void {
  const service = createPmAutomationService(options), empty = z.strictObject({}), uuid = z.uuid().toLowerCase();
  const base = '/api/v1/workspaces/:workspaceId/automations/pm';
  const params = z.strictObject({ workspaceId: uuid, executionId: uuid.optional(), candidateId: z.string().min(1).max(300).optional(), requestId: uuid.optional() });
  async function context(request: FastifyRequest, authority: 'user' | 'service' | 'read' = 'user') {
    empty.parse(request.query);
    const scope = params.parse(request.params);
    const serviceBearer = request.headers.authorization?.startsWith('Bearer pm-automation-v1.') === true;
    if (authority === 'service' && !serviceBearer) throw new DomainError('automation_service_required', 'Only this execution service may freeze sources or publish analysis', 403);
    if (authority === 'user' && serviceBearer) throw new DomainError('automation_service_scope_forbidden', 'Only the authenticated user may review or apply PM proposals', 403);
    return { ...scope, serviceBearer, actor: await options.actor(request) };
  }
  app.addHook('onSend', async (request, reply) => { if (request.routeOptions.url?.startsWith(base)) reply.header('Cache-Control', 'private, no-store'); });
  app.get(base + '/executions/:executionId/snapshot', async request => { const c = await context(request, 'read'); return service.snapshot(c.actor, c.workspaceId, c.executionId!); });
  app.post(base + '/executions/:executionId/snapshot', async request => { const c = await context(request, 'service'), input = pmAutomationSnapshotInputSchema.parse(request.body); return service.freeze(c.actor, c.workspaceId, c.executionId!, input.agentEvidence); });
  app.get(base + '/executions/:executionId/result', async request => { const c = await context(request, 'read'); return service.result(c.actor, c.workspaceId, c.executionId!, c.serviceBearer); });
  app.post(base + '/executions/:executionId/result', async request => { const c = await context(request, 'service'), input = pmAutomationPublishSchema.parse(request.body); return service.publish(c.actor, c.workspaceId, c.executionId!, input.result); });
  app.patch(base + '/executions/:executionId/candidates/:candidateId', async request => { const c = await context(request), input = pmAutomationCandidateEditSchema.parse(request.body); await service.edit(c.actor, c.workspaceId, c.executionId!, c.candidateId!, input); return service.receipt(c.actor, c.workspaceId, input.requestId); });
  app.post(base + '/executions/:executionId/candidates/:candidateId/preview', async request => { const c = await context(request), input = pmAutomationPreviewRequestSchema.parse(request.body); return service.preview(c.actor, c.workspaceId, c.executionId!, c.candidateId!, input); });
  app.post(base + '/executions/:executionId/candidates/:candidateId/apply', async (request, reply) => { const c = await context(request), input = pmAutomationApplyRequestSchema.parse(request.body); await service.apply(c.actor, c.workspaceId, c.executionId!, c.candidateId!, input); const receipt = await service.receipt(c.actor, c.workspaceId, input.requestId); return reply.code(receipt.httpStatus).send(receipt); });
  app.post(base + '/executions/:executionId/candidates/:candidateId/ignore', async request => { const c = await context(request), input = pmAutomationReviewRequestSchema.parse(request.body); await service.ignore(c.actor, c.workspaceId, c.executionId!, c.candidateId!, input); return service.receipt(c.actor, c.workspaceId, input.requestId); });
  app.get(base + '/receipts/:requestId', async request => { const c = await context(request); return service.receipt(c.actor, c.workspaceId, c.requestId!); });
  app.post(base + '/visits', async request => { const c = await context(request), input = pmAutomationVisitRequestSchema.parse(request.body); return recordPmAutomationVisit(options, c.actor, c.workspaceId, input); });
  app.register(async signals => {
    signals.removeContentTypeParser('application/json');
    signals.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 512 * 1024 }, (_request, body, done) => done(null, body));
    signals.post(base + '/signals', async request => {
      const scope = z.strictObject({ workspaceId: uuid }).parse(request.params); empty.parse(request.query);
      if (typeof request.body !== 'string') throw new DomainError('automation_signal_invalid', 'Signed signal ingress requires exact JSON bytes', 400);
      const headers = new Headers();
      for (const key of ['x-pm-automation-timestamp', 'x-pm-automation-signature']) { const value = request.headers[key]; if (typeof value === 'string') headers.set(key, value); }
      if (!verifyAutomationServiceRequest('POST', new URL(request.url, 'http://pm.invalid').pathname, request.body, headers)) throw new DomainError('unauthenticated', 'Agent signal producer signature is invalid or expired', 401);
      let body: unknown; try { body = JSON.parse(request.body); } catch { throw new DomainError('automation_signal_invalid', 'Signal body is not JSON', 400); }
      const event = pmAutomationEventSchema.parse(body);
      return receivePmAutomationSignal(options, { workspaceId: scope.workspaceId, event });
    });
  });
}
