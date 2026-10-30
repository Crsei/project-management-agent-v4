import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { z } from "zod";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { closeStore } from "./durable/store.ts";
import { initializeNativeOutput, getNativeOutput } from "./durable/native-output.ts";
import { openPmToolBridge } from "./pm-tools.ts";
import { workspaceRoot } from "./paths.ts";

// Exercises the HTTP boundary without a provider account; PM remains the result authority.
test("tool bridge preserves identity, forbids browser origins, and reconciles lost replies without replay", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-tool-bridge-"));
  const oldData = process.env.AGENT_WORKSPACE_DATA_DIR, oldUrl = process.env.PM_API_URL;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  const workspaceId = randomUUID(), generationId = randomUUID(), operationId = randomUUID();
  const threadId = "thread", messageId = "message";
  let calls = 0; let forwardedCookie: string | undefined; let requestBody: Record<string, unknown> | undefined;
  const server = createServer(async (req, res) => {
    forwardedCookie = req.headers.cookie;
    if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ tools: [] })); return; }
    let text = ""; for await (const chunk of req) text += String(chunk);
    const body = JSON.parse(text) as Record<string, unknown>;
    if (req.url?.endsWith("/call")) { calls++; requestBody = body; req.socket.destroy(); return; }
    assert.deepEqual(body, requestBody);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ operationId, name: "pm_query", status: "succeeded", result: { kind: "query", items: [], nextCursor: null, truncated: false, sources: [] }, error: null, threadId, messageId, generationId, workspaceId, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  initializeNativeOutput(generationId, threadId, "running");
  const bridge = await openPmToolBridge({ scope: { workspaceId, projectId: null }, threadId, messageId, generationId, headers: new Headers({ cookie: "pm_v4_session=fixture" }) });
  try {
    const input = { operationId, name: "pm_query", arguments: { entity: null } };
    const post = (endpoint: string, origin?: string) => fetch(`${bridge.url}/tools/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(input) });
    assert.equal((await post("call", "https://other.example")).status, 403);
    const unknown = await (await post("call")).json() as { status: string };
    assert.equal(unknown.status, "unknown"); assert.equal(calls, 1);
    const same = await (await post("call")).json() as { status: string };
    assert.equal(same.status, "unknown"); assert.equal(calls, 1);
    const recovered = await (await post("result")).json() as { status: string };
    assert.equal(recovered.status, "succeeded"); assert.equal(calls, 1);
    assert.equal(forwardedCookie, "pm_v4_session=fixture");
    assert.deepEqual(requestBody?.scope, { kind: "workspace", projectIds: [] });
    assert.ok(getNativeOutput(generationId)?.items.some((item) => item.id === `pm-tool:${operationId}`));
  } finally {
    await bridge.close(); server.closeAllConnections();
    const closed = Promise.withResolvers<void>(); server.close((error) => error ? closed.reject(error) : closed.resolve()); await closed.promise;
    closeStore();
    if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData;
    if (oldUrl === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = oldUrl;
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP duplicate request IDs reuse the original write and reject changed input", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-tool-mcp-"));
  const oldData = process.env.AGENT_WORKSPACE_DATA_DIR, oldUrl = process.env.PM_API_URL;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  const workspaceId = randomUUID(), generationId = randomUUID(), threadId = "mcp-thread", messageId = "mcp-message";
  const received: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body) as Record<string, unknown>;
    received.push(input);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ operationId: input.operationId, name: input.name, status: "succeeded", result: { kind: "task", items: [], nextCursor: null, truncated: false, sources: [] }, error: null, threadId, messageId, generationId, workspaceId, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  initializeNativeOutput(generationId, threadId, "running");
  const bridge = await openPmToolBridge({ scope: { workspaceId, projectId: null }, threadId, messageId, generationId, headers: new Headers({ cookie: "pm_v4_session=fixture" }) });
  const child = spawn(process.execPath, [path.join(workspaceRoot, "packages/pm-cli/agent-tools.mjs"), bridge.url, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "exit");
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const request = async (message: unknown) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    const line = await output.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value as string) as Record<string, unknown>;
  };
  try {
    await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pm_create_task", arguments: { title: "once" } } };
    const first = await request(call);
    const repeated = await request(call);
    assert.deepEqual(repeated, first);
    assert.equal(received.length, 1);
    const conflict = await request({ ...call, params: { ...call.params, arguments: { title: "different" } } });
    assert.ok(conflict.error);
    assert.equal(received.length, 1);
    const reply = z.object({ result: z.object({ structuredContent: z.object({ operationId: z.uuid() }) }) }).parse(first);
    assert.equal(reply.result.structuredContent.operationId, received[0]?.operationId);
    const restarted = spawn(process.execPath, [path.join(workspaceRoot, "packages/pm-cli/agent-tools.mjs"), bridge.url, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    const restartedExit = once(restarted, "exit");
    const restartedOutput = createInterface({ input: restarted.stdout })[Symbol.asyncIterator]();
    try {
      restarted.stdin.write(`${JSON.stringify(call)}\n`);
      const line = await restartedOutput.next();
      assert.equal(line.done, false);
      const second = z.object({ result: z.object({ structuredContent: z.object({ operationId: z.uuid() }) }) }).parse(JSON.parse(line.value as string));
      assert.notEqual(second.result.structuredContent.operationId, reply.result.structuredContent.operationId);
      assert.equal(second.result.structuredContent.operationId, received[1]?.operationId);
      assert.equal(received.length, 2);
    } finally { restarted.stdin.end(); await restartedExit; }
  } finally {
    child.stdin.end(); await exit;
    await bridge.close(); server.closeAllConnections();
    const closed = Promise.withResolvers<void>(); server.close((error) => error ? closed.reject(error) : closed.resolve()); await closed.promise;
    closeStore();
    if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData;
    if (oldUrl === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = oldUrl;
    await rm(directory, { recursive: true, force: true });
  }
});
