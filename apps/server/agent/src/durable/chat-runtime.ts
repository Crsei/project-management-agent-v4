import { acquireChatDirectoryWriter, assertCollaborationThreadLifecycleMutation } from "../collaboration/coordinator.ts";
import { assertCollaborationChatAdmission, assertCollaborationModelInput, assertCollaborationThreadExecution, getCollaborationGenerationContext, recordCollaborationOutput } from "../collaboration/runs.ts";
import { getStoreIdentity, inventoryPersistence } from "./persistence-schema.ts";
import { resolveChatExecutionScope } from "../task-delivery/binding.ts";
import { createHash } from "node:crypto";
import path from "node:path";
import { workspaceRoot } from "../paths.ts";
import { interruptPmToolCalls, openPmToolBridge } from "../pm-tools.ts";
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
import type { PmToolTarget } from "@agent-workspace/contracts/pm-tools";
import type { ExecutionPolicy, TurnContext, PmReferenceInput, PmReferenceResolution } from "@agent-workspace/contracts/pm-references";
import { pmReferenceResolutionSchema } from "@agent-workspace/contracts/pm-references";
import { upsertNativeOutputItem, type NativeOutputItem, type ResponseStreamingMode } from "@agent-workspace/contracts/output";
import type { NativeUsageUpdate, ThreadUsageSnapshot } from "@agent-workspace/contracts/usage";
import type { ContextTransfer } from "@agent-workspace/contracts/durable";
import type { McpAppProducingIdentity } from "@agent-workspace/contracts/mcp-apps";
import { closeMcpAppSession } from "../mcp-apps/live.ts";
import { assertMcpThread, mcpIdentityFromHeaders } from "../mcp/identity.ts";
import { createPmVisibilityProjector, pmPayloadTargets, recordPmContentProvenance, recordPmQuoteProvenance } from "../pm-visibility.ts";
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
import { openAutomationGenerationConnectors, type AutomationGenerationConnectors } from "../automation-execution/connectors.ts";
import { assertNativeTemplateChatSnapshot } from "../automation-execution/native-templates/repository.ts";
import { automationRequestForNativeGeneration, getNativeGenerationPmTargetCeiling, isPmAnalysisGeneration } from "../automation-execution/context.ts";
import { queuePmAgentTerminal, startPmAgentSignals, stopPmAgentSignals } from "../automation-execution/pm-signals.ts";
import { resolvePmAnalysisChatSnapshot } from "../automation-execution/native-templates/pm-analysis-chat.ts";
import { boundedContext } from "./context.ts";
import { forkChatSnapshot } from "./forks.ts";
import { getDatabase, listRecords, readRecord, transaction, writeRecord } from "./store.ts";
import {
  closeNativeInteractions,
  emitNativeOutput,
  endNativeOutput,
  getNativeOutput,
  initializeNativeOutput,
  normalizeToolValue,
  requestNativeInteraction,
  setNativeOutputStatus,
} from "./native-output.ts";
import { makeAssistantStreamingFilter } from "./assistant-streaming.ts";
import { DurableError } from "./errors.ts";
import {
  agentExecutionIdentity,
  sameExecutionIdentity,
  type AgentExecutionSnapshot,
} from "./agent-execution.ts";
import {
  CHAT_FORMAT,
  bindMessageTurnContext,
  ensureThread,
  getThread,
  getThreadBranch,
  getThreadHistory,
  saveFormattedMessage,
  setThreadHead,
  setThreadNativeSession,
  ThreadConflictError,
  updateThread,
  freezeThreadExecution,
  type StoredMessage,
  assertThreadWritable,
} from "./threads.ts";
import {
  pmContextPromptLine,
  resolvePmReferenceOperations,
} from "./pm-context.ts";
import { chatContextResolveRequestSchema, type AcceptedChatContext, type ChatContextInput } from "@agent-workspace/contracts/message-context";
import { contextDigest, contextPromptText, projectContextMessage, resolveChatContextItems, resolveContextAttachmentParts, validateContextAttachmentBindings } from "./message-context.ts";
import { validateChatAttachments } from "../providers/chat-attachments.ts";

