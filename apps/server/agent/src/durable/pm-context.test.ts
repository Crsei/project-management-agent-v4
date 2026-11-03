import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { AgentScope, RemoteThread } from "@agent-workspace/contracts/chat";
import type { PmReferenceResolution } from "@agent-workspace/contracts/pm-references";
import type { NativeSessionRef, ProviderCapabilities } from "@agent-workspace/contracts/provider";
import { chatRoutes } from "../chat.ts";
import {
  cancelChat,
  getChatGeneration,
  listChatGenerations,
  stopChatRuntime,
  submitChat,
  type ChatGeneration,
} from "./chat-runtime.ts";
import {
  pmContextPromptLine,
  resolvePmContextBinding,
  resolvePmReferences,
} from "./pm-context.ts";
import { closeStore, writeRecord } from "./store.ts";
import {
  ensureThread,
  getThread,
  ThreadConflictError,
  updateThread,
} from "./threads.ts";
import { createProviderInstance } from "../providers/instances.ts";
import { codexAdapter } from "../providers/drivers/codex.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const scope: AgentScope = { workspaceId, projectId: "PRJ-001" };
const headers = { "content-type": "application/json", cookie: "pm_v4_session=fixture", authorization: "Bearer fixture" };
const originalDataDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalPmUrl = process.env.PM_API_URL;
const originalCodexCheck = codexAdapter.check;
const originalCodexRun = codexAdapter.run;
const app = new Hono().route("/api", chatRoutes);
let directory: string;
let pm: Server;
let referenceStatus: number;
let availability: Map<string, PmReferenceResolution["availability"]>;
let referenceCalls: { url: string; cookie?: string; authorization?: string; body: { references: { kind: string; id: string; projectId: string | null; revision: string | null }[] } }[];

