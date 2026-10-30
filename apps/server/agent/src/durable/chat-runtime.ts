import { createHash } from "node:crypto";
import path from "node:path";
import { workspaceRoot } from "../paths.ts";
import { interruptPmToolCalls, openPmToolBridge } from "../pm-tools.ts";
import { observePmCoreChanges, stopPmCoreChanges } from "../pm-core-changes/index.ts";
import { injectQuoteContext } from "@assistant-ui/ai-sdk";
import {
  createUIMessageStream,
  readUIMessageStream,
  type JSONSchema7,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { CliSessionOptions, NativeSessionRef, ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import type { RemoteSettings as ThreadSettings } from "@agent-workspace/contracts/chat";
import type { PmReferenceInput, PmReferenceResolution } from "@agent-workspace/contracts/pm-references";
import type { NativeOutputItem, ResponseStreamingMode } from "@agent-workspace/contracts/output";
import type { NativeUsageUpdate, ThreadUsageSnapshot } from "@agent-workspace/contracts/usage";
import type { ContextTransfer } from "@agent-workspace/contracts/durable";
import { beginThreadUsage, getThreadUsage, recordNativeUsage, updateUsageSession } from "../usage/ledger.ts";
import { recordUsageLaunch, recordUsageLaunchSession } from "../usage/service-tiers.ts";
import {
  buildChatPrompt,
  resolveProviderRuntime,
  runNativeRuntime,
  ProviderRuntimeError,
  type ProviderRuntime,
} from "../providers/runtime.ts";
import { classifyProviderError } from "../providers/errors.ts";
import { sanitizeErrorMessage } from "../agents/cli-chat.ts";
import { resolveProviderModelOptions } from "../providers/catalog.ts";
import { getStoredInstance } from "../providers/instances.ts";
import { listRuns, withThreadExecution } from "./engine.ts";
import { consumeTransfers, getThreadFork, TRANSFERS } from "./transfers.ts";
import type { ChatRecoveryCandidate } from "../automation/service.ts";
import { boundedContext } from "./context.ts";
import { forkChatSnapshot } from "./forks.ts";
import { listRecords, readRecord, transaction, writeRecord } from "./store.ts";
import {
  closeNativeInteractions,
  emitNativeOutput,
  endNativeOutput,
  getNativeOutput,
  initializeNativeOutput,
  requestNativeInteraction,
  setNativeOutputStatus,
} from "./native-output.ts";
import { makeAssistantStreamingFilter } from "./assistant-streaming.ts";
import { DurableError } from "./errors.ts";
import {
  agentContextIdentity,
  resolveAgentScope,
  sameAgentScope,
  type AgentExecutionSnapshot,
} from "./agent-scope.ts";
import {
  CHAT_FORMAT,
  ensureThread,
  getThread,
  getThreadBranch,
  getThreadHistory,
  saveFormattedMessage,
  setThreadHead,
  setThreadNativeSession,
  ThreadConflictError,
  updateThread,
  type StoredMessage,
} from "./threads.ts";
import {
  assertResolvedReferences,
  pmContextPromptLine,
  resolvePmContextBinding,
  resolvePmReferences,
  samePmContext,
} from "./pm-context.ts";

const GENERATIONS = "chat:generations";
const EVENTS = "chat:events";
const REQUESTS = "chat:requests";
export type ChatRequest = {
  id: string;
  messages: UIMessage[];
  system?: string;
  tools?: Record<string, { description?: string; parameters: JSONSchema7 }>;
  config?: { providerInstanceId?: string; modelName?: string; modelOptions?: ProviderOptionSelection[]; interactionMode?: "default" | "plan"; threadSettingsRevision?: number; responseStreamingMode?: ResponseStreamingMode };
  callSettings?: { temperature?: number };
  transferContext?: string;
  trigger?: "submit-message" | "regenerate-message";
  messageId?: string;
  idempotencyKey?: string;
  /** Pinned PM references resolved before the turn is accepted; never bodies. */
  pmReferences?: PmReferenceInput[];
};
export type ChatGeneration = {
  id: string;
  threadId: string;
  messageId: string;
  parentId: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  endedAt?: string;
  seq: number;
  request: ChatRequest;
  providerInstanceId: string;
  providerInstanceRevision: number;
  modelId: string;
  temperature: number;
  modelOptions?: ProviderOptionSelection[];
  interactionMode?: "default" | "plan";
  threadSettingsSnapshot?: ThreadSettings;
  executionSnapshot?: AgentExecutionSnapshot;
  output?: UIMessage;
  error?: string;
  errorClass?: string;
  resetAt?: string;
  nativeSession?: NativeSessionRef;
  continuationOf?: string;
  continuationId?: string;
  continuationIdempotencyKey?: string;
  handoff?: { mode: "native" | "native-fork" | "portable"; reason: string };
  idleCompaction?: "onReturn" | "beforeCacheExpires";
  usage?: ThreadUsageSnapshot;
  nativeContextReported?: boolean;
  /** Resolved IDs, titles, revisions and short reasons captured at acceptance time. */
  pmReferences?: PmReferenceResolution[];
};
type JournalEvent = { generationId: string; seq: number; chunk: UIMessageChunk };
type ChatRuntimeState = {
  controllers: Map<string, AbortController>;
  workers: Map<string, Promise<void>>;
  subscribers: Map<string, Set<() => void>>;
  started: boolean;
  stopping: boolean;
};
const stateKey = Symbol.for("agent-workspace.chat-runtime");
const globals = globalThis as typeof globalThis & { [stateKey]?: ChatRuntimeState };
const state = (globals[stateKey] ??= {
  controllers: new Map(),
  workers: new Map(),
  subscribers: new Map(),
  started: false,
  stopping: false,
});
const compactionTimers = new Map<string, NodeJS.Timeout>();
const compactionTasks = new Set<Promise<void>>();
const { controllers, workers, subscribers } = state;
export const isChatActive = (generation: ChatGeneration) =>
  generation.status === "queued" || generation.status === "running";
export function getChatGeneration(id: string): ChatGeneration | null {
  return readRecord(GENERATIONS, id);
}
export function listChatGenerations(threadId: string): ChatGeneration[] {
  return listRecords<ChatGeneration>(GENERATIONS)
    .filter((generation) => generation.threadId === threadId)
    .reverse()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function getActiveChat(threadId: string): ChatGeneration | undefined {
  return listChatGenerations(threadId).find(isChatActive);
}
function saveGeneration(generation: ChatGeneration): void {
  writeRecord(GENERATIONS, generation.id, generation);
  for (const notify of subscribers.get(generation.id) ?? []) notify();
}
function appendChunk(id: string, chunk: UIMessageChunk): void {
  transaction(() => {
    const generation = getChatGeneration(id)!;
    const seq = generation.seq + 1;
    writeRecord<JournalEvent>(EVENTS, `${id}:${String(seq).padStart(12, "0")}`, {
      generationId: id,
      seq,
      chunk,
    });
    saveGeneration({ ...generation, seq });
  });
}
export function readChatEvents(id: string, after = 0): JournalEvent[] {
  const generation = getChatGeneration(id);
  if (!generation) return [];
  const events: JournalEvent[] = [];
  for (let seq = after + 1; seq <= generation.seq; seq++) {
    const event = readRecord<JournalEvent>(EVENTS, `${id}:${String(seq).padStart(12, "0")}`);
    if (event) events.push(event);
  }
  return events;
}
export function subscribeChat(id: string, signal?: AbortSignal): ReadableStream<UIMessageChunk> {
  let cleanup = () => {};
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      let seq = 0;
      let closed = false;
      const listeners = subscribers.get(id) ?? new Set<() => void>();
      subscribers.set(id, listeners);
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.close();
      };
      const pump = () => {
        if (closed) return;
        for (const event of readChatEvents(id, seq)) {
          controller.enqueue(event.chunk);
          seq = event.seq;
        }
        const generation = getChatGeneration(id);
        if (!generation || !isChatActive(generation)) close();
      };
      cleanup = () => {
        listeners.delete(pump);
        if (!listeners.size) subscribers.delete(id);
        signal?.removeEventListener("abort", close);
      };
      listeners.add(pump);
      signal?.addEventListener("abort", close, { once: true });
      if (signal?.aborted) close();
      else pump();
    },
    cancel() {
      cleanup();
    }, // Unsubscribe only: the worker has its own AbortController.
  });
}
const toUIMessage = (entry: StoredMessage): UIMessage =>
  ({ id: entry.id, ...entry.content }) as UIMessage;
