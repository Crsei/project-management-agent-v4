import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type ChatAttachment,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import {
  ProviderRuntimeHost,
  type ProviderRuntimeHostBinding,
  type ProviderRuntimeHostService,
} from "@t3tools/provider-core/server/ProviderRuntimeHost";
import type { ProviderAuthSessionInvalidation } from "../../../../../../../vendor/t3code/apps/server/src/provider/ProviderAuthService.ts";
import type { DocumentText } from "../../../../../../../vendor/t3code/apps/server/src/provider/DocumentText.ts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { ProviderConfig, ProviderDriver, ProviderInstanceUpdate } from "@agent-workspace/contracts/provider";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import { isProviderAccountBusy } from "../../auth.ts";
import {
  createProviderInstance,
  getProviderSettings,
  getStoredInstance,
  providerContext,
  providerDataDirectory,
  updateProviderInstance,
  updateProviderSettings,
} from "../../instances.ts";
import type { PmProviderBoundaryError, PmProviderHostService } from "../contract.ts";
import { makePmProviderPlatformLayer, type PmProviderPlatformServices } from "../host-runtime.ts";
import {
  makePmProviderHostLayer,
  makePmProviderHostServices,
  makePmProviderUpstreamServicesLayer,
  makePmServerConfig,
} from "../host.ts";
import { makePmProviderAuthSessionInvalidationLayer } from "../management.ts";
import { makePmProviderRuntimeHost } from "../runtime-host.ts";
import { registerProviderAttachment } from "../upstream-services/attachments.ts";
import type { ServerConfig } from "../upstream-services/server-config.ts";
import type { ServerSettingsService } from "../upstream-services/server-settings.ts";
import type { ServerSecretStore } from "../upstream-services/server-secret-store.ts";
import type { ServerEnvironmentIdentity } from "../upstream-services/server-environment.ts";
import type { CodexUsageHistory } from "../upstream-services/usage-history.ts";

export type PmNativeTestHostServices =
  | ProviderHost | ProviderRuntimeHost | ProviderEventLoggers | IdAllocator.IdAllocatorV2
  | ServerConfig | ServerSettingsService | ServerSecretStore | ServerEnvironmentIdentity
  | PmProviderPlatformServices | DocumentText | CodexUsageHistory;

export type TestAuthorizationAction = "compaction" | "tool";

export interface PmNativeTestHostOptions {
  readonly driver: ProviderDriver;
  readonly instanceId?: string;
  readonly config?: ProviderConfig;
  /** Omit for a real temporary working directory; explicit paths retain protocol fixture semantics. */
  readonly cwd?: string;
  readonly prefix?: string;
  /** Explicit test values only. Ambient provider credentials are never forwarded. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly healthRefreshIntervalSeconds?: number;
}

export interface PmNativeTestGenerationInput {
  readonly threadId: ThreadId;
  readonly executionId: string;
  /** No action is authorized unless it is listed here. Native permission grants remain separate. */
  readonly actions: ReadonlyArray<TestAuthorizationAction>;
  readonly mcpServers?: ProviderRuntimeHostBinding["mcpServers"];
  readonly instructionText?: string;
  /** Optional asynchronous policy, rechecked for revocation on both sides of the await. */
  readonly authorize?: (action: TestAuthorizationAction) => Effect.Effect<void, Error>;
}

export interface PmNativeTestGeneration {
  readonly binding: ProviderRuntimeHostBinding;
  readonly isCurrent: Effect.Effect<boolean>;
  readonly authorize: (action: TestAuthorizationAction) => Effect.Effect<void, Error>;
  readonly revoke: Effect.Effect<void>;
}

// PM settings and authoritative provider environments read process.env. Hold both the isolated
// data root and narrowed ambient environment for the entire fixture Scope under the same gate.
const dataRootGate = Semaphore.makeUnsafe(1);
const scopedRoots = new WeakMap<Scope.Scope, Deferred.Deferred<string, Error>>();
const failure = (cause: unknown): Error => cause instanceof Error ? cause : new Error(String(cause));
const inheritedEnvironmentNames: Readonly<Record<string, true>> = {
  PATH: true, PATHEXT: true, SystemRoot: true, SYSTEMROOT: true, COMSPEC: true, WINDIR: true,
  LANG: true, LANGUAGE: true, LC_ALL: true, TZ: true, TMPDIR: true, TMP: true, TEMP: true,
  NODE_ENV: true, NODE_TEST_CONTEXT: true, VITEST: true, VITEST_MODE: true,
  VITEST_WORKER_ID: true, VITEST_POOL_ID: true, JEST_WORKER_ID: true,
};
function replaceProcessEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(process.env)) {
    if (!Object.hasOwn(environment, name)) delete process.env[name];
  }
  Object.assign(process.env, environment);
}
const stale = () => Object.assign(new Error("The test execution authorization has been revoked or replaced."), {
  status: 409, code: "stale_execution",
});

/** Runtime-only suites need no application state and receive no implicit authorization. */
export const runtimeHostLayer = Layer.sync(ProviderRuntimeHost, makePmProviderRuntimeHost);