const GENERATIONS = "chat:generations";
const EVENTS = "chat:events";
const REQUESTS = "chat:requests";
type ChatSubmissionRecord = {
  version?: 1; id?: string; fingerprint: string; threadId?: string; submissionId?: string;
  inputMessageId?: string; state?: "resolving" | "accepted" | "rejected" | "unknown";
  storeId?: string; restoreEpoch?: number; reason?: string; updatedAt?: string;
};
export function lookupChatAcceptance(threadId: string, submissionId: string): ChatGeneration | null {
  const identity = chatRequestIdentity({ id: threadId, idempotencyKey: submissionId, messages: [] });
  const record = readRecord<ChatSubmissionRecord>(REQUESTS, identity);
  if (!record?.id) return null;
  const generation = getChatGeneration(record.id);
  if (generation?.threadId !== threadId) return null;
  if (record.version === 1) return record.state === "accepted" && record.threadId === threadId &&
    record.submissionId === submissionId && typeof record.inputMessageId === "string" &&
    record.inputMessageId === generation.inputMessageId ? generation : null;
  return generation.request.idempotencyKey === submissionId ? generation : null;
}
export function lookupChatSubmission(threadId: string, submissionId: string): {
  status: "accepted" | "not_accepted" | "unknown"; generationId?: string; reason?: string; storeId: string; restoreEpoch: number;
} {
  const store = getStoreIdentity(getDatabase());
  const identity = chatRequestIdentity({ id: threadId, idempotencyKey: submissionId, messages: [] });
  const record = readRecord<ChatSubmissionRecord>(REQUESTS, identity);
  const generation = lookupChatAcceptance(threadId, submissionId);
  if (generation && (!record?.inputMessageId || record.inputMessageId === generation.inputMessageId))
    return { status: "accepted", generationId: generation.id, storeId: store.storeId, restoreEpoch: store.restoreEpoch };
  if (record?.state === "rejected" && record.storeId === store.storeId && record.restoreEpoch === store.restoreEpoch)
    return { status: "not_accepted", reason: record.reason, storeId: store.storeId, restoreEpoch: store.restoreEpoch };
  return { status: "unknown", reason: record?.reason ?? "No complete original acceptance proof is available.", storeId: store.storeId, restoreEpoch: store.restoreEpoch };
}
export const assertChatLifecycleMutationAllowed = assertCollaborationThreadLifecycleMutation;
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
  contextItems?: ChatContextInput[];
};
export type ChatGeneration = {
  id: string;
  threadId: string;
  messageId: string;
  /** Input USER message identity is independent of the assistant output messageId. */
  inputMessageId?: string;
  traceId?: string;
  executionGrantId?: string;
  executionPolicy?: ExecutionPolicy;
  turnContext?: TurnContext;
  parentId: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  endedAt?: string;
  seq: number;
  request: ChatRequest;
  /** Exact sanitized system/transfer context selected for the model; raw admission evidence stays unchanged. */
  modelInputContext?: { system?: string; transferContext?: string };
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
  /** Immutable authorized PM operation evidence; never a Session owner or directory grant. */
  pmOperations?: { actorId: string; target: PmToolTarget }[];
};
type JournalEvent = { generationId: string; seq: number; chunk: UIMessageChunk };
type ChatRuntimeState = {
  controllers: Map<string, AbortController>;
  workers: Map<string, Promise<void>>;
  subscribers: Map<string, Set<() => void>>;
  admissions?: Set<Promise<void>>;
  started: boolean;
  stopping: boolean;
};
const stateKey = Symbol.for("agent-workspace.chat-runtime");
const globals = globalThis as typeof globalThis & { [stateKey]?: ChatRuntimeState };
const state: ChatRuntimeState = (globals[stateKey] ??= {
  controllers: new Map(),
  workers: new Map(),
  subscribers: new Map(),
  started: false,
  stopping: false,
});
const compactionTimers = new Map<string, NodeJS.Timeout>();
const compactionTasks = new Set<Promise<void>>();
const { controllers, workers, subscribers } = state;
const admissions = (state.admissions ??= new Set<Promise<void>>());
function beginChatAdmission(): () => void {
  if (state.stopping) throw new DurableError(503, "chat_runtime_stopping", "Chat execution is stopping; no new admission or history mutation is allowed.");
  const barrier = Promise.withResolvers<void>();
  admissions.add(barrier.promise);
  return () => { if (admissions.delete(barrier.promise)) barrier.resolve(); };
}
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
export function recordGenerationPmOperation(generationId: string, operation: { actorId: string; target: PmToolTarget }): void {
  transaction(() => {
    const generation = getChatGeneration(generationId);
    if (!generation || !isChatActive(generation)) throw new DurableError(409, "stale_execution", "PM operation no longer belongs to an active generation.");
    recordPmContentProvenance({ threadId: generation.threadId, generationId,
      messageIds: [generation.messageId], operationIds: [], targets: [operation.target], authorities: [operation] });
    const operations = generation.pmOperations ?? [];
    if (operations.some(item => item.actorId === operation.actorId && item.target.workspaceId === operation.target.workspaceId &&
        item.target.projectId === operation.target.projectId)) return;
    const authorizationEvidence = [...operations, { actorId: operation.actorId, target: { ...operation.target } }];
    saveGeneration({ ...generation, pmOperations: authorizationEvidence });
    if (generation.executionGrantId) {
      const grant = readRecord<Record<string, unknown>>("chat:execution-grants", generation.executionGrantId);
      if (grant) writeRecord("chat:execution-grants", generation.executionGrantId, { ...grant, authorizationEvidence });
    }
  });
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
/** Observation never resubmits and aborting this wait does not stop the generation. */
export async function waitForChatTerminal(id: string, signal?: AbortSignal): Promise<ChatGeneration> {
  signal?.throwIfAborted();
  const original = getChatGeneration(id);
  if (!original) throw new DurableError(404, "generation_not_found", "Original generation is unavailable.");
  if (!isChatActive(original)) return original;
  const { promise, resolve, reject } = Promise.withResolvers<ChatGeneration>();
  const listeners = subscribers.get(id) ?? new Set<() => void>();
  subscribers.set(id, listeners);
  const cleanup = () => { listeners.delete(check); if (!listeners.size) subscribers.delete(id); signal?.removeEventListener("abort", abort); };
  const abort = () => { cleanup(); reject(signal?.reason ?? new Error("Terminal observation cancelled.")); };
  const check = () => {
    const generation = getChatGeneration(id);
    if (!generation) { cleanup(); reject(new DurableError(409, "generation_unresolved", "Original generation disappeared before a terminal state was observed.")); }
    else if (!isChatActive(generation)) { cleanup(); resolve(generation); }
  };
  listeners.add(check);
  signal?.addEventListener("abort", abort, { once: true });
  check();
  return promise;
}
const toUIMessage = (entry: StoredMessage): UIMessage =>
  ({ id: entry.id, ...entry.content, ...(entry.turnContext ? {
    metadata: { ...(entry.content.metadata as Record<string, unknown> | undefined), turnContext: entry.turnContext },
  } : {}) }) as UIMessage;
const toStoredMessage = (message: UIMessage, parentId: string | null): StoredMessage => {
  const { id, ...content } = message;
  return { id, parent_id: parentId, format: CHAT_FORMAT, content };
};

export const defaultChatExecutionPolicy: ExecutionPolicy = {
  access: "full",
  mode: "audit-only",
  notice: "执行来源记录默认 full / audit-only；不新增操作许可或审批，现有身份、PM 权限、撤权及部署审批仍生效。",
};
const inputDigest = (message: UIMessage, originalQuote?: unknown) => createHash("sha256").update(JSON.stringify({
  role: message.role, parts: message.parts,
  quote: (message.metadata as { custom?: { quote?: unknown } } | undefined)?.custom?.quote ?? originalQuote,
  contextAttachments: (message.metadata as { custom?: { contextAttachments?: unknown } } | undefined)?.custom?.contextAttachments,
})).digest("hex");
function inputMessage(request: ChatRequest): UIMessage {
  const message = request.messages.findLast(message => message.role === "user");
  if (!message) throw new ThreadConflictError("执行必须有输入用户消息。", "invalid_turn_context");
  return message;
}
function frozenReferenceInputs(context: TurnContext): PmReferenceInput[] {
  return context.pmReferences.map(({ workspaceId, projectId, kind, id, revision }) => ({ workspaceId, projectId, kind, id, revision }));
}
function validateInputBinding(request: ChatRequest): TurnContext | undefined {
  const input = inputMessage(request);
  const saved = getThreadHistory(request.id).messages.find(message => message.id === input.id);
  if (saved && request.messages.at(-1)?.role === "user" && inputDigest(toUIMessage(saved)) !==
      inputDigest(input, (saved.content.metadata as { custom?: { quote?: unknown } } | undefined)?.custom?.quote))
    throw new ThreadConflictError("相同输入消息 ID 对应了不同内容；编辑须使用新消息 ID。", "idempotency_conflict");
  const context = saved?.turnContext;
  if (context && request.pmReferences !== undefined) {
    const frozen = frozenReferenceInputs(context);
    if (request.pmReferences.length !== frozen.length || request.pmReferences.some((reference, index) => {
      const original = frozen[index]!;
      return reference.workspaceId !== original.workspaceId || reference.projectId !== original.projectId ||
        reference.kind !== original.kind || reference.id !== original.id ||
        reference.revision !== null && reference.revision !== original.revision;
    }))
      throw new ThreadConflictError("已受理消息的 PM 上下文不可修改；请发送新消息。", "turn_context_conflict");
  }
  if (context && request.contextItems !== undefined) {
    const frozen = (context.contextItems ?? []).flatMap(item => item.input ? [item.input] : []);
    const supplied = request.contextItems.map((input, index) => {
      const original = frozen[index];
      if (input.source.type === "environment" && original?.source.type === "environment")
        return { ...input, source: { ...input.source, environmentDigest: input.source.environmentDigest ?? original.source.environmentDigest } };
      if (input.source.type === "terminal" && original?.source.type === "terminal")
        return { ...input, source: { ...input.source, environmentDigest: input.source.environmentDigest ?? original.source.environmentDigest } };
      if (input.source.type === "response" && original?.source.type === "response")
        return { ...input, source: { ...input.source, generationId: input.source.generationId ?? original.source.generationId,
          contentDigest: input.source.contentDigest ?? original.source.contentDigest } };
      if (input.source.type === "thread" && original?.source.type === "thread" ||
          input.source.type === "native-output" && original?.source.type === "native-output")
        return { ...input, source: { ...input.source, contentDigest: input.source.contentDigest ?? original.source.contentDigest } };
      return input;
    });
    if (contextDigest(chatContextResolveRequestSchema.parse({ contextItems: supplied }).contextItems) !== contextDigest(frozen))
      throw new ThreadConflictError("已受理消息的上下文不可修改；请使用新输入消息 ID。", "turn_context_conflict");
  }
  return context;
}
/** Audit metadata only: it never authorizes, expires or gates an operation. No credentials are stored. */
function bindExecutionInput(request: ChatRequest, generationId: string, references: PmReferenceResolution[],
  operations: NonNullable<ChatGeneration["pmOperations"]>, requestHeaders?: Headers, contextItems?: AcceptedChatContext[]) {
  const input = inputMessage(request);
  const existing = validateInputBinding(request);
  const executionGrantId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const context: TurnContext = existing ?? {
    version: 1, threadId: request.id, messageId: input.id,
    acceptedAt: new Date().toISOString(), pmReferences: references, executionGrantId,
    ...(contextItems?.length ? { contextItems } : {}),
  };
  bindMessageTurnContext(request.id, context);
  const identity = requestHeaders ? mcpIdentityFromHeaders(requestHeaders) : null;
  writeRecord("chat:execution-grants", executionGrantId, {
    id: executionGrantId, threadId: request.id, inputMessageId: input.id, generationId, traceId,
    inputDigest: contextDigest({ message: inputDigest(input), contextItems: context.contextItems?.map(item => item.input) }),
    issuedAt: new Date().toISOString(), policy: defaultChatExecutionPolicy,
    authorizationEvidence: operations,
    ...(identity ? { sourceGrantId: identity.grantId, actorId: identity.actorId } : { source: "local" }),
  });
  return { inputMessageId: input.id, traceId, executionGrantId,
    executionPolicy: defaultChatExecutionPolicy, turnContext: context };
}
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
    const canonical = getThreadHistory(request.id).messages.find(entry => entry.id === message.id)!;
    const quote = (canonical.content.metadata as { custom?: { quote?: { messageId?: unknown } } } | undefined)?.custom?.quote;
    if (canonical.content.role === "user" && typeof quote?.messageId === "string" &&
        quote.messageId !== message.id && known.has(quote.messageId))
      recordPmQuoteProvenance({ threadId: request.id, messageId: message.id, sourceMessageId: quote.messageId });
    accepted.push(toUIMessage(canonical));
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
  const metadata = last?.metadata as { custom?: { quote?: unknown; contextAttachments?: unknown } } | undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({
        trigger: request.trigger ?? "submit-message",
        messageId: request.messageId,
        tail: last
          ? { id: last.id, role: last.role, parts: last.parts, quote: metadata?.custom?.quote, contextAttachments: metadata?.custom?.contextAttachments }
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
        contextItems: request.contextItems,
      }),
    )
    .digest("hex");
}
function findSubmittedChat(identity: string, fingerprint: string): ChatGeneration | null {
  const existing = readRecord<ChatSubmissionRecord>(REQUESTS, identity);
  if (!existing) return null;
  if (existing.fingerprint !== fingerprint)
    throw new ThreadConflictError("相同提交身份对应了不同聊天请求。", "idempotency_conflict");
  if (existing.id) {
    const generation = getChatGeneration(existing.id);
    if (!generation) throw new ThreadConflictError("原受理记录缺少生成证据；不能重新派发。", "submission_unknown");
    return generation;
  }
  return null;
}
function requireRunnableThread(threadId: string, expectedRevision?: number) {
  assertThreadWritable(threadId);
  const thread = getThread(threadId);
  if (!thread) throw new ThreadConflictError("该会话已删除。", "thread_deleted");
  if (!thread.executionSelection)
    throw new DurableError(412, "session_cutover_required", "Old Sessions cannot execute; create a new Session.");
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
  if (!thread || thread.status !== "regular" || !thread.executionSelection || !latest || latest.status !== "completed" ||
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

/** Server-only synchronous hooks commit provenance/bindings with acceptance, before any native launch. */
export type ChatAdmissionHooks = { onAccepted: (generation: ChatGeneration) => void };
export async function submitChat(
  request: ChatRequest,
  runtime?: ProviderRuntime,
  requestHeaders?: Headers,
  idle?: { expectedId: string; mode: "onReturn" | "beforeCacheExpires" },
  admissionHooks?: ChatAdmissionHooks,
): Promise<ChatGeneration> {
  await startChatRuntime();
  const releaseAdmission = beginChatAdmission();
  try {
  const identity = chatRequestIdentity(request);
  const fingerprint = chatRequestFingerprint(request);
  const existing = findSubmittedChat(identity, fingerprint);
  if (existing) { await resolveChatExecutionScope(requireRunnableThread(existing.threadId), requestHeaders); return existing; }
  const reservationStore = getStoreIdentity(getDatabase());
  transaction(() => {
    const previous = readRecord<ChatSubmissionRecord>(REQUESTS, identity);
    if (previous?.fingerprint !== undefined && previous.fingerprint !== fingerprint)
      throw new ThreadConflictError("相同提交身份对应了不同聊天请求。", "idempotency_conflict");
    if (previous && previous.state !== "rejected")
      throw new ThreadConflictError("原提交仍在受理或待核对；只查询原键，不能重新派发。", "submission_unknown");
    writeRecord<ChatSubmissionRecord>(REQUESTS, identity, {
      version: 1, fingerprint, threadId: request.id, submissionId: request.idempotencyKey,
      inputMessageId: request.messages.at(-1)?.id, state: "resolving",
      storeId: reservationStore.storeId, restoreEpoch: reservationStore.restoreEpoch, updatedAt: new Date().toISOString(),
    });
  });
  try {
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
  const acceptDuplicateInput = (generation: ChatGeneration): ChatGeneration => {
    requireRunnableThread(request.id, thread.revision);
    if (state.stopping) throw new DurableError(503, "chat_runtime_stopping", "Runtime stopped during asynchronous admission.");
    const reservation = readRecord<ChatSubmissionRecord>(REQUESTS, identity);
    if (reservation?.state !== "resolving" || reservation.fingerprint !== fingerprint)
      throw new ThreadConflictError("原提交受理身份已变化；请核对原结果。", "submission_unknown");
    writeRecord<ChatSubmissionRecord>(REQUESTS, identity, { ...reservation, id: generation.id,
      inputMessageId: generation.inputMessageId, state: "accepted", updatedAt: new Date().toISOString() });
    return generation;
  };
  const submittedInput = inputMessage(request);
  const savedInput = getThreadHistory(request.id).messages.find(message => message.id === submittedInput.id);
  const savedQuote = (savedInput?.content.metadata as { custom?: { quote?: unknown } } | undefined)?.custom?.quote;
  if (savedInput && request.messages.at(-1)?.role === "user" &&
      inputDigest(toUIMessage(savedInput)) !== inputDigest(submittedInput, savedQuote)) {
    const projector = await createPmVisibilityProjector(request.id, requestHeaders ?? new Headers());
    const projectedInput = projector.history([savedInput])[0]!;
    if (inputDigest(toUIMessage(projectedInput)) === inputDigest(submittedInput))
      request = { ...request, messages: request.messages.map(message =>
        message.id === savedInput.id ? toUIMessage(savedInput) : message) };
  }
  const boundContext = validateInputBinding(request);
  if (boundContext && request.trigger !== "regenerate-message" && request.messages.at(-1)?.role === "user") {
    const original = listChatGenerations(request.id).find(generation => generation.inputMessageId === boundContext.messageId &&
      generation.request.trigger !== "regenerate-message" && !generation.continuationOf);
    if (original) { await resolveChatExecutionScope(thread, requestHeaders); return transaction(() => acceptDuplicateInput(original)); }
  }
  // A frozen context is metadata evidence, not a historic-body read. Recheck live
  // authority against the same entity, retaining the ORIGINAL accepted metadata.
  const referencesToAuthorize = boundContext
    ? frozenReferenceInputs(boundContext).map(reference => ({ ...reference, revision: null }))
    : request.pmReferences ?? [];
  const referenceEvidence = referencesToAuthorize.length
    ? await resolvePmReferenceOperations(referencesToAuthorize, requestHeaders)
    : undefined;
  const pmReferences = boundContext?.pmReferences ?? referenceEvidence?.references;
  const contextItems = boundContext?.contextItems ?? await resolveChatContextItems(request.id, request.contextItems ?? [], requestHeaders ?? new Headers());
  if (boundContext?.contextItems?.length) {
    const projector = await createPmVisibilityProjector(request.id, requestHeaders ?? new Headers());
    const saved = getThreadHistory(request.id).messages.find(message => message.id === boundContext.messageId)!;
    if (projector.history([saved])[0]?.turnContext?.contextItems?.some(item => item.visibility !== "available"))
      throw new DurableError(403, "context_forbidden", "Accepted source context is no longer readable; remove the reference in a new message.");
  }
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
  validateContextAttachmentBindings(inputMessage(request), request.contextItems ?? boundContext?.contextItems?.flatMap(item => item.input ? [item.input] : []));
  const analysisSnapshot = await resolvePmAnalysisChatSnapshot(request.id, request.idempotencyKey);
  const executionSnapshot = analysisSnapshot ?? await resolveChatExecutionScope(thread, requestHeaders);
  if (!thread.executionSelection) throw new DurableError(412, "session_cutover_required", "旧会话不能执行；请新建 Session。");
  if (!executionSnapshot.environment) throw new DurableError(412, "execution_environment_required", "Every executable Session requires a versioned actual environment.");
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
  await preflightNativeAttachments({
    threadId: request.id, executionSnapshot,
    request: { ...request, system: request.system ?? thread.settings.systemPrompt, transferContext: undefined },
  }, resolved, requestHeaders ?? new Headers(), boundContext ? undefined : { messageId: submittedInput.id, items: contextItems });
  const generation = transaction(() => {
    const duplicate = findSubmittedChat(identity, fingerprint);
    if (duplicate) return duplicate;
    const acceptedContext = validateInputBinding(request);
    if (acceptedContext && request.trigger !== "regenerate-message" && request.messages.at(-1)?.role === "user") {
      const original = listChatGenerations(request.id).find(generation => generation.inputMessageId === acceptedContext.messageId &&
        generation.request.trigger !== "regenerate-message" && !generation.continuationOf);
      if (original) return acceptDuplicateInput(original);
    }
    // Provider/PM resolution yields; archiving, deletion, settings or binding edits may have won meanwhile.
    requireRunnableThread(request.id, thread.revision);
    if (state.stopping) throw new DurableError(503, "chat_runtime_stopping", "Runtime stopped during asynchronous admission.");
    assertCollaborationChatAdmission(request.id, submittedInput.id, request.idempotencyKey);
    if (JSON.stringify(getThread(request.id)?.executionSelection) !== JSON.stringify(thread.executionSelection))
      throw new ThreadConflictError("Execution selection changed during admission.", "execution_selection_conflict");
    if (idle) {
      const candidate = idleCompactionCandidate(request.id, idle.mode);
      const now = Date.now();
      if (state.stopping || !candidate || candidate.latest.id !== idle.expectedId ||
          !resolved.capabilities.nativeResume ||
          candidate.thread.nativeSession?.cwd !== executionSnapshot.path ||
          !sameExecutionIdentity(candidate.thread.nativeEnvironment, executionSnapshot.environment) ||
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
    executionSnapshot.environment = { ...executionSnapshot.environment!, frozen: true };
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
        ...(pmReferences ? { pmReferences: pmReferences.map(({ workspaceId, projectId, kind, id, revision }) => ({ workspaceId, projectId, kind, id, revision })) } : {}),
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
      ...bindExecutionInput({ ...request, messages: accepted }, id, pmReferences ?? [], referenceEvidence?.operations ?? [], requestHeaders, contextItems),
      ...(pmReferences ? { pmReferences } : {}),
      ...(referenceEvidence?.operations.length ? { pmOperations: referenceEvidence.operations } : {}),
    };
    saveGeneration(next);
    freezeThreadExecution(request.id, executionSnapshot.environment!, executionSnapshot.path);
    initializeNativeOutput(id, request.id);
    writeRecord<ChatSubmissionRecord>(REQUESTS, identity, {
      version: 1, id, fingerprint, threadId: request.id, submissionId: request.idempotencyKey,
      inputMessageId: next.inputMessageId, state: "accepted", storeId: reservationStore.storeId,
      restoreEpoch: reservationStore.restoreEpoch, updatedAt: new Date().toISOString(),
    });
    admissionHooks?.onAccepted(next);
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
  } catch (error) {
    transaction(() => {
      const current = readRecord<ChatSubmissionRecord>(REQUESTS, identity);
      if (current?.state === "resolving" && !current.id) writeRecord<ChatSubmissionRecord>(REQUESTS, identity, {
        ...current, state: "rejected", reason: error instanceof DurableError || error instanceof ThreadConflictError ? error.code : "admission_rejected",
        updatedAt: new Date().toISOString(),
      });
    });
    throw error;
  }
  } finally { releaseAdmission(); }
}
type NativeHandoffInput = Pick<ChatGeneration, "threadId" | "request" | "executionSnapshot" | "continuationOf" | "nativeSession">;
type NativeHandoff = {
  session?: CliSessionOptions; messages: UIMessage[]; includeSystem: boolean;
  handoff: NonNullable<ChatGeneration["handoff"]>;
};
/** One source of truth for both before-accept byte validation and native dispatch. */
function nativeHandoff(generation: NativeHandoffInput, runtime: ProviderRuntime, forcePortable = false): NativeHandoff {
  const thread = getThread(generation.threadId);
  if (!thread) throw new ThreadConflictError("该会话已删除。", "thread_deleted");
  const fork = thread.pendingFork;
  const forkOrigin = fork ? getChatGeneration(getThreadFork(generation.threadId)?.sourceRunId ?? "") : null;
  const snapshot = generation.executionSnapshot;
  const compatibleDirectory = (ref: NativeSessionRef | undefined) => Boolean(snapshot && ref?.cwd === snapshot.path);
  if (!forcePortable && fork && !generation.continuationOf &&
      sameExecutionIdentity(thread.pendingForkEnvironment, snapshot?.environment) && compatibleDirectory(fork.source) &&
      forkOrigin && forkOrigin.request.system === generation.request.system &&
      fork.source.providerInstanceId === runtime.providerInstanceId && fork.source.instanceRevision === runtime.instanceRevision &&
      runtime.capabilities.nativeFork && (fork.source.modelId === runtime.modelId || runtime.capabilities.modelTransition === "native") &&
      (!fork.boundary || runtime.capabilities.boundedFork))
    return { session: { fork }, messages: generation.request.messages.slice(-1), includeSystem: true,
      handoff: { mode: "native-fork", reason: "从已保存的原生边界建立分支。" } };
  const ref = thread.nativeSession;
  const index = ref && thread.nativeMessageId ? generation.request.messages.findIndex(message => message.id === thread.nativeMessageId) : -1;
  const modelCompatible = ref?.modelId === runtime.modelId || runtime.capabilities.modelTransition === "native";
  if (!forcePortable && ref?.providerInstanceId === runtime.providerInstanceId && ref.instanceRevision === runtime.instanceRevision &&
      sameExecutionIdentity(thread.nativeEnvironment, snapshot?.environment) && compatibleDirectory(ref) &&
      runtime.capabilities.nativeResume && index >= 0 && modelCompatible &&
      thread.nativeSystemPrompt === generation.request.system && !generation.continuationOf)
    return { session: { resume: ref }, messages: generation.request.messages.slice(index + 1), includeSystem: false,
      handoff: { mode: "native", reason: "同账号原生会话续接；只发送新的回合。" } };
  const previous = generation.continuationOf ? getChatGeneration(generation.continuationOf) : null;
  if (!forcePortable && generation.continuationOf && generation.nativeSession?.providerInstanceId === runtime.providerInstanceId &&
      generation.nativeSession.instanceRevision === runtime.instanceRevision && compatibleDirectory(generation.nativeSession) &&
      sameExecutionIdentity(previous?.executionSnapshot?.environment, snapshot?.environment) &&
      previous?.executionSnapshot?.path === snapshot?.path && runtime.capabilities.nativeResume &&
      generation.request.system === previous?.request.system &&
      ((generation.nativeSession.modelId ?? previous?.modelId) === runtime.modelId || runtime.capabilities.modelTransition === "native"))
    return { session: { resume: generation.nativeSession }, messages: generation.request.messages.slice(-1), includeSystem: false,
      handoff: { mode: "native", reason: "用户确认后的原生恢复；先核对已有进度，不重放原始任务。" } };
  return { messages: generation.request.messages, includeSystem: true, handoff: { mode: "portable",
    reason: forcePortable ? "历史 PM 内容当前不可读或来源无法证明，使用过滤后的历史重建上下文；不重放业务工具。"
      : ref || fork || previous ? "实例、模型、系统指令、作用域目录或分支边界变化，使用已保存上下文移交。" : "首次使用当前实例。" } };
}
/** Both fresh admission and explicit recovery validate the same projected byte set as dispatch. */
async function preflightNativeAttachments(
  generation: NativeHandoffInput, runtime: ProviderRuntime, headers: Headers,
  current?: { messageId: string; items: AcceptedChatContext[] },
): Promise<void> {
  const projector = await createPmVisibilityProjector(generation.threadId, headers);
  const byId = new Map(getThreadHistory(generation.threadId).messages.map(message => [message.id, message]));
  const history = projector.history(generation.request.messages.map((message, index) =>
    byId.get(message.id) ?? toStoredMessage(message, generation.request.messages[index - 1]?.id ?? null)));
  const lineage = new Set<string>();
  let ancestor = generation.continuationOf;
  while (ancestor && !lineage.has(ancestor)) { lineage.add(ancestor); ancestor = getChatGeneration(ancestor)?.continuationOf; }
  const transfers = listRecords<ContextTransfer>(TRANSFERS).filter(value => value.parentThreadId === generation.threadId &&
    (!generation.continuationOf && !value.consumedAt || Boolean(value.consumedByRunId && lineage.has(value.consumedByRunId))));
  let forcePortable = projector.nativeContextContaminated || Boolean(generation.request.transferContext?.trim() && !transfers.length);
  for (const transfer of transfers) {
    if (!getThread(transfer.sourceThreadId)) forcePortable = true;
    else forcePortable ||= (await createPmVisibilityProjector(transfer.sourceThreadId, headers)).nativeContextContaminated;
  }
  const handoff = nativeHandoff({ ...generation, request: { ...generation.request, messages: history.map(toUIMessage) } }, runtime, forcePortable);
  const selected = new Set(handoff.messages.map(message => message.id));
  const parts: UIMessage["parts"] = [];
  for (const entry of history) if (selected.has(entry.id)) {
    parts.push(...toUIMessage(entry).parts);
    parts.push(...await resolveContextAttachmentParts(current && entry.id === current.messageId ? current.items : entry.turnContext?.contextItems, headers));
  }
  validateChatAttachments(parts, runtime.driver);
}
function nativePlan(generation: ChatGeneration, runtime: ProviderRuntime, forcePortable = false) {
  const plan = nativeHandoff(generation, runtime, forcePortable), snapshot = generation.executionSnapshot;
  const system = plan.includeSystem ? [generation.request.system, snapshot && agentExecutionIdentity(snapshot),
    snapshot && `本次执行工作目录：${JSON.stringify(snapshot.path)}。目录位置不是隔离沙箱或额外授权。`].filter(Boolean).join("\n\n") : undefined;
  return { ...plan, prompt: buildChatPrompt(plan.messages, [system, pmContextPromptLine(generation.pmReferences)].filter(Boolean).join("\n\n"),
    generation.request.transferContext, generation.inputMessageId) };
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
      await closeMcpAppSession(generation.threadId, { preserveContext: true });
      if (controller.signal.aborted) return;
      const snapshot = generation.executionSnapshot;
      if (!snapshot?.environment)
        throw new DurableError(412, "execution_environment_required", "This execution has no versioned authorized environment; create a new Session.");
      const collaborationOwned = getCollaborationGenerationContext(generation.id) !== null;
      const releaseWriter = await acquireChatDirectoryWriter(generation.threadId, generation.id, snapshot.path, controller.signal);
      try {
      let admittedModelContexts: { messageId: string; contextId: string; inputDigest: string }[] = [];
      const assertLiveAuthorization = () => {
        const current = getChatGeneration(generation.id);
        if (state.stopping || controller.signal.aborted || controllers.get(generation.id) !== controller ||
            current?.status !== "running" || current.threadId !== generation.threadId ||
            current.messageId !== generation.messageId || getActiveChat(generation.threadId)?.id !== generation.id ||
            current.providerInstanceId !== generation.providerInstanceId ||
            current.providerInstanceRevision !== generation.providerInstanceRevision ||
            !sameExecutionIdentity(current.executionSnapshot?.environment, snapshot.environment) || current.executionSnapshot?.path !== snapshot.path)
          throw new DurableError(409, "stale_execution", "本次原生回调不再属于当前聊天执行。");
        const instance = getStoredInstance(generation.providerInstanceId);
        if (!instance?.enabled || instance.revision !== generation.providerInstanceRevision ||
            runtime.providerInstanceId !== generation.providerInstanceId || runtime.instanceRevision !== generation.providerInstanceRevision)
          throw new ProviderRuntimeError(409, "session_mismatch", "Agent configuration changed during execution authorization.");
        const thread = requireRunnableThread(generation.threadId, threadSnapshot?.revision);
        if (!threadSnapshot || !sameExecutionIdentity(thread.executionEnvironment, snapshot.environment) ||
            JSON.stringify(thread.settings) !== JSON.stringify(generation.threadSettingsSnapshot))
          throw new ThreadConflictError("会话作用域或模型设置已更改，拒绝过期原生回调。", "stale_settings");
        if (!thread.executionSelection || !thread.executionEnvironment?.frozen || thread.executionPath !== snapshot.path ||
            !sameExecutionIdentity(thread.executionEnvironment, snapshot.environment))
          throw new DurableError(409, "execution_environment_changed", "The accepted Session execution environment is no longer authoritative.");
      };
      const assertExternalGrant = async () => {
        if (!requestHeaders?.get("authorization")?.startsWith("Bearer pm-mcp-service-v1.")) return;
        const identity = mcpIdentityFromHeaders(requestHeaders);
        if (!identity || identity.access !== "full")
          throw new DurableError(403, "mcp_write_forbidden", "原 MCP 委托不允许执行 Chat。");
        await assertMcpThread(identity, generation.threadId);
        assertLiveAuthorization();
      };
      // The initiating PM credentials live only in this closure, not the provider binding or Chat records.
      const authorizeExecution = async (action: "launch" | "compaction" | "tool") => {
        assertLiveAuthorization();
        await assertExternalGrant();
        if (action === "tool" && generation.idleCompaction)
          throw new DurableError(412, "scope_required", "无工具的会话压缩不能获得 PM 工具权限。");
        try {
          const analysis = await resolvePmAnalysisChatSnapshot(generation.threadId, generation.request.idempotencyKey, controller.signal);
          const resolved = analysis ?? await resolveChatExecutionScope(requireRunnableThread(generation.threadId), requestHeaders, "execute", controller.signal);
          if (analysis) await assertCollaborationThreadExecution(generation.threadId, requestHeaders, controller.signal, generation.id);
          assertLiveAuthorization();
          if (resolved.path !== snapshot.path || !sameExecutionIdentity(resolved.environment, snapshot.environment))
            throw new DurableError(409, "execution_environment_changed", "Current execution directory differs from the accepted versioned environment.");
          if (!analysis) await assertNativeTemplateChatSnapshot(generation, resolved);
          if (admittedModelContexts.length) {
            const projection = await createPmVisibilityProjector(generation.threadId, requestHeaders ?? new Headers());
            const current = projection.history(getThreadHistory(generation.threadId).messages);
            for (const selected of admittedModelContexts) if (!current.find(message => message.id === selected.messageId)?.turnContext?.contextItems?.some(item =>
              item.visibility === "available" && item.contextId === selected.contextId && item.inputDigest === selected.inputDigest))
              throw new DurableError(403, "context_authorization_changed", "Selected source context is no longer readable; no further native dispatch is authorized.");
          }
          assertLiveAuthorization();
          await assertExternalGrant();
        } catch (error) {
          // Cancellation or a revision cutover wins even when it aborts the in-flight PM request.
          assertLiveAuthorization();
          throw error;
        }
      };
      const templateChild = automationRequestForNativeGeneration(generation)?.config.action.kind === "template";
      // Retained Apps use current browser authority, not a completed generation's
      // tool grant or the initiating user's saved credentials.
      const authorizeMcpApp = generation.idleCompaction || templateChild || isPmAnalysisGeneration(generation)
        ? undefined
        : async (headers: Headers, producing: McpAppProducingIdentity): Promise<void> => {
          const assertCurrent = () => {
            const current = getChatGeneration(generation.id);
            const thread = requireRunnableThread(generation.threadId);
            const instance = getStoredInstance(generation.providerInstanceId);
            const active = getActiveChat(generation.threadId);
            if (state.stopping || controller.signal.aborted ||
                producing.threadId !== generation.threadId || producing.generationId !== generation.id ||
                producing.providerInstanceId !== generation.providerInstanceId ||
                producing.instanceRevision !== generation.providerInstanceRevision ||
                !instance?.enabled || instance.revision !== generation.providerInstanceRevision ||
                !current || !["running", "completed"].includes(current.status) ||
                current.nativeSession?.sessionId !== producing.nativeSessionId ||
                (active && active.id !== generation.id) ||
                listRuns(generation.threadId).some(run => run.status === "queued" || run.status === "running") ||
                !sameExecutionIdentity(thread.executionEnvironment, snapshot.environment) ||
                JSON.stringify(thread.settings) !== JSON.stringify(generation.threadSettingsSnapshot) ||
                (current.status === "completed" && (
                  thread.nativeSession?.sessionId !== producing.nativeSessionId ||
                  thread.nativeMessageId !== generation.messageId ||
                  listChatGenerations(generation.threadId)[0]?.id !== generation.id
                )))
              throw new DurableError(409, "mcp_app_session_stale", "此 App 不再属于当前原生会话。");
            return thread;
          };
          const thread = assertCurrent();
          if (requestHeaders?.get("authorization")?.startsWith("Bearer pm-mcp-service-v1.")) {
            const originalGrant = mcpIdentityFromHeaders(requestHeaders);
            if (!originalGrant)
              throw new DurableError(403, "mcp_grant_revoked", "产生此 App 的 MCP 委托已撤销。");
            await assertMcpThread(originalGrant, generation.threadId);
            assertCurrent();
          }
          const resolved = await resolveChatExecutionScope(thread, headers, "inspect");
          assertCurrent();
          if (resolved.path !== snapshot.path || !sameExecutionIdentity(resolved.environment, snapshot.environment))
            throw new DurableError(403, "mcp_app_execution_changed", "Current directory differs from the App's producing execution.");
        };
      const bridge = generation.idleCompaction || templateChild ? undefined : await openPmToolBridge({
        threadId: generation.threadId, messageId: generation.messageId,
        generationId: generation.id, headers: requestHeaders, authorizeExecution,
        traceId: generation.traceId, inputMessageId: generation.inputMessageId,
        executionGrantId: generation.executionGrantId,
        targetCeiling: getNativeGenerationPmTargetCeiling(generation),
        onAuthorizedOperation: operation => recordGenerationPmOperation(generation.id, operation),
      });
      let automationConnectors: AutomationGenerationConnectors | undefined;
      try {
      saveGeneration({ ...getChatGeneration(generation.id)!, status: "running" });
      setNativeOutputStatus(generation.id, "running");
      await authorizeExecution("launch");
      automationConnectors = await openAutomationGenerationConnectors(generation, requestHeaders, authorizeExecution);
      let failed: unknown;
      let source: ReadableStream<UIMessageChunk>;
        const projector = await createPmVisibilityProjector(generation.threadId, requestHeaders ?? new Headers());
        const stored = getThreadHistory(generation.threadId).messages;
        const byId = new Map(stored.map(message => [message.id, message]));
        const projectedHistory = projector.history(generation.request.messages.map((message, index) =>
          byId.get(message.id) ?? toStoredMessage(message, generation.request.messages[index - 1]?.id ?? null)));
        if (generation.turnContext?.contextItems?.length) {
          const current = projectedHistory.find(message => message.id === generation.inputMessageId)?.turnContext?.contextItems;
          if (!current || current.length !== generation.turnContext.contextItems.length || current.some(item => item.visibility !== "available"))
            throw new DurableError(403, "context_forbidden", "The accepted selected context became unavailable before native dispatch; no Provider turn was sent.");
        }
        const visibleReferences = (entry: StoredMessage | undefined) => (entry?.turnContext?.pmReferences ?? [])
          .flatMap(reference => { const parsed = pmReferenceResolutionSchema.safeParse(reference); return parsed.success ? [parsed.data] : []; });
        const modelMessages = await Promise.all(projectedHistory.map(async entry => {
          const message = projectContextMessage(toUIMessage(entry), entry.turnContext?.contextItems,
            await resolveContextAttachmentParts(entry.turnContext?.contextItems, requestHeaders ?? new Headers()));
          const line = entry.id !== generation.inputMessageId ? pmContextPromptLine(visibleReferences(entry)) : undefined;
          return line ? { ...message, parts: [{ type: "text" as const, text: line }, ...message.parts] } : message;
        }));
        admittedModelContexts = projectedHistory.flatMap(message => (message.turnContext?.contextItems ?? [])
          .filter(item => item.visibility === "available" && (item.dependencies?.some(source => source.threadId !== generation.threadId) ||
            item.pmProvenance?.targets.length || item.pmProvenance?.operationIds.length || item.pmProvenance?.authorities?.length))
          .map(item => ({ messageId: message.id, contextId: item.contextId, inputDigest: item.inputDigest })));
        const dependencies = projector.visibleProvenance(modelMessages.map(message => message.id));
        const lineage = new Set([generation.id]);
        let ancestor = generation.continuationOf;
        while (ancestor && !lineage.has(ancestor)) {
          lineage.add(ancestor);
          ancestor = getChatGeneration(ancestor)?.continuationOf;
        }
        const transfers = listRecords<ContextTransfer>(TRANSFERS).filter(transfer =>
          transfer.parentThreadId === generation.threadId && transfer.consumedByRunId && lineage.has(transfer.consumedByRunId));
        const transferTargets: PmToolTarget[] = [];
        const transferOperationIds: string[] = [];
        const transferAuthorities: NonNullable<ChatGeneration["pmOperations"]> = [];
        const transferContextSources: { threadId: string; messageIds: string[] }[] = [];
        let transferContaminated = Boolean(generation.request.transferContext?.trim() && !transfers.length);
        for (const transfer of transfers) {
          if (!getThread(transfer.sourceThreadId)) { transferContaminated = true; continue; }
          const sourceProjection = await createPmVisibilityProjector(transfer.sourceThreadId, requestHeaders ?? new Headers());
          transferContaminated ||= sourceProjection.nativeContextContaminated;
          transferTargets.push(...sourceProjection.provenance.targets);
          transferOperationIds.push(...sourceProjection.provenance.operationIds);
          transferAuthorities.push(...(sourceProjection.provenance.authorities ?? []));
          transferContextSources.push({ threadId: transfer.sourceThreadId, messageIds: [] }, ...(sourceProjection.provenance.contextSources ?? []));
        }
        const contaminated = projector.nativeContextContaminated || transferContaminated;
        recordPmContentProvenance({
          threadId: generation.threadId, generationId: generation.id, messageIds: [generation.messageId],
          operationIds: [...dependencies.operationIds, ...(!transferContaminated ? transferOperationIds : [])],
          contextSources: [...(dependencies.contextSources ?? []), ...(!transferContaminated ? transferContextSources : [])],
          targets: [...dependencies.targets, ...pmPayloadTargets(projectedHistory), ...(!transferContaminated ? transferTargets : [])],
          authorities: [...(dependencies.authorities ?? []), ...(!transferContaminated ? transferAuthorities : []),
            ...(generation.pmOperations ?? []).filter(operation => visibleReferences(
              projectedHistory.find(message => message.id === generation.inputMessageId)).some(reference =>
                reference.workspaceId === operation.target.workspaceId && reference.projectId === operation.target.projectId))],
        });
        const modelGeneration: ChatGeneration = {
          ...generation,
          pmReferences: visibleReferences(projectedHistory.find(message => message.id === generation.inputMessageId)),
          request: {
            ...generation.request, messages: modelMessages,
            ...(contaminated ? { system: threadSnapshot?.settings.systemPrompt, transferContext: undefined } : {}),
          },
        };
        const plan = nativePlan(modelGeneration, runtime, contaminated);
        assertCollaborationModelInput(generation.id, plan.prompt);
        if (generation.idleCompaction && !plan.session?.resume)
          throw new ThreadConflictError("原生会话已变化，跳过自动压缩。", "stale_compaction");
        saveGeneration({
          ...getChatGeneration(generation.id)!,
          handoff: plan.handoff,
          modelInputContext: { system: modelGeneration.request.system, transferContext: modelGeneration.request.transferContext },
          nativeSession: plan.session?.resume,
        });
        beginThreadUsage({ threadId: generation.threadId, generationId: generation.id,
          instanceId: runtime.providerInstanceId, model: runtime.modelId, session: plan.session?.resume });
        if (!plan.session?.resume) setThreadNativeSession(generation.threadId, undefined);
        source = createUIMessageStream({
          generateId: () => generation.messageId,
          execute: async ({ writer }) => {
            const textId = crypto.randomUUID();
            writer.write({ type: "start", messageId: generation.messageId, messageMetadata: { durable: {
              generationId: generation.id, inputMessageId: generation.inputMessageId, traceId: generation.traceId,
              executionGrantId: generation.executionGrantId, executionPolicy: generation.executionPolicy, nativeOutput: true,
            } } });
            writer.write({ type: "text-start", id: textId });
            const mode = generation.request.config?.responseStreamingMode ?? "paragraph";
            const filter = makeAssistantStreamingFilter(mode);
            const items = new Map<string, NativeOutputItem>();
            const visible = new Map<string, string>();
            let legacyText = "";
            let legacyVisible = "";
            let hasAssistantItem = false;
            let bodySettled = false;
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
              const ordered: NativeOutputItem[] = [];
              for (const item of items.values()) upsertNativeOutputItem(ordered, item);
              // A native ordinal can arrive late, and unknown phase may become
              // commentary at completion. Neither is safe for an append-only body.
              if (!bodySettled && ordered.some(item => !item.parentItemId && (item.order || !item.phase))) return;
              const text = ordered.filter(item => !item.parentItemId && item.phase !== "commentary"
                && (bodySettled || item.phase === "final_answer"))
                .map(item => visible.get(`item:${item.id}`) ?? "").filter(Boolean).join("\n\n");
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
              await authorizeExecution("launch");
              recordUsageLaunch({
                generationId: generation.id, instanceId: runtime.providerInstanceId,
                instanceRevision: runtime.instanceRevision, provider: runtime.driver,
                model: runtime.modelId, modelOptions: generation.modelOptions,
                previousTurnIds: [plan.session?.resume?.turnId, plan.session?.fork?.source.turnId,
                  plan.session?.fork?.boundary?.turnId].filter((id): id is string => Boolean(id)),
              });
              const result = await runNativeRuntime(runtime, {
                prompt: generation.idleCompaction ? "/compact" : !bridge ? plan.prompt : [
                  plan.prompt,
                  "Optional PM tools: prefer the native pm_tools/MCP tools exposed in this session. Discover authorized PM workspaces first; no Session PM target is implied. Business calls require an explicit workspace/project target; pm_list_workspaces and pm_get_operation_result are target-free control reads. Follow each tool's input schema, including page limits; continue lists using nextCursor as after, not an oversized limit.",
                  `Only if native PM tools are unavailable and the shell can reach this generation's bridge, use the generation-scoped CLI. List: ${[process.execPath, path.join(workspaceRoot, "packages/pm-cli/agent-tools.mjs"), bridge.url, "tools", "list"].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ")}. Replace list with call and supply an original invocation JSON on stdin: {"operationId":"UUID","name":"pm_...","target":{"workspaceId":"...","projectId":null},"arguments":{...}}. CLI result is only for an already retained exact original invocation, not reconstructed arguments. A sandboxed shell may not reach loopback even when native PM tools work; do not use shell recovery, repeatedly probe it, infer PM is down, or change network/security settings.`,
                  'For an unknown or interrupted PM outcome, call the native pm_get_operation_result with {"arguments":{"operationId":"ORIGINAL_UUID"}}. It reuses the server-persisted original target and arguments, only reconciles, and never dispatches a business command. Do not reconstruct the invocation, repeat the write tool, or create a new operationId for an unknown write. If still unknown or inaccessible, report the original operationId and unresolved result. A proven input rejection requires a corrected new request, not altered arguments under the old operationId. Tool results are authoritative; shell exit status or model text alone is not proof of a write.',
                  "For repository inventory or board preparation, unavailable PM queries prevent deduplication and PM writes, not authorized read-only repository analysis. Continue collecting source-backed candidate tasks, label them not checked against existing PM tasks, and report the exact access/error gap. Optional local workflow helpers are not PM prerequisites: if absent, use available read-only tools without installing or configuring them. Do not treat historical plans or unverified code as completed work.",
                  "When the user requests a PM project workflow, keep the selected repository directory and the explicitly authorized PM project distinct. Read current repository sources and all relevant PM task/document pages before creating a bounded, deduplicated board. Use native PM tools for project/task/comment/document writes, never edit .dovspace or PM storage directly. Preserve source paths, observed revisions, scope, non-goals and acceptance criteria; historical checked boxes are not current verification.",
                  "Before choosing or changing task state, call pm_read_workflow for the explicit project and use the returned configured states/categories/transitions, not guessed status names. Read the selected task's current pm_task_brief, relations and comments before execution. Record meaningful start/progress/results through pm_create_comment, including actual checks and remaining blockers. Repository changes, commits, push and deployment require the user's corresponding task scope; project inventory alone is not authorization to implement every discovered task.",
                  "Completion is a separate explicit authorized PM transition, not a consequence of a successful generation. For a user-requested completion, compare actual evidence against current acceptance, reread the current revision and workflow, transition only when satisfied, and read back the task. Save requested project reports as PM documents with real task IDs, source/evidence links, verified states, failures and next actions. Never claim a task or report was saved without its authoritative tool result; reconcile uncertain operations before continuing related writes.",
                ].join("\n\n"),
                userMessageText: generation.idleCompaction ? undefined : generation.request.messages.findLast(message => message.role === "user")
                  ?.parts.filter(part => part.type === "text").map(part => part.text).join("\n"),
                attachmentParts: plan.messages.flatMap(message => message.parts),
                pmToolBridge: bridge ? { command: process.execPath, args: [path.join(workspaceRoot, "packages/pm-cli/agent-tools.mjs"), bridge.url] } : undefined,
                mcpServers: automationConnectors?.mcpServers,
                execution: { threadId: generation.threadId, generationId: generation.id,
                  messageId: generation.messageId, environment: snapshot.environment,
                  inputMessageId: generation.inputMessageId, traceId: generation.traceId, executionGrantId: generation.executionGrantId },
                authorizeExecution,
                authorizeMcpApp,
                authorizeMcpAppContext: generation.idleCompaction || templateChild || isPmAnalysisGeneration(generation) ? undefined : async producing => {
                  await authorizeExecution("tool");
                  if (producing.threadId !== generation.threadId) return false;
                  const source = getChatGeneration(producing.generationId);
                  if (!source || source.threadId !== generation.threadId) return false;
                  const projection = await createPmVisibilityProjector(generation.threadId, requestHeaders ?? new Headers());
                  const visible = projection.generation({ id: source.id, pmVisibility: undefined as string | undefined });
                  if (visible.pmVisibility) return false;
                  const deps = projection.visibleProvenance([source.messageId]);
                  recordPmContentProvenance({ threadId: generation.threadId, generationId: generation.id,
                    messageIds: [generation.messageId], operationIds: deps.operationIds, targets: deps.targets, authorities: deps.authorities ?? [] });
                  return true;
                },
                originatingMcpGrant: requestHeaders?.get("authorization")?.startsWith("Bearer pm-mcp-service-v1.")
                  ? mcpIdentityFromHeaders(requestHeaders) ?? undefined : undefined,
                authorizeWorktreeWrite: generation.idleCompaction || !snapshot.worktreeWriteConfirmed ? undefined : async () => {
                  await authorizeExecution("tool");
                  const current = await resolveChatExecutionScope(requireRunnableThread(generation.threadId), requestHeaders, "execute", controller.signal);
                  assertLiveAuthorization();
                  if (current.path !== snapshot.path) throw new DurableError(409, "scope_conflict", "Delivery worktree changed.");
                  if (!current.worktreeWriteConfirmed) throw new DurableError(409, "scope_conflict", "Delivery write confirmation is no longer current.");
                  return current.path;
                },
                signal: controller.signal,
                session: plan.session,
                modelOptions: generation.modelOptions,
                interactionMode: generation.interactionMode,
                cwd: snapshot.path,
                ...(isPmAnalysisGeneration(generation) ? { pmAnalysis: true as const } : {}),
                onText: (delta) => {
                  if (hasAssistantItem) return;
                  legacyText += delta;
                  if (collaborationOwned) recordCollaborationOutput(generation.id, legacyText, "assistant-legacy");
                  const ready = filter.update("legacy", legacyText);
                  if (ready !== null) publish("legacy", ready);
                  schedule();
                },
                onEvent: (event) => {
                  if (collaborationOwned) {
                    if (event.type === "item.upsert") recordCollaborationOutput(generation.id, JSON.stringify(normalizeToolValue(event.item)), `native:${event.item.id}`);
                    else recordCollaborationOutput(generation.id, event.chunk, `native:${event.itemId}`, true);
                  }
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
              // Native items own the body, including phase and ordering; a driver's
              // convenience result must not append commentary or duplicate a revision.
              if (hasAssistantItem) {
                bodySettled = true;
                for (const [key, item] of items) visible.set(key, item.text ?? "");
                publishStructuredJournal();
              }
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
              bodySettled = true;
              if (hasAssistantItem) for (const [key, item] of items) visible.set(key, item.text ?? "");
              for (const release of filter.flush()) publish(release.key, release.text);
              if (hasAssistantItem) publishStructuredJournal();
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
          durable: { generationId: current.id, inputMessageId: current.inputMessageId, traceId: current.traceId,
            executionGrantId: current.executionGrantId, executionPolicy: current.executionPolicy,
            status: current.status, nativeOutput: true, ...(current.usage ? { usage: current.usage } : {}) },
        };
        saveFormattedMessage(
          generation.threadId,
          toStoredMessage({ ...message, metadata }, generation.parentId),
          true,
        );
      }
      if (failed) throw failed;
      } finally {
        try { await automationConnectors?.close(); }
        finally { await bridge?.close(); }
      }
      } finally { releaseWriter?.(); }
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
                inputMessageId: current.inputMessageId, traceId: current.traceId,
                executionGrantId: current.executionGrantId, executionPolicy: current.executionPolicy,
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
        current.executionSnapshot?.environment,
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
    queuePmAgentTerminal(getChatGeneration(id)!);
  });
}
export async function cancelChat(id: string): Promise<void> {
  const current = getChatGeneration(id);
  if (!current) return;
  if (isChatActive(current)) controllers.get(id)?.abort("explicit-cancel");
  if (getActiveChat(current.threadId)?.id === id || listChatGenerations(current.threadId)[0]?.id === id)
    await closeMcpAppSession(current.threadId);
  if (!isChatActive(current)) return;
  closeNativeInteractions(id);
  // A queued task might wait behind a long workspace run: settle immediately, never execute it later.
  if (current.status === "queued") settleChat(id, "cancelled");
  else await workers.get(id);
}
export async function cancelThreadChat(
  threadId: string,
  target: { generationId?: string; messageId?: string },
): Promise<void> {
  if (!target.generationId && !target.messageId && !getActiveChat(threadId)) await closeMcpAppSession(threadId);
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
  const releaseAdmission = beginChatAdmission();
  try {
  const previous = getChatGeneration(id);
  if (!previous) throw new ThreadConflictError("找不到该回复。", "not_found");
  if (previous.continuationId) { await resolveChatExecutionScope(requireRunnableThread(previous.threadId), requestHeaders); return getChatGeneration(previous.continuationId)!; }
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
  const executionSnapshot = await resolveChatExecutionScope(thread, requestHeaders);
  if (!thread.executionSelection || !executionSnapshot.environment) throw new DurableError(412, "execution_environment_required", "Continuation requires a versioned, currently authorized Session environment.");
  if (!confirmSideEffects)
    throw new ThreadConflictError(
      "CLI 的外部副作用可能已发生。请核对后确认恢复。",
      "side_effect_confirmation_required",
    );
  const frozenReferences = previous.turnContext?.pmReferences ?? previous.pmReferences ?? [];
  const referenceEvidence = frozenReferences.length
    ? await resolvePmReferenceOperations(frozenReferences.map(({ workspaceId, projectId, kind, id }) =>
      ({ workspaceId, projectId, kind, id, revision: null })), requestHeaders)
    : undefined;
  const originalInput = getThreadHistory(previous.threadId).messages.find(message => message.id === previous.inputMessageId);
  let contextItems: AcceptedChatContext[] | undefined;
  if (previous.turnContext?.contextItems?.length) {
    if (!originalInput) throw new DurableError(409, "context_unavailable", "The original accepted context binding is missing.");
    const projector = await createPmVisibilityProjector(previous.threadId, requestHeaders ?? new Headers());
    contextItems = projector.history([originalInput])[0]?.turnContext?.contextItems;
    if (!contextItems || contextItems.some(item => item.visibility !== "available"))
      throw new DurableError(403, "context_forbidden", "The original selected source context is no longer readable; send a new message with currently available references.");
  }
  const originalUi = originalInput ? toUIMessage(originalInput) : undefined;
  const originalMetadata = originalUi?.metadata;
  const originalCustom = originalMetadata !== null && typeof originalMetadata === "object" && "custom" in originalMetadata ? originalMetadata.custom : undefined;
  const contextAttachments = originalCustom !== null && typeof originalCustom === "object" && "contextAttachments" in originalCustom ? originalCustom.contextAttachments : undefined;
  const recovery: UIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [
      ...(originalUi?.parts.map(part => part.type === "text" ? { type: "text" as const, text: "" } : part) ?? []),
      {
        type: "text",
        text: "用户已明确授权从刚才保存的中断状态继续。先核对已有输出和工作目录中的实际进度，仅完成尚未完成的部分；不要重新执行已完成的步骤或盲目重复外部写入。若无法判断副作用是否已发生，请先询问用户。",
      },
    ],
    metadata: { custom: { continuationOf: id, sideEffectsConfirmed: confirmSideEffects, ...(contextAttachments ? { contextAttachments } : {}) } },
  };
  validateContextAttachmentBindings(recovery, contextItems?.flatMap(item => item.input ? [item.input] : []));
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
    pmReferences: frozenReferences.map(({ workspaceId, projectId, kind, id, revision }) => ({ workspaceId, projectId, kind, id, revision })),
    contextItems: contextItems?.flatMap(item => item.input ? [item.input] : []),
    idempotencyKey,
  };
  await preflightNativeAttachments({ threadId: previous.threadId, executionSnapshot, request,
    continuationOf: id, nativeSession: previous.nativeSession }, runtime, requestHeaders ?? new Headers(),
    { messageId: recovery.id, items: contextItems ?? [] });
  // All identity checks and the lineage link commit before scheduling the provider.
  const identity = chatRequestIdentity(request);
  const generation = transaction(() => {
    const latest = getChatGeneration(id)!;
    if (latest.continuationId) return getChatGeneration(latest.continuationId)!;
    requireRunnableThread(previous.threadId, thread.revision);
    if (state.stopping) throw new DurableError(503, "chat_runtime_stopping", "Runtime stopped during continuation preflight.");
    assertCollaborationChatAdmission(previous.threadId, recovery.id, idempotencyKey);
    if (getActiveChat(previous.threadId))
      throw new ThreadConflictError("当前会话已有运行中的回复。");
    freezeThreadExecution(previous.threadId, executionSnapshot.environment!, executionSnapshot.path);
    executionSnapshot.environment = { ...executionSnapshot.environment!, frozen: true };
    const messages = acceptMessages(request);
    const generationId = crypto.randomUUID();
    const next: ChatGeneration = {
      id: generationId,
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
      ...bindExecutionInput({ ...request, messages }, generationId, frozenReferences, referenceEvidence?.operations ?? [], requestHeaders, contextItems),
      continuationOf: id,
      nativeSession: previous.nativeSession,
      ...(frozenReferences.length ? { pmReferences: frozenReferences } : {}),
      ...(referenceEvidence ? { pmOperations: referenceEvidence.operations } : {}),
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
  } finally { releaseAdmission(); }
}
export async function startChatRuntime(): Promise<void> {
  if (state.started) return;
  state.started = true;
  state.stopping = false;
  interruptPmToolCalls();
  const database = getDatabase();
  const resolving = database.prepare("SELECT key FROM records WHERE namespace=?").all(REQUESTS).flatMap(value => {
    const key = String(value.key), record = readRecord<ChatSubmissionRecord>(REQUESTS, key);
    return record?.state === "resolving" ? [{ key, record }] : [];
  });
  const inventory = resolving.length ? inventoryPersistence(database, { omitCredentialValues: true }) : null;
  const store = resolving.length ? getStoreIdentity(database) : null;
  const generations = resolving.length ? listRecords<ChatGeneration>(GENERATIONS) : [];
  for (const { key, record } of resolving) {
    const identity = record.threadId && record.submissionId ? chatRequestIdentity({ id: record.threadId, idempotencyKey: record.submissionId, messages: [] }) : null;
    const related = generations.some(generation => generation.threadId === record.threadId &&
      (generation.request?.idempotencyKey === record.submissionId || generation.inputMessageId === record.inputMessageId));
    const neverAccepted = inventory !== null && inventory.blockers.length === 0 && store !== null &&
      inventory.store !== null && inventory.store.storeId === store.storeId && inventory.store.restoreEpoch === store.restoreEpoch &&
      record.version === 1 && !record.id && typeof record.inputMessageId === "string" && record.inputMessageId.length > 0 &&
      /^[a-f0-9]{64}$/.test(record.fingerprint) && identity === key && record.storeId === store.storeId && record.restoreEpoch === store.restoreEpoch && !related;
    writeRecord(REQUESTS, key, { ...record, state: neverAccepted ? "rejected" : "unknown",
      reason: neverAccepted ? "admission_interrupted" : "original_admission_unresolved", updatedAt: new Date().toISOString() });
  }
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
  startPmAgentSignals();
}
export async function stopChatRuntime(): Promise<void> {
  state.stopping = true;
  await stopPmAgentSignals();
  for (const timer of compactionTimers.values()) clearTimeout(timer);
  compactionTimers.clear();
  for (const controller of controllers.values()) controller.abort("server-shutdown");
  for (const generation of listRecords<ChatGeneration>(GENERATIONS))
    if (isChatActive(generation)) closeNativeInteractions(generation.id);
  for (const generation of listRecords<ChatGeneration>(GENERATIONS))
    if (generation.status === "queued") settleChat(generation.id, "interrupted");
  await Promise.all(admissions);
  await Promise.all(workers.values());
  await Promise.all(compactionTasks);
  for (const generation of listRecords<ChatGeneration>(GENERATIONS))
    if (isChatActive(generation)) settleChat(generation.id, "interrupted");
  state.started = false;
}

export function getChatRecoveryCandidate(id: string): ChatRecoveryCandidate | null {
  const generation = getChatGeneration(id);
  if (!generation || !generation.executionSnapshot?.environment || !getThread(generation.threadId)?.executionSelection) return null;
  try { assertThreadWritable(generation.threadId); } catch { return null; }
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
  requestHeaders?: Headers,
): Promise<{ id: string; status: ChatGeneration["status"] }> {
  const releaseAdmission = beginChatAdmission();
  try {
  const previous = getChatGeneration(id);
  if (!previous) throw new ThreadConflictError("找不到额度恢复的回复。", "not_found");
  requireRunnableThread(previous.threadId);
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
  const generation = await continueChat(id, nativeRecovery, options.idempotencyKey, runtime, requestHeaders);
  return { id: generation.id, status: generation.status };
  } finally { releaseAdmission(); }
}

export async function forkChatGeneration(
  id: string,
  options: { title?: string; idempotencyKey?: string } = {},
  requestHeaders?: Headers,
): Promise<{ threadId: string }> {
  const releaseAdmission = beginChatAdmission();
  try {
  const original = getChatGeneration(id);
  if (!original) throw new ThreadConflictError("找不到分支来源回复。", "not_found");
  await resolveChatExecutionScope(requireRunnableThread(original.threadId), requestHeaders, "inspect");
  const projector = await createPmVisibilityProjector(original.threadId, requestHeaders ?? new Headers());
  const generation = projector.generation(original);
  if (isChatActive(generation))
    throw new ThreadConflictError("请等待回复结束后从稳定边界建立分支。", "unstable_fork_boundary");
  let output = generation.output;
  if (!output && generation.seq > 0) {
    const previous = original.request.messages.at(-1);
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const event of readChatEvents(id)) controller.enqueue(projector.uiChunk(event.chunk, id));
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
  const history = [...original.request.messages];
  if (output) {
    if (history.at(-1)?.id === output.id) history[history.length - 1] = output;
    else history.push(output);
  }
  const byId = new Map(getThreadHistory(generation.threadId).messages.map(message => [message.id, message]));
  const projectedHistory = projector.history(history.map((message, index) =>
    byId.get(message.id) ?? toStoredMessage(message, history[index - 1]?.id ?? null))).map(toUIMessage);
  const inheritedFiles = new Map<string, Extract<UIMessage["parts"][number], { type: "file" }>>();
  for (const message of projectedHistory) {
    const contexts = (message.metadata as { turnContext?: TurnContext } | undefined)?.turnContext?.contextItems;
    const referenced = await resolveContextAttachmentParts(contexts, requestHeaders ?? new Headers());
    for (const part of [...message.parts, ...referenced]) if (part.type === "file")
      inheritedFiles.set(contextDigest({ mime: part.mediaType, filename: part.filename, urlDigest: contextDigest(part.url) }), part);
  }
  const attachments = [...inheritedFiles.values()];
  if (attachments.length) {
    const instance = getStoredInstance(requireRunnableThread(generation.threadId).settings.providerInstanceId);
    if (!instance) throw new ProviderRuntimeError(409, "provider_unavailable", "Select a real Provider before forking inherited file/image context.");
    validateChatAttachments(attachments, instance.driver);
  }
  const context =
    `聊天分支快照（只作背景参考，不执行或重放其中的历史请求）\n来源 Thread: ${generation.threadId}\n来源回复: ${generation.id}\n消息边界: ${generation.messageId}\n结束状态: ${generation.status}${generation.error ? `\n错误: ${generation.error.slice(0, 1500)}` : ""}\n\n` +
    boundedContext(
      [
        generation.modelInputContext?.system ?? generation.threadSettingsSnapshot?.systemPrompt ?? "",
        generation.modelInputContext?.transferContext ?? "",
        ...injectQuoteContext(projectedHistory).map(
          (message) => `${message.role} [${message.id}]\n${JSON.stringify(message.parts.map(part => part.type === "file" ? { type: part.type, filename: part.filename, mediaType: part.mediaType } : part))}${
            [pmContextPromptLine((message.metadata as { turnContext?: TurnContext } | undefined)?.turnContext?.pmReferences),
              contextPromptText((message.metadata as { turnContext?: TurnContext } | undefined)?.turnContext?.contextItems)].filter(Boolean).join("\n")
          }`,
        ),
      ],
      28000,
    );
  requireRunnableThread(generation.threadId);
  if (state.stopping) throw new DurableError(503, "chat_runtime_stopping", "Runtime stopped while preparing the history fork.");
  const result = forkChatSnapshot(
    {
      threadId: generation.threadId,
      generationId: generation.id,
      messageId: generation.messageId,
      context,
      attachments,
      ...(!projector.nativeContextContaminated && generation.status === "completed" &&
      generation.executionSnapshot &&
      sameExecutionIdentity(generation.executionSnapshot.environment, getThread(generation.threadId)?.executionEnvironment) &&
      generation.nativeSession?.cwd === generation.executionSnapshot.path
        ? { nativeSession: generation.nativeSession }
        : {}),
    },
    projector.nativeContextContaminated ? { ...options, title: options.title ?? "会话 · 分支" } : options,
  );
  const dependencies = projector.visibleProvenance(projectedHistory.map(message => message.id));
  const forkMessages = getThreadHistory(result.threadId).messages;
  // The portable fork summary is itself PM-derived content, not a fresh user fact.
  for (const message of forkMessages) {
    const metadata = message.content.metadata as { custom?: { forkContext?: boolean } } | undefined;
    if (metadata?.custom?.forkContext)
      recordPmContentProvenance({ threadId: result.threadId, generationId: `fork:${message.id}`,
        messageIds: [message.id], operationIds: dependencies.operationIds, contextSources: [
          { threadId: generation.threadId, messageIds: projectedHistory.map(message => message.id) }, ...(dependencies.contextSources ?? [])],
        targets: [...dependencies.targets, ...pmPayloadTargets(projectedHistory)], authorities: dependencies.authorities ?? [] });
  }
  return result;
  } finally { releaseAdmission(); }
}
