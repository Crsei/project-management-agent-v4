import assert from "node:assert/strict";
import { test } from "node:test";
import { StudioApiError, StudioClient } from "../../../../../../../../packages/contracts/src/automation-studio-client.ts";
import type { StudioConfig, StudioExecution } from "../../../../../../../../packages/contracts/src/automation-studio.ts";
import { StudioActionStore } from "./studio-action-store.ts";

const definitionId = "11111111-1111-4111-8111-111111111111";
const config: StudioConfig = { name: "Saved analysis", description: "", projectId: "PRJ-001", tags: [], templateId: null, action: { kind: "prompt", prompt: "Review saved facts", providerInstanceId: "explicit-provider", model: "explicit-model", options: {}, repositories: [], plugins: [], timeoutSeconds: 600 }, trigger: { kind: "manual" }, dailyLimit: 10, cooldownMinutes: 0 };
function execution(requestId: string, revision = 7): StudioExecution {
  return { id: "22222222-2222-4222-8222-222222222222", definitionId, definitionRevision: revision, configSnapshot: config, trigger: "manual", requestId, status: "queued", createdAt: "2026-11-06T10:00:00.000Z", startedAt: null, finishedAt: null, threadId: null, externalExecutionId: null, error: null, summary: "" };
}
function journal() {
  const entries = new Map<string, string>();
  let failWrite = false;
  let failRemove = false;
  const storage: Storage = {
    get length() { return entries.size; }, key: index => [...entries.keys()][index] ?? null,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { if (failWrite) throw new Error("storage unavailable"); entries.set(key, value); },
    removeItem: key => { if (failRemove) throw new Error("storage unavailable"); entries.delete(key); },
    clear: () => { entries.clear(); },
  };
  return { storage, entries, failWrites: () => { failWrite = true; }, failRemovals: (value: boolean) => { failRemove = value; } };
}
function context(version = 1) {
  const accepted: string[] = [];
  return { version, text: (_zh: string, en: string) => en, settled: (result: { execution?: StudioExecution }) => { if (result.execution) accepted.push(result.execution.id); }, accessFailure: () => {}, accepted };
}

test("multiple entries share one pending identity and dispatch only the frozen saved revision", async () => {
  const memory = journal(); const store = new StudioActionStore("actor:workspace", () => memory.storage);
  const first = context(); const second = context();
  store.subscribe(() => {}, 1); store.subscribe(() => {}, 1);
  const api = new StudioClient("workspace");
  const completion = Promise.withResolvers<StudioExecution>();
  let calls = 0; let requestId = "";
  api.run = async (id, request, revision) => {
    calls++; requestId = request;
    assert.equal(id, definitionId); assert.equal(revision, 7);
    return completion.promise;
  };
  const command = { kind: "run" as const, id: definitionId, expectedRevision: 7 };
  const running = store.execute(api, command, first);
  command.expectedRevision = 99;
  await store.execute(api, { kind: "run", id: "another-definition", expectedRevision: 3 }, second);
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot().pending?.requestId, requestId);
  assert.equal(memory.entries.get("actor:workspace")?.includes('"expectedRevision":7'), true);
  completion.resolve(execution(requestId)); await running;
  assert.equal(store.getSnapshot().pending, null);
  assert.equal(store.getSnapshot().settled?.execution?.definitionRevision, 7);
  assert.equal(memory.entries.size, 0);
  assert.equal(first.accepted.length, 1); assert.equal(second.accepted.length, 0);
});

test("unknown dispatch survives remount and only the original receipt can settle it", async () => {
  const memory = journal(); const api = new StudioClient("workspace");
  let calls = 0; const receiptIds: string[] = [];
  api.run = async () => { calls++; throw new Error("lost response"); };
  api.receipt = async id => { receiptIds.push(id); throw new StudioApiError(404, "not_found", "No receipt yet"); };
  const store = new StudioActionStore("actor:workspace", () => memory.storage); store.subscribe(() => {}, 1);
  await store.execute(api, { kind: "run", id: definitionId, expectedRevision: 7 }, context());
  const original = store.getSnapshot().pending!.requestId;
  assert.equal(store.getSnapshot().settled, null);
  const restored = new StudioActionStore("actor:workspace", () => memory.storage); restored.subscribe(() => {}, 2);
  await restored.execute(api, { kind: "run", id: definitionId, expectedRevision: 8 }, context(2));
  assert.equal(calls, 1);
  api.receipt = async id => { receiptIds.push(id); return { requestId: id, httpStatus: 202, result: execution(id) }; };
  await restored.reconcile(api, context(2));
  assert.deepEqual(receiptIds, [original, original]);
  assert.equal(restored.getSnapshot().pending, null);
  assert.equal(restored.getSnapshot().settled?.execution?.requestId, original);
  assert.equal(calls, 1);
});

