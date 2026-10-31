import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { ThreadId, ProviderDriverKind, ProviderInstanceId, OrchestrationV2AppThread, OrchestrationV2ExecutionNode, OrchestrationV2ProviderSession, OrchestrationV2ProviderThread, OrchestrationV2ProviderTurn, OrchestrationV2TurnItem, OrchestrationV2RuntimeRequest, ServerProvider } from "@t3tools/contracts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import type { ProviderAdapterV2Event, ProviderAdapterV2ForkThreadInput, ProviderAdapterV2SessionRuntime, ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import type { NativeOutputEvent } from "@agent-workspace/contracts/output";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import type { PmProviderHostService, PmProviderLease } from "./contract.ts";
import { makePmProviderRuntimeHost } from "./runtime-host.ts";
import { makePmProviderExecutionService } from "./execution.ts";
import { pmAdapterBoundaryError } from "./events.ts";
import { registerPmProviderProtocolResolver, PM_CONTINUATIONS, pmExecutionError, readPmContinuation, type PmProviderProtocolResolver } from "./continuation.ts";
import { closeStore, listRecords } from "../../durable/store.ts";

const now = DateTime.makeUnsafe("2026-10-30T00:00:00.000Z");
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("fixture");
let directory: string;
const previousDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "t3-execution-")); process.env.AGENT_WORKSPACE_DATA_DIR = directory; });
afterEach(async () => { closeStore(); await rm(directory, { recursive: true, force: true });
  if (previousDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousDirectory; });

async function harness(
  scenario: (input: ProviderAdapterV2TurnInput, emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>) => Effect.Effect<void>,
  resolver: PmProviderProtocolResolver = () => Effect.succeed({ protocol: "fixture:original-v2" }),
  fixture: { canFork?: boolean; closeFailure?: Error; configure?: (runtime: ProviderAdapterV2SessionRuntime, emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>) => void } = {},
) {
  const runtimeHost = makePmProviderRuntimeHost();
  const starts: ProviderAdapterV2TurnInput[] = [];
  const forks: ProviderAdapterV2ForkThreadInput[] = [];
  const operations: string[] = [];
  let closed = 0;
  let interrupts = 0;
  let probes = 0;
  const context: ProviderDriverContext = { instanceId, driver: "codex", config: {}, homeDirectory: "/native-home", stateDirectory: "/state", cwd: "/workspace", env: {}, revision: 7 };
  const decodeThread = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderThread));
  const snapshot = Schema.decodeUnknownSync(ServerProvider)({ instanceId, driver, enabled: true, installed: true, version: "fixture",
    status: "ready", auth: { status: "authenticated" }, checkedAt: "2026-10-30T00:00:00.000Z", models: [],
    usageLimits: { checkedAt: "2026-10-30T00:00:00.000Z", windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 30 }] } });
  const capabilities = { ...AcpProviderCapabilitiesV2, threads: { ...AcpProviderCapabilitiesV2.threads,
    canForkThread: fixture.canFork ?? false, canForkFromTurn: fixture.canFork ?? false } };
  const instance: ProviderInstance = {
    instanceId, driverKind: driver, displayName: undefined, enabled: true, continuationIdentity: { driverKind: driver, continuationKey: "fixture-account" },
    snapshot: { getSnapshot: Effect.succeed(snapshot), streamChanges: Stream.never,
      refresh: Effect.die(new Error("Execution must not refresh status.")),
      resolveMaintenance: () => Effect.die(new Error("Execution must not resolve maintenance.")),
      applyUsageLimits: () => Effect.void },
    get textGeneration(): never { throw new Error("Execution must not invoke title generation."); },
    orchestrationAdapter: { instanceId, driver,
      getCapabilities: () => Effect.succeed(capabilities),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) => Effect.gen(function* () {
        operations.push("open");
        assert.equal((yield* runtimeHost.read({ threadId: input.threadId, providerInstanceId: instanceId }))?.nativePermissions, "deny-ungranted");
        const queue = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* Effect.addFinalizer(() => Effect.sync(() => { closed++; operations.push("close"); }).pipe(
          Effect.andThen(Effect.suspend(() => fixture.closeFailure ? Effect.die(fixture.closeFailure) : Effect.void)),
        ));
        const session = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderSession))({ id: input.providerSessionId, driver, providerInstanceId: instanceId,
          status: "ready", cwd: context.cwd, model: input.modelSelection.model, capabilities, createdAt: now, updatedAt: now, lastError: null });
        let thread = decodeThread({ id: "provider-thread", driver, providerInstanceId: instanceId, providerSessionId: input.providerSessionId, appThreadId: input.threadId,
          ownerNodeId: null, nativeThreadRef: { driver, nativeId: input.initialNativeThreadId ?? "native-session", strength: "strong" }, nativeConversationHeadRef: null,
          status: "idle", firstRunOrdinal: null, lastRunOrdinal: null, handoffIds: [], forkedFrom: null, createdAt: now, updatedAt: now });
        const emit = (event: ProviderAdapterV2Event) => Queue.offer(queue, event).pipe(Effect.asVoid);
        const runtime: ProviderAdapterV2SessionRuntime = { instanceId, driver, providerSessionId: session.id, providerSession: session, events: Stream.fromQueue(queue),
          ensureThread: (ensure) => Effect.sync(() => {
            assert.equal(input.initialNativeThreadId, undefined, "Native references must never go through create/ensure.");
            assert.equal(ensure.forceNewNativeThread, false, "Fresh execution must adopt the session already admitted by original openSession.");
            operations.push("ensure"); return thread;
          }),
          resumeThread: (resume) => Effect.sync(() => { operations.push("resume"); thread = { ...resume.providerThread, appThreadId: resume.threadId ?? resume.providerThread.appThreadId, providerSessionId: session.id }; return thread; }),
          startTurn: (turn) => Effect.gen(function* () { operations.push("start"); starts.push(turn); yield* scenario(turn, emit); }),
          interruptTurn: () => Effect.sync(() => { interrupts++; }),
          steerTurn: () => Effect.die(new Error("Unexpected steering")),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.sync(() => {
            operations.push("read");
            return { providerThread: thread, providerTurns: [], messages: [], runtimeRequests: [],
              providerPayload: { cwd: "/workspace", nativeHome: "/native-home" } };
          }),
          rollbackThread: () => Effect.die(new Error("Unexpected rollback")),
          forkThread: (fork) => Effect.sync(() => {
            operations.push("fork"); forks.push(fork);
            thread = decodeThread({ ...thread, id: "fork-provider-thread", appThreadId: fork.targetThreadId,
              nativeThreadRef: { driver, nativeId: "fork-native-session", strength: "strong" } });
            return thread;
          }),
        };
        fixture.configure?.(runtime, emit);
        return runtime;
      }),
    },
  };
  const leaseState = { live: true };
  const lease: PmProviderLease = { localDriver: "codex", instanceId, revision: 7, cwd: context.cwd, nativeHome: context.homeDirectory,
    continuationIdentity: instance.continuationIdentity, instance,
    assertCurrent: Effect.suspend(() => leaseState.live ? Effect.void : Effect.fail(pmExecutionError(409, "stale_lease", "Fixture provider revision was invalidated."))) };
  const host: PmProviderHostService = { acquire: () => Effect.succeed(lease), invalidate: () => Effect.void, shutdown: Effect.void };
  const releaseProbe = registerPmProviderProtocolResolver("codex", (operation) => Effect.sync(() => { probes++; }).pipe(Effect.flatMap(() => resolver(operation))));
  return { service: makePmProviderExecutionService(host, runtimeHost), runtimeHost, leaseState, lease, context, starts, forks, operations, releaseProbe,
    counts: () => ({ closed, interrupts, probes }) };
}

