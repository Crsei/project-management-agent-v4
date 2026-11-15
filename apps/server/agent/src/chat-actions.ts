import { Hono } from "hono";
import { z } from "zod";
import { chatQueueActionSchema, savedChatDraftSchema } from "@agent-workspace/contracts/chat";
import { DurableError } from "./durable/errors.ts";
import { getThreadHistory, ThreadConflictError } from "./durable/threads.ts";
import { listChatGenerations } from "./durable/chat-runtime.ts";
import { enqueueMessage, editQueuedMessage, listQueuedMessages, listStashedDrafts, mutateQueue, queueRuntimeId, reconcileQueuedMessage, removeStashedDraft, savedDraftExists, sendQueuedMessage, stashDraft } from "./durable/message-queue.ts";
import { implementGenerationPlan, nativeForkGeneration, resolveGenerationSubagent, rewindConversation, steerActiveGeneration, threadActionCapabilities } from "./durable/thread-actions.ts";

const operationIdentity = z.object({ idempotencyKey: z.string().min(1).max(200) }).strict();
/** Mounted on the existing guarded Chat router; no alternate authorization or worker lifecycle. */
export const chatActionRoutes = new Hono()
  .onError((error, c) => {
    if (error instanceof DurableError) return c.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof ThreadConflictError) return c.json({ error: error.message, code: error.code }, error.code === "not_found" ? 404 : 409);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "请求格式无效。", code: "invalid_request" }, 400);
    return c.json({ error: "操作结果未明，请只读取原操作状态，不自动重发。", code: "operation_unknown" }, 500);
  })
  .get("/chat/threads/:id/saved-drafts/:kind/:draftId", async c => {
    const kind = z.enum(["queue", "stash"]).parse(c.req.param("kind"));
    return c.json({ saved: await savedDraftExists(c.req.param("id"), c.req.param("draftId"), kind, c.req.raw.headers) });
  })
  .get("/chat/threads/:id/queue", async c => {
    const id = c.req.param("id"), messages = await listQueuedMessages(id, c.req.raw.headers), latest = listChatGenerations(id)[0];
    return c.json({ messages, runtimeId: queueRuntimeId, headId: getThreadHistory(id).headId,
      latest: latest ? { id: latest.id, status: latest.status, messageId: latest.messageId } : null });
  })
  .post("/chat/threads/:id/queue", async c => {
    const input = savedChatDraftSchema.parse(await c.req.json());
    await enqueueMessage(c.req.param("id"), input.id, input.draft, input.threadSettingsRevision, c.req.raw.headers);
    return c.json({ saved: true }, 201);
  })
  .post("/chat/threads/:id/queue/:queueId", async c => {
    const input = chatQueueActionSchema.parse(await c.req.json()), threadId = c.req.param("id"), id = c.req.param("queueId"), headers = c.req.raw.headers;
    if (input.action === "send") await sendQueuedMessage(threadId, id, input.revision, headers, input.confirmAfterGenerationId,
      { headId: input.expectedHeadId, generationId: input.expectedGenerationId });
    else if (input.action === "reconcile") await reconcileQueuedMessage(threadId, id, input.revision, headers);
    else if (input.action === "edit") await editQueuedMessage(threadId, id, input.revision, input.draft, input.threadSettingsRevision, headers);
    else await mutateQueue(threadId, id, input.revision, input.action, headers, input.action === "move" ? input.beforeId : undefined);
    const messages = await listQueuedMessages(threadId, headers);
    return c.json({ messages, generationId: messages.find(row => row.id === id)?.generationId });
  })
  .get("/chat/threads/:id/stash", async c => c.json({ drafts: await listStashedDrafts(c.req.param("id"), c.req.raw.headers) }))
  .post("/chat/threads/:id/stash", async c => {
    const input = savedChatDraftSchema.parse(await c.req.json());
    await stashDraft(c.req.param("id"), input.id, input.draft, c.req.raw.headers);
    return c.json({ saved: true }, 201);
  })
  .delete("/chat/threads/:id/stash/:draftId", async c => {
    await removeStashedDraft(c.req.param("id"), c.req.param("draftId"), c.req.raw.headers);
    return c.json({ removed: true });
  })
  .get("/chat/threads/:id/actions", async c => c.json(await threadActionCapabilities(c.req.param("id"), c.req.raw.headers)))
  .post("/chat/threads/:id/steer", async c => {
    const input = z.object({ generationId: z.string().min(1), idempotencyKey: z.string().min(1).max(200), text: z.string().trim().min(1).max(32000), confirmToolInterruption: z.boolean().optional() }).strict().parse(await c.req.json());
    return c.json(await steerActiveGeneration(c.req.param("id"), input, c.req.raw.headers));
  })
  .post("/chat/threads/:id/rewind", async c => {
    const input = z.object({ messageId: z.string().min(1).max(256), expectedHeadId: z.string().nullable(), revision: z.number().int().nonnegative(), confirmed: z.boolean(), idempotencyKey: z.string().min(1).max(200) }).strict().parse(await c.req.json());
    return c.json(await rewindConversation(c.req.param("id"), input, c.req.raw.headers));
  })
  .post("/chat/generations/:id/native-fork", async c => {
    const input = operationIdentity.parse(await c.req.json());
    return c.json(await nativeForkGeneration(c.req.param("id"), input.idempotencyKey, c.req.raw.headers), 201);
  })
  .post("/chat/generations/:id/plans/:itemId/implement", async c => {
    const input = operationIdentity.parse(await c.req.json());
    return c.json(await implementGenerationPlan(c.req.param("id"), c.req.param("itemId"), input.idempotencyKey, c.req.raw.headers), 202);
  })
  .get("/chat/generations/:id/subagents/:itemId/session", async c => c.json(await resolveGenerationSubagent(c.req.param("id"), c.req.param("itemId"), c.req.raw.headers)));