export class PmNativeTestHost extends Context.Service<
  PmNativeTestHost,
  PmNativeTestHostFixture
>()("pm/testing/PmNativeTestHost") {}

export interface PmNativeTestHostFixture {
  readonly root: string;
  readonly context: ProviderDriverContext;
  readonly serverConfig: ServerConfig["Service"];
  readonly runtimeHost: ProviderRuntimeHostService;
  readonly services: ProviderHost["Service"];
  readonly layer: Layer.Layer<PmNativeTestHostServices, PmProviderBoundaryError>;
  readonly bindGeneration: (input: PmNativeTestGenerationInput) => Effect.Effect<PmNativeTestGeneration, Error, Scope.Scope>;
  readonly registerAttachment: (attachment: ChatAttachment, bytes: Uint8Array | string, relativePath?: string) => Effect.Effect<string, Error>;
  /** Uses the actual PM CAS writer; the existing fixture context deliberately becomes stale. */
  readonly updateInstance: (patch: ProviderInstanceUpdate) => Effect.Effect<ProviderDriverContext, Error>;
  readonly setHealthRefreshInterval: (seconds: number) => Effect.Effect<void, Error>;
  /** Supply the actual retained PM host; this is the production mutation/peer/drain authorization. */
  readonly authSessionInvalidationLayer: (host: PmProviderHostService) => Layer.Layer<ProviderAuthSessionInvalidation>;
}

function makeFixtureServicesLayer(
  context: ProviderDriverContext,
  runtimeHost: ProviderRuntimeHostService,
  services: Omit<ProviderHost["Service"], "paths">,
): Layer.Layer<PmNativeTestHostServices, PmProviderBoundaryError> {
  return Layer.mergeAll(
    makePmProviderHostLayer(context, services),
    makePmProviderUpstreamServicesLayer(context),
    Layer.succeed(ProviderRuntimeHost, runtimeHost),
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
    IdAllocator.layer,
  ).pipe(Layer.provideMerge(makePmProviderPlatformLayer(context)));
}

function acquireTestDataRoot(prefix: string): Effect.Effect<string, Error, Scope.Scope> {
  return Effect.uninterruptibleMask(restore => Effect.gen(function* () {
    const provided = yield* Effect.serviceOption(PmNativeTestHost);
    if (Option.isSome(provided)) return provided.value.root;
    const scope = yield* Scope.Scope;
    const selected = yield* Effect.sync(() => {
      const existing = scopedRoots.get(scope);
      if (existing) return { ready: existing, owner: false };
      const ready = Deferred.makeUnsafe<string, Error>();
      scopedRoots.set(scope, ready);
      return { ready, owner: true };
    });
    if (!selected.owner) return yield* restore(Deferred.await(selected.ready));
    const acquired = yield* Effect.gen(function* () {
      yield* Effect.acquireRelease(dataRootGate.take(1).pipe(Effect.interruptible), () => dataRootGate.release(1));
      const root = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => realpath(await mkdtemp(path.join(os.tmpdir(), prefix + "-"))),
          catch: failure,
        }),
        directory => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      yield* Effect.acquireRelease(Effect.sync(() => {
        const previous = { ...process.env };
        const inherited = Object.fromEntries(Object.entries(previous).filter(([name]) =>
          Object.hasOwn(inheritedEnvironmentNames, name) || /^LC_[A-Z_]+$/.test(name)));
        replaceProcessEnvironment({ ...inherited, AGENT_WORKSPACE_DATA_DIR: root });
        return previous;
      }), previous => Effect.sync(() => {
        replaceProcessEnvironment(previous);
      }));
      return root;
    }).pipe(restore, Effect.exit);
    yield* Deferred.done(selected.ready, acquired);
    return yield* acquired;
  }));
}

/**
 * Provider-only PM host composition: real settings CAS/subscriptions, private secret backend,
 * attachment registry, bound native platform and the same revocable RuntimeHost as production.
 * It does not import a t3 application orchestrator, projection store, business run or replay engine.
 */
export function makePmNativeTestHost(options: PmNativeTestHostOptions): Effect.Effect<
  PmNativeTestHostFixture, Error, Scope.Scope
