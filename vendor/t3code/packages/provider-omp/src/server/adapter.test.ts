import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import {
  MessageId, NodeId, ProjectId, ProviderInstanceId, ProviderSessionId, RunAttemptId, RunId, ThreadId,
  type OrchestrationV2AppThread, type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderRuntimeHost, type ProviderRuntimeHostBinding } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeOmpAdapterV2, assertOmpPromptIsSafe } from "./adapter.ts";
import { OmpSettings } from "../settings.ts";
import { readOmpSessionEvidence } from "./sessionEvidence.ts";
import { OmpRpcError, type OmpRpcConnection, type OmpRpcRecord, type OmpRpcSpawnOptions } from "./rpc.ts";
import type * as RpcModule from "./rpc.ts";

// This is a controlled wire producer, not native/model acceptance evidence.
// ACK/result/settled shapes follow recordings from real 18.13.2 in
// .local/evidence/omp-provider/native-18.13.2-controlled-stream.jsonl and
// native-18.13.2-local-command-and-model-error.jsonl (Main's isolated replay).
const rpc = vi.hoisted(() => ({ create: undefined as unknown }));
vi.mock("./rpc.ts", async importOriginal => ({
  ...await importOriginal<typeof RpcModule>(),
  makeOmpRpcConnection: (options: OmpRpcSpawnOptions) => (rpc.create as (options: OmpRpcSpawnOptions) => Effect.Effect<OmpRpcConnection>)(options),
}));

const instanceId = ProviderInstanceId.make("omp-test");
const threadId = ThreadId.make("omp-thread");
const sessionId = ProviderSessionId.make("omp-session");
const modelSelection = { instanceId, model: "fixture/model", options: [{ id: "thinking", value: "xhigh" }] };
const layer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)));

