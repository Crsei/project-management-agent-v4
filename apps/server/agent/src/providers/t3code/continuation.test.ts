import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { ProviderDriverKind, ProviderInstanceId, ThreadId, OrchestrationV2ProviderSessionJson, OrchestrationV2ProviderThreadJson, OrchestrationV2ProviderTurnJson } from "@t3tools/contracts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import type { PmProviderLease } from "./contract.ts";
import { bindPmContinuationSink, continuationKey, makePmProviderContinuationRequests, nextPmOrdinal, nextPmProviderTurnOrdinal, PM_CONTINUATIONS, readPmContinuation, savePmContinuation } from "./continuation.ts";
import { closeStore, readRecord, writeRecord } from "../../durable/store.ts";
import { initializeNativeOutput, emitNativeNotification, endNativeOutput, getNativeOutput } from "../../durable/native-output.ts";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { makePmProviderRuntimeHost, pmRuntimeBinding } from "./runtime-host.ts";

let directory: string;
const previousDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "t3-continuation-")); process.env.AGENT_WORKSPACE_DATA_DIR = directory; });
afterEach(async () => { closeStore(); await rm(directory, { recursive: true, force: true });
  if (previousDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousDirectory; });
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("account");
const identity = { driverKind: driver, continuationKey: "account:binding" };
const lease: PmProviderLease = { localDriver: "codex", instanceId, revision: 4, cwd: "/workspace", nativeHome: "/native-home", continuationIdentity: identity,
  assertCurrent: Effect.void,
  instance: { instanceId, driverKind: driver, continuationIdentity: identity, displayName: undefined, enabled: true,
    get snapshot(): never { throw new Error("Codec must not read provider state"); },
    get textGeneration(): never { throw new Error("Codec must not generate text"); },
    get orchestrationAdapter(): never { throw new Error("Codec must not start native processes"); } },
};
const now = "2026-10-30T00:00:00.000Z";
const session = Schema.decodeUnknownSync(OrchestrationV2ProviderSessionJson)({ id: "provider-session", driver, providerInstanceId: instanceId, status: "ready",
  cwd: lease.cwd, model: "explicit", capabilities: AcpProviderCapabilitiesV2, createdAt: now, updatedAt: now, lastError: null });
const thread = Schema.decodeUnknownSync(OrchestrationV2ProviderThreadJson)({ id: "provider-thread", driver, providerInstanceId: instanceId,
  providerSessionId: session.id, appThreadId: "owner", ownerNodeId: null, nativeThreadRef: { driver, nativeId: "native-session", strength: "strong" },
  nativeConversationHeadRef: null, status: "idle", firstRunOrdinal: 1, lastRunOrdinal: 2, handoffIds: [], forkedFrom: null, createdAt: now, updatedAt: now });
const turn = Schema.decodeUnknownSync(OrchestrationV2ProviderTurnJson)({ id: "provider-turn", providerThreadId: thread.id, nodeId: "root", runAttemptId: "attempt",
  nativeTurnRef: { driver, nativeId: "native-turn", strength: "strong" }, ordinal: 2, status: "completed", startedAt: now, completedAt: now });

test("original JSON schemas round-trip timestamps and native IDs without widening NativeSessionRef", () => {
  const ref = savePmContinuation({ lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner", generationId: "generation", session, thread, turns: [turn] })!;
  assert.deepEqual(ref, { providerInstanceId: "account", driver: "codex", sessionId: "native-session", instanceRevision: 4, cwd: "/workspace", modelId: "explicit", turnId: "native-turn" });
  const raw = readRecord<Record<string, unknown>>(PM_CONTINUATIONS, continuationKey(lease, ref.sessionId))!;
  assert.equal((raw.providerSessionJson as Record<string, unknown>).createdAt, now);
  const loaded = readPmContinuation(lease, ref, "codex:fixture-handshake", "owner")!;
  assert.equal(loaded.thread.id, thread.id);
  assert.equal(nextPmOrdinal(loaded.thread.lastRunOrdinal ?? 0), 3);
  assert.throws(() => readPmContinuation({ ...lease, nativeHome: "/other-home" }, ref, "codex:fixture-handshake"), { code: "session_mismatch" });
  assert.throws(() => readPmContinuation(lease, ref, "another-dialect"), { code: "session_mismatch" });
  assert.throws(() => readPmContinuation(lease, ref, "codex:fixture-handshake", "different-owner"), { code: "session_mismatch" });
});

test("missing sidecar is eligible for metadata adoption, incompatible schema is not, and stale generations cannot overwrite", () => {
  const old = { providerInstanceId: "account", driver: "codex" as const, sessionId: "legacy", instanceRevision: 4, cwd: "/workspace", modelId: "explicit" };
  assert.equal(readPmContinuation(lease, old, "codex:fixture-handshake"), undefined);
  writeRecord(PM_CONTINUATIONS, continuationKey(lease, old.sessionId), { version: 999 });
  assert.throws(() => readPmContinuation(lease, old, "codex:fixture-handshake"), { code: "session_mismatch" });
  writeRecord("chat:generations", "old-generation", { threadId: "owner", status: "interrupted" });
  assert.throws(() => savePmContinuation({ lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner", generationId: "old-generation", session, thread, turns: [turn] }), { code: "session_mismatch" });
  assert.throws(() => nextPmOrdinal(Number.MAX_SAFE_INTEGER), { code: "session_mismatch" });
});

test("large original turn histories use bounded-stack ordinal selection and reject invalid metadata", () => {
  function* history() { for (let ordinal = 1; ordinal <= 200_000; ordinal++) yield { ordinal }; }
  assert.equal(nextPmProviderTurnOrdinal(history()), 200_001);
  assert.equal(nextPmProviderTurnOrdinal([]), 1);
  assert.throws(() => nextPmProviderTurnOrdinal([{ ordinal: 0 }]), { code: "session_mismatch" });
  assert.throws(() => nextPmProviderTurnOrdinal([{ ordinal: Number.MAX_SAFE_INTEGER }]), { code: "session_mismatch" });
});

test("scope shutdown drains native child notifications without reopening a completed Chat generation", async () => {
  initializeNativeOutput("settled", "owner", "running");
  endNativeOutput("settled", "completed");
  writeRecord("chat:generations", "settled", { threadId: "owner", providerInstanceId: instanceId, status: "completed" });
  emitNativeNotification("settled", "owner", { id: "native-child:child", type: "notification", status: "completed", input: { providerThreadId: thread.id } });
  const context: ProviderDriverContext = { instanceId, driver: "codex", revision: 4, config: {}, cwd: "/workspace",
    homeDirectory: "/native-home", stateDirectory: "/state", env: {}, execution: { threadId: "owner", generationId: "settled",
      messageId: "message", scope: { workspaceId: "workspace", projectId: null } } };
  let cleared = false;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const requests = yield* makePmProviderContinuationRequests(context, makePmProviderRuntimeHost());
    yield* requests.offer({ threadId: ThreadId.make("child"), providerThreadId: thread.id, driver, detail: null,
      hostExecution: { threadId: ThreadId.make("owner"), executionId: "settled" },
      notification: { source: { kind: "command" }, outcome: "completed", summary: "Native child result" },
      clearIfCurrent: () => Effect.sync(() => { cleared = true; }) });
  })));
  assert.equal(cleared, true);
  assert.equal(getNativeOutput("settled")?.status, "completed");
  assert.equal(readRecord<{ status: string }>("chat:generations", "settled")?.status, "completed");
  assert.ok(getNativeOutput("settled")?.items.some((item) => item.text === "Native child result"));
});

test("native-only completed history survives reopening without fabricated application turns", () => {
  const nativeHistory = { nativeSessionId: "native-session",
    completedTurnRefs: [{ driver, nativeId: "legacy-completed", strength: "strong" as const }] };
  const base = savePmContinuation({ lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner", generationId: "generation",
    session, thread, turns: [], nativeHistory })!;
  assert.equal(base.turnId, undefined);
  const source = { ...base, turnId: "legacy-completed", messageId: "older-optional-head" };
  closeStore();
  const loaded = readPmContinuation(lease, source, "codex:fixture-handshake", "owner", true)!;
  assert.deepEqual(loaded.turns, []);
  assert.throws(() => readPmContinuation(lease, { ...source, turnId: "unproven" }, "codex:fixture-handshake", "owner", true),
    { code: "session_mismatch" });
  const key = continuationKey(lease, source.sessionId);
  const record = readRecord<Record<string, unknown>>(PM_CONTINUATIONS, key)!;
  for (const invalid of [
    { ...nativeHistory, nativeSessionId: "another-native-session" },
    { ...nativeHistory, completedTurnRefs: [{ driver: "another-driver", nativeId: "legacy-completed", strength: "strong" }] },
    { ...nativeHistory, completedTurnRefs: [{ driver, nativeId: "legacy-completed", strength: "weak" }] },
    { ...nativeHistory, completedTurnRefs: [{ driver, nativeId: "", strength: "strong" }] },
    { ...nativeHistory, completedTurnRefs: [] },
    { ...nativeHistory, completedTurnRefs: [{ driver, nativeId: "   ", strength: "strong" }] },
    { ...nativeHistory, latestCompletedTurnRef: { driver, nativeId: "unproven-tip", strength: "strong" } },
    { ...nativeHistory, latestCompletedTurnRef: { driver: "another-driver", nativeId: "legacy-completed", strength: "strong" } },
  ]) {
    writeRecord(PM_CONTINUATIONS, key, { ...record, nativeHistory: invalid });
    assert.throws(() => readPmContinuation(lease, source, "codex:fixture-handshake", "owner", true), { code: "session_mismatch" });
  }
});

test("native current-tip proof takes precedence over proof-array order but an older strong graph turn is not the current head", () => {
  const latest = { driver, nativeId: "latest-native", strength: "strong" as const };
  const older = { driver, nativeId: "older-native", strength: "strong" as const };
  const input = { lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner", generationId: "generation", session, thread };
  const nativeHistory = { nativeSessionId: "native-session", completedTurnRefs: [latest, older] };
  const ref = savePmContinuation({ ...input, turns: [], nativeHistory: { ...nativeHistory, latestCompletedTurnRef: latest } })!;
  assert.equal(ref.turnId, "latest-native");
  closeStore();
  assert.equal(readPmContinuation(lease, ref, input.protocol)?.nativeHistory?.latestCompletedTurnRef?.nativeId, "latest-native");
  const newerWeakTurn = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderTurnJson))({
    ...turn, id: "newer-weak-turn", ordinal: 3,
    nativeTurnRef: { driver, nativeId: "newer-unproven", strength: "weak" },
  });
  const unproven = savePmContinuation({ ...input, turns: [turn, newerWeakTurn], nativeHistory })!;
  assert.equal(unproven.turnId, undefined);
  assert.equal(readPmContinuation(lease, { ...unproven, turnId: "native-turn" }, input.protocol, "owner", true)?.turns.length, 2);
});

test("older proven boundaries remain forkable but cannot resume an advanced native session", () => {
  const nextTurn = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderTurnJson))({
    ...turn, id: "newer-turn", ordinal: 3,
    nativeTurnRef: { driver, nativeId: "latest-native-turn", strength: "strong" },
  });
  const old = savePmContinuation({ lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner",
    generationId: "generation", session, thread, turns: [turn] })!;
  const latest = savePmContinuation({ lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner",
    generationId: "generation", session, thread, turns: [turn, nextTurn] })!;
  closeStore();
  assert.throws(() => readPmContinuation(lease, old, "codex:fixture-handshake", "owner"), { code: "session_mismatch" });
  assert.equal(readPmContinuation(lease, old, "codex:fixture-handshake", undefined, true)?.turns.length, 2);
  assert.equal(readPmContinuation(lease, latest, "codex:fixture-handshake", "owner")?.turns.length, 2);
  const headThread = { ...thread, nativeConversationHeadRef: { driver, nativeId: "latest-message", strength: "strong" as const } };
  savePmContinuation({ lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner",
    generationId: "generation", session, thread: headThread, turns: [turn, nextTurn] });
  assert.throws(() => readPmContinuation(lease, { ...latest, messageId: "stale-message" }, "codex:fixture-handshake", "owner"), { code: "session_mismatch" });
  assert.ok(readPmContinuation(lease, { ...old, messageId: "stale-optional-head" }, "codex:fixture-handshake", undefined, true));
});