function resolvedReference(input: { kind: string; id: string; projectId: string | null }): PmReferenceResolution {
  return {
    kind: input.kind as PmReferenceResolution["kind"],
    id: input.id,
    projectId: input.projectId,
    title: `Issue ${input.id}`,
    revision: `rev-${input.id}`,
    availability: availability.get(input.id) ?? "available",
    reason: availability.has(input.id) ? "The reference is unavailable or not accessible." : null,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-pm-context-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  referenceStatus = 200;
  availability = new Map();
  referenceCalls = [];
  const area = { path: null, status: "unconfigured" as const, revision: 1, source: null, canManage: false };
  pm = createServer(async (incoming, outgoing) => {
    const send = (status: number, body: unknown) => {
      outgoing.writeHead(status, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(body));
    };
    if (incoming.method === "GET" && incoming.url === "/api/v1/agent-contexts") {
      send(200, { workspaces: [{ id: workspaceId, name: "Fixture", fileArea: area, projects: [{ id: "PRJ-001", name: "Project", fileArea: area }] }] });
      return;
    }
    if (incoming.method === "POST" && incoming.url === "/api/v1/agent-contexts/resolve") {
      let raw = "";
      for await (const chunk of incoming) raw += String(chunk);
      const parsed = JSON.parse(raw) as AgentScope;
      send(200, { scope: parsed, workspaceName: "Fixture", projectName: parsed.projectId, path: directory });
      return;
    }
    const match = /^\/api\/v1\/workspaces\/([^/]+)\/agent-references\/resolve$/.exec(incoming.url ?? "");
    if (incoming.method === "POST" && match) {
      let raw = "";
      for await (const chunk of incoming) raw += String(chunk);
      const body = JSON.parse(raw) as (typeof referenceCalls)[number]["body"];
      if (body.references.length > 50) {
        send(400, { error: "too_many" });
        return;
      }
      referenceCalls.push({ url: incoming.url!, cookie: incoming.headers.cookie, authorization: incoming.headers.authorization, body });
      if (referenceStatus !== 200) {
        send(referenceStatus, { error: "fixture" });
        return;
      }
      send(200, { items: body.references.map(resolvedReference) });
      return;
    }
    send(404, { error: "not_found" });
  });
  const listening = Promise.withResolvers<void>();
  pm.once("error", listening.reject);
  pm.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = pm.address();
  assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await stopChatRuntime();
  codexAdapter.check = originalCodexCheck;
  codexAdapter.run = originalCodexRun;
  closeStore();
  pm.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  pm.close((error) => (error ? closed.reject(error) : closed.resolve()));
  await closed.promise;
  await rm(directory, { recursive: true, force: true });
  if (originalDataDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
  else process.env.AGENT_WORKSPACE_DATA_DIR = originalDataDirectory;
  if (originalPmUrl === undefined) delete process.env.PM_API_URL;
  else process.env.PM_API_URL = originalPmUrl;
});

function putThread(id: string, body: unknown) {
  return app.request(`http://localhost/api/chat/threads/${id}`, { method: "PUT", headers, body: JSON.stringify(body) });
}
function createThread(id: string, body: Record<string, unknown>) {
  return app.request("http://localhost/api/chat/threads", { method: "POST", headers, body: JSON.stringify({ id, scope, ...body }) });
}
function seedQueuedGeneration(threadId: string) {
  const generation: ChatGeneration = {
    id: `${threadId}-generation`, threadId, messageId: `${threadId}-assistant`, parentId: null, status: "queued",
    createdAt: new Date().toISOString(), seq: 0,
    request: { id: threadId, messages: [{ id: `${threadId}-message`, role: "user", parts: [{ type: "text", text: "hi" }] }] },
    providerInstanceId: "fixture", providerInstanceRevision: 1, modelId: "fixture-model", temperature: 1,
  };
  writeRecord("chat:generations", generation.id, generation);
}

test("creating a thread validates and persists PM context, and list/read expose only IDs", async () => {
  const created = await createThread("issue-thread", { pmContext: { taskId: "TASK-1" } });
  assert.equal(created.status, 200);
  const { thread } = await created.json() as { thread: RemoteThread };
  assert.deepEqual(thread.pmContext, { taskId: "TASK-1", entityId: null });
  assert.equal(referenceCalls.length, 1);
  assert.equal(referenceCalls[0]!.url, `/api/v1/workspaces/${workspaceId}/agent-references/resolve`);
  assert.equal(referenceCalls[0]!.cookie, "pm_v4_session=fixture");
  assert.equal(referenceCalls[0]!.authorization, "Bearer fixture");
  assert.deepEqual(referenceCalls[0]!.body, {
    references: [{ kind: "issue", id: "TASK-1", projectId: "PRJ-001", revision: null }],
  });

  const listed = await (await app.request("http://localhost/api/chat/threads")).json() as { threads: RemoteThread[] };
  assert.deepEqual(listed.threads.find((entry) => entry.remoteId === "issue-thread")!.pmContext, { taskId: "TASK-1", entityId: null });
  const read = await (await app.request("http://localhost/api/chat/threads/issue-thread")).json() as { thread: RemoteThread };
  assert.deepEqual(read.thread.pmContext, { taskId: "TASK-1", entityId: null });
  const serialized = JSON.stringify({ listed, read });
  assert.doesNotMatch(serialized, /pm_v4_session|Bearer fixture|authorization|cookie|agent-references|127\.0\.0\.1/);
});

test("ensureThread never silently rebinds; update can set and clear a binding", async () => {
  ensureThread("bound", undefined, scope, { taskId: "TASK-1", entityId: null });
  assert.throws(
    () => ensureThread("bound", undefined, scope, { taskId: "TASK-2", entityId: null }),
    (error: unknown) => error instanceof ThreadConflictError && error.code === "pm_context_conflict",
  );
  ensureThread("bound");
  assert.deepEqual(getThread("bound")!.pmContext, { taskId: "TASK-1", entityId: null });

  const beforeSet = referenceCalls.length;
  const set = await putThread("bound", { pmContext: { taskId: "TASK-2", entityId: "TASK-2" } });
  assert.equal(set.status, 200);
  assert.deepEqual(getThread("bound")!.pmContext, { taskId: "TASK-2", entityId: "TASK-2" });
  // Rechecks may validate the old binding again; the new binding must still
  // resolve the shared task/entity ID without duplicating it in a request.
  const newBindingCalls = referenceCalls.slice(beforeSet)
    .filter((call) => call.body.references.some((item) => item.id === "TASK-2"));
  assert.ok(newBindingCalls.length > 0, "The replacement binding must be authorized through PM.");
  for (const call of newBindingCalls)
    assert.deepEqual(call.body.references.map((item) => item.id), ["TASK-2"]);

  const calls = referenceCalls.length;
  const cleared = await putThread("bound", { pmContext: null });
  assert.equal(cleared.status, 200);
  assert.equal(getThread("bound")!.pmContext, undefined);
  assert.equal(referenceCalls.length, calls);
});

test("invalid or inaccessible PM context is rejected and never persisted", async () => {
  availability.set("TASK-FORBIDDEN", "forbidden");
  const forbidden = await createThread("forbidden-thread", { pmContext: { taskId: "TASK-FORBIDDEN" } });
  assert.equal(forbidden.status, 403);
  assert.equal(getThread("forbidden-thread"), null);

  availability.set("TASK-DELETED", "deleted");
  const deleted = await createThread("deleted-thread", { pmContext: { taskId: "TASK-DELETED" } });
  assert.equal(deleted.status, 412);
  assert.equal(getThread("deleted-thread"), null);

  referenceStatus = 500;
  const unavailable = await createThread("unavailable-thread", { pmContext: { taskId: "TASK-1" } });
  assert.equal(unavailable.status, 503);
  assert.equal(getThread("unavailable-thread"), null);
  referenceStatus = 200;

  const badShape = await app.request("http://localhost/api/chat/threads", {
    method: "POST", headers, body: JSON.stringify({ id: "bad-shape", scope, pmContext: { taskId: "  " } }),
  });
  assert.equal(badShape.status, 400);

  const noScope = await app.request("http://localhost/api/chat/threads", {
    method: "POST", headers, body: JSON.stringify({ id: "no-scope", pmContext: { taskId: "TASK-1" } }),
  });
  assert.equal(noScope.status, 412);
  assert.equal(getThread("no-scope"), null);

  const legacy = await app.request("http://localhost/api/chat/threads", {
    method: "POST", headers, body: JSON.stringify({ id: "legacy-plain" }),
  });
  assert.equal(legacy.status, 200);
  assert.equal(getThread("legacy-plain")!.pmContext, undefined);
});

test("a running generation blocks PM context changes", async () => {
  ensureThread("busy", undefined, scope, { taskId: "TASK-1", entityId: null });
  seedQueuedGeneration("busy");
  const response = await putThread("busy", { pmContext: { taskId: "TASK-2" } });
  assert.equal(response.status, 409);
  assert.deepEqual(getThread("busy")!.pmContext, { taskId: "TASK-1", entityId: null });
});

test("a bound task that is no longer accessible rejects scope-sensitive changes", async () => {
  ensureThread("scope-check", undefined, scope, { taskId: "TASK-1", entityId: null });
  availability.set("TASK-1", "forbidden");
  const archived = await putThread("scope-check", { status: "archived" });
  assert.equal(archived.status, 403);
  assert.equal(getThread("scope-check")!.status, "regular");
  const removed = await app.request("http://localhost/api/chat/threads/scope-check", { method: "DELETE" });
  assert.equal(removed.status, 403);
  assert.ok(getThread("scope-check"));
});

test("threads without PM context keep listing and reading normally without a PM reference call", async () => {
  ensureThread("legacy", "旧历史");
  const read = await app.request("http://localhost/api/chat/threads/legacy");
  assert.equal(read.status, 200);
  const { thread } = await read.json() as { thread: Record<string, unknown> };
  assert.equal("pmContext" in thread, false);
  assert.equal(referenceCalls.length, 0);
});

test("reference resolution failure rejects the submit before a generation is accepted", async () => {
  ensureThread("submit-failure", undefined, scope);
  updateThread("submit-failure", { settings: { providerInstanceId: "fixture", model: "fixture-model", systemPrompt: "", temperature: 1 } });
  availability.set("TASK-9", "forbidden");
  const forbidden = await app.request("http://localhost/api/chat", {
    method: "POST", headers,
    body: JSON.stringify({
      id: "submit-failure",
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "read TASK-9" }] }],
      pmReferences: [{ kind: "issue", id: "TASK-9", projectId: "PRJ-001", revision: null }],
    }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(listChatGenerations("submit-failure").length, 0);

  referenceStatus = 500;
  const unavailable = await app.request("http://localhost/api/chat", {
    method: "POST", headers,
    body: JSON.stringify({
      id: "submit-failure",
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "read TASK-1" }] }],
      pmReferences: [{ kind: "issue", id: "TASK-1", projectId: "PRJ-001", revision: null }],
    }),
  });
  assert.equal(unavailable.status, 503);
  assert.equal(listChatGenerations("submit-failure").length, 0);

  referenceStatus = 200;
  const duplicated = await app.request("http://localhost/api/chat", {
    method: "POST", headers,
    body: JSON.stringify({
      id: "submit-failure",
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "many" }] }],
      pmReferences: Array.from({ length: 51 }, (_, index) => ({ kind: "issue", id: `TASK-${index + 1}`, projectId: null, revision: null })),
    }),
  });
  assert.equal(duplicated.status, 400);
});

