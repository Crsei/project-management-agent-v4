import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { extensionAppIds, extensionProjectScopeSchema, type ExtensionAppId, type ExtensionContext, type ExtensionDirectory, type ExtensionEvent, type ExtensionFailure, type ExtensionMcpDefinition, type ExtensionMcpManagement, type ExtensionProjectScope, type ExtensionDefinitionReference, type ResolvedExtensionDefinition } from "@agent-workspace/contracts/extensions";
import { validateAutomationMcpEndpoint, validateAutomationPrivateHeaders } from "../../../../../packages/infrastructure/src/automation-integrations.ts";
import { canonicalExtensionProviderPath, invalidateExtensionProviderBindings, listExtensionProviderTargets, resolveRegisteredExtensionProviders, type ExtensionProviderBinding, type ExtensionProviderInvalidation } from "./provider-bindings.ts";
import { isExtensionMutationCommand, parseExtensionCommand, type ExtensionCommand } from "./commands.ts";
import { ExtensionError, ExtensionSidecar } from "./rpc.ts";
import { contextDataDirectory, contextSecretKey, privateDirectory, projectExtensionContextId, readExtensionContexts, saveExtensionContexts, type StoredExtensionContext } from "./storage.ts";
import { definitionFingerprint, hasOperationFailures, mergeMcpDefinitionSecrets, mergeMcpOverrideSecrets, mergeMcpServerSecrets, redactMcpImportPreview, redactMcpManagement, redactMcpServers, redactOperationResult } from "./secrets.ts";
import { assertDefinitionNotReferenced, authorizeExtensionProject, extensionPmCallback, resolveExtensionBrowserScope } from "./pm.ts";
import { assertExtensionHostBindingCurrent, listExternalExtensionTargets, refreshExistingExtensionHostBinding, resolveExtensionHostBinding, type ExtensionHostBindingInput } from "./external-targets.ts";
import { readExtensionMaintenance, saveExtensionMaintenance, type ExtensionMaintenance } from "./maintenance.ts";
import { parseMcpDefinition, parseMcpImportPreview, parseMcpImportResult, parseMcpManagement } from "./mcp-wire.ts";