test("unordered native history cannot establish a resume tip, while cursorless resume and exact forks remain valid", () => {
  const nativeHistory = { nativeSessionId: "native-session", completedTurnRefs: [
    { driver, nativeId: "first-proof", strength: "strong" as const },
    { driver, nativeId: "second-proof", strength: "strong" as const },
  ] };
  const input = { lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner", generationId: "generation", session, thread, turns: [], nativeHistory };
  const cursorless = savePmContinuation(input)!;
  assert.equal(cursorless.turnId, undefined);
  closeStore();
  for (const proof of nativeHistory.completedTurnRefs) {
    const explicitTurn = { ...cursorless, turnId: proof.nativeId };
    const explicitMessage = { ...cursorless, messageId: proof.nativeId };
    assert.throws(() => readPmContinuation(lease, explicitTurn, input.protocol, "owner"), { code: "session_mismatch" });
    assert.throws(() => readPmContinuation(lease, explicitMessage, input.protocol, "owner"), { code: "session_mismatch" });
    assert.ok(readPmContinuation(lease, explicitTurn, input.protocol, undefined, true));
  }
  assert.ok(readPmContinuation(lease, cursorless, input.protocol, "owner"));
  const strongHead = savePmContinuation({ ...input, thread: { ...thread,
    nativeConversationHeadRef: { driver, nativeId: "second-proof", strength: "strong" as const } } })!;
  assert.equal(strongHead.messageId, "second-proof");
  assert.ok(readPmContinuation(lease, strongHead, input.protocol, "owner"));
});

test("a failed newer root leaves historical completed turns forkable but not current resume cursors", () => {
  const input = { lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner",
    generationId: "generation", session, thread };
  const old = savePmContinuation({ ...input, turns: [turn] })!;
  const failedTurn = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderTurnJson))({
    ...turn, id: "newer-failed-turn", ordinal: 3, status: "failed",
    nativeTurnRef: { driver, nativeId: "failed-native-turn", strength: "strong" },
  });
  const current = savePmContinuation({ ...input, turns: [turn, failedTurn] })!;
  assert.equal(current.turnId, undefined);
  closeStore();
  assert.throws(() => readPmContinuation(lease, old, input.protocol, "owner"), { code: "session_mismatch" });
  assert.ok(readPmContinuation(lease, old, input.protocol, undefined, true));
  assert.ok(readPmContinuation(lease, current, input.protocol, "owner"));
});

