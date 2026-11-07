import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ProviderDriver, ProviderNativeConfigurationChange } from "@agent-workspace/contracts/provider";
import { resolveProviderNativeDirectories } from "../providers/t3code/native-paths.ts";
import { listStoredInstances, providerUsageContext, providerUserHome, type StoredProviderInstance } from "../providers/instances.ts";
import { invalidateProviderSkillsSnapshots } from "../providers/t3code/management.ts";

/** These are upstream application IDs, never PM Provider instance/driver IDs. */
export const EXTENSION_APP_IDS = [
  "claude", "codex", "gemini", "grokbuild", "opencode", "hermes", "pi", "mcode", "kimi", "dsh", "agy", "omp",
] as const;
export type ExtensionAppId = typeof EXTENSION_APP_IDS[number];

export type ExtensionProviderTarget = {
  providerInstanceId: string;
  providerRevision: number;
  driver: ProviderDriver;
  label: string;
  app: ExtensionAppId;
  /** Actual target user Home: Unified skills are Home/.agents/skills, not project-local skills. */
  homeDir: string;
  /** Authoritative native configuration root, preserving native symlink/relative-path semantics. */
  appDir: string;
  /** Private runtime authority: present iff Claude is bound; never exposed in public target metadata. */
  claudeMcpFile?: string;
  /** Canonical ownership keys; includes the separate Claude MCP file and Unified skills root. */
  physicalRoots: string[];
  unifiedSkillsRoot: string;
  sharedProviderInstanceIds: string[];
  bindingFingerprint: string;
  nativeMcp: "native-config" | "execution-scoped";
  warnings: string[];
};
export type ExtensionProviderBinding = {
  label: string;
  homeDir: string;
  appDirs: Partial<Record<ExtensionAppId, string>>;
  /** Required for a bound Claude app, including explicit overrides equal to the default directory. */
  claudeMcpFile?: string;
  providerInstanceIds: string[];
  apps: ExtensionAppId[];
  physicalRoots: string[];
  unifiedSkillsRoot: string;
  sharedProviderInstanceIds: string[];
  bindingFingerprint: string;
  warnings: string[];
};
export type ExtensionProviderInvalidation = ProviderNativeConfigurationChange & { providerInstanceIds: string[] };

function bindingError(message: string, code = "extension_provider_binding_changed", status = 409): Error {
  return Object.assign(new Error(message), { status, code });
}

