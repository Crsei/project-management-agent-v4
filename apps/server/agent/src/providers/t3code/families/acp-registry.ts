import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AcpRegistryDriver } from "@t3tools/provider-acp-registry/server";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as Registry from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import type { ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import type { PmProviderInstallationMethods } from "../management.ts";
import { acpCapabilities, acpProtocolResolver, makeAcpDriverLayer } from "./acp.ts";
import { makePmProviderPlatformLayer } from "../host-runtime.ts";
import { makePmProviderHostLayer, makePmProviderHostServices } from "../host.ts";
import { makePmProviderRuntimeHost } from "../runtime-host.ts";

export const acpRegistryDriver = AcpRegistryDriver;
export function makeAcpRegistryDriverLayer(context: ProviderDriverContext, runtimeHost: ProviderRuntimeHostService) {
  return Registry.layerFromHost.pipe(Layer.provideMerge(makeAcpDriverLayer(context, runtimeHost)));
}
export const acpRegistryProtocolResolver = acpProtocolResolver;
export const acpRegistryCapabilities = acpCapabilities;

/** Management invokes this under the existing PM maintenance/revision exclusion. */
export function makeAcpRegistryCatalogLayer(context: ProviderDriverContext) {
  // Catalog-only management has no execution binding and cannot authorize native work or tools.
  const runtimeHost = makePmProviderRuntimeHost();
  return Registry.layerFromHost.pipe(Layer.provideMerge(
    makePmProviderHostLayer(context, makePmProviderHostServices(context, runtimeHost)).pipe(
      Layer.provideMerge(makePmProviderPlatformLayer(context)),
    ),
  ));
}
export const acpRegistryInstallationMethods: PmProviderInstallationMethods = {
  prepare: (context, signal, onProgress, lease) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    if (lease) yield* lease.assertCurrent;
    const settings = Schema.decodeUnknownSync(AcpRegistrySettings)(context.config);
    const catalog = yield* Registry.AcpRegistryCatalog;
    if (settings.source === "local") {
      const resolved = yield* catalog.resolve(settings, context.cwd, context.env);
      return { message: "Local ACP executable resolved; authentication and native execution have not been verified.",
        agentId: resolved.agent?.id ?? "", version: resolved.agent?.version ?? null, distribution: "local", commandPath: resolved.spawn.command };
    }
    onProgress?.({ message: `Preparing ACP Registry agent ${settings.agentId}.` });
    const prepared = yield* catalog.prepare({ agentId: settings.agentId });
    const resolved = yield* catalog.resolve(settings, context.cwd, context.env);
    if (lease) yield* lease.assertCurrent;
    return { ...prepared, commandPath: resolved.spawn.command,
      message: `${prepared.agentId} ${prepared.version} prepared (${prepared.distribution}); authentication and inference remain separate checks.` };
  })).pipe(Effect.provide(makeAcpRegistryCatalogLayer(context))), { signal }),
};
