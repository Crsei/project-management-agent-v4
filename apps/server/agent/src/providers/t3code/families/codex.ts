import path from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { ProviderContinuationRequests } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderRuntimeHost, type ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import { CodexDriver, readCodexInstanceInstallation } from "../../../../../../../vendor/t3code/apps/server/src/provider/Drivers/CodexDriver.ts";
import { layerAppServerClientFactory, readCodexSessionEvidence } from "../../../../../../../vendor/t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ModelManifest from "../../../../../../../vendor/t3code/apps/server/src/provider/ModelManifest.ts";
import { makePmResetCreditCoordinatorLayer } from "../upstream-services/reset-credit-coordinator.ts";
import * as CodexInstallation from "../../../../../../../vendor/t3code/apps/server/src/provider/CodexInstallation.ts";
import * as CodexManagedTokenBroker from "../../../../../../../vendor/t3code/apps/server/src/provider/CodexManagedTokenBroker.ts";
import { CodexManagedHomePath } from "../../../../../../../vendor/t3code/apps/server/src/provider/CodexManagedHome.ts";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import { tokenizeNativeArgs, validateCodexLaunchArgs } from "../../drivers/codex-config.ts";
import { getStoredInstance } from "../../instances.ts";
import { makePmProviderPlatformLayer } from "../host-runtime.ts";
import { makePmProviderHostLayer, makePmProviderHostServices, makePmProviderUpstreamServicesLayer } from "../host.ts";
import { makePmProviderContinuationRequests, pmExecutionError, type PmProviderProtocolResolver } from "../continuation.ts";
import type { PmProviderCapabilitiesProjector, PmProviderInstallationMethods } from "../management.ts";
import { pmAdapterBoundaryError } from "../events.ts";
import type { PmProviderLease } from "../contract.ts";

export const codexDriver = CodexDriver;

/** All concrete source dependencies are scoped to the authorized PM instance operation. */
export function makeCodexDriverLayer(context: ProviderDriverContext, runtimeHost: ProviderRuntimeHostService) {
  validateCodexLaunchArgs(tokenizeNativeArgs(context.env.T3CODE_CODEX_LAUNCH_ARGS?.trim() || String(context.config.launchArgs ?? "")));
  const platform = makePmProviderPlatformLayer(context);
  const host = Layer.mergeAll(
    makePmProviderHostLayer(context, makePmProviderHostServices(context, runtimeHost)),
    makePmProviderUpstreamServicesLayer(context),
    Layer.succeed(ProviderRuntimeHost, runtimeHost),
    Layer.succeed(CodexManagedHomePath, context.config.setupMode === "managed" ? context.homeDirectory : undefined),
    Layer.effect(ProviderContinuationRequests, makePmProviderContinuationRequests(context, runtimeHost)),
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
    IdAllocator.layer,
    ProviderLatestVersions.layer,
  ).pipe(Layer.provideMerge(platform));
  const manifest = ModelManifest.layer.pipe(Layer.provideMerge(host));
  return Layer.mergeAll(
    layerAppServerClientFactory,
    makePmResetCreditCoordinatorLayer(runtimeHost),
    ModelManifest.layerModelCatalog,
    Layer.effect(CodexInstallation.CodexInstallation, CodexInstallation.makeCodexInstallation({
      baseDir: context.stateDirectory, managedDirectory: path.join(context.stateDirectory, ".managed-codex", "runtime"),
    })),
    CodexManagedTokenBroker.layer,
  ).pipe(Layer.provideMerge(manifest), Layer.catch(error => Layer.effectContext(Effect.fail(pmAdapterBoundaryError(error)))));
}

export const codexProtocolResolver: PmProviderProtocolResolver = ({ context, lease, runtime }) => Effect.gen(function* () {
  yield* lease.assertCurrent;
  const probe = readCodexSessionEvidence(runtime);
  if (!probe || context.driver !== "codex" || runtime.instanceId !== lease.instance.instanceId) {
    return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The original Codex operation has no native protocol evidence."));
  }
  const evidence = yield* probe.pipe(Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause), "session_mismatch", 409))));
  if (!path.isAbsolute(evidence.homeDirectory) || path.resolve(evidence.homeDirectory) !== lease.nativeHome) {
    return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The original Codex operation did not confirm this native Home."));
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

export const codexCapabilities: PmProviderCapabilitiesProjector = ({ lease }) => lease.assertCurrent.pipe(
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

function installationLayer(context: ProviderDriverContext) {
  const host = makePmProviderUpstreamServicesLayer(context).pipe(Layer.provideMerge(makePmProviderPlatformLayer(context)));
  return Layer.effect(CodexInstallation.CodexInstallation, CodexInstallation.makeCodexInstallation({
    baseDir: context.stateDirectory, managedDirectory: path.join(context.stateDirectory, ".managed-codex", "runtime"),
  })).pipe(Layer.provideMerge(ModelManifest.layer.pipe(Layer.provideMerge(host))));
}

function withCodexInstallation<A, E>(context: ProviderDriverContext, lease: PmProviderLease | undefined,
  task: Effect.Effect<A, E, CodexInstallation.CodexInstallation | Scope.Scope>, signal?: AbortSignal) {
  const installation = lease ? readCodexInstanceInstallation(lease.instance) : undefined;
  if (lease && !installation) throw pmExecutionError(409, "provider_not_configured", "The original Codex instance has no owned installer.");
  return Effect.runPromise(Effect.scoped(installation
    ? task.pipe(Effect.provideService(CodexInstallation.CodexInstallation, installation))
    : task.pipe(Effect.provide(installationLayer(context)))), { signal });
}

/** Original install/remove operations only; PM management owns mutation exclusion and revision checks. */
export const codexInstallationMethods: PmProviderInstallationMethods = {
  prepare: (context, signal, progress, lease) => withCodexInstallation(context, lease, Effect.gen(function* () {
    const installation = yield* CodexInstallation.CodexInstallation;
    const states = yield* Stream.toQueue(installation.changes, { capacity: "unbounded" });
    const operation = yield* Effect.acquireRelease(installation.startOperation, captured => Effect.gen(function* () {
      const current = yield* installation.state;
      if (captured.state.operationId && current.operationId === captured.state.operationId
        && ["downloading", "extracting", "verifying"].includes(current.phase))
        yield* installation.cancel(captured.state.operationId).pipe(Effect.orDie);
    }).pipe(Effect.ensuring(captured.completion.pipe(Effect.orDie))));
    const first = operation.state;
    let result = first;
    while (!["succeeded", "failed", "cancelled"].includes(result.phase)) {
      if (!first.operationId) return yield* Effect.fail(pmExecutionError(500, "provider_install_failed", "Codex did not start an installation operation."));
      const state = yield* Queue.take(states);
      if (state.operationId !== first.operationId) continue;
      yield* Effect.sync(() => progress?.({ message: state.message ?? `Codex installation: ${state.phase}` }));
      result = state;
    }
    if (result.phase !== "succeeded") return yield* Effect.fail(pmExecutionError(412, "provider_not_configured", result.message ?? "Codex installation did not complete."));
    return { message: result.message ?? "Codex runtime is ready." };
  }), signal),
  removeInstallation: (context, signal, _progress, lease) => withCodexInstallation(context, lease, Effect.gen(function* () {
    const installation = yield* CodexInstallation.CodexInstallation;
    const current = getStoredInstance(context.instanceId);
    yield* installation.remove(current && typeof current.config.binaryPath === "string" && current.config.binaryPath
      ? [current.config.binaryPath] : []);
    return { message: "Managed Codex runtime removed; native homes and account connections were preserved." };
  }), signal),
};