const turn = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderTurn));
const item = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2TurnItem));
function finish(input: ProviderAdapterV2TurnInput, emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>, status: "completed" | "interrupted" = "completed") {
  const root = turn({ id: `root-provider-turn:${input.providerTurnOrdinal}`, providerThreadId: input.providerThread.id, nodeId: input.rootNodeId, runAttemptId: input.attemptId,
    nativeTurnRef: { driver, nativeId: `native-turn:${input.providerTurnOrdinal}`, strength: "strong" }, ordinal: input.providerTurnOrdinal, status, startedAt: now, completedAt: now });
  return Effect.gen(function* () {
    yield* emit({ type: "provider_thread.updated", driver, providerThread: { ...input.providerThread, lastRunOrdinal: input.runOrdinal } });
    yield* emit({ type: "provider_turn.updated", driver, providerTurn: root });
    yield* emit({ type: "turn_item.updated", driver, turnItem: item({ id: "answer", type: "assistant_message", threadId: input.threadId, runId: input.runId,
      nodeId: input.rootNodeId, providerThreadId: input.providerThread.id, providerTurnId: root.id, nativeItemRef: null, parentItemId: null, ordinal: 1,
      status: "completed", title: null, startedAt: now, completedAt: now, updatedAt: now, messageId: "native-message", text: "original answer", streaming: false }) });
    yield* emit({ type: "turn.terminal", driver, providerThreadId: input.providerThread.id, providerTurnId: root.id,
      runOrdinal: input.runOrdinal, status, failure: null, threadDisposition: "reusable" });
  });
}

const nativeHistoryProbe: PmProviderProtocolResolver = () => Effect.succeed({
  protocol: "fixture:original-v2",
  adoptLegacy: ({ runtime, source }) => runtime.readThreadSnapshot({ providerThread: Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderThread))({
    id: "unused-request-metadata", driver, providerInstanceId: instanceId, providerSessionId: runtime.providerSessionId,
    appThreadId: null, ownerNodeId: null, nativeThreadRef: { driver, nativeId: source.sessionId, strength: "strong" },
    nativeConversationHeadRef: null, status: "idle", firstRunOrdinal: null, lastRunOrdinal: null,
    handoffIds: [], forkedFrom: null, createdAt: now, updatedAt: now,
  }) }).pipe(Effect.map(snapshot => ({ ...snapshot,
    nativeHistory: { nativeSessionId: source.sessionId, completedTurnRefs: [
      { driver, nativeId: "legacy-kept", strength: "strong" as const },
      { driver, nativeId: "legacy-completed", strength: "strong" as const },
    ], latestCompletedTurnRef: { driver, nativeId: "legacy-completed", strength: "strong" as const } },
  })), Effect.mapError(error => pmExecutionError(409, "session_mismatch", error.message))),
});

const legacySource = { providerInstanceId: instanceId, driver: "codex" as const, sessionId: "legacy-native",
  modelId: "explicit", cwd: "/workspace", instanceRevision: 7, turnId: "legacy-completed" };

for (const foreignSnapshot of [false, true]) {
  test(`completed weak graph refs ${foreignSnapshot ? "reject a foreign" : "adopt only an explicitly proven"} native history tip`, async () => {
    const f = await harness((input, emit) => finish(input, event => emit(event.type === "provider_turn.updated"
      ? { ...event, providerTurn: { ...event.providerTurn, nativeTurnRef: { driver, nativeId: "weak-runtime-id", strength: "weak" } } }
      : event)), undefined, { configure: runtime => {
      const read = runtime.readThreadSnapshot;
      Object.assign(runtime, { readThreadSnapshot: (input: Parameters<typeof read>[0]) => read(input).pipe(Effect.map(snapshot => {
        const latest = { driver, nativeId: "native-completed-boundary", strength: "strong" as const };
        return { ...snapshot,
          providerThread: { ...snapshot.providerThread, appThreadId: foreignSnapshot ? ThreadId.make("another-owner") : snapshot.providerThread.appThreadId },
          nativeHistory: { nativeSessionId: "native-session", completedTurnRefs: [latest], latestCompletedTurnRef: latest } };
      })) });
    } });
    try {
      const operation = f.service.run(f.context, { model: "explicit", prompt: "complete native turn" });
      if (foreignSnapshot) {
        await assert.rejects(operation, { code: "session_mismatch" });
      } else {
        const result = await operation;
        assert.equal(result.nativeSession?.turnId, "native-completed-boundary");
        const saved = readPmContinuation(f.lease, result.nativeSession!, "fixture:original-v2")!;
        assert.equal(saved.turns[0]?.nativeTurnRef?.strength, "weak");
        assert.equal(saved.turns[0]?.nativeTurnRef?.nativeId, "weak-runtime-id");
        assert.equal(saved.nativeHistory?.latestCompletedTurnRef?.nativeId, result.nativeSession?.turnId);
      }
    } finally { f.releaseProbe(); }
  });
}

