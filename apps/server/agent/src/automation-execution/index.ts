import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { studioExecutionRequestSchema } from '../../../../../packages/contracts/src/automation-studio.ts';
import { verifyAutomationServiceRequest } from '../../../../../packages/infrastructure/src/automation-execution-client.ts';
import { dispatchAutomationExecution, queryAutomationExecution, cancelAutomationExecution, runtimeCapabilities } from './service.ts';
export { startAutomationExecutionRuntime, stopAutomationExecutionRuntime } from './service.ts';

const scopeSchema = z.strictObject({ actorId: z.uuid(), workspaceId: z.uuid(), projectId: z.string().regex(/^PRJ-\d+$/) });
/** Separate from browser access: only the dedicated PM service HMAC admits calls. */
export const automationExecutionRoutes = new Hono();
automationExecutionRoutes.use('*', bodyLimit({ maxSize: 4 * 1024 * 1024 }));
automationExecutionRoutes.use('*', async (c, next) => {
  if (c.req.header('origin') || c.req.header('sec-fetch-site')) return c.json({ code: 'service_only', error: 'Automation runtime accepts authenticated service requests only.' }, 403);
  const body = await c.req.text();
  if (!verifyAutomationServiceRequest(c.req.method, new URL(c.req.url).pathname, body, c.req.raw.headers)) return c.json({ code: 'service_auth_required', error: 'Configure the dedicated PM automation service transport.' }, 401);
  return next();
});
automationExecutionRoutes.onError((error, c) => {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ code: 'invalid_request', error: 'Invalid immutable execution request.' }, 400);
  const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : null;
  if (status === 409) return c.json({ code: 'execution_conflict', error: 'Execution identity belongs to a different request.' }, 409);
  return c.json({ code: 'runtime_unavailable', error: 'Automation runtime could not confirm this operation. Reconcile the original execution identity.' }, 503);
});
automationExecutionRoutes.post('/capabilities', async c => c.json(await runtimeCapabilities(scopeSchema.parse(await c.req.json()))));
automationExecutionRoutes.post('/dispatch', async c => c.json(await dispatchAutomationExecution(studioExecutionRequestSchema.parse(await c.req.json())), 202));
automationExecutionRoutes.post('/query', async c => c.json(await queryAutomationExecution(studioExecutionRequestSchema.parse(await c.req.json()))));
automationExecutionRoutes.post('/cancel', async c => c.json(await cancelAutomationExecution(studioExecutionRequestSchema.parse(await c.req.json()))));
