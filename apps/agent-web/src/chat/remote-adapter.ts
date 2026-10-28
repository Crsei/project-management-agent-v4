import { useMemo } from "react";
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
import type { ChatGenerationView, RemoteThread } from "@agent-workspace/contracts/chat";
import { ensureChatMigration } from "./migration";
import { chatStreams } from "./transport";
import { acceptRemoteThread, acceptRemoteThreads, reportThreadError, threadScope } from "../pm/state";
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

export async function initializeScopedThread(id: string): Promise<{ remoteId: string }> {
  const scope = threadScope(id);
  if (!scope) throw new Error("请先选择工作区或项目，再新建会话。");
  await ensureChatMigration();
  const { thread } = await workspaceClient.json<{ thread: RemoteThread }>("/api/chat/threads", {
    method: "POST",
    body: JSON.stringify({ id, scope }),
  });
  acceptInitializedThread(id, thread);
  acceptRemoteThread(thread);
  return { remoteId: id };
}

export function createServerThreadAdapter(): RemoteThreadListAdapter {
  const patch = async (id: string, value: object) => {
    await workspaceClient.json(`/api/chat/threads/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(value),
    });
  };
  return {
    async list() {
      try {
        await ensureChatMigration();
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
    initialize: initializeScopedThread,
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
            throw new Error("此运行时需要 assistant-ui 格式化历史适配器。");
          },
          async append() {
            throw new Error("此运行时需要 assistant-ui 格式化历史适配器。");
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
                const body = await workspaceClient.json<HistoryResponse>(
                  `/api/chat/threads/${encodeURIComponent(remoteId)}/history?format=${encodeURIComponent(formatAdapter.format)}`,
                );
                if (body.activeGenerationId)
                  chatStreams.setStreamId(body.activeGenerationId, localId);
                else chatStreams.clear(localId);
                const messages = body.messages.map((entry) =>
                  formatAdapter.decode(entry as MessageStorageEntry<TStorageFormat>),
                );
                return { headId: body.headId, messages };
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