test("V2 owns start/resume and scope; no-tool continuation reuses validated technical owner and probes every operation", async () => {
  const f = await harness(finish);
  try {
    let text = "";
    const first = await f.service.run(f.context, { model: "explicit", prompt: "one prompt", onText: (delta) => { text += delta; } });
    assert.equal(first.text, "original answer");
    assert.equal(text, "original answer");
    assert.equal(first.nativeSession?.sessionId, "native-session");
    assert.notEqual(first.nativeSession?.sessionId, f.starts[0].providerThread.providerSessionId);
    assert.equal(f.starts[0].runtimePolicy.runtimeMode, "approval-required");
    assert.deepEqual(f.starts[0].runtimePolicy.sandboxPolicy, { type: "readOnly" });
    const next = await f.service.run(f.context, { model: "explicit", prompt: "only new message", resume: first.nativeSession });
    assert.equal(next.text, "original answer");
    assert.equal(f.starts[1].threadId, f.starts[0].threadId);
    assert.equal(f.starts[1].runOrdinal, 2);
    assert.equal(f.starts[1].providerTurnOrdinal, 2);
    assert.deepEqual(f.starts.map((start) => start.message.text), ["one prompt", "only new message"]);
    assert.deepEqual(f.counts(), { closed: 2, interrupts: 0, probes: 2 });
    assert.equal(listRecords(PM_CONTINUATIONS).length, 1);
    assert.deepEqual(f.operations, ["open", "ensure", "start", "close", "open", "resume", "start", "close"]);
    assert.equal(first.nativeUsage?.limits?.windows[0].usedPercent, 30);
  } finally { f.releaseProbe(); }
});

test("native interrupted rejects without an aborted host signal and closes the scope", async () => {
  const f = await harness((input, emit) => finish(input, emit, "interrupted"));
  try {
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "once" }), { terminalStatus: "interrupted" });
    assert.equal(f.counts().closed, 1);
  } finally { f.releaseProbe(); }
});

test("callback failure interrupts the original root and is not converted to native success", async () => {
  const f = await harness((input, emit) => finish(input, event => event.type === "provider_turn.updated"
    ? emit({ ...event, providerTurn: { ...event.providerTurn, status: "running", completedAt: null } })
    : event.type === "turn.terminal" ? Effect.void : emit(event)));
  try {
    const failure = new Error("consumer failed");
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "once", onEvent: () => { throw failure; } }), /consumer failed/);
    assert.equal(f.counts().interrupts, 1);
    assert.equal(f.counts().closed, 1);
  } finally { f.releaseProbe(); }
});

test("a child or wrong-run terminal cannot complete the root generation", async () => {
  const f = await harness((input, emit) => Effect.gen(function* () {
    yield* emit({ type: "turn.terminal", driver, providerThreadId: input.providerThread.id,
      providerTurnId: Schema.decodeUnknownSync(OrchestrationV2ProviderTurn.fields.id)("child-turn"), runOrdinal: input.runOrdinal,
      status: "completed", failure: null, threadDisposition: "reusable" });
    yield* finish(input, emit);
  }));
  try { assert.equal((await f.service.run(f.context, { model: "explicit", prompt: "once" })).text, "original answer"); }
  finally { f.releaseProbe(); }
});

test("native child roots require their admitted provider-thread association and never enter the root answer", async () => {
  const events: NativeOutputEvent[] = [];
  const f = await harness((input, emit) => Effect.gen(function* () {
    const childId = Schema.decodeUnknownSync(OrchestrationV2AppThread.fields.id)("owned-child");
    const childThread = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderThread))({
      ...input.providerThread, id: "child-provider-thread", appThreadId: childId,
      nativeThreadRef: { driver, nativeId: "child-native-session", strength: "strong" },
    });
    yield* emit({ type: "app_thread.created", driver, appThread: makeSubagentChildThread({
      parentThread: input.appThread, childThreadId: childId, parentNodeId: input.rootNodeId,
      activeProviderThreadId: childThread.id, providerInstanceId: instanceId, modelSelection: input.modelSelection,
      title: "Native child", now, createdBy: "agent", creationSource: "provider",
    }) });
    yield* emit({ type: "provider_thread.updated", driver, providerThread: childThread });
    for (const owned of [false, true]) {
      const prefix = owned ? "owned" : "foreign";
      const childRoot = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ExecutionNode))({
        id: `${prefix}-root`, threadId: childId, runId: null, parentNodeId: null, rootNodeId: `${prefix}-root`,
        kind: "root_turn", status: "running", countsForRun: false,
        providerThreadId: owned ? childThread.id : "foreign-provider-thread", providerTurnId: `${prefix}-turn`,
        nativeItemRef: null, runtimeRequestId: null, checkpointScopeId: null, startedAt: now, completedAt: null,
      });
      yield* emit({ type: "node.updated", driver, node: childRoot });
      const childTurn = turn({ id: `${prefix}-turn`, providerThreadId: childRoot.providerThreadId,
        nodeId: childRoot.id, runAttemptId: null, nativeTurnRef: null, ordinal: 1,
        status: "completed", startedAt: now, completedAt: now });
      yield* emit({ type: "provider_turn.updated", driver, providerTurn: childTurn });
      yield* emit({ type: "turn_item.updated", driver, turnItem: item({
        id: `${prefix}-answer`, type: "assistant_message", threadId: childId, runId: null, nodeId: childRoot.id,
        providerThreadId: childTurn.providerThreadId, providerTurnId: childTurn.id, nativeItemRef: null,
        parentItemId: null, ordinal: 1, status: "completed", title: null, startedAt: now, completedAt: now, updatedAt: now,
        messageId: `${prefix}-message`, text: `${prefix} child answer`, streaming: false,
      }) });
      yield* emit({ type: "turn.terminal", driver, providerThreadId: childTurn.providerThreadId,
        providerTurnId: childTurn.id, runOrdinal: input.runOrdinal, status: "completed", failure: null, threadDisposition: "reusable" });
    }
    yield* finish(input, emit);
  }));
  try {
    const result = await f.service.run(f.context, { model: "explicit", prompt: "once", onEvent: event => events.push(event) });
    assert.equal(result.text, "original answer");
    const answers = events.flatMap(event => event.type === "item.upsert" && event.item.type === "assistant_message" ? [event.item] : []);
    assert.equal(answers.find(answer => answer.text === "owned child answer")?.parentItemId, "native-child:owned-child");
    assert.equal(answers.some(answer => answer.text === "foreign child answer"), false);
  } finally { f.releaseProbe(); }
});

