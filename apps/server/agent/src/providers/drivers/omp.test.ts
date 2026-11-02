import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  OrchestrationV2ProviderSessionJson, OrchestrationV2ProviderThreadJson,
  ProviderDriverKind, ProviderInstanceId, ThreadId,
} from "@t3tools/contracts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import type {
  ProviderAdapterV2EnsureThreadInput, ProviderAdapterV2SessionRuntime, ProviderAdapterV2ThreadSnapshot,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { bindOmpSessionEvidence } from "@t3tools/provider-omp/server/sessionEvidence";
import { OMP_STATUS_TIMEOUT_MS } from "@t3tools/provider-omp/server/status";
import { ompAdapter } from "./omp.ts";
import { getNativeProviderAdapter } from "../driver-registry.ts";
import { getProviderModels, readNativeProviderStatus, resolveCatalogModel } from "../catalog.ts";
import { createProviderInstance, getStoredInstance, listStoredInstances, providerContext, updateProviderInstance } from "../instances.ts";
import { closeStore } from "../../durable/store.ts";
import { makePmNativeTestHost } from "../t3code/testing/native-test-host.testkit.ts";
import { ompProtocolResolver } from "../t3code/families/omp.ts";
import { pmExecutionError, readPmContinuation, savePmContinuation, type PmProtocolOperation } from "../t3code/continuation.ts";
import type { PmProviderLease } from "../t3code/contract.ts";
import type { ProviderDriverContext, ProviderDriverStatus } from "../driver-adapter.ts";

const driver = ProviderDriverKind.make("omp");
const instanceId = ProviderInstanceId.make("omp-boundary");
const now = "2026-10-31T00:00:00.000Z";

// Metadata-only host fixture: no native process, model result or permission is invented here.
function operation() {
  const context: ProviderDriverContext = { instanceId, driver: "omp", config: {}, revision: 7,
    cwd: "/workspace", homeDirectory: "/native-home", stateDirectory: "/pm-state", env: { HOME: "/native-home" } };
  const session = Schema.decodeUnknownSync(OrchestrationV2ProviderSessionJson)({ id: "omp-provider-session", driver,
    providerInstanceId: instanceId, status: "ready", cwd: context.cwd, model: "openai/gpt-6.1-sol",
    capabilities: AcpProviderCapabilitiesV2, createdAt: now, updatedAt: now, lastError: null });
  const thread = Schema.decodeUnknownSync(OrchestrationV2ProviderThreadJson)({ id: "omp-provider-thread", driver,
    providerInstanceId: instanceId, providerSessionId: session.id, appThreadId: "omp-chat", ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: "/native-home/.omp/agent/sessions/workspace/native.jsonl", strength: "strong" },
    nativeConversationHeadRef: null, status: "idle", firstRunOrdinal: null, lastRunOrdinal: null,
    handoffIds: [], forkedFrom: null, createdAt: now, updatedAt: now });
  const snapshot: ProviderAdapterV2ThreadSnapshot = { providerThread: thread, providerTurns: [], messages: [], runtimeRequests: [] };
  const unexpected = () => Effect.die(new Error("A protocol metadata probe must not execute native operations."));
  const runtime: ProviderAdapterV2SessionRuntime = { instanceId, driver, providerSessionId: session.id, providerSession: session,
    events: Stream.never, ensureThread: unexpected, resumeThread: unexpected, startTurn: unexpected,
    interruptTurn: unexpected, steerTurn: unexpected, respondToRuntimeRequest: unexpected,
    readThreadSnapshot: unexpected, rollbackThread: unexpected, forkThread: unexpected };
  const state = { current: true, probes: 0, reads: 0, invalidateOnRead: false };
  const continuationIdentity = { driverKind: driver, continuationKey: "omp-original-native-binding" };
  const lease: PmProviderLease = { instanceId, revision: context.revision, localDriver: "omp", cwd: context.cwd,
    nativeHome: context.homeDirectory, continuationIdentity,
    assertCurrent: Effect.suspend(() => state.current ? Effect.void : Effect.fail(pmExecutionError(409, "stale_lease", "The test lease was revoked."))),
    instance: { instanceId, driverKind: driver, continuationIdentity, displayName: undefined, enabled: true,
      get snapshot(): never { throw new Error("Protocol resolution must not read status."); },
      get textGeneration(): never { throw new Error("Protocol resolution must not generate text."); },
      get orchestrationAdapter(): never { throw new Error("Protocol resolution must not create an adapter."); } },
  };
  const input: PmProtocolOperation = { context, lease, runtime };
  const native = { protocol: "fixture:negotiated-omp-v2", cwd: context.cwd, homeDirectory: context.homeDirectory };
  let lastEnsure: ProviderAdapterV2EnsureThreadInput | undefined;
  const bind = () => bindOmpSessionEvidence(runtime, {
    probe: Effect.sync(() => { state.probes++; return native; }),
    readLegacy: value => Effect.sync(() => {
      assert.equal(value.nativeSessionId, thread.nativeThreadRef!.nativeId);
      lastEnsure = value.ensure;
      state.reads++;
      if (state.invalidateOnRead) state.current = false;
      return snapshot;
    }),
  });
  return { input, state, native, bind, snapshot, session, lastEnsure: () => lastEnsure };
}

