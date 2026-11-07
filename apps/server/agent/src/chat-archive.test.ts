import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { chatOnlyExecutionSelection } from "@agent-workspace/contracts/chat";
import { chatRoutes } from "./chat.ts";
import { getChatGeneration, type ChatGeneration } from "./durable/chat-runtime.ts";
import { closeStore, writeRecord } from "./durable/store.ts";
import { ensureThread, getThread, getThreadHistory, saveFormattedMessage, updateThread } from "./durable/threads.ts";
import { chatOnlyEnvironment } from "./durable/execution.testkit.ts";

const originalDataDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalPmUrl = process.env.PM_API_URL;
const app = new Hono().route("/api", chatRoutes);
let directory: string;
let pm: Server;
let pmRequests: number;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-chat-archive-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  pmRequests = 0;
  pm = createServer((_request, response) => {
    pmRequests++;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "PM unavailable" }));
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
  assert.equal(pmRequests, 0, "Session lifecycle must not require PM authorization or connectivity");
});

function statusRequest(id: string, status: "regular" | "archived") {
  return app.request(`http://localhost/api/chat/threads/${id}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }),
  });
}
function seedHistory(id: string) {
  ensureThread(id, "保持原始历史", chatOnlyExecutionSelection(), chatOnlyEnvironment());
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

test("archive and restore preserve execution selection, history and settings while PM is unavailable", async () => {
  seedHistory("history");
  const original = getThread("history")!;
  const history = getThreadHistory("history");
  assert.equal((await statusRequest("history", "archived")).status, 200);
  const listed = await (await app.request("http://localhost/api/chat/threads")).json();
  assert.equal(listed.threads.find((thread: { remoteId: string }) => thread.remoteId === "history").status, "archived");
  closeStore();
  assert.equal(getThread("history")!.status, "archived");
  assert.equal((await statusRequest("history", "regular")).status, 200);
  assert.deepEqual(getThread("history")!.executionSelection, original.executionSelection);
  assert.deepEqual(getThread("history")!.executionEnvironment, original.executionEnvironment);
  assert.deepEqual(getThread("history")!.settings, original.settings);
  assert.equal(getThread("history")!.revision, original.revision);
  assert.deepEqual(getThreadHistory("history"), history);
});

test("archive never cancels queued or running generations", async () => {
  for (const status of ["queued", "running"] as const) {
    seedHistory(status);
    const generation = seedGeneration(status, status);
    assert.equal((await statusRequest(status, "archived")).status, 409);
    assert.equal(getChatGeneration(generation.id)!.status, status);
    assert.equal(getThread(status)!.status, "regular");
  }
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

test("missing status updates never create ghost threads", async () => {
  assert.equal((await statusRequest("missing", "archived")).status, 404);
  assert.equal(getThread("missing"), null);
});