test("conflicting original root identities cannot claim the same native ordinal or complete successfully", async () => {
  const f = await harness((input, emit) => Effect.gen(function* () {
    const original = turn({ id: "first-root", providerThreadId: input.providerThread.id, nodeId: input.rootNodeId,
      runAttemptId: input.attemptId, nativeTurnRef: { driver, nativeId: "first-native-turn", strength: "strong" },
      ordinal: input.providerTurnOrdinal, status: "running", startedAt: now, completedAt: null });
    yield* emit({ type: "provider_turn.updated", driver, providerTurn: original });
    yield* emit({ type: "provider_turn.updated", driver, providerTurn: { ...original,
      id: Schema.decodeUnknownSync(OrchestrationV2ProviderTurn.fields.id)("conflicting-root") } });
  }));
  try {
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "once" }), { code: "provider_protocol_error" });
    assert.equal(f.counts().closed, 1);
    assert.equal(f.starts.length, 1);
  } finally { f.releaseProbe(); }
});

test("valid legacy native metadata is adopted with zero probe prompts and preserved original ordinals", async () => {
  let adopted = 0;
  const f = await harness(finish, ({ context, lease }) => Effect.succeed({
    protocol: "fixture:original-v2",
    adoptLegacy: ({ source, ensure, runtime }) => Effect.gen(function* () {
      adopted++;
      const requestThread = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderThread))({
        id: "provider-thread", driver, providerInstanceId: lease.instance.instanceId, providerSessionId: runtime.providerSessionId,
        appThreadId: ensure.threadId, ownerNodeId: null, nativeThreadRef: { driver, nativeId: source.sessionId, strength: "strong" },
        nativeConversationHeadRef: null, status: "idle", firstRunOrdinal: 1, lastRunOrdinal: 3, handoffIds: [], forkedFrom: null,
        createdAt: now, updatedAt: now,
      });
      const snapshot = yield* runtime.readThreadSnapshot({ providerThread: requestThread });
      const nativeScope = Schema.decodeUnknownSync(Schema.Struct({ cwd: Schema.String, nativeHome: Schema.String }))(snapshot.providerPayload);
      assert.equal(context.cwd, nativeScope.cwd);
      assert.equal(context.homeDirectory, nativeScope.nativeHome);
      assert.equal(snapshot.providerThread.nativeThreadRef?.nativeId, source.sessionId);
      return { providerThread: { ...snapshot.providerThread, lastRunOrdinal: 3 }, providerTurns: [turn({
        id: "old-provider-turn", providerThreadId: snapshot.providerThread.id, nodeId: "old-root", runAttemptId: "old-attempt",
        nativeTurnRef: { driver, nativeId: "old-native-turn", strength: "strong" }, ordinal: 9,
        status: "completed", startedAt: now, completedAt: now,
      })], messages: [], runtimeRequests: [] };
    }).pipe(Effect.mapError((error) => pmExecutionError(409, "session_mismatch", error.message))),
  }));
  try {
    await f.service.run(f.context, { model: "explicit", prompt: "new user message only", resume: {
      providerInstanceId: instanceId, driver: "codex", sessionId: "legacy-native", turnId: "old-native-turn",
      modelId: "explicit", cwd: f.context.cwd, instanceRevision: f.context.revision,
    } });
    assert.equal(adopted, 1);
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].message.text, "new user message only");
    assert.equal(f.starts[0].runOrdinal, 4);
    assert.equal(f.starts[0].providerTurnOrdinal, 10);
    assert.deepEqual(f.operations, ["open", "read", "resume", "start", "close"]);
  } finally { f.releaseProbe(); }
});

test("legacy metadata adoption rejects a proven stale head before dispatch but accepts the current native cursor", async () => {
  const resolver: PmProviderProtocolResolver = operation => nativeHistoryProbe(operation).pipe(Effect.map(probe => ({
    ...probe,
    adoptLegacy: input => probe.adoptLegacy!(input).pipe(Effect.map(snapshot => ({
      ...snapshot, nativeHistory: { nativeSessionId: input.source.sessionId,
        completedTurnRefs: [
          { driver, nativeId: "legacy-completed", strength: "strong" as const },
          { driver, nativeId: "actual-current-head", strength: "strong" as const },
        ],
        latestCompletedTurnRef: { driver, nativeId: "actual-current-head", strength: "strong" as const },
      },
    }))),
  })));
  const f = await harness(finish, resolver);
  try {
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "stale cursor must not dispatch", resume: legacySource }),
      { code: "session_mismatch" });
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "stale message must not dispatch",
      resume: { ...legacySource, turnId: undefined, messageId: "legacy-completed" } }), { code: "session_mismatch" });
    assert.equal(f.starts.length, 0);
    assert.deepEqual(f.operations, ["open", "read", "close", "open", "read", "close"]);
    const current = await f.service.run(f.context, { model: "explicit", prompt: "new message only",
      resume: { ...legacySource, turnId: "actual-current-head" } });
    assert.equal(current.nativeSession?.sessionId, legacySource.sessionId);
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].message.text, "new message only");
  } finally { f.releaseProbe(); }
});

