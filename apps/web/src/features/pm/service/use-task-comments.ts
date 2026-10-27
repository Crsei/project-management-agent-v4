import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { ApiError, type TaskComment, type TaskCommentRevision } from '@contracts';
import { pmKeys } from './pm-data';
import { usePmCommand, usePmService, usePrivateQuery } from './pm-service';
import { createCommentDraftStore, settleCommentDraft, type CommentDraftStore } from './task-comments-model';

const stores = new Map<string, CommentDraftStore>();
export function useTaskCommentDrafts(taskId: string, projectId: string) {
  const { actor, workspace } = usePmService();
  const command = usePmCommand();
  const key = JSON.stringify(['pm-task-comment-drafts', window.location.origin, actor?.id, workspace?.id, projectId, taskId]);
  const store = useMemo(() => {
    let result = stores.get(key);
    if (!result) {
      result = createCommentDraftStore(key, { getItem: name => sessionStorage.getItem(name), setItem: (name, value) => sessionStorage.setItem(name, value) });
      stores.set(key, result);
    }
    return result;
  }, [key]);
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    if (!command.receipt) return;
    store.commit(current => Object.fromEntries(Object.entries(current).map(([id, draft]) => [id, draft.confirmed ? draft : settleCommentDraft(draft, command.receipt!)])));
  }, [command.receipt, store]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (store.persistenceError()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [store]);
  return { drafts, store };
}
export function useTaskComments(taskId: string, projectId: string) {
  const { actor, workspace } = usePmService();
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? 'anonymous', workspace?.id ?? 'none'), 'task-comments', projectId, taskId];
  return usePrivateQuery(key, 'domain.read', projectId, async (client, workspaceId, signal) => {
    const items = new Map<string, TaskComment>();
    const cursors = new Set<string>();
    let after: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await client.getTaskComments(workspaceId, taskId, { projectId, limit: 100, ...(after ? { after } : {}) }, { signal });
      if (page.taskId !== taskId || page.projectId !== projectId || page.items.some(item => item.taskId !== taskId || item.projectId !== projectId || item.workspaceId !== workspaceId) || page.nextCursor !== null && cursors.has(page.nextCursor)) throw new ApiError(502, { error: { code: 'invalid_response' } });
      for (const item of page.items) items.set(item.id, item);
      after = page.nextCursor ?? undefined;
      if (after) cursors.add(after);
    } while (after);
    return [...items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }, !!projectId && !!taskId);
}
export function useTaskCommentHistory(taskId: string, projectId: string, commentId: string, enabled: boolean) {
  const { actor, workspace } = usePmService();
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? 'anonymous', workspace?.id ?? 'none'), 'task-comments', projectId, taskId, 'history', commentId];
  return usePrivateQuery(key, 'domain.read', projectId, async (client, workspaceId, signal) => {
    const items: TaskCommentRevision[] = [];
    let after: number | undefined;
    do {
      signal.throwIfAborted();
      const page = await client.getTaskCommentHistory(workspaceId, taskId, commentId, { projectId, limit: 100, ...(after ? { after } : {}) }, { signal });
      if (page.taskId !== taskId || page.projectId !== projectId || page.commentId !== commentId || page.items.some(item => item.commentId !== commentId) || page.nextCursor !== null && page.nextCursor <= (after ?? 0)) throw new ApiError(502, { error: { code: 'invalid_response' } });
      items.push(...page.items);
      after = page.nextCursor ?? undefined;
    } while (after);
    return items;
  }, enabled);
}