test("OMP rejects configuration that bypasses host identity or native permission boundaries", () => {
  assert.throws(() => ompAdapter.validateConfig({ binaryPath: "bad\0path" }));
  assert.throws(() => ompAdapter.validateConfig({ homePath: "/pi-home" }));
  assert.throws(() => ompAdapter.validateConfig({ profile: "other-account" }));
  for (const launchArgs of ["--mode json", "--no-ui", "--yolo", "--session /other", "--cwd /other", "--config /other", "--tools bash"]) {
    assert.throws(() => ompAdapter.validateConfig({ launchArgs }), launchArgs);
  }
});

test("creating OMP preserves Pi and native Home, persists explicit models and increments revisions", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const pm = yield* makePmNativeTestHost({ driver: "omp", instanceId: "omp-created", config: { binaryPath: "/missing/omp" } });
    yield* Effect.addFinalizer(() => Effect.sync(closeStore));
    const stored = getStoredInstance(pm.context.instanceId)!;
    assert.equal(stored.driver, "omp");
    assert.equal(stored.homeDirectory, pm.context.env.HOME);
    assert.notEqual(stored.stateDirectory, stored.homeDirectory);
    assert.equal(listStoredInstances().some(value => value.driver === "pi"), false);
    assert.deepEqual(getProviderModels(stored.instanceId), []);
    assert.throws(() => resolveCatalogModel(stored.instanceId, ""));
    const pi = createProviderInstance({ instanceId: "pi-existing", driver: "pi", config: { binaryPath: "/existing/pi" },
      customModels: [{ id: "native-pi-model", label: "Existing Pi model" }] });
    const changed = updateProviderInstance(stored.instanceId, {
      customModels: [{ id: "openai/gpt-6.1-sol", label: "GPT 6.1 Sol" }],
    }, stored.revision);
    assert.ok(changed.revision > stored.revision);
    assert.equal(resolveCatalogModel(stored.instanceId, "openai/gpt-6.1-sol").id, "openai/gpt-6.1-sol");
    assert.throws(() => resolveCatalogModel(stored.instanceId, ""));
    assert.throws(() => updateProviderInstance(stored.instanceId, { label: "stale" }, stored.revision), { status: 409 });
    assert.equal(providerContext(changed, pm.context.cwd).homeDirectory, pm.context.homeDirectory);
    assert.deepEqual(getStoredInstance(pi.instanceId), pi);
    assert.equal(resolveCatalogModel(pi.instanceId, "native-pi-model").id, "native-pi-model");
  })));
});

test("OMP protocol evidence cannot be borrowed from a different operation, instance, driver or Home", async () => {
  const f = operation();
  await assert.rejects(Effect.runPromise(ompProtocolResolver(f.input)), { code: "session_mismatch", status: 409 });
  const unbind = f.bind();
  try {
    const probe = await Effect.runPromise(ompProtocolResolver(f.input));
    assert.equal(probe.protocol, f.native.protocol);
    assert.equal(probe.adoptBuffered, undefined);
    await assert.rejects(Effect.runPromise(ompProtocolResolver({ ...f.input, context: { ...f.input.context, driver: "pi" } })), { code: "session_mismatch" });
    await assert.rejects(Effect.runPromise(ompProtocolResolver({ ...f.input,
      runtime: { ...f.input.runtime, instanceId: ProviderInstanceId.make("other-instance") } })), { code: "session_mismatch" });
    f.native.homeDirectory = "/other-home";
    await assert.rejects(Effect.runPromise(ompProtocolResolver(f.input)), { code: "session_mismatch" });
    f.native.homeDirectory = f.input.lease.nativeHome;
    f.native.cwd = "/other-workspace";
    await assert.rejects(Effect.runPromise(ompProtocolResolver(f.input)), { code: "session_mismatch" });
    f.native.cwd = f.input.lease.cwd;
    f.state.current = false;
    const count = f.state.probes;
    await assert.rejects(Effect.runPromise(ompProtocolResolver(f.input)), { code: "stale_lease" });
    assert.equal(f.state.probes, count);
  } finally { unbind(); }
  f.state.current = true;
  await assert.rejects(Effect.runPromise(ompProtocolResolver(f.input)), { code: "session_mismatch" });
});

