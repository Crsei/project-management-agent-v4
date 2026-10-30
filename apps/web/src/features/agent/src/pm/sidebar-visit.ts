// A surface can remount while its previous visit is still in flight. Share that
// operation, then read the authoritative revision before the next distinct visit.
export function createSidebarVisitCoordinator<T extends { sidebar: { revision: number } }>(
  read: (threadId: string) => Promise<T>,
  visit: (threadId: string, revision: number) => Promise<T>,
) {
  const pending = new Map<string, Promise<T>>();
  return (threadId: string): Promise<T> => {
    const existing = pending.get(threadId);
    if (existing) return existing;
    const operation = read(threadId).then(thread => visit(threadId, thread.sidebar.revision));
    pending.set(threadId, operation);
    void operation.finally(() => { if (pending.get(threadId) === operation) pending.delete(threadId); }).catch(() => {});
    return operation;
  };
}
