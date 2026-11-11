import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { UIMessage } from "ai";
import { z } from "zod";
import { Hono } from "hono";
import { chatOnlyExecutionSelection, type ExecutionSelection } from "@agent-workspace/contracts/chat";
import type { ProviderDriverContext } from "../providers/driver-adapter.ts";
import { codexAdapter } from "../providers/drivers/codex.ts";
import { createProviderInstance, getStoredInstance, updateProviderInstance } from "../providers/instances.ts";
import { pmRuntimeBinding } from "../providers/t3code/runtime-host.ts";
import { ThreadId } from "@t3tools/contracts";
import { openAgentWorkspace, updateAgentWorkspace } from "../agent-workspaces.ts";
import { chatRoutes } from "../chat.ts";
import { resolveAgentExecution } from "./agent-execution.ts";
import { cancelChat, getChatGeneration, stopChatRuntime, submitChat, type ChatGeneration } from "./chat-runtime.ts";
import { emitNativeOutput, endNativeOutput, initializeNativeOutput } from "./native-output.ts";
import { closeStore, listRecords, writeRecord } from "./store.ts";
import { ensureThread, getThread, getThreadBranch, setThreadNativeSession, setThreadPendingFork, updateThread } from "./threads.ts";

const target = { workspaceId: "00000000-0000-4000-8000-000000000001", projectId: "PRJ-001" };
const actorId = "00000000-0000-4000-8000-000000000002";
const headers = new Headers({ cookie: "authorization-fixture=session", authorization: "Bearer authorization-fixture", "x-not-pm-authorization": "must-not-forward" });
const originalPmUrl = process.env.PM_API_URL;
const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalAllowed = process.env.AGENT_WORKSPACE_ALLOWED_ROOTS;
const originalCheck = codexAdapter.check;
const originalRun = codexAdapter.run;
let directory: string;
let executionPath: string;
let selection: ExecutionSelection;
let pmServer: Server;
let pmStatus: number;
let pmRequests: string[];
let onPmAuthorize: (() => Promise<void> | void) | undefined;
let admitted: PromiseWithResolvers<ProviderDriverContext>;
let release: PromiseWithResolvers<void>;
let cleanup: PromiseWithResolvers<void> | undefined;
let cleanupStarted: PromiseWithResolvers<void>;
let toolDispatches: number;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "chat-authorization-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([directory]);
  executionPath = join(directory, "selected-directory");
  await mkdir(executionPath);
  const workspace = openAgentWorkspace({ path: executionPath });
  selection = { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  pmStatus = 503;
  pmRequests = [];
  onPmAuthorize = undefined;
  admitted = Promise.withResolvers<ProviderDriverContext>();
  release = Promise.withResolvers<void>();
  cleanup = undefined;
  cleanupStarted = Promise.withResolvers<void>();
  toolDispatches = 0;
  pmServer = createServer(async (incoming, outgoing) => {
    pmRequests.push(`${incoming.method} ${incoming.url}`);
    outgoing.setHeader("content-type", "application/json");
    if (pmStatus !== 200) { outgoing.writeHead(pmStatus).end(JSON.stringify({ error: "PM unavailable" })); return; }
    if (incoming.url === "/api/v1/agent-contexts/authorize") {
      let body = "";
      for await (const chunk of incoming) body += String(chunk);
      assert.deepEqual(JSON.parse(body), target);
      assert.equal(incoming.headers.cookie, headers.get("cookie"));
      assert.equal(incoming.headers.authorization, headers.get("authorization"));
      assert.equal(incoming.headers["x-not-pm-authorization"], undefined);
      await onPmAuthorize?.();
      outgoing.end(JSON.stringify({ actorId, scope: target }));
      return;
    }
    if (incoming.url === `/api/v1/workspaces/${target.workspaceId}/agent-tools/call`) {
      let body = "";
      for await (const chunk of incoming) body += String(chunk);
      const input = JSON.parse(body) as Record<string, unknown>;
      toolDispatches++;
      await appendFile(join(directory, "native-pm-effects.log"), `${body}\n`);
      outgoing.end(JSON.stringify({ ...input, actorId, target, workspaceId: target.workspaceId, status: "succeeded",
        result: { kind: "task", items: [], nextCursor: null, truncated: false, sources: [] }, error: null,
        createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
      return;
    }
    outgoing.end(JSON.stringify({ tools: [] }));
  });
  const listening = Promise.withResolvers<void>();
  pmServer.once("error", listening.reject);
  pmServer.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = pmServer.address();
  assert.ok(address && typeof address === "object");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  createProviderInstance({ instanceId: "authorization-provider", driver: "codex", label: "Chat authorization boundary fixture",
    customModels: [{ id: "authorization-model", label: "Authorization fixture model" }] });
  codexAdapter.check = async () => ({
    installation: { status: "installed", checkedAt: new Date().toISOString() }, authentication: "authenticated", nativeSessionReady: true,
    models: [{ id: "authorization-model", label: "Authorization fixture model", source: "discovered", temperature: false }],
    methods: [], canLogout: false,
    capabilities: { nativeResume: false, nativeFork: false, boundedFork: false, modelTransition: "portable", portableHandoff: true },
  });
  // Hold the real Chat lifecycle while native CLI/MCP children exercise its live grant.
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
  const execution = await resolveAgentExecution(selection, "authorization-chat");
  ensureThread("authorization-chat", undefined, selection, execution.environment);
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
  if (originalAllowed === undefined) delete process.env.AGENT_WORKSPACE_ALLOWED_ROOTS; else process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = originalAllowed;
  await rm(directory, { recursive: true, force: true });
});

function api(path: string, method = "GET", body?: object) {
  return new Hono().route("/api", chatRoutes).request(`http://localhost/api${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("updating an unknown Session never implicitly creates chat-only state", async () => {
  const response = await api("/chat/threads/not-created", "PUT", { title: "Must remain absent" });
  assert.equal(response.status, 404);
  assert.equal(getThread("not-created"), null);
  assert.deepEqual(pmRequests, []);
});

async function start(messageId = "authorization-user"): Promise<{ generation: ChatGeneration; context: ProviderDriverContext }> {
  const messages = getThreadBranch("authorization-chat").map(message => ({ ...message.content, id: message.id }) as UIMessage);
  messages.push({ id: messageId, role: "user", parts: [{ type: "text", text: "Exercise the authorization boundary." }] });
  const generation = await submitChat({ id: "authorization-chat", messages }, undefined, headers);
  const context = await admitted.promise;
  assert.equal(context.execution?.generationId, generation.id);
  assert.equal(context.execution?.inputMessageId, generation.inputMessageId);
  assert.equal(context.execution?.traceId, generation.traceId);
  assert.equal(context.execution?.executionGrantId, generation.executionGrantId);
  assert.equal(context.execution?.environment.agentWorkspaceId, selection.agentWorkspaceId);
  assert.equal(context.cwd, executionPath);
  assert.ok(context.authorizeExecution);
  return { generation, context };
}

async function nativeRequest(context: ProviderDriverContext, action: "list" | "call" | "mcp", input?: unknown) {
  assert.ok(context.pmToolBridge);
  const bridge = context.pmToolBridge;
  const child = spawn(bridge.command, [...bridge.args, ...(action === "mcp" ? ["mcp"] : ["tools", action])], { stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "exit");
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdin.end(input === undefined ? "" : `${JSON.stringify(input)}\n`);
  const [code] = await exit;
  return { code, stdout, stderr };
}

function writeInput() {
  return { operationId: crypto.randomUUID(), name: "pm_create_task", target, arguments: { title: "Must not be created" } };
}

async function assertNoNativeEffects(): Promise<void> {
  assert.equal(toolDispatches, 0, "A rejected native call must never reach PM dispatch.");
  assert.deepEqual(listRecords("pm-tool-calls"), [], "Rejected new operations must not become durable calls.");
  await assert.rejects(readFile(join(directory, "native-pm-effects.log")), { code: "ENOENT" });
}

test("Session CRUD, settings, archive, native restart and output access never consult unavailable PM", async () => {
  const chatOnly = await api("/chat/threads", "POST", { id: "chat-only-session", executionSelection: chatOnlyExecutionSelection() });
  assert.equal(chatOnly.status, 200);
  const chatOnlyThread = (await chatOnly.json()).thread;
  assert.equal(chatOnlyThread.executionEnvironment.sourcePath, null);
  assert.equal(chatOnlyThread.executionEnvironment.executionPath, null);
  assert.equal((await api("/chat/threads/chat-only-session", "DELETE")).status, 200);
  const id = "independent-session";
  assert.equal((await api("/chat/threads", "POST", { id, executionSelection: selection })).status, 200);
  assert.equal((await api("/chat/threads")).status, 200);
  assert.equal((await api(`/chat/threads/${id}`)).status, 200);
  const created = getThread(id)!;
  const settings = { ...created.settings, providerInstanceId: "authorization-provider", model: "authorization-model" };
  assert.equal((await api(`/chat/threads/${id}`, "PUT", { settings, revision: created.revision })).status, 200);
  assert.deepEqual(getThread(id)!.settings, settings);
  const originalEnvironment = getThread(id)!.executionEnvironment;
  const source = { providerInstanceId: "authorization-provider", driver: "codex" as const, instanceRevision: getStoredInstance("authorization-provider")!.revision,
    sessionId: "native-session", turnId: "native-turn", modelId: "authorization-model", cwd: executionPath };
  setThreadNativeSession(id, source, "answer", "", originalEnvironment);
  setThreadPendingFork(id, { source, boundary: { turnId: source.turnId } });
  assert.equal((await api(`/chat/threads/${id}/native-session/restart`, "POST", {})).status, 200);
  assert.equal(getThread(id)!.nativeSession, undefined);
  assert.equal(getThread(id)!.pendingFork, undefined);
  assert.equal(getThread(id)!.nativeEnvironment, undefined);
  assert.equal(getThread(id)!.pendingForkEnvironment, undefined);
  assert.deepEqual(getThread(id)!.executionEnvironment, originalEnvironment);
  assert.equal((await api(`/chat/threads/${id}`, "PUT", { status: "archived" })).status, 200);
  assert.equal(getThread(id)!.status, "archived");
  assert.equal((await api(`/chat/threads/${id}`, "PUT", { status: "regular" })).status, 200);
  const generationId = "independent-output";
  writeRecord("chat:generations", generationId, { id: generationId, threadId: id, messageId: "answer", status: "completed", seq: 0,
    createdAt: new Date().toISOString(), request: { id, messages: [] }, providerInstanceId: "authorization-provider" });
  initializeNativeOutput(generationId, id, "running");
  emitNativeOutput(generationId, { type: "item.upsert", item: { id: "command", type: "command_execution", status: "completed", output: "Independent output" } });
  endNativeOutput(generationId, "completed");
  for (const path of [`/chat/threads/${id}/history`, `/chat/threads/${id}/generations`]) assert.equal((await api(path)).status, 200);
  for (const path of [`/chat/generations/${generationId}/output`, `/chat/generations/${generationId}/items/command/output`]) {
    const response = await api(path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Independent output/);
  }
  assert.equal((await api(`/chat/threads/${id}`, "DELETE")).status, 200);
  assert.equal(getThread(id), null);
  assert.equal((await api(`/chat/generations/${generationId}/output`)).status, 404);
  assert.deepEqual(pmRequests, []);
});

test("plain execution and live tool/compaction grants use local directory authority without persisting credentials", async () => {
  const { generation, context } = await start();
  await context.authorizeExecution!("tool");
  await context.authorizeExecution!("compaction");
  assert.deepEqual(pmRequests, []);
  const binding = pmRuntimeBinding(context, ThreadId.make(generation.threadId), generation.id);
  const stored = JSON.stringify([binding, listRecords("chat:generations"), listRecords("chat:threads")]);
  assert.equal(stored.includes("authorization-fixture"), false);
  assert.equal(stored.includes("must-not-forward"), false);
  assert.equal(stored.includes("authorizeExecution"), false);
  assert.deepEqual(context.execution?.environment, getThread("authorization-chat")!.executionEnvironment);
});

test("PM catalog and tool failure cannot revoke an independent running Session", async () => {
  const { generation, context } = await start();
  assert.equal((await nativeRequest(context, "list")).code, 0, "Unavailable business tools do not block native discovery admission.");
  assert.notEqual((await nativeRequest(context, "call", writeInput())).code, 0);
  await context.authorizeExecution!("compaction");
  assert.equal(getChatGeneration(generation.id)?.status, "running");
  assert.equal(context.cwd, executionPath);
  await assertNoNativeEffects();
});

for (const during of [false, true]) {
  for (const replacement of [false, true]) {
    test(`a ${replacement ? "replaced" : "missing"} directory ${during ? "during execution" : "at admission"} fails closed`, async () => {
      const running = during ? await start() : undefined;
      await rename(executionPath, join(directory, "original-directory"));
      if (replacement) await mkdir(executionPath);
      const expected = { code: replacement ? "workspace_directory_changed" : "directory_unavailable" };
      if (running) {
        await assert.rejects(running.context.authorizeExecution!("tool"), expected);
        await assert.rejects(running.context.authorizeExecution!("compaction"), expected);
        assert.equal(getThread("authorization-chat")!.executionEnvironment?.executionPath, executionPath);
      } else {
        await assert.rejects(submitChat({ id: "authorization-chat", messages: [{ id: "unavailable-user", role: "user", parts: [{ type: "text", text: "No fallback directory." }] }] }, undefined, headers), expected);
        assert.deepEqual(listRecords("chat:generations"), []);
      }
      if (!replacement) await assert.rejects(stat(executionPath), { code: "ENOENT" });
      assert.deepEqual(pmRequests, []);
      await assertNoNativeEffects();
    });
  }
}

test("opening, renaming and archiving workspace metadata cannot rebind a frozen running Session", async () => {
  const { generation, context } = await start();
  const accepted = structuredClone(getThread("authorization-chat")!);
  const otherPath = join(directory, "another-directory");
  await mkdir(otherPath);
  const other = openAgentWorkspace({ path: otherPath });
  const otherSelection: ExecutionSelection = { version: 2, agentWorkspaceId: other.id, agentWorkspaceRevision: other.revision };
  const selected = updateAgentWorkspace(selection.agentWorkspaceId!, { expectedRevision: selection.agentWorkspaceRevision!, name: "Renamed" });
  updateAgentWorkspace(selected.id, { expectedRevision: selected.revision, archived: true });
  await context.authorizeExecution!("tool");
  assert.equal(getThread("authorization-chat")!.executionEnvironment?.frozen, true);
  const rebind = () => api("/chat/threads/authorization-chat", "PUT", { executionSelection: otherSelection, revision: accepted.revision });
  assert.equal((await rebind()).status, 409);
  assert.equal((await api("/chat/threads/authorization-chat/native-session/restart", "POST", {})).status, 409);
  assert.equal((await api("/chat/threads/authorization-chat", "PUT", { status: "archived" })).status, 409);
  assert.throws(() => ensureThread("authorization-chat", undefined, otherSelection), { code: "execution_selection_conflict" });
  await cancelChat(generation.id);
  assert.equal((await rebind()).status, 409, "Stopping a run does not unfreeze its accepted execution.");
  const current = getThread("authorization-chat")!;
  assert.deepEqual(current.executionSelection, accepted.executionSelection);
  assert.deepEqual(current.executionEnvironment, accepted.executionEnvironment);
  assert.equal(current.executionPath, accepted.executionPath);
  assert.equal(context.cwd, accepted.executionPath);
  assert.deepEqual(pmRequests, []);
});

for (const during of [false, true]) {
  test(`an incomplete delivery binding ${during ? "during execution" : "at admission"} cannot fall back to the ordinary directory`, async () => {
    const running = during ? await start() : undefined;
    writeRecord("task-code-delivery-v1", "pending-delivery", {
      id: "pending-delivery", threadId: "authorization-chat", ...target, executionSelection: selection,
      taskId: "TASK-001", step: "preparing", pending: { action: "prepare", at: new Date().toISOString() },
    });
    if (running) {
      await assert.rejects(running.context.authorizeExecution!("tool"), { code: "delivery_binding_changed" });
      await assert.rejects(running.context.authorizeExecution!("compaction"), { code: "delivery_binding_changed" });
      assert.equal(running.context.authorizeWorktreeWrite, undefined);
    } else {
      await assert.rejects(submitChat({ id: "authorization-chat", messages: [{ id: "pending-delivery-user", role: "user", parts: [{ type: "text", text: "Do not use the source directory." }] }] }, undefined, headers), { code: "delivery_binding_changed" });
      assert.deepEqual(listRecords("chat:generations"), []);
    }
    assert.deepEqual(pmRequests, []);
    await assertNoNativeEffects();
  });
}

for (const during of [false, true]) {
  for (const mutation of ["provider-revision", "thread-revision", "thread-archive"] as const) {
    test(`${mutation} ${during ? "during" : "before"} a live execution recheck fails closed`, async () => {
      const { context } = await start();
      const mutate = () => {
        if (mutation === "provider-revision") updateProviderInstance("authorization-provider", { label: "Changed revision" });
        else if (mutation === "thread-revision") updateThread("authorization-chat", { settings: { ...getThread("authorization-chat")!.settings } });
        else updateThread("authorization-chat", { status: "archived" });
      };
      const expected = { code: mutation === "provider-revision" ? "session_mismatch" : mutation === "thread-revision" ? "stale_settings" : "thread_archived" };
      if (during) {
        const pending = assert.rejects(context.authorizeExecution!("compaction"), expected);
        mutate();
        await pending;
      } else {
        mutate();
        await assert.rejects(context.authorizeExecution!("compaction"), expected);
      }
      assert.deepEqual(pmRequests, []);
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
  await assert.rejects(first.context.authorizeExecution!("tool"), { code: "stale_execution" });
  await second.context.authorizeExecution!("tool");
  assert.equal(getChatGeneration(second.generation.id)?.status, "running");
  assert.equal(getStoredInstance(second.context.instanceId)?.revision, second.context.revision);
  assert.deepEqual(pmRequests, []);
});

for (const drain of [false, true]) {
  test(`${drain ? "runtime drain" : "cancellation"} invalidates an in-flight local authorization callback`, async () => {
    const { generation, context } = await start();
    const pending = assert.rejects(context.authorizeExecution!("compaction"), { code: "stale_execution" });
    if (drain) await stopChatRuntime(); else await cancelChat(generation.id);
    await pending;
    assert.deepEqual(pmRequests, []);
  });
}

for (const transport of ["call", "mcp"] as const) {
  test(`native ${transport} bridge rejects discovery and a fresh write after directory replacement`, async () => {
    const { context } = await start();
    await rename(executionPath, join(directory, "original-directory"));
    await mkdir(executionPath);
    assert.notEqual((await nativeRequest(context, "list")).code, 0);
    assert.deepEqual(pmRequests, [], "Stale native discovery must not reach PM.");
    const input = writeInput();
    const result = await nativeRequest(context, transport, transport === "mcp"
      ? { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: input.name, arguments: { target: input.target, arguments: input.arguments } } }
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
      assert.equal(getChatGeneration(generation.id)?.status, "running", "Hold the native cleanup boundary open.");
      const input = writeInput();
      const result = await nativeRequest(context, transport, transport === "mcp"
        ? { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: input.name, arguments: { target: input.target, arguments: input.arguments } } }
        : input);
      if (transport === "mcp") z.object({ error: z.object({ message: z.string() }) }).parse(JSON.parse(result.stdout));
      else assert.notEqual(result.code, 0);
      assert.deepEqual(pmRequests, []);
      await assertNoNativeEffects();
    } finally { cleanup.resolve(); await cancellation; }
  });
}

test("native bridge rechecks directory identity after asynchronous request body admission", async () => {
  const { context } = await start();
  assert.ok(context.pmToolBridge);
  const url = context.pmToolBridge.args.find(value => /^http:\/\/127\.0\.0\.1:\d+$/.test(value));
  assert.ok(url);
  const input = JSON.stringify(writeInput());
  const response = Promise.withResolvers<number>();
  const incoming = request(`${url}/tools/call`, { method: "POST", headers: { "content-type": "application/json", expect: "100-continue" } }, res => {
    res.resume(); res.once("end", () => response.resolve(res.statusCode!));
  });
  incoming.once("error", response.reject);
  const continued = once(incoming, "continue");
  incoming.flushHeaders();
  await continued;
  incoming.write(input.slice(0, -1));
  try {
    assert.equal((await nativeRequest(context, "list")).code, 0);
    await rename(executionPath, join(directory, "original-directory"));
    await mkdir(executionPath);
    incoming.end(input.slice(-1));
    assert.equal(await response.promise, 400);
    await assertNoNativeEffects();
  } finally { incoming.destroy(); }
});

test("native bridge rechecks directory identity after asynchronous PM tool authorization", async () => {
  const { context } = await start();
  pmStatus = 200;
  onPmAuthorize = async () => {
    await rename(executionPath, join(directory, "original-directory"));
    await mkdir(executionPath);
  };
  assert.notEqual((await nativeRequest(context, "call", writeInput())).code, 0);
  await assertNoNativeEffects();
});