test("legacy unordered history membership rejects explicit resume cursors but does not reject cursorless native resume", async () => {
  const resolver: PmProviderProtocolResolver = operation => nativeHistoryProbe(operation).pipe(Effect.map(probe => ({
    ...probe,
    adoptLegacy: input => probe.adoptLegacy!(input).pipe(Effect.map(snapshot => ({
      ...snapshot, nativeHistory: { nativeSessionId: input.source.sessionId, completedTurnRefs: snapshot.nativeHistory!.completedTurnRefs },
    }))),
  })));
  const f = await harness(finish, resolver);
  try {
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "no current turn proof", resume: legacySource }),
      { code: "session_mismatch" });
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "no current message proof",
      resume: { ...legacySource, turnId: undefined, messageId: "legacy-completed" } }), { code: "session_mismatch" });
    assert.equal(f.starts.length, 0);
    assert.deepEqual(f.operations, ["open", "read", "close", "open", "read", "close"]);
    const result = await f.service.run(f.context, { model: "explicit", prompt: "new message only",
      resume: { ...legacySource, turnId: undefined } });
    assert.equal(result.nativeSession?.sessionId, legacySource.sessionId);
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].message.text, "new message only");
  } finally { f.releaseProbe(); }
});

test("a newer weak graph root invalidates the retained native tip until an actual original snapshot refresh", async () => {
  let snapshotTip = "first-native-snapshot-tip";
  const f = await harness((input, emit) => finish(input, event => emit(event.type === "provider_turn.updated"
    ? { ...event, providerTurn: { ...event.providerTurn, nativeTurnRef: { driver, nativeId: `weak:${input.providerTurnOrdinal}`, strength: "weak" } } }
    : event)), undefined, { configure: runtime => {
    const read = runtime.readThreadSnapshot;
    Object.assign(runtime, { readThreadSnapshot: (input: Parameters<typeof read>[0]) => read(input).pipe(Effect.map(snapshot => ({
      ...snapshot, nativeHistory: { nativeSessionId: snapshot.providerThread.nativeThreadRef!.nativeId,
        completedTurnRefs: [{ driver, nativeId: snapshotTip, strength: "strong" as const }],
        latestCompletedTurnRef: { driver, nativeId: snapshotTip, strength: "strong" as const },
      },
    }))) });
  } });
  try {
    const first = await f.service.run(f.context, { model: "explicit", prompt: "first native turn" });
    assert.equal(first.nativeSession?.turnId, snapshotTip);
    const stop = new Error("Stop after persisting the newer weak graph, before its native snapshot");
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "second native turn", resume: first.nativeSession,
      onSession: () => {
        const saved = listRecords<{ providerTurnsJson: Array<{ ordinal: number }>;
          nativeHistory?: { completedTurnRefs: Array<{ nativeId: string }>; latestCompletedTurnRef?: unknown } }>(PM_CONTINUATIONS)[0]!;
        if (saved.providerTurnsJson.some(turn => turn.ordinal === 2)) {
          assert.equal(saved.nativeHistory?.latestCompletedTurnRef, undefined);
          assert.deepEqual(saved.nativeHistory?.completedTurnRefs.map(ref => ref.nativeId), ["first-native-snapshot-tip"]);
          throw stop;
        }
      },
    }), error => error === stop);
    closeStore();
    assert.throws(() => readPmContinuation(f.lease, first.nativeSession!, "fixture:original-v2"), { code: "session_mismatch" });
    assert.equal(f.starts.length, 2);
    snapshotTip = "fresh-native-snapshot-tip";
    const current = await f.service.run(f.context, { model: "explicit", prompt: "explicit cursorless recovery",
      resume: { ...first.nativeSession!, turnId: undefined } });
    assert.equal(current.nativeSession?.turnId, snapshotTip);
    assert.equal(readPmContinuation(f.lease, current.nativeSession!, "fixture:original-v2")?.nativeHistory?.latestCompletedTurnRef?.nativeId, snapshotTip);
    assert.equal(f.starts.length, 3);
  } finally { f.releaseProbe(); }
});

test("pending information answers never block event consumption or terminal cleanup", { timeout: 2000 }, async () => {
  let offered = 0;
  const f = await harness((input, emit) => Effect.gen(function* () {
    const root = turn({ id: `root-provider-turn:${input.providerTurnOrdinal}`, providerThreadId: input.providerThread.id, nodeId: input.rootNodeId,
      runAttemptId: input.attemptId, nativeTurnRef: null, ordinal: input.providerTurnOrdinal, status: "running", startedAt: now, completedAt: null });
    yield* emit({ type: "provider_turn.updated", driver, providerTurn: root });
    yield* emit({ type: "runtime_request.updated", driver, runtimeRequest: Schema.decodeUnknownSync(Schema.toType(OrchestrationV2RuntimeRequest))({
      id: "question", nodeId: input.rootNodeId, providerTurnId: root.id, nativeRequestRef: null, kind: "user_input", status: "pending",
      responseCapability: { type: "live", providerSessionId: input.providerThread.providerSessionId }, createdAt: now, resolvedAt: null,
    }) });
    yield* emit({ type: "turn_item.updated", driver, turnItem: item({
      id: "question-item", type: "user_input_request", threadId: input.threadId, runId: input.runId, nodeId: input.rootNodeId,
      providerThreadId: input.providerThread.id, providerTurnId: root.id, nativeItemRef: null, parentItemId: null, ordinal: 1,
      status: "waiting", title: "Question", startedAt: now, completedAt: null, updatedAt: now, requestId: "question",
      questions: [{ id: "answer", header: "Question", question: "Choose", options: [{ label: "One", description: "First" }] }],
    }) });
    yield* finish(input, emit);
  }));
  try {
    const result = await f.service.run(f.context, { model: "explicit", prompt: "once", onRequest: () => {
      offered++;
      return new Promise(() => {});
    } });
    assert.equal(result.text, "original answer");
    assert.equal(offered, 1);
    assert.equal(f.counts().closed, 1);
  } finally { f.releaseProbe(); }
});

test("a same-operation dialect probe failure closes the original session and never starts a turn", async () => {
  const f = await harness(finish, () => Effect.fail(pmExecutionError(409, "session_mismatch", "Native probe did not confirm a dialect.")));
  try {
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "must not dispatch" }), { code: "session_mismatch" });
    assert.equal(f.starts.length, 0);
    assert.equal(f.counts().closed, 1);
  } finally { f.releaseProbe(); }
});

