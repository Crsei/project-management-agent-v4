import { getProviderInstanceDisplayName, getProviderSecretConfigKeys } from "@agent-workspace/client-runtime/providers";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ModelCapabilities } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { resolveProviderNativeHome } from "./t3code/native-paths.ts";
import { dataDirectory, projectDirectory } from "../paths.ts";
import type { ProviderConfig, ProviderDriver, ProviderInstanceInput, ProviderInstanceUpdate, ProviderCustomModel, ProviderInstallation, ProviderModel, ProviderTestResult, ProviderModelPreferences } from "@agent-workspace/contracts/provider";
import type { ProviderDriverContext } from "./driver-adapter.ts";
import { getNativeProviderAdapter, nativeProviderAdapters } from "./driver-registry.ts";
import { expandNativePath } from "./drivers/codex-config.ts";
import { migrateCodexManagedState } from "./t3code/families/codex-persistence.ts";
import { readPreparedAcpRegistryConfigMigration } from "./t3code/families/acp-registry-migration.ts";
import { beginProviderMaintenance } from "./auth.ts";

export type ProviderObservations = {
  instanceRevision: number;
  lastConnectionTest?: ProviderTestResult | undefined;
  installation?: ProviderInstallation | undefined;
  discoveredModels?: ProviderModel[] | undefined;
};
const OptionSelectionSchema = z.object({ id: z.string().min(1).max(200), value: z.union([z.string(), z.boolean()]) }).strict();
// The original schema owns model/option shape; PM retains only its bounded-input invariants.
const ModelCapabilitiesSchema = z.unknown().transform((value, ctx) => {
  try {
    const capabilities = Schema.decodeUnknownSync(ModelCapabilities)(value, { onExcessProperty: "error" });
    const descriptors = capabilities.optionDescriptors ?? [];
    if (descriptors.length > 100 || new Set(descriptors.map(option => option.id)).size !== descriptors.length)
      throw new Error("Invalid or duplicate model option IDs.");
    for (const descriptor of descriptors) {
      if (descriptor.id.length > 200 || descriptor.label.length > 200 || (descriptor.description?.length ?? 0) > 2000)
        throw new Error("Model option exceeds the PM input limit.");
      if (descriptor.type !== "select") continue;
      const ids = descriptor.options.map(option => option.id);
      if (ids.length === 0 || ids.length > 100 || new Set(ids).size !== ids.length
        || descriptor.options.filter(option => option.isDefault).length > 1
        || (descriptor.currentValue !== undefined && !ids.includes(descriptor.currentValue))
        || (descriptor.promptInjectedValues?.length ?? 0) > 100
        || descriptor.promptInjectedValues?.some(option => !ids.includes(option))
        || descriptor.options.some(option => option.id.length > 200 || option.label.length > 200 || (option.description?.length ?? 0) > 2000))
        throw new Error("Invalid select options or default.");
    }
    return capabilities;
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid model capabilities." });
    return z.NEVER;
  }
});
const ModelPreferencesSchema = z.object({
  hidden: z.array(z.string().min(1).max(200)).max(500),
  order: z.array(z.string().min(1).max(200)).max(500),
  favorites: z.array(z.string().min(1).max(200)).max(500),
  options: z.record(z.string().min(1).max(200), z.array(OptionSelectionSchema).max(100)),
}).strict().refine(value => [value.hidden, value.order, value.favorites].every(list => new Set(list).size === list.length) && Object.values(value.options).every(list => new Set(list.map(option => option.id)).size === list.length), "Duplicate model preferences.");
const CustomModelSchema = z.object({
  // oxlint-disable-next-line no-control-regex -- reject model IDs containing ASCII controls.
  id: z.string().trim().min(1).max(200).regex(/^[^\s\x00-\x1f\x7f]+$/),
  // oxlint-disable-next-line no-control-regex -- labels must not carry terminal controls.
  label: z.string().trim().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/),
  capabilities: ModelCapabilitiesSchema.optional(),
}).strict();
const ModelSchema = CustomModelSchema.extend({ shortName: z.string().optional(), badge: z.literal("new").optional(), subProvider: z.string().optional(), source: z.enum(["builtin", "discovered", "custom"]).optional(), temperature: z.boolean(), reasoning: z.boolean().optional(), isDefault: z.boolean().optional(), legacy: z.boolean().optional(), disabledReason: z.string().optional(), aliases: z.array(z.string().min(1).max(200)).max(100).optional() });
const ObservationsSchema = z.object({
  instanceRevision: z.number().int().positive(),
  discoveredModels: z.array(ModelSchema).max(500).optional(),
  installation: z.object({ status: z.enum(["installed", "not-installed", "unknown", "not-applicable"]), checkedAt: z.string().optional(), version: z.string().optional(), latestVersion: z.string().optional(), updateAvailable: z.boolean().optional(), updateSupported: z.boolean().optional(), executablePath: z.string().optional(), error: z.string().optional() }).optional(),
  lastConnectionTest: z.object({ ok: z.boolean(), latencyMs: z.number().nonnegative(), checkedAt: z.string().optional(), instanceRevision: z.number().int().positive().optional(), kind: z.literal("agent-status").optional(), authentication: z.enum(["authenticated", "unauthenticated", "unknown"]).optional(), nativeSessionReady: z.boolean().optional(), requiresOpenaiAuth: z.boolean().optional(), error: z.string().optional(), models: z.array(ModelSchema).max(500).optional() }).optional(),
});
const ConfigSchema = z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]));
const ActiveInstanceSchema = z.object({
  instanceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/), driver: z.string(), label: z.string().max(120),
  enabled: z.boolean().optional(), accentColor: z.string().optional(), registryIconUrl: z.string().url().optional(), config: ConfigSchema.optional(), env: z.record(z.string(), z.string()).default({}), envSensitivity: z.record(z.string(), z.boolean()).optional(),
  revision: z.number().int().positive(), customModels: z.array(CustomModelSchema).max(100).optional(), modelPreferences: ModelPreferencesSchema.optional(),
  cliHome: z.string().optional(), executable: z.string().optional(), cwd: z.string().optional(),
});
export type StoredProviderInstance = {
  instanceId: string; driver: ProviderDriver; label: string; enabled: boolean; accentColor?: string; registryIconUrl?: string;
  config: ProviderConfig; env: Record<string, string>; envSensitivity?: Record<string, boolean>; revision: number;
  /** Effective native home; external directories are never application-owned. */
  homeDirectory: string;
  /** Application-owned runtime, account and installation artifacts. */
  stateDirectory: string;
  customModels?: ProviderCustomModel[]; modelPreferences?: ProviderModelPreferences; observations?: ProviderObservations;
};
type RawInstance = Record<string, unknown>;
type InstanceFile = Record<string, unknown> & { version: 1; instances: RawInstance[]; revisionClock?: number };
// Native configuration and credential variables are inherited. Loader injection
// and PM/server-only secrets are not part of the native provider environment.
const RESERVED_ENV = /^(?:NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|AGENT_WORKSPACE_.*|AGENT_PM_TOOL_.*|PM_(?:API_URL|SESSION_TOKEN|EMAIL|PASSWORD|ACCESS_FILE|WORKSPACE_ID|AUTOMATION_.*)|DATABASE_URL|T3_MCP_.*|T3_PI_MCP_EXTENSION_PATH)$/i;
export function providerDataDirectory(): string { return dataDirectory(); }
function filePath(): string { return path.join(providerDataDirectory(), "provider-instances.json"); }
export function expandProviderPath(value: string): string {
  return path.resolve(projectDirectory(), expandNativePath(value));
}
function stateDirectory(instanceId: string): string { return path.join(providerDataDirectory(), "provider-homes", instanceId); }
function nativeEnvironment(env: Record<string, string>): NodeJS.ProcessEnv {
  const result = { ...process.env, ...env };
  for (const key of Object.keys(result)) if (RESERVED_ENV.test(key)) delete result[key];
  return result;
}
/** The native runtime's user Home authority, distinct from Codex/Claude configuration homes. */
export function providerUserHome(instance: Pick<StoredProviderInstance, "env">, cwd = projectDirectory()): string {
  const env = nativeEnvironment(instance.env);
  return path.resolve(cwd, env.HOME || env.USERPROFILE || os.homedir());
}
function nativeHome(instanceId: string, driver: ProviderDriver, config: ProviderConfig, environment: Record<string, string>, cwd = projectDirectory()): string {
  const env = nativeEnvironment(environment);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return resolveProviderNativeHome(driver, config, env, cwd, home, stateDirectory(instanceId));
}
function environmentBinding(instance: StoredProviderInstance): string {
  const env = nativeEnvironment(instance.env);
  const shadowBase = instance.driver === "codex" && instance.config.setupMode !== "managed" && instance.config.shadowHomePath && !instance.config.homePath ? env.HOME || env.USERPROFILE || os.homedir() : undefined;
  // The Claude SDK writes its version on first query; that is not an account change.
  const environment = Object.entries(env).filter(([key]) => key !== "CLAUDE_AGENT_SDK_VERSION").sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify([instance.homeDirectory, shadowBase, environment])).digest("hex");
}
function decode(raw: RawInstance): StoredProviderInstance | null {
  const adapter = typeof raw.driver === "string" ? getNativeProviderAdapter(raw.driver) : null;
  if (!adapter) return null;
  const parsed = ActiveInstanceSchema.parse(raw);
  const config = { ...parsed.config };
  if (!parsed.config && (parsed.driver === "codex" || parsed.driver === "claude")) {
    if (parsed.cliHome) config.homePath = parsed.cliHome;
    if (parsed.executable) config.binaryPath = parsed.executable;
  }
  const validated = adapter.validateConfig(config);
  const observations = ObservationsSchema.safeParse(raw.observations);
  return { instanceId: parsed.instanceId, driver: adapter.definition.driver, label: parsed.label,
    enabled: parsed.enabled ?? true, ...(parsed.accentColor ? { accentColor: parsed.accentColor } : {}), ...(parsed.registryIconUrl ? { registryIconUrl: parsed.registryIconUrl } : {}),
    config: validated, env: parsed.env, revision: parsed.revision, homeDirectory: nativeHome(parsed.instanceId, adapter.definition.driver, validated, parsed.env), stateDirectory: stateDirectory(parsed.instanceId),
    ...(parsed.envSensitivity ? { envSensitivity: parsed.envSensitivity } : {}), ...(parsed.customModels ? { customModels: parsed.customModels } : {}), ...(parsed.modelPreferences ? { modelPreferences: parsed.modelPreferences } : {}), ...(observations.success ? { observations: observations.data } : {}) };
}
function encode(instance: StoredProviderInstance, previous?: RawInstance): RawInstance {
  const metadata: RawInstance = {};
  if (previous) for (const [key, value] of Object.entries(previous)) {
    if (!Object.hasOwn(ActiveInstanceSchema.shape, key) && key !== "observations" && key !== "nativeEnvironmentBinding")
      metadata[key] = value;
  }
  const { homeDirectory: _home, stateDirectory: _state, ...stored } = instance;
  return { ...metadata, ...stored, nativeEnvironmentBinding: environmentBinding(instance) };
}

