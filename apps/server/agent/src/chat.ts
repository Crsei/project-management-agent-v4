import { createUIMessageStreamResponse, type UIMessage, type UIMessageChunk } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { ProviderRuntimeError } from "./providers/runtime.ts";
import { resolveProviderModelOptions } from "./providers/catalog.ts";
import { ChatDefaultsError } from "./settings/chat-defaults.ts";
import {
  chatBodySchema,
  createThreadSchema,
  storedMessageSchema,
  threadPatchSchema,
  threadSidebarActionSchema,
} from "@agent-workspace/contracts/chat";
import { nativeInteractionResponseSchema } from "@agent-workspace/contracts/output";
import {
  getNativeOutput,
  respondNativeInteraction,
  subscribeCommandOutput,
  subscribeNativeOutput,
} from "./durable/native-output.ts";
import { DurableError } from "./durable/errors.ts";
import {
  cancelChat,
  cancelThreadChat,
  continueChat,
  defaultChatExecutionPolicy,
  forkChatGeneration,
  getActiveChat,
  getChatGeneration,
  isChatActive,
  listChatGenerations,
  submitChat,
  subscribeChat,
  type ChatGeneration,
  type ChatRequest,
} from "./durable/chat-runtime.ts";
import {
  deleteThread,
  ensureThread,
  getThread,
  getThreadHistory,
  listThreads,
  saveFormattedMessage,
  ThreadConflictError,
  updateThread,
  validThreadId,
  type ThreadMetadata,
} from "./durable/threads.ts";
import { getThreadSidebar, updateThreadSidebar } from "./durable/thread-sidebar.ts";
import { generateThreadTitle } from "./durable/thread-title.ts";
import { transaction } from "./durable/store.ts";
import { resolveAgentExecution } from "./durable/agent-execution.ts";
import { listRuns } from "./durable/engine.ts";
import { setThreadNativeSession } from "./durable/threads.ts";
import { closeMcpAppSession } from "./mcp-apps/live.ts";
import { resolveChatExecutionScope } from "./task-delivery/binding.ts";
import { terminateSessionTerminals } from "./inspector/terminal.ts";
import { createPmVisibilityProjector, type PmVisibilityProjector } from "./pm-visibility.ts";

export const chatRoutes = new Hono();
export const publicThread = (thread: ThreadMetadata) => ({
  remoteId: thread.remoteId,
  executionSelection: thread.executionSelection,
  executionEnvironment: thread.executionEnvironment,
  title: thread.title,
  status: thread.status,
  custom: thread.custom,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  lastMessageAt: thread.updatedAt,
  revision: thread.revision,
  settings: thread.settings,
  defaultsRevision: thread.defaultsRevision,
  sidebar: getThreadSidebar(thread),
});
export const publicChatGeneration = (generation: ChatGeneration) => ({
  id: generation.id,
  threadId: generation.threadId,
  messageId: generation.messageId,
  inputMessageId: generation.inputMessageId,
  traceId: generation.traceId,
  executionGrantId: generation.executionGrantId,
  executionPolicy: generation.executionPolicy,
  turnContext: generation.turnContext,
  status: generation.status,
  createdAt: generation.createdAt,
  endedAt: generation.endedAt,
  error: generation.error,
  errorClass: generation.errorClass,
  resetAt: generation.resetAt,
  providerInstanceId: generation.providerInstanceId,
  modelId: generation.modelId,
  continuationOf: generation.continuationOf,
  continuationId: generation.continuationId,
  handoff: generation.handoff,
  pmReferences: generation.pmReferences,
});

export async function publicAuthorizedThread(thread: ThreadMetadata, headers: Headers) {
  const projector = await createPmVisibilityProjector(thread.remoteId, headers);
  const result = publicThread(thread);
  // Legacy Session titles/custom summaries have no item-level dependency proof.
  return projector.nativeContextContaminated ? { ...result, title: "会话", custom: undefined } : result;
}

async function accessibleGeneration(id: string): Promise<ChatGeneration> {
  const generation = getChatGeneration(id);
  if (!generation) throw new DurableError(404, "not_found", "找不到该回复。");
  const thread = getThread(generation.threadId);
  if (!thread) throw new DurableError(404, "not_found", "找不到该会话。");
  return generation;
}

function outputSse<T>(stream: ReadableStream<T>): Response {
  const encoder = new TextEncoder();
  return new Response(stream.pipeThrough(new TransformStream<T, Uint8Array>({
    transform(frame, controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
    },
  })), { headers: {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  } });
}

