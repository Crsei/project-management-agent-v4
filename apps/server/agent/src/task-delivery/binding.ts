import { workflowTaskRevision, type WorkflowRun } from '../../../../../packages/contracts/src/task-workflow.ts';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { listRecords, readRecord, writeRecord, transaction } from '../durable/store.ts';
import { resolveAgentExecution, sameExecutionIdentity, type AgentExecutionSnapshot } from '../durable/agent-execution.ts';
import { DurableError } from '../durable/errors.ts';
import type { ThreadMetadata } from '../durable/threads.ts';
import { authorizeDelivery } from './authority.ts';
import { verifyWorktree } from './git.ts';
import { resolveSessionNativeTemplateSnapshot } from '../automation-execution/native-templates/repository.ts';
import { executionSelectionSchema } from '@agent-workspace/contracts/chat';
import { authorizeAutomationNativeThreadExecution } from '../automation-execution/context.ts';

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
export async function resolveChatExecutionScope(thread: ThreadMetadata, headers?: Headers, purpose: 'execute' | 'inspect' = 'execute', signal?: AbortSignal): Promise<AgentExecutionSnapshot> {
  const selection = executionSelectionSchema.safeParse(thread.executionSelection);
  if (!selection.success) throw new DurableError(412, 'session_cutover_required', '旧会话不能继续执行；请创建新版 Session。');
  const original = await resolveAgentExecution(selection.data, thread.remoteId, signal);
  const persisted = thread.executionEnvironment;
  original.environment.frozen = persisted?.frozen ?? false;
  if (persisted?.frozen && (persisted.agentWorkspaceId !== original.environment.agentWorkspaceId ||
      persisted.agentWorkspaceRevision !== original.environment.agentWorkspaceRevision || persisted.sourcePath !== original.environment.sourcePath))
    throw new DurableError(409, 'execution_environment_changed', '执行环境已变化；不能为已有 Session 隐式改绑目录。');
  const delivery = deliveryStore.list().find(v => v.threadId === thread.remoteId);
  if (!delivery) {
    await authorizeAutomationNativeThreadExecution(thread.remoteId, original, purpose, signal);
    const actual = await resolveSessionNativeTemplateSnapshot(thread.remoteId, original, purpose);
    if (persisted?.frozen && (thread.executionPath && actual.path !== thread.executionPath || !sameExecutionIdentity(persisted, actual.environment)))
      throw new DurableError(409, 'execution_environment_changed', 'Session actual execution filesystem changed; no implicit rebind is permitted.');
    return actual;
  }
  const ownedSelection = executionSelectionSchema.safeParse(delivery.executionSelection);
  if (!delivery.git || !ownedSelection.success || ownedSelection.data.agentWorkspaceId === null ||
      ownedSelection.data.agentWorkspaceId !== selection.data.agentWorkspaceId || ownedSelection.data.agentWorkspaceRevision !== selection.data.agentWorkspaceRevision ||
      original.environment.sourcePath !== delivery.git.root ||
      (purpose === 'execute' && !(delivery.pending?.action === 'develop' || !delivery.pending && delivery.step === 'developing')))
    throw new DurableError(409, 'delivery_binding_changed', '交付会话目录或执行阶段已变化；请从任务交付入口启动开发。');
  if (purpose === 'execute') {
    const task = await authorizeDelivery(delivery, true, headers);
    if (task.root !== delivery.git.root || task.revision !== deliveryTaskRevision(delivery))
      throw new DurableError(409, 'delivery_binding_changed', '目录或任务需求版本已变化，停止执行。');
  }
  await verifyWorktree(delivery);
  const environment = { ...original.environment, executionPath: delivery.git.directory,
    worktree: { deliveryId: delivery.id, branch: delivery.git.branch } };
  if (persisted?.frozen && !sameExecutionIdentity(persisted, environment))
    throw new DurableError(409, 'execution_environment_changed', '交付工作树身份已变化；已有 Session 不会隐式改绑。');
  return { ...original, path: delivery.git.directory, environment,
    ...(purpose === 'execute' && delivery.worktreeWriteConfirmed === true ? { worktreeWriteConfirmed: true } : {}) };
}
