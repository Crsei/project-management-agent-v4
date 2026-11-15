import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { WorkspaceClientError, type WorkspaceClient } from "@agent-workspace/client-runtime";
import { executionEnvironmentSchema, type AgentWorkspace, type ChatGenerationView, type ExecutionEnvironment, type RemoteThread } from "@agent-workspace/contracts/chat";
import type { ProvidersResponse } from "@agent-workspace/contracts/provider";
import type { TurnContext } from "@agent-workspace/contracts/pm-references";
import { workspaceClient } from "../network.ts";
import { runBoardActivity, runBoardStopTargetMatches } from "./run-board-model.ts";
import { subscribeCollaborationAccess } from "../collaboration/data-model.ts";

export type RunBoardHistory = {
  headId: string | null;
  messages: {
    id: string;
    parent_id: string | null;
    format: string;
    content: {
      role: "system" | "user" | "assistant";
      parts: ({ type: string } & Record<string, unknown>)[];
      metadata?: unknown;
      [key: string]: unknown;
    };
    turnContext?: TurnContext;
  }[];
  activeGenerationId?: string;
  latestGeneration: ChatGenerationView | null;
};

type BoardSnapshot = {
  threads: RemoteThread[];
  workspaces: AgentWorkspace[];
  providers: ProvidersResponse["providers"];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  metadataError: string | null;
  loadedAt: string | null;
};
type HistorySnapshot = { data: RunBoardHistory | null; loading: boolean; error: string | null };
type ExecutionSnapshot = { environment: ExecutionEnvironment | null; loading: boolean; error: string | null };
type Client = Pick<WorkspaceClient, "json">;
type Listener = () => void;

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const isAuthorizationError = (cause: unknown): cause is WorkspaceClientError =>
  cause instanceof WorkspaceClientError && (cause.status === 401 || cause.status === 403);
const authorizationMessage = (cause: WorkspaceClientError) =>
  `Agent 访问授权失效（HTTP ${cause.status}）；已清除旧数据，请重新登录或刷新。`;
const emptyBoard = (): BoardSnapshot => ({ threads: [], workspaces: [], providers: [], loading: true, refreshing: false, error: null, metadataError: null, loadedAt: null });

export type RunBoardAccessScope = {
  revision: () => number;
  subscribe: (listener: (error: string) => void) => () => void;
  deny: (cause: WorkspaceClientError) => void;
};

/** Invalidation only, not a shared content cache or part of the Chat runtime. */
export function createRunBoardAccessScope(): RunBoardAccessScope {
  let revision = 0;
  const listeners = new Set<(error: string) => void>();
  return {
    revision: () => revision,
    subscribe(listener: (error: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    deny(cause: WorkspaceClientError) {
      revision += 1;
      for (const listener of listeners) listener(authorizationMessage(cause));
    },
  };
}
const boardAccess = createRunBoardAccessScope();

function observeAuthorization<T>(request: Promise<T>, access: RunBoardAccessScope, current: () => boolean): Promise<T> {
  return request.catch((cause: unknown) => {
    if (current() && isAuthorizationError(cause)) access.deny(cause);
    throw cause;
  });
}

function visible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function pollVisible(refresh: () => Promise<void>): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const refreshVisible = () => { if (visible()) void refresh(); };
  const interval = window.setInterval(refreshVisible, 5_000);
  window.addEventListener("focus", refreshVisible);
  window.addEventListener("online", refreshVisible);
  document.addEventListener("visibilitychange", refreshVisible);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener("focus", refreshVisible);
    window.removeEventListener("online", refreshVisible);
    document.removeEventListener("visibilitychange", refreshVisible);
  };
}

type ReadOperation = { controller: AbortController; promise: Promise<void> };

