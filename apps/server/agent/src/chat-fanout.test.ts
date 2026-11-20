import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { chatOnlyExecutionSelection, type ChatFanoutRequest, type ChatFanoutResult, type ExecutionEnvironment } from "../../../../packages/agent-contracts/src/chat.ts";
import { accessGuard } from "./access.ts";
import { openAgentWorkspace } from "./agent-workspaces.ts";
import { createChatFanoutService, parseChatFanoutRequest } from "./chat-fanout.ts";
import { chatRoutes } from "./chat.ts";
import { readChatWorktree } from "./chat-worktrees.ts";
import { resolveAgentExecution } from "./durable/agent-execution.ts";
import type { ChatRequest } from "./durable/chat-runtime.ts";
import { DurableError } from "./durable/errors.ts";
import { chatOnlyEnvironment } from "./durable/execution.testkit.ts";
import { getStoreIdentity, inventoryPersistence, namespacePolicy, PERSISTENCE_NAMESPACE } from "./durable/persistence-schema.ts";
import { closeStore, getDatabase, listRecords, readRecord, writeRecord } from "./durable/store.ts";
import { ensureThread, getThread, listThreads, updateThread, type ThreadMetadata } from "./durable/threads.ts";
import { git } from "./task-delivery/git.ts";

const namespace = "chat-fanouts-v1";
const token = "synthetic-fanout-agent-access-token-at-least-thirty-two-characters";
const app = new Hono().use("/api/*", accessGuard).route("/api", chatRoutes);
const keys = ["AGENT_WORKSPACE_DATA_DIR", "AGENT_WORKSPACE_ALLOWED_ROOTS", "AGENT_WORKSPACE_ACCESS_TOKEN", "PM_API_URL"] as const;
let previous: Record<string, string | undefined>;
let directory: string;
let originalFetch: typeof fetch;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "chat-fanout-"));
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(directory, "store");
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([directory]);
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = token;
  process.env.PM_API_URL = "http://127.0.0.1:1";
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Fanout unit tests must not call a real Provider or PM API."); };
});
afterEach(async () => {
  closeStore();
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  await rm(directory, { recursive: true, force: true });
});