/** Resolve aliases even before a target exists, without creating directories or reading file contents. */
export function canonicalExtensionProviderPath(value: string): string {
  if (!path.isAbsolute(value) || value.includes("\0"))
    throw bindingError("Native extension paths must be absolute host-authorized paths.", "invalid_extension_provider_path", 400);
  let current = path.normalize(value);
  const missing: string[] = [];
  for (;;) {
    try {
      const resolved = path.join(realpathSync.native(current), ...missing);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw bindingError("A native extension path could not be resolved safely.", "invalid_extension_provider_path");
      try {
        if (lstatSync(current).isSymbolicLink())
          throw bindingError("A native extension target contains a dangling symbolic link.", "invalid_extension_provider_path");
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      const parent = path.dirname(current);
      if (parent === current)
        throw bindingError("A native extension path has no resolvable filesystem root.", "invalid_extension_provider_path");
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Canonical roots overlap by ancestry as well as equality, including shared skills subdirectories. */
export function extensionProviderPathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const inverse = path.relative(right, left);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) ||
    (!path.isAbsolute(inverse) && inverse !== ".." && !inverse.startsWith(`..${path.sep}`));
}

function targetForInstance(instance: StoredProviderInstance): ExtensionProviderTarget | undefined {
  const context = providerUsageContext(instance);
  const env = context.env;
  // Registered Provider settings are the authority; resolution does not inspect credentials or write native files.
  const directories = resolveProviderNativeDirectories(context, providerUserHome(instance, context.cwd));
  const homeDir = directories.homeDirectory;
  let app: ExtensionAppId;
  let appDir: string;
  switch (instance.driver) {
    case "claude":
    case "codex":
      app = instance.driver;
      appDir = context.homeDirectory;
      break;
    case "grok":
      app = "grokbuild";
      appDir = env.GROK_HOME?.trim() ? path.resolve(context.cwd, env.GROK_HOME) : path.join(homeDir, ".grok");
      break;
    case "antigravity":
      app = "agy";
      // The production driver links these real user skills into its private GEMINI_HOME; account data stays private.
      appDir = path.join(homeDir, ".gemini", "config");
      break;
    case "pi":
      app = "pi";
      appDir = env.PI_CODING_AGENT_DIR ? path.resolve(context.cwd, env.PI_CODING_AGENT_DIR) : path.join(homeDir, ".pi", "agent");
      break;
    case "omp":
      app = "omp";
      appDir = directories.agentDirectory!;
      break;
    case "opencode": {
      // A borrowed/remote OpenCode server does not establish ownership of any local native config root.
      if (String(instance.config.serverUrl ?? "").trim()) return undefined;
      app = "opencode";
      appDir = env.OPENCODE_CONFIG_DIR
        ? path.resolve(context.cwd, env.OPENCODE_CONFIG_DIR)
        : path.resolve(context.cwd, env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "opencode");
      // Upstream cc-switch owns opencode.json/jsonc under one directory, not arbitrary OPENCODE_CONFIG files.
      if (env.OPENCODE_CONFIG && !["opencode.json", "opencode.jsonc"].some(name =>
        canonicalExtensionProviderPath(path.resolve(context.cwd, env.OPENCODE_CONFIG!)) === canonicalExtensionProviderPath(path.join(appDir, name))))
        return undefined;
      break;
    }
    // Cursor, FX, Muse and generic ACP have no proven corresponding upstream app layout.
    default: return undefined;
  }
  appDir = path.resolve(context.cwd, appDir);
  const unifiedSkillsRoot = canonicalExtensionProviderPath(path.join(homeDir, ".agents", "skills"));
  const physicalRoots = [canonicalExtensionProviderPath(appDir), unifiedSkillsRoot];
  let claudeMcpFile: string | undefined;
  if (app === "claude") {
    // The effective runtime environment distinguishes a real default from an explicit default-looking override.
    claudeMcpFile = env.CLAUDE_CONFIG_DIR?.trim()
      ? path.join(appDir, ".claude.json") : path.join(homeDir, ".claude.json");
    physicalRoots.push(canonicalExtensionProviderPath(claudeMcpFile));
  }
  const warnings = [
    "Configuration saved and files synchronized do not mean a running native session has reloaded; explicitly reload or start a new native session.",
    "Unified skills use the target user's Home/.agents/skills and can affect other native applications sharing that Home.",
  ];
  if (app === "agy") warnings.push("PM Antigravity keeps MCP execution-scoped in its private GEMINI_HOME; this native target shares user skills, not PM tool authorization.");
  if (app === "omp") warnings.push("OMP skills remain native-directory observations; installation does not grant Composer invocation or cross-directory discovery.");
  const target: ExtensionProviderTarget = {
    providerInstanceId: instance.instanceId, providerRevision: instance.revision, driver: instance.driver,
    label: instance.label || instance.instanceId, app, homeDir, appDir,
    ...(claudeMcpFile ? { claudeMcpFile } : {}),
    physicalRoots: [...new Set(physicalRoots)].sort(), unifiedSkillsRoot, sharedProviderInstanceIds: [],
    bindingFingerprint: "", nativeMcp: app === "agy" ? "execution-scoped" : "native-config", warnings,
  };
  target.bindingFingerprint = createHash("sha256").update(JSON.stringify([
    target.providerInstanceId, target.providerRevision, target.app, target.homeDir, target.appDir, target.physicalRoots,
    ...(target.claudeMcpFile ? [target.claudeMcpFile] : []),
  ])).digest("hex");
  return target;
}

/** Metadata only: no CLI probes, credential reads, native writes or grants; Provider store initialization stays authoritative. */
export function listExtensionProviderTargets(): ExtensionProviderTarget[] {
  const targets = listStoredInstances().filter(instance => instance.enabled).flatMap(instance => {
    const target = targetForInstance(instance);
    return target ? [target] : [];
  });
  for (const target of targets) {
    target.sharedProviderInstanceIds = targets.filter(other => other.providerInstanceId !== target.providerInstanceId &&
      other.physicalRoots.some(root => target.physicalRoots.some(owned => extensionProviderPathsOverlap(root, owned)))).map(other => other.providerInstanceId).sort();
    if (target.sharedProviderInstanceIds.length)
      target.warnings.push("Other Provider instances share this native root or Unified skills Home; their configuration/discovery can also be affected.");
  }
  return targets;
}

/** Browser input selects IDs only. The host must separately enforce physical-root single ownership. */
export function resolveExtensionProviderBinding(input: { providerInstanceIds: string[]; confirmed: true }): ExtensionProviderBinding {
  if (input.confirmed !== true)
    throw bindingError("Explicit native target confirmation is required.", "extension_provider_confirmation_required", 400);
  return resolveRegisteredExtensionProviders(input.providerInstanceIds);
}

/** Resolve already-registered Provider authority without accepting a browser binding confirmation. */
export function resolveRegisteredExtensionProviders(providerInstanceIds: string[]): ExtensionProviderBinding {
  if (!Array.isArray(providerInstanceIds) || !providerInstanceIds.length || providerInstanceIds.length > 100 ||
      providerInstanceIds.some(id => typeof id !== "string" || !id) || new Set(providerInstanceIds).size !== providerInstanceIds.length)
    throw bindingError("Select distinct current Provider instances.", "invalid_extension_provider_selection", 400);
  const targets = listExtensionProviderTargets();
  const selected = providerInstanceIds.map(id => {
    const target = targets.find(item => item.providerInstanceId === id);
    if (!target) throw bindingError("A selected Provider has no supported local upstream application target.", "unsupported_extension_provider_target");
    return target;
  }).sort((a, b) => a.providerInstanceId.localeCompare(b.providerInstanceId));
  const homeDir = selected[0]!.homeDir;
  if (selected.some(target => canonicalExtensionProviderPath(target.homeDir) !== canonicalExtensionProviderPath(homeDir)))
    throw bindingError("Different native user Homes require separate extension contexts.", "extension_provider_home_conflict");
  const appDirs: Partial<Record<ExtensionAppId, string>> = {};
  let claudeMcpFile: string | undefined;
  for (const target of selected) {
    const previous = appDirs[target.app];
    if (previous && canonicalExtensionProviderPath(previous) !== canonicalExtensionProviderPath(target.appDir))
      throw bindingError("Different roots for the same upstream application require separate extension contexts.", "extension_provider_app_conflict");
    if (target.app === "claude") {
      if (!target.claudeMcpFile)
        throw bindingError("The Claude target has no explicit native MCP file authority.");
      if (claudeMcpFile && canonicalExtensionProviderPath(claudeMcpFile) !== canonicalExtensionProviderPath(target.claudeMcpFile))
        throw bindingError("Claude targets using different native MCP files require separate extension contexts.", "extension_provider_claude_mcp_conflict");
      claudeMcpFile ??= target.claudeMcpFile;
    }
    appDirs[target.app] ??= target.appDir;
  }
  if (claudeMcpFile && claudeMcpFile !== path.join(homeDir, ".claude.json") &&
      claudeMcpFile !== path.join(appDirs.claude!, ".claude.json"))
    throw bindingError("The selected native Home aliases cannot represent the chosen Claude MCP file.", "extension_provider_claude_mcp_conflict");
  const bindingFingerprint = createHash("sha256").update(JSON.stringify(selected.map(target => target.bindingFingerprint))).digest("hex");
  return {
    label: selected.map(target => target.label).join(" / "), homeDir, appDirs,
    ...(claudeMcpFile ? { claudeMcpFile } : {}),
    providerInstanceIds: selected.map(target => target.providerInstanceId), apps: EXTENSION_APP_IDS.filter(app => appDirs[app] !== undefined),
    physicalRoots: [...new Set(selected.flatMap(target => target.physicalRoots))].sort(), unifiedSkillsRoot: selected[0]!.unifiedSkillsRoot,
    sharedProviderInstanceIds: [...new Set(selected.flatMap(target => target.sharedProviderInstanceIds))].sort(),
    bindingFingerprint, warnings: [...new Set(selected.flatMap(target => target.warnings))],
  };
}

/** Recheck immediately before every sidecar operation; changed authority requires re-resolution. */
export function assertExtensionProviderBindingCurrent(binding: ExtensionProviderBinding): void {
  const current = resolveRegisteredExtensionProviders(binding.providerInstanceIds);
  const canonical = (value: string | undefined) => value === undefined ? undefined : canonicalExtensionProviderPath(value);
  if (current.bindingFingerprint !== binding.bindingFingerprint ||
      canonical(current.homeDir) !== canonical(binding.homeDir) || canonical(current.claudeMcpFile) !== canonical(binding.claudeMcpFile) ||
      current.apps.length !== binding.apps.length || current.apps.some(app => canonical(current.appDirs[app]) !== canonical(binding.appDirs[app])) ||
      JSON.stringify([...current.physicalRoots].sort()) !== JSON.stringify([...binding.physicalRoots].sort()))
    throw bindingError("Provider native targets changed; reopen management for the current Provider before continuing.");
}

/** Successful mutation notification only; no execution cancellation, account/reset or tool-policy changes. */
export function invalidateExtensionProviderBindings(providerInstanceIds: readonly string[], reason: string): ExtensionProviderInvalidation {
  const targets = listExtensionProviderTargets();
  const roots = targets.filter(target => providerInstanceIds.includes(target.providerInstanceId)).flatMap(target => target.physicalRoots);
  const affected = [...new Set([...providerInstanceIds, ...targets.filter(target => target.physicalRoots.some(root =>
    roots.some(changed => extensionProviderPathsOverlap(root, changed)))).map(target => target.providerInstanceId)])].sort();
  const change = invalidateProviderSkillsSnapshots(affected, reason);
  return { ...change, providerInstanceIds: affected };
}
