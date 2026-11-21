import type { RemoteThread } from "@agent-workspace/contracts/chat";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import { workspaceClient } from "../network";

/** One automatic title attempt per Session per page load; manual regenerate stays available. */
const attempted = new Set<string>();

/** Ask the server for the isolated title only when it can produce one from saved text.
 * Failures stay silent: an untitled Session is still usable, and the sidebar refresh
 * picks up whatever authoritative title the server holds. */
export function requestMissingThreadTitle(
  thread: RemoteThread,
  accept: (thread: RemoteThread) => void,
  refresh: () => Promise<unknown>,
): void {
  const title = thread.title?.trim();
  if (title || thread.messageCount === 0 || thread.status !== "regular" || thread.sidebar.running || attempted.has(thread.remoteId)) return;
  attempted.add(thread.remoteId);
  void (async () => {
    try {
      const result = await workspaceClient.json<{ thread: RemoteThread }>(
        `/api/chat/threads/${encodeURIComponent(thread.remoteId)}/regenerate-title`,
        { method: "POST", body: JSON.stringify({ revision: thread.revision }) },
      );
      accept(result.thread);
      await refresh();
    } catch (error) {
      // A run that started after the guard was read can retry once it settles.
      if (error instanceof WorkspaceClientError && error.code === "chat_busy") attempted.delete(thread.remoteId);
      await refresh().catch(() => {});
    }
  })();
}
