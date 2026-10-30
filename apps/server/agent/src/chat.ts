import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { ProviderRuntimeError } from "./providers/runtime.ts";
import { resolveProviderModelOptions } from "./providers/catalog.ts";
import { agentCatalogSchema } from "../../../../packages/contracts/src/agent-file-areas.ts";
import { ChatDefaultsError } from "./settings/chat-defaults.ts";
import {
  chatBodySchema,
  createThreadSchema,
  importBodySchema,
  storedMessageSchema,
  threadPatchSchema,
  threadSidebarActionSchema,
  type PmContext,
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
  importThreads,
  listThreads,
  saveFormattedMessage,
  ThreadConflictError,
  updateThread,
  validThreadId,
  type ThreadMetadata,
} from "./durable/threads.ts";
import { getThreadSidebar, updateThreadSidebar } from "./durable/thread-sidebar.ts";
import { generateThreadTitle } from "./durable/thread-title.ts";
import { resolvePmContextBinding } from "./durable/pm-context.ts";
import { transaction } from "./durable/store.ts";

export const chatRoutes = new Hono();
export const publicThread = (thread: ThreadMetadata) => ({
  remoteId: thread.remoteId,
  scope: thread.scope,
  ...(thread.pmContext ? { pmContext: thread.pmContext } : {}),
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
export async function assertThreadScopeAccessible(thread: ThreadMetadata, requestHeaders: Headers): Promise<void> {
  if (!thread.scope)
    throw new DurableError(412, "scope_required", "旧历史没有原始工作区归属，不能归档、恢复或删除，也不会重新分派。");
  let endpoint: URL;
  try {
    const base = new URL(process.env.PM_API_URL?.trim() || "http://127.0.0.1:4194");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
      throw new Error("Invalid PM origin");
    endpoint = new URL("/api/v1/agent-contexts", base.origin);
  } catch {
    throw new DurableError(503, "scope_unavailable", "PM API 地址配置无效，未更改会话。");
  }
  const headers = new Headers();
  for (const name of ["cookie", "authorization"]) {
    const value = requestHeaders.get(name);
    if (value) headers.set(name, value);
  }
  let response: Response;
  try {
    response = await fetch(endpoint, { headers, redirect: "error" });
  } catch {
    throw new DurableError(503, "scope_unavailable", "无法核验当前 PM 访问范围，未更改会话。");
  }
  if (!response.ok)
    throw new DurableError(
      response.status === 401 || response.status === 403 || response.status === 404 ? response.status : 503,
      "scope_unavailable", "无法核验当前 PM 访问范围，请检查登录及原始分组权限。",
    );
  const catalog = agentCatalogSchema.safeParse(await response.json().catch(() => null));
  if (!catalog.success)
    throw new DurableError(503, "scope_unavailable", "PM 目录册响应无效，未更改会话。");
  const workspace = catalog.data.workspaces.find((item) => item.id === thread.scope!.workspaceId);
  if (!workspace || (thread.scope.projectId !== null && !workspace.projects.some((item) => item.id === thread.scope!.projectId)))
    throw new DurableError(403, "scope_unavailable", "原始工作区或项目当前不可访问，不能更改此会话。");
  // A bound task that is no longer accessible must reject every scope-sensitive change.
  if (thread.pmContext) await resolvePmContextBinding(thread.pmContext, thread.scope, requestHeaders);
}

async function accessibleGeneration(id: string, headers: Headers): Promise<ChatGeneration> {
  const generation = getChatGeneration(id);
  if (!generation) throw new DurableError(404, "not_found", "找不到该回复。");
  const thread = getThread(generation.threadId);
  if (!thread) throw new DurableError(404, "not_found", "找不到该会话。");
  await assertThreadScopeAccessible(thread, headers);
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
chatRoutes.get("/chat/threads", (c) => c.json({ threads: listThreads().map(publicThread) }));
chatRoutes.post("/chat/threads", async (c) => {
  const { id, scope, pmContext } = createThreadSchema.parse(await c.req.json());
  if (!validThreadId(id)) return c.json({ error: "无效的会话 ID。", code: "invalid_request" }, 400);
  const binding = await resolvePmContextBinding(pmContext, scope, c.req.raw.headers, c.req.raw.signal);
  ensureThread(id, undefined, scope, binding);
  const thread = getThread(id);
  if (!thread) return c.json({ error: "会话已删除。", code: "thread_deleted" }, 409);
  updateThread(id, {});
  return c.json({ thread: publicThread(thread) });
});
chatRoutes.post("/chat/import", async (c) => {
  const body = importBodySchema.parse(await c.req.json());
  if (body.threads.some((thread) => !validThreadId(thread.remoteId)))
    return c.json({ error: "导入含无效会话 ID。", code: "invalid_request" }, 400);
  return c.json(importThreads(body.migrationId, body.threads));
});
chatRoutes.get("/chat/threads/:id", (c) => {
  const thread = getThread(c.req.param("id"));
  return thread
    ? c.json({ thread: publicThread(thread) })
    : c.json({ error: "找不到会话。", code: "not_found" }, 404);
});
chatRoutes.put("/chat/threads/:id", async (c) => {
  const id = c.req.param("id");
  const patch = threadPatchSchema.parse(await c.req.json());
  if (patch.settings && patch.revision === undefined)
    return c.json({ error: "保存设置必须提供 revision。", code: "invalid_request" }, 400);
  let pmContext: PmContext | null | undefined;
  if (patch.pmContext !== undefined) {
    const thread = getThread(id);
    if (!thread) throw new DurableError(404, "not_found", "找不到会话。");
    if (getActiveChat(id))
      throw new DurableError(409, "chat_busy", "生成进行中，不能更改绑定的 PM 议题；请先停止生成。");
    // Clearing a stale binding must not be blocked by the issue it removes.
    if (patch.pmContext !== null) await assertThreadScopeAccessible(thread, c.req.raw.headers);
    pmContext = (await resolvePmContextBinding(patch.pmContext, thread.scope, c.req.raw.headers, c.req.raw.signal)) ?? null;
  }
  if (patch.status) {
    const thread = getThread(id);
    if (!thread) throw new DurableError(404, "not_found", "找不到会话。");
    await assertThreadScopeAccessible(thread, c.req.raw.headers);
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
  return c.json({ thread: publicThread(updateThread(id, { ...patch, ...(pmContext !== undefined ? { pmContext } : {}) })) });
});
chatRoutes.post("/chat/threads/:id/sidebar", async (c) => {
  const id = c.req.param("id");
  const action = threadSidebarActionSchema.parse(await c.req.json());
  const thread = getThread(id);
  if (!thread) throw new DurableError(404, "not_found", "找不到会话。");
  await assertThreadScopeAccessible(thread, c.req.raw.headers);
  updateThreadSidebar(id, action);
  const current = getThread(id);
  if (!current) throw new DurableError(404, "not_found", "找不到会话。");
  return c.json({ thread: publicThread(current) });
});
chatRoutes.post("/chat/threads/:id/regenerate-title", async (c) => {
  const id = c.req.param("id");
  const { revision } = z.object({ revision: z.number().int().nonnegative() }).parse(await c.req.json());
  const thread = getThread(id);
  if (!thread) throw new DurableError(404, "not_found", "找不到会话。");
  await assertThreadScopeAccessible(thread, c.req.raw.headers);
  const current = getThread(id);
  if (!current) throw new DurableError(404, "not_found", "找不到会话。");
  if (current.revision !== revision) throw new ThreadConflictError("会话设置已更改，请重新载入。");
  const history = JSON.stringify(getThreadHistory(id));
  const title = await generateThreadTitle(current, c.req.raw.headers, c.req.raw.signal);
  await assertThreadScopeAccessible(current, c.req.raw.headers);
  const saved = transaction(() => {
    const latest = getThread(id);
    if (!latest) throw new DurableError(404, "not_found", "找不到会话。");
    if (latest.revision !== revision || latest.title !== current.title ||
        latest.status !== current.status || JSON.stringify(getThreadHistory(id)) !== history)
      throw new ThreadConflictError("生成标题期间会话已更改，请重新载入。", "title_conflict");
    return title === current.title || title === "New thread" ? latest : updateThread(id, { title, revision });
  });
  return c.json({ thread: publicThread(saved) });
});
chatRoutes.delete("/chat/threads/:id", async (c) => {
  const id = c.req.param("id");
  const thread = getThread(id);
  if (!thread) return c.json({ deleted: true });
  await assertThreadScopeAccessible(thread, c.req.raw.headers);
  for (const generation of listChatGenerations(id))
    if (isChatActive(generation)) await cancelChat(generation.id);
  if (getActiveChat(id))
    throw new DurableError(409, "chat_busy", "后台生成尚未确认停止，历史未删除；请核对生成状态后重试。");
  deleteThread(id);
  return c.json({ deleted: true });
});
chatRoutes.get("/chat/threads/:id/history", (c) => {
  const id = c.req.param("id");
  if (!getThread(id)) return c.json({ error: "找不到会话。", code: "not_found" }, 404);
  const history = getThreadHistory(id, c.req.query("format") ?? "ai-sdk/v6");
  const active = getActiveChat(id);
  const latest = listChatGenerations(id)[0];
  // Replay starts from the generation boundary, not a browser's partial text.
  // A frontend-tool continuation retains the original pre-generation message.
  const original = active?.request.messages.at(-1);
  const continuing = original?.id === active?.messageId && original?.role === "assistant";
  const messages = history.messages.flatMap((message) => {
    if (message.id !== active?.messageId) return [message];
    if (!continuing || !original) return [];
    const { id: messageId, ...content } = original;
    return [{ id: messageId, parent_id: active!.parentId, format: history.format, content }];
  });
  return c.json({
    headId: active ? (continuing ? active.messageId : active.parentId) : history.headId,
    messages,
    activeGenerationId: active?.id,
    latestGeneration: latest ? publicChatGeneration(latest) : null,
  });
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
chatRoutes.get("/chat/threads/:id/generations", (c) =>
  c.json({ generations: listChatGenerations(c.req.param("id")).map(publicChatGeneration) }),
);
chatRoutes.post("/chat/threads/:id/cancel", async (c) => {
  const body = z
    .object({ generationId: z.string().optional(), messageId: z.string().max(256).optional() })
    .parse(await c.req.json());
  await cancelThreadChat(c.req.param("id"), body);
  return c.json({ cancelled: true });
});
chatRoutes.post("/chat/generations/:id/continue", async (c) => {
  const body = z
    .object({ confirmSideEffects: z.boolean().default(false) })
    .parse(await c.req.json());
  const generation = await continueChat(c.req.param("id"), body.confirmSideEffects, undefined, undefined, c.req.raw.headers);
  return c.json({ generation: publicChatGeneration(generation) }, 202);
});
chatRoutes.post("/chat/generations/:id/fork", async (c) => {
  const options = z
    .object({
      title: z.string().max(200).optional(),
      idempotencyKey: z.string().max(200).optional(),
    })
    .parse(await c.req.json());
  return c.json(await forkChatGeneration(c.req.param("id"), options), 201);
});
chatRoutes.get("/chat/generations/:id/output", async (c) => {
  const generation = await accessibleGeneration(c.req.param("id"), c.req.raw.headers);
  const after = c.req.query("after");
  if (after !== undefined && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))))
    return c.json({ error: "无效的输出序号。", code: "invalid_request" }, 400);
  if (!getNativeOutput(generation.id))
    return c.json({ error: "该回复没有原生输出。", code: "not_found" }, 404);
  // A full snapshot is a safe reset for any cursor, including one from another server lifetime.
  return outputSse(subscribeNativeOutput(generation.id, c.req.raw.signal));
});
chatRoutes.get("/chat/generations/:id/items/:itemId/output", async (c) => {
  const generation = await accessibleGeneration(c.req.param("id"), c.req.raw.headers);
  const item = getNativeOutput(generation.id)?.items.find((entry) => entry.id === c.req.param("itemId"));
  if (!item || item.type !== "command_execution")
    return c.json({ error: "找不到该命令。", code: "not_found" }, 404);
  return outputSse(subscribeCommandOutput(generation.id, item.id, c.req.raw.signal));
});
chatRoutes.post("/chat/generations/:id/requests/:requestId/respond", async (c) => {
  const generation = await accessibleGeneration(c.req.param("id"), c.req.raw.headers);
  const response = nativeInteractionResponseSchema.parse(await c.req.json());
  respondNativeInteraction(generation.id, c.req.param("requestId"), response);
  return c.json({ accepted: true });
});
chatRoutes.get("/chat/streams/:id", (c) => {
  const generation = getChatGeneration(c.req.param("id"));
  if (!generation) return c.json({ error: "找不到该回复。", code: "not_found" }, 404);
  return createUIMessageStreamResponse({
    stream: subscribeChat(generation.id, c.req.raw.signal),
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
    stream: subscribeChat(generation.id, c.req.raw.signal),
    headers: { "x-resumable-stream-id": generation.id, "cache-control": "no-store" },
  });
});
