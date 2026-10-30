import path from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderContinuationRequests } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderRuntimeHost, type ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import { readAcpSessionEvidence } from "@t3tools/provider-acp/server/adapter";
import { AntigravityDriver, readAntigravityInstallation } from "../../../../../../../vendor/t3code/apps/server/src/provider/Drivers/AntigravityDriver.ts";
import * as AntigravityInstallation from "../../../../../../../vendor/t3code/apps/server/src/provider/AntigravityInstallation.ts";
import * as AntigravityUsage from "../../../../../../../vendor/t3code/apps/server/src/provider/Drivers/AntigravityUsage.ts";
import { AntigravityProfileDirectories } from "../../../../../../../vendor/t3code/apps/server/src/provider/antigravityAuthSupport.ts";
import * as ModelManifest from "../../../../../../../vendor/t3code/apps/server/src/provider/ModelManifest.ts";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import { getStoredInstance, listStoredInstances } from "../../instances.ts";
import { registerProviderResourceBindings } from "../../auth.ts";
import { makePmProviderPlatformLayer } from "../host-runtime.ts";
import { makePmProviderHostLayer, makePmProviderHostServices, makePmProviderUpstreamServicesLayer } from "../host.ts";
import { makePmProviderContinuationRequests, pmExecutionError, type PmProviderProtocolResolver } from "../continuation.ts";
import type { PmProviderCapabilitiesProjector, PmProviderInstallationMethods } from "../management.ts";
import type { PmProviderLease } from "../contract.ts";
import { pmAdapterBoundaryError } from "../events.ts";

export const antigravityDriver = AntigravityDriver;
export const antigravityUsageLayer = AntigravityUsage.layer;

function installationLayer(context: ProviderDriverContext) {
  return Layer.effect(AntigravityInstallation.AntigravityInstallation, Effect.gen(function* () {
    // Preserve the existing app-owned per-instance installation; native HOME is untouched.
    const installation = yield* AntigravityInstallation.makeAntigravityInstallation({ baseDir: context.stateDirectory });
    if (getStoredInstance(context.instanceId)) yield* Effect.try({
      try: () => registerProviderResourceBindings(context.instanceId, ["maintenance:antigravity:" + installation.managedDirectory]),
      catch: error => pmAdapterBoundaryError(error, "provider_busy", 409),
    });
    return installation;
  }));
}

/** Original driver/SDK dependencies, closed over the same generation runtime host as execution. */
export function makeAntigravityDriverLayer(context: ProviderDriverContext, runtimeHost: ProviderRuntimeHostService) {
  const platform = makePmProviderPlatformLayer(context);
  const upstream = makePmProviderUpstreamServicesLayer(context);
  const catalog = ModelManifest.layerModelCatalog.pipe(Layer.provide(ModelManifest.layer), Layer.provide(upstream));
  const base = Layer.mergeAll(
    makePmProviderHostLayer(context, makePmProviderHostServices(context, runtimeHost)),
    Layer.succeed(ProviderRuntimeHost, runtimeHost),
    Layer.succeed(AntigravityProfileDirectories, { instanceId: ProviderInstanceId.make(context.instanceId),
      directories: { profile: context.stateDirectory, runtimeTemp: path.join(context.stateDirectory, "antigravity-acp", "tmp") } }),
    Layer.effect(ProviderContinuationRequests, makePmProviderContinuationRequests(context, runtimeHost)),
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
    IdAllocator.layer,
    installationLayer(context),
    catalog,
  ).pipe(Layer.provideMerge(platform));
  return AntigravityUsage.layer.pipe(Layer.provideMerge(base));
}

export const antigravityProtocolResolver: PmProviderProtocolResolver = ({ context, lease, runtime }) => Effect.gen(function* () {
  yield* lease.assertCurrent;
  const evidence = readAcpSessionEvidence(runtime);
  if (!evidence || context.driver !== "antigravity" || runtime.instanceId !== lease.instance.instanceId
    || evidence.cwd !== lease.cwd || path.resolve(lease.cwd, evidence.homeDirectory) !== lease.nativeHome) {
    return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The original Antigravity operation did not confirm its native protocol, Home and directory."));
  }
  return {
    protocol: evidence.protocol,
    adoptLegacy: ({ source, ensure }) => lease.assertCurrent.pipe(
      Effect.andThen(evidence.readLegacy({ nativeSessionId: source.sessionId,
        ...(source.turnId ? { turnId: source.turnId } : {}), ...(source.messageId ? { messageId: source.messageId } : {}), ensure })),
      Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause), "session_mismatch", 409))),
    ),
  };
});

