import type { NativeSessionRef, CliSessionOptions } from "@agent-workspace/contracts/provider";
import type { AgentScope, RemoteSettings as ThreadSettings } from "@agent-workspace/contracts/chat";
import { deleteRecord, listRecords, readRecord, transaction, writeRecord } from "./store.ts";
import { sameAgentScope } from "./agent-scope.ts";
import { newThreadSettingsSnapshot } from "../settings/chat-defaults.ts";
import { UNSELECTED_THREAD_SETTINGS } from "@agent-workspace/contracts/settings";

export const CHAT_FORMAT = "ai-sdk/v6";
const THREADS = "chat:threads";
const HISTORY = "chat:history";
const IMPORTS = "chat:imports";

export type ThreadMetadata = {
  remoteId: string;
  scope?: AgentScope;
  title?: string;
  status: "regular" | "archived";
  custom?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  revision: number;
  settings: ThreadSettings;
  defaultsRevision?: number;
  chatOwned?: boolean;
  nativeSession?: NativeSessionRef;
  nativeMessageId?: string;
  nativeSystemPrompt?: string;
  nativeScope?: AgentScope;
  pendingForkScope?: AgentScope;
  pendingFork?: NonNullable<CliSessionOptions["fork"]>;
  deleted?: boolean;
};
export type StoredMessage = {
  id: string;
  parent_id: string | null;
  format: string;
  content: Record<string, unknown>;
};
export type ThreadHistory = {
  threadId: string;
  format: string;
  headId: string | null;
  messages: StoredMessage[];
  authoritativeIds: string[];
};
export class ThreadConflictError extends Error {
  readonly code: string;
  constructor(message: string, code = "thread_conflict") {
    super(message);
    this.code = code;
  }
}
export const validThreadId = (id: unknown): id is string =>
  typeof id === "string" &&
  id.length > 0 &&
  id.length <= 256 &&
  id !== "." &&
  id !== ".." &&
  // oxlint-disable-next-line no-control-regex -- identifiers must exclude control characters.
  !/[\u0000-\u001f]/.test(id);
const historyKey = (id: string, format: string) => JSON.stringify([id, format]);

export function ensureThread(threadId: string, title?: string, scope?: AgentScope): void {
  if (!validThreadId(threadId)) throw new Error("无效的会话 ID。");
  const existing = readRecord<ThreadMetadata>(THREADS, threadId);
  if (existing) {
    if (scope && !sameAgentScope(existing.scope, scope))
      throw new ThreadConflictError("已有会话不能更改工作区或项目归属。", "scope_conflict");
    return;
  }
  const now = new Date().toISOString();
  const snapshot = newThreadSettingsSnapshot();
  writeRecord<ThreadMetadata>(THREADS, threadId, {
    remoteId: threadId,
    ...(scope ? { scope: { ...scope } } : {}),
    title,
    status: "regular",
    createdAt: now,
    updatedAt: now,
    revision: 0,
    ...snapshot,
  });
}
export function getThread(threadId: string): ThreadMetadata | null {
  const thread = readRecord<ThreadMetadata>(THREADS, threadId);
  return thread?.deleted ? null : thread;
}
export function listThreads(): ThreadMetadata[] {
  return listRecords<ThreadMetadata>(THREADS)
    .filter((thread) => !thread.deleted)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function updateThread(
  threadId: string,
  patch: {
    title?: string;
    status?: "regular" | "archived";
    custom?: Record<string, unknown>;
    settings?: ThreadSettings;
    revision?: number;
  },
): ThreadMetadata {
  return transaction(() => {
    ensureThread(threadId);
    const current = getThread(threadId);
    if (!current) throw new ThreadConflictError("该会话已删除，不能重新写入。", "thread_deleted");
    if (patch.revision !== undefined && current.revision !== patch.revision)
      throw new ThreadConflictError("会话设置已在另一页面更改，请重新载入后再保存。");
    const { revision: _revision, ...values } = patch;
    const next = {
      ...current,
      ...values,
      chatOwned: true,
      revision: current.revision + (patch.settings ? 1 : 0),
      updatedAt: new Date().toISOString(),
    };
    writeRecord(THREADS, threadId, next);
    return next;
  });
}
export function deleteThread(threadId: string): void {
  transaction(() => {
    const thread = getThread(threadId);
    if (!thread) return;
    writeRecord(THREADS, threadId, { ...thread, deleted: true });
    deleteRecord("chat:sidebar", threadId);
    for (const history of listRecords<ThreadHistory>(HISTORY)) {
      if (history.threadId === threadId)
        deleteRecord(HISTORY, historyKey(threadId, history.format));
    }
  });
}
export function getThreadHistory(threadId: string, format = CHAT_FORMAT): ThreadHistory {
  return (
    readRecord<ThreadHistory>(HISTORY, historyKey(threadId, format)) ?? {
      threadId,
      format,
      headId: null,
      messages: [],
      authoritativeIds: [],
    }
  );
}
export function getThreadBranch(threadId: string, headId?: string | null): StoredMessage[] {
  const history = getThreadHistory(threadId);
  const byId = new Map(history.messages.map((message) => [message.id, message]));
  let cursor = headId === undefined ? history.headId : headId;
  const branch: StoredMessage[] = [];
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const message = byId.get(cursor);
    if (!message) break;
    branch.push(message);
    cursor = message.parent_id;
  }
  return branch.reverse();
}