test("a no-tool technical operation cannot write a matching Chat's native notifications", async () => {
  initializeNativeOutput("foreign", "owner", "running");
  const before = getNativeOutput("foreign");
  let cleared = false;
  const context: ProviderDriverContext = { instanceId, driver: "codex", revision: 4, config: {}, cwd: "/workspace",
    homeDirectory: "/native-home", stateDirectory: "/state", env: {} };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const requests = yield* makePmProviderContinuationRequests(context, makePmProviderRuntimeHost());
    yield* requests.offer({ threadId: ThreadId.make("owner"), providerThreadId: thread.id, driver, detail: "not admitted",
      clearIfCurrent: () => Effect.sync(() => { cleared = true; }) });
  })));
  assert.equal(cleared, true);
  assert.deepEqual(getNativeOutput("foreign"), before);
});

const retainedContext: ProviderDriverContext = { instanceId, driver: "codex", revision: 4, config: {}, cwd: "/workspace",
  homeDirectory: "/native-home", stateDirectory: "/state", env: {} };
const ownerThreadId = ThreadId.make("owner");

function seedOwnedGeneration(executionId: string, status: "running" | "completed" = "running") {
  writeRecord("chat:generations", executionId, { threadId: ownerThreadId, providerInstanceId: instanceId, status });
  initializeNativeOutput(executionId, ownerThreadId, "running");
  if (status === "completed") endNativeOutput(executionId, status);
  return pmRuntimeBinding(retainedContext, ownerThreadId, executionId);
}

