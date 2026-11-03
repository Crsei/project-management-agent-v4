import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { UIMessage } from "ai";
import { z } from "zod";
import type { AgentScope } from "@agent-workspace/contracts/chat";
import type { ProviderDriverContext } from "../providers/driver-adapter.ts";
import { codexAdapter } from "../providers/drivers/codex.ts";
import { createProviderInstance, getStoredInstance, updateProviderInstance } from "../providers/instances.ts";
import { pmRuntimeBinding } from "../providers/t3code/runtime-host.ts";
import { ThreadId } from "@t3tools/contracts";
import { cancelChat, getChatGeneration, stopChatRuntime, submitChat, type ChatGeneration } from "./chat-runtime.ts";
import { closeStore, listRecords, writeRecord } from "./store.ts";
import { ensureThread, getThread, getThreadBranch, updateThread } from "./threads.ts";

const scope: AgentScope = { workspaceId: "00000000-0000-4000-8000-000000000001", projectId: null };
const headers = new Headers({ cookie: "authorization-fixture=session", authorization: "Bearer authorization-fixture", "x-not-pm-authorization": "must-not-forward" });
const originalPmUrl = process.env.PM_API_URL;
const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalCheck = codexAdapter.check;
const originalRun = codexAdapter.run;
let directory: string;
let pmServer: Server;
let pmStatus: number;
let resolvedPath: string;
let onResolve: (() => Promise<void> | void) | undefined;
let resolutions: { cookie: string | undefined; authorization: string | undefined; unexpected: string | undefined }[];
let admitted: PromiseWithResolvers<ProviderDriverContext>;
let release: PromiseWithResolvers<void>;
let cleanup: PromiseWithResolvers<void> | undefined;
let cleanupStarted: PromiseWithResolvers<void>;
let toolDiscoveries: number;
let toolDispatches: number;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "chat-authorization-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  resolvedPath = directory;
  pmStatus = 200;
  onResolve = undefined;
  resolutions = [];
  admitted = Promise.withResolvers<ProviderDriverContext>();
  release = Promise.withResolvers<void>();
  cleanup = undefined;
  cleanupStarted = Promise.withResolvers<void>();
  toolDiscoveries = 0;
  toolDispatches = 0;
  pmServer = createServer(async (incoming, outgoing) => {
    if (incoming.url?.startsWith(`/api/v1/workspaces/${scope.workspaceId}/agent-tools`)) {
      outgoing.setHeader("content-type", "application/json");
      if (incoming.method === "GET") {
        toolDiscoveries++;
        outgoing.end(JSON.stringify({ tools: [] }));
        return;
      }
      let body = "";
      for await (const chunk of incoming) body += String(chunk);
      const input = z.object({ operationId: z.uuid(), name: z.string(), arguments: z.unknown(),
        threadId: z.string(), messageId: z.string(), generationId: z.string() }).parse(JSON.parse(body));
      assert.ok(incoming.url.endsWith("/call"));
      toolDispatches++;
      await appendFile(join(directory, "native-pm-effects.log"), `${JSON.stringify(input)}\n`);
      outgoing.end(JSON.stringify({ ...input, status: "succeeded", result: { kind: "task", items: [], nextCursor: null, truncated: false, sources: [] },
        error: null, workspaceId: scope.workspaceId, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
      return;
    }
    if (incoming.method === "GET" && incoming.url === "/api/v1/agent-contexts") {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ workspaces: [{ id: scope.workspaceId, projects: [] }] }));
      return;
    }
    assert.equal(incoming.method, "POST");
    assert.equal(incoming.url, "/api/v1/agent-contexts/resolve");
    let body = "";
    for await (const chunk of incoming) body += String(chunk);
    assert.deepEqual(JSON.parse(body), scope);
    resolutions.push({ cookie: incoming.headers.cookie, authorization: incoming.headers.authorization,
      unexpected: incoming.headers["x-not-pm-authorization"] as string | undefined });
    await onResolve?.();
    outgoing.writeHead(pmStatus, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ scope, workspaceName: "Authorization fixture", projectName: null, path: resolvedPath }));
  });
  const listening = Promise.withResolvers<void>();
  pmServer.once("error", listening.reject);
  pmServer.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = pmServer.address();
  assert.ok(address && typeof address === "object");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  createProviderInstance({ instanceId: "authorization-provider", driver: "codex", label: "Chat authorization boundary fixture" });
  codexAdapter.check = async () => ({
    installation: { status: "installed", checkedAt: new Date().toISOString() }, authentication: "authenticated",
    nativeSessionReady: true,
    models: [{ id: "authorization-model", label: "Authorization fixture model", source: "discovered", temperature: false }],
    methods: [], canLogout: false,
    capabilities: { nativeResume: false, nativeFork: false, boundedFork: false, modelTransition: "portable", portableHandoff: true },
  });
  // This seam holds the Chat lifecycle; native CLI/MCP children exercise the real bridge and PM HTTP authorization.
  codexAdapter.run = async (context, options) => {
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(Object.assign(new Error("Authorization fixture cancelled"), { code: "aborted" }));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (options.signal?.aborted) onAbort();
      admitted.resolve(context);
      await Promise.race([release.promise, aborted.promise]);
      return { text: "Authorization fixture completed" };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      cleanupStarted.resolve();
      await cleanup?.promise;
    }
  };
  ensureThread("authorization-chat", undefined, scope);
  updateThread("authorization-chat", { settings: { providerInstanceId: "authorization-provider", model: "authorization-model", systemPrompt: "Original instructions", temperature: 1 } });
});

