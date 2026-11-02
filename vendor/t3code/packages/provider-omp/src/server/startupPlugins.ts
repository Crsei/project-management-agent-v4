import * as Fs from "node:fs";
import * as Path from "node:path";

export interface OmpPluginStartupInput {
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly cwd: string;
  readonly nativeHome: { readonly configRoot: string; readonly agentDirectory: string; readonly profile?: string };
}

function statMetadata(path: string): Fs.Stats | undefined {
  try { return Fs.statSync(path); }
  catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && (cause.code === "ENOENT" || cause.code === "ENOTDIR")) return undefined;
    throw new Error("OMP plugin startup source could not be classified safely", { cause });
  }
}
function comparisonPath(path: string): string {
  const resolved = Path.resolve(path);
  const real = statMetadata(resolved) ? Fs.realpathSync(resolved) : resolved;
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** Pinned 18.13.2 utils/dirs.ts#getPluginsDir and discovery/helpers.ts
 * #resolveActiveProjectRegistryPath. Resolve exactly one native user root and
 * at most one project root; Home and temporary directories are discovery
 * ceilings, not project configuration candidates. Never read plugin secrets.
 */
export function ompPluginStartupRoots(input: OmpPluginStartupInput): ReadonlyArray<string> {
  const env = input.environment;
  const configName = env.PI_CONFIG_DIR || ".omp";
  let userConfigRoot = input.nativeHome.configRoot;
  const defaultAgent = Path.join(userConfigRoot, "agent");
  if ((process.platform === "linux" || process.platform === "darwin") &&
    input.nativeHome.agentDirectory === defaultAgent && env.XDG_DATA_HOME) {
    const xdg = Path.join(Path.resolve(input.cwd, env.XDG_DATA_HOME), "omp",
      ...(input.nativeHome.profile ? ["profiles", input.nativeHome.profile] : []));
    if (statMetadata(xdg)) userConfigRoot = xdg;
  }
  const userRoot = Path.join(userConfigRoot, "plugins");
  const nativeHome = comparisonPath(input.homeDirectory);
  const temporary = process.platform === "win32"
    ? env.TEMP || env.TMP || Path.join(env.SystemRoot || env.windir || "C:\\Windows", "Temp")
    : env.TMPDIR || env.TMP || env.TEMP || "/tmp";
  const ceilings = new Set([nativeHome, comparisonPath(Path.resolve(input.cwd, temporary))]);
  if (process.platform !== "win32") { ceilings.add(comparisonPath("/tmp")); ceilings.add(comparisonPath("/var/tmp")); }
  // The native process obtains its cwd from getcwd(), not the parent's PWD alias.
  const cwd = Fs.realpathSync(Path.resolve(input.cwd));
  const nativeAgent = comparisonPath(input.nativeHome.agentDirectory);
  const baseUserConfig = comparisonPath(Path.join(input.homeDirectory, configName));
  const pluginConfig = comparisonPath(userConfigRoot);
  const isUserRoot = (directory: string) => {
    const config = comparisonPath(Path.join(directory, configName));
    return config === baseUserConfig || config === pluginConfig;
  };
  let nearestGitRoot: string | undefined;
  let gitAnchor: string | undefined;
  let directory = cwd;
  while (!ceilings.has(comparisonPath(directory))) {
    if (statMetadata(Path.join(directory, ".git"))) {
      nearestGitRoot ??= directory;
      if (!isUserRoot(directory)) { gitAnchor = directory; break; }
    }
    const parent = Path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  let aboveGitRoot = nearestGitRoot === undefined;
  directory = cwd;
  let projectRoot: string | undefined;
  while (!ceilings.has(comparisonPath(directory))) {
    if (statMetadata(Path.join(directory, configName))?.isDirectory() && !isUserRoot(directory)) {
      const agent = Path.join(directory, configName, "agent");
      const foreignUserLayout = aboveGitRoot && statMetadata(agent)?.isDirectory() === true && comparisonPath(agent) !== nativeAgent;
      if (!foreignUserLayout) { projectRoot = Path.join(directory, configName, "plugins"); break; }
    }
    if (directory === nearestGitRoot) aboveGitRoot = true;
    const parent = Path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  projectRoot ??= gitAnchor === undefined ? undefined : Path.join(gitAnchor, configName, "plugins");
  return projectRoot && comparisonPath(projectRoot) !== comparisonPath(userRoot) ? [userRoot, projectRoot] : [userRoot];
}

/** custom-tools/loader.ts calls getAllPluginToolPaths outside capability
 * filtering. plugins/loader.ts combines dependency keys and runtime-lock keys
 * without proving containment. Even empty node_modules is therefore unsafe
 * when either metadata file exists: '../escape' can select code next to it.
 * Refuse metadata by presence, never parse locks that may hold plugin secrets.
 */
export function assertOmpPluginStartupSafe(input: OmpPluginStartupInput): void {
  for (const root of ompPluginStartupRoots(input)) {
    const modules = Path.join(root, "node_modules");
    const stat = statMetadata(modules);
    if (!stat) continue;
    if (!stat.isDirectory()) throw new Error("OMP plugin node_modules is not a directory; startup refused");
    if (statMetadata(Path.join(root, "package.json")) || statMetadata(Path.join(root, "omp-plugins.lock.json")))
      throw new Error("OMP plugin startup metadata is unsupported by the PM permission boundary; use a native environment without plugin package/runtime-lock metadata");
    if (Fs.readdirSync(modules).length !== 0)
      throw new Error("OMP installed plugin startup is unsupported by the PM permission boundary; use a native environment without installed plugin modules");
  }
}
