import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { pmToolCapabilitiesSchema } from '../../../../../packages/agent-contracts/src/pm-capabilities.ts';
import type { DeliveryScope } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import type { DeliveryTask } from '../../../../../packages/application/src/task-code-delivery.ts';
import { DurableError } from '../durable/errors.ts';
import { resolveAgentExecution } from '../durable/agent-execution.ts';
import { executionSelectionSchema, type ExecutionSelection } from '@agent-workspace/contracts/chat';

const taskSchema = z.object({ id: z.string(), revision: z.string().min(1), entity: z.object({ entity: z.literal('work_item'), project: z.string(), title: z.string(), body: z.string(), status: z.string().optional(), archived: z.boolean().optional() }) });
export async function requestDeliveryPm(endpoint: string, requestHeaders?: Headers, body?: unknown): Promise<unknown> {
  const origin = new URL(process.env.PM_API_URL?.trim() || 'http://127.0.0.1:4194');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new DurableError(503, 'pm_unavailable', 'PM 地址无效。');
  const headers = new Headers({ accept: 'application/json' });
  for (const name of ['cookie', 'authorization']) { const value = requestHeaders?.get(name); if (value) headers.set(name, value); }
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(new URL(endpoint, origin.origin), { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) { await response.body?.cancel(); throw new DurableError(response.status === 401 ? 401 : response.status === 403 || response.status === 404 ? 403 : response.status === 409 || response.status === 422 ? 409 : 503, 'task_unavailable', body === undefined ? '任务不可访问，请检查 PM 登录与当前项目权限。' : 'PM 状态转换未确认：请核对原收据、任务状态/版本、权限及配置状态边。'); }
  return response.json();
}
export async function authorizeDelivery(scope: DeliveryScope & { executionSelection?: ExecutionSelection | undefined }, write: boolean, requestHeaders?: Headers): Promise<DeliveryTask> {
  const read = (endpoint: string) => requestDeliveryPm(endpoint, requestHeaders);
  const file = taskSchema.parse(await read(`/api/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/core/files/${encodeURIComponent(scope.taskId)}`));
  if (file.id !== scope.taskId || file.entity.project !== scope.projectId || file.entity.archived) throw new DurableError(409, 'task_scope_changed', '任务已归档或不属于当前项目。');
  if (write) {
    const caps = pmToolCapabilitiesSchema.parse(await read(`/api/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/agent-capabilities?projectId=${encodeURIComponent(scope.projectId)}`));
    if (!caps.tools.some(tool => tool.name === 'pm_update_task' && tool.allowed)) throw new DurableError(403, 'delivery_denied', '启动或发布任务代码需要当前项目的 planning.edit 能力。');
  }
  const selection = scope.executionSelection;
  let root = '';
  if (selection) {
    const parsed = executionSelectionSchema.safeParse(selection);
    if (!parsed.success || parsed.data.agentWorkspaceId === null) {
      if (write) throw new DurableError(412, 'agent_workspace_required', '代码交付必须明确选择一个有效的 Agent 目录。');
    } else {
      const snapshot = await resolveAgentExecution(parsed.data);
      root = await realpath(snapshot.path);
    }
  }
  return { ...scope, revision: file.revision, title: file.entity.title, description: file.entity.body, root, ...(file.entity.status ? { status: file.entity.status } : {}) };
}
