import { createHash } from "node:crypto";
import path from "node:path";
import * as Cause from "effect/Cause";
import type { Crypto } from "effect/Crypto";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { Stdio } from "effect/Stdio";
import type { ChildProcessSpawner } from "effect/process";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { FetchHttpClient, type HttpClient } from "effect/http";
import type { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import type { PmProviderFamily, PmProviderFamilyRuntime } from "./registration.ts";
import { DocumentTextWorkerEntry, type DocumentText } from "../../../../../../vendor/t3code/apps/server/src/provider/DocumentText.ts";
import { makePmDocumentTextLayer, pmDocumentTextWorkerEntry } from "./upstream-services/document-text.ts";
import { makePmProviderAgentScopeLayer } from "./upstream-services/agent-scope.ts";
import { makePmProviderProcessPlatformLayer } from "./upstream-services/process-platform.ts";
export { bindPmProviderCommand } from "./upstream-services/process-platform.ts";
import { beginProviderExecution, beginProviderHostMutation, beginProviderHostStatus, registerProviderResourceBindings } from "../auth.ts";
import { getStoredInstance, providerUsageContext, providerDataDirectory, subscribeProviderSettingsChanges } from "../instances.ts";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import type { PmProviderBoundaryError, PmProviderHostService, PmProviderPurpose, PmProviderLease, PmProviderUsageLease } from "./contract.ts";
import { projectProviderInstance, providerBoundaryError, toT3DriverKind } from "./config-mapping.ts";

export type PmProviderPlatformServices =
  | ChildProcessSpawner.ChildProcessSpawner | Crypto | FileSystem | Path | Stdio | HttpClient.HttpClient | DocumentText;

export function makePmProviderPlatformLayer(context: ProviderDriverContext): Layer.Layer<PmProviderPlatformServices> {
  const processPlatform = makePmProviderProcessPlatformLayer(context);
  return Layer.mergeAll(processPlatform, FetchHttpClient.layer, makePmProviderAgentScopeLayer(context),
    makePmDocumentTextLayer(context).pipe(Layer.provide(processPlatform)),
    Layer.succeed(DocumentTextWorkerEntry, pmDocumentTextWorkerEntry()));
}
function contextIdentity(context: ProviderDriverContext, root: string): string {
  return createHash("sha256").update(JSON.stringify([
    path.resolve(root), context.instanceId, context.driver, context.revision, path.resolve(context.cwd), path.resolve(context.homeDirectory),
    path.resolve(context.stateDirectory), Object.entries(context.env)
      .filter(([key]) => key !== "CLAUDE_AGENT_SDK_VERSION").sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(context.config).sort(([a], [b]) => a.localeCompare(b)), context.customModels ?? [],
    Object.entries(context.instanceEnvironment ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ])).digest("hex");
}
export function makePmProviderHostService(input: {
  readonly families: ReadonlyMap<ProviderDriverKind, PmProviderFamily>;
  readonly runtimeHost: ProviderRuntimeHostService;
}): Effect.Effect<PmProviderHostService, PmProviderBoundaryError, Scope.Scope> {
  return Effect.gen(function* () {
    const hostScope = yield* Scope.Scope;
    type Operation = { readonly purpose: PmProviderPurpose; invalidated: boolean };
    interface Entry {
      readonly context: ProviderDriverContext;
      readonly identity: string;
      readonly root: string;
      readonly scope: Scope.Closeable;
      readonly operations: Set<Operation>;
      readonly drained: Deferred.Deferred<void>;
      readonly initialization: Fiber.Fiber<PmProviderFamilyRuntime, PmProviderBoundaryError>;
      instance?: ProviderInstance;
      invalidated: boolean;
      closing?: Deferred.Deferred<void, PmProviderBoundaryError>;
    }
    // Each exact native context owns one retained registry; cwd-independent account locks stay in auth.ts.
    const entries = new Map<string, Entry>();
    const cleanupFailures = new Map<string, PmProviderBoundaryError>();
    const gate = Semaphore.makeUnsafe(1);
    let stopped = false;
    const cleanupError = (entry: Entry) => {
      const error = providerBoundaryError("Provider scope cleanup failed.", "provider_cleanup_failed", 500);
      cleanupFailures.set(`${entry.root}\0${entry.context.instanceId}`, error);
      return error;
    };
    const checkContext = (context: ProviderDriverContext, root: string, identity: string, allowDisabled = false) => Effect.try({ try: () => {
      const current = getStoredInstance(context.instanceId);
      if (stopped || root !== providerDataDirectory() || !current || (!allowDisabled && !current.enabled) || current.driver !== context.driver
        || current.revision !== context.revision
        || contextIdentity(providerUsageContext(current, context.cwd), root) !== identity)
        throw providerBoundaryError("Provider instance, revision or native environment changed.");
      return current;
    }, catch: error => error instanceof Error && "status" in error && "code" in error
      ? Object.assign(error, { status: Number(error.status), code: String(error.code) })
      : providerBoundaryError("Unable to read the authoritative Provider instance.", "provider_configuration_unavailable", 500) });
    const markInvalid = (entry: Entry) => {
      entry.invalidated = true;
      for (const operation of entry.operations) operation.invalidated = true;
    };
    const close = (entry: Entry): Effect.Effect<void, PmProviderBoundaryError> => Effect.uninterruptible(Effect.suspend(() => {
      if (entry.closing) return Deferred.await(entry.closing);
      const closing = entry.closing = Deferred.makeUnsafe<void, PmProviderBoundaryError>();
      return Effect.gen(function* () {
        const result = yield* Scope.close(entry.scope, Exit.void).pipe(
          Effect.catchCause(() => Effect.fail(cleanupError(entry))), Effect.exit,
        );
        if (entries.get(entry.identity) === entry) entries.delete(entry.identity);
        yield* Deferred.done(closing, result);
        return yield* result;
      });
    }));
    const retire = (entry: Entry): Effect.Effect<void, PmProviderBoundaryError> => Effect.gen(function* () {
      markInvalid(entry);
      // Initialization belongs to the host, not whichever operation first requested it.
      yield* Fiber.interrupt(entry.initialization);
      if (entry.operations.size === 0) yield* close(entry);
    });
    const drain = (entry: Entry) => Effect.gen(function* () {
      yield* retire(entry);
      if (entry.operations.size) yield* Deferred.await(entry.drained);
      yield* close(entry);
    });
    const shutdown = Effect.suspend(() => {
      // Stop admissions synchronously, even if another acquisition is about to enter the gate.
      stopped = true;
      return Effect.gen(function* () {
        const owned = yield* gate.withPermit(Effect.sync(() => [...entries.values()]));
        for (const entry of owned) markInvalid(entry);
        const results = yield* Effect.forEach(owned, entry => Effect.exit(drain(entry)));
        if (results.some(Exit.isFailure) || cleanupFailures.size)
          return yield* Effect.fail(providerBoundaryError("Provider scope cleanup failed.", "provider_cleanup_failed", 500));
      });
    });
    yield* Effect.addFinalizer(() => shutdown.pipe(Effect.orDie));
    function acquire(context: ProviderDriverContext, purpose: "usage"): Effect.Effect<PmProviderUsageLease, PmProviderBoundaryError, Scope.Scope>;
    function acquire(context: ProviderDriverContext, purpose: Exclude<PmProviderPurpose, "usage">): Effect.Effect<PmProviderLease, PmProviderBoundaryError, Scope.Scope>;
    function acquire(providedContext: ProviderDriverContext, purpose: PmProviderPurpose): Effect.Effect<PmProviderUsageLease | PmProviderLease, PmProviderBoundaryError, Scope.Scope> {
      return Effect.gen(function* () {
        if (stopped) return yield* Effect.fail(providerBoundaryError("Provider host has shut down.", "provider_host_closed", 503));
        const root = providerDataDirectory();
        const context = { ...providedContext, env: { ...providedContext.env }, config: { ...providedContext.config },
          ...(providedContext.instanceEnvironment ? { instanceEnvironment: { ...providedContext.instanceEnvironment } } : {}) };
        const identity = contextIdentity(context, root);
        yield* checkContext(context, root, identity, purpose === "usage");
        const begin = purpose === "execution" || purpose === "usage" ? () => beginProviderExecution(context.instanceId)
          : purpose === "status" ? () => beginProviderHostStatus(context.instanceId)
          : () => beginProviderHostMutation(context.instanceId, purpose === "maintenance");
        yield* Effect.acquireRelease(Effect.try({ try: begin, catch: () => providerBoundaryError("Provider account is busy.", "provider_busy", 409) }), done => Effect.sync(done));
        const operation: Operation = { purpose, invalidated: false };
        const select: Effect.Effect<Entry, PmProviderBoundaryError> = Effect.suspend(() => gate.withPermit(Effect.gen(function* () {
          if (stopped) return yield* Effect.fail(providerBoundaryError("Provider host has shut down.", "provider_host_closed", 503));
          const current = yield* checkContext(context, root, identity, purpose === "usage");
          const cleanupFailure = cleanupFailures.get(`${root}\0${context.instanceId}`);
          if (cleanupFailure) return yield* Effect.fail(cleanupFailure);
          const stale: Entry[] = [];
          for (const entry of entries.values()) {
            if (entry.root === root && entry.context.instanceId !== context.instanceId) continue;
            const authoritative = yield* checkContext(entry.context, entry.root, entry.identity, true).pipe(Effect.result);
            if (entry.invalidated || authoritative._tag === "Failure") stale.push(entry);
          }
          if (stale.length) {
            for (const entry of stale) markInvalid(entry);
            return { _tag: "stale" as const, stale };
          }
          let entry = entries.get(identity);
          if (!entry) {
            const family = input.families.get(toT3DriverKind(context.driver));
            if (!family || family.driverKind !== toT3DriverKind(context.driver))
              return yield* Effect.fail(providerBoundaryError("Provider source driver is not registered.", "unknown_provider", 400));
            const projected = yield* Effect.try({ try: () => projectProviderInstance(current, context),
              catch: () => providerBoundaryError("Provider instance cannot be represented by its source schema.", "invalid_config", 409) });
            const scope = yield* Scope.make();
            const initialize = Effect.gen(function* () {
              // Each family closes its own requirements and builds original services in this retained scope.
              return yield* family.build(context, projected, input.runtimeHost, scope);
            }).pipe(Effect.catchCause(cause => {
              const error = Cause.squash(cause);
              return Effect.fail(error instanceof Error && "status" in error && "code" in error
                ? Object.assign(error, { status: Number(error.status), code: String(error.code) })
                : providerBoundaryError("Provider source initialization failed.", "provider_initialization_failed", 500));
            }), Effect.onExit(result => Effect.gen(function* () {
              const owned = entries.get(identity);
              if (Exit.isSuccess(result) || owned?.scope !== scope) return;
              markInvalid(owned);
              if (owned.operations.size === 0) yield* close(owned).pipe(Effect.orDie);
            })), Effect.interruptible);
            const initialization = yield* Effect.forkIn(initialize, hostScope);
            entry = { context, identity, root, scope, initialization, operations: new Set(), drained: Deferred.makeUnsafe(), invalidated: false };
            if (stopped) {
              yield* drain(entry);
              return yield* Effect.fail(providerBoundaryError("Provider host has shut down.", "provider_host_closed", 503));
            }
            entries.set(identity, entry);
          }
          entry.operations.add(operation);
          return { _tag: "ready" as const, entry };
        })).pipe(Effect.flatMap(selected => selected._tag === "ready" ? Effect.succeed(selected.entry)
          : Effect.forEach(selected.stale, drain).pipe(Effect.interruptible, Effect.andThen(select)))));
        const entry = yield* Effect.acquireRelease(select, entry => Effect.gen(function* () {
          operation.invalidated = true;
          entry.operations.delete(operation);
          if (entry.invalidated && entry.operations.size === 0) {
            yield* Deferred.succeed(entry.drained, undefined);
            yield* close(entry).pipe(Effect.orDie);
          }
        }));
        const retained = yield* Fiber.join(entry.initialization).pipe(Effect.onErrorIf(
          cause => !Cause.hasInterrupts(cause), () => Effect.sync(() => markInvalid(entry)),
        ));
        const instance = retained.instance;
        if (instance) entry.instance = instance;
        const assertCurrent = Effect.gen(function* () {
          if (operation.invalidated || entry.invalidated)
            return yield* Effect.fail(providerBoundaryError("Provider instance, revision or native environment changed."));
          yield* checkContext(context, root, identity, purpose === "usage").pipe(
            Effect.onError(() => Effect.sync(() => markInvalid(entry))),
          );
        });
        const credentialBinding = instance?.auth?.credentialBinding;
        if (credentialBinding) yield* Effect.try({
          try: () => registerProviderResourceBindings(context.instanceId, [`credential:${credentialBinding.owner}:${credentialBinding.key}`]),
          catch: () => providerBoundaryError("A shared Provider credential binding is busy.", "provider_busy", 409),
        });
        yield* assertCurrent;
        const lease: PmProviderUsageLease = {
          localDriver: context.driver, instanceId: context.instanceId, revision: context.revision,
          cwd: context.cwd, nativeHome: context.homeDirectory, assertCurrent,
          ...(retained.usage ? { usage: retained.usage } : {}),
        };
        if (purpose === "usage") return lease;
        if (!instance) {
          markInvalid(entry);
          return yield* Effect.fail(providerBoundaryError("Provider source instance is unavailable for the current configuration.", "invalid_config", 409));
        }
        return { ...lease, continuationIdentity: instance.continuationIdentity, instance };
      });
    }
    const service: PmProviderHostService = {
      acquire,
      invalidate: instanceId => Effect.gen(function* () {
        const owned = [...entries.values()].filter(entry => entry.context.instanceId === instanceId);
        const results = yield* Effect.forEach(owned, entry => Effect.gen(function* () {
          const current = yield* checkContext(entry.context, entry.root, entry.identity, true).pipe(Effect.result);
          // Only the current mutation's exact controller survives its own stopSessions call.
          // Idle contexts for other cwd values must not retain the previous auth/catalog state.
          const ownsMutation = current._tag === "Success" && [...entry.operations].some(operation =>
            !operation.invalidated && (operation.purpose === "auth" || operation.purpose === "maintenance"));
          if (!ownsMutation) markInvalid(entry);
          else for (const operation of entry.operations)
            if (operation.purpose !== "auth" && operation.purpose !== "maintenance") operation.invalidated = true;
          const invalidated = yield* (entry.instance?.invalidateCaches ?? Effect.void).pipe(
            Effect.catchCause(() => Effect.fail(cleanupError(entry))), Effect.exit,
          );
          const retired = yield* (ownsMutation ? Effect.void : retire(entry)).pipe(Effect.exit);
          if (Exit.isFailure(invalidated)) return yield* invalidated;
          return yield* retired;
        }).pipe(Effect.exit));
        const cleanupFailure = cleanupFailures.get(`${providerDataDirectory()}\0${instanceId}`);
        if (cleanupFailure) return yield* Effect.fail(cleanupFailure);
        for (const result of results) if (Exit.isFailure(result)) return yield* result;
      }),
      shutdown,
    };
    yield* Effect.acquireRelease(Effect.sync(() => subscribeProviderSettingsChanges(() => {
      for (const entry of entries.values()) {
        let changed = entry.root !== providerDataDirectory();
        try {
          const current = getStoredInstance(entry.context.instanceId);
          changed ||= !current || contextIdentity(providerUsageContext(current, entry.context.cwd), entry.root) !== entry.identity;
        } catch { changed = true; }
        if (changed) {
          markInvalid(entry);
          Effect.runFork(retire(entry));
        }
      }
    })), unsubscribe => Effect.sync(unsubscribe));
    return service;
  });
}
