import { createHash } from "node:crypto";
import path from "node:path";
import * as Layer from "effect/Layer";
import * as UpstreamAgentScope from "../../../../../../../vendor/t3code/apps/server/src/process/agentScope.ts";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import { makePmServerConfig } from "../host.ts";
import { makePmProviderProcessPlatformLayer } from "./process-platform.ts";
import { ServerConfig } from "./server-config.ts";

/** Native orphan cleanup must never share the t3 application's or another PM context's slice. */
export function pmProviderAgentScopeStateDirectory(context: ProviderDriverContext): string {
  const { baseDir, stateDir } = makePmServerConfig(context);
  const identity = createHash("sha256").update(JSON.stringify([
    path.resolve(baseDir), context.instanceId, context.driver, context.revision,
    path.resolve(context.cwd), path.resolve(context.homeDirectory), path.resolve(stateDir),
    Object.entries(context.env).filter(([key]) => key !== "CLAUDE_AGENT_SDK_VERSION")
      .sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(context.instanceEnvironment ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(context.config).sort(([a], [b]) => a.localeCompare(b)), context.customModels ?? [],
  ])).digest("hex");
  return path.join(stateDir, "process-scopes", identity);
}

/**
 * The original scoped service, real ProcessRunner and environment-bound Node spawner.
 * Linux without a working systemd user manager retains the source oom-score wrapper
 * but returns no unit; other platforms retain the source unavailable-scope behavior.
 * Native session finalizers, not arbitrary unit names, own descendant cleanup.
 */
export function makePmProviderAgentScopeLayer(context: ProviderDriverContext): Layer.Layer<never> {
  return UpstreamAgentScope.layer.pipe(
    Layer.provide(Layer.succeed(ServerConfig, {
      ...makePmServerConfig(context), stateDir: pmProviderAgentScopeStateDirectory(context),
    })),
    Layer.provide(makePmProviderProcessPlatformLayer(context)),
  );
}
