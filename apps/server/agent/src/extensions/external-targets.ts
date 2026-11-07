import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { extensionAppIds } from "@agent-workspace/contracts/extensions";
import { canonicalExtensionProviderPath, extensionProviderPathsOverlap, listExtensionProviderTargets, resolveExtensionProviderBinding, resolveRegisteredExtensionProviders, assertExtensionProviderBindingCurrent, type ExtensionProviderBinding } from "./provider-bindings.ts";
import { assertPrivatePath } from "../../../../../packages/pm-core/private-path.ts";
import { ExtensionError } from "./rpc.ts";

const absolute = z.string().min(1).max(4000).refine(value => path.isAbsolute(value) && !value.includes("\0"));
const descriptorSchema = z.strictObject({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), label: z.string().min(1).max(200), app: z.enum(extensionAppIds), homeDir: absolute, appDir: absolute, claudeMcpFile: absolute.optional() }).superRefine((target, context) => {
  if (target.claudeMcpFile === undefined) return;
  if (target.app !== "claude") {
    context.addIssue({ code: "custom", path: ["claudeMcpFile"], message: "Only Claude targets may register a Claude MCP file." });
    return;
  }
  if (path.normalize(target.claudeMcpFile) !== target.claudeMcpFile || ![path.join(target.homeDir, ".claude.json"), path.join(target.appDir, ".claude.json")].includes(target.claudeMcpFile)) context.addIssue({ code: "custom", path: ["claudeMcpFile"], message: "The Claude MCP file must be an exact normalized native Home or app-directory location." });
});
export type ExternalExtensionTarget = z.infer<typeof descriptorSchema> & { physicalRoots: string[]; unifiedSkillsRoot: string; fingerprint: string };
export type ExtensionHostBindingInput = { providerInstanceIds: string[]; externalTargetIds?: string[]; confirmed: true };
export type ExtensionHostBinding = { binding: ExtensionProviderBinding; providerBinding?: ExtensionProviderBinding; externalTargets?: ExternalExtensionTarget[] };

/** Only deployment-owned registration grants external filesystem authority; browsers choose opaque IDs. */
export function listExternalExtensionTargets(): ExternalExtensionTarget[] {
  const filename = process.env.CC_SWITCH_EXTERNAL_TARGETS_FILE?.trim();
  if (!filename) return [];
  if (!path.isAbsolute(filename)) throw new ExtensionError(503, "external_targets_invalid", "The external target registry must be an absolute host-configured path.");
  try {
    const info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())))) throw new Error("unsafe target registry");
    assertPrivatePath(filename);
    const descriptors = z.array(descriptorSchema).max(100).parse(JSON.parse(readFileSync(filename, "utf8")));
    if (new Set(descriptors.map(target => target.id)).size !== descriptors.length) throw new Error("duplicate target");
    return descriptors.map(target => {
      const unifiedSkillsRoot = canonicalExtensionProviderPath(path.join(target.homeDir, ".agents", "skills"));
      const physicalRoots = [canonicalExtensionProviderPath(target.appDir), unifiedSkillsRoot];
      const claudeMcpFile = target.app === "claude" ? target.claudeMcpFile ?? (path.normalize(target.appDir) === path.join(target.homeDir, ".claude") ? path.join(target.homeDir, ".claude.json") : path.join(target.appDir, ".claude.json")) : undefined;
      if (claudeMcpFile) physicalRoots.push(canonicalExtensionProviderPath(claudeMcpFile));
      const resolved = { ...target, ...(claudeMcpFile ? { claudeMcpFile } : {}) };
      return { ...resolved, physicalRoots, unifiedSkillsRoot, fingerprint: createHash("sha256").update(JSON.stringify({ target: resolved, physicalRoots })).digest("hex") };
    });
  } catch { throw new ExtensionError(503, "external_targets_invalid", "The deployment-owned external target registry is unavailable or invalid; no fallback target was registered."); }
}
export function resolveExtensionHostBinding(input: ExtensionHostBindingInput): ExtensionHostBinding {
  if (input.confirmed !== true) throw new ExtensionError(403, "binding_confirmation_required", "Explicit native target binding confirmation is required.");
  const providerBinding = input.providerInstanceIds.length ? resolveExtensionProviderBinding({ providerInstanceIds: input.providerInstanceIds, confirmed: true }) : undefined;
  const registered = listExternalExtensionTargets();
  const externalTargets = [...new Set(input.externalTargetIds ?? [])].sort().map(id => {
    const target = registered.find(item => item.id === id);
    if (!target) throw new ExtensionError(404, "external_target_unknown", "An external target ID is not registered by the host administrator.");
    return target;
  });
  return assembleExtensionHostBinding(providerBinding, externalTargets);
}

