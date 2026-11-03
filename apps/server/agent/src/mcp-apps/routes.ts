import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { mcpAppCallInputSchema, mcpAppContextInputSchema, mcpAppResourceInputSchema } from "@agent-workspace/contracts/mcp-apps";
import { DurableError } from "../durable/errors.ts";
import { mcpAppCall, mcpAppContext, mcpAppResource, mcpAppSnapshot, mcpAppTools } from "./requests.ts";
import { getThread } from "../durable/threads.ts";
import { resolveChatExecutionScope } from "../task-delivery/binding.ts";
import { resolvePmContextBinding } from "../durable/pm-context.ts";
import { closeMcpAppSession } from "./live.ts";

async function readBody(request: Request, limit: number): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new DurableError(415, "invalid_content_type", "MCP App requests require JSON.");
  const reader = request.body?.getReader();
  if (!reader) throw new DurableError(400, "invalid_body", "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new DurableError(413, "mcp_app_request_too_large", "The App request exceeds the permitted size.");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new DurableError(400, "invalid_body", "The App request must contain valid UTF-8 JSON."); }
}

/** Mounted by the Agent host at /api; normal browser authentication remains mandatory. */
export const mcpAppRoutes = new Hono();
mcpAppRoutes.onError((error, c) => {
  if (error instanceof DurableError) return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
  if (error instanceof z.ZodError) return c.json({ error: "Invalid MCP App request.", code: "invalid_body" }, 400);
  return c.json({ error: "MCP App request failed.", code: "mcp_app_request_failed" }, 500);
});
mcpAppRoutes.use("/mcp-apps/:threadId/:itemId/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  const threadId = c.req.param("threadId");
  const itemId = c.req.param("itemId");
  if (!threadId || !itemId || threadId.length > 512 || itemId.length > 512)
    throw new DurableError(400, "invalid_target", "Invalid producing App target.");
  const thread = getThread(threadId);
  if (!thread) throw new DurableError(404, "thread_not_found", "The producing thread was not found.");
  try {
    // Shared Chat scope authority runs even when the App capability has stopped.
    // Current browser credentials are never replaced by the producing turn's headers.
    // A frame remount cancels its read, not the native session's authority. Finish
    // the bounded check so cancellation cannot masquerade as a scope failure.
    await resolveChatExecutionScope(thread, c.req.raw.headers, "inspect");
    if (thread.pmContext) await resolvePmContextBinding(thread.pmContext, thread.scope, c.req.raw.headers);
  } catch (error) {
    await closeMcpAppSession(threadId);
    throw error;
  }
  if (c.req.raw.signal.aborted)
    throw new DurableError(409, "mcp_app_request_cancelled", "The App request was cancelled. No operation was started.");
  await next();
});
mcpAppRoutes.get("/mcp-apps/:threadId/:itemId/snapshot", async c => c.json(await mcpAppSnapshot(
  c.req.param("threadId"), c.req.param("itemId"), c.req.raw.headers, c.req.raw.signal)));
mcpAppRoutes.get("/mcp-apps/:threadId/:itemId/tools", async c => c.json(await mcpAppTools(
  c.req.param("threadId"), c.req.param("itemId"), c.req.raw.headers, c.req.raw.signal)));
mcpAppRoutes.post("/mcp-apps/:threadId/:itemId/call", async c => {
  const input = mcpAppCallInputSchema.parse(await readBody(c.req.raw, 64 * 1024));
  return c.json(await mcpAppCall(c.req.param("threadId"), c.req.param("itemId"), c.req.raw.headers, input, c.req.raw.signal));
});
mcpAppRoutes.post("/mcp-apps/:threadId/:itemId/resource", async c => {
  const input = mcpAppResourceInputSchema.parse(await readBody(c.req.raw, 8 * 1024));
  return c.json(await mcpAppResource(c.req.param("threadId"), c.req.param("itemId"), c.req.raw.headers, input.uri, c.req.raw.signal));
});
mcpAppRoutes.post("/mcp-apps/:threadId/:itemId/context", async c => {
  const input = mcpAppContextInputSchema.parse(await readBody(c.req.raw, 16 * 1024));
  return c.json(await mcpAppContext(c.req.param("threadId"), c.req.param("itemId"), c.req.raw.headers, input, c.req.raw.signal));
});
