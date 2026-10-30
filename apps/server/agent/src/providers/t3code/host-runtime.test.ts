import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Layer from "effect/Layer";
import type * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { OpenCodeDriver } from "@t3tools/provider-opencode/server";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderRuntimeHost } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { createProviderInstance, getStoredInstance, providerContext, providerUsageContext, updateProviderInstance } from "../instances.ts";
import { makePmProviderHostLayer, makePmProviderHostServices, makePmServerSettings } from "./host.ts";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ChildProcess } from "effect/process";
import { bindPmProviderCommand, makePmProviderHostService, makePmProviderPlatformLayer } from "./host-runtime.ts";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { ProviderInstanceId } from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { PmProviderHostService, PmProviderLease } from "./contract.ts";
import { makePmProviderRuntimeHost } from "./runtime-host.ts";
import { makePmProviderManagement } from "./management.ts";
import { makePmProviderFamily } from "./registration.ts";
import { beginProviderMaintenance } from "../auth.ts";

function context(instanceId: string): ProviderDriverContext {
  return { instanceId, driver: "opencode", config: {}, revision: 1, cwd: `/work/${instanceId}`,
    homeDirectory: `/native/${instanceId}/.config`, stateDirectory: `/private/${instanceId}`,
    env: { HOME: `/users/${instanceId}`, XDG_CONFIG_HOME: `/users/${instanceId}/xdg`, PATH: "/bin", ACCOUNT: instanceId } };
}
test("concurrent bound platforms isolate native environment, user home and effective cwd", async () => {
  const read = Effect.gen(function* () {
    const env = yield* HostProcess.Environment;
    const home = yield* HostProcess.HomeDirectory;
    const cwd = yield* HostProcess.WorkingDirectory;
    return { env, home, cwd };
  });
  const [a, b] = await Promise.all(["one", "two"].map(id => Effect.runPromise(read.pipe(Effect.provide(makePmProviderPlatformLayer(context(id)))))));
  assert.equal(a!.env.ACCOUNT, "one"); assert.equal(b!.env.ACCOUNT, "two");
  assert.equal(a!.home, "/users/one"); assert.equal(b!.cwd, "/work/two");
  assert.equal(a!.env.XDG_CONFIG_HOME, "/users/one/xdg");
});
test("spawn binding never reimports process.env and preserves explicit native command options", () => {
  const bound = bindPmProviderCommand(ChildProcess.make("native", ["status"], { env: { EXTRA: "yes" }, extendEnv: true }), context("one"));
  assert.equal(bound._tag, "StandardCommand");
  if (bound._tag !== "StandardCommand") return;
  assert.equal(bound.options.cwd, "/work/one");
  assert.equal(bound.options.extendEnv, false);
  assert.deepEqual(bound.options.env, { ...context("one").env, EXTRA: "yes" });
  const explicit = bindPmProviderCommand(ChildProcess.make("native", [], { env: { ONLY: "explicit" }, extendEnv: false, cwd: "/native-helper" }), context("two"));
  if (explicit._tag !== "StandardCommand") throw new Error("Expected standard command.");
  assert.deepEqual(explicit.options.env, { ONLY: "explicit" });
  assert.equal(explicit.options.cwd, "/native-helper");
});

