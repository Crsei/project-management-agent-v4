import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { copyFile, cp, lstat, mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePrivateDirectory, writePrivateJson } from "../../src/private-state.mjs";
import { INSTALL_E2E_HARNESS, INSTALL_E2E_SCENARIOS, INSTALL_E2E_UNINSTALL_MATRIX, assertDataPreserved, compareVersions, materialRecord, sha256File, validateSnapshot, verifyInstallE2EReceipt } from "./evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const exists = async (path) => { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const inside = (root, path) => { const value = relative(root, path); return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
const blocked = (message) => Object.assign(new Error(message), { code: "E2E_BLOCKED" });
export function requireWindowsNative() {
  if (process.platform !== "win32" || process.arch !== "x64" || !process.env.SystemRoot || !/^[A-Za-z]:\\/.test(process.env.SystemRoot))
    throw blocked("Native Windows x64 Node and system Windows PowerShell are required; Linux, WSL, Wine and simulated platforms are not installer evidence.");
}
export function parseOptions(argv) {
  const allowed = new Set(["--delivery", "--baseline", "--baseline-sha256", "--root", "--account-sid", "--run-id", "--run-attempt", "--repository", "--baseline-run-id", "--baseline-run-attempt", "--export-dir"]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || options[key.slice(2)] !== undefined) throw new Error("Use explicit, unique --name value install E2E arguments.");
    options[key.slice(2)] = value;
  }
  for (const key of ["delivery", "root", "account-sid", "run-id", "run-attempt", "repository"]) if (!options[key]) throw new Error(`Missing --${key}.`);
  if (!/^S-1-5-21-(?:\d+-){3}\d+$/.test(options["account-sid"]) || !/^\d+$/.test(options["run-id"]) || !/^[1-9]\d*$/.test(options["run-attempt"]) || !/^[^/\s]+\/[^/\s]+$/.test(options.repository)) throw new Error("Invalid isolated account or run identity.");
  return options;
}
async function realAncestors(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    const info = await lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error("E2E roots require real directory ancestors.");
    if (dirname(current) === current) break;
  }
}
function environment() {
  const home = homedir();
  return {
    ...Object.fromEntries(["SystemRoot", "WINDIR", "SystemDrive", "TEMP", "TMP", "PROGRAMFILES", "PROGRAMFILES(X86)", "ProgramData", "PATH", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    USERPROFILE: home, HOME: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
  };
}
async function deliveryIdentity(directory, expectedHash) {
  const manifest = JSON.parse(await readFile(join(directory, "desktop-package.json"), "utf8"));
  if (manifest.schemaVersion !== 3 || manifest.target !== "win32-x64" || !["signed", "unsigned"].includes(manifest.signing)
    || !/^[a-f0-9]{40}$/.test(manifest.source?.commit) || !/^[a-f0-9]{64}$/.test(manifest.source?.sha256) || typeof manifest.source.dirty !== "boolean") throw blocked("Exact Windows delivery manifest and commit/dirty source digest are required.");
  const stamp = manifest.installStamp;
  if (stamp?.formatVersion !== 1 || stamp.commit !== manifest.source.commit || stamp.source?.sha256 !== manifest.source.sha256
    || stamp.source?.dirty !== manifest.source.dirty || stamp.version !== manifest.version || stamp.compatibility?.dataSchema !== 1
    || stamp.compatibility?.postgresMajor !== 16 || !/^[a-f0-9]{64}$/.test(stamp.compatibility?.migrationsSha256))
    throw blocked("The exact delivery lacks the supported installed lifecycle/compatibility stamp; an older unsupported installer cannot stand in for a true baseline.");
  const artifacts = manifest.artifacts?.filter((entry) => /^[^/\\:]+\.exe$/.test(entry.path));
  if (artifacts?.length !== 1) throw blocked("Exactly one explicitly recorded NSIS installer is required.");
  const artifact = artifacts[0];
  const path = join(directory, artifact.path), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== artifact.bytes || await sha256File(path) !== artifact.sha256 || expectedHash && expectedHash !== artifact.sha256) throw blocked("Installer bytes do not match the supplied exact SHA256 identity.");
  const source = JSON.parse(await readFile(join(directory, "desktop-source.json"), "utf8"));
  if (source.commit !== manifest.source.commit || source.dirty !== manifest.source.dirty || source.sha256 !== manifest.source.sha256) throw blocked("Corresponding source identity differs from installer delivery.");
  const report = JSON.parse(await readFile(join(directory, "desktop-verification.json"), "utf8"));
  const final = report.checks?.finalArtifacts?.artifacts?.find((entry) => entry.path === artifact.path);
  if (report.checks?.finalArtifacts?.status !== "passed" || final?.sha256 !== artifact.sha256 || final?.bytes !== artifact.bytes || !/^[a-f0-9]{64}$/.test(final?.application?.sha256)) throw blocked("Exact final installer/app.asar verification is missing.");
  return { manifest, sourceManifest: source, artifact, path, finalArtifacts: report.checks.finalArtifacts, appAsarSha256: final.application.sha256 };
}
async function treeSnapshot(root, prefix = "", includeEmpty = false) {
  const entries = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Data snapshot refuses reparse/link entries.");
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && info.nlink === 1) entries.push({ path: `${prefix}${relative(root, path).split(sep).join("/")}`, bytes: info.size, sha256: await sha256File(path) });
      else throw new Error("Data snapshot refuses special or aliased files.");
    }
  };
  if (await exists(root)) await walk(root);
  return includeEmpty ? entries : entries.filter((entry) => entry.bytes > 0);
}