afterEach(async () => {
  release.resolve();
  cleanup?.resolve();
  await stopChatRuntime();
  codexAdapter.check = originalCheck;
  codexAdapter.run = originalRun;
  closeStore();
  pmServer.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  pmServer.close(error => error ? closed.reject(error) : closed.resolve());
  await closed.promise;
  if (originalPmUrl === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = originalPmUrl;
  if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
  await rm(directory, { recursive: true, force: true });
});

async function start(messageId = "authorization-user"): Promise<{ generation: ChatGeneration; context: ProviderDriverContext }> {
  const messages = getThreadBranch("authorization-chat").map(message => ({ ...message.content, id: message.id }) as UIMessage);
  messages.push({ id: messageId, role: "user", parts: [{ type: "text", text: "Exercise the authorization boundary." }] });
  const generation = await submitChat({ id: "authorization-chat", messages }, undefined, headers);
  const context = await admitted.promise;
  assert.equal(context.execution?.generationId, generation.id);
  assert.ok(context.authorizeExecution);
  return { generation, context };
}

async function nativeRequest(context: ProviderDriverContext, action: "list" | "call" | "mcp", input?: unknown) {
  assert.ok(context.pmToolBridge);
  const bridge = context.pmToolBridge;
  const child = spawn(bridge.command, [...bridge.args, ...(action === "mcp" ? ["mcp"] : ["tools", action])], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdin.end(input === undefined ? "" : `${JSON.stringify(input)}\n`);
  const [code] = await exit;
  return { code, stdout, stderr };
}

async function assertNoNativeEffects(): Promise<void> {
  assert.equal(toolDispatches, 0, "A rejected native call must never reach PM dispatch.");
  assert.deepEqual(listRecords("pm-tool-calls"), [], "Rejected new operations must not become durable calls.");
  await assert.rejects(readFile(join(directory, "native-pm-effects.log")), { code: "ENOENT" });
}

test("live authorization rechecks initiating PM headers without persisting or transporting the callback or credentials", async () => {
  const { generation, context } = await start();
  const beforeTool = resolutions.length;
  await context.authorizeExecution!("tool");
  assert.ok(resolutions.length > beforeTool, "Tool authorization must recheck current PM access.");
  const beforeCompaction = resolutions.length;
  await context.authorizeExecution!("compaction");
  assert.ok(resolutions.length > beforeCompaction, "Compaction authorization must recheck current PM access.");
  for (const resolution of resolutions)
    assert.deepEqual(resolution, { cookie: headers.get("cookie"), authorization: headers.get("authorization"), unexpected: undefined });
  const binding = pmRuntimeBinding(context, ThreadId.make(generation.threadId), generation.id);
  const stored = JSON.stringify([binding, listRecords("chat:generations"), listRecords("chat:threads")]);
  assert.equal(stored.includes("authorization-fixture"), false);
  assert.equal(stored.includes("authorizeExecution"), false);
});

test("revoked PM access and a changed resolved directory reject a live native callback", async () => {
  const { context } = await start();
  pmStatus = 403;
  await assert.rejects(context.authorizeExecution!("tool"), { status: 403, code: "scope_unavailable" });
  pmStatus = 200;
  resolvedPath = join(directory, "replacement");
  await assert.rejects(context.authorizeExecution!("compaction"), { status: 409, code: "scope_conflict" });
});

for (const during of [false, true]) {
  test(`an incomplete delivery binding ${during ? "during execution" : "at admission"} cannot fall back to the PM root`, async () => {
    const running = during ? await start() : undefined;
    // A server-owned delivery that has not acquired its worktree is not an ordinary Chat.
    writeRecord("task-code-delivery-v1", "pending-delivery", {
      id: "pending-delivery", threadId: "authorization-chat", workspaceId: scope.workspaceId,
      projectId: "PRJ-001", taskId: "TASK-001", step: "preparing",
      pending: { action: "prepare", at: new Date().toISOString() },
    });
    if (running) {
      await assert.rejects(running.context.authorizeExecution!("tool"), { code: "delivery_binding_changed" });
      await assert.rejects(running.context.authorizeExecution!("compaction"), { code: "delivery_binding_changed" });
      assert.equal(running.context.authorizeWorktreeWrite, undefined);
    } else {
      await assert.rejects(submitChat({
        id: "authorization-chat",
        messages: [{ id: "pending-delivery-user", role: "user", parts: [{ type: "text", text: "Do not use the project root." }] }],
      }, undefined, headers), { code: "delivery_binding_changed" });
      assert.deepEqual(listRecords("chat:generations"), []);
    }
    await assertNoNativeEffects();
  });
}

for (const during of [false, true]) {
  for (const mutation of ["provider-revision", "thread-revision", "thread-archive", "pm-context"] as const) {
    test(`${mutation} ${during ? "during" : "before"} an asynchronous PM recheck fails closed`, async () => {
      const { context } = await start();
      const mutate = () => {
        if (mutation === "provider-revision") updateProviderInstance("authorization-provider", { label: "Changed revision" });
        else if (mutation === "thread-revision") updateThread("authorization-chat", { settings: { ...getThread("authorization-chat")!.settings } });
        else if (mutation === "pm-context") updateThread("authorization-chat", { pmContext: { taskId: "TASK-001", entityId: null } });
        else updateThread("authorization-chat", { status: "archived" });
      };
      if (during) onResolve = mutate; else mutate();
      const before = resolutions.length;
      await assert.rejects(context.authorizeExecution!("compaction"), {
        code: mutation === "provider-revision" ? "session_mismatch" : mutation === "thread-revision" ? "stale_settings"
          : mutation === "pm-context" ? "pm_context_conflict" : "thread_archived",
      });
      assert.equal(resolutions.length, before + (during ? 1 : 0));
    });
  }
}

test("a cancelled generation cannot authorize a later generation sharing its thread and provider", async () => {
  const first = await start();
  await cancelChat(first.generation.id);
  admitted = Promise.withResolvers<ProviderDriverContext>();
  const second = await start("next-authorization-user");
  assert.notEqual(second.generation.id, first.generation.id);
  assert.equal(second.context.instanceId, first.context.instanceId);
  const before = resolutions.length;
  await assert.rejects(first.context.authorizeExecution!("tool"), { code: "stale_execution" });
  assert.equal(resolutions.length, before, "An old generation must not borrow the new generation's PM access.");
  await second.context.authorizeExecution!("tool");
  assert.equal(getChatGeneration(second.generation.id)?.status, "running");
  assert.equal(getStoredInstance(second.context.instanceId)?.revision, second.context.revision);
});

test("cancellation while a PM recheck is pending rejects after the asynchronous callback", async () => {
  const { generation, context } = await start();
  const reachedPm = Promise.withResolvers<void>();
  const respond = Promise.withResolvers<void>();
  onResolve = async () => { reachedPm.resolve(); await respond.promise; };
  const pending = assert.rejects(context.authorizeExecution!("tool"), { code: "stale_execution" });
  try {
    await reachedPm.promise;
    await cancelChat(generation.id);
  } finally { respond.resolve(); }
  await pending;
});

test("runtime drain invalidates a callback even while its PM authorization request is pending", async () => {
  const { context } = await start();
  const reachedPm = Promise.withResolvers<void>();
  const respond = Promise.withResolvers<void>();
  onResolve = async () => { reachedPm.resolve(); await respond.promise; };
  const pending = assert.rejects(context.authorizeExecution!("compaction"), { code: "stale_execution" });
  try {
    await reachedPm.promise;
    await stopChatRuntime();
  } finally { respond.resolve(); }
  await pending;
});

for (const transport of ["call", "mcp"] as const) {
  test(`native ${transport} bridge rejects discovery and a new write after file-area cwd changes`, async () => {
    const { context } = await start();
    resolvedPath = join(directory, "replacement");
    const listed = await nativeRequest(context, "list");
    assert.notEqual(listed.code, 0);
    assert.equal(toolDiscoveries, 0, "Stale native discovery must not reach PM.");
    const input = { operationId: crypto.randomUUID(), name: "pm_create_task", arguments: { projectId: "PRJ-1", title: "Must not be created" } };
    const result = await nativeRequest(context, transport, transport === "mcp"
      ? { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: input.name, arguments: input.arguments } }
      : input);
    if (transport === "mcp") z.object({ error: z.object({ message: z.string() }) }).parse(JSON.parse(result.stdout));
    else assert.notEqual(result.code, 0);
    await assertNoNativeEffects();
  });

  test(`native ${transport} bridge rejects fresh dispatch while cancellation cleanup remains pending`, async () => {
    cleanup = Promise.withResolvers<void>();
    const { generation, context } = await start();
    const cancellation = cancelChat(generation.id);
    await cleanupStarted.promise;
    try {
      assert.equal(getChatGeneration(generation.id)?.status, "running", "The test must hold the native cleanup boundary open.");
      const input = { operationId: crypto.randomUUID(), name: "pm_create_task", arguments: { projectId: "PRJ-1", title: "Must not be created" } };
      const result = await nativeRequest(context, transport, transport === "mcp"
        ? { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: input.name, arguments: input.arguments } }
        : input);
      if (transport === "mcp") z.object({ error: z.object({ message: z.string() }) }).parse(JSON.parse(result.stdout));
      else assert.notEqual(result.code, 0);
      await assertNoNativeEffects();
    } finally { cleanup.resolve(); await cancellation; }
  });
}

