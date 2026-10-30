import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { getNativeProviderAdapter } from "../providers/driver-registry.ts";
import { validateHubUrl } from "../usage/hubs.ts";

type SecretPolicy = "include" | "exclude";
type JsonObject = Record<string, unknown>;
type Coverage = { records: number; events: number; threads: number; histories: number; messages: number; settings: number; digest: string };
type BundleFile = { path: string; bytes: number; sha256: string };
export type AgentBackupManifest = {
  format: "agent-offline-backup";
  version: 1;
  createdAt: string;
  secrets: SecretPolicy;
  privateData: true;
  coverage: Coverage;
  providerInstances: number;
  files: BundleFile[];
  exclusions: string[];
};
const DATABASE = "workspace.sqlite";
const CONFIG = "provider-instances.json";
const CREDENTIALS = "providers.json";
const USAGE_SOURCES = "usage-sources.json";
const CURSOR_USAGE_CACHE = "cursor-usage-cache.json";
// Rebuildable usage-only projections are deliberately not portable history.
const DERIVED_USAGE_CACHES = ["usage-transcript-cache-v1.json", "native-database-usage-cache-v1.json"];
const derivedUsageCache = (name: string) => DERIVED_USAGE_CACHES.includes(name)
  || DERIVED_USAGE_CACHES.some(file => name.startsWith(`${file}.`) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(name.slice(file.length + 1)));
