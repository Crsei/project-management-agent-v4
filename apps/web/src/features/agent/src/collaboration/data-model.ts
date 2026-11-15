export type Client = { json<T>(path: string, init?: RequestInit): Promise<T> };
export type ResourceSnapshot<T> = { data: T | null; error: string | null; accessDenied: boolean; loading: boolean; loadedAt: string | null };
type StateUpdate<T> = T | ((previous: T) => T);
const listeners = new Set<(cause: unknown) => void>();
let authorityRevision = 0;
export function restricted(cause: unknown): boolean {
  // Both transports expose HTTP status on Error: WorkspaceClientError and PM's PmApiError.
  // This only invalidates cached authority; it never grants access or decides a request's outcome.
  return cause instanceof Error && "status" in cause && (cause.status === 401 || cause.status === 403);
}
export const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
export function invalidateCollaborationAccess(cause?: unknown) {
  authorityRevision++;
  for (const listener of listeners) listener(cause);
}
export function subscribeCollaborationAccess(listener: (cause: unknown) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** A response is usable only in the authority epoch in which it was requested. */
export function captureCollaborationAuthority() {
  const revision = authorityRevision;
  return () => revision === authorityRevision;
}
/** Local copies (selection, confirmation, configuration drafts) share resource invalidation. */
export function createCollaborationLocalState<T>(initial: T, cleared: T) {
  let revision = authorityRevision;
  let value = initial;
  const subscriptions = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;
  const synchronize = () => {
    if (revision !== authorityRevision) { revision = authorityRevision; value = cleared; }
  };
  const clear = () => { synchronize(); for (const listener of subscriptions) listener(); };
  return {
    getSnapshot() { synchronize(); return value; },
    subscribe(listener: () => void) {
      subscriptions.add(listener);
      unsubscribe ??= subscribeCollaborationAccess(clear);
      return () => {
        subscriptions.delete(listener);
        if (!subscriptions.size) { unsubscribe?.(); unsubscribe = null; }
      };
    },
    set(next: StateUpdate<T>) {
      synchronize();
      value = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
      for (const listener of subscriptions) listener();
    },
  };
}
export async function collaborationJson<T>(path: string, init: RequestInit | undefined, client: Client): Promise<T> {
  const currentAuthority = captureCollaborationAuthority();
  try {
    const result = await client.json<T>(path, init);
    if (!currentAuthority()) throw new Error("访问授权已变化，已丢弃旧响应；原操作需只读核对。 / Access changed; the old response was discarded. Reconcile the original operation read-only.");
    return result;
  }
  catch (cause) { if (currentAuthority() && restricted(cause)) invalidateCollaborationAccess(cause); throw cause; }
}

/** Per-mount read model. A lost mutation is never retried by this read poller. */
export function createCollaborationResource<T>(path: string, client: Client, parse: (value: T) => T = value => value) {
  let snapshot: ResourceSnapshot<T> = { data: null, error: null, accessDenied: false, loading: true, loadedAt: null };
  let active = false;
  let pending: { controller: AbortController; promise: Promise<void> } | null = null;
  const subscriptions = new Set<() => void>();
  const publish = (next: ResourceSnapshot<T>) => { snapshot = next; for (const listener of subscriptions) listener(); };
  const clear = () => {
    pending?.controller.abort(); pending = null;
    publish({ data: null, loadedAt: null, loading: false, accessDenied: true, error: "Access is unavailable; restricted content was cleared." });
  };
  const refresh = (): Promise<void> => {
    if (!active) return Promise.resolve();
    if (pending) return pending.promise;
    const controller = new AbortController();
    const revision = authorityRevision;
    const current = () => active && !controller.signal.aborted && revision === authorityRevision;
    const operation = { controller, promise: Promise.resolve() };
    pending = operation;
    publish({ ...snapshot, loading: true });
    operation.promise = (async () => {
      try {
        const result = parse(await client.json<T>(path, { signal: controller.signal, cache: "no-store" }));
        if (current()) publish({ data: result, error: null, accessDenied: false, loading: false, loadedAt: new Date().toISOString() });
      } catch (cause) {
        if (!current()) return;
        if (restricted(cause)) { invalidateCollaborationAccess(cause); return; }
        publish({ ...snapshot, loading: false, accessDenied: false, error: errorText(cause) });
      } finally { if (pending === operation) pending = null; }
    })();
    return operation.promise;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { subscriptions.add(listener); return () => { subscriptions.delete(listener); }; },
    refresh,
    start() {
      active = true; listeners.add(clear); void refresh();
      const poll = () => { if (typeof document === "undefined" || document.visibilityState !== "hidden") void refresh(); };
      const timer = typeof window !== "undefined" ? window.setInterval(poll, 5000) : undefined;
      if (typeof window !== "undefined") { window.addEventListener("focus", poll); window.addEventListener("online", poll); document.addEventListener("visibilitychange", poll); }
      return () => {
        active = false; pending?.controller.abort(); pending = null; listeners.delete(clear);
        if (typeof window !== "undefined") { window.clearInterval(timer); window.removeEventListener("focus", poll); window.removeEventListener("online", poll); document.removeEventListener("visibilitychange", poll); }
      };
    },
  };
}
export function collaborationPath(resource: string, workspaceId: string, extra: Record<string, string> = {}): string | null {
  return workspaceId ? `/api/collaboration/${resource}?${new URLSearchParams({ workspaceId, ...extra })}` : null;
}
export function safeCollaborationHref(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return null;
  return value.startsWith("/agent/") || value.startsWith("/pm/") ? value : null;
}
