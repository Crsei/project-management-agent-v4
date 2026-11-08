import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdtemp, open, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertSelfOwnedInstall, validateInstallStamp } from "./install-stamp.mjs";
import { assertPrivatePath, ensurePrivateDirectory } from "./private-state.mjs";

export const UNINSTALL_MODES = Object.freeze(["app-only", "app+runtime", "full", "data-only"]);
export const INSTALL_FILES_NAME = "desktop-install-files.json";
export const INSTALL_STAMP_NAME = "desktop-install-stamp.json";
export const UNINSTALL_GOLDEN = Object.freeze({
  "app-only": Object.freeze({ delete: ["installation:gui", "os:shortcuts", "os:registration"], preserve: ["installation:runtime", "instance:*", "userData:*", "projects:*", "nativeProviderHomes:*"] }),
  "app+runtime": Object.freeze({ delete: ["installation:*", "os:shortcuts", "os:registration"], preserve: ["instance:*", "userData:*", "projects:*", "nativeProviderHomes:*"] }),
  full: Object.freeze({ delete: ["installation:*", "instance:owned-data", "userData:owned-state", "os:shortcuts", "os:registration"], preserve: ["projects:*", "nativeProviderHomes:*", "userData:unknown"] }),
  "data-only": Object.freeze({ delete: ["instance:owned-data", "userData:owned-state"], preserve: ["installation:*", "os:shortcuts", "os:registration", "projects:*", "nativeProviderHomes:*", "userData:unknown"] }),
});
const DATA_NAMES = new Set(["postgres", "managed-postgres.json", "service-ports.json", "bootstrap.json", "agent-data", "chat-spaces", "runtime-home", "local-projects.json", "pm-workspaces", "blobs", "backups", ".postgres-owner.json"]);
const USER_STATE_NAMES = new Set(["connection.json", "window-state.json", "Preferences", "Local State", "Network", "Partitions", "Session Storage", "Local Storage", "IndexedDB", "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "blob_storage", "logs", "Crashpad", "Crash Reports", "Dictionaries"]);
const resourcesPrefix = stamp => stamp.platform === "darwin" ? "Contents/Resources" : "resources";
const runtimeFile = (path, stamp) => {
  const prefix = resourcesPrefix(stamp);
  return path === `${prefix}/${INSTALL_FILES_NAME}` || path === `${prefix}/${INSTALL_STAMP_NAME}` || path === `${prefix}/windows-runtime-dependencies.json` || path.startsWith(`${prefix}/desktop-runtime/`) || path.startsWith(`${prefix}/workspace-runtime/`) || path.startsWith(`${prefix}/desktop-maintenance/`);
};
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const portable = value => value.split(sep).join("/");
const inside = (root, path) => { const name = relative(root, path); return name === "" || name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name); };
function safeRoot(input) {
  if (typeof input !== "string" || !isAbsolute(input) || input.includes("\0") || input !== resolve(input) || input === parse(input).root || process.platform === "win32" && (input.startsWith("\\\\") || input.startsWith("\\\\?\\"))) throw new Error("Uninstall requires an absolute canonical non-root local path.");
  if (process.platform === "win32" && input.slice(parse(input).root.length).split(sep).some(part => /[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Windows device names and path aliases are not uninstall roots.");
  return input;
}
function safeRelative(path) {
  if (typeof path !== "string" || !path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === ".." || /[:<>\"|?*]/.test(part) || /[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Unsafe uninstall manifest path.");
  return path;
}
async function exists(path) { try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function rejectReparse(paths) {
  if (process.platform !== "win32" || !paths.length) return;
  // lstat rejects symlinks/junctions; native attributes also reject every other
  // reparse type. No user profile, PATH command, or remotely fetched helper.
  const script = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $paths=ConvertFrom-Json ([Console]::In.ReadToEnd()); foreach($p in $paths) { if (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point in uninstall path' } }";
  await new Promise((done, fail) => {
    const child = execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 120_000, maxBuffer: 4096, env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } }, error => error ? fail(new Error("Cannot prove uninstall paths are free of Windows reparse points.")) : done());
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(paths));
  });
}
async function ancestors(root) {
  const paths = [];
  for (let current = root; ; current = dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Uninstall path contains a non-directory or link ancestor.");
    paths.push(current);
    if (dirname(current) === current) break;
  }
  await rejectReparse(paths);
}
async function fileHash(path, before, includeIdentity = false) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino) throw new Error("Uninstall file identity changed.");
    const exact = await file.stat({ bigint: true });
    const hash = createHash("sha256");
    for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) throw new Error("Uninstall file changed while snapshotting.");
    const sha256 = hash.digest("hex");
    return includeIdentity ? { sha256, fileIdentity: { dev: String(exact.dev), ino: String(exact.ino) } } : sha256;
  } finally { await file.close(); }
}