test("a successful submit stores resolved IDs, titles and revisions on the generation", async () => {
  const instance = createProviderInstance({ instanceId: "pm-ref-provider", driver: "codex", label: "PM reference fixture" });
  const capabilities: ProviderCapabilities = {
    nativeResume: true, nativeFork: false, boundedFork: false, modelTransition: "native", portableHandoff: true,
  };
  codexAdapter.check = async (_context) => ({
    installation: { status: "installed", checkedAt: new Date().toISOString() },
    authentication: "authenticated",
    nativeSessionReady: true,
    models: [{ id: "pm-ref-model", label: "Fixture", source: "discovered", temperature: false }],
    methods: [],
    canLogout: false,
    capabilities,
  });
  codexAdapter.run = async (context, options) => {
    const nativeSession: NativeSessionRef = {
      providerInstanceId: context.instanceId, driver: "codex", sessionId: "session-pm-ref", turnId: "turn-pm-ref",
      cwd: context.cwd, modelId: options.model, instanceRevision: context.revision,
    };
    options.onSession?.(nativeSession);
    options.onText?.("已读取引用。");
    return { text: "已读取引用。", nativeSession, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  ensureThread("submit-ok", undefined, scope);
  updateThread("submit-ok", { settings: { providerInstanceId: instance.instanceId, model: "pm-ref-model", systemPrompt: "", temperature: 1 } });

  const generation = await submitChat({
    id: "submit-ok",
    messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "总结 TASK-1" }] }],
    pmReferences: [{ kind: "issue", id: "TASK-1", projectId: "PRJ-001", revision: null }],
  }, undefined, new Headers(headers));

  assert.deepEqual(generation.pmReferences, [{
    kind: "issue", id: "TASK-1", projectId: "PRJ-001", title: "Issue TASK-1", revision: "rev-TASK-1",
    availability: "available", reason: null,
  }]);
  assert.deepEqual(getChatGeneration(generation.id)!.pmReferences, generation.pmReferences);
  assert.equal(referenceCalls.at(-1)!.body.references.length, 1);
  await cancelChat(generation.id);
});

test("the PM context prompt line stays short and never includes bodies or credentials", async () => {
  const resolution = await resolvePmReferences(workspaceId, [
    { kind: "issue", id: "TASK-1", projectId: "PRJ-001", revision: null },
  ], new Headers(headers));
  const line = pmContextPromptLine({ taskId: "TASK-1", entityId: null }, resolution)!;
  assert.match(line, /TASK-1/);
  assert.match(line, /rev-TASK-1/);
  assert.doesNotMatch(line, /pm_v4_session|Bearer|cookie|http:\/\//);
  assert.equal(pmContextPromptLine(undefined, []), undefined);
  assert.deepEqual(
    await resolvePmContextBinding(null, scope, new Headers()),
    undefined,
  );
});
