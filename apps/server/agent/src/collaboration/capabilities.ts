import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentCapabilityBindings, CapabilityManifest } from "@agent-workspace/contracts/collaboration";
import { capabilityManifestSchema } from "@agent-workspace/contracts/collaboration";
import { assertPrivatePath } from "../../../../../packages/pm-core/private-path.ts";
import { computePiDeploymentHash } from "../../../cc-switch-host/src/skills/hash.ts";
import { inspectSkillImportTree } from "../../../cc-switch-host/src/skills/fs.ts";
import { getStoredInstance } from "../providers/instances.ts";
import { getExtensionHost } from "../extensions/service.ts";
import { contextDataDirectory, extensionDataDirectory, readExtensionContexts, type StoredExtensionContext } from "../extensions/storage.ts";
import { listExtensionProviderTargets } from "../extensions/provider-bindings.ts";
import { authorizePmTarget } from "../durable/pm-context.ts";
import { DurableError } from "../durable/errors.ts";

export type CapabilityInput = {
  providerInstanceId: string;
  capabilityBindings: AgentCapabilityBindings;
  workspaceId: string;
  projectId?: string;
  headers?: Headers;
};
type Entry = CapabilityManifest["entries"][number];
type Row = Record<string, unknown>;
const emptyBindings: AgentCapabilityBindings = { restriction: "observe", mcp: [], skills: [], hostTools: [] };
export const capabilityFingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** These adapters accept original collaboration tool names in the existing generation transport. */
export function collaborationHostToolSupport(driver: string): CapabilityManifest["hostTools"] {
  if (["pi", "omp"].includes(driver)) return {
    supported: false,
    reason: `${driver} currently admits only pm_* generation host tools. delegate_task/ask_agent require a reviewed upstream adapter change; aliases are not permitted.`,
  };
  if (["codex", "claude", "cursor", "grok", "fx", "antigravity", "acpRegistry", "muse", "opencode"].includes(driver))
    return { supported: true, reason: driver === "muse" ? "Requires the native Muse sessionMcp capability; native admission still applies." : null };
  return { supported: false, reason: "This Provider has no implemented generation-owned collaboration tool transport." };
}

