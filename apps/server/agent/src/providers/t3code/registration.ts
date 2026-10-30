import { ProviderInstanceId, type ProviderDriverKind, type ProviderInstanceConfig } from "@t3tools/contracts";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { makeProviderInstanceRegistry } from "../../../../../../vendor/t3code/apps/server/src/provider/ProviderInstanceRegistry.ts";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import type { PmProviderBoundaryError } from "./contract.ts";
import { decodeProviderConfig } from "./config-mapping.ts";
import { makePmNativeUsageReader, type PmNativeUsageReader } from "./native-usage.ts";

export interface PmProviderFamilyRuntime {
  readonly instance?: ProviderInstance;
  readonly usage?: PmNativeUsageReader;
}

/** Closes each driver's own service requirements without claiming unrelated families' services. */
export interface PmProviderFamily {
  readonly driverKind: ProviderDriverKind;
  readonly build: (
    context: ProviderDriverContext,
    config: ProviderInstanceConfig,
    runtimeHost: ProviderRuntimeHostService,
    scope: Scope.Scope,
  ) => Effect.Effect<PmProviderFamilyRuntime, unknown>;
}

export function makePmProviderFamily<R, UsageR>(
  driver: AnyProviderDriver<R, UsageR>,
  driverLayer: (context: ProviderDriverContext, runtimeHost: ProviderRuntimeHostService) => Layer.Layer<R | UsageR, PmProviderBoundaryError>,
): PmProviderFamily {
  return {
    driverKind: driver.driverKind,
    build: (context, config, runtimeHost, scope) => Effect.gen(function* () {
      const services = yield* Layer.buildWithScope(driverLayer(context, runtimeHost), scope);
      const decoded = yield* decodeProviderConfig(driver, config);
      let instance: ProviderInstance | undefined;
      if (config.enabled !== false) {
        const source = yield* makeProviderInstanceRegistry({
          drivers: [driver], configMap: { [context.instanceId]: config },
        }).pipe(Effect.provideContext(services), Effect.provideService(Scope.Scope, scope));
        instance = yield* source.registry.getInstance(ProviderInstanceId.make(context.instanceId));
      }
      const usage = makePmNativeUsageReader(driver.usage, {
        instanceId: ProviderInstanceId.make(context.instanceId),
        config: decoded, environment: context.env, configured: true,
      }, services);
      return { ...(instance ? { instance } : {}), ...(usage ? { usage } : {}) };
    }),
  };
}
