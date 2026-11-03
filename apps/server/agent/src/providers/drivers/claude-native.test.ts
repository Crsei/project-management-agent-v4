import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChatAttachmentId, ChatFileAttachment, ClaudeSettings, MessageId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderRuntimeHost } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makePmNativeTestHost } from "../t3code/testing/native-test-host.testkit.ts";
import { resolveAttachmentPath } from "../t3code/upstream-services/attachments.ts";
import * as AgentLifecycle from "../t3code/upstream-services/port-discovery.ts";
import { claudeAdapter } from "./claude.ts";
import { CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER } from "@t3tools/shared/claudeCompaction";
import { ClaudeAgentSdkQueryRunner, layerQueryRunner, makeClaudeAdapterV2, readClaudeSessionEvidence, CLAUDE_PROVIDER } from "../../../../../../vendor/t3code/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { checkClaudeProviderStatus } from "../../../../../../vendor/t3code/apps/server/src/provider/ClaudeProvider.ts";
import { makePmProviderPlatformLayer } from "../t3code/host-runtime.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const ASSISTANT = "aaaaaaaa-0000-4000-8000-000000000002";
const platform = Layer.mergeAll(NodeServices.layer, IdAllocator.layer);
const fixture = (resume = false) => Effect.gen(function* () {
  const directory = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "pm-original-claude-")));
  yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })));
  const binary = path.join(directory, "claude.mjs");
  yield* Effect.promise(() => copyFile(new URL("./testing/claude-native.fixture.mjs", import.meta.url), binary));
  yield* Effect.promise(() => chmod(binary, 0o700));
  const home = path.join(directory, "native-home");
  const logFile = path.join(directory, "protocol.jsonl");
  yield* Effect.promise(() => mkdir(home, { recursive: true }));
  const pm = yield* makePmNativeTestHost({ driver: "claude", instanceId: "claude-fixture", cwd: directory,
    config: { binaryPath: binary, homePath: home }, environment: { HOME: directory, CLAUDE_CONFIG_DIR: home, PM_CLAUDE_FIXTURE_LOG: logFile } });
  const env = pm.context.env;
  const instanceId = ProviderInstanceId.make(pm.context.instanceId);
  const threadId = ThreadId.make("thread-claude-fixture");
  const runId = RunId.make("generation-claude-fixture");
  const allocator = yield* IdAllocator.IdAllocatorV2;
  const providerSessionId = yield* allocator.allocate.providerSession({ providerInstanceId: instanceId, threadId });
  const modelSelection = { instanceId, model: "claude-sonnet-4-6", options: [{ id: "thinking", value: false }] };
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({ runtimeMode: "approval-required", interactionMode: "default", cwd: directory });
  const host = pm.runtimeHost;
  let authorized = true;
  const authorizations: string[] = [];
  yield* pm.bindGeneration({ threadId, executionId: runId, actions: ["compaction", "tool"],
    instructionText: "Only existing PM authorization grants business access.",
    mcpServers: [{ name: "pm_tools", transport: "stdio", command: "fixture-pm-cli", args: ["mcp"] }],
    authorize: (action) => Effect.try(() => { authorizations.push(action); if (!authorized) throw new Error("PM scope revoked"); }),
  });
  const queryLayer = layerQueryRunner.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, AgentLifecycle.layer,
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers), Layer.succeed(HostProcess.Environment, env),
    Layer.succeed(HostProcess.HomeDirectory, directory))));
  const adapter = yield* Effect.gen(function* () {
    return yield* makeClaudeAdapterV2({ instanceId, settings: Schema.decodeUnknownSync(ClaudeSettings)({ binaryPath: binary, homePath: home }),
      environment: env, attachmentsDir: directory, fileSystem: yield* FileSystem.FileSystem, path: yield* Path.Path,
      crypto: yield* Crypto.Crypto, idAllocator: allocator, queryRunner: yield* ClaudeAgentSdkQueryRunner });
  }).pipe(Effect.provide(queryLayer), Effect.provideService(ProviderRuntimeHost, host),
    Effect.provideService(HostProcess.Environment, env), Effect.provideService(HostProcess.HomeDirectory, directory));
  const runtime = yield* adapter.openSession({ threadId, providerSessionId, modelSelection, runtimePolicy,
    ...(resume ? { initialNativeThreadId: SESSION } : {}) });
  const evidence = readClaudeSessionEvidence(runtime);
  assert.ok(evidence);
  const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const terminals = yield* Queue.unbounded<Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>>();
  let revokeOnQuestion = false;
  yield* runtime.events.pipe(Stream.runForEach((event) => Effect.gen(function* () {
    events.push(event);
    if (event.type === "turn.terminal") yield* Queue.offer(terminals, event);
    if (event.type === "turn_item.updated" && event.turnItem.type === "user_input_request" && event.turnItem.status === "waiting") {
      if (revokeOnQuestion) authorized = false;
      const question = event.turnItem.questions[0];
      if (question) yield* runtime.respondToRuntimeRequest({ requestId: event.turnItem.requestId,
        answers: { [question.id]: [CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER] } });
    }
  })), Effect.forkScoped({ startImmediately: true }));
  const ensure = { threadId, providerSessionId, modelSelection, runtimePolicy, forceNewNativeThread: false };
  const turnInput = (providerThread: ProviderAdapter.ProviderAdapterV2TurnInput["providerThread"], text: string, ordinal = 1): ProviderAdapter.ProviderAdapterV2TurnInput => {
    const now = DateTime.nowUnsafe();
    return { threadId, runId, runOrdinal: ordinal, providerTurnOrdinal: ordinal,
      attemptId: allocator.derive.runAttempt({ runId, attemptOrdinal: ordinal }), rootNodeId: allocator.derive.rootNode({ runId }), providerThread,
      modelSelection, runtimePolicy, message: { messageId: MessageId.make(`message-claude-fixture-${ordinal}`), text, attachments: [], createdBy: "user", creationSource: "server" },
      appThread: { id: threadId, createdBy: "user", creationSource: "server", projectId: ProjectId.make("fixture-project"), title: "Native protocol fixture",
        providerInstanceId: instanceId, modelSelection, runtimeMode: "approval-required", interactionMode: "default", branch: null, worktreePath: null,
        activeProviderThreadId: providerThread.id, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }, forkedFrom: null,
        createdAt: now, updatedAt: now, archivedAt: null, deletedAt: null, settledOverride: null, settledAt: null, lastVisitedAt: null } };
  };
  const log = () => Effect.promise(async () => (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));
  const writeLegacy = (includeLater = false) => Effect.promise(async () => {
    const project = path.join(home, "projects", directory.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(project, { recursive: true });
    const user = "aaaaaaaa-0000-4000-8000-000000000001";
    const file = path.join(project, `${SESSION}.jsonl`);
    const bytes = [
      { type: "user", uuid: user, parentUuid: null, sessionId: SESSION, cwd: directory, isSidechain: false, timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: "saved native question" } },
      { type: "assistant", uuid: ASSISTANT, parentUuid: user, sessionId: SESSION, cwd: directory, isSidechain: false, timestamp: "2026-10-01T00:00:01.000Z", message: { role: "assistant", model: "claude-sonnet-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "saved native answer" }] } },
      ...(includeLater ? [
        { type: "user", uuid: "aaaaaaaa-0000-4000-8000-000000000003", parentUuid: ASSISTANT, sessionId: SESSION, cwd: directory,
          isSidechain: false, timestamp: "2026-10-01T00:00:02.000Z", message: { role: "user", content: "excluded later question" } },
        { type: "assistant", uuid: "aaaaaaaa-0000-4000-8000-000000000004", parentUuid: "aaaaaaaa-0000-4000-8000-000000000003",
          sessionId: SESSION, cwd: directory, isSidechain: false, timestamp: "2026-10-01T00:00:03.000Z",
          message: { role: "assistant", model: "claude-sonnet-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "excluded later answer" }] } },
      ] : []),
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await writeFile(file, bytes);
    return { file, bytes, project };
  });
  return { pm, directory, home, host, runtime, evidence, events, terminals, ensure, turnInput, log, writeLegacy, authorizations,
    revoke: () => { authorized = false; }, revokeOnQuestion: () => { revokeOnQuestion = true; } };
});

test("Claude facade validates the original schema and rejects native permission/session overrides", () => {
  assert.equal(claudeAdapter.validateConfig({ homePath: "", idleCompaction: "onReturn" }).idleCompaction, "onReturn");
  for (const launchArgs of ["--permission-mode bypassPermissions", "--resume foreign", "--mcp-config foreign", "--settings foreign", "--tools Bash"]) {
    assert.throws(() => claudeAdapter.validateConfig({ launchArgs }), /cannot override PM/);
  }
});

test("original SDK operation negotiates without a prompt and reuses that exact native query for continuation", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const f = yield* fixture();
    assert.equal(yield* f.evidence.negotiate, "claude-agent-sdk.query.initialize/1");
    assert.equal((yield* f.log()).filter((entry) => entry.type === "prompt").length, 0);
    const thread = yield* f.runtime.ensureThread({ ...f.ensure, forceNewNativeThread: true });
    yield* f.runtime.startTurn(f.turnInput(thread, "first"));
    assert.equal((yield* Queue.take(f.terminals)).status, "completed");
    const resumed = yield* f.runtime.resumeThread({ providerThread: thread });
    yield* f.runtime.startTurn(f.turnInput(resumed, "second only", 2));
    assert.equal((yield* Queue.take(f.terminals)).status, "completed");
    const log = yield* f.log();
    assert.equal(log.filter((entry) => entry.type === "launch").length, 1);
    assert.deepEqual(log.filter((entry) => entry.type === "prompt").map((entry) => entry.text), ["first", "second only"]);
    const completed = f.events.filter((event) => event.type === "provider_turn.updated" && event.providerTurn.status === "completed");
    assert.ok(completed.every((event) => event.type === "provider_turn.updated" && event.providerTurn.nativeTurnRef?.strength === "strong"));
  }).pipe(Effect.scoped, Effect.provide(platform), Effect.timeout("20 seconds")));
});

