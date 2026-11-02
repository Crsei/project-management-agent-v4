// Native path/CLI contract: oh-my-pi e996e1c7ac476f60e02b8ed9764cf30fa8c00a8e
// packages/utils/src/dirs.ts, coding-agent/src/cli/{args,flag-tables}.ts and main.ts.
import { existsSync } from "node:fs";
import * as Path from "node:path";
import { homedir } from "node:os";
import { assertOmpStartupSafe } from "./startupPolicy.ts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export type OmpLaunchArgsResolution =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

const SAFE_BOOLEAN_ARGS: Readonly<Record<string, true>> = {
  "--no-skills": true, "--no-rules": true, "--no-context-files": true,
  "--no-lsp": true, "--no-pty": true, "--no-title": true,
};
const SAFE_NUMERIC_ARGS: Readonly<Record<string, true>> = {
  "--max-time": true, "--warn-cost": true, "--max-cost": true,
};

/** Unknown flags are rejected: extension flags can shadow built-ins and config can bypass policy. */
export function resolveOmpLaunchArgs(launchArgs: string | ReadonlyArray<string>): OmpLaunchArgsResolution {
  const tokens = typeof launchArgs === "string" ? tokenizeCliArgs(launchArgs) : launchArgs;
  const args: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const equals = token.indexOf("=");
    const flag = equals < 0 ? token : token.slice(0, equals);
    if (Object.hasOwn(SAFE_BOOLEAN_ARGS, flag) && equals < 0) {
      args.push(flag);
      continue;
    }
    if (Object.hasOwn(SAFE_NUMERIC_ARGS, flag)) {
      const value = equals < 0 ? tokens[++index] : token.slice(equals + 1);
      const numeric = value === undefined ? NaN : Number(value);
      if (value === undefined || !Number.isFinite(numeric) || numeric <= 0) {
        return { ok: false, message: `OMP argument '${flag}' requires a positive numeric value.` };
      }
      args.push(flag, value);
      continue;
    }
    return {
      ok: false,
      message: "OMP launch arguments may only contain --no-skills, --no-rules, --no-context-files, --no-lsp, --no-pty, --no-title, --max-time, --warn-cost or --max-cost. Protocol, model, permissions, tools, configuration, Home and session identity are host-owned.",
    };
  }
  return { ok: true, args };
}

export interface OmpNativeHome {
  readonly homeDirectory: string;
  readonly configRoot: string;
  readonly agentDirectory: string;
  readonly sessionsDirectory: string;
  readonly profile?: string;
}

/** Metadata-only projection; never reads dotenv, auth stores or credential files. */
export function resolveOmpNativeHome(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
}): OmpNativeHome {
  const env = input.environment;
  const cwd = input.cwd ?? process.cwd();
  const homeDirectory = Path.resolve(cwd, (input.platform ?? process.platform) === "win32"
    ? env.USERPROFILE || input.homeDirectory
    : env.HOME || input.homeDirectory);
  const rawProfile = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE;
  const normalized = rawProfile?.trim();
  const profile = !normalized || normalized === "default" ? undefined : normalized;
  if (profile !== undefined && (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) || profile === "." || profile === ".." ||
    profile.endsWith(".") || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(profile)
  )) throw new Error("Invalid OMP native profile");
  const baseRoot = Path.join(homeDirectory, env.PI_CONFIG_DIR || ".omp");
  const configRoot = profile === undefined ? baseRoot : Path.join(baseRoot, "profiles", profile);
  const defaultAgent = Path.join(configRoot, "agent");
  // A PI_PROFILE-derived override inherited from a parent must not become the default agent directory.
  const inheritedProfileDir = env.PI_PROFILE && env.PI_PROFILE.trim() !== "default"
    ? Path.join(baseRoot, "profiles", env.PI_PROFILE.trim(), "agent") : undefined;
  const override = profile !== undefined || env.PI_CODING_AGENT_DIR === inheritedProfileDir
    ? undefined : env.PI_CODING_AGENT_DIR;
  const agentDirectory = override ? Path.resolve(cwd, override) : defaultAgent;
  let dataDirectory = agentDirectory;
  const platform = input.platform ?? process.platform;
  if ((platform === "linux" || platform === "darwin") && agentDirectory === defaultAgent && env.XDG_DATA_HOME) {
    const candidate = profile === undefined
      ? Path.resolve(cwd, env.XDG_DATA_HOME, "omp")
      : Path.resolve(cwd, env.XDG_DATA_HOME, "omp", "profiles", profile);
    if ((input.exists ?? existsSync)(candidate)) dataDirectory = candidate;
  }
  return {
    homeDirectory,
    configRoot,
    agentDirectory,
    sessionsDirectory: env.PI_CODING_AGENT_SESSION_DIR
      ? Path.resolve(cwd, env.PI_CODING_AGENT_SESSION_DIR)
      : Path.join(dataDirectory, "sessions"),
    ...(profile === undefined ? {} : { profile }),
  };
}