const harness = Effect.fnUntraced(function* (pmBridge?: string, technical = false) {
  const fs = yield* FileSystem.FileSystem;
  const host = yield* ProviderHost.ProviderHost;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "omp-adapter-test-" });
  const cwd = `${home}/workspace`;
  const sessions = `${home}/.omp/agent/sessions`;
  const directory = `${sessions}/workspace`;
  yield* fs.makeDirectory(cwd, { recursive: true });
  yield* fs.makeDirectory(directory, { recursive: true });
  let file = `${directory}/native.jsonl`;
  let nativeId = "native-session";
  const writeHeader = () => fs.writeFileString(file, `${JSON.stringify({ type: "title", v: 1, title: "", pad: "" })}\n${JSON.stringify({ type: "session", version: 3, id: nativeId, cwd })}\n`);
  yield* writeHeader();
  const sourceFile = file;
  const incoming = yield* Queue.unbounded<OmpRpcRecord, OmpRpcError>();
  const outgoing = yield* Queue.unbounded<OmpRpcRecord>();
  const requests = yield* Queue.unbounded<OmpRpcRecord>();
  const observed: OmpRpcRecord[] = [];
  const entries: OmpRpcRecord[] = [];
  let streaming = false, settled = true, pendingAsync = false;
  let gateTitle = "";
  let contextPath = "";
  let live = true;
  let spawnedArgs: ReadonlyArray<string> = [];
  let binding: ProviderRuntimeHostBinding = { providerInstanceId: instanceId, threadId, executionId: "execution-1", cwd,
    mcpServers: pmBridge ? [{ name: "pm_tools", transport: "stdio", command: "node", args: ["bridge.mjs", pmBridge, "mcp"] }] : [],
    nativePermissions: "deny-ungranted", instructionText: "PM instructions",
    ...(technical ? { promptAuthorization: "technical-no-tools" as const } : {}) };
  const authorized: string[] = [];
  const runtimeHost = ProviderRuntimeHost.of({ bind: () => Effect.void, read: () => Effect.sync(() => technical && !live ? undefined : binding),
    authorize: request => Effect.suspend(() => {
      authorized.push(request.executionId);
      return !technical && live && request.executionId === binding.executionId ? Effect.void : Effect.fail(new Error("Execution revoked or no Chat callback"));
    }) });
  const state = () => ({ sessionFile: file, sessionId: nativeId, isStreaming: streaming, isCompacting: false,
    isSettled: settled, hasPendingAsyncWork: pendingAsync, queuedMessageCount: 0,
    model: { provider: "fixture", id: "model", contextWindow: 8192 }, thinkingLevel: "xhigh" });
  const exited = yield* Deferred.make<number>();
  rpc.create = (options: OmpRpcSpawnOptions) => Effect.gen(function* () {
    spawnedArgs = options.args;
    const index = options.args.indexOf("--trusted-extension");
    assert.isTrue(index >= 0);
    const source = yield* fs.readFileString(options.args[index + 1]!);
    gateTitle = JSON.parse(/const title = (.*);/.exec(source)![1]!) as string;
    contextPath = JSON.parse(/const contextPath = (.*);/.exec(source)![1]!) as string;
    const prefix = JSON.parse(/const ready = (.*);/.exec(source)![1]!) as string;
    yield* Queue.offer(incoming, { type: "extension_ui_request", method: "notify", id: "ready",
      message: prefix + JSON.stringify({ version: 1, homeDirectory: home, cwd, sessionDirectory: directory, sessionId: nativeId, sessionFile: file, profile: "" }) });
    return {
      events: incoming,
      send: frame => Queue.offer(outgoing, frame).pipe(Effect.asVoid),
      request: record => Effect.gen(function* () {
        observed.push(record); yield* Queue.offer(requests, record);
        switch (record.type) {
          case "get_state": return state();
          case "get_entries": return { entries, leafId: entries.at(-1)?.id ?? null };
          case "get_messages": return { messages: entries.filter(entry => entry.type === "message").map(entry => entry.message) };
          case "get_messages_page": {
            const messages = entries.filter(entry => entry.type === "message").map(entry => entry.message);
            return { messages, totalMessages: messages.length };
          }
          case "set_model": return { provider: record.provider, id: record.modelId, contextWindow: 8192 };
          case "set_thinking_level": return undefined;
          case "set_host_tools": return { toolNames: (record.tools as OmpRpcRecord[]).map(tool => tool.name) };
          case "prompt":
            if (record.message === "/session") {
              yield* Queue.offer(incoming, { type: "command_output", text: "Session: native-session" });
              return { agentInvoked: false };
            }
            streaming = true; settled = false; return undefined;
          case "abort": return undefined;
          case "switch_session": file = String(record.sessionPath); return { cancelled: false };
          case "new_session": nativeId += "-new"; file = `${directory}/${nativeId}.jsonl`; entries.length = 0; yield* writeHeader(); return { cancelled: false };
          default: return {};
        }
      }).pipe(Effect.orDie),
      exited: Deferred.await(exited),
      terminate: Effect.gen(function* () {
        yield* Deferred.succeed(exited, 0);
        yield* Queue.fail(incoming, new OmpRpcError({ operation: "stdout", detail: "Controlled process stopped" }));
      }),
    } satisfies OmpRpcConnection;
  });
  const adapter = yield* makeOmpAdapterV2({ instanceId, settings: Schema.decodeSync(OmpSettings)({}), environment: { HOME: home } }).pipe(
    Effect.provideService(ProviderRuntimeHost, runtimeHost), Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(ProviderHost.ProviderHost, { ...host, paths: { ...host.paths, cwd } }));
  const policy = { runtimeMode: "approval-required" as const, interactionMode: "default" as const, cwd, approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" } };
  const runtime = yield* adapter.openSession({ threadId, providerSessionId: sessionId, modelSelection, runtimePolicy: policy });
  const rows = yield* Queue.unbounded<Adapter.ProviderAdapterV2Event>();
  yield* Stream.runForEach(runtime.events, event => Queue.offer(rows, event)).pipe(Effect.forkScoped);
  const takeEvent = (type: Adapter.ProviderAdapterV2Event["type"]) => Effect.gen(function* () {
    for (;;) { const row = yield* Queue.take(rows); if (row.type === type) return row; }
  });
  const takeRequest = (type: string) => Effect.gen(function* () {
    for (;;) { const row = yield* Queue.take(requests); if (row.type === type) return row; }
  });
  const takeOutgoing = () => Queue.take(outgoing);
  const appendMessage = (message: unknown) => Effect.gen(function* () {
    const entry = { type: "message", id: `entry-${entries.length}`, parentId: entries.at(-1)?.id ?? null,
      runtime: { version: "18.13.2" }, message };
    entries.push(entry);
    yield* fs.writeFileString(file, `${JSON.stringify(entry)}\n`, { flag: "a" });
  });
  const appendMetadata = (metadata: OmpRpcRecord) => Effect.gen(function* () {
    const entry = { ...metadata, id: `entry-${entries.length}`, parentId: entries.at(-1)?.id ?? null, runtime: { version: "18.13.2" } };
    entries.push(entry);
    yield* fs.writeFileString(file, `${JSON.stringify(entry)}\n`, { flag: "a" });
  });
  const emit = (frame: OmpRpcRecord) => Effect.gen(function* () {
    if (frame.type === "prompt_result") {
      streaming = false; settled = frame.sessionSettled === true; pendingAsync = !settled;
    }
    if (frame.type === "session_settled") { streaming = false; settled = true; pendingAsync = false; }
    if (frame.type === "message_end") yield* appendMessage(frame.message);
    yield* Queue.offer(incoming, frame);
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy: policy });
  const start = (text = "Hello", ordinal = 1, provider: OrchestrationV2ProviderThread = providerThread) => Effect.gen(function* () {
    const now = yield* DateTime.now;
    const appThread: OrchestrationV2AppThread = { id: threadId, title: "OMP test", projectId: ProjectId.make("omp-project"), providerInstanceId: instanceId,
      modelSelection, runtimeMode: "approval-required", interactionMode: "default", branch: null, worktreePath: null, activeProviderThreadId: provider.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }, forkedFrom: null,
      createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now, archivedAt: null, settledOverride: null,
      settledAt: null, lastVisitedAt: null, deletedAt: null };
    yield* runtime.startTurn({ appThread, threadId, runId: RunId.make(`run-${ordinal}`), runOrdinal: ordinal, providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`attempt-${ordinal}`), rootNodeId: NodeId.make(`root-${ordinal}`), providerThread: provider,
      message: { messageId: MessageId.make(`user-${ordinal}`), text, attachments: [], createdBy: "user", creationSource: "web" },
      modelSelection, runtimePolicy: policy });
    return yield* takeRequest("prompt");
  });
  const gateRequest = (id: string, tool = "bash") => ({ type: "extension_ui_request", id, method: "confirm", title: gateTitle,
    message: JSON.stringify({ agentKind: "main", toolName: tool, toolCallId: id, input: { command: "printf safe" }, sessionFile: file, sessionId: nativeId }) });
  const nativeApprovalRequest = (id: string, tool: string) => ({ type: "extension_ui_request", id: `native:${id}`, method: "notify",
    message: gateTitle + ":native-approval:" + JSON.stringify({ agentKind: "main", toolName: tool, toolCallId: id,
      sessionId: nativeId, sessionFile: file, approvalMode: "always-ask" }) });
  return { adapter, runtime, providerThread, start, emit, takeEvent, takeOutgoing, takeRequest, observed, sourceFile, cwd, home, contextPath,
    gateRequest, nativeApprovalRequest, appendExternal: appendMessage, appendMetadata, authorized, spawnedArgs,
    disconnect: Queue.fail(incoming, new OmpRpcError({ operation: "stdout", detail: "Controlled stdout closed" })), revoke: () => { live = false; },
    replaceBinding: () => { binding = { ...binding, executionId: "execution-2" }; } };
});