for (const during of [false, true]) {
  test(`generation authorization rechecks the leased provider ${during ? "after" : "before"} the asynchronous PM callback`, async () => {
    let authorization: Effect.Effect<void, Error> = Effect.fail(new Error("Authorization fixture was not admitted."));
    const f = await harness(finish, () => Effect.suspend(() => authorization).pipe(
      Effect.mapError(error => pmAdapterBoundaryError(error)), Effect.as({ protocol: "fixture:original-v2" })));
    let callbacks = 0;
    f.context.execution = { threadId: "authorized-chat", generationId: "authorized-generation", messageId: "authorized-message",
      scope: { workspaceId: "workspace", projectId: null } };
    f.context.authorizeExecution = async () => {
      callbacks++;
      await Promise.resolve();
      f.leaseState.live = false;
    };
    authorization = Effect.sync(() => { if (!during) f.leaseState.live = false; }).pipe(Effect.andThen(f.runtimeHost.authorize({
      threadId: ThreadId.make("authorized-chat"), providerInstanceId: instanceId, executionId: "authorized-generation", action: "compaction",
    })));
    try {
      await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "must not dispatch" }), { code: "stale_lease" });
      assert.equal(callbacks, during ? 1 : 0);
      assert.equal(f.starts.length, 0);
      assert.equal(f.counts().closed, 1);
      await assert.rejects(Effect.runPromise(f.runtimeHost.authorize({
        threadId: ThreadId.make("authorized-chat"), providerInstanceId: instanceId, executionId: "authorized-generation", action: "compaction",
      })), { code: "stale_execution" });
    } finally { f.releaseProbe(); }
  });
}

test("native history survives real graph turns and reopen; fork persists fresh target proof and actual target turns", async () => {
  const f = await harness(finish, nativeHistoryProbe, { canFork: true, configure: runtime => {
    const read = runtime.readThreadSnapshot;
    Object.assign(runtime, { readThreadSnapshot: (input: Parameters<typeof read>[0]) => read(input).pipe(Effect.map(snapshot => {
      if (input.providerThread.nativeThreadRef?.nativeId !== "fork-native-session") return snapshot;
      return { ...snapshot, providerThread: { ...snapshot.providerThread, lastRunOrdinal: 7,
        nativeConversationHeadRef: { driver, nativeId: "fresh-target-head", strength: "strong" as const } },
        providerTurns: [turn({ id: "actual-target-turn", providerThreadId: snapshot.providerThread.id,
          nodeId: "actual-target-node", runAttemptId: "actual-target-attempt",
          nativeTurnRef: { driver, nativeId: "target-native-turn", strength: "strong" }, ordinal: 5,
          status: "completed", startedAt: now, completedAt: now })],
        nativeHistory: { nativeSessionId: "fork-native-session",
          completedTurnRefs: [{ driver, nativeId: "legacy-completed", strength: "strong" as const }] } };
    })) });
  } });
  try {
    const first = await f.service.run(f.context, { model: "explicit", prompt: "first migrated turn", resume: legacySource });
    assert.equal(first.nativeSession?.turnId, "native-turn:1");
    const saved = readPmContinuation(f.lease, first.nativeSession!, "fixture:original-v2")!;
    assert.equal(saved.turns.length, 1);
    assert.equal(saved.turns[0].nodeId, f.starts[0].rootNodeId);
    assert.deepEqual(saved.nativeHistory?.completedTurnRefs.map(ref => ref.nativeId), ["legacy-kept", "legacy-completed"]);
    closeStore();
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "stale must not dispatch", resume: legacySource }),
      { code: "session_mismatch" });
    assert.equal(f.starts.length, 1);
    const second = await f.service.run(f.context, { model: "explicit", prompt: "after reopen", resume: first.nativeSession });
    assert.equal(f.starts[1].providerTurnOrdinal, 2);
    assert.equal(readPmContinuation(f.lease, second.nativeSession!, "fixture:original-v2")!.turns.length, 2);
    const forked = await f.service.fork(f.context, second.nativeSession!, { turnId: "legacy-completed" });
    assert.equal(f.forks.length, 1);
    assert.equal(f.forks[0].providerTurnId, undefined);
    assert.deepEqual(f.forks[0].nativeCompletedTurnRef, { driver, nativeId: "legacy-completed", strength: "strong" });
    assert.equal(f.forks[0].sourceProviderTurns?.length, 2);
    const target = readPmContinuation(f.lease, forked, "fixture:original-v2")!;
    assert.equal(target.thread.lastRunOrdinal, 7);
    assert.equal(target.thread.nativeConversationHeadRef?.nativeId, "fresh-target-head");
    assert.deepEqual(target.turns.map(value => [value.id, value.nodeId, value.runAttemptId]),
      [["actual-target-turn", "actual-target-node", "actual-target-attempt"]]);
    assert.equal(target.nativeHistory?.nativeSessionId, "fork-native-session");
    assert.deepEqual(target.nativeHistory?.completedTurnRefs.map(ref => ref.nativeId), ["legacy-completed"]);
    assert.equal(readPmContinuation(f.lease, second.nativeSession!, "fixture:original-v2")!.nativeHistory?.nativeSessionId, "legacy-native");
    closeStore();
    await f.service.run(f.context, { model: "explicit", prompt: "continue target", resume: forked });
    assert.equal(f.starts[2].runOrdinal, 8);
    assert.equal(f.starts[2].providerTurnOrdinal, 6);
  } finally { f.releaseProbe(); }
});