function source(): ThreadMetadata {
  ensureThread("source", undefined, chatOnlyExecutionSelection(), chatOnlyEnvironment());
  return updateThread("source", { settings: { providerInstanceId: "original", model: "original-model", modelOptions: [{ id: "effort", value: "low" }],
    systemPrompt: "Keep the original system instructions", temperature: 0.4, interactionMode: "plan" } });
}
function body(): ChatFanoutRequest {
  return { operationId: randomUUID(), sourceThreadId: "source", message: { id: "source-user-message", role: "user", parts: [
    { type: "text", text: "Compare these results" }, { type: "file", mediaType: "image/png", filename: "sample.png", url: "data:image/png;base64,aGVsbG8=" },
  ] }, selections: [{ providerInstanceId: "provider-a", model: "model-a" }, { providerInstanceId: "provider-b", model: "model-b", modelOptions: [{ id: "effort", value: "high" }] }],
    messageId: "source-correlation" };
}
const hasCode = (code: string) => (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === code;
function fixture(overrides: Parameters<typeof createChatFanoutService>[0] = {}) {
  const submissions: { request: ChatRequest; headers: Headers }[] = [];
  const worktrees: ThreadMetadata[] = [];
  const initialized: string[] = [];
  const service = createChatFanoutService({
    authorizeSource: async () => {},
    initializeChild: async id => { initialized.push(id); return chatOnlyEnvironment(); },
    validateSelection: () => {},
    createWorktree: async thread => { worktrees.push(thread); },
    submit: async (request, headers, onAccepted) => {
      submissions.push({ request, headers });
      const generation = { id: randomUUID() };
      onAccepted(generation);
      return generation;
    },
    ...overrides,
  });
  return { service, submissions, worktrees, initialized };
}
async function post(input: unknown, authorization = `Bearer ${token}`): Promise<Response> {
  return app.request("http://localhost/api/chat/fanout", { method: "POST", headers: { host: "localhost", authorization, "content-type": "application/json" }, body: JSON.stringify(input) });
}

test("strict selections reject empty/over-limit lists, malformed IDs/options and unsupported fields", () => {
  const request = body();
  for (const selections of [[], Array.from({ length: 9 }, () => request.selections[0]), [{ providerInstanceId: " ", model: "a" }],
    [{ providerInstanceId: "a", model: "b", extra: true }], [{ providerInstanceId: "a", model: "b", modelOptions: [{ id: "effort", value: 3 }] }],
    [{ providerInstanceId: "a", model: "b", modelOptions: [{ id: "effort", value: "high" }, { id: "effort", value: "low" }] }]]) {
    assert.throws(() => parseChatFanoutRequest({ ...request, selections }));
  }
  for (const input of [null, [], { ...request, operationId: "not-a-uuid" }, { ...request, sourceThreadId: ".." }, { ...request, extra: true }])
    assert.throws(() => parseChatFanoutRequest(input));
  assert.equal(parseChatFanoutRequest({ ...request, selections: Array.from({ length: 8 }, (_, i) => ({ providerInstanceId: `p-${i}`, model: "m" })) }).selections.length, 8);
});

test("fanout only permits user text/file parts and explicitly rejects PM references, quotes and metadata", () => {
  const request = body();
  assert.deepEqual(parseChatFanoutRequest(request), request);
  for (const input of [{ ...request, pmReferences: [] }, { ...request, contextItems: [] },
    { ...request, message: { ...request.message, metadata: {} } },
    { ...request, message: { ...request.message, metadata: { custom: { quote: "quoted PM text" } } } }])
    assert.throws(() => parseChatFanoutRequest(input), hasCode("fanout_context_unsupported"));
  for (const message of [{ ...request.message, role: "assistant" }, { ...request.message, parts: [] },
    { ...request.message, parts: [{ type: "tool-pm", toolCallId: "x" }] },
    { ...request.message, parts: [{ type: "reasoning", text: "hidden" }] },
    { ...request.message, parts: [{ type: "text", text: "x", providerMetadata: {} }] },
    { ...request.message, parts: [{ type: "file", url: "/context-asset", mediaType: "text/plain", contextBinding: {} }] }])
    assert.throws(() => parseChatFanoutRequest({ ...request, message }));
});

test("deduplicates exact selections including reordered options, but preserves distinct model options", async () => {
  source();
  const request = body();
  const first = { providerInstanceId: "provider-a", model: "model-a", modelOptions: [{ id: "effort", value: "high" }, { id: "fast", value: true }] };
  request.selections = [first, { ...first, modelOptions: [...first.modelOptions].reverse() }, { ...first, modelOptions: [{ id: "effort", value: "low" }] }];
  const { service, submissions } = fixture();
  const result = await service(request);
  assert.equal(result.children.length, 2);
  assert.equal(submissions.length, 2);
  assert.equal(result.status, "created");
});

test("creates independent threads, copies only template settings and submits fresh message IDs with original content", async () => {
  const original = source();
  writeRecord("chat:threads", original.remoteId, { ...original, nativeSession: { provider: "codex", sessionId: "must-not-copy" }, custom: { private: true } });
  const request = body();
  const headers = new Headers({ authorization: `Bearer ${token}`, "x-test-source": "same-auth" });
  const { service, submissions, initialized, worktrees } = fixture();
  const result = await service(request, headers);
  assert.equal(result.status, "created");
  assert.equal(initialized.length, 2);
  assert.equal(worktrees.length, 0);
  assert.equal(new Set(result.children.map(child => child.threadId)).size, 2);
  assert.equal(new Set(submissions.map(entry => entry.request.messages[0]!.id)).size, 2);
  for (const [index, child] of result.children.entries()) {
    assert.match(child.threadId, /^[a-f0-9-]{36}$/);
    const thread = getThread(child.threadId)!;
    assert.deepEqual(thread.executionSelection, original.executionSelection);
    assert.deepEqual(thread.settings, { systemPrompt: original.settings.systemPrompt, temperature: original.settings.temperature, interactionMode: "plan", ...child.selection });
    assert.equal(thread.nativeSession, undefined);
    assert.equal(thread.custom, undefined);
    const submitted = submissions[index]!;
    assert.equal(submitted.headers, headers);
    assert.equal(submitted.request.id, child.threadId);
    assert.equal(submitted.request.idempotencyKey, request.operationId);
    assert.equal(submitted.request.config?.threadSettingsRevision, thread.revision);
    assert.equal(submitted.request.messageId, submitted.request.messages[0]!.id);
    assert.notEqual(submitted.request.messages[0]!.id, request.message.id);
    assert.equal(submitted.request.messages.length, 1);
    assert.deepEqual(submitted.request.messages[0]!.parts, request.message.parts);
    assert.notEqual(submitted.request.messages[0]!.parts, request.message.parts);
    assert.equal(submitted.request.messages[0]!.metadata, undefined);
    assert.equal(submitted.request.pmReferences, undefined);
    assert.equal(submitted.request.contextItems, undefined);
    assert.ok(child.generationId);
    assert.equal(child.error, undefined);
  }
  assert.equal(getThread("source")!.revision, original.revision);
  assert.equal(listThreads().length, 3);
});

test("operationId replay persists across service instances and store reopen without a second submission", async () => {
  source();
  const request = body();
  const first = fixture();
  const result = await first.service(request);
  assert.deepEqual(await first.service(request), result);
  closeStore();
  const second = fixture();
  assert.deepEqual(await second.service(request), result);
  assert.equal(first.submissions.length, 2);
  assert.equal(second.submissions.length, 0);
  const stored = readRecord<ChatFanoutResult & { fingerprint: string }>(namespace, request.operationId)!;
  assert.equal(stored.operationId, request.operationId);
  assert.equal(stored.sourceThreadId, "source");
  assert.match(stored.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(stored.createdAt));
  assert.equal("fingerprint" in result, false);
  assert.equal(namespacePolicy(namespace)?.backup, "retain");
  assert.equal(namespacePolicy(namespace)?.deletion, "identity");
  assert.deepEqual(inventoryPersistence(getDatabase()).blockers, []);
});

test("conflicting operation bodies return 409 identity conflict without further provider dispatch", async () => {
  source();
  const request = body();
  const { service, submissions } = fixture();
  await service(request);
  for (const changed of [{ ...request, sourceThreadId: "other" }, { ...request, messageId: "other" },
    { ...request, message: { ...request.message, parts: [{ type: "text", text: "changed prompt" }] } },
    { ...request, selections: [request.selections[0]] }])
    await assert.rejects(service(changed), hasCode("idempotency_conflict"));
  assert.equal(submissions.length, 2);
  assert.equal((await post({ ...request, messageId: "different" })).status, 409);
});

test("concurrent same-operation requests share one barrier; concurrent different bodies are rejected", async () => {
  source();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let authorizations = 0;
  const { service, submissions } = fixture({ authorizeSource: async () => { authorizations++; entered.resolve(); await release.promise; } });
  const request = body();
  const first = service(request);
  await entered.promise;
  const duplicate = service({ ...request });
  await assert.rejects(service({ ...request, messageId: "conflict" }), hasCode("idempotency_conflict"));
  release.resolve();
  const [one, two] = await Promise.all([first, duplicate]);
  assert.deepEqual(one, two);
  assert.equal(authorizations, 1);
  assert.equal(submissions.length, 2);
});

test("source must exist, be writable and have an initialized execution environment", async () => {
  const { service, submissions } = fixture();
  await assert.rejects(service(body()), hasCode("not_found"));
  source();
  const saved = getThread("source")!;
  for (const [patch, code] of [[{ status: "archived" }, "thread_archived"], [{ deletionState: "closing" }, "thread_closing"],
    [{ executionSelection: undefined }, "session_cutover_required"], [{ executionEnvironment: undefined }, "session_cutover_required"]] as const) {
    writeRecord("chat:threads", saved.remoteId, { ...saved, ...patch });
    await assert.rejects(service(body()), hasCode(code));
  }
  writeRecord("chat:threads", saved.remoteId, saved);
  const identity = getStoreIdentity(getDatabase());
  writeRecord(PERSISTENCE_NAMESPACE, "store", { ...identity, restoredThreads: { source: true } });
  await assert.rejects(service(body()), hasCode("restored_history_read_only"));
  assert.equal(submissions.length, 0);
  assert.equal(listRecords(namespace).length, 0);
  assert.equal(listThreads().length, 1);
});

test("source authorization failures and changes during asynchronous preflight create no child threads", async () => {
  source();
  const denied = fixture({ authorizeSource: async () => { throw new DurableError(403, "forbidden", "Source is forbidden"); } });
  await assert.rejects(denied.service(body()), hasCode("forbidden"));
  const changed = fixture({ authorizeSource: async () => { updateThread("source", { settings: { ...getThread("source")!.settings, temperature: 1 } }); } });
  await assert.rejects(changed.service(body()), hasCode("fanout_source_changed"));
  assert.equal(listThreads().length, 1);
  assert.equal(listRecords(namespace).length, 0);
});

test("a failed child records partial details and retains both inspectable threads without retrying", async () => {
  source();
  let calls = 0;
  const { service } = fixture({ submit: async (request, _headers, onAccepted) => {
    calls++;
    if (getThread(request.id)!.settings.providerInstanceId === "provider-b") throw new DurableError(412, "provider_not_ready", "Original provider not ready");
    const generation = { id: randomUUID() };
    onAccepted(generation);
    return generation;
  } });
  const request = body();
  const result = await service(request);
  assert.equal(result.status, "partial");
  assert.ok(result.children[0]!.generationId);
  assert.deepEqual(result.children[1]!.error, { code: "provider_not_ready", message: "Original provider not ready" });
  assert.equal(result.children[1]!.generationId, undefined);
  assert.ok(getThread(result.children[1]!.threadId));
  const response = await post(request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), result);
  assert.deepEqual(await service(request), result);
  assert.equal(calls, 2);
});