const HOME_PREFIX = "agent-backup://";
const object = (value: unknown): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid backup structure.");
  return value as JsonObject;
};
function parseObject(text: string): JsonObject {
  try { return object(JSON.parse(text)); }
  catch { throw new Error("Invalid private JSON data; original content was not logged or changed."); }
}
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function regular(filename: string): void {
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error("Backup refuses symlinks, hardlinks and nonregular files.");
}
function readJson(filename: string): JsonObject {
  regular(filename);
  if (lstatSync(filename).size > 16 * 1024 * 1024) throw new Error("Backup metadata is too large.");
  return parseObject(readFileSync(filename, "utf8"));
}
function safeRelative(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")
    || path.posix.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..")
    || !(value === USAGE_SOURCES || value === CURSOR_USAGE_CACHE || /^(?:workspace\.sqlite|provider-instances\.json|providers\.json|provider-homes\/.+)$/.test(value)))
    throw new Error("Unsafe backup member path.");
  return value;
}
/** Resolve existing ancestors without accepting symlinks anywhere in the requested path. */
function safeAbsolute(value: string): string {
  if (!value || value.includes("\0") || value.split(/[\\/]/).includes("..")) throw new Error("Unsafe maintenance path.");
  const absolute = path.resolve(value);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Maintenance paths cannot contain symlinks.");
  }
  return absolute;
}
function separate(left: string, right: string): void {
  const within = (base: string, child: string) => child === base || child.startsWith(`${base}${path.sep}`);
  if (within(left, right) || within(right, left)) throw new Error("Source, backup and restore paths must be separate, not nested.");
}
function directory(value: string): string {
  const absolute = safeAbsolute(value);
  if (!lstatSync(absolute).isDirectory()) throw new Error("Expected an existing directory.");
  return realpathSync(absolute);
}
function livePid(value: unknown): boolean {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error("Invalid recorded owner PID; refusing maintenance.");
  try { process.kill(Number(value), 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM or an uninspectable owner is not evidence that it has stopped.
    throw new Error("Cannot verify recorded owner PID; refusing maintenance.");
  }
}
function assertDatabaseOffline(db: DatabaseSync): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  for (const required of ["records", "run_events", "worker_owner"])
    if (!tables.some((row) => row.name === required)) throw new Error("Unsupported Agent database schema.");
  const owner = db.prepare("SELECT pid FROM worker_owner WHERE singleton = 1").get();
  if (owner && livePid(owner.pid)) throw new Error("Agent database has a live owner. Stop the owning service first; no process was signalled.");
}
function acquireOfflineLock(root: string): () => void {
  const filename = path.join(root, "workspace.lock");
  if (existsSync(filename)) {
    const owner = readJson(filename);
    if (livePid(owner.pid)) throw new Error("Agent is running. Stop the owning service first; no process was signalled.");
    throw new Error("Stale Agent lock found. Verify the stopped owner and remove that stale lock manually; maintenance did not change it.");
  }
  const token = randomUUID();
  const descriptor = openSync(filename, "wx", 0o600);
  try { writeFileSync(descriptor, json({ pid: process.pid, token, kind: "offline-maintenance" })); }
  finally { closeSync(descriptor); }
  const original = lstatSync(filename);
  return () => {
    const actual = lstatSync(filename);
    const owner = readJson(filename);
    if (actual.ino !== original.ino || actual.dev !== original.dev || owner.token !== token || owner.pid !== process.pid)
      throw new Error("Maintenance lock ownership changed; refusing to remove another owner's lock.");
    unlinkSync(filename);
  };
}
function restrictedWrite(filename: string, content: string): void {
  writeFileSync(filename, content, { mode: 0o600, flag: "wx" });
}
function copyRestricted(source: string, target: string): void {
  regular(source);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  chmodSync(target, 0o600);
}
function walk(root: string, prefix = ""): string[] {
  const result: string[] = [];
  for (const name of readdirSync(path.join(root, prefix)).sort()) {
    if (name.includes("\\") || name === "." || name === "..") throw new Error("Unsupported backup file name.");
    const relative = prefix ? `${prefix}/${name}` : name;
    const filename = path.join(root, relative);
    const info = lstatSync(filename);
    if (info.isSymbolicLink()) throw new Error("Backup refuses symbolic links.");
    if (info.isDirectory()) result.push(...walk(root, relative));
    else { regular(filename); result.push(relative); }
  }
  return result;
}
function coverage(db: DatabaseSync): Coverage {
  const hash = createHash("sha256");
  let records = 0, events = 0, threads = 0, histories = 0, messages = 0, settings = 0;
  for (const row of db.prepare("SELECT namespace, key, value FROM records ORDER BY namespace, key").iterate()) {
    hash.update(JSON.stringify([row.namespace, row.key, row.value]));
    records++;
    if (row.namespace === "chat:threads") threads++;
    if (row.namespace === "chat:history") {
      histories++;
      const value = parseObject(String(row.value));
      if (!Array.isArray(value.messages)) throw new Error("Invalid durable history.");
      messages += value.messages.length;
    }
    if (String(row.namespace).includes("settings") || String(row.namespace).includes("defaults")) settings++;
  }
  for (const row of db.prepare("SELECT run_id, seq, event FROM run_events ORDER BY run_id, seq").iterate()) {
    hash.update(JSON.stringify([row.run_id, row.seq, row.event])); events++;
  }
  return { records, events, threads, histories, messages, settings, digest: hash.digest("hex") };
}
function inspectDatabase(filename: string): Coverage {
  regular(filename);
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    assertDatabaseOffline(db);
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== "ok") throw new Error("Agent database integrity verification failed.");
    if (db.prepare("SELECT 1 FROM worker_owner").get()) throw new Error("Backup contains an execution owner.");
    return coverage(db);
  } finally { db.close(); }
}
function validateConfiguration(config: JsonObject): JsonObject[] {
  if (config.version !== 1 || !Array.isArray(config.instances)) throw new Error("Unsupported Provider configuration.");
  const ids = new Set<string>();
  return config.instances.map((entry) => {
    const instance = object(entry);
    if (typeof instance.instanceId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(instance.instanceId)
      || ids.has(instance.instanceId) || typeof instance.driver !== "string" || !instance.driver
      || typeof instance.label !== "string" || !Number.isSafeInteger(instance.revision) || Number(instance.revision) < 1)
      throw new Error("Invalid Provider instance configuration.");
    ids.add(instance.instanceId);
    return instance;
  });
}
function normalizedUsageSources(config: JsonObject, secrets: SecretPolicy): JsonObject {
  if (config.version !== 1 || !Number.isSafeInteger(config.revisionClock) || Number(config.revisionClock) < 0 || !Array.isArray(config.sources))
    throw new Error("Invalid usage source configuration.");
  const ids = new Set<string>();
  const sources = config.sources.map((entry) => {
    const source = object(entry);
    if (typeof source.id !== "string" || !source.id || ids.has(source.id) || source.kind !== "cliproxy"
      || typeof source.label !== "string" || typeof source.url !== "string" || typeof source.enabled !== "boolean"
      || !Number.isSafeInteger(source.revision) || Number(source.revision) < 1 || Number(source.revision) > Number(config.revisionClock)
      || (source.managementKey !== undefined && typeof source.managementKey !== "string"))
      throw new Error("Invalid usage source configuration.");
    ids.add(source.id);
    validateHubUrl(source.url);
    return { id: source.id, kind: source.kind, label: source.label, url: source.url,
      enabled: secrets === "exclude" ? false : source.enabled, revision: source.revision,
      ...(secrets === "include" && source.managementKey !== undefined ? { managementKey: source.managementKey } : {}) };
  });
  return { version: 1, revisionClock: config.revisionClock, sources };
}
function excludedConfigField(driver: string, key: string): boolean {
  return /(?:key|token|secret|password|credential|cookie|url|endpoint|path|args|command)/i.test(key)
    || getNativeProviderAdapter(driver)?.definition.fields.some((field) => field.key === key && field.type === "password") === true;
}
function mappedHome(value: unknown, source: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("Provider Home reference must be an absolute path.");
  const absolute = path.resolve(value);
  const relative = path.relative(source, absolute).split(path.sep).join("/");
  // External native homes are references, never owned backup contents.
  if (!relative.startsWith("provider-homes/") || relative.split("/").some((part) => part === ".." || !part)) return absolute;
  return `${HOME_PREFIX}${safeRelative(relative)}`;
}
function normalizedConfiguration(config: JsonObject, source: string, secrets: SecretPolicy): JsonObject {
  const instances = validateConfiguration(config);
  const providerSettings = config.providerSettings === undefined ? undefined : object(config.providerSettings);
  if (providerSettings && (!Number.isSafeInteger(providerSettings.revision) || Number(providerSettings.revision) < 1
    || !Number.isSafeInteger(providerSettings.healthRefreshIntervalSeconds) || Number(providerSettings.healthRefreshIntervalSeconds) < 0
    || Number(providerSettings.healthRefreshIntervalSeconds) > Number.MAX_SAFE_INTEGER / 1000
    || Object.keys(providerSettings).some((key) => key !== "revision" && key !== "healthRefreshIntervalSeconds")))
    throw new Error("Invalid Provider health settings.");
  return { version: config.version, ...(config.revisionClock !== undefined ? { revisionClock: config.revisionClock } : {}),
    ...(providerSettings ? { providerSettings } : {}),
    instances: instances.map((original) => {
      const native = getNativeProviderAdapter(String(original.driver)) !== null;
      const instance: JsonObject = secrets === "exclude" ? {
        instanceId: original.instanceId, driver: original.driver, label: original.label,
        revision: original.revision, env: {}, envSensitivity: {},
        ...(original.customModels !== undefined ? { customModels: original.customModels } : {}),
        ...(original.modelPreferences !== undefined ? { modelPreferences: original.modelPreferences } : {}),
        ...(native ? { enabled: false, ...(original.accentColor !== undefined ? { accentColor: original.accentColor } : {}) } : {}),
      } : { ...original };
      // Observations belong to a past machine/revision and may contain private diagnostic text.
      delete instance.observations;
      delete instance.nativeEnvironmentBinding;
      if (native && original.config !== undefined) {
        const nativeConfig = { ...object(original.config) };
        if (secrets === "exclude") {
          for (const key of Object.keys(nativeConfig)) if (excludedConfigField(String(original.driver), key)) delete nativeConfig[key];
        } else {
          for (const key of ["homePath", "shadowHomePath"])
            if (nativeConfig[key]) nativeConfig[key] = mappedHome(nativeConfig[key], source);
        }
        instance.config = nativeConfig;
      }
      // Legacy native rows remain decodable without introducing unsupported config fields.
      if (native && original.config === undefined && (original.driver === "codex" || original.driver === "claude") && secrets === "include" && original.cliHome !== undefined) {
        instance.cliHome = mappedHome(original.cliHome, source);
      }
      return instance;
    }) };
}
function relocateConfiguration(bytes: Uint8Array, target: string): string {
  const config = parseObject(Buffer.from(bytes).toString("utf8"));
  for (const instance of validateConfiguration(config)) {
    if (!getNativeProviderAdapter(String(instance.driver))) continue;
    const relocate = (value: unknown): string => {
      if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid provider Home reference.");
      if (!value.startsWith(HOME_PREFIX)) {
        if (!path.isAbsolute(value)) throw new Error("Invalid external provider Home reference.");
        return path.resolve(value);
      }
      const relative = safeRelative(value.slice(HOME_PREFIX.length));
      if (!relative.startsWith("provider-homes/")) throw new Error("Invalid provider home mapping.");
      return path.join(target, relative);
    };
    if (instance.cliHome !== undefined) instance.cliHome = relocate(instance.cliHome);
    if (instance.config !== undefined) {
      const nativeConfig = object(instance.config);
      for (const key of ["homePath", "shadowHomePath"]) if (nativeConfig[key]) nativeConfig[key] = relocate(nativeConfig[key]);
    }
  }
  return json(config);
}
function excludeNativeSessions(db: DatabaseSync): void {
  const update = db.prepare("UPDATE records SET value = ? WHERE namespace = ? AND key = ?");
  for (const row of db.prepare("SELECT namespace, key, value FROM records WHERE namespace IN ('chat:threads', 'chat:generations', 'durable:runs')").all()) {
    const value = parseObject(String(row.value));
    delete value.nativeSession;
    if (row.namespace === "chat:threads") {
      for (const key of ["nativeMessageId", "nativeSystemPrompt", "nativeScope", "pendingFork", "pendingForkScope"])
        delete value[key];
    }
    if (row.namespace === "durable:runs" && Array.isArray(value.steps)) {
      value.steps = value.steps.map((step) => {
        const portable = { ...object(step) };
        delete portable.nativeSession;
        return portable;
      });
    }
    update.run(JSON.stringify(value), row.namespace!, row.key!);
  }
}
function privateBundle(root: string): void {
  if ((lstatSync(root).mode & 0o077) !== 0) throw new Error("Backup directory must be private (0700).");
  for (const relative of walk(root))
    if ((lstatSync(path.join(root, relative)).mode & 0o077) !== 0) throw new Error("Backup files must be private (0600).");
}

