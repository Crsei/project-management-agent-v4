import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import type { WorkflowDefinition, WorkflowRun } from '../../../../../packages/contracts/src/task-workflow.ts';
import { DurableError } from '../durable/errors.ts';
import { listRecords, readRecord, transaction, writeRecord } from '../durable/store.ts';

const definitions = 'task-workflow-definitions-v1', runs = 'task-workflow-runs-v1';
export const workflowStore = {
  readDefinition: (id: string) => readRecord<WorkflowDefinition>(definitions, id),
  definitions: () => listRecords<WorkflowDefinition>(definitions),
  saveDefinition: (v: WorkflowDefinition) => transaction(() => {
    const old = readRecord<WorkflowDefinition>(definitions, v.id);
    if ((old?.revision ?? 0) !== v.revision - 1 || (old && (old.workspaceId !== v.workspaceId || old.projectId !== v.projectId))) throw new DurableError(409, 'workflow_conflict', '工作流版本冲突。');
    writeRecord(definitions, v.id, v);
  }),
  readRun: (id: string) => readRecord<WorkflowRun>(runs, id),
  runs: () => listRecords<WorkflowRun>(runs),
  saveRun: (v: WorkflowRun) => transaction(() => {
    const old = readRecord<WorkflowRun>(runs, v.id);
    if ((old?.version ?? 0) !== v.version - 1 || (!old && listRecords<WorkflowRun>(runs).some(r => r.input.workspaceId === v.input.workspaceId && r.input.taskId === v.input.taskId))) throw new DurableError(409, 'workflow_conflict', '任务已有运行或运行版本已变化。');
    if (!old && listRecords<TaskCodeDelivery>('task-code-delivery-v1').some(d => d.workspaceId === v.input.workspaceId && d.taskId === v.input.taskId)) throw new DurableError(409, 'workflow_conflict', '任务已有手动交付。');
    writeRecord(runs, v.id, v);
  }),
};