test("legacy adoption uses SDK-native metadata without allocating a replacement session or sending a prompt", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const f = yield* fixture(true);
    yield* f.writeLegacy();
    yield* f.evidence.negotiate;
    const snapshot = yield* f.evidence.readLegacy({ sessionId: SESSION, messageId: ASSISTANT }, f.ensure);
    assert.equal(snapshot.providerThread.nativeThreadRef?.nativeId, SESSION);
    assert.equal(snapshot.providerTurns.at(-1)?.nativeTurnRef?.nativeId, ASSISTANT);
    assert.equal(snapshot.providerTurns.at(-1)?.nativeTurnRef?.strength, "strong");
    assert.equal((yield* f.log()).filter((entry) => entry.type === "prompt").length, 0);
    const rejected = yield* f.evidence.readLegacy({ sessionId: SESSION, messageId: "not-an-assistant-uuid" }, f.ensure).pipe(Effect.exit);
    assert.equal(rejected._tag, "Failure");
    const wrongCwd = yield* f.evidence.readLegacy({ sessionId: SESSION, messageId: ASSISTANT }, { ...f.ensure, runtimePolicy: { ...f.ensure.runtimePolicy, cwd: f.home } }).pipe(Effect.exit);
    assert.equal(wrongCwd._tag, "Failure");
    const resumed = yield* f.runtime.resumeThread({ providerThread: snapshot.providerThread });
    yield* f.runtime.startTurn(f.turnInput(resumed, "new message only", 2));
    assert.equal((yield* Queue.take(f.terminals)).status, "completed");
    assert.deepEqual((yield* f.log()).filter((entry) => entry.type === "prompt").map((entry) => entry.text), ["new message only"]);
  }).pipe(Effect.scoped, Effect.provide(platform), Effect.timeout("20 seconds")));
});

