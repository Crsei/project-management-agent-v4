import path from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Path as EffectPath } from "effect/Path";
import * as NodePath from "@effect/platform-node/NodePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CodexSettings } from "@t3tools/contracts";
import type { ProviderConfig, ProviderDriver } from "@agent-workspace/contracts/provider";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { resolveCodexHomeLayout } from "../../../../../../vendor/t3code/apps/server/src/provider/Drivers/CodexHomeLayout.ts";
import { resolveClaudeHomePath } from "../../../../../../vendor/t3code/apps/server/src/provider/Drivers/ClaudeHome.ts";
import { resolveOmpNativeHome } from "../../../../../../vendor/t3code/packages/provider-omp/src/server/launch.ts";
import { resolveAntigravityUserHome } from "../../../../../../vendor/t3code/apps/server/src/provider/Drivers/AntigravitySkills.ts";

/** Native layout uses the filtered execution environment, not an independent extension default. */
export function resolveProviderNativeHome(driver: ProviderDriver, config: ProviderConfig, env: NodeJS.ProcessEnv, cwd: string, userHome: string, managedHome: string): string {
  const resolve = <A>(effect: Effect.Effect<A, never, EffectPath>) => Effect.runSync(effect.pipe(
    Effect.provideService(HostProcess.HomeDirectory, userHome),
    Effect.provideService(HostProcess.Environment, env),
    Effect.provideService(HostProcess.WorkingDirectory, cwd),
    Effect.provide(NodePath.layer),
  ));
  if (driver === "codex") {
    if (config.setupMode === "managed") return managedHome;
    const layout = resolve(resolveCodexHomeLayout(Schema.decodeUnknownSync(CodexSettings)(config)));
    return layout.effectiveHomePath ?? layout.sharedHomePath;
  }
  if (driver === "claude") return resolve(resolveClaudeHomePath({ homePath: String(config.homePath ?? "") }, env));
  return path.resolve(cwd, userHome);
}

/** Shared native layout authority for runtime and explicitly confirmed extension bindings. */
export function resolveProviderNativeDirectories(context: ProviderDriverContext, userHome: string): { homeDirectory: string; agentDirectory?: string } {
  const homeDirectory = context.driver === "antigravity"
    ? path.resolve(context.cwd, resolveAntigravityUserHome(process.platform, context.env, userHome)) : userHome;
  return context.driver === "omp"
    ? { homeDirectory, agentDirectory: resolveOmpNativeHome({ environment: context.env, homeDirectory, cwd: context.cwd, exists: () => false }).agentDirectory }
    : { homeDirectory };
}
