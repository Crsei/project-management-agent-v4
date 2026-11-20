import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  executionEnvironmentSchema, executionSelectionSchema, providerOptionSelectionSchema,
  type ChatFanoutRequest, type ChatFanoutResult, type ChatFanoutSelection, type ExecutionEnvironment, type ExecutionSelection,
} from "../../../../packages/agent-contracts/src/chat.ts";
import { resolveAgentExecution } from "./durable/agent-execution.ts";
import { submitChat, type ChatRequest } from "./durable/chat-runtime.ts";
import { DurableError } from "./durable/errors.ts";
import { getDatabase, readRecord, transaction, writeRecord } from "./durable/store.ts";
import { assertThreadWritable, ensureThread, getThread, ThreadConflictError, updateThread, validThreadId, type ThreadMetadata } from "./durable/threads.ts";
import { createChatWorktree } from "./chat-worktrees.ts";
import { resolveProviderModelOptions } from "./providers/catalog.ts";
import { ProviderRuntimeError } from "./providers/runtime.ts";
import { resolveChatExecutionScope } from "./task-delivery/binding.ts";

const namespace = "chat-fanouts-v1";
const identifier = z.string().min(1).max(256);
const selectionSchema = z.strictObject({
  providerInstanceId: identifier.trim().min(1),
  model: identifier.trim().min(1),
  modelOptions: z.array(providerOptionSelectionSchema).max(100).optional(),
}).superRefine((value, context) => {
  const ids = value.modelOptions?.map(option => option.id) ?? [];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Duplicate model option IDs are not allowed." });
});
const requestSchema = z.strictObject({
  operationId: z.uuid(),
  sourceThreadId: identifier.refine(validThreadId),
  message: z.strictObject({
    id: identifier,
    role: z.literal("user"),
    parts: z.array(z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("text"), text: z.string() }),
      z.strictObject({ type: z.literal("file"), mediaType: z.string().min(1), url: z.string().min(1), filename: z.string().optional() }),
    ])).min(1).max(2000),
  }),
  selections: z.array(selectionSchema).min(1).max(8),
  messageId: identifier.optional(),
});