// A browser may complete a frontend tool call, but cannot rewrite generated text,
// input arguments, citations, reasoning, or a result already saved by another tab.
export function mergeFrontendToolResults(
  current: StoredMessage,
  incoming: StoredMessage,
): StoredMessage {
  type ToolPart = {
    type: string;
    toolCallId?: string;
    state?: string;
    output?: unknown;
    errorText?: string;
    approval?: { id?: string; approved?: boolean; reason?: string };
  };
  const saved = current.content as { parts?: ToolPart[] };
  const received = incoming.content as { parts?: ToolPart[] };
  if (!Array.isArray(saved.parts) || !Array.isArray(received.parts)) return current;
  const parts = saved.parts.map((part) => {
    if (
      typeof part.toolCallId !== "string" ||
      !(part.type.startsWith("tool-") || part.type === "dynamic-tool")
    )
      return part;
    const candidate = received.parts!.find(
      (value) => value.toolCallId === part.toolCallId && value.type === part.type,
    );
    if (!candidate) return part;
    if (
      part.state === "output-available" ||
      part.state === "output-error" ||
      part.state === "output-denied"
    )
      return part;
    if (
      !["output-available", "output-error", "output-denied", "approval-responded"].includes(
        String(candidate.state),
      )
    )
      return part;
    return {
      ...part,
      state: candidate.state,
      ...(candidate.output === undefined ? {} : { output: candidate.output }),
      ...(typeof candidate.errorText === "string" ? { errorText: candidate.errorText } : {}),
      ...(candidate.approval
        ? {
            approval: {
              ...part.approval,
              approved: candidate.approval.approved,
              reason: candidate.approval.reason,
            },
          }
        : {}),
    };
  });
  return { ...current, content: { ...current.content, parts } };
}
export function saveFormattedMessage(
  threadId: string,
  entry: StoredMessage,
  authoritative = false,
  setHead = true,
): void {
  transaction(() => {
    ensureThread(threadId);
    if (!getThread(threadId)) throw new ThreadConflictError("该会话已删除。", "thread_deleted");
    const history = getThreadHistory(threadId, entry.format);
    const index = history.messages.findIndex((message) => message.id === entry.id);
    const existing = history.messages[index];
    if (existing && !authoritative) {
      if (history.authoritativeIds.includes(entry.id))
        entry = mergeFrontendToolResults(existing, entry);
      else return; // Existing saved content is immutable; edits create a branch/new id.
    }
    if (index === -1) history.messages.push(entry);
    else history.messages[index] = entry;
    if (authoritative && !history.authoritativeIds.includes(entry.id))
      history.authoritativeIds.push(entry.id);
    if (setHead) history.headId = entry.id;
    writeRecord(HISTORY, historyKey(threadId, entry.format), history);
  });
}
export function setThreadHead(threadId: string, headId: string | null): void {
  const history = getThreadHistory(threadId);
  history.headId = headId;
  writeRecord(HISTORY, historyKey(threadId, CHAT_FORMAT), history);
}
export function getThreadNativeSession(id: string): NativeSessionRef | undefined {
  return getThread(id)?.nativeSession;
}
export function getThreadPendingFork(
  id: string,
): NonNullable<CliSessionOptions["fork"]> | undefined {
  return getThread(id)?.pendingFork;
}
export function setThreadNativeSession(
  id: string,
  ref: NativeSessionRef | undefined,
  messageId?: string,
  systemPrompt?: string,
  scope?: AgentScope,
): void {
  ensureThread(id);
  const thread = getThread(id);
  if (thread)
    writeRecord(THREADS, id, {
      ...thread,
      nativeSession: ref,
      nativeMessageId: messageId,
      nativeSystemPrompt: systemPrompt,
      nativeScope: ref && scope ? { ...scope } : undefined,
      pendingForkScope: undefined,
      pendingFork: undefined,
    });
}
export function setThreadPendingFork(
  id: string,
  fork: NonNullable<CliSessionOptions["fork"]>,
): void {
  ensureThread(id);
  const thread = getThread(id);
  if (thread)
    writeRecord(THREADS, id, {
      ...thread,
      pendingFork: fork,
      pendingForkScope: thread.scope,
      nativeScope: undefined,
      nativeSession: undefined,
      nativeMessageId: undefined,
    });
}
export function forkThreadHistory(
  sourceThreadId: string,
  targetThreadId: string,
  context?: string,
): void {
  transaction(() => {
    ensureThread(sourceThreadId);
    const source = getThread(sourceThreadId);
    ensureThread(targetThreadId, `${source?.title ?? "会话"} · 分支`, source?.scope);
    const target = getThread(targetThreadId);
    if (!source || !target || getThreadHistory(targetThreadId).messages.length > 0) return;
    writeRecord(THREADS, targetThreadId, {
      ...target,
      title: target.title ?? `${source.title ?? "会话"} · 分支`,
      settings: source.settings,
      defaultsRevision: source.defaultsRevision,
      custom: { ...target.custom, parentThreadId: sourceThreadId },
    });
    // An explicit run snapshot is the stable boundary; current chat may have advanced.
    const all = context === undefined ? getThreadBranch(sourceThreadId) : [];
    const stable = all.filter((message) => {
      const metadata = message.content.metadata as { durable?: { status?: string } } | undefined;
      return metadata?.durable?.status !== "running";
    });
    let size = 0;
    const kept: StoredMessage[] = [];
    for (let i = stable.length - 1; i >= 0; i--) {
      const length = JSON.stringify(stable[i]).length;
      if (size + length > 64000) break;
      kept.unshift(stable[i]);
      size += length;
    }
    let parent: string | null = null;
    for (const message of kept) {
      saveFormattedMessage(targetThreadId, { ...message, parent_id: parent }, true);
      parent = message.id;
    }
    if (context?.trim())
      saveFormattedMessage(
        targetThreadId,
        {
          id: crypto.randomUUID(),
          parent_id: parent,
          format: CHAT_FORMAT,
          content: {
            role: "user",
            parts: [{ type: "text", text: context }],
            metadata: { custom: { sourceThreadId, forkContext: true } },
          },
        },
        true,
      );
  });
}