test("native bridge rechecks authorization after asynchronous request body admission", async () => {
  const { context } = await start();
  assert.ok(context.pmToolBridge);
  const url = context.pmToolBridge.args.find(value => /^http:\/\/127\.0\.0\.1:\d+$/.test(value));
  assert.ok(url);
  const input = JSON.stringify({ operationId: crypto.randomUUID(), name: "pm_create_task", arguments: { projectId: "PRJ-1", title: "Must not be created" } });
  const response = Promise.withResolvers<number>();
  const incoming = request(`${url}/tools/call`, {
    method: "POST", headers: { "content-type": "application/json", expect: "100-continue" },
  }, res => { res.resume(); res.once("end", () => response.resolve(res.statusCode!)); });
  incoming.once("error", response.reject);
  const continued = once(incoming, "continue");
  incoming.flushHeaders();
  await continued;
  incoming.write(input.slice(0, -1));
  try {
    // Completing another native request leaves this one waiting for the final body chunk.
    assert.equal((await nativeRequest(context, "list")).code, 0);
    resolvedPath = join(directory, "replacement");
    incoming.end(input.slice(-1));
    assert.equal(await response.promise, 400);
    await assertNoNativeEffects();
  } finally { incoming.destroy(); }
});

test("native bridge rechecks cwd after asynchronous PM authorization", async () => {
  const { context } = await start();
  onResolve = () => { resolvedPath = join(directory, "replacement"); };
  const result = await nativeRequest(context, "call", {
    operationId: crypto.randomUUID(), name: "pm_create_task",
    arguments: { projectId: "PRJ-1", title: "Must not be created" },
  });
  assert.notEqual(result.code, 0);
  await assertNoNativeEffects();
});
