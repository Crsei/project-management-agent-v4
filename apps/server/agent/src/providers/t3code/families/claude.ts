import path from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderRuntimeHost, type ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import { ProviderContinuationRequests } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { ClaudeDriver } from "../../../../../../../vendor/t3code/apps/server/src/provider/Drivers/ClaudeDriver.ts";
import { ClaudeAgentSdkQueryRunner, layerQueryRunner, readClaudeSessionEvidence, type ClaudeAgentSdkQueryOpenInput, type ClaudeAgentSdkQueryRunnerShape } from "../../../../../../../vendor/t3code/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ModelManifest from "../../../../../../../vendor/t3code/apps/server/src/provider/ModelManifest.ts";
import { makePmResetCreditCoordinatorLayer } from "../upstream-services/reset-credit-coordinator.ts";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import { makePmProviderPlatformLayer } from "../host-runtime.ts";
import { makePmProviderHostLayer, makePmProviderHostServices, makePmProviderUpstreamServicesLayer } from "../host.ts";
import { makePmProviderContinuationRequests, pmExecutionError, type PmProviderProtocolProbe, type PmProviderProtocolResolver } from "../continuation.ts";
import type { PmProviderCapabilitiesProjector } from "../management.ts";
import { pmAdapterBoundaryError } from "../events.ts";
import * as AgentLifecycle from "../upstream-services/port-discovery.ts";
import { ProviderInstanceId } from "@t3tools/contracts";

export const claudeDriver = ClaudeDriver;
/** The original SDK/adapter still owns execution. Only a server-issued analysis binding removes tools. */
export function restrictPmAnalysisQueries(original: ClaudeAgentSdkQueryRunnerShape, runtimeHost: ProviderRuntimeHostService, instanceId: Parameters<ProviderRuntimeHostService['read']>[0]['providerInstanceId']): ClaudeAgentSdkQueryRunnerShape {
  return ClaudeAgentSdkQueryRunner.of({
    ...original,
    open: (input: ClaudeAgentSdkQueryOpenInput) => Effect.gen(function* () {
      const binding = yield* runtimeHost.read({ threadId: input.threadId, providerInstanceId: instanceId });
      if (binding?.promptAuthorization !== 'technical-no-tools') return yield* original.open(input);
      if (binding.mcpServers.length || binding.cwd !== input.options.cwd) throw new Error('Read-only analysis cannot inherit tools or another working directory.');
      // SDK tool removal is authoritative. A callback denial is defense in depth,
      // not a prompt promise; no connector descriptors or native hooks survive.
      const { hooks: _hooks, extraArgs: _extraArgs, ...options } = input.options;
      return yield* original.open({ ...input, options: {
        ...options, tools: [], allowedTools: [], disallowedTools: ['*'], mcpServers: {},
        settingSources: [], plugins: [], strictMcpConfig: true,
        settings: { disableAllHooks: true },
        canUseTool: async () => ({ behavior: 'deny' as const, message: 'PM automation analysis has no tool authority.' }),
      } });
    }),
  });
}

/** Original SDK, native Home/Skills/catalog/maintenance/usage, closed over this operation's host. */
export function makeClaudeDriverLayer(context: ProviderDriverContext, runtimeHost: ProviderRuntimeHostService) {
  const platform = makePmProviderPlatformLayer(context);
  const host = makePmProviderUpstreamServicesLayer(context);
  const logging = Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers);
  const originalQueryRunner = layerQueryRunner.pipe(Layer.provide(Layer.mergeAll(platform, logging, AgentLifecycle.layer)));
  const queryRunner = Layer.effect(ClaudeAgentSdkQueryRunner, Effect.gen(function* () {
    const original = yield* ClaudeAgentSdkQueryRunner;
    return restrictPmAnalysisQueries(original, runtimeHost, ProviderInstanceId.make(context.instanceId));
  })).pipe(Layer.provide(originalQueryRunner));
  const catalog = ModelManifest.layerModelCatalog.pipe(Layer.provide(ModelManifest.layer.pipe(Layer.provide(Layer.mergeAll(platform, host)))));
  return Layer.mergeAll(
    makePmProviderHostLayer(context, makePmProviderHostServices(context, runtimeHost)), host,
    Layer.succeed(ProviderRuntimeHost, runtimeHost),
    Layer.effect(ProviderContinuationRequests, makePmProviderContinuationRequests(context, runtimeHost)),
    IdAllocator.layer, ProviderLatestVersions.layer, logging, queryRunner, catalog,
    makePmResetCreditCoordinatorLayer(runtimeHost),
  ).pipe(Layer.provideMerge(platform));
}

export const claudeProtocolResolver: PmProviderProtocolResolver = ({ context, lease, runtime }) => Effect.gen(function* () {
  yield* lease.assertCurrent;
  const evidence = readClaudeSessionEvidence(runtime);
  if (!evidence || context.driver !== "claude" || runtime.instanceId !== lease.instance.instanceId
    || path.resolve(evidence.homeDirectory) !== path.resolve(lease.nativeHome)) {
    return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The original Claude operation did not confirm its native Home and instance."));
  }
  const protocol = yield* evidence.negotiate.pipe(Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause)))));
  yield* lease.assertCurrent;
  return { protocol, adoptLegacy: ({ source, ensure }) => lease.assertCurrent.pipe(
    Effect.andThen(evidence.readLegacy(source, ensure)),
    Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause), "session_mismatch", 409))),
  ), adoptBuffered: (input) => lease.assertCurrent.pipe(
    Effect.andThen(evidence.adoptBuffered({ request: input.request, turn: input.turn, isCurrent: input.isCurrent })),
    Effect.catchCause(cause => Effect.fail(pmAdapterBoundaryError(Cause.squash(cause)))),
  ) } satisfies PmProviderProtocolProbe;
});

export const claudeCapabilities: PmProviderCapabilitiesProjector = ({ lease }) => lease.assertCurrent.pipe(
  Effect.andThen(lease.instance.orchestrationAdapter.getCapabilities()),
  Effect.map(capabilities => ({ nativeResume: capabilities.threads.exposesNativeThreadId,
    nativeFork: capabilities.threads.canForkThread,
    boundedFork: capabilities.threads.canForkThread && capabilities.threads.canForkFromTurn,
    modelTransition: capabilities.sessions.supportsModelSwitchInSession ? "native" as const : "portable" as const,
    portableHandoff: true as const })),
  Effect.mapError(error => pmAdapterBoundaryError(error)),
);
