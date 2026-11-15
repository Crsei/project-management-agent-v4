import type { ChatGenerationView } from "@agent-workspace/contracts/chat";
import { agentText } from "../i18n-text.ts";

export const HISTORY_PAGE_SIZE = 80;
export type HistoryEntry = {
  id: string;
  parent_id: string | null;
  format: string;
  content: Record<string, unknown>;
};
export type HistoryPage = {
  headId: string | null;
  messages: HistoryEntry[];
  activeGenerationId?: string;
  latestGeneration?: ChatGenerationView;
  page: { hasMore: boolean; beforeCursor: string | null; total: number; snapshot: string };
};

/**
 * assistant-ui requires every parent before importing its repository. Paging is
 * a transport boundary, not permission to truncate the model's selected branch.
 * Rendering is paged separately; editing/regeneration still see the full graph.
 */
export async function loadCompleteHistory(
  fetchPage: (before?: string) => Promise<HistoryPage>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Omit<HistoryPage, "page">> {
  const first = await fetchPage();
  const pages = [first.messages];
  const seenCursors = new Set<string>();
  let current = first;
  let loaded = first.messages.length;
  onProgress?.(loaded, first.page.total);
  while (current.page.hasMore) {
    const cursor = current.page.beforeCursor;
    if (!cursor || seenCursors.has(cursor)) throw new Error(agentText("历史分页游标无效，请重新打开会话。", "Invalid history page cursor; reopen the session."));
    seenCursors.add(cursor);
    current = await fetchPage(cursor);
    if (current.page.snapshot !== first.page.snapshot || current.headId !== first.headId) throw new Error(agentText("读取期间会话历史已变化，请重新打开会话。", "The session history changed while loading; reopen the session."));
    pages.push(current.messages);
    loaded += current.messages.length;
    onProgress?.(loaded, first.page.total);
  }
  const messages = pages.reverse().flat();
  const ids = new Set(messages.map((entry) => entry.id));
  if (messages.length !== first.page.total || ids.size !== messages.length || messages.some((entry) => entry.parent_id !== null && !ids.has(entry.parent_id)) || (first.headId !== null && !ids.has(first.headId))) {
    throw new Error(agentText("历史分支不完整，发送已暂停；请重新打开会话。", "The history branch is incomplete; sending is paused. Reopen the session."));
  }
  return { headId: first.headId, messages, activeGenerationId: first.activeGenerationId, latestGeneration: first.latestGeneration };
}