interface OriginalHostFixture {
  readonly host: PmProviderHostService;
  readonly current: ProviderDriverContext;
  readonly root: string;
  readonly sourceConfigs: string[];
  readonly probedConfigs: string[];
  readonly counts: { opened: number; closed: number; layersOpened: number; layersClosed: number };
}
async function withOriginalHost(
  use: (fixture: OriginalHostFixture) => Effect.Effect<void, unknown, Scope.Scope>,
  onCreate?: (input: Parameters<typeof OpenCodeDriver.create>[0]) => Effect.Effect<void, ProviderDriverError>,
  options: {
    readonly enabled?: boolean;
    readonly transformInstance?: (instance: ProviderInstance) => Effect.Effect<ProviderInstance, ProviderDriverError, Scope.Scope | Crypto.Crypto>;
    readonly closeLayer?: Effect.Effect<void>;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-provider-lease-"));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  try {
    const home = path.join(root, "test-only-native-home");
    await mkdir(home);
    const stored = createProviderInstance({ instanceId: "original-open-code", driver: "opencode", enabled: options.enabled ?? true,
      config: { binaryPath: path.join(root, "intentionally-uninstalled-offline-cli") },
      environment: [{ name: "HOME", value: home, sensitive: false },
        ...["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map(name => ({
          name, value: path.join(home, name.toLowerCase()), sensitive: false,
        }))] });
    const current = providerUsageContext(stored, root);
    const counts = { opened: 0, closed: 0, layersOpened: 0, layersClosed: 0 };
    const sourceConfigs: string[] = [];
    const probedConfigs: string[] = [];
    const driver: typeof OpenCodeDriver = { ...OpenCodeDriver, create: input => Effect.gen(function* () {
      counts.opened++;
      sourceConfigs.push(input.config.binaryPath);
      yield* Effect.addFinalizer(() => Effect.sync(() => { counts.closed++; }));
      if (onCreate) yield* onCreate(input);
      const original = yield* OpenCodeDriver.create(input);
      const instance = options.transformInstance ? yield* options.transformInstance(original) : original;
      return { ...instance, snapshot: { ...instance.snapshot,
        refresh: instance.snapshot.refresh.pipe(Effect.tap(() => Effect.sync(() => {
          probedConfigs.push(input.config.binaryPath);
        }))),
      } };
    }) };
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const runtimeHost = makePmProviderRuntimeHost();
      const host = yield* makePmProviderHostService({
        families: new Map([[driver.driverKind, makePmProviderFamily(driver, bound => {
          const platform = makePmProviderPlatformLayer(bound);
          const services = makePmProviderHostServices(bound, runtimeHost);
          return Layer.mergeAll(IdAllocator.layer, Layer.succeed(ProviderRuntimeHost, runtimeHost), ProviderLatestVersions.layer,
            Layer.effectDiscard(Effect.gen(function* () {
              counts.layersOpened++;
              yield* Effect.addFinalizer(() => Effect.sync(() => { counts.layersClosed++; }).pipe(
                Effect.andThen(options.closeLayer ?? Effect.void),
              ));
            })),
            Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, ProviderEventLoggers.NoOpProviderEventLoggers),
            makePmProviderHostLayer(bound, { ...services, shouldRunBackgroundWork: () => Effect.succeed(false) }),
            OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
          ).pipe(Layer.provideMerge(platform));
        })]]),
        runtimeHost,
      });
      yield* use({ host, current, root, sourceConfigs, probedConfigs, counts });
    })));
  } finally {
    if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("disabled usage access retains its scope without execution and expires on revision change", async () =>
  withOriginalHost(({ host, current, counts }) => Effect.gen(function* () {
    const terminalListeners = process.stdin.listenerCount("end");
    yield* Effect.scoped(Effect.gen(function* () {
      const usage = yield* host.acquire(current, "usage");
      assert.equal(counts.opened, 0);
      assert.equal(counts.layersOpened, 1);
      assert.equal(process.stdin.listenerCount("end"), terminalListeners);
      const execution = yield* host.acquire(current, "execution").pipe(Effect.exit);
      assert.equal(Exit.isFailure(execution), true);
      assert.throws(() => beginProviderMaintenance(current.instanceId), { status: 409 });
      updateProviderInstance(current.instanceId, { label: "Changed while reading history" }, current.revision);
      const stale = yield* usage.assertCurrent.pipe(Effect.exit);
      assert.equal(Exit.isFailure(stale), true);
    }));
    assert.equal(counts.opened, 0);
    assert.equal(counts.layersClosed, 1);
  }), undefined, { enabled: false }),
);

test("the original instance and driver layer survive normal operation release until host shutdown", async () =>
  withOriginalHost(({ host, current, counts }) => Effect.gen(function* () {
    const first = yield* Effect.scoped(Effect.gen(function* () {
      const lease = yield* host.acquire(current, "status");
      assert.equal(lease.instance.instanceId, current.instanceId);
      assert.equal(counts.opened, 1);
      assert.equal(counts.closed, 0);
      yield* lease.assertCurrent;
      const previousSdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION;
      try {
        // Match the native instance binding: SDK runtime metadata is not an account change.
        process.env.CLAUDE_AGENT_SDK_VERSION = "test-only-runtime-metadata";
        yield* lease.assertCurrent;
      } finally {
        if (previousSdkVersion === undefined) delete process.env.CLAUDE_AGENT_SDK_VERSION;
        else process.env.CLAUDE_AGENT_SDK_VERSION = previousSdkVersion;
      }
      assert.equal(counts.layersOpened, 1);
      assert.equal(counts.layersClosed, 0);
      return lease;
    }));
    assert.equal(counts.closed, 0);
    assert.equal(Exit.isFailure(yield* first.assertCurrent.pipe(Effect.exit)), true);
    yield* Effect.scoped(Effect.gen(function* () {
      const second = yield* host.acquire(current, "status");
      assert.equal(second.instance, first.instance);
      assert.equal(counts.opened, 1);
      yield* second.assertCurrent;
    }));
    assert.equal(counts.layersClosed, 0);
    yield* host.shutdown;
    const afterShutdown = yield* host.acquire(current, "status").pipe(Effect.result);
    assert.equal(afterShutdown._tag, "Failure");
    assert.equal(counts.closed, 1);
    assert.equal(counts.layersClosed, 1);
  })),
);

test("a binaryPath CAS makes management probe the new original registry configuration", async () =>
  withOriginalHost(({ host, current, root, sourceConfigs, probedConfigs }) => Effect.gen(function* () {
    const management = makePmProviderManagement(host);
    const first = yield* Effect.promise(() => management.check(current));
    assert.equal(first.installation.status, "not-installed");
    const next = updateProviderInstance(current.instanceId, {
      config: { binaryPath: path.join(root, "second-intentionally-uninstalled-offline-cli") },
    }, current.revision);
    const fresh = providerContext(next, root);
    const stale = yield* host.acquire(current, "status").pipe(Effect.scoped, Effect.exit);
    assert.equal(Exit.isFailure(stale), true);
    const second = yield* Effect.promise(() => management.check(fresh));
    assert.equal(second.installation.status, "not-installed");
    assert.deepEqual(sourceConfigs, [current.config.binaryPath, fresh.config.binaryPath]);
    assert.deepEqual(probedConfigs, [current.config.binaryPath, fresh.config.binaryPath]);
    assert.equal(getStoredInstance(current.instanceId)!.revision, next.revision);
  })),
);

test("an unavailable original registry entry is not an executable PM lease or a deleted account", async () =>
  withOriginalHost(({ host, current, counts, sourceConfigs }) => Effect.gen(function* () {
    const result = yield* host.acquire(current, "status").pipe(Effect.scoped, Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.code, "invalid_config");
    assert.deepEqual(sourceConfigs, [current.config.binaryPath]);
    assert.equal(counts.closed, 1);
    assert.equal(counts.layersClosed, 1);
    const stored = getStoredInstance(current.instanceId)!;
    assert.equal(stored.revision, current.revision);
    assert.equal(stored.observations, undefined);
    const snapshot = yield* makePmServerSettings().getSettings;
    assert.ok(snapshot.providerInstances[ProviderInstanceId.make(current.instanceId)]);
    assert.equal(snapshot.providerInstances[ProviderInstanceId.make("cursor")], undefined);
  }), input => Effect.fail(new ProviderDriverError({
    instanceId: input.instanceId, driver: OpenCodeDriver.driverKind, detail: "Controlled unavailable source dependency.",
  }))),
);

test("a configuration saved while the original driver starts rejects its old lease and admits the current revision", async () => {
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  let first = true;
  try {
    await withOriginalHost(({ host, current, root, sourceConfigs }) => Effect.gen(function* () {
      const pending = yield* host.acquire(current, "status").pipe(Effect.scoped, Effect.exit, Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      const saved = updateProviderInstance(current.instanceId, {
        config: { binaryPath: path.join(root, "saved-during-driver-start") },
      }, current.revision);
      complete.resolve();
      assert.equal(Exit.isFailure(yield* Fiber.join(pending)), true);
      const lease = yield* host.acquire(providerContext(saved, root), "status");
      yield* lease.assertCurrent;
      assert.equal(lease.revision, saved.revision);
      assert.deepEqual(sourceConfigs, [current.config.binaryPath, saved.config.binaryPath]);
      assert.equal(getStoredInstance(current.instanceId)!.observations, undefined);
    }), () => {
      if (!first) return Effect.void;
      first = false;
      entered.resolve();
      return Effect.promise(() => complete.promise);
    });
  } finally { complete.resolve(); }
});

test("an older queued settings event cannot replace a newer PM lease or authorize its old revision", async () =>
  withOriginalHost(({ host, current, root, sourceConfigs }) => Effect.gen(function* () {
    const settings = makePmServerSettings();
    const changes = yield* settings.subscribeChanges;
    const older = updateProviderInstance(current.instanceId, { label: "older queued state" }, current.revision);
    const newer = updateProviderInstance(current.instanceId, { label: "newer authoritative seed" }, older.revision);
    const lease = yield* host.acquire(providerContext(newer, root), "status");
    const queued = yield* Stream.runHead(changes);
    assert.equal(queued._tag, "Some");
    if (queued._tag === "Some")
      assert.equal(queued.value.providerInstances[ProviderInstanceId.make(current.instanceId)]?.displayName, older.label);
    assert.equal((yield* settings.getSettings).providerInstances[ProviderInstanceId.make(current.instanceId)]?.displayName, newer.label);
    const replay = yield* host.acquire(providerContext(older, root), "status").pipe(Effect.scoped, Effect.exit);
    assert.equal(Exit.isFailure(replay), true);
    yield* lease.assertCurrent;
    assert.equal(lease.instance.displayName, newer.label);
    assert.equal(sourceConfigs.length, 1);
  })),
);

test("consumer check, original auth and subsequent check share the original controller and authenticated catalog", async () =>
  withOriginalHost(({ host, current, root, counts }) => Effect.gen(function* () {
    const management = makePmProviderManagement(host);
    const before = yield* Effect.promise(() => management.check(current));
    assert.equal(before.authentication, "unknown");
    assert.deepEqual(before.methods?.map(method => method.id), ["controlled-login"]);
    assert.deepEqual(before.models, []);
    const siblingContext = providerContext(getStoredInstance(current.instanceId)!, path.join(root, "other-auth-context"));
    const sibling = yield* host.acquire(siblingContext, "status").pipe(Effect.scoped);
    assert.equal(counts.opened, 2);
    assert.equal(counts.closed, 0);
    yield* Effect.promise(() => management.authenticate(current, {
      methodId: "controlled-login", signal: new AbortController().signal,
      readInput: async () => { throw new Error("The controlled source auth flow requires no user input."); },
      onUpdate: () => undefined, saveEnvironment: async () => { throw new Error("No test credentials may be persisted."); },
    }));
    const after = yield* Effect.promise(() => management.check(current));
    assert.equal(after.authentication, "authenticated");
    assert.deepEqual(after.methods?.map(method => method.id), ["controlled-reauth"]);
    assert.deepEqual(after.models.map(model => model.id), ["controlled-authenticated-model"]);
    yield* Effect.scoped(Effect.gen(function* () {
      const lease = yield* host.acquire(current, "status");
      const state = yield* Stream.runHead(lease.instance.auth!.subscribe("consumer"));
      assert.equal(Option.isSome(state) && state.value.phase, "succeeded");
    }));
    assert.equal(counts.opened, 2);
    assert.equal(counts.closed, 1);
    assert.equal(counts.layersOpened, 2);
    assert.equal(counts.layersClosed, 1);
    const reopenedSibling = yield* host.acquire(siblingContext, "status").pipe(Effect.scoped);
    assert.notEqual(reopenedSibling.instance, sibling.instance);
    assert.equal(counts.opened, 3);
  }), undefined, { transformInstance: instance => Effect.gen(function* () {
    // Real original flow state/scope, with a deterministic credential-free provider boundary.
    let authenticated = false;
    const auth = yield* ProviderAuthFlow.make({
      instanceId: instance.instanceId, credentialBinding: { owner: "provider", key: "controlled-original-account" },
      methods: Effect.sync(() => [{ id: authenticated ? "controlled-reauth" : "controlled-login",
        name: "Controlled native sign-in", description: null, type: "agent" as const }]),
      refreshMethodsAfterAuth: true,
      authenticate: () => Effect.sync(() => { authenticated = true; }),
      logout: Effect.sync(() => { authenticated = false; }),
    });
    return { ...instance, auth, snapshot: { ...instance.snapshot,
      refresh: instance.snapshot.refresh.pipe(Effect.map(snapshot => ({ ...snapshot,
        auth: { status: authenticated ? "authenticated" as const : "unknown" as const },
        models: authenticated ? [{ slug: "controlled-authenticated-model", name: "Controlled authenticated model",
          isCustom: false, capabilities: null }] : [],
      }))),
    } };
  }) }),
);

test("concurrent same-context acquisitions initialize one original registry and retained driver layer", async () => {
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  try {
    await withOriginalHost(({ host, current, counts }) => Effect.gen(function* () {
      const pending = yield* Effect.forEach([0, 1, 2], () => Effect.scoped(Effect.gen(function* () {
        const lease = yield* host.acquire(current, "status");
        yield* lease.assertCurrent;
        return lease.instance;
      })), { concurrency: "unbounded" }).pipe(Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      assert.equal(counts.opened, 1);
      complete.resolve();
      const instances = yield* Fiber.join(pending);
      assert.equal(instances[0], instances[1]);
      assert.equal(instances[1], instances[2]);
      assert.equal(counts.opened, 1);
      assert.equal(counts.layersOpened, 1);
      assert.equal(counts.closed, 0);
      yield* host.invalidate(current.instanceId);
      assert.equal(counts.closed, 1);
      assert.equal(counts.layersClosed, 1);
    }), () => {
      entered.resolve();
      return Effect.promise(() => complete.promise);
    });
  } finally { complete.resolve(); }
});

test("cancelling the initializing operation does not cancel the shared original registry or surviving lease", async () => {
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  try {
    await withOriginalHost(({ host, current, counts }) => Effect.gen(function* () {
      const first = yield* host.acquire(current, "status").pipe(Effect.scoped, Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      const survivor = yield* host.acquire(current, "status").pipe(Effect.scoped, Effect.forkScoped);
      yield* Fiber.interrupt(first);
      assert.equal(counts.closed, 0);
      complete.resolve();
      const lease = yield* Fiber.join(survivor);
      yield* Effect.scoped(Effect.gen(function* () {
        const next = yield* host.acquire(current, "status");
        assert.equal(next.instance, lease.instance);
        yield* next.assertCurrent;
      }));
      assert.equal(counts.opened, 1);
      assert.equal(counts.closed, 0);
      yield* host.shutdown;
      assert.equal(counts.closed, 1);
      assert.equal(counts.layersClosed, 1);
    }), () => {
      entered.resolve();
      return Effect.promise(() => complete.promise);
    });
  } finally { complete.resolve(); }
});

test("explicit invalidation rejects active leases immediately and drains the original instance only after release", async () =>
  withOriginalHost(({ host, current, counts }) => Effect.gen(function* () {
    const original = yield* Effect.scoped(Effect.gen(function* () {
      const lease = yield* host.acquire(current, "execution");
      yield* host.invalidate(current.instanceId);
      assert.equal(Exit.isFailure(yield* lease.assertCurrent.pipe(Effect.exit)), true);
      assert.equal(counts.closed, 0);
      assert.equal(counts.layersClosed, 0);
      const mutation = yield* host.acquire(current, "auth").pipe(Effect.scoped, Effect.result);
      assert.equal(mutation._tag, "Failure");
      if (mutation._tag === "Failure") assert.equal(mutation.failure.code, "provider_busy");
      return lease.instance;
    }));
    assert.equal(counts.closed, 1);
    assert.equal(counts.layersClosed, 1);
    yield* Effect.scoped(Effect.gen(function* () {
      const replacement = yield* host.acquire(current, "status");
      assert.notEqual(replacement.instance, original);
      yield* replacement.assertCurrent;
    }));
    assert.equal(counts.opened, 2);
    assert.equal(counts.closed, 1);
  })),
);

test("parallel execution leases in distinct cwd values and a default-cwd status probe keep independent original contexts current", async () =>
  withOriginalHost(({ host, current, root, counts }) => Effect.gen(function* () {
    const stored = getStoredInstance(current.instanceId)!;
    const contexts = ["first-project", "second-project"].map(cwd => providerContext(stored, path.join(root, cwd)));
    const originals = yield* Effect.scoped(Effect.gen(function* () {
      const turns = yield* Effect.forEach(contexts, bound => host.acquire(bound, "execution"), { concurrency: "unbounded" });
      for (const lease of turns) yield* lease.assertCurrent;
      const status = yield* host.acquire(current, "status");
      const repeated = yield* host.acquire(contexts[0]!, "status");
      assert.equal(repeated.instance, turns[0]!.instance);
      assert.notEqual(turns[0]!.instance, turns[1]!.instance);
      assert.notEqual(status.instance, turns[0]!.instance);
      assert.notEqual(status.instance, turns[1]!.instance);
      for (const lease of [...turns, status, repeated]) yield* lease.assertCurrent;
      assert.equal(counts.opened, 3);
      assert.equal(counts.layersOpened, 3);
      assert.equal(counts.closed, 0);
      const mutation = yield* host.acquire(current, "auth").pipe(Effect.scoped, Effect.result);
      assert.equal(mutation._tag, "Failure");
      if (mutation._tag === "Failure") assert.equal(mutation.failure.code, "provider_busy");
      return [...turns, status];
    }));
    assert.equal(counts.closed, 0);
    for (let index = 0; index < contexts.length; index++) {
      const repeated = yield* host.acquire(contexts[index]!, "execution").pipe(Effect.scoped);
      assert.equal(repeated.instance, originals[index]!.instance);
    }
    assert.equal(counts.opened, 3);
    yield* host.invalidate(current.instanceId);
    assert.equal(counts.closed, 3);
    assert.equal(counts.layersClosed, 3);
    const replacement = yield* host.acquire(current, "status").pipe(Effect.scoped);
    assert.notEqual(replacement.instance, originals[2]!.instance);
    assert.equal(counts.opened, 4);
    yield* host.shutdown;
    assert.equal(counts.closed, 4);
    assert.equal(counts.layersClosed, 4);
  })),
);

test("an authoritative revision invalidates every retained cwd lease and drains all old scopes before replacement", async () =>
  withOriginalHost(({ host, current, root, counts }) => Effect.gen(function* () {
    const stored = getStoredInstance(current.instanceId)!;
    const contexts = ["first-project", "second-project"].map(cwd => providerContext(stored, path.join(root, cwd)));
    const acquired = yield* Deferred.make<ReadonlyArray<PmProviderLease>>();
    const release = yield* Deferred.make<void>();
    const owners = yield* Effect.scoped(Effect.gen(function* () {
      const turns = yield* Effect.forEach(contexts, bound => host.acquire(bound, "execution"), { concurrency: "unbounded" });
      const status = yield* host.acquire(current, "status");
      yield* Deferred.succeed(acquired, [...turns, status]);
      yield* Deferred.await(release);
    })).pipe(Effect.forkScoped);
    const old = yield* Deferred.await(acquired);
    const saved = updateProviderInstance(current.instanceId, { label: "new authoritative revision" }, current.revision);
    for (const lease of old) assert.equal(Exit.isFailure(yield* lease.assertCurrent.pipe(Effect.exit)), true);
    assert.equal(counts.opened, 3);
    assert.equal(counts.closed, 0);
    const freshContext = providerContext(saved, contexts[0]!.cwd);
    const replacement = yield* host.acquire(freshContext, "execution").pipe(Effect.scoped, Effect.forkScoped);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(owners);
    const fresh = yield* Fiber.join(replacement);
    for (const lease of old) assert.notEqual(fresh.instance, lease.instance);
    assert.equal(counts.opened, 4);
    assert.equal(counts.closed, 3);
    assert.equal(counts.layersClosed, 3);
    const repeated = yield* host.acquire(freshContext, "status").pipe(Effect.scoped);
    assert.equal(repeated.instance, fresh.instance);
    assert.equal(counts.opened, 4);
    yield* host.shutdown;
    assert.equal(counts.closed, 4);
    assert.equal(counts.layersClosed, 4);
  })),
);

test("healthy cwd contexts coexist until an inherited native environment change retires both original layers", async () =>
  withOriginalHost(({ host, current, root, counts }) => Effect.gen(function* () {
    const original = yield* host.acquire(current, "status").pipe(Effect.scoped);
    const nextCwd = providerContext(getStoredInstance(current.instanceId)!, path.join(root, "other-effective-cwd"));
    const changed = yield* host.acquire(nextCwd, "status").pipe(Effect.scoped);
    assert.notEqual(changed.instance, original.instance);
    assert.equal(counts.closed, 0);
    assert.equal(counts.layersClosed, 0);
    const previous = process.env.PM_HOST_LIFETIME_TEST_NATIVE_BINDING;
    try {
      process.env.PM_HOST_LIFETIME_TEST_NATIVE_BINDING = "changed-native-environment";
      const fresh = providerContext(getStoredInstance(current.instanceId)!, nextCwd.cwd);
      const replacement = yield* host.acquire(fresh, "status").pipe(Effect.scoped);
      assert.notEqual(replacement.instance, changed.instance);
      assert.equal(counts.opened, 3);
      assert.equal(counts.closed, 2);
      assert.equal(counts.layersClosed, 2);
    } finally {
      if (previous === undefined) delete process.env.PM_HOST_LIFETIME_TEST_NATIVE_BINDING;
      else process.env.PM_HOST_LIFETIME_TEST_NATIVE_BINDING = previous;
    }
  })),
);

test("changing provider data roots retires the old registry even when instance id and revision coincide", async () =>
  withOriginalHost(({ host, current, root, counts }) => Effect.gen(function* () {
    const original = yield* host.acquire(current, "status").pipe(Effect.scoped);
    const otherRoot = path.join(root, "other-provider-root");
    process.env.AGENT_WORKSPACE_DATA_DIR = otherRoot;
    try {
      const stored = createProviderInstance({ instanceId: current.instanceId, driver: current.driver,
        config: current.config, environment: Object.entries(current.instanceEnvironment ?? {}).map(([name, value]) => ({
          name, value, sensitive: false,
        })) });
      assert.equal(stored.revision, current.revision);
      const fresh = providerContext(stored, current.cwd);
      const replacement = yield* host.acquire(fresh, "status").pipe(Effect.scoped);
      assert.notEqual(replacement.instance, original.instance);
      assert.equal(counts.opened, 2);
      assert.equal(counts.closed, 1);
      assert.equal(counts.layersClosed, 1);
    } finally { process.env.AGENT_WORKSPACE_DATA_DIR = root; }
  })),
);

test("shutdown interrupts pending initialization, drains its retained source scope and prevents later admissions", async () => {
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  try {
    await withOriginalHost(({ host, current, counts }) => Effect.gen(function* () {
      const pending = yield* host.acquire(current, "status").pipe(Effect.scoped, Effect.exit, Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      yield* host.shutdown;
      assert.equal(Exit.isFailure(yield* Fiber.join(pending)), true);
      assert.equal(counts.opened, 1);
      assert.equal(counts.closed, 1);
      assert.equal(counts.layersClosed, 1);
      const closed = yield* host.acquire(current, "status").pipe(Effect.scoped, Effect.result);
      assert.equal(closed._tag, "Failure");
      if (closed._tag === "Failure") assert.equal(closed.failure.code, "provider_host_closed");
      assert.equal(counts.opened, 1);
    }), () => {
      entered.resolve();
      return Effect.promise(() => complete.promise);
    });
  } finally { complete.resolve(); }
});

test("disabled instances cannot acquire execution or management through a caller-supplied enabled context", async () =>
  withOriginalHost(({ host, current, root, counts }) => Effect.gen(function* () {
    const disabled = updateProviderInstance(current.instanceId, { enabled: false }, current.revision);
    const forged = providerContext({ ...disabled, enabled: true }, root);
    for (const purpose of ["status", "execution", "auth", "maintenance"] as const) {
      const result = yield* host.acquire(forged, purpose).pipe(Effect.scoped, Effect.result);
      assert.equal(result._tag, "Failure");
    }
    assert.equal(counts.opened, 0);
    assert.equal(counts.layersOpened, 0);
  })),
);

test("retained source layer cleanup failures remain visible to invalidation, future acquisition and shutdown", async () => {
  await assert.rejects(withOriginalHost(({ host, current, root, counts }) => Effect.gen(function* () {
    yield* host.acquire(current, "status").pipe(Effect.scoped);
    const sibling = providerContext(getStoredInstance(current.instanceId)!, path.join(root, "other-cleanup-context"));
    yield* host.acquire(sibling, "status").pipe(Effect.scoped);
    const invalidated = yield* host.invalidate(current.instanceId).pipe(Effect.result);
    assert.equal(invalidated._tag, "Failure");
    if (invalidated._tag === "Failure") assert.equal(invalidated.failure.code, "provider_cleanup_failed");
    assert.equal(counts.closed, 2);
    assert.equal(counts.layersClosed, 2);
    const next = yield* host.acquire(current, "status").pipe(Effect.scoped, Effect.result);
    assert.equal(next._tag, "Failure");
    if (next._tag === "Failure") assert.equal(next.failure.code, "provider_cleanup_failed");
    const stopped = yield* host.shutdown.pipe(Effect.result);
    assert.equal(stopped._tag, "Failure");
    if (stopped._tag === "Failure") assert.equal(stopped.failure.code, "provider_cleanup_failed");
  }), undefined, { closeLayer: Effect.die(new Error("Controlled private cleanup diagnostics.")) }),
  error => error instanceof Error && error.message.includes("Provider scope cleanup failed.")
    && !error.message.includes("Controlled private cleanup diagnostics."));
});

test("retained source credential bindings still exclude peer mutations until admitted readers release", async () =>
  withOriginalHost(({ host, current, root, counts }) => Effect.gen(function* () {
    const peer = createProviderInstance({ instanceId: "controlled-credential-peer", driver: "opencode",
      config: current.config, environment: [{ name: "HOME", value: path.join(root, "separate-peer-native-home"), sensitive: false }] });
    const peerContext = providerContext(peer, root);
    yield* Effect.scoped(Effect.gen(function* () {
      const reader = yield* host.acquire(current, "status");
      const mutation = yield* host.acquire(peerContext, "auth").pipe(Effect.scoped, Effect.result);
      assert.equal(mutation._tag, "Failure");
      if (mutation._tag === "Failure") assert.equal(mutation.failure.code, "provider_busy");
      yield* reader.assertCurrent;
      assert.equal(counts.opened, 2);
      assert.equal(counts.closed, 0);
    }));
    yield* Effect.scoped(Effect.gen(function* () {
      const admitted = yield* host.acquire(peerContext, "auth");
      yield* admitted.assertCurrent;
      assert.equal(counts.opened, 2);
    }));
  }), undefined, { transformInstance: instance => Effect.gen(function* () {
    const auth = yield* ProviderAuthFlow.make({
      instanceId: instance.instanceId, credentialBinding: { owner: "provider", key: "controlled-shared-credential" },
      methods: Effect.succeed([]),
      authenticate: () => Effect.die("Peer exclusion must run before source authentication."),
      logout: Effect.die("No logout is requested by this credential binding regression."),
    });
    return { ...instance, auth };
  }) }),
);
