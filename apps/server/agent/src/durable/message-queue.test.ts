import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { chatOnlyExecutionSelection, type ChatDraftInput } from "@agent-workspace/contracts/chat";
import { chatActionRoutes } from "../chat-actions.ts";
import { closeStore, getDatabase, listRecords, readRecord, writeRecord } from "./store.ts";
import { deleteThread, ensureThread, getThread, saveFormattedMessage, updateThread } from "./threads.ts";
import { chatRequestIdentity, stopChatRuntime, type ChatGeneration } from "./chat-runtime.ts";
import { enqueueMessage, listQueuedMessages, listStashedDrafts, mutateQueue, editQueuedMessage, reconcileQueuedMessage, removeStashedDraft, savedDraftExists, stashDraft, validateDurableDraft } from "./message-queue.ts";
import { getStoreIdentity, restorePersistenceIdentity } from "./persistence-schema.ts";

let directory: string;
const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const headers = new Headers({ cookie: "never-persist-this-cookie", authorization: "Bearer never-persist-this-bearer" });
const draft = (id: string, text = "Explicit queued instruction"): ChatDraftInput => ({ message: { id, role: "user", parts: [{ type: "text", text }] } });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "message-queue-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  ensureThread("session", undefined, chatOnlyExecutionSelection());
});
afterEach(async () => {
  await stopChatRuntime();
  closeStore();
  if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
  await rm(directory, { recursive: true, force: true });
});
test("queue admission is durable, idempotent and does not create generations or persist request authority", async () => {
  const revision = getThread("session")!.revision;
  await enqueueMessage("session", "one", draft("input-one"), revision, headers);
  await enqueueMessage("session", "one", draft("input-one"), revision, headers);
  assert.equal(listRecords("chat:generations").length, 0);
  assert.equal((await listQueuedMessages("session", headers)).length, 1);
  assert.doesNotMatch(JSON.stringify(listRecords("chat:message-queue")), /never-persist-this|cookie|authorization/i);
  closeStore();
  assert.equal((await listQueuedMessages("session", headers))[0]!.status, "queued");
  await assert.rejects(enqueueMessage("session", "one", draft("changed", "Different"), revision, headers), { code: "idempotency_conflict" });
});
test("queue CAS prevents conflicting reorder/edit; editing requires fresh message identity", async () => {
  await enqueueMessage("session", "one", draft("input-one"), 0, headers);
  await enqueueMessage("session", "two", draft("input-two"), 0, headers);
  await mutateQueue("session", "two", 0, "move", headers, "one");
  let rows = await listQueuedMessages("session", headers);
  assert.deepEqual(rows.map(row => row.id), ["two", "one"]);
  await assert.rejects(mutateQueue("session", "two", 0, "remove", headers), { code: "queue_conflict" });
  const row = rows.find(value => value.id === "one")!;
  await assert.rejects(editQueuedMessage("session", "one", row.revision, draft("input-one", "changed"), 0, headers), { code: "new_input_id_required" });
  await editQueuedMessage("session", "one", row.revision, draft("new-input", "changed"), 0, headers);
  rows = await listQueuedMessages("session", headers);
  assert.equal(rows.find(value => value.id === "one")!.draft!.message.id, "new-input");
});
test("an orphaned dispatch remains unknown when the original submission evidence is absent", async () => {
  await enqueueMessage("session", "one", draft("input-one"), 0, headers);
  const key = JSON.stringify(["session", "one"]), row = readRecord<Record<string, unknown>>("chat:message-queue", key)!;
  writeRecord("chat:message-queue", key, { ...row, status: "dispatching" });
  closeStore();
  assert.equal((await listQueuedMessages("session", headers))[0]!.status, "unknown");
  assert.equal(listRecords("chat:generations").length, 0);
  await reconcileQueuedMessage("session", "one", 0, headers);
  assert.equal((await listQueuedMessages("session", headers))[0]!.status, "unknown");
  assert.equal(listRecords("chat:generations").length, 0);
});
test("reconciliation finds an already accepted failed/unknown generation without dispatching a second one", async () => {
  await enqueueMessage("session", "one", draft("input-one"), 0, headers);
  const key = JSON.stringify(["session", "one"]), row = readRecord<Record<string, unknown>>("chat:message-queue", key)!;
  writeRecord("chat:message-queue", key, { ...row, status: "dispatching" });
  writeRecord<ChatGeneration>("chat:generations", "accepted", { id: "accepted", threadId: "session", messageId: "assistant", inputMessageId: "input-one", parentId: "input-one", status: "interrupted", seq: 0,
    createdAt: new Date().toISOString(), request: { id: "session", messages: [draft("input-one").message], idempotencyKey: "queue:one:0" }, providerInstanceId: "fixture", providerInstanceRevision: 1, modelId: "fixture", temperature: 0 });
  writeRecord("chat:requests", chatRequestIdentity({ id: "session", messages: [], idempotencyKey: "queue:one:0" }), { version: 1, id: "accepted", fingerprint: "exact-original", threadId: "session", submissionId: "queue:one:0", inputMessageId: "input-one", state: "accepted" });
  await reconcileQueuedMessage("session", "one", 0, headers);
  const saved = (await listQueuedMessages("session", headers))[0]!;
  assert.equal(saved.status, "sent"); assert.equal(saved.generationId, "accepted");
  assert.equal(listRecords("chat:generations").length, 1);
});
test("stash is explicit multiple immutable drafts, scoped by session, independent of composer and never dispatches", async () => {
  await stashDraft("session", "a", draft("draft-a"), headers);
  await stashDraft("session", "b", draft("draft-b"), headers);
  ensureThread("other", undefined, chatOnlyExecutionSelection());
  assert.equal((await listStashedDrafts("other", headers)).length, 0);
  closeStore();
  assert.deepEqual((await listStashedDrafts("session", headers)).map(value => value.id), ["a", "b"]);
  assert.equal(listRecords("chat:generations").length, 0);
});
test("non-durable attachments are rejected instead of silently losing data", () => {
  for (const url of ["blob:browser-only", "https://attacker.invalid/image.png", "file:///private/image.png"]) {
    assert.throws(() => validateDurableDraft({ message: { id: "file", role: "user", parts: [{ type: "file", mediaType: "image/png", url }] } }), { code: "non_durable_attachment" });
  }
  assert.equal(validateDurableDraft({ message: { id: "file", role: "user", parts: [{ type: "file", mediaType: "text/plain", url: "data:text/plain;base64,aGVsbG8=" }] } }).message.parts.length, 1);
});
test("HTTP stash/queue contracts reject forged grants and stale settings without changing existing records", async () => {
  const app = new Hono().route("/api", chatActionRoutes);
  const post = (body: object) => app.request("http://localhost/api/chat/threads/session/queue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const forged = draft("forged") as unknown as { message: { metadata: unknown } };
  forged.message.metadata = { executionGrantId: "forged" };
  assert.equal((await post({ id: "forged", draft: forged, threadSettingsRevision: 0 })).status, 400);
  updateThread("session", { settings: getThread("session")!.settings });
  assert.equal((await post({ id: "stale", draft: draft("stale"), threadSettingsRevision: 0 })).status, 409);
  assert.equal(listRecords("chat:message-queue").length, 0);
});
test("removal clears draft payload but retains save proof; Session deletion removes queue and stash rows", async () => {
  await enqueueMessage("session", "one", draft("queued", "PRIVATE QUEUED TEXT"), 0, headers);
  await stashDraft("session", "stash", draft("stashed", "PRIVATE STASH TEXT"), headers);
  await mutateQueue("session", "one", 0, "remove", headers);
  await removeStashedDraft("session", "stash", headers);
  assert.equal(await savedDraftExists("session", "one", "queue", headers), true);
  assert.equal(await savedDraftExists("session", "stash", "stash", headers), true);
  assert.doesNotMatch(JSON.stringify([listRecords("chat:message-queue"), listRecords("chat:draft-stash")]), /PRIVATE QUEUED TEXT|PRIVATE STASH TEXT/);
  deleteThread("session");
  assert.equal(listRecords("chat:message-queue").length, 0); assert.equal(listRecords("chat:draft-stash").length, 0);
});

test("only explicit same-epoch rejection unlocks an unknown queue; restore/missing evidence never proves no admission", async () => {
  await enqueueMessage("session", "one", draft("input-one"), 0, headers);
  const key = JSON.stringify(["session", "one"]), row = readRecord<Record<string, unknown>>("chat:message-queue", key)!;
  const identity = getStoreIdentity(getDatabase());
  const requestKey = chatRequestIdentity({ id: "session", messages: [], idempotencyKey: "queue:one:0" });
  writeRecord("chat:message-queue", key, { ...row, status: "unknown", dispatchStoreId: identity.storeId, dispatchRestoreEpoch: identity.restoreEpoch });
  writeRecord("chat:requests", requestKey, { version: 1, fingerprint: "original", threadId: "session", submissionId: "queue:one:0", inputMessageId: "input-one", state: "rejected",
    reason: "admission_rejected", storeId: identity.storeId, restoreEpoch: identity.restoreEpoch });
  await reconcileQueuedMessage("session", "one", 0, headers);
  assert.equal((await listQueuedMessages("session", headers))[0]!.status, "blocked");
  const blocked = readRecord<Record<string, unknown>>("chat:message-queue", key)!;
  writeRecord("chat:message-queue", key, { ...blocked, status: "unknown" });
  restorePersistenceIdentity(getDatabase());
  await reconcileQueuedMessage("session", "one", Number(blocked.revision), headers);
  assert.equal((await listQueuedMessages("session", headers))[0]!.status, "unknown");
  assert.equal(listRecords("chat:generations").length, 0);
});

test("archive retains readable queue/stash and never makes their write or send paths usable", async () => {
  await enqueueMessage("session", "one", draft("input-one"), 0, headers);
  await stashDraft("session", "saved", draft("saved-input"), headers);
  updateThread("session", { status: "archived", lifecycleRevision: 0 });
  assert.equal((await listQueuedMessages("session", headers)).length, 1);
  assert.equal((await listStashedDrafts("session", headers)).length, 1);
  await assert.rejects(enqueueMessage("session", "two", draft("input-two"), 0, headers), { code: "thread_archived" });
  await assert.rejects(removeStashedDraft("session", "saved", headers), { code: "thread_archived" });
});

test("typed context draft survives queue/stash restart and source deletion never deletes referencing records", async () => {
  ensureThread("context-source", undefined, chatOnlyExecutionSelection());
  saveFormattedMessage("context-source", { id: "source-response", parent_id: null, format: "ai-sdk/v6", content: { role: "assistant", parts: [{ type: "text", text: "Real saved source response" }] } }, true);
  writeRecord("chat:generations", "source-generation", { id: "source-generation", threadId: "context-source", messageId: "source-response", status: "completed",
    output: { id: "source-response", role: "assistant", parts: [{ type: "text", text: "Real saved source response" }] } });
  const selected: ChatDraftInput = { ...draft("context-draft"), contextItems: [
    { contextId: "browser-snapshot", kind: "preview-annotation", source: { type: "browser", url: "https://not-fetched.invalid/" }, text: "USER_SELECTED_BROWSER_SNAPSHOT" },
    { contextId: "source-response", kind: "response", source: { type: "response", threadId: "context-source", messageId: "source-response", generationId: "source-generation" }, selectedText: "saved source" },
    { contextId: "local-environment", kind: "environment", source: { type: "environment", hostId: "local" } },
  ] };
  await enqueueMessage("session", "context-queue", selected, 0, headers);
  await stashDraft("session", "context-stash", { ...selected, message: { ...selected.message, id: "stashed-context-input" } }, headers);
  const frozen = (await listQueuedMessages("session", headers))[0]!.draft!.contextItems!;
  const environment = frozen.find(item => item.kind === "environment")!;
  assert.equal(environment.source.type, "environment");
  if (environment.source.type === "environment") assert.match(environment.source.environmentDigest!, /^[a-f0-9]{64}$/);
  closeStore();
  assert.deepEqual((await listQueuedMessages("session", headers))[0]!.draft!.contextItems, frozen);
  assert.deepEqual((await listStashedDrafts("session", headers))[0]!.draft!.contextItems, frozen);
  deleteThread("context-source");
  assert.equal(listRecords("chat:message-queue").length, 1); assert.equal(listRecords("chat:draft-stash").length, 1);
  assert.equal((await listQueuedMessages("session", headers))[0]!.draft, null);
  assert.equal((await listStashedDrafts("session", headers))[0]!.draft, null);
  assert.equal((await listQueuedMessages("session", headers))[0]!.status, "queued");
  assert.equal(listRecords<{ threadId: string }>("chat:generations").filter(value => value.threadId === "session").length, 0);
});