function assembleExtensionHostBinding(providerBinding: ExtensionProviderBinding | undefined, externalTargets: ExternalExtensionTarget[]): ExtensionHostBinding {
  if (!externalTargets.length) {
    if (!providerBinding) throw new ExtensionError(400, "binding_target_required", "Select at least one confirmed native target.");
    return { binding: providerBinding };
  }
  const homeDir = providerBinding?.homeDir ?? externalTargets[0]!.homeDir;
  const homeRoot = canonicalExtensionProviderPath(homeDir);
  const appDirs = { ...providerBinding?.appDirs };
  let claudeMcpFile = providerBinding?.claudeMcpFile;
  if (providerBinding?.appDirs.claude && !claudeMcpFile) throw new ExtensionError(409, "binding_claude_mcp_missing", "The Provider's Claude MCP file authority is missing. Explicitly rebind its current native target.");
  for (const target of externalTargets) {
    if (canonicalExtensionProviderPath(target.homeDir) !== homeRoot) throw new ExtensionError(409, "binding_home_conflict", "One context cannot bind native targets belonging to different user Homes.");
    if (appDirs[target.app] && canonicalExtensionProviderPath(appDirs[target.app]!) !== canonicalExtensionProviderPath(target.appDir)) throw new ExtensionError(409, "binding_app_conflict", "One context cannot bind two different roots for the same upstream application.");
    if (target.app === "claude") {
      if (!target.claudeMcpFile) throw new ExtensionError(503, "external_claude_mcp_missing", "The registered Claude target has no explicit resolved MCP file authority.");
      if (claudeMcpFile && canonicalExtensionProviderPath(claudeMcpFile) !== canonicalExtensionProviderPath(target.claudeMcpFile)) throw new ExtensionError(409, "binding_claude_mcp_conflict", "The selected Claude targets use different MCP files, even though their application directories may match.");
      claudeMcpFile ??= target.claudeMcpFile;
    }
    appDirs[target.app] ??= target.appDir;
  }
  if (appDirs.claude && (!claudeMcpFile || ![path.join(homeDir, ".claude.json"), path.join(appDirs.claude, ".claude.json")].includes(claudeMcpFile))) throw new ExtensionError(409, "binding_claude_mcp_conflict", "The selected context's exact native roots cannot represent its chosen Claude MCP file. Register consistent explicit root spellings.");
  const physicalRoots = [...new Set([...(providerBinding?.physicalRoots ?? []), ...externalTargets.flatMap(target => target.physicalRoots)])];
  const sharedProviderInstanceIds = [...new Set([...(providerBinding?.sharedProviderInstanceIds ?? []), ...listExtensionProviderTargets().filter(target => target.physicalRoots.some(root => physicalRoots.some(owned => extensionProviderPathsOverlap(root, owned)))).map(target => target.providerInstanceId)])].sort();
  const binding: ExtensionProviderBinding = {
    label: [providerBinding?.label, ...externalTargets.map(target => target.label)].filter(Boolean).join(" · "), homeDir, appDirs,
    apps: extensionAppIds.filter(app => appDirs[app] !== undefined), providerInstanceIds: providerBinding?.providerInstanceIds ?? [], physicalRoots,
    ...(claudeMcpFile ? { claudeMcpFile } : {}),
    unifiedSkillsRoot: canonicalExtensionProviderPath(path.join(homeDir, ".agents", "skills")), sharedProviderInstanceIds,
    bindingFingerprint: createHash("sha256").update(JSON.stringify({ provider: providerBinding?.bindingFingerprint, external: externalTargets.map(target => target.fingerprint) })).digest("hex"),
    warnings: [...(providerBinding?.warnings ?? []), "External CLI targets do not add a PM Chat Provider or grant project execution authority. Native sessions require an explicit reload after configuration changes.", ...(sharedProviderInstanceIds.length ? [`Native configuration or Unified Home overlaps Provider instances: ${sharedProviderInstanceIds.join(", ")}.`] : [])],
  };
  return { binding, ...(providerBinding ? { providerBinding } : {}), externalTargets };
}
/** Refresh an already enrolled external owner, never enrolling a new external target. */
export function refreshExistingExtensionHostBinding(stored: ExtensionHostBinding, providerBinding?: ExtensionProviderBinding): ExtensionHostBinding {
  if (!stored.binding.bindingFingerprint) throw new ExtensionError(409, "binding_reconfirmation_required", "Restored external targets require explicit enrollment before their configuration can be managed.");
  const registered = listExternalExtensionTargets();
  const externalTargets = (stored.externalTargets ?? []).map(previous => {
    const current = registered.find(target => target.id === previous.id);
    if (!current || current.fingerprint !== previous.fingerprint) throw new ExtensionError(409, "external_binding_changed", "The external target registration changed. Reconcile its explicit enrollment before continuing.");
    return current;
  });
  if (!externalTargets.length) throw new ExtensionError(409, "external_binding_changed", "The existing external target enrollment is unavailable.");
  return assembleExtensionHostBinding(providerBinding, externalTargets);
}
export function assertExtensionHostBindingCurrent(stored: ExtensionHostBinding): void {
  if (!stored.binding.bindingFingerprint) throw new ExtensionError(409, "binding_reconfirmation_required", "The restored native target binding requires explicit confirmation.");
  if (!stored.externalTargets?.length) { assertExtensionProviderBindingCurrent(stored.binding); return; }
  if (stored.providerBinding) assertExtensionProviderBindingCurrent(stored.providerBinding);
  const currentProvider = stored.binding.providerInstanceIds.length ? resolveRegisteredExtensionProviders(stored.binding.providerInstanceIds) : undefined;
  const current = refreshExistingExtensionHostBinding(stored, currentProvider);
  const canonical = (value: string | undefined) => value === undefined ? undefined : canonicalExtensionProviderPath(value);
  if (current.binding.bindingFingerprint !== stored.binding.bindingFingerprint ||
      canonical(current.binding.homeDir) !== canonical(stored.binding.homeDir) ||
      canonical(current.binding.claudeMcpFile) !== canonical(stored.binding.claudeMcpFile) ||
      current.binding.apps.length !== stored.binding.apps.length || current.binding.apps.some(app => canonical(current.binding.appDirs[app]) !== canonical(stored.binding.appDirs[app])) ||
      JSON.stringify([...current.binding.physicalRoots].sort()) !== JSON.stringify([...stored.binding.physicalRoots].sort()))
    throw new ExtensionError(409, "external_binding_changed", "The external target registration or native path identity changed. Explicitly rebind its current targets.");
}