type RuntimeContext = { stored: StoredExtensionContext; sidecar: ExtensionSidecar; listeners: Set<(event: ExtensionEvent) => void>; queue: Promise<void>; reloadRequired: boolean; operationFailure?: ExtensionFailure; operationWarning: boolean };
type ServerRecord = { id: string; name: string; server: Record<string, unknown>; apps: Record<string, boolean> };
const serverMapSchema = z.record(z.string(), z.object({ id: z.string(), name: z.string(), server: z.record(z.string(), z.unknown()), apps: z.record(z.string(), z.boolean()), description: z.string().optional(), homepage: z.string().optional(), docs: z.string().optional(), tags: z.array(z.string()).optional() }));
const sameScope = (a: ExtensionProjectScope, b: ExtensionProjectScope) => a.actorId === b.actorId && a.workspaceId === b.workspaceId && a.projectId === b.projectId;
function overlaps(a: string, b: string): boolean {
  const relative = path.relative(a, b);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function writableRoots(binding: ExtensionProviderBinding, unifiedOwned = false): string[] {
  const appRoots = Object.values(binding.appDirs).map(root => canonicalExtensionProviderPath(root));
  return binding.physicalRoots.filter(root => root !== binding.unifiedSkillsRoot || unifiedOwned || appRoots.includes(root));
}
function sameBindingRoots(a: ExtensionProviderBinding, b: ExtensionProviderBinding): boolean {
  // Preserve sidecar path spellings while rechecking their physical identity on every operation.
  const canonical = (value: string | undefined) => value === undefined ? undefined : canonicalExtensionProviderPath(value);
  return canonical(a.homeDir) === canonical(b.homeDir) &&
    canonical(a.claudeMcpFile) === canonical(b.claudeMcpFile) &&
    a.apps.length === b.apps.length && a.apps.every(app => b.apps.includes(app) && canonical(a.appDirs[app]) === canonical(b.appDirs[app])) &&
    a.unifiedSkillsRoot === b.unifiedSkillsRoot &&
    JSON.stringify([...a.physicalRoots].sort()) === JSON.stringify([...b.physicalRoots].sort());
}

function ownsProviderTarget(owner: ExtensionProviderBinding, target: ExtensionProviderBinding): boolean {
  const app = target.apps[0]!;
  return canonicalExtensionProviderPath(owner.homeDir) === canonicalExtensionProviderPath(target.homeDir) &&
    owner.appDirs[app] !== undefined &&
    canonicalExtensionProviderPath(owner.appDirs[app]!) === canonicalExtensionProviderPath(target.appDirs[app]!) &&
    (app !== "claude" || (owner.claudeMcpFile !== undefined && target.claudeMcpFile !== undefined &&
      canonicalExtensionProviderPath(owner.claudeMcpFile) === canonicalExtensionProviderPath(target.claudeMcpFile)));
}
function assertNativeApps(context: StoredExtensionContext, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const allowed = context.binding?.apps ?? [];
  for (const [app, enabled] of Object.entries(value)) if (enabled === true && !allowed.includes(app as typeof extensionAppIds[number])) throw new ExtensionError(403, "native_target_unbound", "An enabled application has no authorized native target in this context.");
}

/** One process-owned manager. Definitions and installation algorithms live exclusively in the copied Rust services. */
export class ExtensionHost {
  private contexts?: Promise<Map<string, RuntimeContext>>;
  private registryQueue: Promise<void> = Promise.resolve();
  private maintenance?: ExtensionMaintenance;
  private maintenanceEnding = false;
  private maintenanceQueue: Promise<void> = Promise.resolve();
  private stopped = false;

  private async load(): Promise<Map<string, RuntimeContext>> {
    if (this.stopped) throw new ExtensionError(503, "extension_host_stopping", "The extension host is stopping.");
    if (!this.contexts) this.contexts = Promise.all([readExtensionContexts(), readExtensionMaintenance()]).then(([items, maintenance]) => { this.maintenance = maintenance; return new Map(items.map(stored => [stored.id, this.runtime(stored)])); }).catch(error => { this.contexts = undefined; throw error; });
    return this.contexts;
  }
  private assertProjectMutationAvailable(migrationId?: string): void {
    if (this.maintenance && (this.maintenanceEnding || this.maintenance.migrationId !== migrationId)) throw new ExtensionError(409, "definition_maintenance_active", "Project definitions are excluded by an active reviewed migration. Reconcile or end that same migration before editing.");
  }
  async beginMaintenance(input: ExtensionMaintenance, signal?: AbortSignal): Promise<ExtensionMaintenance> {
    const next = this.maintenanceQueue.then(async () => {
      const contexts = await this.load();
      if (signal?.aborted) throw new ExtensionError(409, "migration_control_aborted", "Migration exclusion control was interrupted; reconcile the same reviewed plan.");
      if (this.maintenance && this.maintenance.migrationId !== input.migrationId) throw new ExtensionError(409, "migration_owner_conflict", "A different reviewed migration owns the definition exclusion gate.");
      this.maintenance = input;
      await saveExtensionMaintenance(input);
      await this.registryQueue;
      await Promise.all([...contexts.values()].filter(runtime => runtime.stored.kind === "project").map(runtime => runtime.queue));
      return input;
    });
    this.maintenanceQueue = next.then(() => undefined, () => undefined);
    return next;
  }
  async endMaintenance(input: ExtensionMaintenance, signal?: AbortSignal): Promise<ExtensionMaintenance> {
    const next = this.maintenanceQueue.then(async () => {
      const contexts = await this.load();
      if (signal?.aborted) throw new ExtensionError(409, "migration_control_aborted", "Migration exclusion control was interrupted; its gate was retained.");
      if (this.maintenance && this.maintenance.migrationId !== input.migrationId) throw new ExtensionError(409, "migration_owner_conflict", "A different reviewed migration owns the definition exclusion gate.");
      if (!this.maintenance) return input;
      this.maintenanceEnding = true;
      try {
        await this.registryQueue;
        await Promise.all([...contexts.values()].filter(runtime => runtime.stored.kind === "project").map(runtime => runtime.queue));
        if (signal?.aborted) throw new ExtensionError(409, "migration_control_aborted", "Migration exclusion control was interrupted; its gate was retained.");
        await saveExtensionMaintenance(undefined);
        this.maintenance = undefined;
        return input;
      } finally { this.maintenanceEnding = false; }
    });
    this.maintenanceQueue = next.then(() => undefined, () => undefined);
    return next;
  }
  private runtime(stored: StoredExtensionContext): RuntimeContext {
    const listeners = new Set<(event: ExtensionEvent) => void>();
    const publish = (event: ExtensionEvent) => {
      if (event.event === "warning") runtime.operationWarning = true;
      for (const listener of listeners) listener(event);
    };
    const runtime: RuntimeContext = { stored, listeners, queue: Promise.resolve(), reloadRequired: false, operationWarning: false, sidecar: new ExtensionSidecar(async () => {
      // A stopped owner's roots may expand during registry publication. Startup
      // waits for that publication before freezing the native child configuration.
      await this.registryQueue;
      if (stored.binding) assertExtensionHostBindingCurrent({ binding: stored.binding, providerBinding: stored.providerBinding, externalTargets: stored.externalTargets });
      const dataDir = contextDataDirectory(stored.id);
      await privateDirectory(path.dirname(dataDir));
      await privateDirectory(dataDir);
      await privateDirectory(path.join(dataDir, "uploads"));
      const homeDir = stored.binding?.homeDir ?? path.join(dataDir, "home");
      if (!stored.binding) await privateDirectory(homeDir);
      return { dataDir, homeDir, appDirs: { ...(stored.binding?.appDirs ?? {}) }, ...(stored.binding?.claudeMcpFile ? { claudeMcpFile: stored.binding.claudeMcpFile } : {}), secretKey: await contextSecretKey(stored) };
    }, publish) };
    return runtime;
  }
  private publish(runtime: RuntimeContext, event: ExtensionEvent): void { for (const listener of runtime.listeners) listener(event); }
  private invalidateProviders(runtime: RuntimeContext, reason: string, migratingStorage = false): ExtensionProviderInvalidation {
    const binding = runtime.stored.binding!;
    const includeUnified = runtime.stored.unifiedSkillsOwned === true || migratingStorage;
    const roots = writableRoots(binding, includeUnified);
    const affected = listExtensionProviderTargets().filter(target => target.physicalRoots.filter(root => root !== target.unifiedSkillsRoot || includeUnified).some(root => roots.some(owned => overlaps(root, owned) || overlaps(owned, root)))).map(target => target.providerInstanceId);
    return invalidateExtensionProviderBindings([...new Set([...binding.providerInstanceIds, ...affected])], reason);
  }
  private async require(id: string): Promise<RuntimeContext> {
    const runtime = (await this.load()).get(id);
    if (!runtime) throw new ExtensionError(404, "context_not_found", "Unknown management context.");
    if (runtime.stored.binding) assertExtensionHostBindingCurrent({ binding: runtime.stored.binding, providerBinding: runtime.stored.providerBinding, externalTargets: runtime.stored.externalTargets });
    return runtime;
  }
  private async serial<T>(runtime: RuntimeContext, work: () => Promise<T>): Promise<T> {
    const next = runtime.queue.then(work, work);
    runtime.queue = next.then(() => undefined, () => undefined);
    return next;
  }
  describe(runtime: RuntimeContext): ExtensionContext {
    const stored = runtime.stored;
    return { id: stored.id, label: stored.label, kind: stored.kind, apps: stored.binding?.apps ?? [], providerInstanceIds: stored.binding?.providerInstanceIds ?? [], externalTargetIds: stored.externalTargets?.map(target => target.id) ?? [], sharedProviderInstanceIds: stored.binding?.sharedProviderInstanceIds ?? [], warnings: stored.binding?.warnings ?? [], unifiedStorageOwned: stored.unifiedSkillsOwned === true, ...(stored.scope ? { scope: { workspaceId: stored.scope.workspaceId, projectId: stored.scope.projectId } } : {}), status: runtime.sidecar.status, ...((runtime.sidecar.lastError ?? runtime.operationFailure) ? { lastError: runtime.sidecar.lastError ?? runtime.operationFailure } : {}), reloadRequired: runtime.reloadRequired };
  }
  async browserContext(id: string, headers: Headers, write = false): Promise<ExtensionContext> {
    const runtime = await this.require(id);
    if (runtime.stored.scope) {
      const resolved = await resolveExtensionBrowserScope(runtime.stored.scope, headers, write);
      if (!sameScope(resolved, runtime.stored.scope)) throw new ExtensionError(403, "context_scope_mismatch", "This management context belongs to a different PM actor or project.");
    }
    return this.describe(runtime);
  }
  async list(headers: Headers, project?: { workspaceId: string; projectId: string }): Promise<{ contexts: ExtensionContext[] }> {
    if (project) {
      const scope = await resolveExtensionBrowserScope(project, headers);
      const { contextId } = await this.ensureProjectContext(scope, false);
      return { contexts: [this.describe(await this.require(contextId))] };
    }
    return { contexts: [...(await this.load()).values()].filter(item => item.stored.kind === "native").map(item => this.describe(item)) };
  }
  targets(): { targets: Array<Record<string, unknown>> } {
    const providerTargets = listExtensionProviderTargets();
    const targets: Array<Record<string, unknown>> = providerTargets.map(({ providerInstanceId, providerRevision, driver, label, app, sharedProviderInstanceIds, bindingFingerprint, nativeMcp, warnings }) => ({ providerInstanceId, providerRevision, driver, label, app, sharedProviderInstanceIds, bindingFingerprint, nativeMcp, warnings }));
    targets.push(...listExternalExtensionTargets().map(target => {
      const sharedProviderInstanceIds = providerTargets.filter(provider => provider.physicalRoots.some(root => target.physicalRoots.some(owned => overlaps(root, owned) || overlaps(owned, root)))).map(provider => provider.providerInstanceId);
      return { externalTargetId: target.id, label: target.label, app: target.app, sharedProviderInstanceIds, bindingFingerprint: target.fingerprint, nativeMcp: "native-config", warnings: ["External CLI target only; this does not add PM Chat Provider support.", ...(sharedProviderInstanceIds.length ? [`Native configuration or Unified Home overlaps Provider instances: ${sharedProviderInstanceIds.join(", ")}.`] : [])] };
    }));
    return { targets };
  }
  /** Prepare metadata for a saved Provider; native configuration and the cc-switch database are untouched. */
  async resolveProviderContext(providerInstanceId: string): Promise<{ context: ExtensionContext }> {
    const next = this.registryQueue.then(async () => {
      const contexts = await this.load();
      const binding = resolveRegisteredExtensionProviders([providerInstanceId]);
      let owner: RuntimeContext | undefined;
      for (const existing of contexts.values()) {
        const owned = existing.stored.binding;
        if (!owned) continue;
        const incomingRoots = writableRoots(binding);
        const ownedRoots = writableRoots(owned, existing.stored.unifiedSkillsOwned);
        if (!incomingRoots.some(root => ownedRoots.some(other => overlaps(root, other) || overlaps(other, root)))) continue;
        if (!ownsProviderTarget(owned, binding) || owner) throw new ExtensionError(409, "native_root_owned", "The Provider overlaps an incompatible management context. Reconcile the existing native root ownership before continuing.");
        owner = existing;
      }
      if (owner) {
        const stored = owner.stored;
        // Associate the selected Provider, and retain only existing Providers which still
        // authorize an exact part of this owner. A moved Provider gets its own context.
        const ids = [...new Set([...stored.binding!.providerInstanceIds, providerInstanceId])];
        const matching = ids.filter(id => {
          try { return ownsProviderTarget(stored.binding!, resolveRegisteredExtensionProviders([id])); }
          catch { return false; }
        });
        let current: ExtensionProviderBinding;
        try { current = resolveRegisteredExtensionProviders(matching); }
        catch { throw new ExtensionError(409, "native_owner_stale", "The existing owner has unavailable or changed Providers. Reconcile its binding without deleting its saved definitions."); }
        const resolved = stored.externalTargets?.length
          ? refreshExistingExtensionHostBinding({ binding: stored.binding!, providerBinding: stored.providerBinding, externalTargets: stored.externalTargets }, current)
          : { binding: current };
        if (!sameBindingRoots(stored.binding!, resolved.binding)) throw new ExtensionError(409, "native_owner_stale", "The existing owner has changed native roots. Reconcile its binding without moving or deleting its saved definitions.");
        const updated: StoredExtensionContext = { ...stored, providerBinding: undefined, ...resolved, binding: { ...resolved.binding, homeDir: stored.binding!.homeDir, appDirs: stored.binding!.appDirs, claudeMcpFile: stored.binding!.claudeMcpFile } };
        if (JSON.stringify(stored) !== JSON.stringify(updated)) {
          await saveExtensionContexts([...contexts.values()].map(item => item === owner ? updated : item.stored));
          // Preserve the runtime, sidecar, queued work and SSE listeners; only same-root authority changes.
          Object.assign(stored, updated);
        }
        return { context: this.describe(owner) };
      }
      const stored: StoredExtensionContext = { id: randomUUID(), label: binding.label, kind: "native", binding, createdAt: new Date().toISOString() };
      await saveExtensionContexts([...contexts.values()].map(item => item.stored).concat(stored));
      const runtime = this.runtime(stored);
      contexts.set(stored.id, runtime);
      return { context: this.describe(runtime) };
    });
    this.registryQueue = next.then(() => undefined, () => undefined);
    return next;
  }
  /** Combine compatible unopened targets, preserving saved libraries and live runtimes. */
  async resolveEnabledProviderContexts(): Promise<{ contexts: ExtensionContext[] }> {
    const next = this.registryQueue.then(async () => {
      const contexts = await this.load();
      const targets = listExtensionProviderTargets();
      const groups: { owner?: RuntimeContext; ids: string[]; binding: ExtensionProviderBinding }[] = [];
      const unowned: typeof targets = [];
      for (const target of targets) {
        const binding = resolveRegisteredExtensionProviders([target.providerInstanceId]);
        const owners = [...contexts.values()].filter(context => context.stored.binding &&
          writableRoots(binding).some(root => writableRoots(context.stored.binding!, context.stored.unifiedSkillsOwned).some(other => overlaps(root, other) || overlaps(other, root))));
        if (owners.length > 1 || owners[0] && !ownsProviderTarget(owners[0].stored.binding!, binding))
          throw new ExtensionError(409, "native_root_owned", "The Provider overlaps an incompatible management context. Reconcile native root ownership before continuing.");
        const owner = owners[0];
        if (!owner) { unowned.push(target); continue; }
        if (owner.stored.externalTargets?.length)
          throw new ExtensionError(409, "native_context_external_targets", "Use the explicitly enrolled context to manage its external targets.");
        const existing = owner.stored.binding!;
        // Validate the pinned old physical identities before considering any expansion.
        // Disabled aliases no longer confer authority, but an enabled same-root
        // instance can retain the complete physical owner without moving its data.
        const currentIds = [...new Set([...existing.providerInstanceIds, target.providerInstanceId])].filter(id =>
          targets.some(candidate => candidate.providerInstanceId === id) && ownsProviderTarget(existing, resolveRegisteredExtensionProviders([id])));
        const current = resolveRegisteredExtensionProviders(currentIds);
        if (!sameBindingRoots(existing, current))
          throw new ExtensionError(409, "native_owner_stale", "An owned native root changed. Reconcile it without moving the saved library.");
        const group = groups.find(item => item.owner === owner);
        if (group) {
          group.ids.push(target.providerInstanceId);
          group.binding = resolveRegisteredExtensionProviders(group.ids);
        } else groups.push({ owner, ids: [target.providerInstanceId], binding });
      }
      for (const target of unowned) {
        const group = groups.find(item => {
          // Rust initialization fixes native paths for the lifetime of its child.
          if (item.owner && item.owner.sidecar.status !== "stopped") return false;
          const binding = item.binding;
          if (canonicalExtensionProviderPath(binding.homeDir) !== canonicalExtensionProviderPath(target.homeDir)) return false;
          const appDir = binding.appDirs[target.app];
          if (appDir !== undefined && canonicalExtensionProviderPath(appDir) !== canonicalExtensionProviderPath(target.appDir)) return false;
          let candidate: ExtensionProviderBinding;
          try { candidate = resolveRegisteredExtensionProviders([...item.ids, target.providerInstanceId]); }
          catch (error) {
            if (error instanceof Error && "code" in error && error.code === "extension_provider_claude_mcp_conflict") return false;
            throw error;
          }
          // Native initialization validates exact Claude spellings, not just canonical
          // roots. A retained owner's Home cannot be rewritten to fit a new target.
          const old = item.owner?.stored.binding;
          const claudeFile = old?.claudeMcpFile ?? candidate.claudeMcpFile;
          const claudeDir = old?.appDirs.claude ?? candidate.appDirs.claude;
          if (claudeFile && claudeFile !== path.join(old?.homeDir ?? candidate.homeDir, ".claude.json") &&
              (!claudeDir || claudeFile !== path.join(claudeDir, ".claude.json"))) return false;
          item.ids.push(target.providerInstanceId);
          item.binding = candidate;
          return true;
        });
        if (!group) groups.push({ ids: [target.providerInstanceId], binding: resolveRegisteredExtensionProviders([target.providerInstanceId]) });
      }
      // Preflight the whole registry before publishing any group, including conflicts
      // between newly discovered targets with different Homes but the same app root.
      const updates = groups.map(group => {
        const { owner, binding } = group;
        if (!owner) return { group, stored: { id: randomUUID(), label: binding.label, kind: "native" as const, binding, createdAt: new Date().toISOString() } };
        const old = owner.stored.binding!;
        if (!old.apps.every(app => binding.apps.includes(app)) ||
            !old.physicalRoots.every(root => binding.physicalRoots.includes(root)) ||
            old.unifiedSkillsRoot !== binding.unifiedSkillsRoot)
          throw new ExtensionError(409, "native_owner_stale", "An owned native root is no longer available. Reconcile the existing context without moving its saved definitions.");
        const stored: StoredExtensionContext = { ...owner.stored, providerBinding: undefined, label: binding.label,
          binding: { ...binding, homeDir: old.homeDir, appDirs: { ...binding.appDirs, ...old.appDirs }, claudeMcpFile: old.claudeMcpFile ?? binding.claudeMcpFile } };
        return { group, stored };
      });
      const planned = [...contexts.values()].map(runtime => updates.find(item => item.group.owner === runtime)?.stored ?? runtime.stored)
        .concat(updates.filter(item => !item.group.owner).map(item => item.stored));
      for (const { stored } of updates) {
        const roots = writableRoots(stored.binding!, stored.unifiedSkillsOwned);
        if (planned.some(other => other.id !== stored.id && other.binding &&
          roots.some(root => writableRoots(other.binding!, other.unifiedSkillsOwned).some(owned => overlaps(root, owned) || overlaps(owned, root)))))
          throw new ExtensionError(409, "native_root_owned", "Separate management contexts cannot own overlapping native roots.");
      }
      if (updates.some(({ group, stored }) => !group.owner || JSON.stringify(group.owner.stored) !== JSON.stringify(stored)))
        await saveExtensionContexts(planned);
      const results = updates.map(({ group, stored }) => {
        if (group.owner) {
          Object.assign(group.owner.stored, stored);
          return this.describe(group.owner);
        }
        const runtime = this.runtime(stored);
        contexts.set(stored.id, runtime);
        return this.describe(runtime);
      });
      return { contexts: results };
    });
    this.registryQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async bind(input: ExtensionHostBindingInput): Promise<{ context: ExtensionContext }> {
    const next = this.registryQueue.then(async () => {
      const contexts = await this.load();
      const resolved = resolveExtensionHostBinding(input);
      const { binding } = resolved;
      for (const existing of contexts.values()) {
        if (!existing.stored.binding) continue;
        if (existing.stored.binding.bindingFingerprint === binding.bindingFingerprint) return { context: this.describe(existing) };
        const incomingRoots = writableRoots(binding);
        const ownedBinding = existing.stored.binding;
        const ownedRoots = writableRoots(ownedBinding, existing.stored.unifiedSkillsOwned);
        if (incomingRoots.some(root => ownedRoots.some(owned => overlaps(root, owned) || overlaps(owned, root)))) throw new ExtensionError(409, "native_root_owned", "Another management context owns an overlapping native configuration root. Select that context or explicitly unbind it first.");
      }
      const stored: StoredExtensionContext = { id: randomUUID(), label: binding.label, kind: "native", ...resolved, createdAt: new Date().toISOString() };
      const runtime = this.runtime(stored);
      await saveExtensionContexts([...contexts.values()].map(item => item.stored).concat(stored));
      contexts.set(stored.id, runtime);
      return { context: this.describe(runtime) };
    });
    this.registryQueue = next.then(() => undefined, () => undefined);
    return next;
  }
  async unbind(id: string): Promise<void> {
    const next = this.registryQueue.then(async () => {
      const contexts = await this.load();
      const runtime = contexts.get(id);
      if (!runtime || runtime.stored.kind !== "native") throw new ExtensionError(404, "native_context_not_found", "Unknown native management context.");
      await runtime.sidecar.close();
      await saveExtensionContexts([...contexts.values()].filter(item => item !== runtime).map(item => item.stored));
      contexts.delete(id);
      // Keep the private database/files for matching backup recovery. Unbinding never edits native application configuration.
    });
    this.registryQueue = next.then(() => undefined, () => undefined);
    await next;
  }
  private async claimUnified(runtime: RuntimeContext): Promise<void> {
    const binding = runtime.stored.binding;
    if (!binding) throw new ExtensionError(403, "native_target_unbound", "Unified storage requires an authorized native user Home.");
    const next = this.registryQueue.then(async () => {
      const contexts = await this.load();
      if (contexts.get(runtime.stored.id) !== runtime) throw new ExtensionError(409, "context_unbound", "This native context was unbound before the operation.");
      for (const other of contexts.values()) {
        if (other === runtime || !other.stored.binding) continue;
        const owner = other.stored.binding;
        const owned = writableRoots(owner, other.stored.unifiedSkillsOwned);
        if (owned.some(root => overlaps(root, binding.unifiedSkillsRoot) || overlaps(binding.unifiedSkillsRoot, root))) throw new ExtensionError(409, "unified_root_owned", "Another context owns the shared Unified skills directory. Use that context or explicitly unbind it before moving this context's storage.");
      }
      if (runtime.stored.unifiedSkillsOwned) return;
      runtime.stored.unifiedSkillsOwned = true;
      try { await saveExtensionContexts([...contexts.values()].map(item => item.stored)); }
      catch (error) { delete runtime.stored.unifiedSkillsOwned; throw error; }
    });
    this.registryQueue = next.then(() => undefined, () => undefined);
    await next;
  }
  async rebind(id: string, input: ExtensionHostBindingInput): Promise<{ context: ExtensionContext }> {
    const next = this.registryQueue.then(async () => {
      const contexts = await this.load();
      const previous = contexts.get(id);
      if (!previous || previous.stored.kind !== "native") throw new ExtensionError(404, "native_context_not_found", "Unknown native management context.");
      const resolved = resolveExtensionHostBinding(input);
      const { binding } = resolved;
      if (previous.stored.unifiedSkillsOwned && previous.stored.binding?.unifiedSkillsRoot !== binding.unifiedSkillsRoot) throw new ExtensionError(409, "unified_owner_changed", "A Unified storage owner cannot be rebound to a different user Home. Migrate its storage back before rebinding.");
      for (const other of contexts.values()) {
        if (other === previous || !other.stored.binding) continue;
        const owner = other.stored.binding;
        const incomingRoots = writableRoots(binding, previous.stored.unifiedSkillsOwned);
        const ownedRoots = writableRoots(owner, other.stored.unifiedSkillsOwned);
        if (incomingRoots.some(root => ownedRoots.some(owned => overlaps(root, owned) || overlaps(owned, root)))) throw new ExtensionError(409, "native_root_owned", "Another context owns an overlapping native root.");
      }
      const stored: StoredExtensionContext = { ...previous.stored, providerBinding: undefined, externalTargets: undefined, label: binding.label, ...resolved };
      await previous.sidecar.close();
      await saveExtensionContexts([...contexts.values()].map(item => item === previous ? stored : item.stored));
      const replacement = this.runtime(stored);
      contexts.set(id, replacement);
      return { context: this.describe(replacement) };
    });
    this.registryQueue = next.then(() => undefined, () => undefined);
    return next;
  }
  async ensureProjectContext(scope: ExtensionProjectScope, write = true, maintenance = false, migrationId?: string): Promise<{ contextId: string }> {
    extensionProjectScopeSchema.parse(scope);
    await this.load();
    if (write) this.assertProjectMutationAvailable(maintenance ? migrationId : undefined);
    await authorizeExtensionProject(scope, write, maintenance);
    const contextId = projectExtensionContextId(scope);
    const next = this.registryQueue.then(async () => {
      const contexts = await this.load();
      const existing = contexts.get(contextId);
      if (existing) {
        if (!existing.stored.scope || !sameScope(scope, existing.stored.scope)) throw new ExtensionError(409, "context_scope_mismatch", "The project management context has a conflicting owner.");
        return { contextId };
      }
      // Validate deployment key availability before creating any project state. No native-key fallback.
      const stored: StoredExtensionContext = { id: contextId, label: `Project ${scope.projectId}`, kind: "project", scope, createdAt: new Date().toISOString() };
      await contextSecretKey(stored);
      await saveExtensionContexts([...contexts.values()].map(item => item.stored).concat(stored));
      contexts.set(contextId, this.runtime(stored));
      return { contextId };
    });
    this.registryQueue = next.then(() => undefined, () => undefined);
    return next;
  }
  async authorizePrivate(scope: ExtensionProjectScope, contextId: string, write = false, maintenance = false): Promise<RuntimeContext> {
    await authorizeExtensionProject(scope, write, maintenance);
    const runtime = await this.require(contextId);
    if (!runtime.stored.scope || !sameScope(scope, runtime.stored.scope) || contextId !== projectExtensionContextId(scope)) throw new ExtensionError(403, "context_scope_mismatch", "Private definition access is restricted to the exact PM actor, workspace and project.");
    return runtime;
  }
  private async servers(runtime: RuntimeContext): Promise<Record<string, ServerRecord>> {
    return serverMapSchema.parse(await runtime.sidecar.invoke("get_mcp_servers"));
  }
  private async management(runtime: RuntimeContext): Promise<ExtensionMcpManagement> {
    const value = parseMcpManagement(await runtime.sidecar.invoke("get_mcp_management"));
    const allowed = runtime.stored.binding?.apps ?? [];
    if (value.boundApps.length !== new Set(value.boundApps).size || value.boundApps.some(app => !allowed.includes(app))) throw new ExtensionError(502, "sidecar_protocol_invalid", "The configuration service returned an unauthorized native target.");
    return value;
  }
  private validateProjectDefinition(runtime: RuntimeContext, definition: ExtensionMcpDefinition): void {
    if (!runtime.stored.scope) return;
    if (Object.keys(definition.server).some(field => !["type", "url", "headers"].includes(field))) throw new ExtensionError(412, "definition_transport_unsupported", "Project definitions support only PM-policy-valid Streamable HTTP endpoints and private headers, not native process configuration.");
    this.resolveServer(runtime.stored.id, definition.id, { [definition.id]: { ...definition, apps: {} } });
  }
  private resolveServer(contextId: string, serverId: string, servers: Record<string, ServerRecord>): ResolvedExtensionDefinition {
    const server = Object.hasOwn(servers, serverId) ? servers[serverId] : undefined;
    if (!server) throw new ExtensionError(404, "definition_not_found", "The managed MCP definition no longer exists.");
    if (!["http", "streamable-http"].includes(String(server.server.type ?? "")) || typeof server.server.url !== "string") throw new ExtensionError(412, "definition_transport_unsupported", "PM scoped execution requires a Streamable HTTP MCP definition.");
    let endpoint: string, headers: Record<string, string>;
    try { endpoint = validateAutomationMcpEndpoint(server.server.url); headers = validateAutomationPrivateHeaders(z.record(z.string(), z.string()).parse(server.server.headers ?? {})); }
    catch { throw new ExtensionError(412, "definition_target_invalid", "The managed definition does not meet the existing PM endpoint and private-header policy."); }
    return { contextId, serverId, configFingerprint: definitionFingerprint(endpoint, headers), transport: "streamable-http", endpoint, headers };
  }
  async resolveDefinition(input: { scope: ExtensionProjectScope; contextId: string; serverId: string }): Promise<ResolvedExtensionDefinition> {
    const runtime = await this.authorizePrivate(input.scope, input.contextId);
    return this.resolveServer(input.contextId, input.serverId, await this.servers(runtime));
  }
  async listDefinitions(scope: ExtensionProjectScope): Promise<{ contextId: string; definitions: ExtensionDefinitionReference[] }> {
    const { contextId } = await this.ensureProjectContext(scope, false);
    const runtime = await this.authorizePrivate(scope, contextId);
    const servers = await this.servers(runtime);
    const definitions: ExtensionDefinitionReference[] = [];
    for (const server of Object.values(servers)) {
      if (!["http", "streamable-http"].includes(String(server.server.type ?? ""))) continue;
      const resolved = this.resolveServer(contextId, server.id, servers);
      definitions.push({ contextId, serverId: server.id, name: server.name, transport: resolved.transport, configFingerprint: resolved.configFingerprint });
    }
    return { contextId, definitions };
  }
  async importDefinition(input: { scope: ExtensionProjectScope; serverId: string; name: string; endpoint: string; headers?: Record<string, string>; migrationId?: string }): Promise<ResolvedExtensionDefinition> {
    const { contextId } = await this.ensureProjectContext(input.scope, true, true, input.migrationId);
    const runtime = await this.authorizePrivate(input.scope, contextId, true, true);
    return this.serial(runtime, async () => {
      this.assertProjectMutationAvailable(input.migrationId);
      await authorizeExtensionProject(input.scope, true, true);
      const endpoint = validateAutomationMcpEndpoint(input.endpoint), headers = validateAutomationPrivateHeaders(input.headers ?? {});
      const existing = await this.servers(runtime);
      const fingerprint = definitionFingerprint(endpoint, headers);
      if (Object.hasOwn(existing, input.serverId)) {
        const resolved = this.resolveServer(contextId, input.serverId, existing);
        if (resolved.configFingerprint !== fingerprint) throw new ExtensionError(409, "definition_import_conflict", "The deterministic migration mapping already exists with different content; it was not overwritten.");
        return resolved;
      }
      await runtime.sidecar.invoke("upsert_mcp_server", { server: { id: input.serverId, name: input.name, server: { type: "http", url: endpoint, headers }, apps: Object.fromEntries(extensionAppIds.map(app => [app, false])) } });
      return this.resolveServer(contextId, input.serverId, await this.servers(runtime));
    });
  }
  async subscribe(id: string, listener: (event: ExtensionEvent) => void): Promise<() => void> {
    const runtime = await this.require(id);
    runtime.listeners.add(listener);
    listener({ event: "status", data: this.describe(runtime) });
    return () => { runtime.listeners.delete(listener); };
  }
  private validateTargets(runtime: RuntimeContext, command: ExtensionCommand, args: Record<string, unknown>): void {
    const stored = runtime.stored;
    if (stored.kind === "project") {
      // Keep this ahead of generic target checks: PM verification is a separate transport/authorization boundary.
      if (command === "start_mcp_connectivity_checks" || command === "cancel_mcp_connectivity_checks") throw new ExtensionError(403, "project_connectivity_requires_pm", "Verify project connections explicitly in Studio. Native probes do not implement PM's pinned-DNS, no-proxy transport and cannot authorize project tools.");
      if (command === "set_mcp_agent_configuration" || command === "toggle_mcp_app" || command === "resync_mcp_to_apps") throw new ExtensionError(403, "project_native_assignment_unavailable", "Project-private definitions have no native Agent targets. Open a registered Provider to manage native assignments.");
      if (command === "preview_mcp_import" || command === "apply_mcp_import") throw new ExtensionError(403, "project_native_import_unavailable", "Native import reads bound user configuration roots; a project-private context has no such authority.");
      if (!["get_mcp_servers", "get_mcp_management", "save_mcp_definition", "upsert_mcp_server", "delete_mcp_server", "get_settings"].includes(command)) throw new ExtensionError(403, "project_native_operation_unavailable", "This project-private context manages eligible HTTP definitions only; native process, filesystem and Skills operations require a bound native context.");
    }
    if (typeof args.app === "string" && !stored.binding?.apps.includes(args.app as ExtensionAppId)) throw new ExtensionError(403, "native_target_unbound", "This application has no authorized native target in the selected context.");
    if (typeof args.currentApp === "string" && !stored.binding?.apps.includes(args.currentApp as ExtensionAppId)) throw new ExtensionError(403, "native_target_unbound", "Installing into this application requires an authorized native target.");
    if (Array.isArray(args.apps)) for (const app of args.apps) if (!stored.binding?.apps.includes(app as ExtensionAppId)) throw new ExtensionError(403, "native_target_unbound", "One of the requested native targets is not bound.");
    if (command === "upsert_mcp_server") assertNativeApps(stored, (args.server as Record<string, unknown>).apps);
    if (command === "import_skills_from_apps") for (const item of args.imports as Array<{ apps: unknown }>) assertNativeApps(stored, item.apps);
  }
  async invoke(id: string, commandName: string, rawArgs: Record<string, unknown>): Promise<unknown> {
    const runtime = await this.require(id);
    const { command, args } = parseExtensionCommand(commandName, rawArgs);
    this.validateTargets(runtime, command, args);
    if (runtime.stored.scope && isExtensionMutationCommand(command)) this.assertProjectMutationAvailable();
    const execute = async () => {
      if ((await this.load()).get(id) !== runtime) throw new ExtensionError(409, "context_binding_changed", "This context changed before the operation. Reopen management for its current Provider or external target.");
      if (runtime.stored.binding) assertExtensionHostBindingCurrent({ binding: runtime.stored.binding, providerBinding: runtime.stored.providerBinding, externalTargets: runtime.stored.externalTargets });
      const mutation = isExtensionMutationCommand(command);
      if (mutation) { runtime.operationWarning = false; this.publish(runtime, { event: "operation", data: { command, state: "running" } }); }
      let uploaded: string | undefined;
      let dispatched = false;
      let completion: Record<string, unknown> | undefined;
      try {
        if (mutation && runtime.stored.scope) {
          this.assertProjectMutationAvailable();
          await authorizeExtensionProject(runtime.stored.scope, true);
        }
        if (mutation && runtime.stored.binding && !command.includes("mcp")) {
          const settings = await runtime.sidecar.invoke("get_settings");
          const requestedLocation = command === "save_settings" ? (args.settings as Record<string, unknown>).skillStorageLocation : undefined;
          if (requestedLocation !== undefined && settings && typeof settings === "object" && "skillStorageLocation" in settings && requestedLocation !== settings.skillStorageLocation) throw new ExtensionError(400, "storage_migration_required", "Use the explicit storage migration operation to change the Skill storage location.");
          if (settings && typeof settings === "object" && "skillStorageLocation" in settings && settings.skillStorageLocation === "unified") await this.claimUnified(runtime);
        }
        if (command === "migrate_skill_storage" && args.target === "unified") await this.claimUnified(runtime);
        if (command === "browse_directory") return await this.browseDirectory(runtime, args);
        if (command === "read_skill_file") return await this.readSkillFile(runtime, args);
        if (command === "delete_mcp_server" && runtime.stored.scope) await assertDefinitionNotReferenced(runtime.stored.scope, id, String(args.id));
        if (command === "upsert_mcp_server") {
          // The strict command schema owns metadata; restoring config masks does not change that shape.
          const incoming = args.server as ServerRecord;
          const existing = await this.servers(runtime);
          const merged = mergeMcpServerSecrets(incoming, Object.hasOwn(existing, incoming.id) ? existing[incoming.id] : undefined, await contextSecretKey(runtime.stored), id) as ServerRecord;
          args.server = merged;
          this.validateProjectDefinition(runtime, merged);
        }
        if (command === "save_mcp_definition") {
          const incoming = args.definition as ExtensionMcpDefinition;
          const existing = await this.servers(runtime);
          const previous = Object.hasOwn(existing, incoming.id) ? existing[incoming.id] : undefined;
          args.definition = mergeMcpDefinitionSecrets(incoming, previous ? parseMcpDefinition(previous) : undefined, await contextSecretKey(runtime.stored), id);
          this.validateProjectDefinition(runtime, args.definition as ExtensionMcpDefinition);
        }
        if (command === "set_mcp_agent_configuration" && args.override !== undefined && args.override !== null) {
          const previous = (await this.management(runtime)).agentConfigurations[String(args.serverId)]?.[args.app as ExtensionAppId];
          args.override = mergeMcpOverrideSecrets(args.override as Record<string, unknown>, previous?.override, await contextSecretKey(runtime.stored), id, String(args.serverId), args.app as ExtensionAppId);
        }
        if (command === "install_skills_from_zip") {
          uploaded = path.join(contextDataDirectory(id), "uploads", `${String(args.uploadId)}.zip`);
          const info = await lstat(uploaded).catch(() => { throw new ExtensionError(404, "upload_not_found", "The authorized ZIP upload does not exist in this context."); });
          if (!info.isFile() || info.isSymbolicLink()) throw new ExtensionError(403, "upload_invalid", "The ZIP upload is not a private regular file.");
          args.zipPath = uploaded;
          delete args.uploadId;
        }
        dispatched = true;
        const result = await runtime.sidecar.invoke(command, args);
        const importResult = command === "apply_mcp_import" ? parseMcpImportResult(result) : undefined;
        if ((command === "save_mcp_definition" || command === "set_mcp_agent_configuration") && result !== null) throw new ExtensionError(502, "sidecar_protocol_invalid", "The configuration service did not confirm the expected MCP mutation result.");
        if (command === "scan_unmanaged_skills") return z.array(z.object({ directory: z.string(), name: z.string(), description: z.string().optional(), foundIn: z.array(z.enum([...extensionAppIds, "agents", "cc-switch"])) })).parse(result);
        if (command === "get_mcp_servers") return redactMcpServers(serverMapSchema.parse(result), await contextSecretKey(runtime.stored), id);
        if (command === "get_mcp_management") {
          const value = parseMcpManagement(result);
          const allowed = runtime.stored.binding?.apps ?? [];
          if (value.boundApps.some(app => !allowed.includes(app))) throw new ExtensionError(502, "sidecar_protocol_invalid", "The configuration service returned an unauthorized native target.");
          return redactMcpManagement(value, await contextSecretKey(runtime.stored), id);
        }
        if (command === "preview_mcp_import") {
          const value = parseMcpImportPreview(result);
          if ([...value.entries.map(entry => entry.sourceApp), ...value.warnings.map(warning => warning.app)].some(app => !runtime.stored.binding?.apps.includes(app))) throw new ExtensionError(502, "sidecar_protocol_invalid", "The configuration service returned an unbound import source.");
          return redactMcpImportPreview(value, await contextSecretKey(runtime.stored), id);
        }
        if (mutation) {
          const partial = runtime.operationWarning || hasOperationFailures(result) || (importResult?.warnings.length ?? 0) > 0;
          if (command === "migrate_skill_storage" && args.target === "cc_switch" && !partial && runtime.stored.unifiedSkillsOwned) {
            const release = this.registryQueue.then(async () => {
              const contexts = await this.load();
              delete runtime.stored.unifiedSkillsOwned;
              try { await saveExtensionContexts([...contexts.values()].map(item => item.stored)); }
              catch (error) { runtime.stored.unifiedSkillsOwned = true; throw error; }
            });
            this.registryQueue = release.then(() => undefined, () => undefined);
            await release;
          }
          runtime.operationFailure = partial ? (importResult ? { code: "mcp_import_warnings", message: "The reviewed import completed with source warnings. Read the per-application warnings and reconcile the current management snapshot." } : { code: "native_projection_partial", message: "Configuration changes were applied, but one or more native projections failed. Read the per-application result before reloading." }) : undefined;
          if (importResult?.applied === 0) {
            completion = { command, state: partial ? "partial" : "completed", configurationSaved: false, nativeFilesWritten: false, reloadRequired: runtime.reloadRequired, ...(runtime.operationFailure ? { message: runtime.operationFailure.message } : {}) };
            return importResult;
          }
          const projection = { filesSynchronized: !partial && command !== "apply_mcp_import", ...(command === "apply_mcp_import" ? { nativeFilesWritten: false, syncReconciliationRequired: true } : {}) };
          if (runtime.stored.binding) {
            const invalidation = this.invalidateProviders(runtime, command, command === "migrate_skill_storage");
            runtime.reloadRequired = true;
            this.publish(runtime, { event: "changed", data: { command, ...invalidation, configurationSaved: true, ...projection, liveSessionsReloaded: false } });
          } else this.publish(runtime, { event: "changed", data: { command, configurationSaved: true, ...projection, liveSessionsReloaded: false } });
          completion = { command, state: partial ? "partial" : "completed", reloadRequired: runtime.reloadRequired, ...(runtime.operationFailure ? { message: runtime.operationFailure.message } : {}) };
        }
        return importResult ?? redactOperationResult(result);
      } catch (error) {
        completion = undefined;
        if (mutation) {
          const importRejected = command === "apply_mcp_import" && error instanceof ExtensionError && ["mcp_import_preview_stale", "mcp_import_selection_invalid", "mcp_import_conflict"].includes(error.code);
          runtime.operationFailure = { code: error instanceof ExtensionError ? error.code : "operation_failed", message: importRejected ? error.message : "The operation failed or its completion is unconfirmed. Read the authoritative state before retrying." };
          this.publish(runtime, { event: "operation", data: { command, state: "failed", error: runtime.operationFailure } });
          if (dispatched && !importRejected) {
            if (runtime.stored.binding) {
              const invalidation = this.invalidateProviders(runtime, `${command}:unconfirmed`, command === "migrate_skill_storage");
              runtime.reloadRequired = true;
              this.publish(runtime, { event: "changed", data: { command, ...invalidation, configurationSaved: "unconfirmed", filesSynchronized: false, liveSessionsReloaded: false } });
            } else this.publish(runtime, { event: "changed", data: { command, configurationSaved: "unconfirmed", filesSynchronized: false, liveSessionsReloaded: false } });
          }
        }
        throw error;
      } finally {
        if (uploaded) await unlink(uploaded).catch(() => undefined);
        // A failed native projection can occur after DAO persistence. Invalidate PM approval after every attempted definition write.
        if (dispatched && mutation && runtime.stored.scope && ["upsert_mcp_server", "save_mcp_definition", "delete_mcp_server"].includes(command)) {
          let configFingerprint: string | undefined;
          const serverId = command === "upsert_mcp_server" ? String((args.server as Record<string, unknown>).id) : command === "save_mcp_definition" ? String((args.definition as ExtensionMcpDefinition).id) : typeof args.id === "string" ? args.id : undefined;
          if ((command === "upsert_mcp_server" || command === "save_mcp_definition") && serverId) {
            try { configFingerprint = this.resolveServer(id, serverId, await this.servers(runtime)).configFingerprint; }
            catch { /* Unknown or invalid authoritative state keeps deletion reservations and approval fail-closed. */ }
          }
          try { await extensionPmCallback("invalidate", { scope: runtime.stored.scope, contextId: id, ...(serverId ? { serverId } : {}), ...(configFingerprint ? { configFingerprint } : {}) }); }
          catch {
            runtime.operationFailure = { code: "approval_invalidation_unconfirmed", message: "The definition operation may have been saved, but PM approval invalidation could not be confirmed. Do not execute it until PM authority is reconciled." };
            this.publish(runtime, { event: "operation", data: { command, state: "failed", error: runtime.operationFailure } });
            throw new ExtensionError(503, runtime.operationFailure.code, runtime.operationFailure.message);
          }
        }
        if (completion) this.publish(runtime, { event: "operation", data: completion });
      }
    };
    return isExtensionMutationCommand(command) ? this.serial(runtime, execute) : execute();
  }
  async upload(id: string, body: ReadableStream<Uint8Array> | null): Promise<{ uploadId: string }> {
    const runtime = await this.require(id);
    if (runtime.stored.kind === "project") throw new ExtensionError(403, "project_native_operation_unavailable", "Native Skills uploads require an authorized native context, not a project-private HTTP definition context.");
    if (!body) throw new ExtensionError(400, "zip_required", "A ZIP request body is required.");
    const uploads = path.join(contextDataDirectory(id), "uploads");
    await privateDirectory(path.dirname(uploads));
    await privateDirectory(uploads);
    const uploadId = randomUUID(), filename = path.join(uploads, `${uploadId}.zip`);
    const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const reader = body.getReader();
    let total = 0;
    let signature = Buffer.alloc(0);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 100 * 1024 * 1024) throw new ExtensionError(413, "zip_too_large", "ZIP uploads are limited to 100 MiB.");
        if (signature.length < 4) signature = Buffer.concat([signature, value]).subarray(0, 4);
        await file.writeFile(value);
      }
      if (signature.length !== 4 || signature[0] !== 0x50 || signature[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(signature[2]!)) throw new ExtensionError(400, "zip_invalid", "The uploaded file is not a ZIP archive.");
      await file.sync();
      return { uploadId };
    } catch (error) { await reader.cancel().catch(() => undefined); await unlink(filename).catch(() => undefined); throw error; }
    finally { await file.close(); reader.releaseLock(); }
  }
  private async skillRoot(runtime: RuntimeContext): Promise<string> {
    const settings = await runtime.sidecar.invoke("get_settings");
    const unified = settings && typeof settings === "object" && "skillStorageLocation" in settings && settings.skillStorageLocation === "unified";
    const root = unified ? path.join(runtime.stored.binding?.homeDir ?? path.join(contextDataDirectory(runtime.stored.id), "home"), ".agents", "skills") : await runtime.sidecar.invoke("get_cc_switch_skills_dir");
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new ExtensionError(502, "skill_root_invalid", "The configuration service did not return an authorized skills root.");
    const expected = unified ? runtime.stored.binding?.unifiedSkillsRoot : path.join(canonicalExtensionProviderPath(contextDataDirectory(runtime.stored.id)), "skills");
    const actual = canonicalExtensionProviderPath(root);
    if (!expected || actual !== expected) throw new ExtensionError(403, "skill_root_unbound", "The skill storage root is not owned by this explicitly authorized context.");
    return root;
  }
  private async contained(root: string, relative: string): Promise<string> {
    const [base, target] = await Promise.all([realpath(root), realpath(path.join(root, relative))]);
    if (!overlaps(base, target)) throw new ExtensionError(403, "skill_path_escape", "The selected path leaves the authorized skill directory.");
    return target;
  }
  private async installedSkillRoot(runtime: RuntimeContext, directory: string): Promise<string> {
    const skills = z.array(z.object({ directory: z.string() }).passthrough()).parse(await runtime.sidecar.invoke("get_installed_skills"));
    if (!skills.some(skill => skill.directory === directory)) throw new ExtensionError(404, "skill_not_installed", "The selected skill is not managed by this context.");
    return this.contained(await this.skillRoot(runtime), directory);
  }
  private async browseDirectory(runtime: RuntimeContext, args: Record<string, unknown>): Promise<ExtensionDirectory> {
    if (args.kind === "skill" && typeof args.directory !== "string") throw new ExtensionError(400, "skill_directory_required", "Select an installed skill directory.");
    const root = args.kind === "skill" ? await this.installedSkillRoot(runtime, String(args.directory)) : await this.skillRoot(runtime);
    if (args.kind === "skills") await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = typeof args.subdirectory === "string" ? await this.contained(root, args.subdirectory) : await realpath(root);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > 2000) throw new ExtensionError(413, "directory_too_large", "The directory has too many entries to display safely.");
    const result: ExtensionDirectory = { label: args.kind === "skill" ? String(args.directory) : "Managed skills", entries: [] };
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isDirectory()) continue;
      const info = entry.isFile() ? await stat(path.join(directory, entry.name)) : undefined;
      result.entries.push({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file", ...(info ? { size: info.size } : {}) });
    }
    return result;
  }
  private async readSkillFile(runtime: RuntimeContext, args: Record<string, unknown>): Promise<{ content: string }> {
    const root = await this.installedSkillRoot(runtime, String(args.directory));
    const filename = await this.contained(root, String(args.file));
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new ExtensionError(413, "skill_file_too_large", "Only regular skill text files up to one MiB can be viewed.");
      const content = await file.readFile("utf8");
      if (content.includes("\0")) throw new ExtensionError(415, "skill_file_binary", "The selected skill file is not a text document.");
      return { content };
    } finally { await file.close(); }
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.contexts) await Promise.all([...(await this.contexts).values()].map(runtime => runtime.sidecar.close()));
  }
}
let host: ExtensionHost | undefined;
export function getExtensionHost(): ExtensionHost { return host ??= new ExtensionHost(); }
export async function stopExtensionHost(): Promise<void> { if (host) { await host.close(); host = undefined; } }
