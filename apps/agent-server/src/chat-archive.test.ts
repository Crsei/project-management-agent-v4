import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { AgentCatalog } from "../../../packages/contracts/src/agent-file-areas.ts";
import { chatRoutes } from "./chat.ts";
import { getChatGeneration, type ChatGeneration } from "./durable/chat-runtime.ts";
import { closeStore, writeRecord } from "./durable/store.ts";
import { ensureThread, getThread, getThreadHistory, saveFormattedMessage, updateThread } from "./durable/threads.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const scope = { workspaceId, projectId: "PRJ-001" };
const originalDataDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalPmUrl = process.env.PM_API_URL;
const app = new Hono().route("/api", chatRoutes);
let directory: string;
let pm: Server;
let catalog: AgentCatalog;
let pmStatus: number;
let receivedHeaders: { cookie?: string; authorization?: string };
let catalogGate: Promise<void> | undefined;
let catalogRequested: (() => void) | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-chat-archive-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  pmStatus = 200;
  receivedHeaders = {};
  catalogGate = undefined;
  catalogRequested = undefined;
  const area = { path: null, status: "unconfigured" as const, revision: 3, source: null, canManage: false };
  catalog = { workspaces: [{ id: workspaceId, name: "归档测试工作区", fileArea: area, projects: [{ id: "PRJ-001", name: "原项目", fileArea: area }] }] };
  pm = createServer(async (request, response) => {
    assert.equal(request.url, "/api/v1/agent-contexts");
    assert.equal(request.method, "GET");
    receivedHeaders = { cookie: request.headers.cookie, authorization: request.headers.authorization };
    catalogRequested?.();
    await catalogGate;
    response.writeHead(pmStatus, { "content-type": "application/json" });
    response.end(JSON.stringify(pmStatus === 200 ? catalog : { error: "拒绝访问" }));
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
  const closed = Promise.withResolvers<void>();
  pm.close((error) => error ? closed.reject(error) : closed.resolve());
  await closed.promise;
  closeStore();
  await rm(directory, { recursive: true, force: true });
  if (originalDataDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
  else process.env.AGENT_WORKSPACE_DATA_DIR = originalDataDirectory;
  if (originalPmUrl === undefined) delete process.env.PM_API_URL;
  else process.env.PM_API_URL = originalPmUrl;
});

function statusRequest(id: string, status: "regular" | "archived") {
  return app.request(`http://localhost/api/chat/threads/${id}`, {
    method: "PUT", headers: { "content-type": "application/json", cookie: "pm_v3_session=fixture", authorization: "Bearer fixture" },
    body: JSON.stringify({ status }),
  });
}
function seedHistory(id: string, scoped = true) {
  ensureThread(id, "保持原始历史", scoped ? scope : undefined);
  saveFormattedMessage(id, { id: `${id}-message`, parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "原始消息" }] } });
}
function seedGeneration(threadId: string, status: "queued" | "running" = "queued") {
  const generation: ChatGeneration = {
    id: `${threadId}-generation`, threadId, messageId: `${threadId}-assistant`, parentId: `${threadId}-message`, status,
    createdAt: new Date().toISOString(), seq: 0,
    request: { id: threadId, messages: [{ id: `${threadId}-message`, role: "user", parts: [{ type: "text", text: "原始消息" }] }] },
    providerInstanceId: "isolated-fixture", providerInstanceRevision: 1, modelId: "fixture-model", temperature: 1,
  };
  writeRecord("chat:generations", generation.id, generation);
  return generation;
}

test("archive and restore retain original scope/history/settings without requiring a configured directory or management permission", async () => {
  seedHistory("scoped");
  const original = getThread("scoped")!;
  const history = getThreadHistory("scoped");
  assert.equal((await statusRequest("scoped", "archived")).status, 200);
  const listed = await (await app.request("http://localhost/api/chat/threads")).json();
  assert.equal(listed.threads.find((thread: { remoteId: string }) => thread.remoteId === "scoped").status, "archived");
  assert.deepEqual(receivedHeaders, { cookie: "pm_v3_session=fixture", authorization: "Bearer fixture" });
  closeStore();
  assert.equal(getThread("scoped")!.status, "archived");
  assert.equal((await statusRequest("scoped", "regular")).status, 200);
  assert.deepEqual(getThread("scoped")!.scope, scope);
  assert.deepEqual(getThread("scoped")!.settings, original.settings);
  assert.equal(getThread("scoped")!.revision, original.revision);
  assert.deepEqual(getThreadHistory("scoped"), history);
});

