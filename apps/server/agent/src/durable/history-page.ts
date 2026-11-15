import { createHash } from "node:crypto";
import { DurableError } from "./errors.ts";
import type { StoredMessage } from "./threads.ts";

export type HistoryPage = { hasMore: boolean; beforeCursor: string | null; total: number; snapshot: string };
/** Pages preserve stored graph order. Clients must hydrate all parent chains before importing a graph runtime. */
export function paginateHistory(messages: StoredMessage[], headId: string | null, query: { limit?: string; before?: string }): { messages: StoredMessage[]; page?: HistoryPage } {
  if (query.limit === undefined && query.before === undefined) return { messages };
  const limit = query.limit === undefined ? 80 : Number(query.limit);
  if (!query.limit?.match(/^\d+$/) && query.limit !== undefined || !Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new DurableError(400, "invalid_history_page", "历史每页必须为 1–200 条。");
  const snapshot = createHash("sha256").update(JSON.stringify({ headId, graph: messages.map(message => [message.id, message.parent_id, message.format]) })).digest("hex");
  let end = messages.length;
  if (query.before !== undefined) {
    let cursor: { snapshot?: unknown; offset?: unknown };
    try {
      if (query.before.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.before)) throw new Error("Invalid cursor");
      cursor = JSON.parse(Buffer.from(query.before, "base64url").toString("utf8"));
    } catch { throw new DurableError(400, "invalid_history_cursor", "无效的历史游标。"); }
    if (!cursor || typeof cursor !== "object" || !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0 || (cursor.offset as number) > messages.length)
      throw new DurableError(400, "invalid_history_cursor", "无效的历史游标。");
    if (cursor.snapshot !== snapshot) throw new DurableError(409, "history_changed", "历史分支已改变；请重新载入第一页，不拼接不同版本。");
    end = cursor.offset as number;
  }
  const start = Math.max(0, end - limit);
  return { messages: messages.slice(start, end), page: { hasMore: start > 0, total: messages.length, snapshot,
    beforeCursor: start > 0 ? Buffer.from(JSON.stringify({ snapshot, offset: start })).toString("base64url") : null } };
}