test("native forks require a strong completed assistant UUID and use the original SDK worker", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const f = yield* fixture(true);
    const original = yield* f.writeLegacy(true);
    yield* f.evidence.negotiate;
    const snapshot = yield* f.evidence.readLegacy({ sessionId: SESSION, messageId: ASSISTANT }, f.ensure);
    const boundary = snapshot.providerTurns[0]!;
    const input = { sourceProviderThread: snapshot.providerThread, targetThreadId: ThreadId.make("thread-fork-fixture"), providerTurnId: boundary.id, sourceProviderTurns: snapshot.providerTurns };
    const weak = yield* f.runtime.forkThread({ ...input, sourceProviderTurns: [{ ...boundary, nativeTurnRef: { driver: CLAUDE_PROVIDER, nativeId: ASSISTANT, strength: "weak" } }] }).pipe(Effect.exit);
    assert.equal(weak._tag, "Failure");
    const forked = yield* f.runtime.forkThread(input);
    assert.notEqual(forked.nativeThreadRef?.nativeId, SESSION);
    assert.ok(forked.nativeThreadRef?.nativeId);
    const transcript = yield* Effect.promise(() => readFile(path.join(original.project, `${forked.nativeThreadRef!.nativeId}.jsonl`), "utf8"));
    assert.match(transcript, /saved native answer/);
    assert.doesNotMatch(transcript, /excluded later/);
    assert.equal(yield* Effect.promise(() => readFile(original.file, "utf8")), original.bytes);
    assert.equal((yield* f.log()).filter((entry) => entry.type === "prompt").length, 0);
  }).pipe(Effect.scoped, Effect.provide(platform), Effect.timeout("20 seconds")));
});

