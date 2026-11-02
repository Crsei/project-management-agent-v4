import path from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { OmpDriver } from "@t3tools/provider-omp/server";
import { readOmpSessionEvidence } from "@t3tools/provider-omp/server/sessionEvidence";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderRuntimeHost, type ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import { ProviderContinuationRequests } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import { makePmProviderPlatformLayer } from "../host-runtime.ts";
import { makePmProviderHostLayer, makePmProviderHostServices } from "../host.ts";
import { makePmProviderContinuationRequests, pmExecutionError, type PmProviderProtocolResolver, type PmProviderProtocolProbe } from "../continuation.ts";
import type { PmProviderCapabilitiesProjector, PmProviderInstallationMethods } from "../management.ts";
import { pmAdapterBoundaryError } from "../events.ts";

export const ompDriver = OmpDriver;
export function makeOmpDriverLayer(context: ProviderDriverContext, runtimeHost: ProviderRuntimeHostService) {
  return Layer.mergeAll(
    makePmProviderHostLayer(context, makePmProviderHostServices(context, runtimeHost)),
    Layer.succeed(ProviderRuntimeHost, runtimeHost),
    Layer.effect(ProviderContinuationRequests, makePmProviderContinuationRequests(context, runtimeHost)),
    IdAllocator.layer,
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  ).pipe(Layer.provideMerge(makePmProviderPlatformLayer(context)));
}

export const ompProtocolResolver: PmProviderProtocolResolver = ({ context, lease, runtime }) => Effect.gen(function* () {
  yield* lease.assertCurrent;
  const evidence = readOmpSessionEvidence(runtime);
  if (!evidence || context.driver !== "omp" || lease.localDriver !== "omp"
    || runtime.driver !== OmpDriver.driverKind || runtime.instanceId !== lease.instance.instanceId)
    return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The original OMP operation has no native protocol evidence."));
  const native = yield* evidence.probe.pipe(Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause), "session_mismatch", 409))));
  yield* lease.assertCurrent;
  if (path.resolve(native.cwd) !== path.resolve(lease.cwd) || path.resolve(native.homeDirectory) !== path.resolve(lease.nativeHome))
    return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The original OMP native directory or Home changed."));
  return {
    protocol: native.protocol,
    adoptLegacy: ({ source, ensure }) => Effect.gen(function* () {
      yield* lease.assertCurrent;
      const snapshot = yield* evidence.readLegacy({
        nativeSessionId: source.sessionId, ...(source.turnId ? { turnId: source.turnId } : {}),
        ...(source.messageId ? { messageId: source.messageId } : {}), ensure,
      }).pipe(Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause), "session_mismatch", 409))));
      yield* lease.assertCurrent;
      return snapshot;
    }),
  } satisfies PmProviderProtocolProbe;
});

export const ompCapabilities: PmProviderCapabilitiesProjector = ({ lease }) => lease.assertCurrent.pipe(
  Effect.andThen(lease.instance.orchestrationAdapter.getCapabilities()),
  Effect.map(capabilities => ({
    nativeResume: capabilities.threads.exposesNativeThreadId && capabilities.threads.canReadThreadSnapshot,
    nativeFork: capabilities.threads.canForkThread,
    boundedFork: capabilities.threads.canForkThread && capabilities.threads.canForkFromTurn,
    modelTransition: capabilities.sessions.supportsModelSwitchInSession ? "native" as const : "portable" as const,
    portableHandoff: true as const,
  })), Effect.mapError(error => pmAdapterBoundaryError(error)),
);

/** The OMP CLI installation and native account remain externally managed. */
export const ompInstallationMethods: PmProviderInstallationMethods = {};