const toStoredMessage = (message: UIMessage, parentId: string | null): StoredMessage => {
  const { id, ...content } = message;
  return { id, parent_id: parentId, format: CHAT_FORMAT, content };
};
function acceptMessages(request: ChatRequest): UIMessage[] {
  const history = getThreadHistory(request.id);
  const incomingIds = new Set(request.messages.map((message) => message.id));
  if (incomingIds.size !== request.messages.length)
    throw new ThreadConflictError("消息 ID 不能重复。", "invalid_request");
  if (
    request.trigger !== "regenerate-message" &&
    history.headId &&
    !incomingIds.has(history.headId)
  )
    throw new ThreadConflictError(
      "会话已有新的服务端输出，请重新载入历史后再发送。",
      "stale_history",
    );
  const known = new Map(history.messages.map((message) => [message.id, message]));
  let parent: string | null = null;
  const accepted: UIMessage[] = [];
  for (const message of request.messages) {
    const stored = known.get(message.id);
    if (!stored && message.role !== "user")
      throw new ThreadConflictError("客户端不能新增助手消息。", "invalid_history");
    if (stored && stored.parent_id !== parent)
      throw new ThreadConflictError("消息分支与服务端历史不一致。", "invalid_history");
    saveFormattedMessage(request.id, toStoredMessage(message, parent), !stored, false);
    accepted.push(
      toUIMessage(getThreadHistory(request.id).messages.find((entry) => entry.id === message.id)!),
    );
    parent = message.id;
  }
  setThreadHead(request.id, parent);
  return accepted;
}
export function chatRequestIdentity(request: ChatRequest): string {
  const last = request.messages.at(-1);
  return createHash("sha256")
    .update(
      JSON.stringify({
        threadId: request.id,
        ...(request.idempotencyKey
          ? { key: request.idempotencyKey }
          : {
              trigger: request.trigger ?? "submit-message",
              messageId: request.messageId,
              tailId: last?.id,
              tools:
                last?.role === "assistant"
                  ? last.parts.filter(
                      (part) => part.type.startsWith("tool-") || part.type === "dynamic-tool",
                    )
                  : undefined,
            }),
      }),
    )
    .digest("hex");
}
function chatRequestFingerprint(request: ChatRequest): string {
  const last = request.messages.at(-1);
  const metadata = last?.metadata as { custom?: { quote?: unknown } } | undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({
        trigger: request.trigger ?? "submit-message",
        messageId: request.messageId,
        tail: last
          ? { id: last.id, role: last.role, parts: last.parts, quote: metadata?.custom?.quote }
          : null,
        system: request.system,
        providerInstanceId: request.config?.providerInstanceId,
        modelName: request.config?.modelName,
        modelOptions: request.config?.modelOptions,
        interactionMode: request.config?.interactionMode,
        threadSettingsRevision: request.config?.threadSettingsRevision,
        responseStreamingMode: request.config?.responseStreamingMode,
        tools: request.tools,
        pmReferences: request.pmReferences,
      }),
    )
    .digest("hex");
}
function findSubmittedChat(identity: string, fingerprint: string): ChatGeneration | null {
  const existing = readRecord<{ id: string; fingerprint: string }>(REQUESTS, identity);
  if (!existing) return null;
  if (existing.fingerprint !== fingerprint)
    throw new ThreadConflictError("相同提交身份对应了不同聊天请求。", "idempotency_conflict");
  return getChatGeneration(existing.id);
}
function requireRunnableThread(threadId: string, expectedRevision?: number) {
  const thread = getThread(threadId);
  if (!thread) throw new ThreadConflictError("该会话已删除。", "thread_deleted");
  if (!thread.scope)
    throw new DurableError(412, "scope_required", "历史会话没有工作区归属；请先选择工作区或项目并新建会话。");
  if (thread.status === "archived")
    throw new ThreadConflictError("请先恢复已归档会话，再发送或继续回复。", "thread_archived");
  if (!thread.settings.providerInstanceId.trim() || !thread.settings.model.trim())
    throw new ThreadConflictError("请先为此会话选择并保存模型提供商和模型。", "model_selection_required");
  if (expectedRevision !== undefined && thread.revision !== expectedRevision)
    throw new ThreadConflictError("会话模型设置已更改，请重新载入后发送。", "stale_settings");
  return thread;
}
function validatedModelOptions(instanceId: string, modelId: string, selections?: ProviderOptionSelection[]): ProviderOptionSelection[] {
  try {
    return resolveProviderModelOptions(instanceId, modelId, selections);
  } catch (error) {
    throw new ProviderRuntimeError(400, "invalid_model_options", error instanceof Error ? error.message : "无效模型选项。");
  }
}
// Idle compaction is a real, visible native turn. Authorization is re-resolved
// using only the initiating request's in-memory headers; credentials are never persisted.
function idleCompactionCandidate(threadId: string, mode: "onReturn" | "beforeCacheExpires") {
  const thread = getThread(threadId);
  const latest = listChatGenerations(threadId)[0];
  if (!thread || thread.status !== "regular" || !thread.scope || !latest || latest.status !== "completed" ||
      getActiveChat(threadId) || thread.pendingFork || !thread.nativeSession ||
      thread.nativeMessageId !== latest.messageId || latest.nativeSession?.sessionId !== thread.nativeSession.sessionId ||
      thread.settings.providerInstanceId !== latest.providerInstanceId || thread.settings.model !== latest.modelId ||
      thread.nativeSystemPrompt !== latest.request.system ||
      listRuns(threadId).some((run) => run.status === "queued" || run.status === "running") ||
      listRecords<ContextTransfer>(TRANSFERS).some((item) => item.parentThreadId === threadId && !item.consumedAt))
    return null;
  const instance = getStoredInstance(latest.providerInstanceId);
  if (!instance?.enabled || instance.driver !== "claude" || instance.revision !== latest.providerInstanceRevision ||
      instance.config.idleCompaction !== mode) return null;
  const lastUser = latest.request.messages.at(-1);
  if (!lastUser || lastUser.role !== "user" || lastUser.parts.some((part) =>
    part.type === "text" && /^\/compact(?:\s|$)/i.test(part.text.trim()))) return null;
  const usage = getThreadUsage(threadId);
  const context = usage.context;
  if (!latest.nativeContextReported || usage.generationId !== latest.id || (context?.usedTokens ?? 0) < 200_000) return null;
  const updated = Date.parse(context!.updatedAt);
  if (!Number.isFinite(updated)) return null;
  const expires = updated + (context!.promptCacheTtlMs ?? 70 * 60_000);
  if (mode === "beforeCacheExpires" && context!.promptCacheTtlMs === undefined) return null;
  return { latest, thread, expires };
}