export const antigravityCapabilities: PmProviderCapabilitiesProjector = ({ lease }) => lease.assertCurrent.pipe(
  Effect.andThen(lease.instance.orchestrationAdapter.getCapabilities()),
  Effect.map(capabilities => ({
    nativeResume: capabilities.threads.exposesNativeThreadId && capabilities.threads.canReadThreadSnapshot,
    nativeFork: capabilities.threads.canForkThread,
    boundedFork: capabilities.threads.canForkThread && capabilities.threads.canForkFromTurn,
    modelTransition: capabilities.sessions.supportsModelSwitchInSession ? "native" as const : "portable" as const,
    portableHandoff: true as const,
  })),
  Effect.mapError(error => pmAdapterBoundaryError(error)),
);

// Provisional instances have no account row yet. Keep their real installer exclusive too.
const provisioning = new Set<string>();
async function withInstallation<A>(context: ProviderDriverContext, signal: AbortSignal | undefined,
  use: (installation: AntigravityInstallation.AntigravityInstallation["Service"]) => Effect.Effect<A, unknown, Scope.Scope>,
  lease?: PmProviderLease) {
  if (context.config.binaryPath) throw pmExecutionError(409, "unsupported_install", "Clear the custom Antigravity binary path before managing the runtime.");
  const key = path.resolve(context.stateDirectory);
  if (provisioning.has(key)) throw pmExecutionError(409, "provider_busy", "Antigravity installation is already in progress for this provider.");
  provisioning.add(key);
  try {
    const action = lease ? Effect.gen(function* () {
      yield* lease.assertCurrent;
      const installation = readAntigravityInstallation(lease.instance);
      if (!installation) return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The retained Antigravity installation controller is no longer owned by this instance."));
      const result = yield* use(installation);
      yield* lease.assertCurrent;
      return result;
    }) : Effect.gen(function* () {
      // No existing account may silently use a second installer/controller.
      if (getStoredInstance(context.instanceId)) return yield* Effect.fail(pmExecutionError(409, "provider_busy", "An existing Antigravity account requires its retained maintenance lease."));
      return yield* use(yield* AntigravityInstallation.AntigravityInstallation);
    }).pipe(Effect.provide(installationLayer(context)), Effect.provide(makePmProviderPlatformLayer(context)));
    return await Effect.runPromise(Effect.scoped(action).pipe(
      Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause))))), { signal });
  } finally { provisioning.delete(key); }
}

export const antigravityInstallationMethods: PmProviderInstallationMethods = {
  prepare: (context, signal, progress, lease) => withInstallation(context, signal, installation => Effect.gen(function* () {
    const states = yield* Stream.toQueue(installation.changes, { capacity: "unbounded" });
    const operation = yield* Effect.acquireRelease(installation.startOperation, captured => Effect.gen(function* () {
      const current = yield* installation.state;
      if (captured.state.operationId && current.operationId === captured.state.operationId
        && ["downloading", "extracting", "verifying"].includes(current.phase))
        yield* installation.cancel(captured.state.operationId).pipe(Effect.orDie);
    }).pipe(Effect.ensuring(captured.completion.pipe(Effect.orDie))));
    const started = operation.state;
    const operationId = started.operationId;
    if (!operationId) return yield* Effect.fail(pmExecutionError(500, "provider_install_failed", "Antigravity did not start an installation operation."));
    for (;;) {
      const state = yield* Queue.take(states);
      if (state.operationId !== operationId) continue;
      yield* Effect.sync(() => progress?.({ ...(state.message ? { message: state.message } : {}),
        bytesDownloaded: state.downloadedBytes, ...(state.totalBytes === null ? {} : { bytesTotal: state.totalBytes }) }));
      if (state.phase === "succeeded") return { message: state.message ?? "Antigravity runtime installed and verified." };
      if (state.phase === "failed" || state.phase === "cancelled")
        return yield* Effect.fail(pmExecutionError(500, "provider_install_failed", state.message ?? "Antigravity installation did not complete."));
    }
  }), lease),
  removeInstallation: (context, signal, _progress, lease) => withInstallation(context, signal, installation => Effect.gen(function* () {
    const protectedPaths = listStoredInstances().filter(instance => instance.driver === "antigravity")
      .flatMap(instance => typeof instance.config.binaryPath === "string" && instance.config.binaryPath ? [instance.config.binaryPath] : []);
    yield* installation.remove(protectedPaths);
    return { message: "Removed this instance's managed Antigravity runtime. Account data and external executables were retained." };
  }), lease),
};
