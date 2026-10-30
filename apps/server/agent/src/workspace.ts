import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import { cancelRun, continueRun, getRun, listRuns, submitRun } from "./durable/engine.ts";
import { DurableError } from "./durable/errors.ts";
import { onRunEvent, readRunEvents } from "./durable/events.ts";
import { forkRun, getMergePreview, mergeThread } from "./durable/forks.ts";
import { getWorkspace, importWorkspaces, putWorkspace } from "./durable/resources.ts";
import { getThreadFork } from "./durable/transfers.ts";
import { isObject, text, validateRunRequest } from "./durable/validation.ts";
import { sanitizeErrorMessage } from "./agents/cli-chat.ts";

export const workspaceRoutes = new Hono();
workspaceRoutes.use(
  "/workspace/*",
  bodyLimit({
    maxSize: 16 * 1024 * 1024,
    onError: (c) => c.json({ error: "请求体不得超过 16 MiB。", code: "body_too_large" }, 413),
  }),
);
workspaceRoutes.onError((error, c) => {
  if (error instanceof DurableError) {
    if (error.code === "revision_conflict")
      return c.json(
        {
          error: error.message,
          code: error.code,
          workspace: getWorkspace(c.req.param("threadId")!),
        },
        error.status,
      );
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  return c.json(
    { error: sanitizeErrorMessage(error, "工作区持久化操作失败。"), code: "workspace_error" },
    500,
  );
});
workspaceRoutes.use("/workspace/*", async (c, next) => {
  const threadId = c.req.param("threadId");
  const id = c.req.param("id");
  if (
    (threadId !== undefined && !text(threadId, 120, true)) ||
    (id !== undefined && !text(id, 120, true))
  )
    return c.json({ error: "资源 ID 无效。", code: "invalid_id" }, 400);
  await next();
});
async function parseJson(request: { text: () => Promise<string> }): Promise<unknown> {
  const body = await request.text();
  try {
    return body.trim() ? JSON.parse(body) : {};
  } catch {
    throw new DurableError(400, "invalid_json", "请求体必须是有效的 JSON。");
  }
}
function optionsObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new DurableError(400, "invalid_request", "请求字段无效。");
  return value;
}

