import type { FileRecord } from '../../pm-schema/index.ts';
import type { WorkflowTransitionRequest } from '../../contracts/src/task-workflow.ts';
import { DomainError } from '../../domain/src/core.ts';

/** Narrow policy for workflow-originated transitions; the native PM guard still owns permissions and configured edges. */
export function workflowTransitionChanges(request: WorkflowTransitionRequest, before: FileRecord): { status: string } {
  if (before.id !== request.taskId || before.entity.entity !== 'work_item' || before.entity.project !== request.projectId || before.entity.archived)
    throw new DomainError('workflow_task_scope', '任务已归档或项目归属已变化。', 409);
  if (before.revision !== request.revision) throw new DomainError('workflow_task_changed', '任务版本已变化，不覆盖人工修改。', 409);
  const allowed = request.phase === 'start' ? ['todo', 'in_progress'] : ['in_progress'];
  if (!allowed.includes(String(before.entity.status))) throw new DomainError('workflow_task_state', '任务当前状态不允许此联动，不会自动重开或回退。', 409);
  return { status: request.phase === 'start' ? 'in_progress' : 'review' };
}