test("all rejected selections remain visible with failed status and no provider submissions", async () => {
  source();
  const { service, submissions } = fixture({ validateSelection: () => { throw Object.assign(new Error("private credential must not leak"), { code: "invalid_model" }); } });
  const request = body();
  const result = await service(request);
  assert.equal(result.status, "failed");
  assert.equal(result.children.length, 2);
  for (const child of result.children) {
    assert.ok(getThread(child.threadId));
    assert.equal(child.error?.code, "invalid_model");
    assert.doesNotMatch(child.error!.message, /private credential/);
  }
  assert.deepEqual(await service(request), result);
  assert.equal(submissions.length, 0);
});

test("runtime acceptance is persisted before the submit promise resolves and survives a later exception", async () => {
  source();
  const { service } = fixture({ submit: async (_request, _headers, onAccepted) => {
    const accepted = { id: randomUUID() };
    onAccepted(accepted);
    const record = listRecords<ChatFanoutResult>(namespace)[0]!;
    assert.ok(record.children.some(child => child.generationId === accepted.id));
    throw new DurableError(503, "post_acceptance_failure", "Accepted execution must be reconciled");
  } });
  const request = body();
  const result = await service(request);
  assert.equal(result.status, "partial");
  for (const child of result.children) {
    assert.ok(child.generationId);
    assert.equal(child.error?.code, "post_acceptance_failure");
  }
  assert.deepEqual(await service(request), result);
});