async function compactIdleThread(threadId: string, expectedId: string, mode: "onReturn" | "beforeCacheExpires", headers?: Headers): Promise<void> {
  const candidate = idleCompactionCandidate(threadId, mode);
  const now = Date.now();
  if (state.stopping || !candidate || candidate.latest.id !== expectedId ||
      (mode === "onReturn" ? now < candidate.expires : now < candidate.expires - 120_000 || now >= candidate.expires)) return;
  const generation = await submitChat({
    id: threadId,
    messages: [...getThreadBranch(threadId).map(toUIMessage), {
      id: `idle-compact:${expectedId}`, role: "user", parts: [{ type: "text", text: "/compact" }],
      metadata: { custom: { idleCompaction: mode } },
    }],
    system: candidate.latest.request.system,
    config: { threadSettingsRevision: candidate.thread.revision },
    idempotencyKey: `idle-compact:${expectedId}`,
  }, undefined, headers, { expectedId, mode });
  await workers.get(generation.id);
  if (getChatGeneration(generation.id)?.status !== "completed")
    throw new ThreadConflictError("会话压缩未完成，请检查后重试。", "compaction_failed");
}

function scheduleIdleCompaction(generation: ChatGeneration, headers?: Headers): void {
  clearTimeout(compactionTimers.get(generation.threadId));
  compactionTimers.delete(generation.threadId);
  const candidate = idleCompactionCandidate(generation.threadId, "beforeCacheExpires");
  if (!candidate || candidate.latest.id !== generation.id || Date.now() >= candidate.expires) return;
  const timer = setTimeout(() => {
    compactionTimers.delete(generation.threadId);
    const task = compactIdleThread(generation.threadId, generation.id, "beforeCacheExpires", headers)
      .catch(() => {}).finally(() => compactionTasks.delete(task));
    compactionTasks.add(task);
  }, Math.max(0, candidate.expires - 120_000 - Date.now()));
  timer.unref();
  compactionTimers.set(generation.threadId, timer);
}