export type ThreadImport = {
  remoteId: string;
  title?: string;
  status?: "regular" | "archived";
  custom?: Record<string, unknown>;
  histories?: { format: string; messages: StoredMessage[] }[];
  settings?: ThreadSettings;
};
export function importThreads(
  migrationId: string,
  threads: ThreadImport[],
): { imported: number; skipped: number } {
  return transaction(() => {
    const previous = readRecord<{ imported: number; skipped: number }>(IMPORTS, migrationId);
    if (previous) return previous;
    let imported = 0;
    let skipped = 0;
    for (const input of threads) {
      const existing = readRecord<ThreadMetadata>(THREADS, input.remoteId);
      // Resource import may create metadata first. Fill only that unclaimed
      // shell; never merge into a claimed, deleted, or nonempty chat.
      if (
        existing &&
        (existing.deleted ||
          existing.chatOwned ||
          getThreadHistory(input.remoteId).messages.length > 0)
      ) {
        skipped++;
        continue;
      }
      ensureThread(input.remoteId, input.title);
      // Imported history has no relationship to today's default revision.
      if (!existing) {
        const created = getThread(input.remoteId)!;
        writeRecord(THREADS, input.remoteId, {
          ...created,
          settings: input.settings ?? { ...UNSELECTED_THREAD_SETTINGS },
          defaultsRevision: undefined,
        });
      }
      updateThread(input.remoteId, {
        title: input.title ?? existing?.title,
        status: input.status ?? "regular",
        custom: input.custom,
        ...(input.settings ? { settings: input.settings } : {}),
      });
      for (const history of input.histories ?? []) {
        let headId: string | null = null;
        const messages: StoredMessage[] = [];
        const ids = new Set<string>();
        for (const message of history.messages) {
          if (ids.has(message.id)) continue;
          ids.add(message.id);
          messages.push({
            ...message,
            parent_id: message.parent_id && ids.has(message.parent_id) ? message.parent_id : null,
          });
          headId = message.id;
        }
        writeRecord<ThreadHistory>(HISTORY, historyKey(input.remoteId, history.format), {
          threadId: input.remoteId,
          format: history.format,
          headId,
          messages,
          authoritativeIds: messages.map((message) => message.id),
        });
      }
      imported++;
    }
    const result = { imported, skipped };
    writeRecord(IMPORTS, migrationId, result);
    return result;
  });
}

export function getThreadStableOutputs(threadId: string): { busy: boolean; texts: string[] } {
  type Content = {
    role?: string;
    metadata?: { durable?: { generationId?: string }; custom?: { forkContext?: boolean } };
    parts?: { type: string; text?: string }[];
  };
  type Generation = {
    id: string;
    threadId: string;
    messageId: string;
    status: string;
    output?: Content;
  };
  const generations = listRecords<Generation>("chat:generations").filter(
    (generation) => generation.threadId === threadId,
  );
  const confirmed = new Map<string, Generation>();
  for (const generation of generations)
    if (generation.status === "completed") confirmed.set(generation.messageId, generation);
  const texts = getThreadBranch(threadId).flatMap((entry) => {
    const generation = confirmed.get(entry.id);
    if (!generation) return [];
    const saved = entry.content as Content;
    const content =
      generation.output ??
      (saved.metadata?.durable?.generationId === generation.id ? saved : undefined);
    if (content?.role !== "assistant" || content.metadata?.custom?.forkContext) return [];
    const text = content.parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    return text?.trim() ? [text] : [];
  });
  return {
    busy: generations.some(
      (generation) => generation.status === "queued" || generation.status === "running",
    ),
    texts,
  };
}