function drainBufferedOffers(requests: { readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void> }) {
  return Effect.gen(function* () {
    const drained = Promise.withResolvers<void>();
    yield* requests.offer({ threadId: ThreadId.make("unowned-drain-barrier"), providerThreadId: thread.id, driver, detail: null,
      clearIfCurrent: () => Effect.sync(() => { drained.resolve(); }) });
    yield* Effect.promise(() => drained.promise);
  });
}

test("a status-first retained continuation service adopts only explicitly authorized original generation owners", async () => {
  const runtimeHost = makePmProviderRuntimeHost();
  const adopted: string[] = [];
  const authorizations: string[] = [];
  const failures: unknown[] = [];
  const cleared: string[] = [];
  assert.equal(retainedContext.execution, undefined);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const requests = yield* makePmProviderContinuationRequests(retainedContext, runtimeHost);
    for (const executionId of ["first-live-owner", "next-live-owner"]) {
      const binding = seedOwnedGeneration(executionId);
      const grant = { active: true };
      yield* Effect.scoped(Effect.gen(function* () {
        yield* runtimeHost.bind(binding, action => Effect.suspend(() => {
          authorizations.push(`${executionId}:${action}`);
          return grant.active && action === "tool" ? Effect.void : Effect.fail(new Error("Native continuation authorization revoked."));
        }));
        yield* Effect.acquireRelease(Effect.sync(() => bindPmContinuationSink(ownerThreadId, {
          executionId,
          accept: async request => { adopted.push(request.hostExecution!.executionId); return grant.active; },
          fail: error => { failures.push(error); },
        })), release => Effect.sync(release));
        yield* requests.offer({ threadId: ownerThreadId, providerThreadId: thread.id, driver, detail: "Original buffered native work",
          hostExecution: { threadId: binding.threadId, executionId: binding.executionId },
          clearIfCurrent: () => Effect.sync(() => { cleared.push(executionId); }) });
        yield* drainBufferedOffers(requests);
      }));
      grant.active = false;
      writeRecord("chat:generations", executionId, { threadId: ownerThreadId, providerInstanceId: instanceId, status: "completed" });
      endNativeOutput(executionId, "completed");
    }
  })));
  assert.deepEqual(adopted, ["first-live-owner", "next-live-owner"]);
  assert.deepEqual(authorizations, ["first-live-owner:tool", "next-live-owner:tool"]);
  assert.deepEqual(failures, []);
  assert.deepEqual(cleared, []);
  assert.equal(getNativeOutput("next-live-owner")?.status, "completed");
  assert.deepEqual(getNativeOutput("next-live-owner")?.items, []);
});

