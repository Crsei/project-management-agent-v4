import type { NativeSessionRef, CliSessionOptions } from "@agent-workspace/contracts/provider";
import { chatOnlyExecutionSelection, type ExecutionSelection, type ExecutionEnvironment, type RemoteSettings as ThreadSettings } from "@agent-workspace/contracts/chat";
import type { TurnContext } from "@agent-workspace/contracts/pm-references";
import type { UIMessage } from "ai";
import { deleteRecord, getDatabase, listRecords, readRecord, transaction, writeRecord } from "./store.ts";
import { newThreadSettingsSnapshot } from "../settings/chat-defaults.ts";
import { sameExecutionIdentity } from "./agent-execution.ts";
import { getStoreIdentity } from "./persistence-schema.ts";
import { commitThreadRetention, inspectThreadRetention } from "./thread-retention.ts";

export const CHAT_FORMAT = "ai-sdk/v6";
const THREADS = "chat:threads";
const HISTORY = "chat:history";

export type ThreadMetadata = {
  remoteId: string;
  executionSelection?: ExecutionSelection;
  executionEnvironment?: ExecutionEnvironment;
  /** Private actual cwd freeze, including chat-only scratch that must never appear as a code root. */
  executionPath?: string;
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
  nativeEnvironment?: ExecutionEnvironment;
  pendingForkEnvironment?: ExecutionEnvironment;
  pendingFork?: NonNullable<CliSessionOptions["fork"]>;
  deleted?: boolean;
  lifecycleRevision?: number;
  deletionState?: "closing" | "committed";
  deletionOperationId?: string;
  sessionCutover?: unknown;
};
export type StoredMessage = {
  id: string;
  parent_id: string | null;
  format: string;
  content: Record<string, unknown>;
  /** Immutable server-owned input binding. Missing on legacy/unaccepted messages, never inferred. */
  turnContext?: TurnContext;
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

export function ensureThread(
  threadId: string,
  title?: string,
  executionSelection?: ExecutionSelection,
  executionEnvironment?: ExecutionEnvironment,
): void {
  if (!validThreadId(threadId)) throw new Error("无效的会话 ID。");
  const existing = readRecord<ThreadMetadata>(THREADS, threadId);
  if (existing) {
    if (existing.deleted || existing.sessionCutover)
      throw new ThreadConflictError("Deleted Session IDs cannot be reused.", "thread_deleted");
    if (executionSelection && JSON.stringify(existing.executionSelection) !== JSON.stringify(executionSelection))
      throw new ThreadConflictError("Existing Session execution selection cannot be rebound implicitly.", "execution_selection_conflict");
    return;
  }
  const now = new Date().toISOString();
  const snapshot = newThreadSettingsSnapshot();
  writeRecord<ThreadMetadata>(THREADS, threadId, {
    remoteId: threadId,
    executionSelection: executionSelection ?? chatOnlyExecutionSelection(),
    ...(executionEnvironment ? { executionEnvironment } : {}),
    title,
    status: "regular",
    createdAt: now,
    updatedAt: now,
    revision: 0,
    lifecycleRevision: 0,
    ...snapshot,
  });
}
export function getThread(threadId: string): ThreadMetadata | null {
  const thread = readRecord<ThreadMetadata>(THREADS, threadId);
  return thread?.deleted || thread?.sessionCutover ? null : thread;
}
/** Synchronous admission barrier; call again after every asynchronous preflight and inside admission. */
export function assertThreadWritable(threadId: string, options: { allowArchived?: boolean; allowRestored?: boolean } = {}): ThreadMetadata {
  const thread = getThread(threadId);
  if (!thread) throw new ThreadConflictError("Session was deleted or is unavailable.", "thread_deleted");
  if (thread.deletionState) throw new ThreadConflictError("Session deletion is in progress; no new execution or mutation is allowed.", "thread_closing");
  if (!options.allowArchived && thread.status === "archived") throw new ThreadConflictError("Restore the archived Session before writing.", "thread_archived");
  const identity = getStoreIdentity(getDatabase());
  if (!options.allowRestored && identity.restoredThreads && Object.hasOwn(identity.restoredThreads, threadId))
    throw new ThreadConflictError("Restored history is read-only. Explicitly create a new Session; frozen directories and native identities were not rebound.", "restored_history_read_only");
  return thread;
}
export function listThreads(): ThreadMetadata[] {
  return listRecords<ThreadMetadata>(THREADS)
    .filter((thread) => !thread.deleted && !thread.sessionCutover)
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
    lifecycleRevision?: number;
    executionSelection?: ExecutionSelection;
    executionEnvironment?: ExecutionEnvironment;
  },
): ThreadMetadata {
  return transaction(() => {
    ensureThread(threadId);
    const current = assertThreadWritable(threadId, { allowArchived: true, allowRestored: true });
    if (patch.executionSelection || patch.executionEnvironment) assertThreadWritable(threadId, { allowArchived: true });
    if (patch.status && (patch.lifecycleRevision === undefined || patch.lifecycleRevision !== (current.lifecycleRevision ?? 0)))
      throw new ThreadConflictError("Session lifecycle changed; reload before archiving or restoring.", "lifecycle_conflict");
    if (patch.revision !== undefined && current.revision !== patch.revision)
      throw new ThreadConflictError("会话设置已在另一页面更改，请重新载入后再保存。");
    if (patch.executionSelection && current.executionEnvironment?.frozen)
      throw new ThreadConflictError("Execution environment is frozen; create a new Session to change roots.", "execution_frozen");
    if (patch.executionEnvironment && current.executionEnvironment?.frozen &&
        (!patch.executionEnvironment.frozen || !sameExecutionIdentity(current.executionEnvironment, patch.executionEnvironment)))
      throw new ThreadConflictError("Frozen Session directory cannot be rebound.", "execution_frozen");
    const { revision: _revision, lifecycleRevision: _lifecycleRevision, ...values } = patch;
    const next = {
      ...current,
      ...values,
      chatOwned: true,
      revision: current.revision + (patch.settings || patch.executionSelection ? 1 : 0),
      lifecycleRevision: (current.lifecycleRevision ?? 0) + (patch.status && patch.status !== current.status ? 1 : 0),
      updatedAt: new Date().toISOString(),
    };
    writeRecord(THREADS, threadId, next);
    return next;
  });
}
/** Called within generation admission's transaction, so selection and first execution freeze atomically. */
export function freezeThreadExecution(threadId: string, environment: ExecutionEnvironment, actualPath = environment.executionPath ?? undefined): void {
  const thread = assertThreadWritable(threadId);
  if (!thread?.executionSelection) throw new ThreadConflictError("Old Session model cannot execute; create a new Session.", "session_cutover_required");
  if (thread.executionEnvironment?.frozen &&
      (!sameExecutionIdentity(thread.executionEnvironment, environment) || thread.executionPath !== actualPath))
    throw new ThreadConflictError("Frozen Session directory cannot be rebound.", "execution_frozen");
  writeRecord(THREADS, threadId, { ...thread, ...(actualPath ? { executionPath: actualPath } : {}), executionEnvironment: { ...environment, frozen: true } });
}
export function deleteThread(threadId: string, operationId = "internal-delete"): void {
  transaction(() => {
    const thread = getThread(threadId);
    if (!thread) return;
    const retention = inspectThreadRetention(getDatabase(), threadId);
    if (retention.blockers.length)
      throw new ThreadConflictError(`Deletion blocked; reconcile original operations first: ${retention.blockers.join(", ")}`, "deletion_blocked");
    commitThreadRetention(getDatabase(), retention);
    writeRecord(THREADS, threadId, { remoteId: threadId, deleted: true, deletionState: "committed", deletionOperationId: operationId,
      lifecycleRevision: (thread.lifecycleRevision ?? 0) + 1, deletedAt: new Date().toISOString(),
      retainedGenerationIds: retention.retainedGenerationIds, retainedReferences: retention.references });
    deleteRecord("chat:sidebar", threadId);
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
    if (!authoritative) assertThreadWritable(threadId);
    const history = getThreadHistory(threadId, entry.format);
    const index = history.messages.findIndex((message) => message.id === entry.id);
    const existing = history.messages[index];
    // Only admission's server-side binder can attach a context. Browser history
    // writes and subsequent assistant snapshots cannot replace accepted evidence.
    entry = { ...entry };
    if (existing?.turnContext) entry.turnContext = existing.turnContext;
    else delete entry.turnContext;
    const metadata = entry.content.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      const { turnContext: _clientContext, custom, ...rest } = metadata as Record<string, unknown>;
      if (custom && typeof custom === "object" && !Array.isArray(custom)) {
        const { turnContext: _clientCustomContext, ...trustedCustom } = custom as Record<string, unknown>;
        entry.content = { ...entry.content, metadata: { ...rest, custom: trustedCustom } };
      } else entry.content = { ...entry.content, metadata: { ...rest, ...(custom === undefined ? {} : { custom }) } };
    }
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

/** Called inside generation admission's transaction, after its input message was saved. */
export function bindMessageTurnContext(threadId: string, context: TurnContext): void {
  assertThreadWritable(threadId);
  const history = getThreadHistory(threadId);
  const entry = history.messages.find(message => message.id === context.messageId);
  if (context.threadId !== threadId || !entry || entry.content.role !== "user")
    throw new ThreadConflictError("TurnContext 必须绑定已受理的输入用户消息。", "invalid_turn_context");
  if (entry.turnContext) {
    if (JSON.stringify(entry.turnContext) !== JSON.stringify(context))
      throw new ThreadConflictError("已受理消息的 PM 上下文不可修改；请使用新消息 ID。", "turn_context_conflict");
    return;
  }
  entry.turnContext = context;
  writeRecord(HISTORY, historyKey(threadId, CHAT_FORMAT), history);
}
export function setThreadHead(threadId: string, headId: string | null): void {
  assertThreadWritable(threadId);
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
  environment?: ExecutionEnvironment,
): void {
  ensureThread(id);
  const thread = getThread(id);
  if (thread)
    writeRecord(THREADS, id, {
      ...thread,
      nativeSession: ref,
      nativeMessageId: messageId,
      nativeSystemPrompt: systemPrompt,
      nativeEnvironment: ref && environment ? { ...environment } : undefined,
      pendingForkEnvironment: undefined,
      pendingFork: undefined,
    });
}
export function setThreadPendingFork(
  id: string,
  fork: NonNullable<CliSessionOptions["fork"]>,
): void {
  ensureThread(id);
  assertThreadWritable(id);
  const thread = getThread(id);
  if (thread)
    writeRecord(THREADS, id, {
      ...thread,
      pendingFork: fork,
      pendingForkEnvironment: thread.executionEnvironment,
      nativeEnvironment: undefined,
      nativeSession: undefined,
      nativeMessageId: undefined,
    });
}
export function forkThreadHistory(
  sourceThreadId: string,
  targetThreadId: string,
  context?: string,
  attachments: Extract<UIMessage["parts"][number], { type: "file" }>[] = [],
): void {
  transaction(() => {
    ensureThread(sourceThreadId);
    const source = getThread(sourceThreadId);
    assertThreadWritable(sourceThreadId);
    if (!source?.executionSelection) throw new ThreadConflictError("Old Session cannot be forked into a usable Session.", "session_cutover_required");
    const environment = source.executionEnvironment ? { ...source.executionEnvironment,
      executionPath: source.executionEnvironment.sourcePath, worktree: null, frozen: false } : undefined;
    ensureThread(targetThreadId, `${source.title ?? "会话"} · 分支`, source.executionSelection, environment);
    assertThreadWritable(targetThreadId);
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
    if (context?.trim()) {
      const messageId = crypto.randomUUID();
      saveFormattedMessage(
        targetThreadId,
        {
          id: messageId,
          parent_id: parent,
          format: CHAT_FORMAT,
          content: {
            role: "user",
            parts: [{ type: "text", text: context }, ...attachments],
            metadata: { custom: { sourceThreadId, forkContext: true } },
          },
        },
        true,
      );
      // A server-created fork background is a real accepted User source, not an
      // imported/native response or an execution grant. Keep it referenceable.
      bindMessageTurnContext(targetThreadId, { version: 1, threadId: targetThreadId, messageId,
        acceptedAt: new Date().toISOString(), pmReferences: [] });
    }
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