export async function submitChat(
  request: ChatRequest,
  runtime?: ProviderRuntime,
  requestHeaders?: Headers,
  idle?: { expectedId: string; mode: "onReturn" | "beforeCacheExpires" },
): Promise<ChatGeneration> {
  await startChatRuntime();
  const identity = chatRequestIdentity(request);
  const fingerprint = chatRequestFingerprint(request);
  const existing = findSubmittedChat(identity, fingerprint);
  if (existing) return existing;
  if (!idle) {
    const active = getActiveChat(request.id);
    if (active?.idleCompaction) {
      await workers.get(active.id);
      if (getChatGeneration(active.id)?.status !== "completed")
        throw new ThreadConflictError("会话压缩未完成，请检查后重试。", "compaction_failed");
    }
  }
  // A server-initiated compaction may have advanced history while a browser
  // was idle. Rebase only the exact branch it compacted, never arbitrary stale edits.
  if (!idle && request.trigger !== "regenerate-message") {
    const compact = listChatGenerations(request.id)[0];
    const last = request.messages.at(-1);
    const branch = getThreadBranch(request.id);
    if (compact?.idleCompaction && compact.status === "completed" && last?.role === "user" &&
        branch.at(-1)?.id === compact.messageId &&
        JSON.stringify(request.messages.slice(0, -1).map((message) => message.id)) ===
          JSON.stringify(compact.request.messages.slice(0, -1).map((message) => message.id)))
      request = { ...request, messages: [...branch.map(toUIMessage), last] };
  }
  ensureThread(request.id);
  const thread = requireRunnableThread(request.id, request.config?.threadSettingsRevision);
  // The bound issue is re-checked, and pinned references are resolved against the
  // authoritative core before acceptance; anything inaccessible rejects the turn.
  if (thread.pmContext) await resolvePmContextBinding(thread.pmContext, thread.scope, requestHeaders);
  const pmReferences = request.pmReferences?.length
    ? await resolvePmReferences(thread.scope!.workspaceId, request.pmReferences, requestHeaders)
    : undefined;
  if (pmReferences) assertResolvedReferences(pmReferences);
  if (
    (request.config?.providerInstanceId !== undefined &&
      request.config.providerInstanceId !== thread.settings.providerInstanceId) ||
    (request.config?.modelName !== undefined && request.config.modelName !== thread.settings.model) ||
    (request.config?.modelOptions !== undefined && JSON.stringify(request.config.modelOptions) !== JSON.stringify(thread.settings.modelOptions)) ||
    (request.config?.interactionMode !== undefined && request.config.interactionMode !== (thread.settings.interactionMode ?? "default"))
  )
    throw new ThreadConflictError("发送配置必须与已保存的会话模型一致。", "stale_settings");
  const resolved =
    runtime ??
    (await resolveProviderRuntime({
      providerInstanceId: thread.settings.providerInstanceId,
      modelName: thread.settings.model,
    }));
  const modelOptions = validatedModelOptions(resolved.providerInstanceId, thread.settings.model, thread.settings.modelOptions);
  const executionSnapshot = await resolveAgentScope(thread.scope, requestHeaders);
  if (!idle && request.trigger !== "regenerate-message") {
    const candidate = idleCompactionCandidate(request.id, "onReturn");
    const last = request.messages.at(-1);
    const branch = getThreadBranch(request.id);
    if (candidate && Date.now() >= candidate.expires && last?.role === "user" &&
        !getThreadHistory(request.id).messages.some((message) => message.id === last.id) &&
        !last.parts.some((part) => part.type === "text" && /^\/compact(?:\s|$)/i.test(part.text.trim())) &&
        JSON.stringify(request.messages.slice(0, -1).map((message) => message.id)) === JSON.stringify(branch.map((message) => message.id)) &&
        (request.system ?? thread.settings.systemPrompt) === candidate.latest.request.system) {
      await compactIdleThread(request.id, candidate.latest.id, "onReturn", requestHeaders);
      const newBranch = getThreadBranch(request.id);
      if (newBranch.at(-1)?.id !== branch.at(-1)?.id)
        request = { ...request, messages: [...newBranch.map(toUIMessage), last] };
    }
  }
  const generation = transaction(() => {
    const duplicate = findSubmittedChat(identity, fingerprint);
    if (duplicate) return duplicate;
    // Provider/PM resolution yields; archiving, deletion, settings or binding edits may have won meanwhile.
    requireRunnableThread(request.id, thread.revision);
    if (!samePmContext(getThread(request.id)?.pmContext, thread.pmContext))
      throw new ThreadConflictError("会话绑定的 PM 议题已更改，请重新发送。", "pm_context_conflict");
    if (idle) {
      const candidate = idleCompactionCandidate(request.id, idle.mode);
      const now = Date.now();
      if (state.stopping || !candidate || candidate.latest.id !== idle.expectedId ||
          !resolved.capabilities.nativeResume ||
          candidate.thread.nativeSession?.cwd !== executionSnapshot.path ||
          !sameAgentScope(candidate.thread.nativeScope, executionSnapshot.scope) ||
          JSON.stringify(candidate.thread.settings) !== JSON.stringify(candidate.latest.threadSettingsSnapshot) ||
          (idle.mode === "onReturn" ? now < candidate.expires : now < candidate.expires - 120_000 || now >= candidate.expires))
        throw new ThreadConflictError("会话状态已变化，跳过自动压缩。", "stale_compaction");
    }
    if (getActiveChat(request.id))
      throw new ThreadConflictError(
        "当前会话已有正在生成的回复，请恢复订阅或显式取消。",
        "chat_busy",
      );
    const accepted = acceptMessages(request);
    const last = accepted.at(-1)!;
    const continuingTools = last.role === "assistant" && request.trigger !== "regenerate-message";
    const id = crypto.randomUUID();
    const cancelled =
      readRecord("chat:cancellations", JSON.stringify([request.id, last.id])) !== null;
    const transfer = cancelled ? "" : consumeTransfers(request.id, id);
    const next: ChatGeneration = {
      id,
      threadId: request.id,
      messageId: continuingTools ? last.id : crypto.randomUUID(),
      parentId: continuingTools
        ? getThreadHistory(request.id).messages.find((message) => message.id === last.id)!.parent_id
        : last.id,
      status: "queued",
      seq: 0,
      createdAt: new Date().toISOString(),
      request: {
        ...request,
        messages: accepted,
        system: request.system ?? thread.settings.systemPrompt,
        transferContext: transfer,
      },
      providerInstanceId: resolved.providerInstanceId,
      providerInstanceRevision: resolved.instanceRevision,
      modelId: resolved.modelId,
      temperature: thread.settings.temperature,
      modelOptions,
      interactionMode: thread.settings.interactionMode ?? "default",
      ...(idle ? { idleCompaction: idle.mode } : {}),
      threadSettingsSnapshot: { ...thread.settings },
      executionSnapshot,
      ...(pmReferences ? { pmReferences } : {}),
    };
    saveGeneration(next);
    initializeNativeOutput(id, request.id);
    writeRecord(REQUESTS, identity, { id, fingerprint });
    updateThread(request.id, {});
    if (cancelled) settleChat(next.id, "cancelled");
    return getChatGeneration(next.id)!;
  });
  if (isChatActive(generation) && !workers.has(generation.id)) {
    clearTimeout(compactionTimers.get(generation.threadId));
    compactionTimers.delete(generation.threadId);
    launchChat(generation, resolved, requestHeaders);
  }
  return generation;
}
function nativePlan(
  generation: ChatGeneration,
  runtime: ProviderRuntime,
): {
  session?: CliSessionOptions;
  prompt: string;
  handoff: NonNullable<ChatGeneration["handoff"]>;
} {
  const thread = getThread(generation.threadId)!;
  const fork = thread.pendingFork;
  const forkOrigin = fork ? getChatGeneration(getThreadFork(generation.threadId)?.sourceRunId ?? "") : null;
  const snapshot = generation.executionSnapshot;
  const system = [
    generation.request.system,
    snapshot && agentContextIdentity(snapshot),
    pmContextPromptLine(thread.pmContext, generation.pmReferences),
    snapshot && `本次执行工作目录：${JSON.stringify(snapshot.path)}。目录位置不是隔离沙箱或额外授权。`,
  ].filter(Boolean).join("\n\n");
  const compatibleDirectory = (ref: NativeSessionRef | undefined) =>
    Boolean(snapshot && ref?.cwd === snapshot.path);
  if (
    fork &&
    !generation.continuationOf &&
    sameAgentScope(thread.pendingForkScope, snapshot?.scope) &&
    compatibleDirectory(fork.source) &&
    forkOrigin && forkOrigin.request.system === generation.request.system &&
    fork.source.providerInstanceId === runtime.providerInstanceId &&
    fork.source.instanceRevision === runtime.instanceRevision &&
    runtime.capabilities.nativeFork &&
    (fork.source.modelId === runtime.modelId ||
      runtime.capabilities.modelTransition === "native") &&
    (!fork.boundary || runtime.capabilities.boundedFork)
  ) {
    return {
      session: { fork },
      prompt: buildChatPrompt(
        generation.request.messages.slice(-1),
        system,
        generation.request.transferContext,
      ),
      handoff: { mode: "native-fork", reason: "从已保存的原生边界建立分支。" },
    };
  }
  const ref = thread.nativeSession;
  const index =
    ref && thread.nativeMessageId
      ? generation.request.messages.findIndex((message) => message.id === thread.nativeMessageId)
      : -1;
  const modelCompatible =
    ref?.modelId === runtime.modelId || runtime.capabilities.modelTransition === "native";
  if (
    ref?.providerInstanceId === runtime.providerInstanceId &&
    ref.instanceRevision === runtime.instanceRevision &&
    sameAgentScope(thread.nativeScope, snapshot?.scope) &&
    compatibleDirectory(ref) &&
    runtime.capabilities.nativeResume &&
    index >= 0 &&
    modelCompatible &&
    thread.nativeSystemPrompt === generation.request.system &&
    !generation.continuationOf
  ) {
    return {
      session: { resume: ref },
      prompt: buildChatPrompt(
        generation.request.messages.slice(index + 1),
        undefined,
        generation.request.transferContext,
      ),
      handoff: { mode: "native", reason: "同账号原生会话续接；只发送新的回合。" },
    };
  }
  const previous = generation.continuationOf ? getChatGeneration(generation.continuationOf) : null;
  if (
    generation.continuationOf &&
    generation.nativeSession?.providerInstanceId === runtime.providerInstanceId &&
    generation.nativeSession.instanceRevision === runtime.instanceRevision &&
    compatibleDirectory(generation.nativeSession) &&
    sameAgentScope(previous?.executionSnapshot?.scope, snapshot?.scope) &&
    previous?.executionSnapshot?.path === snapshot?.path &&
    runtime.capabilities.nativeResume &&
    generation.request.system === previous?.request.system &&
    ((generation.nativeSession.modelId ?? previous?.modelId) ===
      runtime.modelId ||
      runtime.capabilities.modelTransition === "native")
  ) {
    return {
      session: { resume: generation.nativeSession },
      prompt: buildChatPrompt(
        generation.request.messages.slice(-1),
        undefined,
        generation.request.transferContext,
      ),
      handoff: { mode: "native", reason: "用户确认后的原生恢复；先核对已有进度，不重放原始任务。" },
    };
  }
  return {
    prompt: buildChatPrompt(
      generation.request.messages,
      system,
      generation.request.transferContext,
    ),
    handoff: {
      mode: "portable",
      reason:
        ref || fork || previous
          ? "实例、模型、系统指令、作用域目录或分支边界变化，使用已保存上下文移交。"
          : "首次使用当前实例。",
    },
  };
}
function launchChat(generation: ChatGeneration, runtime: ProviderRuntime, requestHeaders?: Headers): void {
  const threadSnapshot = getThread(generation.threadId);
  const controller = new AbortController();
  controllers.set(generation.id, controller);
  let callbackFailure: unknown;
  const worker = withThreadExecution(
    generation.threadId,
    async () => {
      if (controller.signal.aborted) return;
      const snapshot = generation.executionSnapshot;
      if (!snapshot)
        throw new DurableError(412, "scope_required", "本次执行没有可信目录快照，请选择上下文后新建请求。");
      const assertLiveAuthorization = () => {
        const current = getChatGeneration(generation.id);
        if (state.stopping || controller.signal.aborted || controllers.get(generation.id) !== controller ||
            current?.status !== "running" || current.threadId !== generation.threadId ||
            current.messageId !== generation.messageId || getActiveChat(generation.threadId)?.id !== generation.id ||
            current.providerInstanceId !== generation.providerInstanceId ||
            current.providerInstanceRevision !== generation.providerInstanceRevision ||
            !sameAgentScope(current.executionSnapshot?.scope, snapshot.scope) || current.executionSnapshot?.path !== snapshot.path)
          throw new DurableError(409, "stale_execution", "本次原生回调不再属于当前聊天执行。");
        const instance = getStoredInstance(generation.providerInstanceId);
        if (!instance?.enabled || instance.revision !== generation.providerInstanceRevision ||
            runtime.providerInstanceId !== generation.providerInstanceId || runtime.instanceRevision !== generation.providerInstanceRevision)
          throw new ProviderRuntimeError(409, "session_mismatch", "Agent configuration changed during execution authorization.");
        const thread = requireRunnableThread(generation.threadId, threadSnapshot?.revision);
        if (!threadSnapshot || !sameAgentScope(thread.scope, snapshot.scope) ||
            JSON.stringify(thread.settings) !== JSON.stringify(generation.threadSettingsSnapshot))
          throw new ThreadConflictError("会话作用域或模型设置已更改，拒绝过期原生回调。", "stale_settings");
        if (!samePmContext(thread.pmContext, threadSnapshot.pmContext))
          throw new ThreadConflictError("会话绑定的 PM 议题已更改，拒绝过期原生回调。", "pm_context_conflict");
      };
      // The initiating PM credentials live only in this closure, not the provider binding or Chat records.
      const authorizeExecution = async (action: "compaction" | "tool") => {
        assertLiveAuthorization();
        if (action === "tool" && generation.idleCompaction)
          throw new DurableError(412, "scope_required", "无工具的会话压缩不能获得 PM 工具权限。");
        const resolved = await resolveAgentScope(snapshot.scope, requestHeaders);
        assertLiveAuthorization();
        if (!sameAgentScope(resolved.scope, snapshot.scope) || resolved.path !== snapshot.path)
          throw new DurableError(409, "scope_conflict", "本次执行的文件区域已更改，拒绝过期原生回调。");
        if (threadSnapshot?.pmContext) {
          await resolvePmContextBinding(threadSnapshot.pmContext, snapshot.scope, requestHeaders);
          assertLiveAuthorization();
        }
      };
      const bridge = generation.idleCompaction ? undefined : await openPmToolBridge({
        scope: snapshot.scope, threadId: generation.threadId, messageId: generation.messageId,
        generationId: generation.id, headers: requestHeaders, authorizeExecution,
      });
      const observe = async (phase: string) => {
        try {
          const result = await observePmCoreChanges(snapshot.scope, requestHeaders ?? new Headers());
          if (result.status === "failed" || result.status === "incomplete") emitNativeOutput(generation.id, { type: "item.upsert", item: { id: `pm-core-observation:${phase}`, type: "notification", status: "failed", title: "PM core observation unavailable", text: result.error ?? "Observation failed or was incomplete." } });
        } catch {
          emitNativeOutput(generation.id, { type: "item.upsert", item: { id: `pm-core-observation:${phase}`, type: "notification", status: "failed", title: "PM core observation unavailable", text: "Could not observe PM core files." } });
        }
      };
      try {
      await observe("before");
      saveGeneration({ ...getChatGeneration(generation.id)!, status: "running" });
      setNativeOutputStatus(generation.id, "running");
      let failed: unknown;
      let source: ReadableStream<UIMessageChunk>;
        const plan = nativePlan(generation, runtime);
        if (generation.idleCompaction && !plan.session?.resume)
          throw new ThreadConflictError("原生会话已变化，跳过自动压缩。", "stale_compaction");
        saveGeneration({
          ...getChatGeneration(generation.id)!,
          handoff: plan.handoff,
          nativeSession: plan.session?.resume,
        });
        beginThreadUsage({ threadId: generation.threadId, generationId: generation.id,
          instanceId: runtime.providerInstanceId, model: runtime.modelId, session: plan.session?.resume });
        if (!plan.session?.resume) setThreadNativeSession(generation.threadId, undefined);
        source = createUIMessageStream({
          generateId: () => generation.messageId,
          execute: async ({ writer }) => {
            const textId = crypto.randomUUID();
            writer.write({ type: "start", messageId: generation.messageId, messageMetadata: { durable: { generationId: generation.id, nativeOutput: true } } });
            writer.write({ type: "text-start", id: textId });
            const mode = generation.request.config?.responseStreamingMode ?? "paragraph";
            const filter = makeAssistantStreamingFilter(mode);
            const items = new Map<string, NativeOutputItem>();
            const visible = new Map<string, string>();
            let legacyText = "";
            let legacyVisible = "";
            let hasAssistantItem = false;
            let timer: NodeJS.Timeout | undefined;
            let usageSession: NativeSessionRef | undefined = plan.session?.resume
              ? { ...plan.session.resume, turnId: undefined, messageId: undefined }
              : undefined;
            const onUsage = (update: NativeUsageUpdate) => {
              if (!update.turn && !update.reportedTurn && !update.context) return;
              const current = getChatGeneration(generation.id);
              if (!current) return;
              transaction(() => {
                const usage = recordNativeUsage({
                  generationId: generation.id, threadId: generation.threadId,
                  instanceId: runtime.providerInstanceId, provider: runtime.driver,
                  model: runtime.modelId, session: usageSession, update,
                });
                saveGeneration({ ...current, usage, ...(update.context ? { nativeContextReported: true } : {}) });
              });
            };
            let succeeded = false;
            const appendJournal = (text: string) => {
              if (!text.startsWith(legacyVisible)) return;
              const delta = text.slice(legacyVisible.length);
              if (delta) writer.write({ type: "text-delta", id: textId, delta });
              legacyVisible = text;
            };
            const publishStructuredJournal = () => {
              let text = "";
              let first = true;
              for (const [key, item] of items) {
                if (item.parentItemId) continue;
                if (!first) text += "\n\n";
                text += visible.get(key) ?? "";
                first = false;
              }
              appendJournal(text);
            };
            const publish = (key: string, text: string) => {
              if (key === "legacy") {
                if (hasAssistantItem) return;
                appendJournal(text);
                return;
              }
              const item = items.get(key);
              if (!item) return;
              visible.set(key, text);
              emitNativeOutput(generation.id, { type: "item.upsert", item: { ...item, text } });
              if (!item.parentItemId) publishStructuredJournal();
            };
            const schedule = () => {
              clearTimeout(timer);
              const delay = filter.nextDelay();
              timer = delay === null ? undefined : setTimeout(() => {
                timer = undefined;
                try {
                  for (const release of filter.releaseDue()) publish(release.key, release.text);
                  schedule();
                } catch (error) {
                  callbackFailure = error;
                  controller.abort("output-callback-failed");
                }
              }, delay);
            };
            try {
              recordUsageLaunch({
                generationId: generation.id, instanceId: runtime.providerInstanceId,
                instanceRevision: runtime.instanceRevision, provider: runtime.driver,
                model: runtime.modelId, modelOptions: generation.modelOptions,
                previousTurnIds: [plan.session?.resume?.turnId, plan.session?.fork?.source.turnId,
                  plan.session?.fork?.boundary?.turnId].filter((id): id is string => Boolean(id)),
              });
              const result = await runNativeRuntime(runtime, {
                prompt: generation.idleCompaction ? "/compact" : `${plan.prompt}\n\nPM tools are available through the generation-scoped CLI. List: ${[process.execPath, path.join(workspaceRoot, "packages/pm-cli/agent-tools.mjs"), bridge!.url, "tools", "list"].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ")}. For calls or reconciliation use the same command replacing list with call or result and supply JSON on stdin: {"operationId":"UUID","name":"pm_...","arguments":{...}}. Keep the same operationId and arguments to reconcile an unknown outcome; never redispatch an unknown write with a new ID. Tool results are authoritative; shell exit status or model text alone is not proof of a write.`,
                pmToolBridge: bridge ? { command: process.execPath, args: [path.join(workspaceRoot, "packages/pm-cli/agent-tools.mjs"), bridge.url] } : undefined,
                execution: { threadId: generation.threadId, generationId: generation.id,
                  messageId: generation.messageId, scope: snapshot.scope },
                authorizeExecution,
                signal: controller.signal,
                session: plan.session,
                modelOptions: generation.modelOptions,
                interactionMode: generation.interactionMode,
                cwd: snapshot.path,
                onText: (delta) => {
                  if (hasAssistantItem) return;
                  legacyText += delta;
                  const ready = filter.update("legacy", legacyText);
                  if (ready !== null) publish("legacy", ready);
                  schedule();
                },
                onEvent: (event) => {
                  if (event.type !== "item.upsert" || event.item.type !== "assistant_message") {
                    emitNativeOutput(generation.id, event);
                    return;
                  }
                  const item = event.item;
                  if (!item.parentItemId) hasAssistantItem = true;
                  const key = `item:${item.id}`;
                  items.set(key, item);
                  const text = item.text ?? "";
                  const terminal = !["pending", "running", "waiting"].includes(item.status);
                  const ready = terminal && mode === "paragraph"
                    ? filter.finish(key, text)
                    : filter.update(key, text);
                  if (ready !== null) publish(key, ready);
                  else emitNativeOutput(generation.id, {
                    type: "item.upsert",
                    item: { ...item, text: visible.get(key) ?? "" },
                  });
                  schedule();
                },
                onRequest: (request) => requestNativeInteraction(generation.id, request),
                onUsage,
                onSession: (ref) => {
                  usageSession = ref;
                  saveGeneration({ ...getChatGeneration(generation.id)!, nativeSession: ref });
                  updateUsageSession(generation.id, ref);
                  recordUsageLaunchSession(generation.id, ref);
                },
              });
              if (callbackFailure) throw callbackFailure;
              if (hasAssistantItem) appendJournal(result.text);
              if (result.nativeSession)
                saveGeneration({
                  ...getChatGeneration(generation.id)!,
                  nativeSession: result.nativeSession,
                });
              if (result.nativeSession) {
                usageSession = result.nativeSession;
                updateUsageSession(generation.id, result.nativeSession);
                recordUsageLaunchSession(generation.id, result.nativeSession);
              }
              if (result.nativeUsage) onUsage(result.nativeUsage);
              succeeded = true;
            } finally {
              clearTimeout(timer);
              for (const release of filter.flush()) publish(release.key, release.text);
              if (!hasAssistantItem && legacyText) {
                emitNativeOutput(generation.id, {
                  type: "item.upsert",
                  item: { id: `legacy-assistant:${textId}`, type: "assistant_message", status: succeeded ? "completed" : callbackFailure ? "failed" : controller.signal.aborted ? (state.stopping ? "interrupted" : "cancelled") : "failed", text: legacyText },
                });
              }
              writer.write({ type: "text-end", id: textId });
            }
            writer.write({ type: "finish", finishReason: "stop" });
          },
          onError: (error) => {
            failed = error;
            return sanitizeErrorMessage(error);
          },
        });
      const journal = source.pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
          transform(chunk, writer) {
            appendChunk(generation.id, chunk);
            writer.enqueue(chunk);
          },
        }),
      );
      const previous = generation.request.messages.at(-1);
      for await (const message of readUIMessageStream({
        stream: journal,
        ...(previous?.id === generation.messageId ? { message: previous } : {}),
        onError: (error) => {
          failed ??= error;
        },
      })) {
        const current = getChatGeneration(generation.id)!;
        const metadata = {
          ...(message.metadata as Record<string, unknown> | undefined),
          durable: { generationId: current.id, status: current.status, nativeOutput: true, ...(current.usage ? { usage: current.usage } : {}) },
        };
        saveFormattedMessage(
          generation.threadId,
          toStoredMessage({ ...message, metadata }, generation.parentId),
          true,
        );
      }
      if (failed) throw failed;
      } finally {
        await observe("after");
        await bridge?.close();
      }
    },
    controller.signal,
  )
    .then(() =>
      settleChat(
        generation.id,
        controller.signal.aborted ? (state.stopping ? "interrupted" : "cancelled") : "completed",
      ),
    )
    .catch((error) =>
      settleChat(
        generation.id,
        callbackFailure ? "failed" : controller.signal.aborted ? (state.stopping ? "interrupted" : "cancelled")
          : error && typeof error === "object" && "terminalStatus" in error
            && (error.terminalStatus === "cancelled" || error.terminalStatus === "interrupted") ? error.terminalStatus : "failed",
        callbackFailure ?? error,
      ),
    )
    .finally(() => {
      controllers.delete(generation.id);
      workers.delete(generation.id);
      const completed = getChatGeneration(generation.id);
      if (!state.stopping && completed?.status === "completed") scheduleIdleCompaction(completed, requestHeaders);
    });
  workers.set(generation.id, worker);
}
function settleChat(id: string, status: ChatGeneration["status"], error?: unknown): void {
  transaction(() => {
    const current = getChatGeneration(id)!;
    if (
      !isChatActive(current) &&
      !(current.status === "interrupted" && status === "interrupted" && workers.has(id))
    )
      return;
    const classified = error ? classifyProviderError(error, current.providerInstanceId) : undefined;
    const message =
      status === "interrupted"
        ? `${state.stopping ? "服务端已停止。" : classified?.message ? `${classified.message} ` : "执行已中断。"}已保存部分输出；恢复需明确确认，不会自动重放原始任务。`
        : classified?.message;
    const next: ChatGeneration = {
      ...current,
      status,
      endedAt: new Date().toISOString(),
      ...(message ? { error: message } : {}),
      ...(classified ? { errorClass: classified.errorClass, resetAt: classified.resetAt } : {}),
    };
    const saved = getThreadHistory(current.threadId).messages.find(
      (entry) => entry.id === current.messageId,
    );
    if (saved && getThread(current.threadId)) {
      saveFormattedMessage(
        current.threadId,
        {
          ...saved,
          content: {
            ...saved.content,
            metadata: {
              ...(saved.content.metadata as Record<string, unknown> | undefined),
              durable: {
                generationId: id,
                ...(getNativeOutput(id) ? { nativeOutput: true } : {}),
                status,
                ...(current.usage ? { usage: current.usage } : {}),
                ...(message ? { error: message } : {}),
              },
            },
          },
        },
        true,
      );
      next.output = toUIMessage(
        getThreadHistory(current.threadId).messages.find(
          (entry) => entry.id === current.messageId,
        )!,
      );
    }
    if (status === "completed" && current.nativeSession)
      setThreadNativeSession(
        current.threadId,
        current.nativeSession,
        current.messageId,
        current.request.system,
        current.executionSnapshot?.scope,
      );
    if (status !== "completed" && current.status !== "queued")
      setThreadNativeSession(current.threadId, undefined);
    const events = readChatEvents(id);
    if (status === "failed" && !events.some((event) => event.chunk.type === "error"))
      appendChunk(id, { type: "error", errorText: message ?? "回复失败。" });
    if (
      (status === "interrupted" || status === "cancelled") &&
      !events.some((event) => event.chunk.type === "abort")
    )
      appendChunk(id, { type: "abort", reason: message ?? "用户已取消。" });
    // Terminal notification follows the final event and saved output.
    saveGeneration({ ...next, seq: getChatGeneration(id)!.seq });
    if (getNativeOutput(id) && !isChatActive(next))
      endNativeOutput(id, status as "completed" | "failed" | "cancelled" | "interrupted");
  });
}
export async function cancelChat(id: string): Promise<void> {
  const current = getChatGeneration(id);
  if (!current || !isChatActive(current)) return;
  controllers.get(id)?.abort("explicit-cancel");
  closeNativeInteractions(id);
  // A queued task might wait behind a long workspace run: settle immediately, never execute it later.
  if (current.status === "queued") settleChat(id, "cancelled");
  else await workers.get(id);
}
export async function cancelThreadChat(
  threadId: string,
  target: { generationId?: string; messageId?: string },
): Promise<void> {
  if (target.messageId)
    writeRecord("chat:cancellations", JSON.stringify([threadId, target.messageId]), {
      cancelledAt: new Date().toISOString(),
    });
  const active = getActiveChat(threadId);
  if (
    active &&
    (target.generationId
      ? active.id === target.generationId
      : target.messageId
        ? active.request.messages.at(-1)?.id === target.messageId
        : true)
  )
    await cancelChat(active.id);
}
export async function continueChat(
  id: string,
  confirmSideEffects: boolean,
  idempotencyKey = `continue:${id}`,
  resolvedRuntime?: ProviderRuntime,
  requestHeaders?: Headers,
): Promise<ChatGeneration> {
  const previous = getChatGeneration(id);
  if (!previous) throw new ThreadConflictError("找不到该回复。", "not_found");
  if (previous.continuationId) return getChatGeneration(previous.continuationId)!;
  if (!["interrupted", "failed", "cancelled"].includes(previous.status))
    throw new ThreadConflictError("只有中断、失败或取消的回复可继续。");
  const thread = requireRunnableThread(previous.threadId);
  const unchangedSettings =
    JSON.stringify(thread.settings) === JSON.stringify(previous.threadSettingsSnapshot);
  const runtime =
    resolvedRuntime ??
    (await resolveProviderRuntime({
      providerInstanceId: unchangedSettings
        ? previous.providerInstanceId
        : thread.settings.providerInstanceId,
      modelName: unchangedSettings ? previous.modelId : thread.settings.model,
    }));
  const modelOptions = validatedModelOptions(runtime.providerInstanceId, thread.settings.model,
    unchangedSettings ? previous.modelOptions ?? thread.settings.modelOptions : thread.settings.modelOptions);
  const executionSnapshot = await resolveAgentScope(thread.scope, requestHeaders);
  if (!confirmSideEffects)
    throw new ThreadConflictError(
      "CLI 的外部副作用可能已发生。请核对后确认恢复。",
      "side_effect_confirmation_required",
    );
  const recovery: UIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [
      {
        type: "text",
        text: "用户已明确授权从刚才保存的中断状态继续。先核对已有输出和工作目录中的实际进度，仅完成尚未完成的部分；不要重新执行已完成的步骤或盲目重复外部写入。若无法判断副作用是否已发生，请先询问用户。",
      },
    ],
    metadata: { custom: { continuationOf: id, sideEffectsConfirmed: confirmSideEffects } },
  };
  const oldSystem = previous.threadSettingsSnapshot?.systemPrompt;
  const system =
    oldSystem !== undefined &&
    oldSystem !== thread.settings.systemPrompt &&
    (previous.request.system ?? "").startsWith(oldSystem)
      ? [
          thread.settings.systemPrompt,
          (previous.request.system ?? "").slice(oldSystem.length).trimStart(),
        ]
          .filter(Boolean)
          .join("\n\n")
      : previous.request.system;
  const request: ChatRequest = {
    id: previous.threadId,
    messages: [...getThreadBranch(previous.threadId).map(toUIMessage), recovery],
    system,
    transferContext: previous.request.transferContext,
    tools: previous.request.tools,
    config: previous.request.config,
    trigger: "submit-message",
    idempotencyKey,
  };
  // All identity checks and the lineage link commit before scheduling the provider.
  const identity = chatRequestIdentity(request);
  const generation = transaction(() => {
    const latest = getChatGeneration(id)!;
    if (latest.continuationId) return getChatGeneration(latest.continuationId)!;
    requireRunnableThread(previous.threadId, thread.revision);
    if (getActiveChat(previous.threadId))
      throw new ThreadConflictError("当前会话已有运行中的回复。");
    const messages = acceptMessages(request);
    const next: ChatGeneration = {
      id: crypto.randomUUID(),
      threadId: previous.threadId,
      messageId: crypto.randomUUID(),
      parentId: recovery.id,
      status: "queued",
      createdAt: new Date().toISOString(),
      seq: 0,
      request: { ...request, messages },
      providerInstanceId: runtime.providerInstanceId,
      providerInstanceRevision: runtime.instanceRevision,
      modelId: runtime.modelId,
      temperature: thread.settings.temperature,
      modelOptions,
      interactionMode: thread.settings.interactionMode ?? "default",
      threadSettingsSnapshot: { ...thread.settings },
      executionSnapshot,
      continuationOf: id,
      nativeSession: previous.nativeSession,
      ...(previous.pmReferences ? { pmReferences: previous.pmReferences } : {}),
    };
    saveGeneration(next);
    initializeNativeOutput(next.id, next.threadId);
    saveGeneration({
      ...latest,
      continuationId: next.id,
      continuationIdempotencyKey: idempotencyKey,
    });
    writeRecord(REQUESTS, identity, { id: next.id, fingerprint: chatRequestFingerprint(request) });
    return next;
  });
  if (!workers.has(generation.id) && isChatActive(generation)) launchChat(generation, runtime, requestHeaders);
  return generation;
}
export async function startChatRuntime(): Promise<void> {
  if (state.started) return;
  state.started = true;
  state.stopping = false;
  interruptPmToolCalls();
  for (const generation of listRecords<ChatGeneration>(GENERATIONS)) {
    if (!isChatActive(generation)) continue;
    const previous = generation.request.messages.at(-1);
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const event of readChatEvents(generation.id)) controller.enqueue(event.chunk);
        controller.close();
      },
    });
    for await (const message of readUIMessageStream({
      stream,
      ...(previous?.id === generation.messageId ? { message: previous } : {}),
      onError: () => {},
    }))
      saveFormattedMessage(
        generation.threadId,
        toStoredMessage(message, generation.parentId),
        true,
      );
    settleChat(generation.id, "interrupted");
  }
}
export async function stopChatRuntime(): Promise<void> {
  state.stopping = true;
  for (const timer of compactionTimers.values()) clearTimeout(timer);
  compactionTimers.clear();
  for (const controller of controllers.values()) controller.abort("server-shutdown");
  for (const generation of listRecords<ChatGeneration>(GENERATIONS))
    if (isChatActive(generation)) closeNativeInteractions(generation.id);
  for (const generation of listRecords<ChatGeneration>(GENERATIONS))
    if (generation.status === "queued") settleChat(generation.id, "interrupted");
  await Promise.all(workers.values());
  await Promise.all(compactionTasks);
  await stopPmCoreChanges();
  for (const generation of listRecords<ChatGeneration>(GENERATIONS))
    if (isChatActive(generation)) settleChat(generation.id, "interrupted");
  state.started = false;
}

