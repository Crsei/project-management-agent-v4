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
import { closeStore, readRecord, writeRecord } from "./durable/store.ts";
import { initializeNativeOutput, getNativeOutput } from "./durable/native-output.ts";
import { callPmTool, openPmToolBridge, pmToolRoutes, type StoredPmToolCall } from "./pm-tools.ts";
import { ensureThread } from "./durable/threads.ts";
import { workspaceRoot } from "./paths.ts";
import { pmToolRequestHash } from "../../../../packages/infrastructure/src/pm-tool-service-auth.ts";

const queryArguments = { entity: null, projectId: null, query: null, after: null, limit: 20 };
const taskArguments = { projectId: "PRJ-001", title: "once", description: "", assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null };

// Exercises the HTTP boundary without a provider account; PM remains the result authority.
test("tool bridge preserves identity, forbids browser origins, and reconciles lost replies without replay", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-tool-bridge-"));
  const oldData = process.env.AGENT_WORKSPACE_DATA_DIR, oldUrl = process.env.PM_API_URL;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  const workspaceId = randomUUID(), generationId = randomUUID(), operationId = randomUUID();
  const actorId = randomUUID(), target = { workspaceId, projectId: null };
  const threadId = "thread", messageId = "message";
  let calls = 0; let forwardedCookie: string | undefined; let requestBody: Record<string, unknown> | undefined;
  let live = true;
  const admission = Promise.withResolvers<void>(), reachedAdmission = Promise.withResolvers<void>();
  let authorizations = 0;
  const authorizeExecution = async () => {
    if (!live) throw new Error("Generation authorization is no longer live");
    if (++authorizations === 2) reachedAdmission.resolve();
    await admission.promise;
  };
  const server = createServer(async (req, res) => {
    forwardedCookie = req.headers.cookie;
    if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ tools: [] })); return; }
    let text = ""; for await (const chunk of req) text += String(chunk);
    const body = JSON.parse(text) as Record<string, unknown>;
    if (req.url === "/api/v1/agent-contexts/authorize") {
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ actorId, scope: body })); return;
    }
    if (req.url?.endsWith("/call")) { calls++; requestBody = body; reachedAdmission.resolve(); req.socket.destroy(); return; }
    assert.deepEqual(body, requestBody);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ operationId, name: "pm_query", target, actorId, status: "succeeded", result: { kind: "query", items: [], nextCursor: null, truncated: false, sources: [] }, error: null, threadId, messageId, generationId, workspaceId, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  initializeNativeOutput(generationId, threadId, "running");
  const bridge = await openPmToolBridge({ threadId, messageId, generationId, headers: new Headers({ cookie: "pm_v4_session=fixture" }), authorizeExecution });
  try {
    const input = { operationId, name: "pm_query", target, arguments: queryArguments };
    const post = (endpoint: string, origin?: string) => fetch(`${bridge.url}/tools/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(input) });
    assert.equal((await post("call", "https://other.example")).status, 403);
    const pending = Promise.all([post("call"), post("call")]);
    await reachedAdmission.promise;
    admission.resolve();
    const initial = await Promise.all((await pending).map(async response => z.object({ status: z.enum(["running", "unknown"]) }).parse(await response.json())));
    assert.ok(initial.some(record => record.status === "unknown")); assert.equal(calls, 1);
    live = false;
    for (const endpoint of ["call", "result"]) {
      const denied = await post(endpoint);
      assert.equal(denied.status, 400);
      assert.match((await denied.json() as { error: string }).error, /no longer live/);
    }
    assert.equal(calls, 1);
    const rejected = await fetch(`${bridge.url}/tools/call`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, operationId: randomUUID() }) });
    assert.equal(rejected.status, 400); assert.equal(calls, 1);
    live = true;
    const same = await (await post("call")).json() as { status: string };
    assert.equal(same.status, "unknown"); assert.equal(calls, 1);
    const recovered = await (await post("result")).json() as { status: string; operationId: string };
    assert.equal(recovered.status, "succeeded"); assert.equal(recovered.operationId, operationId); assert.equal(calls, 1);
    assert.equal(forwardedCookie, "pm_v4_session=fixture");
    assert.deepEqual(requestBody?.target, target);
    assert.equal(requestBody?.scope, undefined);
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
  const actorId = randomUUID(), target = { workspaceId, projectId: "PRJ-001" };
  const received: Array<Record<string, unknown>> = [];
  let live = true, targetAllowed = true, currentActor = actorId;
  const authorizeExecution = async () => { if (!live) throw new Error("Generation authorization is no longer live"); };
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body) as Record<string, unknown>;
    if (req.url === "/api/v1/agent-contexts/authorize") {
      if (!targetAllowed) { res.writeHead(403).end(JSON.stringify({ error: "Target access revoked" })); return; }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ actorId: currentActor, scope: input })); return;
    }
    if (req.url?.endsWith("/call")) received.push(input);
    else assert.ok(req.url?.endsWith("/result"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ operationId: input.operationId, name: input.name, target: input.target, actorId, status: "succeeded", result: { kind: "task", items: [], nextCursor: null, truncated: false, sources: [] }, error: null, threadId, messageId, generationId, workspaceId, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  initializeNativeOutput(generationId, threadId, "running");
  const bridge = await openPmToolBridge({ threadId, messageId, generationId, headers: new Headers({ cookie: "pm_v4_session=fixture" }), authorizeExecution });
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
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pm_create_task", arguments: { target, arguments: taskArguments } } };
    const first = await request(call);
    assert.deepEqual(await request(call), first);
    assert.equal(received.length, 1);
    targetAllowed = false;
    const revoked = await request(call);
    assert.ok(revoked.error);
    assert.doesNotMatch(JSON.stringify(revoked), /structuredContent|once/);
    assert.equal(received.length, 1);
    targetAllowed = true;
    currentActor = randomUUID();
    assert.ok((await request(call)).error, "another PM actor cannot retrieve the cached write");
    assert.equal(received.length, 1);
    currentActor = actorId;
    live = false;
    assert.ok((await request(call)).error, "a stopped generation cannot retrieve the cached write");
    assert.equal(received.length, 1);
    const conflict = await request({ ...call, params: { ...call.params, arguments: { target, arguments: { title: "different" } } } });
    assert.ok(conflict.error);
    assert.equal(received.length, 1);
    const denied = await request({ ...call, id: 3 });
    assert.ok(denied.error);
    assert.equal(received.length, 1);
    live = true;
    assert.deepEqual(await request(call), first);
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

test("native registration is PM-independent and one Session selects every PM target explicitly", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-tool-targets-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR, previousPm = process.env.PM_API_URL;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  const workspaceId = randomUUID(), actorId = randomUUID(), generationId = randomUUID();
  const firstTarget = { workspaceId, projectId: "PRJ-001" }, secondTarget = { workspaceId, projectId: "PRJ-002" };
  const requests: { path: string; input: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += String(chunk);
    const input = text ? JSON.parse(text) as Record<string, unknown> : {};
    requests.push({ path: request.url!, input });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/agent-contexts") {
      response.end(JSON.stringify({ workspaces: [{ id: workspaceId, name: "PM", workspaceAllowed: true,
        fileArea: { path: "/must-not-leak" }, projects: [{ id: "PRJ-001", name: "One" }, { id: "PRJ-002", name: "Two" }] }] })); return;
    }
    if (request.url === "/api/v1/agent-contexts/authorize") {
      response.end(JSON.stringify({ actorId, scope: input })); return;
    }
    response.end(JSON.stringify({ operationId: input.operationId, name: input.name, target: input.target, actorId,
      status: "succeeded", result: { kind: "query", items: [], nextCursor: null, truncated: false, sources: [] },
      error: null, threadId: input.threadId, messageId: input.messageId, generationId: input.generationId,
      workspaceId, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  const context = { threadId: "one-code-session", messageId: "message", generationId,
    headers: new Headers({ cookie: "pm_v4_session=fixture" }), authorizeExecution: async () => {} };
  initializeNativeOutput(generationId, context.threadId, "running");
  const bridge = await openPmToolBridge(context);
  const limitedBridge = await openPmToolBridge({ ...context, targetCeiling: firstTarget });
  const send = async (base: string, input: unknown) => {
    const response = await fetch(`${base}/tools/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  try {
    const originalDirectory = process.cwd();
    const registry = await (await fetch(`${bridge.url}/tools/list`)).json() as { tools: { name: string; inputSchema: Record<string, unknown> }[] };
    assert.equal(requests.length, 0, "native MCP registration must not contact PM");
    assert.ok(registry.tools.some(tool => tool.name === "pm_list_workspaces"));
    assert.deepEqual(registry.tools.find(tool => tool.name === "pm_query")!.inputSchema.required, ["target", "arguments"]);
    const missingTarget = await send(bridge.url, { operationId: randomUUID(), name: "pm_query", arguments: {} });
    assert.equal(missingTarget.status, 400); assert.equal(requests.length, 0);
    const operationId = randomUUID();
    for (const [index, target] of [firstTarget, secondTarget].entries()) {
      const result = await send(bridge.url, { operationId: index === 0 ? operationId : randomUUID(), name: "pm_query", target, arguments: queryArguments });
      assert.equal(result.body.status, "succeeded");
      assert.deepEqual(result.body.target, target);
      assert.equal(result.body.threadId, context.threadId);
    }
    assert.equal(process.cwd(), originalDirectory);
    const dispatched = requests.filter(request => request.path.endsWith("/call"));
    assert.deepEqual(dispatched.map(request => request.input.target), [firstTarget, secondTarget]);
    assert.ok(dispatched.every(request => !("scope" in request.input)));
    assert.equal((await send(bridge.url, { operationId, name: "pm_query", target: secondTarget, arguments: {} })).status, 400);
    const count = requests.length;
    assert.equal((await send(limitedBridge.url, { operationId: randomUUID(), name: "pm_query", target: secondTarget, arguments: {} })).status, 400);
    assert.equal(requests.length, count, "forged business ceiling fails before any PM dispatch");
    const discovery = await send(bridge.url, { operationId: randomUUID(), name: "pm_list_workspaces", arguments: {} });
    assert.equal(discovery.body.status, "succeeded"); assert.equal(discovery.body.workspaceId, null);
    assert.equal(discovery.body.target, undefined);
    assert.doesNotMatch(JSON.stringify(discovery.body), /must-not-leak|fileArea|pm_v4_session/);
  } finally {
    await Promise.all([bridge.close(), limitedBridge.close()]);
    server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise;
    closeStore();
    if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
    if (previousPm === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = previousPm;
    await rm(directory, { recursive: true, force: true });
  }
});

test("cached discovery rechecks visible PM targets, concurrent admission, and live execution", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-tool-discovery-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR, previousPm = process.env.PM_API_URL;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  const workspaceId = randomUUID(), generationId = randomUUID();
  let visibility: "all" | "project-revoked" | "workspace-revoked" | "missing" = "all";
  let live = true, discoveries = 0;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/v1/agent-contexts");
    discoveries++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ workspaces: visibility === "missing" ? [] : [{
      id: workspaceId, name: "Confidential PM workspace", workspaceAllowed: visibility !== "workspace-revoked",
      projects: visibility === "project-revoked" ? [] : [{ id: "PRJ-001", name: "Confidential project" }],
    }] }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  const context = { threadId: "discovery-thread", messageId: "message", generationId,
    headers: new Headers({ cookie: "pm_v4_session=fixture" }),
    authorizeExecution: async () => { if (!live) throw new Error("Generation authorization is no longer live"); } };
  initializeNativeOutput(generationId, context.threadId, "running");
  const bridge = await openPmToolBridge(context);
  const input = { operationId: randomUUID(), name: "pm_list_workspaces", arguments: {} };
  const transport = { transportId: "discovery-transport", requestId: 1, name: input.name, arguments: { arguments: {} } };
  const send = async (endpoint: string, body: unknown) => {
    const response = await fetch(`${bridge.url}/tools/${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const reachedAdmission = Promise.withResolvers<void>(), releaseAdmission = Promise.withResolvers<void>();
  try {
    const first = await send("call", input);
    assert.equal(first.body.status, "succeeded");
    const count = discoveries;
    assert.deepEqual(await send("call", input), first);
    assert.ok(discoveries > count, "an existing discovery operation must revalidate its result");
    const firstTransport = await send("mcp-call", transport);
    assert.equal(firstTransport.body.status, "succeeded");
    assert.deepEqual(await send("mcp-call", transport), firstTransport);

    // Pause the second admission check so another request creates this exact operation first.
    const raceInput = { ...input, operationId: randomUUID() };
    let checks = 0;
    const raced = assert.rejects(callPmTool({ ...context, authorizeExecution: async () => {
      await context.authorizeExecution();
      if (++checks === 2) { reachedAdmission.resolve(); await releaseAdmission.promise; }
    } }, raceInput), /no longer authorized/);
    await reachedAdmission.promise;
    assert.equal((await callPmTool(context, raceInput)).status, "succeeded");
    visibility = "missing";
    releaseAdmission.resolve();
    await raced;

    for (const revoked of ["project-revoked", "workspace-revoked", "missing"] as const) {
      visibility = revoked;
      for (const [endpoint, body] of [["call", input], ["result", input], ["mcp-call", transport]] as const) {
        const denied = await send(endpoint, body);
        assert.equal(denied.status, 400);
        assert.doesNotMatch(JSON.stringify(denied.body), /Confidential|operationId|workspaces/);
      }
    }
    visibility = "all";
    assert.deepEqual(await send("mcp-call", transport), firstTransport);
    live = false;
    const beforeStoppedRequests = discoveries;
    for (const [endpoint, body] of [["call", input], ["result", input], ["mcp-call", transport]] as const) {
      const denied = await send(endpoint, body);
      assert.equal(denied.status, 400);
      assert.match(String(denied.body.error), /no longer live/);
    }
    assert.equal(discoveries, beforeStoppedRequests, "stopped execution fails before contacting PM");
  } finally {
    releaseAdmission.resolve();
    await bridge.close(); server.closeAllConnections();
    const closed = Promise.withResolvers<void>(); server.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise;
    closeStore();
    if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
    if (previousPm === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = previousPm;
    await rm(directory, { recursive: true, force: true });
  }
});

test("native MCP unknown writes retain their operationId and never bypass live retrieval checks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-tool-mcp-unknown-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR, previousPm = process.env.PM_API_URL;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  const workspaceId = randomUUID(), actorId = randomUUID(), generationId = randomUUID();
  const target = { workspaceId, projectId: "PRJ-001" };
  let live = true, targetAllowed = true, writes = 0, results = 0;
  const authorizationReached = Promise.withResolvers<void>(), releaseAuthorization = Promise.withResolvers<void>();
  const resultReached = Promise.withResolvers<void>(), releaseResult = Promise.withResolvers<void>();
  let pauseAuthorization = false, pauseResult = false;
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += String(chunk);
    const input = JSON.parse(text) as Record<string, unknown>;
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/agent-contexts/authorize") {
      if (pauseAuthorization) { pauseAuthorization = false; authorizationReached.resolve(); await releaseAuthorization.promise; }
      if (!targetAllowed) { response.writeHead(403).end(JSON.stringify({ error: "Target access revoked" })); return; }
      response.end(JSON.stringify({ actorId, scope: input })); return;
    }
    if (request.url?.endsWith("/call")) { writes++; request.socket.destroy(); return; }
    assert.ok(request.url?.endsWith("/result"));
    results++;
    if (pauseResult) { pauseResult = false; resultReached.resolve(); await releaseResult.promise; }
    response.end(JSON.stringify({ operationId: input.operationId, name: input.name, target: input.target, actorId,
      status: "succeeded", result: { kind: "task", items: [], nextCursor: null, truncated: false, sources: [] },
      error: null, threadId: input.threadId, messageId: input.messageId, generationId: input.generationId,
      workspaceId, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  const context = { threadId: "unknown-mcp-thread", messageId: "message", generationId,
    headers: new Headers({ cookie: "pm_v4_session=fixture" }),
    authorizeExecution: async () => { if (!live) throw new Error("Generation authorization is no longer live"); } };
  initializeNativeOutput(generationId, context.threadId, "running");
  const bridge = await openPmToolBridge(context);
  const transport = { transportId: "unknown-transport", requestId: 1, name: "pm_create_task", arguments: { target, arguments: taskArguments } };
  const send = async (endpoint: string, body: unknown) => {
    const response = await fetch(`${bridge.url}/tools/${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  try {
    const [first, duplicate] = await Promise.all([send("mcp-call", transport), send("mcp-call", transport)]);
    assert.equal(first.body.status, "unknown");
    assert.deepEqual(duplicate, first);
    assert.equal(writes, 1); assert.equal(results, 0);
    const operationId = z.uuid().parse(first.body.operationId);
    const input = { operationId, name: transport.name, ...transport.arguments };
    assert.deepEqual(await send("mcp-call", transport), first);
    assert.equal(writes, 1); assert.equal(results, 0);

    targetAllowed = false;
    for (const [endpoint, body] of [["mcp-call", transport], ["result", input]] as const) {
      const denied = await send(endpoint, body);
      assert.equal(denied.status, 400);
      assert.equal(denied.body.operationId, undefined);
    }
    assert.equal(writes, 1); assert.equal(results, 0);
    targetAllowed = true;
    const recovered = await send("result", input);
    assert.equal(recovered.body.status, "succeeded");
    assert.equal(recovered.body.operationId, operationId);
    assert.equal(recovered.body.visibility, "visible", "explicit result delivery uses the current authorized projection");
    const cachedRecovered = await send("mcp-call", transport);
    assert.equal(cachedRecovered.status, 200);
    assert.equal(cachedRecovered.body.status, "succeeded");
    assert.equal(cachedRecovered.body.operationId, operationId);
    assert.equal(cachedRecovered.body.actorId, actorId);
    assert.deepEqual(cachedRecovered.body.target, target);
    assert.deepEqual(cachedRecovered.body.result, recovered.body.result);
    assert.equal(writes, 1);

    pauseAuthorization = true;
    const stopping = send("mcp-call", transport);
    await authorizationReached.promise;
    live = false; releaseAuthorization.resolve();
    const stopped = await stopping;
    assert.equal(stopped.status, 400);
    assert.match(String(stopped.body.error), /no longer live/);
    assert.equal(stopped.body.operationId, undefined);
    assert.equal(writes, 1);

    live = true; pauseResult = true;
    const retrieving = send("result", input);
    await resultReached.promise;
    live = false; releaseResult.resolve();
    const stoppedResult = await retrieving;
    assert.equal(stoppedResult.status, 400);
    assert.match(String(stoppedResult.body.error), /no longer live/);
    assert.equal(stoppedResult.body.operationId, undefined);
    assert.equal(writes, 1);
  } finally {
    releaseAuthorization.resolve(); releaseResult.resolve();
    await bridge.close(); server.closeAllConnections();
    const closed = Promise.withResolvers<void>(); server.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise;
    closeStore();
    if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
    if (previousPm === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = previousPm;
    await rm(directory, { recursive: true, force: true });
  }
});

test("native and MCP calls reject invalid inputs before PM dispatch and bind corrections to a new read", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-tool-inputs-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR, previousPm = process.env.PM_API_URL;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  const workspaceId = randomUUID(), actorId = randomUUID(), generationId = randomUUID();
  const target = { workspaceId, projectId: "PRJ-002" };
  const dispatched: Array<Record<string, unknown>> = [];
  let results = 0;
  const originalResults = new Map<string, unknown>();
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += String(chunk);
    const input = JSON.parse(text) as Record<string, unknown>;
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/agent-contexts/authorize") {
      response.end(JSON.stringify({ actorId, scope: input })); return;
    }
    if (request.url?.endsWith("/result")) {
      results++;
      const original = originalResults.get(String(input.operationId));
      if (!original) { response.writeHead(404).end("{}"); return; }
      response.end(JSON.stringify(original)); return;
    }
    assert.ok(request.url?.endsWith("/call"));
    dispatched.push(input);
    const args = input.arguments as typeof queryArguments;
    const original = { ...input, workspaceId, actorId, status: "succeeded", error: null,
      result: { kind: "query", items: [], sources: [], nextCursor: args.after === null ? "TASK-020" : null, truncated: args.after === null },
      createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    originalResults.set(String(input.operationId), original);
    response.end(JSON.stringify(original));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  const context = { threadId: "input-validation", messageId: "message", generationId, authorizeExecution: async () => {} };
  initializeNativeOutput(generationId, context.threadId, "running");
  const bridge = await openPmToolBridge(context);
  const send = async (endpoint: string, input: unknown) => {
    const response = await fetch(`${bridge.url}/tools/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  try {
    const input = { operationId: randomUUID(), name: "pm_query", target, arguments: { ...queryArguments, limit: 100 } };
    const rejected = await send("call", input);
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, "failed");
    assert.deepEqual(rejected.body.certainty, { dispatch: "not_sent", evidence: "local_rejection" });
    assert.match(JSON.stringify(rejected.body.error), /limit: must be at most 20/);
    assert.match(JSON.stringify(rejected.body.error), /nextCursor.*after/);
    assert.equal(dispatched.length, 0);
    const result = await send("result", input);
    assert.equal(result.body.status, "failed");
    assert.deepEqual(result.body.error, rejected.body.error);
    assert.equal(results, 0, "a known local rejection never queries a nonexistent PM result");
    assert.equal((await send("call", { ...input, arguments: queryArguments })).status, 400, "operation IDs cannot be reused for corrected input");
    const transport = { transportId: "invalid-query", requestId: 7, name: input.name, arguments: { target, arguments: input.arguments } };
    const mcpRejected = await send("mcp-call", transport);
    assert.equal(mcpRejected.body.status, "failed");
    assert.deepEqual((await send("mcp-call", transport)).body, mcpRejected.body);
    assert.equal((await send("mcp-call", { ...transport, arguments: { target, arguments: queryArguments } })).status, 400, "MCP IDs cannot adopt changed arguments");
    const unknownTool = await callPmTool(context, { operationId: randomUUID(), name: "pm_unregistered", target, arguments: {} });
    assert.equal(unknownTool.status, "failed");
    assert.equal(unknownTool.error?.code, "agent_tool_not_available");
    const badWrite = await callPmTool(context, { operationId: randomUUID(), name: "pm_delete_task", target, arguments: { id: "TASK-001", revision: "bad" } });
    assert.equal(badWrite.status, "failed", "invalid destructive writes never wait for approval");
    assert.deepEqual(badWrite.certainty, { dispatch: "not_sent", evidence: "local_rejection" });
    assert.equal(dispatched.length, 0);
    const corrected = await send("call", { ...input, operationId: randomUUID(), arguments: queryArguments });
    assert.equal(corrected.body.status, "succeeded");
    assert.notEqual(corrected.body.operationId, input.operationId);
    const cursor = z.object({ nextCursor: z.string() }).parse(corrected.body.result).nextCursor;
    const nextArguments = { ...queryArguments, after: cursor };
    const continued = await send("call", { ...input, operationId: randomUUID(), arguments: nextArguments });
    assert.equal(continued.body.status, "succeeded");
    assert.equal(z.object({ nextCursor: z.string().nullable() }).parse(continued.body.result).nextCursor, null);
    assert.deepEqual(dispatched.map(call => call.arguments), [queryArguments, nextArguments]);
    assert.deepEqual(readRecord<StoredPmToolCall>("pm-tool-calls", input.operationId)!.request.arguments, input.arguments);
  } finally {
    await bridge.close(); server.closeAllConnections();
    const closed = Promise.withResolvers<void>(); server.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise;
    closeStore();
    if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
    if (previousPm === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = previousPm;
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy invalid queries reconcile without replay while original hash, actor and uncertain writes remain protected", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-tool-legacy-inputs-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR, previousPm = process.env.PM_API_URL, previousSecret = process.env.PM_AUTOMATION_SERVICE_SECRET;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.PM_AUTOMATION_SERVICE_SECRET = "isolated-legacy-query-proof-fixture";
  const workspaceId = randomUUID(), actorId = randomUUID(), generationId = randomUUID();
  const target = { workspaceId, projectId: "PRJ-002" };
  let currentActor = actorId, targetAllowed = true, calls = 0, results = 0, proofs = 0;
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += String(chunk);
    const input = JSON.parse(text) as Record<string, unknown>;
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/agent-contexts/authorize") {
      if (!targetAllowed) { response.writeHead(403).end("{}"); return; }
      response.end(JSON.stringify({ actorId: currentActor, scope: input })); return;
    }
    if (request.url === "/api/v1/internal/agent-tools/reconcile") {
      proofs++; response.writeHead(404).end("{}"); return;
    }
    if (request.url?.endsWith("/call")) calls++;
    else results++;
    response.writeHead(404).end(JSON.stringify({ error: "Original operation is not accessible" }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  const context = { threadId: "legacy-input-validation", messageId: "message", generationId, authorizeExecution: async () => {} };
  initializeNativeOutput(generationId, context.threadId, "running");
  const bridge = await openPmToolBridge(context);
  const seed = (name: string, args: unknown): StoredPmToolCall => {
    const request = { operationId: randomUUID(), name, target, arguments: args, threadId: context.threadId, messageId: context.messageId, generationId };
    const value: StoredPmToolCall = { request, requestHash: pmToolRequestHash(request, actorId), record: {
      operationId: request.operationId, name, target, actorId, workspaceId, threadId: request.threadId, messageId: request.messageId, generationId,
      status: "unknown", result: null, error: { code: "result_unavailable", message: "Legacy missing PM record" },
      certainty: { dispatch: "possibly_sent", evidence: "unresolved" }, createdAt: new Date().toISOString(), finishedAt: null,
    } };
    writeRecord("pm-tool-calls", request.operationId, value);
    return value;
  };
  const send = async (value: StoredPmToolCall, action = "result", args = value.request.arguments) => {
    const response = await fetch(`${bridge.url}/tools/${action}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: value.request.operationId, name: value.request.name, target, arguments: args }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  try {
    for (const entity of ["work_item", "document"]) {
      const legacy = seed("pm_query", { ...queryArguments, entity, limit: 100 });
      targetAllowed = false;
      assert.equal((await send(legacy)).status, 400);
      assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", legacy.record.operationId)!.record.status, "unknown");
      targetAllowed = true; currentActor = randomUUID();
      assert.equal((await send(legacy)).status, 400);
      currentActor = actorId;
      assert.equal((await send(legacy, "result", queryArguments)).status, 400);
      const settled = await send(legacy, entity === "work_item" ? "result" : "call");
      assert.equal(settled.body.status, "failed");
      assert.equal(z.object({ code: z.string() }).parse(settled.body.error).code, "agent_tool_invalid_input");
      assert.deepEqual(settled.body.certainty, { dispatch: "possibly_sent", evidence: "local_rejection" });
      assert.deepEqual((await send(legacy)).body.error, settled.body.error);
      const retained = readRecord<StoredPmToolCall>("pm-tool-calls", legacy.record.operationId)!;
      assert.deepEqual(retained.request, legacy.request);
      assert.equal(retained.requestHash, legacy.requestHash);
    }
    assert.equal(calls, 0); assert.equal(results, 0, "invalid read settlement is entirely local after authorization");
    assert.equal(proofs, 0, "schema rejection needs no service proof or missing PM operation");
    const tampered = seed("pm_query", { ...queryArguments, limit: 100 });
    tampered.requestHash = "0".repeat(64);
    writeRecord("pm-tool-calls", tampered.record.operationId, tampered);
    assert.equal((await send(tampered)).status, 400);
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", tampered.record.operationId)!.record.status, "unknown");
    const uncertainWrite = seed("pm_create_task", { title: "legacy invalid write" });
    const unresolved = await send(uncertainWrite);
    assert.equal(unresolved.body.status, "unknown");
    assert.deepEqual(unresolved.body.certainty, { dispatch: "possibly_sent", evidence: "unresolved" });
    assert.equal(unresolved.body.finishedAt, null);
    assert.equal((await send(uncertainWrite, "call")).body.status, "unknown");
    assert.equal(calls, 0); assert.equal(results, 1, "an absent PM write result is not proof of rejection");
    assert.equal(proofs, 1, "unresolved writes still use the original internal proof path");
  } finally {
    await bridge.close(); server.closeAllConnections();
    const closed = Promise.withResolvers<void>(); server.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise;
    closeStore();
    if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
    if (previousPm === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = previousPm;
    if (previousSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = previousSecret;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const name of ["pm_read_workflow", "pm_task_brief", "pm_search_knowledge"] as const) test(`cached ${name} reads reject stale results without redispatching or rewriting historical success`, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-workflow-cache-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR, previousPm = process.env.PM_API_URL;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  const workspaceId = randomUUID(), actorId = randomUUID(), generationId = randomUUID();
  const target = { workspaceId, projectId: "PRJ-002" };
  let stale = false, calls = 0;
  const sourceVersions = new Map<string, boolean>();
  let pauseAuthorization = false;
  const authorizationReached = Promise.withResolvers<void>(), resumeAuthorization = Promise.withResolvers<void>();
  const workflow = {
    ...target, entity: "work_item", initial: "queued",
    states: [{ id: "queued", label: "Queued", category: "unstarted" }], transitions: [], defaultTargets: null,
    configuration: { schema: "pm/config/v1", revision: "config-one", source: "workspace", workflowRevision: "a".repeat(64) },
  };
  const revision = "a".repeat(64), generatedAt = "2026-11-13T00:00:00.000Z";
  const resultFields = { items: [], sources: [], nextCursor: null, truncated: false };
  const result = name === "pm_read_workflow" ? { kind: "workflow", workflow, ...resultFields }
    : name === "pm_task_brief" ? { kind: "task_brief", ...resultFields, brief: {
      schemaVersion: 1, stage: "analysis", generatedAt,
      task: { ...target, taskId: "TASK-001", revision, title: "Original task", body: "Original requirement",
        bodyOffset: 0, bodyLength: 20, nextBodyOffset: null },
      goals: [], acceptanceCriteria: [], constraints: [], nonGoals: [], relations: [], guidance: [], sources: [],
      gaps: [{ code: "acceptance_not_explicit", message: "Acceptance is not yet explicit." }],
      truncation: { truncated: false, body: false, statements: false, relations: false, message: null },
      dispatchable: false, authorityNotice: "Read-only context, not authorization.",
    } } : { kind: "knowledge", ...resultFields, knowledge: {
      schemaVersion: 1, generatedAt, taskRevision: revision, query: "Original requirement",
      projectIds: [target.projectId], items: [], nextCursor: null, method: "deterministic_lexical",
      authorityNotice: "Candidates require review.",
    } };
  const args = name === "pm_read_workflow" ? { projectId: target.projectId }
    : name === "pm_task_brief" ? { projectId: target.projectId, taskId: "TASK-001", revision, stage: "analysis", bodyOffset: null, bodyLimit: null }
      : { projectId: target.projectId, taskId: "TASK-001", revision, query: "Original requirement", projectIds: null, limit: 10, cursor: null };
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    let text = ""; for await (const chunk of request) text += String(chunk);
    const input = JSON.parse(text) as Record<string, unknown>;
    if (request.url === "/api/v1/agent-contexts/authorize") {
      if (pauseAuthorization) {
        pauseAuthorization = false; authorizationReached.resolve(); await resumeAuthorization.promise;
      }
      response.end(JSON.stringify({ actorId, scope: input })); return;
    }
    if (request.url === "/api/v1/internal/agent-tools/reconcile") { response.writeHead(404).end("{}"); return; }
    if (request.url?.endsWith("/result")) {
      if (sourceVersions.get(String(input.operationId)) !== stale) {
        response.writeHead(409).end(JSON.stringify({ code: "agent_tool_read_stale", message: "Source content changed; perform a new read." }));
        return;
      }
    } else {
      assert.ok(request.url?.endsWith("/call")); calls++;
      sourceVersions.set(String(input.operationId), stale);
    }
    response.end(JSON.stringify({ ...input, actorId, workspaceId, status: "succeeded", error: null,
      result,
      createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  const context = { threadId: "workflow-cache", messageId: "message", generationId, authorizeExecution: async () => {} };
  ensureThread(context.threadId, "Workflow cache regression");
  initializeNativeOutput(generationId, context.threadId, "running");
  const bridge = await openPmToolBridge(context);
  const input = { operationId: randomUUID(), name, target, arguments: args };
  const send = async (endpoint: string, body: unknown = input) => {
    const response = await fetch(`${bridge.url}/tools/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  try {
    assert.equal((await send("call")).body.status, "succeeded");
    assert.equal((await send("call")).body.status, "succeeded");
    assert.equal(calls, 1);
    stale = true;
    for (const endpoint of ["call", "result"]) {
      const rejected = await send(endpoint);
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.result, undefined);
    }
    const recovered = await send("mcp-call", { transportId: "stale-read-recovery", requestId: 1,
      name: "pm_get_operation_result", arguments: { arguments: { operationId: input.operationId } } });
    assert.equal(recovered.status, 400);
    assert.equal(recovered.body.result, undefined);
    assert.equal(calls, 1);
    const historical = readRecord<StoredPmToolCall>("pm-tool-calls", input.operationId)!.record;
    assert.equal(historical.status, "succeeded");
    assert.equal(historical.result?.kind, result.kind);
    const reconciled = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${input.operationId}/reconcile`, { method: "POST" });
    assert.equal(reconciled.status, 200);
    const projection = await reconciled.json() as Record<string, unknown>;
    assert.equal(projection.visibility, "unavailable");
    assert.equal(projection.result, undefined);
    assert.equal((await send("call", { ...input, operationId: randomUUID() })).body.status, "succeeded");
    assert.equal(calls, 2, "only an explicitly new read dispatches again");
    stale = false; pauseAuthorization = true;
    const raceInput = { ...input, operationId: randomUUID() };
    const pending = send("call", raceInput);
    await authorizationReached.promise;
    assert.equal((await send("call", raceInput)).body.status, "succeeded");
    stale = true; resumeAuthorization.resolve();
    const raced = await pending;
    assert.equal(raced.status, 400);
    assert.equal(raced.body.result, undefined);
    assert.equal(calls, 3, "concurrent admission must revalidate, not redispatch, the newly cached read");
  } finally {
    resumeAuthorization.resolve();
    await bridge.close();
    const stopped = Promise.withResolvers<void>(); server.close(() => stopped.resolve()); await stopped.promise;
    closeStore();
    if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
    if (previousPm === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = previousPm;
    await rm(directory, { recursive: true, force: true });
  }
});
