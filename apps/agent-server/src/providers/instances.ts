import { z } from "zod";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDirectory, projectDirectory } from "../paths.ts";
import type { ProviderConfig, ProviderDriver, ProviderInstanceInput, ProviderInstanceUpdate, ProviderCustomModel, ProviderInstallation, ProviderModel, ProviderTestResult } from "@agent-workspace/contracts/provider";
import type { ProviderDriverContext } from "./driver-adapter.ts";
import { getNativeProviderAdapter, nativeProviderAdapters } from "./driver-registry.ts";

export type ProviderObservations = {
  instanceRevision: number;
  lastConnectionTest?: ProviderTestResult;
  installation?: ProviderInstallation;
  discoveredModels?: ProviderModel[];
};
const CustomModelSchema = z.object({
  // oxlint-disable-next-line no-control-regex -- reject model IDs containing ASCII controls.
  id: z.string().trim().min(1).max(200).regex(/^[^\s\x00-\x1f\x7f]+$/),
  // oxlint-disable-next-line no-control-regex -- labels must not carry terminal controls.
  label: z.string().trim().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/),
}).strict();
const ModelSchema = CustomModelSchema.extend({ source: z.enum(["builtin", "discovered", "custom"]).optional(), temperature: z.boolean(), reasoning: z.boolean().optional() });
const ObservationsSchema = z.object({
  instanceRevision: z.number().int().positive(),
  discoveredModels: z.array(ModelSchema).max(500).optional(),
  installation: z.object({ status: z.enum(["installed", "not-installed", "unknown", "not-applicable"]), checkedAt: z.string().optional(), version: z.string().optional(), executablePath: z.string().optional(), error: z.string().optional() }).optional(),
  lastConnectionTest: z.object({ ok: z.boolean(), latencyMs: z.number().nonnegative(), checkedAt: z.string().optional(), instanceRevision: z.number().int().positive().optional(), kind: z.literal("agent-status").optional(), authentication: z.enum(["authenticated", "unauthenticated", "unknown"]).optional(), error: z.string().optional(), models: z.array(ModelSchema).max(500).optional() }).optional(),
});
const ConfigSchema = z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]));
const ActiveInstanceSchema = z.object({
  instanceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/), driver: z.string(), label: z.string().min(1).max(120),
  enabled: z.boolean().optional(), accentColor: z.string().optional(), config: ConfigSchema.optional(), env: z.record(z.string(), z.string()).default({}),
  revision: z.number().int().positive(), customModels: z.array(CustomModelSchema).max(100).optional(),
  cliHome: z.string().optional(), executable: z.string().optional(), cwd: z.string().optional(),
});
export type StoredProviderInstance = {
  instanceId: string; driver: ProviderDriver; label: string; enabled: boolean; accentColor?: string;
  config: ProviderConfig; env: Record<string, string>; revision: number;
  /** Derived private path, never returned by publicInstanceConfig or persisted as a flat field. */
  homeDirectory: string;
  customModels?: ProviderCustomModel[]; observations?: ProviderObservations;
};
type RawInstance = Record<string, unknown>;
type InstanceFile = Record<string, unknown> & { version: 1; instances: RawInstance[]; revisionClock?: number };
const RESERVED_ENV = /^(?:HOME|USERPROFILE|XDG_.*|CODEX_HOME|CLAUDE_CONFIG_DIR|GROK_HOME|GEMINI_HOME|PI_CODING_AGENT_DIR|NODE_OPTIONS|LD_PRELOAD|DYLD_.*)$/;
const SECRET_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE)/i;
const AMBIENT_PROVIDER_ENV = /^(?:OPENAI|ANTHROPIC|DEEPSEEK|GOOGLE|GEMINI|GROK|XAI|CURSOR|OPENCODE|MUSE|PI_CODING_AGENT|CODEX|CLAUDE)_/;
export function providerDataDirectory(): string { return dataDirectory(); }
function filePath(): string { return path.join(providerDataDirectory(), "provider-instances.json"); }
export function expandProviderPath(value: string): string {
  return path.resolve(projectDirectory(), value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
}
function canonical(value: string): string {
  if (existsSync(value)) return realpathSync(value);
  const parent = path.dirname(value);
  return parent === value ? value : path.join(canonical(parent), path.basename(value));
}
function dedicatedHome(instanceId: string, driver: ProviderDriver, config: ProviderConfig): string {
  const explicit = driver === "codex" && typeof config.shadowHomePath === "string" && config.shadowHomePath
    ? config.shadowHomePath : typeof config.homePath === "string" && config.homePath ? config.homePath : undefined;
  return explicit ? expandProviderPath(explicit) : path.join(providerDataDirectory(), "provider-homes", instanceId);
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
    enabled: parsed.enabled ?? true, ...(parsed.accentColor ? { accentColor: parsed.accentColor } : {}),
    config: validated, env: parsed.env, revision: parsed.revision, homeDirectory: dedicatedHome(parsed.instanceId, adapter.definition.driver, validated),
    ...(parsed.customModels ? { customModels: parsed.customModels } : {}), ...(observations.success ? { observations: observations.data } : {}) };
}
function encode(instance: StoredProviderInstance): RawInstance {
  const { homeDirectory: _home, ...stored } = instance;
  return stored;
}
function persist(store: InstanceFile): void {
  const directory = providerDataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.instances.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, filePath());
  chmodSync(filePath(), 0o600);
}
function readInstances(): InstanceFile {
  let text: string;
  try { text = readFileSync(filePath(), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const instances = nativeProviderAdapters.filter((adapter) => adapter.definition.driver === "codex" || adapter.definition.driver === "claude").map((adapter) => {
      const config = adapter.validateConfig({});
      const instance: StoredProviderInstance = { instanceId: adapter.definition.driver, driver: adapter.definition.driver, label: adapter.definition.label, enabled: true, config, env: {}, revision: 1, homeDirectory: dedicatedHome(adapter.definition.driver, adapter.definition.driver, config) };
      mkdirSync(instance.homeDirectory, { recursive: true, mode: 0o700 });
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
function field(value: unknown, name: string, max = 4096): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error(`Invalid ${name}.`);
  return value.trim() || undefined;
}
function overlaps(left: string, right: string): boolean { return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`); }
function homePaths(instance: StoredProviderInstance): string[] {
  return [...new Set([instance.homeDirectory, ...[instance.config.homePath, instance.config.shadowHomePath].filter((value): value is string => typeof value === "string" && Boolean(value)).map(expandProviderPath)])];
}
function validateHomes(instance: StoredProviderInstance, others: StoredProviderInstance[]): void {
  const globals = [".codex", ".claude", ".cursor", ".grok", ".gemini", ".pi", ".muse", ".config/opencode", ".local/share/opencode"].map((name) => path.join(os.homedir(), name));
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "GEMINI_HOME", "PI_CODING_AGENT_DIR"]) if (process.env[key]) globals.push(expandProviderPath(process.env[key]!));
  const globalPaths = globals.map(canonical);
  for (const home of homePaths(instance)) {
    const resolved = canonical(home);
    if (resolved === canonical(os.homedir()) || resolved === path.parse(resolved).root || globalPaths.some((global) => overlaps(global, resolved)))
      throw new Error("Use a dedicated provider home, not the global account directory.");
    if (others.some((other) => other.instanceId !== instance.instanceId && homePaths(other).some((candidate) => overlaps(canonical(candidate), resolved))))
      throw new Error("This provider home is already bound to another instance or overlaps its directory.");
  }
}
function validate(input: ProviderInstanceInput, others: StoredProviderInstance[], old?: StoredProviderInstance): StoredProviderInstance {
  const adapter = getNativeProviderAdapter(input.driver);
  if (!adapter) throw new Error("Unsupported provider driver.");
  const allowed: Record<string, true> = { instanceId: true, driver: true, label: true, enabled: true, accentColor: true, config: true, env: true, customModels: true };
  if (Object.keys(input).some((key) => !Object.hasOwn(allowed, key))) throw new Error("Unsupported provider instance field.");
  const instanceId = old?.instanceId ?? field(input.instanceId, "instanceId", 80) ?? `${input.driver}-${randomUUID()}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(instanceId)) throw new Error("instanceId must contain only letters, numbers, underscore and dash.");
  const label = field(input.label, "label", 120);
  if (!label) throw new Error("A provider label is required.");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("Invalid enabled state.");
  const accentColor = field(input.accentColor, "accentColor");
  const config = { ...old?.config };
  if (input.config !== undefined) {
    if (!input.config || typeof input.config !== "object" || Array.isArray(input.config)) throw new Error("Invalid provider config.");
    for (const [key, value] of Object.entries(input.config)) {
      if (value === null) delete config[key];
      else config[key] = value;
    }
  }
  const validated = adapter.validateConfig(ConfigSchema.parse(config));
  for (const key of ["homePath", "shadowHomePath"]) if (typeof validated[key] === "string" && validated[key]) validated[key] = expandProviderPath(validated[key] as string);
  const env = { ...old?.env };
  if (input.env !== undefined) {
    if (!input.env || typeof input.env !== "object" || Array.isArray(input.env) || Object.keys(input.env).length > 64) throw new Error("Invalid environment map.");
    for (const [key, value] of Object.entries(input.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || RESERVED_ENV.test(key)) throw new Error(`Environment variable ${key} is reserved or invalid.`);
      if (value === null) delete env[key];
      else if (typeof value !== "string" || value.length > 8192 || value.includes("\0")) throw new Error(`Invalid environment variable ${key}.`);
      else env[key] = value;
    }
  }
  const models = z.array(CustomModelSchema).max(100).safeParse(input.customModels ?? old?.customModels ?? []);
  if (!models.success) throw new Error("Invalid custom model list; use model ID and label only.");
  if (new Set(models.data.map((model) => model.id)).size !== models.data.length) throw new Error("Custom model IDs must be unique.");
  const instance: StoredProviderInstance = { instanceId, driver: adapter.definition.driver, label, enabled: input.enabled ?? old?.enabled ?? true, ...(accentColor ? { accentColor } : {}), config: validated, env, revision: 1, customModels: models.data, homeDirectory: dedicatedHome(instanceId, adapter.definition.driver, validated) };
  validateHomes(instance, others);
  return instance;
}
export function createProviderInstance(input: ProviderInstanceInput): StoredProviderInstance {
  if (!getNativeProviderAdapter(input.driver)) throw new Error("Unsupported provider driver.");
  const store = readInstances();
  const instance = validate(input, store.instances.flatMap((entry) => { const active = decode(entry); return active ? [active] : []; }));
  if (store.instances.some((entry) => entry.instanceId === instance.instanceId)) throw new Error("Provider instance already exists.");
  instance.revision = nextRevision(store); store.revisionClock = instance.revision;
  mkdirSync(instance.homeDirectory, { recursive: true, mode: 0o700 });
  store.instances.push(encode(instance)); persist(store); return instance;
}
export function updateProviderInstance(instanceId: string, input: ProviderInstanceUpdate, expectedRevision?: number): StoredProviderInstance {
  if (Object.hasOwn(input, "driver") || Object.hasOwn(input, "instanceId")) throw new Error("Provider identity and driver cannot be changed.");
  const store = readInstances();
  const index = store.instances.findIndex((entry) => entry.instanceId === instanceId);
  const old = index < 0 ? null : decode(store.instances[index]!);
  if (!old) throw new Error("Unknown or unsupported provider instance.");
  if (expectedRevision !== undefined && expectedRevision !== old.revision) throw Object.assign(new Error("Provider instance changed; reload before saving."), { status: 409 });
  const instance = validate({ driver: old.driver, label: old.label, enabled: old.enabled, ...(old.accentColor ? { accentColor: old.accentColor } : {}), ...input }, store.instances.flatMap((entry) => { const active = decode(entry); return active ? [active] : []; }), old);
  instance.revision = nextRevision(store); store.revisionClock = instance.revision;
  mkdirSync(instance.homeDirectory, { recursive: true, mode: 0o700 });
  store.instances[index] = encode(instance); persist(store); return instance;
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
export function providerEnvironment(instance: StoredProviderInstance): NodeJS.ProcessEnv {
  if (!getNativeProviderAdapter(instance.driver)) throw new Error("Unsupported provider driver.");
  validateHomes(instance, listStoredInstances());
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (SECRET_ENV.test(key) || RESERVED_ENV.test(key) || AMBIENT_PROVIDER_ENV.test(key)) delete env[key];
  for (const [key, value] of Object.entries(instance.env)) if (!RESERVED_ENV.test(key)) env[key] = value;
  env.HOME = instance.homeDirectory; env.USERPROFILE = instance.homeDirectory;
  env.XDG_CONFIG_HOME = path.join(instance.homeDirectory, ".config"); env.XDG_DATA_HOME = path.join(instance.homeDirectory, ".local", "share");
  env.XDG_CACHE_HOME = path.join(instance.homeDirectory, ".cache"); env.XDG_STATE_HOME = path.join(instance.homeDirectory, ".local", "state");
  if (instance.driver === "codex") env.CODEX_HOME = instance.homeDirectory;
  if (instance.driver === "claude") env.CLAUDE_CONFIG_DIR = instance.homeDirectory;
  if (instance.driver === "pi") env.PI_CODING_AGENT_DIR = path.join(instance.homeDirectory, ".pi", "agent");
  if (instance.driver === "grok") env.GROK_HOME = instance.homeDirectory;
  if (instance.driver === "antigravity") env.GEMINI_HOME = instance.homeDirectory;
  return env;
}
export function providerContext(instance: StoredProviderInstance, cwd = projectDirectory()): ProviderDriverContext {
  if (!instance.enabled) throw new Error("Provider instance is disabled.");
  return { instanceId: instance.instanceId, driver: instance.driver, config: { ...instance.config }, homeDirectory: instance.homeDirectory, cwd, env: providerEnvironment(instance), revision: instance.revision };
}
export function publicInstanceConfig(instance: StoredProviderInstance) {
  const adapter = getNativeProviderAdapter(instance.driver);
  if (!adapter) throw new Error("Unsupported provider driver.");
  const secretFields = new Set(adapter.definition.fields.filter((field) => field.type === "password").map((field) => field.key));
  const config: ProviderConfig = {};
  const secretConfigKeys: string[] = [];
  for (const [key, value] of Object.entries(instance.config)) {
    if (secretFields.has(key)) { if (value !== "" && value !== false) secretConfigKeys.push(key); }
    else config[key] = value;
  }
  return { instanceId: instance.instanceId, driver: instance.driver, label: instance.label, enabled: instance.enabled, ...(instance.accentColor ? { accentColor: instance.accentColor } : {}), config, secretConfigKeys: secretConfigKeys.sort(), customModels: instance.customModels ?? [], envKeys: Object.keys(instance.env).sort(), revision: instance.revision };
}
