import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { cancelRunSchema, createRunSchema, runsQuerySchema, type CollaborationRun, type RunDetailResponse } from '@agent-workspace/contracts/collaboration';
import { DurableError } from '../durable/errors.ts';
import { authorizePmTarget } from '../durable/pm-context.ts';
import { cancelCollaborationRun, collaborationDelegationReadTargets, collaborationRunReadTargets, createCollaborationRun, getCollaborationNativeOutput, getCollaborationOperation, listCollaborationDelegations, listCollaborationRunsForInbox, projectCollaborationResultRefs, projectCollaborationRun, readCollaborationRun, reconcileCollaborationRun } from './runs.ts';
import { readCollaborationDiscussion } from './pm.ts';

async function authorizeRead(run: CollaborationRun, headers: Headers): Promise<void> {
  const targets = new Map(collaborationRunReadTargets(run).map(target => [`${target.workspaceId}:${target.projectId}`, target]));
  for (const target of targets.values()) await authorizePmTarget(target, headers);
}
async function detail(run: CollaborationRun, headers: Headers): Promise<RunDetailResponse> {
  const visibleRun = await projectCollaborationRun(run, headers);
  const delegations = await Promise.all(listCollaborationDelegations(run.id).map(async delegation => {
    for (const target of collaborationDelegationReadTargets(delegation.id)) await authorizePmTarget(target, headers);
    const resultRefs = await projectCollaborationResultRefs(delegation.resultRefs, run.rootRunId, headers);
    return { ...delegation, resultRefs, error: delegation.error && resultRefs.some(result => result.visibility !== 'visible')
      ? { code: delegation.error.code, message: 'Error details are currently hidden by the original PM visibility projector.' } : delegation.error };
  }));
  return { run: visibleRun, delegations,
    discussion: await readCollaborationDiscussion(run.target, headers), evidence: [
    ...run.resultRefs.map(result => ({ kind: 'native_output' as const, id: result.generationId, threadId: result.threadId, generationId: result.generationId, href: `/api/collaboration/runs/${encodeURIComponent(run.id)}/generations/${encodeURIComponent(result.generationId)}/output` })),
    ...run.operationRefs.filter(item => item.kind === 'pm_tool' || item.kind === 'comment').map(item => ({ kind: item.kind === 'comment' ? 'comment' as const : 'pm_operation' as const,
      id: item.operationId, threadId: run.threadId, generationId: run.generationId, href: item.kind === 'comment' ? `/api/collaboration/runs/${encodeURIComponent(run.id)}/operations/${encodeURIComponent(item.operationId)}` : `/api/pm-tools/calls/${encodeURIComponent(item.operationId)}` })),
  ] };
}
export const runRoutes = new Hono();
runRoutes.use('/collaboration/runs/*', bodyLimit({ maxSize: 256 * 1024 }));
runRoutes.use('/collaboration/runs', bodyLimit({ maxSize: 256 * 1024 }));
runRoutes.use('/collaboration/runs/*', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); });
runRoutes.use('/collaboration/runs', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); });
runRoutes.onError((error, c) => {
  if (error instanceof DurableError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid collaboration Run request.', code: 'invalid_request' }, 400);
  return c.json({ error: 'Run service is unavailable. Query the original Run ID before any retry.', code: 'run_unavailable' }, 503);
});
runRoutes.get('/collaboration/runs', async c => {
  const query = runsQuerySchema.parse(c.req.query());
  await authorizePmTarget({ workspaceId: query.workspaceId, projectId: query.projectId ?? null }, c.req.raw.headers);
  const visible: CollaborationRun[] = [];
  for (const run of listCollaborationRunsForInbox()) {
    if (run.target.workspaceId !== query.workspaceId || query.projectId && run.target.projectId !== query.projectId || query.taskId && run.target.taskId !== query.taskId) continue;
    try { await authorizeRead(run, c.req.raw.headers); visible.push(await projectCollaborationRun(run, c.req.raw.headers)); }
    catch (error) { if (!(error instanceof DurableError) || error.status !== 403 && error.status !== 404) throw error; }
  }
  return c.json({ runs: visible.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});
runRoutes.post('/collaboration/runs', async c => {
  const run = await createCollaborationRun(createRunSchema.parse(await c.req.json()), c.req.raw.headers);
  await authorizeRead(run, c.req.raw.headers);
  return c.json({ run: await projectCollaborationRun(run, c.req.raw.headers) });
});
runRoutes.get('/collaboration/runs/:id', async c => {
  const run = readCollaborationRun(c.req.param('id'));
  if (!run) throw new DurableError(404, 'run_not_found', 'No visible durable Run receipt exists yet. Absence does not prove an in-flight request was not accepted; do not automatically resend.');
  await authorizeRead(run, c.req.raw.headers);
  return c.json(await detail(run, c.req.raw.headers));
});
runRoutes.post('/collaboration/runs/:id/reconcile', async c => {
  const run = readCollaborationRun(c.req.param('id'));
  if (!run) throw new DurableError(404, 'run_not_found', 'Original Run receipt is unavailable.');
  await authorizeRead(run, c.req.raw.headers);
  return c.json(await detail(await reconcileCollaborationRun(run.id, c.req.raw.headers), c.req.raw.headers));
});
runRoutes.get('/collaboration/runs/:id/operations/:operationId', async c => {
  const run = readCollaborationRun(c.req.param('id'));
  if (!run) throw new DurableError(404, 'run_not_found', 'Original Run receipt is unavailable.');
  await authorizeRead(run, c.req.raw.headers);
  const operation = await getCollaborationOperation(run.id, c.req.param('operationId'), c.req.raw.headers);
  return c.json({ operation });
});
runRoutes.get('/collaboration/runs/:id/generations/:generationId/output', async c => {
  const run = readCollaborationRun(c.req.param('id'));
  if (!run) throw new DurableError(404, 'run_not_found', 'Original Run receipt is unavailable.');
  await authorizeRead(run, c.req.raw.headers);
  return c.json(await getCollaborationNativeOutput(run.id, c.req.param('generationId'), c.req.raw.headers));
});
runRoutes.post('/collaboration/runs/:id/cancel', async c => {
  const run = await cancelCollaborationRun(c.req.param('id'), cancelRunSchema.parse(await c.req.json()), c.req.raw.headers);
  await authorizeRead(run, c.req.raw.headers);
  return c.json({ run: await projectCollaborationRun(run, c.req.raw.headers) });
});
