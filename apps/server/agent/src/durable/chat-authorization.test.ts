import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { UIMessage } from "ai";
import type { AgentScope } from "@agent-workspace/contracts/chat";
import type { ProviderDriverContext } from "../providers/driver-adapter.ts";
import { codexAdapter } from "../providers/drivers/codex.ts";
import { createProviderInstance, getStoredInstance, updateProviderInstance } from "../providers/instances.ts";
import { pmRuntimeBinding } from "../providers/t3code/runtime-host.ts";
import { ThreadId } from "@t3tools/contracts";
import { cancelChat, getChatGeneration, stopChatRuntime, submitChat, type ChatGeneration } from "./chat-runtime.ts";
import { closeStore, listRecords } from "./store.ts";
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

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "chat-authorization-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  resolvedPath = directory;
  pmStatus = 200;
  onResolve = undefined;
  resolutions = [];
  admitted = Promise.withResolvers<ProviderDriverContext>();
  release = Promise.withResolvers<void>();
  pmServer = createServer(async (incoming, outgoing) => {
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
  // This seam only holds the Chat generation open. The permission callback under test is the real PM HTTP recheck.
  codexAdapter.run = async (context, options) => {
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(Object.assign(new Error("Authorization fixture cancelled"), { code: "aborted" }));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (options.signal?.aborted) onAbort();
      admitted.resolve(context);
      await Promise.race([release.promise, aborted.promise]);
      return { text: "Authorization fixture completed" };
    } finally { options.signal?.removeEventListener("abort", onAbort); }
  };
  ensureThread("authorization-chat", undefined, scope);
  updateThread("authorization-chat", { settings: { providerInstanceId: "authorization-provider", model: "authorization-model", systemPrompt: "Original instructions", temperature: 1 } });
});

afterEach(async () => {
  release.resolve();
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

test("live authorization rechecks initiating PM headers without persisting or transporting the callback or credentials", async () => {
  const { generation, context } = await start();
  await context.authorizeExecution!("tool");
  await context.authorizeExecution!("compaction");
  assert.equal(resolutions.length, 3);
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
