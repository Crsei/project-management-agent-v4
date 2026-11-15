import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type { RemoteThread } from "@agent-workspace/contracts/chat";

type TitleClient = { json<T>(path: string, init?: RequestInit): Promise<T> };
type TitleChunk = { readonly path: readonly number[] } & (
  | { type: "part-start"; part: { type: "text" } }
  | { type: "text-delta"; textDelta: string }
  | { type: "part-finish" }
);

/** Keep saved titles verbatim; an absent title belongs to the localized UI fallback. */
export function storedThreadTitle(thread: Pick<RemoteThread, "title">): string | undefined {
  return thread.title?.trim() ? thread.title : undefined;
}

/**
 * assistant-ui calls its required title hook automatically. Only read the saved
 * title here: inference is the explicit, revision-guarded regenerate-title action.
 * In particular, this read must never write an old snapshot over a concurrent rename.
 */
export function createStoredThreadTitleReader(client: TitleClient): RemoteThreadListAdapter["generateTitle"] {
  return async (id) => {
    const { thread } = await client.json<{ thread: Pick<RemoteThread, "title"> }>(
      `/api/chat/threads/${encodeURIComponent(id)}`,
      { cache: "no-store" },
    );
    const title = storedThreadTitle(thread);
    return new ReadableStream<TitleChunk>({
      start(controller) {
        if (title !== undefined) {
          controller.enqueue({ type: "part-start", path: [0], part: { type: "text" } });
          controller.enqueue({ type: "text-delta", path: [0], textDelta: title });
          controller.enqueue({ type: "part-finish", path: [0] });
        }
        controller.close();
      },
    });
  };
}