for (const during of [false, true]) {
  test(`revoked native buffered authority ${during ? "during" : "before"} authorization never reaches adoption`, async () => {
    const runtimeHost = makePmProviderRuntimeHost();
    const binding = seedOwnedGeneration("revoked-owner");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let granted = true;
    let adopted = 0;
    const actions: string[] = [];
    const failures: unknown[] = [];
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const requests = yield* makePmProviderContinuationRequests(retainedContext, runtimeHost);
        yield* runtimeHost.bind(binding, action => Effect.gen(function* () {
          actions.push(action);
          started.resolve();
          if (during) yield* Effect.promise(() => finish.promise);
          if (!granted || action !== "tool") return yield* Effect.fail(new Error("PM access revoked."));
        }));
        yield* Effect.acquireRelease(Effect.sync(() => bindPmContinuationSink(ownerThreadId, {
          executionId: binding.executionId,
          accept: async () => { adopted++; return true; },
          fail: error => { failures.push(error); },
        })), release => Effect.sync(release));
        if (!during) granted = false;
        yield* requests.offer({ threadId: ownerThreadId, providerThreadId: thread.id, driver, detail: "Buffered work must not dispatch",
          hostExecution: { threadId: binding.threadId, executionId: binding.executionId } });
        yield* Effect.promise(() => started.promise);
        granted = false;
        finish.resolve();
        yield* drainBufferedOffers(requests);
      })));
      assert.equal(adopted, 0);
      assert.deepEqual(actions, ["tool"]);
      assert.equal(failures.length, 1);
      assert.ok(failures[0] instanceof Error && "code" in failures[0]);
      assert.equal(failures[0].code, "provider_continuation_failed");
      assert.deepEqual(getNativeOutput(binding.executionId)?.items, []);
    } finally { finish.resolve(); }
  });
}