const settingsReaders = new Map<string, number>();
const settingsListeners = new Map<string, Set<() => void>>();
/** Synchronous writers cannot wait inside a durable transaction; retry after the snapshot releases. */
export function assertProviderSettingsWritable(): void {
  if ((settingsReaders.get(providerDataDirectory()) ?? 0) > 0)
    throw Object.assign(new Error("Provider settings are in use; retry the configuration change."), { status: 409, code: "settings_busy" });
}
export function acquireProviderSettingsSnapshot<A>(read: () => A): { value: A; release: () => void } {
  const value = read();
  const root = providerDataDirectory();
  settingsReaders.set(root, (settingsReaders.get(root) ?? 0) + 1);
  let released = false;
  return { value, release: () => {
    if (released) return;
    released = true;
    const count = (settingsReaders.get(root) ?? 1) - 1;
    if (count) settingsReaders.set(root, count); else settingsReaders.delete(root);
  } };
}
export function subscribeProviderSettingsChanges(listener: () => void): () => void {
  const root = providerDataDirectory();
  let listeners = settingsListeners.get(root);
  if (!listeners) { listeners = new Set(); settingsListeners.set(root, listeners); }
  listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) settingsListeners.delete(root); };
}
export function publishProviderSettingsChanges(): void {
  for (const listener of settingsListeners.get(providerDataDirectory()) ?? []) listener();
}
function withSettingsTemporaryFile(file: string, content: string, publish: () => void): void {
  // Only a successful exclusive open gives this operation ownership of the temporary file.
  const descriptor = openSync(file, "wx", 0o600);
  const failures: unknown[] = [];
  try { writeFileSync(descriptor, content); } catch (error) { failures.push(error); }
  try { closeSync(descriptor); } catch (error) { failures.push(error); }
  if (!failures.length) {
    try { publish(); } catch (error) { failures.push(error); }
  }
  try { unlinkSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Provider settings publication and cleanup failed.");
}
function persist(store: InstanceFile, expectedText?: string): void {
  assertProviderSettingsWritable();
  const directory = providerDataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.instances.${randomUUID()}.tmp`);
  withSettingsTemporaryFile(temporary, `${JSON.stringify(store, null, 2)}\n`, () => {
    if (expectedText !== undefined && readFileSync(filePath(), "utf8") !== expectedText)
      throw Object.assign(new Error("Provider settings changed during startup conversion; original data was not overwritten."), { status: 409, code: "settings_changed" });
    renameSync(temporary, filePath());
    chmodSync(filePath(), 0o600);
  });
  publishProviderSettingsChanges();
}
function readInstances(): InstanceFile {
  let text: string;
  try { text = readFileSync(filePath(), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const instances = nativeProviderAdapters.filter((adapter) => adapter.definition.driver === "codex" || adapter.definition.driver === "claude").map((adapter) => {
      const config = adapter.validateConfig({});
      const instance: StoredProviderInstance = { instanceId: adapter.definition.driver, driver: adapter.definition.driver, label: adapter.definition.label, enabled: true, config, env: {}, revision: 1, homeDirectory: nativeHome(adapter.definition.driver, adapter.definition.driver, config, {}), stateDirectory: stateDirectory(adapter.definition.driver) };
      mkdirSync(instance.stateDirectory, { recursive: true, mode: 0o700 });
      return encode(instance);
    });
    const fresh: InstanceFile = { version: 1, instances };
    persist(fresh);
    return fresh;
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
    const store = raw as InstanceFile;
    if (store.version !== 1 || !Array.isArray(store.instances) || (store.revisionClock !== undefined && (!Number.isSafeInteger(store.revisionClock) || store.revisionClock < 0))) throw new Error();
    const ids = new Set<string>();
    for (const entry of store.instances) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.instanceId !== "string" || typeof entry.driver !== "string" || ids.has(entry.instanceId)) throw new Error();
      ids.add(entry.instanceId);
      if (getNativeProviderAdapter(entry.driver)) decode(entry);
    }
    // The cutover and inherited-home/environment changes invalidate both saved
    // checks and revision-bound native continuation; never reuse the old account.
    let changed = false;
    for (const entry of store.instances) {
      const instance = decode(entry);
      if (!instance || entry.nativeEnvironmentBinding === environmentBinding(instance)) continue;
      const revision = nextRevision(store); entry.revision = revision; store.revisionClock = revision;
      entry.nativeEnvironmentBinding = environmentBinding(instance);
      delete entry.observations;
      changed = true;
    }
    if (changed) persist(store);
    return store;
  } catch { throw new Error("Invalid provider instance store; original data was not overwritten."); }
}
function nextRevision(store: InstanceFile): number {
  return Math.max(store.revisionClock ?? 0, 0, ...store.instances.map((entry) => typeof entry.revision === "number" && Number.isSafeInteger(entry.revision) ? entry.revision : 0)) + 1;
}
/** Historical unsupported rows stay opaque on disk and are never executable instances. */
export function listStoredInstances(): StoredProviderInstance[] { return readInstances().instances.flatMap((entry) => { const instance = decode(entry); return instance ? [instance] : []; }); }
export function getStoredInstance(instanceId: string): StoredProviderInstance | null {
  const raw = readInstances().instances.find((entry) => entry.instanceId === instanceId);
  return raw ? decode(raw) : null;
}
export function getProviderSettings(): { revision: number; healthRefreshIntervalSeconds: number } {
  const settings = readInstances().providerSettings;
  if (settings === undefined) return { revision: 1, healthRefreshIntervalSeconds: 300 };
  return z.object({ revision: z.number().int().positive(), healthRefreshIntervalSeconds: z.number().finite().nonnegative() }).strict().parse(settings);
}
export function updateProviderSettings(revision: number, healthRefreshIntervalSeconds: number) {
  const store = readInstances();
  const current = getProviderSettings();
  if (revision !== current.revision) throw Object.assign(new Error("Provider settings changed; reload before saving."), { status: 409 });
  if (!Number.isSafeInteger(healthRefreshIntervalSeconds) || healthRefreshIntervalSeconds < 0 || healthRefreshIntervalSeconds > Number.MAX_SAFE_INTEGER / 1000) throw Object.assign(new Error("Invalid health refresh interval."), { status: 400 });
  const next = { revision: current.revision + 1, healthRefreshIntervalSeconds };
  store.providerSettings = next; persist(store); return next;
}
function field(value: unknown, name: string, max = 4096): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error(`Invalid ${name}.`);
  return value.trim() || undefined;
}
function validate(input: ProviderInstanceInput, old?: StoredProviderInstance): StoredProviderInstance {
  const adapter = getNativeProviderAdapter(input.driver);
  if (!adapter) throw new Error("Unsupported provider driver.");
  const allowed: Record<string, true> = { instanceId: true, driver: true, label: true, enabled: true, accentColor: true, registryIconUrl: true, config: true, environment: true, customModels: true, modelPreferences: true };
  if (Object.keys(input).some((key) => !Object.hasOwn(allowed, key))) throw new Error("Unsupported provider instance field.");
  const instanceId = old?.instanceId ?? field(input.instanceId, "instanceId", 64) ?? `${input.driver}-${randomUUID()}`;
  if (!old && !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(instanceId)) throw new Error("instanceId must start with a letter and contain at most 64 letters, numbers, underscores or dashes.");
  const label = field(input.label, "label", 120) ?? "";
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("Invalid enabled state.");
  const accentColor = field(input.accentColor, "accentColor");
  const registryIconUrl = field(input.registryIconUrl, "registryIconUrl", 2048);
  if (registryIconUrl) { let url: URL; try { url = new URL(registryIconUrl); } catch { throw new Error("Invalid registry icon URL."); } if (url.protocol !== "https:" || url.username || url.password) throw new Error("Registry icon URL must use HTTPS."); }
  const config = { ...old?.config };
  if (input.config !== undefined) {
    if (!input.config || typeof input.config !== "object" || Array.isArray(input.config)) throw new Error("Invalid provider config.");
    for (const [key, value] of Object.entries(input.config)) {
      if (value === null) delete config[key];
      else config[key] = value;
    }
  }
  const validated = adapter.validateConfig(ConfigSchema.parse(config));
  if (adapter.definition.driver !== "codex" && adapter.definition.driver !== "claude")
    for (const key of ["homePath", "shadowHomePath"]) if (typeof validated[key] === "string" && validated[key]) validated[key] = expandProviderPath(validated[key] as string);
  let env = { ...old?.env };
  let envSensitivity = { ...old?.envSensitivity };
  if (input.environment !== undefined) {
    if (!Array.isArray(input.environment) || input.environment.length > 64) throw new Error("Invalid environment list.");
    env = {}; envSensitivity = {};
    for (const entry of input.environment) {
      if (!entry || typeof entry !== "object" || Object.keys(entry).some(key => !["name", "value", "sensitive", "valueRedacted"].includes(key)) || typeof entry.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(entry.name) || RESERVED_ENV.test(entry.name) || Object.hasOwn(env, entry.name)) throw new Error("Invalid, duplicate or reserved environment variable.");
      if (typeof entry.value !== "string" || entry.value.length > 8192 || entry.value.includes("\0") || typeof entry.sensitive !== "boolean" || (entry.valueRedacted !== undefined && typeof entry.valueRedacted !== "boolean")) throw new Error(`Invalid environment variable ${entry.name}.`);
      if (entry.valueRedacted) {
        if (!entry.sensitive || entry.value !== "" || !old || !Object.hasOwn(old.env, entry.name) || old.envSensitivity?.[entry.name] === false) throw new Error("Invalid redacted environment roundtrip.");
        env[entry.name] = old.env[entry.name]!;
      } else env[entry.name] = entry.value;
      envSensitivity[entry.name] = entry.sensitive;
    }
  }
  const models = z.array(CustomModelSchema).max(100).safeParse(input.customModels ?? old?.customModels ?? []);
  if (!models.success) throw new Error("Invalid custom model list.");
  if (adapter.definition.supportsCustomModels === false && input.customModels?.length) throw new Error("This provider does not support custom models.");
  if (new Set(models.data.map((model) => model.id)).size !== models.data.length) throw new Error("Custom model IDs must be unique.");
  const preferences = ModelPreferencesSchema.parse(input.modelPreferences ?? old?.modelPreferences ?? { hidden: [], order: [], favorites: [], options: {} });
  const instance: StoredProviderInstance = { instanceId, driver: adapter.definition.driver, label, enabled: input.enabled ?? old?.enabled ?? true, ...(accentColor ? { accentColor } : {}), ...(registryIconUrl ? { registryIconUrl } : {}), config: validated, env, envSensitivity, revision: 1, customModels: adapter.definition.supportsCustomModels === false ? [] : models.data, modelPreferences: preferences, homeDirectory: nativeHome(instanceId, adapter.definition.driver, validated, env), stateDirectory: stateDirectory(instanceId) };
  return instance;
}
export function createProviderInstance(input: ProviderInstanceInput): StoredProviderInstance {
  if (!getNativeProviderAdapter(input.driver)) throw new Error("Unsupported provider driver.");
  const store = readInstances();
  const instance = validate(input);
  if (store.instances.some((entry) => entry.instanceId === instance.instanceId)) throw new Error("Provider instance already exists.");
  instance.revision = nextRevision(store); store.revisionClock = instance.revision;
  mkdirSync(instance.stateDirectory, { recursive: true, mode: 0o700 });
  store.instances.push(encode(instance)); persist(store); return instance;
}
/** Validate a future instance without reserving an ID or importing credentials. */
export function prepareProviderInstance(input: ProviderInstanceInput): StoredProviderInstance {
  const store = readInstances();
  const instance = validate(input);
  if (store.instances.some(entry => entry.instanceId === instance.instanceId)) throw new Error("Provider instance already exists.");
  mkdirSync(instance.stateDirectory, { recursive: true, mode: 0o700 });
  return instance;
}
export function resetProviderInstance(instanceId: string, expectedRevision: number): StoredProviderInstance | null {
  const store = readInstances();
  const index = store.instances.findIndex(entry => entry.instanceId === instanceId);
  const old = index < 0 ? null : decode(store.instances[index]!);
  if (!old) throw Object.assign(new Error("Unknown provider instance."), { status: 404 });
  const adapter = getNativeProviderAdapter(old.driver)!;
  if (!adapter.definition.defaultInstance || old.instanceId !== old.driver) throw Object.assign(new Error("Only a configured default instance can be reset."), { status: 400 });
  if (old.revision !== expectedRevision) throw Object.assign(new Error("Provider instance changed; reload before resetting."), { status: 409 });
  if (old.driver !== "codex" && old.driver !== "claude") {
    store.revisionClock = nextRevision(store);
    store.instances.splice(index, 1);
    persist(store);
    return null;
  }
  const instance = validate({ instanceId, driver: old.driver, enabled: true }, old);
  instance.config = adapter.validateConfig({});
  instance.env = {}; instance.envSensitivity = {}; instance.customModels = [];
  instance.modelPreferences = { hidden: [], order: [], favorites: [], options: {} };
  instance.homeDirectory = nativeHome(instanceId, old.driver, instance.config, {});
  instance.revision = nextRevision(store); store.revisionClock = instance.revision;
  store.instances[index] = encode(instance, store.instances[index]); persist(store); return instance;
}
export function updateProviderInstance(instanceId: string, input: ProviderInstanceUpdate, expectedRevision?: number): StoredProviderInstance {
  if (Object.hasOwn(input, "driver") || Object.hasOwn(input, "instanceId")) throw new Error("Provider identity and driver cannot be changed.");
  const store = readInstances();
  const index = store.instances.findIndex((entry) => entry.instanceId === instanceId);
  const old = index < 0 ? null : decode(store.instances[index]!);
  if (!old) throw new Error("Unknown or unsupported provider instance.");
  if (expectedRevision !== undefined && expectedRevision !== old.revision) throw Object.assign(new Error("Provider instance changed; reload before saving."), { status: 409 });
  const instance = validate({ driver: old.driver, label: old.label, enabled: old.enabled, ...(old.accentColor ? { accentColor: old.accentColor } : {}), ...(old.registryIconUrl ? { registryIconUrl: old.registryIconUrl } : {}), ...input }, old);
  instance.revision = nextRevision(store); store.revisionClock = instance.revision;
  const displayFields: Record<string, true> = { label: true, enabled: true, accentColor: true, registryIconUrl: true, customModels: true, modelPreferences: true };
  if (Object.keys(input).length > 0 && Object.keys(input).every(key => Object.hasOwn(displayFields, key)) && old.observations?.instanceRevision === old.revision && old.observations.discoveredModels) {
    instance.observations = { instanceRevision: instance.revision, discoveredModels: old.observations.discoveredModels };
  }
  mkdirSync(instance.stateDirectory, { recursive: true, mode: 0o700 });
  store.instances[index] = encode(instance, store.instances[index]); persist(store); return instance;
}
export function deleteProviderInstance(instanceId: string): void {
  const store = readInstances();
  const raw = store.instances.find((entry) => entry.instanceId === instanceId);
  if (raw && !decode(raw)) throw new Error("Unsupported historical provider instance cannot be changed.");
  store.revisionClock = nextRevision(store); store.instances = store.instances.filter((entry) => entry.instanceId !== instanceId);
  // Provider-owned credentials/transcripts and obsolete providers.json are never deleted here.
  persist(store);
}
export function recordProviderObservations(instanceId: string, expectedRevision: number, observations: Omit<ProviderObservations, "instanceRevision">): void {
  const store = readInstances();
  const raw = store.instances.find((entry) => entry.instanceId === instanceId);
  const instance = raw ? decode(raw) : null;
  if (!instance || !instance.enabled) throw new Error("Unknown, disabled or unsupported provider instance.");
  if (instance.revision !== expectedRevision) throw Object.assign(new Error("Provider instance changed during the check; run it again."), { status: 409 });
  raw!.observations = ObservationsSchema.parse({ ...observations, instanceRevision: expectedRevision }); persist(store);
}
function contextEnvironment(instance: StoredProviderInstance, homeDirectory: string): NodeJS.ProcessEnv {
  if (!getNativeProviderAdapter(instance.driver)) throw new Error("Unsupported provider driver.");
  const env = nativeEnvironment(instance.env);
  // Only explicit native config overrides are projected; inherited values stay byte-for-byte native.
  if (instance.driver === "codex" && (instance.config.setupMode === "managed" || instance.config.homePath || instance.config.shadowHomePath)) env.CODEX_HOME = homeDirectory;
  if (instance.driver === "claude" && typeof instance.config.homePath === "string" && instance.config.homePath.trim()) env.CLAUDE_CONFIG_DIR = homeDirectory;
  return env;
}
export function providerEnvironment(instance: StoredProviderInstance): NodeJS.ProcessEnv {
  return contextEnvironment(instance, nativeHome(instance.instanceId, instance.driver, instance.config, instance.env));
}
function makeProviderContext(instance: StoredProviderInstance, cwd = projectDirectory()): ProviderDriverContext {
  const homeDirectory = nativeHome(instance.instanceId, instance.driver, instance.config, instance.env, cwd);
  return { instanceId: instance.instanceId, driver: instance.driver, config: { ...instance.config }, homeDirectory, stateDirectory: instance.stateDirectory, cwd, env: contextEnvironment(instance, homeDirectory), instanceEnvironment: { ...instance.env }, revision: instance.revision,
    ...(instance.customModels === undefined ? {} : { customModels: instance.customModels }) };
}
export function providerContext(instance: StoredProviderInstance, cwd = projectDirectory()): ProviderDriverContext {
  if (!instance.enabled) throw new Error("Provider instance is disabled.");
  return makeProviderContext(instance, cwd);
}

/** History reads retain the same native binding without enabling execution. */
export function providerUsageContext(instance: StoredProviderInstance, cwd = projectDirectory()): ProviderDriverContext {
  return makeProviderContext(instance, cwd);
}

const startupMigrations = new Set<string>();
/** Closed startup transaction: only proven app-private metadata conversions may retain a revision. */
export async function migrateProviderStartupState(): Promise<void> {
  const root = providerDataDirectory();
  if (startupMigrations.has(root))
    throw Object.assign(new Error("Provider startup conversion is already active."), { status: 409, code: "settings_busy" });
  assertProviderSettingsWritable();
  startupMigrations.add(root);
  let snapshot: { release: () => void } | undefined;
  try {
    const captured = acquireProviderSettingsSnapshot(readInstances);
    snapshot = captured;
    const store = captured.value;
    const originalText = readFileSync(filePath(), "utf8");
    const instances = store.instances.flatMap(raw => {
      const instance = decode(raw);
      return instance ? [{ raw, instance, binding: environmentBinding(instance) }] : [];
    });
    const assertUnchanged = () => {
      if (root !== providerDataDirectory() || readFileSync(filePath(), "utf8") !== originalText
        || instances.some(({ instance, binding }) => environmentBinding({
          ...instance, homeDirectory: nativeHome(instance.instanceId, instance.driver, instance.config, instance.env),
        }) !== binding))
        throw Object.assign(new Error("Provider settings or native environment changed during startup conversion."), { status: 409, code: "settings_changed" });
    };
    let changed = false;
    for (const { raw, instance } of instances) {
      if (!(instance.driver === "codex" && instance.config.setupMode === "managed") && instance.driver !== "acpRegistry") continue;
      assertUnchanged();
      const release = beginProviderMaintenance(instance.instanceId);
      try {
        // This private constructor does not enable a disabled stored instance for execution.
        const context = makeProviderContext(instance);
        await migrateCodexManagedState(context);
        const config = await readPreparedAcpRegistryConfigMigration(context);
        assertUnchanged();
        if (!config) continue;
        if (instance.driver !== "acpRegistry" || instance.config.commandPath
          || typeof config.commandPath !== "string" || !path.isAbsolute(config.commandPath)
          || !["binary", "npx", "uvx"].includes(String(config.distribution))
          || !isDeepStrictEqual(config, { ...instance.config, commandPath: config.commandPath, distribution: config.distribution }))
          throw new Error("Startup conversion refused an unexpected effective Provider configuration change.");
        const converted = decode({ ...raw, config });
        if (!converted || converted.homeDirectory !== instance.homeDirectory || environmentBinding(converted) !== environmentBinding(instance))
          throw new Error("Startup conversion refused a native Provider identity change.");
        // Keep the original row, including opaque fields, observations and revision-bound history.
        raw.config = { ...(raw.config as ProviderConfig | undefined), commandPath: config.commandPath, distribution: config.distribution };
        changed = true;
      } finally { release(); }
    }
    assertUnchanged();
    if (changed) {
      // Content-addressed rollback input is immutable, private, and never replaces another backup.
      const digest = createHash("sha256").update(originalText).digest("hex");
      const backup = path.join(root, `provider-instances.before-source-startup-v1.${digest}.json`);
      const temporary = path.join(root, `.instances-backup.${randomUUID()}.tmp`);
      withSettingsTemporaryFile(temporary, originalText, () => {
        try { linkSync(temporary, backup); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        const stat = lstatSync(backup);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
          || (process.getuid && stat.uid !== process.getuid()) || readFileSync(backup, "utf8") !== originalText)
          throw new Error("Startup conversion refused a divergent or unsafe Provider settings backup.");
      });
      assertUnchanged();
      // No await between releasing the in-process settings snapshot and the exact-byte CAS/rename.
      snapshot.release();
      snapshot = undefined;
      persist(store, originalText);
    }
  } finally {
    snapshot?.release();
    startupMigrations.delete(root);
  }
}
export function publicInstanceConfig(instance: StoredProviderInstance) {
  const adapter = getNativeProviderAdapter(instance.driver);
  if (!adapter) throw new Error("Unsupported provider driver.");
  const secretFields = new Set(getProviderSecretConfigKeys(instance.driver));
  const config: ProviderConfig = {};
  const secretConfigKeys: string[] = [];
  for (const [key, value] of Object.entries(instance.config)) {
    if (secretFields.has(key)) { if (value !== "" && value !== false) secretConfigKeys.push(key); }
    else config[key] = value;
  }
  return { instanceId: instance.instanceId, driver: instance.driver, label: getProviderInstanceDisplayName({ instanceId: instance.instanceId, driver: instance.driver, label: instance.label || adapter.definition.label }), enabled: instance.enabled, ...(instance.accentColor ? { accentColor: instance.accentColor } : {}), ...(instance.registryIconUrl ? { registryIconUrl: instance.registryIconUrl } : {}), config, secretConfigKeys: secretConfigKeys.sort(), customModels: adapter.definition.supportsCustomModels === false ? [] : instance.customModels ?? [], modelPreferences: instance.modelPreferences ?? { hidden: [], order: [], favorites: [], options: {} }, environment: Object.keys(instance.env).sort().map(name => { const sensitive = instance.envSensitivity?.[name] ?? true; return { name, value: sensitive ? "" : instance.env[name]!, sensitive, ...(sensitive ? { valueRedacted: true } : {}) }; }), revision: instance.revision };
}