test("revoked project scope and legacy histories cannot archive, restore, delete, or silently rebind", async () => {
  seedHistory("revoked");
  updateThread("revoked", { status: "archived" });
  catalog.workspaces[0]!.projects = [];
  assert.equal((await statusRequest("revoked", "regular")).status, 403);
  assert.equal((await app.request("http://localhost/api/chat/threads/revoked", { method: "DELETE" })).status, 403);
  assert.equal(getThread("revoked")!.status, "archived");
  assert.deepEqual(getThread("revoked")!.scope, scope);
  assert.equal(getThreadHistory("revoked").messages.length, 1);
  seedHistory("legacy", false);
  updateThread("legacy", { status: "archived" });
  assert.equal((await statusRequest("legacy", "regular")).status, 412);
  assert.equal((await statusRequest("legacy", "archived")).status, 412);
  assert.equal((await app.request("http://localhost/api/chat/threads/legacy", { method: "DELETE" })).status, 412);
  assert.equal(getThread("legacy")!.scope, undefined);
});

test("archive never cancels queued or running generations, including a generation accepted while permission lookup is in flight", async () => {
  for (const status of ["queued", "running"] as const) {
    seedHistory(status);
    const generation = seedGeneration(status, status);
    assert.equal((await statusRequest(status, "archived")).status, 409);
    assert.equal(getChatGeneration(generation.id)!.status, status);
    assert.equal(getThread(status)!.status, "regular");
  }
  seedHistory("race");
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  catalogGate = gate.promise;
  catalogRequested = () => entered.resolve();
  const archiving = statusRequest("race", "archived");
  await entered.promise;
  const generation = seedGeneration("race");
  gate.resolve();
  assert.equal((await archiving).status, 409);
  assert.equal(getChatGeneration(generation.id)!.status, "queued");
  assert.equal(getThread("race")!.status, "regular");
});

test("permanent delete preserves explicit cancellation semantics and leaves history intact when cancellation is unconfirmed", async () => {
  seedHistory("queued-delete");
  updateThread("queued-delete", { status: "archived" });
  const queued = seedGeneration("queued-delete");
  assert.equal((await app.request("http://localhost/api/chat/threads/queued-delete", { method: "DELETE" })).status, 200);
  assert.equal(getChatGeneration(queued.id)!.status, "cancelled");
  assert.equal(getThread("queued-delete"), null);
  assert.equal(getThreadHistory("queued-delete").messages.length, 0);
  assert.equal((await app.request("http://localhost/api/chat/threads/queued-delete", { method: "DELETE" })).status, 200);
  seedHistory("unconfirmed-delete");
  const running = seedGeneration("unconfirmed-delete", "running");
  assert.equal((await app.request("http://localhost/api/chat/threads/unconfirmed-delete", { method: "DELETE" })).status, 409);
  assert.equal(getChatGeneration(running.id)!.status, "running");
  assert.ok(getThread("unconfirmed-delete"));
  assert.equal(getThreadHistory("unconfirmed-delete").messages.length, 1);
});

test("permission failures do not cancel or delete a generation, and missing status updates never create ghost threads", async () => {
  seedHistory("denied");
  const generation = seedGeneration("denied");
  pmStatus = 401;
  assert.equal((await statusRequest("denied", "archived")).status, 401);
  assert.equal((await app.request("http://localhost/api/chat/threads/denied", { method: "DELETE" })).status, 401);
  assert.equal(getChatGeneration(generation.id)!.status, "queued");
  assert.equal(getThreadHistory("denied").messages.length, 1);
  pmStatus = 503;
  assert.equal((await statusRequest("denied", "archived")).status, 503);
  assert.equal((await statusRequest("missing", "archived")).status, 404);
  assert.equal(getThread("missing"), null);
});
