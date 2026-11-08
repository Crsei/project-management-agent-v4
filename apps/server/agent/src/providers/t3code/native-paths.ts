import path from "node:path";
import { realpath, stat } from "node:fs/promises";
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

/**
 * Native handshakes may canonicalize a Windows Home to a long/UNC path, its
 * on-disk casing, or a junction target. Do not lowercase paths: Windows also
 * supports case-sensitive directories. Different spellings need filesystem
 * proof that they refer to the same directory, never a guessed string alias.
 */
export async function confirmsProviderNativeHome(reported: string, expected: string): Promise<boolean> {
  if (!path.isAbsolute(reported) || !path.isAbsolute(expected)) return false;
  if (path.resolve(reported) === path.resolve(expected)) return true;
  try {
    const [actual, configured] = await Promise.all([realpath(reported), realpath(expected)]);
    const [actualIdentity, configuredIdentity] = await Promise.all([
      stat(actual, { bigint: true }), stat(configured, { bigint: true }),
    ]);
    return actualIdentity.isDirectory() && configuredIdentity.isDirectory()
      && (actual === configured || (actualIdentity.ino !== 0n && configuredIdentity.ino !== 0n
        && actualIdentity.dev === configuredIdentity.dev && actualIdentity.ino === configuredIdentity.ino));
  } catch {
    // Unavailable or unprovable aliases cannot authorize a native operation.
    return false;
  }
}

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