test("stale and missing captured owners cannot borrow a newer generation's sink or native output", async () => {
  const runtimeHost = makePmProviderRuntimeHost();
  const oldBinding = seedOwnedGeneration("completed-owner", "completed");
  const currentBinding = seedOwnedGeneration("current-owner");
  const before = getNativeOutput(currentBinding.executionId);
  let granted = true;
  let authorized = 0;
  let adopted = 0;
  let cleared = 0;
  const failures: unknown[] = [];
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const requests = yield* makePmProviderContinuationRequests(retainedContext, runtimeHost);
    yield* runtimeHost.bind(currentBinding, action => Effect.suspend(() => {
      authorized++;
      return granted && action === "tool" ? Effect.void : Effect.fail(new Error("Current generation grant revoked."));
    }));
    yield* Effect.acquireRelease(Effect.sync(() => bindPmContinuationSink(ownerThreadId, {
      executionId: currentBinding.executionId, accept: async () => { adopted++; return true; },
      fail: error => { failures.push(error); },
    })), release => Effect.sync(release));
    for (const hostExecution of [
      { threadId: oldBinding.threadId, executionId: oldBinding.executionId },
      undefined,
      { threadId: ThreadId.make("foreign-owner"), executionId: currentBinding.executionId },
    ]) {
      yield* requests.offer({ threadId: ownerThreadId, providerThreadId: thread.id, driver, detail: null, hostExecution,
        notification: { source: { kind: "command" }, outcome: "completed", summary: "Original stale native result" },
        clearIfCurrent: () => Effect.sync(() => { cleared++; }) });
    }
    yield* drainBufferedOffers(requests);
  })));
  granted = false;
  assert.equal(cleared, 3);
  assert.equal(authorized, 0);
  assert.equal(adopted, 0);
  assert.deepEqual(failures, []);
  assert.deepEqual(getNativeOutput(currentBinding.executionId), before);
  assert.equal(getNativeOutput(oldBinding.executionId)?.status, "completed");
  assert.ok(getNativeOutput(oldBinding.executionId)?.items.some(item => item.text === "Original stale native result"));
});

