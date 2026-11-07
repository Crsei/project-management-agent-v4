import { Hono } from "hono";
import { stream } from "hono/streaming";
import { cancelRun, getRun, listRuns } from "./durable/engine.ts";
import { DurableError } from "./durable/errors.ts";
import { onRunEvent, readRunEvents } from "./durable/events.ts";
import { text } from "./durable/validation.ts";

/** Archival resource-run evidence only. Creation/import/continue/fork/merge belonged to the removed Session model. */
export const workspaceRoutes = new Hono();
workspaceRoutes.onError((error, c) => error instanceof DurableError
  ? c.json({ error: error.message, code: error.code }, error.status)
  : c.json({ error: "无法读取历史执行证据。", code: "workspace_history_error" }, 500));
workspaceRoutes.get("/workspace/runs", c => {
  const threadId = c.req.query("threadId");
  if (threadId !== undefined && !text(threadId, 256, true)) throw new DurableError(400, "invalid_id", "Thread ID 无效。");
  return c.json({ runs: listRuns(threadId) });
});
workspaceRoutes.get("/workspace/runs/:id", c => {
  const run = getRun(c.req.param("id"));
  if (!run) throw new DurableError(404, "run_not_found", "历史运行不存在。");
  return c.json({ run });
});
workspaceRoutes.post("/workspace/runs/:id/cancel", async c => {
  await cancelRun(c.req.param("id"));
  return c.json({ run: getRun(c.req.param("id")) });
});
workspaceRoutes.get("/workspace/runs/:id/events", c => {
  const runId = c.req.param("id"), initial = getRun(runId);
  if (!initial) throw new DurableError(404, "run_not_found", "历史运行不存在。");
  const rawAfter = c.req.query("after") ?? "0", after = Number(rawAfter);
  if (!/^\d+$/.test(rawAfter) || !Number.isSafeInteger(after)) throw new DurableError(400, "invalid_cursor", "after 必须是非负整数事件序号。");
  c.header("Content-Type", "application/x-ndjson; charset=utf-8"); c.header("Cache-Control", "no-cache, no-transform"); c.header("X-Accel-Buffering", "no");
  return stream(c, async output => {
    let cursor = after, disconnected = false, wake = Promise.withResolvers<void>();
    const unsubscribe = onRunEvent(runId, () => wake.resolve());
    const disconnect = () => { disconnected = true; wake.resolve(); };
    output.onAbort(disconnect); c.req.raw.signal.addEventListener("abort", disconnect, { once: true });
    try {
      if (c.req.raw.signal.aborted) disconnect();
      while (!disconnected) {
        wake = Promise.withResolvers<void>();
        const events = readRunEvents(runId, cursor);
        for (const event of events) { await output.writeln(JSON.stringify(event)); cursor = event.seq; }
        if (events.length) continue;
        const current = getRun(runId);
        if (!current || current.status !== "queued" && current.status !== "running") break;
        await wake.promise;
      }
    } finally { unsubscribe(); c.req.raw.signal.removeEventListener("abort", disconnect); }
  });
});
