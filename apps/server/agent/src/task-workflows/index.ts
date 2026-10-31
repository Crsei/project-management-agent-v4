import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { deliveryScopeSchema } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { workflowSaveSchema, workflowStartSchema, workflowControlSchema } from '../../../../../packages/contracts/src/task-workflow.ts';
import { DeliveryError } from '../../../../../packages/application/src/task-code-delivery.ts';
import { DurableError } from '../durable/errors.ts';
import { workflowService } from './service.ts';
import { assertWorkflowRunner, scheduleWorkflow } from './runner.ts';
export const taskWorkflowRoutes = new Hono();
taskWorkflowRoutes.use('/task-workflows/*', bodyLimit({ maxSize: 96 * 1024 }));
taskWorkflowRoutes.use('/task-workflows', bodyLimit({ maxSize: 96 * 1024 }));
taskWorkflowRoutes.onError((error, c) => {
  if (error instanceof DurableError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof DeliveryError) return c.json({ error: error.message, code: error.code }, error.code === 'not_found' ? 404 : 409);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: '工作流请求或图格式无效。' }, 400);
  return c.json({ error: '工作流暂不可用，请核对登录、项目 Git 仓库与 Provider 就绪状态。' }, 503);
});
taskWorkflowRoutes.get('/task-workflows', async c => c.json(await workflowService(c.req.raw.headers).catalog(deliveryScopeSchema.parse(c.req.query()))));
taskWorkflowRoutes.post('/task-workflows/definitions', async c => c.json(await workflowService(c.req.raw.headers).saveDefinition(workflowSaveSchema.parse(await c.req.json()))));
taskWorkflowRoutes.post('/task-workflows/runs', async c => {
  assertWorkflowRunner();
  const value = await workflowService(c.req.raw.headers).start(workflowStartSchema.parse(await c.req.json()));
  if (['running', 'waiting'].includes(value.status)) scheduleWorkflow(value.id, c.req.raw.headers);
  return c.json(value);
});
taskWorkflowRoutes.get('/task-workflows/runs/:id', async c => c.json(await workflowService(c.req.raw.headers).read(z.uuid().parse(c.req.param('id')))));
taskWorkflowRoutes.post('/task-workflows/runs/:id/control', async c => {
  assertWorkflowRunner();
  const input = workflowControlSchema.parse(await c.req.json());
  const value = await workflowService(c.req.raw.headers).control(z.uuid().parse(c.req.param('id')), input.action, input.version);
  if (input.action !== 'pause') scheduleWorkflow(value.id, c.req.raw.headers);
  return c.json(value);
});