/** Recheck CURRENT PM authority at serialization, including reconnect and slow-consumer snapshots. */
function authorizedStream<T>(threadId: string, headers: Headers, stream: ReadableStream<T>,
  project: (projector: PmVisibilityProjector, frame: T) => T): ReadableStream<T> {
  return stream.pipeThrough(new TransformStream<T, T>({
    async transform(frame, controller) {
      const projector = await createPmVisibilityProjector(threadId, headers);
      controller.enqueue(project(projector, frame));
    },
  }));
}
chatRoutes.onError((error, c) => {
  if (error instanceof ChatDefaultsError)
    return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof DurableError)
    return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof ThreadConflictError)
    return c.json(
      { error: error.message, code: error.code },
      error.code === "not_found" ? 404 : 409,
    );
  if (error instanceof ProviderRuntimeError)
    return c.json({ error: error.message, code: error.code }, error.status === 412 ? 412 : 400);
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return c.json({ error: "请求格式无效。", code: "invalid_request" }, 400);
  console.error("Chat request failed:", error instanceof Error ? error.name : "unknown");
  return c.json({ error: "无法保存或读取会话，请检查服务端存储。", code: "chat_error" }, 500);
});
chatRoutes.get("/chat/threads", async (c) => c.json({
  threads: await Promise.all(listThreads().map(thread => publicAuthorizedThread(thread, c.req.raw.headers))),
}));
chatRoutes.post("/chat/threads", async (c) => {
  const { id, executionSelection } = createThreadSchema.parse(await c.req.json());
  if (!validThreadId(id)) return c.json({ error: "无效的会话 ID。", code: "invalid_request" }, 400);
  const execution = await resolveAgentExecution(executionSelection, id, c.req.raw.signal);
  ensureThread(id, undefined, executionSelection, execution.environment);
  const thread = getThread(id);
  if (!thread) return c.json({ error: "会话已删除。", code: "thread_deleted" }, 409);
  updateThread(id, {});
  return c.json({ thread: await publicAuthorizedThread(thread, c.req.raw.headers) });
});
chatRoutes.get("/chat/threads/:id", async (c) => {
  const thread = getThread(c.req.param("id"));
  return thread
    ? c.json({ thread: await publicAuthorizedThread(thread, c.req.raw.headers) })
    : c.json({ error: "找不到会话。", code: "not_found" }, 404);
});
chatRoutes.get("/chat/threads/:id/execution", async c => {
  const thread = getThread(c.req.param("id"));
  if (!thread) throw new DurableError(404, "not_found", "找不到会话。");
  const snapshot = await resolveChatExecutionScope(thread, c.req.raw.headers, "inspect", c.req.raw.signal);
  return c.json({ environment: snapshot.environment, executionPolicy: defaultChatExecutionPolicy });
});
chatRoutes.post("/chat/threads/:id/native-session/restart", async c => {
  z.strictObject({}).parse(await c.req.json());
  const id = c.req.param("id");
  const thread = getThread(id);
  if (!thread) throw new DurableError(404, "not_found", "找不到会话。");
  const assertIdle = () => {
    if (getActiveChat(id) || listRuns(id).some(run => run.status === "queued" || run.status === "running"))
      throw new DurableError(409, "chat_busy", "会话仍在运行；请等待完成或显式停止，不能自动取消。");
  };
  assertIdle();
  await closeMcpAppSession(id);
  const current = transaction(() => {
    const latest = getThread(id);
    if (!latest) throw new DurableError(404, "not_found", "找不到会话。");
    if (latest.revision !== thread.revision || JSON.stringify(latest.executionSelection) !== JSON.stringify(thread.executionSelection) ||
        JSON.stringify(latest.nativeSession) !== JSON.stringify(thread.nativeSession) ||
        JSON.stringify(latest.pendingFork) !== JSON.stringify(thread.pendingFork))
      throw new ThreadConflictError("会话已更改，请重新载入。");
    assertIdle();
    setThreadNativeSession(id, undefined);
    return getThread(id)!;
  });
  return c.json({ thread: await publicAuthorizedThread(current, c.req.raw.headers) });
});
chatRoutes.put("/chat/threads/:id", async (c) => {
  const id = c.req.param("id");
  const patch = threadPatchSchema.parse(await c.req.json());
  if (!getThread(id)) throw new DurableError(404, "not_found", "找不到会话。");
  if (patch.settings && patch.revision === undefined)
    return c.json({ error: "保存设置必须提供 revision。", code: "invalid_request" }, 400);
  if (patch.executionSelection) {
    if (Object.keys(patch).some(key => !["executionSelection", "revision"].includes(key)))
      throw new DurableError(400, "invalid_request", "Save execution selection separately from other Session changes.");
    const thread = getThread(id);
    if (!thread) throw new DurableError(404, "not_found", "找不到会话。");
    if (patch.revision === undefined) throw new DurableError(400, "revision_required", "Execution selection requires revision.");
    if (thread.revision !== patch.revision) throw new ThreadConflictError("Session changed; reload before selecting its directory.");
    if (!thread.executionSelection || thread.executionEnvironment?.frozen || listChatGenerations(id).length || getActiveChat(id) ||
        listRuns(id).some(run => run.status === "queued" || run.status === "running"))
      throw new DurableError(409, "execution_frozen", "Create a new Session to change execution directories.");
    const snapshot = await resolveAgentExecution(patch.executionSelection, id, c.req.raw.signal);
    await closeMcpAppSession(id);
    const latest = getThread(id);
    if (!latest || latest.revision !== thread.revision || latest.executionEnvironment?.frozen || listChatGenerations(id).length ||
        listRuns(id).some(run => run.status === "queued" || run.status === "running"))
      throw new ThreadConflictError("Session execution changed while saving its directory.", "execution_frozen");
    return c.json({ thread: await publicAuthorizedThread(updateThread(id, { ...patch, executionEnvironment: snapshot.environment }), c.req.raw.headers) });
  }
  if (patch.status) {
    const thread = getThread(id);
    if (!thread) throw new DurableError(404, "not_found", "找不到会话。");
    if (patch.status === "archived" && getActiveChat(id))
      throw new DurableError(409, "chat_busy", "请等待后台生成结束或在聊天中显式停止后再归档；归档不会自动取消生成。");
  }
  if (patch.settings) {
    try {
      resolveProviderModelOptions(patch.settings.providerInstanceId, patch.settings.model, patch.settings.modelOptions);
    } catch (error) {
      throw new ProviderRuntimeError(
        400, error instanceof Error && "code" in error ? String(error.code) : "invalid_model",
        error instanceof Error ? error.message : "无效模型选择。",
      );
    }
  }
  if (patch.settings || patch.status === "archived") {
    const thread = getThread(id);
    if (!thread) throw new DurableError(404, "not_found", "找不到会话。");
    if (patch.revision !== undefined && patch.revision !== thread.revision)
      throw new ThreadConflictError("会话已更改，请重新载入。");
    await closeMcpAppSession(id);
    const latest = getThread(id);
    if (!latest || latest.revision !== thread.revision)
      throw new ThreadConflictError("会话已更改，请重新载入。");
    if (patch.status === "archived" && getActiveChat(id))
      throw new DurableError(409, "chat_busy", "会话仍在运行，请先停止生成。");
  }
  return c.json({ thread: await publicAuthorizedThread(updateThread(id, patch), c.req.raw.headers) });
});
chatRoutes.post("/chat/threads/:id/sidebar", async (c) => {
  const id = c.req.param("id");
  const action = threadSidebarActionSchema.parse(await c.req.json());
  const thread = getThread(id);
  if (!thread) throw new DurableError(404, "not_found", "找不到会话。");
  updateThreadSidebar(id, action);
  const current = getThread(id);
  if (!current) throw new DurableError(404, "not_found", "找不到会话。");
  return c.json({ thread: await publicAuthorizedThread(current, c.req.raw.headers) });
});
chatRoutes.post("/chat/threads/:id/regenerate-title", async (c) => {
  const id = c.req.param("id");
  const { revision } = z.object({ revision: z.number().int().nonnegative() }).parse(await c.req.json());
  const current = getThread(id);
  if (!current) throw new DurableError(404, "not_found", "找不到会话。");
  if (current.revision !== revision) throw new ThreadConflictError("会话设置已更改，请重新载入。");
  const generations = listChatGenerations(id);
  if (generations.some(isChatActive))
    throw new DurableError(409, "chat_busy", "会话仍在运行，请等待生成结束后重新生成标题。");
  const history = JSON.stringify(getThreadHistory(id));
  const title = await generateThreadTitle(current, c.req.raw.signal, c.req.raw.headers);
  const saved = transaction(() => {
    const latest = getThread(id);
    if (!latest) throw new DurableError(404, "not_found", "找不到会话。");
    const latestGenerations = listChatGenerations(id);
    if (latest.revision !== revision || latest.title !== current.title ||
        latest.status !== current.status || JSON.stringify(getThreadHistory(id)) !== history ||
        latestGenerations.length !== generations.length ||
        latestGenerations.some((generation, index) => isChatActive(generation) || generation.id !== generations[index]?.id))
      throw new ThreadConflictError("生成标题期间会话已更改，请重新载入。", "title_conflict");
    return title === current.title || title === "New thread" ? latest : updateThread(id, { title, revision });
  });
  return c.json({ thread: await publicAuthorizedThread(saved, c.req.raw.headers) });
});
chatRoutes.delete("/chat/threads/:id", async (c) => {
  const id = c.req.param("id");
  const thread = getThread(id);
  if (!thread) return c.json({ deleted: true });
  for (const generation of listChatGenerations(id))
    if (isChatActive(generation)) await cancelChat(generation.id);
  if (getActiveChat(id))
    throw new DurableError(409, "chat_busy", "后台生成尚未确认停止，历史未删除；请核对生成状态后重试。");
  await closeMcpAppSession(id);
  if (getActiveChat(id))
    throw new DurableError(409, "chat_busy", "后台生成尚未确认停止，历史未删除。");
  terminateSessionTerminals(id);
  deleteThread(id);
  return c.json({ deleted: true });
});
chatRoutes.get("/chat/threads/:id/history", async (c) => {
  const id = c.req.param("id");
  if (!getThread(id)) return c.json({ error: "找不到会话。", code: "not_found" }, 404);
  const history = getThreadHistory(id, c.req.query("format") ?? "ai-sdk/v6");
  const active = getActiveChat(id);
  const latest = listChatGenerations(id)[0];
  // Replay starts from the generation boundary, not a browser's partial text.
  // A frontend-tool continuation retains the original pre-generation message.
  const original = active?.request.messages.at(-1);
  const continuing = original?.id === active?.messageId && original?.role === "assistant";
  const rawMessages = history.messages.flatMap((message) => {
    if (message.id !== active?.messageId) return [message];
    if (!continuing || !original) return [];
    const { id: messageId, ...content } = original;
    return [{ id: messageId, parent_id: active!.parentId, format: history.format, content }];
  });
  const projector = await createPmVisibilityProjector(id, c.req.raw.headers);
  const messages = projector.history(rawMessages).map(message => message.turnContext ? {
    ...message, content: { ...message.content, metadata: {
      ...(message.content.metadata as Record<string, unknown> | undefined), turnContext: message.turnContext,
    } },
  } : message);
  return c.json({
    headId: active ? (continuing ? active.messageId : active.parentId) : history.headId,
    messages,
    activeGenerationId: active?.id,
    latestGeneration: latest ? projector.generation(publicChatGeneration(latest)) : null,
  });
});
chatRoutes.get("/chat/threads/:id/messages/:messageId/context", async c => {
  const id = c.req.param("id");
  if (!getThread(id)) throw new DurableError(404, "not_found", "找不到会话。");
  const message = getThreadHistory(id).messages.find(message => message.id === c.req.param("messageId"));
  if (!message || message.content.role !== "user") throw new DurableError(404, "not_found", "找不到输入消息。");
  const projector = await createPmVisibilityProjector(id, c.req.raw.headers);
  const projected = projector.history([message])[0]!;
  const metadata = projected.content.metadata as { pmVisibility?: string } | undefined;
  return c.json({ turnContext: projected.turnContext, visibility: metadata?.pmVisibility ?? "visible" });
});
chatRoutes.put("/chat/threads/:id/history", async (c) => {
  const id = c.req.param("id");
  const entry = storedMessageSchema.parse(await c.req.json());
  const existing = getThreadHistory(id, entry.format).messages.find(
    (message) => message.id === entry.id,
  );
  // Stream snapshots are owned by the worker, never by a disconnected tab's
  // history adapter. Only a known frontend tool can contribute its own result.
  if (!existing && entry.content.role !== "user") return c.json({ saved: false });
  saveFormattedMessage(id, entry, false, false);
  return c.json({ saved: true });
});
chatRoutes.get("/chat/threads/:id/generations", async (c) => {
  const id = c.req.param("id");
  if (!getThread(id)) throw new DurableError(404, "not_found", "找不到会话。");
  const projector = await createPmVisibilityProjector(id, c.req.raw.headers);
  return c.json({ generations: listChatGenerations(id).map(generation => projector.generation(publicChatGeneration(generation))) });
});
chatRoutes.post("/chat/threads/:id/cancel", async (c) => {
  const body = z
    .object({ generationId: z.string().optional(), messageId: z.string().max(256).optional() })
    .parse(await c.req.json());
  const id = c.req.param("id");
  const thread = getThread(id);
  if (thread && !getActiveChat(id)) {
    await closeMcpAppSession(id);
  }
  await cancelThreadChat(id, body);
  return c.json({ cancelled: true });
});
chatRoutes.post("/chat/generations/:id/continue", async (c) => {
  const body = z
    .object({ confirmSideEffects: z.boolean().default(false) })
    .parse(await c.req.json());
  const generation = await continueChat(c.req.param("id"), body.confirmSideEffects, undefined, undefined, c.req.raw.headers);
  const projector = await createPmVisibilityProjector(generation.threadId, c.req.raw.headers);
  return c.json({ generation: projector.generation(publicChatGeneration(generation)) }, 202);
});
chatRoutes.post("/chat/generations/:id/fork", async (c) => {
  const options = z
    .object({
      title: z.string().max(200).optional(),
      idempotencyKey: z.string().max(200).optional(),
    })
    .parse(await c.req.json());
  return c.json(await forkChatGeneration(c.req.param("id"), options, c.req.raw.headers), 201);
});
chatRoutes.get("/chat/generations/:id/output", async (c) => {
  const generation = await accessibleGeneration(c.req.param("id"));
  const after = c.req.query("after");
  if (after !== undefined && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))))
    return c.json({ error: "无效的输出序号。", code: "invalid_request" }, 400);
  if (!getNativeOutput(generation.id))
    return c.json({ error: "该回复没有原生输出。", code: "not_found" }, 404);
  // A full snapshot is a safe reset for any cursor, including one from another server lifetime.
  return outputSse(authorizedStream(generation.threadId, c.req.raw.headers,
    subscribeNativeOutput(generation.id, c.req.raw.signal), (projector, frame) => projector.nativeFrame(frame)));
});
chatRoutes.get("/chat/generations/:id/items/:itemId/output", async (c) => {
  const generation = await accessibleGeneration(c.req.param("id"));
  const item = getNativeOutput(generation.id)?.items.find((entry) => entry.id === c.req.param("itemId"));
  if (!item || item.type !== "command_execution")
    return c.json({ error: "找不到该命令。", code: "not_found" }, 404);
  return outputSse(authorizedStream(generation.threadId, c.req.raw.headers,
    subscribeCommandOutput(generation.id, item.id, c.req.raw.signal),
    (projector, frame) => projector.commandFrame(frame, generation.id, item.id)));
});
chatRoutes.post("/chat/generations/:id/requests/:requestId/respond", async (c) => {
  const generation = await accessibleGeneration(c.req.param("id"));
  const response = nativeInteractionResponseSchema.parse(await c.req.json());
  respondNativeInteraction(generation.id, c.req.param("requestId"), response);
  return c.json({ accepted: true });
});
chatRoutes.get("/chat/streams/:id", async (c) => {
  const generation = await accessibleGeneration(c.req.param("id"));
  return createUIMessageStreamResponse({
    stream: authorizedStream(generation.threadId, c.req.raw.headers, subscribeChat(generation.id, c.req.raw.signal),
      (projector, frame: UIMessageChunk) => projector.uiChunk(frame, generation.id)),
    headers: { "x-resumable-stream-id": generation.id, "cache-control": "no-store" },
  });
});
chatRoutes.post("/chat", async (c) => {
  const body = chatBodySchema.parse(await c.req.json());
  if (!validThreadId(body.id))
    return c.json({ error: "无效的会话 ID。", code: "invalid_request" }, 400);
  const request = { ...body, messages: body.messages as UIMessage[] } as ChatRequest;
  const generation = await submitChat(request, undefined, c.req.raw.headers);
  return createUIMessageStreamResponse({
    stream: authorizedStream(generation.threadId, c.req.raw.headers, subscribeChat(generation.id, c.req.raw.signal),
      (projector, frame: UIMessageChunk) => projector.uiChunk(frame, generation.id)),
    headers: { "x-resumable-stream-id": generation.id, "cache-control": "no-store",
      ...(generation.inputMessageId ? { "x-accepted-input-message-id": generation.inputMessageId } : {}),
      ...(generation.traceId ? { "x-turn-trace-id": generation.traceId } : {}),
    },
  });
});