/** Filesystem-only private bundle. Never registered as an HTTP route. */
export async function createAgentBackup(options: { source: string; bundle: string; secrets: SecretPolicy; stopped: boolean }): Promise<AgentBackupManifest> {
  if (!options.stopped) throw new Error("Explicit --stopped maintenance acknowledgement is required.");
  if (options.secrets !== "include" && options.secrets !== "exclude") throw new Error("Explicit --secrets include|exclude policy is required.");
  const source = directory(options.source);
  const bundle = safeAbsolute(options.bundle);
  separate(source, bundle);
  if (existsSync(bundle)) throw new Error("Backup destination must not already exist.");
  regular(path.join(source, DATABASE));
  // Check root classification before reading any credentials/home contents.
  for (const name of readdirSync(source)) {
    if (!derivedUsageCache(name) && ![DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`, CONFIG, CREDENTIALS, USAGE_SOURCES, CURSOR_USAGE_CACHE, "provider-homes", "workspace.lock", "agent-restore.json"].includes(name))
      throw new Error("Unclassified Agent data file found; backup refuses to silently omit persistent data.");
  }
  const release = acquireOfflineLock(source);
  let staging: string | undefined;
  try {
    const original = new DatabaseSync(path.join(source, DATABASE), { readOnly: true });
    try {
      assertDatabaseOffline(original);
      staging = mkdtempSync(path.join(path.dirname(bundle), ".agent-backup-"));
      chmodSync(staging, 0o700);
      await backup(original, path.join(staging, DATABASE));
    } finally { original.close(); }
    chmodSync(path.join(staging!, DATABASE), 0o600);
    const snapshot = new DatabaseSync(path.join(staging!, DATABASE));
    try {
      snapshot.exec("PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE; DELETE FROM worker_owner;");
      if (options.secrets === "exclude") excludeNativeSessions(snapshot);
      snapshot.exec("COMMIT;");
    } finally { snapshot.close(); }
    let providerInstances = 0;
    if (existsSync(path.join(source, CONFIG))) {
      const config = normalizedConfiguration(readJson(path.join(source, CONFIG)), source, options.secrets);
      providerInstances = validateConfiguration(config).length;
      restrictedWrite(path.join(staging!, CONFIG), json(config));
    }
    if (existsSync(path.join(source, USAGE_SOURCES))) {
      const sources = normalizedUsageSources(readJson(path.join(source, USAGE_SOURCES)), options.secrets);
      restrictedWrite(path.join(staging!, USAGE_SOURCES), json(sources));
    }
    if (options.secrets === "include") {
      if (existsSync(path.join(source, CREDENTIALS))) copyRestricted(path.join(source, CREDENTIALS), path.join(staging!, CREDENTIALS));
      if (existsSync(path.join(source, CURSOR_USAGE_CACHE))) copyRestricted(path.join(source, CURSOR_USAGE_CACHE), path.join(staging!, CURSOR_USAGE_CACHE));
      const homes = path.join(source, "provider-homes");
      if (existsSync(homes)) {
        directory(homes);
        for (const relative of walk(homes)) copyRestricted(path.join(homes, relative), path.join(staging!, "provider-homes", relative));
      }
    }
    const files = walk(staging!).map((relative) => {
      safeRelative(relative);
      const bytes = readFileSync(path.join(staging!, relative));
      return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
    });
    const manifest: AgentBackupManifest = {
      format: "agent-offline-backup", version: 1, createdAt: new Date().toISOString(), secrets: options.secrets, privateData: true,
      coverage: inspectDatabase(path.join(staging!, DATABASE)), providerInstances, files,
      exclusions: ["PM database, Markdown, attachments and user project/source files (use the existing PM backup separately)",
        ".env.agent and all process/global environment, browser cookies/preferences, external/global provider homes",
        "workspace.lock and worker_owner execution ownership; provider probe observations",
        "rebuildable transcript/database usage scan caches and interrupted atomic-write temporary files",
        ...(options.secrets === "exclude" ? ["providers.json, all provider home contents, instance env and native config secrets/endpoints/executable/argument overrides; native resume/fork references are cleared; providers remain disabled until explicitly reconfigured and enabled; hub management keys are removed and hubs disabled"] : [])],
    };
    restrictedWrite(path.join(staging!, "manifest.json"), json(manifest));
    privateBundle(staging!);
    // Rename only after the bundle has been verified. An existing destination is never replaced.
    if (existsSync(bundle)) throw new Error("Backup destination appeared during maintenance; refusing overwrite.");
    renameSync(staging!, bundle);
    staging = undefined;
    return manifest;
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    release();
  }
}

function loadBundle(value: string): { root: string; manifest: AgentBackupManifest } {
  const root = directory(value);
  privateBundle(root);
  const parsed = readJson(path.join(root, "manifest.json"));
  if (parsed.format !== "agent-offline-backup" || parsed.version !== 1 || parsed.privateData !== true
    || !["include", "exclude"].includes(String(parsed.secrets)) || !Array.isArray(parsed.files)
    || !Array.isArray(parsed.exclusions) || !Number.isSafeInteger(parsed.providerInstances)) throw new Error("Unsupported Agent backup manifest.");
  const manifest = parsed as AgentBackupManifest;
  const paths = new Set<string>();
  for (const entry of manifest.files) {
    const member = object(entry);
    const relative = safeRelative(member.path);
    if (paths.has(relative) || !Number.isSafeInteger(member.bytes) || Number(member.bytes) < 0
      || typeof member.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(member.sha256)) throw new Error("Invalid backup member.");
    paths.add(relative);
    const bytes = readFileSync(path.join(root, relative));
    if (bytes.length !== member.bytes || sha256(bytes) !== member.sha256) throw new Error("Backup file checksum verification failed.");
    if (manifest.secrets === "exclude" && (relative === CREDENTIALS || relative === CURSOR_USAGE_CACHE || relative.startsWith("provider-homes/")))
      throw new Error("Credential-excluded bundle contains credential files.");
  }
  if (!paths.has(DATABASE)) throw new Error("Backup is missing its database.");
  const actual = walk(root).filter((relative) => relative !== "manifest.json");
  if (actual.length !== paths.size || actual.some((relative) => !paths.has(relative))) throw new Error("Backup contains unlisted files.");
  const actualCoverage = inspectDatabase(path.join(root, DATABASE));
  if (JSON.stringify(actualCoverage) !== JSON.stringify(manifest.coverage)) throw new Error("Backup durable data coverage verification failed.");
  const config = paths.has(CONFIG) ? readJson(path.join(root, CONFIG)) : null;
  if ((config ? validateConfiguration(config).length : 0) !== manifest.providerInstances) throw new Error("Backup Provider configuration verification failed.");
  if (paths.has(USAGE_SOURCES)) {
    const sources = readJson(path.join(root, USAGE_SOURCES));
    const normalized = normalizedUsageSources(sources, manifest.secrets);
    if (manifest.secrets === "exclude" && JSON.stringify(sources) !== JSON.stringify(normalized))
      throw new Error("Credential-excluded usage sources contain secrets or enabled hubs.");
  }
  if (config) {
    relocateConfiguration(readFileSync(path.join(root, CONFIG)), path.join(os.tmpdir(), "agent-restore-verification-only"));
    if (manifest.secrets === "exclude") {
      for (const instance of validateConfiguration(config)) {
        if (Object.keys(object(instance.env)).length
          || (instance.envSensitivity !== undefined && Object.keys(object(instance.envSensitivity)).length)
          || ["environment", "apiKeyEnv", "baseUrl", "executable", "observations"].some((key) => key in instance))
          throw new Error("Credential-excluded configuration contains excluded fields.");
        if (instance.config !== undefined && Object.keys(object(instance.config)).some((key) => excludedConfigField(String(instance.driver), key)))
          throw new Error("Credential-excluded native configuration contains excluded fields.");
      }
    }
  }
  return { root, manifest };
}
function compareTarget(bundle: string, target: string, manifest: AgentBackupManifest): Coverage {
  const expected = new Set(manifest.files.map((entry) => entry.path));
  for (const relative of walk(target)) {
    if (relative === "workspace.lock" || relative === "agent-restore.json") continue;
    if (!expected.has(relative)) throw new Error("Restore target contains unverified files.");
  }
  for (const entry of manifest.files) {
    const filename = path.join(target, safeRelative(entry.path));
    regular(filename);
    if ((lstatSync(filename).mode & 0o077) !== 0) throw new Error("Restored files must have restricted permissions.");
    const bytes = readFileSync(filename);
    const expectedHash = entry.path === CONFIG
      ? sha256(relocateConfiguration(readFileSync(path.join(bundle, CONFIG)), target)) : entry.sha256;
    if (sha256(bytes) !== expectedHash) throw new Error("Restored file verification failed.");
  }
  const result = inspectDatabase(path.join(target, DATABASE));
  if (JSON.stringify(result) !== JSON.stringify(manifest.coverage)) throw new Error("Restored histories/settings verification failed.");
  return result;
}

export function restoreAgentBackup(options: { bundle: string; target: string; stopped: boolean }): Coverage {
  if (!options.stopped) throw new Error("Explicit --stopped maintenance acknowledgement is required.");
  const { root, manifest } = loadBundle(options.bundle);
  const target = safeAbsolute(options.target);
  separate(root, target);
  if (existsSync(target)) {
    directory(target);
    if (readdirSync(target).length !== 0) throw new Error("Restore target must be a separate empty directory. Existing data was not changed.");
  } else mkdirSync(target, { mode: 0o700 });
  const release = acquireOfflineLock(target);
  let locked = true;
  let staging: string | undefined;
  try {
    staging = mkdtempSync(path.join(path.dirname(target), ".agent-restore-"));
    chmodSync(staging, 0o700);
    for (const entry of manifest.files) {
      const relative = safeRelative(entry.path);
      if (relative === CONFIG) restrictedWrite(path.join(staging, CONFIG), relocateConfiguration(readFileSync(path.join(root, CONFIG)), target));
      else copyRestricted(path.join(root, relative), path.join(staging, relative));
    }
    // Create only application-owned directories. External native homes remain untouched.
    if (existsSync(path.join(staging, CONFIG))) {
      for (const instance of validateConfiguration(readJson(path.join(staging, CONFIG)))) {
        if (!getNativeProviderAdapter(String(instance.driver))) continue;
        const nativeConfig = instance.config === undefined ? {} : object(instance.config);
        const homes = [path.join(target, "provider-homes", String(instance.instanceId)), instance.cliHome, nativeConfig.homePath, nativeConfig.shadowHomePath];
        for (const home of homes) {
          if (typeof home !== "string" || !home) continue;
          const relative = path.relative(target, home);
          if (!relative.startsWith(`provider-homes${path.sep}`) || relative.split(path.sep).includes("..")) continue;
          mkdirSync(path.join(staging, relative), { recursive: true, mode: 0o700 });
        }
      }
    }
    // Staging config is already mapped to final target; compare it against that explicit mapping.
    for (const entry of manifest.files) {
      const bytes = readFileSync(path.join(staging, entry.path));
      const expectedHash = entry.path === CONFIG ? sha256(relocateConfiguration(readFileSync(path.join(root, CONFIG)), target)) : entry.sha256;
      if (sha256(bytes) !== expectedHash) throw new Error("Isolated restore verification failed.");
    }
    const restored = inspectDatabase(path.join(staging, DATABASE));
    if (JSON.stringify(restored) !== JSON.stringify(manifest.coverage)) throw new Error("Restored histories/settings verification failed.");
    restrictedWrite(path.join(staging, "agent-restore.json"), json({ format: "agent-isolated-restore", version: 1,
      restoredAt: new Date().toISOString(), secrets: manifest.secrets, requiresLogin: manifest.secrets === "exclude",
      backupManifestSha256: sha256(readFileSync(path.join(root, "manifest.json"))), exclusions: manifest.exclusions }));
    release(); locked = false;
    if (readdirSync(target).length !== 0) throw new Error("Restore target changed during maintenance; refusing overwrite.");
    // POSIX rename replaces only the verified empty target atomically; a concurrently populated directory makes it fail.
    renameSync(staging, target); staging = undefined;
    return restored;
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    if (locked) release();
  }
}

export function verifyAgentBackup(options: { bundle: string; target?: string; stopped: boolean }): Coverage {
  if (!options.stopped) throw new Error("Explicit --stopped maintenance acknowledgement is required.");
  const { root, manifest } = loadBundle(options.bundle);
  if (!options.target) return manifest.coverage;
  const target = directory(options.target);
  separate(root, target);
  const release = acquireOfflineLock(target);
  try { return compareTarget(root, target, manifest); }
  finally { release(); }
}
