// Pinned stock CLI boundary: oh-my-pi e996e1c7ac476f60e02b8ed9764cf30fa8c00a8e.
// See discovery/{index,helpers,builtin,claude,codex,gemini,opencode,cursor,windsurf,vscode,mcp-json}.ts,
// extensibility/custom-tools/loader.ts, utils/env.ts and utils/dirs.ts.
import * as Fs from "node:fs";
import * as Path from "node:path";
import type { OmpNativeHome } from "./launch.ts";
import { assertOmpPluginStartupSafe, ompPluginStartupRoots } from "./startupPlugins.ts";

export class OmpStartupPolicyError extends Error {
  readonly unsafePath: string;
  readonly reason: string;

  constructor(unsafePath: string, reason: string) {
    super(`OMP startup refused: ${reason} (${unsafePath}). Stock OMP 18.13.2 cannot disable all ambient MCP/custom-tool startup. Select a native environment without this source; a disabled entry inside an uninspected file cannot be verified. The host does not read or rewrite its contents, copy credentials, or start these services.`);
    this.name = "OmpStartupPolicyError";
    this.unsafePath = unsafePath;
    this.reason = reason;
  }
}

/** Candidate source paths, not their content. Shared by the preflight and behavioral boundary tests. */
export function ompStartupSourcePaths(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly nativeHome: OmpNativeHome;
}): { readonly files: ReadonlySet<string>; readonly directories: ReadonlySet<string> } {
  const files = new Set<string>();
  const directories = new Set<string>();
  const cwd = Path.resolve(input.cwd);
  const home = Path.resolve(input.homeDirectory);
  const claudeOverride = input.environment.CLAUDE_CONFIG_DIR?.trim();
  const claudeRoot = claudeOverride ? Path.resolve(cwd, claudeOverride) : Path.join(home, ".claude");
  // Explicit per-loader roots. In particular, vscode and standalone MCP are cwd-only;
  // settings.json is an MCP input only for Gemini, not a generic discovery filename.
  const fileSources: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    [cwd, ["mcp.json", ".mcp.json", "opencode.json", "opencode.jsonc"]],
    [Path.join(cwd, ".omp"), ["mcp.json", ".mcp.json"]],
    [input.nativeHome.agentDirectory, ["mcp.json", ".mcp.json"]],
    [Path.join(cwd, ".claude"), ["mcp.json", ".mcp.json"]],
    [claudeRoot, ["mcp.json"]],
    [Path.join(cwd, ".codex"), ["config.toml"]],
    [Path.join(home, ".codex"), ["config.toml"]],
    [Path.join(cwd, ".gemini"), ["settings.json"]],
    [Path.join(home, ".gemini"), ["settings.json"]],
    [Path.join(cwd, ".cursor"), ["mcp.json"]],
    [Path.join(home, ".cursor"), ["mcp.json"]],
    [Path.join(cwd, ".windsurf"), ["mcp_config.json"]],
    [Path.join(home, ".codeium", "windsurf"), ["mcp_config.json"]],
    [Path.join(cwd, ".opencode"), ["opencode.json", "opencode.jsonc"]],
    [Path.join(home, ".config", "opencode"), ["opencode.json", "opencode.jsonc"]],
    [Path.join(cwd, ".vscode"), ["mcp.json"]],
  ];
  for (const [root, names] of fileSources) {
    for (const name of names) files.add(Path.join(root, name));
  }
  files.add(claudeOverride ? Path.join(claudeRoot, ".claude.json") : Path.join(home, ".claude.json"));
  for (const root of [
    input.nativeHome.agentDirectory,
    Path.join(cwd, ".claude"), claudeRoot,
    Path.join(cwd, ".codex"), Path.join(home, ".codex"),
  ]) directories.add(Path.join(root, "tools"));
  // builtin.ts skips project tools when the actual cwd is Home. Its other project
  // tool root is cwd/.omp only; its ancestor walk loads skills/system context, not tools.
  let actualCwd = cwd;
  let actualHome = home;
  try { actualCwd = Fs.realpathSync(cwd); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new OmpStartupPolicyError(cwd, "could not establish the native working directory");
    }
  }
  try { actualHome = Fs.realpathSync(home); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new OmpStartupPolicyError(home, "could not establish the native Home directory");
    }
  }
  const sameHome = process.platform === "win32"
    ? actualCwd.toLowerCase() === actualHome.toLowerCase()
    : actualCwd === actualHome;
  if (!sameHome) directories.add(Path.join(cwd, ".omp", "tools"));
  // Of these executable-startup sources, only plugin lookup walks ancestors.
  // Share its actual nearest registry resolution with the npm/module guard.
  for (const root of ompPluginStartupRoots({ ...input, cwd, homeDirectory: home })) {
    files.add(Path.join(root, "installed_plugins.json"));
  }
  files.add(Path.join(claudeRoot, "plugins", "installed_plugins.json"));
  // env.ts reads exactly these four .env files. Bun's automatic mode/local
  // dotenv variants apply only at the actual process cwd, never at its ancestors.
  for (const root of new Set([cwd, home, input.nativeHome.configRoot, input.nativeHome.agentDirectory])) {
    files.add(Path.join(root, ".env"));
  }
  const nodeEnv = input.environment.NODE_ENV || "development";
  if (!/^[A-Za-z0-9_-]+$/.test(nodeEnv)) throw new OmpStartupPolicyError("NODE_ENV", "unrecognized dotenv selection");
  for (const name of [".env.local", `.env.${nodeEnv}`, `.env.${nodeEnv}.local`]) files.add(Path.join(cwd, name));
  return { files, directories };
}

/** Checks metadata only and fails before ANY CLI invocation (including health/discovery helpers). */
export function assertOmpStartupSafe(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly nativeHome: OmpNativeHome;
}): void {
  const { files, directories } = ompStartupSourcePaths(input);
  for (const file of files) {
    try {
      Fs.lstatSync(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw new OmpStartupPolicyError(file, "could not prove an ambient startup source absent");
    }
    throw new OmpStartupPolicyError(file, "ambient or uninspectable MCP/plugin/dotenv configuration exists");
  }
  for (const directory of directories) {
    try {
      const stat = Fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new OmpStartupPolicyError(directory, "uninspectable custom-tool/plugin directory");
      if (Fs.readdirSync(directory).length > 0) throw new OmpStartupPolicyError(directory, "ambient custom tools or plugins exist");
    } catch (error) {
      if (error instanceof OmpStartupPolicyError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw new OmpStartupPolicyError(directory, "could not establish an empty custom-tool/plugin directory");
    }
  }
  assertOmpPluginStartupSafe(input);
}
