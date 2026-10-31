import { workflowStore } from "../task-workflows/store.ts";
import { resolveProviderRuntime } from '../providers/runtime.ts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { UIMessage } from 'ai';
import { deliveryActionSchema, deliveryScopeSchema, prepareDeliverySchema } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { DeliveryError, TaskCodeDeliveryService } from '../../../../../packages/application/src/task-code-delivery.ts';
import { DurableError } from '../durable/errors.ts';
import { getActiveChat, listChatGenerations, submitChat } from '../durable/chat-runtime.ts';
import { ensureThread, getThread, getThreadBranch, updateThread } from '../durable/threads.ts';
import { deliveryStore } from './binding.ts';
import { authorizeDelivery } from './authority.ts';
import { git, preflightPrepare, reconcileCommit, commitTree, prepareWorktree, pushTree, readRemoteHead, readTree, testTree, verifyWorktree } from './git.ts';
import { DeliveryGitHub } from './github.ts';

const active = new Set<string>();
const github = new DeliveryGitHub();
export function deliveryService(headers: Headers) {
  return new TaskCodeDeliveryService({
    ...deliveryStore,
    authorize: (scope, write) => authorizeDelivery(scope, write, headers),
    preflightPrepare, reconcileCommit,
    preflightAction: async (v, action) => {
      if (action.action === 'develop') await resolveProviderRuntime({ providerInstanceId: action.providerInstanceId, modelName: action.model });
      if (action.action === 'commit') { await git(v.git!.directory, 'config', 'user.name'); await git(v.git!.directory, 'config', 'user.email'); }
      if (action.action === 'push') await readRemoteHead(v);
      if (action.action === 'draft-pr') await github.find(v);
    },
    prepare: prepareWorktree, verify: verifyWorktree, tree: v => readTree(v), test: testTree, commit: commitTree, push: pushTree, remoteHead: readRemoteHead,
    findPr: v => github.find(v), createPr: v => github.create(v), feedback: v => github.feedback(v),
    busy: v => !!getActiveChat(v.threadId),
    generation: v => { const generation = listChatGenerations(v.threadId).find(g => g.request.idempotencyKey === v.generationKey); return generation ? { id: generation.id, status: generation.status } : null; },
    develop: async (v, providerInstanceId, model) => {
      ensureThread(v.threadId, `${v.taskId} · ${v.title}`, { workspaceId: v.workspaceId, projectId: v.projectId }, { taskId: v.taskId, entityId: null });
      const thread = getThread(v.threadId)!;
      const next = updateThread(v.threadId, { revision: thread.revision, settings: { ...thread.settings, providerInstanceId, model, modelOptions: [] } });
      const request = await submitChat({ id: v.threadId, idempotencyKey: v.generationKey!, trigger: 'submit-message', messages: [
        ...getThreadBranch(v.threadId).map(entry => ({ id: entry.id, ...entry.content }) as UIMessage),
        { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: `${v.developmentPurpose === 'analysis' ? '只读分析以下任务与代码，输出实现建议、风险、验收标准草稿；不要修改文件或运行有写入副作用的命令。' : '在本次独立工作目录中开发并验证下面任务。'}遵守仓库 AGENTS.md。不要提交、推送、创建 PR、合并、部署或修改 PM 任务状态；这些步骤由用户在任务交付入口分别确认。不要读取或输出凭据。先检查工作目录与现有改动，不覆盖他人内容。完成后说明代码变更、实际运行的验证、失败和未验证项。\n\n任务 ${v.taskId}（版本 ${v.taskRevision}）\n${v.title}\n\n${v.description}\n\n本次节点要求：${v.developmentInstruction ?? ''}` }] },
      ], config: { providerInstanceId, modelName: model, threadSettingsRevision: next.revision } }, undefined, headers);
      return request.id;
    },
  }, active);
}
export const taskDeliveryRoutes = new Hono();
taskDeliveryRoutes.use('/task-deliveries/*', bodyLimit({ maxSize: 32 * 1024 }));
taskDeliveryRoutes.use('/task-deliveries', bodyLimit({ maxSize: 32 * 1024 }));
taskDeliveryRoutes.onError((error, c) => {
  if (error instanceof DurableError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof DeliveryError) return c.json({ error: error.message, code: error.code }, error.code === 'not_found' ? 404 : 409);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: '请求或上游数据格式无效。' }, 400);
  return c.json({ error: '交付服务暂不可用。请先读取现有记录核对，勿重复执行副作用。' }, 503);
});
taskDeliveryRoutes.get('/task-deliveries', async c => c.json({ items: await deliveryService(c.req.raw.headers).list(deliveryScopeSchema.parse(c.req.query())) }));
taskDeliveryRoutes.post('/task-deliveries', async c => {
  const input = prepareDeliverySchema.parse(await c.req.json());
  await authorizeDelivery(input, true, c.req.raw.headers);
  if (workflowStore.runs().some(v => v.input.workspaceId === input.workspaceId && v.input.taskId === input.taskId)) throw new DeliveryError('workflow_managed', '此任务由工作流管理，请在工作流入口操作。');
  return c.json(await deliveryService(c.req.raw.headers).prepare(input));
});
taskDeliveryRoutes.get('/task-deliveries/:id', async c => c.json(await deliveryService(c.req.raw.headers).inspect(z.uuid().parse(c.req.param('id')))));
taskDeliveryRoutes.post('/task-deliveries/:id/actions', async c => {
  const id = z.uuid().parse(c.req.param('id')), action = deliveryActionSchema.parse(await c.req.json());
  if (action.action !== 'refresh' && workflowStore.readRun(id)) {
    const value = deliveryStore.read(id);
    if (value) await authorizeDelivery(value, true, c.req.raw.headers);
    throw new DeliveryError('workflow_managed', '此交付由工作流管理，不能手动穿插修改。');
  }
  return c.json(await deliveryService(c.req.raw.headers).act(id, action));
});