test("late old-membership results do not publish private execution feedback into the new scope", async () => {
  const memory = journal(); const store = new StudioActionStore("actor:workspace", () => memory.storage);
  const unsubscribe = store.subscribe(() => {}, 1);
  const api = new StudioClient("workspace"); const completion = Promise.withResolvers<StudioExecution>(); let original = "";
  api.run = async (_id, request) => { original = request; return completion.promise; };
  const running = store.execute(api, { kind: "run", id: definitionId, expectedRevision: 7 }, context());
  unsubscribe(); store.subscribe(() => {}, 2);
  completion.resolve(execution(original)); await running;
  assert.equal(store.getSnapshot().pending, null);
  assert.equal(store.getSnapshot().settled, null);
  assert.equal(store.getSnapshot().error, "");
});

test("revision conflict is surfaced without reloading or dispatching an upgraded revision", async () => {
  const memory = journal(); const store = new StudioActionStore("actor:workspace", () => memory.storage); store.subscribe(() => {}, 1);
  const api = new StudioClient("workspace"); let calls = 0;
  api.run = async (_id, _request, revision) => { calls++; assert.equal(revision, 7); throw new StudioApiError(409, "revision_conflict", "Saved revision changed; refresh explicitly"); };
  api.definition = async () => { throw new Error("No automatic revision upgrade is allowed"); };
  await store.execute(api, { kind: "run", id: definitionId, expectedRevision: 7 }, context());
  assert.equal(calls, 1); assert.equal(store.getSnapshot().pending, null);
  assert.equal(store.getSnapshot().settled, null);
  assert.match(store.getSnapshot().error, /Saved revision changed/);
});

test("a mismatched receipt cannot become success or erase the original identity", async () => {
  const memory = journal(); const store = new StudioActionStore("actor:workspace", () => memory.storage); store.subscribe(() => {}, 1);
  const api = new StudioClient("workspace");
  api.run = async () => { throw new Error("lost response"); };
  api.receipt = async id => ({ requestId: id, httpStatus: 202, result: execution(id, 8) });
  await store.execute(api, { kind: "run", id: definitionId, expectedRevision: 7 }, context());
  assert.notEqual(store.getSnapshot().pending, null);
  assert.equal(store.getSnapshot().settled, null);
  assert.match(store.getSnapshot().error, /still unknown/);
});

test("storage failures block new writes and preserve an accepted request until its receipt is reconciled", async () => {
  const memory = journal(); const blocked = new StudioActionStore("blocked", () => memory.storage); blocked.subscribe(() => {}, 1);
  const api = new StudioClient("workspace"); let calls = 0;
  api.run = async (_id, request) => { calls++; return execution(request); };
  memory.failWrites();
  await blocked.execute(api, { kind: "run", id: definitionId, expectedRevision: 7 }, context());
  assert.equal(calls, 0); assert.equal(blocked.getSnapshot().storageError, true);

  const recovery = journal(); const store = new StudioActionStore("pending", () => recovery.storage); store.subscribe(() => {}, 1);
  recovery.failRemovals(true);
  await store.execute(api, { kind: "run", id: definitionId, expectedRevision: 7 }, context());
  const original = store.getSnapshot().pending!.requestId;
  assert.equal(calls, 1); assert.equal(store.getSnapshot().settled, null);
  recovery.failRemovals(false);
  api.receipt = async id => { assert.equal(id, original); return { requestId: id, httpStatus: 202, result: execution(id) }; };
  await store.reconcile(api, context());
  assert.equal(calls, 1); assert.equal(store.getSnapshot().pending, null);
  assert.equal(store.getSnapshot().settled?.execution?.requestId, original);
});

test("unparseable recovery journals remain intact and fail closed", async () => {
  const memory = journal(); memory.entries.set("actor:workspace", "not-json");
  const store = new StudioActionStore("actor:workspace", () => memory.storage); store.subscribe(() => {}, 1);
  const api = new StudioClient("workspace"); let calls = 0;
  api.run = async (_id, request) => { calls++; return execution(request); };
  store.retryStorage(api, context());
  await store.execute(api, { kind: "run", id: definitionId, expectedRevision: 7 }, context());
  assert.equal(calls, 0); assert.equal(store.getSnapshot().storageError, true);
  assert.equal(memory.entries.get("actor:workspace"), "not-json");
});

test("actor/workspace journals cannot settle or overwrite another scope's original request", async () => {
  const memory = journal();
  const first = new StudioActionStore("actor:workspace-a", () => memory.storage);
  const second = new StudioActionStore("actor:workspace-b", () => memory.storage);
  first.subscribe(() => {}, 1); second.subscribe(() => {}, 1);
  const firstApi = new StudioClient("workspace-a"); const secondApi = new StudioClient("workspace-b");
  firstApi.run = async () => { throw new Error("unknown first workspace outcome"); };
  firstApi.receipt = async () => { throw new StudioApiError(404, "not_found", "not found yet"); };
  secondApi.run = async (_id, request) => execution(request);
  await first.execute(firstApi, { kind: "run", id: definitionId, expectedRevision: 7 }, context());
  const original = memory.entries.get("actor:workspace-a");
  await second.execute(secondApi, { kind: "run", id: definitionId, expectedRevision: 7 }, context());
  assert.equal(memory.entries.get("actor:workspace-a"), original);
  assert.equal(first.getSnapshot().pending?.requestId, JSON.parse(original!).requestId);
  assert.equal(second.getSnapshot().pending, null);
  assert.equal(memory.entries.has("actor:workspace-b"), false);
});