test("interrupted durable reservations are replay-only even when no generation was confirmed", async () => {
  source();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<ExecutionEnvironment>();
  const first = fixture({ initializeChild: async () => { entered.resolve(); return release.promise; } });
  const request = body();
  const pending = first.service(request);
  await entered.promise;
  const interrupted = readRecord<ChatFanoutResult & { fingerprint: string }>(namespace, request.operationId)!;
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.children.length, 2);
  for (const child of interrupted.children) {
    assert.ok(getThread(child.threadId));
    assert.equal(child.error?.code, "fanout_incomplete");
  }
  release.resolve(chatOnlyEnvironment());
  await pending;
  // Model a stopped-process snapshot taken before either admission completed.
  writeRecord(namespace, request.operationId, interrupted);
  closeStore();
  const replay = fixture();
  const result = await replay.service(request);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.children, interrupted.children);
  assert.equal(replay.submissions.length, 0);
  assert.equal(replay.initialized.length, 0);
});

test("workspace children use separate real Git worktrees while source files remain untouched", async () => {
  const root = path.join(directory, "repository");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Fanout Test");
  await git(root, "config", "user.email", "fanout@example.invalid");
  await writeFile(path.join(root, "base.txt"), "committed base\n");
  await git(root, "add", "base.txt");
  await git(root, "commit", "-m", "synthetic fanout fixture");
  await writeFile(path.join(root, "base.txt"), "user uncommitted source\n");
  const workspace = openAgentWorkspace({ path: root });
  const selection = { version: 2 as const, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  const environment = (await resolveAgentExecution(selection, "source")).environment;
  source();
  updateThread("source", { executionSelection: selection, executionEnvironment: environment });
  let calls = 0;
  const service = createChatFanoutService({ validateSelection: () => {}, submit: async (request, _headers, accepted) => {
    calls++;
    const receipt = readChatWorktree(request.id)!;
    assert.ok(receipt);
    assert.equal(getThread(request.id)!.executionEnvironment?.executionPath, receipt.directory);
    const generation = { id: randomUUID() };
    accepted(generation);
    return generation;
  } });
  const request = body();
  const result = await service(request);
  assert.equal(result.status, "created");
  const receipts = result.children.map(child => readChatWorktree(child.threadId)!);
  assert.equal(new Set(receipts.map(receipt => receipt.directory)).size, 2);
  assert.equal(new Set(receipts.map(receipt => receipt.branch)).size, 2);
  for (const receipt of receipts) assert.equal(await readFile(path.join(receipt.directory, "base.txt"), "utf8"), "committed base\n");
  assert.equal(await readFile(path.join(root, "base.txt"), "utf8"), "user uncommitted source\n");
  assert.deepEqual(await service(request), result);
  assert.equal(calls, 2);
});

test("worktree failure retains the failed child and skips only its provider submission", async () => {
  const saved = source();
  const selection = { version: 2 as const, agentWorkspaceId: "test-workspace", agentWorkspaceRevision: 1 };
  writeRecord("chat:threads", saved.remoteId, { ...saved, executionSelection: selection });
  const worktrees: string[] = [];
  const { service, submissions } = fixture({ createWorktree: async thread => {
    worktrees.push(thread.remoteId);
    if (thread.settings.providerInstanceId === "provider-b") throw new DurableError(409, "worktree_create_failed", "Original worktree failed; inspect its receipt");
  } });
  const request = body();
  const result = await service(request);
  assert.equal(result.status, "partial");
  assert.equal(worktrees.length, 2);
  assert.equal(submissions.length, 1);
  assert.ok(getThread(result.children[1]!.threadId));
  assert.equal(result.children[1]!.error?.code, "worktree_create_failed");
  assert.deepEqual(await service(request), result);
  assert.equal(worktrees.length, 2);
});

test("route preserves existing authentication and returns explicit validation/source error statuses", async () => {
  assert.equal((await post(body(), "")).status, 401);
  assert.equal((await post({ ...body(), pmReferences: [] })).status, 400);
  const rejected = await post({ ...body(), message: { ...body().message, metadata: { quote: "no" } } });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json() as { code: string }).code, "fanout_context_unsupported");
  assert.equal((await post(body())).status, 404);
  source();
  const saved = getThread("source")!;
  writeRecord("chat:threads", saved.remoteId, { ...saved, status: "archived" });
  assert.equal((await post(body())).status, 409);
  writeRecord("chat:threads", saved.remoteId, { ...saved, executionEnvironment: undefined });
  assert.equal((await post(body())).status, 412);
});
