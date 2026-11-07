/** Translated from apps/server/cc-switch-host/src/host_context.rs. */
import { constants, chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { APP_IDS, type HostInitialization } from "./types.ts";
import { AppError, invalidInput } from "./errors.ts";
import { initialize as initializeSecretCodec } from "./secret-codec.ts";

interface ContextPaths {
  data: string;
  home: string;
  apps: Map<string, string>;
  claudeMcpFile?: string;
  physicalHome: string;
  physicalApps: Map<string, string>;
}

let context: ContextPaths | undefined;

function isDirectory(value: string): boolean {
  try { return statSync(value).isDirectory(); } catch { return false; }
}

/** Reject relative paths and traversal. Explicit symlink roots are allowed. */
export function validateRoot(root: string): void {
  if (!path.isAbsolute(root) || path.parse(root).root === root) throw invalidInput("An explicit absolute path without traversal is required");
  const parts = root.split(path.sep).filter(Boolean);
  let prefix = path.parse(root).root;
  for (const part of parts) {
    if (part === "." || part === "..") throw invalidInput("An explicit absolute path without traversal is required");
    prefix = path.join(prefix, part);
    let info;
    try { info = lstatSync(prefix); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() && !isDirectory(prefix)) throw invalidInput("Root symlink does not resolve to a directory");
    if (!info.isDirectory() && !info.isSymbolicLink()) throw invalidInput("Root component is not a directory");
  }
}

function validateClaudeMcpFile(home: string, apps: Map<string, string>, selected: string | undefined): void {
  const appDir = apps.get("claude");
  if (appDir !== undefined && selected !== undefined) {
    const normalized = path.normalize(selected);
    if (!path.isAbsolute(selected) || selected.split(path.sep).some((part) => part === "." || part === "..") || normalized !== selected) {
      throw invalidInput("Claude MCP file must be an absolute normalized native path");
    }
    if (selected !== path.join(home, ".claude.json") && selected !== path.join(appDir, ".claude.json")) {
      throw invalidInput("Claude MCP file is outside the two authorized native locations");
    }
    return;
  }
  if (appDir !== undefined) throw invalidInput("Bound Claude target requires an explicit MCP file");
  if (selected !== undefined) throw invalidInput("Claude MCP file requires a bound Claude target");
}

export function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError("IO", "Configuration storage must be a host-owned directory, not a symbolic link.");
  if (process.platform !== "win32") {
    try { chmodSync(directory, 0o700); } catch { /* best effort */ }
  }
}