/** Canonical object keys avoid treating JSON serialization order as a different request. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function parseChatFanoutRequest(input: unknown): ChatFanoutRequest {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const body = input as Record<string, unknown>;
    if (Object.hasOwn(body, "pmReferences") || Object.hasOwn(body, "contextItems") ||
        body.message && typeof body.message === "object" && Object.hasOwn(body.message, "metadata"))
      throw new DurableError(400, "fanout_context_unsupported", "多模型 fanout 仅允许 text/file；禁止 PM 引用、contextItems 和消息 metadata（包括 quote），避免重复执行 PM 写操作。");
  }
  return requestSchema.parse(input);
}

/** Exact model/option selections are deduplicated; different options remain independent runs. */
function uniqueSelections(selections: ChatFanoutSelection[]): ChatFanoutSelection[] {
  const seen = new Set<string>();
  return selections.filter(selection => {
    const key = canonical({ ...selection, modelOptions: [...(selection.modelOptions ?? [])].sort((a, b) => a.id.localeCompare(b.id)) });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type FanoutRecord = ChatFanoutResult & { fingerprint: string };
type AcceptedGeneration = { id: string };
type FanoutDependencies = {
  authorizeSource: (thread: ThreadMetadata, headers: Headers) => Promise<unknown>;
  initializeChild: (id: string, selection: ExecutionSelection) => Promise<ExecutionEnvironment>;
  createWorktree: (thread: ThreadMetadata) => Promise<unknown>;
  validateSelection: (selection: ChatFanoutSelection) => void;
  submit: (request: ChatRequest, headers: Headers, onAccepted: (generation: AcceptedGeneration) => void) => Promise<AcceptedGeneration>;
};
const defaults: FanoutDependencies = {
  authorizeSource: (thread, headers) => resolveChatExecutionScope(thread, headers),
  initializeChild: async (id, selection) => (await resolveAgentExecution(selection, id)).environment,
  createWorktree: createChatWorktree,
  validateSelection: selection => { resolveProviderModelOptions(selection.providerInstanceId, selection.model, selection.modelOptions); },
  submit: (request, headers, onAccepted) => submitChat(request, undefined, headers, undefined, { onAccepted }),
};
type Barrier = { fingerprint: string; promise: Promise<ChatFanoutResult> };
const barrierKey = Symbol.for("agent-workspace.chat-fanout-barriers");
const globals = globalThis as typeof globalThis & { [barrierKey]?: Map<string, Barrier> };
const barriers = globals[barrierKey] ??= new Map<string, Barrier>();

function publicResult({ fingerprint: _fingerprint, ...record }: FanoutRecord): ChatFanoutResult {
  return record;
}
function requireSource(id: string): ThreadMetadata & { executionSelection: ExecutionSelection } {
  if (!getThread(id)) throw new DurableError(404, "not_found", "找不到 fanout 来源会话。");
  const thread = assertThreadWritable(id);
  if (!executionSelectionSchema.safeParse(thread.executionSelection).success || !executionEnvironmentSchema.safeParse(thread.executionEnvironment).success)
    throw new DurableError(412, "session_cutover_required", "fanout 来源会话尚未初始化；请先创建有明确执行环境的新版 Session。");
  return thread as ThreadMetadata & { executionSelection: ExecutionSelection };
}
function requireUnchangedSource(source: ThreadMetadata): void {
  const current = requireSource(source.remoteId);
  if (current.revision !== source.revision || (current.lifecycleRevision ?? 0) !== (source.lifecycleRevision ?? 0) ||
      canonical(current.executionSelection) !== canonical(source.executionSelection))
    throw new ThreadConflictError("fanout 来源会话已变化，请核对原操作与子会话。", "fanout_source_changed");
}
function outcome(children: ChatFanoutResult["children"]): ChatFanoutResult["status"] {
  const accepted = children.filter(child => child.generationId !== undefined).length;
  return accepted === children.length && children.every(child => !child.error) ? "created" : accepted ? "partial" : "failed";
}
function childError(error: unknown): NonNullable<ChatFanoutResult["children"][number]["error"]> {
  if (error instanceof DurableError || error instanceof ThreadConflictError || error instanceof ProviderRuntimeError)
    return { code: error.code, message: error.message };
  // Do not expose arbitrary Provider/OS exception text (which can contain credentials).
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "fanout_child_failed";
  return { code, message: "子会话准备或提交失败；请通过 threadId 核对会话、工作树及原提交，不会自动重试。" };
}

/**
 * POST /api/chat/fanout returns 200 for every durable outcome, including partial/failed.
 * A committed reservation is never resumed: after a crash, incomplete children keep an
 * explicit unknown receipt. Retrying the same operation only reads it, never dispatches.
 */
export function createChatFanoutService(overrides: Partial<FanoutDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async (input: unknown, headers = new Headers()): Promise<ChatFanoutResult> => {
    const request = parseChatFanoutRequest(input);
    const fingerprint = createHash("sha256").update(canonical(request)).digest("hex");
    // getDatabase also enforces the existing single-process store ownership lock.
    getDatabase();
    const active = barriers.get(request.operationId);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new ThreadConflictError("operationId 已用于不同的 fanout 请求。", "idempotency_conflict");
      return active.promise;
    }
    const previous = readRecord<FanoutRecord>(namespace, request.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ThreadConflictError("operationId 已用于不同的 fanout 请求。", "idempotency_conflict");
      return publicResult(previous);
    }
    const source = requireSource(request.sourceThreadId);
    const barrier = Promise.withResolvers<ChatFanoutResult>();
    barriers.set(request.operationId, { fingerprint, promise: barrier.promise });
    const execute = async (): Promise<ChatFanoutResult> => {
      await dependencies.authorizeSource(source, headers);
      const record = transaction(() => {
        requireUnchangedSource(source);
        const children = uniqueSelections(request.selections).map(selection => {
          const threadId = randomUUID();
          ensureThread(threadId, undefined, source.executionSelection);
          updateThread(threadId, { settings: {
            systemPrompt: source.settings.systemPrompt, temperature: source.settings.temperature,
            ...(source.settings.interactionMode ? { interactionMode: source.settings.interactionMode } : {}), ...selection,
          } });
          return { selection, threadId, error: { code: "fanout_incomplete", message: "原操作尚未确认提交；中断后只核对原子会话，不会重新派发。" } };
        });
        const reserved: FanoutRecord = { operationId: request.operationId, fingerprint, sourceThreadId: request.sourceThreadId,
          status: "failed", children, createdAt: new Date().toISOString() };
        // Persist all child identities before any asynchronous filesystem/provider effect.
        writeRecord(namespace, request.operationId, reserved);
        return reserved;
      });
      const saveChild = (index: number, patch: Pick<ChatFanoutResult["children"][number], "generationId" | "error">) => transaction(() => {
        const current = readRecord<FanoutRecord>(namespace, request.operationId);
        if (!current || current.fingerprint !== fingerprint) throw new ThreadConflictError("fanout 原操作记录已变化，不能重新提交。", "fanout_changed");
        current.children[index] = { ...current.children[index]!, ...patch };
        current.status = outcome(current.children);
        writeRecord(namespace, request.operationId, current);
      });
      await Promise.all(record.children.map(async (child, index) => {
        try {
          requireUnchangedSource(source);
          dependencies.validateSelection(child.selection);
          const environment = await dependencies.initializeChild(child.threadId, source.executionSelection);
          requireUnchangedSource(source);
          const thread = updateThread(child.threadId, { executionEnvironment: environment });
          if (source.executionSelection.agentWorkspaceId !== null) await dependencies.createWorktree(thread);
          requireUnchangedSource(source);
          const current = assertThreadWritable(child.threadId);
          const inputId = randomUUID();
          const generation = await dependencies.submit({
            id: child.threadId, messages: [{ id: inputId, role: "user", parts: structuredClone(request.message.parts) }],
            trigger: "submit-message", messageId: inputId, idempotencyKey: request.operationId,
            config: { threadSettingsRevision: current.revision },
          }, headers, accepted => saveChild(index, { generationId: accepted.id, error: undefined }));
          saveChild(index, { generationId: generation.id, error: undefined });
        } catch (error) {
          // Retain any generation already accepted atomically by the runtime's admission hook.
          saveChild(index, { error: childError(error) });
        }
      }));
      return publicResult(readRecord<FanoutRecord>(namespace, request.operationId)!);
    };
    void execute().then(barrier.resolve, barrier.reject).finally(() => { barriers.delete(request.operationId); });
    return barrier.promise;
  };
}

export const fanoutChat = createChatFanoutService();