/** One instance per board mount. Reads and mutations never touch Chat's stores. */
export function createRunBoardData(client: Client = workspaceClient, access: RunBoardAccessScope = boardAccess, now = () => new Date().toISOString()) {
  let snapshot = emptyBoard();
  let active = false;
  let pending: ReadOperation | null = null;
  const listeners = new Set<Listener>();
  const actionReads = new Set<AbortController>();
  const stopping = new Set<string>();
  const publish = (next: BoardSnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
  const invalidate = (error: string) => {
    pending?.controller.abort();
    pending = null;
    for (const controller of actionReads) controller.abort();
    publish({ ...emptyBoard(), loading: false, error });
  };

  const refresh = (): Promise<void> => {
    if (!active) return Promise.resolve();
    if (pending) return pending.promise;
    const controller = new AbortController();
    const revision = access.revision();
    const current = () => active && !controller.signal.aborted && revision === access.revision();
    publish({ ...snapshot, loading: snapshot.loadedAt === null, refreshing: true });
    const read = <T,>(path: string) => observeAuthorization(client.json<T>(path, { signal: controller.signal, cache: "no-store" }), access, current);
    const operation: ReadOperation = { controller, promise: Promise.resolve() };
    pending = operation;
    operation.promise = (async () => {
      const [threads, workspaces, providers] = await Promise.allSettled([
        read<{ threads: RemoteThread[] }>("/api/chat/threads").then(body => {
          if (!Array.isArray(body?.threads)) throw new Error("会话列表响应不兼容；未替换上次快照。");
          return body.threads.filter(thread => thread.status !== "archived");
        }),
        read<{ workspaces: AgentWorkspace[] }>("/api/agent-workspaces").then(body => {
          if (!Array.isArray(body?.workspaces)) throw new Error("文件夹元数据响应不兼容。");
          return body.workspaces;
        }),
        read<ProvidersResponse>("/api/providers").then(body => {
          if (!Array.isArray(body?.providers)) throw new Error("Provider 元数据响应不兼容。");
          return body.providers;
        }),
      ]);
      if (!current() || pending !== operation) return;
      const metadataErrors: string[] = [];
      if (workspaces.status === "rejected") metadataErrors.push(`文件夹：${message(workspaces.reason)}`);
      if (providers.status === "rejected") metadataErrors.push(`Provider：${message(providers.reason)}`);
      publish({
        threads: threads.status === "fulfilled" ? threads.value : snapshot.threads,
        workspaces: workspaces.status === "fulfilled" ? workspaces.value : snapshot.workspaces,
        providers: providers.status === "fulfilled" ? providers.value : snapshot.providers,
        loading: false,
        refreshing: false,
        error: threads.status === "rejected" ? message(threads.reason) : null,
        metadataError: metadataErrors.length ? metadataErrors.join("；") : null,
        loadedAt: threads.status === "fulfilled" ? now() : snapshot.loadedAt,
      });
    })().finally(() => { if (pending === operation) pending = null; });
    return operation.promise;
  };

  // A refresh already in flight can predate the stop. Await it, then read again.
  const reconcile = async () => {
    if (pending) await pending.promise;
    if (!active) throw new Error("运行面板已关闭；请重新打开会话核对原停止请求。");
    await refresh();
    if (snapshot.error || !snapshot.loadedAt) throw new Error(snapshot.error || "未取得当前会话快照。");
  };

  const stop = async (threadId: string, generationId: string): Promise<void> => {
    if (stopping.has(threadId)) throw new Error("该会话的停止请求仍在核对；不会重复提交。");
    const observed = snapshot.threads.find(thread => thread.remoteId === threadId);
    if (!active || snapshot.error || !snapshot.loadedAt || !observed || !runBoardStopTargetMatches(observed, threadId, generationId))
      throw new Error("停止目标不可用或快照已过期；请先刷新并确认当前生成。");
    stopping.add(threadId);
    const controller = new AbortController();
    actionReads.add(controller);
    const revision = access.revision();
    const current = () => active && !controller.signal.aborted && revision === access.revision();
    let submitted = false;
    let failure: unknown;
    try {
      const result = await observeAuthorization(client.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(threadId)}`, { signal: controller.signal, cache: "no-store" }), access, current);
      if (!current()) throw new Error("访问状态已改变；未提交停止请求。");
      if (!result?.thread || !runBoardStopTargetMatches(result.thread, threadId, generationId))
        throw new Error("当前活动生成已改变；未提交停止请求，请核对刷新后的会话。");
      submitted = true;
      // Never abort/replay a submitted mutation when the page closes. Its result
      // may be uncertain; disconnecting reads must not send another cancellation.
      const response = await observeAuthorization(client.json<{ cancelled: true }>(`/api/chat/threads/${encodeURIComponent(threadId)}/cancel`, {
        method: "POST", body: JSON.stringify({ generationId }),
      }), access, current);
      if (response?.cancelled !== true) throw new Error("服务端未确认停止请求。");
    } catch (cause) {
      failure = cause;
    } finally {
      actionReads.delete(controller);
    }
    try {
      await reconcile();
      const currentThread = snapshot.threads.find(thread => thread.remoteId === threadId);
      const currentActivity = currentThread ? runBoardActivity(currentThread) : null;
      if (!failure) {
        if (!currentThread || !currentActivity || currentActivity.status === "unknown" || (currentActivity.active && !currentActivity.generationId))
          failure = new Error("当前快照无法确认目标会话的活动状态；请在原会话中核对停止结果。");
        else if (runBoardStopTargetMatches(currentThread, threadId, generationId))
          failure = new Error("服务端仍报告该生成处于活动状态；停止尚未确认。");
      }
    } catch (cause) {
      failure = new Error(`${failure ? `${message(failure)}；` : ""}状态核对失败：${message(cause)}`);
    } finally {
      stopping.delete(threadId);
    }
    if (failure) throw new Error(`${submitted ? "停止结果未确认" : "未提交停止请求"}：${message(failure)}。原请求不会自动重发；请核对当前状态。`);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    stop,
    start() {
      active = true;
      const unsubscribe = access.subscribe(invalidate);
      const unpoll = pollVisible(refresh);
      if (visible()) void refresh();
      return () => {
        active = false;
        pending?.controller.abort();
        pending = null;
        for (const controller of actionReads) controller.abort();
        actionReads.clear();
        unsubscribe();
        unpoll();
      };
    },
  };
}

/** Selection belongs to the instance: a prior thread cannot populate a new one. */
export function createRunBoardHistoryData(threadId: string | null, client: Client = workspaceClient, access: RunBoardAccessScope = boardAccess) {
  let snapshot: HistorySnapshot = { data: null, loading: threadId !== null, error: null };
  let active = false;
  let pending: ReadOperation | null = null;
  const listeners = new Set<Listener>();
  const publish = (next: HistorySnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
  const invalidate = (error: string) => {
    pending?.controller.abort();
    pending = null;
    publish({ data: null, loading: false, error });
  };
  const refresh = (): Promise<void> => {
    if (!active || threadId === null) return Promise.resolve();
    if (pending) return pending.promise;
    const controller = new AbortController();
    const revision = access.revision();
    const current = () => active && !controller.signal.aborted && revision === access.revision();
    const operation: ReadOperation = { controller, promise: Promise.resolve() };
    pending = operation;
    publish({ ...snapshot, loading: true });
    operation.promise = observeAuthorization(client.json<RunBoardHistory>(`/api/chat/threads/${encodeURIComponent(threadId)}/history?format=ai-sdk/v6`, { signal: controller.signal, cache: "no-store" }), access, current)
      .then(data => {
        if (!Array.isArray(data?.messages)) throw new Error("会话历史响应不兼容。");
        if (current() && pending === operation) publish({ data, loading: false, error: null });
      }).catch((cause: unknown) => {
        if (current() && pending === operation) publish({
          data: cause instanceof WorkspaceClientError && cause.status === 404 ? null : snapshot.data,
          loading: false, error: message(cause),
        });
      }).finally(() => { if (pending === operation) pending = null; });
    return operation.promise;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    start() {
      active = true;
      const unsubscribe = access.subscribe(invalidate);
      const unpoll = threadId === null ? () => {} : pollVisible(refresh);
      if (visible()) void refresh();
      return () => { active = false; pending?.controller.abort(); pending = null; unsubscribe(); unpoll(); };
    },
  };
}

/** Resolve only the selected Session; never open a terminal or infer a directory. */
export function createRunBoardExecutionData(threadId: string | null, client: Client = workspaceClient, access: RunBoardAccessScope = boardAccess) {
  let snapshot: ExecutionSnapshot = { environment: null, loading: threadId !== null, error: null };
  let active = false;
  let pending: ReadOperation | null = null;
  const listeners = new Set<Listener>();
  const publish = (next: ExecutionSnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
  const invalidate = (error: string) => {
    pending?.controller.abort();
    pending = null;
    publish({ environment: null, loading: false, error });
  };
  const refresh = (): Promise<void> => {
    if (!active || threadId === null) return Promise.resolve();
    if (pending) return pending.promise;
    const controller = new AbortController();
    const revision = access.revision();
    const current = () => active && !controller.signal.aborted && revision === access.revision();
    const operation: ReadOperation = { controller, promise: Promise.resolve() };
    pending = operation;
    // Keep the last verified same-Session link stable during background reads.
    // A failed read clears it below; Chat revalidates before opening any PTY.
    publish({ ...snapshot, loading: true, error: null });
    operation.promise = client.json<{ environment: unknown }>(`/api/chat/threads/${encodeURIComponent(threadId)}/execution`, { signal: controller.signal, cache: "no-store" })
      .then(data => {
        const environment = executionEnvironmentSchema.parse(data?.environment);
        if (current() && pending === operation) publish({ environment, loading: false, error: null });
      }).catch((cause: unknown) => {
        // This endpoint also checks the selected Session's PM target. Its explicit
        // resource denial must not revoke unrelated Agent Sessions or their history.
        if (current() && isAuthorizationError(cause) && !(cause.status === 403 && cause.code === "pm_reference_forbidden")) access.deny(cause);
        if (current() && pending === operation) publish({ environment: null, loading: false, error: message(cause) });
      }).finally(() => { if (pending === operation) pending = null; });
    return operation.promise;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    start() {
      active = true;
      const unsubscribe = access.subscribe(invalidate);
      const unpoll = threadId === null ? () => {} : pollVisible(refresh);
      if (visible()) void refresh();
      return () => { active = false; pending?.controller.abort(); pending = null; unsubscribe(); unpoll(); };
    },
  };
}

/** A denied board read must also hide the shared Chat sidebar's cached content. */
export function useRunBoardAccessError(): string | null {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const unsubscribeBoard = boardAccess.subscribe(setError);
    const unsubscribeCollaboration = subscribeCollaborationAccess(cause => {
      // A PM resource denial must not revoke unrelated Agent Sessions.
      if (cause instanceof WorkspaceClientError && cause.kind === "http" && cause.status === 401 && cause.code === "access_required") boardAccess.deny(cause);
    });
    return () => { unsubscribeCollaboration(); unsubscribeBoard(); };
  }, []);
  return error;
}

export function useRunBoard(): BoardSnapshot & { refresh: () => Promise<void>; stop: (threadId: string, generationId: string) => Promise<void> } {
  const store = useMemo(() => createRunBoardData(), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(store.start, [store]);
  return { ...snapshot, refresh: store.refresh, stop: store.stop };
}

export function useRunBoardHistory(threadId: string | null): HistorySnapshot & { refresh: () => Promise<void> } {
  const store = useMemo(() => createRunBoardHistoryData(threadId), [threadId]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(store.start, [store]);
  return { ...snapshot, refresh: store.refresh };
}

export function useRunBoardExecution(threadId: string | null, revision?: number): ExecutionSnapshot & { refresh: () => Promise<void> } {
  const store = useMemo(() => createRunBoardExecutionData(threadId), [threadId, revision]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(store.start, [store]);
  return { ...snapshot, refresh: store.refresh };
}