export async function runWindowsInstallE2E(options) {
  requireWindowsNative();
  const root = resolve(options.root);
  if (!/^[A-Za-z]:\\/.test(options.root) || /["\r\n<>|?*]/.test(options.root) || root === parse(root).root || await exists(root)) throw new Error("Install E2E requires a new absolute local-drive isolated work root; existing roots are never reused or deleted.");
  await realAncestors(root);
  await ensurePrivateDirectory(root);
  const diagnostics = await ensurePrivateDirectory(join(root, "diagnostics"));
  const evidenceRoot = await ensurePrivateDirectory(join(diagnostics, "evidence"));
  const privateRoot = await ensurePrivateDirectory(join(root, "private"));
  const receiptPath = join(diagnostics, "install-e2e-receipt.json");
  let exportRoot;
  if (options["export-dir"]) {
    exportRoot = resolve(options["export-dir"]);
    if (!isAbsolute(options["export-dir"]) || inside(root, exportRoot) || inside(exportRoot, root) || await exists(exportRoot)) throw new Error("Diagnostic export requires a new nonoverlapping directory.");
    await realAncestors(exportRoot);
    await mkdir(exportRoot); await mkdir(join(exportRoot, "evidence"));
  }
  let current, baseline, activeCase, activeScenario, sequence = 0;
  const running = new Set();
  const receipt = {
    schemaVersion: 1, kind: "desktop-windows-install-e2e", status: "running", target: "win32-x64",
    startedAt: new Date().toISOString(), installationExecuted: false, electronGuiExecuted: false,
    run: { id: options["run-id"], attempt: options["run-attempt"], repository: options.repository, commit: null },
    native: { platform: process.platform, arch: process.arch, accountSid: options["account-sid"], isolatedAccount: true, administrator: false },
    controller: { scope: "installed-electron-app-asar", appAsarSha256: null }, baseline: null,
    scenarios: INSTALL_E2E_SCENARIOS.map((name) => ({ name, status: "not-run", materials: [] })), materials: [],
  };
  const name = (suffix) => `evidence/${String(++sequence).padStart(4, "0")}-${suffix}`;
  const publishMaterial = (path) => exportRoot ? copyFile(join(diagnostics, path), join(exportRoot, path), constants.COPYFILE_EXCL) : Promise.resolve();
  const save = async (path, value) => {
    await writeFile(join(diagnostics, path), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await publishMaterial(path);
    return path;
  };
  const checkpoint = async () => {
    const body = `${JSON.stringify(receipt, null, 2)}\n`;
    await writeFile(receiptPath, body, { mode: 0o600 });
    if (exportRoot) await writeFile(join(exportRoot, "install-e2e-receipt.json"), body, { mode: 0o600 });
  };
  const add = (path) => { if (activeScenario && !activeScenario.materials.includes(path)) activeScenario.materials.push(path); return path; };
  const startCommand = async (executable, args, scope, { timeout = 600_000, interrupted = false } = {}) => {
    const stdout = name("stdout.log"), stderr = name("stderr.log"), commandPath = name("command.json");
    const out = createWriteStream(join(diagnostics, stdout), { flags: "wx", mode: 0o600 });
    const err = createWriteStream(join(diagnostics, stderr), { flags: "wx", mode: 0o600 });
    const startedAt = new Date().toISOString();
    const child = spawn(executable, args, { cwd: root, env: environment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out); child.stderr.pipe(err);
    let spawnError, completed = false, settle, reject;
    child.once("error", (error) => { spawnError = error; });
    const command = { schemaVersion: 1, kind: "command", executable, executableScope: scope, arguments: args, pid: child.pid ?? null, startedAt, stdout, stderr, interrupted };
    const done = new Promise((resolve, fail) => { settle = resolve; reject = fail; });
    const closed = (stream) => new Promise((resolve) => stream.closed ? resolve() : stream.once("close", resolve));
    const finalize = async (code, signal, abandoned = false) => {
      if (completed) return;
      completed = true;
      if (abandoned) {
        child.stdout.unpipe(out); child.stderr.unpipe(err); out.end(); err.end();
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }
      await Promise.all([closed(out), closed(err)]);
      Object.assign(command, { finishedAt: new Date().toISOString(), exitCode: code, signal, timedOut: abandoned, ...(spawnError ? { error: "Command failed to spawn" } : {}) });
      try { await publishMaterial(stdout); await publishMaterial(stderr); await save(commandPath, command); running.delete(handle); settle(command); } catch (error) { reject(error); }
    };
    child.once("close", (code, signal) => { void finalize(code, signal); });
    const handle = { child, command, commandPath, done, deadline: Date.now() + timeout, abandon: () => finalize(null, null, true) };
    running.add(handle); add(stdout); add(stderr); add(commandPath);
    return handle;
  };
  const finish = async (handle, { allowInterrupted = false } = {}) => {
    const command = await Promise.race([handle.done, delay(Math.max(1, handle.deadline - Date.now()), undefined, { ref: false }).then(async () => {
      await handle.abandon();
      throw new Error("Owned command timeout; diagnostics retained without a process sweep or forced service termination.");
    })]);
    if (command.timedOut || command.exitCode !== 0 && !(allowInterrupted && command.interrupted)) throw new Error(`Native command failed (${command.exitCode ?? command.signal ?? "spawn"}); diagnostics retained.`);
    return handle;
  };
  const systemPowerShell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const powerShellArguments = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
  const native = async (request, collect = true) => {
    const requestFile = join(privateRoot, `${randomUUID()}.json`);
    await writePrivateJson(requestFile, { root, accountSid: options["account-sid"], installRoot: activeCase?.installRoot ?? join(root, "not-installed"), userDataDir: activeCase?.userDataDir ?? join(root, "not-started"), ...request }, { exclusive: true });
    const command = await startCommand(systemPowerShell, [...powerShellArguments, "-File", join(here, "native-evidence.ps1"), "-RequestFile", requestFile], "native-system");
    await finish(command);
    const result = JSON.parse((await readFile(join(diagnostics, command.command.stdout), "utf8")).replace(/^\uFEFF/, "").trim());
    await unlink(requestFile);
    if (collect) return add(await save(name(`${request.operation ?? "native-state"}.json`), result));
    return result;
  };
  const paths = () => ({
    installation: activeCase.installRoot,
    app: join(activeCase.installRoot, "PM Agent v4.exe"), runtime: join(activeCase.installRoot, "resources", "desktop-runtime"),
    workspaceRuntime: join(activeCase.installRoot, "resources", "workspace-runtime"), data: activeCase.dataDir, userData: activeCase.userDataDir,
    managedPostgres: join(activeCase.dataDir, "postgres"), agentData: join(activeCase.dataDir, "agent-data"), managedMarkdown: join(activeCase.dataDir, "pm-workspaces"),
    connection: join(activeCase.userDataDir, "connection.json"), projects: join(activeCase.dataDir, "projects"),
    userOwnedFile: join(activeCase.userDataDir, "user-owned-must-survive.txt"), external: activeCase.external,
  });
  const state = () => native({ operation: "state", paths: paths() });
  const scenario = async (key, action) => {
    activeScenario = receipt.scenarios.find(({ name }) => name === key);
    activeScenario.status = "running";
    try {
      const proof = await action();
      const statePath = await state();
      const proofPath = add(await save(name(`${key}-proof.json`), { schemaVersion: 1, kind: "scenario-proof", name: key, status: "passed", ...proof, state: statePath, commands: activeScenario.materials.filter((path) => path.endsWith("-command.json")) }));
      Object.assign(activeScenario, { status: "passed", proof: proofPath });
    } catch (error) { activeScenario.status = error.code === "E2E_BLOCKED" ? "blocked" : "failed"; throw error; }
    finally { activeScenario = null; await checkpoint(); }
  };
  const newCase = async (label) => {
    const directory = await ensurePrivateDirectory(join(root, label));
    const userDataDir = await ensurePrivateDirectory(join(directory, "userData"));
    const external = await ensurePrivateDirectory(join(directory, "external-native-home"));
    await writeFile(join(external, "must-survive.txt"), `External project/provider home ${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
    const value = { directory, installRoot: join(directory, "installed"), userDataDir, dataDir: join(userDataDir, "workspace"), external, fixtureId: randomUUID(), password: randomBytes(32).toString("base64url"), controller: null };
    activeCase = value;
    return value;
  };
  const expectedStamp = (delivery) => ({ commit: delivery.manifest.source.commit, sourceSha256: delivery.manifest.source.sha256 });
  const request = async (operation, delivery, extra = {}) => {
    const id = randomUUID(), requestFile = join(privateRoot, `${id}.request.json`), responseFile = join(privateRoot, `${id}.response.json`);
    await writePrivateJson(requestFile, { formatVersion: 1, operation, requestId: id, responseFile, expectedInstallRoot: activeCase.installRoot, expectedStamp: expectedStamp(delivery), userDataDir: activeCase.userDataDir, dataDir: activeCase.dataDir, fixtureId: activeCase.fixtureId, ...(["stop", "preinstall", "uninstall"].includes(operation) ? { consent: { stopLocalServices: true } } : {}), ...extra }, { exclusive: true });
    return { requestFile, responseFile, id };
  };
  const response = async (files, handle, timeout = 300_000) => {
    const deadline = Date.now() + timeout;
    while (!await exists(files.responseFile)) {
      if (Date.now() >= deadline || handle.command.finishedAt) throw new Error("Installed controller did not publish a successful private response; diagnostics retained.");
      await delay(100);
    }
    const value = JSON.parse(await readFile(files.responseFile, "utf8"));
    await unlink(files.requestFile);
    const resultPath = add(await save(name("installed-controller.json"), { schemaVersion: 1, kind: "installed-controller", ...value }));
    if (value.formatVersion !== 1 || value.requestId !== files.id || !value.ok) throw new Error("Installed packaged controller operation failed; see private response/evidence.");
    return { value, resultPath };
  };
  const preserveNativeFailure = async (files) => {
    if (!files) return;
    for (const path of [files.responseFile, `${files.responseFile}.cleanup.json`]) if (await exists(path)) {
      await save(name("native-failure-response.json"), { schemaVersion: 1, kind: "native-failure-response", source: basename(path), response: JSON.parse(await readFile(path, "utf8")) });
    }
  };
  const finishNative = async (handle, files) => {
    try { return await finish(handle); }
    catch (error) { await preserveNativeFailure(files); throw error; }
  };
  const controller = async (operation, delivery, extra = {}) => {
    const app = join(activeCase.installRoot, "PM Agent v4.exe");
    if (await sha256File(join(activeCase.installRoot, "resources", "app.asar")) !== delivery.appAsarSha256) throw new Error("Installed controller app.asar does not match exact installer payload.");
    const files = await request(operation, delivery, extra);
    const handle = await startCommand(app, ["--desktop-lifecycle", operation, "--request-file", files.requestFile, "--response-file", files.responseFile], "installed-controller");
    Object.assign(handle.command, { controllerAsarSha256: delivery.appAsarSha256, installRoot: activeCase.installRoot });
    if (operation === "start-health") { activeCase.controller = handle; activeCase.runningDelivery = delivery; }
    const result = await response(files, handle);
    if (operation === "start-health") {
      if (result.value.installStamp?.version !== delivery.manifest.version || result.value.result?.ready !== true) throw new Error("Installed startup health/version differs from expected exact release.");
    } else await finish(handle);
    return result;
  };
  const start = (delivery, createFixture) => controller("start-health", delivery, { createFixture, setup: { name: "Installer E2E", email: `e2e-${activeCase.fixtureId}@example.invalid`, password: activeCase.password, workspaceName: "Installer lifecycle fixture" } });
  const stop = async (delivery) => {
    const result = await controller("stop", delivery);
    if (activeCase.controller) { await finish(activeCase.controller); activeCase.controller = null; activeCase.runningDelivery = null; }
    const observed = JSON.parse(await readFile(join(diagnostics, await state()), "utf8"));
    if (observed.processes.length) throw new Error("Owned processes remain after graceful installed-controller stop.");
    return result;
  };
  const snapshot = async (delivery) => {
    const { value } = await controller("snapshot", delivery);
    const raw = value.result?.snapshot ?? value.result;
    const document = validateSnapshot({ schemaVersion: 1, kind: "data-snapshot", scope: "installed-fixture-logical-data", fixtureId: activeCase.fixtureId, components: raw?.components });
    return add(await save(name("data-snapshot.json"), document));
  };
  const stoppedSnapshot = async () => {
    const userEntries = (await treeSnapshot(activeCase.userDataDir)).filter((entry) => ["connection.json", "desktop-lifecycle-fixture.json"].includes(entry.path));
    const document = { schemaVersion: 1, kind: "data-snapshot", scope: "stopped-data-files-and-saved-client-state", fixtureId: activeCase.fixtureId, components: {
      postgres: { entries: await treeSnapshot(join(activeCase.dataDir, "postgres")) },
      markdown: { entries: [...await treeSnapshot(join(activeCase.dataDir, "pm-workspaces"), "pm-workspaces/"), ...await treeSnapshot(join(activeCase.dataDir, "projects"), "projects/")].filter((entry) => entry.path.endsWith(".md")) },
      agent: { entries: await treeSnapshot(join(activeCase.dataDir, "agent-data")) }, userData: { entries: userEntries },
    } };
    validateSnapshot(document);
    return add(await save(name("stopped-data-snapshot.json"), document));
  };
  const preservation = async (before, after) => { const a = JSON.parse(await readFile(join(diagnostics, before), "utf8")), b = JSON.parse(await readFile(join(diagnostics, after), "utf8")); assertDataPreserved(a, b); add(before); add(after); return { before, after }; };
  const install = async (delivery, { interrupt = false } = {}) => {
    const previous = activeCase.installedDelivery;
    const handoff = previous && await exists(join(activeCase.installRoot, "PM Agent v4.exe")) ? await request("preinstall", previous) : null;
    const handle = await startCommand(delivery.path, ["/S", "/currentuser", ...(handoff ? [`/DOVSPACE_REQUEST=${handoff.requestFile}`, `/DOVSPACE_RESPONSE=${handoff.responseFile}`] : []), `/D=${activeCase.installRoot}`], "installer", { interrupted: interrupt });
    handle.command.artifact = delivery.artifact;
    receipt.installationExecuted = true;
    if (interrupt) return handle;
    await finishNative(handle, handoff);
    if (handoff) await response(handoff, handle);
    if (await sha256File(join(activeCase.installRoot, "resources", "app.asar")) !== delivery.appAsarSha256) throw new Error("Silent installer did not install the exact packaged controller.");
    const installed = JSON.parse(await readFile(join(diagnostics, await state()), "utf8"));
    if (!installed.registry.length || !installed.shortcuts.length) throw new Error("Silent installer did not register per-user uninstall metadata/shortcuts.");
    activeCase.installedDelivery = delivery;
    return handle;
  };
  const uninstall = async (mode, delivery) => {
    const candidates = (await readdir(activeCase.installRoot)).filter((name) => /^Uninstall .*\.exe$/i.test(name));
    if (candidates.length !== 1) throw new Error("Exact installed NSIS uninstaller is missing or ambiguous.");
    const files = await request("uninstall", delivery, { mode, confirm: mode, consent: { stopLocalServices: true, mode, deleteData: ["full", "data-only"].includes(mode) } });
    const handle = await startCommand(join(activeCase.installRoot, candidates[0]), ["/S", `/DOVSPACE_MODE=${mode}`, `/DOVSPACE_CONFIRM=${mode}`, `/DOVSPACE_REQUEST=${files.requestFile}`, `/DOVSPACE_RESPONSE=${files.responseFile}`], "installed-uninstaller");
    await finishNative(handle, files);
    const selected = await response(files, handle, 30_000);
    const cleanupFile = `${files.responseFile}.cleanup.json`;
    const deadline = Date.now() + 120_000;
    while (!await exists(cleanupFile)) { if (Date.now() >= deadline) throw new Error("Detached uninstall cleanup receipt missing; no successful deletion can be claimed."); await delay(100); }
    const cleanup = JSON.parse(await readFile(cleanupFile, "utf8"));
    const cleanupPath = add(await save(name("uninstall-cleanup.json"), { schemaVersion: 1, kind: "uninstall-cleanup", ...cleanup }));
    if (cleanup.formatVersion !== 1 || cleanup.status !== "complete" || cleanup.deletionExecuted !== true || cleanup.mode !== mode || cleanup.sourceSha256 !== delivery.manifest.source.sha256) throw new Error("Owned native uninstall cleanup failed; preserve diagnostics.");
    activeCase.installedDelivery = mode === "data-only" ? delivery : null;
    return { cleanup: cleanupPath, plan: selected.resultPath, selected: selected.value.result };
  };
  const inspectUninstallFiles = async (handoff) => {
    const plan = handoff.selected;
    const roots = { installation: activeCase.installRoot, instance: activeCase.dataDir, userData: activeCase.userDataDir };
    if (!plan || !plan.roots || Object.keys(plan.roots).length !== 3 || Object.entries(roots).some(([scope, path]) => plan.roots[scope] !== path) || !Array.isArray(plan.delete) || !Array.isArray(plan.deleteDirectories) || !Array.isArray(plan.preserve)) throw new Error("Native uninstall did not return an exact owned file/directory plan.");
    const location = (entry) => {
      if (!Object.hasOwn(roots, entry.scope) || typeof entry.path !== "string" || entry.path.includes("\\") || entry.path.includes(":")
        || entry.path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe native uninstall evidence path.");
      const path = join(roots[entry.scope], entry.path);
      if (!inside(roots[entry.scope], path)) throw new Error("Uninstall evidence escaped its owned scope.");
      return path;
    };
    const deleted = [];
    for (const entry of plan.delete) {
      const present = await exists(location(entry));
      if (present) throw new Error("A selected owned uninstall file remains.");
      deleted.push({ scope: entry.scope, path: entry.path, exists: false });
    }
    const deletedDirectories = [];
    for (const entry of plan.deleteDirectories) {
      if (await exists(location(entry))) throw new Error("A selected owned uninstall directory remains.");
      deletedDirectories.push({ scope: entry.scope, path: entry.path, exists: false });
    }
    const preserved = [], cache = new Map();
    for (const entry of plan.preserve) {
      const path = location(entry);
      let actual = cache.get(path);
      if (!actual) {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Preserved uninstall file changed type or identity.");
        actual = { bytes: info.size, sha256: await sha256File(path) }; cache.set(path, actual);
      }
      if (entry.transition) {
        const manifest = JSON.parse(await readFile(path, "utf8"));
        if (entry.scope !== "installation" || entry.path !== "resources/desktop-install-files.json" || entry.transition !== "retained-runtime-ownership-manifest"
          || manifest.retainedRuntime !== true || manifest.sourceSha256 !== receipt.source.sha256) throw new Error("Retained runtime ownership transition is invalid.");
      } else if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error("Uninstall modified a protected/preserved file.");
      preserved.push({ scope: entry.scope, path: entry.path, ...actual, ...(entry.transition ? { transition: entry.transition, transitionVerified: true } : {}) });
    }
    return add(await save(name("uninstall-file-outcome.json"), { schemaVersion: 1, kind: "uninstall-file-outcome", roots, deleted, deletedDirectories, preserved }));
  };
  const exportDiagnostics = async () => {
    // Completed logs/materials are mirrored as they close, so a hosted job
    // cancellation still retains a running (never passed) checkpoint.
    await checkpoint();
  };
  await checkpoint();
  try {
    current = await deliveryIdentity(resolve(options.delivery));
    Object.assign(receipt, { version: current.manifest.version, signing: current.manifest.signing, source: { commit: current.manifest.source.commit, dirty: current.manifest.source.dirty, sha256: current.manifest.source.sha256 }, artifact: current.artifact });
    receipt.run.commit = receipt.source.commit; receipt.controller.appAsarSha256 = current.appAsarSha256;
    const harnessFiles = [];
    for (const path of INSTALL_E2E_HARNESS) {
      const expected = current.sourceManifest.files?.find((entry) => entry.path === path);
      const actual = join(resolve(here, "../../../.."), path);
      if (!expected || await sha256File(actual) !== expected.sha256) throw blocked("Lifecycle harness differs from the exact candidate source inventory.");
      harnessFiles.push({ path, sha256: expected.sha256, bytes: expected.bytes });
    }
    receipt.harness = { files: harnessFiles, sourceSha256: receipt.source.sha256 };
    if (current.manifest.ci && (current.manifest.ci.runId !== receipt.run.id || current.manifest.ci.attempt !== receipt.run.attempt || current.manifest.ci.repository !== receipt.run.repository)) throw blocked("Lifecycle run/attempt must match exact candidate build provenance.");
    if (!options.baseline || !/^[a-f0-9]{64}$/.test(options["baseline-sha256"] ?? "") || !/^\d+$/.test(options["baseline-run-id"] ?? "") || !/^[1-9]\d*$/.test(options["baseline-run-attempt"] ?? "")) throw blocked("True N to N+1 upgrade is blocked: supply an exact lower-version baseline delivery, installer SHA256 and baseline run/attempt. Same-version overwrite is not an upgrade.");
    baseline = await deliveryIdentity(resolve(options.baseline), options["baseline-sha256"]);
    if (compareVersions(baseline.manifest.version, current.manifest.version) >= 0 || baseline.artifact.sha256 === current.artifact.sha256) throw blocked("True upgrade requires an older exact semantic version and different installer bytes; same-version installers only exercise overwrite.");
    if (baseline.manifest.ci && (baseline.manifest.ci.runId !== options["baseline-run-id"] || baseline.manifest.ci.attempt !== options["baseline-run-attempt"])) throw blocked("Baseline delivery run/attempt differs from supplied exact provenance.");
    receipt.baseline = { version: baseline.manifest.version, source: { commit: baseline.manifest.source.commit, dirty: baseline.manifest.source.dirty, sha256: baseline.manifest.source.sha256 }, artifact: baseline.artifact, appAsarSha256: baseline.appAsarSha256, run: { id: options["baseline-run-id"], attempt: options["baseline-run-attempt"] } };
    receipt.compatibility = current.manifest.installStamp.compatibility;
    receipt.baseline.compatibility = baseline.manifest.installStamp.compatibility;
    if (JSON.stringify(receipt.compatibility) !== JSON.stringify(receipt.baseline.compatibility)) throw blocked("True upgrade is blocked by changed PM/Agent migration fingerprint or data schema; no migration rollback compatibility is assumed.");
    await newCase("current-overwrite");
    const initial = JSON.parse(await readFile(join(diagnostics, await state()), "utf8"));
    if (initial.registry.length || initial.shortcuts.length || initial.processes.length) throw blocked("Dedicated account has preexisting Dovspace registration/processes; do not overwrite another installation.");
    await scenario("silent-install", async () => { await install(current); return {}; });
    let initialSnapshot;
    await scenario("installed-start-health", async () => { const started = await start(current, true); initialSnapshot = await snapshot(current); return { controller: started.resultPath, snapshot: initialSnapshot }; });
    await scenario("stop-owned-processes", async () => { await stop(current); return {}; });
    await scenario("overwrite-install", async () => {
      await install(current); await start(current, false); const after = await snapshot(current); await stop(current);
      return { fromVersion: current.manifest.version, toVersion: current.manifest.version, preservation: await preservation(initialSnapshot, after) };
    });
    await uninstall("app+runtime", current);
    await newCase("baseline-upgrade");
    let baselineSnapshot, recoveryBaselineSnapshot, upgradeProfile;
    await scenario("baseline-install", async () => {
      await install(baseline); await start(baseline, true); recoveryBaselineSnapshot = await snapshot(baseline); await stop(baseline);
      const recoveryProfile = { userDataDir: activeCase.userDataDir, dataDir: activeCase.dataDir, fixtureId: activeCase.fixtureId, password: activeCase.password };
      const upgradeUserData = await ensurePrivateDirectory(join(activeCase.directory, "true-upgrade-userData"));
      upgradeProfile = { userDataDir: upgradeUserData, dataDir: join(upgradeUserData, "workspace"), fixtureId: randomUUID(), password: randomBytes(32).toString("base64url") };
      Object.assign(activeCase, upgradeProfile);
      await start(baseline, true); baselineSnapshot = await snapshot(baseline); await stop(baseline);
      Object.assign(activeCase, recoveryProfile);
      return { snapshot: recoveryBaselineSnapshot, independentUpgradeSnapshot: baselineSnapshot };
    });
    const originalUserData = activeCase.userDataDir;
    const recoveryUserData = join(activeCase.directory, "pre-upgrade-recovery-userData");
    await state();
    const beforeCopy = await treeSnapshot(originalUserData, "", true);
    const originalIdentity = await lstat(originalUserData, { bigint: true });
    await cp(originalUserData, recoveryUserData, { recursive: true, errorOnExist: true, force: false });
    await ensurePrivateDirectory(recoveryUserData);
    const afterCopy = await treeSnapshot(recoveryUserData, "", true);
    if (JSON.stringify(beforeCopy) !== JSON.stringify(afterCopy)) throw new Error("Preserved pre-upgrade copy differs from the stopped original.");
    for (const entry of afterCopy) {
      const file = await open(join(recoveryUserData, entry.path), "r+");
      try { await file.sync(); } finally { await file.close(); }
    }
    const recoveryCopy = await save(name("pre-upgrade-copy.json"), {
      schemaVersion: 1, kind: "pre-upgrade-copy", source: originalUserData, destination: recoveryUserData,
      files: afterCopy, verified: true, fileFsync: true, directoryFsync: false, startupSource: "original-inode-tree", copyPurpose: "diagnostic-only-never-started",
      durabilityBoundary: "Node cannot fsync Windows directories; sudden-power-loss durability is not claimed.",
    });
    await scenario("interrupted-upgrade-recovery", async () => {
      const previousAsar = await sha256File(join(activeCase.installRoot, "resources", "app.asar"));
      const previousRecords = new Set(await readdir(activeCase.directory));
      const handle = await install(current, { interrupt: true });
      const identity = await native({ operation: "process-identity", pid: handle.child.pid, executable: current.path }, false);
      handle.command.creationTime = identity.creationTime;
      const deadline = Date.now() + 300_000; let mutation;
      while (!handle.command.finishedAt && Date.now() < deadline) {
        const asar = join(activeCase.installRoot, "resources", "app.asar");
        const present = await exists(asar);
        const changedHash = present ? await sha256File(asar).catch(() => undefined) : null;
        if (!present || changedHash && changedHash !== previousAsar) {
          mutation = { beforeSha256: previousAsar, after: { exists: present, sha256: changedHash }, observedAt: new Date().toISOString() };
          break;
        }
        await delay(20);
      }
      if (!mutation || handle.command.finishedAt) throw new Error("Upgrade completed/failed before a payload-mutation interruption boundary was observed; cannot claim interruption coverage.");
      const payloadMutation = add(await save(name("payload-mutation.json"), { schemaVersion: 1, kind: "payload-mutation", path: join(activeCase.installRoot, "resources", "app.asar"), ...mutation }));
      const targetPath = await native({ operation: "capture-installer-tree", ...identity });
      const target = JSON.parse(await readFile(join(diagnostics, targetPath), "utf8"));
      // libuv holds the original spawned Windows process HANDLE. A separate
      // PID-based native termination would reintroduce a PID-reuse race.
      const killReturned = handle.child.kill("SIGKILL");
      if (!killReturned) throw new Error("Original installer handle was no longer terminable; no interruption pass can be claimed.");
      await finish(handle, { allowInterrupted: true });
      const fault = { ...target, kind: "interruption", fault: "terminate-original-spawned-installer-handle-after-payload-mutation", heldHandle: true,
        termination: { signal: "SIGKILL", killReturned, exitCode: handle.command.exitCode, exitSignal: handle.command.signal } };
      const interruption = add(await save(name("interruption.json"), fault));
      const installerTree = await native({ operation: "wait-installer-tree", rootPid: fault.pid, tree: fault.tree });
      const records = (await readdir(activeCase.directory)).filter((file) => !previousRecords.has(file)
        && file.startsWith(`${basename(activeCase.installRoot)}.rollback-`) && file.endsWith(".json"));
      if (records.length !== 1) throw new Error("Interrupted installer did not preserve exactly one new persistent rollback record.");
      const recordPath = join(activeCase.directory, records[0]);
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      const restoreHelper = recordPath.slice(0, -".json".length) + ".ps1";
      const expectedHelper = baseline.sourceManifest.files?.find((entry) => entry.path === "apps/desktop/assets/desktop-maintenance.ps1");
      if (record.originalRoot !== activeCase.installRoot || record.dataMigrated !== false || record.stamp?.source?.sha256 !== baseline.manifest.source.sha256
        || !expectedHelper || await sha256File(restoreHelper) !== expectedHelper.sha256)
        throw new Error("Persistent interruption recovery is not bound to the exact unchanged baseline installation.");
      const restored = await startCommand(systemPowerShell, [...powerShellArguments, "-File", restoreHelper, "-Stage", "restore", "-InstallRoot", activeCase.installRoot, "-RecoveryRecord", recordPath], "installed-maintenance");
      await finish(restored);
      if (await sha256File(join(activeCase.installRoot, "resources", "app.asar")) !== baseline.appAsarSha256) throw new Error("Native interruption recovery did not restore exact baseline application bytes.");
      activeCase.installedDelivery = baseline;
      const restoration = add(await save(name("native-rollback-restoration.json"), {
        schemaVersion: 1, kind: "rollback-restoration", status: "passed", originalRoot: activeCase.installRoot,
        baselineSource: receipt.baseline.source, recordSha256: await sha256File(recordPath),
        helperSha256: expectedHelper.sha256, dataMigrated: false,
      }));
      await install(baseline);
      const recoveredIdentity = await lstat(originalUserData, { bigint: true });
      if (recoveredIdentity.dev !== originalIdentity.dev || recoveredIdentity.ino !== originalIdentity.ino
        || JSON.stringify(await treeSnapshot(originalUserData, "", true)) !== JSON.stringify(beforeCopy))
        throw new Error("Installer interruption modified/replaced the preserved pre-upgrade data tree; old-version startup is prohibited.");
      await start(baseline, false); const recovered = await snapshot(baseline); await stop(baseline);
      add(recoveryCopy);
      const proof = {
        mutationObserved: true, interruptedPidIdentityVerified: true, recoveredVersion: baseline.manifest.version,
        recoveryCompatibility: "unchanged-pre-upgrade-tree-no-candidate-start", recoveryScope: "installer-interruption-only",
        migrationRollbackExecuted: false, originalDataIdentityPreserved: true, recoveryCopy, payloadMutation, interruption, installerTree, restoration,
        preservation: await preservation(recoveryBaselineSnapshot, recovered),
      };
      return proof;
    });
    Object.assign(activeCase, upgradeProfile);
    await scenario("version-upgrade", async () => { await install(current); await start(current, false); const after = await snapshot(current); await stop(current); return { fromVersion: baseline.manifest.version, toVersion: current.manifest.version, preservation: await preservation(baselineSnapshot, after) }; });
    await uninstall("app+runtime", current);
    for (const [mode, key] of [["app-only", "uninstall-app-only"], ["app+runtime", "uninstall-app-runtime"], ["full", "uninstall-full"], ["data-only", "uninstall-data-only"]]) {
      await newCase(key);
      await scenario(key, async () => {
        await install(current); await start(current, true); await snapshot(current); await stop(current);
        await writeFile(join(activeCase.dataDir, "projects", "user-project-source.txt"), `Protected project source ${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
        await writeFile(join(activeCase.userDataDir, "user-owned-must-survive.txt"), `Unknown user file ${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
        const projectsBefore = await treeSnapshot(join(activeCase.dataDir, "projects"), "", true);
        const userOwnedBefore = await sha256File(join(activeCase.userDataDir, "user-owned-must-survive.txt"));
        const before = await stoppedSnapshot();
        const beforeState = await state();
        const externalBefore = await sha256File(join(activeCase.external, "must-survive.txt"));
        const handoff = await uninstall(mode, current);
        const fileOutcome = await inspectUninstallFiles(handoff);
        const statePath = await state(), observed = JSON.parse(await readFile(join(diagnostics, statePath), "utf8"));
        const externalAfter = await sha256File(join(activeCase.external, "must-survive.txt"));
        const projectsAfter = await treeSnapshot(join(activeCase.dataDir, "projects"), "", true);
        const userOwnedAfter = await sha256File(join(activeCase.userDataDir, "user-owned-must-survive.txt"));
        if (JSON.stringify(projectsBefore) !== JSON.stringify(projectsAfter) || userOwnedBefore !== userOwnedAfter) throw new Error("Uninstall changed a protected project tree or unknown user file.");
        const protectedFiles = add(await save(name("protected-files.json"), { schemaVersion: 1, kind: "protected-files", projects: { before: projectsBefore, after: projectsAfter }, userOwnedFile: { before: userOwnedBefore, after: userOwnedAfter } }));
        const roots = new Map(observed.paths.map((entry) => [entry.label, entry]));
        const remaining = {
          installationRoot: await exists(activeCase.installRoot),
          app: await exists(join(activeCase.installRoot, "PM Agent v4.exe")),
          runtime: await exists(join(activeCase.installRoot, "resources", "desktop-runtime")) && await exists(join(activeCase.installRoot, "resources", "workspace-runtime")),
          dataRoot: await exists(activeCase.dataDir), userDataRoot: await exists(activeCase.userDataDir),
          ownedData: ["managedPostgres", "agentData", "managedMarkdown"].some((label) => roots.get(label)?.files > 0),
          ownedUserState: roots.get("connection")?.exists === true, registry: observed.registry.length > 0,
          shortcuts: observed.shortcuts.length > 0, projects: roots.get("projects")?.exists === true,
          userOwnedFile: roots.get("userOwnedFile")?.exists === true, external: externalAfter === externalBefore,
        };
        const expected = INSTALL_E2E_UNINSTALL_MATRIX[key];
        if (JSON.stringify(remaining) !== JSON.stringify(expected) || observed.processes.length) throw new Error(`Uninstall ${mode} violates golden deletion/preservation/process matrix.`);
        return { remaining, cleanup: handoff.cleanup, plan: handoff.plan, fileOutcome, protectedFiles, beforeSnapshot: before, beforeState, externalPreservation: { sha256Before: externalBefore, sha256After: externalAfter }, ...(expected.ownedData ? { preservation: await preservation(before, await stoppedSnapshot()) } : {}) };
      });
      if (mode === "app-only") {
        const files = await request("uninstall", current, { mode: "app+runtime", confirm: "app+runtime", consent: { stopLocalServices: true, mode: "app+runtime", deleteData: false } });
        const handle = await startCommand(systemPowerShell, [...powerShellArguments, "-File", join(activeCase.installRoot, "resources", "desktop-maintenance", "desktop-maintenance.ps1"), "-Stage", "runtime", "-InstallRoot", activeCase.installRoot, "-Mode", "app+runtime", "-Confirm", "app+runtime", "-RequestFile", files.requestFile, "-ResponseFile", files.responseFile], "installed-maintenance");
        await finishNative(handle, files); await response(files, handle);
        const cleanup = JSON.parse(await readFile(`${files.responseFile}.cleanup.json`, "utf8"));
        await save(name("retained-runtime-cleanup.json"), { schemaVersion: 1, kind: "uninstall-cleanup", ...cleanup });
        if (cleanup.status !== "complete" || cleanup.deletionExecuted !== true || await exists(join(activeCase.installRoot, "resources", "desktop-runtime"))) throw new Error("Retained runtime teardown failed; do not overlap the next matrix installation.");
      }
      // A data-only case deliberately leaves a usable installation. Its retained
      // code is diagnostic evidence, not silently removed by test teardown.
    }
    receipt.status = "passed";
  } catch (error) {
    receipt.status = error.code === "E2E_BLOCKED" ? "blocked" : "failed";
    receipt.failure = { message: error.message, criterion: activeScenario?.name ?? receipt.scenarios.find((entry) => ["failed", "blocked"].includes(entry.status))?.name ?? "native-prerequisites" };
    for (const item of receipt.scenarios) if (item.status === "running") item.status = receipt.status;
    // A graceful installed-controller stop is the only cleanup allowed. On any
    // timeout/error retain owned roots and process identities for diagnosis.
    if (activeCase?.controller && activeCase.runningDelivery) {
      try { await stop(activeCase.runningDelivery); } catch { receipt.cleanup = "graceful-stop-failed; inspect owned-process evidence"; }
    }
    if (activeCase) {
      try { receipt.failure.state = await state(); } catch { receipt.failure.state = "native-state-collection-failed"; }
    }
  } finally {
    for (const handle of [...running]) {
      if (handle.command.finishedAt) await handle.done.catch(() => {});
      else { receipt.status = "failed"; await handle.abandon(); }
    }
    receipt.finishedAt = new Date().toISOString();
    receipt.materials = [];
    for (const entry of (await readdir(evidenceRoot)).sort()) receipt.materials.push(await materialRecord(diagnostics, `evidence/${entry}`));
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    if (receipt.status === "passed") {
      try { await verifyInstallE2EReceipt(receiptPath, { output: resolve(options.delivery), manifest: current.manifest, finalArtifacts: current.finalArtifacts }); }
      catch (error) { receipt.status = "failed"; receipt.failure = { criterion: "receipt-validation", message: error.message }; await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); }
    }
    await exportDiagnostics();
  }
  return { receiptPath, status: receipt.status };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runWindowsInstallE2E(parseOptions(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    if (result.status !== "passed") process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