describe("OMP supervised adapter lifecycle", () => {
  it.effect("replays recorded 18.13.2 streaming without duplicating deltas and agrees with native history", () => Effect.gen(function* () {
    const recorded = readFileSync(new URL("./fixtures/native-18.13.2-stream.jsonl", import.meta.url), "utf8")
      .trim().split("\n").slice(1).map(line => JSON.parse(line) as { direction: string; frame: OmpRpcRecord });
    const h = yield* harness();
    const prompt = yield* h.start(String(recorded[0]!.frame.message));
    for (const row of recorded) if (row.direction === "out" && row.frame.type !== "response") {
      // Only the request correlation is rebound; payloads/timing order remain recorded.
      yield* h.emit(row.frame.type === "prompt_result" ? { ...row.frame, id: prompt.id } : row.frame);
    }
    let message = yield* h.takeEvent("message.updated");
    while (message.type === "message.updated" && message.message.streaming) message = yield* h.takeEvent("message.updated");
    assert.equal(message.type === "message.updated" && message.message.text, "OMP_CONTROLLED_STREAM: 17 + 25 = 42.");
    const terminal = yield* h.takeEvent("turn.terminal");
    assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
    const snapshot = yield* h.runtime.readThreadSnapshot({ providerThread: h.providerThread });
    assert.equal(snapshot.messages.at(-1)?.text, "OMP_CONTROLLED_STREAM: 17 + 25 = 42.");
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("completes native local-only commands without waiting for nonexistent terminals", () => Effect.gen(function* () {
    const h = yield* harness();
    yield* h.start("/session");
    const terminal = yield* h.takeEvent("turn.terminal");
    assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
    assert.isFalse(yield* h.runtime.hasPendingBackgroundWork!);
    assert.isTrue(h.observed.some(record => record.type === "set_thinking_level" && record.level === "xhigh"));
    assert.isFalse((yield* h.adapter.getCapabilities()).threads.canForkThread);
    assert.isTrue((yield* Effect.result(h.runtime.forkThread({ sourceProviderThread: h.providerThread, targetThreadId: ThreadId.make("target") })))._tag === "Failure");
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("preserves streamed text/thinking/tools and waits through background work for root settlement", () => Effect.gen(function* () {
    const h = yield* harness(); const prompt = yield* h.start();
    const message = { role: "assistant", content: [{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "Answer" }],
      stopReason: "stop", usage: { input: 16, output: 12, cacheRead: 2, cacheWrite: 1, totalTokens: 31 } };
    yield* h.emit({ type: "message_start", message: { ...message, content: [] } });
    yield* h.emit({ type: "message_update", message });
    yield* h.emit({ type: "message_end", message });
    yield* h.emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "file.ts" } });
    yield* h.emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "actual tool output" }] } });
    yield* h.emit({ type: "prompt_result", id: "wrong-root", status: "completed", sessionSettled: true });
    yield* h.emit({ type: "prompt_result", id: prompt.id, status: "completed", sessionSettled: false });
    // Queue round-trip is an ordering barrier, not a timer-based assumption.
    yield* h.emit({ type: "extension_ui_request", id: "background-ask", method: "input", title: "Continue?" });
    const request = yield* h.takeEvent("runtime_request.updated");
    assert.isTrue(yield* h.runtime.hasPendingBackgroundWork!);
    assert.equal(request.type === "runtime_request.updated" && request.runtimeRequest.kind, "user_input");
    yield* h.emit({ type: "session_settled" });
    const terminal = yield* h.takeEvent("turn.terminal");
    assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
    const snapshot = yield* h.runtime.readThreadSnapshot({ providerThread: h.providerThread });
    assert.equal(snapshot.messages.at(-1)?.text, "Answer");
    assert.equal(snapshot.nativeHistory?.latestCompletedTurnRef?.nativeId, "entry-0");
    assert.equal((yield* readOmpSessionEvidence(h.runtime)!.probe).homeDirectory, h.home);
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("keeps provider errors failed even when session_settled follows", () => Effect.gen(function* () {
    const h = yield* harness(); const prompt = yield* h.start();
    yield* h.emit({ type: "prompt_result", id: prompt.id, agentInvoked: true, status: "error", sessionSettled: false,
      error: { message: "404 404 page not found", retryable: false, httpStatus: 404 } });
    yield* h.emit({ type: "session_settled" });
    const terminal = yield* h.takeEvent("turn.terminal");
    assert.equal(terminal.type === "turn.terminal" && terminal.status, "failed");
    assert.equal(terminal.type === "turn.terminal" && terminal.failure?.message, "404 404 page not found");
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("separates questions from per-call approvals and rejects late generation replies", () => Effect.gen(function* () {
    const h = yield* harness(); const prompt = yield* h.start();
    yield* h.emit(h.gateRequest("grant-1"));
    const grant = yield* h.takeEvent("runtime_request.updated");
    assert.equal(grant.type === "runtime_request.updated" && grant.runtimeRequest.kind, "command");
    if (grant.type !== "runtime_request.updated") return;
    const wrong = yield* Effect.result(h.runtime.respondToRuntimeRequest({ requestId: grant.runtimeRequest.id, answers: { "grant-1": "Yes" } }));
    assert.equal(wrong._tag, "Failure");
    yield* h.runtime.respondToRuntimeRequest({ requestId: grant.runtimeRequest.id, decision: "decline" });
    assert.equal((yield* h.takeOutgoing()).confirmed, false);
    yield* h.emit({ type: "extension_ui_request", id: "ask-1", method: "ask", questions: [{ id: "database", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] }] });
    let ask = yield* h.takeEvent("runtime_request.updated");
    if (ask.type === "runtime_request.updated" && ask.runtimeRequest.status !== "pending") ask = yield* h.takeEvent("runtime_request.updated");
    if (ask.type !== "runtime_request.updated") return;
    assert.equal(ask.runtimeRequest.kind, "user_input");
    yield* h.runtime.respondToRuntimeRequest({ requestId: ask.runtimeRequest.id, answers: { database: "SQLite" } });
    assert.deepEqual((yield* h.takeOutgoing()).answers, [{ id: "database", selectedOptions: ["SQLite"] }]);
    yield* h.emit({ type: "prompt_result", id: prompt.id, status: "completed", sessionSettled: true });
    yield* h.takeEvent("turn.terminal");
    yield* h.start("Next", 2);
    assert.equal((yield* Effect.result(h.runtime.respondToRuntimeRequest({ requestId: grant.runtimeRequest.id, decision: "accept" })))._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("captures execution identity and fails closed when a replacement binding answers an old request", () => Effect.gen(function* () {
    const h = yield* harness(); yield* h.start(); yield* h.emit(h.gateRequest("grant-old"));
    const grant = yield* h.takeEvent("runtime_request.updated");
    if (grant.type !== "runtime_request.updated") return;
    h.replaceBinding();
    assert.equal((yield* Effect.result(h.runtime.respondToRuntimeRequest({ requestId: grant.runtimeRequest.id, decision: "accept" })))._tag, "Failure");
    assert.equal(h.authorized.at(-1), "execution-1");
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("does not mistake a recovered native retry attempt for the prompt's final failure", () => Effect.gen(function* () {
    const h = yield* harness(); const prompt = yield* h.start();
    yield* h.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    yield* h.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Transient attempt" } });
    yield* h.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    yield* h.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Recovered" }], stopReason: "stop" } });
    yield* h.emit({ type: "prompt_result", id: prompt.id, status: "completed", sessionSettled: true });
    const terminal = yield* h.takeEvent("turn.terminal");
    assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("cancels unsupported/secret UI and rejects a native-cancelled request reply", () => Effect.gen(function* () {
    const h = yield* harness(); yield* h.start();
    yield* h.emit({ type: "extension_ui_request", id: "unknown-ui", method: "custom" });
    assert.deepEqual(yield* h.takeOutgoing(), { type: "extension_ui_response", id: "unknown-ui", cancelled: true });
    yield* h.emit({ type: "extension_ui_request", id: "secret-ui", method: "input", secret: true, title: "Secret" });
    assert.deepEqual(yield* h.takeOutgoing(), { type: "extension_ui_response", id: "secret-ui", cancelled: true });
    yield* h.emit({ type: "extension_ui_request", id: "ordinary", method: "confirm", title: "Continue?", message: "An information question" });
    const question = yield* h.takeEvent("runtime_request.updated");
    if (question.type !== "runtime_request.updated") return;
    assert.equal(question.runtimeRequest.kind, "user_input");
    yield* h.emit({ type: "extension_ui_request", id: "cancel-frame", method: "cancel", targetId: "ordinary" });
    yield* h.takeEvent("runtime_request.updated");
    assert.equal((yield* Effect.result(h.runtime.respondToRuntimeRequest({ requestId: question.runtimeRequest.id, answers: { ordinary: "Yes" } })))._tag, "Failure");
    yield* h.emit({ type: "extension_ui_request", id: "user-cancel", method: "input", title: "Optional note" });
    const cancellable = yield* h.takeEvent("runtime_request.updated");
    if (cancellable.type !== "runtime_request.updated") return;
    yield* h.runtime.respondToRuntimeRequest({ requestId: cancellable.runtimeRequest.id, decision: "cancel" });
    assert.deepEqual(yield* h.takeOutgoing(), { type: "extension_ui_response", id: "user-cancel", cancelled: true });
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("fails a live root when its stream ends without prompt completion", () => Effect.gen(function* () {
    const h = yield* harness(); yield* h.start(); yield* h.disconnect;
    const terminal = yield* h.takeEvent("turn.terminal");
    assert.equal(terminal.type === "turn.terminal" && terminal.status, "failed");
    assert.equal(terminal.type === "turn.terminal" && terminal.threadDisposition, "broken");
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("abort ACK does not become completed; waits for native aborted settlement", () => Effect.gen(function* () {
    const h = yield* harness(); const prompt = yield* h.start();
    const started = yield* h.takeEvent("provider_turn.updated");
    if (started.type !== "provider_turn.updated") return;
    yield* h.runtime.interruptTurn({ providerThread: h.providerThread, providerTurnId: started.providerTurn.id });
    yield* h.takeRequest("abort");
    yield* h.emit({ type: "prompt_result", id: prompt.id, status: "aborted", sessionSettled: true });
    const terminal = yield* h.takeEvent("turn.terminal");
    assert.equal(terminal.type === "turn.terminal" && terminal.status, "interrupted");
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("restores native header/tree evidence and rejects cross-cwd source metadata", () => Effect.gen(function* () {
    const h = yield* harness(); const prompt = yield* h.start();
    yield* h.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    yield* h.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Remembered" }], stopReason: "stop" } });
    yield* h.emit({ type: "prompt_result", id: prompt.id, status: "completed", sessionSettled: true });
    yield* h.takeEvent("turn.terminal");
    const evidence = readOmpSessionEvidence(h.runtime)!;
    const snapshot = yield* evidence.readLegacy({ nativeSessionId: h.sourceFile, turnId: "entry-0", messageId: "entry-0",
      ensure: { threadId, modelSelection, runtimePolicy: { runtimeMode: "approval-required", interactionMode: "default", cwd: h.cwd } } });
    assert.equal(snapshot.messages.at(-1)?.text, "Remembered");
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${h.home}/.omp/agent/sessions/foreign.jsonl`, JSON.stringify({ type: "session", version: 3, id: "foreign", cwd: h.home }) + "\n");
    assert.equal((yield* Effect.result(evidence.readLegacy({ nativeSessionId: `${h.home}/.omp/agent/sessions/foreign.jsonl`,
      ensure: { threadId, modelSelection, runtimePolicy: { runtimeMode: "approval-required", interactionMode: "default", cwd: h.cwd } } })))._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("passes the stock always-ask stage only for an exact live PM host admission", () => Effect.gen(function* () {
    const calls: unknown[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/tools/list")) return new Response(JSON.stringify({ tools: [{ name: "pm_inspect", description: "Inspect PM state",
        inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }] }));
      if (typeof init?.body !== "string") throw new Error("Invalid controlled bridge request");
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ status: "pending_approval", operationId: "bridge-owned-operation", result: null }));
    });
    try {
      const h = yield* harness("http://127.0.0.1:1");
      const prompt = yield* h.start();
      yield* h.emit(h.gateRequest("pm-call-1", "pm_inspect"));
      assert.equal((yield* h.takeOutgoing()).confirmed, true);
      // Faithfully include ExtensionToolWrapper's second approval stage;
      // the first hook grant alone does not produce a host_tool_call.
      yield* h.emit(h.nativeApprovalRequest("pm-call-1", "pm_inspect"));
      yield* h.emit({ type: "extension_ui_request", id: "stock-pm", method: "select",
        title: "Allow tool: pm_inspect\nArguments:\n  command: printf safe", options: ["Approve", "Approve pm_inspect for this session", "Deny"] });
      assert.deepEqual(yield* h.takeOutgoing(), { type: "extension_ui_response", id: "stock-pm", value: "Approve" });
      yield* h.emit({ type: "host_tool_call", id: "host-pm-1", toolCallId: "pm-call-1", toolName: "pm_inspect", arguments: { command: "printf safe" } });
      const result = yield* h.takeOutgoing();
      assert.equal(result.type, "host_tool_result");
      assert.deepEqual(result.result, { content: [{ type: "text", text: JSON.stringify({ status: "pending_approval", operationId: "bridge-owned-operation", result: null }) }],
        details: { status: "pending_approval", operationId: "bridge-owned-operation", result: null } });
      yield* h.emit({ type: "host_tool_call", id: "replay-pm", toolCallId: "pm-call-1", toolName: "pm_inspect", arguments: { command: "printf safe" } });
      assert.equal((yield* h.takeOutgoing()).isError, true);
      assert.equal(calls.length, 1);
      yield* h.emit({ type: "extension_ui_request", id: "stock-native", method: "select",
        title: "Allow tool: bash\nCommand: printf unsafe", options: ["Approve", "Deny"] });
      const denied = yield* h.takeEvent("runtime_request.updated");
      if (denied.type !== "runtime_request.updated") return;
      assert.equal(denied.runtimeRequest.kind, "permission");
      yield* h.runtime.respondToRuntimeRequest({ requestId: denied.runtimeRequest.id, decision: "decline" });
      assert.equal((yield* h.takeOutgoing()).value, "Deny");
      yield* h.emit({ type: "prompt_result", id: prompt.id, status: "completed", sessionSettled: true });
      yield* h.takeEvent("turn.terminal");
    } finally { fetch.mockRestore(); }
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("refuses same-file restored history that advanced beyond its saved strong head", () => Effect.gen(function* () {
    const h = yield* harness(); const prompt = yield* h.start();
    yield* h.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    yield* h.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Saved head" }], stopReason: "stop" } });
    yield* h.emit({ type: "prompt_result", id: prompt.id, status: "completed", sessionSettled: true });
    yield* h.takeEvent("turn.terminal");
    const saved = yield* h.runtime.readThreadSnapshot({ providerThread: h.providerThread });
    assert.equal(saved.providerThread.nativeConversationHeadRef?.nativeId, "entry-0");
    yield* h.appendExternal({ role: "assistant", content: [{ type: "text", text: "Unseen external CLI message" }], stopReason: "stop" });
    const promptsBefore = h.observed.filter(record => record.type === "prompt").length;
    assert.equal((yield* Effect.result(h.runtime.resumeThread({ providerThread: saved.providerThread })))._tag, "Failure");
    assert.equal(h.observed.filter(record => record.type === "prompt").length, promptsBefore);
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("restores the same conversational head through stock restart metadata but rejects a later unseen message", () => Effect.gen(function* () {
    const h = yield* harness(); const prompt = yield* h.start();
    yield* h.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    yield* h.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Saved native answer" }], stopReason: "stop" } });
    yield* h.emit({ type: "prompt_result", id: prompt.id, status: "completed", sessionSettled: true });
    yield* h.takeEvent("turn.terminal");
    const saved = yield* h.runtime.readThreadSnapshot({ providerThread: h.providerThread });
    const sourceHead = saved.providerThread.nativeConversationHeadRef?.nativeId;
    // Real 18.13.2 host restart evidence: assistant 35dbbddb was followed
    // only by normal dispose exits c972a7a4 and 10e329db, not new messages.
    yield* h.appendMetadata({ type: "custom", customType: "session_exit", data: {
      reason: "dispose", kind: "normal", recordedAt: "2026-10-31T06:15:28.486Z" } });
    yield* h.appendMetadata({ type: "custom", customType: "session_exit", data: {
      reason: "dispose", kind: "normal", recordedAt: "2026-10-31T06:15:29.888Z" } });
    yield* h.appendMetadata({ type: "model_change", model: "fixture/model", role: "default" });
    yield* h.appendMetadata({ type: "thinking_level_change", thinkingLevel: "xhigh", configured: "xhigh" });
    const resumed = yield* h.runtime.resumeThread({ providerThread: saved.providerThread });
    assert.equal(resumed.nativeThreadRef?.nativeId, h.sourceFile);
    assert.equal(saved.providerThread.nativeConversationHeadRef?.nativeId, sourceHead);
    const legacy = yield* readOmpSessionEvidence(h.runtime)!.readLegacy({ nativeSessionId: h.sourceFile, turnId: "entry-0", messageId: "entry-0",
      ensure: { threadId, modelSelection, runtimePolicy: { runtimeMode: "approval-required", interactionMode: "default", cwd: h.cwd } } });
    assert.equal(legacy.messages.at(-1)?.text, "Saved native answer");
    assert.deepEqual(legacy.providerThread.nativeConversationHeadRef, saved.providerThread.nativeConversationHeadRef);
    assert.equal(legacy.nativeHistory?.latestCompletedTurnRef?.nativeId, "entry-0");
    const legacyResumed = yield* h.runtime.resumeThread({ providerThread: legacy.providerThread });
    assert.deepEqual(legacyResumed.nativeConversationHeadRef, saved.providerThread.nativeConversationHeadRef);
    yield* h.appendExternal({ role: "user", content: [{ type: "text", text: "Unseen external prompt" }] });
    assert.equal((yield* Effect.result(h.runtime.resumeThread({ providerThread: saved.providerThread })))._tag, "Failure");
    assert.equal((yield* Effect.result(readOmpSessionEvidence(h.runtime)!.readLegacy({ nativeSessionId: h.sourceFile,
      turnId: "entry-0", messageId: "entry-0", ensure: { threadId, modelSelection,
        runtimePolicy: { runtimeMode: "approval-required", interactionMode: "default", cwd: h.cwd } } })))._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("runs explicitly marked technical model/questions with --no-tools and no Chat callback", () => Effect.gen(function* () {
    const h = yield* harness(undefined, true);
    assert.isTrue(h.spawnedArgs.includes("--no-tools"));
    const prompt = yield* h.start();
    yield* h.emit({ type: "extension_ui_request", id: "technical-question", method: "input", title: "Clarify text" });
    const question = yield* h.takeEvent("runtime_request.updated");
    if (question.type !== "runtime_request.updated") return;
    assert.equal(question.runtimeRequest.kind, "user_input");
    yield* h.runtime.respondToRuntimeRequest({ requestId: question.runtimeRequest.id, answers: { "technical-question": "Model-only" } });
    assert.equal((yield* h.takeOutgoing()).value, "Model-only");
    yield* h.emit({ type: "prompt_result", id: prompt.id, status: "completed", sessionSettled: true });
    const terminal = yield* h.takeEvent("turn.terminal");
    assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
    assert.equal(h.authorized.length, 0);
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("never falls back to technical mode when a no-PM-tools Chat authorization is revoked", () => Effect.gen(function* () {
    const h = yield* harness();
    assert.isFalse(h.spawnedArgs.includes("--no-tools"));
    h.revoke();
    assert.equal((yield* Effect.result(h.start()))._tag, "Failure");
    assert.equal(h.observed.filter(record => record.type === "prompt").length, 0);
    assert.equal(h.authorized.at(-1), "execution-1");
  }).pipe(Effect.scoped, Effect.provide(layer)));

  it.effect("rejects a late technical question response after its live binding disappears", () => Effect.gen(function* () {
    const h = yield* harness(undefined, true);
    yield* h.start();
    yield* h.emit({ type: "extension_ui_request", id: "technical-late", method: "input", title: "Clarify" });
    const question = yield* h.takeEvent("runtime_request.updated");
    if (question.type !== "runtime_request.updated") return;
    h.revoke();
    assert.equal((yield* Effect.result(h.runtime.respondToRuntimeRequest({ requestId: question.runtimeRequest.id,
      answers: { "technical-late": "Late" } })))._tag, "Failure");
    assert.equal(h.authorized.length, 0);
  }).pipe(Effect.scoped, Effect.provide(layer)));
});

describe("OMP local command policy", () => {
  it("permits the side-effect-free native session query, not dashboard/config/session mutation paths", () => {
    assert.doesNotThrow(() => assertOmpPromptIsSafe("/session"));
    for (const text of ["/stats", "/session delete", "/model other", "/reload", "/settings", "/login", "/goal", "!touch unsafe"]) {
      assert.throws(() => assertOmpPromptIsSafe(text));
    }
  });
});