export function getChatRecoveryCandidate(id: string): ChatRecoveryCandidate | null {
  const generation = getChatGeneration(id);
  if (!generation) return null;
  return {
    id,
    threadId: generation.threadId,
    status: generation.status,
    startedAt: generation.createdAt,
    errorClass: generation.errorClass,
    resetAt: generation.resetAt,
    providerInstanceId: generation.providerInstanceId,
    providerInstanceRevision: generation.providerInstanceRevision,
    requestBinding: createHash("sha256")
      .update(
        JSON.stringify({
          request: generation.request,
          providerInstanceId: generation.providerInstanceId,
          modelId: generation.modelId,
          instanceRevision: generation.providerInstanceRevision,
          executionSnapshot: generation.executionSnapshot,
        }),
      )
      .digest("hex"),
    latest:
      listChatGenerations(generation.threadId)[0]?.id === id &&
      JSON.stringify(generation.threadSettingsSnapshot) ===
        JSON.stringify(getThread(generation.threadId)?.settings),
    continuationRunId: generation.continuationId,
    continuationIdempotencyKey: generation.continuationIdempotencyKey,
  };
}
export async function continueChatRecovery(
  id: string,
  options: { idempotencyKey: string },
): Promise<{ id: string; status: ChatGeneration["status"] }> {
  const previous = getChatGeneration(id);
  if (!previous) throw new ThreadConflictError("找不到额度恢复的回复。", "not_found");
  if (previous.continuationId && previous.continuationIdempotencyKey !== options.idempotencyKey)
    throw new ThreadConflictError("该回复已有用户创建的后续执行。");
  if (previous.continuationId) {
    const accepted = getChatGeneration(previous.continuationId)!;
    return { id: accepted.id, status: accepted.status };
  }
  const runtime = await resolveProviderRuntime({
    providerInstanceId: previous.providerInstanceId,
    modelName: previous.modelId,
  });
  if (runtime.instanceRevision !== previous.providerInstanceRevision)
    throw new ThreadConflictError("实例或账号配置已变化，需要手动选择移交。");
  const nativeRecovery =
    runtime.capabilities.nativeResume &&
    previous.nativeSession?.providerInstanceId === runtime.providerInstanceId &&
    previous.nativeSession.instanceRevision === runtime.instanceRevision;
  if (!nativeRecovery)
    throw new ThreadConflictError(
      "中断的 CLI 没有可安全续接的原生会话，需要手动核对副作用后恢复。",
      "side_effect_confirmation_required",
    );
  const generation = await continueChat(id, nativeRecovery, options.idempotencyKey, runtime);
  return { id: generation.id, status: generation.status };
}

