import path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import { MuseDriver } from "@t3tools/provider-muse/server";
import { readMuseSessionEvidence } from "../../../../../../../vendor/t3code/packages/provider-muse/src/server/sessionEvidence.ts";
import * as MuseUsageHome from "../../../../../../../vendor/t3code/packages/provider-muse/src/server/MuseUsageHome.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderRuntimeHost, type ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import { ProviderContinuationRequests } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import { makePmProviderPlatformLayer } from "../host-runtime.ts";
import { makePmProviderHostLayer, makePmProviderHostServices } from "../host.ts";
import { makePmProviderContinuationRequests, pmExecutionError, type PmProviderProtocolResolver, type PmProviderProtocolProbe } from "../continuation.ts";
import type { PmProviderCapabilitiesProjector, PmProviderInstallationMethods } from "../management.ts";
import { pmAdapterBoundaryError } from "../events.ts";

export const museDriver = MuseDriver;
export function makeMuseDriverLayer(context: ProviderDriverContext, runtimeHost: ProviderRuntimeHostService) {
  return Layer.mergeAll(
    makePmProviderHostLayer(context, makePmProviderHostServices(context, runtimeHost)),
    Layer.succeed(ProviderRuntimeHost, runtimeHost),
    Layer.effect(ProviderContinuationRequests, makePmProviderContinuationRequests(context, runtimeHost)),
    IdAllocator.layer, ProviderLatestVersions.layer,
    MuseUsageHome.layer,
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  ).pipe(Layer.provideMerge(makePmProviderPlatformLayer(context)));
}
export const museProtocolResolver: PmProviderProtocolResolver = ({ context, lease, runtime }) => Effect.gen(function* () {
  yield* lease.assertCurrent;
  const evidence = readMuseSessionEvidence(runtime);
  if (!evidence || context.driver !== "muse" || runtime.instanceId !== lease.instance.instanceId)
    return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The original Muse operation has no native protocol evidence."));
  const native = yield* evidence.probe.pipe(Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause), "session_mismatch", 409))));
  if (path.resolve(native.cwd) !== path.resolve(lease.cwd) || path.resolve(native.homeDirectory) !== path.resolve(lease.nativeHome))
    return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The original Muse native directory or Home changed."));
  const adoptBuffered = evidence.adoptBuffered;
  return { protocol: native.protocol,
    adoptLegacy: ({ source, ensure }) => lease.assertCurrent.pipe(Effect.andThen(evidence.readLegacy({
      nativeSessionId: source.sessionId, ...(source.turnId ? { turnId: source.turnId } : {}),
      ...(source.messageId ? { messageId: source.messageId } : {}), ensure,
    })), Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause), "session_mismatch", 409)))),
    ...(adoptBuffered ? { adoptBuffered: (input: Parameters<NonNullable<PmProviderProtocolProbe["adoptBuffered"]>>[0]) => lease.assertCurrent.pipe(
      Effect.andThen(adoptBuffered({ request: input.request, turn: input.turn, isCurrent: input.isCurrent })),
      Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause)))),
    ) } : {}),
  } satisfies PmProviderProtocolProbe;
});
export const museCapabilities: PmProviderCapabilitiesProjector = ({ lease }) => lease.assertCurrent.pipe(
  Effect.andThen(lease.instance.orchestrationAdapter.getCapabilities()),
  Effect.map(capabilities => ({
    nativeResume: capabilities.threads.exposesNativeThreadId && capabilities.threads.canReadThreadSnapshot,
    nativeFork: capabilities.threads.canForkThread,
    boundedFork: capabilities.threads.canForkThread && capabilities.threads.canForkFromTurn,
    modelTransition: capabilities.sessions.supportsModelSwitchInSession ? "native" as const : "portable" as const,
    portableHandoff: true as const,
  })), Effect.mapError(error => pmAdapterBoundaryError(error)),
);
export const museInstallationMethods: PmProviderInstallationMethods = {};