test("an in-flight original offer cannot adopt or fail the replacement generation after its binding drains", async () => {
  const runtimeHost = makePmProviderRuntimeHost();
  const binding = seedOwnedGeneration("draining-owner");
  const oldScope = await Effect.runPromise(Scope.make());
  const newScope = await Effect.runPromise(Scope.make());
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const grant = { old: true, current: true };
  let oldAdopted = 0;
  let newAdopted = 0;
  const oldFailures: unknown[] = [];
  const newFailures: unknown[] = [];
  let unbindOld: (() => void) | undefined;
  let unbindNew: (() => void) | undefined;
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const requests = yield* makePmProviderContinuationRequests(retainedContext, runtimeHost);
      yield* runtimeHost.bind(binding, action => Effect.gen(function* () {
        started.resolve();
        yield* Effect.promise(() => finish.promise);
        if (!grant.old || action !== "tool") return yield* Effect.fail(new Error("Original authorization revoked."));
      })).pipe(Effect.provideService(Scope.Scope, oldScope));
      unbindOld = bindPmContinuationSink(ownerThreadId, {
        executionId: binding.executionId, accept: async () => { oldAdopted++; return true; },
        fail: error => { oldFailures.push(error); },
      });
      yield* requests.offer({ threadId: ownerThreadId, providerThreadId: thread.id, driver, detail: "Original queued native work",
        hostExecution: { threadId: binding.threadId, executionId: binding.executionId } });
      yield* Effect.promise(() => started.promise);
      yield* Scope.close(oldScope, Exit.void);
      unbindOld();
      writeRecord("chat:generations", binding.executionId, { threadId: ownerThreadId, providerInstanceId: instanceId, status: "completed" });
      endNativeOutput(binding.executionId, "completed");
      const replacement = seedOwnedGeneration("replacement-owner");
      yield* runtimeHost.bind(replacement, action => Effect.suspend(() =>
        grant.current && action === "tool" ? Effect.void : Effect.fail(new Error("Replacement authorization revoked.")),
      )).pipe(Effect.provideService(Scope.Scope, newScope));
      unbindNew = bindPmContinuationSink(ownerThreadId, {
        executionId: replacement.executionId, accept: async () => { newAdopted++; return true; },
        fail: error => { newFailures.push(error); },
      });
      finish.resolve();
      yield* drainBufferedOffers(requests);
      assert.equal(oldAdopted, 0);
      assert.equal(newAdopted, 0);
      assert.equal(oldFailures.length, 1);
      assert.deepEqual(newFailures, []);
      assert.equal(getNativeOutput(replacement.executionId)?.status, "running");
      assert.deepEqual(getNativeOutput(replacement.executionId)?.items, []);
      yield* requests.offer({ threadId: ownerThreadId, providerThreadId: thread.id, driver, detail: "Replacement's own buffered work",
        hostExecution: { threadId: replacement.threadId, executionId: replacement.executionId } });
      yield* drainBufferedOffers(requests);
      assert.equal(newAdopted, 1);
    })));
  } finally {
    grant.old = false;
    grant.current = false;
    finish.resolve();
    unbindOld?.();
    unbindNew?.();
    await Effect.runPromise(Scope.close(oldScope, Exit.void));
    await Effect.runPromise(Scope.close(newScope, Exit.void));
  }
});

test("durable native proof and actual graph turns coexist across reopen without rewriting historical IDs", () => {
  const nativeHistory = { nativeSessionId: "native-session",
    completedTurnRefs: [{ driver, nativeId: "old-native-boundary", strength: "strong" as const }] };
  const ref = savePmContinuation({ lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner", generationId: "first",
    session, thread, turns: [], nativeHistory })!;
  assert.equal(ref.turnId, undefined);
  savePmContinuation({ lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner", generationId: "next",
    session, thread, turns: [turn], nativeHistory });
  closeStore();
  const old = readPmContinuation(lease, { ...ref, turnId: "old-native-boundary" }, "codex:fixture-handshake", "owner", true)!;
  const current = readPmContinuation(lease, { ...ref, turnId: "native-turn" }, "codex:fixture-handshake", "owner")!;
  assert.equal(old.turns.length, 1);
  assert.deepEqual(current.turns, [turn]);
  assert.deepEqual(current.nativeHistory, nativeHistory);
  assert.equal(current.turns[0].nodeId, "root");
  assert.equal(current.turns[0].runAttemptId, "attempt");
});

test("durable continuation rejects stale session, owner and native identity bindings", () => {
  const ref = savePmContinuation({ lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner", generationId: "generation",
    session, thread, turns: [turn] })!;
  const key = continuationKey(lease, ref.sessionId);
  const record = readRecord<Record<string, unknown>>(PM_CONTINUATIONS, key)!;
  const json = Schema.encodeSync(OrchestrationV2ProviderThreadJson)(thread);
  for (const patch of [
    { appThreadId: "foreign-owner" },
    { providerSessionId: "foreign-provider-session" },
    { nativeThreadRef: { driver: "foreign-driver", nativeId: "native-session", strength: "strong" } },
    { nativeThreadRef: { driver, nativeId: "native-session", strength: "weak" } },
  ]) {
    writeRecord(PM_CONTINUATIONS, key, { ...record, providerThreadJson: { ...json, ...patch } });
    assert.throws(() => readPmContinuation(lease, ref, "codex:fixture-handshake"), { code: "session_mismatch" });
  }
  assert.throws(() => savePmContinuation({ lease, protocol: "codex:fixture-handshake", ownerThreadId: "foreign-owner",
    generationId: "generation", session, thread, turns: [turn] }), { code: "session_mismatch" });
  assert.throws(() => savePmContinuation({ lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner",
    generationId: "generation", session, thread, turns: [],
    nativeHistory: { nativeSessionId: "foreign-native-session", completedTurnRefs: [{ driver, nativeId: "native-turn", strength: "strong" }] } }),
  { code: "session_mismatch" });
  assert.throws(() => savePmContinuation({ lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner",
    generationId: "generation", session, thread, turns: [], nativeHistory: { nativeSessionId: "native-session", completedTurnRefs: [] } }),
  { code: "session_mismatch" });
});