export async function captureUninstallSnapshot(input) {
  const root = safeRoot(input);
  await ancestors(root);
  const rootInfo = await lstat(root);
  const rootExact = await lstat(root, { bigint: true });
  const entries = [];
  const paths = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const location = safeRelative(portable(relative(root, path)));
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error("Uninstall snapshot rejects links, shared files and special files.");
      paths.push(path);
      const exactDirectory = info.isDirectory() ? await lstat(path, { bigint: true }) : null;
      const entry = { path: location, type: info.isDirectory() ? "directory" : "file", dev: info.dev, ino: info.ino, ...(info.isFile() ? { bytes: info.size, mtimeMs: info.mtimeMs, ...await fileHash(path, info, true) } : { fileIdentity: { dev: String(exactDirectory.dev), ino: String(exactDirectory.ino) } }) };
      entries.push(entry);
      if (info.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  await rejectReparse(paths);
  const after = await lstat(root);
  if (after.dev !== rootInfo.dev || after.ino !== rootInfo.ino) throw new Error("Uninstall root identity changed.");
  const files = entries.filter(entry => entry.type === "file");
  if (!files.length || !files.some(entry => entry.bytes > 0)) throw new Error("Empty uninstall snapshots are not evidence.");
  return { formatVersion: 1, root, identity: { dev: rootInfo.dev, ino: rootInfo.ino, exact: { dev: String(rootExact.dev), ino: String(rootExact.ino) } }, entries, fileCount: files.length, bytes: files.reduce((sum, entry) => sum + entry.bytes, 0), sha256: digest(entries) };
}

export async function createInstallationManifest(root, stamp) {
  const snapshot = await captureUninstallSnapshot(root);
  return { formatVersion: 1, appId: stamp.appId, commit: stamp.commit, sourceSha256: stamp.source.sha256, directories: snapshot.entries.filter(entry => entry.type === "directory").map(entry => entry.path), files: snapshot.entries.filter(entry => entry.type === "file" && entry.path !== `${resourcesPrefix(stamp)}/${INSTALL_FILES_NAME}`).map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
}

export async function verifyInstallationManifest(root, stamp) {
  const prefix = resourcesPrefix(stamp);
  const snapshot = await captureUninstallSnapshot(root);
  const manifest = JSON.parse(await readFile(join(root, prefix, INSTALL_FILES_NAME), "utf8"));
  const diskStamp = validateInstallStamp(JSON.parse(await readFile(join(root, prefix, INSTALL_STAMP_NAME), "utf8")), { platform: stamp.platform, arch: stamp.arch, version: stamp.version });
  if (JSON.stringify(diskStamp) !== JSON.stringify(stamp) || manifest.formatVersion !== 1 || manifest.appId !== stamp.appId || manifest.commit !== stamp.commit || manifest.sourceSha256 !== stamp.source.sha256 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Installation ownership manifest/stamp mismatch.");
  const expected = new Map(manifest.files.map(entry => [safeRelative(entry.path), entry]));
  if (expected.size !== manifest.files.length) throw new Error("Duplicate install ownership paths.");
  if (!Array.isArray(manifest.directories) || JSON.stringify(snapshot.entries.filter(entry => entry.type === "directory").map(entry => entry.path).sort()) !== JSON.stringify(manifest.directories.map(safeRelative).sort())) throw new Error("Unknown, missing or modified installation directories.");
  for (const entry of snapshot.entries.filter(entry => entry.type === "file")) {
    if (entry.path === `${prefix}/${INSTALL_FILES_NAME}`) continue;
    // NSIS creates this exact product-owned executable after payload assembly.
    // No wildcard, directory prefix, or user-provided filename grants ownership.
    if (entry.path === "Uninstall PM Agent v4.exe" && !expected.has(entry.path)) continue;
    const claimed = expected.get(entry.path);
    if (!claimed || claimed.bytes !== entry.bytes || claimed.sha256 !== entry.sha256) throw new Error("Unknown or modified installation file; refusing tree deletion.");
    expected.delete(entry.path);
  }
  if (expected.size) throw new Error("Installation ownership files are missing.");
  return snapshot;
}
async function snapshotIfPresent(root) { return await exists(root) ? captureUninstallSnapshot(root) : { formatVersion: 1, root, absent: true }; }
async function ownData(dataDir, snapshot) {
  if (snapshot.absent) throw new Error("Deleting data requires a nonempty owned instance snapshot.");
  const state = JSON.parse(await readFile(join(dataDir, "managed-postgres.json"), "utf8"));
  const ports = JSON.parse(await readFile(join(dataDir, "service-ports.json"), "utf8"));
  const cluster = JSON.parse(await readFile(join(dataDir, "postgres", ".desktop-instance.json"), "utf8"));
  if (state.formatVersion !== 1 || state.postgresMajor !== 16 || state.phase !== "ready" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(state.instanceId) || ports.instanceId !== state.instanceId || cluster.formatVersion !== 1 || cluster.instanceId !== state.instanceId || cluster.postgresMajor !== 16) throw new Error("Data ownership does not identify one complete managed instance.");
  await assertPrivatePath(dataDir, true);
  if ((await readFile(join(dataDir, "postgres", "PG_VERSION"), "utf8")).trim() !== "16") throw new Error("PostgreSQL on-disk major is not rollback-compatible.");
  for (const entry of snapshot.entries) if (!DATA_NAMES.has(entry.path.split("/")[0]) && entry.path.split("/")[0] !== "projects") throw new Error("Unknown instance tree; refusing data deletion.");
  if (await exists(join(dataDir, "postgres", "postmaster.pid")) || await exists(join(dataDir, ".postgres-owner.json"))) throw new Error("Managed PostgreSQL still has process ownership state; refusing deletion.");
  return state.instanceId;
}

async function protectedNativeHomes(dataDir, projectRoot) {
  const path = join(dataDir, "agent-data", "provider-instances.json");
  if (!await exists(path)) return [];
  await assertPrivatePath(dirname(path), true);
  const registry = JSON.parse(await readFile(path, "utf8"));
  if (registry?.version !== 1 || !Array.isArray(registry.instances)) throw new Error("Cannot establish native Provider roots from the saved registry.");
  const roots = [];
  for (const instance of registry.instances) {
    const config = instance.config ?? {}, environment = instance.env ?? {};
    const candidates = [instance.cliHome, environment.CODEX_HOME, environment.CLAUDE_CONFIG_DIR];
    if (config.setupMode !== "managed") candidates.push(config.homePath, config.shadowHomePath);
    for (const home of [environment.HOME, environment.USERPROFILE]) if (typeof home === "string" && isAbsolute(home) && inside(dataDir, resolve(home))) candidates.push(home);
    // Only explicit native locations are read; never credentials, session
    // contents, broad HOME prefixes, or a guessed provider-directory name.
    for (let candidate of candidates) {
      if (candidate === undefined || candidate === "") continue;
      if (typeof candidate !== "string") throw new Error("Unknown native Provider path binding.");
      const userHome = environment.HOME || environment.USERPROFILE || homedir();
      if (candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")) candidate = join(userHome, candidate.slice(2));
      if (!isAbsolute(candidate)) {
        const cwd = instance.cwd || projectRoot;
        if (!cwd || !isAbsolute(cwd)) throw new Error("Relative native Provider root cannot be resolved safely; preserve the instance.");
        candidate = resolve(cwd, candidate);
      }
      roots.push(safeRoot(resolve(candidate)));
    }
  }
  return roots;
}

export async function planUninstall({ stamp: input, installRoot: installInput, userDataDir: userInput, dataDir: dataInput, mode, consent, externalRoots = [] }) {
  const stamp = validateInstallStamp(input, { platform: input?.platform, arch: input?.arch, version: input?.version });
  assertSelfOwnedInstall(stamp);
  if (stamp.ownership.scope !== "per-user") throw new Error("Self-managed deletion supports per-user installations only; use the owning OS administrator for machine installs.");
  if (!UNINSTALL_MODES.includes(mode)) throw new Error("Select one of the four explicit uninstall modes.");
  if (consent?.mode !== mode || ["full", "data-only"].includes(mode) && consent.deleteData !== true) throw new Error("Uninstall mode-specific consent is required; data deletion needs a separate explicit confirmation.");
  const installRoot = safeRoot(installInput), userDataDir = safeRoot(userInput), dataDir = safeRoot(dataInput ?? join(userDataDir, "workspace"));
  if (inside(installRoot, userDataDir) || inside(userDataDir, installRoot) || inside(installRoot, dataDir) || inside(dataDir, installRoot) || inside(dataDir, userDataDir)) throw new Error("Installation, user data and instance roots overlap unsafely.");
  const installation = await verifyInstallationManifest(installRoot, stamp);
  const instance = await snapshotIfPresent(dataDir);
  const userData = userDataDir === dataDir ? instance : await snapshotIfPresent(userDataDir);
  const deleteData = ["full", "data-only"].includes(mode);
  const instanceId = deleteData ? await ownData(dataDir, instance) : null;
  const remove = [];
  if (mode !== "data-only") for (const entry of installation.entries) if (entry.type === "file" && (mode !== "app-only" || !runtimeFile(entry.path, stamp))) remove.push({ scope: "installation", ...entry });
  if (deleteData) {
    for (const entry of instance.entries) if (entry.type === "file" && DATA_NAMES.has(entry.path.split("/")[0])) remove.push({ scope: "instance", ...entry });
    if (!userData.absent) for (const entry of userData.entries) if (entry.type === "file" && USER_STATE_NAMES.has(entry.path.split("/")[0]) && !inside(dataDir, join(userDataDir, entry.path))) remove.push({ scope: "userData", ...entry });
  }
  const roots = { installation: installRoot, instance: dataDir, userData: userDataDir };
  const protectedRoots = [...new Set([join(dataDir, "projects"), ...externalRoots.map(safeRoot), ...(deleteData ? await protectedNativeHomes(dataDir, externalRoots[0]) : [])])];
  for (const entry of remove) for (const protectedRoot of protectedRoots) if (inside(protectedRoot, join(roots[entry.scope], entry.path))) throw new Error("Uninstall would touch a protected project or native Provider root.");
  const removeDirectories = [];
  for (const [scope, snapshot] of Object.entries({ installation, instance, userData })) {
    if (snapshot.absent) continue;
    for (const entry of snapshot.entries) {
      if (entry.type !== "directory") continue;
      const selected = scope === "installation" ? mode !== "data-only" && (mode !== "app-only" || entry.path !== resourcesPrefix(stamp) && !resourcesPrefix(stamp).startsWith(`${entry.path}/`) && !runtimeFile(`${entry.path}/`, stamp))
        : deleteData && (scope === "instance" ? DATA_NAMES : USER_STATE_NAMES).has(entry.path.split("/")[0]);
      const path = join(snapshot.root, entry.path);
      if (selected && !protectedRoots.some(protectedRoot => inside(protectedRoot, path) || inside(path, protectedRoot))) removeDirectories.push({ scope, ...entry });
    }
  }
  const preserved = [];
  const removedPaths = new Set(remove.map(item => join(roots[item.scope], item.path)));
  for (const [scope, snapshot] of Object.entries({ installation, instance, userData })) if (!snapshot.absent) for (const entry of snapshot.entries) if (entry.type === "file" && !removedPaths.has(join(snapshot.root, entry.path))) preserved.push({ scope, path: entry.path, ...(mode === "app-only" && scope === "installation" && entry.path === `${resourcesPrefix(stamp)}/${INSTALL_FILES_NAME}` ? { transition: "retained-runtime-ownership-manifest" } : { sha256: entry.sha256, bytes: entry.bytes }) });
  return { formatVersion: 1, mode, stamp, roots, instanceId, golden: UNINSTALL_GOLDEN[mode], snapshots: { installation, instance, userData }, delete: remove, deleteDirectories: removeDirectories, preserve: preserved, protectedRoots, osIntegration: mode === "data-only" ? "preserve" : "remove", rollbackCompatibility: { ...stamp.compatibility, migrationsPerformed: false } };
}

async function assertSnapshot(snapshot) {
  if (snapshot.absent) { if (await exists(snapshot.root)) throw new Error("An absent uninstall root appeared."); return; }
  const actual = await captureUninstallSnapshot(snapshot.root);
  if (actual.sha256 !== snapshot.sha256 || JSON.stringify(actual.identity.exact) !== JSON.stringify(snapshot.identity.exact)) throw new Error("Uninstall snapshot changed; plan must be reviewed again.");
}
async function deleteOwnedFile(root, entry, { attempts, retryDelayMs }) {
  const path = join(root, safeRelative(entry.path));
  for (let attempt = 0; ; attempt++) {
    await ancestors(dirname(path));
    const info = await exists(path);
    if (!info) return;
    await rejectReparse([path]);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.dev !== entry.dev || info.ino !== entry.ino || info.size !== entry.bytes || await fileHash(path, info) !== entry.sha256) throw new Error("Owned file changed before deletion; refusing retry.");
    try { await unlink(path); return; }
    catch (error) { if (!["EBUSY", "EPERM", "EACCES"].includes(error.code) || attempt + 1 >= attempts) throw error; await delay(retryDelayMs); }
  }
}

export async function executeUninstall(options) {
  validateInstallStamp(options.stamp, { platform: options.stamp?.platform, arch: options.stamp?.arch, version: options.stamp?.version });
  assertSelfOwnedInstall(options.stamp);
  if (!UNINSTALL_MODES.includes(options.mode) || options.consent?.mode !== options.mode || ["full", "data-only"].includes(options.mode) && options.consent.deleteData !== true) throw new Error("Explicit mode-specific consent is required before stopping or deleting anything.");
  safeRoot(options.installRoot);
  safeRoot(options.userDataDir);
  if (typeof options.stop !== "function") throw new Error("A verified stop-before-delete callback is required.");
  const stopped = await options.stop();
  if (stopped?.stopped !== true || stopped.remainingProcesses !== 0) throw new Error("Owned processes have not verifiably stopped; no uninstall files were deleted.");
  const plan = await planUninstall(options);
  if (options.deferInstallation) return { ...plan, status: "prepared", deletionExecuted: false, stopped };
  if (process.platform === "win32" && plan.mode !== "data-only") throw new Error("Windows app removal must use the external NSIS cleanup executor after the packaged controller exits.");
  for (const snapshot of Object.values(plan.snapshots)) await assertSnapshot(snapshot);
  const deleted = [];
  for (const entry of plan.delete) { await deleteOwnedFile(plan.roots[entry.scope], entry, { attempts: 3, retryDelayMs: 100 }); deleted.push({ scope: entry.scope, path: entry.path }); }
  // Never recursive-rm an ancestor: only remove empty directories from the exact
  // snapshot, deepest first, and preserve every unknown/new file on races.
  const deletedDirectories = [];
  for (const entry of [...plan.deleteDirectories].sort((a, b) => b.path.length - a.path.length)) {
    const path = join(plan.roots[entry.scope], entry.path);
    await ancestors(path);
    const info = await lstat(path);
    if (info.dev !== entry.dev || info.ino !== entry.ino) throw new Error("Owned directory identity changed before deletion.");
    await rmdir(path);
    deletedDirectories.push({ scope: entry.scope, path: entry.path });
  }
  if (["app+runtime", "full"].includes(plan.mode)) {
    await ancestors(plan.roots.installation);
    const identity = await lstat(plan.roots.installation, { bigint: true });
    if (String(identity.dev) !== plan.snapshots.installation.identity.exact.dev || String(identity.ino) !== plan.snapshots.installation.identity.exact.ino) throw new Error("Installation root changed before final empty removal.");
    await rmdir(plan.roots.installation);
  }
  if (plan.mode === "app-only") {
    await writeFile(join(plan.roots.installation, resourcesPrefix(plan.stamp), INSTALL_FILES_NAME), `${JSON.stringify({ ...await createInstallationManifest(plan.roots.installation, plan.stamp), retainedRuntime: true })}\n`);
  }
  const result = { ...plan, status: "complete", deletionExecuted: true, deleted, deletedDirectories, stopped };
  if (options.receiptFile) await writeFile(options.receiptFile, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
  return result;
}

export async function launchNativeUninstall({ installRoot, requestFile, responseFile, mode, controllerPid = process.pid }) {
  if (process.platform !== "win32") throw new Error("Native uninstall handoff requires Windows NSIS.");
  safeRoot(installRoot);
  if (!UNINSTALL_MODES.includes(mode) || !Number.isSafeInteger(controllerPid) || controllerPid < 1) throw new Error("Invalid native uninstall handoff.");
  await assertPrivatePath(requestFile);
  await assertPrivatePath(responseFile);
  const directory = await mkdtemp(join(tmpdir(), "dovspace-native-handoff-"));
  await ensurePrivateDirectory(directory, { newlyCreated: true });
  const helper = join(directory, "desktop-maintenance.ps1");
  await cp(join(installRoot, "resources", "desktop-maintenance", "desktop-maintenance.ps1"), helper);
  const child = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Stage", "handoff", "-InstallRoot", installRoot, "-RequestFile", requestFile, "-ResponseFile", responseFile, "-Mode", mode, "-Confirm", mode, "-ControllerPid", String(controllerPid)], { detached: true, windowsHide: true, stdio: "ignore" });
  await new Promise((done, fail) => { child.once("spawn", done); child.once("error", fail); });
  child.unref();
  return { status: "native-executor-started", receiptFile: `${responseFile}.cleanup.json` };
}
