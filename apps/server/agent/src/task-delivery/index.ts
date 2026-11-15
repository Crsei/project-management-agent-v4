import { checkRoadmapBase, inspectRoadmapDelivery } from './roadmap.ts';
import { roadmapDeliveryScopeSchema } from '../../../../../packages/contracts/src/product-roadmap.ts';
import { appPreviews } from './app-preview.ts';
import { appPreviewActionSchema } from '../../../../../packages/contracts/src/task-app-preview.ts';
import { workflowStore } from "../task-workflows/store.ts";
import { resolveProviderRuntime, type ProviderRuntime } from '../providers/runtime.ts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { UIMessage } from 'ai';
import { deliveryActionSchema, deliveryScopeSchema, prepareDeliverySchema } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { DeliveryError, TaskCodeDeliveryService } from '../../../../../packages/application/src/task-code-delivery.ts';
import { DurableError } from '../durable/errors.ts';
import { getActiveChat, submitChat } from '../durable/chat-runtime.ts';
import { CHAT_FORMAT, ensureThread, getThread, getThreadBranch, getThreadHistory, saveFormattedMessage, updateThread } from '../durable/threads.ts';
import { deliveryStore, deliveryTaskRevision, resolveChatExecutionScope } from './binding.ts';
import { authorizeDelivery } from './authority.ts';
import { git, preflightPrepare, reconcileCommit, commitTree, prepareWorktree, pushTree, readRemoteHead, readTree, testTree, verifyWorktree } from './git.ts';
import { DeliveryGitHub } from './github.ts';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { executionSelectionSchema } from '@agent-workspace/contracts/chat';
import { taskBriefStageSchema } from '@agent-workspace/contracts/task-brief';
import { deliveryGeneration, readTaskExecutionBrief, recordTaskExecutionInputProvenance, taskExecutionInput, taskExecutionPrompt } from './brief.ts';
import type { TaskExecutionBrief } from '../../../../../packages/contracts/src/task-execution-brief.ts';