test("active-branch retention prunes native-only proof without dropping retained graph turns", async () => {
  let runs = 0;
  const f = await harness((input, emit) => Effect.gen(function* () {
    if (++runs === 2) yield* emit({ type: "provider_thread.updated", driver, providerThread: input.providerThread,
      retainedNativeTurnIds: ["legacy-kept", "native-turn:1"] });
    yield* finish(input, emit);
  }), nativeHistoryProbe, { canFork: true, configure: runtime => {
    const read = runtime.readThreadSnapshot;
    Object.assign(runtime, { readThreadSnapshot: (input: Parameters<typeof read>[0]) => read(input).pipe(Effect.map(snapshot =>
      input.providerThread.nativeThreadRef?.nativeId === "fork-native-session" ? { ...snapshot,
        nativeHistory: { nativeSessionId: "fork-native-session",
          completedTurnRefs: [{ driver, nativeId: "legacy-kept", strength: "strong" as const }] } } : snapshot)) });
  } });
  try {
    const first = await f.service.run(f.context, { model: "explicit", prompt: "one", resume: legacySource });
    closeStore();
    const result = await f.service.run(f.context, { model: "explicit", prompt: "two", resume: first.nativeSession });
    const loaded = readPmContinuation(f.lease, result.nativeSession!, "fixture:original-v2")!;
    assert.deepEqual(loaded.nativeHistory?.completedTurnRefs.map(ref => ref.nativeId), ["legacy-kept"]);
    assert.deepEqual(loaded.turns.map(value => value.nativeTurnRef?.nativeId), ["native-turn:1", "native-turn:2"]);
    await assert.rejects(f.service.fork(f.context, result.nativeSession!, { turnId: "legacy-completed" }), { code: "unsupported_fork" });
    assert.equal(f.forks.length, 0);
    await f.service.fork(f.context, result.nativeSession!, { turnId: "native-turn:1" });
    assert.equal(f.forks[0].providerTurnId, loaded.turns[0].id);
    assert.equal(f.forks[0].nativeCompletedTurnRef, undefined);
  } finally { f.releaseProbe(); }
});

for (const [field, value] of [
  ["id", "another-provider-thread"],
  ["providerInstanceId", "another-instance"],
  ["driver", "another-driver"],
  ["providerSessionId", "another-provider-session"],
  ["appThreadId", "another-chat"],
  ["nativeThreadRef", { driver, nativeId: "another-native-session", strength: "strong" }],
  ["nativeThreadRef", { driver: "another-driver", nativeId: "fork-native-session", strength: "strong" }],
  ["nativeThreadRef", { driver, nativeId: "fork-native-session", strength: "weak" }],
] as const) {
  test(`fork rejects mismatched target snapshot ${field}=${JSON.stringify(value)} without retrying or persisting it`, async () => {
    const f = await harness(finish, nativeHistoryProbe, { canFork: true, configure: runtime => {
      const read = runtime.readThreadSnapshot;
      Object.assign(runtime, { readThreadSnapshot: (input: Parameters<typeof read>[0]) => read(input).pipe(Effect.map(snapshot => {
        if (input.providerThread.nativeThreadRef?.nativeId !== "fork-native-session") return snapshot;
        return { ...snapshot,
          providerThread: Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderThread))({ ...snapshot.providerThread, [field]: value }),
          nativeHistory: { nativeSessionId: "fork-native-session",
            completedTurnRefs: [{ driver, nativeId: "legacy-completed", strength: "strong" as const }] } };
      })) });
    } });
    try {
      await assert.rejects(f.service.fork(f.context, legacySource, { turnId: "legacy-completed" }), { code: "provider_fork_unconfirmed" });
      assert.equal(f.forks.length, 1);
      assert.equal(f.starts.length, 0);
      assert.equal(listRecords(PM_CONTINUATIONS).length, 0);
      assert.equal(f.counts().closed, 1);
    } finally { f.releaseProbe(); }
  });
}

for (const failure of ["reply-identity", "unknown-native-side-effect", "missing-target-proof", "source-proof-relabel", "stale-lease"] as const) {
  test(`fork ${failure} remains unconfirmed and never retries the native side effect`, async () => {
    let invalidate = () => {};
    const f = await harness(finish, nativeHistoryProbe, { canFork: true, configure: runtime => {
      const fork = runtime.forkThread;
      const read = runtime.readThreadSnapshot;
      Object.assign(runtime, {
        forkThread: (input: ProviderAdapterV2ForkThreadInput) => fork(input).pipe(Effect.flatMap(reply => {
          if (failure === "unknown-native-side-effect") return Effect.fail(pmExecutionError(502, "provider_error", "Native transport dropped after fork dispatch."));
          return Effect.succeed(failure === "reply-identity" ? { ...reply, appThreadId: ThreadId.make("foreign-owner") } : reply);
        })),
        readThreadSnapshot: (input: Parameters<typeof read>[0]) => read(input).pipe(Effect.map(snapshot => {
          if (input.providerThread.nativeThreadRef?.nativeId !== "fork-native-session") return snapshot;
          if (failure === "stale-lease") invalidate();
          return failure === "missing-target-proof" ? snapshot : { ...snapshot,
            nativeHistory: { nativeSessionId: failure === "source-proof-relabel" ? "legacy-native" : "fork-native-session",
              completedTurnRefs: [{ driver, nativeId: "legacy-completed", strength: "strong" as const }] } };
        })),
      });
    } });
    invalidate = () => { f.leaseState.live = false; };
    try {
      await assert.rejects(f.service.fork(f.context, legacySource, { turnId: "legacy-completed" }), { code: "provider_fork_unconfirmed" });
      assert.equal(f.forks.length, 1);
      assert.equal(f.starts.length, 0);
      assert.equal(listRecords(PM_CONTINUATIONS).length, 0);
    } finally { f.releaseProbe(); }
  });
}

test("a native terminal drains a still-running start operation without hanging", { timeout: 2000 }, async () => {
  const f = await harness((input, emit) => finish(input, emit).pipe(Effect.andThen(Effect.never)));
  try {
    assert.equal((await f.service.run(f.context, { model: "explicit", prompt: "once" })).text, "original answer");
    assert.equal(f.counts().closed, 1);
  } finally { f.releaseProbe(); }
});

