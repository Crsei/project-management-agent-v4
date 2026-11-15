import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { chatOnlyExecutionSelection } from "@agent-workspace/contracts/chat";
import { chatRoutes } from "./chat.ts";
import { chatRequestIdentity, getChatGeneration, lookupChatSubmission, type ChatGeneration } from "./durable/chat-runtime.ts";
import { closeStore, getDatabase, readRecord, writeRecord } from "./durable/store.ts";
import { assertThreadWritable, ensureThread, getThread, getThreadHistory, saveFormattedMessage, updateThread } from "./durable/threads.ts";
import { chatOnlyEnvironment } from "./durable/execution.testkit.ts";
import { applySessionCutover, inventorySessionCutover } from "./maintenance/session-cutover.ts";

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
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, lifecycleRevision: getThread(id)?.lifecycleRevision ?? 0 }),
  });
}
function deletionRequest(id: string, operationId: string, lifecycleRevision: number, expectedGenerationId: string | null, stopActive: boolean) {
  return app.request(`http://localhost/api/chat/threads/${id}`, { method: "DELETE",
    headers: { "content-type": "application/json", "Idempotency-Key": operationId },
    body: JSON.stringify({ lifecycleRevision, confirm: true, expectedGenerationId, stopActive }) });
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
  updateThread("queued-delete", { status: "archived", lifecycleRevision: 0 });
  const queued = seedGeneration("queued-delete");
  assert.equal((await deletionRequest("queued-delete", "delete-queued", 1, queued.id, true)).status, 200);
  assert.equal(getChatGeneration(queued.id)!.status, "cancelled");
  assert.equal(getThread("queued-delete"), null);
  assert.equal(getThreadHistory("queued-delete").messages.length, 0);
  assert.equal((await deletionRequest("queued-delete", "delete-queued", 1, queued.id, true)).status, 200);
  seedHistory("unconfirmed-delete");
  const running = seedGeneration("unconfirmed-delete", "running");
  assert.equal((await deletionRequest("unconfirmed-delete", "delete-unconfirmed", 0, running.id, true)).status, 409);
  assert.equal(getChatGeneration(running.id)!.status, "running");
  assert.ok(getThread("unconfirmed-delete"));
  assert.equal(getThreadHistory("unconfirmed-delete").messages.length, 1);
});

test("offline legacy cutover preserves committed modern deletion and its original acceptance identity", async () => {
  const threadId = "modern-deleted", submissionId = "original-modern-submission";
  seedHistory(threadId);
  const generation = seedGeneration(threadId);
  generation.status = "completed";
  generation.inputMessageId = `${threadId}-message`;
  generation.request.idempotencyKey = submissionId;
  writeRecord("chat:generations", generation.id, generation);
  const requestIdentity = chatRequestIdentity(generation.request);
  writeRecord("chat:requests", requestIdentity, { id: generation.id, fingerprint: "a".repeat(64), inputMessageId: generation.inputMessageId });
  assert.equal(lookupChatSubmission(threadId, submissionId).status, "accepted");
  assert.equal((await deletionRequest(threadId, "modern-delete-operation", 0, null, false)).status, 200);
  const tombstone = readRecord("chat:threads", threadId);
  const request = readRecord("chat:requests", requestIdentity), retainedGeneration = readRecord("chat:generations", generation.id);
  const receipt = readRecord("chat:lifecycle-operations", JSON.stringify([threadId, "modern-delete-operation"]));
  assert.equal(lookupChatSubmission(threadId, submissionId).status, "accepted");
  assert.ok(tombstone); assert.ok(request); assert.ok(retainedGeneration); assert.ok(receipt);
  writeRecord("chat:threads", "genuine-legacy-deleted", { remoteId: "genuine-legacy-deleted", deleted: true });
  const plan = inventorySessionCutover(getDatabase(), directory);
  assert.equal(plan.candidateIds.includes(threadId), false);
  assert.equal(plan.candidateIds.includes("genuine-legacy-deleted"), true);
  applySessionCutover(getDatabase(), plan, directory);
  closeStore();
  assert.deepEqual(readRecord("chat:threads", threadId), tombstone);
  assert.deepEqual(readRecord("chat:requests", requestIdentity), request);
  assert.deepEqual(readRecord("chat:generations", generation.id), retainedGeneration);
  assert.deepEqual(readRecord("chat:lifecycle-operations", JSON.stringify([threadId, "modern-delete-operation"])), receipt);
  assert.equal(lookupChatSubmission(threadId, submissionId).status, "accepted");
  assert.equal((await deletionRequest(threadId, "modern-delete-operation", 0, null, false)).status, 200);
});

test("missing status updates never create ghost threads", async () => {
  assert.equal((await statusRequest("missing", "archived")).status, 404);
  assert.equal(getThread("missing"), null);
});

