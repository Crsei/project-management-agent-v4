// A surface can remount while its previous visit is still in flight. Share that
// operation, then read the authoritative revision before the next distinct visit.
const VISIT_TIMEOUT_MS = 15_000;

export function createSidebarVisitCoordinator<T extends { sidebar: { revision: number } }>(
  read: (threadId: string) => Promise<T>,
  visit: (threadId: string, revision: number) => Promise<T>,
) {
  const pending = new Map<string, Promise<T>>();
  return (threadId: string): Promise<T> => {
    const existing = pending.get(threadId);
    if (existing) return existing;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = Promise.race([
      read(threadId).then(thread => visit(threadId, thread.sidebar.revision)),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Session visit timed out; the view did not wait indefinitely.")), VISIT_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
      if (pending.get(threadId) === operation) pending.delete(threadId);
    });
    pending.set(threadId, operation);
    void operation.catch(() => {});
    return operation;
  };
}