/** Resolve existing ancestors without creating an uninitialized native root. */
function physicalIdentity(value: string): string {
  let ancestor = value;
  const suffix: string[] = [];
  for (;;) {
    try {
      const resolved = realpathSync(ancestor);
      return path.join(resolved, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalidInput("Native root unavailable");
      const name = path.basename(ancestor);
      if (!name || name === path.parse(ancestor).root) throw invalidInput("Native root unavailable");
      suffix.push(name);
      ancestor = path.dirname(ancestor);
    }
  }
}

export function initialize(args: HostInitialization): string[] {
  if (context) throw invalidInput("Context is already initialized");
  validateRoot(args.dataDir);
  validateRoot(args.homeDir);
  if (args.dataDir === path.parse(args.dataDir).root || args.homeDir === path.parse(args.homeDir).root) throw invalidInput("Filesystem root is not a management context");
  const apps = new Map<string, string>();
  for (const [app, root] of Object.entries(args.appDirs)) {
    if (!(APP_IDS as readonly string[]).includes(app)) throw invalidInput("Unsupported target application");
    validateRoot(root);
    apps.set(app, root);
  }
  validateClaudeMcpFile(args.homeDir, apps, args.claudeMcpFile);
  privateDirectory(args.dataDir);
  if (!statExists(args.homeDir)) {
    const relative = path.relative(args.dataDir, args.homeDir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw invalidInput("Native target HOME must already exist");
    privateDirectory(args.homeDir);
  }
  initializeSecretCodec(args.secretKey);
  const physicalHome = physicalIdentity(args.homeDir);
  const physicalApps = new Map<string, string>();
  for (const [app, root] of apps) physicalApps.set(app, physicalIdentity(root));
  context = {
    data: args.dataDir,
    home: args.homeDir,
    apps,
    ...(args.claudeMcpFile !== undefined ? { claudeMcpFile: args.claudeMcpFile } : {}),
    physicalHome,
    physicalApps,
  };
  return [...apps.keys()];
}

function statExists(value: string): boolean {
  try { lstatSync(value); return true; } catch { return false; }
}

function paths(): ContextPaths {
  if (!context) throw invalidInput("host_initialize must precede management");
  return context;
}

export function dataDir(): string { return paths().data; }
export function homeDir(): string { return paths().home; }
export function hasNativeTargets(): boolean { return paths().apps.size > 0; }
export function isBound(app: string): boolean { return paths().apps.has(app); }
export function requireApp(app: string): void {
  if (!isBound(app)) throw invalidInput("unbound_target");
}
export function claudeMcpFile(): string {
  const value = paths().claudeMcpFile;
  if (!value) throw invalidInput("unbound_target");
  return value;
}
export function appDir(app: string): string {
  const value = paths().apps.get(app);
  return value ?? path.join(paths().data, "unbound", app);
}
export function physicalRoot(app: string): string | undefined {
  return paths().physicalApps.get(app);
}
export function physicalHome(): string { return paths().physicalHome; }

/** Fixed adapter paths may not follow a file or retargeted root into another app's Home/config. */
export function requireNativeReadPath(app: string, nativePath: string): void {
  const current = paths();
  const root = current.apps.get(app);
  const physical = current.physicalApps.get(app);
  if (!root || !physical) throw invalidInput("unbound_target");
  if (physicalIdentity(root) !== physical) throw new AppError("CONFIG", "Native root changed after authorization");
  if (app === "claude" && current.claudeMcpFile === path.join(current.home, ".claude.json")) {
    if (current.claudeMcpFile !== nativePath
      || physicalIdentity(current.home) !== current.physicalHome
      || physicalIdentity(nativePath) !== path.join(current.physicalHome, ".claude.json")) {
      throw new AppError("CONFIG", "Native file is outside its authorized target");
    }
    return;
  }
  if (!isWithin(root, nativePath) || !isWithin(physical, physicalIdentity(nativePath))) {
    throw new AppError("CONFIG", "Native file is outside its authorized target");
  }
}

function isWithin(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function validateReadPath(nativePath: string): void {
  if (!path.isAbsolute(nativePath)) throw invalidInput("Native path must be absolute");
  let canonical: string;
  try { canonical = realpathSync(nativePath); } catch { throw new AppError("CONFIG", "Native path is unavailable"); }
  const current = paths();
  const within = (root: string) => {
    try { return isWithin(realpathSync(root), canonical); } catch { return false; }
  };
  if (within(current.data) || within(current.home) || [...current.apps.values()].some(within)) return;
  throw new AppError("CONFIG", "Path is outside the authorized context");
}

export function uploadedZip(value: string): string {
  if (!path.isAbsolute(value)) throw invalidInput("Uploaded archive path must be absolute");
  let canonical: string;
  try { canonical = realpathSync(value); } catch { throw new AppError("IO", "Uploaded archive is unavailable"); }
  let uploads: string;
  try { uploads = realpathSync(path.join(dataDir(), "uploads")); } catch { throw new AppError("IO", "Upload directory is unavailable"); }
  if (!isWithin(uploads, canonical) || !isFile(canonical)) throw invalidInput("Archive is not an owned upload");
  return canonical;
}

function isFile(value: string): boolean {
  try { return statSync(value).isFile(); } catch { return false; }
}

/** Test-only reset; never used by production commands. */
export function resetContextForTests(): void {
  context = undefined;
}

export const PRIVATE_MODE = constants.S_IRUSR | constants.S_IWUSR;
