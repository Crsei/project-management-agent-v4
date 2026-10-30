import path from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderRuntimeHost, type ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import { ProviderContinuationRequests } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { readAcpSessionEvidence } from "@t3tools/provider-acp/server/adapter";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import { makePmProviderPlatformLayer } from "../host-runtime.ts";
import { makePmProviderHostLayer, makePmProviderHostServices } from "../host.ts";
import { makePmProviderContinuationRequests, pmExecutionError, type PmProviderProtocolResolver, type PmProviderProtocolProbe } from "../continuation.ts";
import type { PmProviderCapabilitiesProjector } from "../management.ts";
import { pmAdapterBoundaryError } from "../events.ts";

/** Shared host composition only; the original ACP adapter owns the native lifecycle. */
export function makeAcpDriverLayer(context: ProviderDriverContext, runtimeHost: ProviderRuntimeHostService) {
  return Layer.mergeAll(
    makePmProviderHostLayer(context, makePmProviderHostServices(context, runtimeHost)),
    Layer.succeed(ProviderRuntimeHost, runtimeHost),
    Layer.effect(ProviderContinuationRequests, makePmProviderContinuationRequests(context, runtimeHost)),
    IdAllocator.layer,
    ProviderLatestVersions.layer,
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  ).pipe(Layer.provideMerge(makePmProviderPlatformLayer(context)));
}

export const acpProtocolResolver: PmProviderProtocolResolver = ({ lease, runtime }) => Effect.gen(function* () {
  yield* lease.assertCurrent;
  const evidence = readAcpSessionEvidence(runtime);
  if (!evidence || runtime.instanceId !== lease.instance.instanceId
    || evidence.cwd !== lease.cwd || path.resolve(evidence.homeDirectory) !== lease.nativeHome) {
    return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The original ACP connection did not confirm its protocol, native Home and directory."));
  }
  return {
    protocol: evidence.protocol,
    adoptLegacy: ({ source, ensure }) => lease.assertCurrent.pipe(
      Effect.andThen(evidence.readLegacy({ nativeSessionId: source.sessionId,
        ...(source.turnId ? { turnId: source.turnId } : {}), ...(source.messageId ? { messageId: source.messageId } : {}), ensure })),
      Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause), "session_mismatch", 409))),
    ),
    ...(evidence.adoptBuffered ? { adoptBuffered: (input: Parameters<NonNullable<PmProviderProtocolProbe["adoptBuffered"]>>[0]) => lease.assertCurrent.pipe(
      Effect.andThen(evidence.adoptBuffered!({ request: input.request, turn: input.turn, isCurrent: input.isCurrent })),
      Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause)))),
    ) } : {}),
  } satisfies PmProviderProtocolProbe;
});

export const acpCapabilities: PmProviderCapabilitiesProjector = ({ lease }) => lease.assertCurrent.pipe(
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
