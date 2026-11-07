import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import {
  useAui,
  useAuiState,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
  type MessageFormatAdapter,
  type MessageFormatItem,
  type GenericThreadHistoryAdapter,
  type MessageStorageEntry,
} from "@assistant-ui/react";
import { createSimpleTitleAdapter } from "@assistant-ui/core/react";
import { workspaceClient } from "../network";
import { agentText } from "../i18n-text.ts";
import type { ChatGenerationView, RemoteThread } from "@agent-workspace/contracts/chat";
import { chatStreams } from "./transport";
import { acceptRemoteThread, acceptRemoteThreads, reportThreadError, threadExecutionSelection } from "../pm/state";
import { acceptInitializedThread, acceptThreadSettings } from "../../hooks/use-chat-settings";

type Entry = {
  id: string;
  parent_id: string | null;
  format: string;
  content: Record<string, unknown>;
};
type HistoryResponse = {
  headId: string | null;
  messages: Entry[];
  activeGenerationId?: string;
  latestGeneration?: ChatGenerationView;
};

type HistoryLoadOutcome =
  | { status: "idle" | "loading" }
  | { status: "loaded"; messageCount: number }
  | { status: "error"; message: string };
const idleHistory: HistoryLoadOutcome = { status: "idle" };
export type HistoryLoadStore = {
  subscribe: (id: string, listener: () => void) => () => void;
  snapshot: (id: string) => HistoryLoadOutcome;
  begin: (id: string) => symbol;
  isCurrent: (id: string, request: symbol) => boolean;
  finish: (id: string, request: symbol, outcome: HistoryLoadOutcome) => void;
};

/** Status belongs to one mounted assistant runtime, never to a remote ID globally. */
export function createHistoryLoadStore(): HistoryLoadStore {
  const outcomes = new Map<string, HistoryLoadOutcome>();
  const listeners = new Map<string, Set<() => void>>();
  const requests = new Map<string, symbol>();
  const publish = (id: string, outcome: HistoryLoadOutcome) => {
    outcomes.set(id, outcome);
    for (const listener of listeners.get(id) ?? []) listener();
  };
  return {
    subscribe(id, listener) {
      const bucket = listeners.get(id) ?? new Set<() => void>();
      listeners.set(id, bucket);
      bucket.add(listener);
      return () => {
        bucket.delete(listener);
        if (!bucket.size) listeners.delete(id);
      };
    },
    snapshot: (id) => outcomes.get(id) ?? idleHistory,
    begin(id) {
      const request = Symbol();
      requests.set(id, request);
      publish(id, { status: "loading" });
      return request;
    },
    isCurrent: (id, request) => requests.get(id) === request,
    finish(id, request, outcome) {
      if (requests.get(id) !== request) return;
      requests.delete(id);
      publish(id, outcome);
    },
  };
}

export const HistoryLoadContext = createContext<HistoryLoadStore | null>(null);

/** Volatile load status only; message history remains owned by the runtime. */
export function useHistoryLoadOutcome(id: string): HistoryLoadOutcome {
  const store = useContext(HistoryLoadContext);
  const subscribe = useCallback((listener: () => void) => store?.subscribe(id, listener) ?? (() => {}), [store, id]);
  const snapshot = useCallback(() => store?.snapshot(id) ?? idleHistory, [store, id]);
  return useSyncExternalStore(subscribe, snapshot, () => idleHistory);
}
let reloadThreads: (() => Promise<void>) | undefined;
export function registerThreadListRefresh(reload: () => Promise<void>): () => void {
  reloadThreads = reload;
  return () => {
    if (reloadThreads === reload) reloadThreads = undefined;
  };
}
export async function refreshThreadList(): Promise<void> {
  await reloadThreads?.();
}
const metadata = (thread: RemoteThread) => {
  acceptRemoteThread(thread);
  acceptThreadSettings(thread);
  return {
    ...thread,
    lastMessageAt: thread.lastMessageAt ? new Date(thread.lastMessageAt) : undefined,
  };
};

export async function initializeAgentThread(id: string): Promise<{ remoteId: string }> {
  const { thread } = await workspaceClient.json<{ thread: RemoteThread }>("/api/chat/threads", {
    method: "POST",
    body: JSON.stringify({ id, executionSelection: threadExecutionSelection(id) }),
  });
  acceptInitializedThread(id, thread);
  acceptRemoteThread(thread);
  return { remoteId: id };
}