test("lifecycle CAS is independent of settings/title revisions and closing rejects competing mutations", async () => {
  seedHistory("race");
  updateThread("race", { title: "Renamed without lifecycle transition" });
  assert.equal(getThread("race")!.lifecycleRevision, 0);
  assert.equal((await statusRequest("race", "archived")).status, 200);
  const stale = await app.request("http://localhost/api/chat/threads/race", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "regular", lifecycleRevision: 0 }) });
  assert.equal(stale.status, 409); assert.equal(getThread("race")!.status, "archived");
  assert.equal((await statusRequest("race", "regular")).status, 200);
  seedGeneration("race", "running");
  assert.equal((await deletionRequest("race", "original-race", 2, "race-generation", true)).status, 409);
  assert.equal(getThread("race")!.deletionState, "closing");
  assert.throws(() => assertThreadWritable("race"), { code: "thread_closing" });
  assert.throws(() => updateThread("race", { title: "Late title" }), { code: "thread_closing" });
  const receipt = await app.request("http://localhost/api/chat/threads/race/lifecycle-operations/original-race");
  assert.equal((await receipt.json()).operation.state, "blocked");
  assert.equal((await deletionRequest("race", "original-race", 2, "different-generation", true)).status, 409);
  assert.equal(getThreadHistory("race").messages.length, 1);
});

test("unknown PM/steer/fork/queue outcomes and unclassified namespaces block deletion without erasing evidence", async () => {
  for (const kind of ["pm", "steer", "fork", "queue", "namespace"] as const) {
    const id = `blocked-${kind}`; seedHistory(id);
    if (kind === "pm") writeRecord("pm-tool-calls", id, { record: { operationId: id, threadId: id, status: "unknown", certainty: { dispatch: "possibly_sent", evidence: "unresolved" } } });
    if (kind === "steer") writeRecord("chat:steering", id, { threadId: id, status: "unknown" });
    if (kind === "fork") writeRecord("chat:threads", id, { ...getThread(id), pendingFork: { source: { sessionId: "unresolved" } } });
    if (kind === "queue") writeRecord("chat:message-queue", JSON.stringify([id, "q"]), { id: "q", threadId: id, status: "unknown" });
    if (kind === "namespace") writeRecord("future:unclassified", id, { threadId: id });
    assert.equal((await deletionRequest(id, `delete-${kind}`, 0, null, false)).status, 409);
    assert.equal(getThreadHistory(id).messages.length, 1);
    assert.equal(getThread(id)!.deletionState, undefined);
  }
});

test("deletion retains exact business evidence, removes unreferenced payloads and never revives original IDs", async () => {
  seedHistory("retained"); const generation = seedGeneration("retained");
  writeRecord("chat:generations", generation.id, { ...generation, status: "completed", request: { ...generation.request, idempotencyKey: "original" } });
  writeRecord("collaboration:runs:v1", "business", { id: "business", threadId: "retained", generationId: generation.id, status: "succeeded" });
  assert.equal((await deletionRequest("retained", "retained-delete", 0, null, false)).status, 200);
  assert.deepEqual(readRecord("collaboration:runs:v1", "business"), { id: "business", threadId: "retained", generationId: generation.id, status: "succeeded" });
  assert.equal((readRecord<{ request: { messages: unknown[] } }>("chat:generations", generation.id)!).request.messages.length, 1);
  assert.throws(() => ensureThread("retained"), { code: "thread_deleted" });
  assert.throws(() => saveFormattedMessage("retained", { id: "late", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [] } }), { code: "thread_deleted" });
  const tombstone = readRecord<Record<string, unknown>>("chat:threads", "retained")!;
  assert.equal(tombstone.title, undefined); assert.equal(tombstone.settings, undefined);
  seedHistory("unreferenced"); const ordinary = seedGeneration("unreferenced");
  writeRecord("chat:generations", ordinary.id, { ...ordinary, status: "completed" });
  writeRecord("pm-content-provenance", ordinary.id, { threadId: "unreferenced", generationId: ordinary.id, messageIds: [ordinary.messageId], operationIds: [], targets: [], authorities: [] });
  writeRecord("chat:steering", "ordinary-steer", { id: "steer", threadId: "unreferenced", generationId: ordinary.id, status: "accepted", text: "PRIVATE ACCEPTED STEERING" });
  assert.equal((await deletionRequest("unreferenced", "ordinary-delete", 0, null, false)).status, 200);
  assert.equal(readRecord<{ persistenceTombstone: boolean }>("chat:generations", ordinary.id)!.persistenceTombstone, true);
  assert.deepEqual(readRecord<{ request: { messages: unknown[] } }>("chat:generations", ordinary.id)!.request.messages, []);
  assert.equal(readRecord("pm-content-provenance", ordinary.id), null);
  assert.doesNotMatch(JSON.stringify(readRecord("chat:steering", "ordinary-steer")), /PRIVATE ACCEPTED STEERING/);
});