test("foreign and weak graph refs are retained as graph metadata but never become completed native proof", () => {
  for (const nativeTurnRef of [
    { driver: ProviderDriverKind.make("foreign-driver"), nativeId: "native-turn", strength: "strong" as const },
    { driver, nativeId: "native-turn", strength: "weak" as const },
  ]) {
    const ref = savePmContinuation({ lease, protocol: "codex:fixture-handshake", ownerThreadId: "owner", generationId: "generation",
      session, thread, turns: [{ ...turn, nativeTurnRef }] })!;
    assert.equal(ref.turnId, undefined);
    assert.equal(readPmContinuation(lease, ref, "codex:fixture-handshake")!.turns.length, 1);
    assert.throws(() => readPmContinuation(lease, { ...ref, turnId: "native-turn" }, "codex:fixture-handshake", "owner", true),
      { code: "session_mismatch" });
  }
});

test("scope cancellation drains in-flight and queued notices and preserves every cleanup error", { timeout: 2000 }, async () => {
  const runtimeHost = makePmProviderRuntimeHost();
  const binding = seedOwnedGeneration("cancelled-native-worker");
  const started = Promise.withResolvers<void>();
  const cleaned: number[] = [];
  const failures: unknown[] = [];
  const errors = [new Error("in-flight cleanup failed"), new Error("queued cleanup failed"), new Error("last cleanup failed")];
  await assert.rejects(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* runtimeHost.bind(binding, () => Effect.void);
    yield* Effect.acquireRelease(Effect.sync(() => bindPmContinuationSink(ownerThreadId, {
      executionId: binding.executionId, accept: async () => { started.resolve(); return new Promise<boolean>(() => {}); },
      fail: error => { failures.push(error); },
    })), release => Effect.sync(release));
    const requests = yield* makePmProviderContinuationRequests(retainedContext, runtimeHost);
    for (const [index, error] of errors.entries()) yield* requests.offer({
      threadId: ownerThreadId, providerThreadId: thread.id, driver, detail: `cleanup-${index}`,
      hostExecution: { threadId: binding.threadId, executionId: binding.executionId },
      clearIfCurrent: () => Effect.sync(() => { cleaned.push(index); }).pipe(Effect.andThen(Effect.die(error))),
    });
    yield* Effect.promise(() => started.promise);
  }))), error => {
    assert.ok(error instanceof AggregateError);
    for (const failure of errors) assert.ok(error.errors.includes(failure));
    return true;
  });
  assert.deepEqual(cleaned, [0, 1, 2]);
  assert.deepEqual(failures, [], "interrupting the worker is not a native adoption failure");
});

test("a worker cleanup failure remains visible when the queue scope later closes", { timeout: 2000 }, async () => {
  const failure = new Error("original notice cleanup failed");
  await assert.rejects(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const requests = yield* makePmProviderContinuationRequests(retainedContext, makePmProviderRuntimeHost());
    yield* requests.offer({ threadId: ThreadId.make("unowned"), providerThreadId: thread.id, driver, detail: null,
      clearIfCurrent: () => Effect.die(failure) });
    yield* drainBufferedOffers(requests);
  }))), error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.includes(failure));
    return true;
  });
});
