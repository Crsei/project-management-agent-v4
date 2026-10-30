import path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import { CursorDriver } from "@t3tools/provider-cursor/server";
import { readCursorSessionEvidence } from "../../../../../../../vendor/t3code/packages/provider-cursor/src/server/sessionEvidence.ts";
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
import * as CursorSdk from "@t3tools/provider-cursor/server/CursorSdk";
import { CursorAgentSdkRunner } from "@t3tools/provider-cursor/server/CursorAgentSdk";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import { makeCursorSdkWorkerRunner } from "../../../../../../../vendor/t3code/packages/provider-cursor/src/server/CursorSdkWorkerRunner.ts";
import * as CursorUsageAccounts from "../../../../../../../vendor/t3code/packages/provider-cursor/src/server/CursorUsageAccounts.ts";
import * as CursorAccountReader from "../../../../../../../vendor/t3code/packages/provider-cursor/src/server/CursorAccountReader.ts";
import { CursorHostPaths } from "../../../../../../../vendor/t3code/packages/provider-cursor/src/server/CursorHostPaths.ts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { pmUsageBinding } from "../native-usage.ts";

export const cursorDriver = CursorDriver;
export function makeCursorDriverLayer(context: ProviderDriverContext, runtimeHost: ProviderRuntimeHostService) {
  const base = Layer.mergeAll(
    makePmProviderHostLayer(context, makePmProviderHostServices(context, runtimeHost)),
    Layer.succeed(ProviderRuntimeHost, runtimeHost),
    Layer.effect(ProviderContinuationRequests, makePmProviderContinuationRequests(context, runtimeHost)),
    IdAllocator.layer, ProviderLatestVersions.layer,
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
    CursorSdk.layer, CursorKeychain.layer,
    Layer.succeed(CursorHostPaths, { legacyCredentialsFile: path.join(context.stateDirectory, ".cursor", "sdk", "auth.json") }),
    Layer.effect(CursorAgentSdkRunner, Effect.gen(function* () {
      return makeCursorSdkWorkerRunner(context.env, path.join(context.stateDirectory, ".cursor", "sdk", "state"), runtimeHost, yield* AgentScope);
    })),
  ).pipe(Layer.provideMerge(makePmProviderPlatformLayer(context)));
  const accounts = CursorAccountReader.layer.pipe(Layer.provideMerge(base));
  // Original account cache keys are credential locations. Keep revisions/environments
  // separate on disk as well as in the retained in-memory source service.
  const usageHost = Layer.effect(ProviderHost.ProviderHost, Effect.gen(function* () {
    const host = yield* ProviderHost.ProviderHost;
    return { ...host, paths: { ...host.paths, stateDir: path.join(host.paths.stateDir, "usage", pmUsageBinding(context)) } };
  })).pipe(Layer.provide(accounts));
  return CursorUsageAccounts.layer.pipe(Layer.provide(usageHost), Layer.provideMerge(accounts));
}
export const cursorProtocolResolver: PmProviderProtocolResolver = ({ context, lease, runtime }) => Effect.gen(function* () {
  yield* lease.assertCurrent;
  const evidence = readCursorSessionEvidence(runtime);
  if (!evidence || context.driver !== "cursor" || runtime.instanceId !== lease.instance.instanceId)
    return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The original Cursor operation has no native protocol evidence."));
  const native = yield* evidence.probe.pipe(Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause), "session_mismatch", 409))));
  if (path.resolve(native.cwd) !== path.resolve(lease.cwd) || path.resolve(native.homeDirectory) !== path.resolve(lease.nativeHome))
    return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The original Cursor native directory or Home changed."));
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
export const cursorCapabilities: PmProviderCapabilitiesProjector = ({ lease }) => lease.assertCurrent.pipe(
  Effect.andThen(lease.instance.orchestrationAdapter.getCapabilities()),
  Effect.map(capabilities => ({
    nativeResume: capabilities.threads.exposesNativeThreadId && capabilities.threads.canReadThreadSnapshot,
    nativeFork: capabilities.threads.canForkThread,
    boundedFork: capabilities.threads.canForkThread && capabilities.threads.canForkFromTurn,
    modelTransition: capabilities.sessions.supportsModelSwitchInSession ? "native" as const : "portable" as const,
    portableHandoff: true as const,
  })), Effect.mapError(error => pmAdapterBoundaryError(error)),
);
export const cursorInstallationMethods: PmProviderInstallationMethods = {};
