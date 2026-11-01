import { workflowTaskRevision, type WorkflowRun } from '../../../../../packages/contracts/src/task-workflow.ts';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { listRecords, readRecord, writeRecord, transaction } from '../durable/store.ts';
import { resolveAgentScope, type AgentExecutionSnapshot } from '../durable/agent-scope.ts';
import { DurableError } from '../durable/errors.ts';
import type { ThreadMetadata } from '../durable/threads.ts';
import { authorizeDelivery } from './authority.ts';
import { verifyWorktree } from './git.ts';

const namespace = 'task-code-delivery-v1';
export function deliveryTaskRevision(delivery: TaskCodeDelivery): string {
  const run = readRecord<WorkflowRun>('task-workflow-runs-v1', delivery.id);
  if (!run || run.input.taskId !== delivery.taskId || run.input.workspaceId !== delivery.workspaceId || run.input.projectId !== delivery.projectId || run.input.taskRevision !== delivery.taskRevision) return delivery.taskRevision;
  return workflowTaskRevision(run);
}
export const deliveryStore = {
  read: (id: string) => readRecord<TaskCodeDelivery>(namespace, id),
  list: () => listRecords<TaskCodeDelivery>(namespace),
  save: (v: TaskCodeDelivery) => transaction(() => {
    const old = readRecord<TaskCodeDelivery>(namespace, v.id);
    if (old ? old.version !== v.version - 1 : v.version !== 1 || listRecords<TaskCodeDelivery>(namespace).some(other => other.workspaceId === v.workspaceId && other.taskId === v.taskId)) throw new DurableError(409, 'delivery_conflict', '交付记录已变化，请刷新核对。');
    if (!old && listRecords<WorkflowRun>('task-workflow-runs-v1').some(r => r.input.workspaceId === v.workspaceId && r.input.taskId === v.taskId && r.id !== v.id)) throw new DurableError(409, 'workflow_managed', '任务由工作流管理，不能创建第二条交付。');
    writeRecord(namespace, v.id, v);
  }),
};
/** Only a server-owned receipt can redirect execution; client-editable thread.custom is never authority. */
export async function resolveChatExecutionScope(thread: ThreadMetadata, headers?: Headers, purpose: 'execute' | 'inspect' = 'execute'): Promise<AgentExecutionSnapshot> {
  const original = await resolveAgentScope(thread.scope, headers);
  const delivery = deliveryStore.list().find(v => v.threadId === thread.remoteId);
  if (!delivery) return original;
  if (!delivery.git || delivery.workspaceId !== thread.scope?.workspaceId || delivery.projectId !== thread.scope.projectId || thread.pmContext?.taskId !== delivery.taskId || thread.pmContext.entityId !== null || (purpose === 'execute' && !(delivery.pending?.action === 'develop' || !delivery.pending && delivery.step === 'developing'))) throw new DurableError(409, 'delivery_binding_changed', '交付会话归属或执行阶段已变化；请从任务交付入口启动开发。');
  const task = await authorizeDelivery(delivery, purpose === 'execute', headers);
  if (task.root !== delivery.git.root || (purpose === 'execute' && task.revision !== deliveryTaskRevision(delivery))) throw new DurableError(409, 'delivery_binding_changed', '项目目录或任务需求版本已变化，停止执行。');
  await verifyWorktree(delivery);
  return { ...original, path: delivery.git.directory,
    ...(purpose === 'execute' && delivery.worktreeWriteConfirmed === true ? { worktreeWriteConfirmed: true } : {}) };
}