/** All callers, including discovery and tool-free auxiliary generation, share this launch boundary. */
export function buildOmpRpcLaunch(input: {
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly homeDirectory?: string;
  readonly extensionPath?: string;
  readonly permissionEnvironment?: NodeJS.ProcessEnv;
  readonly sessionPath?: string;
  readonly sessionDirectory?: string;
  readonly ephemeral?: boolean;
  readonly disableTools?: boolean;
  readonly disableExtensions?: boolean;
}): { readonly args: string[]; readonly env: NodeJS.ProcessEnv } {
  const validated = resolveOmpLaunchArgs(input.launchArgs);
  if (!validated.ok) throw new Error(validated.message);
  if (input.sessionPath !== undefined && input.ephemeral) throw new Error("Cannot resume an ephemeral OMP session");
  if (input.disableTools !== true && input.extensionPath === undefined) {
    throw new Error("OMP native tools require the host permission extension");
  }
  if (input.disableExtensions && input.extensionPath !== undefined) {
    throw new Error("Cannot disable the required OMP permission extension");
  }
  const env: NodeJS.ProcessEnv = { ...input.environment };
  for (const key of Object.keys(env)) {
    if (/^(?:AGENT_OMP_|T3_OMP_|AGENT_PM_TOOL_|T3_MCP_)/i.test(key)) delete env[key];
  }
  for (const [key, value] of Object.entries(input.permissionEnvironment ?? {})) {
    if (!/^AGENT_OMP_[A-Z0-9_]+$/.test(key) || value?.includes("\0")) {
      throw new Error("Invalid OMP host permission environment");
    }
    env[key] = value;
  }
  const cwd = Path.resolve(input.cwd ?? process.cwd());
  const homeDirectory = input.homeDirectory || homedir();
  const nativeHome = resolveOmpNativeHome({ environment: env, homeDirectory, cwd });
  assertOmpStartupSafe({ environment: env, homeDirectory: nativeHome.homeDirectory, cwd, nativeHome });
  const args = ["--mode", "rpc-ui", "--approval-mode", "always-ask", ...validated.args];
  // An exact native trust allowlist also disables ambient hooks/configured extensions.
  if (input.extensionPath !== undefined) {
    if (!Path.isAbsolute(input.extensionPath) || input.extensionPath.includes("\0")) throw new Error("OMP host extension path must be absolute");
    args.push("--trusted-extension", input.extensionPath);
  } else args.push("--no-extensions");
  if (input.disableTools) args.push("--no-tools");
  if (input.ephemeral) args.push("--no-session");
  if (input.sessionDirectory !== undefined) {
    if (!Path.isAbsolute(input.sessionDirectory) || input.sessionDirectory.includes("\0")) throw new Error("OMP session directory must be absolute");
    args.push("--session-dir", input.sessionDirectory);
  }
  if (input.sessionPath !== undefined) {
    if (!Path.isAbsolute(input.sessionPath) || input.sessionPath.includes("\0")) throw new Error("OMP session path must be absolute");
    args.push("--session", input.sessionPath);
  }
  // No --model: native discovery may still be in flight before ready. Select through RPC afterwards.
  return { args, env };
}