test("native compaction and resume-return answers recheck the same generation's revocable PM grant", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.evidence.negotiate;
    const thread = yield* f.runtime.ensureThread(f.ensure);
    yield* f.runtime.startTurn(f.turnInput(thread, "/compact"));
    assert.equal((yield* Queue.take(f.terminals)).status, "completed");
    assert.deepEqual(f.authorizations, ["compaction"]);
    f.revokeOnQuestion();
    yield* f.runtime.startTurn(f.turnInput(thread, "dialog", 2));
    assert.equal((yield* Queue.take(f.terminals)).status, "failed");
    assert.deepEqual(f.authorizations, ["compaction", "compaction", "compaction"]);
    const denied = yield* f.runtime.startTurn(f.turnInput(thread, "/compact", 3)).pipe(Effect.exit);
    assert.equal(denied._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(platform), Effect.timeout("20 seconds")));
});

test("native SDK admits only the current PM transport and rejects EOF as completion", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.evidence.negotiate;
    const thread = yield* f.runtime.ensureThread(f.ensure);
    yield* f.runtime.startTurn(f.turnInput(thread, "permission:mcp__pm_tools__list_tasks"));
    assert.equal((yield* Queue.take(f.terminals)).status, "completed");
    f.revoke();
    yield* f.runtime.startTurn(f.turnInput(thread, "permission:mcp__pm_tools__list_tasks", 2));
    assert.equal((yield* Queue.take(f.terminals)).status, "failed");
    yield* f.runtime.startTurn(f.turnInput(thread, "eof", 3));
    assert.notEqual((yield* Queue.take(f.terminals)).status, "completed");
  }).pipe(Effect.scoped, Effect.provide(platform), Effect.timeout("20 seconds")));
});

test("Claude's actual PM host rejects changed attachments and revoked generation authority", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const pm = yield* makePmNativeTestHost({ driver: "claude" });
    const attachment = ChatFileAttachment.make({ type: "file", id: ChatAttachmentId.make("claude-fixture-file"),
      name: "fixture.txt", mimeType: "text/plain", sizeBytes: 4 });
    const file = yield* pm.registerAttachment(attachment, Buffer.from("data"));
    assert.equal(resolveAttachmentPath({ attachmentsDir: pm.serverConfig.attachmentsDir, attachment }), file);
    yield* Effect.promise(() => writeFile(file, "changed"));
    assert.equal(resolveAttachmentPath({ attachmentsDir: pm.serverConfig.attachmentsDir, attachment }), null);
    assert.equal((yield* pm.registerAttachment(attachment, Buffer.from("data"), "../escape").pipe(Effect.exit))._tag, "Failure");
    const grant = yield* pm.bindGeneration({ threadId: ThreadId.make("thread-native-grant"),
      executionId: "owned-native-generation", actions: ["compaction"] });
    yield* grant.authorize("compaction");
    assert.equal((yield* pm.runtimeHost.authorize({ ...grant.binding, executionId: "stale-native-generation", action: "compaction" })
      .pipe(Effect.exit))._tag, "Failure");
    yield* grant.revoke;
    assert.equal((yield* grant.authorize("compaction").pipe(Effect.exit))._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(platform), Effect.timeout("20 seconds")));
});

test("original Claude readiness does not fabricate missing or custom-endpoint account identity", { skip: process.platform === "win32" }, async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const f = yield* fixture();
    const settings = Schema.decodeUnknownSync(ClaudeSettings)(f.pm.context.config);
    const check = (account: { readonly tokenSource?: string; readonly email?: string }, environment = f.pm.context.env) =>
      checkClaudeProviderStatus(settings, () => Effect.succeed({
        email: undefined, subscriptionType: undefined, tokenSource: undefined,
        apiKeySource: undefined, apiProvider: undefined, ...account, slashCommands: [],
      }), environment, f.directory)
        .pipe(Effect.provide(makePmProviderPlatformLayer(f.pm.context)));
    const unknown = yield* check({});
    assert.equal(unknown.status, "ready");
    assert.equal(unknown.auth.status, "unknown");
    assert.equal(unknown.auth.email, undefined);
    const loggedOut = yield* check({ tokenSource: "none" });
    assert.equal(loggedOut.auth.status, "unauthenticated");
    const custom = yield* check({ tokenSource: "oauth", email: "first-party@example.invalid" },
      { ...f.pm.context.env, ANTHROPIC_BASE_URL: "https://fixture.example.invalid" });
    assert.equal(custom.status, "ready");
    assert.equal(custom.auth.status, "unknown");
    assert.equal(custom.auth.email, undefined);
  }).pipe(Effect.scoped, Effect.provide(platform), Effect.timeout("20 seconds")));
});