const active = new Set<string>();
const github = new DeliveryGitHub();
export function deliveryService(headers: Headers) {
  const inputs = new Map<string, { runtime: ProviderRuntime; brief: TaskExecutionBrief; text: string }>();
  return new TaskCodeDeliveryService({
    ...deliveryStore,
    expectedTaskRevision: deliveryTaskRevision,
    authorize: (scope, write) => authorizeDelivery(scope, write, headers),
    preflightPrepare, reconcileCommit,
    preflightTask: (task, base) => checkRoadmapBase(task, base, headers),
    preflightAction: async (v, action) => {
      if (action.action === 'develop') {
        const runtime = await resolveProviderRuntime({ providerInstanceId: action.providerInstanceId, modelName: action.model });
        await checkRoadmapBase(await authorizeDelivery(v, true, headers), v.baseBranch, headers, v.git?.baseSha);
        const brief = await readTaskExecutionBrief(v.id, action.purpose ?? 'development', headers, false);
        if (brief.taskVersion.changed || brief.repository.status !== 'observed') throw new DeliveryError('task_changed', '当前需求或仓库无法核对；请重新读取并重新规划。');
        inputs.set(v.id, { runtime, brief, text: taskExecutionPrompt(brief, action.instruction ?? '', runtime) });
      }
      if (action.action === 'commit') { await git(v.git!.directory, 'config', 'user.name'); await git(v.git!.directory, 'config', 'user.email'); }
      if (action.action === 'push') await readRemoteHead(v);
      if (action.action === 'draft-pr') await github.find(v);
    },
    prepare: async (value, root, base) => {
      const binding = await prepareWorktree(value, root, base);
      await checkRoadmapBase({ ...value, root, revision: value.taskRevision }, base, headers, binding.baseSha);
      return binding;
    }, verify: verifyWorktree, tree: v => readTree(v), test: testTree, commit: commitTree, push: pushTree, remoteHead: readRemoteHead,
    findPr: v => github.find(v), createPr: v => github.create(v), feedback: v => github.feedback(v),
    busy: v => !!getActiveChat(v.threadId),
    generation: deliveryGeneration,
    develop: async (v, providerInstanceId, model) => {
      const selection = executionSelectionSchema.safeParse(v.executionSelection);
      if (!selection.success || selection.data.agentWorkspaceId === null) throw new DurableError(412, 'session_cutover_required', '交付缺少新版 Agent 目录选择；请明确创建新的 Session。');
      ensureThread(v.threadId, `${v.taskId} · ${v.title}`, selection.data);
      const thread = getThread(v.threadId)!;
      const next = updateThread(v.threadId, { revision: thread.revision, settings: { ...thread.settings, providerInstanceId, model, modelOptions: [] } });
      const input = inputs.get(v.id);
      if (!input) throw new DeliveryError('task_brief_missing', '没有派发前已核验的完整阶段简报。');
      const message = taskExecutionInput(input.brief, input.text);
      await recordTaskExecutionInputProvenance(input.brief, message.id, headers);
      const request = await submitChat({ id: v.threadId, idempotencyKey: v.generationKey!, trigger: 'submit-message', messages: [
        ...getThreadBranch(v.threadId).map(entry => ({ id: entry.id, ...entry.content }) as UIMessage),
        message,
      ], pmReferences: [{ workspaceId: v.workspaceId, projectId: v.projectId, kind: 'issue', id: v.taskId, revision: deliveryTaskRevision(v) }],
      config: { providerInstanceId, modelName: model, threadSettingsRevision: next.revision } }, input.runtime, headers);
      return request.id;
    },
  }, active);
}
export async function createDeliverySession(value: TaskCodeDelivery, headers: Headers): Promise<void> {
  const selection = executionSelectionSchema.safeParse(value.executionSelection);
  if (!selection.success || selection.data.agentWorkspaceId === null) throw new DurableError(412, 'agent_workspace_required', 'Select an Agent Workspace before creating a Session.');
  ensureThread(value.threadId, `${value.taskId} · ${value.title}`, selection.data);
  const snapshot = await resolveChatExecutionScope(getThread(value.threadId)!, headers, 'inspect');
  updateThread(value.threadId, { executionEnvironment: snapshot.environment });
  const messageId = `delivery-handoff:${value.id}:${value.threadId}`;
  if (getThreadHistory(value.threadId).messages.some(message => message.id === messageId)) return;
  const brief = await readTaskExecutionBrief(value.id, 'recovery', headers, false);
  const message = taskExecutionInput(brief, taskExecutionPrompt(brief, ''), messageId);
  await recordTaskExecutionInputProvenance(brief, message.id, headers);
  const { id, ...content } = message;
  const parent = getThreadBranch(value.threadId).at(-1)?.id ?? null;
  saveFormattedMessage(value.threadId, { id, parent_id: parent, format: CHAT_FORMAT, content }, true);
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
taskDeliveryRoutes.get('/task-deliveries/:id/brief', async c => {
  const query = z.strictObject({ stage: taskBriefStageSchema }).parse(c.req.query());
  return c.json(await readTaskExecutionBrief(z.uuid().parse(c.req.param('id')), query.stage, c.req.raw.headers));
});
taskDeliveryRoutes.post('/task-deliveries/:id/actions', async c => {
  const id = z.uuid().parse(c.req.param('id')), action = deliveryActionSchema.parse(await c.req.json());
  if (action.action !== 'refresh' && workflowStore.readRun(id)) {
    const value = deliveryStore.read(id);
    if (value) await authorizeDelivery(value, true, c.req.raw.headers);
    throw new DeliveryError('workflow_managed', '此交付由工作流管理，不能手动穿插修改。');
  }
  if (action.action === 'new-session') taskExecutionPrompt(await readTaskExecutionBrief(id, 'recovery', c.req.raw.headers, false), '');
  const result = await deliveryService(c.req.raw.headers).act(id, action);
  if (action.action === 'new-session') await createDeliverySession(result, c.req.raw.headers);
  return c.json(result);
});

async function authorizedPreview(id: string, write: boolean, headers: Headers, stopping = false) {
  const value = deliveryStore.read(id);
  if (!value) throw new DeliveryError('not_found', '交付记录不存在。');
  const task = await authorizeDelivery(value, write, headers);
  if (!stopping && (task.root !== value.git?.root || (write && task.revision !== deliveryTaskRevision(value)))) throw new DeliveryError('task_changed', '任务或项目目录已变化，请先核对。');
  return value;
}
taskDeliveryRoutes.get('/task-deliveries/:id/preview', async c => {
  const v = await authorizedPreview(z.uuid().parse(c.req.param('id')), false, c.req.raw.headers);
  return c.json(await appPreviews.inspect(v.id, await appPreviews.supported(v)));
});
taskDeliveryRoutes.post('/task-deliveries/:id/preview', async c => {
  const input = appPreviewActionSchema.parse(await c.req.json());
  const v = await authorizedPreview(z.uuid().parse(c.req.param('id')), true, c.req.raw.headers, input.action === 'stop');
  if (input.action === 'stop') { await appPreviews.stop(v.id); return c.json(appPreviews.state(v.id, await appPreviews.supported(v))); }
  return c.json(await appPreviews.start(v, input.head));
});

// Project preview can only reuse a verified, committed integration candidate; never merge code here.
taskDeliveryRoutes.get('/project-roadmap-deliveries', async c => {
  const { refresh, ...query } = c.req.query();
  return c.json(await inspectRoadmapDelivery(roadmapDeliveryScopeSchema.parse(query), c.req.raw.headers, refresh === '1'));
});
taskDeliveryRoutes.get('/project-app-previews/:id', async c => {
  const scope = roadmapDeliveryScopeSchema.parse(c.req.query()), id = z.uuid().parse(c.req.param('id'));
  const result = await inspectRoadmapDelivery(scope, c.req.raw.headers, false);
  if (!result.eligible || result.candidate?.id !== id) throw new DeliveryError('project_not_integrated', result.reason);
  const value = await authorizedPreview(id, false, c.req.raw.headers);
  return c.json(await appPreviews.inspect(id, await appPreviews.supported(value)));
});
taskDeliveryRoutes.post('/project-app-previews/:id', async c => {
  const scope = roadmapDeliveryScopeSchema.parse(c.req.query()), id = z.uuid().parse(c.req.param('id')), input = appPreviewActionSchema.parse(await c.req.json());
  const value = await authorizedPreview(id, true, c.req.raw.headers, input.action === 'stop');
  if (value.workspaceId !== scope.workspaceId || value.projectId !== scope.projectId) throw new DeliveryError('project_scope', '项目不一致。');
  if (input.action === 'stop') { await appPreviews.stop(id); return c.json(appPreviews.state(id, await appPreviews.supported(value))); }
  const result = await inspectRoadmapDelivery(scope, c.req.raw.headers, true);
  if (!result.eligible || result.candidate?.id !== id || result.candidate.head !== input.head) throw new DeliveryError('project_not_integrated', '集成证据已变化，请重新核对；没有启动预览。');
  return c.json(await appPreviews.start(value, input.head));
});
