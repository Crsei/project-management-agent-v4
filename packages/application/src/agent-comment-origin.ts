import { AsyncLocalStorage } from 'node:async_hooks';
import { taskCommentAgentOriginSchema, type TaskCommentAgentOrigin } from '../../domain/src/task-comments.ts';

const origin = new AsyncLocalStorage<TaskCommentAgentOrigin>();

/** In-process producer context. Only the PM route's verified service linkage may enter here. */
export function withAgentCommentOrigin<T>(value: TaskCommentAgentOrigin, operation: () => Promise<T>): Promise<T> {
  return origin.run(taskCommentAgentOriginSchema.parse(value), operation);
}

export function currentAgentCommentOrigin(): TaskCommentAgentOrigin | null {
  return origin.getStore() ?? null;
}
