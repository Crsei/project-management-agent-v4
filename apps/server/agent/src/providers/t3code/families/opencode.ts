import path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import { OpenCodeDriver } from "@t3tools/provider-opencode/server";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderRuntimeHost, type ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import { ProviderContinuationRequests } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import { makePmProviderPlatformLayer } from "../host-runtime.ts";
import { makePmProviderHostLayer, makePmProviderHostServices, makePmServerConfig } from "../host.ts";
import { makePmProviderContinuationRequests, pmExecutionError, type PmProviderProtocolResolver, type PmProviderProtocolProbe } from "../continuation.ts";
import type { PmProviderCapabilitiesProjector, PmProviderInstallationMethods } from "../management.ts";
import { pmAdapterBoundaryError } from "../events.ts";

/** The original driver owns both generations, schemas, catalog, auth, maintenance and usage. */
export const openCodeDriver = OpenCodeDriver;

/** Retained-context dependencies; operation authority comes from the application's shared host. */
export function makeOpenCodeDriverLayer(context: ProviderDriverContext, runtimeHost: ProviderRuntimeHostService) {
  const platform = makePmProviderPlatformLayer(context);
  const ledger = OpenCodeServerLedger.layer({ stateDir: makePmServerConfig(context).stateDir });
  return Layer.mergeAll(
    makePmProviderHostLayer(context, makePmProviderHostServices(context, runtimeHost)),
    Layer.succeed(ProviderRuntimeHost, runtimeHost),
    Layer.effect(ProviderContinuationRequests, makePmProviderContinuationRequests(context, runtimeHost)),
    IdAllocator.layer,
    ProviderLatestVersions.layer,
    // Optional raw event logs are deliberately disabled; sanitized Chat output remains persisted.
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
    OpenCodeRuntime.layer.pipe(Layer.provide(ledger)),
  ).pipe(Layer.provideMerge(platform));
}

export const openCodeProtocolResolver: PmProviderProtocolResolver = ({ context, lease, runtime }) => Effect.gen(function* () {
  yield* lease.assertCurrent;
  const evidence = OpenCodeRuntime.readOpenCodeSessionEvidence(runtime);
  if (!evidence || context.driver !== "opencode" || runtime.instanceId !== lease.instance.instanceId
    || evidence.cwd !== lease.cwd || path.resolve(lease.cwd, evidence.homeDirectory) !== lease.nativeHome) {
    return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The original OpenCode operation did not confirm its native protocol, Home and directory."));
  }
  const adoptBuffered = evidence.adoptBuffered;
  return {
    protocol: evidence.protocol,
    adoptLegacy: ({ source, ensure }) => lease.assertCurrent.pipe(
      Effect.andThen(evidence.readLegacy({ nativeSessionId: source.sessionId,
        ...(source.turnId ? { turnId: source.turnId } : {}), ...(source.messageId ? { messageId: source.messageId } : {}), ensure })),
      Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause), "session_mismatch", 409))),
    ),
    ...(adoptBuffered ? { adoptBuffered: (input: Parameters<NonNullable<PmProviderProtocolProbe["adoptBuffered"]>>[0]) => lease.assertCurrent.pipe(
      Effect.andThen(adoptBuffered({ request: input.request, turn: input.turn, isCurrent: input.isCurrent })),
      Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause)))),
    ) } : {}),
  } satisfies PmProviderProtocolProbe;
});

export const openCodeCapabilities: PmProviderCapabilitiesProjector = ({ lease }) => lease.assertCurrent.pipe(
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

/** Installation/removal remain external; original maintenance handles explicit in-generation updates. */
export const openCodeInstallationMethods: PmProviderInstallationMethods = {};
