import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { defaultProviderContinuationIdentity, type ProviderDriver, type ProviderInstance } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { haveProviderSnapshotSettingsChanged, makeProviderSnapshotSettingsSource } from "@t3tools/provider-core/server/snapshotSettings";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { OmpSettings } from "../settings.ts";
import { OmpAdapterV2Driver, type OmpAdapterV2DriverEnv } from "./adapter.ts";
import { buildInitialOmpProviderSnapshot, checkOmpProviderStatus, discoverOmpCommandsForCwd } from "./status.ts";
import { makeOmpTextGeneration } from "./textGeneration.ts";

const DRIVER_KIND = ProviderDriverKind.make("omp");
const decodeSettings = Schema.decodeSync(OmpSettings);
export type OmpDriverEnv = OmpAdapterV2DriverEnv | ProviderHost.ProviderHost | ChildProcessSpawner.ChildProcessSpawner;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Oh My Pi", supportsMultipleInstances: true },
  configSchema: OmpSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("OmpDriver.create")(function* (input) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const host = yield* ProviderHost.ProviderHost;
    const environment = yield* mergeProviderInstanceEnvironment(input.environment);
    const config = { ...input.config, enabled: input.enabled } satisfies OmpSettings;
    const continuationIdentity = defaultProviderContinuationIdentity({ driverKind: DRIVER_KIND, instanceId: input.instanceId });
    const stamp = (snapshot: ServerProviderDraft): ServerProvider => ({
      ...snapshot,
      instanceId: input.instanceId,
      driver: DRIVER_KIND,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      continuation: { groupKey: continuationIdentity.continuationKey },
    });
    const orchestrationAdapter = yield* OmpAdapterV2Driver.create(input).pipe(
      Effect.mapError((cause) => new ProviderDriverError({ driver: DRIVER_KIND, instanceId: input.instanceId, detail: "Failed to create OMP orchestration adapter.", cause })),
    );
    const textGeneration = yield* makeOmpTextGeneration(config, environment);
    const source = yield* makeProviderSnapshotSettingsSource(config);
    const snapshot = yield* makeManagedServerProvider({
      // External CLI lifecycle only. No package manager, automatic updater or login side effects.
      resolveMaintenance: () => Effect.succeed({ provider: DRIVER_KIND, packageName: null, update: null }),
      getSettings: source.getSettings,
      streamSettings: source.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) => buildInitialOmpProviderSnapshot(settings.provider).pipe(Effect.map(stamp)),
      checkProvider: checkOmpProviderStatus(config, environment, host.paths.cwd).pipe(
        Effect.map(stamp), Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    }).pipe(Effect.mapError((cause) => new ProviderDriverError({ driver: DRIVER_KIND, instanceId: input.instanceId, detail: "Failed to create OMP snapshot.", cause })));
    return {
      instanceId: input.instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName: input.displayName,
      accentColor: input.accentColor,
      enabled: input.enabled,
      snapshot,
      snapshotForCwd: (cwd) => !config.enabled ? snapshot.getSnapshot : Effect.all([
        snapshot.getSnapshot,
        discoverOmpCommandsForCwd(config, environment, cwd).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((cause) => new ProviderDriverError({ driver: DRIVER_KIND, instanceId: input.instanceId, detail: "Failed to discover OMP workspace commands.", cause })),
        ),
      ]).pipe(Effect.map(([current, commands]) => ({ ...current, ...commands, slashCommandsPending: false }))),
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
