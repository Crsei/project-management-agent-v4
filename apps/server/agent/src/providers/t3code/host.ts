import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { ProviderInstanceId, ServerSettingsError, ThreadId, type ServerSettings } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { acquireProviderSettingsSnapshot, providerDataDirectory, subscribeProviderSettingsChanges } from "../instances.ts";
import { projectProviderSettings, providerBoundaryError } from "./config-mapping.ts";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { getProviderSettings, getStoredInstance } from "../instances.ts";
import { isProviderAccountBusy } from "../auth.ts";
import { makePmProviderCredentials, makePmServerSecretStore, layerIdentity } from "./credentials.ts";
import { ServerConfig } from "./upstream-services/server-config.ts";
import { resolveAttachmentPath } from "./upstream-services/attachments.ts";
import { resolveExtractedTextPath } from "./upstream-services/document-text.ts";
import { ServerSettingsService } from "./upstream-services/server-settings.ts";
import { ServerSecretStore } from "./upstream-services/server-secret-store.ts";
import { makePmCodexUsageHistoryLayer } from "./upstream-services/usage-history.ts";

export function makePmProviderHostServices(context: ProviderDriverContext, runtimeHost: ProviderRuntimeHostService): Omit<ProviderHost["Service"], "paths"> {
  const settings = makePmServerSettings();
  const paths = makePmServerConfig(context);
  return {
    settings: { get: settings.getSettings, withSnapshot: settings.withSettingsSnapshot,
      changes: settings.streamChanges, subscribe: settings.subscribeChanges },
    shouldRunBackgroundWork: scope => Effect.suspend(() => {
      const current = getStoredInstance(context.instanceId);
      if (!current?.enabled || current.revision !== context.revision || isProviderAccountBusy(context.instanceId)) return Effect.succeed(false);
      if (scope.type === "provider-status") return Effect.succeed((!scope.instanceId || scope.instanceId === context.instanceId)
        && getProviderSettings().healthRefreshIntervalSeconds > 0);
      if (scope.type !== "thread") return Effect.succeed(false);
      return runtimeHost.read({ providerInstanceId: ProviderInstanceId.make(context.instanceId), threadId: ThreadId.make(scope.threadId) }).pipe(
        Effect.flatMap(binding => binding
          ? runtimeHost.authorize({ providerInstanceId: binding.providerInstanceId, threadId: binding.threadId,
            executionId: binding.executionId, action: "compaction" }).pipe(Effect.as(true))
          : Effect.succeed(false)),
        Effect.catchCause(() => Effect.succeed(false)),
      );
    }),
    resolveAttachmentPath: attachment => resolveAttachmentPath({ attachmentsDir: paths.attachmentsDir, attachment }),
    resolveExtractedTextPath,
    credentials: makePmProviderCredentials(),
  };
}
export function makePmProviderHostLayer(context: ProviderDriverContext, services: Omit<ProviderHost["Service"], "paths">): Layer.Layer<ProviderHost> {
  const { cwd, baseDir, stateDir, providerStatusCacheDir, attachmentsDir } = makePmServerConfig(context);
  return Layer.succeed(ProviderHost, { paths: { cwd, baseDir, stateDir, providerStatusCacheDir, attachmentsDir }, ...services });
}

/** Concrete upstream application dependencies, without SQL, SourceControl or the t3 server. */
export function makePmProviderUpstreamServicesLayer(context: ProviderDriverContext) {
  return Layer.mergeAll(makePmServerConfigLayer(context),
    Layer.succeed(ServerSettingsService, makePmServerSettings()),
    Layer.succeed(ServerSecretStore, makePmServerSecretStore()),
    makePmCodexUsageHistoryLayer(context.instanceId),
    layerIdentity);
}
export function makePmServerConfig(context: ProviderDriverContext): ServerConfig["Service"] {
  const root = providerDataDirectory();
  return {
    cwd: context.cwd, baseDir: root, stateDir: path.join(context.stateDirectory, "t3code"),
    providerStatusCacheDir: path.join(root, "provider-cache", "t3code"),
    attachmentsDir: path.join(root, "provider-attachments"),
    secretsDir: path.join(root, "provider-private", "secrets"),
    environmentIdPath: path.join(root, "provider-private", "environment-id"),
  };
}
export function makePmServerConfigLayer(context: ProviderDriverContext) {
  return Layer.effect(ServerConfig, Effect.tryPromise({
    try: async () => {
      const config = makePmServerConfig(context);
      await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
      return config;
    },
    catch: () => providerBoundaryError("Unable to initialize Provider state directory.", "provider_state_unavailable", 500),
  }));
}
export function makePmServerSettings(): ServerSettingsService["Service"] {
  const settingsPath = providerDataDirectory() + "/provider-instances.json";
  const failure = (cause: unknown) => new ServerSettingsError({ settingsPath, operation: "read-file", cause });
  const getSettings = Effect.try({ try: projectProviderSettings, catch: failure });
  const subscribeChanges = Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(Queue.unbounded<ServerSettings>(), Queue.shutdown);
    yield* Effect.acquireRelease(Effect.sync(() => subscribeProviderSettingsChanges(() => {
      // A failed read never publishes an empty or partially decoded instance map.
      try { Queue.offerUnsafe(queue, projectProviderSettings()); } catch { /* retain the last valid snapshot */ }
    })), unsubscribe => Effect.sync(unsubscribe));
    return Stream.fromQueue(queue);
  });
  return {
    getSettings,
    withSettingsSnapshot: use => Effect.acquireUseRelease(
      Effect.try({ try: () => acquireProviderSettingsSnapshot(projectProviderSettings), catch: failure }),
      snapshot => use(snapshot.value),
      snapshot => Effect.sync(snapshot.release),
    ),
    streamChanges: Stream.unwrap(subscribeChanges),
    subscribeChanges,
  };
}