test("native cancellation converges after interrupt acknowledgement even without a terminal event", { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const f = await harness((input, emit) => emit({ type: "provider_turn.updated", driver, providerTurn: turn({
    id: "running-root", providerThreadId: input.providerThread.id, nodeId: input.rootNodeId, runAttemptId: input.attemptId,
    nativeTurnRef: null, ordinal: input.providerTurnOrdinal, status: "running", startedAt: now, completedAt: null,
  }) }).pipe(Effect.andThen(Effect.never)));
  let sessions = 0;
  try {
    const running = f.service.run(f.context, { model: "explicit", prompt: "once", signal: controller.signal,
      onSession: () => { if (++sessions === 2) started.resolve(); } });
    await started.promise;
    controller.abort();
    await assert.rejects(running, { terminalStatus: "cancelled" });
    assert.equal(f.counts().interrupts, 1);
    assert.equal(f.counts().closed, 1);
  } finally { controller.abort(); f.releaseProbe(); }
});

test("callback, interrupt and start-finalizer failures all survive native cleanup", { timeout: 2000 }, async () => {
  const callback = new Error("consumer callback failed");
  const interrupt = new Error("native interrupt failed");
  const finalizer = new Error("native start finalizer failed");
  const scopeFinalizer = new Error("native session scope finalizer failed");
  const f = await harness((input, emit) => finish(input, event => event.type === "provider_turn.updated"
    ? emit({ ...event, providerTurn: { ...event.providerTurn, status: "running", completedAt: null } })
    : event.type === "turn.terminal" ? Effect.void : emit(event)).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.die(finalizer))),
    undefined, { closeFailure: scopeFinalizer, configure: runtime => { Object.assign(runtime, { interruptTurn: () => Effect.fail(interrupt) }); } });
  try {
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "once", onEvent: () => { throw callback; } }), error => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.includes(callback));
      assert.ok(error.errors.includes(interrupt));
      assert.ok(error.errors.includes(finalizer));
      assert.ok(error.errors.includes(scopeFinalizer));
      return true;
    });
    assert.equal(f.counts().closed, 1);
  } finally { f.releaseProbe(); }
});

test("native-only history can fork and reopen without inventing application turns or choosing an arbitrary historic head", async () => {
  const f = await harness(finish, nativeHistoryProbe, { canFork: true, configure: runtime => {
    const read = runtime.readThreadSnapshot;
    Object.assign(runtime, { readThreadSnapshot: (input: Parameters<typeof read>[0]) => read(input).pipe(Effect.map(snapshot =>
      input.providerThread.nativeThreadRef?.nativeId === "fork-native-session" ? { ...snapshot,
        nativeHistory: { nativeSessionId: "fork-native-session",
          completedTurnRefs: [{ driver, nativeId: "legacy-completed", strength: "strong" as const }] } } : snapshot)) });
  } });
  try {
    const forked = await f.service.fork(f.context, legacySource, { turnId: "legacy-completed" });
    assert.equal(f.starts.length, 0);
    assert.deepEqual(f.forks[0].sourceProviderTurns, []);
    assert.deepEqual(f.forks[0].nativeCompletedTurnRef, { driver, nativeId: "legacy-completed", strength: "strong" });
    assert.equal(forked.turnId, undefined);
    closeStore();
    const boundary = { ...forked, turnId: "legacy-completed" };
    const target = readPmContinuation(f.lease, boundary, "fixture:original-v2", undefined, true)!;
    assert.deepEqual(target.turns, []);
    assert.equal(target.nativeHistory?.nativeSessionId, forked.sessionId);
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "unproven tip must not dispatch", resume: boundary }),
      { code: "session_mismatch" });
    assert.equal(f.starts.length, 0);
    const result = await f.service.run(f.context, { model: "explicit", prompt: "first real target turn", resume: forked });
    assert.equal(f.starts[0].providerTurnOrdinal, 1);
    assert.equal(readPmContinuation(f.lease, result.nativeSession!, "fixture:original-v2")!.turns.length, 1);
  } finally { f.releaseProbe(); }
});

test("a completed root is not interrupted when a callback fails before its terminal event is consumed", async () => {
  const callback = new Error("native completion callback failed");
  const f = await harness(finish, undefined, { configure: runtime => {
    Object.assign(runtime, { interruptTurn: () => Effect.die(new Error("An already completed root must not be interrupted.")) });
  } });
  try {
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "once", onSession: session => {
      if (session.turnId) throw callback;
    } }), error => error === callback);
    assert.equal(f.counts().closed, 1);
  } finally { f.releaseProbe(); }
});

test("preparation cancellation preserves terminal status alongside session Scope cleanup failures", { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const failure = new Error("cancelled preparation cleanup failed");
  const f = await harness(finish, undefined, { closeFailure: failure, configure: () => { controller.abort(); } });
  try {
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "must not dispatch", signal: controller.signal }), error => {
      assert.ok(error instanceof AggregateError);
      assert.ok("terminalStatus" in error && error.terminalStatus === "cancelled");
      assert.ok(error.errors.includes(failure));
      return true;
    });
    assert.equal(f.starts.length, 0);
    assert.equal(f.counts().closed, 1);
  } finally { f.releaseProbe(); }
});


test("confirmed Codex worktree uses bounded writes; no grant retains read-only and mismatches fail closed", async () => {
  for (const grant of [undefined, "/workspace", "/outside"]) {
    const f = await harness(finish);
    try {
      f.context.execution = { threadId: "delivery-thread", generationId: "delivery-generation", messageId: "delivery-message", scope: { workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "PRJ-001" } };
      f.context.authorizeExecution = async () => {};
      f.context.authorizeWorktreeWrite = async () => grant;
      const operation = f.service.run(f.context, { model: "explicit", prompt: "test" });
      if (grant === "/outside") { await assert.rejects(operation, { code: "scope_required" }); assert.equal(f.starts.length, 0); }
      else {
        await operation;
        assert.equal(f.starts[0].runtimePolicy.approvalPolicy, grant ? "on-request" : "untrusted");
        assert.deepEqual(f.starts[0].runtimePolicy.sandboxPolicy, grant ? { type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } : { type: "readOnly" });
      }
    } finally { f.releaseProbe(); }
  }
});
test("a technical caller cannot grant native worktree writes without live Chat identity", async () => {
  const f = await harness(finish);
  try {
    f.context.authorizeWorktreeWrite = async () => "/workspace";
    await assert.rejects(f.service.run(f.context, { model: "explicit", prompt: "test" }), { code: "scope_required" });
    assert.equal(f.starts.length, 0);
  } finally { f.releaseProbe(); }
});