function exists(filename: string): boolean {
  try { lstatSync(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function privateFile(filename: string): void {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new DurableError(503, "capability_storage_unavailable", "Capability inventory storage is not a regular private file.");
  assertPrivatePath(filename);
}
function baseEntry(kind: Entry["kind"], referenceId: string, contextId: string | null): Entry {
  return { kind, referenceId, contextId, installed: "unknown", assigned: "unknown", authorized: "unknown", discovered: "unknown", loaded: "unknown", configFingerprint: null, schemaFingerprint: null, contentFingerprint: null, evidence: [] };
}
function safeDirectory(value: unknown): string | null {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\") || value.includes("\0") || value.split("/").some(part => !part || part === "." || part === "..")) return null;
  return value;
}

/** Reads existing protected rows without opening a manager, decrypting secrets, or initializing a DB. */
function contextEntries(context: StoredExtensionContext, app: string | undefined): Entry[] {
  const databaseFile = path.join(contextDataDirectory(context.id), "cc-switch.db");
  if (!exists(databaseFile)) return [];
  for (const directory of [path.join(extensionDataDirectory(), "contexts"), contextDataDirectory(context.id)]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DurableError(503, "capability_storage_unavailable", "Capability storage directories cannot be symbolic links.");
    assertPrivatePath(directory);
  }
  privateFile(databaseFile);
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    database.exec("BEGIN");
    const servers = database.prepare("SELECT * FROM mcp_servers ORDER BY id").all() as Row[];
    const overrides = database.prepare("SELECT server_id, app, patch FROM mcp_agent_overrides ORDER BY server_id, app").all() as Row[];
    const skills = database.prepare("SELECT * FROM skills ORDER BY id").all() as Row[];
    const settingsFile = path.join(contextDataDirectory(context.id), "settings.json");
    let location: unknown = "cc_switch";
    if (exists(settingsFile)) {
      privateFile(settingsFile);
      const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Row;
      location = settings.skillStorageLocation ?? "cc_switch";
      if (!["unified", "cc_switch"].includes(String(location))) throw new DurableError(503, "capability_storage_unavailable", "The managed Skill storage setting is invalid.");
    }
    const skillRoot = location === "unified" && context.binding ? context.binding.unifiedSkillsRoot : path.join(contextDataDirectory(context.id), "skills");
    const entries: Entry[] = servers.map(row => ({
      ...baseEntry("mcp", String(row.id), context.id), installed: "yes",
      assigned: app ? row[`enabled_${app}`] === 1 ? "yes" : "no" : "unknown",
      configFingerprint: capabilityFingerprint(["protected-manager-config-v1", row.server_config, overrides.filter(item => item.server_id === row.id && (!app || item.app === app))]),
      evidence: ["Existing manager definition; SHA-256 covers protected persisted config and the selected app override, without decrypting credentials.", "Assignment is native-app metadata, not Agent authorization; schema, discovery and loaded bytes are not observed."],
    }));
    for (const row of skills) {
      const entry = baseEntry("skill", String(row.id), context.id);
      entry.evidence.push("Existing managed Skill record; repository branch and cached content_hash are not immutable version evidence.");
      entry.assigned = !app || app === "pi" || app === "omp" ? "unknown" : row[`enabled_${app}`] === 1 ? "yes" : "no";
      const directory = safeDirectory(row.directory);
      if (directory && exists(path.join(skillRoot, directory))) {
        try {
          const tree = inspectSkillImportTree(path.join(skillRoot, directory), skillRoot);
          entry.contentFingerprint = computePiDeploymentHash(tree.root);
          tree.assertUnchanged();
          entry.installed = "yes";
          entry.evidence.push("Fresh SHA-256 full managed tree digest includes hidden entries, empty directories, file types and link text; validated contained links are not a loaded-code proof.");
        } catch {
          entry.evidence.push("The managed content tree could not be safely fingerprinted; content and installation evidence remain unknown.");
        }
      } else entry.installed = "no";
      entries.push(entry);
    }
    return entries;
  } finally { database.close(); }
}

/** Pure inventory: never creates a context, invokes a manager/CLI, probes a remote server or changes shared Home. */
export async function readCapabilityManifest(input: CapabilityInput): Promise<CapabilityManifest> {
  const authority = await authorizePmTarget({ workspaceId: input.workspaceId, projectId: input.projectId ?? null }, input.headers);
  const instance = getStoredInstance(input.providerInstanceId);
  if (!instance?.enabled) throw new DurableError(409, "provider_unavailable", "The selected Provider is missing or disabled.");
  const target = listExtensionProviderTargets().find(item => item.providerInstanceId === instance.instanceId);
  // The existing registry reader only prepares its root. Do not call it when the root does not exist.
  const contexts = exists(extensionDataDirectory()) ? await readExtensionContexts() : [];
  const eligible = contexts.filter(context => context.kind === "native" ? context.binding?.providerInstanceIds.includes(instance.instanceId)
    : context.scope?.workspaceId === input.workspaceId && context.scope.actorId === authority.actorId && input.projectId !== undefined && context.scope.projectId === input.projectId);
  const relevantIds = new Set([
    ...eligible.map(context => context.id),
    ...input.capabilityBindings.mcp.map(item => item.contextId),
    ...input.capabilityBindings.skills.flatMap(item => item.contextId ? [item.contextId] : []),
  ]);
  const entries: Entry[] = [];
  let reloadRequired = false;
  for (const context of eligible) {
    if (!relevantIds.has(context.id)) continue;
    const current = await getExtensionHost().browserContext(context.id, input.headers ?? new Headers());
    reloadRequired ||= current.reloadRequired;
    entries.push(...contextEntries(context, context.kind === "native" ? target?.app : undefined));
  }
  for (const binding of input.capabilityBindings.mcp) {
    if (!entries.some(entry => entry.kind === "mcp" && entry.contextId === binding.contextId && entry.referenceId === binding.serverId))
      entries.push({ ...baseEntry("mcp", binding.serverId, binding.contextId), installed: "no", evidence: ["No matching definition in a currently visible, existing Provider or exact project context. Selection grants no access."] });
  }
  for (const binding of input.capabilityBindings.skills) {
    if (!entries.some(entry => entry.kind === "skill" && entry.contextId === binding.contextId && entry.referenceId === binding.skillId))
      entries.push({ ...baseEntry("skill", binding.skillId, binding.contextId), evidence: ["No safe managed content observation for this reference. Native discovery/loading is unknown."] });
  }
  entries.sort((a, b) => `${a.kind}:${a.contextId}:${a.referenceId}`.localeCompare(`${b.kind}:${b.contextId}:${b.referenceId}`));
  const facts = {
    providerInstanceId: instance.instanceId, providerRevision: instance.revision, providerKind: instance.driver,
    bindingFingerprint: target?.bindingFingerprint ?? null, contextIds: eligible.map(context => context.id).sort(),
    restriction: input.capabilityBindings.restriction, hostTools: collaborationHostToolSupport(instance.driver),
    sharedHome: { shared: target !== undefined, providerInstanceIds: target?.sharedProviderInstanceIds ?? [], reloadRequired }, entries,
    limitations: [
      "Capability bindings are references, not authorization or a native tool/filesystem sandbox.",
      "Native live loading, remote tool schemas and remote implementation versions are unknown; management snapshots do not prove them.",
      "Only existing manager config and safe managed content are fingerprinted. External native configuration changes and late native reads cannot be frozen by this manifest.",
      "Native Home remains an operator-owned shared resource even when no other registered Provider instance is known; the peer list does not enumerate external CLI processes.",
      "Shared Home is never rewritten for per-Agent isolation. Configuration changes may require a new native session; live sessions are not reloaded.",
      ...(input.capabilityBindings.restriction === "observe" ? [] : ["The requested strict restriction cannot be enforced by current native Provider adapters; execution is rejected."]),
    ],
  };
  return capabilityManifestSchema.parse({ ...facts, observedAt: new Date().toISOString(), fingerprint: capabilityFingerprint(facts) });
}

function assertBindings(manifest: CapabilityManifest, bindings: AgentCapabilityBindings): void {
  if (bindings.restriction !== "observe") throw new DurableError(412, "capability_restriction_unsupported", "This Provider cannot enforce only-bound capabilities or immutable loaded versions. Choose observe explicitly or a compatible future adapter.");
  if (bindings.hostTools.length && !manifest.hostTools.supported) throw new DurableError(412, "collaboration_tools_unsupported", manifest.hostTools.reason ?? "Collaboration host tools are unsupported.");
  for (const binding of bindings.mcp) {
    const entry = manifest.entries.find(item => item.kind === "mcp" && item.contextId === binding.contextId && item.referenceId === binding.serverId);
    if (!entry || entry.installed !== "yes") throw new DurableError(409, "capability_binding_unavailable", "A selected MCP definition is not currently available in this scope.");
    if (binding.configFingerprint && entry.configFingerprint !== binding.configFingerprint) throw new DurableError(409, "capability_changed", "The selected MCP configuration changed; explicitly update the Agent version.");
    if (binding.schemaFingerprint && entry.schemaFingerprint !== binding.schemaFingerprint) throw new DurableError(412, "capability_schema_unverified", "A required remote tool schema cannot be verified by this native Provider inventory.");
  }
  for (const binding of bindings.skills) {
    const entry = manifest.entries.find(item => item.kind === "skill" && item.contextId === binding.contextId && item.referenceId === binding.skillId);
    if (!entry || entry.installed !== "yes" || !entry.contentFingerprint) throw new DurableError(409, "capability_content_unverified", "A selected Skill has no safe current managed content evidence.");
    if (binding.contentFingerprint && entry.contentFingerprint !== binding.contentFingerprint) throw new DurableError(409, "capability_changed", "The selected Skill content changed; explicitly update the Agent version.");
  }
}
export async function resolveRunCapabilityFacts(input: CapabilityInput): Promise<CapabilityManifest> {
  const manifest = await readCapabilityManifest(input);
  assertBindings(manifest, input.capabilityBindings);
  return manifest;
}
export async function assertRunCapabilitiesCurrent(manifest: CapabilityManifest, input: CapabilityInput): Promise<void> {
  const current = await resolveRunCapabilityFacts(input);
  if (current.fingerprint !== manifest.fingerprint) throw new DurableError(409, "capability_changed", "Provider revision, bindings or observed capability configuration/content changed. The frozen execution cannot silently adopt the new capability version.");
}
export function defaultCapabilityBindings(): AgentCapabilityBindings { return { ...emptyBindings, mcp: [], skills: [], hostTools: [] }; }