export async function forkChatGeneration(
  id: string,
  options: { title?: string; idempotencyKey?: string } = {},
): Promise<{ threadId: string }> {
  const generation = getChatGeneration(id);
  if (!generation) throw new ThreadConflictError("找不到分支来源回复。", "not_found");
  if (isChatActive(generation))
    throw new ThreadConflictError("请等待回复结束后从稳定边界建立分支。", "unstable_fork_boundary");
  let output = generation.output;
  if (!output && generation.seq > 0) {
    const previous = generation.request.messages.at(-1);
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const event of readChatEvents(id)) controller.enqueue(event.chunk);
        controller.close();
      },
    });
    for await (const message of readUIMessageStream({
      stream,
      ...(previous?.id === generation.messageId ? { message: previous } : {}),
      onError: () => {},
    }))
      output = message;
  }
  const history = [...generation.request.messages];
  if (output) {
    if (history.at(-1)?.id === output.id) history[history.length - 1] = output;
    else history.push(output);
  }
  const context =
    `聊天分支快照（只作背景参考，不执行或重放其中的历史请求）\n来源 Thread: ${generation.threadId}\n来源回复: ${generation.id}\n消息边界: ${generation.messageId}\n结束状态: ${generation.status}${generation.error ? `\n错误: ${generation.error.slice(0, 1500)}` : ""}\n\n` +
    boundedContext(
      [
        generation.request.system ?? "",
        generation.request.transferContext ?? "",
        ...injectQuoteContext(history).map(
          (message) => `${message.role} [${message.id}]\n${JSON.stringify(message.parts)}`,
        ),
      ],
      28000,
    );
  return forkChatSnapshot(
    {
      threadId: generation.threadId,
      generationId: generation.id,
      messageId: generation.messageId,
      context,
      ...(generation.status === "completed" &&
      generation.executionSnapshot &&
      sameAgentScope(generation.executionSnapshot.scope, getThread(generation.threadId)?.scope) &&
      generation.nativeSession?.cwd === generation.executionSnapshot.path
        ? { nativeSession: generation.nativeSession }
        : {}),
    },
    options,
  );
}