> {
  return Effect.gen(function* () {
    const prefix = (options.prefix ?? "pm-native-provider").replace(/[^a-z0-9_-]+/gi, "-");
    const root = yield* acquireTestDataRoot(prefix);
    const assertRoot = () => {
      if (path.resolve(providerDataDirectory()) !== root) throw stale();
    };
    const instanceId = options.instanceId ?? options.driver + "-native-test-" + randomUUID().slice(0, 8);
    const home = path.join(root, "native-user-home", instanceId);
    const workspace = path.join(root, "workspace");
    const environment = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      CODEX_HOME: path.join(home, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      ...options.environment,
    };
    yield* Effect.tryPromise({
      try: async () => {
        for (const directory of [workspace, ...Object.values(environment).filter(value =>
          path.isAbsolute(value) && (value === home || value.startsWith(home + path.sep)))]) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
        }
      },
      catch: failure,
    });
    const current = yield* Effect.try({ try: () => {
      const settings = getProviderSettings();
      updateProviderSettings(settings.revision, options.healthRefreshIntervalSeconds ?? 0);
      const stored = createProviderInstance({
        driver: options.driver,
        instanceId,
        config: options.config ?? {},
        environment: Object.entries(environment).map(([name, value]) => ({ name, value, sensitive: false })),
      });
      return providerContext(stored, options.cwd ?? workspace);
    }, catch: failure });
    const serverConfig = makePmServerConfig(current);
    yield* Effect.tryPromise({
      try: async () => {
        for (const directory of [current.stateDirectory, serverConfig.stateDir, serverConfig.providerStatusCacheDir,
          serverConfig.attachmentsDir, serverConfig.secretsDir]) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
        }
      },
      catch: failure,
    });
    const runtimeHost = makePmProviderRuntimeHost();
    const generations = new Set<{ input: PmNativeTestGenerationInput; active: boolean }>();
    let closed = false;
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      closed = true;
      for (const generation of generations) generation.active = false;
    }));
    const assertCurrent = () => {
      assertRoot();
      const stored = getStoredInstance(current.instanceId);
      if (closed || !stored?.enabled || stored.driver !== current.driver || stored.revision !== current.revision
        || isProviderAccountBusy(current.instanceId)) throw stale();
    };
    const services = makePmProviderHostServices(current, runtimeHost);
    const fixture: PmNativeTestHostFixture = {
      root, context: current, serverConfig, runtimeHost,
      services: { paths: serverConfig, ...services },
      layer: makeFixtureServicesLayer(current, runtimeHost, services),
      bindGeneration: input => Effect.gen(function* () {
        yield* Effect.try({ try: assertCurrent, catch: failure });
        const generation = { input: { ...input, actions: [...input.actions] }, active: true };
        yield* Effect.acquireRelease(Effect.sync(() => { generations.add(generation); }), () => Effect.sync(() => {
          generation.active = false;
          generations.delete(generation);
        }));
        const binding: ProviderRuntimeHostBinding = {
          providerInstanceId: ProviderInstanceId.make(current.instanceId), threadId: input.threadId,
          executionId: input.executionId, cwd: current.cwd, nativePermissions: "deny-ungranted",
          mcpServers: input.mcpServers ?? [], instructionText: input.instructionText ?? "",
        };
        const check = (action: TestAuthorizationAction) => Effect.try({ try: () => {
          assertCurrent();
          if (!generation.active || !generation.input.actions.includes(action)) throw stale();
        }, catch: failure });
        yield* runtimeHost.bind(binding, action => Effect.gen(function* () {
          yield* check(action);
          if (input.authorize) yield* input.authorize(action);
          yield* check(action);
        }));
        return {
          binding,
          isCurrent: Effect.sync(() => {
            try { assertCurrent(); return generation.active; } catch { return false; }
          }),
          authorize: action => runtimeHost.authorize({ ...binding, action }),
          revoke: Effect.sync(() => { generation.active = false; }),
        };
      }),
      registerAttachment: (attachment, bytes, relativePath = attachment.id) => Effect.tryPromise({
        try: async () => {
          assertRoot();
          const target = path.resolve(serverConfig.attachmentsDir, relativePath);
          const relative = path.relative(serverConfig.attachmentsDir, target);
          if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)
            || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) throw new Error("Unsafe test attachment path.");
          const value = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
          if (value.byteLength !== attachment.sizeBytes) throw new Error("Test attachment size does not match its bytes.");
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, value, { mode: 0o600, flag: "wx" });
          assertRoot();
          registerProviderAttachment(attachment, relativePath);
          return target;
        },
        catch: failure,
      }),
      updateInstance: patch => Effect.try({ try: () => {
        assertRoot();
        const next = updateProviderInstance(current.instanceId, patch, current.revision);
        return providerContext(next, current.cwd);
      }, catch: failure }),
      setHealthRefreshInterval: seconds => Effect.try({ try: () => {
        assertRoot();
        updateProviderSettings(getProviderSettings().revision, seconds);
      }, catch: failure }),
      authSessionInvalidationLayer: makePmProviderAuthSessionInvalidationLayer,
    };
    return fixture;
  });
}

/** Replace source ServerConfig/ServerSettings/ProviderHostLive test layers with this one composition. */
export const layer = (options: PmNativeTestHostOptions) => Layer.unwrap(
  makePmNativeTestHost(options).pipe(Effect.map(fixture => fixture.layer.pipe(
    Layer.merge(Layer.succeed(PmNativeTestHost, fixture)),
  ))),
);

/** Only the provider-consumed paths are returned; no t3 database/settings/projection layout exists. */
export const makeReplayServerConfig = (scenario: string, options: PmNativeTestHostOptions) =>
  makePmNativeTestHost({ ...options, prefix: options.prefix ?? "pm-native-replay-" + scenario }).pipe(
    Effect.map(fixture => fixture.serverConfig),
  );