export function createServerThreadAdapter(historyStatus: HistoryLoadStore): RemoteThreadListAdapter {
  const patch = async (id: string, value: object) => {
    await workspaceClient.json(`/api/chat/threads/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(value),
    });
  };
  return {
    async list() {
      try {
        const body = await workspaceClient.json<{ threads: RemoteThread[] }>("/api/chat/threads");
        acceptRemoteThreads(body.threads);
        for (const thread of body.threads) acceptThreadSettings(thread);
        return { threads: body.threads.map((thread) => ({
          ...thread,
          lastMessageAt: thread.lastMessageAt ? new Date(thread.lastMessageAt) : undefined,
        })) };
      } catch (error) {
        reportThreadError(error);
        throw error;
      }
    },
    initialize: (threadId) => initializeAgentThread(threadId),
    async fetch(id) {
      return metadata(
        (
          await workspaceClient.json<{ thread: RemoteThread }>(
            `/api/chat/threads/${encodeURIComponent(id)}`,
          )
        ).thread,
      );
    },
    rename: (id, title) => patch(id, { title }),
    archive: (id) => patch(id, { status: "archived" }),
    unarchive: (id) => patch(id, { status: "regular" }),
    updateCustom: (id, custom) => patch(id, { custom }),
    async delete(id) {
      await workspaceClient.json(`/api/chat/threads/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
    async generateTitle(id, messages) {
      const title = await createSimpleTitleAdapter().generateTitle(messages);
      await patch(id, { title });
      type TitleChunk = { readonly path: readonly number[] } & (
        | { type: "part-start"; part: { type: "text" } }
        | { type: "text-delta"; textDelta: string }
        | { type: "part-finish" }
      );
      return new ReadableStream<TitleChunk>({
        start(controller) {
          controller.enqueue({ type: "part-start", path: [0], part: { type: "text" } });
          controller.enqueue({ type: "text-delta", path: [0], textDelta: title });
          controller.enqueue({ type: "part-finish", path: [0] });
          controller.close();
        },
      });
    },
    unstable_useAdapters: function useServerHistory() {
      const aui = useAui();
      const localId = useAuiState((state) => state.threadListItem.id);
      return useMemo(() => {
        // The synthesized adapter already has an item scope. The global thread
        // lookup can lag a newly fetched fork while React commits the list.
        const item = aui.threadListItem;
        let remoteId: string | undefined;
        const history: ThreadHistoryAdapter = {
          scopeId: localId,
          async load() {
            throw new Error(agentText("此运行时需要 assistant-ui 格式化历史适配器。", "This runtime requires an assistant-ui formatted history adapter."));
          },
          async append() {
            throw new Error(agentText("此运行时需要 assistant-ui 格式化历史适配器。", "This runtime requires an assistant-ui formatted history adapter."));
          },
          withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
            formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>,
          ): GenericThreadHistoryAdapter<TMessage> {
            const pin = () => {
              remoteId ??= item.getState().remoteId;
            };
            const save = async (entry: MessageFormatItem<TMessage>) => {
              remoteId ??= (await item.initialize()).remoteId;
              await workspaceClient.json(
                `/api/chat/threads/${encodeURIComponent(remoteId)}/history`,
                {
                  method: "PUT",
                  body: JSON.stringify({
                    id: formatAdapter.getId(entry.message),
                    parent_id: entry.parentId,
                    format: formatAdapter.format,
                    content: formatAdapter.encode(entry),
                  }),
                },
              );
            };
            return {
              pin,
              async load() {
                pin();
                if (!remoteId) return { messages: [] };
                const request = historyStatus.begin(localId);
                try {
                  const body = await workspaceClient.json<HistoryResponse>(
                    `/api/chat/threads/${encodeURIComponent(remoteId)}/history?format=${encodeURIComponent(formatAdapter.format)}`,
                  );
                  if (historyStatus.isCurrent(localId, request)) {
                    if (body.activeGenerationId)
                      chatStreams.setStreamId(body.activeGenerationId, localId);
                    else chatStreams.clear(localId);
                  }
                  const messages = body.messages.map((entry) =>
                    formatAdapter.decode(entry as MessageStorageEntry<TStorageFormat>),
                  );
                  historyStatus.finish(localId, request, { status: "loaded", messageCount: messages.length });
                  return { headId: body.headId, messages };
                } catch (error) {
                  historyStatus.finish(localId, request, { status: "error", message: error instanceof Error ? error.message : String(error) });
                  throw error;
                }
              },
              append: save,
              update: save,
            };
          },
        };
        return { history };
      }, [aui, localId]);
    },
  };
}