test("legacy OMP recovery uses its original session evidence and rejects a lease revoked during adoption", async () => {
  const f = operation();
  const unbind = f.bind();
  try {
    const probe = await Effect.runPromise(ompProtocolResolver(f.input));
    const sessionId = f.snapshot.providerThread.nativeThreadRef?.nativeId;
    assert.ok(sessionId);
    const source = { providerInstanceId: instanceId, driver: "omp" as const, instanceRevision: f.input.lease.revision,
      cwd: f.input.context.cwd, sessionId };
    const ensure: ProviderAdapterV2EnsureThreadInput = { threadId: ThreadId.make("omp-chat"), providerSessionId: f.session.id,
      modelSelection: { instanceId, model: "openai/gpt-6.1-sol" },
      runtimePolicy: { cwd: f.input.context.cwd, runtimeMode: "approval-required", interactionMode: "default" } };
    const recovered = await Effect.runPromise(probe.adoptLegacy!({ ...f.input, source, ensure }));
    assert.equal(recovered, f.snapshot);
    assert.equal(f.lastEnsure(), ensure);
    assert.equal(f.state.reads, 1);
    f.state.invalidateOnRead = true;
    await assert.rejects(Effect.runPromise(probe.adoptLegacy!({ ...f.input, source, ensure })), { code: "stale_lease" });
  } finally { unbind(); }
});

test("OMP continuation survives store reopening but never adopts Pi or changed Home/revision/cwd", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* makePmNativeTestHost({ driver: "omp", instanceId: "omp-sidecar", config: { binaryPath: "/missing/omp" } });
    yield* Effect.addFinalizer(() => Effect.sync(closeStore));
    const f = operation();
    const ref = savePmContinuation({ lease: f.input.lease, protocol: f.native.protocol, ownerThreadId: "omp-chat",
      generationId: "omp-generation", session: f.session, thread: f.snapshot.providerThread, turns: [] })!;
    closeStore();
    assert.equal(readPmContinuation(f.input.lease, ref, f.native.protocol, "omp-chat")?.thread.nativeThreadRef?.nativeId, ref.sessionId);
    for (const lease of [
      { ...f.input.lease, localDriver: "pi" as const },
      { ...f.input.lease, nativeHome: "/other-home" },
      { ...f.input.lease, cwd: "/other-workspace" },
    ]) assert.throws(() => readPmContinuation(lease, ref, f.native.protocol, "omp-chat"), { code: "session_mismatch" });
    assert.throws(() => readPmContinuation(f.input.lease, { ...ref, instanceRevision: 8 }, f.native.protocol, "omp-chat"), { code: "session_mismatch" });
  })));
});

test("OMP status uses its independent startup deadline, propagates cancellation and never retries", { timeout: 10_000 }, async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const pm = yield* makePmNativeTestHost({ driver: "omp", instanceId: "omp-status-timeout", config: { binaryPath: "/missing/omp" } });
    yield* Effect.addFinalizer(() => Effect.sync(closeStore));
    yield* Effect.promise(async () => {
      const codex = getNativeProviderAdapter("codex")!;
      const originalTimeout = AbortSignal.timeout, originalOmpCheck = ompAdapter.check, originalCodexCheck = codex.check;
      const controller = new AbortController(), deadlines: number[] = [];
      const failure = new DOMException("The OMP status deadline expired.", "TimeoutError");
      let calls = 0;
      const started = Promise.withResolvers<AbortSignal>();
      try {
        AbortSignal.timeout = milliseconds => { deadlines.push(milliseconds); return controller.signal; };
        ompAdapter.check = async (_context, signal) => {
          calls++;
          assert.ok(signal);
          started.resolve(signal);
          const result = Promise.withResolvers<ProviderDriverStatus>();
          signal.addEventListener("abort", () => result.reject(signal.reason), { once: true });
          return result.promise;
        };
        const pending = Promise.allSettled([
          readNativeProviderStatus(pm.context.instanceId), readNativeProviderStatus(pm.context.instanceId),
        ]);
        assert.equal(await started.promise, controller.signal);
        assert.equal(OMP_STATUS_TIMEOUT_MS, 120_000);
        assert.deepEqual(deadlines, [OMP_STATUS_TIMEOUT_MS]);
        controller.abort(failure);
        const results = await pending;
        assert.equal(calls, 1);
        assert.ok(results.every(result => result.status === "rejected" && result.reason === failure));
        codex.check = async () => ({ installation: { status: "unknown" }, authentication: "unknown",
          nativeSessionReady: false, models: [], methods: [], canLogout: false });
        await readNativeProviderStatus("codex");
        assert.deepEqual(deadlines, [OMP_STATUS_TIMEOUT_MS, 30_000]);
      } finally {
        controller.abort(failure);
        AbortSignal.timeout = originalTimeout;
        ompAdapter.check = originalOmpCheck;
        codex.check = originalCodexCheck;
      }
    });
  })));
});
