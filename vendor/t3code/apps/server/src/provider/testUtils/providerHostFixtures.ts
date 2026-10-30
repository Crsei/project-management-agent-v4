import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../../../../../../apps/server/agent/src/providers/t3code/upstream-services/server-config.ts";
import { ServerSettingsService } from "../../../../../../../apps/server/agent/src/providers/t3code/upstream-services/server-settings.ts";

/** Provider-only test resources; never the t3 app's config, SQL settings or SourceControl layers. */
export const makeTestServerConfigLayer = (cwd: string, options: { prefix: string }) =>
  Layer.effect(ServerConfig, Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: options.prefix });
    const stateDir = path.join(baseDir, "state");
    const attachmentsDir = path.join(baseDir, "attachments");
    yield* fs.makeDirectory(stateDir, { recursive: true });
    yield* fs.makeDirectory(attachmentsDir, { recursive: true });
    return { cwd, baseDir, stateDir, attachmentsDir,
      providerStatusCacheDir: path.join(baseDir, "provider-cache"),
      secretsDir: path.join(baseDir, "secrets"), environmentIdPath: path.join(baseDir, "environment-id") };
  }));
export const makeTestServerSettingsLayer = (overrides: Partial<ServerSettings> = {}) => {
  const snapshot = { ...DEFAULT_SERVER_SETTINGS, ...overrides };
  return Layer.succeed(ServerSettingsService, {
    getSettings: Effect.succeed(snapshot),
    withSettingsSnapshot: use => use(snapshot),
    streamChanges: Stream.never,
    subscribeChanges: Effect.succeed(Stream.never),
  });
};