workspaceRoutes.get("/workspace/threads/:threadId", (c) => {
  const threadId = c.req.param("threadId");
  return c.json({ workspace: getWorkspace(threadId), fork: getThreadFork(threadId) ?? undefined });
});
workspaceRoutes.put("/workspace/threads/:threadId", async (c) => {
  const threadId = c.req.param("threadId");
  return c.json({
    workspace: putWorkspace(threadId, await parseJson(c.req)),
    fork: getThreadFork(threadId) ?? undefined,
  });
});
workspaceRoutes.post("/workspace/import", async (c) =>
  c.json(importWorkspaces(await parseJson(c.req))),
);
workspaceRoutes.post(
  "/workspace/runs",
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: "运行请求体不得超过 2 MiB。", code: "body_too_large" }, 413),
  }),
  async (c) => {
    const request = await parseJson(c.req);
    validateRunRequest(request);
    return c.json({ run: await submitRun(request) }, 202);
  },
);
workspaceRoutes.get("/workspace/runs", (c) => {
  const threadId = c.req.query("threadId");
  if (threadId !== undefined && !text(threadId, 120, true))
    throw new DurableError(400, "invalid_id", "Thread ID 无效。");
  return c.json({ runs: listRuns(threadId) });
});
workspaceRoutes.get("/workspace/runs/:id", (c) => {
  const run = getRun(c.req.param("id"));
  if (!run) throw new DurableError(404, "run_not_found", "运行不存在。");
  return c.json({ run });
});
workspaceRoutes.post("/workspace/runs/:id/cancel", async (c) => {
  await cancelRun(c.req.param("id"));
  return c.json({ run: getRun(c.req.param("id")) });
});
workspaceRoutes.post("/workspace/runs/:id/continue", async (c) => {
  const value = optionsObject(await parseJson(c.req), ["idempotencyKey", "confirmSideEffects"]);
  if (
    (value.idempotencyKey !== undefined && !text(value.idempotencyKey, 200, true)) ||
    (value.confirmSideEffects !== undefined && typeof value.confirmSideEffects !== "boolean")
  )
    throw new DurableError(400, "invalid_request", "续跑参数无效。");
  return c.json(
    {
      run: await continueRun(c.req.param("id"), {
        idempotencyKey: value.idempotencyKey,
        confirmSideEffects: value.confirmSideEffects,
      }),
    },
    202,
  );
});
workspaceRoutes.post("/workspace/runs/:id/fork", async (c) => {
  const value = optionsObject(await parseJson(c.req), [
    "stepId",
    "title",
    "threadId",
    "idempotencyKey",
  ]);
  for (const key of ["stepId", "threadId", "idempotencyKey", "title"] as const)
    if (
      value[key] !== undefined &&
      !text(value[key], key === "title" || key === "idempotencyKey" ? 200 : 120, true)
    )
      throw new DurableError(400, "invalid_request", "Fork 参数无效。");
  return c.json(
    forkRun(c.req.param("id"), {
      stepId: typeof value.stepId === "string" ? value.stepId : undefined,
      title: typeof value.title === "string" ? value.title : undefined,
      threadId: typeof value.threadId === "string" ? value.threadId : undefined,
      idempotencyKey: typeof value.idempotencyKey === "string" ? value.idempotencyKey : undefined,
    }),
    201,
  );
});
workspaceRoutes.get("/workspace/threads/:threadId/merge-preview", (c) =>
  c.json(getMergePreview(c.req.param("threadId"))),
);
workspaceRoutes.post("/workspace/threads/:threadId/merge", async (c) => {
  const value = optionsObject(await parseJson(c.req), [
    "confirmed",
    "parentThreadId",
    "text",
    "idempotencyKey",
  ]);
  if (
    value.confirmed !== true ||
    (value.parentThreadId !== undefined && !text(value.parentThreadId, 120, true)) ||
    (value.text !== undefined && !text(value.text, 32000)) ||
    (value.idempotencyKey !== undefined && !text(value.idempotencyKey, 200, true))
  )
    throw new DurableError(400, "confirmation_required", "请明确确认有效的回传预览。");
  return c.json({
    transfer: mergeThread(c.req.param("threadId"), {
      confirmed: true,
      parentThreadId: value.parentThreadId,
      text: value.text,
    }),
  });
});
workspaceRoutes.get("/workspace/runs/:id/events", (c) => {
  const runId = c.req.param("id");
  const initial = getRun(runId);
  if (!initial) throw new DurableError(404, "run_not_found", "运行不存在。");
  const rawAfter = c.req.query("after") ?? "0";
  const after = Number(rawAfter);
  if (!/^\d+$/.test(rawAfter) || !Number.isSafeInteger(after))
    throw new DurableError(400, "invalid_cursor", "after 必须是非负整数事件序号。");
  c.header("Content-Type", "application/x-ndjson; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");
  return stream(c, async (output) => {
    let cursor = after;
    let disconnected = false;
    let wake = Promise.withResolvers<void>();
    const unsubscribe = onRunEvent(runId, () => wake.resolve());
    const disconnect = () => {
      disconnected = true;
      wake.resolve();
    };
    output.onAbort(disconnect);
    c.req.raw.signal.addEventListener("abort", disconnect, { once: true });
    try {
      if (c.req.raw.signal.aborted) disconnect();
      while (!disconnected) {
        wake = Promise.withResolvers<void>();
        const events = readRunEvents(runId, cursor);
        for (const event of events) {
          await output.writeln(JSON.stringify(event));
          cursor = event.seq;
        }
        if (events.length) continue;
        const current = getRun(runId);
        if (!current || (current.status !== "queued" && current.status !== "running")) break;
        await wake.promise;
      }
    } finally {
      unsubscribe();
      c.req.raw.signal.removeEventListener("abort", disconnect);
      // This subscriber never aborts the detached execution controller.
    }
  });
});
